// file: packages/payments/src/types/validation.ts

import { z } from 'zod';
import type { PaymobBillingData } from './payment.types';
// ═══════════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * URL that must use http: or https: only (rejects javascript:, data:, file:, etc.).
 */
const HttpOrHttpsUrlSchema = (message = 'URL must be a valid http or https URL') =>
    z.string().url(message).refine(
        (value) => {
            try {
                const protocol = new URL(value).protocol;
                return protocol === 'http:' || protocol === 'https:';
            } catch {
                return false;
            }
        },
        { message: 'URL must use http or https scheme' },
    );

// ═══════════════════════════════════════════════════════════════════════════════
// Moyasar Source Schemas (module-private composition helpers)
// ═══════════════════════════════════════════════════════════════════════════════

const CreditCardSourceSchema = z.object({
    type: z.literal("creditcard"),
    name: z.string().min(2),
    number: z.string().regex(/^\d{13,19}$/, "Invalid card number format"),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2000),
    cvc: z.string().regex(/^\d{3,4}$/, "Invalid CVC format"),
    statementDescriptor: z.string().optional(),
    _3ds: z.boolean().optional(),
    manualCapture: z.boolean().optional(),
    saveCard: z.boolean().optional(),
});

const CardTokenSourceSchema = z.object({
    type: z.literal("token"),
    token: z.string().startsWith("token_"),
    cvc: z.string().regex(/^\d{3,4}$/).optional(),
    statementDescriptor: z.string().optional(),
    _3ds: z.boolean().optional(),
    manualCapture: z.boolean().optional(),
});

const ApplePaySourceSchema = z.object({
    type: z.literal("applepay"),
    token: z.string(),
    manualCapture: z.boolean().optional(),
    saveCard: z.boolean().optional(),
    statementDescriptor: z.string().optional(),
});

const ApplePayDecryptedSourceSchema = z.object({
    type: z.literal("applepay"),
    dpan: z.string().regex(/^\d{16,19}$/, "Invalid Apple Pay DPAN format"),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2000),
    cryptogram: z.string().min(1).max(64),
    deviceId: z.string().min(8).max(16),
    lastFour: z.string().regex(/^\d{4}$/).optional(),
    eci: z.string().regex(/^\d{2}$/).optional(),
});

const SamsungPaySourceSchema = z.object({
    type: z.literal("samsungpay"),
    token: z.string(),
    manualCapture: z.boolean().optional(),
    saveCard: z.boolean().optional(),
    statementDescriptor: z.string().optional(),
});

const StcPaySourceSchema = z.object({
    type: z.literal("stcpay"),
    mobile: z.string().regex(/^(?:05|\+9665|009665|9665)\d{8}$/, "Invalid KSA mobile number"),
    cashier: z.string().optional(),
    branch: z.string().optional(),
});

const MoyasarPaymentSourceSchema = z.union([
    CreditCardSourceSchema,
    CardTokenSourceSchema,
    ApplePaySourceSchema,
    ApplePayDecryptedSourceSchema,
    SamsungPaySourceSchema,
    StcPaySourceSchema,
]);

const MOYASAR_MAX_METADATA_KEYS = 30;
const MOYASAR_MAX_METADATA_KEY_LENGTH = 40;
const MOYASAR_MAX_METADATA_VALUE_LENGTH = 500;

/**
 * 1.0 Money-only: Money-shaped
 * `{ amount: string, currency: string, exponent?: number }`.
 *
 * CORE-2: Money arm enforces decimal form + sign at the Zod boundary so
 * adapters that trust schemas alone cannot pass garbage/negative Money into
 * conversion. Full scale/exponent checks remain in shared money helpers.
 *
 * P05-MONEY-1: optional `exponent` (integer 0–18) is part of the object so
 * Zod does not strip a stored non-ISO scale (e.g. OMR merchant override 2).
 */
