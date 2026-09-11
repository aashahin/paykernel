/** Shared validation + status-transition guards. No D1 access. */

import { LabValidationError } from "./errors";
import type {
  LabAttempt,
  LabFinancialStatus,
  LabGateway,
  LabLineItem,
  LabMode,
  LabOperationKind,
  LabOperationStatus,
  LabPaymentEvidence,
  LabRefundEvidence,
} from "./types";

export const LAB_GATEWAYS: readonly LabGateway[] = [
  "moyasar",
  "paypal",
  "paymob",
  "stripe",
  "tap",
  "myfatoorah",
  "hesabe",
];

const GATEWAY_SET: ReadonlySet<string> = new Set(LAB_GATEWAYS);

export function assertGateway(value: string): asserts value is LabGateway {
  if (!GATEWAY_SET.has(value)) throw new LabValidationError(`unknown gateway: ${value}`);
}

export function assertMode(value: string): asserts value is LabMode {
  if (value !== "sandbox" && value !== "simulator") {
    throw new LabValidationError(`unknown mode: ${value}`);
  }
}

/** Simulator-only tables reject any sandbox targeting so modes never mix. */
export function assertSimulatorMode(value: string): void {
  if (value !== "simulator") throw new LabValidationError("simulator state is simulator-mode only");
}

export function assertCurrency(value: string): void {
  if (!/^[A-Z]{3}$/.test(value)) throw new LabValidationError(`invalid currency: ${value}`);
}

export function assertPositiveMinor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LabValidationError(`${field} must be a positive safe integer`);
  }
}

export function assertNonNegativeMinor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LabValidationError(`${field} must be a non-negative safe integer`);
  }
}

export function assertNonEmptyString(value: string, field: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new LabValidationError(`${field} must be 1..${max} chars`);
  }
}

export function assertIdempotencyKey(value: string, field: string): void {
  assertNonEmptyString(value, field, 128);
}

export function assertFingerprint(value: string, field: string): void {
  assertNonEmptyString(value, field, 256);
}

/** Store-level order item/sum check (routes validate first; the store re-enforces). */
export function assertValidItems(items: LabLineItem[], totalMinor: number): void {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new LabValidationError("items must be a non-empty list (max 100)");
  }
  let sum = 0;
  for (const item of items) {
    if (typeof item.name !== "string" || item.name.length === 0 || item.name.length > 200) {
      throw new LabValidationError("item.name must be 1..200 chars");
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new LabValidationError("item.quantity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(item.unitMinor) || item.unitMinor <= 0) {
      throw new LabValidationError("item.unitMinor must be a positive safe integer");
    }
    const line = item.quantity * item.unitMinor;
    if (!Number.isSafeInteger(line)) throw new LabValidationError("line total overflows safe integer");
    sum += line;
    if (!Number.isSafeInteger(sum)) throw new LabValidationError("order total overflows safe integer");
  }
  if (sum !== totalMinor) {
    throw new LabValidationError(`items sum ${sum} does not equal totalMinor ${totalMinor}`);
  }
}

/** Attempts that block a new attempt for the same order (unresolved or funded). */
export const BLOCKING_ATTEMPT_STATUSES: readonly LabFinancialStatus[] = [
  "pending",
  "processing",
  "approved",
  "authorized",
  "partially_captured",
  "paid",
  "partially_refunded",
  "refunded",
];

export function isBlockingAttemptStatus(status: LabFinancialStatus): boolean {
  return (BLOCKING_ATTEMPT_STATUSES as readonly string[]).includes(status);
}

/**
 * Explicit monotonic payment-evidence transitions. Same-status is always
 * allowed (idempotent re-delivery). Everything not listed is rejected —
 * in particular authorized->pending (regression) is NOT allowed, terminal
 * paid/refunded/partially_refunded/failed/cancelled never regress via payment
 * evidence, and refunds move money only through the refund-evidence path.
 *
 * failed->paid is NOT allowed here. A verified late-payment recovery may pass
 * through `isLatePaidRecovery` in the evidence applier, which additionally
 * requires fresh captured money (never a second charge on already-captured
 * funds) and full amount/currency/resource correlation.
 */
const PAYMENT_FORWARD: Readonly<Record<LabFinancialStatus, ReadonlySet<string>>> = {
  pending: new Set(["processing", "approved", "authorized", "partially_captured", "paid", "failed", "cancelled"]),
  processing: new Set(["approved", "authorized", "partially_captured", "paid", "failed", "cancelled"]),
  approved: new Set(["authorized", "partially_captured", "paid", "failed", "cancelled"]),
  authorized: new Set(["partially_captured", "paid", "failed", "cancelled"]),
  partially_captured: new Set(["paid"]),
  paid: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
  partially_refunded: new Set([]),
  refunded: new Set([]),
};

