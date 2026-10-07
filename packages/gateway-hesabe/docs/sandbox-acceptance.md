# Hesabe sandbox acceptance

Offline tests cover documented fixtures and simulated failures. They do not establish live merchant-account compatibility. Use sandbox credentials supplied by Hesabe, keep them outside source control, and record sanitized results for these checks:

1. Create a KWD checkout, inspect the hosted redirect, and complete successful and failed payments. Confirm encryption works across several payload lengths, especially around 16-byte block boundaries. The provider's JavaScript and PHP padding examples differ.
2. Resolve encrypted callbacks and confirm transaction enquiry agrees on token, order, amount, and status. Verify the checkout token cannot be used as a transaction token.
3. For the same completed transaction, call `getTransactionEnquiry({ token })` and `getTransactionEnquiry({ orderReferenceNumber })`. Confirm both identify the same token, order reference, amount, and status, and preserve documented IDs and nullable details. Confirm order-reference lookup succeeds with `?isOrderReference=1`; capture the sanitized request URL, HTTP status, and matching response fields. If an order has multiple transactions, verify every result belongs to it and the adapter retains provider ordering without selecting a successful payment. Check missing and empty `results` variants if the sandbox returns them. Do not mark order-reference interoperability validated until this equivalence check succeeds.
4. Receive a real webhook. Verify enquiry confirmation, rejection of changed order/amount/status, and one fulfillment across repeated deliveries.
5. Submit full and partial refunds. Confirm the merchant account accepts method `1` for full and `2` for partial, and that acceptance remains pending until refund details show completion. Check remaining-balance rejection with Hesabe.
6. Exercise token expiry and refresh on the merchant API. Confirm invalid refresh credentials lead to one fresh login while outages do not.
7. Drop a checkout or refund response after submission. Confirm an indeterminate result and a retained reservation, with no automatic second POST. Use order-reference enquiry to look for resulting transactions; an absent match must not release the reservation or trigger another submission. Reconcile the provider state before any manual retry.
8. Run two application instances against the production-intended atomic store. Confirm one provider submission for a shared key, completed replay, changed-parameter rejection, and durable uncertain reservations across restarts.

The [Hesabe transaction-enquiry guide](https://developer.hesabe.com/docs/guides/transaction-enquiry/) shows GET but asks for the order-reference flag in the request body. The adapter uses a query parameter because portable `fetch` cannot send a GET body. The published sandbox sample token and order reference returned HTTP 404 during planning; this establishes neither a successful token lookup nor successful order-reference transport.

Capture merchant confirmation for any undocumented response variants before changing parsing or status mappings. Do not record passwords, access codes, encryption keys, bearer tokens, or customer card data in acceptance evidence.
