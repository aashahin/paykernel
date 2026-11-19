/**
 * Webhook inbox engine (Phase 10.1–10.6).
 *
 * Ordered pipeline for `processVerified`:
 * 1. validate inputs (gateway, providerEventId, payloadHash)
 * 2. derive key via `deriveWebhookEventKey`
 * 3. atomic `store.claim`
 * 4. map claim kinds → outcomes (no handler on non-acquired)
 * 5. mode branch: ackAfterClaim (durable) or run handler
 * 6. run application handler under lease (with `ctx.renew`)
 * 7. on success → `store.complete` → `processed`
 * 8. on handler throw → sanitize → `store.fail` → mode-specific outcome
 * 9. complete throwing lease_lost after handler success → `handler_failed` retryable
 *    (crash boundary: external side effect may have committed; do NOT report processed)
 *
 * ### Crash boundaries (10.6)
 * | Boundary | Behavior |
 * | -------- | -------- |
 * | Before claim | No store mutation; safe to retry delivery |
 * | After claim, before handler | Lease held; abandon → reclaim after expiry; handler not run |
 * | During handler | Lease held; abandon → reclaim; **handler must be idempotent** |
 * | After side effect, before complete | Reclaim re-runs handler; complete may fail with lease_lost for stale worker |
 * | After complete | Terminal; further process → `duplicate_completed` |
 *
 * **Handler idempotency is mandatory.** The inbox cannot atomically commit an
 * arbitrary external side effect with its completion row unless they share a
 * transaction boundary.
 *
 * **Silent ACK forbidden:** failed/uncertain work returns an explicit
 * {@link WebhookProcessingOutcome} — never imply success without `processed`
 * or intentional `duplicate_completed` / durable `scheduled_for_retry`.
 * Inline mode never emits `scheduled_for_retry`.
 *
 * Modes are fixed at construction (`inline` | `durable_retry`).
 */

import {
  hashWebhookPayload,
  isPaymentEvent,
  redactWebhookPayloadSecrets,
  toPersistedPaymentEventEnvelope,
} from "@paykernel/core";
import { deriveWebhookEventKey, parseWebhookEventKey } from "./event-key";
import {
  redactOpaquePayloadRefString,
  sanitizeWebhookError,
} from "./sanitize";
import {
  isStoreLeaseLostError,
  StoreLeaseLostError,
  type ClaimWebhookInput,
  type LeaseToken,
  type WebhookEventKey,
  type WebhookInboxRecord,
  type WebhookInboxStore,
  type RenewWebhookLeaseResult,
} from "./store";
import type {
  CreateWebhookInboxEngineOptions,
  EngineClock,
  ProcessOneInput,
  ProcessOneResult,
  ProcessRetryableInput,
  ProcessRetryableResult,
  ProcessVerifiedInput,
  ProcessWithVerifierInput,
  SanitizeErrorFn,
  ScheduledForRetryReason,
  WebhookHandler,
  WebhookHandlerContext,
  WebhookInboxEngine,
  WebhookProcessingMode,
  WebhookProcessingOutcome,
} from "./types";
import { NonRetryableHandlerError } from "./types";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_OWNER = "webhook-worker";
/** Default claim lease. `processRetryable` claims one-at-a-time so this 30s window is per handler, not shared across a batch (NEW-WEBHOOKS-1). */
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_AFTER_MS = 5_000;

/**
 * Lease duration must be a finite number of milliseconds strictly greater than 0.
 * `leaseMs <= 0` would yield an immediately expired lease (complete loses fencing;
 * successful handlers map to retryable handler_failed).
 */
function assertPositiveLeaseMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `createWebhookInboxEngine: ${label} must be a finite number > 0 (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * maxAttempts: finite integer >= 1 (handler budget; 0 would dead-letter immediately).
 */
function assertMaxAttempts(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `createWebhookInboxEngine: ${label} must be a finite integer >= 1 (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * defaultRetryAfterMs: finite number >= 0 (0 = immediate retry eligibility).
 */
function assertNonNegativeRetryMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `createWebhookInboxEngine: ${label} must be a finite number >= 0 (got ${String(value)})`,
    );
  }
  return value;
}

const systemClock: EngineClock = {
  nowMs: () => Date.now(),
};

// ─── Outcome helpers (exactOptionalPropertyTypes-safe) ───────────────────────

function outcomeProcessed(): WebhookProcessingOutcome {
  return { outcome: "processed" };
}

function outcomeDuplicateCompleted(): WebhookProcessingOutcome {
  return { outcome: "duplicate_completed" };
}

function outcomeAlreadyProcessing(
  retryAfterMs?: number,
): WebhookProcessingOutcome {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return { outcome: "already_processing", retryAfterMs };
  }
  return { outcome: "already_processing" };
}

function outcomeScheduledForRetry(
  reason: ScheduledForRetryReason,
  timing?: { availableAt?: string; retryAfterMs?: number },
): WebhookProcessingOutcome {
  const out: {
    outcome: "scheduled_for_retry";
    reason: ScheduledForRetryReason;
    availableAt?: string;
    retryAfterMs?: number;
  } = { outcome: "scheduled_for_retry", reason };
  if (timing?.availableAt !== undefined && timing.availableAt.length > 0) {
    out.availableAt = timing.availableAt;
  }
  if (
    timing?.retryAfterMs !== undefined &&
    Number.isFinite(timing.retryAfterMs) &&
    timing.retryAfterMs >= 0
  ) {
    out.retryAfterMs = timing.retryAfterMs;
  }
  return out;
}

/** Build timing fields for scheduled_for_retry from an absolute availableAt. */
function timingFromAvailableAt(
  availableAt: string,
  nowMs: number,
): { availableAt: string; retryAfterMs: number } {
  const at = Date.parse(availableAt);
  const retryAfterMs =
    Number.isFinite(at) && at > nowMs ? Math.max(0, at - nowMs) : 0;
  return { availableAt, retryAfterMs };
}

/** Build timing fields for scheduled_for_retry from a relative delay. */
function timingFromRetryAfterMs(
  retryAfterMs: number,
  nowMs: number,
): { availableAt: string; retryAfterMs: number } {
  const ms = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0;
  return {
    availableAt: new Date(nowMs + ms).toISOString(),
    retryAfterMs: ms,
  };
}

function outcomeHandlerFailed(retryable: boolean): WebhookProcessingOutcome {
  return { outcome: "handler_failed", retryable };
}

function outcomePayloadConflict(): WebhookProcessingOutcome {
  return { outcome: "payload_conflict" };
}

function outcomeInvalidWebhook(reason?: string): WebhookProcessingOutcome {
  if (reason !== undefined && reason.length > 0) {
    return { outcome: "invalid_webhook", reason };
  }
  return { outcome: "invalid_webhook" };
}

/**
 * WEBHOOKS-3: parse-stage InvalidWebhookError (Paymob / Moyasar / handleWebhook
 * reclass leftovers). These are authentic-payload shape failures, not forgery.
 */
function isParseStageInvalidWebhookMessage(message: string): boolean {
  return (
    message.includes("webhook parse failed") ||
    message.includes("parse failed") ||
    message.startsWith("webhook parse") ||
    message.includes("invalid paymob") ||
    message.includes("invalid moyasar webhook payload") ||
    message.includes("invalid moyasar")
  );
}

/** Signature / authenticity failures only — typically handleWebhook verify-false. */
function isVerifyFailureMessage(message: string): boolean {
  return (
    message.includes("webhook verification failed") ||
    message.includes("verification failed") ||
    message.includes("invalid signature") ||
    message.includes("signature verification") ||
    message.includes("hmac mismatch") ||
    message.includes("hmac verification")
  );
}

