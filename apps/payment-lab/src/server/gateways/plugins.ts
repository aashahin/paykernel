import {
  InvalidRequestError,
  OperationNotSupportedError,
  createDefaultGatewayContext,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type WebhookEvent,
} from "@paykernel/core";
import { tapGateway } from "@paykernel/gateway-tap";
import { myfatoorahGateway } from "@paykernel/gateway-myfatoorah";
import { hesabeGateway } from "@paykernel/gateway-hesabe";
import type { MyFatoorahCountry } from "@paykernel/gateway-myfatoorah";
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

function assertHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty HTTPS URL`);
  }
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidRequestError(`${field} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidRequestError(`${field} must be an HTTPS URL (sandbox only)`);
  }
  return trimmed;
}

function assertSandboxTapKey(secretKey: string | undefined): string {
  if (typeof secretKey !== "string" || secretKey.trim().length === 0) {
    throw new InvalidRequestError("tap.TAP_SECRET_KEY must be a non-empty string");
  }
  const trimmed = secretKey.trim();
  if (/^sk_live/i.test(trimmed)) {
    throw new InvalidRequestError("tap sandbox driver rejects live keys (sk_live)");
  }
  return trimmed;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new InvalidRequestError("customer.name must be a non-empty string");
  }
  if (parts.length === 1) {
    return { firstName: parts[0] as string, lastName: parts[0] as string };
  }
  const firstName = parts[0] as string;
  const lastName = parts.slice(1).join(" ");
  return { firstName, lastName };
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function parseJsonOnce(rawBody: unknown): unknown {
  if (typeof rawBody === "string") {
    const trimmed = rawBody.trim();
    if (trimmed.length === 0) {
      throw new InvalidRequestError("webhook rawBody must be a JSON object");
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new InvalidRequestError("webhook rawBody is not valid JSON");
    }
  }
  if (rawBody instanceof Uint8Array) {
    const text = new TextDecoder().decode(rawBody).trim();
    if (text.length === 0) {
      throw new InvalidRequestError("webhook rawBody must be a JSON object");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new InvalidRequestError("webhook rawBody is not valid JSON");
    }
  }
  return rawBody;
}

function unsupported(gateway: string, method: string): never {
  throw new OperationNotSupportedError(gateway, method, {
    claimedSupport: false,
  });
}

const MYFATOORAH_COUNTRIES: readonly string[] = [
  "KWT",
  "SAU",
  "ARE",
  "QAT",
  "BHR",
  "OMN",
  "JOR",
  "EGY",
];

function resolveMyFatoorahCountry(raw: string | undefined): MyFatoorahCountry {
  const trimmed = (raw ?? "KWT").trim().toUpperCase();
  if (!(MYFATOORAH_COUNTRIES as readonly string[]).includes(trimmed)) {
    throw new InvalidRequestError(
      `myfatoorah.MYFATOORAH_COUNTRY must be one of ${MYFATOORAH_COUNTRIES.join(", ")}`,
    );
  }
  return trimmed as MyFatoorahCountry;
}

