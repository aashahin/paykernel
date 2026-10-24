// file: packages/payments/src/gateways/base.gateway.ts

import type { PaymentGateway } from './gateway.interface';
import type {
    CreatePaymentParams,
    CaptureParams,
    RefundParams,
    GatewayPaymentResult,
    GatewayRefundResult,
} from '../types/payment.types';
import type { WebhookEvent } from '../types/webhook.types';
import type { GatewayConfig } from '../types/config.types';
import type { HookContext, OperationType } from '../hooks/hooks.types';
import type { HooksManager } from '../hooks/hooks.manager';
import { z } from 'zod';
import {
    PaymentAbortedError,
    InvalidRequestError,
    PaymentError,
    OperationNotSupportedError,
    NetworkError,
} from '../errors';
import {
    applyIndeterminatePaymentOutcome,
    applyIndeterminateRefundOutcome,
} from '../types/operation-result';
import {
    applyIndeterminateCheckoutSessionOutcome,
    type CheckoutSessionOperationResult,
} from '../types/checkout.types';
import {
    applyIndeterminateCustomerOutcome,
    applyIndeterminatePaymentMethodOutcome,
    type CustomerOperationResult,
    type PaymentMethodOperationResult,
} from '../types/customer.types';
import {
    applyIndeterminateDisputeOutcome,
    type DisputeOperationResult,
} from '../types/dispute.types';
import {
    applyIndeterminatePaymentLinkOutcome,
    type PaymentLinkOperationResult,
} from '../types/payment-link.types';
import { assertNoRawCardMaterial } from '../utils/raw-card';
import { createRedactingLogger, noopLogger, type Logger } from '../utils/logger';
import type { Clock } from '../runtime/clock';
import type {
    GatewayRuntimeDeps,
    PaymentRuntime,
} from '../runtime/payment-runtime';
import { createPaymentRuntime } from '../runtime/payment-runtime';
import {
    extractAbortSignal,
    stripAbortSignal,
    withAbortSignal,
} from '../runtime/abort';
import {
    defineGatewayCapabilities,
    freezeCapabilities,
    requiredCapabilitiesForOperation,
    type GatewayCapabilities,
    type GatewayCapabilityKey,
} from './gateway-capabilities';
import {
    detachNestedIdentityFields,
    restoreMoneyIdentityFields,
    shallowCloneResult,
} from '../hooks/money-identity';

/**
 * Abstract base gateway that provides hook execution for all operations.
 * All concrete gateway implementations should extend this class.
 *
 * `name` is an open string so third-party gateways need not cast to the
 * closed built-in {@link import('../types/payment.types').GatewayName} union.
 *
 * ## Capabilities (Phase 3)
 *
 * Instances always expose a complete frozen {@link capabilities} snapshot.
 * Pass explicit claims via the optional constructor argument (or
 * {@link defineGatewayCapabilities}). When omitted, capabilities default to
 * **all false** (fail-closed). The base class does **not** infer `true` from
 * optional method presence — built-ins and third-party adapters must claim
 * support deliberately.
 */
export abstract class BaseGateway implements PaymentGateway {
    abstract readonly name: string;

    /**
     * Frozen, complete capability snapshot. Always every
     * {@link GatewayCapabilityKey}, never partial.
     */
    readonly capabilities: GatewayCapabilities;

    /**
     * Redacting logger shared by all gateways. Defaults to a no-op when the
     * client is created without a logger. Never log secrets/PII directly;
     * structured context passed here is scrubbed before reaching the sink.
     */
    protected readonly logger: Logger;

    /**
     * Portable runtime (fetch / crypto / clock / randomUUID).
     * Defaults from {@link createPaymentRuntime} when ctor omits overrides.
     */
    protected readonly runtime: PaymentRuntime;

    /** Injected HTTP implementation (never bare global `fetch` at call sites). */
    protected readonly fetch: typeof globalThis.fetch;

    /** Wall clock from runtime (prefer over `Date.now` for ops/skew). */
    protected readonly clock: Clock;

