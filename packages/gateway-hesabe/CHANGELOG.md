# @paykernel/gateway-hesabe

## 0.1.1

### Patch Changes

- Adapters now report the published package version in `manifest.version`.

  `TAP_ADAPTER_VERSION`, `MYFATOORAH_ADAPTER_VERSION`, and `HESABE_ADAPTER_VERSION` were still the
  pre-release string `0.1.0-next.0` after the packages moved to stable versions, so every registered
  adapter advertised a prerelease manifest version. The constants now match `package.json`, and the
  public API tests assert the constant and the factory manifest against `package.json` so the drift
  cannot come back.

  The Tap and MyFatoorah gateways also stop merging a redundant `interface` into the same-named
  `GatewayAdapter` class; the class methods already carry the narrowed per-gateway parameter types,
  and `tsc` plus the factory type suites verify that surface.

## 0.1.0

### Minor Changes

- 5921bee: Add the portable Hesabe adapter for KWD redirect payments, transaction enquiry,
  enquiry-verified notifications, and full or partial refunds with atomic mutation
  reservations.

## Unreleased

- Add the Hesabe adapter for KWD redirect payments, transaction enquiry, callbacks,
  enquiry-verified notifications, and merchant refunds.