export function createPluginDriver(options: CreateSandboxDriverOptions): SandboxGatewayDriver {
  const gatewayKey = options.gateway;
  if (gatewayKey !== "tap" && gatewayKey !== "myfatoorah" && gatewayKey !== "hesabe") {
    throw new InvalidRequestError(
      `createPluginDriver supports tap, myfatoorah, hesabe only (got "${String(gatewayKey)}")`,
    );
  }
  const secrets = options.secrets;
  const ctx = createDefaultGatewayContext();

  if (gatewayKey === "tap") {
    const secretKey = assertSandboxTapKey(secrets.TAP_SECRET_KEY);
    const merchantId =
      typeof secrets.TAP_MERCHANT_ID === "string" && secrets.TAP_MERCHANT_ID.trim().length > 0
        ? secrets.TAP_MERCHANT_ID.trim()
        : undefined;
    const configuredWebhook =
      typeof secrets.TAP_WEBHOOK_URL === "string" && secrets.TAP_WEBHOOK_URL.trim().length > 0
        ? assertHttpsUrl(secrets.TAP_WEBHOOK_URL, "TAP_WEBHOOK_URL")
        : undefined;
    // Sandbox only: Tap adapter has no live flag; live keys are rejected above
    // Tap uses one API host for test and live keys.
    const gw = tapGateway({
      secretKey,
      ...(merchantId !== undefined ? { merchantId } : {}),
      ...(configuredWebhook !== undefined ? { webhookUrl: configuredWebhook } : {}),
    }).create(ctx);

    return {
      gateway: "tap",
      async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
        if (input.sourceToken !== undefined) {
          throw new InvalidRequestError("Tap driver does not accept sourceToken (no raw card data)");
        }
        const callbackUrl = assertHttpsUrl(input.callbackUrl, "callbackUrl");
        const perRequestPost =
          input.webhookUrl !== undefined ? assertHttpsUrl(input.webhookUrl, "webhookUrl") : undefined;
        if (typeof input.reference !== "string" || input.reference.trim().length === 0) {
          throw new InvalidRequestError("reference must be a non-empty string");
        }
        if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
          throw new InvalidRequestError("idempotencyKey must be a non-empty string");
        }
        const currency = input.amount.currency;
        const { firstName, lastName } = splitName(input.customer.name);
        if (typeof input.customer.email !== "string" || input.customer.email.trim().length === 0) {
          throw new InvalidRequestError("customer.email must be a non-empty string");
        }
        const methodRaw =
          typeof input.method === "string" && input.method.trim().length > 0
            ? input.method.trim()
            : "src_all";
        return gw.createPayment({
          amount: input.amount,
          currency,
          orderId: input.reference.trim(),
          callbackUrl,
          capture: input.capture ?? true,
          idempotencyKey: input.idempotencyKey,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          tapCustomer: { firstName, lastName, email: input.customer.email.trim() },
          tapSource: { id: methodRaw },
          ...(perRequestPost !== undefined ? { tapPostUrl: perRequestPost } : {}),
          ...(merchantId !== undefined ? { tapMerchantId: merchantId } : {}),
        });
      },
      async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
        return gw.getPayment({ gatewayPaymentId });
      },
      async capture(input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
        // SDK preserves distinct charge vs authorize ids in references; returned unchanged.
        return gw.capturePayment({
          gatewayPaymentId: input.gatewayPaymentId,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          idempotencyKey: input.idempotencyKey,
        });
      },
      async void(input: SandboxVoidInput): Promise<GatewayPaymentResult> {
        return gw.voidPayment({
          gatewayPaymentId: input.gatewayPaymentId,
          idempotencyKey: input.idempotencyKey,
        });
      },
      async refund(input: SandboxRefundInput): Promise<import("@paykernel/core").GatewayRefundResult> {
        return gw.refundPayment({
          gatewayPaymentId: input.gatewayPaymentId,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          idempotencyKey: input.idempotencyKey,
        });
      },
      async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
        // Never trust query status or arbitrary redirect URLs. Confirm the stored
        // provider id only via server lookup.
        if (
          typeof input.storedGatewayPaymentId !== "string" ||
          input.storedGatewayPaymentId.length === 0
        ) {
          throw new InvalidRequestError("storedGatewayPaymentId must be a non-empty string");
        }
        return gw.getPayment({ gatewayPaymentId: input.storedGatewayPaymentId });
      },
      async verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent> {
        // Tap: verify the parsed object (hashstring over parsed fields), then parse
        // the same object. Strings are parsed once and reused.
        const parsed = parseJsonOnce(input.rawBody);
        const headers = normalizeHeaders(input.headers);
        const signature = input.signature;
        const ok = gw.verifyWebhook(parsed, signature, headers);
        if (!ok) {
          throw new InvalidRequestError("Tap webhook signature verification failed");
        }
        return gw.parseWebhookEvent(parsed);
      },
    };
  }

  if (gatewayKey === "myfatoorah") {
    const apiToken = secrets.MYFATOORAH_API_TOKEN;
    if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
      throw new InvalidRequestError("myfatoorah.MYFATOORAH_API_TOKEN must be a non-empty string");
    }
    const country = resolveMyFatoorahCountry(secrets.MYFATOORAH_COUNTRY);
    const webhookSecret =
      typeof secrets.MYFATOORAH_WEBHOOK_SECRET === "string" &&
      secrets.MYFATOORAH_WEBHOOK_SECRET.trim().length > 0
        ? secrets.MYFATOORAH_WEBHOOK_SECRET.trim()
        : undefined;
    const configuredWebhook =
      typeof secrets.MYFATOORAH_WEBHOOK_URL === "string" &&
      secrets.MYFATOORAH_WEBHOOK_URL.trim().length > 0
        ? assertHttpsUrl(secrets.MYFATOORAH_WEBHOOK_URL, "MYFATOORAH_WEBHOOK_URL")
        : undefined;
    // Sandbox only: live is always false; test host inside the SDK is used.
    const gw = myfatoorahGateway({
      apiToken: apiToken.trim(),
      country,
      live: false,
      ...(webhookSecret !== undefined ? { webhookSecret } : {}),
      ...(configuredWebhook !== undefined ? { webhookUrl: configuredWebhook } : {}),
      ...(options.idempotencyStore !== undefined
        ? { idempotencyStore: options.idempotencyStore }
        : {}),
    }).create(ctx);

    return {
      gateway: "myfatoorah",
      async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
        if (input.sourceToken !== undefined) {
          throw new InvalidRequestError(
            "MyFatoorah driver does not accept sourceToken (no raw card data)",
          );
        }
        const callbackUrl = assertHttpsUrl(input.callbackUrl, "callbackUrl");
        const perRequestWebhook =
          input.webhookUrl !== undefined ? assertHttpsUrl(input.webhookUrl, "webhookUrl") : undefined;
        if (typeof input.reference !== "string" || input.reference.trim().length === 0) {
          throw new InvalidRequestError("reference must be a non-empty string");
        }
        if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
          throw new InvalidRequestError("idempotencyKey must be a non-empty string");
        }
        if (input.capture === false) {
          // SDK claims no authorization; surface an explicit unsupported error.
          throw new OperationNotSupportedError("myfatoorah", "createPayment", {
            capability: "authorization",
            claimedSupport: false,
          });
        }
        const currency = input.amount.currency;
        const methodRaw =
          typeof input.method === "string" && input.method.trim().length > 0
            ? input.method.trim().toUpperCase()
            : undefined;
        const knownMethods: readonly string[] = ["INVOICE", "CARD", "APPLE_PAY", "GOOGLE_PAY", "KNET"];
        const paymentMethod =
          methodRaw !== undefined && (knownMethods as readonly string[]).includes(methodRaw)
            ? (methodRaw as "INVOICE" | "CARD" | "APPLE_PAY" | "GOOGLE_PAY" | "KNET")
            : undefined;
        if (methodRaw !== undefined && paymentMethod === undefined) {
          throw new InvalidRequestError(
            `Unsupported MyFatoorah method "${input.method}". Use INVOICE, CARD, APPLE_PAY, GOOGLE_PAY, KNET.`,
          );
        }
        return gw.createPayment({
          amount: input.amount,
          currency,
          orderId: input.reference.trim(),
          callbackUrl,
          idempotencyKey: input.idempotencyKey,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          myfatoorahCustomer: {
            name: input.customer.name,
            email: input.customer.email,
            reference: input.reference.trim(),
          },
          ...(paymentMethod !== undefined ? { myfatoorahPaymentMethod: paymentMethod } : {}),
          ...(perRequestWebhook !== undefined ? { myfatoorahWebhookUrl: perRequestWebhook } : {}),
        });
      },
      async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
        return gw.getPayment({ gatewayPaymentId });
      },
      async capture(_input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
        // MyFatoorah SDK supports no capture/authorization on this surface.
        unsupported("myfatoorah", "capturePayment");
      },
      async void(_input: SandboxVoidInput): Promise<GatewayPaymentResult> {
        // No voidPayment on the MyFatoorah SDK surface.
        unsupported("myfatoorah", "voidPayment");
      },
      async refund(input: SandboxRefundInput): Promise<GatewayRefundResult> {
        // SDK preserves distinct refund ids (RefundId) in the refund result.
        return gw.refundPayment({
          gatewayPaymentId: input.gatewayPaymentId,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          idempotencyKey: input.idempotencyKey,
        });
      },
      async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
        // Never trust query status. Confirm the stored invoice id only via
        // server-side GetPaymentStatus. No redirects accepted from query.
        if (
          typeof input.storedGatewayPaymentId !== "string" ||
          input.storedGatewayPaymentId.length === 0
        ) {
          throw new InvalidRequestError("storedGatewayPaymentId must be a non-empty string");
        }
        return gw.getPayment({ gatewayPaymentId: input.storedGatewayPaymentId });
      },
      async verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent> {
        // MyFatoorah: verify the raw body exactly as received, then parse it.
        // Raw strings/bytes are passed through untouched so the HMAC canonical
        // string matches the sender bytes.
        const raw = input.rawBody;
        const headers = input.headers;
        const signature = input.signature;
        const headerBag: Record<string, string | string[]> | undefined =
          headers === undefined ? undefined : { ...headers };
        const ok = gw.verifyWebhook(raw, signature, headerBag);
        if (!ok) {
          throw new InvalidRequestError("MyFatoorah webhook signature verification failed");
        }
        return gw.parseWebhookEvent(raw);
      },
    };
  }

  // hesabe
  const merchantCode = secrets.HESABE_MERCHANT_CODE;
  const accessCode = secrets.HESABE_ACCESS_CODE;
  const encryptionKey = secrets.HESABE_ENCRYPTION_KEY;
  const ivKey = secrets.HESABE_IV_KEY;
  const username = secrets.HESABE_USERNAME;
  const password = secrets.HESABE_PASSWORD;
  if (typeof merchantCode !== "string" || merchantCode.trim().length === 0) {
    throw new InvalidRequestError("hesabe.HESABE_MERCHANT_CODE must be a non-empty string");
  }
  if (typeof accessCode !== "string" || accessCode.trim().length === 0) {
    throw new InvalidRequestError("hesabe.HESABE_ACCESS_CODE must be a non-empty string");
  }
  if (typeof encryptionKey !== "string" || encryptionKey.length === 0) {
    throw new InvalidRequestError("hesabe.HESABE_ENCRYPTION_KEY must be a non-empty string");
  }
  if (typeof ivKey !== "string" || ivKey.length === 0) {
    throw new InvalidRequestError("hesabe.HESABE_IV_KEY must be a non-empty string");
  }
  if (typeof username !== "string" || username.trim().length === 0) {
    throw new InvalidRequestError("hesabe.HESABE_USERNAME must be a non-empty string");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new InvalidRequestError("hesabe.HESABE_PASSWORD must be a non-empty string");
  }
  if (options.idempotencyStore === undefined) {
    throw new InvalidRequestError("hesabe.idempotencyStore is required (pass options.idempotencyStore)");
  }
  const configuredWebhook =
    typeof secrets.HESABE_WEBHOOK_URL === "string" && secrets.HESABE_WEBHOOK_URL.trim().length > 0
      ? assertHttpsUrl(secrets.HESABE_WEBHOOK_URL, "HESABE_WEBHOOK_URL")
      : undefined;
  // Sandbox only: live is always false; sandbox hosts inside the SDK are used.
  const gw = hesabeGateway({
    merchantCode: merchantCode.trim(),
    accessCode: accessCode.trim(),
    encryptionKey,
    ivKey,
    username,
    password,
    live: false,
    idempotencyStore: options.idempotencyStore,
    ...(configuredWebhook !== undefined ? { webhookUrl: configuredWebhook } : {}),
  }).create(ctx);

  return {
    gateway: "hesabe",
    async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
      if (input.sourceToken !== undefined) {
        throw new InvalidRequestError("Hesabe driver does not accept sourceToken (no raw card data)");
      }
      // Hesabe is KWD-only; the SDK enforces it strictly (no silent rounding).
      if (input.amount.currency.toUpperCase() !== "KWD") {
        throw new InvalidRequestError(`Hesabe only supports KWD (got "${input.amount.currency}")`);
      }
      const callbackUrl = assertHttpsUrl(input.callbackUrl, "callbackUrl");
      const perRequestWebhook =
        input.webhookUrl !== undefined ? assertHttpsUrl(input.webhookUrl, "webhookUrl") : undefined;
      if (typeof input.reference !== "string" || input.reference.trim().length === 0) {
        throw new InvalidRequestError("reference must be a non-empty string");
      }
      if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
        throw new InvalidRequestError("idempotencyKey must be a non-empty string");
      }
      if (input.capture === false) {
        throw new OperationNotSupportedError("hesabe", "authorizePayment", {
          capability: "authorization",
          claimedSupport: false,
        });
      }
      return gw.createPayment({
        amount: input.amount,
        currency: "KWD",
        orderId: input.reference.trim(),
        callbackUrl,
        idempotencyKey: input.idempotencyKey,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        hesabeName: input.customer.name,
        hesabeEmail: input.customer.email,
        ...(perRequestWebhook !== undefined ? { hesabeWebhookUrl: perRequestWebhook } : {}),
      });
    },
    async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
      // Checkout ids (checkout:…) are not transaction tokens; the SDK rejects
      // them explicitly — surfaced here instead of a fake pending status.
      return gw.getPayment({ gatewayPaymentId });
    },
    async capture(_input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
      // Hesabe SDK claims no authorization; capture is unsupported.
      unsupported("hesabe", "capturePayment");
    },
    async void(_input: SandboxVoidInput): Promise<GatewayPaymentResult> {
      // No voidPayment on the Hesabe SDK surface.
      unsupported("hesabe", "voidPayment");
    },
    async refund(input: SandboxRefundInput): Promise<GatewayRefundResult> {
      // SDK preserves distinct numeric refund ids; returned unchanged.
      if (input.currency !== undefined && input.currency.toUpperCase() !== "KWD") {
        throw new InvalidRequestError(`Hesabe only supports KWD (got "${input.currency}")`);
      }
      if (input.amount !== undefined && input.amount.currency.toUpperCase() !== "KWD") {
        throw new InvalidRequestError(`Hesabe only supports KWD (got "${input.amount.currency}")`);
      }
      return gw.refundPayment({
        gatewayPaymentId: input.gatewayPaymentId,
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        idempotencyKey: input.idempotencyKey,
      });
    },
    async lookupRefund(gatewayRefundId: string): Promise<GatewayRefundResult> {
      return gw.getRefund({ gatewayRefundId });
    },
    async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
      // Never trust query status and never accept redirects from query.
      // Confirm only the stored provider id via server enquiry. For Hesabe the
      // browser callback carries encrypted `data`; resolveCallback decrypts it
      // with the exact SDK API (AES-256-CBC + transaction enquiry) and the
      // result is cross-checked against the stored id.
      if (
        typeof input.storedGatewayPaymentId !== "string" ||
        input.storedGatewayPaymentId.length === 0
      ) {
        throw new InvalidRequestError("storedGatewayPaymentId must be a non-empty string");
      }
      const stored = input.storedGatewayPaymentId;
      const encryptedData = input.query?.["data"];
      if (typeof encryptedData === "string" && encryptedData.trim().length > 0) {
        // Exact SDK API: encrypted callback data goes to resolveCallback, which
        // decrypts and confirms via transaction enquiry (no unverified status).
        const confirmed = await gw.resolveCallback({ data: encryptedData.trim() });
        if (stored.toLowerCase().startsWith("checkout:")) {
          return confirmed;
        }
        if (confirmed.gatewayId !== stored) {
          throw new InvalidRequestError("Hesabe callback does not match stored payment");
        }
        return confirmed;
      }
      // No callback payload: server enquiry on the stored transaction token.
      // Checkout ids cannot be enquired; fail closed instead of guessing.
      return gw.getPayment({ gatewayPaymentId: stored });
    },
    async verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent> {
      // Hesabe: verifyWebhookAsync(parsedObject) THEN parseWebhookEvent(exact
      // same object). The SDK WeakMap only recognises the identical reference,
      // so strings are parsed once and the same object is reused for both
      // calls. Unverified payloads never yield a status.
      const parsed = parseJsonOnce(input.rawBody);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new InvalidRequestError("Hesabe webhook payload must be a JSON object");
      }
      // verifyWebhookAsync performs the server enquiry check against the
      // decrypted callback fields carried in this parsed object.
      const ok = await gw.verifyWebhookAsync(parsed);
      if (!ok) {
        throw new InvalidRequestError("Hesabe webhook verification failed");
      }
      return gw.parseWebhookEvent(parsed);
    },
  };
}
