import {
  attachPaymentEvent,
  hashWebhookPayload,
  InvalidRequestError,
  type Money,
  type WebhookEvent,
} from "@paykernel/core";
import { parseTapAmount } from "./money";
import type { TapApiObject } from "./types";
import { tapCreatedRaw, tapWebhookEventId } from "./webhooks";

export function chargeIdFromAuthorize(obj: TapApiObject): string | undefined {
  if (typeof obj.charge_id === "string" && obj.charge_id.startsWith("chg_")) {
    return obj.charge_id;
  }
  const nested = (obj as { charge?: unknown }).charge;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const id = (nested as { id?: unknown }).id;
    if (typeof id === "string" && id.startsWith("chg_")) return id;
  }
  return undefined;
}

export function authorizeIdFromSource(obj: TapApiObject): string | undefined {
  const source = obj.source;
  if (source !== null && typeof source === "object" && !Array.isArray(source)) {
    const id = (source as { id?: unknown }).id;
    if (typeof id === "string" && id.startsWith("auth_")) return id;
  }
  return undefined;
}

export function withRelatedIdsOnPaymentEvent(
  event: NonNullable<WebhookEvent["event"]>,
  relatedIds: {
    authorizationId?: string | undefined;
    chargeId?: string | undefined;
  },
): NonNullable<WebhookEvent["event"]> {
  if (!("payment" in event) || event.payment === undefined) return event;
  const authorizationId = relatedIds.authorizationId;
  const chargeId = relatedIds.chargeId;
  if (authorizationId === undefined && chargeId === undefined) return event;
  const payment = event.payment;
  return {
    ...event,
    payment: {
      ...payment,
      references: {
        ...payment.references,
        relatedIds: {
          ...payment.references.relatedIds,
          ...(authorizationId !== undefined ? { authorizationId } : {}),
          ...(chargeId !== undefined ? { chargeId } : {}),
        },
      },
    },
  };
}

export function tapMetadataPaymentId(obj: TapApiObject): string | undefined {
  const metadata = (obj as { metadata?: unknown }).metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const rec = metadata as Record<string, unknown>;
    for (const key of ["paymentId", "orderId"]) {
      const value = rec[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  const reference = obj.reference;
  if (reference !== null && typeof reference === "object") {
    const order = (reference as { order?: unknown }).order;
    if (typeof order === "string" && order.length > 0) return order;
  }
  return undefined;
}

export function tapWebhookTimestamp(createdRaw: string): Date {
  const asNumber = Number(createdRaw);
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    throw new InvalidRequestError("Tap webhook created timestamp is not a unix time");
  }
  // Tap charge/authorize samples use millisecond unix strings (13 digits).
  // Values below 1e12 are treated as seconds so Date is not 1970.
  const ms = asNumber < 1e12 ? asNumber * 1000 : asNumber;
  return new Date(ms);
}

/**
 * Parse a Tap invoice webhook object into a normalized {@link WebhookEvent}.
 * Invoices stay provider-native (`type: invoice.<status>`, `event.type:
 * provider.unmapped`, no `stableType`) and never fulfill payment. `status` is
 * always `processing` as a nonterminal placeholder, not invoice/payment state;
 * inspect `rawPayload.status` or the related charge events for settlement.
 */
export function parseTapInvoiceWebhookEvent(obj: TapApiObject): WebhookEvent {
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new InvalidRequestError("Tap invoice webhook missing id");
  }
  const id = obj.id;
  const tapStatus = typeof obj.status === "string" ? obj.status : "";
  const createdRaw = tapCreatedRaw(obj);
  if (createdRaw === undefined) {
    throw new InvalidRequestError("Tap webhook missing created timestamp");
  }
  const created = tapWebhookTimestamp(createdRaw);
  const currency =
    typeof obj.currency === "string" ? obj.currency.toUpperCase() : undefined;
  let amount: Money | undefined;
  if (obj.amount !== undefined && currency !== undefined) {
    amount = parseTapAmount(obj.amount, currency);
  }
  const nativeType = `invoice.${tapStatus}`;
  const legacy: WebhookEvent = {
    id: tapWebhookEventId(obj),
    type: nativeType,
    gateway: "tap",
    paymentId: tapMetadataPaymentId(obj),
    gatewayPaymentId: id,
    status: "processing",
    timestamp: created,
    rawPayload: obj,
  };
  if (amount !== undefined) {
    legacy.amount = amount;
    legacy.currency = amount.currency;
  } else if (currency !== undefined) {
    legacy.currency = currency;
  }
  const attached = attachPaymentEvent(legacy);
  const provider = attached.provider
    ? { ...attached.provider, eventType: nativeType }
    : attached.provider;
  const nested = attached.event
    ? {
        ...attached.event,
        provider: { ...attached.event.provider, eventType: nativeType },
      }
    : attached.event;
  return {
    ...attached,
    type: nativeType,
    ...(provider !== undefined ? { provider } : {}),
    ...(nested !== undefined ? { event: nested } : {}),
    payloadHash: hashWebhookPayload({
      id,
      object: "invoice",
      status: tapStatus,
      created: createdRaw,
    }),
  };
}
