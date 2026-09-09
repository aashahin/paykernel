import {
  hmacSha256Hex,
  InvalidRequestError,
  sha256Hex,
  timingSafeEqualHex,
} from "@paykernel/core";
import { formatTapIsoAmount, parseTapAmount } from "./money";
import type { TapApiObject, TapObjectKind } from "./types";

export function coerceTapPayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.length === 0) {
      throw new InvalidRequestError("Tap webhook payload must be a JSON object");
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new InvalidRequestError("Tap webhook payload is not valid JSON");
    }
  }
  if (payload instanceof Uint8Array) {
    const text = new TextDecoder().decode(payload).trim();
    if (text.length === 0) {
      throw new InvalidRequestError("Tap webhook payload must be a JSON object");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new InvalidRequestError("Tap webhook payload is not valid JSON");
    }
  }
  return payload;
}

export type TapHashFields = {
  id: string;
  amount: string;
  currency: string;
  gatewayReference: string;
  paymentReference: string;
  status: string;
  created: string;
  updated?: string;
};

export function extractHashstringHeader(
  signature?: string,
  headers?: Record<string, string>,
): string | undefined {
  if (typeof signature === "string" && signature.trim().length > 0) {
    return signature.trim();
  }
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "hashstring" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function canonicalTapHashstring(fields: TapHashFields): string {
  // Invoice HMAC is a different field list (`x_updated`, no gateway/payment
  // refs). `hashFieldsFromTapObject` only sets `updated` for object=invoice.
  if (fields.updated !== undefined) {
    return (
      `x_id${fields.id}` +
      `x_amount${fields.amount}` +
      `x_currency${fields.currency}` +
      `x_updated${fields.updated}` +
      `x_status${fields.status}` +
      `x_created${fields.created}`
    );
  }
  return (
    `x_id${fields.id}` +
    `x_amount${fields.amount}` +
    `x_currency${fields.currency}` +
    `x_gateway_reference${fields.gatewayReference}` +
    `x_payment_reference${fields.paymentReference}` +
    `x_status${fields.status}` +
    `x_created${fields.created}`
  );
}

export function computeTapHashstring(
  fields: TapHashFields,
  secretKey: string,
): string {
  return hmacSha256Hex(secretKey, canonicalTapHashstring(fields));
}

export function tapWebhookEventId(payload: unknown): string {
  const fields = hashFieldsFromTapObject(payload);
  const digest = sha256Hex(canonicalTapHashstring(fields));
  return `${fields.id}:${digest}`;
}

function tapHashableObject(
  payload: TapApiObject,
): "charge" | "authorize" | "refund" | "invoice" {
  const object = payload.object;
  if (
    object === "charge" ||
    object === "authorize" ||
    object === "refund" ||
    object === "invoice"
  ) {
    return object;
  }
  throw new InvalidRequestError(
    `Unsupported Tap webhook object ${String(object)} (charge, authorize, refund, or invoice)`,
  );
}

export function hashFieldsFromTapObject(payload: unknown): TapHashFields {
  const normalized = coerceTapPayload(payload);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new InvalidRequestError("Tap webhook payload must be a JSON object");
  }
  const obj = normalized as TapApiObject;
  const kind = tapHashableObject(obj);
  const id = requiredString(obj.id, "id");
  const currency = requiredString(obj.currency, "currency").toUpperCase();
  const status = requiredString(obj.status, "status");
  const amount = formatTapIsoAmount(parseTapAmount(obj.amount, currency), currency);
  const created = extractCreated(obj);
  if (kind === "invoice") {
    return {
      id,
      amount,
      currency,
      gatewayReference: "",
      paymentReference: "",
      status,
      created,
      updated: extractUpdated(obj),
    };
  }
  const reference =
    obj.reference !== null && typeof obj.reference === "object"
      ? (obj.reference as Record<string, unknown>)
      : {};
  const gateway =
    typeof reference.gateway === "string" ? reference.gateway : "";
  const payment =
    typeof reference.payment === "string" ? reference.payment : "";
  return {
    id,
    amount,
    currency,
    gatewayReference: gateway,
    paymentReference: payment,
    status,
    created,
  };
}

export function verifyTapHashstring(
  payload: unknown,
  secretKey: string,
  provided: string | undefined,
): boolean {
  if (provided === undefined || provided.length === 0) return false;
  let fields: TapHashFields;
  try {
    fields = hashFieldsFromTapObject(payload);
  } catch {
    return false;
  }
  const computed = computeTapHashstring(fields, secretKey);
  return timingSafeEqualHex(provided, computed);
}

export function tapObjectKind(payload: unknown): TapObjectKind {
  const normalized = coerceTapPayload(payload);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new InvalidRequestError("Tap webhook payload must be a JSON object");
  }
  const object = (normalized as TapApiObject).object;
  if (object === "charge" || object === "authorize" || object === "refund") {
    return object;
  }
  throw new InvalidRequestError(
    `Unsupported Tap webhook object ${String(object)} (charges, authorize, and refunds only)`,
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRequestError(`Tap webhook missing ${field}`);
  }
  return value;
}

/** Raw `transaction.created` / top-level `created` as Tap sent it (hashstring + Date parse). */
export function tapCreatedRaw(obj: TapApiObject): string | undefined {
  const tx = obj.transaction;
  if (tx !== null && typeof tx === "object" && !Array.isArray(tx)) {
    const created = (tx as { created?: unknown }).created;
    if (typeof created === "string" || typeof created === "number") {
      const value = String(created);
      if (value.length > 0) return value;
    }
  }
  const top = (obj as { created?: unknown }).created;
  if (typeof top === "string" || typeof top === "number") {
    const value = String(top);
    if (value.length > 0) return value;
  }
  return undefined;
}

function extractCreated(obj: TapApiObject): string {
  const created = tapCreatedRaw(obj);
  if (created === undefined) {
    throw new InvalidRequestError("Tap webhook missing created timestamp");
  }
  return created;
}

function extractUpdated(obj: TapApiObject): string {
  const raw = (obj as { updated?: unknown }).updated;
  if (typeof raw === "string" || typeof raw === "number") {
    const value = String(raw);
    if (value.length > 0) return value;
  }
  throw new InvalidRequestError("Tap webhook missing updated timestamp");
}
