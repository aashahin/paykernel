# @paykernel/integration-http

## 0.1.2

### Patch Changes

- Remove a `try`/`catch` in `processWebhookHttp` whose only statement was `throw err`.

  The engine still classifies `InvalidWebhookError` (forgery → 400, parse/missing → 500) exactly as
  before; the wrapper added no behavior.

## 0.1.1

### Patch Changes

- fix: replace workspace:* with registry versions for consumer install

  All 18 packages with runtime workspace:* dependencies were published as 0.1.0/1.0.0 with unresolvable workspace:* specifiers, breaking `npm install` for consumers (Unsupported URL Type "workspace:"). Patch to 0.1.1/1.0.1 with concrete registry versions (^1.0.0, ^0.1.0 etc) via changesets internal dependency update. No API changes.

- Updated dependencies
  - @paykernel/webhooks@0.1.1

## 0.1.0

### Minor Changes

- 0bebd63: Phase 24: optional framework webhook integrations (raw-body handlers, inbox HTTP mapping, durable ACK policy). Core and webhooks stay framework-agnostic.

### Patch Changes

- Updated dependencies [df66280]
- Updated dependencies [94547b7]
- Updated dependencies [6f78c47]
- Updated dependencies [9de3699]
  - @paykernel/core@1.0.0
  - @paykernel/webhooks@0.1.0

## Unreleased

- Initial release: portable HTTP mapping (`mapInboxOutcome`, `retryAfterSeconds`), header/correlation helpers, gateway signature extraction, `processWebhookHttp`, and `requireStringBindings`.