    /**
     * @param config - Gateway config (may contain secrets; never copied into capabilities)
     * @param hooks - Shared hooks manager
     * @param logger - Optional logger sink (wrapped with redaction)
     * @param capabilities - Optional partial or complete capability claims.
     *   Merged with all-false defaults via {@link defineGatewayCapabilities}.
     *   Do not put secrets or credential material here.
     * @param runtime - Optional partial {@link PaymentRuntime} (fetch/crypto/clock/uuid).
     *   When omitted, portable defaults are used so `new StripeGateway(config, hooks)` still works.
     *   Access Web Crypto via `this.runtime.crypto` when needed.
     */
    constructor(
        protected readonly config: GatewayConfig,
        protected readonly hooks: HooksManager,
        logger?: Logger,
        capabilities?: Partial<GatewayCapabilities> | GatewayCapabilities,
        runtime?: GatewayRuntimeDeps,
    ) {
        // Skip wrapping when no sink is configured (or the shared noop is
        // passed explicitly via GatewayContext defaults) so we never pay
        // redaction cost for discarded logs, and never double-wrap the
        // client's already-redacting logger when callers pass the raw sink.
        this.logger =
            logger && logger !== noopLogger
                ? createRedactingLogger(logger)
                : noopLogger;
        this.capabilities = freezeCapabilities(
            defineGatewayCapabilities(capabilities ?? {}),
        );
        this.runtime = createPaymentRuntime(runtime ?? {});
        this.fetch = this.runtime.fetch;
        this.clock = this.runtime.clock;
    }

    /**
     * Whether this gateway claims support for `capability`.
     * Backed solely by {@link capabilities} — never by method duck-typing.
     */
    supports(capability: GatewayCapabilityKey): boolean {
        return this.capabilities[capability] === true;
    }

    /**
     * Throw {@link OperationNotSupportedError} with capability metadata when
     * the gateway does not claim `capability`. Use before capability-gated ops.
     */
    protected assertCapability(
        capability: GatewayCapabilityKey,
        operation: string,
    ): void {
        if (!this.supports(capability)) {
            throw new OperationNotSupportedError(this.name, operation, {
                capability,
                claimedSupport: false,
            });
        }
    }

    /**
     * After before-hooks, gate the operation against {@link supports}.
     * Claims are authoritative: a method may exist and still be rejected.
     */
    protected assertCapabilitiesAfterHooks(
        operation: OperationType,
        params: unknown,
    ): void {
        for (const capability of requiredCapabilitiesForOperation(
            operation,
            params,
        )) {
            this.assertCapability(capability, operation);
        }
    }