/**
 * I10: missing merchant webhook config (webhookSecret / hmacSecret / webhookId).
 * Never treat as forgery — the payload was not proven fake; 400 ACK would drop
 * paid redeliveries until the merchant adds the secret.
 */
function isMissingWebhookConfigMessage(message: string): boolean {
  return (
    message.includes("webhooksecret") ||
    message.includes("hmacsecret") ||
    message.includes("webhookid") ||
    message.includes("webhook secret") ||
    message.includes("hmac secret") ||
    message.includes("webhook_id") ||
    message.includes("webhook-id")
  );
}

function isMissingWebhookConfigError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== "object") return false;
  const e = err as { message?: unknown };
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return message.length > 0 && isMissingWebhookConfigMessage(message);
}

/**
 * WEBHOOKS-1 / WEBHOOKS-3: forgery-class verify failures only.
 *
 * Reserved for explicit signature / authenticity failures — typically
 * `InvalidWebhookError` from `PaymentClient.handleWebhook` when verify returns
 * false. Do **not** put transport, rate-limit, TypeError, unknown throws, or
 * **post-verify parse** errors here (those must be 5xx-class so providers
 * redeliver paid events).
 *
 * Core `handleWebhook` throws `InvalidRequestError` for parse-after-verify
 * (never `InvalidWebhookError`). If a custom verifier still wraps parse as
 * `InvalidWebhookError` (Paymob/Moyasar parse messages), that is **retryable**,
 * not forgery. Unknown InvalidWebhookError is fail-open retryable so new parse
 * shapes redeliver rather than 400-ACK.
 *
 * Explicit `{ ok: false }` from `verifyAndNormalize` is handled separately
 * (never throws).
 */
function isForgeryClassVerifyError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";

  const looksLikeWebhookInvalid =
    name === "invalidwebhookerror" || code === "invalid_webhook";
  if (!looksLikeWebhookInvalid) return false;

  if (isParseStageInvalidWebhookMessage(message)) return false;
  // Missing merchant secret is config, not a MAC mismatch.
  if (isMissingWebhookConfigMessage(message)) return false;
  return isVerifyFailureMessage(message);
}

/**
 * Transient HTTP statuses that must stay retryable even though they are 4xx.
 * 408 Request Timeout, 409 Conflict, 425 Too Early, 429 Too Many Requests.
 */
function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429;
}

/** Client 4xx that are permanent config/input failures (not transient). */
function isPermanentClientHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && !isTransientHttpStatus(status);
}

/**
 * WEBHOOKS-5 / WEBHOOKS-6: permanent (non-retryable) verify/normalize failures
 * that are **not** forgery — e.g. structural `GatewayApiError` ("Invalid webhook
 * payload"), or explicit `retryable: false`.
 *
 * **Not permanent:** post-verify `InvalidRequestError` / parse failures
 * (WEBHOOKS-5) — treat as retryable so authentic paid events redeliver.
 * 408 / 409 / 425 / 429 stay retryable.
 *
 * Map permanent cases to `handler_failed { retryable: false }` (not infinite
 * 5xx, not forgery 400).
 */
function isPermanentNonRetryableVerifyError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== "object") return false;
  const e = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    statusCode?: unknown;
    retryable?: unknown;
    rawError?: unknown;
  };
  if (e.retryable === false) return true;
  if (e.retryable === true) return false;
  // I10: missing secret/webhookId is retryable config (5xx) so providers redeliver
  // after the merchant adds the secret — never permanent 4xx, never forgery.
  if (isMissingWebhookConfigError(err)) return false;

  const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";

  // Rate limits and other transient 4xx stay retryable (provider redelivery).
  if (name === "ratelimiterror" || code === "rate_limit_exceeded") return false;
  if (typeof e.statusCode === "number" && isTransientHttpStatus(e.statusCode)) {
    return false;
  }

  // WEBHOOKS-5: post-verify parse / request-shape errors must stay retryable so
  // signature-valid paid events redeliver (new event types, thin payloads, skew).
  // Only treat as permanent when clearly client-config (explicit retryable:false).
  if (name === "invalidrequesterror" || code === "invalid_request") {
    return false;
  }
  // Parse-stage messages (Paymob/Moyasar payload shape, handleWebhook leftovers)
  // stay retryable even when wrapped on other types.
  if (isParseStageInvalidWebhookMessage(message)) {
    return false;
  }

  const looksLikeWebhookInvalid =
    name === "invalidwebhookerror" || code === "invalid_webhook";
  // WEBHOOKS-403: InvalidWebhookError is always HTTP 403. Forgery is classified
  // separately. Parse-stage and any non-verify-failure InvalidWebhookError must
  // not hit the permanent 4xx fall-through (signature-valid paid bodies redeliver).
  if (looksLikeWebhookInvalid && !isVerifyFailureMessage(message)) {
    return false;
  }

  // Permanent payload / structure failures at verify boundary (PayPal coerce etc.).
  if (
    name === "gatewayapierror" ||
    code === "gateway_api_error" ||
    code === "gateway_error"
  ) {
    if (
      message.includes("invalid webhook payload") ||
      message.includes("not valid json") ||
      message.includes("missing gateway payment identifier") ||
      message.includes("invalid create_time")
    ) {
      return true;
    }
    // Nested HTTP status on rawError when gateway attached it.
    const raw = e.rawError;
    if (raw !== null && typeof raw === "object") {
      const status =
        "status" in raw
          ? (raw as { status?: unknown }).status
          : "statusCode" in raw
            ? (raw as { statusCode?: unknown }).statusCode
            : undefined;
      if (typeof status === "number" && isPermanentClientHttpStatus(status)) {
        return true;
      }
    }
    // Default GatewayApiError (verify postback / 502-class) stays retryable.
    return false;
  }

  // Remaining definite client-config 4xx (e.g. GatewayNotConfiguredError).
  // Exclude forgery (handled first), InvalidWebhookError 403 (above),
  // InvalidRequestError / parse (above), transient 4xx (408/409/425/429).
  if (typeof e.statusCode === "number") {
    if (isPermanentClientHttpStatus(e.statusCode)) {
      if (!isForgeryClassVerifyError(err) && !looksLikeWebhookInvalid) {
        return true;
      }
    }
  }

  return false;
}

/**
 * WEBHOOKS-1 / WEBHOOKS-5 / WEBHOOKS-403: classify verify/normalize throws.
 *
 * Policy (fail-open for paid redelivery):
 * 1. Forgery (`InvalidWebhookError` / `INVALID_WEBHOOK` from verify-false only)
 *    → `invalid_webhook`
 * 2. Permanent non-retryable (structure GatewayApiError, clear config 4xx,
 *    `retryable:false`) → `handler_failed { retryable: false }`
 * 3. **Everything else** including post-verify `InvalidRequestError` / parse,
 *    parse-stage `InvalidWebhookError` (always HTTP 403 — WEBHOOKS-403),
 *    NetworkError, RateLimitError, TypeError, 5xx, Timeout, unknown Error,
 *    onWebhookVerified throws → `handler_failed { retryable: true }` (HTTP 5xx)
 *
 * Callers should map retryable `handler_failed` to 5xx so providers redeliver.
 * Reserve forgery-class outcomes only for explicit verify-false / signature
 * failures / `{ ok: false }` — never for parse or unknown throws.
 */
function classifyVerifyThrow(
  err: unknown,
): "forgery" | "permanent" | "retryable" {
  // I10 first: missing webhookSecret / hmacSecret / webhookId is never forgery.
  if (isMissingWebhookConfigError(err)) return "retryable";
  if (isForgeryClassVerifyError(err)) return "forgery";
  if (isPermanentNonRetryableVerifyError(err)) return "permanent";
  // Fail-open: InvalidRequestError (parse), RateLimitError, TypeError, etc.
  return "retryable";
}

