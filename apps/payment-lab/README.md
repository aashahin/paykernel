# PayKernel Lab

Payment lab for seven buyer gateways. Buyer checkout, seller operations, signed webhooks, reconciliation, and scenario evidence — all against D1.

Worker URL: https://paykernel-lab.abshahin.workers.dev. The dedicated D1 binding and minute cron are configured in `wrangler.jsonc`. The deployed app secrets enable seller authentication and signed simulator callbacks. New deployments need their own `BETTER_AUTH_SECRET` and `SIMULATOR_SECRET`.

Keep `global_fetch_strictly_public` enabled in `wrangler.jsonc`: simulator webhook delivery uses the public Worker URL and must re-enter its HTTP handler.

Stack: vinext App Router on Cloudflare Workers (`vite.config.ts`), Hono RPC under `/api/*`, BetterAuth + D1, Tailwind v4.

## Buyer: simulator vs sandbox

Seven gateways: `stripe`, `paypal`, `paymob`, `moyasar`, `tap`, `myfatoorah`, `hesabe` (`src/server/gateways/types.ts`).

| Gateway | Simulator | Sandbox (real provider test host) |
| --- | --- | --- |
| All seven | Always available. `mode: "simulator"` creates `sim_<gateway>_<attemptId>` in D1, settles only via seller controls + signed simulator webhooks. | Only when `GET /api/gateways` reports `configured: true`. Otherwise checkout forces simulator and sandbox calls fail with missing-secret errors. |
| Stripe | Simulator flow | Elements (PaymentIntent `clientSecret` + `STRIPE_PUBLISHABLE_KEY`) or hosted Checkout (`method: "checkout"`, automatic only, HTTPS redirect). |
| PayPal | Simulator flow | Hosted approval redirect; return is confirmed server-side (`token` must match stored payment). |
| Paymob | Simulator flow | Egypt region (`eg`, EGP). Hosted redirect. Requires `phone` (≥5 chars). One per-attempt callback URL drives both notification and redirection. `PAYMOB_API_KEY` authenticates transaction inquiries and capture/refund/void management; the modern secret key creates intentions. Manual capture needs `PAYMOB_AUTH_INTEGRATION_ID` or `method` override. |
| Moyasar | Simulator flow | Browser token only: the Moyasar token API returns `token_…`, backend never sees PAN. `sourceToken` required, `method` rejected. |
| Tap | Simulator flow | Hosted redirect (`method` defaults to `src_all`). HTTPS callback required. |
| MyFatoorah | Simulator flow | Invoice/redirect (`INVOICE`, `CARD`, `APPLE_PAY`, `GOOGLE_PAY`, `KNET`). No authorization/capture/void surface. HTTPS callback required. |
| Hesabe | Simulator flow | KWD-only hosted checkout. No authorization/capture/void surface. Encrypted `data` callback is decrypted and cross-checked against the stored id. |

Buyer routes: `/` checkout, `/orders/[id]` payment progress, `/setup` read-only readiness, `/seller` seller login + dashboard, `/testing` scenario workspace, `/seller/orders/[id]` full evidence.

Buyer API: `POST /api/orders` (`name`, `email`, `gateway`, `quantity` 1–5), `GET /api/orders/:id` (guest-cookie scoped), `POST /api/orders/:id/pay` (`gateway`, `mode`, `captureIntent`, `idempotencyKey`, optional `sourceToken`/`phone`/`method`).

Currency comes from the gateway default (`stripe/paypal: USD`, `paymob: EGP`, `moyasar: SAR`, `tap/myfatoorah/hesabe: KWD`); the catalog sells the `notebook` item only in those currencies.

## Seller allowlist and provision script

`TESTER_EMAILS` (wrangler `vars`) is the allowlist. `GET /api/seller/ping` returns 401 signed-out, 403 non-allowlisted, 200 seller. Seller APIs require the same session plus `Origin: APP_ORIGIN`.

No public signup (`disableSignUp: true`, password ≥12 chars, DB rate limiting). Provision with:

```bash
# from apps/payment-lab
bun ./scripts/provision-seller.ts --email <address> --local
bun ./scripts/provision-seller.ts --email <address> --remote

# password source: PAYKERNEL_SELLER_PASSWORD env, else stdin (never a CLI arg)
export PAYKERNEL_SELLER_PASSWORD='set-a-new-unique-password'
```

The script hashes with BetterAuth `hashPassword`, writes one short-lived SQL file with escaped literals, runs `wrangler d1 execute paykernel-lab --local|--remote --config wrangler.jsonc --file <tmp>`, then deletes the temp dir. Runtime uses parameterized drizzle queries. Package shortcut: `bun run provision:seller`.

## Env secrets and readiness

For local development, copy `.dev.vars.example` to `.dev.vars` and replace both secret placeholders with independently generated random values. `.dev.vars` is ignored by Git.

Vars: `APP_ORIGIN`, `TESTER_EMAILS`. Secret (`wrangler secret put <NAME> --config wrangler.jsonc`): `BETTER_AUTH_SECRET` (≥32 chars), `SIMULATOR_SECRET`.

