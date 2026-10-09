# @paykernel/gateway-hesabe

Hesabe adapter for `@paykernel/core`, supporting KWD redirect payments, embedded Hosted Checkout, direct Apple Pay, transaction enquiry, confirmed callbacks, enquiry-verified webhooks, and full/partial refunds. Register it as an external adapter; it does not extend core's built-in gateway names.

This documentation describes adapter version `0.3.0`, which introduces embedded checkout, direct Apple Pay, and their action guards. Live sandbox interoperability has not been validated — complete the [sandbox acceptance checklist](./docs/sandbox-acceptance.md) before production use.

## Setup

```sh
bun add @paykernel/core @paykernel/gateway-hesabe@0.3.0
```

```ts
import { createPaymentClient, InMemoryIdempotencyStore, money } from "@paykernel/core";
import { hesabeGateway } from "@paykernel/gateway-hesabe";

const payments = createPaymentClient({
  gateways: {
    hesabe: hesabeGateway({
      merchantCode: process.env.HESABE_MERCHANT_CODE!,
      accessCode: process.env.HESABE_ACCESS_CODE!,
      encryptionKey: process.env.HESABE_ENCRYPTION_KEY!, // 32 UTF-8 bytes
      ivKey: process.env.HESABE_IV_KEY!, // 16 UTF-8 bytes
      username: process.env.HESABE_USERNAME!,
      password: process.env.HESABE_PASSWORD!,
      idempotencyStore: new InMemoryIdempotencyStore(), // single-process example
      live: false,
    }),
  },
  defaultGateway: "hesabe",
});
const hesabe = payments.gateway("hesabe");
const result = await hesabe.createPayment({
  amount: money("10.000", "KWD"),
  currency: "KWD",
  orderId: "order-123",
  idempotencyKey: "checkout-order-123", // retain this key for retries
  callbackUrl: "https://merchant.example/hesabe/callback",
});
if (result.outcome === "requires_action" && result.redirectUrl) {
  // Redirect the customer to result.redirectUrl. Payment is not yet confirmed.
}
```

Keep credentials on your backend. The runtime uses Web `fetch` and Web Crypto `subtle`; inject runtime dependencies through `createPaymentClient({ runtime })` when needed. Defaults are sandbox hosts and a 30-second request timeout (`timeoutMs`). Merchant login is lazy and shared by concurrent refund requests on the same instance. Tokens refresh 60 seconds before expiry.

Checkout requires an order ID, idempotency key, positive KWD `Money` with at most three decimal places, and an HTTPS callback URL. By default it uses indirect payment type `0`, checkout version `2.0`. Optional customer fields on `HesabeCreatePaymentParams` are `hesabeName`, `hesabeEmail`, `hesabeMobileNumber` (eight digits without a country code), `hesabeVariable1` through `hesabeVariable5`, `hesabeWebhookUrl`, and `hesabeFailureUrl`. Direct Apple Pay reserves `variable5` for its merchant domain. The callback URL is also the failure URL by default. A config-level `webhookUrl` supplies the default notification URL.

## Checkout modes

Select a flow through `hesabeCheckoutMode`. Omission and `"redirect"` are equivalent, including when replaying an existing idempotency key.

| Mode | Encrypted provider fields | Customer next step |
| --- | --- | --- |
| `redirect` (default) | `version: "2.0"`, `paymentType: 0` | Existing `redirectUrl` and redirect action |
| `embedded` | `version: "3.0"`, `paymentType: 0`, `embeddedPayment: true` | `nextAction: { type: "hesabe_embedded_checkout", sessionId, environment }` |
| `applepay` | `version: "2.0"`, Apple Pay `paymentType`, merchant domain in `variable5` | `nextAction: { type: "hesabe_apple_pay", checkoutToken, environment, scriptUrl }` |

All three initialize a payment attempt: `outcome: "requires_action"`, `status: "pending"`, and a `checkout:` ID. Embedded and Apple Pay actions have no `redirectUrl`. `environment` is `"sandbox"` or `"production"`, derived from the adapter's `live` setting. Both retain the raw checkout token in `references.relatedIds.checkoutToken`.

### Embedded Hosted Checkout

Using the server-side client from Setup:

