# Payment lab validation

Verified on 2026-09-10. These results distinguish simulation from real provider tests.

| Check | Result |
| --- | --- |
| App TypeScript, ESLint, production build | Passed |
| Lab tests: D1 concurrency, capture recovery, SDK HTTP fixtures, refund receipts | 31 passed |
| Shared D1 adapter tests and TypeScript | 93 passed |
| Local Chromium buyer/seller flows, guest isolation, seven gateways, mobile layouts | 7 passed |
| Local signed-HTTP simulator matrix: 24 scenarios × 7 gateways | 156 passed, 12 unsupported, 0 failed |
| Public Worker signed-HTTP simulator matrix: 24 scenarios × 7 gateways | 156 passed, 12 unsupported, 0 failed, 0 running |
| Public Worker checkout and D1 health smoke tests | 2 passed |
| Deployed Chromium suite, including seller login, seven-gateway signed callbacks/refunds, and mobile layouts | 7 passed |
| Settled simulator order persists across an actual Worker redeploy | Passed |
| Deployed cron recovers deliberately failed signed webhooks | Passed; runner uses `PAYKERNEL_TEST_CRON=1` without manual retry calls |

The unsupported matrix entries require authorization/capture/void on MyFatoorah or Hesabe, which these adapters do not support. The lost-response scenario accepts a simulator capture, records an indeterminate operation, delivers a signed webhook, and confirms reconciliation releases the operation without counting money twice.

The deployed matrix evidence is saved in `validation-results/scenarios-deployed.json`, separate from Playwright output so browser tests cannot erase it. All seven retry cases passed using the deployed scheduled handler, with no manual retry requests. The previous local report was temporary; the counts above record the completed run. Browser screenshots, failure traces, and reports are under the ignored `test-results/` directory. Rerun commands and configuration are in [README.md](README.md).

## Deployment

- Worker: https://paykernel-lab.abshahin.workers.dev
- Code version used for the 2026-09-10 redeploy persistence check: `80073f57-116a-464b-b836-52e2ff5a6f4a`. Gateway secrets were subsequently deployed on 2026-09-11.
- Dedicated D1: `ae745b2a-9638-4ed5-a096-c2eea3492f74`; migrations 0001–0005 applied.
- Scheduled handler deployed with `* * * * *`.

The user approved uploading `BETTER_AUTH_SECRET` and `SIMULATOR_SECRET`; both are installed. Seller sign-in and signed payment/refund callbacks pass on the public Worker. `global_fetch_strictly_public` routes simulator callbacks back through its public HTTP handler. Persistence evidence is in `validation-results/redeploy-persistence.json`: a paid attempt retained its provider ID and captured amount across the redeploy.

## Sandbox credential checks — 2026-09-11

The supplied credentials are saved in ignored, owner-readable `.env` and `.dev.vars` files. Local configuration checks find every required setting for Stripe, PayPal, Paymob, Moyasar, MyFatoorah, and Hesabe. Tap remains unconfigured. Configuration presence does not establish credential validity.

