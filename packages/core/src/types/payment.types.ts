import type {
    CreditCardSource,
    MoyasarPaymentSource,
} from "./moyasar-source.types";
import type { Money } from "../utils/money";
import type { GatewayPaymentStatus, PaymentDomainStatus } from "./domain-status";
import type { ProviderReferences } from "./provider-refs";
import type {
    PaymentDecline,
    PaymentOperationOutcome,
    RefundOperationOutcome,
} from "./operation-result";

/**
 * Amount input for create/capture/refund — Money only (1.0).
 *
 * Pass {@link Money} via `money("10.50", "SAR")` (decimal string + currency).
 * Plain `number` major units are no longer accepted on payment APIs; use Money.
 * The `money()` factory may still accept a clean number to construct Money.
 */
export type AmountInput = Money;

/**
 * Built-in first-party gateway names shipped with this package.
 */
export type BuiltInGatewayName = "moyasar" | "paypal" | "paymob" | "stripe";

/**
 * Open gateway identifier for plugin/registry contracts.
 *
 * Use this on {@link PaymentGateway}.name, hook context, webhook events, and
 * registry-typed client methods. Built-in names are assignable to {@link GatewayId}.
 */
export type GatewayId = string;

/**
 * Public 0.x alias for the closed built-in gateway name union.
 *
 * Open (third-party / registry) gateway names are typed as {@link GatewayId} or
 * via registry generics on the plugin client APIs — not by widening this alias.
 * Prefer {@link BuiltInGatewayName} when you mean only first-party gateways.
 */
export type GatewayName = BuiltInGatewayName;

/**
 * Payment charge/intent lifecycle only (1.0).
 * Alias kept for fewer import churn sites.
 */
export type PaymentStatus = PaymentDomainStatus;

/**
 * Refund processing status (entity-level).
 * Alias-compatible with {@link import('./domain-status').RefundDomainStatus}.
 */
export type RefundStatus = "pending" | "completed" | "failed";

/**
 * Merchant metadata bag attached to create/refund params.
 */
export type PaymentMetadata = Record<string, unknown>;

/**
 * Shared options for provider network operations (create/capture/refund/void/get).
 *
 * Not mixed into {@link CommonPaymentInput} (money-focused) so provider
 * adapters that extend only money fields stay free of transport concerns.
 * Mixed into mutation/query param interfaces and checkout session params.
 *
 * Do **not** put `signal` on webhook events or payment/refund results.
 */
export interface OperationRequestOptions {
    /**
     * Optional cancellation for the underlying HTTP request(s).
     * Combined with the gateway timeout via {@link import('../runtime/abort').combineAbortSignals}.
     * Pre-aborted signals fail fast without hanging on the provider network.
     */
    signal?: AbortSignal;
}

/**
 * Common payment fields shared across providers — **no** provider-specific keys.
 *
 * Provider packages/adapters should extend this type rather than dumping
 * `stripe*` / `moyasar*` / `paypal*` / `paymob*` fields into a shared contract.
 *
 * @example
 * ```ts
 * type AcmeCreateParams = CommonPaymentInput & {
 *   currency: string;
 *   callbackUrl: string;
 *   acmeWalletId: string;
 * };
 * ```
 */
export type CommonPaymentInput = {
    /** AmountInput is Money only in 1.0 -- pass money("10.50", "SAR"). */
    amount: AmountInput;
    /** Optional order/transaction ID for your system */
    orderId?: string;
    /** Payment description shown to customer */
    description?: string;
    /** Custom metadata to attach to payment */
    metadata?: PaymentMetadata;
};

/**
 * Parameters for creating a new payment.
 *
 * Common fields come from {@link CommonPaymentInput} plus `currency`,
 * `callbackUrl`, optional `capture` / `idempotencyKey`.
 *
 * Provider fields are not on `CreatePaymentParams`; use per-gateway `*CreatePaymentParams` (1.0).
 */
