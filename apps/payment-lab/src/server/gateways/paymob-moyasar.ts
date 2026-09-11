import {
  createDefaultGatewayContext,
  InvalidRequestError,
  moyasarGateway,
  paymobGateway,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type IdempotencyRecord,
  type IdempotencyStore,
  type PaymobIdempotencyRecord,
  type PaymobIdempotencyStore,
  type WebhookEvent,
} from "@paykernel/core";
import type {
  CreateSandboxDriverOptions,
  SandboxCaptureInput,
  SandboxCompleteReturnInput,
  SandboxCreateInput,
  SandboxGatewayDriver,
  SandboxRefundInput,
  SandboxVoidInput,
  SandboxWebhookInput,
} from "./types";
import { z } from "zod";
import { createPaymobInquiry } from "./paymob-inquiry";
import { GatewayActionNotSubmittedError } from "./types";
import { normalizeMoyasarSale } from "./moyasar-payment";

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

function required(value: unknown, field: string): string {
  const out = trimmed(value);
  if (out === undefined) {
    throw new InvalidRequestError(`${field} must be a non-empty string`);
  }
  return out;
}

function assertUrl(value: unknown, field: string): string {
  const out = required(value, field);
  try {
    const parsed = new URL(out);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new InvalidRequestError(`${field} must be a valid HTTP(S) URL`);
    }
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    throw new InvalidRequestError(`${field} must be a valid HTTP(S) URL`);
  }
  return out;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new InvalidRequestError("customer.name must be a non-empty string");
  }
  if (parts.length === 1) {
    const only = parts[0] as string;
    return { firstName: only, lastName: only };
  }
  return { firstName: parts[0] as string, lastName: parts.slice(1).join(" ") };
}

function parseJsonOnce(rawBody: unknown): unknown {
  if (typeof rawBody === "string") {
    const text = rawBody.trim();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new InvalidRequestError("webhook rawBody is not valid JSON");
    }
  }
  if (rawBody instanceof Uint8Array) {
    const text = new TextDecoder().decode(rawBody).trim();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new InvalidRequestError("webhook rawBody is not valid JSON");
    }
  }
  return rawBody;
}

