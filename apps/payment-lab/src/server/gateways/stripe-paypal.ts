import {
  fromMinorUnits,
  money,
  toMinorUnits,
  InvalidRequestError,
  createDefaultGatewayContext,
  paypalGateway,
  stripeGateway,
  type GatewayPaymentResult,
  type CheckoutSessionOperationResult,
  type GatewayRefundResult,
  type WebhookEvent,
} from "@paykernel/core";
import { z } from "zod";
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

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertSandboxStripeSecret(value: string | undefined): string {
  const key = assertNonEmpty(value, "stripe.STRIPE_SECRET_KEY");
  if (/^sk_live/i.test(key) || /^rk_live/i.test(key)) {
    throw new InvalidRequestError("stripe sandbox driver rejects live keys");
  }
  if (!/^sk_test_/i.test(key)) {
    throw new InvalidRequestError("stripe sandbox driver requires an sk_test_ key");
  }
  return key;
}

function isCheckoutSessionId(id: string): boolean {
  return id.startsWith("cs_");
}

const paypalMoney = z.object({ value: z.string(), currency_code: z.string() });
const stripeIntent = z.object({
  id: z.string().startsWith("pi_"), amount: z.number().int().nonnegative(), currency: z.string(),
  amount_received: z.number().int().nonnegative().optional(),
  latest_charge: z.union([z.string(), z.object({ amount_captured: z.number().int().nonnegative().optional() })]).nullish(),
});

function normalizeStripePayment(result: GatewayPaymentResult): GatewayPaymentResult {
  const parsed = stripeIntent.safeParse(result.rawResponse);
  if (!parsed.success) return result;
  const intent = parsed.data;
  const currency = intent.currency.toUpperCase();
  const captured = intent.amount_received ?? (typeof intent.latest_charge === "object" ? intent.latest_charge?.amount_captured : undefined);
  return { ...result, amount: fromMinorUnits(intent.amount, currency), currency,
    ...(captured !== undefined ? { capturedAmount: fromMinorUnits(captured, currency, { allowZero: true }) } : {}),
  };
}

const paypalOrder = z.object({ id: z.string(), purchase_units: z.array(z.object({
  amount: paypalMoney,
  payments: z.object({ captures: z.array(z.object({ id: z.string(), status: z.string(), amount: paypalMoney })).optional() }).optional(),
})).length(1) });

