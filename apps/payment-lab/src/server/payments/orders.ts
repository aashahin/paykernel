/**
 * Order repository: create / get / list / edit (items+total) / fulfillment / notes.
 *
 * Concurrency contract:
 * - Edits are refused once ANY attempt exists for the order. The check is part
 *   of the conditional UPDATE itself (`NOT EXISTS (lab_attempts ...)`) so a
 *   payment that starts between read and write still blocks the edit.
 * - Every mutation pairs its conditional UPDATE/INSERT with an audit INSERT
 *   guarded by `WHERE changes() = 1` in ONE D1 batch(), so audit rows only
 *   exist when the transition actually matched. Version-existence guards are
 *   never used for audits (a concurrent writer can own the same next version).
 * - Conflict detection reads batch `meta.changes` of the mutation statement —
 *   never a read-after-version comparison. A follow-up read only explains the
 *   conflict (stale version vs attempt-started vs missing), it never decides it.
 */

import type { D1DatabaseLike, LabClock, OrderRow } from "./db";
import {
  auditInsertSql,
  batchChanges,
  newLabId,
  requireInt,
  requireNonEmptyText,
  requireText,
  systemClock,
} from "./db";
import { LabConflictError, LabNotFoundError, LabValidationError } from "./errors";
import type {
  CreateOrderRequest,
  EditOrderRequest,
  LabFulfillment,
  LabLineItem,
  LabOrder,
  UpdateFulfillmentRequest,
  UpdateNotesRequest,
} from "./types";
import {
  assertCurrency,
  assertNonEmptyString,
  assertPositiveMinor,
  assertValidItems,
  sanitizeDetailJson,
} from "./validate";

const ORDER_COLS = `id, guest_token_hash, customer_name, customer_email, total_minor, currency, items_json, fulfillment, notes, version, created_at, updated_at`;

const FULFILLMENTS: readonly LabFulfillment[] = [
  "unfulfilled",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
];

export function mapOrderRow(row: OrderRow): LabOrder {
  const itemsText = requireText(row.items_json, "items_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(itemsText);
  } catch {
    throw new LabValidationError("corrupt row: items_json is not JSON");
  }
  if (!Array.isArray(parsed)) throw new LabValidationError("corrupt row: items_json is not a list");
  return {
    id: requireNonEmptyText(row.id, "id"),
    guestTokenHash: requireNonEmptyText(row.guest_token_hash, "guest_token_hash"),
    customerName: requireNonEmptyText(row.customer_name, "customer_name"),
    customerEmail: requireNonEmptyText(row.customer_email, "customer_email"),
    totalMinor: requireInt(row.total_minor, "total_minor"),
    currency: requireNonEmptyText(row.currency, "currency"),
    items: parsed as LabLineItem[],
    fulfillment: requireNonEmptyText(row.fulfillment, "fulfillment") as LabFulfillment,
    notes: requireText(row.notes, "notes"),
    version: requireInt(row.version, "version"),
    createdAt: requireNonEmptyText(row.created_at, "created_at"),
    updatedAt: requireNonEmptyText(row.updated_at, "updated_at"),
  };
}

export async function createOrder(
  db: D1DatabaseLike,
  input: CreateOrderRequest,
  clock: LabClock = systemClock(),
): Promise<LabOrder> {
  assertNonEmptyString(input.guestTokenHash, "guestTokenHash", 256);
  assertNonEmptyString(input.customerName, "customerName", 200);
  assertNonEmptyString(input.customerEmail, "customerEmail", 320);
  assertPositiveMinor(input.totalMinor, "totalMinor");
  assertCurrency(input.currency);
  assertValidItems(input.items, input.totalMinor);
  if (input.notes !== undefined && input.notes.length > 2000) {
    throw new LabValidationError("notes must be at most 2000 chars");
  }
  const now = clock.nowIso();
  const id = input.id ?? newLabId("ord");
  const detail = sanitizeDetailJson({ op: "create", totalMinor: input.totalMinor, currency: input.currency });
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO lab_orders (id, guest_token_hash, customer_name, customer_email, total_minor, currency, items_json, fulfillment, notes, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unfulfilled', ?, 1, ?, ?)`,
      )
      .bind(
        id,
        input.guestTokenHash,
        input.customerName,
        input.customerEmail,
        input.totalMinor,
        input.currency,
        JSON.stringify(input.items),
        input.notes ?? "",
        now,
        now,
      ),
    db.prepare(auditInsertSql()).bind("order", id, "create", detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) {
    throw new LabConflictError(`order create lost a concurrent write: ${id}`);
  }
  return getOrder(db, id);
}

