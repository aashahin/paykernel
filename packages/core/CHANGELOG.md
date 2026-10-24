# @paykernel/core

## 1.0.1

### Patch Changes

- 63c3cf3: Move request validation to zod 4 (`^4.6.7`). zod 3 has no release patched for GHSA-mrhx-c7xc-m3w5, a memory exhaustion while validating oversized constrained collections. Behaviour is unchanged: records keep string keys, UUID fields keep zod 3's permissive 8-4-4-4-12 match (`z.guid()`), and `InvalidRequestError` details carry the zod issue list as before.

## 1.0.0

### Major Changes

- 6f78c47: 1.0 contract cut (constructor, Money, outcomes, statuses, provider params, reserve required). Removes 0.x shims: `new PaymentClient({ moyasar, ... })` → `createPaymentClient({ gateways: { moyasar: moyasarGateway(...) } })`; `AmountInput = Money` only (`money("10.50", "SAR")`), `GatewayPaymentResult` amount fields `Money | undefined`; `outcome` required, `success` removed; `PaymentStatus` → `PaymentDomainStatus`, `WebhookEvent.status` → `WebhookEnvelopeStatus`; provider fields moved off `CreatePaymentParams` onto per-gateway `*CreatePaymentParams`; `IdempotencyStore.reserve` and `PaymobIdempotencyStore.reserve` required; `expectedAmountMinor` and `ScriptedStep` removed from `@paykernel/testkit`. Compat CI (`check:compat`) + baselines (`public-api.inventory.json`, `schema.inventory.json`) added; `bun-hono-postgres` RC with real Postgres via `store-postgres/pg`.

### Minor Changes

- df66280: Initial PayKernel package family under the `@paykernel` npm scope.

### Patch Changes

- 94547b7: Document `@paykernel/gateway-tap` as a first-party extra adapter on the custom-gateways plugin path.
- 9de3699: Type `createPayment` / `capturePayment` / `refundPayment` from the client's default gateway (map and registry) without putting extra-package fields on core params. Tap omitted-amount remaining math fail-closes on mixed refund lists; nested refund replay matches `reference.idempotent`.

## Unreleased

### Major Changes

- **Phase 22 hosted checkout:** `createCheckoutSession` / `getCheckoutSession` now return a Phase 6 `outcome` union (`session` + `references`) instead of `{ success, sessionId, url }`. Create success is not paid settlement. Prefer `PaymentClient.createCheckoutSession` (capability `hostedCheckout`).
- **Phase 22 disputes / payment links:** Stripe claims `disputes` and `paymentLinks` with first-class get/list/evidence and Payment Links APIs.

### Behavior (0.x)

- **TAP-SINGLETON-DEFAULT / CLIENT-SOLE-GATEWAY:** When `defaultGateway` is omitted and exactly one gateway is configured (gateways map, registry, or legacy constructor), one-arg `createPayment` / `capturePayment` / `refundPayment` / `voidPayment` / `getPayment` use that gateway. This matches existing singleton `DefaultOpParams` typing. Two or more configured gateways without a default still throw `InvalidRequestError`.
- **CLIENT-DEFAULT-OP-PARAMS:** `createPaymentClient` infers a second `PaymentClient` type argument from `defaultGateway` (gateways-map **and** registry forms). One-arg `createPayment` / `capturePayment` / `refundPayment` use that gateway's method params. Multi-gateway clients without a typed default still use core `CreatePaymentParams` / `CaptureParams` / `RefundParams` (not `never`). Named `gateway` is a separate overload so default-gateway extra fields cannot be passed to another registered name.
- **P22-CKO-GET-ZERO:** `getCheckoutSession` amount is session `amount_total` while unpaid; captured rematch only after paid. Do not fulfill on GET checkout amount.
- **List paging:** Stripe refund lists follow `has_more` / `starting_after`. Payment-link `line_items.has_more` omits amount rather than inventing major `0`.
- **P22-PCI:** PCI fence walks nested `metadata` / `evidence` / CVC, not only top-level PAN keys. Allows numeric order ids / timestamps and Moyasar AFT `sender.account.number` that is not a Luhn PAN; rejects Luhn-valid PAN, embedded PAN text, and CVC aliases including `cvv2`. Does not claim every 13-digit leaf is blocked. Stripe `tok_…` attach is `paymentMethods`, not capability `tokenization`.
- **P22-PP-DISPUTE:** PayPal `CUSTOMER.DISPUTE.CREATED` / `UPDATED` / `RESOLVED` parse without throw; dual-write `dispute.opened` / `updated` / `closed`. Envelope status is dispute lifecycle (`needs_response` / `under_review` / `won` / `lost` / `processing`), never `paid` or generic payment `pending`. IDs are the dispute resource id.
- **Off-session customer:** `createPayment({ offSession: true })` requires a stored payment-method id **and** a customer id (see `docs/customers.md`). Fail-closed unless the gateway claims `paymentMethods`.
- **Detach omit customerId:** detach snapshots omit `customerId` even when the request passed one (detached). Mock gateway matches. Mock `getCustomer` looks up created customers; unknown ids are `outcome: failed` with statusCode 404 (not invented `active`).
- **Dispute unknown status:** missing Stripe dispute `status` is `unknown`, not `needs_response`. Empty evidence submit is rejected. `listDisputes` pages (`has_more` / `starting_after`) with a page cap.
- **Hosted cancelUrl:** Stripe hosted Checkout payment/subscription modes require `cancelUrl`. Setup may omit. Checkout/link URLs must be http(s).
- **Payment-link envelope:** payment_link webhook envelopes must not last-write a payment as `pending`/`paid`.
- **Checkout create paymentIntentId:** Checkout session `references.relatedIds.paymentIntentId` when Stripe expands a PaymentIntent (`getCheckoutSession`; use that `pi_*` for capture/refund/void).
- **README outcome sample:** Stripe Checkout README sample uses the outcome union (`result.outcome === "succeeded"`, `result.session.url`, `references.providerObjectId`) and requires `idempotencyKey`.

