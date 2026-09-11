/**
 * Payment attempt reservations. One durable blocking attempt per order.
 *
 * Concurrency contract:
 * - Reserves never rely on read-then-insert. The INSERT runs first and the
 *   UNIQUE indexes serialize concurrent writers:
 *   uq_lab_attempts_idem (gateway, mode, idempotency_key) for stable
 *   idempotency, uq_lab_attempts_single_blocking (order_id) WHERE blocking
 *   for the single-winner rule. Failed/cancelled attempts are non-blocking
 *   so a retry with a fresh key is allowed.
 * - Same idempotency key + same fingerprint returns the existing row with
 *   replayed:true so the caller skips a second provider request. Same key +
 *   different fingerprint is a 409 (mismatched idempotency).
 * - Audit rows are paired in the same batch() guarded by WHERE changes()=1.
 */

import type { AttemptRow, D1DatabaseLike, LabClock } from "./db";
import {
  auditInsertSql,
  batchChanges,
  isUniqueViolation,
  newLabId,
  requireBooleanInt,
  requireInt,
  requireNonEmptyText,
  requireOptionalText,
  systemClock,
} from "./db";
import { LabConflictError, LabNotFoundError, LabValidationError } from "./errors";
import type {
  LabAttempt,
  LabCaptureIntent,
  LabFinancialStatus,
  LabGateway,
  LabMode,
  LabProviderRefs,
  ReserveAttemptRequest,
  ReserveAttemptResult,
} from "./types";
import {
  assertCurrency,
  assertFingerprint,
  assertGateway,
  assertIdempotencyKey,
  assertMode,
  assertPositiveMinor,
  sanitizeDetailJson,
} from "./validate";
import { getOrder } from "./orders";

const ATTEMPT_COLS = `id, order_id, gateway, mode, amount_minor, currency, capture_intent, idempotency_key, fingerprint, status, ambiguous, pending_operation_id, provider_object_id, provider_order_id, provider_authorization_id, provider_capture_id, captured_minor, refunded_minor, version, created_at, updated_at`;

const CAPTURE_INTENTS: readonly LabCaptureIntent[] = ["automatic", "manual"];

export function mapAttemptRow(row: AttemptRow): LabAttempt {
  const provider: LabProviderRefs = {};
  const objectId = requireOptionalText(row.provider_object_id, "provider_object_id");
  const orderRef = requireOptionalText(row.provider_order_id, "provider_order_id");
  const authId = requireOptionalText(row.provider_authorization_id, "provider_authorization_id");
  const captureId = requireOptionalText(row.provider_capture_id, "provider_capture_id");
  if (objectId !== undefined) provider.providerObjectId = objectId;
  if (orderRef !== undefined) provider.providerOrderId = orderRef;
  if (authId !== undefined) provider.providerAuthorizationId = authId;
  if (captureId !== undefined) provider.providerCaptureId = captureId;
  return {
    id: requireNonEmptyText(row.id, "id"),
    orderId: requireNonEmptyText(row.order_id, "order_id"),
    gateway: requireNonEmptyText(row.gateway, "gateway") as LabGateway,
    mode: requireNonEmptyText(row.mode, "mode") as LabMode,
    amountMinor: requireInt(row.amount_minor, "amount_minor"),
    currency: requireNonEmptyText(row.currency, "currency"),
    captureIntent: requireNonEmptyText(row.capture_intent, "capture_intent") as LabCaptureIntent,
    idempotencyKey: requireNonEmptyText(row.idempotency_key, "idempotency_key"),
    fingerprint: requireNonEmptyText(row.fingerprint, "fingerprint"),
    status: requireNonEmptyText(row.status, "status") as LabFinancialStatus,
    ambiguous: requireBooleanInt(row.ambiguous, "ambiguous"),
    pendingOperationId: requireOptionalText(row.pending_operation_id, "pending_operation_id"),
    provider,
    capturedMinor: requireInt(row.captured_minor, "captured_minor"),
    refundedMinor: requireInt(row.refunded_minor, "refunded_minor"),
    version: requireInt(row.version, "version"),
    createdAt: requireNonEmptyText(row.created_at, "created_at"),
    updatedAt: requireNonEmptyText(row.updated_at, "updated_at"),
  };
}

export async function getAttempt(db: D1DatabaseLike, attemptId: string): Promise<LabAttempt> {
  const row = await db
    .prepare(`SELECT ${ATTEMPT_COLS} FROM lab_attempts WHERE id = ?`)
    .bind(attemptId)
    .first<AttemptRow>();
  if (row === null) throw new LabNotFoundError(`attempt not found: ${attemptId}`);
  return mapAttemptRow(row);
}

