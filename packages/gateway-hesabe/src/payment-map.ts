import {
  applyOutcomeToGatewayRefundResult,
  applyOutcomeToGatewayResult,
  buildProviderReferences,
  InvalidRequestError,
  NetworkError,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type Money,
} from "@paykernel/core";
import { parseHesabeKwdAmount } from "./money";
import { mapHesabeEnquiryStatus } from "./status";

export type HesabeTransaction = {
  token: string;
  referenceNumber: string;
  amount: Money;
  nativeStatus: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function requireOuterAccepted(envelope: unknown, context: string): Record<string, unknown> {
  const rec = asRecord(envelope);
  if (rec === undefined) {
    throw new NetworkError(`Hesabe ${context} response malformed`);
  }
  if (rec.status === false) {
    throw new InvalidRequestError(`Hesabe ${context} rejected by provider`);
  }
  if (rec.status !== true) {
    throw new NetworkError(`Hesabe ${context} response malformed`);
  }
  return rec;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRefundId(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n <= 0) return undefined;
    return String(n);
  }
  return undefined;
}

function parseRefundAtUtc(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/u.exec(trimmed);
  if (!date) return undefined;
  const day = new Date(`${date[1]}-${date[2]}-${date[3]}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== trimmed.slice(0, 10))
    return undefined;
  const parsed = new Date(trimmed.length === 10 ? `${trimmed}T00:00:00.000Z` : trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Parse an already-decrypted transaction enquiry envelope.
 * Plain shape: { status: true, data: { token, amount: "45.000",
 * reference_number: "order1", status: "SUCCESSFUL" | "FAILED" | "PENDING" | unknown } }.
 */
export function parseHesabeTransaction(
  envelope: unknown,
  expectedToken: string,
): HesabeTransaction {
  const expected = nonEmptyString(expectedToken);
  if (expected === undefined) {
    throw new InvalidRequestError("Hesabe transaction lookup requires a token");
  }
  const rec = requireOuterAccepted(envelope, "transaction enquiry");
  const data = asRecord(rec.data);
  if (data === undefined) {
    throw new NetworkError("Hesabe transaction enquiry response malformed");
  }
  const token = nonEmptyString(data.token);
  const referenceNumber = nonEmptyString(data.reference_number);
  const nativeStatus = nonEmptyString(data.status);
  if (token === undefined || referenceNumber === undefined || nativeStatus === undefined) {
    throw new NetworkError("Hesabe transaction enquiry response malformed");
  }
  if (token !== expected) {
    throw new NetworkError("Hesabe transaction token mismatch");
  }
  let amount: Money;
  try {
    amount = parseHesabeKwdAmount(data.amount);
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    throw new NetworkError("Hesabe transaction amount malformed");
  }
  return { token, referenceNumber, amount, nativeStatus };
}

/** Map a parsed transaction to a GatewayPaymentResult. */
export function hesabeTransactionResult(transaction: HesabeTransaction): GatewayPaymentResult {
  const mapped = mapHesabeEnquiryStatus(transaction.nativeStatus);
  const status = mapped ?? "pending";
  const references = buildProviderReferences({
    gateway: "hesabe",
    gatewayId: transaction.token,
    status,
    orderId: transaction.referenceNumber,
    internalReference: transaction.referenceNumber,
    providerNativeStatus: transaction.nativeStatus,
  });
  return applyOutcomeToGatewayResult(
    {
      gatewayId: transaction.token,
      orderId: transaction.referenceNumber,
      status,
      references,
      amount: transaction.amount,
      currency: "KWD",
      ...(mapped === "paid" ? { capturedAmount: transaction.amount } : {}),
      rawResponse: {
        token: transaction.token,
        amount: transaction.amount.amount,
        currency: "KWD",
        reference_number: transaction.referenceNumber,
        status: transaction.nativeStatus,
      },
      gateway: "hesabe",
      providerNativeStatus: transaction.nativeStatus,
    },
    mapped === "paid"
      ? "succeeded"
      : mapped === "failed"
        ? "failed"
        : mapped === "pending"
          ? "requires_action"
          : "indeterminate",
  );
}

/**
 * Parse an already-decrypted merchant refund envelope.
 * Shape: { status: true, response: { id: 1467, token: "transaction",
 * amount: "10.000", status: 0 | 1 | unknown, refund_at: string | null, ... } }.
 * Never surfaces totalRefunded (cumulative ambiguity).
 */
export function parseHesabeRefund(
  envelope: unknown,
  expected: { id?: string; token?: string; amount?: Money },
): GatewayRefundResult {
  const rec = requireOuterAccepted(envelope, "refund");
  const response = asRecord(rec.response);
  if (response === undefined) {
    throw new NetworkError("Hesabe refund response malformed");
  }
  const refundId = normalizeRefundId(response.id);
  const token = nonEmptyString(response.token);
  if (refundId === undefined || token === undefined) {
    throw new NetworkError("Hesabe refund response malformed");
  }
  let amount: Money;
  try {
    amount = parseHesabeKwdAmount(response.amount);
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error;
    throw new NetworkError("Hesabe refund amount malformed");
  }
  if (expected.id !== undefined && expected.id.trim() !== refundId) {
    throw new NetworkError("Hesabe refund id mismatch");
  }
  if (expected.token !== undefined && expected.token.trim() !== token) {
    throw new NetworkError("Hesabe refund token mismatch");
  }
  if (expected.amount !== undefined) {
    if (
      expected.amount.amount !== amount.amount ||
      expected.amount.currency.toUpperCase() !== amount.currency.toUpperCase()
    ) {
      throw new NetworkError("Hesabe refund amount mismatch");
    }
  }
  const innerStatus: unknown = response.status;
  const refundAtRaw: unknown = response.refund_at;
  const rawResponse = {
    id: refundId,
    token,
    amount: amount.amount,
    currency: amount.currency,
    status: typeof innerStatus === "number" || typeof innerStatus === "string" ? innerStatus : null,
    refund_at: typeof refundAtRaw === "string" ? refundAtRaw.trim() : null,
  };
  if (innerStatus === 0) {
    return applyOutcomeToGatewayRefundResult(
      { gatewayRefundId: refundId, status: "pending", rawResponse },
      "pending",
    );
  }
  const refundedAt = innerStatus === 1 ? parseRefundAtUtc(refundAtRaw) : undefined;
  if (refundedAt !== undefined) {
    return applyOutcomeToGatewayRefundResult(
      { gatewayRefundId: refundId, status: "completed", rawResponse, refundedAt },
      "succeeded",
    );
  }
  return applyOutcomeToGatewayRefundResult(
    { gatewayRefundId: refundId, status: "pending", rawResponse },
    "indeterminate",
  );
}

/**
 * Parse an already-decrypted checkout envelope.
 * Shape: { status: true, code: 200, response: { data: "checkout_token" } }.
 * `code` is not required (docs inconsistent).
 */
export function parseHesabeCheckout(
  envelope: unknown,
  params: { orderId: string; amount: Money; baseUrl: string },
): GatewayPaymentResult {
  const { orderId, baseUrl } = params;
  const rec = requireOuterAccepted(envelope, "checkout");
  const response = asRecord(rec.response);
  if (response === undefined) {
    throw new NetworkError("Hesabe checkout response malformed");
  }
  const checkoutToken = nonEmptyString(response.data);
  if (checkoutToken === undefined) {
    throw new NetworkError("Hesabe checkout response malformed");
  }
  const gatewayId = `checkout:${checkoutToken}`;
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const redirectUrl = `${normalizedBase}/payment?data=${encodeURIComponent(checkoutToken)}`;
  const rawResponse = { checkoutToken };
  const references = buildProviderReferences({
    gateway: "hesabe",
    gatewayId,
    status: "pending",
    orderId,
    internalReference: orderId,
    providerNativeStatus: "CHECKOUT",
    relatedIds: { checkoutToken },
  });
  return applyOutcomeToGatewayResult(
    {
      gatewayId,
      orderId,
      status: "pending",
      rawResponse,
      references,
      amount: params.amount,
      currency: params.amount.currency,
      providerNativeStatus: "CHECKOUT",
      gateway: "hesabe",
      internalReference: orderId,
      relatedIds: { checkoutToken },
      redirectUrl,
      nextAction: { type: "redirect", url: redirectUrl },
    },
    "requires_action",
    { action: { type: "redirect", url: redirectUrl } },
  );
}
