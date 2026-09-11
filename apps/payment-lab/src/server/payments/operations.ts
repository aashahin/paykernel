/** Operation ledger: get/list/reserve + version-guarded status marks. */
import type { D1DatabaseLike, LabClock, OperationRow } from "./db";
import {
  auditInsertSql,
  batchChanges,
  isUniqueViolation,
  newLabId,
  requireInt,
  requireNonEmptyText,
  requireOptionalText,
  systemClock,
} from "./db";
import { LabConflictError, LabNotFoundError, LabValidationError } from "./errors";
import type {
  LabOperation,
  LabOperationKind,
  LabOperationStatus,
  MarkOperationRequest,
  ReserveOperationRequest,
  ReserveOperationResult,
} from "./types";
import {
  assertCurrency,
  assertFingerprint,
  assertIdempotencyKey,
  assertNonNegativeMinor,
  assertOperationKind,
  assertPositiveMinor,
  canReserveCapture,
  canReserveRefund,
  isOperationTransitionAllowed,
  sanitizeDetailJson,
} from "./validate";
import { getAttempt } from "./attempts";

export const OP_COLS = `id, attempt_id, kind, idempotency_key, fingerprint, amount_minor, currency, provider_id, status, attempts, next_retry_at, last_error_sanitized, version, created_at, updated_at, captured_before_minor`;

export function mapOperationRow(row: OperationRow): LabOperation {
  return {
    capturedBeforeMinor: row.captured_before_minor == null ? undefined : requireInt(row.captured_before_minor, "captured_before_minor"),
    id: requireNonEmptyText(row.id, "id"),
    attemptId: requireNonEmptyText(row.attempt_id, "attempt_id"),
    kind: requireNonEmptyText(row.kind, "kind") as LabOperationKind,
    idempotencyKey: requireNonEmptyText(row.idempotency_key, "idempotency_key"),
    fingerprint: requireNonEmptyText(row.fingerprint, "fingerprint"),
    amountMinor: requireInt(row.amount_minor, "amount_minor"),
    currency: requireNonEmptyText(row.currency, "currency"),
    providerId: requireOptionalText(row.provider_id, "provider_id"),
    status: requireNonEmptyText(row.status, "status") as LabOperationStatus,
    attempts: requireInt(row.attempts, "attempts"),
    nextRetryAt: requireOptionalText(row.next_retry_at, "next_retry_at"),
    lastError: requireOptionalText(row.last_error_sanitized, "last_error_sanitized"),
    version: requireInt(row.version, "version"),
    createdAt: requireNonEmptyText(row.created_at, "created_at"),
    updatedAt: requireNonEmptyText(row.updated_at, "updated_at"),
  };
}

export async function getOperation(db: D1DatabaseLike, operationId: string): Promise<LabOperation> {
  const row = await db
    .prepare(`SELECT ${OP_COLS} FROM lab_operations WHERE id = ?`)
    .bind(operationId)
    .first<OperationRow>();
  if (row === null) throw new LabNotFoundError(`operation not found: ${operationId}`);
  return mapOperationRow(row);
}

export async function getOperationByIdempotency(
  db: D1DatabaseLike,
  attemptId: string,
  idempotencyKey: string,
): Promise<LabOperation | null> {
  const row = await db
    .prepare(`SELECT ${OP_COLS} FROM lab_operations WHERE attempt_id = ? AND idempotency_key = ?`)
    .bind(attemptId, idempotencyKey)
    .first<OperationRow>();
  return row === null ? null : mapOperationRow(row);
}

export async function listOperationsByAttempt(db: D1DatabaseLike, attemptId: string): Promise<LabOperation[]> {
  const { results } = await db
    .prepare(`SELECT ${OP_COLS} FROM lab_operations WHERE attempt_id = ? ORDER BY created_at ASC`)
    .bind(attemptId)
    .all<OperationRow>();
  return results.map((r) => mapOperationRow(r));
}