const MoneyAmountBaseSchema = z
    .object({
        amount: z.string().min(1, "Money.amount must be a non-empty decimal string"),
        currency: z.string().min(1, "Money.currency must be a non-empty string"),
        exponent: z.number().int().min(0).max(18).optional(),
    })
    // Drop `exponent: undefined` so parsed Money matches `exponent?: number`
    // under exactOptionalPropertyTypes (Stripe toStripeAmount / AmountInput).
    .transform((val) =>
        val.exponent === undefined
            ? { amount: val.amount, currency: val.currency }
            : { amount: val.amount, currency: val.currency, exponent: val.exponent },
    );

/** Decimal major-unit string: optional leading sign, digits, optional fraction. */
const MONEY_DECIMAL_FORM = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function moneyAmountNumericValue(amount: string): number | undefined {
    const trimmed = amount.trim();
    if (!MONEY_DECIMAL_FORM.test(trimmed)) return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return undefined;
    return n;
}

/**
 * Shared Money.amount Zod refine: finite decimal form, then a sign/zero check.
 * Keeps Positive / Nonnegative / Moyasar-split arms DRY.
 */
function refineMoneyAmountValue(
    val: { amount: string },
    ctx: z.RefinementCtx,
    isInvalid: (n: number) => boolean,
    invalidMessage: string,
): void {
    const n = moneyAmountNumericValue(val.amount);
    if (n === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Money.amount must be a finite decimal string",
            path: ["amount"],
        });
        return;
    }
    if (isInvalid(n)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: invalidMessage,
            path: ["amount"],
        });
    }
}

/** Positive Money shape (create/capture/refund amounts). */
const PositiveMoneyAmountSchema = MoneyAmountBaseSchema.superRefine((val, ctx) => {
    refineMoneyAmountValue(
        val,
        ctx,
        (n) => n <= 0,
        "Money.amount must be a positive finite decimal",
    );
});

/** Non-negative Money shape (e.g. free-trial $0 line items). */
const NonnegativeMoneyAmountSchema = MoneyAmountBaseSchema.superRefine((val, ctx) => {
    refineMoneyAmountValue(
        val,
        ctx,
        (n) => n < 0,
        "Money.amount must be a non-negative finite decimal",
    );
});

const PositiveAmountInputSchema = PositiveMoneyAmountSchema;

const OptionalPositiveAmountInputSchema = PositiveAmountInputSchema.optional();

/**
 * Nonnegative Money amount (free-trial $0 line items) — Money-only in 1.0.
 */
const NonnegativeAmountInputSchema = NonnegativeMoneyAmountSchema;
/**
 * When `amount` is a Money object and a top-level `currency` is present,
 * require case-insensitive currency match (deep scale checks stay in money helpers).
 */
