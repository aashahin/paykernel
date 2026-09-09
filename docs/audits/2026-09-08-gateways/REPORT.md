# Gateway integration audit — 2026-09-08

Audited revision: `1ee2fd7cddda98ead161baf40a91526b13683fa4` on `main`.

The audit found **nine reproducible implementation defects and one test coverage finding**. The highest priorities are MyFatoorah replay/concurrency protection and Tap webhook deduplication. No production files were changed.

Scope: Stripe, PayPal, Paymob, Moyasar, Tap, MyFatoorah, and the shared types, validation, operation-result mapping, and webhook inbox paths involved in those integrations. Three read-only reviews used the requested OpenCode Go model, `opencode-go/muse-spark-1.3-contributor`, through the OpenCode workers MCP bridge. Codex checked the findings against source, current official documentation, compiler behavior, and local execution. One earlier provider-rate-limited review failed without a patch and was replaced after termination. All workers are stopped; no worker patches were applied.

The executable probes inject synthetic provider responses into actual gateway/client/inbox code. Their signatures use local fixture secrets. They prove the local behavior described below; they are **not live or sandbox payment tests**, and no provider account configuration or financial settlement was tested.

## Findings

P1 means prioritize before relying on the affected payment flow. P2 means a concrete correctness or verification problem with a narrower trigger. Severity describes potential impact under the stated conditions, not evidence of an actual customer incident.

| ID | Priority | Integration | Defect |
| --- | --- | --- | --- |
| F1 | P1 | MyFatoorah | Paid-invoice replay comparison always rejects a mapped Money amount |
| F2 | P1 | MyFatoorah | Concurrent creates with the same key can both submit outside KWT/SAU |
| F3 | P1 | Tap + webhook inbox | Object ID deduplication drops later status changes |
| F4 | P2 | Tap | Declined partial capture becomes `partially_captured` |
| F5 | P2 | Moyasar | Advertised AFT fields are rejected before HTTP |
| F6 | P2 | Moyasar | 3DS next action violates the documented normalized shape |
| F7 | P2 | PayPal | Equivalent public entry points disagree on provider parameter types |
| F8 | P2 | Tap | Paid invoice webhook is reported as cancelled |
| F9 | P2 | MyFatoorah | Raw byte webhook verification rejects an otherwise valid body |
| F10 | P2 | Test coverage | Most selected gateway tests are skipped; the run also fails |

### F1 — MyFatoorah paid-invoice replay comparison cannot succeed

Location: [gateway.ts](../../../packages/gateway-myfatoorah/src/gateway.ts), `replayInvoiceMatchesRequest`, lines 841–858; [money.ts](../../../packages/gateway-myfatoorah/src/money.ts), lines 42–54.

`mapGetPaymentResult` supplies `mapped.amount` as a `Money` object. Line 855 passes it into `parseMyFatoorahAmount`, which accepts only a number or decimal string. The exception is caught and converted to `false`. Matching paid invoices therefore never pass this check.

**Trigger and effect:** repeat a create for a stable CustomerReference whose inquiry returns a paid invoice with the same amount and currency. In KWT/SAU the optional replay lookup falls through to a new create request. Native idempotency can still suppress that request during its retention window; after expiry this loses the intended duplicate-invoice protection. Outside KWT/SAU the matching paid invoice instead returns `indeterminate`, making successful replay recovery nonfunctional.

