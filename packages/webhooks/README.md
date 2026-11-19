# @paykernel/webhooks

Storage-agnostic **webhook inbox engine** for [`@paykernel/core`](https://www.npmjs.com/package/@paykernel/core): atomic claim, payload-hash conflict detection, lease-fenced complete/fail, explicit processing modes, and framework-agnostic outcomes.

> **Portable.** No Node-only imports. No Express/Hono HTTP status hardcoding. Runtime: Bun / Node ≥ 18 / Deno / Workers (Web APIs). Depends only on `@paykernel/core`.

## Install

```bash
bun add @paykernel/webhooks
# peer / workspace: @paykernel/core
```

## Quickstart

Inject any `WebhookInboxStore` (testkit memory in tests; Phase 11+ durable adapters in production).

```typescript
import {
  createWebhookInboxEngine,
  resolveInboxPayloadHash,
  type WebhookInboxStore,
} from "@paykernel/webhooks";

declare const store: WebhookInboxStore;
/** Verified event from PaymentClient.handleWebhook / gateway.parseWebhookEvent */
declare const webhookEvent: {
  id: string;
  payloadHash?: string;
  rawPayload?: unknown;
  event?: unknown;
};

const engine = createWebhookInboxEngine({
  store,
  mode: "inline", // or "durable_retry" — fixed at construction
  owner: "api-worker-1",
  defaultLeaseMs: 30_000,
});

// WEBHOOKS-2 (required composition): claim/lease BEFORE money side effects.
// 1) Verify + normalize only (core handleWebhook) — do NOT fulfill here.
// 2) processVerified claims the inbox under a lease.
// 3) Fulfill only inside handler (or processRetryable after claim).
// Never run handleWebhook onWebhookVerified fulfillment inside
// processWithVerifier.verifyAndNormalize when using the inbox engine.
//
// Hash source: prefer event.payloadHash; else hash the same object shape the
// gateway used (parsed rawPayload). Do NOT mix rawBody string hashing with
// object event.payloadHash (idle rows supersede; active lease → payload_conflict).
const payloadHash = resolveInboxPayloadHash({
  eventPayloadHash: webhookEvent.payloadHash,
  payloadForHash: webhookEvent.rawPayload ?? webhookEvent.event ?? webhookEvent,
});
const outcome = await engine.processVerified({
  gateway: "stripe",
  providerEventId: webhookEvent.id,
  // Paymob: pass PaymentEvent so class is provider.eventType and processed
  // status is payment.status / refund.status (NEW-WH-KEY-1 / WEBHOOKS-1).
  payloadHash,
  event: webhookEvent.event ?? webhookEvent,
  // Optional sanitized dual-write envelope (never raw signatures / secrets):
  // envelope: toPersistedPaymentEventEnvelope(paymentEvent, { payloadHash }),
  // → payloadRef = { schemaVersion, event, payloadHash, storedAt }
  // processRetryable default auto-unwraps .event into ctx.event
  handler: async (ctx) => {
    // Long work: await ctx.renew(30_000);
    // Fulfill AFTER claim — under lease (WEBHOOKS-2).
    await fulfill(ctx.event);
  },
});

// Map outcome → HTTP in YOUR framework adapter — not inside this package.
// Engine is HTTP-agnostic; policy below is recommended, not hardcoded.
import { mapInboxOutcome } from "@paykernel/integration-http";
// Ready-made mapping: mapInboxOutcome(outcome) // provider_redelivery default; mapInboxOutcome(outcome, { kind: "durable_worker" }) for persisted deferrals

switch (outcome.outcome) {
  case "processed":
  case "duplicate_completed":
    // typically 200
    break;
  case "already_processing":
    // typically 5xx / 409 + Retry-After so the provider redelivers
    break;
  case "scheduled_for_retry":
    // Policy choice (engine never picks HTTP):
    // - 200 when durable claim/fail is already persisted and a worker will run
    //   (ackAfterClaim / intentional durable ACK) — provider need not redeliver
    // - 5xx when you want provider redelivery as the retry mechanism
    break;
  case "handler_failed":
    // retryable: typically 5xx; non-retryable: 200 or 4xx per policy
    // never silent-ACK uncertain/failed work without a real worker design
    break;
  case "payload_conflict":
    // typically 409 / 400 — active lease holds a different hash; do not ACK 200
    // without recovery (WEBHOOKS-3). Idle pending supersedes automatically.
    break;
  case "invalid_webhook":
    // typically 400 — forgery / empty key / empty hash only.
    // Missing durable payload / unrefusable snapshot is handler_failed
    // retryable (WEBHOOKS-2), not invalid_webhook.
    break;
}
```

### Tests with memory store

```typescript
import { createMemoryWebhookInboxStore, createFakeClock } from "@paykernel/testkit";
import { createWebhookInboxEngine } from "@paykernel/webhooks";

const clock = createFakeClock();
const store = createMemoryWebhookInboxStore({ clock });
const engine = createWebhookInboxEngine({ store, mode: "inline", clock });
```

(`@paykernel/webhooks` does **not** depend on testkit — import memory stores only from test code.)

**Dual memory-store honesty:** this package keeps a **non-exported** in-package `memory-store` for engine unit tests (not on the public surface). Testkit ships a separate `createMemoryWebhookInboxStore` for app tests and conformance. Both are **test-only / NON-PRODUCTION** and can drift on SQL-fencing nuances; production apps must inject durable adapters (`@paykernel/store-*`) that pass `runWebhookInboxStoreConformanceSuite`.

### With injected verifier (verify-only; fulfill after claim)

```typescript
import { resolveInboxPayloadHash } from "@paykernel/webhooks";

// WEBHOOKS-2: verifyAndNormalize must be **verify-only**.
// Do NOT put onWebhookVerified fulfillment / money side effects inside
// handleWebhook hooks when using the inbox — fulfill in `handler` after claim.
// Prefer: handleWebhook with no fulfillment hooks, or gateway.verify+parse only.
const outcome = await engine.processWithVerifier({
  raw: { body, headers },
  verifyAndNormalize: async (raw) => {
    // Let throws propagate. Classification (WEBHOOKS-1 / WEBHOOKS-3 / WEBHOOKS-4):
    // - verify-false InvalidWebhookError / ok:false → invalid_webhook (~400 forgery)
    // - parse-stage InvalidWebhookError (Paymob/Moyasar payload shape;
    //   core always uses HTTP 403) → handler_failed { retryable: true }
    //   (~5xx; not forgery / not permanent 4xx)
    // - RateLimitError / TypeError / NetworkError / unknown Error →
    //   handler_failed { retryable: true } (~5xx; providers redeliver)
    // - Permanent structure GatewayApiError → handler_failed { retryable: false }
    // Prefer ok:false for signature forgery; do not catch-and-map infra to ok:false.
    const event = await client.handleWebhook(
      "stripe",
      raw.body,
      raw.headers["stripe-signature"],
    );
    return {
      ok: true,
      gateway: "stripe",
      providerEventId: event.id,
      // Prefer gateway payloadHash; hash parsed shape only as fallback
      payloadHash: resolveInboxPayloadHash({
        eventPayloadHash: event.payloadHash,
        payloadForHash: event.rawPayload ?? event.event ?? event,
      }),
      event,
    };
  },
  // Fulfill only here — after atomic claim/lease (or in processRetryable).
  handler: async (ctx) => {
    await fulfill(ctx.event);
  },
});
```

### Payload hash conflict recovery (WEBHOOKS-3)

Same key + different `payloadHash` on an **idle** non-terminal row (pending /
expired lease) **supersedes** the stored hash and reclaims so paid redrive is
not permanently stuck after a hash-source mistake (e.g. raw body string vs
parsed object). Active leases still return `payload_conflict`.

Terminal rows (`completed` / `dead_letter`) stay terminal (WEBHOOKS-4).

**Ops recovery** when a row is terminal-wrong or an adapter has not implemented
idle supersede yet:

1. Prefer one canonical hash via `resolveInboxPayloadHash` going forward.
2. Delete the stuck inbox row for `gateway:providerEventId` in your store
   adapter (or `deleteExpired` after the row is `dead_letter` / `completed`
   and aged), then allow provider redelivery / redrive.
3. Do **not** silent-ACK `payload_conflict` as HTTP 200 without a recovery plan.

## Processing modes (explicit)

| Mode | Behavior |
| --- | --- |
| `inline` | Await handler under lease. Failure → `handler_failed { retryable }` (`fail` uses `retryAfterMs: 0`). **Never** emits `scheduled_for_retry`. |
| `durable_retry` | Await handler by default; retryable failure → `store.fail` + `scheduled_for_retry`. |
| `durable_retry` + `ackAfterClaim: true` | After durable claim, release to pending and return `scheduled_for_retry` **without** running the handler (parking claim free vs `maxAttempts`). **Requires `workerGuaranteed: true`** (I6) — without it the engine refuses parked (no 200 ACK with no worker). Workers call `processRetryable`. |

Mode is fixed at `createWebhookInboxEngine` construction. Process methods never switch modes implicitly.
`processRetryable` is valid **only** on `durable_retry` engines (throws on `inline`).
To process one known row (a queue pointer names its key) use `processOne({ key, handler })`: same lease, attempts and backoff, no other row is touched; see [docs/inbox-engine.md](docs/inbox-engine.md).
`ackAfterClaim` is valid **only** with `durable_retry` (constructor throws otherwise).
`ackAfterClaim` also requires `workerGuaranteed: true` (constructor throws if omitted on the engine; per-call park without it is retryable `handler_failed`, never parked).
`defaultLeaseMs` / per-call `leaseMs` must be finite and **`> 0`** (constructor / call throws otherwise; default remains 30s).
`processRetryable` **claims one row at a time** (NEW-WEBHOOKS-1): the next
lease is acquired only after the previous handler returns. Do not assume
`limit=10` + `leaseMs=30s` covers N serial handlers if claims were taken
up front — they are not.
Worker claims pass the listed `payloadHash` with `ifMatchPayloadHash` so a
newer idle body cannot be rolled back to the list snapshot (S19 / I14).

**Default `processRetryable` materialization:** if `payloadRef` is a
`PersistedPaymentEventEnvelope` (`schemaVersion` + `event` + `payloadHash`),
the engine unwraps `.event` so handlers receive the PaymentEvent. Plain events
and custom shapes pass through; override `resolveEvent` when needed.
**Missing `payloadRef` never stubs** `{ key, payloadHash }` — the poll
returns `handler_failed { retryable: true }` and leaves the row pending
(WEBHOOKS-4; does **not** dead-letter paid work). Provide `resolveEvent` or
let provider redelivery supply a snapshot.

**Silent acknowledgment of failed work is forbidden.** Always inspect `WebhookProcessingOutcome`.

## Outcomes (no HTTP hardcoding)

```ts
type ScheduledForRetryReason = "parked" | "handler_retry" | "not_available";

type WebhookProcessingOutcome =
  | { outcome: "processed" }
  | { outcome: "duplicate_completed" }
  | { outcome: "already_processing"; retryAfterMs?: number }
  | {
      outcome: "scheduled_for_retry";
      reason: ScheduledForRetryReason;
      /** When the row becomes claimable again (ISO), when known (WEBHOOKS-5). */
      availableAt?: string;
      /** ms until `availableAt` from engine clock, when computable. */
      retryAfterMs?: number;
    }
  | { outcome: "handler_failed"; retryable: boolean }
  | { outcome: "payload_conflict" }
  | { outcome: "invalid_webhook"; reason?: string };
```

Policy notes:

- Store claim `duplicate_failed` → `handler_failed { retryable: false }` (terminal `dead_letter`; custom stores may still use status `failed`).
- Store claim `not_available` (backoff before `availableAt`) → durable `scheduled_for_retry { reason: "not_available", availableAt?, retryAfterMs? }` without burning attempts. **Inline maps `not_available` to `handler_failed { retryable: true }`** (never `scheduled_for_retry`). Adapters should prefer **5xx** (provider redelivery) unless a durable scheduler owns the row — **never silent-ACK 200** when no worker will process.
- `scheduled_for_retry { reason: "parked" }` is emitted **only** after `store.fail({ restoreAttempt: true })` succeeds. Park `lease_lost` → `already_processing` or `handler_failed { retryable: true }` (the row stays claimed — do **not** HTTP 200 that park). Safe to 200 **only** when a `processRetryable` worker is guaranteed.
- Handler success but `complete` loses lease → `handler_failed { retryable: true }` (do **not** report `processed`).
- **WH-LIST-FAIL:** handler throw after lease expiry, when a concurrent `listRetryable` already soft-released the token, is `lease_lost` on `fail()`. Engine still returns `handler_failed { retryable: true }` (best-effort re-record) and **never `complete`s** — at-least-once; handlers must be idempotent.
- **Handlers must be idempotent** — reclaim after crash re-runs work under a new lease. Soft-release of an expired claim **restores** the unfinished attempt so crash/deploy reclaim does not burn `maxAttempts`.
- Durable redrive never materializes stub events: missing `payloadRef` → retryable `handler_failed` (row stays pending; WEBHOOKS-4).
- Terminal claim outcomes (`already_completed` / `duplicate_failed`) take precedence over `payload_hash_conflict` so completed rows redelivered with a mismatched hash still ACK as done (WEBHOOKS-1).

## Event key

```ts
import { deriveWebhookEventKey } from "@paykernel/webhooks";

deriveWebhookEventKey("stripe", "evt_123"); // "stripe:evt_123"
deriveWebhookEventKey("paymob", "123456789", "TRANSACTION_RESPONSE");
// "paymob:TRANSACTION_RESPONSE:123456789"
deriveWebhookEventKey("paymob", "123456789", "TRANSACTION");
// "paymob:TRANSACTION:123456789"
deriveWebhookEventKey("paymob", "123456789", "TRANSACTION", "paid");
// "paymob:TRANSACTION:123456789:paid"
```

Empty gateway or providerEventId throws / yields `invalid_webhook`.

**Paymob (WEBHOOKS-1 / NEW-WEBHOOKS-2):** `WebhookEvent.id` is the
transaction id on both redirect `TRANSACTION_RESPONSE` (`payment.processing`)
and processed `TRANSACTION`. `processVerified` includes the notification
class in the key when `event` / `envelope` carries `provider.eventType` or a
known native class (`TRANSACTION` / `TRANSACTION_RESPONSE`) — not remapped
domain types such as `payment.succeeded` (NEW-WH-1). Do **not** inbox-dedupe
Paymob on raw `event.id` and no-op the redirect — that combo ACK-suppresses
later paid. Redirect stays `paymob:TRANSACTION_RESPONSE:{txnId}`. Processed
`TRANSACTION` includes domain status when available
(`paymob:TRANSACTION:{id}:{status}`) so a later same-id void/refund snapshot
is not `already_completed`. Recommended `event: webhookEvent.event`
(PaymentEvent) has no top-level `status` — the engine reads `payment.status`,
`refund.status`, legacy `status`, and those paths on nested envelope
`event` (NEW-WH-KEY-1). Redirect still ignores status. Child
refund/capture callbacks may still have **new** `obj.id`s. Do **not**
complete fulfillment on Paymob
`payment.processing` — wait for processed `TRANSACTION` + a settlement
stable type.

## Store contract

`WebhookInboxStore` is **owned by this package** (roadmap domain ownership). Phase 9 testkit types remain structurally compatible for `createMemoryWebhookInboxStore` and conformance suites.

Atomic claim only — never get-then-set in the engine. Lease tokens fence complete/fail/renew; renew rotates token + generation.

### 10.2 field mapping (lean record)

| Roadmap concept | Lean field |
| --- | --- |
| event key | `key` |
| gateway + provider event id | encoded in `key` (`gateway:id`) |
| provider type / schema version / envelope | optional JSON in `payloadRef` |
| payload hash | `payloadHash` |
| state / attempts | `status` / `attempts` |
| lease owner, token, expiry | `leaseOwner`, `leaseToken`, `leaseExpiresAt` |
| first / last received | `createdAt` / `updatedAt` |
| next attempt / claim gate | `availableAt` |
| completion time | `updatedAt` when `status === "completed"` |
| sanitized error | `lastError` |

**Status honesty:** the public `WebhookInboxStatus` union still includes `failed` for 0.x/custom-store compatibility, but the engine and official adapters only write `pending` | `claimed` | `completed` | `dead_letter` (fail → `pending` or `dead_letter`).

**Do not** persist raw signatures, authorization headers, secret tokens, or unredacted provider payloads.

**Envelope honesty:** object/array envelopes (and JSON-string envelopes that parse as object/array) are deep-redacted via core `redactWebhookPayloadSecrets` before `JSON.stringify` into `payloadRef`. Opaque non-JSON string envelopes have known secret/signature patterns redacted (`redactOpaquePayloadRefString`, WEBHOOKS-6) before store; plain opaque refs without secret shapes pass through. Redaction is defense-in-depth — still prefer core `toPersistedPaymentEventEnvelope` (or strip secrets yourself) so raw signatures never enter. On `durable_retry`, if `envelope` is omitted the engine snapshots a redacted `event` into `payloadRef` for redrive. **Inline** also snapshots `event` / `envelope` when materializable (WEBHOOKS-4) so a later durable worker can redrive. Values that still carry `rawPayload` or `headers` are converted via `toPersistedPaymentEventEnvelope` when a PaymentEvent is present; otherwise durable_retry refuses the claim as retryable `handler_failed` (WEBHOOKS-2 — **not** `invalid_webhook` / 400) — raw request-local payloads are never persisted (P610-SNAP-1).

Durable adapters must pass testkit `runWebhookInboxStoreConformanceSuite`.

## Lease renewal

```ts
await ctx.renew(30_000); // rotates leaseToken for subsequent complete
// or
const r = await engine.renewLease(key, token, 30_000);
```

Stale token → renew fails (`lease_lost`); complete/fail with old token throw `StoreLeaseLostError`.

## Documentation

| Doc | Contents |
| --- | --- |
| **[docs/webhook-inbox.md](./docs/webhook-inbox.md)** | Full guide: pipeline 1–10, modes, outcomes, store, boundaries |
| **[docs/crash-boundaries.md](./docs/crash-boundaries.md)** | Phase 10.6 crash matrix (store / handler / provider / outcome) |
| [docs/inbox-engine.md](./docs/inbox-engine.md) | Short pipeline cheat sheet |
| [core webhooks.md](../core/docs/webhooks.md) | Verify + normalize (`handleWebhook`) |
| [testkit store-contracts.md](../store-contracts/docs/contracts.md) | Lease-aware store semantics + conformance |

## Engineering rules

1. Atomic claim via `store.claim` only.
2. Never convert uncertain outcomes into failure masquerading as success (lease_lost after success → retryable `handler_failed`, not `processed`).
3. Sanitize all `lastError` values (default strips `sk_live_`, `whsec_`, Bearer, etc.).
4. No framework coupling; no Node-only assumptions.
5. Core must not depend on this package; this package must not depend on testkit/adapters.

## License

MIT
