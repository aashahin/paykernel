/**
 * Shared D1 binding surface + strict row decoding for the payment lab store.
 *
 * Uses the real Workers D1Database binding type (NOT an invented structural
 * port with an incompatible batch<T> signature) so the parent can pass
 * `env.PAYMENTS_DB` / `env.DB` directly. All values are bound parameters —
 * never interpolate user input into SQL.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { LabValidationError } from "./errors";

/** Real D1 binding. Kept under the historic alias so existing imports keep working. */
export type D1DatabaseLike = D1Database;

export type LabClock = {
  nowIso(): string;
};

export function systemClock(): LabClock {
  return { nowIso: () => new Date().toISOString() };
}

/** ID factory: crypto.randomUUID only. No Math.random fallback, no unsafe casts. */
export function newLabId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** True when the driver reports a uniqueness violation (caller maps to 409). */
export function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const msg =
    error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("unique constraint failed") ||
    lower.includes("unique index") ||
    lower.includes("uq_lab_") ||
    lower.includes("already exists") ||
    lower.includes("primary key")
  );
}

/* ── Typed SELECT row interfaces (decoded strictly, never silent fallbacks) ── */

export interface OrderRow {
  id: unknown;
  guest_token_hash: unknown;
  customer_name: unknown;
  customer_email: unknown;
  total_minor: unknown;
  currency: unknown;
  items_json: unknown;
  fulfillment: unknown;
  notes: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface AttemptRow {
  id: unknown;
  order_id: unknown;
  gateway: unknown;
  mode: unknown;
  amount_minor: unknown;
  currency: unknown;
  capture_intent: unknown;
  idempotency_key: unknown;
  fingerprint: unknown;
  status: unknown;
  ambiguous: unknown;
  pending_operation_id: unknown;
  provider_object_id: unknown;
  provider_order_id: unknown;
  provider_authorization_id: unknown;
  provider_capture_id: unknown;
  captured_minor: unknown;
  refunded_minor: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface OperationRow {
  captured_before_minor: unknown;
  id: unknown;
  attempt_id: unknown;
  kind: unknown;
  idempotency_key: unknown;
  fingerprint: unknown;
  amount_minor: unknown;
  currency: unknown;
  provider_id: unknown;
  status: unknown;
  attempts: unknown;
  next_retry_at: unknown;
  last_error_sanitized: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface RefundRow {
  id: unknown;
  attempt_id: unknown;
  operation_id: unknown;
  provider_refund_id: unknown;
  amount_minor: unknown;
  currency: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface WebhookRow {
  id: unknown;
  gateway: unknown;
  mode: unknown;
  provider_event_id: unknown;
  attempt_id: unknown;
  effect: unknown;
  status: unknown;
  evidence_json: unknown;
  attempts: unknown;
  next_retry_at: unknown;
  last_error_sanitized: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface TestRunRow {
  id: unknown;
  scenario: unknown;
  gateway: unknown;
  mode: unknown;
  verdict: unknown;
  evidence_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface SimulatorRow {
  gateway: unknown;
  mode: unknown;
  state_key: unknown;
  state_json: unknown;
  updated_at: unknown;
}

/* ── Strict decoders: malformed DB values throw, never silently become ''/0/[] ── */

export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new LabValidationError(`corrupt row: ${field} is not text`);
  return value;
}

export function requireNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LabValidationError(`corrupt row: ${field} is empty`);
  }
  return value;
}

export function requireInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new LabValidationError(`corrupt row: ${field} is not an integer`);
}

export function requireOptionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new LabValidationError(`corrupt row: ${field} is not text`);
  return value.length > 0 ? value : undefined;
}

export function requireBooleanInt(value: unknown, field: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new LabValidationError(`corrupt row: ${field} is not 0/1`);
}

/** Read meta.changes for one statement of a D1 batch() result. */
export function batchChanges(
  results: ReadonlyArray<{ meta?: { changes?: unknown } }>,
  index: number,
): number {
  const meta = results[index]?.meta;
  const changes = meta?.changes;
  return typeof changes === "number" && Number.isSafeInteger(changes) ? changes : 0;
}

/**
 * Audit INSERT guard. `WHERE changes() = 1` ties the audit row to the
 * immediately preceding mutation in the same batch(): when the conditional
 * UPDATE/INSERT matched 0 rows (lost race / stale version), no audit row is
 * written. Never guard audits on "new version exists" — a concurrent writer
 * can own that same next version and a failed writer would still log audit.
 */
export function auditInsertSql(): string {
  return `INSERT INTO lab_audit (entity_kind, entity_id, action, detail_json, created_at)
    SELECT ?, ?, ?, ?, ? WHERE changes() = 1`;
}
