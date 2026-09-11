# Coverage policy (Phase 0 baseline)

This document freezes **what we measure** and **what we require** for test
coverage of `@paykernel/core`. It does **not** change runtime payment
behavior.

## How to run

From the monorepo root:

```bash
# Local / CI: apply thresholds from monorepo root bunfig.toml
bun run test:coverage
# Runs the core suite with LCOV and enforces the aggregate thresholds.

# Optional LCOV artifact (does not change thresholds)
bun test --coverage --coverage-reporter=lcov packages/core
```

Coverage is **not** always-on. Running plain `bun test packages/core` (or
`bun run test`) stays fast for local development. `bun run test:coverage` reads thresholds from monorepo root `bunfig.toml`
and checks aggregate covered/total LCOV counts. It preserves test failures and
rejects missing or invalid coverage reports. Direct `bun test --coverage` uses
Bun’s per-file enforcement and is not equivalent to the aggregate CI gate.

## Global thresholds

Configured in monorepo root [`bunfig.toml`](../../../../bunfig.toml):

| Metric     | Threshold | Notes |
|------------|-----------|--------|
| **lines**  | **0.90**  | Fail the run if aggregate line coverage falls below 90% |
| **functions** | **0.85** | Fail the run if aggregate function coverage falls below 85% |

Settings:

- `coverageSkipTestFiles = true` — test files are excluded from the coverage
  denominator so the report reflects production sources under `src/`.
- `coverageReporter = ["text"]` by default — CI may add `lcov` via CLI flags.

### Baseline vs floor

Ad-hoc measurement at Phase 0 freeze (with existing unit suite) was
approximately:

- **~95–96% lines**
- **~94–95% functions**

The committed thresholds sit **below** that baseline with headroom so:

1. Real deletions of tests or accidental untested payment paths fail the gate.
2. Minor Bun coverage flakiness / report noise does not block green builds.
3. We never chase blind 100% line coverage that pushes refactors or deletion of
   defensive branches.

**Do not lower** thresholds below `lines = 0.88` / `functions = 0.80` without an
explicit documented exception in this file. Prefer adding meaningful tests over
weakening the gate.

### Exception log

_None at freeze._ Thresholds remain `lines = 0.90`, `functions = 0.85` as
verified against the current suite.

## Required focus areas

Coverage work (and review of new code) must prioritize **meaningful** branch
and failure-path coverage in the areas below. These are the payment-critical
surfaces; global percentage is a safety net, not a substitute for domain focus.

### 1. Client orchestration

File: `src/client.ts`

- Routing of `create` / `capture` / `refund` / `void` / `get` / webhook APIs
  to the selected or default gateway
- `GatewayNotConfiguredError` / `InvalidRequestError` / `OperationNotSupportedError`
- Webhook path: received → verify → verified/failed hooks; fail-closed on bad
  signatures; isolation of hook errors so primary verification errors surface

### 2. Hook execution and isolation

Files: `src/hooks/hooks.manager.ts`, gateway `executeWithHooks` paths

- **Before** hooks: `proceed: false` aborts cleanly (no provider call);
  param modifications apply; composed before-handlers short-circuit on abort
- **After** hooks: `proceed: false` is **ignored** (warn); throws are
  **isolated** (error-logged); later after-handlers still run; success returns
- **Money / identity field restore** on after-hook `modifiedResult` (and
  in-place mutation of the shallow clone)
- **onError**: runs for executor/API failures only — not for intentional
  before-aborts or after-hook noise; composed onError handlers both run and
  first throw is rethrown after both complete
- Webhook hooks: `onWebhookReceived` (untrusted payload), fail-fast
  `onWebhookVerified`, `onWebhookFailed` isolation with primary error kept

### 3. Retry and idempotency utilities

Files: `src/utils/retry.ts`, `src/utils/idempotency.ts`

- Retryable vs non-retryable errors, max attempts, backoff boundaries
- In-memory store get/set/fingerprint behavior and multi-call safety caveats
  (process-local stores are documented as non-distributed)

### 4. Currency conversion

File: `src/utils/currency.ts`

- ISO 4217 exponents: 0-decimal (e.g. JPY), 2-decimal, 3-decimal currencies
- Fallback behavior for unknown / edge currencies used by gateways

### 5. Error mapping per gateway

Files: `src/gateways/*/*.gateway.ts` (+ shared base)

- Provider HTTP / API errors map to SDK error types without leaking secrets
- Auth failures, card declines, rate limits, not-found, validation — as each
  gateway implements them

### 6. Webhook verification and normalization

- Signature verification **fail-closed** (missing/empty secrets, bad signatures)
- Raw body requirements (Stripe, PayPal) respected in tests/fixtures
- Normalized `WebhookEvent` fields for status transitions consumers rely on

### 7. Every built-in gateway

- **moyasar**, **paypal**, **paymob**, **stripe**
- Core ops: create / capture / refund / void (where supported) / get / webhooks
- Idempotency keys or store usage as documented per provider
- Capture / void / refund **ID shape** requirements (e.g. Stripe `pi_`, PayPal
  capture id, Paymob transaction id, Moyasar UUID)

### 8. Security-sensitive branches

- Signature verify fail-closed paths
- Empty or missing webhook secrets
- Redaction of secrets/PII in logs (`src/utils` redact helpers)
- No secret material in fixtures, test logs, or committed coverage artifacts

## Quality bar (not 100% lines)

We require **meaningful branch coverage** for:

- Payment **state transitions** (authorized → captured, refunded, voided, etc.)
- **Failure paths** that affect money, idempotency, or security
- Hook isolation contracts that prevent analytics failures from becoming
  retryable payment failures

We **do not** require:

- 100% line or function coverage
- Tests that only exercise dead code or pure type overloads without behavior
- Refactors whose sole purpose is to raise a percentage

Intentional soft spots (simple accessors, rare defensive fallbacks) may remain
below per-file 100% as long as global thresholds hold and the focus areas above
stay covered by explicit tests.

## Ownership / Phase 0 note

- Thresholds and this policy are Stream B (coverage boundaries).
- Changing thresholds or focus areas should be intentional baseline updates,
  not silent drift.
- Do not change payment business logic solely to improve coverage numbers.
