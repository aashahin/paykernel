# @paykernel/gateway-tap

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

- 94547b7: Phase 23: add portable `@paykernel/gateway-tap` (Tap Payments charges, authorize/capture/void, refunds, hashstring webhooks). Extra gateway package — not a core built-in.

### Patch Changes

- 9de3699: Type `createPayment` / `capturePayment` / `refundPayment` from the client's default gateway (map and registry) without putting extra-package fields on core params. Tap omitted-amount remaining math fail-closes on mixed refund lists; nested refund replay matches `reference.idempotent`.
- Updated dependencies [df66280]
- Updated dependencies [94547b7]
- Updated dependencies [6f78c47]
- Updated dependencies [9de3699]
  - @paykernel/core@1.0.0

## Unreleased

### Minor

- **Phase 23:** first-party portable Tap Payments adapter (`tapGateway` / `TapGateway`). Charges, authorize/capture/void, refunds, and HMAC-SHA256 `hashstring` webhooks. Conservative capability claims. Not a core built-in.

### Patch

- **TAP-JSON-PAD:** Mutating JSON `amount` is an ISO-padded **number** token on the wire (`10.50` SAR, `1.200` KWD), not a JSON string and not `JSON.stringify`’s shortest `10.5`. `JSON.parse` still yields an IEEE number. Hashstring padding is unchanged.
- **TAP-SINGLETON-DEFAULT:** A TAP-only `createPaymentClient({ gateways: { tap } })` (no `defaultGateway`) uses that gateway at runtime, matching singleton one-arg typing. Two or more gateways without a default still throw. Implemented in `@paykernel/core`.
- **TAP-REFUND-ZERO-POST:** Remaining `0` means nothing left to refund. The adapter does not `POST /refunds` with `charge.amount`. Map the nested refund for this `idempotencyKey` (or `GET /refunds/{id}`); otherwise `InvalidRequestError`.
- **TAP-REFUND-REFUNDED-POST:** Charge status `REFUNDED` is fully refunded. That is not a new `POST` of `charge.amount`. Map the nested refund for this `idempotencyKey` (or `GET /refunds/{id}`); otherwise `InvalidRequestError`.
- **TAP-NESTED-KEY-MISMATCH:** A nested refund whose `reference.idempotent` is present and differs from this `idempotencyKey` is not this refund (including a single nested refund). A single nested refund is still mapped when Tap omits that field.
- **TAP-CHARGE-VOID:** Charge object `VOID` is a failed payment (`getPayment` / charge webhook). Authorize `VOID` remains `succeeded` + `cancelled` (successful release).
- **TAP-INVOICE-HASH:** Invoice webhook `hashstring` uses Tap’s invoice formula with `x_updated` (not the charge `x_gateway_reference` / `x_payment_reference` string).
- **TAP-WEBHOOK-AUTH-ID:** Authorize `CAPTURED` webhook with `charge_id` sets `gatewayPaymentId` to that `chg_…` id.
- **TAP-PARTIAL-CAPTURE:** Capture `amount` less than the authorize is `partially_captured`, not `paid`. `isPaidOutcome` is false.
- **TAP-CREATE-KEY:** `createPayment` requires a caller `idempotencyKey`. The adapter does not mint an ephemeral UUID.
- **TAP-PARSE-OBJECT:** `verifyWebhook` fails closed (`false`) when `object` is missing or not `charge` / `authorize` / `refund` / `invoice`.
- **TAP-VOID-GET:** `voidPayment` GETs the authorize first. Already `VOID` is a GET replay, not `POST /authorize/{id}/void`.
- **TAP-CAPTURE-OVER:** Capture `amount` greater than the authorize throws `InvalidRequestError`.
- **TAP-AUTOVOID-SRC:** `autoVoidHours` is not defaulted. Authorize create with omitted / `src_card` source rejects it (`InvalidRequestError`). Token sources (`tok_…`) may send `auto: { type: "VOID", time }`. Charges never send `auto`.
- **TAP-WEBHOOK-HTTPS:** Config `webhookUrl` and per-request `tapPostUrl` must be HTTPS. `http://` and unparseable URLs are `InvalidRequestError`.
- **TAP-HTTP-11XX-REST:** Unlisted Tap `11xx` / `41xx` / `2100` / `2103` / `2108` JSON error codes are `InvalidRequestError`. Auth / not-found / amount / `1151` keep their existing maps. HTTP 5xx is still `NetworkError`.
- **TAP-REFUND-OMITTED:** Omitted refund amount without remaining/refunded on the charge throws `InvalidRequestError` (do not resend `charge.amount`). Remaining is used when exposed and **positive**. Remaining `0` is TAP-REFUND-ZERO-POST (not a POST of `charge.amount`). A `refunds` list that mixes parseable and opaque amounts is fail-closed.
- **TAP-CLIENT-OVERLOAD:** `createPaymentClient({ defaultGateway: "tap" })` (gateways map or registry) types `createPayment` / `capturePayment` / `refundPayment` from the registered gateway (Tap `tap*` fields) without adding those keys to core `CreatePaymentParams`. A TAP-only map without `defaultGateway` matches at runtime (TAP-SINGLETON-DEFAULT).
- **TAP-GOD-CLASS:** Refund remaining math lives in `refund-support.ts`; webhook identity / invoice parse live in `webhook-map.ts`.
- **TAP-CAPTURE-3DS:** Capture still sends `threeDSecure: true` and `customer_initiated: true`. Passing `false` throws (Tap forbids those false on authorize capture).
- **TAP-REFUND-REPLAY:** A charge already `REFUNDED` maps the nested refund for this `idempotencyKey` (or `GET /refunds/{id}`). Without a match it is `InvalidRequestError`, not a POST of `charge.amount` (TAP-REFUND-REFUNDED-POST / TAP-NESTED-KEY-MISMATCH). A single nested refund is still mapped when Tap omits `reference.idempotent`.
- **TAP-CAPTURE-CHARGE-ID:** `getPayment(auth_…)` on a CAPTURED authorize uses nested `charge_id` when present (`gatewayId` is `chg_…`, `authorizationId` is `auth_…`). Without `charge_id`, omit `amount` (do not invent captured money from the hold) and keep `authorizationId` `auth_…` — refunds still need a `chg_…` from capture POST or a charge webhook.
- **TAP-VOID-GET-OUTCOME:** `getPayment` of an **authorize** VOID is `outcome: "succeeded"` + `status: "cancelled"` (same as `voidPayment`), not `failed`. Charge VOID is TAP-CHARGE-VOID (`failed`). ABANDONED / CANCELLED stay `failed`.
- **TAP-INVOICE-PARSE:** Well-formed invoice webhook objects parse as non-paid (`cancelled`) so they are not fulfilled. Missing `id` or `created` still throws.
- **TAP-SAVE-CARD:** Create and capture POST send `save_card: false`.
- **TAP-ABORT-RETRY:** Caller-abort `NetworkError` after a mutating POST is not retried.
- **TAP-HTTP-5XX-ORDER:** HTTP 5xx maps to `NetworkError` before Tap JSON `1106` / other 11xx body codes. A 5xx body that includes `1106` is not `InvalidRequestError`.
- **TAP-WEBHOOK-AUTH-CHARGE:** Authorize webhook objects set `relatedIds.chargeId` when `charge_id` is present. Authorize `CAPTURED` with `charge_id` also sets `gatewayPaymentId` to that `chg_…` (TAP-WEBHOOK-AUTH-ID).
- **TAP-CHARGE-REFUNDED:** Charge object status `REFUNDED` maps to payment `refunded` (`getPayment` and charge webhooks), not `failed`. Refund _objects_ were already `refunded`.
- **TAP-MISSING-STATUS:** Mutating HTTP 2xx with an `id` but no object `status` is `indeterminate` (`afterProviderSubmit`). Missing status is not mapped as Tap `UNKNOWN` → `failed`.
- **TAP-CAPTURE-REPLAY:** `capturePayment` GETs the authorize. `AUTHORIZED` POSTs `/charges`. `CAPTURED` does not POST — keeps `authorizationId` (crash-retry after a completed capture). Without nested `charge_id`, omit `amount`. Replaying POST on an already-captured `auth_…` is Tap `1126`.
- **TAP-AUTH-CHARGE-ID:** Capture result `authorizationId` is the `auth_…` id; `gatewayId` is the charge `chg_…` id. Capture does not drop the authorize id when mapping the charge.
- **TAP-REFUND-REMAINING:** Omitted refund `amount` is the remaining refundable amount when the charge exposes `refunded` / remaining and remaining is **positive**. Remaining `0` is TAP-REFUND-ZERO-POST. If remaining is not exposed, pass `amount` explicitly (see TAP-REFUND-OMITTED).
- **TAP-CURRENCY-MATCH:** Capture and refund `currency` must match the authorize / charge. Mismatch is `InvalidRequestError` (Tap `1149`).
- **TAP-CREATE-RECONCILE:** `createPayment` timeout / 5xx / `1151` after submit: replay `createPayment` with the same `idempotencyKey`. Do not `getPayment` until you have a `chg_…` or `auth_…` id. capture / void / refund timeouts: `getPayment` with the stored id.
- **TAP-HTTP-11XX:** Tap error codes `1126` ("Source already used") and `1149` ("Currency code is not matching") are `InvalidRequestError`, not untyped `GatewayApiError`.
- **TAP-CUSTOMER-FIELDS:** Inline `tapCustomer` requires non-empty `firstName`, `lastName`, and `email`. Blank names or email are rejected (Tap `1130` / `1132` / `1138`).
- **TAP-DECLINE-CODES:** Charge `FAILED` with `response.code` `501`–`516` is `declined` (with decline extras), not a generic `failed`. `DECLINED` is unchanged.
- **TAP-REASON-LENGTH:** Refund `reason` longer than 249 characters is rejected (`InvalidRequestError`; Tap `1157`).
- **TAP-KEY-TRIM:** Config `secretKey` is trimmed. Whitespace-only keys remain invalid.
- **TAP-REDIRECT-URL:** Result `redirectUrl` / `nextAction` is `transaction.url` only. Merchant `redirect.url` (`callbackUrl`) is never a checkout next action. CAPTURED / AUTHORIZED must not redirect from that echo URL.
- **TAP-UDF1-PAYMENT-ID:** Webhook `paymentId` is `metadata.paymentId` / `metadata.orderId` / `reference.order` — never `metadata.udf1`.
- **TAP-REFUND-POST:** Refund POST includes `post.url` from config `webhookUrl` when set.
- **TAP-FAWRY-IN-PROGRESS:** Charge status `IN PROGRESS` / `IN_PROGRESS` (Fawry) maps to `pending` / `requires_action` like other pending statuses — not `failed`. All pending statuses are `requires_action`; `transaction.url` is only the redirect target when present.
- **TAP-TOTAL-REFUNDED:** Refund results omit `totalRefunded`. A single refund `amount` is not a cumulative total; the adapter does not invent `0`.
- **TAP-CAPTURE-BODY:** Capture POST sends `merchant.id` from config and `post.url` from `webhookUrl` when set.
- **TAP-CAPTURE-STATUS:** Capture requires GET authorize `AUTHORIZED` then `POST /charges`. GET `CAPTURED` does not POST — keeps `authorizationId` (crash-retry after a completed capture). Capture `amount` less than the authorize is TAP-PARTIAL-CAPTURE (`partially_captured`). `VOID` is rejected — the hold was released, not captured.
- **TAP-REFUND-ACCEPTED:** Refund object `ACCEPTED` maps to pending / `refund_pending`, not failed. Do not fulfill or retry as failure.
- **TAP-AUTH-LEFTOVER-URL:** Leftover `transaction.url` on AUTHORIZED / CAPTURED is not `requires_action`.
- **TAP-CAPTURE-FIELDS:** Capture POST sends `threeDSecure: true` and `customer_initiated: true`.
- **TAP-AUTHORIZE-AUTO:** Optional config `autoVoidHours` is sent as authorize-create `auto: { type: "VOID", time }` only. It is not defaulted. Omitted / `src_card` source is TAP-AUTOVOID-SRC.
- **TAP-AUTHORIZE-SOURCE:** `capture: false` omitted `tapSource` defaults to `src_card` (charges still default `src_all`).
- **TAP-CREATE-AUTH-SOURCE:** `createPayment` rejects `auth_…` source ids. Capture with `capturePayment`.
- **TAP-IN-PROGRESS-UNDERSCORE:** Charge / refund status `IN_PROGRESS` is treated like `IN PROGRESS` (pending).
- **TAP-HTTP-50X:** HTTP 5xx maps to `NetworkError` (mutating → `afterProviderSubmit`). It is not a card decline even if a JSON error code looks like `50x`.
- **TAP-1106-CUSTOMER:** Tap error `1106` ("Customer not found") is `InvalidRequestError`, not payment `ResourceNotFoundError`.
- **TAP-ZERO-AMOUNT:** Outbound amounts must be `> 0`. Zero is rejected.
- **TAP-1114-STATUS:** Tap error `1114` ("Please check the Authorize status") is a typed `InvalidRequestError` (fail closed), not an untyped `GatewayApiError`.
- **TAP-LAST-NAME:** Inline `tapCustomer` requires `lastName` (Tap error `1132`). Existing `cus_…` ids are unchanged.
- **TAP-CAPTURE-REDIRECT:** Capture `POST /charges` sends `redirect.url` from `tapRedirectUrl` or the authorize object’s `redirect.url`. Missing both fails closed (Tap `1110`).
- **TAP-VOID-RETRY:** Void is not Tap-idempotent. The adapter does not retry void after `afterProviderSubmit`. Successful void is `outcome: "succeeded"` + `status: "cancelled"`.
- **TAP-REFUND-REASON:** Refund `reason` is `tapReason`, else caller `reason`, else `requested_by_customer`.
- **TAP-TYPES-CREATE:** `TapGateway.createPayment` accepts `tap*` fields (`TapCreatePaymentParams`) without excess-property errors.
- **TAP-1151-TIMEOUT:** Tap error code `1151` ("Gateway timed out") maps to `NetworkError`. Mutating 1151 is `afterProviderSubmit` (indeterminate after keyed retries), not a clean `GatewayApiError` failure.
- **TAP-PCI-DEAD:** PCI fence rejects `source.card` and PCI `on_file` independently.
- **TAP-TIMEOUT-MS:** `timeoutMs` is a positive millisecond timeout (default 30000). Non-positive values are rejected, not treated as "use default" or an instant abort.
- **TAP-HASH-CATCH:** `hashstring` verification fails closed on malformed payload or non-hex signature (`false`). Canonical amount remains ISO-padded. Missing `object` / unsupported object is TAP-PARSE-OBJECT. Invoice formula is TAP-INVOICE-HASH.
- **TAP-HASH-VECTOR:** Tests verify Tap’s published Create-a-Charge `hashstring` header (docs example `sk_test_` + posted charge JSON). ISO amount padding is load-bearing for that vector.
