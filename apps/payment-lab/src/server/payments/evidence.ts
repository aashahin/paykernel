/** Evidence appliers: payment CAS + refund dedupe. Batch-atomic, no fake success. */
import type { D1DatabaseLike, LabClock, RefundRow } from "./db";
import {
  auditInsertSql,
  batchChanges,
  isUniqueViolation,
  newLabId,
  requireInt,
  requireNonEmptyText,
  systemClock,
} from "./db";
import { LabConflictError, LabNotFoundError, LabValidationError } from "./errors";
import type {
  ApplyPaymentEvidenceRequest,
  ApplyPaymentEvidenceResult,
  ApplyRefundEvidenceRequest,
  ApplyRefundEvidenceResult,
  LabRefund,
} from "./types";
import {
  assertCurrency,
  assertNonEmptyString,
  assertPaymentEvidenceCorrelated,
  assertPositiveMinor,
  sanitizeDetailJson,
} from "./validate";
import { getAttempt } from "./attempts";
import { getOperation } from "./operations";

export const REFUND_COLS = `id, attempt_id, operation_id, provider_refund_id, amount_minor, currency, status, created_at, updated_at`;

export function mapRefundRow(row: RefundRow): LabRefund {
  return {
    id: requireNonEmptyText(row.id, "id"),
    attemptId: requireNonEmptyText(row.attempt_id, "attempt_id"),
    operationId: requireNonEmptyText(row.operation_id, "operation_id"),
    providerRefundId: requireNonEmptyText(row.provider_refund_id, "provider_refund_id"),
    amountMinor: requireInt(row.amount_minor, "amount_minor"),
    currency: requireNonEmptyText(row.currency, "currency"),
    status: requireNonEmptyText(row.status, "status") as LabRefund["status"],
    createdAt: requireNonEmptyText(row.created_at, "created_at"),
    updatedAt: requireNonEmptyText(row.updated_at, "updated_at"),
  };
}

async function getRefundByProvider(
  db: D1DatabaseLike,
  attemptId: string,
  providerRefundId: string,
): Promise<LabRefund | null> {
  const row = await db
    .prepare(`SELECT ${REFUND_COLS} FROM lab_refunds WHERE attempt_id = ? AND provider_refund_id = ?`)
    .bind(attemptId, providerRefundId)
    .first<RefundRow>();
  return row === null ? null : mapRefundRow(row);
}

function isStaleTransitionError(message: string, capturedEqual: boolean): boolean {
  if (!capturedEqual) return false;
  const m = message.toLowerCase();
  return m.includes("transition not allowed") || m.includes("regressed");
}