// ─── Payload hash helpers ────────────────────────────────────────────────────

/**
 * Thin wrapper over core `hashWebhookPayload` (redacted portable SHA-256).
 *
 * **Hash-source honesty (WEBHOOKS-2):** this is **not** interchangeable across
 * shapes. `hashWebhookPayload` does **not** JSON-parse non-object strings, so:
 * - `computePayloadHash(parsedObject)` and `computePayloadHash(rawBodyString)`
 *   produce **different** digests even when `rawBodyString` is JSON of the object
 * - Gateways that set `event.payloadHash` (e.g. Stripe with `computePayloadHash`
 *   on the **parsed** event / `rawPayload` object) must be matched on redelivery
 *
 * Prefer {@link resolveInboxPayloadHash} for claim inputs.
 */
export function computePayloadHash(raw: unknown): string {
  return hashWebhookPayload(raw);
}

export type ResolveInboxPayloadHashInput = {
  /**
   * Preferred: gateway/event precomputed hash (trimmed). When non-empty after
   * trim, returned as-is — never re-hashed.
   */
  eventPayloadHash?: string | undefined;
  /**
   * Fallback hash input. Must be the **same object shape** the gateway used for
   * `payloadHash` (typically verified/parsed event or `rawPayload` object).
   * Passing a raw HTTP body **string** is only correct if that string is exactly
   * what was hashed upstream (usually it is not).
   */
  payloadForHash?: unknown;
};

/**
 * Canonical inbox claim hash (WEBHOOKS-2).
 *
 * 1. Prefer `eventPayloadHash` when present (non-empty after trim)
 * 2. Else `hashWebhookPayload(payloadForHash)` on the **gateway-shaped** value
 * 3. Else throw (refuse empty / missing — fail closed)
 *
 * Never treat raw body string hashing as equivalent to object-event hashing
 * without an explicit upstream contract that the gateway hashed that string.
 */
export function resolveInboxPayloadHash(
  input: ResolveInboxPayloadHashInput,
): string {
  const fromEvent =
    typeof input.eventPayloadHash === "string"
      ? input.eventPayloadHash.trim()
      : "";
  if (fromEvent.length > 0) {
    return fromEvent;
  }
  if (input.payloadForHash !== undefined) {
    return hashWebhookPayload(input.payloadForHash);
  }
  throw new Error(
    "resolveInboxPayloadHash: need eventPayloadHash or payloadForHash (refuse empty hash)",
  );
}

// ─── Envelope → payloadRef ───────────────────────────────────────────────────

/**
 * Serialize an envelope/event for `payloadRef` storage.
 *
 * - **Objects / arrays:** deep-redacted via core `redactWebhookPayloadSecrets`
 *   (known secret keys → `"[REDACTED]"`) then `JSON.stringify`. Prefer also
 *   passing `toPersistedPaymentEventEnvelope` so raw signatures never enter.
 * - **JSON strings:** parse → redact object/array values → re-stringify when
 *   parse succeeds as object/array (defense-in-depth for pre-serialized
 *   envelopes).
 * - **Opaque non-JSON strings:** secret/signature patterns redacted
 *   (WEBHOOKS-6); plain opaque refs pass through.
 * - Never stores undefined / empty string.
 */
function envelopeToPayloadRef(envelope: unknown): string | undefined {
  if (envelope === undefined || envelope === null) return undefined;
  if (typeof envelope === "string") {
    if (envelope.length === 0) return undefined;
    // WEBHOOKS-3/4: try redact when the string is JSON object/array.
    try {
      const parsed = JSON.parse(envelope) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        return JSON.stringify(redactWebhookPayloadSecrets(parsed));
      }
    } catch {
      // opaque non-JSON ref
    }
    // WEBHOOKS-6: redact known secret/signature patterns on opaque strings so
    // raw body text / tokens are not persisted unredacted in payloadRef.
    return redactOpaquePayloadRefString(envelope);
  }
  try {
    return JSON.stringify(redactWebhookPayloadSecrets(envelope));
  } catch {
    return undefined;
  }
}

const FORBIDDEN_PERSIST_KEYS = new Set(["rawpayload", "headers"]);

/**
 * P610-SNAP-1: durable payloadRef must never carry request-local rawPayload
 * or HTTP headers (signatures). Check own keys on objects; JSON strings are
 * parsed first.
 */
function valueHasForbiddenPersistKeys(value: unknown): boolean {
  let current = value;
  if (typeof current === "string") {
    if (current.length === 0) return false;
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return false;
    }
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    return false;
  }
  for (const key of Object.keys(current as Record<string, unknown>)) {
    if (!FORBIDDEN_PERSIST_KEYS.has(key.toLowerCase())) continue;
    const v = (current as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) return true;
  }
  return false;
}

function payloadRefHasForbiddenKeys(ref: string): boolean {
  try {
    return valueHasForbiddenPersistKeys(JSON.parse(ref) as unknown);
  } catch {
    return false;
  }
}

function extractPaymentEventForPersist(value: unknown):
  | Parameters<typeof toPersistedPaymentEventEnvelope>[0]
  | undefined {
  if (isPaymentEvent(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as { event?: unknown }).event;
    if (isPaymentEvent(nested)) return nested;
  }
  return undefined;
}

function tryPersistedPaymentEventEnvelopeRef(
  value: unknown,
  payloadHash: string,
): string | undefined {
  const pe = extractPaymentEventForPersist(value);
  if (pe === undefined) return undefined;
  try {
    const env = toPersistedPaymentEventEnvelope(pe, { payloadHash });
    const ref = envelopeToPayloadRef(env);
    if (ref !== undefined && !payloadRefHasForbiddenKeys(ref)) return ref;
  } catch {
    return undefined;
  }
  return undefined;
}

const DURABLE_PAYLOAD_REQUIRED =
  "envelope or event is required for durable_retry (workers need a payloadRef to redrive; refusing claim without materializable payload)";
const DURABLE_RAW_REFUSED =
  "durable_retry must not persist rawPayload/headers (use toPersistedPaymentEventEnvelope)";

/**
 * P610-SNAP-1: materialize a persistable payloadRef for durable_retry.
 * Prefer core `toPersistedPaymentEventEnvelope` when the value still carries
 * request-local `rawPayload` / `headers`; otherwise refuse.
 */
function resolveDurablePayloadRef(args: {
  envelope?: unknown;
  event?: unknown;
  payloadHash: string;
}): { ok: true; payloadRef: string } | { ok: false; reason: string } {
  const source =
    args.envelope !== undefined && args.envelope !== null && args.envelope !== ""
      ? args.envelope
      : args.event;

  if (source === undefined || source === null || source === "") {
    return { ok: false, reason: DURABLE_PAYLOAD_REQUIRED };
  }

  if (valueHasForbiddenPersistKeys(source)) {
    const converted = tryPersistedPaymentEventEnvelopeRef(source, args.payloadHash);
    if (converted !== undefined) return { ok: true, payloadRef: converted };
    return { ok: false, reason: DURABLE_RAW_REFUSED };
  }

  const ref = envelopeToPayloadRef(source);
  if (ref === undefined) {
    return { ok: false, reason: DURABLE_PAYLOAD_REQUIRED };
  }
  if (payloadRefHasForbiddenKeys(ref)) {
    const converted = tryPersistedPaymentEventEnvelopeRef(source, args.payloadHash);
    if (converted !== undefined) return { ok: true, payloadRef: converted };
    return { ok: false, reason: DURABLE_RAW_REFUSED };
  }
  return { ok: true, payloadRef: ref };
}

