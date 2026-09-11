import type { D1DatabaseLike, LabClock, WebhookRow } from "./db";
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
  LabGateway,
  LabMode,
  LabWebhook,
  LabWebhookEffect,
  LabWebhookStatus,
  MarkWebhookRequest,
  RecordWebhookRequest,
  RecordWebhookResult,
} from "./types";
import { assertGateway, assertMode, assertNonEmptyString, sanitizeDetailJson, sanitizeEvidenceJson } from "./validate";

const WEBHOOK_COLS = `id, gateway, mode, provider_event_id, attempt_id, effect, status, evidence_json, attempts, next_retry_at, last_error_sanitized, created_at, updated_at`;
const EFFECTS: readonly LabWebhookEffect[] = ["matched", "mismatched", "unmatched"];
const MAX_ERROR_CHARS = 1000;

export function mapWebhookRow(row: WebhookRow): LabWebhook {
  return {
    id: requireNonEmptyText(row.id, "id"),
    gateway: requireNonEmptyText(row.gateway, "gateway") as LabGateway,
    mode: requireNonEmptyText(row.mode, "mode") as LabMode,
    providerEventId: requireNonEmptyText(row.provider_event_id, "provider_event_id"),
    attemptId: requireOptionalText(row.attempt_id, "attempt_id"),
    effect: requireNonEmptyText(row.effect, "effect") as LabWebhookEffect,
    status: requireNonEmptyText(row.status, "status") as LabWebhookStatus,
    evidenceJson: requireNonEmptyText(row.evidence_json, "evidence_json"),
    attempts: requireInt(row.attempts, "attempts"),
    nextRetryAt: requireOptionalText(row.next_retry_at, "next_retry_at"),
    lastError: requireOptionalText(row.last_error_sanitized, "last_error_sanitized"),
    createdAt: requireNonEmptyText(row.created_at, "created_at"),
    updatedAt: requireNonEmptyText(row.updated_at, "updated_at"),
  };
}

function assertEffect(value: string): asserts value is LabWebhookEffect {
  if (!EFFECTS.includes(value as LabWebhookEffect)) throw new LabValidationError(`unknown webhook effect: ${value}`);
}

function assertBoundedError(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length > MAX_ERROR_CHARS) throw new LabValidationError("lastError too large");
  return value.length > 0 ? value : null;
}

export async function getWebhook(db: D1DatabaseLike, webhookId: string): Promise<LabWebhook> {
  const row = await db.prepare(`SELECT ${WEBHOOK_COLS} FROM lab_webhooks WHERE id = ?`).bind(webhookId).first<WebhookRow>();
  if (row === null) throw new LabNotFoundError(`webhook not found: ${webhookId}`);
  return mapWebhookRow(row);
}

export async function getWebhookByEvent(
  db: D1DatabaseLike,
  gateway: LabGateway,
  mode: LabMode,
  providerEventId: string,
): Promise<LabWebhook | null> {
  const row = await db
    .prepare(`SELECT ${WEBHOOK_COLS} FROM lab_webhooks WHERE gateway = ? AND mode = ? AND provider_event_id = ?`)
    .bind(gateway, mode, providerEventId)
    .first<WebhookRow>();
  return row === null ? null : mapWebhookRow(row);
}

export async function listWebhooksByAttempt(db: D1DatabaseLike, attemptId: string): Promise<LabWebhook[]> {
  const { results } = await db
    .prepare(`SELECT ${WEBHOOK_COLS} FROM lab_webhooks WHERE attempt_id = ? ORDER BY created_at ASC`)
    .bind(attemptId)
    .all<WebhookRow>();
  return results.map((r) => mapWebhookRow(r));
}

export async function listPendingWebhooks(db: D1DatabaseLike, limit = 50): Promise<LabWebhook[]> {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { results } = await db
    .prepare(`SELECT ${WEBHOOK_COLS} FROM lab_webhooks WHERE status = 'received' ORDER BY created_at ASC LIMIT ?`)
    .bind(bounded)
    .all<WebhookRow>();
  return results.map((r) => mapWebhookRow(r));
}