export async function getOrder(db: D1DatabaseLike, orderId: string): Promise<LabOrder> {
  const row = await db.prepare(`SELECT ${ORDER_COLS} FROM lab_orders WHERE id = ?`).bind(orderId).first<OrderRow>();
  if (row === null) throw new LabNotFoundError(`order not found: ${orderId}`);
  return mapOrderRow(row);
}

export async function listOrders(db: D1DatabaseLike, limit = 50): Promise<LabOrder[]> {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { results } = await db
    .prepare(`SELECT ${ORDER_COLS} FROM lab_orders ORDER BY created_at DESC LIMIT ?`)
    .bind(bounded)
    .all<OrderRow>();
  return results.map((r) => mapOrderRow(r));
}

/** Explain a failed conditional order mutation (decision already came from meta.changes). */
async function explainOrderConflict(db: D1DatabaseLike, orderId: string, expectedVersion: number): Promise<never> {
  const current = await db
    .prepare(`SELECT ${ORDER_COLS} FROM lab_orders WHERE id = ?`)
    .bind(orderId)
    .first<OrderRow>();
  if (current === null) throw new LabNotFoundError(`order not found: ${orderId}`);
  const version = requireInt(current.version, "version");
  if (version !== expectedVersion) {
    throw new LabConflictError(`stale order version: expected ${expectedVersion}, found ${version}`);
  }
  const hit = await db
    .prepare(`SELECT 1 AS one FROM lab_attempts WHERE order_id = ? LIMIT 1`)
    .bind(orderId)
    .first<{ one: unknown }>();
  if (hit !== null) {
    throw new LabConflictError("order is immutable after a payment attempt starts");
  }
  throw new LabConflictError("order update lost a concurrent write; retry with the latest version");
}

export async function editOrder(
  db: D1DatabaseLike,
  input: EditOrderRequest,
  clock: LabClock = systemClock(),
): Promise<LabOrder> {
  assertPositiveMinor(input.totalMinor, "totalMinor");
  assertCurrency(input.currency);
  assertValidItems(input.items, input.totalMinor);
  const now = clock.nowIso();
  const nextVersion = input.expectedVersion + 1;
  const detail = sanitizeDetailJson({
    totalMinor: input.totalMinor,
    currency: input.currency,
    items: input.items.length,
  });
  // Atomic immutability: NOT EXISTS lives inside the UPDATE predicate so a
  // payment beginning between read and write still blocks the edit.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE lab_orders SET total_minor = ?, currency = ?, items_json = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?
         AND NOT EXISTS (SELECT 1 FROM lab_attempts WHERE order_id = ?)`,
      )
      .bind(
        input.totalMinor,
        input.currency,
        JSON.stringify(input.items),
        nextVersion,
        now,
        input.orderId,
        input.expectedVersion,
        input.orderId,
      ),
    db.prepare(auditInsertSql()).bind("order", input.orderId, "edit", detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) {
    await explainOrderConflict(db, input.orderId, input.expectedVersion);
  }
  return getOrder(db, input.orderId);
}

export async function updateOrderFulfillment(
  db: D1DatabaseLike,
  input: UpdateFulfillmentRequest,
  clock: LabClock = systemClock(),
): Promise<LabOrder> {
  if (!FULFILLMENTS.includes(input.fulfillment)) {
    throw new LabValidationError(`unknown fulfillment: ${input.fulfillment}`);
  }
  const now = clock.nowIso();
  const nextVersion = input.expectedVersion + 1;
  const detail = sanitizeDetailJson({ fulfillment: input.fulfillment });
  const results = await db.batch([
    db
      .prepare(`UPDATE lab_orders SET fulfillment = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .bind(input.fulfillment, nextVersion, now, input.orderId, input.expectedVersion),
    db.prepare(auditInsertSql()).bind("order", input.orderId, "fulfillment", detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) {
    await explainOrderConflict(db, input.orderId, input.expectedVersion);
  }
  return getOrder(db, input.orderId);
}

export async function updateOrderNotes(
  db: D1DatabaseLike,
  input: UpdateNotesRequest,
  clock: LabClock = systemClock(),
): Promise<LabOrder> {
  if (input.notes.length > 2000) throw new LabValidationError("notes must be at most 2000 chars");
  const now = clock.nowIso();
  const nextVersion = input.expectedVersion + 1;
  const detail = sanitizeDetailJson({ notesLength: input.notes.length });
  const results = await db.batch([
    db
      .prepare(`UPDATE lab_orders SET notes = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .bind(input.notes, nextVersion, now, input.orderId, input.expectedVersion),
    db.prepare(auditInsertSql()).bind("order", input.orderId, "notes", detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) {
    await explainOrderConflict(db, input.orderId, input.expectedVersion);
  }
  return getOrder(db, input.orderId);
}