export interface CreatePaymentParams extends CommonPaymentInput, OperationRequestOptions {
    /** ISO 4217 currency code */
    currency: string;
    /** URL to redirect after payment completion */
    callbackUrl: string;

    /**
     * Whether to capture the payment immediately.
     * Default: true
     * Set to false to only authorize the amount (requires manual capture later).
     */
    capture?: boolean;

    /**
     * Idempotency key for safe retries (UUIDv4 recommended).
     * Moyasar: Maps to `given_id` - becomes the payment ID.
     * Prevents duplicate charges on network failures.
     */
    idempotencyKey?: string;

    /**
     * Stored provider customer id (Phase 22.1). Distinct from the 0.x
     * Stripe convenience field {@link stripeCustomerId}.
     */
    customerId?: string;
    /**
     * Tokenized stored payment-method id (never a PAN). Distinct from
     * {@link stripePaymentMethodId}.
     */
    paymentMethodId?: string;
    /**
     * Charge a stored payment method off-session (customer not present).
     * Requires a stored payment-method id ({@link paymentMethodId} or
     * {@link stripePaymentMethodId}) **and** a customer id ({@link customerId}
     * or {@link stripeCustomerId}). Fail-closed unless the gateway claims
     * `paymentMethods`.
     */
    offSession?: boolean;
}

/**
 * Moyasar payment source types that are safe to use from a merchant backend.
 * Raw credit card details must be sent directly from the customer device to Moyasar
 * or tokenized with Moyasar.js before reaching backend code.
 */
export type MoyasarBackendPaymentSource = Exclude<
    MoyasarPaymentSource,
    CreditCardSource
>;

/**
 * Moyasar split recipient for marketplace/platform payments.
 * Field names (except unit of `amount`) match Moyasar's API payload so callers
 * can copy examples from Moyasar docs without the SDK silently dropping them.
 *
 * **Amount units**: `amount` is in **major** currency units -- the same unit as
 * top-level `createPayment` `amount` (e.g. `money("50.00", "SAR")` for 50.00 SAR). The SDK converts
 * each split to Moyasar's minor units (halalas/fils) before calling the API.
 * Moyasar requires a non-zero split amount; negative values are allowed by the
 * API where reverse splits are supported.
 */
export interface MoyasarPaymentSplit {
    /**
     * Split amount as {@link Money} (major units). Converted to minor units for Moyasar API. Must be non-zero.
     * Negative values are allowed where reverse splits are supported (`allowNegative` on conversion).
     */
    amount: AmountInput;
    recipient_id: string;
    reference?: string;
    description?: string;
    fee_source?: boolean;
    refundable?: boolean;
}

/**
 * Moyasar AFT recipient payload.
 * Required only for Account Funding Transaction payment creation.
 */
export interface MoyasarAftRecipient {
    first_name: string;
    last_name: string;
    middle_name?: string;
    address: string;
    street_name?: string;
    postal_code?: string;
    locality?: string;
    country?: string;
    building_number?: string;
}

/**
 * Moyasar AFT sender payload.
 * Required only for Account Funding Transaction payment creation.
 * `account` is a legacy optional block kept for backwards compatibility and
 * is forwarded as provided when present. `country_code` is optional per
 * current docs.
 */
export interface MoyasarAftSender {
    account?: {
        funds_source: string;
        number: string;
    };
    first_name: string;
    last_name: string;
    address: string;
    locality?: string;
    postal_code?: string;
    administrative_area?: string;
    country_code?: string;
    id_type:
    | "ARNB"
    | "BTHD"
    | "CPNY"
    | "CUID"
    | "DRLN"
    | "EMAL"
    | "LAWE"
    | "MILI"
    | "NTID"
    | "PASN"
    | "PHON"
    | "PRXY"
    | "SSNB"
    | "TRVL";
    id: string;
    phone_number: string;
}