- Stripe: supplied test key authenticated through Stripe CLI. A dedicated test webhook was registered in the matching account, and its signing secret was saved locally.
- PayPal: sandbox authentication passed; the supplied webhook ID resolves to this lab's PayPal webhook URL.
- Paymob: the supplied API key authenticates transaction inquiries. A user-completed sandbox checkout confirmed that the modern secret key and integration ID create a payable intention. The card checkout flow supplies per-payment notification and redirect URLs. See the settlement recovery below.
- Moyasar: authenticated payment listing passed with an explicit HTTP user agent.
- Hesabe: the supplied settings match the official published sandbox credentials; checkout has not been exercised.
- MyFatoorah: after the user confirmed all permissions, the exact saved token was rechecked with Bearer authentication and an explicit HTTP user agent. Payment-method discovery (`/v2/InitiatePayment`) returned HTTP 401, `The token is not valid or expired!`, from both the sandbox and Kuwait production API hosts. These checks created no payments. Evidence is saved in `validation-results/myfatoorah-auth.json`. The [official API-key documentation](https://docs.myfatoorah.com/docs/api-key) gives a different error for missing permissions and identifies active status, expiry, and the creating user's enabled status as token-validity requirements. The supplied value remains unchanged.

After explicit user approval, all 23 gateway settings were uploaded to the public Worker on 2026-09-11. Paymob's supplied API key was subsequently added for transaction inquiries. The deployed `/api/gateways` endpoint confirms the settings are present for all six configured gateways; Tap alone remains unconfigured. `/api/health` returned HTTP 200 with `ok: true` and `db: true`. MyFatoorah's rejected token still needs replacement despite passing the configuration-presence check. Paymob sale and refund settlement are verified below. Other provider checkout and callback flows, and a full sandbox scenario matrix, remain unverified.

## Paymob settlement recovery — 2026-09-11

Paymob transaction `532812832` succeeded for EGP 10.00, but both signed callbacks were stored as unmatched. The lab had saved an intention ID in its transaction slot and omitted Paymob's order ID. Its subsequent transaction inquiry also used the modern secret key, which the provider rejected with HTTP 401.

The fix retains the provider order ID, uses API-key/Bearer authentication for inquiries, and correlates missing references through authenticated transaction data. It does not trust the unsigned `merchant_order_id` in webhook payloads. Standalone-sale inquiry evidence uses the fully paid order amount when Paymob reports zero for the separate capture field. Reconciliation can recover older intention-only attempts and release unresolved create operations.

Deployed version: `f35cc4e2-1d42-46eb-b749-9e9778a875e0`. The order recovered to `paid` with `capturedMinor: 1000`, currency `EGP`, and matching transaction/order IDs. Repeating reconciliation left its version and amount unchanged. Evidence: `validation-results/paymob-settlement-recovery.json`. Five focused D1 regression tests cover recovery, duplicate settlement, unresolved-create recovery, cross-attempt/amount rejection, and signed callbacks with tampered unsigned references. All 36 lab tests, TypeScript, ESLint, and the production build passed.


## Paymob refund and reconciliation recovery — 2026-09-11

Transaction `532815436` was paid for EGP 30.00. Its refund stopped at the SDK transaction-inquiry preflight: modern Token authentication returned HTTP 401. The app held the failed read as an indeterminate money operation, leaving Reconcile unable to release it. An authenticated Bearer inquiry confirmed zero refunded before recovery.

Management now uses the API-key authentication path, and an explicit read-only refund preflight distinguishes an unsent request from an uncertain POST outcome. Reconciliation can recover completed SDK receipts after a missed app-ledger write. Standalone-sale capture evidence remains valid after full or partial refunds. An unresolved reconciliation now explains that the operation remains locked.

The original unsent operation was marked failed with an audit entry, retaining its SDK retry fence. Retrying the requested EGP 30.00 refund through the deployed seller API returned a pending receipt. Reconcile confirmed all 3000 minor units refunded, completed the operation, and cleared the lock. Repeating it retained version 17 and identical totals. A separate authenticated provider inquiry confirmed `is_live: false`, `is_refunded: true`, and `refunded_amount_cents: 3000`.

Deployed version: `baf97ce4-bc57-4dff-9076-591937b8e118`. Evidence: `validation-results/paymob-refund-recovery.json`. The full 40-test suite passed; two further regressions matching the observed zero-total receipt passed for partial/full refunds (11 focused Paymob tests total). TypeScript, ESLint, and the production build passed. Unknown outcomes without a receipt remain locked; reconciliation never blindly resubmits them.


## Pending refund page refresh — 2026-09-11

Order `ord_0f658289-3f61-42f5-ad02-8ec10c06764a` has a successful EGP 5.00 partial refund (`532818571`) against the EGP 10.00 transaction `532812832`. Authenticated inquiry confirms the refund child is successful and no longer pending, and the parent reports 500 minor units refunded. The refund ledger is completed and repeated reconciliation retains attempt version 12. The scheduled reconciliation job is also completed.

The seller page retained its initial pending snapshot because it fetched only on load or explicit actions. It now reads the latest order every five seconds while settlement is unresolved, pauses for hidden pages and active actions, and stops when settled. It preserves unsaved notes and fulfillment edits. TypeScript, ESLint, and production build passed. A Chromium check against the deployment served an initial pending snapshot, then confirmed automatic transition to completed and preservation of an unsaved note. Version: `402b55b2-d210-4f41-ad3d-d99edfa98605`. Evidence: `validation-results/paymob-partial-refund-recovery.json`.


## Moyasar checkout recovery — 2026-09-11

The deployed card form received HTTP 201 from `/v1/tokens` but expected `token` instead of the returned `id`, showing “Card tokenization failed” before creating a payment. The form now validates the returned `token_` ID and passes only that token to the lab backend. The [token API response](https://docs.moyasar.com/api/other/tokens/create-token) documents the `id` field. A browser regression failed against the original deployment and passed after the fix, also checking that the backend request contains no card number/CVC.

End-to-end verification exposed a second mapping issue: Moyasar returned `paid`, amount 1000 SAR minor units, `captured: 0`, and `captured_at: null` after successful 3-D Secure. The SDK treated zero manual capture as processing. The lab now normalizes authenticated paid sales while preserving uncaptured authorization semantics, and retains the sale total through refunds. Moyasar distinguishes [paid sales from manual captures](https://docs.moyasar.com/api/payments/payment-status-reference).

The successful sandbox test returned to order `ord_772c9e50-bb55-4955-8bdc-08eb0fa5e8a7`; attempt `att_24ecb123-ef07-462f-957a-b6159395f54c`, provider payment `f4bd07f5-5409-4261-b442-e7f2c5dea515`, is paid for SAR 10.00. Repeated reconciliation preserves version 7 and capturedMinor 1000. Earlier browser-harness interruptions left separate incomplete sandbox test orders; they were not retried as duplicate payments.

Deployment: `222dfeef-430f-43e8-bb71-fbb9a62f9c79`. Evidence: `validation-results/moyasar-checkout.json` and `validation-results/moyasar-settlement.json`. The 44-test suite passed, followed by two additional refund-mapping regressions (17 driver tests total). TypeScript, ESLint, production build, and the mocked browser token regression passed. Real tokenization, payment creation, successful ACS emulator verification, return to order, and provider/app settlement were verified.
