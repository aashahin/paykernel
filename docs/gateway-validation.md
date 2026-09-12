# Gateway validation

PayKernel has been exercised against real provider sandbox accounts as well as mocks. On **2026-09-11**, the deployed payment lab completed Paymob payments and refunds, and a Moyasar card payment with 3-D Secure. These used provider APIs, hosted payment pages, and authenticated payment inquiries with test credentials; they did not move production funds.

## Recorded provider results

Results below describe the checks actually completed, not every capability an adapter exposes.

| Gateway | Account test result | Verified scope | Still unverified in the recorded run |
| --- | --- | --- | --- |
| **Paymob** | **Sandbox payments and refunds completed** | Hosted checkout; EGP 10.00 and EGP 30.00 payments; EGP 5.00 partial refund and EGP 30.00 full refund; authenticated inquiry; reconciliation to paid/refunded totals; repeat reconciliation without double counting | Other payment methods, currencies, and separate authorization/capture/void flows |
| **Moyasar** | **Sandbox card payment completed** | Real tokenization; payment creation; successful provider 3-D Secure emulator; buyer return; SAR 10.00 paid status confirmed by provider inquiry and the app; repeat reconciliation without changing captured totals | Provider refunds, manual capture/void, other payment methods, and a complete provider-webhook round trip |
| **Stripe** | **Account authentication and webhook setup checked** | Test API key authenticated through Stripe CLI; a dedicated test webhook endpoint registered in the matching account | Completed buyer checkout, delivered provider callbacks, and refunds |
| **PayPal** | **Sandbox authentication and webhook configuration checked** | Sandbox authentication succeeded; the configured webhook ID resolved to the lab endpoint | Completed buyer checkout, delivered provider callbacks, and refunds |
| **MyFatoorah** | **Supplied account credentials blocked testing** | Original and replacement tokens returned HTTP 401; an official public sandbox credential succeeded in a separate control check | Checkout, settlement, and refunds with the supplied merchant account |
| **Hesabe** | **Sandbox configuration only** | Settings matched the official published sandbox credentials | Account checkout, transaction enquiry, callbacks, and refunds; the sandbox acceptance checklist remains open |
| **Tap** | **No account test recorded** | No account credentials were available | All account-backed payment flows |

Authentication or registering a webhook is a narrower check than completing a payment or receiving a provider callback. No production-account payment test is claimed here.

## What the payment lab verified

The [payment lab validation record](https://github.com/aashahin/paykernel/blob/main/apps/payment-lab/VALIDATION.md) contains the dated results, deployed versions, and payment/reconciliation observations.

Paymob testing exposed intention/transaction reference mismatches and different authentication requirements for transaction inquiries. After recovery, the app agreed with provider-confirmed paid and refunded amounts. Full and partial refunds moved from pending to completed through reconciliation, with repeated inquiry preserving the recorded totals.

Moyasar testing exposed a token-response field mismatch and a paid-sale response whose separate manual-capture amount was zero. The lab corrected token handling and normalized authenticated paid-sale evidence, then completed the provider's 3-D Secure flow and confirmed settlement.

These are results for the deployed **SDK plus payment-lab integration**, including its checkout handling and settlement normalization. They do not establish that every standalone SDK method, every release, or every merchant configuration has passed account testing. The Moyasar successful run used lab deployment `222dfeef-430f-43e8-bb71-fbb9a62f9c79`.

## Automated coverage alongside account testing

The lab also ran a signed HTTP simulator matrix on **2026-09-10**: 24 scenarios across seven gateways, with **156 passed, 12 unsupported, and 0 failed** on the public Worker. This covers simulated callbacks, refunds, lost responses, reconciliation, and scheduled recovery. Those counts are **simulator results**, not 156 provider payments.

Mock gateway and conformance suites remain useful for repeatable failure-path and contract checks. Account tests complement them by checking actual provider responses and checkout behavior. A full provider-account scenario matrix for all seven gateways remains incomplete.

## Before adopting a gateway

Use the row above to identify which paths have account evidence. Complete the remaining checkout, callback, refund, and recovery checks with your own sandbox configuration before enabling production payments. For Hesabe, follow its [sandbox acceptance checklist](https://github.com/aashahin/paykernel/blob/main/packages/gateway-hesabe/docs/sandbox-acceptance.md).