/**
 * Moyasar-specific create params. Moyasar only requires callbackUrl for card
 * token flows; STC Pay, Apple Pay, and Samsung Pay can omit it.
 */
export interface MoyasarCreatePaymentParams
    extends Omit<CreatePaymentParams, "callbackUrl"> {
    callbackUrl?: string;
    moyasarSource?: MoyasarBackendPaymentSource;
    /** Moyasar: Whether to apply merchant coupon */
    applyCoupon?: boolean;
    /** Moyasar marketplace/platform split instructions. */
    splits?: MoyasarPaymentSplit[];
    /** Moyasar AFT recipient information. */
    recipient?: MoyasarAftRecipient;
    /** Moyasar AFT sender information. */
    sender?: MoyasarAftSender;
}

/**
 * Paymob-specific create params. Paymob Intention API treats callback and
/**
 * Paymob billing data for customer identification.
 * Shared type used by both {@link PaymobCreatePaymentParams} and Zod validation
 * in `types/validation.ts` (deduped — single source of truth).
 */
export type PaymobBillingData = {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    country?: string | undefined;
    city?: string | undefined;
    street?: string | undefined;
    building?: string | undefined;
    apartment?: string | undefined;
    floor?: string | undefined;
    postalCode?: string | undefined;
    state?: string | undefined;
};

export interface PaymobCreatePaymentParams
    extends Omit<CreatePaymentParams, "callbackUrl"> {
    callbackUrl?: string;
    paymobIntegrationId?: string | number;
    paymobPaymentMethods?: Array<string | number>;
    paymobIframeId?: string | number;
    paymobBillingData?: PaymobBillingData;
}

/**
 * PayPal-specific create params. PayPal prefers `returnUrl` / `cancelUrl`;
 * `callbackUrl` is optional when `returnUrl` is provided. Runtime validation
 * requires at least one of `callbackUrl` | `returnUrl` for success return, and
 * at least one of `cancelUrl` | `callbackUrl` | `returnUrl` for cancel fallback.
 */
export interface PayPalCreatePaymentParams
    extends Omit<CreatePaymentParams, "callbackUrl"> {
    callbackUrl?: string;
    returnUrl?: string;
    cancelUrl?: string;
    paypalShippingPreference?: "GET_FROM_FILE" | "NO_SHIPPING" | "SET_PROVIDED_ADDRESS";
}

/**
 * Parameters for confirming an initiated Moyasar STC Pay payment with the OTP
 * sent to the customer's phone.
 */
export interface MoyasarConfirmStcPayOtpParams extends OperationRequestOptions {
    /** The `source.transaction_url` returned from the initiated STC Pay payment. */
    transactionUrl: string;
    /** OTP value sent to the customer by SMS. */
    otpValue: string | number;
}

/**
 * Parameters for capturing an authorized payment
 */
export interface CaptureParams extends OperationRequestOptions {
    /** Gateway's payment ID */
    gatewayPaymentId: string;
    /** Amount to capture (optional, defaults to full amount). AmountInput is Money only in 1.0. */
    amount?: AmountInput;
    /**
     * ISO 4217 currency code. Required when providing a partial capture
     * `amount` for Moyasar, PayPal, or Stripe (and similar gateways that need
     * currency to convert major units to minor units). Optional for full
     * captures that rely on the original payment currency at the gateway.
     */
    currency?: string;
    /** Idempotency key for safe retries */
    idempotencyKey?: string;
    /**
     * PayPal: which capture endpoint to call.
     * Default 'order' captures an approved CAPTURE-intent order.
     * Use 'authorization' with an authorization ID returned by PayPalGateway.authorizePayment().
     */
    paypalCaptureType?: "order" | "authorization";
    /**
     * PayPal authorization captures only: whether this is the final capture
     * for the authorization. Amount-dependent SDK defaults (PayPal API default
     * is `false`): omit `amount` (full remaining capture) → `true`; set
     * `amount` (partial) → `false` unless `paypalFinalCapture === true`.
     */
    paypalFinalCapture?: boolean;
}

