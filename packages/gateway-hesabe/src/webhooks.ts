import {
  attachPaymentEvent,
  hashWebhookPayload,
  InvalidRequestError,
  sha256Hex,
  type Clock,
  type Money,
  type WebhookEvent,
} from "@paykernel/core";
import { parseHesabeKwdAmount } from "./money";
import { mapHesabeEnquiryStatus } from "./status";

export type HesabeCheckedWebhook = {
  token: string;
  amount: Money;
  referenceNumber: string;
  status: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function coerceHesabeWebhookPayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed.length === 0) {
      throw new InvalidRequestError("Hesabe webhook payload must be a JSON object");
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new InvalidRequestError("Hesabe webhook payload is not valid JSON");
    }
  }
  return payload;
}

/**
 * Parse only the checked webhook fields (token / amount / reference_number /
 * status). Never trusts request extras, `rawPayload` financial overrides, or
 * status aliases. Amount is strict KWD (no silent rounding).
 */
export function checkedHesabeWebhookFields(payload: unknown): HesabeCheckedWebhook {
  const normalized = coerceHesabeWebhookPayload(payload);
  const rec = asRecord(normalized);
  const token = rec.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new InvalidRequestError("Hesabe webhook missing token");
  }
  const referenceNumber = rec.reference_number;
  if (typeof referenceNumber !== "string" || referenceNumber.trim().length === 0) {
    throw new InvalidRequestError("Hesabe webhook missing reference_number");
  }
  const amount = parseHesabeKwdAmount(rec.amount);
  const status = rec.status;
  if (typeof status !== "string" || status.trim().length === 0) {
    throw new InvalidRequestError("Hesabe webhook missing status");
  }
  return {
    token: token.trim(),
    amount,
    referenceNumber: referenceNumber.trim(),
    status: status.trim(),
  };
}

/** Deterministic event id from checked fields only (ignores forged datetime). */
export function hesabeWebhookEventId(checked: HesabeCheckedWebhook): string {
  const digest = sha256Hex(
    JSON.stringify([
      checked.token,
      checked.referenceNumber,
      checked.amount.amount,
      checked.amount.currency,
      checked.status.trim().toUpperCase(),
    ]),
  );
  return `${checked.token}:${digest.slice(0, 32)}`;
}

/**
 * Parse a verified webhook into a normalized event. Uses only checked
 * fields; timestamp is the adapter clock (forged `datetime` ignored).
 */
export function parseHesabeWebhookEvent(payload: unknown, clock: Clock): WebhookEvent {
  const checked = checkedHesabeWebhookFields(payload);
  const mapped = mapHesabeEnquiryStatus(checked.status);
  const status = mapped ?? "pending";
  const nativeType = `transaction.${checked.status.trim().toUpperCase()}`;
  const stable =
    mapped === "paid"
      ? "payment.succeeded"
      : mapped === "failed"
        ? "payment.failed"
        : mapped === "pending"
          ? "payment.processing"
          : undefined;
  const base: WebhookEvent = {
    id: hesabeWebhookEventId(checked),
    type: nativeType,
    gateway: "hesabe",
    paymentId: checked.referenceNumber,
    gatewayPaymentId: checked.token,
    status,
    timestamp: clock.now(),
    rawPayload: {
      token: checked.token,
      amount: checked.amount.amount,
      reference_number: checked.referenceNumber,
      status: checked.status,
    },
  };
  base.amount = checked.amount;
  base.currency = checked.amount.currency;
  // Custom adapters supply the stable mapping, then retain the provider's
  // native event type in both metadata copies.
  const attached = attachPaymentEvent(
    { ...base, type: stable ?? nativeType },
    { receivedAt: base.timestamp.toISOString() },
  );
  const provider = attached.provider && { ...attached.provider, eventType: nativeType };
  const event = attached.event && {
    ...attached.event,
    provider: { ...attached.event.provider, eventType: nativeType },
  };
  return {
    ...attached,
    type: nativeType,
    ...(provider ? { provider } : {}),
    ...(event ? { event } : {}),
    payloadHash: hashWebhookPayload({
      id: checked.token,
      status: checked.status.trim().toUpperCase(),
      reference: checked.referenceNumber,
      amount: checked.amount.amount,
    }),
  };
}
