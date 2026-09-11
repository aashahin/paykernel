# @paykernel/testkit

## 1.0.2

### Patch Changes

- 0cf6baa: Fix mock gateway accounting for successful payments, authorization holds, and zero balances. Preserve the original currency in refund totals and align partial-capture conformance with the current operation outcome contract.

## 1.0.1

### Patch Changes

- fix: replace workspace:* with registry versions for consumer install

  All 18 packages with runtime workspace:* dependencies were published as 0.1.0/1.0.0 with unresolvable workspace:* specifiers, breaking `npm install` for consumers (Unsupported URL Type "workspace:"). Patch to 0.1.1/1.0.1 with concrete registry versions (^1.0.0, ^0.1.0 etc) via changesets internal dependency update. No API changes.

- Updated dependencies
  - @paykernel/reconciliation@0.1.1
  - @paykernel/webhooks@0.1.1

## 1.0.0

### Major Changes

- 6f78c47: 1.0 contract cut (constructor, Money, outcomes, statuses, provider params, reserve required). Removes 0.x shims: `new PaymentClient({ moyasar, ... })` → `createPaymentClient({ gateways: { moyasar: moyasarGateway(...) } })`; `AmountInput = Money` only (`money("10.50", "SAR")`), `GatewayPaymentResult` amount fields `Money | undefined`; `outcome` required, `success` removed; `PaymentStatus` → `PaymentDomainStatus`, `WebhookEvent.status` → `WebhookEnvelopeStatus`; provider fields moved off `CreatePaymentParams` onto per-gateway `*CreatePaymentParams`; `IdempotencyStore.reserve` and `PaymobIdempotencyStore.reserve` required; `expectedAmountMinor` and `ScriptedStep` removed from `@paykernel/testkit`. Compat CI (`check:compat`) + baselines (`public-api.inventory.json`, `schema.inventory.json`) added; `bun-hono-postgres` RC with real Postgres via `store-postgres/pg`.

### Minor Changes

- df66280: Initial PayKernel package family under the `@paykernel` npm scope.

### Patch Changes

- Updated dependencies [df66280]
- Updated dependencies [94547b7]
- Updated dependencies [6f78c47]
- Updated dependencies [9de3699]
  - @paykernel/core@1.0.0
  - @paykernel/webhooks@0.1.0
  - @paykernel/reconciliation@0.1.0

## Unreleased

### Patch Changes

- **S19-WH-HASH-TOCTOU:** memory webhook inbox and `runWebhookInboxStoreConformanceSuite` honor `ifMatchPayloadHash` — idle miss is `payload_hash_conflict` with no rewrite. Durable adapters must pass the new case.
- **WEBHOOKS-1:** Soft-release of expired `claimed` restores one attempt (floor 0); direct reclaim of expired claimed keeps `attempts` unchanged so crash/deploy reclaim does not burn handler `maxAttempts`.
- **N2 (webhook inbox conformance):** `runWebhookInboxStoreConformanceSuite` now asserts claim `not_available` / `availableAt` gate (no attempt++) and `fail({ restoreAttempt: true })` attempt restore (parking claim parity). Adapters that already implement correctly keep passing.
- **Paid-like parity:** `paymentStatusToOperationOutcome("approved")` returns `requires_action` (not `succeeded`), matching core `inferOperationOutcome` / PayPal pre-capture semantics. `isPaidOutcome` remains false for approved.
- **N5 / deleteExpired parity:** memory idempotency `deleteExpired` only removes terminal `completed`/`expired` rows (SQL/Redis parity). Reclaimable `reserved` rows with past `leaseExpiresAt` are no longer wiped by cleanup; soft-release/reclaim remains separate.
- **N4 docs:** store-contracts markdown documents intentional `markIndeterminate` near-expiry parking vs post-reclaim fencing, and terminal-only `deleteExpired`.
- Reconciliation conformance: `listDue` rediscovers abandoned expired claims (poll recovery).

- **Recon listDue recovery (R5/R6):** `runReconciliationStoreConformanceSuite` now requires that after claim-abandon and lease expiry, `listDue` soft-releases/re-indexes the job (poll-path rediscovery). Memory store regression test locks soft-release inside `listDue`. Key-addressed reclaim alone is no longer sufficient for the suite.

## 0.1.0-next.0

### Patch Changes

- Re-export lease-aware store contracts and adapter manifests from `@paykernel/store-contracts` (production adapters no longer hard-depend on full testkit at runtime).

### Major Changes

- Initial PayKernel prerelease under the `@paykernel` npm scope.