async function refundCapacity(db: D1DatabaseLike, attemptId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM lab_refunds WHERE attempt_id = ? AND status IN ('pending','completed')`,
    )
    .bind(attemptId)
    .first<{ total: unknown }>();
  const total = row?.total;
  if (typeof total === "number" && Number.isSafeInteger(total) && total >= 0) return total;
  if (typeof total === "bigint") {
    const n = Number(total);
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  throw new LabValidationError("corrupt row: refund total is not an integer");
}

function kindPredicate(kind: LabOperationKind): string {
  switch (kind) {
    case "create":
      return `AND status IN ('pending','processing') AND ? = amount_minor`;
    case "capture":
      return `AND status IN ('authorized','partially_captured') AND captured_minor + ? <= amount_minor`;
    case "void":
      return `AND status = 'authorized' AND captured_minor = 0 AND ? = 0`;
    case "refund":
      return `AND status IN ('paid','partially_captured','partially_refunded') AND captured_minor > 0 AND (SELECT COALESCE(SUM(amount_minor),0) FROM lab_refunds WHERE attempt_id = lab_attempts.id AND status IN ('pending','completed')) + ? <= captured_minor`;
    case "complete-return":
      return `AND status IN ('pending','processing','approved') AND ? = amount_minor`;
  }
}

export async function reserveOperation(
  db: D1DatabaseLike,
  input: ReserveOperationRequest,
  clock: LabClock = systemClock(),
): Promise<ReserveOperationResult> {
  assertOperationKind(input.kind);
  assertIdempotencyKey(input.idempotencyKey, "idempotencyKey");
  assertFingerprint(input.fingerprint, "fingerprint");
  assertCurrency(input.currency);
  if (input.kind === "void") assertNonNegativeMinor(input.amountMinor, "amountMinor");
  else assertPositiveMinor(input.amountMinor, "amountMinor");
  if (input.providerId !== undefined && (input.providerId.length === 0 || input.providerId.length > 256)) {
    throw new LabValidationError("providerId must be 1..256 chars");
  }

  const attempt = await getAttempt(db, input.attemptId);
  if (input.currency !== attempt.currency) {
    throw new LabValidationError(`operation currency ${input.currency} does not match attempt ${attempt.currency}`);
  }

  const existing = await getOperationByIdempotency(db, input.attemptId, input.idempotencyKey);
  if (existing !== null) {
    if (existing.fingerprint !== input.fingerprint) {
      throw new LabConflictError("operation idempotency key already used with a different fingerprint");
    }
    return { operation: existing, replayed: true };
  }

  // JS pre-checks (SQL predicates re-enforce atomically to win races).
  if (input.kind === "capture") {
    if (!canReserveCapture(attempt.status)) throw new LabConflictError(`capture not allowed from ${attempt.status}`);
    if (input.amountMinor > attempt.amountMinor - attempt.capturedMinor) {
      throw new LabConflictError("capture amount exceeds authorized remaining");
    }
  } else if (input.kind === "void") {
    if (attempt.status !== "authorized" || attempt.capturedMinor !== 0 || input.amountMinor !== 0) {
      throw new LabConflictError("void allowed only for uncaptured authorization");
    }
  } else if (input.kind === "refund") {
    const allowed = canReserveRefund(attempt.status);
    if (!allowed) throw new LabConflictError(`refund not allowed from ${attempt.status}`);
    if (attempt.capturedMinor <= 0) throw new LabConflictError("refund requires captured money");
    const used = await refundCapacity(db, attempt.id);
    if (used + input.amountMinor > attempt.capturedMinor) {
      throw new LabConflictError("refund total (settled + pending) would exceed captured total");
    }
  } else {
    if (input.amountMinor !== attempt.amountMinor) {
      throw new LabValidationError("create operation amount must equal attempt amount");
    }
    if (attempt.status !== "pending" && attempt.status !== "processing" && !(input.kind === "complete-return" && attempt.status === "approved")) {
      throw new LabConflictError(`create not allowed from ${attempt.status}`);
    }
  }

  const now = clock.nowIso();
  const id = input.id ?? newLabId("op");
  const detail = sanitizeDetailJson({ kind: input.kind, amountMinor: input.amountMinor, currency: input.currency });
  const attemptDetail = sanitizeDetailJson({ pendingOperationId: id, kind: input.kind });
  // Atomic gate: INSERT SELECT pins attempt version + status/amount/capacity + no pending.
  const insertSql = `INSERT INTO lab_operations (id, attempt_id, kind, idempotency_key, fingerprint, amount_minor, currency, provider_id, status, attempts, next_retry_at, last_error_sanitized, version, created_at, updated_at, captured_before_minor)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 0, NULL, NULL, 1, ?, ?, captured_minor FROM lab_attempts
    WHERE id = ? AND version = ? AND currency = ? AND pending_operation_id IS NULL ${kindPredicate(input.kind)}`;
  try {
    const results = await db.batch([
      db.prepare(insertSql).bind(
        id, input.attemptId, input.kind, input.idempotencyKey, input.fingerprint,
        input.amountMinor, input.currency, input.providerId ?? null, now, now,
        attempt.id, attempt.version, attempt.currency, input.amountMinor,
      ),
      db.prepare(auditInsertSql()).bind("operation", id, "reserve", detail, now),
      // Chained on audit (mirrors insert): runs only when insert matched.
      db.prepare(
        `UPDATE lab_attempts SET pending_operation_id = ?, ambiguous = 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND pending_operation_id IS NULL AND changes() = 1`,
      ).bind(id, now, attempt.id, attempt.version),
      db.prepare(auditInsertSql()).bind("attempt", attempt.id, "operation-pending", attemptDetail, now),
    ]);
    if (batchChanges(results, 0) !== 1 || batchChanges(results, 2) !== 1) {
      throw new LabConflictError("operation reservation lost a concurrent write; retry");
    }
  } catch (error) {
    if (!isUniqueViolation(error)) {
      if (error instanceof LabConflictError) {
        // 0-change path: resolve replay vs real conflict deterministically.
        const raced = await getOperationByIdempotency(db, input.attemptId, input.idempotencyKey);
        if (raced !== null) {
          if (raced.fingerprint !== input.fingerprint) {
            throw new LabConflictError("operation idempotency key already used with a different fingerprint");
          }
          return { operation: raced, replayed: true };
        }
      }
      throw error;
    }
    const raced = await getOperationByIdempotency(db, input.attemptId, input.idempotencyKey);
    if (raced !== null) {
      if (raced.fingerprint !== input.fingerprint) {
        throw new LabConflictError("operation idempotency key already used with a different fingerprint");
      }
      return { operation: raced, replayed: true };
    }
    throw new LabConflictError("another unresolved operation is already in progress for this attempt");
  }
  return { operation: await getOperation(db, id), replayed: false };
}

async function markOperationTo(
  db: D1DatabaseLike,
  input: MarkOperationRequest,
  to: LabOperationStatus,
  clock: LabClock,
): Promise<LabOperation> {
  const op = await getOperation(db, input.operationId);
  if (op.version !== input.expectedVersion) {
    throw new LabConflictError(`stale operation version: expected ${input.expectedVersion}, found ${op.version}`);
  }
  if (!isOperationTransitionAllowed(op.status, to)) {
    throw new LabConflictError(`operation transition not allowed: ${op.status} -> ${to}`);
  }
  const now = clock.nowIso();
  const nextRetry = input.nextRetryAt ?? null;
  const lastError = input.lastError ?? null;
  const completes = to === "completed" || to === "failed";

  if (op.status === to) {
    // Idempotent re-delivery: refresh retry/error without version churn.
    const results = await db.batch([
      db.prepare(
        `UPDATE lab_operations SET next_retry_at = ?, last_error_sanitized = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?`,
      ).bind(nextRetry, lastError, now, op.id, op.version, op.status),
      db.prepare(auditInsertSql()).bind("operation", op.id, `mark-${to}`, sanitizeDetailJson({ replay: true }), now),
    ]);
    if (batchChanges(results, 0) !== 1) {
      throw new LabConflictError("operation mark lost a concurrent write; retry");
    }
    return getOperation(db, op.id);
  }

  const opDetail = sanitizeDetailJson({ from: op.status, to });
  const attemptDetail = sanitizeDetailJson({ operationId: op.id, to });
  const pendingValue: string | null = completes ? null : op.id;
  const ambiguousValue = completes ? 0 : 1;
  const results = await db.batch([
    db.prepare(
      `UPDATE lab_operations SET status = ?, version = version + 1, attempts = attempts + 1, next_retry_at = ?, last_error_sanitized = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?`,
    ).bind(to, nextRetry, lastError, now, op.id, op.version, op.status),
    db.prepare(auditInsertSql()).bind("operation", op.id, `mark-${to}`, opDetail, now),
    // Chained on audit (mirrors op update): only runs when op update matched.
    db.prepare(
      `UPDATE lab_attempts SET pending_operation_id = ?, ambiguous = ?, version = version + 1, updated_at = ? WHERE id = ? AND changes() = 1`,
    ).bind(pendingValue, ambiguousValue, now, op.attemptId),
    db.prepare(auditInsertSql()).bind("attempt", op.attemptId, `operation-${to}`, attemptDetail, now),
  ]);
  if (batchChanges(results, 0) !== 1) {
    throw new LabConflictError("operation mark lost a concurrent write; retry");
  }
  if (batchChanges(results, 2) !== 1) {
    throw new LabConflictError("operation mark left attempt inconsistent; retry");
  }
  return getOperation(db, op.id);
}

export function markOperationSubmitted(db: D1DatabaseLike, input: MarkOperationRequest, clock: LabClock = systemClock()): Promise<LabOperation> {
  return markOperationTo(db, input, "submitted", clock);
}
export function markOperationPending(db: D1DatabaseLike, input: MarkOperationRequest, clock: LabClock = systemClock()): Promise<LabOperation> {
  return markOperationTo(db, input, "pending", clock);
}
export function markOperationCompleted(db: D1DatabaseLike, input: MarkOperationRequest, clock: LabClock = systemClock()): Promise<LabOperation> {
  return markOperationTo(db, input, "completed", clock);
}
export function markOperationFailed(db: D1DatabaseLike, input: MarkOperationRequest, clock: LabClock = systemClock()): Promise<LabOperation> {
  return markOperationTo(db, input, "failed", clock);
}
export function markOperationIndeterminate(db: D1DatabaseLike, input: MarkOperationRequest, clock: LabClock = systemClock()): Promise<LabOperation> {
  return markOperationTo(db, input, "indeterminate", clock);
}
/** Generic version-guarded transition (same guards as named marks). */
export function markOperationStatus(
  db: D1DatabaseLike,
  input: MarkOperationRequest & { status: LabOperationStatus },
  clock: LabClock = systemClock(),
): Promise<LabOperation> {
  return markOperationTo(db, input, input.status, clock);
}