export async function listWebhooksDueRetry(db: D1DatabaseLike, nowIso: string, limit = 50): Promise<LabWebhook[]> {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { results } = await db
    .prepare(
      `SELECT ${WEBHOOK_COLS} FROM lab_webhooks WHERE status IN ('received','failed') AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(nowIso, bounded)
    .all<WebhookRow>();
  return results.map((r) => mapWebhookRow(r));
}

export async function recordWebhook(
  db: D1DatabaseLike,
  input: RecordWebhookRequest,
  clock: LabClock = systemClock(),
): Promise<RecordWebhookResult> {
  assertGateway(input.gateway);
  assertMode(input.mode);
  assertNonEmptyString(input.providerEventId, "providerEventId", 256);
  assertEffect(input.effect);
  const evidenceJson = sanitizeEvidenceJson(input.evidenceJson);
  const existing = await getWebhookByEvent(db, input.gateway, input.mode, input.providerEventId);
  if (existing !== null) return { webhook: existing, replayed: true };
  const now = clock.nowIso();
  const id = input.id ?? newLabId("wh");
  const detail = sanitizeDetailJson({ gateway: input.gateway, mode: input.mode, effect: input.effect });
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO lab_webhooks (id, gateway, mode, provider_event_id, attempt_id, effect, status, evidence_json, attempts, next_retry_at, last_error_sanitized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'received', ?, 0, NULL, NULL, ?, ?)`,
        )
        .bind(id, input.gateway, input.mode, input.providerEventId, input.attemptId ?? null, input.effect, evidenceJson, now, now),
      db.prepare(auditInsertSql()).bind("webhook", id, "received", detail, now),
    ]);
    if (batchChanges(results, 0) !== 1) throw new LabConflictError("webhook insert lost a concurrent write; retry");
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await getWebhookByEvent(db, input.gateway, input.mode, input.providerEventId);
    if (raced !== null) return { webhook: raced, replayed: true };
    throw new LabConflictError("webhook insert lost a concurrent write; retry");
  }
  return { webhook: await getWebhook(db, id), replayed: false };
}

async function markWebhookTo(
  db: D1DatabaseLike,
  input: MarkWebhookRequest,
  to: LabWebhookStatus,
  clock: LabClock,
): Promise<LabWebhook> {
  const current = await getWebhook(db, input.webhookId);
  if (current.status === "processed") return current;
  const now = clock.nowIso();
  const nextRetry = input.nextRetryAt ?? null;
  if (nextRetry !== null && (nextRetry.length === 0 || nextRetry.length > 128)) {
    throw new LabValidationError("nextRetryAt must be 1..128 chars");
  }
  const lastError = assertBoundedError(input.lastError);
  if (current.status === to) {
    const results = await db.batch([
      db
        .prepare(`UPDATE lab_webhooks SET next_retry_at = ?, last_error_sanitized = ?, updated_at = ? WHERE id = ?`)
        .bind(nextRetry, lastError, now, current.id),
      db.prepare(auditInsertSql()).bind("webhook", current.id, `mark-${to}`, sanitizeDetailJson({ replay: true }), now),
    ]);
    if (batchChanges(results, 0) !== 1) throw new LabConflictError("webhook mark lost a concurrent write; retry");
    return getWebhook(db, current.id);
  }
  const detail = sanitizeDetailJson({ from: current.status, to });
  const results = await db.batch([
    db
      .prepare(
        `UPDATE lab_webhooks SET status = ?, attempts = attempts + 1, next_retry_at = ?, last_error_sanitized = ?, updated_at = ? WHERE id = ? AND status = ?`,
      )
      .bind(to, nextRetry, lastError, now, current.id, current.status),
    db.prepare(auditInsertSql()).bind("webhook", current.id, `mark-${to}`, detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) throw new LabConflictError("webhook mark lost a concurrent write; retry");
  return getWebhook(db, current.id);
}

export function markWebhookProcessed(
  db: D1DatabaseLike,
  input: MarkWebhookRequest,
  clock: LabClock = systemClock(),
): Promise<LabWebhook> {
  return markWebhookTo(db, input, "processed", clock);
}

export function markWebhookFailed(
  db: D1DatabaseLike,
  input: MarkWebhookRequest,
  clock: LabClock = systemClock(),
): Promise<LabWebhook> {
  return markWebhookTo(db, input, "failed", clock);
}

export function markWebhookStatus(
  db: D1DatabaseLike,
  input: MarkWebhookRequest & { status: LabWebhookStatus },
  clock: LabClock = systemClock(),
): Promise<LabWebhook> {
  if (input.status !== "received" && input.status !== "processed" && input.status !== "failed") {
    throw new LabValidationError(`unknown webhook status: ${input.status}`);
  }
  return markWebhookTo(db, input, input.status, clock);
}

export type RecordWebhookRejectionRequest = {
  id?: string | undefined;
  gateway: LabGateway;
  mode: LabMode;
  providerEventId: string;
  reason?: string | undefined;
  payloadHash?: string | undefined;
};

export async function recordWebhookRejection(
  db: D1DatabaseLike,
  input: RecordWebhookRejectionRequest,
  clock: LabClock = systemClock(),
): Promise<{ id: string }> {
  assertGateway(input.gateway);
  assertMode(input.mode);
  assertNonEmptyString(input.providerEventId, "providerEventId", 256);
  const reason = input.reason ?? "invalid_signature";
  assertNonEmptyString(reason, "reason", 128);
  const payloadHash = input.payloadHash ?? "";
  if (payloadHash.length > 256) throw new LabValidationError("payloadHash too large");
  const now = clock.nowIso();
  const id = input.id ?? newLabId("whr");
  await db
    .prepare(
      `INSERT INTO lab_webhook_rejections (id, gateway, mode, provider_event_id, reason_sanitized, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.gateway, input.mode, input.providerEventId, reason, payloadHash, now)
    .run();
  return { id };
}