    /**
     * Template method that wraps any operation with before/after/error hooks
     */
    protected async executeWithHooks<T, R>(
        operation: OperationType,
        params: T,
        executor: (params: T) => Promise<R>,
        schema?: z.ZodType
    ): Promise<R> {
        // AbortSignal is not Zod-friendly (and would fail `.strict()` schemas).
        // Strip before validation, reattach after so the HTTP layer still sees it.
        const initialSignal = extractAbortSignal(params);
        const { rest: paramsForValidation } = stripAbortSignal(params);

        // Validation Layer — use parsed data so Zod defaults/transforms apply
        let validatedParams = paramsForValidation as T;
        if (schema) {
            const parsed = schema.safeParse(paramsForValidation);
            if (!parsed.success) {
                throw new InvalidRequestError(
                    `Validation failed for ${operation}`,
                    parsed.error.issues
                );
            }
            validatedParams = withAbortSignal(parsed.data as T, initialSignal);
        } else {
            validatedParams = withAbortSignal(validatedParams, initialSignal);
        }

        // Fence inbound params before before-hooks so CHD never reaches hooks.
        if (isPciFencedOperation(operation)) {
            assertNoRawCardMaterial(paramsForValidation);
            assertNoRawCardMaterial(validatedParams);
        }

        const ctx: HookContext<T> = {
            gateway: this.name,
            operation,
            params: validatedParams,
            timestamp: new Date(),
            metadata: {},
        };

        // Execute before hooks
        const beforeResult = await this.hooks.runBefore(ctx);
        if (!beforeResult.proceed) {
            throw new PaymentAbortedError(beforeResult.abortReason);
        }

        // Use modified params if provided by hooks; re-validate so defaults/transforms apply
        let finalParams = beforeResult.params ?? validatedParams;
        // Re-assert the PCI fence after before-hooks so hooks cannot inject CHD
        // past the client-layer check. Moyasar applepay DPAN / token CVC are
        // allowlisted inside assertNoRawCardMaterial (skipped moyasarSource).
        if (isPciFencedOperation(operation)) {
            assertNoRawCardMaterial(finalParams);
        }
        const hookSignal =
            extractAbortSignal(finalParams) ?? initialSignal;
        if (schema) {
            const { rest: finalForValidation } = stripAbortSignal(finalParams);
            const parsed = schema.safeParse(finalForValidation);
            if (!parsed.success) {
                throw new InvalidRequestError(
                    `Validation failed for ${operation}`,
                    parsed.error.issues
                );
            }
            finalParams = withAbortSignal(parsed.data as T, hookSignal);
        } else {
            finalParams = withAbortSignal(finalParams, hookSignal);
        }

        // P05-CAPS-1: re-assert claims on hook-final params so before-hooks
        // cannot inject capture:false / amount / splits past capability:false.
        this.assertCapabilitiesAfterHooks(operation, finalParams);

        let result: R;
        try {
            // Execute the actual gateway operation
            result = await executor(finalParams);
        } catch (error) {
            // Map to standardized error
            const mappedError = this.mapError(error);

            // P610-IND-1: fetch timeout / 5xx / connection drop after a mutating
            // POST may have been accepted by the provider. Return an explicit
            // indeterminate arm instead of throwing NetworkError (which callers
            // treat as "failed — retry create"). Queries still throw.
            const indeterminate = tryIndeterminateFromNetworkError(
                operation,
                finalParams,
                mappedError,
                this.name,
            );
            if (indeterminate !== undefined) {
                return indeterminate as R;
            }

            // Error hooks are secondary: log failures but always rethrow the mapped error
            try {
                await this.hooks.runError(ctx, mappedError);
            } catch (hookError) {
                this.logger.error('onError hook failed', {
                    operation,
                    gateway: this.name,
                    hookError:
                        hookError instanceof Error
                            ? hookError.message
                            : String(hookError),
                    originalError: mappedError.message,
                });
            }
            throw mappedError;
        }

        // After hooks run only on successful executor. The gateway side-effect
        // already committed — after hooks must never convert success into a
        // payment failure (no PaymentAbortedError, no rethrow of hook errors).
        // runAfter isolates per-handler throws/proceed:false and keeps last good
        // modifiedResult; this outer catch is a residual safety net.
        //
        // Deep-detach nested identity from any rawResponse alias, then pass a
        // shallow clone (with nested identity deep-cloned again) into runAfter
        // so in-place mutation of the hook argument cannot poison freeze.
        const originalResult = detachNestedIdentityFields(result);
        const resultForHooks = shallowCloneResult(originalResult);

        let afterResult: { proceed: boolean; modifiedResult?: R };
        try {
            afterResult = await this.hooks.runAfter(
                { ...ctx, params: finalParams },
                resultForHooks,
            );
        } catch (hookError) {
            this.logger.error(
                'after hook threw; returning successful gateway result',
                {
                    operation,
                    gateway: this.name,
                    hookError:
                        hookError instanceof Error
                            ? hookError.message
                            : String(hookError),
                },
            );
            return originalResult;
        }

        if (!afterResult.proceed) {
            this.logger.warn(
                'after hook returned proceed:false; ignored because side-effect already committed',
                {
                    operation,
                    gateway: this.name,
                },
            );
        }

        const modified = (afterResult.modifiedResult ?? originalResult) as R;
        if (modified === null || typeof modified !== 'object') {
            this.logger.warn(
                'after hook modifiedResult was not a non-null object; ignored',
                {
                    operation,
                    gateway: this.name,
                },
            );
        }
        return restoreMoneyIdentityFields(originalResult, modified);
    }

