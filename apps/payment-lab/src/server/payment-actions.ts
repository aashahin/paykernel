import { fromMinorUnits, minorAmountToNumber, toMinorUnits } from "@paykernel/core";
import type { AppEnv } from "../env";
import { createSandboxDriver, getGatewayReadiness } from "./gateways/index";
import { createSimulatorDriver } from "./gateways/simulator";
import type { SandboxGatewayDriver } from "./gateways/types";
import { GatewayActionNotSubmittedError } from "./gateways/types";
import { applyGatewayPayment } from "./payment-evidence";
import { normalizeRefundReceipt } from "./refund-receipt";
import { createGatewayIdempotencyStore } from "./sdk-stores";
import type { D1DatabaseLike } from "./payments/db";
import { getAttempt } from "./payments/attempts";
import { applyRefundEvidence, listRefundsByAttempt } from "./payments/evidence";
import { LabConflictError, LabValidationError } from "./payments/errors";
import {
  getOperation,
  getOperationByIdempotency,
  listOperationsByAttempt,
  markOperationCompleted,
  markOperationFailed,
  markOperationIndeterminate,
  markOperationPending,
  markOperationSubmitted,
  reserveOperation,
} from "./payments/operations";
import type { LabAttempt, LabOperation } from "./payments/types";

export type PaymentActionKind = "capture" | "void" | "refund" | "complete-return";

export type PaymentActionInput = {
  kind: PaymentActionKind;
  amountMinor?: number | undefined;
  idempotencyKey: string;
  query?: Record<string, string | undefined> | undefined;
};

function buildDriver(env: AppEnv, attempt: LabAttempt): SandboxGatewayDriver {
  if (attempt.mode === "simulator") return createSimulatorDriver(env.DB, attempt.gateway);
  return createSandboxDriver({
    gateway: attempt.gateway,
    secrets: env,
    idempotencyStore: createGatewayIdempotencyStore(env.DB, `${attempt.gateway}:${attempt.mode}`),
  });
}

function actionFingerprint(kind: PaymentActionKind, requested: number | undefined): string {
  return JSON.stringify({ kind, amount: requested ?? null });
}

function assertActionInput(input: PaymentActionInput): void {
  if (input.kind !== "capture" && input.kind !== "void" && input.kind !== "refund" && input.kind !== "complete-return") {
    throw new LabValidationError("unsupported action");
  }
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 128) {
    throw new LabValidationError("idempotencyKey must be 1..128 chars");
  }
  if (input.amountMinor !== undefined && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)) {
    throw new LabValidationError("amountMinor must be a non-negative safe integer");
  }
}

async function keepIndeterminate(db: D1DatabaseLike, operationId: string, version: number, label: string): Promise<void> {
  try {
    await markOperationIndeterminate(db, { operationId, expectedVersion: version, lastError: label });
  } catch (error) {
    if (!(error instanceof LabConflictError)) throw error;
  }
}

async function pendingRefundTotal(db: D1DatabaseLike, attemptId: string): Promise<number> {
  const refunds = await listRefundsByAttempt(db, attemptId);
  let total = 0;
  for (const refund of refunds) {
    if (refund.status === "pending" || refund.status === "completed") total += refund.amountMinor;
  }
  return total;
}

function isUnresolved(status: LabOperation["status"]): boolean {
  return status === "reserved" || status === "submitted" || status === "pending" || status === "indeterminate";
}