export async function applyPaymentEvidence(
  db: D1DatabaseLike,
  input: ApplyPaymentEvidenceRequest,
  clock: LabClock = systemClock(),
): Promise<ApplyPaymentEvidenceResult> {
  const ev = input.evidence;
  assertCurrency(ev.currency);
  const attempt = await getAttempt(db, input.attemptId);
  if (attempt.version !== input.expectedVersion) {
    throw new LabConflictError(`stale attempt version: expected ${input.expectedVersion}, found ${attempt.version}`);
  }
  try {
    assertPaymentEvidenceCorrelated(attempt, ev);
  } catch (error) {
    // Stale re-delivery with identical money is ignored, never regresses.
    if (error instanceof LabValidationError && isStaleTransitionError(error.message, ev.capturedMinor === attempt.capturedMinor || (ev.capturedMinor < attempt.capturedMinor && ["pending", "processing", "approved", "authorized"].includes(ev.status)))) {
      return { attempt };
    }
    throw error;
  }

  const p = ev.provider;
  const hasNewRef =
    (p.providerObjectId !== undefined && p.providerObjectId !== attempt.provider.providerObjectId) ||
    (p.providerOrderId !== undefined && p.providerOrderId !== attempt.provider.providerOrderId) ||
    (p.providerAuthorizationId !== undefined && p.providerAuthorizationId !== attempt.provider.providerAuthorizationId) ||
    (p.providerCaptureId !== undefined && p.providerCaptureId !== attempt.provider.providerCaptureId);
  if (ev.status === attempt.status && ev.capturedMinor === attempt.capturedMinor && !hasNewRef) {
    return { attempt }; // idempotent duplicate, no version churn.
  }

  const now = clock.nowIso();
  const detail = sanitizeDetailJson({ status: ev.status, capturedMinor: ev.capturedMinor });
  const results = await db.batch([
    db.prepare(
      `UPDATE lab_attempts SET status = ?, captured_minor = ?, provider_object_id = COALESCE(?, provider_object_id), provider_order_id = COALESCE(?, provider_order_id), provider_authorization_id = COALESCE(?, provider_authorization_id), provider_capture_id = COALESCE(?, provider_capture_id), version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
    ).bind(
      ev.status, ev.capturedMinor,
      p.providerObjectId ?? null, p.providerOrderId ?? null,
      p.providerAuthorizationId ?? null, p.providerCaptureId ?? null,
      now, attempt.id, attempt.version,
    ),
    db.prepare(auditInsertSql()).bind("attempt", attempt.id, "payment-evidence", detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) {
    throw new LabConflictError("payment evidence lost a concurrent write; retry");
  }
  return { attempt: await getAttempt(db, attempt.id) };
}

export async function applyRefundEvidence(
  db: D1DatabaseLike,
  input: ApplyRefundEvidenceRequest,
  clock: LabClock = systemClock(),
): Promise<ApplyRefundEvidenceResult> {
  const ev = input.evidence;
  assertNonEmptyString(ev.providerRefundId, "evidence.providerRefundId", 256);
  assertPositiveMinor(ev.amountMinor, "evidence.amountMinor");
  assertCurrency(ev.currency);
  if (!["pending", "completed", "failed"].includes(ev.status)) throw new LabValidationError("invalid refund status");
  const attempt = await getAttempt(db, input.attemptId);
  const op = await getOperation(db, input.operationId);
  if (op.attemptId !== attempt.id || op.kind !== "refund") throw new LabValidationError("refund operation does not match attempt");
  if (op.currency !== ev.currency || attempt.currency !== ev.currency || op.amountMinor !== ev.amountMinor) {
    throw new LabValidationError("refund operation amount/currency does not match evidence");
  }
  const existing = await getRefundByProvider(db, attempt.id, ev.providerRefundId);
  if (existing) {
    if (existing.operationId !== op.id || existing.amountMinor !== ev.amountMinor || existing.currency !== ev.currency) {
      throw new LabConflictError("refund resource already belongs to different evidence");
    }
    // Settled money is final; a delayed pending/failed event cannot reverse it.
    if (existing.status === ev.status || existing.status === "completed" || (existing.status === "failed" && ev.status === "pending")) {
      return { refund: existing, attempt, replayed: true };
    }
  }
  const id = existing?.id ?? newLabId("ref");
  const now = clock.nowIso();
  // Capacity is checked against current rows inside the write, including other pending refunds.
  const capacity = `(SELECT COALESCE(SUM(amount_minor), 0) FROM lab_refunds WHERE attempt_id = ? AND id != ? AND status IN ('pending','completed')) + ? <= (SELECT captured_minor FROM lab_attempts WHERE id = ?)`;
  const mutation = existing
    ? db.prepare(`UPDATE lab_refunds SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND (? = 'failed' OR ${capacity})`)
      .bind(ev.status, now, id, existing.status, ev.status, attempt.id, id, ev.amountMinor, attempt.id)
    : db.prepare(`INSERT INTO lab_refunds (id, attempt_id, operation_id, provider_refund_id, amount_minor, currency, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (? = 'failed' OR ${capacity})`)
      .bind(id, attempt.id, op.id, ev.providerRefundId, ev.amountMinor, ev.currency, ev.status, now, now,
        ev.status, attempt.id, id, ev.amountMinor, attempt.id);
  const settled = `(SELECT COALESCE(SUM(amount_minor), 0) FROM lab_refunds WHERE attempt_id = lab_attempts.id AND status = 'completed')`;
  try {
    const results = await db.batch([
      mutation,
      db.prepare(auditInsertSql()).bind("refund", id, `refund-${ev.status}`, sanitizeDetailJson({ providerRefundId: ev.providerRefundId, amountMinor: ev.amountMinor }), now),
      db.prepare(`UPDATE lab_attempts SET refunded_minor = ${settled},
        status = CASE WHEN ${settled} = captured_minor AND captured_minor > 0 THEN 'refunded'
          WHEN ${settled} > 0 THEN 'partially_refunded' ELSE status END,
        version = version + 1, updated_at = ? WHERE id = ? AND changes() = 1`).bind(now, attempt.id),
      db.prepare(auditInsertSql()).bind("attempt", attempt.id, "refund-evidence", sanitizeDetailJson({ refundId: id, status: ev.status }), now),
    ]);
    if (batchChanges(results, 0) !== 1) {
      const raced = await getRefundByProvider(db, attempt.id, ev.providerRefundId);
      if (raced && (raced.status === ev.status || raced.status === "completed")) {
        return { refund: raced, attempt: await getAttempt(db, attempt.id), replayed: true };
      }
      throw new LabConflictError("refund capacity or status changed; reconcile before retrying");
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Re-enter correlation checks after a concurrent duplicate insert.
    const raced = await getRefundByProvider(db, attempt.id, ev.providerRefundId);
    if (!raced) throw new LabConflictError("operation already has a different provider refund");
    return applyRefundEvidence(db, input, clock);
  }
  return { refund: await getRefundById(db, id), attempt: await getAttempt(db, attempt.id), replayed: false };
}

export async function getRefundById(db: D1DatabaseLike, refundId: string): Promise<LabRefund> {
  const row = await db.prepare(`SELECT ${REFUND_COLS} FROM lab_refunds WHERE id = ?`).bind(refundId).first<RefundRow>();
  if (row === null) throw new LabNotFoundError(`refund not found: ${refundId}`);
  return mapRefundRow(row);
}

export async function listRefundsByAttempt(db: D1DatabaseLike, attemptId: string): Promise<LabRefund[]> {
  const { results } = await db
    .prepare(`SELECT ${REFUND_COLS} FROM lab_refunds WHERE attempt_id = ? ORDER BY created_at ASC`)
    .bind(attemptId)
    .all<RefundRow>();
  return results.map((r) => mapRefundRow(r));
}