```ts
import { isHesabeEmbeddedCheckoutAction } from "@paykernel/gateway-hesabe";

const embedded = await payments.createPayment({
  amount: money("10.000", "KWD"),
  currency: "KWD",
  orderId: "order-embedded-123",
  idempotencyKey: "checkout-embedded-123",
  callbackUrl: "https://merchant.example/hesabe/callback",
  hesabeCheckoutMode: "embedded",
});
if (embedded.outcome === "indeterminate") {
  throw new Error("Checkout submission is uncertain; reconcile before retrying");
}
if (embedded.outcome !== "requires_action" || !isHesabeEmbeddedCheckoutAction(embedded.nextAction)) {
  throw new Error("Embedded checkout was not initialized");
}
const action = embedded.nextAction;
// Return action as JSON from your application's authenticated checkout endpoint.
```

Load the browser SDK and its required container on the merchant page:

```html
<div id="hesabe-payments"></div>
<script
  src="https://unpkg.com/@hesabe-pay/embedded-hosted-checkout@1.0.15/cdn/hesabe-payments.min.js"
  integrity="sha512-iqug3EYPLs4bLenHwhvvlIAXT65UcI+6cJZv19AK/MDBaOFFQbNV+Yyo2oYJ5KbDYOhiaVHf5wQz/zfCYAJdyQ=="
  crossorigin="anonymous"
></script>
```

Once that script loads, initialize it with `action` received from your backend:

```js
hesabePayment.init({
  environment: action.environment,
  sessionID: action.sessionId, // Hesabe's browser SDK uses a capital ID.
  paymentTypes: ["knet", "card", "applepay"], // Choose account-enabled methods.
  debug: false,
});
```

Without an SDK callback, completion returns to the configured success/failure URLs. If you provide a browser callback instead, confirm the reported transaction on your backend through enquiry before fulfillment. KNET still redirects to its payment page.