Sandbox secrets read by drivers (`src/server/gateways/types.ts` — no other names are read):

```text
STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET
PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID
PAYMOB_API_KEY, PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY, PAYMOB_HMAC_SECRET
PAYMOB_INTEGRATION_ID, PAYMOB_AUTH_INTEGRATION_ID
MOYASAR_SECRET_KEY, MOYASAR_PUBLISHABLE_KEY, MOYASAR_WEBHOOK_SECRET
TAP_SECRET_KEY, TAP_MERCHANT_ID, TAP_WEBHOOK_URL
MYFATOORAH_API_TOKEN, MYFATOORAH_COUNTRY, MYFATOORAH_WEBHOOK_SECRET, MYFATOORAH_WEBHOOK_URL
HESABE_MERCHANT_CODE, HESABE_ACCESS_CODE, HESABE_ENCRYPTION_KEY, HESABE_IV_KEY
HESABE_USERNAME, HESABE_PASSWORD, HESABE_WEBHOOK_URL
```

`GET /api/gateways` returns per gateway: `configured`, `missing[]` (exact secret names), `publicKeys` (presence only), `defaultCurrency`, `paymentMethods`, frozen SDK `capabilities`, `sandbox: true`. Required sets live in `src/server/gateways/index.ts` (for example Stripe needs all three `STRIPE_*`; Tap needs only `TAP_SECRET_KEY`). Live keys are rejected (`sk_live`/`rk_live`/`pk_live`); Moyasar requires `sk_test_`, Stripe requires `sk_test_`, Tap requires `sk_test_`. Sandbox is never mixed with live hosts. Unconfigured sandbox create/webhook returns a missing-secret error or HTTP 503. `/setup` shows the same readiness read-only; there is no credential input form.

## Webhooks vs browser returns

They are different endpoints with different trust:

```text
POST /api/webhooks/:gateway            # real provider sandbox webhooks, signature-verified
POST /api/simulator/webhooks/:gateway  # simulator transport, HMAC with SIMULATOR_SECRET
GET  /api/returns/:id                  # browser return, buyer-scoped, then redirect to /orders/:id
POST /api/returns/:id                  # Paymob sandbox notify/return only (shared per-attempt callback)
POST /api/seller/simulator/:id         # seller simulator controls (simulator attempts only)
POST /api/seller/webhooks/retry        # retry failed webhook inbox rows
```

Details: sandbox webhooks verify with the raw body/headers/query (`stripe-signature`, Paymob `hmac`, Tap/MyFatoorah/Hesabe per-SDK rules), enforce a 64 KB body limit, reject `livemode: true`, and correlate by provider ids before applying evidence. Simulator webhooks require `x-lab-timestamp` + `x-lab-signature` HMAC (`timestamp.body`), 5-minute skew, `SIMULATOR_SECRET` configured. Returns never trust query status: PayPal/Hesabe pending returns run `complete-return` (server lookup/authorize/capture or encrypted-callback enquiry), Paymob GET returns with `hmac` are verified before applying evidence; other returns run `reconcile`, then redirect. Requested webhook URLs are `…/api/webhooks/<gateway>?attempt=<id>` except Paymob, which reuses the per-attempt `…/api/returns/<attemptId>` callback.

## D1 migrations

```bash
# from apps/payment-lab
bun run db:migrate:local
bun run db:migrate:remote
```

Which run `wrangler d1 migrations apply paykernel-lab --local|--remote --config wrangler.jsonc`:

- `migrations/0001_auth.sql`: `user`, `session`, `account`, `verification`, `rate_limit` (BetterAuth + DB rate limiting).
- `migrations/0002_payments.sql`: domain — `lab_orders`, `lab_attempts`, `lab_operations`, `lab_refunds`, `lab_webhooks`, `lab_webhook_rejections`, `lab_test_runs`, `lab_simulator_state`, `lab_audit` with single-blocking-attempt and single-unresolved-operation unique indexes.
- `migrations/0003_sdk_stores.sql`: SDK stores — `payment_idempotency`, `payment_webhook_inbox`, `payment_reconciliation_jobs`, `payment_storage_migrations`.
- `migrations/0004_checkout_details.sql`: `lab_checkout_details` (scoped `clientSecret` and `redirectUrl` per attempt).
- `migrations/0005_operation_baseline.sql`: capture balance at operation reservation, so webhook-first recovery can finish an indeterminate operation.

Drizzle `src/db/schema.ts` covers auth only; domain tables are SQL-first with fail-closed constraints.

## Money: capture, void, refunds, reconciliation