- **Phase 22 review close:** Stripe `getCheckoutSession` HTTP 404 is `outcome: failed` (same as getCustomer). Checkout session currency is uppercase ISO. Payment-link GET expands `line_items` and publishes amount only for a single quantity-1 item. After-hooks deep-clone `disputes` / `paymentMethods` lists.

- **Phase 22.1 docs:** customers / stored payment methods / off-session vault surface is documented (`docs/customers.md`). Raw PAN/CVC remains rejected before adapters.
- **Phase 22.4:** marketplace stays a capability group in core (Moyasar create-time `splits`); no Stripe Connect package.

- **NEW-PAYPAL-7:** `capturePayment` maps `paid` only when the **response** `final_capture === true` (same as GET / webhook). Omitted / `false` is `partially_captured` + `requires_action` — no request-intent fallback. Sale/order captures still do not send `final_capture`.
- **NEW-STRIPE-REFUND-0 / NEW-STRIPE-0:** empty / pending-only refund lists omit `totalRefunded` (not major `0`). `fromStripeAmount(undefined|null)` returns `undefined`. Charge `amount_refunded` recovery only when finite and `> 0`.
- **NEW-MOYASAR-JSON-1:** mutating HTTP 2xx with unreadable JSON is `NetworkError({ afterProviderSubmit: true })` (indeterminate fence). GET / non-mutating 2xx stay `GatewayApiError`.
- **NEW-CORE-11:** public mapper rematch tables match `handleWebhook` (`cancelled` / `reversed` / `failed` / `refunded` / `authorized` / open money) for catalog Stripe / PayPal / Moyasar settlement names and already-stable `payment.succeeded` / `capture.completed` / `refund.completed`.
- **NEW-PERF-1:** PayPal and Moyasar `payloadHash` is a compact identity (`id` / type / time / object id), not the full resource tree. Inbox claim must use `event.payloadHash`.
- **NEW-OBS-3:** logger redact matches SetupIntent `seti_…_secret_…` and PayPal `A21AA…` / long `A21…` access tokens (public `pi_` / `seti_` ids stay visible).
- **PAYPAL-DW-1 mapper:** `mapProviderEventTypeToStable('paypal', 'PAYMENT.CAPTURE.REFUNDED')` is status-aware — proven `refunded` → `refund.completed`; missing / `partially_refunded` → `refund.pending`. Catalog `PAYPAL_EVENT_TYPE_MAP` still names the proven-full-refund arm.
- **PERF-6:** `handleWebhook` / composed `onWebhookVerified` isolate identity and dual-write without deep-cloning `rawPayload`. Stripe `parseWebhookEvent` hashes a compact `{ id, type, created, object }` identity instead of the full PaymentIntent/charge tree. `attachPaymentEvent` does not re-hash when `payloadHash` is already set.
- **Deep audit 2026-08-16:** Uncertain refunds (`success: false` / omitted + `pending`) are `indeterminate`, not `failed`. Stripe `refund.failed` maps to `refund_failed` (does not overwrite payment status). Succeeded PaymentIntents read charge refunds; unexpanded `latest_charge` fail-closes to `processing`. PayPal `CAPTURE.REFUNDED` on a refund resource is `partially_refunded`, not full `refunded`; `ORDER.COMPLETED` does not invent paid from a capture-id string. Paymob Intention HTTP 200 missing id/URL keeps the create fence. After-hooks freeze money/identity between composed handlers. `handleWebhook` awaits a thenable `verifyWebhook` and rejects thin 3-field `PaymentEvent`s. Moyasar incomplete `refund_completed` inquiry is `requires_action`, not `succeeded`.
- **PayPal partial auth capture dual-write (N11):** `PAYMENT.AUTHORIZATION.PARTIALLY_CAPTURED` dual-writes stable type **`payment.processing`** (was `capture.completed`) with domain status `partially_captured`. Type-only fulfillment must not treat partial auth capture as full settlement; `isPaidOutcome` remains false. Full `PAYMENT.AUTHORIZATION.CAPTURED` / `PAYMENT.CAPTURE.COMPLETED` still map to `capture.completed`.
- **Paymob partial capture outcome (N12):** `mapPaymobOutcome` demotes status `partially_captured` to **`requires_action`** (not `succeeded`) so outcome-only callers cannot fulfill remaining uncaptured funds. Auth holds still use `outcome: 'succeeded'` with `isPaidOutcome` false. **Always use `isPaidOutcome` / `status === 'paid'` for fulfillment.**
- **Paymob inquiry success fail-closed (N13):** `getPayment` defaults missing transaction `success` to **`false`** (was `true`). Paid/authorized paths cannot invent success when Paymob omits the field; amount-derived refunds still surface honestly.