/**
 * Structural check for core `PersistedPaymentEventEnvelope`
 * (`{ schemaVersion, event, payloadHash, storedAt? }`).
 *
 * Used by default `processRetryable` materialization to unwrap `.event` so
 * handlers receive the nested PaymentEvent (or plain object), not the wrapper.
 * Plain PaymentEvent / custom payloadRef shapes lack top-level `event`+`payloadHash`
 * and are left as-is.
 */
function isPersistedPaymentEventEnvelopeShape(
  value: unknown,
): value is {
  schemaVersion: unknown;
  event: unknown;
  payloadHash: unknown;
} {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    "schemaVersion" in v &&
    "event" in v &&
    "payloadHash" in v &&
    typeof v.payloadHash === "string"
  );
}

/**
 * Default payloadRef → handler event for `processRetryable`.
 * Dual-write envelopes auto-unwrap `.event`; plain events stay as-is.
 * payloadRef was already redacted at store time (envelopeToPayloadRef).
 */
function materializeEventFromPayloadRef(payloadRef: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadRef) as unknown;
  } catch {
    // payloadRef may be opaque non-JSON; pass through as event.
    return payloadRef;
  }
  if (isPersistedPaymentEventEnvelopeShape(parsed)) {
    return parsed.event;
  }
  return parsed;
}

/**
 * WEBHOOKS-5: redaction parity between first delivery and durable redrive.
 *
 * - Prefer caller `event` when present, deep-redacted via core
 *   `redactWebhookPayloadSecrets` so first delivery does not expose secrets
 *   that `processRetryable` would strip from stored `payloadRef`.
 * - When `event` is omitted, materialize from redacted `payloadRef` (envelope
 *   or durable snapshot) — same path as redrive.
 */
/**
 * WEBHOOKS-1 / NEW-WEBHOOKS-2 / NEW-WH-1: notification class for Paymob inbox
 * qualification.
 *
 * Prefer `provider.eventType` (PaymentEvent native type: TRANSACTION vs
 * TRANSACTION_RESPONSE). Do **not** fall through to remapped domain types
 * (`payment.succeeded`). Only known native HMAC classes on `type` fields
 * (`TRANSACTION`, `TRANSACTION_RESPONSE`) are accepted. Processed TRANSACTION
 * keys include domain status when present (`paymob:TRANSACTION:{id}:{status}`)
 * so a later same-id void/refund snapshot is not `already_completed`. Domain
 * status is `refund.status` / `payment.status` from the PaymentEvent (or
 * those paths on nested `event`) — not top-level WebhookEvent.status when
 * a nested event/refund exists (I13). PaymentEvent has no top-level
 * `status` (NEW-WH-KEY-1). Redirect stays
 * `TRANSACTION_RESPONSE:{txnId}` (status ignored). Do not complete fulfillment
 * on Paymob `payment.processing` (redirect).
 */
const PAYMOB_NATIVE_INBOX_CLASSES = new Set([
  "TRANSACTION",
  "TRANSACTION_RESPONSE",
]);

function readProviderNativeEventType(provider: unknown): string | undefined {
  if (provider === null || typeof provider !== "object") return undefined;
  const eventType = (provider as { eventType?: unknown }).eventType;
  if (typeof eventType === "string" && eventType.trim()) return eventType.trim();
  return undefined;
}

function readKnownNativeInboxClass(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || !PAYMOB_NATIVE_INBOX_CLASSES.has(trimmed)) return undefined;
  return trimmed;
}

function extractInboxNotificationClass(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const fromProvider = readProviderNativeEventType(rec.provider);
  if (fromProvider !== undefined) return fromProvider;

  const nested = rec.event;
  if (nested !== null && typeof nested === "object") {
    const nestedRec = nested as Record<string, unknown>;
    const fromNestedProvider = readProviderNativeEventType(nestedRec.provider);
    if (fromNestedProvider !== undefined) return fromNestedProvider;
    const fromNestedNative = readKnownNativeInboxClass(nestedRec.type);
    if (fromNestedNative !== undefined) return fromNestedNative;
  }

  return readKnownNativeInboxClass(rec.type);
}

function readTrimmedInboxStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNestedEntityStatus(
  rec: Record<string, unknown>,
  key: "payment" | "refund",
): string | undefined {
  const nested = rec[key];
  if (nested === null || typeof nested !== "object") return undefined;
  return readTrimmedInboxStatus((nested as Record<string, unknown>).status);
}

/**
 * When a nested PaymentEvent or refund/payment entity exists, do not let
 * envelope `status: paid` qualify processed keys. Prefer entity status.
 */
function extractInboxDomainStatus(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const nestedRaw = rec.event;
  const nested =
    nestedRaw !== null && typeof nestedRaw === "object" && !Array.isArray(nestedRaw)
      ? (nestedRaw as Record<string, unknown>)
      : undefined;

  const fromNestedRefund = nested
    ? readNestedEntityStatus(nested, "refund")
    : undefined;
  const fromOwnRefund = readNestedEntityStatus(rec, "refund");
  const fromNestedPayment = nested
    ? readNestedEntityStatus(nested, "payment")
    : undefined;
  const fromOwnPayment = readNestedEntityStatus(rec, "payment");
  const fromNestedStatus = nested
    ? readTrimmedInboxStatus(nested.status)
    : undefined;

  const nestedOrEntityExists =
    nested !== undefined ||
    fromOwnRefund !== undefined ||
    fromOwnPayment !== undefined;

  if (nestedOrEntityExists) {
    return (
      fromNestedRefund ??
      fromOwnRefund ??
      fromNestedPayment ??
      fromOwnPayment ??
      fromNestedStatus
    );
  }

  return readTrimmedInboxStatus(rec.status);
}

function resolveHandlerEvent(
  inputEvent: unknown | undefined,
  payloadRef: string | undefined,
): unknown {
  if (inputEvent !== undefined) {
    if (inputEvent !== null && typeof inputEvent === "object") {
      return redactWebhookPayloadSecrets(inputEvent);
    }
    return inputEvent;
  }
  if (payloadRef !== undefined) {
    return materializeEventFromPayloadRef(payloadRef);
  }
  return undefined;
}

function isNonRetryable(error: unknown): boolean {
  if (error instanceof NonRetryableHandlerError) return true;
  if (
    typeof error === "object" &&
    error !== null &&
    "deadLetter" in error &&
    (error as { deadLetter: unknown }).deadLetter === true
  ) {
    return true;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable: unknown }).retryable === false
  ) {
    return true;
  }
  return false;
}

/**
 * Whether store.fail should mark dead_letter (terminal) vs pending retry.
 *
 * `maxAttempts` is max **handler** attempts (claim counter after real handler
 * work; parking `ackAfterClaim` restores via restoreAttempt; crash soft-release
 * restores unfinished claims so deploy reclaim does not burn the budget).
 */