- Capture needs `authorized`/`partially_captured`; void needs `authorized` with zero captured (refund instead after capture); refund needs `paid`/`partially_captured` with remaining balance. Excess, currency mismatch, and resource mismatch are rejected without state change.
- Accepted pending refunds reserve balance without moving `refundedMinor`. Confirmed receipts or verified webhooks settle the refund exactly once. Reconciliation can recover cumulative payment refund evidence and query individual Hesabe/simulator refunds. Missing evidence keeps the operation unresolved. Moyasar operation rows disambiguate its reused payment/refund identifier.
- Stripe, PayPal, and Tap sandbox: a partial capture closes the remaining authorization (PayPal sends `final_capture: true`). The lab blocks a second capture with `The authorization was closed by the first capture.` Plan for one capture per authorization on these adapters.
- Reconciliation: `* * * * *` cron (`wrangler.jsonc` → `worker/index.ts` → `runScheduled`) retries webhooks, schedules up to 20 unsettled attempts (`ambiguous` or `pending`/`processing`/`approved`), and processes due jobs via server lookup. Manual: `POST /api/seller/attempts/:id/reconcile`.
- Fail-closed reservations: one blocking attempt per order, one unresolved operation per attempt, idempotency fingerprint mismatch → conflict, provider errors → `indeterminate` + `ambiguous` + `reconcile required`, gateway completion requires D1 lease ownership (`src/server/sdk-stores.ts`).

## Scenarios and HTTP matrix

`/testing` runs one scenario at a time (`POST /api/seller/scenarios` with `gateway`, `mode`, `scenario`); history is `GET /api/seller/runs`. 24 simulator scenarios: success, decline, cancel, pending, abandonment, authorization, capture, partial-capture, void, refund, partial-refund, pending-refund, excessive-amount, double-submit, concurrent-capture-void, duplicate-webhook, out-of-order, invalid-signature, amount-mismatch, currency-mismatch, missing-webhook, retry, persistence, timeout-after-acceptance.

Verdicts: `running`/`passed`/`failed`/`blocked`/`unsupported`. Sandbox runs always return `blocked` (credential readiness or human checkout required, never a fake pass); capability-gated runs return `unsupported`. Evidence is `evidenceJson` steps plus order/attempt links; seller order pages show operations, refunds, webhook inbox, and audit.

Full simulator matrix over signed HTTP:

```bash
# from apps/payment-lab; seller must already be provisioned
export PAYKERNEL_TEST_PASSWORD_FILE=/tmp/opencode/pw.txt
export PLAYWRIGHT_BASE_URL=http://localhost:5173
# optional:
export PAYKERNEL_TEST_EMAIL=lab-tester@example.com
export PAYKERNEL_TEST_GATEWAYS=stripe,paypal,paymob,moyasar,tap,myfatoorah,hesabe
export PAYKERNEL_TEST_REPORT=validation-results/scenarios.json
export PAYKERNEL_TEST_CRON=1
bun ./scripts/run-scenarios.ts
```

The script logs `gateway/scenario: verdict`, polls `GET /api/seller/runs`, retries webhooks unless `PAYKERNEL_TEST_CRON=1`, writes the JSON report, and exits nonzero on `failed`/`running`.

## Tests and deploy

```bash
# repo root
bun install
bun run --filter @paykernel/payment-lab typecheck
bun run --filter @paykernel/payment-lab dev
bun run --filter @paykernel/payment-lab build
bun run --filter @paykernel/payment-lab deploy
bun run --filter @paykernel/payment-lab test
bun run --filter @paykernel/payment-lab test:e2e
bun run --filter @paykernel/payment-lab db:migrate:local
bun run --filter @paykernel/payment-lab db:migrate:remote

# or inside apps/payment-lab (run each command separately)
bun run typecheck
bun run lint
bun run build
bun run dev
bun run db:migrate:local
bun run provision:seller -- --email <address> --local
bun run test
bun run test:e2e
```

What each does (`package.json`, `playwright.config.ts`, `tests/`): `test` runs `bun test tests/*.test.ts` (Miniflare D1: concurrent simulator money, idempotency ownership, capture-vs-void exclusivity, pending-vs-settled refunds, mismatch rejection, order/attempt concurrency). `test:e2e` runs `playwright test` (`tests/e2e/lab.spec.ts`: guest isolation/seller access plus seven-gateway simulator settle + refund through signed HTTP; needs `PAYKERNEL_TEST_PASSWORD_FILE`, optional `PAYKERNEL_TEST_EMAIL`/`PLAYWRIGHT_BASE_URL`). `deploy` runs `vite build && wrangler deploy` to `paykernel-lab` with `dist/client` assets.

## Honest evidence and limits

- Simulator exercises lab plumbing (durable attempts/operations, signed webhook inbox, idempotency, reconciliation), not bank money. Simulator payloads are transport snapshots; financial truth is the versioned D1 evidence plus a fresh provider lookup.
- Tampered signatures (401), stale out-of-order replays, and amount/currency mismatches (4xx) are rejected without financial change; duplicate webhooks do not bump versions.
- Real sandbox coverage is blocked until credentials are configured, so `GET /api/gateways` reports missing secrets, sandbox checkout stays disabled, scenario sandbox runs return `blocked`, and sandbox webhooks return 503. Real-provider scenarios have not been executed.
- To unblock real tests: set the exact secret names above via `wrangler secret put`, redeploy, confirm `/setup` shows `ready`, then use sandbox mode with provider test cards/accounts and complete the real browser handoff.