function refineMoneyCurrencyMatch(
    params: { amount?: unknown; currency?: string | undefined },
    ctx: z.RefinementCtx,
    amountPath: (string | number)[] = ["amount"],
): void {
    const amount = params.amount;
    const currency = params.currency;
    if (
        amount === undefined ||
        currency === undefined ||
        typeof amount !== "object" ||
        amount === null ||
        typeof (amount as { currency?: unknown }).currency !== "string"
    ) {
        return;
    }
    const moneyCurrency = (amount as { currency: string }).currency
        .trim()
        .toUpperCase();
    const expected = currency.trim().toUpperCase();
    if (moneyCurrency.length > 0 && expected.length > 0 && moneyCurrency !== expected) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Money.currency (${moneyCurrency}) must match currency (${expected})`,
            path: [...amountPath, "currency"],
        });
    }
}

/** Split amounts are major currency units — Money only (1.0). Signed adjustments allowed, zero rejected. */
const MoyasarSplitMoneyAmountSchema = MoneyAmountBaseSchema.superRefine((val, ctx) => {
    refineMoneyAmountValue(
        val,
        ctx,
        (n) => n === 0,
        "Moyasar split amount cannot be zero",
    );
});

const MoyasarPaymentSplitSchema = z.object({
    amount: MoyasarSplitMoneyAmountSchema,
    recipient_id: z.string().uuid("Moyasar split recipient_id must be a UUID"),
    reference: z.string().max(255).optional(),
    description: z.string().max(255).optional(),
    fee_source: z.boolean().optional(),
    refundable: z.boolean().optional(),
});

const MoyasarAftRecipientSchema = z.object({
    first_name: z.string().min(1).max(30),
    last_name: z.string().min(1).max(35),
    middle_name: z.string().max(35).optional(),
    address: z.string().min(1).max(50),
    street_name: z.string().max(50).optional(),
    postal_code: z.string().max(10).optional(),
    locality: z.string().max(25).optional(),
    country: z.string().regex(/^[A-Za-z]{2}$/, "Moyasar AFT recipient country must be ISO alpha-2").optional(),
    building_number: z.string().max(19).optional(),
});

const MoyasarAftSenderSchema = z.object({
    // Legacy AFT sender account block, kept for backwards compatibility.
    account: z.object({
        funds_source: z.string().min(1).max(2),
        number: z.string().min(1),
    }).optional(),
    first_name: z.string().min(1).max(30),
    last_name: z.string().min(1).max(35),
    address: z.string().min(1).max(50),
    locality: z.string().max(25).optional(),
    postal_code: z.string().max(10).optional(),
    administrative_area: z.string().max(2).optional(),
    country_code: z.string().max(2).optional(),
    id_type: z.enum([
        "ARNB",
        "BTHD",
        "CPNY",
        "CUID",
        "DRLN",
        "EMAL",
        "LAWE",
        "MILI",
        "NTID",
        "PASN",
        "PHON",
        "PRXY",
        "SSNB",
        "TRVL",
    ]),
    id: z.string().min(1).max(50),
    phone_number: z.string().min(1).max(20),
});

const MoyasarMetadataSchema = z.record(
    z.string()
).superRefine((metadata, ctx) => {
    const entries = Object.entries(metadata);

    if (entries.length > MOYASAR_MAX_METADATA_KEYS) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Moyasar metadata can include at most ${MOYASAR_MAX_METADATA_KEYS} keys`,
        });
    }

    for (const [key, value] of entries) {
        if (key.length > MOYASAR_MAX_METADATA_KEY_LENGTH) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Moyasar metadata key "${key}" must be ${MOYASAR_MAX_METADATA_KEY_LENGTH} characters or fewer`,
                path: [key],
            });
        }

        if (String(value).length > MOYASAR_MAX_METADATA_VALUE_LENGTH) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Moyasar metadata value for "${key}" must be ${MOYASAR_MAX_METADATA_VALUE_LENGTH} characters or fewer`,
                path: [key],
            });
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Core Operation Params Schemas
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Non-empty idempotency key when provided.
 * Rejects empty string and whitespace-only values (CORE-2): whitespace-only keys
 * are unstable across gateways that trim (e.g. Stripe → missing → auto-UUID per
 * call), which silently drops crash/retry protection.
 */
const OptionalIdempotencyKeySchema = z
    .string()
    .min(1, "idempotencyKey must be non-empty when provided")
    .refine((value) => value.trim().length > 0, {
        message: "idempotencyKey must not be whitespace-only",
    })
    .optional();

/**
 * Moyasar payment sources safe for merchant backend use.
 * Excludes raw `creditcard` (must be tokenized client-side via Moyasar.js).
 */
const MoyasarBackendPaymentSourceSchema = z.union([
    CardTokenSourceSchema,
    ApplePaySourceSchema,
    ApplePayDecryptedSourceSchema,
    SamsungPaySourceSchema,
    StcPaySourceSchema,
]);