/** The lab keeps the order face amount and gross captures separate from net refunds. */
function normalizePaypalOrder(result: GatewayPaymentResult): GatewayPaymentResult {
  const parsed = paypalOrder.safeParse(result.rawResponse);
  if (!parsed.success) return result;
  const unit = parsed.data.purchase_units[0]!;
  const amount = money(unit.amount.value, unit.amount.currency_code);
  const captures = unit.payments?.captures ?? [];
  let gross = 0n;
  for (const capture of captures) {
    if (capture.amount.currency_code !== amount.currency) throw new InvalidRequestError("PayPal capture currency mismatch");
    if (["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(capture.status)) {
      gross += toMinorUnits(money(capture.amount.value, capture.amount.currency_code));
    }
  }
  const status = gross > 0n ? (gross === toMinorUnits(amount) ? "paid" : "partially_captured") : result.status;
  return { ...result, amount, currency: amount.currency, status,
    ...(captures.length ? { capturedAmount: fromMinorUnits(gross, amount.currency, { allowZero: true }) } : {}),
  };
}

function toSucceededCheckoutResult(result: CheckoutSessionOperationResult): GatewayPaymentResult {
  if (result.outcome !== "succeeded") {
    return {
      outcome: result.outcome, status: result.outcome === "failed" ? "failed" : "processing",
      gatewayId: result.session?.references.providerObjectId ?? "unknown", redirectUrl: undefined,
      reconciliationRequired: result.outcome === "indeterminate", rawResponse: undefined,
    };
  }
  const session = result.session;
  const status = session.paymentStatus === "paid" ? "paid" : session.status === "expired" ? "cancelled" : "pending";
  return {
    outcome: status === "paid" ? "succeeded" : status === "cancelled" ? "failed" : "requires_action",
    gatewayId: session.references.providerObjectId, status, redirectUrl: session.url,
    amount: session.amount, currency: session.currency, references: session.references,
    captureId: session.references.relatedIds?.paymentIntentId,
    capturedAmount: status === "paid" ? session.amount : undefined,
    rawResponse: session.rawResponse,
  };
}

export function createStripePaypalDriver(options: CreateSandboxDriverOptions): SandboxGatewayDriver {
  if (options.gateway !== "stripe" && options.gateway !== "paypal") {
    throw new InvalidRequestError(
      `createStripePaypalDriver supports stripe, paypal only (got "${String(options.gateway)}")`,
    );
  }
  const ctx = createDefaultGatewayContext();

  if (options.gateway === "stripe") {
    const secretKey = assertSandboxStripeSecret(options.secrets.STRIPE_SECRET_KEY);
    const publishableKey =
      typeof options.secrets.STRIPE_PUBLISHABLE_KEY === "string" &&
      options.secrets.STRIPE_PUBLISHABLE_KEY.trim().length > 0
        ? options.secrets.STRIPE_PUBLISHABLE_KEY.trim()
        : undefined;
    const webhookSecret =
      typeof options.secrets.STRIPE_WEBHOOK_SECRET === "string" &&
      options.secrets.STRIPE_WEBHOOK_SECRET.trim().length > 0
        ? options.secrets.STRIPE_WEBHOOK_SECRET.trim()
        : undefined;
    const gw = stripeGateway({
      secretKey,
      ...(publishableKey !== undefined ? { publishableKey } : {}),
      ...(webhookSecret !== undefined ? { webhookSecret } : {}),
    }).create(ctx);

    return {
      gateway: "stripe",
      async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
        if (input.sourceToken !== undefined) {
          throw new InvalidRequestError("Stripe driver does not accept sourceToken");
        }
        const reference = assertNonEmpty(input.reference, "reference");
        const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
        const callbackUrl = assertNonEmpty(input.callbackUrl, "callbackUrl");
        const currency = assertNonEmpty(input.amount.currency, "amount.currency");
        const method =
          typeof input.method === "string" && input.method.trim().length > 0
            ? input.method.trim().toLowerCase()
            : undefined;
        if (method === "checkout") {
          if (input.capture === false) throw new InvalidRequestError("Use Elements for manual capture; hosted Checkout is automatic.");
          const customerEmail =
            typeof input.customer.email === "string" && input.customer.email.trim().length > 0
              ? input.customer.email.trim()
              : undefined;
          const result = await gw.createCheckoutSession({
            amount: input.amount,
            currency,
            successUrl: callbackUrl,
            cancelUrl: callbackUrl,
            idempotencyKey,
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            ...(customerEmail !== undefined ? { customerEmail } : {}),
          });
          return toSucceededCheckoutResult(result);
        }
        if (method !== undefined && method !== "payment" && method !== "elements") {
          throw new InvalidRequestError(
            `Unsupported Stripe method "${input.method}". Use "checkout" for hosted Checkout.`,
          );
        }
        return normalizeStripePayment(await gw.createPayment({
          amount: input.amount,
          currency,
          orderId: reference,
          callbackUrl,
          capture: input.capture ?? true,
          idempotencyKey,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        }));
      },
      async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
        if (isCheckoutSessionId(gatewayPaymentId)) {
          const result = await gw.getCheckoutSession({ sessionId: gatewayPaymentId });
          return toSucceededCheckoutResult(result);
        }
        return normalizeStripePayment(await gw.getPayment({ gatewayPaymentId }));
      },
      async capture(input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
        return normalizeStripePayment(await gw.capturePayment({
          gatewayPaymentId: input.gatewayPaymentId,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          idempotencyKey: input.idempotencyKey,
        }));
      },
      async void(input: SandboxVoidInput): Promise<GatewayPaymentResult> {
        return normalizeStripePayment(await gw.voidPayment({
          gatewayPaymentId: input.gatewayPaymentId,
          idempotencyKey: input.idempotencyKey,
        }));
      },
      async refund(input: SandboxRefundInput): Promise<GatewayRefundResult> {
        return gw.refundPayment({
          gatewayPaymentId: input.gatewayPaymentId,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          idempotencyKey: input.idempotencyKey,
        });
      },
      async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
        const stored = assertNonEmpty(input.storedGatewayPaymentId, "storedGatewayPaymentId");
        if (isCheckoutSessionId(stored)) {
          const result = await gw.getCheckoutSession({ sessionId: stored });
          return toSucceededCheckoutResult(result);
        }
        return normalizeStripePayment(await gw.getPayment({ gatewayPaymentId: stored }));
      },
      async verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent> {
        const raw = input.rawBody;
        if (typeof raw !== "string" && !(raw instanceof Uint8Array)) {
          throw new InvalidRequestError("Stripe webhook requires the raw request body");
        }
        const headers = normalizeHeaders(input.headers);
        const signature =
          input.signature ?? headers?.["stripe-signature"] ?? headers?.["stripe_signature"];
        const ok =
          headers !== undefined
            ? gw.verifyWebhook(raw, signature, headers)
            : signature !== undefined
              ? gw.verifyWebhook(raw, signature)
              : gw.verifyWebhook(raw);
        if (!ok) {
          throw new InvalidRequestError("Stripe webhook signature verification failed");
        }
        return gw.parseWebhookEvent(raw);
      },
    };
  }

  const clientId = assertNonEmpty(options.secrets.PAYPAL_CLIENT_ID, "paypal.PAYPAL_CLIENT_ID");
  const clientSecret = assertNonEmpty(
    options.secrets.PAYPAL_CLIENT_SECRET,
    "paypal.PAYPAL_CLIENT_SECRET",
  );
  const webhookId =
    typeof options.secrets.PAYPAL_WEBHOOK_ID === "string" &&
    options.secrets.PAYPAL_WEBHOOK_ID.trim().length > 0
      ? options.secrets.PAYPAL_WEBHOOK_ID.trim()
      : undefined;
  const gw = paypalGateway({
    clientId,
    clientSecret,
    sandbox: true,
    ...(webhookId !== undefined ? { webhookId } : {}),
  }).create(ctx);

  return {
    gateway: "paypal",
    async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
      if (input.sourceToken !== undefined) {
        throw new InvalidRequestError("PayPal driver does not accept sourceToken");
      }
      const reference = assertNonEmpty(input.reference, "reference");
      const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
      const callbackUrl = assertNonEmpty(input.callbackUrl, "callbackUrl");
      const currency = assertNonEmpty(input.amount.currency, "amount.currency");
      return gw.createPayment({
        amount: input.amount,
        currency,
        orderId: reference,
        callbackUrl,
        capture: input.capture ?? true,
        idempotencyKey,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
    },
    async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
      return normalizePaypalOrder(await gw.getPayment({ gatewayPaymentId }));
    },
    async capture(input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
      return gw.capturePayment({
        gatewayPaymentId: input.gatewayPaymentId,
        paypalCaptureType: "authorization",
        paypalFinalCapture: true,
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
    async refund(input: SandboxRefundInput): Promise<GatewayRefundResult> {
      return gw.refundPayment({
        gatewayPaymentId: input.gatewayPaymentId,
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        idempotencyKey: input.idempotencyKey,
      });
    },
    async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
      const stored = assertNonEmpty(input.storedGatewayPaymentId, "storedGatewayPaymentId");
      const token = input.query?.["token"];
      if (typeof token === "string" && token.length > 0 && token !== stored) {
        throw new InvalidRequestError("PayPal return token does not match stored payment");
      }
      if (input.capture === false) {
        const authorized = await gw.authorizePayment({
          gatewayPaymentId: stored,
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        });
        if (authorized.outcome === "indeterminate" || authorized.outcome === "failed" || authorized.outcome === "declined") return authorized;
        return normalizePaypalOrder(await gw.getPayment({ gatewayPaymentId: stored }));
      }
      const captured = await gw.capturePayment({
        gatewayPaymentId: stored,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      if (captured.outcome === "indeterminate" || captured.outcome === "failed" || captured.outcome === "declined") return captured;
      return normalizePaypalOrder(await gw.getPayment({ gatewayPaymentId: stored }));
    },
    async verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent> {
      const headers = normalizeHeaders(input.headers);
      const raw = input.rawBody;
      const ok =
        headers !== undefined
          ? await gw.verifyWebhookAsync(raw, headers)
          : await gw.verifyWebhookAsync(raw);
      if (!ok) {
        throw new InvalidRequestError("PayPal webhook verification failed");
      }
      return gw.parseWebhookEvent(raw);
    },
  };
}