- **Stripe partial PI success dual-write:** `payment_intent.succeeded` with status `partially_captured` (`amount_received < amount`) now dual-writes **`payment.processing`**, not `payment.succeeded`. Full paid still maps to `payment.succeeded`. Aligns type-only fulfillment with `isPaidOutcome` / Paymob partial policy — do not fulfill remaining uncaptured funds on stable type alone.
- **Stripe `charge.refunded` incomplete snapshots:** when `refunded !== true` and `amount_refunded` is missing/non-finite, status is **`refund_completed`** (not fail-open full `refunded`), matching safer refund-object incomplete handling.
- **BREAKING (fulfillment helpers):** Domain status `approved` (PayPal buyer approval, pre-capture) is **no longer paid-like**. `PAID_LIKE_PAYMENT_STATUSES` is `paid` only; `isPaidLikePaymentStatus('approved')` and `isPaidOutcome(...)` for approved results are **false**. PayPal `mapPayPalOutcome` and `inferOperationOutcome` map uncaptured `approved` to `requires_action` (not `succeeded`), aligning operation helpers with webhook `CHECKOUT.ORDER.APPROVED` → `payment.processing`. Capture `COMPLETED` / `status: 'paid'` still yields `isPaidOutcome` true. Fulfill only on captured paid — never ship on approval alone.

### Patch

- **Docs (N16):** Moyasar/Paymob capture/refund/void multi-worker double-mutate footgun clarified in gateway docs and behavioral contracts — shared `idempotencyStore` + `idempotencyKey` required for safe multi-worker mutations (store remains API-optional).

- PayPal `PAYMENT.REFUND.COMPLETED` is now parsed as `status=refunded` with Phase 7 dual-write `refund.completed` (was map-only; parse threw Unsupported).
- **Paymob dual-write (amount-only refunds / auth+capture):** Phase 7 stable-type mapping prefers normalized `WebhookEvent.status` and amount-derived refund/capture signals over bare `success` / sticky `is_auth`. Amount-only `refunded_amount_cents` TRANSACTION webhooks dual-write `refund.completed` (not `payment.succeeded`). `is_auth` + full `captured_amount` dual-writes `payment.succeeded` when status is `paid` (not `payment.authorized`). Failed refund/void action callbacks dual-write `payment.failed` in agreement with status. Optional `ProviderEventMapContext.amounts` minor-unit fields support amount-aware dual-write.
- **Paymob redirect honesty (N1):** `TRANSACTION_RESPONSE` (browser/redirect) success, paid, or capture signals dual-write **`payment.processing`**, never `payment.succeeded` / `capture.completed`. Processed server `TRANSACTION` webhooks still settle as before. Prefer fulfill on processed TRANSACTION + settlement stable type (or inquiry + `isPaidOutcome`); do not fulfill on redirect-only.
- **Paymob partial capture dual-write (N2/N7):** `partially_captured` (status or amount-derived partial capture without `is_capture`) dual-writes **`payment.processing`**, not `payment.succeeded`, so type-only fulfillment matches `isPaidOutcome` (partial excluded). Explicit `is_capture` + success still maps to `capture.completed` (amount-aware).

## 0.1.0-next.0

### Major Changes

- Initial PayKernel prerelease under the `@paykernel` npm scope.