export async function performPaymentAction(env: AppEnv, attemptId: string, input: PaymentActionInput) {
  assertActionInput(input);
  const db = env.DB;
  const requested = input.amountMinor;
  const print = actionFingerprint(input.kind, requested);
  const attempt = await getAttempt(db, attemptId);
  const replay = await getOperationByIdempotency(db, attemptId, input.idempotencyKey);
  if (replay !== null) {
    if (replay.fingerprint !== print) throw new LabConflictError("operation idempotency key already used with a different fingerprint");
    return { attempt: await getAttempt(db, attemptId), operation: replay, replayed: true };
  }
  const readiness = getGatewayReadiness(attempt.gateway, env);
  if (attempt.mode === "sandbox" && !readiness.configured) {
    throw new LabValidationError(`gateway not configured: missing ${readiness.missing.join(",") || "sandbox key"}`);
  }
  const caps = readiness.capabilities;
  let effective: number;
  if (input.kind === "capture") {
    if (!caps.authorization) throw new LabValidationError("Gateway does not support capture.");
    if (attempt.mode === "sandbox" && ["stripe", "paypal", "tap"].includes(attempt.gateway) && attempt.capturedMinor > 0) throw new LabConflictError("The authorization was closed by the first capture.");
    const remaining = attempt.amountMinor - attempt.capturedMinor;
    effective = requested ?? remaining;
    if (!Number.isSafeInteger(effective) || effective <= 0) throw new LabValidationError("capture amount must be positive");
    if (effective < remaining && !caps.partialCapture) throw new LabValidationError("gateway does not support partial capture");
  } else if (input.kind === "refund") {
    if (!caps.refunds) throw new LabValidationError("gateway does not support refunds");

    const used = await pendingRefundTotal(db, attemptId);
    effective = requested ?? attempt.capturedMinor - used;
    if (!Number.isSafeInteger(effective) || effective <= 0) throw new LabValidationError("refund amount must be positive");
    if (effective < attempt.capturedMinor - used && !caps.partialRefunds) throw new LabValidationError("gateway does not support partial refunds");
  } else if (input.kind === "void") {
    if (!caps.voids) throw new LabValidationError("gateway does not support voids");
    if (requested !== undefined && requested !== 0) throw new LabValidationError("void amount must be zero");
    effective = 0;
  } else {
    if (!caps.payments) throw new LabValidationError("gateway does not support payments");
    if (requested !== undefined && requested !== attempt.amountMinor) throw new LabValidationError("return amount must equal attempt amount");
    effective = attempt.amountMinor;
  }
  const driver = buildDriver(env, attempt);
  const paypal = attempt.gateway === "paypal" && attempt.mode === "sandbox";
  const transactionId = attempt.mode === "sandbox" && attempt.gateway === "paymob"
    ? attempt.provider.providerAuthorizationId ?? attempt.provider.providerCaptureId
    : attempt.mode === "sandbox" && attempt.gateway === "hesabe" ? attempt.provider.providerCaptureId : attempt.provider.providerObjectId;
  const resource = input.kind === "capture" || input.kind === "void"
    ? (paypal ? attempt.provider.providerAuthorizationId : transactionId)
    : input.kind === "refund"
      ? (paypal || (attempt.mode === "sandbox" && attempt.gateway === "tap" && attempt.provider.providerObjectId?.startsWith("auth_")) || (attempt.gateway === "stripe" && attempt.provider.providerObjectId?.startsWith("cs_")) ? attempt.provider.providerCaptureId : transactionId)
      : attempt.provider.providerObjectId;
  if (resource === undefined) throw new LabConflictError("Missing provider resource; reconcile required.");
  const reserved = await reserveOperation(db, {
    attemptId, kind: input.kind, idempotencyKey: input.idempotencyKey, fingerprint: print, amountMinor: effective, currency: attempt.currency, providerId: resource,
  });
  if (reserved.replayed) {
    return { attempt: await getAttempt(db, attemptId), operation: reserved.operation, replayed: true };
  }
  const submitted = await markOperationSubmitted(db, { operationId: reserved.operation.id, expectedVersion: reserved.operation.version });
  const label = input.kind === "capture" ? "capture failed" : input.kind === "void" ? "void failed" : input.kind === "refund" ? "refund failed" : "return failed";
  const money = fromMinorUnits(BigInt(effective), attempt.currency, { allowZero: true });
  if (input.kind === "refund") {
    let result;
    try {
      result = await driver.refund({
        gatewayPaymentId: resource, idempotencyKey: submitted.idempotencyKey, currency: attempt.currency,
        ...(requested !== undefined ? { amount: money } : {}),
      });
    } catch (error) {
      if (error instanceof GatewayActionNotSubmittedError) {
        await markOperationFailed(db, { operationId: submitted.id, expectedVersion: submitted.version, lastError: error.message });
        throw new LabConflictError(error.message);
      }
      await keepIndeterminate(db, submitted.id, submitted.version, label);
      throw new LabConflictError(`${label}; reconcile required`);
    }
    let evidence;
    try {
      evidence = normalizeRefundReceipt(attempt, submitted, result);
    } catch {
      await keepIndeterminate(db, submitted.id, submitted.version, "refund evidence requires reconciliation");
      throw new LabConflictError("Refund evidence requires reconciliation.");
    }
    if (result.outcome === "pending" || (result.outcome === "succeeded" && result.status === "pending")) {
      try {
        await applyRefundEvidence(db, {
          attemptId, operationId: submitted.id,
          evidence,
        });
      } catch {
        await keepIndeterminate(db, submitted.id, submitted.version, label);
        throw new LabConflictError(`${label}; reconcile required`);
      }
      const pending = await markOperationPending(db, { operationId: submitted.id, expectedVersion: submitted.version });
      return { attempt: await getAttempt(db, attemptId), operation: pending, replayed: false };
    }
    if (result.outcome === "failed") {
      try {
        await applyRefundEvidence(db, {
          attemptId, operationId: submitted.id,
          evidence,
        });
      } catch {
        await keepIndeterminate(db, submitted.id, submitted.version, label);
        throw new LabConflictError(`${label}; reconcile required`);
      }
      const failed = await markOperationFailed(db, { operationId: submitted.id, expectedVersion: submitted.version });
      return { attempt: await getAttempt(db, attemptId), operation: failed, replayed: false };
    }
    try {
      await applyRefundEvidence(db, {
        attemptId, operationId: submitted.id,
        evidence,
      });
    } catch {
      await keepIndeterminate(db, submitted.id, submitted.version, label);
      throw new LabConflictError(`${label}; reconcile required`);
    }
    const done = await markOperationCompleted(db, { operationId: submitted.id, expectedVersion: submitted.version });
    return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
  }
  let payment;
  try {
    if (input.kind === "capture") {
      payment = await driver.capture({
        gatewayPaymentId: resource, idempotencyKey: submitted.idempotencyKey, currency: attempt.currency,
        ...(requested !== undefined ? { amount: money } : {}),
      });
      if (paypal && payment.outcome !== "indeterminate" && payment.outcome !== "failed" && payment.outcome !== "declined") {
        const captured = payment.amount;
        if (!captured || captured.currency !== attempt.currency || minorAmountToNumber(toMinorUnits(captured)) !== effective) throw new LabValidationError("PayPal capture amount mismatch");
        payment = await driver.lookup(attempt.provider.providerObjectId!);
      }
    } else if (input.kind === "void") {
      payment = await driver.void({ gatewayPaymentId: resource, idempotencyKey: submitted.idempotencyKey });
    } else {
      payment = await driver.completeReturn({
        storedGatewayPaymentId: resource, idempotencyKey: submitted.idempotencyKey, capture: attempt.captureIntent === "automatic",
        ...(input.query !== undefined ? { query: input.query } : {}),
      });
    }
  } catch {
    await keepIndeterminate(db, submitted.id, submitted.version, label);
    throw new LabConflictError(`${label}; reconcile required`);
  }
  if (payment.outcome === "indeterminate" || payment.reconciliationRequired === true) {
    await keepIndeterminate(db, submitted.id, submitted.version, label);
    throw new LabConflictError(`${label}; reconcile required`);
  }
  try {
    await applyGatewayPayment(env, attemptId, payment);
  } catch {
    await keepIndeterminate(db, submitted.id, submitted.version, label);
    throw new LabConflictError(`${label}; reconcile required`);
  }
  if (payment.outcome === "failed" || payment.outcome === "declined") {
    const failed = await markOperationFailed(db, { operationId: submitted.id, expectedVersion: submitted.version });
    return { attempt: await getAttempt(db, attemptId), operation: failed, replayed: false };
  }
  const updated = await getAttempt(db, attemptId);
  const conclusive = input.kind === "void" ? updated.status === "cancelled" : input.kind === "capture"
    ? submitted.capturedBeforeMinor !== undefined && updated.capturedMinor - submitted.capturedBeforeMinor === submitted.amountMinor
    : ["paid", "authorized", "partially_captured"].includes(updated.status);
  const mark = conclusive ? markOperationCompleted : markOperationPending;
  const done = await mark(db, { operationId: submitted.id, expectedVersion: submitted.version });
  return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
}