/**
 * Parameters for refunding a payment
 */
export interface RefundParams extends OperationRequestOptions {
    /** Gateway's payment ID to refund */
    gatewayPaymentId: string;
    /** Amount to refund (optional, undefined = full refund). AmountInput is Money only in 1.0. */
    amount?: AmountInput;
    /** Reason for refund */
    reason?: string;
    /** Custom metadata to attach to the refund when the gateway supports it */
    metadata?: Record<string, unknown>;
    /** ISO 4217 currency code (required for PayPal partial refunds) */
    currency?: string;
    /** Idempotency key for safe retries */
    idempotencyKey?: string;
}

/**
 * Parameters for voiding a payment
 */
export interface VoidParams extends OperationRequestOptions {
    /** Gateway's payment ID to void */
    gatewayPaymentId: string;
    /** Idempotency key for safe retries */
    idempotencyKey?: string;
}

/**
 * Parameters for retrieving a payment
 */
export interface GetPaymentParams extends OperationRequestOptions {
    /** Gateway's payment ID to retrieve */
    gatewayPaymentId: string;
}

/**
 * Moyasar STC Pay OTP next step. `transactionUrl` is the OTP submission
 * endpoint (not a browser redirect) — pass it to `confirmStcPayOtp`.
 */
export type MoyasarStcPayOtpNextAction = {
    type: "stcpay_otp";
    transactionUrl: string;
    method: "POST";
    parameter: "otp_value";
};

/**
 * SDK-normalized browser/checkout redirect next step (Moyasar 3DS, Paymob
 * unified checkout, etc.).
 */
export type RedirectPaymentNextAction = {
    type: "redirect";
    /** Browser redirect URL (e.g. Moyasar 3DS `transaction_url`) */
    url?: string;
    /** Paymob unified checkout URL */
    checkoutUrl?: string;
    intentionId?: string;
    clientSecret?: string;
    paymentKeys?: unknown;
};

/**
 * Customer next-step after create/capture. Narrow on `type` for Moyasar STC Pay
 * OTP (`stcpay_otp`) and SDK-normalized redirects (`redirect`). Other providers
 * (e.g. Stripe `PaymentIntent.next_action`) may pass through provider-native
 * shapes under a free-form object.
 */
export type PaymentNextAction =
    | MoyasarStcPayOtpNextAction
    | RedirectPaymentNextAction
    | { type?: string; [key: string]: unknown };


/**
 * Result from gateway payment operations.
 *
 * ## Outcome (1.0)
 *
 * Discriminate on {@link PaymentOperationOutcome} via the **required** `outcome` field
 * (and helpers `isPaidOutcome` / `mapGatewayResultToOperationResult`). See
 * `docs/operation-results.md`.
 *
 * `success` was removed in 1.0 — it historically meant "HTTP/API call ok" (not "paid")
 * and was source of false-fulfillment bugs. Use `outcome === 'succeeded'` with
 * a paid-like `status` (`paid` only — not `approved` / `authorized`), or
 * `isPaidOutcome(result)`.
 *
 * **Indeterminate:** when present, always treat as non-terminal for money —
 * `outcome: 'indeterminate'` + `reconciliationRequired: true`. Do not treat as
 * a definitive decline.
 *
 * **After-hook freeze**: money / identity fields (`outcome`, `status`,
 * `amount`, `gatewayId`, capture/order/authorization/refund IDs, `fee`,
 * `capturedAmount`, `refundedAmount`, `clientSecret`, `references`,
 * `reconciliationRequired`, `providerRequestId`, …) are restored from the
 * original gateway result after after-hooks run. After-hooks may only attach
 * additive fields (and cannot flip outcomes via in-place mutation of the hook
 * argument either).
 */
