/**
 * Engine types: processing modes, outcomes, handler context, options.
 *
 * Modes are fixed at engine construction (never mixed implicitly).
 * Outcomes are framework-agnostic — no Express/Hono HTTP status codes.
 */

import type {
  LeaseToken,
  WebhookEventKey,
  WebhookInboxRecord,
  WebhookInboxStore,
} from "./store";

// ─── Modes (10.3) ────────────────────────────────────────────────────────────

/**
 * Explicit processing mode. Set once on `createWebhookInboxEngine`.
 *
 * - `inline`: await handler; on throw → store.fail (`retryAfterMs: 0`) →
 *   `handler_failed`. **Never** emits `scheduled_for_retry` (including
 *   `not_available` → `handler_failed { retryable: true }`).
 * - `durable_retry`: await handler by default; on retryable throw → store.fail with
 *   delay → `scheduled_for_retry` (`reason: "handler_retry"`). When
 *   `ackAfterClaim: true` **and** `workerGuaranteed: true`, claim persists and
 *   returns `scheduled_for_retry` (`reason: "parked"`) without running the
 *   handler (worker via `processRetryable`) **only if**
 *   `store.fail({ restoreAttempt: true })` succeeds. The parking claim does
 *   **not** count toward `maxAttempts`. `ackAfterClaim` without
 *   `workerGuaranteed` refuses (constructor or retryable `handler_failed`).
 */
export type WebhookProcessingMode = "inline" | "durable_retry";

// ─── Outcomes (10.4) ─────────────────────────────────────────────────────────

/**
 * Why work was deferred under `scheduled_for_retry`.
 *
 * Adapters MUST discriminate these for HTTP policy — a single “retry later”
 * ACK is unsafe when no worker will process the row:
 *
 * - `parked` — durable `ackAfterClaim` released work for `processRetryable`
 *   (safe 200 only when a worker is guaranteed). Requires engine
 *   `workerGuaranteed: true`. Emitted only after
 *   `store.fail({ restoreAttempt: true })` succeeds.
 * - `handler_retry` — handler threw retryable; `store.fail` recorded with backoff.
 * - `not_available` — durable claim backoff (`availableAt` still future); no handler ran.
 *   Prefer 5xx so the provider redelivers unless a durable scheduler owns the row.
 *   **Inline engines never emit this** — they map the same claim kind to
 *   `handler_failed { retryable: true }`.
 */
export type ScheduledForRetryReason =
  | "parked"
  | "handler_retry"
  | "not_available";

/**
 * Explicit processing outcomes. Framework adapters map these to HTTP/status
 * policy. The engine NEVER hardcodes HTTP response codes.
 *
 * **Silent ACK of failed work is forbidden.** Callers must use the outcome
 * discriminant — never treat claim-without-success as processed.
 */
export type WebhookProcessingOutcome =
  | { outcome: "processed" }
  | { outcome: "duplicate_completed" }
  | { outcome: "already_processing"; retryAfterMs?: number }
  | {
      outcome: "scheduled_for_retry";
      reason: ScheduledForRetryReason;
      /**
       * When the inbox row becomes claimable again (ISO), when known
       * (WEBHOOKS-5). Adapters may map this to Retry-After / worker sleep.
       */
      availableAt?: string;
      /** Milliseconds until `availableAt` from engine clock, when computable. */
      retryAfterMs?: number;
    }
  | { outcome: "handler_failed"; retryable: boolean }
  | { outcome: "payload_conflict" }
  | { outcome: "invalid_webhook"; reason?: string };

// ─── Clock ───────────────────────────────────────────────────────────────────

