# @paykernel/gateway-myfatoorah

## 1.0.2

### Patch Changes

- Adapters now report the published package version in `manifest.version`.

  `TAP_ADAPTER_VERSION`, `MYFATOORAH_ADAPTER_VERSION`, and `HESABE_ADAPTER_VERSION` were still the
  pre-release string `0.1.0-next.0` after the packages moved to stable versions, so every registered
  adapter advertised a prerelease manifest version. The constants now match `package.json`, and the
  public API tests assert the constant and the factory manifest against `package.json` so the drift
  cannot come back.

  The Tap and MyFatoorah gateways also stop merging a redundant `interface` into the same-named
  `GatewayAdapter` class; the class methods already carry the narrowed per-gateway parameter types,
  and `tsc` plus the factory type suites verify that surface.

## 1.0.1

### Patch Changes

- fix: replace workspace:* with registry versions for consumer install

  All 18 packages with runtime workspace:* dependencies were published as 0.1.0/1.0.0 with unresolvable workspace:* specifiers, breaking `npm install` for consumers (Unsupported URL Type "workspace:"). Patch to 0.1.1/1.0.1 with concrete registry versions (^1.0.0, ^0.1.0 etc) via changesets internal dependency update. No API changes.

## 1.0.0

### Major Changes

- 6f78c47: 1.0 contract cut (constructor, Money, outcomes, statuses, provider params, reserve required). Removes 0.x shims: `new PaymentClient({ moyasar, ... })` → `createPaymentClient({ gateways: { moyasar: moyasarGateway(...) } })`; `AmountInput = Money` only (`money("10.50", "SAR")`), `GatewayPaymentResult` amount fields `Money | undefined`; `outcome` required, `success` removed; `PaymentStatus` → `PaymentDomainStatus`, `WebhookEvent.status` → `WebhookEnvelopeStatus`; provider fields moved off `CreatePaymentParams` onto per-gateway `*CreatePaymentParams`; `IdempotencyStore.reserve` and `PaymobIdempotencyStore.reserve` required; `expectedAmountMinor` and `ScriptedStep` removed from `@paykernel/testkit`. Compat CI (`check:compat`) + baselines (`public-api.inventory.json`, `schema.inventory.json`) added; `bun-hono-postgres` RC with real Postgres via `store-postgres/pg`.

### Minor Changes

- 1dfda91: Phase 23: add portable `@paykernel/gateway-myfatoorah` (V3 hosted payments, refunds, Webhook V2). Extra gateway package — not a core built-in.

### Patch Changes

