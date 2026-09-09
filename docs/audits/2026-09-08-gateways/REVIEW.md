# Code review: gateway audit fix diff

## Summary
The reviewed changes are ready for local merge with the existing workspace test and lint failures recorded in FIXES.md. No additional correctness defect was confirmed; the maintainability findings below were fixed before merge.
Counts: 0 critical, 2 important, 1 nit

## Important findings
- `packages/gateway-myfatoorah/src/gateway.ts` — naming/functions and KISS (fixed): the nested `executeCreate` callback contained approximately 160 lines of replay lookup, status interpretation, request construction, and submission. Fix: extract `lookupCreateReplay`, `mapCreateReplay`, and `submitCreatePayment`; share the country eligibility rule through `supportsNativeIdempotency`. The submit path checks caller cancellation before marking its reservation as submitted.
- `packages/gateway-myfatoorah/src/gateway.ts` — dead code (fixed): `if (error instanceof RateLimitError) { /* comments only */ }` had no effect in the best-effort KWT/SAU lookup catch. Fix: remove the empty branch while preserving the native-header fallback and the non-native rate-limit error.

## Nits
- `packages/gateway-myfatoorah/src/create-reservation.ts` — YAGNI (fixed): `export interface WithCreateReservationInput` had no importing consumers. Fix: keep the input type module-private and name it `CreateReservationInput`.

## Coverage
- Section A (naming & functions): extracted the nested create flow into focused methods.
- Section B (comments & formatting): removed duplicated lookup commentary with the extraction; retained the reasons for fail-closed replay and headerless retry handling.
- Section C (SOLID): clean for introduced changes; existing gateway capability guards and shared store contracts remain intact.
- Section D (DRY/KISS/YAGNI): consolidated the country rule and replay request; removed the unused type export.
- Section E (AI failure modes): removed the empty branch; no new unused symbols, fabricated success paths, or suppressed regression tests found.

clean-code-guard: 3 fixed, 0 new findings left open. Four existing declaration-merging lint errors remain in the Tap/MyFatoorah class/interface pairs, as reproduced on the original revision.

## Test review

**Rule 3 violation** in `packages/gateway-myfatoorah/src/create-reservation.test.ts` (fixed)
- What: conflict and post-submit replay checks called the same operation twice solely to assert the error class and message separately.
- Fix: assert both properties against one rejected promise. The rate-limit case also uses an awaited rejection assertion instead of a manual catch.

The new audit regressions exercise actual gateways and operation/webhook adapters, real Money values, and an in-memory atomic store/inbox. Network behavior is injected at fetch. The persistence-outage test injects a failure at the storage boundary while preserving real reservation state. Compile-time PayPal checks use fresh object literals so excess-property checking catches a missing `returnUrl` contract. Historical regression cases were preserved.

Two missing reservation scenarios now have gateway-level coverage: a failed inquiry releases the fence for a later successful request, and failure to persist an accepted create response retains the fence and blocks a second gateway instance from charging again.

test-guard: 1 violation fixed, no remaining violations found in the newly written tests.

## Validation
- Final gateway suite: 1,339 passed, 0 failed, 0 skipped (41 files).
- Reservation regressions: 9 passed.
- MyFatoorah build and workspace source/public-API type checks passed.
- API/schema compatibility and `git diff --check` passed.
- Changed-file ESLint: the same four pre-existing declaration-merging errors; no new findings.
- The preceding full-workspace run had 78 failures, all reproduced on the original revision; see FIXES.md and fix-validation.json. That comparison predates this review's refactor and two added tests.
- Provider responses are fixtures; no live provider transactions were performed.
