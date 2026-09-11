import { minorAmountToNumber, toMinorUnits, type GatewayPaymentResult, type GatewayPaymentStatus, type Money } from "@paykernel/core";
import type { AppEnv } from "../env";
import { getAttempt } from "./payments/attempts";
import { applyPaymentEvidence } from "./payments/evidence";
import { LabConflictError, LabValidationError } from "./payments/errors";
import type { LabAttempt, LabFinancialStatus, LabPaymentEvidence, LabProviderRefs } from "./payments/types";

function mapStatus(status: GatewayPaymentStatus): LabFinancialStatus {
  switch (status) {
    case "pending": return "pending";
    case "processing": return "processing";
    case "approved": return "approved";
    case "authorized": return "authorized";
    case "partially_captured": return "partially_captured";
    case "paid": return "paid";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "partially_refunded": return "partially_refunded";
    case "refunded": return "refunded";
    default: throw new LabValidationError(`unmapped gateway status: ${String(status)}`);
  }
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

function moneyMinor(value: Money | undefined, field: string): number {
  if (value === undefined) throw new LabValidationError(`missing gateway ${field}`);
  try {
    return minorAmountToNumber(toMinorUnits(value, { allowZero: field === "capturedAmount" }));
  } catch {
    throw new LabValidationError(`invalid gateway ${field}`);
  }
}

function isFunded(status: LabFinancialStatus): boolean {
  return status === "paid" || status === "authorized" || status === "partially_captured";
}

export function normalizeGatewayPayment(attempt: LabAttempt, result: GatewayPaymentResult): LabPaymentEvidence {
  if (result.outcome === "indeterminate") {
    throw new LabConflictError("indeterminate gateway outcome; reconciliation required");
  }
  let status = mapStatus(result.status);
  const refs = result.references;
  const internalRef = clean(refs?.internalReference);
  if (internalRef !== undefined && internalRef !== attempt.id && !(attempt.gateway === "stripe" && internalRef === attempt.idempotencyKey)) {
    throw new LabValidationError("provider resource does not match attempt");
  }
  const related = refs?.relatedIds ?? {};
  const tapCapture = attempt.mode === "sandbox" && attempt.gateway === "tap"
    && attempt.captureIntent === "manual" && result.gatewayId.startsWith("chg_")
    && ["paid", "partially_captured"].includes(status)
    && (result.authorizationId === attempt.provider.providerObjectId
      || related["authorizationId"] === attempt.provider.providerObjectId
      || result.gatewayId === attempt.provider.providerCaptureId);
  const paymobCapture = attempt.mode === "sandbox" && attempt.gateway === "paymob"
    && result.capturedAmount !== undefined
    && (result.gatewayId === attempt.provider.providerAuthorizationId || result.gatewayId === attempt.provider.providerCaptureId);
  const resultCurrency = clean(result.currency) ?? clean(result.amount?.currency) ?? clean(result.capturedAmount?.currency);
  if (resultCurrency !== undefined && resultCurrency !== attempt.currency) {
    throw new LabValidationError(`evidence currency ${resultCurrency} does not match attempt ${attempt.currency}`);
  }
  let amountMinor: number;
  if (result.amount !== undefined) {
    const minor = moneyMinor(result.amount, "amount");
    const amountCurrency = clean(result.amount.currency) ?? resultCurrency;
    if (amountCurrency !== undefined && amountCurrency !== attempt.currency) {
      throw new LabValidationError(`evidence currency ${amountCurrency} does not match attempt ${attempt.currency}`);
    }
    if (tapCapture) {
      if (minor > attempt.amountMinor) throw new LabValidationError("capture exceeds authorization");
      amountMinor = attempt.amountMinor;
      status = minor === amountMinor ? "paid" : "partially_captured";
    } else {
      if (minor !== attempt.amountMinor) throw new LabValidationError("evidence amount does not match attempt");
      amountMinor = minor;
    }
  } else if (isFunded(status) && !paymobCapture) {
    throw new LabValidationError("evidence amount does not match attempt");
  } else {
    amountMinor = attempt.amountMinor;
  }
  const currency = attempt.currency;
  let capturedMinor: number;
  if (tapCapture) {
    capturedMinor = moneyMinor(result.amount, "amount");
  } else if (result.capturedAmount !== undefined) {
    if (clean(result.capturedAmount.currency) !== currency) {
      throw new LabValidationError(`evidence currency ${clean(result.capturedAmount.currency)} does not match attempt ${currency}`);
    }
    capturedMinor = moneyMinor(result.capturedAmount, "capturedAmount");
  } else if (status === "paid") {
    capturedMinor = amountMinor;
  } else {
    capturedMinor = attempt.capturedMinor;
  }
  const rootCandidate = clean(refs?.providerObjectId) ?? clean(result.gatewayId);
  const storedRoot = clean(attempt.provider.providerObjectId);
  const providerObjectId = storedRoot ?? rootCandidate;
  if (providerObjectId === undefined) throw new LabValidationError("missing gateway payment id");
  const newId = clean(result.gatewayId);
  const provider: LabProviderRefs = { providerObjectId };
  const orderId = clean(result.orderId) ?? clean(related["orderId"]);
  const authId = attempt.gateway === "paymob" && attempt.mode === "sandbox"
    ? (/^\d+$/.test(attempt.provider.providerAuthorizationId ?? "") ? attempt.provider.providerAuthorizationId
      : newId && /^\d+$/.test(newId) ? newId : undefined)
    : clean(result.authorizationId) ?? clean(related["authorizationId"]);
  let captureId = clean(result.captureId) ?? clean(related["captureId"]) ?? clean(related["chargeId"])
    ?? clean(related["paymentIntentId"]) ?? clean(related["transactionId"]);
  if (attempt.gateway === "paymob" && captureId === attempt.provider.providerAuthorizationId) {
    captureId = attempt.provider.providerCaptureId ?? captureId;
  }
  if (storedRoot !== undefined && newId !== undefined && newId !== storedRoot) {
    const relatedValues = new Set(
      [clean(refs?.providerObjectId), clean(refs?.parentId), clean(result.orderId), clean(result.captureId),
        clean(result.authorizationId), ...Object.values(related).map((v) => clean(v))].filter((v) => v !== undefined),
    );
    const storedValues = new Set(
      [storedRoot, attempt.provider.providerOrderId, attempt.provider.providerAuthorizationId,
        attempt.provider.providerCaptureId].map((v) => clean(v)).filter((v) => v !== undefined),
    );
    const owned = internalRef === attempt.id || relatedValues.has(storedRoot) || storedValues.has(newId);
    if (!owned) throw new LabValidationError("provider resource does not match attempt");
    captureId ??= attempt.gateway === "paymob" && newId === attempt.provider.providerAuthorizationId
      ? attempt.provider.providerCaptureId ?? newId : newId;
  }
  if (orderId !== undefined) provider.providerOrderId = orderId;
  if (authId !== undefined) provider.providerAuthorizationId = authId;
  if (captureId !== undefined) provider.providerCaptureId = captureId;
  const evidence: LabPaymentEvidence = { amountMinor, status, capturedMinor, currency, provider };
  const eventId = clean(result.providerRequestId);
  if (eventId !== undefined) evidence.providerEventId = eventId;
  return evidence;
}

export async function applyGatewayPayment(env: AppEnv, attemptId: string, result: GatewayPaymentResult): Promise<LabAttempt> {
  let lastConflict: unknown;
  for (let i = 0; i < 3; i++) {
    const attempt = await getAttempt(env.DB, attemptId);
    const evidence = normalizeGatewayPayment(attempt, result);
    try {
      const applied = await applyPaymentEvidence(env.DB, { attemptId, expectedVersion: attempt.version, evidence });
      return applied.attempt;
    } catch (error) {
      if (!(error instanceof LabConflictError)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict instanceof Error ? lastConflict : new LabConflictError("payment evidence lost a concurrent write; retry");
}
