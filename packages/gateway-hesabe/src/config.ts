import { InvalidRequestError, type IdempotencyStore } from "@paykernel/core";

export const HESABE_SANDBOX_CHECKOUT_BASE_URL = "https://sandbox.hesabe.com";
export const HESABE_LIVE_CHECKOUT_BASE_URL = "https://api.hesabe.com";
export const HESABE_SANDBOX_MERCHANT_BASE_URL = "https://merchantapisandbox.hesabe.com";
export const HESABE_LIVE_MERCHANT_BASE_URL = "https://merchantapi.hesabe.com";
export const HESABE_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Closed-over Hesabe adapter configuration. Secrets never go on the
 * manifest or {@link import("@paykernel/core").GatewayContext}.
 */
export type HesabeConfig = {
  /** Merchant code sent in encrypted checkout / refund payloads. */
  merchantCode: string;
  /** Checkout + enquiry + merchant `accessCode` header value. */
  accessCode: string;
  /** AES-256 key encoded as 32 UTF-8 bytes. */
  encryptionKey: string;
  /** AES-CBC IV encoded as 16 UTF-8 bytes. */
  ivKey: string;
  /** Default notification endpoint; can be overridden on each checkout. */
  webhookUrl?: string;
  /** Merchant API login username (never echoed in errors). */
  username: string;
  /** Merchant API login password (never echoed in errors). */
  password: string;
  /** Use live hosts. Default: false (sandbox). */
  live?: boolean;
  /** Request timeout in milliseconds. Must be finite and > 0. Default: 30000 */
  timeoutMs?: number;
  /** Shared atomic store for payment + refund mutation fences. Required. */
  idempotencyStore: IdempotencyStore;
};

export function resolveHesabeCheckoutBaseUrl(config: { live?: boolean }): string {
  return config.live === true ? HESABE_LIVE_CHECKOUT_BASE_URL : HESABE_SANDBOX_CHECKOUT_BASE_URL;
}

export function resolveHesabeMerchantBaseUrl(config: { live?: boolean }): string {
  return config.live === true ? HESABE_LIVE_MERCHANT_BASE_URL : HESABE_SANDBOX_MERCHANT_BASE_URL;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`hesabe.${field} must be a non-empty string`);
  }
}

export function assertHesabeTimeoutMs(timeoutMs: unknown): asserts timeoutMs is number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InvalidRequestError("hesabe.timeoutMs must be a finite number > 0");
  }
}

export function assertHesabeHttpsUrl(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new InvalidRequestError(`${field} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidRequestError(`${field} must be an HTTPS URL`);
  }
}

function assertHesabeIdempotencyStore(store: unknown): asserts store is IdempotencyStore {
  const rec =
    store !== null && typeof store === "object" ? (store as Record<string, unknown>) : undefined;
  if (
    rec === undefined ||
    typeof rec.get !== "function" ||
    typeof rec.set !== "function" ||
    typeof rec.delete !== "function" ||
    typeof rec.reserve !== "function"
  ) {
    throw new InvalidRequestError(
      "hesabe.idempotencyStore must provide get/set/delete/reserve functions (use InMemoryIdempotencyStore or a shared store with atomic reserve())",
    );
  }
}

export function copyHesabeConfig(config: HesabeConfig): HesabeConfig {
  assertNonEmpty(config.merchantCode, "merchantCode");
  assertNonEmpty(config.accessCode, "accessCode");
  if (
    typeof config.encryptionKey !== "string" ||
    new TextEncoder().encode(config.encryptionKey).length !== 32
  ) {
    throw new InvalidRequestError("hesabe.encryptionKey must contain 32 UTF-8 bytes");
  }
  if (typeof config.ivKey !== "string" || new TextEncoder().encode(config.ivKey).length !== 16) {
    throw new InvalidRequestError("hesabe.ivKey must contain 16 UTF-8 bytes");
  }
  assertNonEmpty(config.username, "username");
  assertNonEmpty(config.password, "password");
  if (config.live !== undefined && typeof config.live !== "boolean") {
    throw new InvalidRequestError("hesabe.live must be a boolean");
  }
  if (config.timeoutMs !== undefined) {
    assertHesabeTimeoutMs(config.timeoutMs);
  }
  if (config.idempotencyStore === undefined) {
    throw new InvalidRequestError("hesabe.idempotencyStore is required");
  }
  assertHesabeIdempotencyStore(config.idempotencyStore);
  const copied: HesabeConfig = {
    merchantCode: config.merchantCode.trim(),
    accessCode: config.accessCode.trim(),
    encryptionKey: config.encryptionKey,
    ivKey: config.ivKey,
    username: config.username,
    password: config.password,
    idempotencyStore: config.idempotencyStore,
  };
  if (config.live !== undefined) copied.live = config.live === true;
  if (config.timeoutMs !== undefined) copied.timeoutMs = config.timeoutMs;
  if (config.webhookUrl !== undefined) {
    assertHesabeHttpsUrl(config.webhookUrl, "hesabe.webhookUrl");
    copied.webhookUrl = config.webhookUrl.trim();
  }
  return copied;
}
