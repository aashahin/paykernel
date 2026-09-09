# Webhooks

Tap POSTs the charge / authorize / refund JSON to `post.url` (`webhookUrl` config or `tapPostUrl`). Verification is **not** HMAC-of-raw-body.

Charge / authorize / refund canonical string:

```text
x_id{id}x_amount{isoAmount}x_currency{currency}x_gateway_reference{gatewayOrEmpty}x_payment_reference{payment}x_status{status}x_created{created}
```

Invoice canonical string (Tap invoice formula; `x_updated`, not gateway/payment reference):

```text
x_id{id}x_amount{isoAmount}x_currency{currency}x_updated{updated}x_status{status}x_created{created}
```

HMAC-SHA256 hex with the **secret API key**, compared to the `hashstring` header (`timingSafeEqualHex`). Amount must be ISO-padded (`1.00` SAR / USD, `1.200` KWD). Missing or non-hex `hashstring`, a payload that cannot supply those fields, and a missing `object` or an `object` other than `charge` / `authorize` / `refund` / `invoice`, fail closed (`verifyWebhook` → `false`).

Tests lock Tap’s published Create-a-Charge `hashstring` header (docs example secret + posted charge JSON). Unpadded amount `1` does not match that vector.

Charge webhooks set `gatewayPaymentId` to the `chg_…` id. Auth/capture merchants must also match `reference.order` / `metadata.paymentId`: capture settlement is a **charge** object (`chg_…`), not the original `auth_…`. An authorize `CAPTURED` webhook with `charge_id` sets `gatewayPaymentId` to that `chg_…` id. Authorize objects may also carry `relatedIds.chargeId` when `charge_id` is present. `paymentId` is `metadata.paymentId`, then `metadata.orderId`, then `reference.order`. **`metadata.udf1` is not a payment id** (Tap uses udf1 as a free-form metadata slot).

Invoice objects stay native (`type: invoice.<status>`, `event.type: provider.unmapped`, no `stableType`) with `gatewayPaymentId` set to the invoice id. `status` is always `processing` as a nonterminal placeholder, not invoice/payment state; inspect `rawPayload.status` or the related charge events for settlement. Missing `id` or `created` is `InvalidRequestError`. Do not fulfill against invoices.

Migration: Tap event `id` is now the raw object id plus a signed-snapshot digest (`tapWebhookEventId`). Stored old Tap inbox keys may redeliver once; application handlers should retain business idempotency.

Refund objects use the charge/authorize hashstring field formula when those fields exist. Tap’s official table lists charge / authorize / invoice.

Fulfill only after an inbox **claim** and `status === "paid"` / `isPaidOutcome`. Partial capture (`partially_captured`) is not `isPaidOutcome`. `handleWebhook` only verifies and normalizes.