export async function reconcileAttempt(env: AppEnv, attemptId: string) {
  const db = env.DB;
  const attempt = await getAttempt(db, attemptId);
  const ops = await listOperationsByAttempt(db, attemptId);
  let unresolved: LabOperation | undefined;
  for (const op of ops) {
    if (op.id === attempt.pendingOperationId && isUnresolved(op.status)) unresolved = op;
  }
  if (unresolved === undefined) {
    for (const op of ops) {
      if (isUnresolved(op.status)) unresolved = op;
    }
  }
  const driver = buildDriver(env, attempt);
  if (unresolved?.kind === "refund") {
    const refunds = await listRefundsByAttempt(db, attemptId);
    const receipt = refunds.find(refund => refund.operationId === unresolved.id);
    // The SDK can have a durable receipt even if the request died before the lab ledger write.
    if (!receipt && driver.recoverRefund) {
      const result = await driver.recoverRefund(unresolved.idempotencyKey);
      if (result) {
        const evidence = normalizeRefundReceipt(attempt, unresolved, result);
        await applyRefundEvidence(db, { attemptId, operationId: unresolved.id, evidence });
        const live = await getOperation(db, unresolved.id);
        if (!isUnresolved(live.status)) return { attempt: await getAttempt(db, attemptId), operation: live, replayed: false };
        const mark = evidence.status === "completed" ? markOperationCompleted : evidence.status === "failed" ? markOperationFailed : markOperationPending;
        const done = await mark(db, { operationId: live.id, expectedVersion: live.version });
        return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
      }
    }
    if (receipt && receipt.status !== "pending") {
      const mark = receipt.status === "completed" ? markOperationCompleted : markOperationFailed;
      const done = await mark(db, { operationId: unresolved.id, expectedVersion: unresolved.version });
      return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
    }
    if (receipt && driver.lookupRefund) {
      const result = await driver.lookupRefund(receipt.providerRefundId);
      const evidence = normalizeRefundReceipt(attempt, unresolved, result);
      await applyRefundEvidence(db, { attemptId, operationId: unresolved.id, evidence });
      if (evidence.status === "pending") return { attempt: await getAttempt(db, attemptId), operation: unresolved, replayed: false };
      const live = await getOperation(db, unresolved.id);
      if (!isUnresolved(live.status)) return { attempt: await getAttempt(db, attemptId), operation: live, replayed: false };
      const mark = evidence.status === "completed" ? markOperationCompleted : markOperationFailed;
      const done = await mark(db, { operationId: live.id, expectedVersion: live.version });
      return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
    }
  }
  const root = attempt.mode === "sandbox" && attempt.gateway === "paymob"
    ? [attempt.provider.providerAuthorizationId, attempt.provider.providerCaptureId].find(id => id && /^\d+$/.test(id))
    : attempt.mode === "sandbox" && attempt.gateway === "hesabe" ? attempt.provider.providerCaptureId : attempt.provider.providerObjectId;

  let fresh = attempt;
  let refundedMinor: number | undefined;
  const referenceLookup = attempt.mode === "sandbox" && attempt.gateway === "paymob" && root === undefined && driver.lookupByReference;
  if (root !== undefined || referenceLookup) {
    let lookup;
    try {
      lookup = referenceLookup ? await referenceLookup(attempt.id) : await driver.lookup(root!);
      if (lookup.refundedAmount?.currency === attempt.currency && lookup.outcome !== "indeterminate") {
        refundedMinor = minorAmountToNumber(toMinorUnits(lookup.refundedAmount, { allowZero: true }));
      }
    } catch {
      if (unresolved !== undefined) await keepIndeterminate(db, unresolved.id, unresolved.version, "reconcile lookup failed");
      throw new LabConflictError("reconcile lookup failed");
    }
    try {
      fresh = await applyGatewayPayment(env, attemptId, lookup);
    } catch (error) {
      if (unresolved !== undefined) {
        const live = await getOperation(db, unresolved.id);
        if (isUnresolved(live.status)) await keepIndeterminate(db, live.id, live.version, "reconcile requires reconcile");
      }
      if (error instanceof LabValidationError) throw error;
      throw new LabConflictError("reconcile requires reconcile");
    }
  }
  if (unresolved === undefined) return { attempt: fresh, operation: undefined, replayed: false };
  const live = await getOperation(db, unresolved.id);
  if (!isUnresolved(live.status)) return { attempt: fresh, operation: live, replayed: false };
  if (live.kind === "refund") {
    if (refundedMinor === fresh.refundedMinor + live.amountMinor) {
      const refunds = await listRefundsByAttempt(db, attemptId);
      const receipt = refunds.find(refund => refund.operationId === live.id);
      const providerRefundId = receipt?.providerRefundId
        ?? (attempt.gateway === "moyasar" && attempt.mode === "sandbox" && live.providerId ? `${live.providerId}:${live.id}` : undefined);
      if (providerRefundId) {
        await applyRefundEvidence(db, { attemptId, operationId: live.id,
          evidence: { providerRefundId, amountMinor: live.amountMinor, currency: attempt.currency, status: "completed" } });
        const done = await markOperationCompleted(db, { operationId: live.id, expectedVersion: live.version });
        return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
      }
    }
    return { attempt: fresh, operation: live, replayed: false };
  }
  if (live.kind === "capture") {
    const gained = live.capturedBeforeMinor === undefined ? 0 : fresh.capturedMinor - live.capturedBeforeMinor;
    if (gained >= live.amountMinor && (fresh.status === "paid" || fresh.status === "partially_captured")) {
      const done = await markOperationCompleted(db, { operationId: live.id, expectedVersion: live.version });
      return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
    }
    return { attempt: fresh, operation: live, replayed: false };
  }
  if (live.kind === "void") {
    if (fresh.status === "cancelled") {
      const done = await markOperationCompleted(db, { operationId: live.id, expectedVersion: live.version });
      return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
    }
    return { attempt: fresh, operation: live, replayed: false };
  }
  if (root === undefined && !referenceLookup) return { attempt: fresh, operation: live, replayed: false };

  if (fresh.status === "paid" || fresh.status === "authorized" || fresh.status === "partially_captured" || fresh.status === "approved") {
    const done = await markOperationCompleted(db, { operationId: live.id, expectedVersion: live.version });
    return { attempt: await getAttempt(db, attemptId), operation: done, replayed: false };
  }
  if (fresh.status === "failed" || fresh.status === "cancelled") {
    const failed = await markOperationFailed(db, { operationId: live.id, expectedVersion: live.version });
    return { attempt: await getAttempt(db, attemptId), operation: failed, replayed: false };
  }
  return { attempt: fresh, operation: live, replayed: false };
}
