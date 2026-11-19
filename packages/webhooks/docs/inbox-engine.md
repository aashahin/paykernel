# Webhook Inbox Engine (cheat sheet)

Package: `@paykernel/webhooks` (Phase 10).

Full guide: **[webhook-inbox.md](./webhook-inbox.md)** · Crash matrix: **[crash-boundaries.md](./crash-boundaries.md)**

## Pipeline (10.1)

1. Validate inputs (`gateway`, `providerEventId`, `payloadHash`).
2. Derive key: `deriveWebhookEventKey(gateway, providerEventId, notificationClass?, status?)` → `gateway:providerEventId` (Paymob: `paymob:{TRANSACTION|TRANSACTION_RESPONSE}:{txnId}` when class is present — WEBHOOKS-1). Redirect stays `TRANSACTION_RESPONSE:{txnId}`. Processed `TRANSACTION` includes domain status when available (`paymob:TRANSACTION:{txnId}:{status}`) so a later same-id void/refund snapshot is not `already_completed` (NEW-WEBHOOKS-2). Domain status is `status`, `payment.status`, `refund.status`, or those paths on nested `event` — PaymentEvent has no top-level `status` (NEW-WH-KEY-1). Notification class is `provider.eventType` or known native HMAC classes only — not remapped `payment.succeeded` (NEW-WH-1). Do not complete on Paymob `payment.processing`.
3. Atomic `store.claim` (never get-then-set in the engine).
4. Map claim kinds to outcomes (no handler on non-`acquired`).
5. Mode branch (`inline` / `durable_retry` / `ackAfterClaim`).
6. Run application handler under lease (`ctx.renew` available).
7. Success → `store.complete` → `{ outcome: "processed" }`.
8. Handler throw → sanitize error → `store.fail` → mode-specific outcome.
9. `complete` throws lease_lost after handler success → `{ outcome: "handler_failed", retryable: true }` (not `processed`).

Verification/normalization is **injected** (`processWithVerifier` or `PaymentClient.handleWebhook` then `processVerified`); the engine does not hardcode PSP signature checks.

**WEBHOOKS-2:** claim/lease **before** money side effects. Use verify-only
`handleWebhook` / `verifyAndNormalize`; fulfill in `handler` or
`processRetryable` after claim — never inside verify when using the inbox.

**WEBHOOKS-1 / WEBHOOKS-5 / WEBHOOKS-403:** verify throws → fail-open `handler_failed { retryable: true }`
except verify-false `InvalidWebhookError` / `{ ok: false }` (forgery) and permanent
structure errors. Post-verify parse / `InvalidRequestError` / parse-stage
`InvalidWebhookError` (Paymob/Moyasar payload shape; always HTTP 403) is **retryable**
(not `invalid_webhook` and not permanent 4xx). Idle hash mismatch **supersedes**
(WEBHOOKS-3/4 — not permanent `payload_conflict`); active lease conflict stays
`payload_conflict`.

**WH-LIST-FAIL:** if the handler runs past lease expiry and a concurrent
`listRetryable` already soft-released the token, `fail()` is `lease_lost`.
Engine returns `handler_failed { retryable: true }` (at-least-once) and never
`complete`s that attempt.

## Modes (10.3)

| Mode | Fixed at construction | On handler failure |
| --- | --- | --- |
| `inline` | yes | `handler_failed { retryable }` |
| `durable_retry` | yes | `scheduled_for_retry { reason: "handler_retry" }` if retryable; else `handler_failed` |
| `durable_retry` + `ackAfterClaim` | yes | N/A — parks with `scheduled_for_retry { reason: "parked" }` only when `workerGuaranteed: true`; requires `envelope`; worker via `processRetryable` |

Modes are never mixed implicitly inside `process*`. `processRetryable` throws on `inline` engines. `processRetryable` claims one-at-a-time so later leases cannot expire during earlier handler I/O (NEW-WEBHOOKS-1). Worker `claim` uses the listed hash with `ifMatchPayloadHash` so idle WEBHOOKS-3 supersede cannot roll a newer body backwards (S19-WH-HASH-TOCTOU). Best-effort fail-after-`lease_lost` reclaim uses the same CAS (S20-WH-FAIL-RECLAIM). Heartbeat `stopHeartbeat` closes renew so a queued tick cannot rotate the token used by `complete` (S20-HEARTBEAT-RACE).

