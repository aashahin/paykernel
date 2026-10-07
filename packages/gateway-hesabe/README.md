# @paykernel/gateway-hesabe

Hesabe adapter for `@paykernel/core`, supporting KWD hosted payments, transaction enquiry, confirmed callbacks, enquiry-verified webhooks, and full/partial refunds. Register it as an external adapter; it does not extend core's built-in gateway names.

This documentation describes adapter version `0.2.0`. Live sandbox interoperability has not been validated — complete the [sandbox acceptance checklist](./docs/sandbox-acceptance.md) before production use.

## Setup

```sh
bun add @paykernel/core @paykernel/gateway-hesabe@0.2.0
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

Checkout requires an order ID, idempotency key, positive KWD `Money` with at most three decimal places, and an HTTPS callback URL. It uses indirect payment type `0`, checkout version `2.0`. Optional fields on `HesabeCreatePaymentParams` are `hesabeName`, `hesabeEmail`, `hesabeMobileNumber` (eight digits without a country code), `hesabeVariable1` through `hesabeVariable5`, `hesabeWebhookUrl`, and `hesabeFailureUrl`. The callback URL is also the failure URL by default. A config-level `webhookUrl` supplies the default notification URL.

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

Retain uncertain reservations beyond your retry horizon; do not let a generic TTL reopen an unresolved payment or refund. Reconcile with Hesabe and your order records before clearing a reservation or choosing a new mutation key. If a checkout response was lost, an order-reference enquiry may locate resulting transactions. An absent match does not make another submission safe, and merchant-side investigation may still be needed.

## Supported capabilities

The adapter claims `payments`, `immediateCapture`, `refunds`, and `partialRefunds`. It does not support separate authorization/capture, voids, stored payment methods, customers, recurring payments, splits, disputes, payment links, or the core Checkout Session API.

## Provider references and sandbox validation

Protocol references: [indirect integration](https://developer.hesabe.com/docs/guides/hesabe-indirect-integration/), [transaction enquiry](https://developer.hesabe.com/docs/guides/transaction-enquiry/), [webhooks](https://developer.hesabe.com/docs/guides/webhook-integration/), [merchant login](https://developer.hesabe.com/docs/api/post-merchant-login/), [refund requests](https://developer.hesabe.com/docs/api/post-refund-request/), and [refund details](https://developer.hesabe.com/docs/api/get-refund-details/).

Crypto uses AES-256-CBC with PKCS#7 padding and hex encoding, matching the official JavaScript example. The [encryption guide](https://developer.hesabe.com/docs/guides/encryption-library/) also includes a PHP example that pads plaintext to 32-byte boundaries; that can differ from standard AES block padding for some message lengths. An official published refund fixture is covered by an offline test, but live sandbox interoperability has not been validated. Complete the [sandbox acceptance checklist](./docs/sandbox-acceptance.md) before production use.

MIT licensed.