    /**
     * Map gateway-specific error to SDK unified error.
     * Gateways can override this to provide specific mapping logic.
     */
    protected mapError(error: unknown): Error {
        // If it's already a PaymentError (from SDK), pass it through
        if (error instanceof PaymentError) {
            return error;
        }
        return error instanceof Error ? error : new Error(String(error));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Abstract methods to be implemented by concrete gateways
    // ═══════════════════════════════════════════════════════════════════════════

    abstract createPayment(params: CreatePaymentParams): Promise<GatewayPaymentResult>;
    abstract capturePayment(params: CaptureParams): Promise<GatewayPaymentResult>;
    abstract refundPayment(params: RefundParams): Promise<GatewayRefundResult>;
    abstract verifyWebhook(
        payload: unknown,
        signature?: string,
        headers?: Record<string, string>,
    ): boolean;
    /**
     * Parse gateway webhook → {@link WebhookEvent}. Prefer dual-writing
     * Phase 7 PaymentEvent via `attachPaymentEvent` (see built-in gateways).
     */
    abstract parseWebhookEvent(payload: unknown): WebhookEvent;
}

function isPostSubmitMoneyMutation(operation: OperationType): boolean {
    return (
        operation === "createPayment" ||
        operation === "authorizePayment" ||
        operation === "capturePayment" ||
        operation === "refundPayment" ||
        operation === "voidPayment" ||
        operation === "confirmStcPayOtp" ||
        operation === "createCheckoutSession"
    );
}

function isPostSubmitCustomerMutation(operation: OperationType): boolean {
    return (
        operation === "createCustomer" ||
        operation === "attachPaymentMethod" ||
        operation === "detachPaymentMethod" ||
        operation === "submitDisputeEvidence" ||
        operation === "createPaymentLink" ||
        operation === "deactivatePaymentLink"
    );
}

function isPciFencedOperation(operation: OperationType): boolean {
    return (
        operation === "createPayment" ||
        operation === "createCustomer" ||
        operation === "getCustomer" ||
        operation === "attachPaymentMethod" ||
        operation === "detachPaymentMethod" ||
        operation === "listPaymentMethods" ||
        operation === "createCheckoutSession" ||
        operation === "getCheckoutSession" ||
        operation === "getDispute" ||
        operation === "listDisputes" ||
        operation === "submitDisputeEvidence" ||
        operation === "createPaymentLink" ||
        operation === "getPaymentLink" ||
        operation === "deactivatePaymentLink"
    );
}

/**
 * Best-effort provider object id for post-submit indeterminate results
 * (CORE-7). Prefer a real payment / order / OTP identity over `"unknown"` so
 * operators can still `getPayment` / reconcile after create/OTP timeout.
 *
 * Create without `orderId` / `gatewayPaymentId` / `idempotencyKey` still
 * returns `"unknown"` — the provider has not assigned an id yet. See
 * `docs/operation-results.md` (P610-IND-1 / CORE-7).
 */
const POST_SUBMIT_ID_KEYS = [
    "gatewayPaymentId",
    "orderId",
    "paymentId",
    "gatewayId",
    "paymentIntentId",
    "sessionId",
    "intentionId",
    "authorizationId",
    "captureId",
    "gatewayRefundId",
    "refundId",
    "transactionUrl",
    "idempotencyKey",
    "customerId",
    "paymentMethodId",
    "disputeId",
    "paymentLinkId",
] as const;

function firstParamId(params: unknown, keys: readonly string[]): string {
    if (params === null || typeof params !== "object") {
        return "unknown";
    }
    const record = params as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }
    return "unknown";
}

function providerObjectIdFromParams(params: unknown): string {
    return firstParamId(params, POST_SUBMIT_ID_KEYS);
}