/** Extendable object shape (no effects) so gateway-specific schemas can `.extend`. */
const CreatePaymentParamsObjectSchema = z.object({
    amount: PositiveAmountInputSchema,
    currency: z.string().length(3, "Currency must be 3-letter ISO code"),
    callbackUrl: HttpOrHttpsUrlSchema("Callback URL must be a valid URL"),
    orderId: z.string().optional(),
    description: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    capture: z.boolean().default(true),
    idempotencyKey: OptionalIdempotencyKeySchema,
    customerId: z.string().min(1).optional(),
    paymentMethodId: z.string().min(1).optional(),
    offSession: z.boolean().optional(),
}).strict();

export const CreatePaymentParamsSchema = CreatePaymentParamsObjectSchema.superRefine(
    (params, ctx) => {
        refineMoneyCurrencyMatch(params, ctx);
        // H5: plain CreatePaymentParams is closed — reject provider-specific fields that belong on per-gateway schemas.
        const record = params as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            if (key === "tokenId") {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `tokenId was removed in 1.0 — use moyasarSource: { type: "token", token }`,
                    path: [key],
                });
                continue;
            }
            if (
                key.startsWith("stripe") ||
                key.startsWith("moyasar") ||
                key.startsWith("paymob") ||
                key === "returnUrl" ||
                key === "cancelUrl" ||
                key === "paypalShippingPreference" ||
                key === "applyCoupon" ||
                key === "splits" ||
                key === "recipient" ||
                key === "sender"
            ) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Unknown field '${key}' — use per-gateway schema (e.g. StripeCreatePaymentParams)`,
                    path: [key],
                });
            }
        }
    },
);

export const MoyasarCreatePaymentParamsSchema = CreatePaymentParamsObjectSchema.extend({
    callbackUrl: HttpOrHttpsUrlSchema("Callback URL must be a valid URL").optional(),
    metadata: MoyasarMetadataSchema.optional(),
    idempotencyKey: z.string().uuid("Moyasar idempotencyKey must be a UUID because it becomes the payment ID").min(1).optional(),
    /** Backend-safe sources only — raw creditcard is rejected at schema level. */
    moyasarSource: MoyasarBackendPaymentSourceSchema.optional(),
    applyCoupon: z.boolean().optional(),
    splits: z.array(MoyasarPaymentSplitSchema).optional(),
    recipient: MoyasarAftRecipientSchema.optional(),
    sender: MoyasarAftSenderSchema.optional(),
});

/**
 * Shared Paymob billing data schema — reuses {@link PaymobBillingData} from
 * `payment.types.ts` as single source of truth (deduped).
 */
export const PaymobBillingDataSchema = z.object({
    email: z.string().email(),
    firstName: z.string().min(1).max(50),
    lastName: z.string().min(1).max(50),
    phone: z.string().min(5),
    country: z.string().optional(),
    city: z.string().optional(),
    street: z.string().optional(),
    building: z.string().optional(),
    apartment: z.string().optional(),
    floor: z.string().optional(),
    postalCode: z.string().optional(),
    state: z.string().optional(),
}) satisfies z.ZodType<PaymobBillingData>;

export const PaymobCreatePaymentParamsSchema = CreatePaymentParamsObjectSchema.extend({
    callbackUrl: HttpOrHttpsUrlSchema("Callback URL must be a valid URL").optional(),
    paymobIntegrationId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    paymobPaymentMethods: z.array(z.union([z.string().trim().min(1), z.number().int().positive()])).min(1).optional(),
    paymobIframeId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
    paymobBillingData: PaymobBillingDataSchema.optional(),
}).superRefine((params, ctx) => {
    refineMoneyCurrencyMatch(params, ctx);
});

/**
 * PayPal order creation. callbackUrl is optional at the schema level because
 * PayPal uses returnUrl/cancelUrl; at least one success return URL
 * (callbackUrl | returnUrl) is required, and cancel falls back to
 * cancelUrl | callbackUrl | returnUrl.
 */
export const PayPalCreatePaymentParamsSchema = CreatePaymentParamsObjectSchema.extend({
    callbackUrl: HttpOrHttpsUrlSchema("Callback URL must be a valid URL").optional(),
    returnUrl: HttpOrHttpsUrlSchema().optional(),
    cancelUrl: HttpOrHttpsUrlSchema().optional(),
    paypalShippingPreference: z.enum(["GET_FROM_FILE", "NO_SHIPPING", "SET_PROVIDED_ADDRESS"]).optional(),
}).superRefine((params, ctx) => {
    refineMoneyCurrencyMatch(params, ctx);
    const hasSuccessReturn = Boolean(params.callbackUrl || params.returnUrl);
    if (!hasSuccessReturn) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
                "PayPal create requires at least one of callbackUrl or returnUrl",
            path: ["returnUrl"],
        });
    }

    const hasCancelFallback = Boolean(
        params.cancelUrl || params.callbackUrl || params.returnUrl,
    );
    if (!hasCancelFallback) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
                "PayPal create requires at least one of cancelUrl, callbackUrl, or returnUrl for cancel fallback",
            path: ["cancelUrl"],
        });
    }
});

export const StripeCreatePaymentParamsSchema = CreatePaymentParamsObjectSchema.extend({
    callbackUrl: HttpOrHttpsUrlSchema("Callback URL must be a valid URL").optional(),
    stripePaymentMethodId: z.string().startsWith('pm_', 'Stripe Payment Method ID must start with pm_').optional(),
    stripeCustomerId: z.string().startsWith('cus_', 'Stripe Customer ID must start with cus_').optional(),
    stripeSetupFutureUsage: z.enum(['on_session', 'off_session']).optional(),
}).superRefine((params, ctx) => {
    refineMoneyCurrencyMatch(params, ctx);
});

export type StripeCreatePaymentParams = z.input<typeof StripeCreatePaymentParamsSchema>;
export type PayPalCreatePaymentParams = z.input<typeof PayPalCreatePaymentParamsSchema>;
const CaptureParamsObjectSchema = z.object({
    gatewayPaymentId: z.string().min(1),
    amount: OptionalPositiveAmountInputSchema,
    currency: z.string().length(3).optional(),
    idempotencyKey: OptionalIdempotencyKeySchema,
    paypalCaptureType: z.enum(["order", "authorization"]).optional(),
    paypalFinalCapture: z.boolean().optional(),
}).strict();

export const CaptureParamsSchema = CaptureParamsObjectSchema.superRefine(
    (params, ctx) => {
        refineMoneyCurrencyMatch(params, ctx);
    },
);

const RefundParamsObjectSchema = z.object({
    gatewayPaymentId: z.string().min(1),
    amount: OptionalPositiveAmountInputSchema,
    reason: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    currency: z.string().length(3).optional(),
    idempotencyKey: OptionalIdempotencyKeySchema,
}).strict();

export const RefundParamsSchema = RefundParamsObjectSchema.superRefine(
    (params, ctx) => {
        refineMoneyCurrencyMatch(params, ctx);
    },
);

export const VoidParamsSchema = z.object({
    gatewayPaymentId: z.string().min(1),
    idempotencyKey: OptionalIdempotencyKeySchema,
}).strict();

export const GetPaymentParamsSchema = z.object({
    gatewayPaymentId: z.string().min(1, "Gateway payment ID is required"),
}).strict();

const MoyasarGatewayPaymentIdSchema = z.string().uuid(
    "Moyasar gatewayPaymentId must be a UUID",
);

export const MoyasarCaptureParamsSchema = CaptureParamsObjectSchema.extend({
    gatewayPaymentId: MoyasarGatewayPaymentIdSchema,
}).superRefine((params, ctx) => {
    refineMoneyCurrencyMatch(params, ctx);
});

export const MoyasarRefundParamsSchema = RefundParamsObjectSchema.extend({
    gatewayPaymentId: MoyasarGatewayPaymentIdSchema,
}).superRefine((params, ctx) => {
    refineMoneyCurrencyMatch(params, ctx);
});

export const MoyasarVoidParamsSchema = VoidParamsSchema.extend({
    gatewayPaymentId: MoyasarGatewayPaymentIdSchema,
});

export const MoyasarGetPaymentParamsSchema = GetPaymentParamsSchema.extend({
    gatewayPaymentId: MoyasarGatewayPaymentIdSchema,
});

// ═══════════════════════════════════════════════════════════════════════════════
// Stripe Checkout Session Schemas
// ═══════════════════════════════════════════════════════════════════════════════

const STRIPE_CHECKOUT_PAYMENT_LINE_ITEM_LIMIT = 100;
const STRIPE_CHECKOUT_SUBSCRIPTION_TOTAL_LINE_ITEM_LIMIT = 40;
const STRIPE_CHECKOUT_SUBSCRIPTION_RECURRING_LINE_ITEM_LIMIT = 20;

const StripeCheckoutLineItemSchema = z.object({
    priceData: z.object({
        currency: z.string().length(3),
        productData: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            // CORE-3: product images must be http(s) only (reject javascript:/data:/file:).
            images: z.array(HttpOrHttpsUrlSchema("Image URL must be a valid http or https URL")).optional(),
        }),
        /**
         * Amount in major currency units (`number | Money`); converted to Stripe
         * minor units. Zero allowed for free trials / fully discounted items.
         */
        amount: NonnegativeAmountInputSchema.optional(),
        /** Stripe minor-unit amount. Kept for callers that already store Stripe price data. */
        unitAmount: z.number().finite().int().nonnegative().optional(),
        /** Recurring price settings required for inline subscription prices. */
        recurring: z.object({
            interval: z.enum(['day', 'week', 'month', 'year']),
            intervalCount: z.number().int().positive().optional(),
        }).optional(),
    }).superRefine((priceData, ctx) => {
        const hasAmount = priceData.amount !== undefined;
        const hasUnitAmount = priceData.unitAmount !== undefined;

        if (hasAmount === hasUnitAmount) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Price data must include exactly one of amount or unitAmount",
                path: ["amount"],
            });
        }

        refineMoneyCurrencyMatch(
            { amount: priceData.amount, currency: priceData.currency },
            ctx,
            ["amount"],
        );
    }).optional(),
    price: z.string().startsWith('price_').optional(),
    quantity: z.number().int().positive(),
}).superRefine((item, ctx) => {
    const hasPrice = Boolean(item.price);
    const hasPriceData = Boolean(item.priceData);

    if (hasPrice === hasPriceData) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Line item must include exactly one of price or priceData",
            path: ["price"],
        });
    }
});

export const CreateCheckoutSessionParamsSchema = z.object({
    /** Prefer Money; plain major-unit number remains 0.x-deprecated. */
    amount: OptionalPositiveAmountInputSchema,
    currency: z.string().length(3, "Currency must be 3-letter ISO code").optional(),
    successUrl: HttpOrHttpsUrlSchema("Success URL must be valid"),
    /**
     * Required at runtime for `payment` and `subscription` hosted Checkout.
     * Setup mode may omit it. Always http(s) when present.
     */
    cancelUrl: HttpOrHttpsUrlSchema("Cancel URL must be valid").optional(),
    mode: z.enum(['payment', 'subscription', 'setup']).default('payment'),
    lineItems: z.array(StripeCheckoutLineItemSchema).min(1).optional(),
    customerId: z.string().startsWith('cus_').optional(),
    customerEmail: z.string().email().optional(),
    metadata: z.record(z.unknown()).optional(),
    paymentMethodTypes: z.array(z.string().min(1)).optional(),
    idempotencyKey: OptionalIdempotencyKeySchema,
}).strict().superRefine((params, ctx) => {
    refineMoneyCurrencyMatch(params, ctx);

    const mode = params.mode ?? 'payment';
    const hasLineItems = Boolean(params.lineItems?.length);
    const hasAmount = params.amount !== undefined;
    const hasCurrency = params.currency !== undefined;
    const hasSimpleAmount = hasAmount && hasCurrency;
    const hasPaymentMethodTypes = Boolean(params.paymentMethodTypes?.length);
    const hasCancelUrl =
        typeof params.cancelUrl === 'string' && params.cancelUrl.length > 0;

    if ((mode === 'payment' || mode === 'subscription') && !hasCancelUrl) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
                "Payment and subscription Checkout Sessions require cancelUrl",
            path: ["cancelUrl"],
        });
    }

    if (hasLineItems && (hasAmount || hasCurrency)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Checkout sessions must use either lineItems or amount and currency, not both",
            path: ["lineItems"],
        });
    }

    if (mode === 'payment' && !hasLineItems && !hasSimpleAmount) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Payment mode requires lineItems or amount and currency",
            path: ["lineItems"],
        });
    }

    if ((mode === 'payment' || mode === 'subscription') && (hasAmount !== hasCurrency) && !hasLineItems) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Amount-based Checkout Sessions require both amount and currency",
            path: hasAmount ? ["currency"] : ["amount"],
        });
    }

    if (mode === 'subscription' && !hasLineItems) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Subscription mode requires lineItems",
            path: ["lineItems"],
        });
    }

    if (mode === 'payment' && hasLineItems && params.lineItems!.length > STRIPE_CHECKOUT_PAYMENT_LINE_ITEM_LIMIT) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Payment mode supports at most ${STRIPE_CHECKOUT_PAYMENT_LINE_ITEM_LIMIT} lineItems`,
            path: ["lineItems"],
        });
    }

    if (mode === 'subscription' && hasLineItems) {
        const lineItems = params.lineItems!;
        const inlineRecurringCount = lineItems.filter((item) => Boolean(item.priceData?.recurring)).length;

        if (lineItems.length > STRIPE_CHECKOUT_SUBSCRIPTION_TOTAL_LINE_ITEM_LIMIT) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Subscription mode supports at most 40 lineItems (20 recurring and 20 one-time)",
                path: ["lineItems"],
            });
        }

        if (inlineRecurringCount > STRIPE_CHECKOUT_SUBSCRIPTION_RECURRING_LINE_ITEM_LIMIT) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Subscription mode supports at most ${STRIPE_CHECKOUT_SUBSCRIPTION_RECURRING_LINE_ITEM_LIMIT} recurring lineItems`,
                path: ["lineItems"],
            });
        }
    }

    if (mode === 'setup' && (hasLineItems || hasAmount)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Setup mode does not accept lineItems or amount",
            path: hasLineItems ? ["lineItems"] : ["amount"],
        });
    }

    if (mode === 'subscription') {
        params.lineItems?.forEach((item, index) => {
            if (item.priceData && !item.priceData.recurring) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "Subscription mode inline priceData requires recurring settings",
                    path: ["lineItems", index, "priceData", "recurring"],
                });
            }
        });
    }

    if (mode === 'setup' && !params.currency && !hasPaymentMethodTypes) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Setup mode requires currency or paymentMethodTypes",
            path: ["currency"],
        });
    }
});

/** Input type for CreateCheckoutSession (allows optional default values) */
export type CreateCheckoutSessionParams =
    Omit<z.input<typeof CreateCheckoutSessionParamsSchema>, "amount"> & {
        /**
         * Prefer {@link import("./payment.types").AmountInput} / Money for simple
         * amount-based sessions; plain major-unit `number` remains 0.x-deprecated.
         * Requires `currency` when set (and is exclusive with `lineItems`).
         */
        amount?: import("./payment.types").AmountInput;
        /**
         * Optional cancellation for the Checkout Session HTTP request.
         * Stripped before Zod `.strict()` validation and reattached for the network layer.
         */
        signal?: AbortSignal;
    };
