---
"@paykernel/gateway-hesabe": minor
---

Add `getTransactionEnquiry` for lookup by confirmed transaction token or order reference, with exported parameter, result, and transaction-detail types. Return validated provider details and all ordered results while preserving the normalized `getPayment` API.

Document the order-reference query flag, multiple-result handling, error behavior, and sandbox checks required to validate token/order-reference equivalence.