/** Prefer the mutated object id; fall back to idempotencyKey / unknown. */
function lookupIdForCustomerMutation(
    operation: string,
    params: unknown,
): string {
    switch (operation) {
        case "createCustomer":
            return firstParamId(params, ["idempotencyKey", "customerId"]);
        case "attachPaymentMethod":
        case "detachPaymentMethod":
            return firstParamId(params, [
                "paymentMethodId",
                "token",
                "idempotencyKey",
            ]);
        case "submitDisputeEvidence":
            return firstParamId(params, ["disputeId", "idempotencyKey"]);
        case "createPaymentLink":
            return firstParamId(params, ["idempotencyKey", "paymentLinkId"]);
        case "deactivatePaymentLink":
            return firstParamId(params, ["paymentLinkId", "idempotencyKey"]);
        default:
            return providerObjectIdFromParams(params);
    }
}

/**
 * Convert a post-submit NetworkError on a money or Phase 22 mutation into the
 * matching indeterminate result. Returns undefined for queries, aborts, and
 * non-network errors.
 *
 * `createCheckoutSession` uses {@link applyIndeterminateCheckoutSessionOutcome}
 * (S19-CKO-TIMEOUT). Customer / payment-method / dispute / payment-link
 * mutations use typed helpers with a lookup identity from params.
 * `getCheckoutSession` stays a thrown NetworkError.
 */
function optionalParamString(params: unknown, key: string): string | undefined {
    if (params === null || typeof params !== "object") {
        return undefined;
    }
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    return undefined;
}

function tryIndeterminateFromNetworkError(
    operation: OperationType,
    params: unknown,
    error: Error,
    gateway: string,
):
    | GatewayPaymentResult
    | GatewayRefundResult
    | CheckoutSessionOperationResult
    | CustomerOperationResult
    | PaymentMethodOperationResult
    | DisputeOperationResult
    | PaymentLinkOperationResult
    | undefined {
    if (!(error instanceof NetworkError) || error.afterProviderSubmit !== true) {
        return undefined;
    }
    if (isPostSubmitCustomerMutation(operation)) {
        const providerObjectId = lookupIdForCustomerMutation(
            operation,
            params,
        );
        const message = error.message;
        const errorName = error.name;
        if (operation === "createCustomer") {
            return applyIndeterminateCustomerOutcome({
                customerId: providerObjectId,
                message,
                errorName,
                gateway,
            });
        }
        if (operation === "attachPaymentMethod") {
            const customerId = optionalParamString(params, "customerId");
            return applyIndeterminatePaymentMethodOutcome({
                paymentMethodId: providerObjectId,
                ...(customerId !== undefined ? { customerId } : {}),
                message,
                errorName,
                gateway,
            });
        }
        if (operation === "detachPaymentMethod") {
            return applyIndeterminatePaymentMethodOutcome({
                paymentMethodId: providerObjectId,
                message,
                errorName,
                gateway,
            });
        }
        if (operation === "submitDisputeEvidence") {
            return applyIndeterminateDisputeOutcome({
                disputeId: providerObjectId,
                message,
                errorName,
                gateway,
            });
        }
        return applyIndeterminatePaymentLinkOutcome({
            paymentLinkId: providerObjectId,
            message,
            errorName,
            gateway,
        });
    }
    if (!isPostSubmitMoneyMutation(operation)) {
        return undefined;
    }
    const providerObjectId = providerObjectIdFromParams(params);
    if (operation === "createCheckoutSession") {
        return applyIndeterminateCheckoutSessionOutcome({
            sessionId: providerObjectId,
            message: error.message,
            errorName: error.name,
            gateway,
        });
    }
    if (operation === "refundPayment") {
        return applyIndeterminateRefundOutcome({
            gatewayRefundId: providerObjectId,
            message: error.message,
            errorName: error.name,
        });
    }
    return applyIndeterminatePaymentOutcome({
        gateway,
        gatewayId: providerObjectId,
        message: error.message,
        errorName: error.name,
    });
}