function shouldDeadLetter(error: unknown, attempts: number, maxAttempts: number, mode: WebhookProcessingMode): boolean {
  if (error instanceof NonRetryableHandlerError) {
    if (error.deadLetter) return true;
    // { deadLetter: false } is an opt-in non-terminal path. Prefer default
    // (deadLetter true). In durable_retry still exhaust maxAttempts so a poison
    // message cannot spin forever via processRetryable / redelivery.
    return mode === "durable_retry" && attempts >= maxAttempts;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "deadLetter" in error &&
    (error as { deadLetter: unknown }).deadLetter === true
  ) {
    return true;
  }
  // Non-retryable without explicit deadLetter=false → terminal.
  if (isNonRetryable(error)) return true;
  // durable_retry: exhaust handler attempts → dead letter.
  if (mode === "durable_retry" && attempts >= maxAttempts) return true;
  return false;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

/**
 * Create a webhook inbox engine bound to a store and **fixed** processing mode.
 *
 * @example
 * ```ts
 * const engine = createWebhookInboxEngine({
 *   store,
 *   mode: "inline",
 *   clock: { nowMs: () => Date.now() },
 * });
 * const outcome = await engine.processVerified({
 *   gateway: "stripe",
 *   providerEventId: "evt_1",
 *   // Prefer gateway event.payloadHash; never mix rawBody string vs object hashes
 *   payloadHash: resolveInboxPayloadHash({
 *     eventPayloadHash: webhookEvent.payloadHash,
 *     payloadForHash: webhookEvent.rawPayload ?? webhookEvent,
 *   }),
 *   event: normalized,
 *   handler: async (ctx) => { await fulfill(ctx.event); },
 * });
 * ```
 */
export function createWebhookInboxEngine(
  options: CreateWebhookInboxEngineOptions,
): WebhookInboxEngine {
  const store: WebhookInboxStore = options.store;
  const mode: WebhookProcessingMode = options.mode;
  if (mode !== "inline" && mode !== "durable_retry") {
    throw new Error(
      `createWebhookInboxEngine: mode must be "inline" or "durable_retry", got ${String(mode)}`,
    );
  }

  const defaultOwner = options.owner ?? DEFAULT_OWNER;
  const defaultLeaseMs = assertPositiveLeaseMs(
    options.defaultLeaseMs ?? DEFAULT_LEASE_MS,
    "defaultLeaseMs",
  );
  const maxAttempts = assertMaxAttempts(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  const defaultRetryAfterMs = assertNonNegativeRetryMs(
    options.defaultRetryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
    "defaultRetryAfterMs",
  );
  const engineAckAfterClaim = options.ackAfterClaim === true;
  const workerGuaranteed = options.workerGuaranteed === true;
  const clock: EngineClock = options.clock ?? systemClock;
  const sanitize: SanitizeErrorFn =
    options.sanitizeError ?? ((err) => sanitizeWebhookError(err));

  if (engineAckAfterClaim && mode !== "durable_retry") {
    throw new Error(
      'createWebhookInboxEngine: ackAfterClaim is only valid with mode "durable_retry"',
    );
  }
  if (engineAckAfterClaim && !workerGuaranteed) {
    throw new Error(
      "createWebhookInboxEngine: ackAfterClaim requires workerGuaranteed: true (parked scheduled_for_retry is mapped to HTTP 200; without a processRetryable worker that ACK drops money-moving webhooks)",
    );
  }

  function retryAfterFromRecord(record: WebhookInboxRecord): number | undefined {
    if (!record.leaseExpiresAt) return undefined;
    const exp = Date.parse(record.leaseExpiresAt);
    if (!Number.isFinite(exp)) return undefined;
    const delta = exp - clock.nowMs();
    return delta > 0 ? delta : 0;
  }

  async function runHandlerUnderLease(args: {
    key: WebhookEventKey;
    leaseToken: LeaseToken;
    record: WebhookInboxRecord;
    gateway: string;
    providerEventId: string;
    event: unknown;
    handler: WebhookHandler;
    /** Default lease extension for ctx.renew() when caller omits ms. */
    leaseMs: number;
    /** Claim owner — used to re-claim after fail lease_lost (WEBHOOKS-3). */
    owner: string;
  }): Promise<WebhookProcessingOutcome> {
    let currentToken = args.leaseToken;
    let currentRecord = args.record;
    let lostOwnership = false;
    let heartbeatLostOwnership = false;
    let closed = false;
    let renewTail: Promise<void> = Promise.resolve();

    const renew = async (leaseMs?: number): Promise<void> => {
      // S20-HEARTBEAT-RACE: ignore ticks after stopHeartbeat so a queued
      // renew cannot rotate the token complete/fail will use.
      if (closed) {
        return;
      }
      const run = async (): Promise<void> => {
        if (closed) {
          return;
        }
        if (lostOwnership) {
          throw new StoreLeaseLostError("renewLease failed: lease_lost");
        }
        // Prefer caller's ms, else this claim's leaseMs (not only engine default).
        const ms = assertPositiveLeaseMs(
          leaseMs ?? args.leaseMs,
          leaseMs !== undefined ? "leaseMs" : "defaultLeaseMs",
        );
        const result = await store.renew({
          key: args.key,
          leaseToken: currentToken,
          leaseMs: ms,
        });
        if (!result.ok) {
          lostOwnership = true;
          throw new StoreLeaseLostError(
            `renewLease failed: ${result.reason}`,
          );
        }
        // In-flight renew started before close: apply rotation — complete
        // awaits this tail. Do not start a *new* renew after close.
        currentToken = result.leaseToken;
        currentRecord = result.record;
      };
      // Serialize ctx.renew + heartbeat so a rotated token is not raced.
      const next = renewTail.then(run, run);
      renewTail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    const ctx: WebhookHandlerContext = {
      key: args.key,
      get leaseToken() {
        return currentToken;
      },
      get record() {
        return currentRecord;
      },
      event: args.event,
      gateway: args.gateway,
      providerEventId: args.providerEventId,
      mode,
      renew,
    };

    // Default 30s leases expire during handler I/O; renew before expiry.
    const heartbeatMs = Math.max(1, Math.floor(args.leaseMs / 3));
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      // Set closed before awaiting the renew tail (callers await after this).
      closed = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    heartbeatTimer = setInterval(() => {
      if (closed) return;
      void renew().catch(() => {
        lostOwnership = true;
        heartbeatLostOwnership = true;
        stopHeartbeat();
      });
    }, heartbeatMs);

    try {
      await args.handler(ctx);
    } catch (err) {
      stopHeartbeat();
      await renewTail;
      // Heartbeat lease_lost: we are not owner — do not fail/complete (fence).
      if (heartbeatLostOwnership) {
        return outcomeHandlerFailed(true);
      }
      // WEBHOOKS-2: do not skip store.fail on lease-lost-from-renew. Stores accept
      // fail with a matching token even after lease expiry so the handler attempt
      // counts toward maxAttempts (soft-release alone must not erase the budget).
      // Only real fencing errors (StoreLeaseLostError / name), not bare code.
      const leaseLostFromHandler = isStoreLeaseLostError(err);
      const failureError = leaseLostFromHandler
        ? new Error("handler lease lost (renew/timeout)")
        : err;

      const nonRetry = !leaseLostFromHandler && isNonRetryable(err);
      const budgetDeadLetter = shouldDeadLetter(
        failureError,
        currentRecord.attempts,
        maxAttempts,
        mode,
      );

      // WEBHOOKS-1: do NOT permanent-dead-letter solely because payloadRef is
      // missing on a retryable handler failure — that blocks provider redelivery
      // of paid events forever. Claim path requires materializable payload for
      // durable_retry; if a legacy row lacks payloadRef, leave pending/retryable
      // so redelivery or a custom resolveEvent path can recover. processRetryable
      // still refuses stub materialization without payloadRef.
      const deadLetter = budgetDeadLetter;

      const failInput: {
        key: WebhookEventKey;
        leaseToken: LeaseToken;
        error: string;
        deadLetter?: boolean;
        retryAfterMs?: number;
      } = {
        key: args.key,
        leaseToken: currentToken,
        error: sanitize(failureError),
      };
      if (deadLetter) {
        failInput.deadLetter = true;
      } else if (mode === "inline") {
        // P610-ACK-1: inline fail is immediately redeliverable (no backoff ACK).
        failInput.retryAfterMs = 0;
      } else {
        failInput.retryAfterMs = defaultRetryAfterMs;
      }

      try {
        await store.fail(failInput);
      } catch (failErr) {
        if (isStoreLeaseLostError(failErr)) {
          // WEBHOOKS-2 / WEBHOOKS-3 / WH-LIST-FAIL: token already cleared
          // (foreign reclaim, or listRetryable/get soft-release after expiry).
          // Best-effort re-claim + fail so maxAttempts / non-retry intent still
          // apply. Never complete on this path (handler already ran; at-least-once).
          // If reclaim cannot record, return handler_failed retryable.
          const recovered = await bestEffortRecordFailAfterLeaseLost({
            key: args.key,
            payloadHash: currentRecord.payloadHash,
            payloadRef: currentRecord.payloadRef,
            owner: args.owner,
            leaseMs: args.leaseMs,
            error: sanitize(failureError),
            forceDeadLetter: deadLetter || nonRetry,
            priorAttempts: currentRecord.attempts,
          });
          // P610-ACK-3: non-retryable / terminal only when fail/dead_letter
          // actually applied (or claim already terminal).
          if (recovered.terminal) {
            return outcomeHandlerFailed(false);
          }
          if (recovered.recorded && mode === "durable_retry") {
            return outcomeScheduledForRetry(
              "handler_retry",
              timingFromRetryAfterMs(defaultRetryAfterMs, clock.nowMs()),
            );
          }
          return outcomeHandlerFailed(true);
        }
        throw failErr;
      }

      if (deadLetter || nonRetry) {
        return outcomeHandlerFailed(false);
      }
      if (mode === "durable_retry") {
        return outcomeScheduledForRetry(
          "handler_retry",
          timingFromRetryAfterMs(defaultRetryAfterMs, clock.nowMs()),
        );
      }
      return outcomeHandlerFailed(true);
    }

    stopHeartbeat();
    await renewTail;
    // Heartbeat or swallowed renew lost the fence — do not complete as owner.
    if (lostOwnership || heartbeatLostOwnership) {
      return outcomeHandlerFailed(true);
    }

    // Handler succeeded — complete with current (possibly rotated) token.
    try {
      await store.complete({
        key: args.key,
        leaseToken: currentToken,
      });
      return outcomeProcessed();
    } catch (completeErr) {
      // Crash boundary: side effect may have committed; never report processed.
      if (isStoreLeaseLostError(completeErr)) {
        return outcomeHandlerFailed(true);
      }
      throw completeErr;
    }
  }

  /**
   * WEBHOOKS-2 / WEBHOOKS-3: after fail() lease_lost, soft-release or a peer
   * may have cleared the token. Best-effort re-claim + fail so:
   * - non-retry / maxAttempts exhaustion reaches `dead_letter`
   * - retryable handler outcomes still record (attempt budget advances)
   * rather than spinning forever with soft-restored attempts.
   */
  async function bestEffortRecordFailAfterLeaseLost(args: {
    key: WebhookEventKey;
    payloadHash: string;
    payloadRef?: string | undefined;
    owner: string;
    leaseMs: number;
    error: string;
    forceDeadLetter: boolean;
    priorAttempts: number;
  }): Promise<{ terminal: boolean; recorded: boolean }> {
    try {
      const claimInput: ClaimWebhookInput = {
        key: args.key,
        payloadHash: args.payloadHash,
        owner: args.owner,
        leaseMs: args.leaseMs,
        // S20-WH-FAIL-RECLAIM: fence the body this handler ran. Idle
        // WEBHOOKS-3 may have moved the row to a newer hash — do not
        // supersede backwards (same CAS as processRetryable / S19).
        ifMatchPayloadHash: args.payloadHash,
      };
      if (args.payloadRef !== undefined) {
        claimInput.payloadRef = args.payloadRef;
      }
      const reclaim = await store.claim(claimInput);
      if (reclaim.kind === "already_completed" || reclaim.kind === "duplicate_failed") {
        return { terminal: true, recorded: true };
      }
      if (reclaim.kind === "payload_hash_conflict") {
        return { terminal: false, recorded: false };
      }
      if (reclaim.kind !== "acquired") {
        return { terminal: false, recorded: false };
      }
      // Reclaim increments attempts when status was pending after soft-release.
      // Use the higher of prior claim attempts and reclaimed counter for budget.
      const attemptsForBudget = Math.max(
        args.priorAttempts,
        reclaim.record.attempts,
      );
      const exhaust =
        mode === "durable_retry" && attemptsForBudget >= maxAttempts;
      const deadLetter = args.forceDeadLetter || exhaust;
      const failInput: {
        key: WebhookEventKey;
        leaseToken: LeaseToken;
        error: string;
        deadLetter?: boolean;
        retryAfterMs?: number;
      } = {
        key: args.key,
        leaseToken: reclaim.leaseToken,
        error: args.error,
      };
      if (deadLetter) {
        failInput.deadLetter = true;
      } else if (mode === "inline") {
        failInput.retryAfterMs = 0;
      } else {
        failInput.retryAfterMs = defaultRetryAfterMs;
      }
      try {
        await store.fail(failInput);
      } catch {
        // P610-ACK-3: post-reclaim fail did not apply — not terminal.
        return { terminal: false, recorded: false };
      }
      return { terminal: deadLetter, recorded: true };
    } catch {
      // P610-ACK-3: catch must not advertise terminal unless fail/dead_letter
      // applied or claim kind is already_completed / duplicate_failed.
      return { terminal: false, recorded: false };
    }
  }

  async function processVerified(
    input: ProcessVerifiedInput,
  ): Promise<WebhookProcessingOutcome> {
    const gateway =
      typeof input.gateway === "string" ? input.gateway.trim() : "";
    const providerEventId =
      typeof input.providerEventId === "string"
        ? input.providerEventId.trim()
        : "";
    const payloadHash =
      typeof input.payloadHash === "string" ? input.payloadHash.trim() : "";

    if (!gateway) {
      return outcomeInvalidWebhook("gateway is required");
    }
    if (!providerEventId) {
      return outcomeInvalidWebhook("providerEventId is required");
    }
    if (!payloadHash) {
      return outcomeInvalidWebhook("payloadHash is required");
    }

    const notificationClass =
      extractInboxNotificationClass(input.event) ??
      extractInboxNotificationClass(input.envelope);
    const domainStatus =
      extractInboxDomainStatus(input.event) ??
      extractInboxDomainStatus(input.envelope);

    let key: string;
    try {
      key = deriveWebhookEventKey(
        gateway,
        providerEventId,
        notificationClass,
        domainStatus,
      );
    } catch (e) {
      return outcomeInvalidWebhook(
        e instanceof Error ? e.message : "invalid event key",
      );
    }

    // Mode branch must be known before claim so we never claim without a path
    // to complete/fail (handler required unless durable ack-after-claim).
    const ackAfterClaim =
      mode === "durable_retry" &&
      (input.ackAfterClaim === true ||
        (input.ackAfterClaim === undefined && engineAckAfterClaim));

    if (!ackAfterClaim && !input.handler) {
      return outcomeInvalidWebhook(
        "handler is required when running handler inline",
      );
    }

    // Parked ACK is HTTP 200. Without a worker guarantee, refuse so the PSP redelivers.
    if (ackAfterClaim && !workerGuaranteed) {
      return outcomeHandlerFailed(true);
    }

    const owner = input.owner ?? defaultOwner;
    const leaseMs = assertPositiveLeaseMs(
      input.leaseMs ?? defaultLeaseMs,
      input.leaseMs !== undefined ? "leaseMs" : "defaultLeaseMs",
    );
    // Prefer explicit envelope; for durable_retry also snapshot redacted `event`
    // so handler failures can redrive without stub materialization (WEBHOOKS-1).
    // P610-SNAP-1: never persist rawPayload/headers — wrap via
    // toPersistedPaymentEventEnvelope or refuse.
    let payloadRef: string | undefined;
    if (mode === "durable_retry") {
      const snap = resolveDurablePayloadRef({
        envelope: input.envelope,
        event: input.event,
        payloadHash,
      });
      if (!snap.ok) {
        // WEBHOOKS-2: missing / unrefusable snapshot is not forgery (not 400).
        // Authentic paid deliveries must stay retryable so the provider redelivers.
        return outcomeHandlerFailed(true);
      }
      payloadRef = snap.payloadRef;
    } else {
      // WEBHOOKS-4: persist payloadRef on inline when event/envelope is
      // materializable so a later durable_retry worker can redrive without
      // dead-lettering paid rows. Raw/unrefusable snapshots are skipped
      // (handler still has the in-memory event).
      const snap = resolveDurablePayloadRef({
        envelope: input.envelope,
        event: input.event,
        payloadHash,
      });
      if (snap.ok) {
        payloadRef = snap.payloadRef;
      }
    }

    // Refuse durable park without a materializable payload — otherwise workers
    // cannot redrive and paid fulfillment is lost after ACK.
    // WEBHOOKS-2: this is a server/retryable outcome, not invalid_webhook/400.
    if (ackAfterClaim && payloadRef === undefined) {
      return outcomeHandlerFailed(true);
    }

    const claimInput: {
      key: string;
      payloadHash: string;
      owner: string;
      leaseMs: number;
      payloadRef?: string;
    } = {
      key,
      payloadHash,
      owner,
      leaseMs,
    };
    if (payloadRef !== undefined) {
      claimInput.payloadRef = payloadRef;
    }

    const claim = await store.claim(claimInput);

    switch (claim.kind) {
      case "already_completed":
        return outcomeDuplicateCompleted();
      case "in_progress":
        return outcomeAlreadyProcessing(retryAfterFromRecord(claim.record));
      case "payload_hash_conflict":
        return outcomePayloadConflict();
      case "duplicate_failed":
        // Terminal failed / dead_letter at store level — not retryable via engine.
        return outcomeHandlerFailed(false);
      case "not_available":
        // Backoff: provider redelivery during availableAt window must not burn attempts.
        // P610-ACK-1: inline never emits scheduled_for_retry (no worker path).
        if (mode === "inline") {
          return outcomeHandlerFailed(true);
        }
        // Distinct reason so adapters can 5xx (provider redelivery) instead of silent 200.
        // WEBHOOKS-5: expose availableAt / retryAfterMs for honest Retry-After.
        return outcomeScheduledForRetry(
          "not_available",
          timingFromAvailableAt(claim.availableAt, clock.nowMs()),
        );
      case "acquired":
        break;
      default: {
        const _exhaustive: never = claim;
        return outcomeInvalidWebhook(
          `unknown claim kind: ${String((_exhaustive as { kind: string }).kind)}`,
        );
      }
    }

    if (ackAfterClaim) {
      // Store contract has no "release to pending" op: fail with retryAfterMs=0
      // parks the row for processRetryable without treating HTTP as processed.
      // restoreAttempt undoes the parking claim's attempt++ so maxAttempts remains
      // max *handler* attempts (parking claim is free).
      try {
        await store.fail({
          key,
          leaseToken: claim.leaseToken,
          error: "ack_after_claim: scheduled for durable worker",
          retryAfterMs: 0,
          restoreAttempt: true,
        });
      } catch (err) {
        if (isStoreLeaseLostError(err)) {
          // P610-ACK-2: parked ONLY when fail(restoreAttempt) applied.
          // lease_lost means the row is still claimed — never ACK as parked.
          const retryAfter = retryAfterFromRecord(claim.record);
          if (retryAfter !== undefined && retryAfter > 0) {
            return outcomeAlreadyProcessing(retryAfter);
          }
          return outcomeHandlerFailed(true);
        }
        throw err;
      }
      return outcomeScheduledForRetry(
        "parked",
        timingFromRetryAfterMs(0, clock.nowMs()),
      );
    }

    // Unreachable under normal control flow: missing handler is rejected before
    // claim when !ackAfterClaim. Kept solely for TypeScript narrowing / defense.
    const handler = input.handler;
    if (!handler) {
      return outcomeInvalidWebhook(
        "handler is required when running handler inline",
      );
    }

    // Materialize + redact so first delivery matches processRetryable:
    // prefer caller event (redacted), else payloadRef snapshot.
    const handlerEvent = resolveHandlerEvent(input.event, payloadRef);

    return runHandlerUnderLease({
      key,
      leaseToken: claim.leaseToken,
      record: claim.record,
      gateway,
      providerEventId,
      event: handlerEvent,
      handler,
      leaseMs,
      owner,
    });
  }

  async function processWithVerifier(
    input: ProcessWithVerifierInput,
  ): Promise<WebhookProcessingOutcome> {
    let verified;
    try {
      verified = await input.verifyAndNormalize(input.raw);
    } catch (err) {
      // WEBHOOKS-1 / WEBHOOKS-5 / WEBHOOKS-403: fail-open on verify throws.
      // Forgery (verify-false InvalidWebhookError only) → invalid_webhook (~400).
      // Permanent structure/config → handler_failed non-retryable.
      // InvalidRequestError / parse-stage InvalidWebhookError (HTTP 403) /
      // RateLimitError / TypeError / NetworkError / unknown / onWebhookVerified
      // → handler_failed retryable (~5xx).
      // Explicit ok:false is the other forgery path (below) — never claim.
      const kind = classifyVerifyThrow(err);
      if (kind === "forgery") {
        return outcomeInvalidWebhook(sanitize(err));
      }
      if (kind === "permanent") {
        return outcomeHandlerFailed(false);
      }
      return outcomeHandlerFailed(true);
    }
    if (!verified.ok) {
      // P610-SNAP-1: never leak secrets from { ok: false }.reason.
      return outcomeInvalidWebhook(
        verified.reason !== undefined ? sanitize(verified.reason) : undefined,
      );
    }

    const next: ProcessVerifiedInput = {
      gateway: verified.gateway,
      providerEventId: verified.providerEventId,
      payloadHash: verified.payloadHash,
    };
    if (verified.event !== undefined) next.event = verified.event;
    if (verified.envelope !== undefined) next.envelope = verified.envelope;
    if (input.handler !== undefined) next.handler = input.handler;
    if (input.leaseMs !== undefined) next.leaseMs = input.leaseMs;
    if (input.owner !== undefined) next.owner = input.owner;
    if (input.ackAfterClaim !== undefined) next.ackAfterClaim = input.ackAfterClaim;

    return processVerified(next);
  }

  async function processRetryable(
    input: ProcessRetryableInput,
  ): Promise<ProcessRetryableResult> {
    // Mode boundary: retry worker path is durable_retry only (never mix with inline).
    if (mode !== "durable_retry") {
      throw new Error(
        'processRetryable is only valid when mode is "durable_retry" (engine mode is fixed at construction)',
      );
    }

    const limit = input.limit ?? 10;
    const owner = input.owner ?? defaultOwner;
    const leaseMs = assertPositiveLeaseMs(
      input.leaseMs ?? defaultLeaseMs,
      input.leaseMs !== undefined ? "leaseMs" : "defaultLeaseMs",
    );
    const pending = await store.listRetryable({ limit });

    const items: ProcessRetryableResult["items"] = [];
    const prepared = pending.map((rec) => prepareRetryableRow(rec, input));

    // NEW-WEBHOOKS-1: list is discovery only. Do not hold N unexpired leases
    // across serial handler I/O — defaults (limit=10, leaseMs=30s) overrun
    // if handlers average >=3s and a peer reclaims the tail. Claim the next
    // row only after the previous handler returns.
    for (const row of prepared) {
      items.push({
        key: row.rec.key,
        outcome: await claimAndRunRetryableRow(row, input.handler, owner, leaseMs),
      });
    }

    return { items };
  }

  async function processOne(input: ProcessOneInput): Promise<ProcessOneResult> {
    if (mode !== "durable_retry") {
      throw new Error(
        'processOne is only valid when mode is "durable_retry" (engine mode is fixed at construction)',
      );
    }
    const owner = input.owner ?? defaultOwner;
    const leaseMs = assertPositiveLeaseMs(
      input.leaseMs ?? defaultLeaseMs,
      input.leaseMs !== undefined ? "leaseMs" : "defaultLeaseMs",
    );
    // Same path as one `processRetryable` row, addressed by key instead of
    // listed: `get` for the hash/payloadRef snapshot, then the store's own
    // compare-and-set `claim` (ifMatchPayloadHash, one lease, attempts and
    // backoff gates). Terminal, leased and not-yet-due rows come back from
    // `claim` as their usual outcomes, so no row state is decided here.
    const rec = await store.get(input.key);
    if (rec === undefined) return { key: input.key, found: false };
    const row = prepareRetryableRow(rec, input);
    return {
      key: input.key,
      found: true,
      outcome: await claimAndRunRetryableRow(row, input.handler, owner, leaseMs, rec),
    };
  }

  type PreparedRetryable = {
    rec: WebhookInboxRecord;
    gateway: string;
    providerEventId: string;
    payloadHash: string;
    event: unknown | undefined;
    payloadRef: string | undefined;
  };

  function prepareRetryableRow(
    rec: WebhookInboxRecord,
    input: Pick<ProcessRetryableInput, "resolveEvent">,
  ): PreparedRetryable {
    let gateway: string;
    let providerEventId: string;
    let payloadHash: string;
    let event: unknown | undefined;

    let payloadRef = rec.payloadRef;
    if (input.resolveEvent) {
      const resolved = input.resolveEvent(rec);
      gateway = resolved.gateway;
      providerEventId = resolved.providerEventId;
      payloadHash = resolved.payloadHash;
      event = resolved.event;
      if (resolved.envelope !== undefined) {
        const snap = resolveDurablePayloadRef({
          envelope: resolved.envelope,
          payloadHash,
        });
        if (snap.ok) payloadRef = snap.payloadRef;
      }
      // WEBHOOKS-5: redact / materialize with same rules as first delivery.
      // Prefer custom resolveEvent.event when provided; else payloadRef.
      if (event !== undefined) {
        event = resolveHandlerEvent(event, undefined);
      } else if (payloadRef !== undefined) {
        event = materializeEventFromPayloadRef(payloadRef);
      }
    } else {
      const parsed = parseWebhookEventKey(rec.key);
      gateway = parsed?.gateway ?? "unknown";
      providerEventId = parsed?.providerEventId ?? rec.key;
      payloadHash = rec.payloadHash;
      if (rec.payloadRef) {
        event = materializeEventFromPayloadRef(rec.payloadRef);
      }
      // WEBHOOKS-1: never stub `{ key, payloadHash }` — paid data would be lost.
    }

    return { rec, gateway, providerEventId, payloadHash, event, payloadRef };
  }

  async function claimAndRunRetryableRow(
    row: PreparedRetryable,
    handler: WebhookHandler,
    owner: string,
    leaseMs: number,
    /** A read the caller made just now (`processOne`); omit to re-read after a list. */
    fresh?: WebhookInboxRecord,
  ): Promise<WebhookProcessingOutcome> {
    // I14: list snapshot can go stale before get. Skip if the idle hash
    // moved forward — do not claim with a hash the list did not show.
    const latest = fresh ?? (await store.get(row.rec.key));
    if (latest === undefined || latest.payloadHash !== row.payloadHash) {
      return outcomeHandlerFailed(true);
    }

    // S19: claim the *listed* hash under ifMatch so get→claim idle
    // supersede cannot roll the row back to this snapshot (WEBHOOKS-3
    // must not run backwards on the worker path).
    const claimInput: ClaimWebhookInput = {
      key: row.rec.key,
      payloadHash: row.payloadHash,
      owner,
      leaseMs,
      ifMatchPayloadHash: row.payloadHash,
    };
    const payloadRef = latest.payloadRef ?? row.payloadRef;
    if (payloadRef !== undefined) {
      claimInput.payloadRef = payloadRef;
    }
    const claim = await store.claim(claimInput);
    const { rec, gateway, providerEventId, event } = row;

    if (claim.kind !== "acquired") {
      // CAS miss / active-lease hash mismatch: skip this poll. Do not
      // surface payload_conflict — the worker is not a delivery ACK.
      if (claim.kind === "payload_hash_conflict") {
        return outcomeHandlerFailed(true);
      }
      return mapClaimKindToOutcome(claim, retryAfterFromRecord, clock.nowMs());
    }

    // WEBHOOKS-4: missing payloadRef (inline-era rows / refused snapshot)
    // must not dead-letter paid work. Refuse this poll as retryable so
    // provider redelivery or a custom resolveEvent can recover.
    if (event === undefined) {
      try {
        await store.fail({
          key: rec.key,
          leaseToken: claim.leaseToken,
          error:
            "missing payloadRef: cannot redrive durable webhook without stored envelope/event",
          retryAfterMs: defaultRetryAfterMs,
          restoreAttempt: true,
        });
      } catch (failErr) {
        if (isStoreLeaseLostError(failErr)) return outcomeHandlerFailed(true);
        throw failErr;
      }
      return outcomeHandlerFailed(true);
    }

    return runHandlerUnderLease({
      key: rec.key,
      leaseToken: claim.leaseToken,
      record: claim.record,
      gateway,
      providerEventId,
      event,
      handler,
      leaseMs,
      owner,
    });
  }

  async function renewLease(
    key: WebhookEventKey,
    leaseToken: LeaseToken,
    leaseMs?: number,
  ): Promise<RenewWebhookLeaseResult> {
    return store.renew({
      key,
      leaseToken,
      leaseMs: assertPositiveLeaseMs(
        leaseMs ?? defaultLeaseMs,
        leaseMs !== undefined ? "leaseMs" : "defaultLeaseMs",
      ),
    });
  }

  return {
    get mode() {
      return mode;
    },
    get workerGuaranteed() {
      return workerGuaranteed;
    },
    processVerified,
    processWithVerifier,
    processRetryable,
    processOne,
    renewLease,
  };
}

function mapClaimKindToOutcome(
  claim: Exclude<
    Awaited<ReturnType<WebhookInboxStore["claim"]>>,
    { kind: "acquired" }
  >,
  retryAfterFromRecord: (r: WebhookInboxRecord) => number | undefined,
  nowMs: number,
): WebhookProcessingOutcome {
  switch (claim.kind) {
    case "already_completed":
      return outcomeDuplicateCompleted();
    case "in_progress":
      return outcomeAlreadyProcessing(retryAfterFromRecord(claim.record));
    case "payload_hash_conflict":
      return outcomePayloadConflict();
    case "duplicate_failed":
      return outcomeHandlerFailed(false);
    case "not_available":
      // WEBHOOKS-5: expose availableAt / retryAfterMs for honest Retry-After.
      return outcomeScheduledForRetry(
        "not_available",
        timingFromAvailableAt(claim.availableAt, nowMs),
      );
    default: {
      const _e: never = claim;
      return outcomeInvalidWebhook(String(_e));
    }
  }
}