function parseIntegrationId(raw: unknown): string | number | undefined {
  const out = trimmed(raw);
  if (out === undefined) return undefined;
  return /^\d+$/.test(out) ? Number(out) : out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PAYMOB_STORE_TTL_MS = 24 * 60 * 60 * 1000;

function toPaymobRecord(record: IdempotencyRecord): PaymobIdempotencyRecord {
  const out: PaymobIdempotencyRecord = {
    fingerprint: record.fingerprint,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.createdAt + PAYMOB_STORE_TTL_MS,
  };
  if ("result" in record) {
    return { ...out, result: record.result };
  }
  return out;
}

function adaptToPaymobStore(store: IdempotencyStore): PaymobIdempotencyStore {
  return {
    async reserve(
      key: string,
      record: PaymobIdempotencyRecord,
    ): Promise<PaymobIdempotencyRecord | undefined> {
      const existing = await store.reserve(key, {
        status: record.status,
        fingerprint: record.fingerprint,
        createdAt: record.createdAt,
        ...("result" in record ? { result: record.result } : {}),
      });
      return existing === undefined ? undefined : toPaymobRecord(existing);
    },
    async get(key: string): Promise<PaymobIdempotencyRecord | undefined> {
      const found = await store.get(key);
      return found === undefined ? undefined : toPaymobRecord(found);
    },
    async set(key: string, record: PaymobIdempotencyRecord): Promise<void> {
      await store.set(key, {
        status: record.status,
        fingerprint: record.fingerprint,
        createdAt: record.createdAt,
        ...("result" in record ? { result: record.result } : {}),
      });
    },
    async delete(key: string): Promise<void> {
      await store.delete(key);
    },
  };
}

export function createPaymobMoyasarDriver(
  options: CreateSandboxDriverOptions,
): SandboxGatewayDriver {
  const ctx = createDefaultGatewayContext();

  if (options.gateway === "paymob") {
    const secretKey = required(options.secrets.PAYMOB_SECRET_KEY, "paymob.PAYMOB_SECRET_KEY");
    const publicKey = required(options.secrets.PAYMOB_PUBLIC_KEY, "paymob.PAYMOB_PUBLIC_KEY");
    const hmacSecret = trimmed(options.secrets.PAYMOB_HMAC_SECRET);
    const integrationId = parseIntegrationId(options.secrets.PAYMOB_INTEGRATION_ID);
    if (integrationId === undefined) {
      throw new InvalidRequestError("paymob.PAYMOB_INTEGRATION_ID must be a non-empty string");
    }
    const authIntegrationId = parseIntegrationId(options.secrets.PAYMOB_AUTH_INTEGRATION_ID);
    const apiKey = required(options.secrets.PAYMOB_API_KEY, "paymob.PAYMOB_API_KEY");
    const inquiry = createPaymobInquiry(apiKey);
    // Management includes a transaction-inquiry preflight, which needs legacy auth.
    const management = paymobGateway({ region: "eg", apiKey,
      ...(options.idempotencyStore ? { idempotencyStore: adaptToPaymobStore(options.idempotencyStore) } : {}),
    }).create(ctx);
    const gw = paymobGateway({
      region: "eg",
      secretKey,
      publicKey,
      integrationId,
      ...(hmacSecret !== undefined ? { hmacSecret } : {}),
      ...(authIntegrationId !== undefined ? { authIntegrationId } : {}),
      ...(options.idempotencyStore !== undefined
        ? { idempotencyStore: adaptToPaymobStore(options.idempotencyStore) }
        : {}),
    }).create(ctx);

    return {
      gateway: "paymob",
      async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
        if (input.sourceToken !== undefined) {
          throw new InvalidRequestError("Paymob driver does not accept sourceToken");
        }
        const reference = required(input.reference, "reference");
        const idempotencyKey = required(input.idempotencyKey, "idempotencyKey");
        // Same URL drives Paymob notification_url + redirection_url (GET return + POST notify).
        const callbackUrl = assertUrl(input.callbackUrl, "callbackUrl");
        const { firstName, lastName } = splitName(required(input.customer.name, "customer.name"));
        const email = required(input.customer.email, "customer.email");
        const phone = required(input.customer.phone, "customer.phone");
        if (phone.length < 5) {
          throw new InvalidRequestError("customer.phone must be at least 5 characters for Paymob");
        }
        const capture = input.capture ?? true;
        if (capture === false && authIntegrationId === undefined && trimmed(input.method) === undefined) {
          throw new InvalidRequestError(
            "paymob capture:false requires PAYMOB_AUTH_INTEGRATION_ID or method override (manual AUTH integration)",
          );
        }
        const methodOverride = parseIntegrationId(input.method);
        const currency = input.amount.currency;
        const result = await gw.createPayment({
          amount: input.amount,
          currency,
          orderId: reference,
          callbackUrl,
          capture,
          idempotencyKey,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          paymobBillingData: { email, firstName, lastName, phone },
          ...(methodOverride !== undefined ? { paymobIntegrationId: methodOverride } : {}),
        });
        const receipt = z.object({ intention_order_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional() }).parse(result.rawResponse);
        return { ...result, ...(receipt.intention_order_id !== undefined ? { orderId: String(receipt.intention_order_id) } : {}) };
      },
      async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
        const id = required(gatewayPaymentId, "gatewayPaymentId");
        return inquiry.lookup(id);
      },
      lookupByReference: inquiry.lookupByReference,
      async capture(input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
        return management.capturePayment({
          gatewayPaymentId: required(input.gatewayPaymentId, "gatewayPaymentId"),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
        });
      },
      async void(input: SandboxVoidInput): Promise<GatewayPaymentResult> {
        return management.voidPayment({
          gatewayPaymentId: required(input.gatewayPaymentId, "gatewayPaymentId"),
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
        });
      },
      async refund(input: SandboxRefundInput): Promise<GatewayRefundResult> {
        // A failed read cannot move money. Keep it distinct from a lost POST response.
        try { await inquiry.lookup(input.gatewayPaymentId); }
        catch { throw new GatewayActionNotSubmittedError("Paymob transaction lookup failed; no refund was sent. Retry after checking gateway credentials."); }
        return management.refundPayment({
          gatewayPaymentId: required(input.gatewayPaymentId, "gatewayPaymentId"),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
        });
      },
      async recoverRefund(idempotencyKey: string): Promise<GatewayRefundResult | undefined> {
        const record = await options.idempotencyStore?.get(`refundPayment:${idempotencyKey}`);
        if (record?.status !== "completed") return undefined;
        const receipt = z.object({ gatewayRefundId: z.string().min(1),
          status: z.enum(["completed", "pending", "failed"]), outcome: z.enum(["succeeded", "pending", "failed"]),
          totalRefunded: z.object({ amount: z.string(), currency: z.string() }).optional(),
        }).safeParse(record.result);
        return receipt.success ? { ...receipt.data, rawResponse: null } : undefined;
      },
      async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
        const stored = required(input.storedGatewayPaymentId, "storedGatewayPaymentId");
        return inquiry.lookup(stored);
      },
      async verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent> {
        const parsed = parseJsonOnce(input.rawBody);
        const payload: unknown =
          isRecord(parsed) || typeof parsed === "string" || parsed instanceof Uint8Array
            ? parsed
            : isRecord(input.query) && Object.keys(input.query).length > 0
              ? { ...input.query }
              : parsed;
        const signature =
          trimmed(input.signature) ?? trimmed(input.query?.["hmac"]);
        const ok = gw.verifyWebhook(payload, signature);
        if (!ok) {
          throw new InvalidRequestError("Paymob webhook HMAC verification failed");
        }
        return gw.parseWebhookEvent(payload);
      },
    };
  }

  if (options.gateway === "moyasar") {
    const secretKey = required(options.secrets.MOYASAR_SECRET_KEY, "moyasar.MOYASAR_SECRET_KEY");
    if (!secretKey.startsWith("sk_test_")) {
      throw new InvalidRequestError("moyasar sandbox driver requires an sk_test_ secret key");
    }
    const publishableKey = trimmed(options.secrets.MOYASAR_PUBLISHABLE_KEY);
    const webhookSecret = trimmed(options.secrets.MOYASAR_WEBHOOK_SECRET);
    const gw = moyasarGateway({
      secretKey,
      ...(publishableKey !== undefined ? { publishableKey } : {}),
      ...(webhookSecret !== undefined ? { webhookSecret } : {}),
      ...(options.idempotencyStore !== undefined
        ? { idempotencyStore: options.idempotencyStore }
        : {}),
    }).create(ctx);

    return {
      gateway: "moyasar",
      async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
        // Browser token only: Moyasar.js tokenizes PAN elsewhere; this backend never sees cards.
        const token = required(input.sourceToken, "moyasar.sourceToken");
        if (!token.startsWith("token_")) {
          throw new InvalidRequestError(
            "moyasar.sourceToken must be a browser token (token_…); raw PAN is never accepted",
          );
        }
        if (trimmed(input.method) !== undefined) {
          throw new InvalidRequestError("Moyasar driver does not accept method");
        }
        const reference = required(input.reference, "reference");
        const idempotencyKey = required(input.idempotencyKey, "idempotencyKey");
        const callbackUrl = assertUrl(input.callbackUrl, "callbackUrl");
        required(input.customer.name, "customer.name");
        required(input.customer.email, "customer.email");
        const currency = input.amount.currency;
        return normalizeMoyasarSale(await gw.createPayment({
          amount: input.amount,
          currency,
          orderId: reference,
          callbackUrl,
          capture: input.capture ?? true,
          idempotencyKey,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          moyasarSource: { type: "token", token },
        }));
      },
      async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
        const id = required(gatewayPaymentId, "gatewayPaymentId");
        return normalizeMoyasarSale(await gw.getPayment({ gatewayPaymentId: id }));
      },
      async capture(input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
        return gw.capturePayment({
          gatewayPaymentId: required(input.gatewayPaymentId, "gatewayPaymentId"),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
        });
      },
      async void(input: SandboxVoidInput): Promise<GatewayPaymentResult> {
        return gw.voidPayment({
          gatewayPaymentId: required(input.gatewayPaymentId, "gatewayPaymentId"),
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
        });
      },
      async refund(input: SandboxRefundInput): Promise<GatewayRefundResult> {
        return gw.refundPayment({
          gatewayPaymentId: required(input.gatewayPaymentId, "gatewayPaymentId"),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
        });
      },
      async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
        const stored = required(input.storedGatewayPaymentId, "storedGatewayPaymentId");
        return normalizeMoyasarSale(await gw.getPayment({ gatewayPaymentId: stored }));
      },
      async verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent> {
        const parsed = parseJsonOnce(input.rawBody);
        const ok = gw.verifyWebhook(parsed);
        if (!ok) {
          throw new InvalidRequestError("Moyasar webhook secret verification failed");
        }
        return gw.parseWebhookEvent(parsed);
      },
    };
  }

  throw new InvalidRequestError(
    `createPaymobMoyasarDriver supports paymob, moyasar only (got "${String(options.gateway)}")`,
  );
}
