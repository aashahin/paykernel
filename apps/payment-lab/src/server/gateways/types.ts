import type {
  GatewayCapabilities,
  GatewayPaymentResult,
  GatewayRefundResult,
  IdempotencyStore,
  Money,
  WebhookEvent,
} from "@paykernel/core";

/**
 * Sandbox gateway keys supported by the payment lab.
 *
 * First-party core adapters: stripe, paypal, paymob, moyasar.
 * Plugin adapters: tap, myfatoorah, hesabe.
 */
export const GATEWAY_KEYS = [
  "stripe",
  "paypal",
  "paymob",
  "moyasar",
  "tap",
  "myfatoorah",
  "hesabe",
] as const;

export type GatewayKey = (typeof GATEWAY_KEYS)[number];

export function isGatewayKey(value: string): value is GatewayKey {
  return (GATEWAY_KEYS as readonly string[]).includes(value);
}

/**
 * Exact optional environment/secret names read by sandbox drivers.
 *
 * Every field is optional so readiness can report what is missing.
 * The lab loads these from process env / wrangler secrets and passes the
 * resulting object to `createSandboxDriver`. No other env names are read
 * by this module.
 */
export interface GatewaySecrets {
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYMOB_SECRET_KEY?: string;
  PAYMOB_API_KEY?: string;
  PAYMOB_PUBLIC_KEY?: string;
  PAYMOB_HMAC_SECRET?: string;
  PAYMOB_INTEGRATION_ID?: string;
  PAYMOB_AUTH_INTEGRATION_ID?: string;
  MOYASAR_SECRET_KEY?: string;
  MOYASAR_PUBLISHABLE_KEY?: string;
  MOYASAR_WEBHOOK_SECRET?: string;
  TAP_SECRET_KEY?: string;
  TAP_MERCHANT_ID?: string;
  TAP_WEBHOOK_URL?: string;
  MYFATOORAH_API_TOKEN?: string;
  MYFATOORAH_COUNTRY?: string;
  MYFATOORAH_WEBHOOK_SECRET?: string;
  MYFATOORAH_WEBHOOK_URL?: string;
  HESABE_MERCHANT_CODE?: string;
  HESABE_ACCESS_CODE?: string;
  HESABE_ENCRYPTION_KEY?: string;
  HESABE_IV_KEY?: string;
  HESABE_USERNAME?: string;
  HESABE_PASSWORD?: string;
  HESABE_WEBHOOK_URL?: string;
}

export interface SandboxCustomer {
  name: string;
  email: string;
  phone?: string;
}

/**
 * Narrow create input owned by this module. The parent wires storage,
 * routing, and UI around it.
 *
 * - reference: merchant order/reference id (mapped to provider orderId /
 *   Customer.Reference / special_reference per gateway).
 * - amount: SDK Money (major units + currency). Currency is derived from
 *   `amount.currency`; no separate currency field to avoid mismatches.
 * - customer: display name/email plus optional phone.
 * - callbackUrl: browser return URL. For Paymob the same URL is used for
 *   both notification_url and redirection_url. Must be HTTPS where the
 *   provider requires it (Tap/MyFatoorah/Hesabe).
 * - webhookUrl: provider webhook/IPN endpoint override (else gateway default).
 * - capture: true (default) captures immediately; false places an
 *   authorization hold where the gateway supports it.
 * - idempotencyKey: required. Crash-retry key for create and later mutations.
 * - sourceToken: Moyasar backend token (`token_…`) only. Browser
 *   tokenization (Moyasar.js) happens elsewhere; raw PAN is never accepted.
 * - method: provider method selector. Tap source id (default `src_all`),
 *   MyFatoorah PaymentMethod, Paymob integration alias override,
 *   Stripe `checkout` for hosted Checkout (default Elements intents).
 */
export interface SandboxCreateInput {
  reference: string;
  amount: Money;
  customer: SandboxCustomer;
  callbackUrl: string;
  webhookUrl?: string;
  capture?: boolean;
  idempotencyKey: string;
  sourceToken?: string;
  method?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxCaptureInput {
  gatewayPaymentId: string;
  amount?: Money;
  currency?: string;
  idempotencyKey: string;
}

export interface SandboxVoidInput {
  gatewayPaymentId: string;
  idempotencyKey: string;
}

export interface SandboxRefundInput {
  gatewayPaymentId: string;
  amount?: Money;
  currency?: string;
  reason?: string;
  idempotencyKey: string;
}

/**
 * Safe return handling. The driver never trusts return/query status.
 * It correlates the stored provider id (and optionally a query id) and
 * confirms via server lookup (or PayPal authorize/capture, Hesabe encrypted
 * callback + enquiry).
 */
export interface SandboxCompleteReturnInput {
  storedGatewayPaymentId: string;
  query?: Record<string, string | undefined>;
  capture?: boolean;
  idempotencyKey?: string;
}

/**
 * Webhook verification input.
 *
 * - rawBody: preserve the raw JSON string for Stripe/MyFatoorah; a parsed
 *   object for Tap/Moyasar/Paymob/Hesabe (strings are parsed once and the
 *   same object is reused for Hesabe verify+parse).
 * - headers: case-insensitive (normalized to lowercase internally).
 * - query: URL query (Paymob `hmac`, Hesabe encrypted `data`).
 * - signature: explicit signature header value when not in `headers`.
 */
export interface SandboxWebhookInput {
  rawBody: string | Uint8Array | unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | undefined>;
  signature?: string;
}

export interface GatewayReadiness {
  gateway: GatewayKey;
  configured: boolean;
  /** Exact GatewaySecrets names (or `idempotencyStore`) that are missing. */
  missing: string[];
  /** Publishable/public key presence by env name. */
  publicKeys: Record<string, boolean>;
  /** Lab default currency for new payments on this gateway. */
  defaultCurrency: string;
  /** Lab-facing payment methods for this gateway. */
  paymentMethods: string[];
  /** Frozen SDK capability snapshot reused from the adapter package. */
  capabilities: GatewayCapabilities;
  /** Sandbox is always true; live keys/hosts are rejected. */
  sandbox: boolean;
}

export interface SandboxGatewayDriver {
  readonly gateway: GatewayKey;
  create(input: SandboxCreateInput): Promise<GatewayPaymentResult>;
  lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult>;
  lookupByReference?(reference: string): Promise<GatewayPaymentResult>;
  capture(input: SandboxCaptureInput): Promise<GatewayPaymentResult>;
  void(input: SandboxVoidInput): Promise<GatewayPaymentResult>;
  refund(input: SandboxRefundInput): Promise<GatewayRefundResult>;
  lookupRefund?(gatewayRefundId: string): Promise<GatewayRefundResult>;
  recoverRefund?(idempotencyKey: string): Promise<GatewayRefundResult | undefined>;
  completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult>;
  verifyAndParseWebhook(input: SandboxWebhookInput): Promise<WebhookEvent>;
}

/** Raised only before calling a provider's money mutation. */
export class GatewayActionNotSubmittedError extends Error {}

export interface CreateSandboxDriverOptions {
  gateway: GatewayKey;
  secrets: GatewaySecrets;
  idempotencyStore?: IdempotencyStore;
}
