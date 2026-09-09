<!-- auto-generated; do not hand-edit -->

# Gateway capabilities

This matrix is **generated from code** (built-in capability claims on
gateway manifests). Do not edit by hand — regenerate with:

```bash
bun run docs:capabilities
```

## Providers

- **Stripe** (`stripe`) `1.0.0`
- **Moyasar** (`moyasar`) `1.0.0`
- **PayPal** (`paypal`) `1.0.0`
- **Paymob** (`paymob`) `1.0.0`

## Capability matrix

Cells are `✓` when the adapter **claims** the capability on its
`GatewayManifest.capabilities` / instance snapshot, otherwise `✗`.
Claims are conservative: method presence alone does not imply `true`.

| Capability | Stripe | Moyasar | PayPal | Paymob |
| --- | --- | --- | --- | --- |
| payments | ✓ | ✓ | ✓ | ✓ |
| immediateCapture | ✓ | ✓ | ✓ | ✓ |
| authorization | ✓ | ✓ | ✓ | ✓ |
| partialCapture | ✓ | ✓ | ✓ | ✓ |
| refunds | ✓ | ✓ | ✓ | ✓ |
| partialRefunds | ✓ | ✓ | ✓ | ✓ |
| voids | ✓ | ✓ | ✓ | ✓ |
| hostedCheckout | ✓ | ✗ | ✗ | ✗ |
| tokenization | ✗ | ✗ | ✗ | ✗ |
| customers | ✓ | ✗ | ✗ | ✗ |
| paymentMethods | ✓ | ✗ | ✗ | ✗ |
| marketplaceSplits | ✗ | ✓ | ✗ | ✗ |
| disputes | ✓ | ✗ | ✗ | ✗ |
| paymentLinks | ✓ | ✗ | ✗ | ✗ |
| providerRecurring | ✗ | ✗ | ✗ | ✗ |

## Key notes

- **partialCapture** / **partialRefunds**: optional `amount` on
  `capturePayment` / `refundPayment`. Omitting `amount` is a full
  capture/refund and does not require the partial flag.
- **PayPal partialCapture**: claimed `true` because authorization
  captures accept `amount` when `paypalCaptureType: "authorization"`.
  PayPal order captures reject amount; callers must use
  `paypalCaptureType: "authorization"` (authorize-then-capture).
- **hostedCheckout**: first-class `createCheckoutSession` (Stripe Checkout
  Session product), not every provider redirect URL.
- **marketplaceSplits**: create-time split / transfer surface (e.g. Moyasar
  `splits`).
- **providerRecurring**: extension-only; default `false`. Checkout
  subscription mode alone does not force `true`.
- **customers** / **paymentMethods**: Stripe implements first-class
  Customer create/get and PaymentMethod attach/list/detach. Other
  built-ins stay false until they expose the same surface.
- **disputes**: Stripe implements get/list/submit evidence. Other
  built-ins stay false (PayPal Customer Dispute webhooks still dual-write).
- **paymentLinks**: Stripe Payment Links product only. Not Checkout
  Sessions and not PayPal Pay Links.
- **tokenization**: claimed only when the adapter exposes first-class
  setup / save-payment-method APIs. Stripe `tok_…` on attach is
  `paymentMethods`, not this key (built-ins stay false).

## Inspecting support at runtime

```ts
import { createPaymentClient, stripeGateway } from "@paykernel/core";

const client = createPaymentClient({
  gateways: { stripe: stripeGateway({ /* closed-over credentials */ }) },
  defaultGateway: "stripe",
});

const gateway = client.gateway("stripe");
if (gateway.supports("partialRefunds")) {
  // partial amount is a viable path on this adapter
}
```