MyFatoorah documents native idempotency only in KWT/SAU, with a 250-minute retention window. The duplicate-creation consequence after expiry is an inference from that contract and the observed extra POST. [Official idempotency documentation](https://docs.myfatoorah.com/docs/idempotency). Paid inquiry interpretation was checked against the [official payment inquiry documentation](https://docs.myfatoorah.com/docs/payment-inquiry).

**Evidence:** probes `myfatoorah_paid_replay_KWT` and `myfatoorah_paid_replay_ARE` use a paid invoice for 10 KWD and a matching request. KWT performs inquiry plus `/v3/payments`; ARE returns `indeterminate` with the existing invoice ID.

**Repair:** compare `toMinorUnits(mapped.amount)` directly after currency validation. Add matching-paid replay checks for both country branches, including post-expiry behavior in KWT/SAU.

### F2 — MyFatoorah concurrent same-key creates bypass the lookup guard

Location: [gateway.ts](../../../packages/gateway-myfatoorah/src/gateway.ts), lines 279–379 and 628–633; [idempotency documentation](../../../packages/gateway-myfatoorah/docs/idempotency.md).

Outside KWT/SAU, create performs a CustomerReference inquiry and then submits a payment if no invoice exists. There is no atomic reservation or serialization between those operations, and the mutation omits `Idempotency-Key`. Two calls with the same order and key can both observe no invoice and both create one. Requiring a key does not make this lookup-and-submit sequence atomic.

**Evidence:** `myfatoorah_concurrent_same_key_create` synchronizes two inquiry responses before allowing either call to proceed, using ARE configuration. It observes two `/v3/payments` calls, both without the header, and two distinct returned invoice IDs. The probe proves duplicate submissions; charging both depends on payment source/customer completion.

The country restriction agrees with the [official idempotency contract](https://docs.myfatoorah.com/docs/idempotency). The local documentation explicitly discusses caller locking for refunds, but does not establish equivalent protection for concurrent creates.

**Repair:** require and document a caller-side distributed reservation/lock per payment attempt outside native-idempotency countries, or provide an atomic shared-store integration and persist the result. A process-local mutex alone would leave multiple application instances exposed. Verify simultaneous same-key calls across the supported deployment model.

### F3 — Tap webhook inbox drops later statuses for the same object

Location: [Tap gateway.ts](../../../packages/gateway-tap/src/gateway.ts), lines 454–455; [event-key.ts](../../../packages/webhooks/src/event-key.ts), lines 70–76; [memory-store.ts](../../../packages/webhooks/src/memory-store.ts), completed-entry claim behavior.

Tap sets the normalized event ID to the charge/authorize/refund object ID. The inbox assumes non-Paymob event IDs identify unique events and leaves that ID unchanged. Once processing completes, a later status snapshot for the same object is treated as an already-completed delivery, even if its payload hash differs.

**Evidence:** `tap_authorize_void_inbox` signs and verifies `AUTHORIZED` and `VOID` snapshots for the same authorize ID, then runs them through the real inbox engine. Outcomes are `processed`, then `duplicate_completed`; the handler sees only `AUTHORIZED`. This can leave an application's authorization state stale after a void.

Tap's official documentation describes notifications for object status changes and provides an authorize webhook with the authorize object ID. This is not a claim that Tap posts an `INITIATED` charge webhook: that page explicitly excludes that case. [Official webhook documentation](https://developers.tap.company/docs/webhook).

**Repair:** derive a Tap-specific event identity from canonical authenticated object kind, object ID, and the relevant status/version fields. Preserve deduplication for repeated delivery of the same transition. Test authorize/void and asynchronous refund transitions through the actual inbox, not only the gateway parser.

### F4 — Tap partial capture overwrites the provider's decline

Location: [gateway.ts](../../../packages/gateway-tap/src/gateway.ts), lines 223–239.

When the requested capture is smaller than the authorized amount, the adapter unconditionally replaces the mapped response with `status: partially_captured` and `outcome: requires_action`. It also drops decline and redirect details. This happens regardless of whether the provider captured anything.

**Evidence:** `tap_declined_partial_capture` retrieves a 10.50 SAR authorization and receives `DECLINED` for a 5 SAR capture. The returned result is `partially_captured` / `requires_action`, with no decline information. Consumers receive false capture state, although the outcome does not claim full payment success.

The requested partial amount itself is valid under Tap's [official authorize-and-capture flow](https://developers.tap.company/docs/authorize-and-capture); the defect is in response mapping.

**Repair:** apply partial-capture normalization only after confirmed capture. Preserve declined, failed, indeterminate, and customer-action responses, including their associated details.

### F5 — Moyasar AFT is advertised but unreachable through validation

Location: [validation.ts](../../../packages/core/src/types/validation.ts), lines 398–406; [payment.types.ts](../../../packages/core/src/types/payment.types.ts), lines 251–254; [moyasar.gateway.ts](../../../packages/core/src/gateways/moyasar/moyasar.gateway.ts), lines 537 onward; [Moyasar guide](../../../packages/core/docs/moyasar.md), lines 255 onward.

Public types and documentation accept AFT `recipient` and `sender` fields, and the request builder contains forwarding branches for them. However, the strict create schema declares neither field. Validation rejects them before those branches can run.

**Evidence:** `moyasar_aft_schema` calls the actual gateway with an advertised recipient object and gets `unrecognized_keys: recipient`, without making a request. `sender` is missing from the same schema. Enabling AFT on the merchant account cannot fix this local rejection.

Moyasar exposes these fields in its [official create-payment API](https://docs.moyasar.com/api/payments/01-create-payment). This is a confirmed nonworking advertised use case, not merely an unsupported provider feature.

**Repair:** add the recipient/sender schemas with the provider's field constraints and verify the serialized request. Alternatively remove the public support claim until implemented.

### F6 — Moyasar 3DS next action has the wrong normalized shape

Location: [moyasar.gateway.ts](../../../packages/core/src/gateways/moyasar/moyasar.gateway.ts), lines 1994–2003; [payment.types.ts](../../../packages/core/src/types/payment.types.ts), lines 396–410.

The documented redirect action is `{ type: 'redirect', url: ... }`. An initiated credit-card challenge instead emits `{ type: 'redirect_to_url', redirectUrl: ... }`, hidden behind `as unknown as RedirectPaymentNextAction`. The operation-result mapper forwards this incompatible action unchanged.

**Evidence:** `moyasar_3ds_action` injects an initiated response with `source.type: creditcard` and `transaction_url`. Both the gateway's next action and the mapped operation's action use the wrong shape. The top-level `redirectUrl` remains correct, so applications using that field can still redirect; consumers following the documented normalized action cannot reliably dispatch it.

The provider response fields match the [official create-payment API](https://docs.moyasar.com/api/payments/01-create-payment). The incompatible discriminator is introduced by Paykernel, not required by Moyasar.

**Repair:** return the normalized redirect object without the cast. The unused `mapNextActionLegacy` method at line 2221 already contains the documented redirect shape; consolidate the implementation rather than retaining divergent mappers.

### F7 — PayPal public types disagree with the runtime provider schema

Location: [paypal.gateway.ts](../../../packages/core/src/gateways/paypal/paypal.gateway.ts), lines 537–544 and schema selection at line 664; [client.ts](../../../packages/core/src/client.ts), createPayment overloads.

`PayPalGateway.createPayment` exposes common `CreatePaymentParams`, while its runtime implementation supports `PayPalCreatePaymentParams`, including `returnUrl`. The explicit named-gateway facade overload accepts that field, but the default-gateway facade and `client.gateway('paypal').createPayment` expose the narrower method type.

**Evidence:** [paypal-types.ts](./paypal-types.ts) contains three equivalent calls. The explicit `'paypal'` call compiles. The other two produce TS2353 for `returnUrl`; [compiler output](./paypal-types.log) records both errors. This is a compile-time API defect, not evidence of a provider HTTP rejection.

**Repair:** expose the provider-specific parameter signature consistently and add a public declaration/type test comparing all three entry points.

### F8 — Tap invoice PAID is reported as cancelled

Location: [webhook-map.ts](../../../packages/gateway-tap/src/webhook-map.ts), lines 112–119; [local webhook guide](../../../packages/gateway-tap/docs/webhooks.md).

Every invoice webhook gets `status: cancelled`, including `PAID`. The local guide deliberately avoids treating invoice events as payment-fulfillment events, but that policy is implemented by asserting an unrelated terminal state. An application consuming the normalized status can cancel a paid invoice/order.

**Evidence:** `tap_paid_invoice` sends an authenticated invoice `PAID` payload through `createPaymentClient().handleWebhook`; the result has native type `invoice.PAID` and normalized status `cancelled`. Tap documents `PAID` separately from `CANCELLED`. [Official invoice status reference](https://developers.tap.company/reference/invoices).

**Repair:** explicitly preserve an unsupported/native invoice event without inventing a cancellation, or implement a distinct invoice-state contract. This finding does not require treating an invoice webhook as sufficient evidence to fulfill a charge.

### F9 — MyFatoorah raw byte webhook input fails verification

Location: [webhooks.ts](../../../packages/gateway-myfatoorah/src/webhooks.ts), lines 100–117.

`coerceWebhookPayload` JSON-decodes strings only. A `Uint8Array`, including a Node Buffer, passes through as an object without the expected event fields, so canonicalization/signature verification fails.

**Evidence:** `myfatoorah_raw_bytes` uses the same authentic payload and signature: the string verifies successfully; its UTF-8 bytes fail. This affects direct gateway/helper callers supplying a raw byte body. Paths that parse JSON or convert it to a string first avoid the problem.

**Repair:** decode supported byte bodies before JSON parsing, then apply the same canonicalization. Verify string, Buffer, and Uint8Array inputs against the same signature and retain rejection of malformed bodies.

### F10 — The gateway test inventory substantially overstates executed coverage

Location examples: [Stripe gateway tests](../../../packages/core/src/gateways/stripe/stripe.gateway.test.ts), line 73 (`describe.skip`); [PayPal gateway tests](../../../packages/core/src/gateways/paypal/paypal.gateway.test.ts), line 156 (`describe.skip`); [Tap tests](../../../packages/gateway-tap/src/gateway.test.ts) and [MyFatoorah tests](../../../packages/gateway-myfatoorah/src/gateway.test.ts), many `it.skip` cases.

After installing locked dependencies and building core/testkit, the selected run returned **475 pass, 836 skip, 12 fail**, across 38 files, with 1,663 expectations. The primary Stripe suite skipped 236 cases and PayPal skipped 202. The MyFatoorah gateway file skipped 86 cases; the Tap gateway file skipped 79 and passed 7.

The 12 failures are in Moyasar tests. Inspection found stale inputs such as `tokenId`, numeric values where Money is now expected, and precision errors thrown while arranging the test. Those failures are not independently counted as 12 provider-integration defects. They show the current suite does not cleanly verify the advertised behavior. Passing structural/conformance fixtures also does not establish provider compatibility.

**Repair:** migrate stale cases to current public inputs, remove skips as each behavior is verified, and ensure CI reports and gates on the relevant executed suites. Add regressions for F1–F9; preserve the distinction between offline tests and provider sandbox smoke tests.

## Additional concerns and rejected hypotheses

- **Tap refund-history fallback — conditional concern:** [refund-support.ts](../../../packages/gateway-tap/src/refund-support.ts), lines 32–45 and 148–149, sums every nested refund amount without examining status. If a charge supplies a history containing failed refunds and omits direct remaining/refunded totals, those failures reduce the inferred refundable balance. Official docs distinguish failed/declined/rejected refunds from completed refunds. The helper defect is visible, but this audit did not establish that the relevant charge response actually includes failed entries in that shape, so it is not included among the nine reproduced defects. Obtain a representative response and test before changing aggregation. [Official refund states](https://developers.tap.company/reference/refunds).
- **Paymob currency exponent:** a claimed OMR scaling bug was not established. Provider prose uses “cents” loosely and the SDK has currency-exponent overrides. Confirm a numeric request/settlement example for the specific Paymob regional product before claiming a 10× error.
- **Paymob callback configuration:** using one callback URL for browser redirection and server notification is restrictive, but one endpoint can handle both methods. The official API distinguishes the destinations; this is a configuration improvement, not a demonstrated authentication bypass. [Official Paymob FAQ](https://developers.paymob.com/paymob-docs/need-help/faqs).
- **Paymob HMAC alias ambiguity:** no verified forgery was demonstrated. The worker hypothesis alone is insufficient to label this exploitable.
- **Stripe customer payment-method listing:** rejected the claim that the SDK must always send `type`; the current official API marks it optional. [Official customer payment-method list](https://docs.stripe.com/api/payment_methods/customer_list).
- **Stripe Payment Links:** rejected the claim that `price_data` is inherently invalid; it exists in the current official create API. [Official Payment Link creation](https://docs.stripe.com/api/payment-link/create).
- **Moyasar token 3DS:** rejected the broad claim that token-created challenges lose every redirect URL. The top-level redirect is preserved for the credit-card-shaped challenge response. F6 isolates the actual normalized-action mismatch.
- **Intentional unsupported features:** raw-card rejection, explicit unsupported-capability errors, and fixture/mock responses were not classified as fake integrations. Paymob's provisional create IDs and requirement to use a transaction ID for later operations are documented workflow constraints, not proof that the adapter never works.

No definite Stripe or Paymob functional defect survived this audit's verification threshold. That is not a clean bill of health: large skipped suites and the absence of live provider checks leave material uncertainty.

## Nonworking-code assessment

The strongest examples are the unreachable Moyasar AFT forwarding branches (F5), MyFatoorah's always-false paid replay comparison (F1), and the unused Moyasar legacy next-action mapper beside a conflicting active mapper (F6). These are demonstrably defective or dormant paths. The audit did not establish deliberate fabrication or that every gateway is nonfunctional. Test mocks are legitimate; claiming execution coverage from skipped test names would be misleading.

## Validation and artifacts

| Check | Result |
| --- | --- |
| Locked dependency installation | Completed with lifecycle scripts disabled |
| `bun run --filter @paykernel/core build` | Passed, including declarations |
| `bun run --filter @paykernel/testkit build` | Passed, including declarations |
| Tap and MyFatoorah package typechecks | Passed |
| Gateway baseline command below | Failed: 475 pass / 836 skip / 12 fail |
| Runtime audit probes | Passed assertions reproducing the defects; 9 output records |
| PayPal type probe | Expected exit 2; exactly two TS2353 errors |
| Live/sandbox provider calls | Not performed |

Run from the repository root after installing dependencies and building core/testkit:

```sh
bun test packages/core/src/gateways packages/gateway-tap packages/gateway-myfatoorah
bun docs/audits/2026-09-08-gateways/reproduce.ts
bun x --no-install tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target esnext docs/audits/2026-09-08-gateways/paypal-types.ts
```

The runtime probe intentionally asserts the observed bugs; a successful probe run does not mean the implementation is correct. Its HTTP dependency is injected and performs no network requests. The PayPal file is typecheck-only and must not be executed.

- [Runtime probes](./reproduce.ts) and [recorded output](./evidence.jsonl).
- [PayPal type probe](./paypal-types.ts) and [compiler output](./paypal-types.log).
- [Gateway baseline output](./gateway-baseline.log).
- Raw Muse reviews: [Paymob/Moyasar](./muse-paymob-moyasar.json), [Tap/MyFatoorah](./muse-tap-myfatoorah.json), [Stripe/PayPal](./muse-stripe-paypal.json). These contain unverified hypotheses and rejected claims; the decisions in this report take precedence.

Official pages were consulted on 2026-09-08. Provider documentation can change independently of this audited revision.
