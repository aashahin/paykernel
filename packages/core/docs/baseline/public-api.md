# Public API Baseline

> **Phase 0 freeze artifact.** Generated from `src/index.ts` and the built `dist/` package.
> Do not hand-edit the inventory tables; regenerate with the command below.

## Generation metadata

- **Command**: `bun run scripts/generate-api-baseline.ts`
- **Source of truth (exports)**: `src/index.ts`
- **Runtime module inspected**: `dist/index.js`
- **Declarations inspected**: `dist/**/*.d.ts`
- **Bundle**: `dist/index.js` — 506454 bytes, sha256 `fa024a1a511afdc9e8570d15673c7551204c5ec33f5cbbdd7bf7cabaf717cbeb`

## Package

- **name**: `@paykernel/core`
- **version**: `1.0.0`

## Entry points

- **main**: `./dist/index.js`
- **types**: `./dist/index.d.ts`
- **type**: `module`
- **exports**:
```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

## Runtime exports

Value exports from `src/index.ts`, classified by inspecting the built ESM module.

| Name | Kind |
| --- | --- |
| `AuthenticationError` | class |
| `BUILTIN_ADAPTER_VERSION` | const |
| `BUILTIN_GATEWAY_CAPABILITIES` | const |
| `BUILTIN_GATEWAY_MANIFESTS` | const |
| `BaseGateway` | class |
| `CAPABILITY_DOCS_BANNER` | const |
| `CAPABILITY_OPERATION_MAP` | const |
| `CardDeclinedError` | class |
| `DEFAULT_GATEWAY_CAPABILITIES` | const |
| `DEFAULT_RETRY_CONFIG` | const |
| `DISPUTE_STATUSES` | const |
| `GATEWAY_CAPABILITY_KEYS` | const |
| `GatewayApiError` | class |
| `GatewayNotConfiguredError` | class |
| `HooksManager` | class |
| `InMemoryIdempotencyStore` | class |
| `InsufficientFundsError` | class |
| `InvalidRequestError` | class |
| `InvalidWebhookError` | class |
| `MOYASAR_CAPABILITIES` | const |
| `MOYASAR_EVENT_TYPE_MAP` | const |
| `MoneyAmountError` | class |
| `MoyasarGateway` | class |
| `NetworkError` | class |
| `OperationNotSupportedError` | class |
| `PAID_LIKE_PAYMENT_STATUSES` | const |
| `PAYMENT_DOMAIN_STATUSES` | const |
| `PAYMENT_EVENT_SCHEMA_VERSION` | const |
| `PAYMOB_CAPABILITIES` | const |
| `PAYMOB_TOKEN_EVENT_TYPES` | const |
| `PAYPAL_CAPABILITIES` | const |
| `PAYPAL_EVENT_TYPE_MAP` | const |
| `PayPalGateway` | class |
| `PaymentAbortedError` | class |
| `PaymentClient` | class |
| `PaymentError` | class |
| `PaymobGateway` | class |
| `RateLimitError` | class |
| `ResourceNotFoundError` | class |
| `STABLE_PAYMENT_EVENT_TYPES` | const |
| `STRIPE_CAPABILITIES` | const |
| `STRIPE_EVENT_TYPE_MAP` | const |
| `STRIPE_UNMAPPED_EVENT_TYPES` | const |
| `StripeGateway` | class |
| `WEBHOOK_PAYLOAD_SECRET_KEYS` | const |
| `applyIndeterminateCheckoutSessionOutcome` | function |
| `applyIndeterminateCustomerOutcome` | function |
| `applyIndeterminateDisputeOutcome` | function |
| `applyIndeterminatePaymentLinkOutcome` | function |
| `applyIndeterminatePaymentMethodOutcome` | function |
| `applyIndeterminatePaymentOutcome` | function |
| `applyIndeterminateRefundOutcome` | function |
| `applyOutcomeToGatewayRefundResult` | function |
| `applyOutcomeToGatewayResult` | function |
| `assertNoSecretsInEnvelope` | function |
| `attachPaymentEvent` | function |
| `base64ToBytes` | function |
| `buildProviderEventMetadata` | function |
| `buildProviderReferences` | function |
| `bytesToBase64` | function |
| `bytesToHex` | function |
| `combineAbortSignals` | function |
| `concatBytes` | function |
| `createDefaultGatewayContext` | function |
| `createDynamicGatewayRegistry` | function |
| `createGatewayRegistry` | function |
| `createOperationContext` | function |
| `createPaymentClient` | function |
| `createPaymentRuntime` | function |
| `createRedactingLogger` | function |
| `createRedactingTelemetrySink` | function |
| `createTimeoutSignal` | function |
| `defineGatewayCapabilities` | function |
| `encryptRawWebhookPayload` | function |
| `extractAbortSignal` | function |
| `finalizeOperationContext` | function |
| `fingerprintParams` | function |
| `formatMoney` | function |
| `freezeCapabilities` | function |
| `fromMinorUnits` | function |
| `generateGatewayCapabilitiesMarkdown` | function |
| `getCurrencyExponent` | function |
| `hashWebhookPayload` | function |
| `hexToBytes` | function |
| `hmacSha256` | function |
| `hmacSha256Hex` | function |
| `hmacSha512` | function |
| `hmacSha512Hex` | function |
| `inferOperationOutcome` | function |
| `inferRefundOperationOutcome` | function |
| `isAbortError` | function |
| `isApplePaySource` | function |
| `isCardTokenSource` | function |
| `isCreditCardSource` | function |
| `isDisputeStatus` | function |
| `isGatewayCapabilityKey` | function |
| `isGatewayPaymentResult` | function |
| `isHostedCheckoutRedirect` | function |
| `isIndeterminateOutcome` | function |
| `isKnownCurrencyCode` | function |
| `isMoney` | function |
| `isPaidLikePaymentStatus` | function |
| `isPaidOutcome` | function |
| `isPaymentDomainStatus` | function |
| `isPaymentEvent` | function |
| `isPaymentFailedEvent` | function |
| `isPaymentSucceededEvent` | function |
| `isProviderUnmappedEvent` | function |
| `isRefundCompletedEvent` | function |
| `isRequiresActionOutcome` | function |
| `isSamsungPaySource` | function |
| `isStablePaymentEventType` | function |
| `isStcPaySource` | function |
| `mapGatewayRefundToOperationResult` | function |
| `mapGatewayResultToOperationResult` | function |
| `mapHttpAbortError` | function |
| `mapNativeDisputeStatus` | function |
| `mapProviderEventTypeToStable` | function |
| `mergePaymentRuntime` | function |
| `minorAmountToNumber` | function |
| `money` | function |
| `moneyToMajorNumber` | function |
| `moyasarGateway` | function |
| `noopLogger` | const |
| `normalizeAmountInput` | function |
| `normalizeCurrencyCode` | function |
| `operationContextToTelemetryData` | function |
| `parseRetryAfterSeconds` | function |
| `paymentFromGatewayResult` | function |
| `paymentFromWebhookEvent` | function |
| `paymentNextActionToAction` | function |
| `paymentRuntimeFromContext` | function |
| `paymobGateway` | function |
| `paypalGateway` | function |
| `redact` | function |
| `redactWebhookPayloadSecrets` | function |
| `resolveDefaultCrypto` | function |
| `sha256` | function |
| `sha256Hex` | function |
| `sha512` | function |
| `sha512Hex` | function |
| `stableStringifyForHash` | function |
| `stripAbortSignal` | function |
| `stripRawFromPaymentEvent` | function |
| `stripeGateway` | function |
| `systemClock` | const |
| `timingSafeEqualBytes` | function |
| `timingSafeEqualHex` | function |
| `toMinorUnits` | function |
| `toPaymentErrorLike` | function |
| `toPersistedPaymentEventEnvelope` | function |
| `utf8Encode` | function |
| `utf8ToBase64` | function |
| `uuidV4FromGetRandomValues` | function |
| `validateMoney` | function |
| `webhookEventToPaymentEvent` | function |
| `withAbortSignal` | function |
| `withRetry` | function |

**Count**: 158

## Type-only exports

Names from `export type { ... }` (and `type` members in value export lists) in `src/index.ts`.
These exist only in the TypeScript declaration surface.

| Name |
| --- |
| `AfterHook` |
| `AfterHookResult` |
| `AmountInput` |
| `ApplePayDecryptedSource` |
| `ApplePaySource` |
| `ApplyOutcomeGatewayBase` |
| `ApplyOutcomeGatewayRefundBase` |
| `AttachPaymentEventOptions` |
| `AttachPaymentMethodParams` |
| `AuthorizationStatus` |
| `BeforeHook` |
| `BeforeHookResult` |
| `BuildProviderEventMetadataOptions` |
| `BuildProviderReferencesInput` |
| `BuiltInGatewayMap` |
| `BuiltInGatewayName` |
| `BuiltinGatewayCapabilityName` |
| `Capture` |
| `CaptureParams` |
| `CaptureStatus` |
| `CardTokenSource` |
| `CheckoutSession` |
| `CheckoutSessionOperationOutcome` |
| `CheckoutSessionOperationResult` |
| `CheckoutSessionStatus` |
| `Clock` |
| `CommonCheckoutSessionInput` |
| `CommonCustomerInput` |
| `CommonPaymentInput` |
| `CommonPaymentLinkInput` |
| `CreateCheckoutSessionParams` |
| `CreateCustomerParams` |
| `CreateDefaultGatewayContextOptions` |
| `CreateOperationContextInput` |
| `CreatePaymentClientOptions` |
| `CreatePaymentLinkParams` |
| `CreatePaymentParams` |
| `CreditCardSource` |
| `CryptoProvider` |
| `CurrencyCode` |
| `CurrencyExponentOverrides` |
| `Customer` |
| `CustomerOperationOutcome` |
| `CustomerOperationResult` |
| `CustomerStatus` |
| `DeactivatePaymentLinkParams` |
| `DecimalString` |
| `DetachPaymentMethodParams` |
| `Dispute` |
| `DisputeEvidenceInput` |
| `DisputeOperationOutcome` |
| `DisputeOperationResult` |
| `DisputeStatus` |
| `EncryptedRawPayloadRecord` |
| `ErrorHook` |
| `FinalizeOperationContextPatch` |
| `GatewayAdapter` |
| `GatewayAdaptersMap` |
| `GatewayCapabilities` |
| `GatewayCapabilityKey` |
| `GatewayConfig` |
| `GatewayContext` |
| `GatewayId` |
| `GatewayManifest` |
| `GatewayMap` |
| `GatewayName` |
| `GatewayPaymentResult` |
| `GatewayPaymentStatus` |
| `GatewayRefundResult` |
| `GatewayRegistryBuilder` |
| `GatewayRuntimeDeps` |
| `GetCheckoutSessionParams` |
| `GetCurrencyExponentOptions` |
| `GetCustomerParams` |
| `GetDisputeParams` |
| `GetPaymentLinkParams` |
| `GetPaymentParams` |
| `HookContext` |
| `IdempotencyRecord` |
| `IdempotencyStatus` |
| `IdempotencyStore` |
| `ImmutableGatewayRegistry` |
| `InferGatewayMapFromAdapters` |
| `ListDisputesParams` |
| `ListDisputesResult` |
| `ListPaymentMethodsParams` |
| `ListPaymentMethodsResult` |
| `LogLevel` |
| `Logger` |
| `MappedStableEventType` |
| `MarketplaceSplit` |
| `MinorAmount` |
| `Money` |
| `MoneyFailureKind` |
| `MoneyParseOptions` |
| `MoneyRoundingMode` |
| `MoyasarAftRecipient` |
| `MoyasarAftSender` |
| `MoyasarBackendPaymentSource` |
| `MoyasarConfig` |
| `MoyasarConfirmStcPayOtpParams` |
| `MoyasarCreatePaymentParams` |
| `MoyasarPaymentSource` |
| `MoyasarPaymentSplit` |
| `MoyasarStcPayOtpNextAction` |
| `MoyasarWebhookPayload` |
| `OperationContext` |
| `OperationNotSupportedErrorOptions` |
| `OperationRequestOptions` |
| `OperationType` |
| `PayPalConfig` |
| `PayPalCreatePaymentParams` |
| `PayPalWebhookPayload` |
| `Payment` |
| `PaymentAction` |
| `PaymentDecline` |
| `PaymentDomainStatus` |
| `PaymentErrorLike` |
| `PaymentEvent` |
| `PaymentEventSchemaVersion` |
| `PaymentFailure` |
| `PaymentGateway` |
| `PaymentHooks` |
| `PaymentLink` |
| `PaymentLinkOperationOutcome` |
| `PaymentLinkOperationResult` |
| `PaymentLinkStatus` |
| `PaymentMetadata` |
| `PaymentMethodOperationResult` |
| `PaymentMethodSetup` |
| `PaymentNextAction` |
| `PaymentOperationOutcome` |
| `PaymentOperationResult` |
| `PaymentOperationType` |
| `PaymentRuntime` |
| `PaymentStatus` |
| `PaymobCardTokenWebhookPayload` |
| `PaymobConfig` |
| `PaymobCreatePaymentParams` |
| `PaymobIdempotencyRecord` |
| `PaymobIdempotencyStore` |
| `PaymobRedirectWebhookPayload` |
| `PaymobWebhookPayload` |
| `Payout` |
| `PayoutStatus` |
| `PersistedPaymentEventEnvelope` |
| `ProviderEventMapContext` |
| `ProviderEventMetadata` |
| `ProviderReferences` |
| `RawWebhookPayloadCodec` |
| `RedirectPaymentNextAction` |
| `Refund` |
| `RefundDomainStatus` |
| `RefundOperationOutcome` |
| `RefundOperationResult` |
| `RefundParams` |
| `RefundStatus` |
| `RequestLocalWebhookContext` |
| `RetryConfig` |
| `SamsungPaySource` |
| `SetupTokenStatus` |
| `StablePaymentEventType` |
| `StcPaySource` |
| `StoredPaymentMethod` |
| `StoredPaymentMethodType` |
| `StripeConfig` |
| `StripeCreatePaymentParams` |
| `StripeWebhookPayload` |
| `SubmitDisputeEvidenceParams` |
| `TelemetrySink` |
| `TimeoutSignalHandle` |
| `ToPersistedEnvelopeOptions` |
| `Transfer` |
| `TransferStatus` |
| `UnmappedPaymentEventType` |
| `VoidParams` |
| `WebhookEnvelopeStatus` |
| `WebhookEvent` |
| `WebhookEventToPaymentEventOptions` |
| `WebhookFailedHook` |
| `WebhookReceivedHook` |
| `WebhookVerifiedHook` |
| `WithRetryOptions` |

**Count**: 183

## Cross-checks

- Parsed value exports present on runtime module: **yes**
- Runtime keys not listed in `src/index.ts` value exports: _none_
- Type-only names that also exist as runtime values: _none_
- Total distinct public names (runtime + type-only): **341**

## Declaration output tree (`dist/**/*.d.ts`)

Relative paths under `dist/`, sorted. Source maps (`.d.ts.map`) are omitted.

- `client.d.ts`
- `create-payment-client.d.ts`
- `errors.d.ts`
- `gateways/base.gateway.d.ts`
- `gateways/builtin-capabilities.d.ts`
- `gateways/capabilities-docs.d.ts`
- `gateways/factories.d.ts`
- `gateways/gateway-adapter.d.ts`
- `gateways/gateway-capabilities.d.ts`
- `gateways/gateway-context.d.ts`
- `gateways/gateway-manifest.d.ts`
- `gateways/gateway-registry.d.ts`
- `gateways/gateway.interface.d.ts`
- `gateways/index.d.ts`
- `gateways/moyasar/moyasar.gateway.d.ts`
- `gateways/paymob/paymob.gateway.d.ts`
- `gateways/paypal/paypal.gateway.d.ts`
- `gateways/stripe/stripe.gateway.d.ts`
- `hooks/hooks.manager.d.ts`
- `hooks/hooks.types.d.ts`
- `hooks/money-identity.d.ts`
- `index.d.ts`
- `runtime/abort.d.ts`
- `runtime/clock.d.ts`
- `runtime/crypto-portable.d.ts`
- `runtime/crypto-provider.d.ts`
- `runtime/index.d.ts`
- `runtime/operation-context.d.ts`
- `runtime/payment-runtime.d.ts`
- `types/checkout.types.d.ts`
- `types/config.types.d.ts`
- `types/customer.types.d.ts`
- `types/dispute.types.d.ts`
- `types/domain-status.d.ts`
- `types/marketplace.types.d.ts`
- `types/moyasar-source.types.d.ts`
- `types/operation-result.d.ts`
- `types/payment-event.d.ts`
- `types/payment-link.types.d.ts`
- `types/payment.types.d.ts`
- `types/provider-refs.d.ts`
- `types/stable-payment-event-types.d.ts`
- `types/validation.d.ts`
- `types/webhook-event-map.d.ts`
- `types/webhook.types.d.ts`
- `utils/currency.d.ts`
- `utils/idempotency.d.ts`
- `utils/logger.d.ts`
- `utils/money.d.ts`
- `utils/raw-card.d.ts`
- `utils/retry.d.ts`

**Count**: 51

## Notes

- Only symbols re-exported from `src/index.ts` are part of the supported public API.
- Internal modules under `dist/` (e.g. `dist/utils/currency.d.ts`) may appear in the declaration tree for compiler layout; they are **not** public entry points unless re-exported from `src/index.ts`.
- Package is **ESM-only** (`"type": "module"`, `exports["."].import` only).
- Kind classification uses runtime heuristics (class vs function vs const); see script source for rules.
