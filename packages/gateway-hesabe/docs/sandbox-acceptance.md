# Hesabe sandbox acceptance

Offline tests cover documented fixtures and simulated failures. They do not establish live merchant-account compatibility. Use sandbox credentials supplied by Hesabe, keep them outside source control, and record sanitized results for these checks:

1. Create a KWD checkout, inspect the hosted redirect, and complete successful and failed payments. Confirm encryption works across several payload lengths, especially around 16-byte block boundaries. The provider's JavaScript and PHP padding examples differ.
2. Resolve encrypted callbacks and confirm transaction enquiry agrees on token, order, amount, and status. Verify the checkout token cannot be used as a transaction token.
3. Receive a real webhook. Verify enquiry confirmation, rejection of changed order/amount/status, and one fulfillment across repeated deliveries.
4. Submit full and partial refunds. Confirm the merchant account accepts method `1` for full and `2` for partial, and that acceptance remains pending until refund details show completion. Check remaining-balance rejection with Hesabe.
5. Exercise token expiry and refresh on the merchant API. Confirm invalid refresh credentials lead to one fresh login while outages do not.
6. Drop a checkout or refund response after submission. Confirm an indeterminate result and a retained reservation, with no automatic second POST. Reconcile the provider state before any manual retry.
7. Run two application instances against the production-intended atomic store. Confirm one provider submission for a shared key, completed replay, changed-parameter rejection, and durable uncertain reservations across restarts.

Capture merchant confirmation for any undocumented response variants before changing parsing or status mappings. Do not record passwords, access codes, encryption keys, bearer tokens, or customer card data in acceptance evidence.