The [Hosted Checkout guide](https://developer.hesabe.com/docs/guides/embedded-payments/) specifies version `3.0` and a boolean `embeddedPayment`; its longer example still uses `2.0`. The adapter follows the parameter specification and never retries with a different version. Sandbox acceptance of this flow remains outstanding.

### Direct Apple Pay

Set `hesabeCheckoutMode: "applepay"` and `hesabeApplePayDomain` to the merchant page's whitelisted hostname. The adapter trims and lowercases DNS hostnames; URLs, paths, ports, and invalid DNS labels are rejected. Use punycode for internationalized hostnames.

`hesabeApplePayPaymentType` accepts `9` (MPGS, default), `10` (CYBS), `11` (KNET debit), `12` (KNET credit), `13` (KNET international), or `14` (AMEX international). Choose a type enabled on your account. Apple Pay fields on other modes, unsupported types, and an independently supplied `hesabeVariable5` throw `InvalidRequestError` before any request.

Using the server-side client from Setup:

```ts
import { isHesabeApplePayAction } from "@paykernel/gateway-hesabe";

const applePay = await payments.createPayment({
  amount: money("10.000", "KWD"),
  currency: "KWD",
  orderId: "order-applepay-123",
  idempotencyKey: "checkout-applepay-123",
  callbackUrl: "https://merchant.example/hesabe/callback",
  hesabeCheckoutMode: "applepay",
  hesabeApplePayDomain: "merchant.example",
  hesabeApplePayPaymentType: 9,
});
if (applePay.outcome === "indeterminate") {
  throw new Error("Apple Pay submission is uncertain; reconcile before retrying");
}
if (applePay.outcome !== "requires_action" || !isHesabeApplePayAction(applePay.nextAction)) {
  throw new Error("Apple Pay was not initialized");
}
const action = applePay.nextAction;
// Return action as JSON from your application's authenticated checkout endpoint.
```

The returned `scriptUrl` uses the configured Hesabe host and a URL-encoded checkout token. It is a script resource, not a navigation destination. On the verified merchant page, follow the [Direct Apple Pay guide](https://developer.hesabe.com/docs/guides/direct-apple-pay/):

```html
<script src="https://applepay.cdn-apple.com/jsapi/v1/apple-pay-sdk.js"></script>
<button id="apple-pay-btn" type="button" hidden>Pay with Apple Pay</button>
<p id="apple-pay-message" role="status"></p>
```

After the markup and Apple SDK are loaded, use `action` from your trusted backend:

```js
const button = document.getElementById("apple-pay-btn");
const message = document.getElementById("apple-pay-message");
const script = document.createElement("script");
script.src = action.scriptUrl;
script.onerror = () => {
  message.textContent = "Apple Pay could not load. Please try another payment method.";
};
script.onload = () => {
  const available = window.ApplePaySession && window.ApplePaySession.canMakePayments();
  if (!available || typeof window.handleApplePayClick !== "function") {
    message.textContent = "Apple Pay is unavailable. Please choose another payment method.";
    return;
  }
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await window.handleApplePayClick();
    } catch {
      message.textContent = "Apple Pay could not start. Please try another payment method.";
    }
  });
};
document.head.appendChild(script);
```

The action guards validate shape, not provenance. Only initialize scripts from your authenticated backend's response, and send checkout tokens as JSON rather than interpolating them into HTML. Keep creation credentials and encryption keys on the backend. For both embedded and direct Apple Pay, complete Hesabe account activation, domain whitelisting, and the domain-verification file setup described in the provider guides. Browser events alone are not payment confirmation; use the existing callback/enquiry or verified webhook flow.

The exported types are `HesabeCheckoutMode`, `HesabeApplePayPaymentType`, `HesabeEmbeddedCheckoutAction`, and `HesabeApplePayAction`. No browser SDK dependency is added to the adapter. These flows use `createPayment`; core's `hostedCheckout` capability remains `false` because the core Checkout Session API is not implemented.

## Confirming a payment

Pass the encrypted callback query parameter to `resolveCallback`:

```ts
const confirmed = await hesabe.resolveCallback({ data: encryptedCallbackData });
if (confirmed.outcome === "succeeded" && confirmed.status === "paid") {
  // Check confirmed.orderId and confirmed.amount against your order before fulfillment.
}
```

The callback's transaction token, order reference, amount, and result are checked against transaction enquiry. A checkout result has a `checkout:`-prefixed ID and `references.relatedIds.checkoutToken`; it is not a transaction token. Use the confirmed transaction ID for subsequent operations:

```ts
const latest = await hesabe.getPayment({ gatewayPaymentId: confirmed.gatewayId });
```

Unknown provider statuses require reconciliation. Never fulfill from a checkout redirect, a callback alone, or a successful HTTP response.

## Transaction enquiry details

`getTransactionEnquiry` was introduced in `0.2.0` and requires that version or newer.

Use the Hesabe-specific `getTransactionEnquiry` method when you need the provider's transaction details or an order-reference lookup:

```ts
const byToken = await hesabe.getTransactionEnquiry({
  token: confirmed.gatewayId, // confirmed transaction token, not a checkout ID
});
const byOrder = await hesabe.getTransactionEnquiry({
  orderReferenceNumber: "order-123",
  // signal: abortController.signal,
});

// data is always present; results is optional and may be empty.
const transactions = byOrder.results?.length ? byOrder.results : [byOrder.data];
for (const transaction of transactions) {
  // Match the order and amount before deciding how to reconcile each transaction.
  console.log(transaction.token, transaction.amount, transaction.status);
}
```

`HesabeTransactionEnquiryParams` accepts exactly one of `token` or `orderReferenceNumber`, plus optional `signal`. Empty identifiers, the URL dot segments `.` / `..`, malformed Unicode, both/neither selector, and `checkout:`-prefixed tokens throw `InvalidRequestError` before a request. The method is available on `payments.gateway("hesabe")`; it is a provider-specific API and does not invoke core operation hooks.

`HesabeTransactionEnquiryResult` contains `status: true`, optional `message`, required `data: HesabeEnquiryTransaction`, and optional `results: HesabeEnquiryTransaction[]`. It preserves provider field names, native status strings, nullable customer/card details, and result ordering. Amount strings retain their decimal precision after trimming; numeric provider amounts are validated and converted to decimal strings. Every returned transaction must match the requested token or order reference. The adapter returns every result and does not choose a successful payment. Use `getPayment` for the existing normalized payment result.

Handle an unknown token or order reference separately from an unavailable or malformed response:

```ts
import { ResourceNotFoundError } from "@paykernel/core";

try {
  await hesabe.getTransactionEnquiry({ orderReferenceNumber: "order-123" });
} catch (error) {
  if (error instanceof ResourceNotFoundError) {
    // No transaction was found. Retain any uncertain checkout reservation.
  } else {
    throw error;
  }
}
```

Provider rejection (`status: false`) throws `InvalidRequestError`; malformed details or identity mismatches throw `NetworkError`. HTTP 404 throws `ResourceNotFoundError`. Enquiries use the configured timeout, caller cancellation, and bounded GET retries, with no merchant login or encrypted request.

Token lookup uses `GET /api/transaction/{encoded-token}` with `accessCode` and `Accept: application/json` headers. Order lookup uses the encoded order reference and `?isOrderReference=1`. The [Hesabe guide](https://developer.hesabe.com/docs/guides/transaction-enquiry/) shows GET but asks for that flag in the request body; this adapter sends it as a query parameter because portable `fetch` cannot send a GET body. Successful order-reference interoperability remains unverified: the published sandbox identifiers returned HTTP 404 during planning. Complete the token/order equivalence check in the [sandbox checklist](./docs/sandbox-acceptance.md) before treating it as live-validated.

Enquiries only inspect provider state. They do not fulfill orders, clear uncertain reservations, or retry checkout/refund submissions.

## Webhooks

Use `payments.handleWebhook("hesabe", payload)` or call `verifyWebhookAsync(payload)` before `parseWebhookEvent(payload)`. Synchronous `verifyWebhook` always returns `false` because Hesabe does not document a webhook signature.

Async verification confirms token, order reference, KWD amount, and status through enquiry. This verifies transaction facts, not sender identity. Check that the order belongs to your application and that its amount matches before fulfillment. Mismatches return `false`; transport failures throw so the delivery can be retried. Unknown statuses are not accepted.

Events contain only the checked fields. Event IDs are deterministic across deliveries of the same facts. Payment success, failure, and processing dual-write the core `PaymentEvent`; untrusted timestamps and extra financial fields are ignored. Applications remain responsible for durable event deduplication.

## Refunds

```ts
const refund = await hesabe.refundPayment({
  gatewayPaymentId: confirmed.gatewayId,
  idempotencyKey: "refund-order-123-part-1",
  amount: money("2.500", "KWD"),
  currency: "KWD",
});
const latestRefund = await hesabe.getRefund({ gatewayRefundId: refund.gatewayRefundId });
```

Omit `amount` for a full refund. The adapter enquires the original successful transaction before submitting either kind of refund. An explicit amount uses the documented partial refund method `2`; full refunds use `1`. The provider remains authoritative about the remaining refundable balance.

An accepted request returns `pending`. A refund becomes completed only when its entity status is `1` and it has a valid `refund_at`. `totalRefunded` is omitted because the returned amount describes one refund, not a cumulative total. Look up only a returned numeric refund ID; an indeterminate submission may not have one.

## Retry and persistence contract

Every checkout and refund requires a stable `idempotencyKey` and the configured `IdempotencyStore`. Production deployments need a shared durable store whose `reserve()` is atomic across workers. `InMemoryIdempotencyStore` protects only one process and loses records on restart.

The adapter fingerprints effective provider parameters, rejects changed parameters or concurrent requests under the same key, and replays completed results. Eligible GET failures use the SDK’s bounded retry policy (up to three attempts, with backoff and Retry-After). It never automatically resubmits a checkout or refund. A failure after submission can return `indeterminate` with `reconciliationRequired: true`; its reservation stays blocked. A local persistence failure after provider acceptance also requires reconciliation.

Changing checkout mode, Apple Pay type, or merchant domain rejects reuse of the same key. Persist the returned `redirectUrl` or browser `nextAction`; replay returns the same initialization data. An uncertain result must not trigger a second checkout in a different mode.

Retain uncertain reservations beyond your retry horizon; do not let a generic TTL reopen an unresolved payment or refund. Reconcile with Hesabe and your order records before clearing a reservation or choosing a new mutation key. If a checkout response was lost, an order-reference enquiry may locate resulting transactions. An absent match does not make another submission safe, and merchant-side investigation may still be needed.

## Supported capabilities

The adapter claims `payments`, `immediateCapture`, `refunds`, and `partialRefunds`. It does not support separate authorization/capture, voids, stored payment methods, customers, recurring payments, splits, disputes, payment links, or the core Checkout Session API.

## Provider references and sandbox validation

Protocol references: [indirect integration](https://developer.hesabe.com/docs/guides/hesabe-indirect-integration/), [transaction enquiry](https://developer.hesabe.com/docs/guides/transaction-enquiry/), [webhooks](https://developer.hesabe.com/docs/guides/webhook-integration/), [merchant login](https://developer.hesabe.com/docs/api/post-merchant-login/), [refund requests](https://developer.hesabe.com/docs/api/post-refund-request/), and [refund details](https://developer.hesabe.com/docs/api/get-refund-details/).

Crypto uses AES-256-CBC with PKCS#7 padding and hex encoding, matching the official JavaScript example. The [encryption guide](https://developer.hesabe.com/docs/guides/encryption-library/) also includes a PHP example that pads plaintext to 32-byte boundaries; that can differ from standard AES block padding for some message lengths. An official published refund fixture is covered by an offline test, but live sandbox interoperability has not been validated. Complete the [sandbox acceptance checklist](./docs/sandbox-acceptance.md) before production use.

MIT licensed.