export function isPaymentTransitionAllowed(from: LabFinancialStatus, to: LabFinancialStatus): boolean {
  if (from === to) return true;
  // Refund-family statuses move only through the refund-evidence path.
  if (to === "refunded" || to === "partially_refunded") return false;
  // Settled or terminal money never regresses via payment evidence.
  if (from === "paid" || from === "refunded" || from === "partially_refunded") return false;
  if (from === "failed" || from === "cancelled") return false;
  // A stale failure/cancel must never overwrite settled money.
  if ((to === "failed" || to === "cancelled") && from === "partially_captured") {
    return false;
  }
  return PAYMENT_FORWARD[from]?.has(to) ?? false;
}

/**
 * Narrow late-payment recovery: a verified provider result arrives after the
 * attempt already settled as failed. Allowed ONLY when the attempt holds no
 * captured money yet (attempt.capturedMinor === 0), the evidence reports the
 * full amount as paid in the attempt currency, and at least one provider
 * reference identifies the charge — so a second charge is never applied on
 * top of already-captured funds and late money is never silently discarded.
 */
export function isLatePaidRecovery(attempt: LabAttempt, evidence: LabPaymentEvidence): boolean {
  if (attempt.status !== "failed" || evidence.status !== "paid") return false;
  if (attempt.capturedMinor !== 0) return false;
  if (evidence.capturedMinor !== attempt.amountMinor) return false;
  if (evidence.currency !== attempt.currency) return false;
  const p = evidence.provider;
  return Boolean(
    p.providerObjectId ?? p.providerOrderId ?? p.providerAuthorizationId ?? p.providerCaptureId,
  );
}

/** Payment-evidence amount/currency/resource correlation (throws on mismatch). */
export function assertPaymentEvidenceCorrelated(attempt: LabAttempt, evidence: LabPaymentEvidence): void {
  if (evidence.amountMinor !== attempt.amountMinor) throw new LabValidationError("evidence amount does not match attempt");
  for (const key of ["providerObjectId", "providerOrderId", "providerAuthorizationId", "providerCaptureId"] as const) {
    if (attempt.provider[key] && evidence.provider[key] && attempt.provider[key] !== evidence.provider[key]) {
      // Older lab builds stored an intention ID in the transaction slot before checkout.
      if (key === "providerAuthorizationId" && attempt.gateway === "paymob" && attempt.mode === "sandbox"
        && attempt.capturedMinor === 0 && attempt.provider[key] === attempt.provider.providerObjectId
        && attempt.provider[key]!.startsWith("pi_") && /^\d+$/.test(evidence.provider[key]!)
        && evidence.provider.providerObjectId === attempt.provider.providerObjectId) continue;
      // Paymob creates child captures; future actions use the original transaction.
      if (key === "providerCaptureId" && attempt.gateway === "paymob" && attempt.mode === "sandbox"
        && attempt.provider.providerAuthorizationId !== undefined
        && evidence.provider.providerAuthorizationId === attempt.provider.providerAuthorizationId
        && evidence.capturedMinor >= attempt.capturedMinor) continue;
      throw new LabValidationError("provider resource does not match attempt");
    }
  }
  assertCurrency(evidence.currency);
  assertNonNegativeMinor(evidence.capturedMinor, "evidence.capturedMinor");
  if (evidence.currency !== attempt.currency) {
    throw new LabValidationError(
      `evidence currency ${evidence.currency} does not match attempt ${attempt.currency}`,
    );
  }
  if (evidence.capturedMinor > attempt.amountMinor) {
    throw new LabValidationError("evidence captured total exceeds attempt amount");
  }
  const lateRecovery = isLatePaidRecovery(attempt, evidence);
  if (!lateRecovery) {
    if (!isPaymentTransitionAllowed(attempt.status, evidence.status)) {
      throw new LabValidationError(`payment transition not allowed: ${attempt.status} -> ${evidence.status}`);
    }
    if (evidence.capturedMinor < attempt.capturedMinor) {
      throw new LabValidationError("evidence captured total regressed");
    }
    // Terminal paid evidence must account for the full amount; partial money
    // must arrive as partially_captured. Never increment twice: a second
    // "paid" delivery with the same totals is idempotent, a larger total is rejected.
    if (evidence.status === "paid" && evidence.capturedMinor !== attempt.amountMinor) {
      throw new LabValidationError("paid evidence must capture the full attempt amount");
    }
    if (evidence.status === "partially_captured") {
      if (evidence.capturedMinor === 0 || evidence.capturedMinor >= attempt.amountMinor) {
        throw new LabValidationError("partial capture total must be within (0, amount)");
      }
    }
    if ((evidence.status === "failed" || evidence.status === "cancelled") && evidence.capturedMinor !== attempt.capturedMinor) {
      throw new LabValidationError("failure evidence must not move captured totals");
    }
  }
}