export interface GatewayPaymentResult {
    /**
     * Payment outcome discriminant. Switch on this (or use `isPaidOutcome` / `mapGatewayResultToOperationResult`).
     */
    outcome: PaymentOperationOutcome;
    /** Gateway's primary payment object ID for this operation */
    gatewayId: string;
    /** Gateway object ID when it is useful to expose separately from the primary ID */
    gatewayObjectId?: string | undefined;
    /** PayPal order ID, when the operation involves a PayPal order */
    orderId?: string | undefined;
    /** PayPal capture ID, required for PayPal refunds */
    captureId?: string | undefined;
    /** PayPal authorization ID, required for PayPal authorization captures and voids */
    authorizationId?: string | undefined;
    /** Normalized payment status — gateway internal mapping (payment/refund/setup) */
    status: GatewayPaymentStatus;
    /** Redirect URL for 3DS/PayPal approval (if applicable) - may be undefined */
    redirectUrl: string | undefined;
    /**
     * Amount as {@link Money} (major units + currency). Omitted when provider did not return money.
     * When `amount` / `fee` / `capturedAmount` / `refundedAmount` is set, prefer also setting {@link currency} so Phase-6 snapshots are complete.
     * {@link import("./operation-result").paymentFromGatewayResult} fail-closes incomplete money (Money without currency on sibling field is omitted).
     */
    amount?: Money | undefined;
    /**
     * ISO 4217 currency code for major-unit money fields on this result.
     * Required for a complete money snapshot when any amount-like field is set.
     */
    currency?: string | undefined;
    /** Fee as {@link Money} (major units). */
    fee?: Money | undefined;
    /** Amount captured so far (partial captures) as {@link Money}. */
    capturedAmount?: Money | undefined;
    /** Amount refunded so far (partial refunds) as {@link Money}. */
    refundedAmount?: Money | undefined;
    clientSecret?: string | undefined;
    /** Gateway-specific next action payload for customer authentication or redirects */
    nextAction?: PaymentNextAction | undefined;
    /**
     * Standardized provider references (preferred over ad-hoc id fields alone).
     * Dual-write with legacy `gatewayId` / `orderId` / `captureId` / `authorizationId`.
     */
    references?: ProviderReferences | undefined;
    /** Structured decline when outcome is `declined` (or success false with decline). */
    decline?: PaymentDecline | undefined;
    /**
     * Explicit indeterminate marker. When `outcome === 'indeterminate'`, must be
     * `true`. New clients must reconcile — never treat as definitive decline/paid.
     */
    reconciliationRequired?: boolean | undefined;
    /** Provider request / correlation id when available */
    providerRequestId?: string | undefined;
    /** Raw response from the gateway API */
    rawResponse: unknown;
}

/**
 * Result from gateway refund operations.
 * Note: Some gateways (like Moyasar) don't have separate refund entities.
 * The refund is tracked on the payment object itself.
 *
 * ## Outcome (1.0)
 *
 * `outcome` is **required** — discriminate on {@link import('./operation-result').RefundOperationOutcome}
 * (and `mapGatewayRefundToOperationResult`). `success` was removed in 1.0.
 */
export interface GatewayRefundResult {
    /**
     * Refund outcome discriminant.
     */
    outcome: RefundOperationOutcome;
    /**
     * Gateway's refund identifier.
     * For Moyasar: This is the payment ID (refunds are tracked on payment).
     * For PayPal: This is the actual refund ID.
     */
    gatewayRefundId: string;
    /** Refund processing status */
    status: RefundStatus;
    /** Total amount refunded on this payment as {@link Money}. */
    totalRefunded?: Money | undefined;
    /** Timestamp when refund was processed */
    refundedAt?: Date | undefined;
    /**
     * Explicit indeterminate marker for post-submit unknown refund state.
     * When `outcome === 'indeterminate'`, must be `true`.
     */
    reconciliationRequired?: boolean | undefined;
    /** Provider request / correlation id when available */
    providerRequestId?: string | undefined;
    /** Raw response from the gateway API */
    rawResponse: unknown;
}