### Processing one receipt by key (`processOne`)

`processOne({ key, handler, owner?, leaseMs?, resolveEvent? })` is the by-key counterpart of one `processRetryable` row (durable_retry only; it throws on `inline`). It reads the row with `store.get(key)`, then claims it through the store's normal compare-and-set `claim` (`ifMatchPayloadHash`), so the lease (30 s default), attempts, `availableAt` backoff, terminal classification and fencing are exactly those of a poll. It adds no store method, so it works on every adapter. A completed, dead-lettered, leased or not-yet-due row is reported as its usual outcome and the handler does not run; an unknown key returns `{ found: false }`. Use it when a queue pointer or webhook delivery names the receipt: it cannot be starved by older stuck rows, and it touches no other key. Keep a scheduled `processRetryable` as the backstop for crashed holders and rows whose pointer was lost. Callers that must also run on 0.1.1 feature-test `typeof engine.processOne === "function"`.

## Outcomes (10.4)

Outcomes are framework-agnostic. **Silent ACK of failed work is forbidden.** Map outcomes to HTTP only in your adapter — and **always read `scheduled_for_retry.reason`**:

| `reason` | Meaning | Safe 200? |
| --- | --- | --- |
| `parked` | `ackAfterClaim` released for worker | Only if `processRetryable` worker is guaranteed |
| `handler_retry` | Handler threw; fail recorded with backoff | Yes with durable worker; else 5xx |
| `not_available` | Claim backoff; no handler ran | Prefer **5xx** (provider redelivery) |

Store claim `duplicate_failed` → `handler_failed { retryable: false }`.
Store claim `not_available` (pending, `availableAt` in future) → durable `scheduled_for_retry { reason: "not_available", availableAt?, retryAfterMs? }` (no attempt burn; WEBHOOKS-5 timing). **Inline maps `not_available` to `handler_failed { retryable: true }`** (never `scheduled_for_retry`).

## Lean record vs 10.2 fields

See [webhook-inbox.md §5](./webhook-inbox.md#5-inbox-record-fields-and-what-must-not-be-stored). Phase 9 lean row stores gateway/event-id in `key`, envelope snapshot in optional `payloadRef`, timestamps via `createdAt` / `updatedAt` / `availableAt`. Do not store raw signatures, auth headers, secrets, or unredacted payloads. Object/JSON-string envelopes are force-redacted via core `redactWebhookPayloadSecrets` before `JSON.stringify` into `payloadRef`; opaque non-JSON strings redact known secret patterns (`redactOpaquePayloadRefString`); `durable_retry` also snapshots redacted `event` when envelope is omitted. Missing `payloadRef` on redrive is retryable `handler_failed` (no stub events, no dead-letter of paid rows — WEBHOOKS-4). Inline also snapshots `event` into `payloadRef` when materializable. Missing / unrefusable durable snapshots are `handler_failed { retryable: true }`, not `invalid_webhook` (WEBHOOKS-2). Still prefer `toPersistedPaymentEventEnvelope` so raw never enters.

## Crash boundaries (10.6)

See **[crash-boundaries.md](./crash-boundaries.md)** for store state, handler status, provider retry, and outcomes per boundary.

| Boundary | Engine / store effect |
| --- | --- |
| Before claim | No mutation; safe redelivery |
| After claim, before handler | Lease held; reclaim after expiry |
| During handler | Lease held; reclaim re-runs handler — **handler must be idempotent** |
| After external side effect, before complete | Stale complete rejected; outcome is not `processed` |
| After complete | Terminal; redelivery → `duplicate_completed` |

## Lease renewal (10.5)

`ctx.renew(leaseMs?)` and `engine.renewLease(key, token, leaseMs?)` call `store.renew`, which **rotates** `leaseToken` and increments `generation`. Stale tokens fail.

## Dependencies

- Depends on: `@paykernel/core` only.
- Must not depend on: testkit, adapter-\*, Redis, Express/Hono.
- Durable adapters must pass testkit `runWebhookInboxStoreConformanceSuite`.
