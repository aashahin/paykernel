# Gateway audit fixes — 2026-09-09

All ten findings in [the original audit](./REPORT.md) are addressed. Muse implemented the fixes through the OpenCode workers MCP bridge; Codex reviewed and integrated the patches, repaired integration details, and ran the checks below. The original audit and its reproductions remain historical evidence of revision `1ee2fd7cddda98ead161baf40a91526b13683fa4`.

| Finding | Result |
| --- | --- |
| F1 | MyFatoorah compares mapped Money directly in minor units. Matching paid inquiries return the existing payment in both country branches. |
| F2 | Outside KWT/SAU, an atomic shared-store reservation covers inquiry and creation. Concurrent requests cannot both submit; replay returns the cached checkout URL, conflicting parameters are rejected, and uncertain submissions retain their reservation. Automatic create POST retries are disabled there. |
| F3 | Tap event IDs incorporate authenticated status/version fields. Authorize-to-void and pending-to-refunded transitions reach the real inbox separately; repeated deliveries remain deduplicated. Provider object references retain their original IDs. |
| F4 | Tap applies partial-capture normalization only after a confirmed successful capture, preserving declines and other outcomes. |
| F5 | Moyasar accepts and forwards the documented AFT recipient/sender fields. |
| F6 | Moyasar 3DS uses `{ type: "redirect", url }`; the obsolete mapper and unsafe action casts are removed. |
| F7 | PayPal exposes provider-specific create parameters consistently through all three public client entry points, covered by a compiler regression. |
| F8 | Tap invoice events retain their native type and `provider.unmapped` event. Their mandatory status field uses the documented nonterminal `processing` placeholder. A paid invoice is no longer reported as cancelled. |
| F9 | MyFatoorah verifies equivalent string, Buffer, and Uint8Array bodies. Malformed UTF-8, JSON, and signatures fail closed. |
| F10 | All 836 previously skipped gateway cases are enabled and migrated to current inputs/results. CI builds dependencies first and runs the gateway suites and audit regressions explicitly. |

Restoring the tests also exposed two defects now fixed: PayPal discarded legitimate zero remaining amounts during Money construction, and built-in adapter manifests still advertised the old prerelease version.

## Required caller changes

- MyFatoorah creation outside KWT/SAU now requires `config.idempotencyStore`. Multi-process deployments must share a store with atomic `reserve()`; preserve uncertain reservations until reconciliation. See [idempotency](../../../packages/gateway-myfatoorah/docs/idempotency.md).
- Tap normalized event IDs changed. Previously stored inbox keys may permit one additional delivery after upgrading; retain application-level business idempotency. Invoice `processing` is a placeholder, not proof of payment. See [webhook behavior](../../../packages/gateway-tap/docs/webhooks.md).

## Verification

`bun run test:gateways`: **1,337 passed, 0 failed, 0 skipped**, across 41 files. This includes the original gateway inventory plus the permanent regressions. No gateway test contains `skip`, `todo`, or `only` modifiers.

Workspace build, typechecks, public API type tests, workspace boundaries, API/schema compatibility, and runtime portability checks pass. The generated capability documentation and API baseline match the final implementation.

The broader workspace remains red for unrelated existing failures. With local test-server access enabled, the original revision has **2,547 passed / 1,170 skipped / 91 failed**; the final workspace has **3,410 passed / 334 skipped / 78 failed**. Every remaining failing test also fails on the original revision. These failures are in shared result/validation tests and the testkit, outside this audit's gateway repair scope. [Machine-readable comparison and remaining cases](./fix-validation.json).

The tests inject provider responses and exercise real gateway/client/inbox code. No live or provider-sandbox payments were performed. Deno import smoke was unavailable because Deno is not installed; the required static portability scans pass.

## Code-quality review

- `moyasar.gateway.ts` — removed the unused mapper and unsafe next-action casts.
- `gateway-myfatoorah/src/gateway.test.ts` — removed a redundant Money cast.
- Stripe/PayPal tests — replaced obsolete assertions and removed redundant comparisons that could pass without checking Money values.
- MyFatoorah configuration/reservation and webhook regression files — reduced comments that restated the code and clarified reservation retention.

Changed-file lint reports four pre-existing declaration-merging errors in the Tap and MyFatoorah gateway class/interface pairs. The same four errors reproduce on the original revision; no new lint findings were introduced.

clean-code-guard: 4 fixed, 4 pre-existing lint findings flagged for author.

## Review before merge (2026-09-09)

The subsequent `clean-code-guard` and `test-guard` review is recorded in
[REVIEW.md](./REVIEW.md). It extracts the MyFatoorah replay/submission paths,
removes an empty rate-limit branch and an unused type export, and adds two
reservation failure-path tests. The final gateway run passes **1,339 tests,
0 failures, 0 skips**. The full-workspace baseline comparison above was run
before these review changes; the final review reran gateway tests, type checks,
the MyFatoorah build, compatibility, and changed-file lint.
