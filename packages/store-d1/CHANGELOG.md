# @paykernel/store-d1

## 0.1.2

### Patch Changes

- 2c6f377: Accept Cloudflare's native D1 database binding in store factories by correcting the structural batch return type. Consumers can pass env.DB without casting the binding.

## 0.1.1

### Patch Changes

- fix: replace workspace:* with registry versions for consumer install

  All 18 packages with runtime workspace:* dependencies were published as 0.1.0/1.0.0 with unresolvable workspace:* specifiers, breaking `npm install` for consumers (Unsupported URL Type "workspace:"). Patch to 0.1.1/1.0.1 with concrete registry versions (^1.0.0, ^0.1.0 etc) via changesets internal dependency update. No API changes.

## 0.1.0

### Minor Changes

- df66280: Initial PayKernel package family under the `@paykernel` npm scope.

## Unreleased

### Patch

- **S19-WH-HASH-TOCTOU:** webhook `claim` UPSERT honors `ifMatchPayloadHash` (idle miss is `payload_hash_conflict`, no rewrite).
- **P16-TX:** Live `createD1Executor` no longer attaches `transaction()` / `BEGIN IMMEDIATE`. Store `withTransaction` fails closed with `StoreUnsupportedFeatureError`. Mock D1 may prove same-connection SQLite via an internal hook.
- **P16-ALS:** Example and smoke Wrangler configs set `nodejs_compat` (required for `node:async_hooks` ALS).
- **P16-SUCCESS:** `query` / `execute` / `batch` throw when D1 reports `success: false` (failed UPSERT is not a claim miss).
- **P16-SESSION:** `createD1Executor` and `migrateD1Adapter` default to `first-primary` when `withSession` exists; `session: false` opts out.
- **WEBHOOKS-1:** Soft-release of expired `claimed` restores one attempt (floor 0); direct reclaim of expired claimed keeps `attempts` unchanged so crash/deploy reclaim does not burn handler `maxAttempts`.
- Reconciliation `listDue` soft-releases expired claimed rows so abandoned jobs are rediscoverable via poll; `markManualReview` requires active (unexpired) lease (parity with complete/fail).

## 0.1.0-next.0

### Patch

- Webhook claim maps pending+future `available_at` to `not_available`; fail honors `restoreAttempt`.
- Webhook `listRetryable`/`get` soft-release expired claimed rows; claim gates pending on `available_at`.

### Major Changes

- Initial PayKernel prerelease under the `@paykernel` npm scope.