- a65b256: Fix critical gateway-myfatoorah review gaps: MF-CREATE-REPLAY now only reuses Paid invoices (Pending falls through — GetPaymentStatus has no PaymentURL, would lose redirect), docs clarify orderId/myfatoorahCustomer.reference required for replay outside KWT/SAU (fallback idempotencyKey removed — was docs-only, would never match invoice CustomerReference); refund headerless retry now `retry:false` (no fan-out to 3 MakeRefund with same ExternalIdentifier); myFatoorahRefundBaseCurrency now only trusts BaseCurrency (no Currency/RefundCurrency fallback that could pick pay currency); mapCreateResult dead invoiceStatus/transactionEvidence removed (PaymentCompleted authoritative per V3).
- a82f3e3: Fix remaining gateway-myfatoorah review gaps: create-replay only outside KWT/SAU and only when Paid amount+currency match (inquiry 5xx/429 fail closed); headerless create/refund retry only on “header not supported” (MakeRefund `retry: false`); parse official thousand-separated amounts; refund PaymentId key type; PARTIALLY_REFUNDED → partially_refunded.
- c822c5b: Fix MyFatoorah residual review findings (docs + fixed behavior): MF-CREATE-REPLAY (CustomerReference lookup before replay outside KWT/SAU, no double-charge), MF-CUSTOMER-REF (`Customer: { Reference = orderId }` or `myfatoorahCustomer.reference`; `customerId` not `ExternalIdentifier` and does not become `Customer.Reference`), MF-SANDBOX-BASE (sandbox base always KWD when `live: false`; first-refund inference only when `live: true`), MF-GETPAYMENT-BASE-MIX (`getPayment` pay-first with `PaidCurrencyValue`/`TransationValue` → `InvoiceValue` fallback, never base+pay mix, last success), MF-CREATE-AMOUNT-FALLBACK (pay/display/base `ValueIn*` chosen by matching request currency, otherwise omitted), MF-PAYMENTCOMPLETED-REDIRECT (`PaymentCompleted: true` alone is `paid`, `PaymentURL` ignored; pending invoice stays `pending`), MF-WEBHOOK-RAW (raw string bodies parsed before verify), MF-WEBHOOK-MONEY-DRIFT (webhook amount is base, create/`getPayment` amount is pay when available).
- 9996428: Gate MyFatoorah 2026-08-25 deep-review gate (C1..I12 + nits):

  - **C1/C2 Fix postSubmit tagging & retry (Transport):** `gateway.ts:myfatoorahRequestOnce` now tracks `responseReceived` — fetch `TypeError`/DNS/connect thrown before headers is `afterProviderSubmit:false` (only `AbortError` timeout/caller-abort after mutating POST is `true`). BHR `404` → connect `TypeError` now retries via `isMyFatoorahRetryableBeforeSubmit` (`withRetry` 3 attempts) and throws retryable `NetworkError{afterProviderSubmit:false}` instead of immediate `indeterminate` with `orderId` gatewayId. KWT test now uses `DOMException AbortError` for true post-submit indeterminate (3×). Headerless retry (`MF-CRIT-2`) updated to `AbortError` (retry:false still). `http.ts` 5xx/inquiry classification unchanged.
  - **I1 Pending PaymentURL (Replay):** `gateway.ts:createPayment` replay comment expanded — `GetPaymentStatus` has no `PaymentURL` and `GET /v3/invoices/{id}` returns “No invoices match this InvoiceId” when no `InvoiceTransactions` (official). Pending invoice `PaymentURL` cannot be recovered; caller must persist before ACK. Still fail-closed `indeterminate` with `InvoiceId`.
  - **I2 GetPaymentStatus 429 rate-limit (Replay):** `gateway.ts:createPayment` replay `catch` now rethrows `RateLimitError` directly (instead of wrapping as `NetworkError{afterProviderSubmit:true}` → indeterminate). Caller gets `retryAfter` to backoff and retry same `orderId`/`idempotencyKey`; still no second `POST /v3/payments`. New test `MF-CREATE-REPLAY: ARE lookup 429 surfaces RateLimitError` (3×429 → `RateLimitError`, 11 replay pass, 80 gateway pass). `docs/idempotency` + `charges` + `production-checklist` note rate-limit.
  - **I7 PaymentCompleted string (Webhook):** `gateway.ts:mapCreateResult` now accepts `PaymentCompleted` boolean `true` **or** case-insensitive trimmed string `"true"` (V3 `IsSuccess` is `"true"`/`"false"` string per OpenAPI) — `"false"` still not paid. Test `PaymentCompleted string handling`.
  - **I8 isPaidOutcome amount-optional (Webhook):** `docs/charges.md` + `webhooks.md` document that `PaymentCompleted:true` with no matching `ValueIn*` omits `amount`/`currency` intentionally to avoid KWD-as-SAR drift; `isPaidOutcome` (status `paid` + `succeeded`, amount optional) still true — merchants must not fulfill on `undefined` amount or re-query `getPayment`.
  - **I9 Remaining refund math (Refund):** `refund-support.ts:myFatoorahRemainingRefundMajor` now allow-lists only `REFUNDED`/`PENDING` (was skip only `CANCELED`). `FAILED`/`REJECTED`/unknown/missing amount ignored (remaining stays full), `Refunded`/`Pending` with missing amount still fail closed. Tests for FAILED/REJECTED/unknown ignored + pending counted + comma `12,345.000` + updated missing-throw expectations. `status.ts`/`refund-support.test.ts` 20 pass.
  - **I11 Webhook other V2 events (Webhook):** `webhooks.ts:myFatoorahWebhookKind` + `verifyMyFatoorahSignature` docs clarified — codes 3-7 `BALANCE_TRANSFERRED`/`SUPPLIER_STATUS_CHANGED`/`RECURRING_UPDATES`/`DISPUTE_STATUS_CHANGED`/`SUPPLIER_UPDATE_REQUEST_CHANGED` per https://docs.myfatoorah.com/docs/webhook-v2 are unsupported; `verify` returns `false`, `parseWebhookEvent` throws `InvalidRequestError(unsupported)` (not signature failure). Test `unsupported webhook codes 3-7 verify false but parse throws unsupported` + `Name` authoritative.
  - **I12 Success is final (Webhook):** `webhook-map.ts` + `docs/webhooks.md` — `Invoice.Status=PAID` authoritative regardless of `Transaction.Status` (KNET duplicate), `Paid` is terminal per https://docs.myfatoorah.com/docs/v3-updating-payment-status-guidelines — later `PENDING` must not un-fulfill; inbox `claim` dedupe noted.

  - **I10 Capability honesty — tokenization:** `MYFATOORAH_CAPABILITIES.tokenization` `false` → `true` with comment that direct `SourceOfFund.Card` PAN is still rejected before any fetch; only `myfatoorahToken`/`myfatoorahSessionId` → `SourceOfFund.Token`/`SessionId` is implemented and tested (gateway.test.ts:283). Manifest version stays `0.1.0-next.0`; `payments`/`immediateCapture`/`refunds`/`partialRefunds` remain `true`, `authorization`/`hostedCheckout` `false`. README Capabilities updated to claimed `tokenization (via Token/SessionId; PAN rejected)` with gateway.ts length-duplication deferred note.

  - **Config nits — `copyMyFatoorahConfig` `webhookSecret`:** `webhookSecret` branch now guards non-string (`number`/`boolean`) with `InvalidRequestError` instead of `TypeError` from `.trim()`; whitespace-only string still throws; trimmed non-empty still copied. Added `isMyFatoorahNonPublicHost` comment that `10.example.com` hostname is intentionally allowed (not a literal `10.x.x.x` IP) — factory.test.ts `accepts a public hostname that starts with 10.` preserved.

  - **Docs consistency — official contracts (links preserved):**
    - README: `orderId` required outside KWT/SAU already exemplified; idempotencyKey required + no minted UUID; amounts ISO-padded number tokens (`10.50` SAR / `1.200` KWD) via `stringifyMyFatoorahJsonBody`.
    - Overview/charges/idempotency/production-checklist (co-landed with ReplayIdempotency I1/I2/I5/I6): `orderId`/`myfatoorahCustomer.reference` required outside KWT/SAU, `Idempotency-Key` only KWT/SAU (250 min per https://docs.myfatoorah.com/docs/idempotency, omitted elsewhere), `CustomerReference` replay reuses only `Paid` when amount+currency match, `Pending`/mismatch/5xx/429/non-404/empty success `Data` → `indeterminate` with `InvoiceId` when known (GetPaymentStatus has no `PaymentURL` — pending cannot recover redirect), official 2xx `IsSuccess:false` + empty `Data` + not-found `Message` may create, unkeyed create/MakeRefund do not retry `429`, header-not-supported retries once without header.
    - Refunds: MakeRefund **base currency only** (e.g. KWD), never display/pay; sandbox `live:false` base always `KWD`; live first-refund base inferred from `country` only when `live:true` and history empty; results `refund_pending` never `completed`; settlement via `REFUND_STATUS_CHANGED` / `GetRefundStatus` `Refunded`; concurrent `ExternalIdentifier` not provider-deduped outside KWT/SAU — caller-side lock noted in refunds.md (ReplayIdempotency).
    - Webhooks: `MyFatoorah-Signature` case-insensitive, HMAC-SHA256+Base64, canonical fixed order null→`""`, `string[]` header allowed; `PAYMENT_STATUS_CHANGED`/`REFUND_STATUS_CHANGED` only, codes 3-7 (`BALANCE_TRANSFERRED` etc) fail closed as `false`/`unsupported` per https://docs.myfatoorah.com/docs/webhook-v2; `Paid` is terminal per https://docs.myfatoorah.com/docs/v3-updating-payment-status-guidelines — later `PENDING` must not un-fulfill.
    - Money: bigint minor units `rounding:reject`, zero rejected outbound, ISO-padded **number tokens** on wire (`10.50`/`1.200`) via `stringifyMyFatoorahJsonBody`, never strings/`*100`; create/`getPayment` publish **pay** when available, webhooks/refunds publish **base** (MF-WEBHOOK-MONEY-DRIFT), `KD`/`SR` aliased to `KWD`/`SAR`, `12,345.000` commas stripped.
    - Status-mapping: `REFUNDED`/`PARTIALLY_REFUNDED` rows kept for shared `mapMyFatoorahInvoiceStatus`/webhook map with explicit note that `POST /v2/GetPaymentStatus` per https://docs.myfatoorah.com/docs/get-payment-status never returns `REFUNDED` — after refund invoice stays `Paid` (I3, refund-blind; use `GetRefundStatus`/webhook).

  - **Nits:** `gateway.ts` length/asRecord/stringOrNumberId/`InvoiceId >=14` heuristic duplication intentionally not split this gate — documented in README; `config.ts` localhost check (`localhost`/`.localhost`, loopback, private IPv4/IPv6, `::ffff:` mapped) already correct; no new speculative flags; CQS/≤20 lines/≤4 params preserved.

  - **Tests:** `factory.test.ts` added `rejects non-string webhookSecret` (number/boolean → `InvalidRequestError`) alongside existing `10.example.com` hostname allow test; `public-api.test.ts` updated to expect `tokenization:true`; `conformance.test.ts` + `factory.test.ts` pass focused.

  Gate covers C1/C2 (Transport), I1/I2/I5/I6 (ReplayIdempotency), I3/I4/I8/I9 (RefundGetPayment), I11/I12 + money (WebhookMoney), I10 + nits + remaining docs (CapabilitiesDocs).

- 76c0e34: Fix MyFatoorah create-replay and unkeyed mutation retries: official 2xx GetPaymentStatus not-found (`IsSuccess:false` + empty Data + not-found Message) may create; empty success Data and generic IsSuccess-false fail closed; pending/mismatch indeterminate keeps the InvoiceId; unkeyed create/MakeRefund no longer retry 429.
- b616fab: Fail closed on MyFatoorah create replay outside KWT/SAU: require `orderId` / `myfatoorahCustomer.reference`; reuse only a Paid invoice whose amount+currency match; Pending, amount mismatch, non-404 lookup errors, and inquiry 5xx/429 return indeterminate instead of a second `/v3/payments`. Also: Paid-without-success stays pending; GetRefundStatus array `Data` is parsed as refund history; webhook host checks use IP literals (not `10.*` hostname prefixes).
- e25eb3c: Fix MyFatoorah deep-review findings: first refund infers account base currency from portal country (fail-closed on pay-currency amounts); nullable `GetRefundStatus` `Data` treated as empty history; headerless idempotency-error create retry runs without post-submit auto-retry; `getPayment` publishes pay-currency amount; refund webhook `paymentId` only from `ReferencedInvoice.ExternalIdentifier`; V3 `PaymentMethod` allowlist restricted to CARD/APPLE_PAY/GOOGLE_PAY/KNET/INVOICE; `KD`/`SR` webhook currency aliases; signature header accepts string arrays; localhost callback/webhook URLs rejected.
- Updated dependencies [df66280]
- Updated dependencies [94547b7]
- Updated dependencies [6f78c47]
- Updated dependencies [9de3699]
  - @paykernel/core@1.0.0

## Unreleased

### Minor

- **Phase 23:** first-party portable MyFatoorah adapter (`myfatoorahGateway` / `MyFatoorahGateway`). V3 hosted payments (sale), refunds via MakeRefund, and Webhook V2 HMAC-SHA256 signatures. Conservative capability claims. Not a core built-in.

### Patch

- **MYF-CREATE-KEY:** `createPayment` requires a caller `idempotencyKey`, sent as the `Idempotency-Key` header **only in KWT/SAU** (https://docs.myfatoorah.com/docs/idempotency — omitted elsewhere). Official cache: 250 minutes. The adapter does not mint an ephemeral UUID. 2xx `IsSuccess:false` `ValidationErrors`/`FieldsErrors` string-body `Idempotency` rejections are retried once without the header; that headerless retry never auto-retries after submit (no double-charge).
- **MYF-AMOUNT-TOKEN:** Mutating JSON amounts are ISO-padded **number** tokens on the wire (`Order.Amount` / `Amount` as `10.50` SAR, `1.200` KWD), never strings and never float-multiplied.
- **MYF-NO-AUTH:** `capture: false` is rejected (`authorization` unclaimed). `capturePayment` throws `OperationNotSupportedError`. `voidPayment` is not implemented.
- **MYF-REDIRECT:** `PaymentURL` maps to `requires_action` + `redirectUrl`; `PaymentCompleted` + paid evidence maps to `succeeded` / `paid` with no redirect. Paid `PaymentId` also checked at `TransactionDetails.Transaction.PaymentId`.
- **MYF-WEBHOOK-SECRET:** Webhook verification uses a separate `webhookSecret` (portal secure key), never the API token. Missing secret or header fails closed (`false`). `Event.Code` `1`/`2` accepted as number or string `"1"`/`"2"`.
- **MYF-REFUND-PENDING:** MakeRefund results are `refund_pending` / `pending`, not `completed`. Settlement arrives via `REFUND_STATUS_CHANGED` or `GetRefundStatus` `Refunded`. `ReferencedInvoice.ExternalIdentifier` (never the refund `ExternalIdentifier` idempotency key) is `paymentId` on refund webhooks.
- **MYF-REFUND-REMAINING:** Refund amount defaults to remaining (`InvoiceValue` − non-canceled refunds). **Any existing refund with `ExternalIdentifier === idempotencyKey` is returned before `MakeRefund`, even for partial refunds (idempotent replay).** Remaining `0` with no match throws — never re-POSTs the invoice amount. Lookup handles both `RefundStatusResult` and `Refunds` shapes.
- **MYF-INVOICE-ID:** `gatewayId` is the InvoiceId. `getPayment` uses `POST /v2/GetPaymentStatus` (never `GET /v3/invoices/{id}` for unpaid invoices). `SR`→`SAR`/`KD`→`KWD` aliased. Paid amount prefers `PaidCurrencyValue`+`PaidCurrency` (pay currency, matching paid create); `InvoiceValue`+`Currency` (base) is the fallback.
- **MYF-PCI:** `SourceOfFund.Card` / raw card objects are rejected before any fetch. Only `myfatoorahSessionId` (SessionId) or `myfatoorahToken` (Token) are sent.
- **MYF-METADATA:** Create `metadata` accepts only `UDF1`..`UDF5` string values.
- **MYF-REFUND-RETRY:** MakeRefund is not auto-retried after submit (no provider dedupe of `ExternalIdentifier`). Create IS retried (header dedupe in KWT/SAU). `Idempotency-Key` header is **omitted outside KWT/SAU**. `orderId` is now sent as both `Order.ExternalIdentifier` and `Customer.Reference` so webhooks reliably carry it as `Invoice.ExternalIdentifier`. `MakeRefund` is **base currency only** (e.g. KWD).
- **MYF-REFUND-BASE:** First refund with empty history infers the account base currency from the portal country (KWD/SAR/BHD/… per ISO lookups) and fails closed on pay-currency amounts. `GetRefundStatus` 2xx with `Data: null` (nullable per OpenAPI) is an empty refund history.
- **MYF-WH-STRICT:** Webhook `KD`/`SR` currency aliases normalize to ISO. Signature header accepts `string[]` values. `callbackUrl`/`webhookUrl` reject localhost. V3 `PaymentMethod` allowlist is `CARD`/`APPLE_PAY`/`GOOGLE_PAY`/`KNET`/`INVOICE` — regional methods (`BENEFIT`, `MADA`, `STC_PAY`, `QPAY`, `OMANNET`) remain `DisplayPaymentMethods` lowercase tokens.
- **MF-CREATE-REPLAY:** Outside KWT/SAU `Idempotency-Key` is omitted and `orderId` / `myfatoorahCustomer.reference` is required; a post-submit timeout / `afterProviderSubmit` / `indeterminate` on `createPayment` first looks up `CustomerReference` via `GetPaymentStatus` before replay — only **Paid** invoices whose amount+currency match are reused. `Pending`, amount mismatch, inquiry 5xx/429, and non-404 4xx fail closed (`indeterminate`, no second `/v3/payments`). HTTP 404 or official 2xx not-found Message + empty Data creates. KWT/SAU still use header dedupe (250-minute cache).
- **MF-CUSTOMER-REF:** `Customer: { Reference }` is set from `myfatoorahCustomer.reference` when provided, otherwise from `orderId` (`Customer.Reference = orderId`, also `Order.ExternalIdentifier = orderId`). `customerId` is **not** `Order.ExternalIdentifier` and does **not** become `Customer.Reference`.
- **MF-SANDBOX-BASE:** Sandbox (`live: false` → `apitest.myfatoorah.com`) base currency is always `KWD` regardless of `country`; first-refund base inference from `country` (KWT→KWD, SAU→SAR, …) only applies when `live: true` and `GetRefundStatus` history is empty, otherwise `KWD`.
- **MF-GETPAYMENT-BASE-MIX:** `getPayment` publishes **pay** currency when available (`PaidCurrency`+`PaidCurrencyValue`/`TransationValue` from last `SUCCESS`/`SUCCSS` transaction) else `InvoiceValue`+`Currency` (base) — never a mixed `InvoiceValue` (base) + `PaidCurrency` (pay) pair. Success transaction is the **last** success.
- **MF-CREATE-AMOUNT-FALLBACK:** `createPayment` paid amount picks the `ValueIn*` field whose currency matches the request `currency` (`ValueInPayCurrency`/`PayCurrency`, `ValueInDisplayCurrency`, `ValueInBaseCurrency`); mismatched currency is **omitted** rather than published as the wrong amount.
- **MF-PAYMENTCOMPLETED-REDIRECT:** `PaymentCompleted: true` alone is `paid`/`succeeded` even without nested `TransactionDetails.Invoice.Status=PAID` or `TransactionDetails.Transaction.Status=SUCCESS`; `PaymentURL` on a paid completion is the Result URL and is ignored. Pending invoices stay `pending` even when transaction is `FAILED`/`AUTHORIZE`.
- **MF-WEBHOOK-RAW:** `verifyWebhook` and `parseWebhookEvent` accept raw `string` bodies (e.g. `request.text()`) and JSON-parse them before verify/normalize; unparseable strings fail closed.
- **MF-WEBHOOK-MONEY-DRIFT:** Webhook `PAYMENT_STATUS_CHANGED`/`REFUND_STATUS_CHANGED` amounts are **base** (`ValueInBaseCurrency`/`BaseCurrency`), while `createPayment`/`getPayment` paid amounts are **pay** when available — never drift base into pay.
- **MF-CREATE-REPLAY-SAFE:** CustomerReference lookup runs only outside KWT/SAU; a Paid invoice is reused only when amount+currency match; `Pending` / mismatch / inquiry 5xx/429 / non-404 4xx fail closed as `indeterminate` (no second `/v3/payments`).
- **MF-IDEMPOTENCY-CONFLICT:** Headerless create/refund retry only on “header not supported”, never on “key already used with a different request”. Headerless MakeRefund is `retry: false` (no 429 fan-out).
- **MF-THOUSANDS:** Official `12,345.000` amount strings parse; `getPayment` keeps pay currency for amounts ≥ 1,000.
- **MF-REFUND-PAYMENTID:** `refundPayment` rejects PaymentId-shaped ids unless `myfatoorahKeyType: "PaymentId"`; MakeRefund then uses that key type.
- **MF-PARTIAL-STATUS:** `PARTIALLY_REFUNDED` maps to `partially_refunded`; payment webhooks do not treat refunded invoices as `failed`.
- **MF-REPLAY-404-MSG:** Create replay outside KWT/SAU treats official 2xx `IsSuccess:false` + empty `Data` + not-found `Message` as no invoice (creates); generic `IsSuccess:false` and `IsSuccess:true` + empty `Data` fail closed. Envelope `Message` is included on mapped errors. Pending/mismatch fail-closed returns the existing **InvoiceId**. Unkeyed create/`MakeRefund` no longer retry `429`.