/** Refund-evidence correlation: currency match, positive amount, never twice. */
export function assertRefundEvidenceCorrelated(
  attempt: LabAttempt,
  evidence: LabRefundEvidence,
  settledMinor: number,
  pendingMinor: number,
): void {
  assertNonEmptyString(evidence.providerRefundId, "evidence.providerRefundId", 256);
  assertPositiveMinor(evidence.amountMinor, "evidence.amountMinor");
  assertCurrency(evidence.currency);
  if (evidence.currency !== attempt.currency) {
    throw new LabValidationError(
      `refund currency ${evidence.currency} does not match attempt ${attempt.currency}`,
    );
  }
  if (evidence.amountMinor > attempt.capturedMinor) {
    throw new LabValidationError("refund amount exceeds captured total");
  }
  if (settledMinor + pendingMinor + evidence.amountMinor > attempt.capturedMinor) {
    throw new LabValidationError("refund total (settled + pending) would exceed captured total");
  }
}

export const UNRESOLVED_OPERATION_STATUSES: readonly LabOperationStatus[] = [
  "reserved",
  "submitted",
  "pending",
  "indeterminate",
];

export function isUnresolvedOperationStatus(status: LabOperationStatus): boolean {
  return (UNRESOLVED_OPERATION_STATUSES as readonly string[]).includes(status);
}

/** Whether a capture-family action may be reserved from this financial status. */
export function canReserveCapture(from: LabFinancialStatus): boolean {
  return from === "authorized" || from === "partially_captured";
}

/** Whether a refund-family action may be reserved from this financial status. */
export function canReserveRefund(from: LabFinancialStatus): boolean {
  return from === "paid" || from === "partially_captured" || from === "partially_refunded";
}

export function assertOperationKind(kind: string): asserts kind is LabOperationKind {
  if (
    kind !== "create" &&
    kind !== "capture" &&
    kind !== "void" &&
    kind !== "refund" &&
    kind !== "complete-return"
  ) {
    throw new LabValidationError(`unknown operation kind: ${kind}`);
  }
}

const OPERATION_FORWARD: Readonly<Record<LabOperationStatus, ReadonlySet<string>>> = {
  reserved: new Set(["submitted", "pending", "failed", "indeterminate"]),
  submitted: new Set(["pending", "completed", "failed", "indeterminate"]),
  pending: new Set(["completed", "failed", "indeterminate"]),
  indeterminate: new Set(["pending", "completed", "failed"]),
  completed: new Set([]),
  failed: new Set([]),
};

export function isOperationTransitionAllowed(from: LabOperationStatus, to: LabOperationStatus): boolean {
  if (from === to) return true;
  return OPERATION_FORWARD[from]?.has(to) ?? false;
}

const SECRET_KEY_PATTERN = /secret|token|pan|card|cvv|cvc|authorization|signature|password|private|api[_-]?key|session/i;
const EVIDENCE_MAX_BYTES = 8000;
const EVIDENCE_MAX_DEPTH = 6;
const EVIDENCE_MAX_KEYS = 100;
const EVIDENCE_MAX_STRING = 2000;

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > EVIDENCE_MAX_DEPTH) throw new LabValidationError("evidence too deeply nested");
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length > EVIDENCE_MAX_STRING) throw new LabValidationError("evidence string too large");
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new LabValidationError("evidence number is not finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > EVIDENCE_MAX_KEYS) throw new LabValidationError("evidence array too large");
    return value.map((entry) => scrubValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > EVIDENCE_MAX_KEYS) throw new LabValidationError("evidence object too large");
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      out[key] = scrubValue(entry, depth + 1);
    }
    return out;
  }
  throw new LabValidationError("evidence contains unsupported value");
}

/**
 * Redact evidence JSON: parse must succeed, cap size/depth/keys, recursively
 * drop secret/card/token-looking fields at every nesting level. Callers should
 * prefer passing known typed normalized evidence; this is the last line of
 * defence before persisting free-form JSON.
 */
export function sanitizeEvidenceJson(raw: string | undefined, maxBytes = EVIDENCE_MAX_BYTES): string {
  const text = raw ?? "{}";
  if (text.length > maxBytes) throw new LabValidationError("evidence too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LabValidationError("evidence must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LabValidationError("evidence must be a JSON object");
  }
  const scrubbed = scrubValue(parsed, 0) as Record<string, unknown>;
  const out = JSON.stringify(scrubbed);
  if (out.length > maxBytes) throw new LabValidationError("evidence too large");
  return out;
}

/** Sanitize an already-parsed detail object with the same recursive rules. */
export function sanitizeDetailJson(value: Record<string, unknown>, maxBytes = EVIDENCE_MAX_BYTES): string {
  const scrubbed = scrubValue(value, 0) as Record<string, unknown>;
  const out = JSON.stringify(scrubbed);
  if (out.length > maxBytes) throw new LabValidationError("evidence too large");
  return out;
}