export async function getAttemptByIdempotency(
  db: D1DatabaseLike,
  gateway: LabGateway,
  mode: LabMode,
  idempotencyKey: string,
): Promise<LabAttempt | null> {
  const row = await db
    .prepare(`SELECT ${ATTEMPT_COLS} FROM lab_attempts WHERE gateway = ? AND mode = ? AND idempotency_key = ?`)
    .bind(gateway, mode, idempotencyKey)
    .first<AttemptRow>();
  return row === null ? null : mapAttemptRow(row);
}

export async function listAttemptsByOrder(db: D1DatabaseLike, orderId: string): Promise<LabAttempt[]> {
  const { results } = await db
    .prepare(`SELECT ${ATTEMPT_COLS} FROM lab_attempts WHERE order_id = ? ORDER BY created_at ASC`)
    .bind(orderId)
    .all<AttemptRow>();
  return results.map((r) => mapAttemptRow(r));
}

export async function reserveAttempt(
  db: D1DatabaseLike,
  input: ReserveAttemptRequest,
  clock: LabClock = systemClock(),
): Promise<ReserveAttemptResult> {
  assertGateway(input.gateway);
  assertMode(input.mode);
  assertCurrency(input.currency);
  assertPositiveMinor(input.amountMinor, "amountMinor");
  assertIdempotencyKey(input.idempotencyKey, "idempotencyKey");
  assertFingerprint(input.fingerprint, "fingerprint");
  if (!CAPTURE_INTENTS.includes(input.captureIntent)) {
    throw new LabValidationError(`unknown captureIntent: ${input.captureIntent}`);
  }
  // Resource correlation: the attempt funds its order exactly.
  const order = await getOrder(db, input.orderId);
  if (input.currency !== order.currency) {
    throw new LabValidationError(
      `attempt currency ${input.currency} does not match order ${order.currency}`,
    );
  }
  if (input.amountMinor !== order.totalMinor) {
    throw new LabValidationError(
      `attempt amount ${input.amountMinor} does not match order total ${order.totalMinor}`,
    );
  }

  // Fast idempotent replay: same key owns this row already.
  const existing = await getAttemptByIdempotency(db, input.gateway, input.mode, input.idempotencyKey);
  if (existing !== null) {
    if (existing.fingerprint !== input.fingerprint) {
      throw new LabConflictError("idempotency key already used with a different fingerprint");
    }
    if (existing.orderId !== input.orderId) {
      throw new LabConflictError("idempotency key already used for a different order");
    }
    return { attempt: existing, replayed: true };
  }

  const now = clock.nowIso();
  const id = input.id ?? newLabId("att");
  const detail = sanitizeDetailJson({
    orderId: input.orderId,
    gateway: input.gateway,
    mode: input.mode,
    amountMinor: input.amountMinor,
    currency: input.currency,
  });
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO lab_attempts (id, order_id, gateway, mode, amount_minor, currency, capture_intent, idempotency_key, fingerprint, status, ambiguous, pending_operation_id, captured_minor, refunded_minor, version, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, 0, 0, 1, ?, ?
           FROM lab_orders WHERE id = ? AND version = ? AND total_minor = ? AND currency = ? AND fulfillment != 'cancelled'`,
        )
        .bind(
          id,
          input.orderId,
          input.gateway,
          input.mode,
          input.amountMinor,
          input.currency,
          input.captureIntent,
          input.idempotencyKey,
          input.fingerprint,
          now,
          now,
          order.id,
          order.version,
          order.totalMinor,
          order.currency,
        ),
      db.prepare(auditInsertSql()).bind("attempt", id, "reserve", detail, now),
    ]);
    if (batchChanges(results, 0) !== 1) {
      throw new LabConflictError("attempt reservation lost a concurrent write; retry");
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent writer won (or this key already exists): resolve deterministically.
    const raced = await getAttemptByIdempotency(db, input.gateway, input.mode, input.idempotencyKey);
    if (raced !== null) {
      if (raced.fingerprint !== input.fingerprint) {
        throw new LabConflictError("idempotency key already used with a different fingerprint");
      }
      if (raced.orderId !== input.orderId) {
        throw new LabConflictError("idempotency key already used for a different order");
      }
      return { attempt: raced, replayed: true };
    }
    throw new LabConflictError("order already has a blocking payment attempt");
  }
  return { attempt: await getAttempt(db, id), replayed: false };
}