/** Injectable clock (structural; tests may pass createFakeClock-like objects). */
export type EngineClock = {
  nowMs(): number;
};

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Application-thrown error that marks non-retryable failure.
 *
 * **Default (`deadLetter` omitted or `true`):** store marks `dead_letter` and
 * outcome is `handler_failed { retryable: false }` — preferred for poison messages.
 *
 * **`{ deadLetter: false }` (opt-in footgun):** engine still returns
 * `handler_failed { retryable: false }` but leaves the row **pending**. Provider
 * redelivery / `processRetryable` can re-run the handler (poison spin risk) until
 * `maxAttempts` is exhausted in `durable_retry` (engine then dead-letters). Prefer
 * the default so poison messages terminal immediately. Use `false` only when you
 * intentionally want a non-retryable signal without terminal storage (rare).
 */
export class NonRetryableHandlerError extends Error {
  readonly deadLetter: boolean;

  constructor(message: string, options?: { deadLetter?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NonRetryableHandlerError";
    this.deadLetter = options?.deadLetter !== false;
  }
}

export type WebhookHandlerContext = {
  key: WebhookEventKey;
  leaseToken: LeaseToken;
  record: WebhookInboxRecord;
  /** Verified+normalized application event (caller-supplied; opaque to engine). */
  event: unknown;
  gateway: string;
  providerEventId: string;
  mode: WebhookProcessingMode;
  /**
   * Renew the active lease. On success, the closed-over lease token is rotated
   * for subsequent complete/fail. On lease_lost, throws {@link import("./store").StoreLeaseLostError}.
   */
  renew: (leaseMs?: number) => Promise<void>;
};

/**
 * Application handler. MUST be idempotent (crash after side effect before
 * complete can re-run the handler after reclaim — see engine crash boundaries).
 */
export type WebhookHandler = (ctx: WebhookHandlerContext) => void | Promise<void>;

// ─── Process inputs ──────────────────────────────────────────────────────────

export type ProcessVerifiedInput = {
  gateway: string;
  providerEventId: string;
  /**
   * Precomputed payload hash for claim duplicate/conflict detection.
   *
   * **Canonical source (WEBHOOKS-2):** prefer gateway/event `payloadHash` when
   * present (e.g. Stripe `computePayloadHash` on the parsed event). Otherwise
   * hash the **same object shape** the gateway used — typically the verified
   * event / `rawPayload` object via core `hashWebhookPayload`.
   *
   * Do **not** mix `hashWebhookPayload(rawBodyString)` with an object hash for
   * the same event: non-object strings are not JSON-parsed before hashing, so
   * digests differ. Idle non-terminal rows **supersede** the stored hash on the
   * next claim (WEBHOOKS-3); active-lease mismatch still returns
   * `payload_conflict`. Prefer one canonical source via
   * {@link resolveInboxPayloadHash}.
   */
  payloadHash: string;
  /**
   * Verified + normalized event passed to the handler.
   * Engine does not interpret shape.
   */
  event?: unknown;
  /**
   * Optional sanitized envelope snapshot for durable retry (JSON string or
   * serializable object → JSON). NEVER pass raw signatures/secrets.
   * Stored only as `payloadRef` on claim (object envelopes are force-redacted;
   * opaque string envelopes have known secret patterns redacted — WEBHOOKS-6).
   *
   * **durable_retry:** when omitted, a redacted snapshot of `event` is stored
   * as `payloadRef` so `processRetryable` can redrive. `ackAfterClaim` still
   * requires a non-empty envelope (or event-derived payloadRef).
   * Events/envelopes that still carry `rawPayload` or `headers` are converted
   * via core `toPersistedPaymentEventEnvelope` when a PaymentEvent is present,
   * otherwise refused as retryable `handler_failed` (WEBHOOKS-2 — not
   * `invalid_webhook` / 400 forgery) — never persisted (P610-SNAP-1).
   *
   * **Handler event (WEBHOOKS-2):** when `event` is omitted but `envelope` is
   * present, `processVerified` materializes `ctx.event` from the envelope /
   * payloadRef the same way as `processRetryable`.
   */
  envelope?: unknown;
  /** Override default lease duration for this claim. */
  leaseMs?: number;
  /** Override default owner for this claim. */
  owner?: string;
  /**
   * Handler for this delivery. Required when mode runs the handler inline
   * (inline mode, or durable_retry without ackAfterClaim).
   */
  handler?: WebhookHandler;
  /**
   * Per-call override for durable_retry ack-after-claim (defaults to engine
   * option). When true, returns `scheduled_for_retry` (`reason: "parked"`) after
   * durable claim without running the handler **only if** engine
   * `workerGuaranteed: true` **and** `store.fail({ restoreAttempt: true })`
   * succeeds. Without `workerGuaranteed`, returns retryable `handler_failed`
   * (never parked — hosts must not 200). Park `lease_lost` returns
   * `already_processing` or `handler_failed { retryable: true }` (never parked).
   * Parking claim does not consume `maxAttempts`.
   *
   * **Requires `envelope`** (non-empty serializable payload for `payloadRef`).
   * Without a stored payload, workers cannot materialize the event — the engine
   * refuses with retryable `handler_failed` (WEBHOOKS-2) rather than parking
   * unfulfillable work or labeling it `invalid_webhook` (forgery / 400).
   */
  ackAfterClaim?: boolean;
};

/**
 * Verify+normalize callback for `processWithVerifier`.
 * Return `{ ok: true, ... }` or `{ ok: false, reason? }` for invalid_webhook.
 */
export type VerifyAndNormalizeResult =
  | {
      ok: true;
      gateway: string;
      providerEventId: string;
      payloadHash: string;
      event?: unknown;
      envelope?: unknown;
    }
  | { ok: false; reason?: string };

export type VerifyAndNormalize = (
  raw: unknown,
) => VerifyAndNormalizeResult | Promise<VerifyAndNormalizeResult>;

export type ProcessWithVerifierInput = {
  raw: unknown;
  verifyAndNormalize: VerifyAndNormalize;
  handler?: WebhookHandler;
  leaseMs?: number;
  owner?: string;
  ackAfterClaim?: boolean;
};

export type ProcessRetryableInput = {
  handler: WebhookHandler;
  /**
   * Max rows to claim+process in this poll. Default 10.
   * Claims are one-at-a-time (NEW-WEBHOOKS-1): the next `store.claim` runs
   * only after the previous handler returns so default `leaseMs` (30s)
   * cannot expire on later rows while earlier handlers I/O.
   */
  limit?: number;
  leaseMs?: number;
  owner?: string;
  /**
   * Resolve handler event/envelope from a pending record.
   *
   * **Default** (when omitted): parse `payloadRef` JSON when present. When the
   * parse matches a `PersistedPaymentEventEnvelope` shape (`schemaVersion` +
   * `event` + `payloadHash`), the nested `.event` is passed to the handler so
   * dual-write workers can `fulfill(ctx.event)` without a custom resolver. Plain
   * PaymentEvent / custom shapes are used as-is.
   *
   * **No stub events:** if `payloadRef` is missing and this resolver is omitted
   * (or returns no `event` / envelope), the row is **not** dead-lettered
   * (WEBHOOKS-4). The poll returns `handler_failed { retryable: true }` and
   * leaves the row pending so provider redelivery or a later `resolveEvent`
   * can recover paid work. Never materializes `{ key, payloadHash }` stubs.
   *
   * Override for custom stores or non-envelope `payloadRef` layouts.
   */
  resolveEvent?: (record: WebhookInboxRecord) => {
    gateway: string;
    providerEventId: string;
    event?: unknown;
    payloadHash: string;
    envelope?: unknown;
  };
};

export type ProcessRetryableItemResult = {
  key: WebhookEventKey;
  outcome: WebhookProcessingOutcome;
};

export type ProcessRetryableResult = {
  items: ProcessRetryableItemResult[];
};

/**
 * One receipt, addressed by key. Same handler, `resolveEvent`, `leaseMs` and
 * `owner` semantics as {@link ProcessRetryableInput} (without `limit`).
 */
export type ProcessOneInput = Omit<ProcessRetryableInput, "limit"> & {
  key: WebhookEventKey;
};

/**
 * `found: false` — no row for the key (never stored, or pruned); nothing ran.
 * `found: true` — `outcome` is what the same row would have produced inside
 * `processRetryable` (terminal/leased/not-yet-due rows are reported, not run).
 */
export type ProcessOneResult =
  | { key: WebhookEventKey; found: false }
  | { key: WebhookEventKey; found: true; outcome: WebhookProcessingOutcome };

// ─── Engine options ──────────────────────────────────────────────────────────

export type SanitizeErrorFn = (error: unknown) => string;

export type CreateWebhookInboxEngineOptions = {
  store: WebhookInboxStore;
  /**
   * Fixed processing mode. INVARIANT: never changes after construction;
   * `process*` methods do not switch modes.
   */
  mode: WebhookProcessingMode;
  /** Default lease owner string. Default: `"webhook-worker"`. */
  owner?: string;
  /**
   * Default lease duration in ms. Default: 30_000.
   * Must be a finite number `> 0` (constructor throws otherwise).
   */
  defaultLeaseMs?: number;
  /**
   * Max **handler** attempts before dead-letter on durable_retry. Default: 5.
   * Must be a finite integer `>= 1` (constructor throws otherwise).
   *
   * Counts handler outcomes (claim that reaches fail/complete), **not** pure
   * crash/deploy reclaims or parking claims:
   * - each successful claim increments store `attempts`
   * - `ackAfterClaim` parking is free (`fail({ restoreAttempt: true })`)
   * - soft-release via get/listRetryable restores unfinished crash reclaim
   * - **WEBHOOKS-2:** `fail` after lease expiry with matching token still
   *   records the attempt so hang/timeout paths hit this budget
   * - **WH-LIST-FAIL:** if `listRetryable` already wiped the token, late
   *   `fail()` is `lease_lost` → retryable `handler_failed` (never complete)
   * - provider redelivery while `availableAt` is in the future returns
   *   `not_available` / `scheduled_for_retry` (`reason: "not_available"`) and
   *   does not increment attempts
   */
  maxAttempts?: number;
  /**
   * Default retry delay after handler failure (ms). Default: 5_000.
   * Must be a finite number `>= 0` (constructor throws otherwise).
   * Sets store `availableAt`; both key-addressed claim and listRetryable respect it.
   */
  defaultRetryAfterMs?: number;
  /**
   * durable_retry only: when true, `processVerified` returns
   * `scheduled_for_retry` (`reason: "parked"`) after successful claim without
   * running the handler **only if** {@link workerGuaranteed} is also `true`
   * **and** `store.fail({ restoreAttempt: true })` succeeds. Constructor
   * throws when `ackAfterClaim` is set without `workerGuaranteed`. Park
   * `lease_lost` → `already_processing` or retryable `handler_failed`.
   * Workers must call `processRetryable`. Default: false (run handler
   * in-process). Parking does not consume handler attempt budget.
   * Requires a non-empty `envelope` on each parking `processVerified` call.
   */
  ackAfterClaim?: boolean;
  /**
   * Host guarantee that a `processRetryable` worker will run.
   * Required to emit `scheduled_for_retry { reason: "parked" }` (HTTP 200).
   * Without it, `ackAfterClaim` is refused so providers redeliver.
   */
  workerGuaranteed?: boolean;
  /** Injectable clock for lease expiry deltas / tests. Default: Date.now. */
  clock?: EngineClock;
  /** Override error sanitizer. Default: {@link import("./sanitize").sanitizeWebhookError}. */
  sanitizeError?: SanitizeErrorFn;
};

export type WebhookInboxEngine = {
  readonly mode: WebhookProcessingMode;
  /**
   * True when the host passed `workerGuaranteed: true` at construction.
   * HTTP adapters (`processWebhookHttp` `durable_worker` ACK) read this
   * property — it is not only an options-bag flag.
   */
  readonly workerGuaranteed: boolean;
  /**
   * Primary path: verified + normalized input → claim → handler (per mode) → outcome.
   */
  processVerified(input: ProcessVerifiedInput): Promise<WebhookProcessingOutcome>;
  /**
   * Optional wrapper: run injected verifyAndNormalize, then processVerified.
   *
   * **Verify classification (WEBHOOKS-1 / WEBHOOKS-3 / WEBHOOKS-4):**
   * - `{ ok: false }` or verify-false `InvalidWebhookError` (signature /
   *   authenticity) → `invalid_webhook` (never claims). `{ ok: false }.reason`
   *   is sanitized before return. Verify-false MAC mismatch stays forgery.
   * - Missing `webhookSecret` / `hmacSecret` / `webhookId` (InvalidRequestError
   *   or InvalidWebhookError whose message names those fields) →
   *   `handler_failed { retryable: true }` (I10 — never forgery; merchant
   *   adds the secret and providers redeliver)
   * - Parse-stage `InvalidWebhookError` (Paymob/Moyasar payload shape,
   *   "parse failed"; always HTTP 403) → `handler_failed { retryable: true }`
   *   (not forgery, not permanent 4xx — WEBHOOKS-403)
   * - Permanent structure/config throws → `handler_failed { retryable: false }`
   *   (408 / 409 / 425 / 429 stay retryable)
   * - Infrastructure / unknown throws (NetworkError, RateLimitError, TypeError,
   *   generic Error, onWebhookVerified) → `handler_failed { retryable: true }`
   *
   * **Composition (WEBHOOKS-2):** `verifyAndNormalize` must be verify-only.
   * Do **not** run fulfillment / `onWebhookVerified` money side effects here —
   * claim first via the returned path, then fulfill in `handler` /
   * `processRetryable`.
   */
  processWithVerifier(input: ProcessWithVerifierInput): Promise<WebhookProcessingOutcome>;
  /**
   * Worker path for **durable_retry** pending rows (`listRetryable` → claim → handler).
   * Throws if engine mode is `inline` (modes are fixed at construction; no silent mix).
   *
   * Claims with the listed `payloadHash` and `ifMatchPayloadHash` so an idle
   * WEBHOOKS-3 supersede between `get` and `claim` cannot roll the body back
   * (S19-WH-HASH-TOCTOU). Hash mismatch on get or compare-and-claim skip is
   * retryable `handler_failed` (not `payload_conflict`).
   */
  processRetryable(input: ProcessRetryableInput): Promise<ProcessRetryableResult>;
  /**
   * Claim and process exactly one receipt by key (durable_retry only; throws
   * in `inline`). The by-key counterpart of one `processRetryable` row:
   * `store.get(key)` for the hash/payloadRef snapshot, then the store's own
   * compare-and-set `claim` with `ifMatchPayloadHash`, so lease length
   * (`leaseMs`, default 30s), attempt accounting, backoff (`availableAt`),
   * terminal classification and lease fencing are the store's, unchanged.
   * It needs no store method beyond the existing `get` and `claim`, so every
   * adapter supports it. Unlike a list poll it never touches other keys, so
   * a due receipt cannot be starved by older stuck ones.
   *
   * A row that is not due, held by a live lease, completed or dead-lettered
   * is reported as its usual outcome and the handler does not run.
   * Added in 0.2.0: callers that must also run on older versions should
   * feature-test `typeof engine.processOne === "function"`.
   */
  processOne(input: ProcessOneInput): Promise<ProcessOneResult>;
  /**
   * Extend lease for a key. Rotates token on success; returns new token.
   * Stale token → `{ ok: false, reason: "lease_lost" }` (same as store.renew).
   */
  renewLease(
    key: WebhookEventKey,
    leaseToken: LeaseToken,
    leaseMs?: number,
  ): Promise<import("./store").RenewWebhookLeaseResult>;
};
