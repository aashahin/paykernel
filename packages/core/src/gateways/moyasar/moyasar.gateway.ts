// file: packages/payments/src/gateways/moyasar.gateway.ts


import { BaseGateway } from "../base.gateway";
import type { GatewayRuntimeDeps } from "../../runtime/payment-runtime";
import {
  combineAbortSignals,
  createTimeoutSignal,
  extractAbortSignal,
  isAbortError,
  isMutatingHttpMethod,
  mapHttpAbortError,
} from "../../runtime/abort";
import {
  timingSafeEqualBytes,
  utf8Encode,
  utf8ToBase64,
} from "../../runtime/crypto-portable";
import type {
  AmountInput,
  CaptureParams,
  CreatePaymentParams,
  GetPaymentParams,
  GatewayPaymentResult,
  GatewayRefundResult,
  MoyasarConfirmStcPayOtpParams,
  MoyasarCreatePaymentParams,
  PaymentNextAction,
  RefundParams,
  VoidParams,
} from "../../types/payment.types";
import type { GatewayPaymentStatus } from "../../types/domain-status";
import {
  applyOutcomeToGatewayResult,
  applyOutcomeToGatewayRefundResult,
  type PaymentOperationOutcome,
} from "../../types/operation-result";
import type {
  MoyasarWebhookPayload,
  WebhookEvent,
} from "../../types/webhook.types";
import {
  attachPaymentEvent,
  hashWebhookPayload,
  paymentFromWebhookEvent,
  PAYMENT_EVENT_SCHEMA_VERSION,
} from "../../types/payment-event";
import type { MoyasarConfig } from "../../types/config.types";
import type { HooksManager } from "../../hooks/hooks.manager";
import type { MoyasarPaymentSource } from "../../types/moyasar-source.types";
import {
  MoyasarCreatePaymentParamsSchema,
  MoyasarCaptureParamsSchema,
  MoyasarRefundParamsSchema,
  MoyasarVoidParamsSchema,
  MoyasarGetPaymentParamsSchema,
} from "../../types/validation";
import {
  GatewayApiError,
  AuthenticationError,
  CardDeclinedError,
  RateLimitError,
  InvalidRequestError,
  NetworkError,
  InvalidWebhookError,
  ResourceNotFoundError,
} from "../../errors";
import {
  withRetry,
  parseRetryAfterSeconds,
  extractRetryAfterSeconds,
} from "../../utils/retry";
import { MOYASAR_CAPABILITIES } from "../builtin-capabilities";
import {
  type IdempotencyStore,
  fingerprintParams,
} from "../../utils/idempotency";
import type { Logger } from "../../utils/logger";
import {
  fromMinorUnits as sharedFromMinorUnits,
  MoneyAmountError,
  minorAmountToNumber,
  normalizeAmountInput,
  toMinorUnits as sharedToMinorUnits,
  type Money,
} from "../../utils/money";

/**
 * Classify transient Moyasar transport/API failures (network, 5xx, 429).
 *
 * Used for:
 * - `createPayment` / `getPayment` `withRetry` predicates (safe GET always;
 *   create only when `given_id`/idempotencyKey is present).
 *
 * Capture/refund/void themselves are **not** auto-retried by `withRetry`.
 * Moyasar has no native mutation idempotency; a lost response after a successful
 * void/refund could double-apply if the SDK retried. Configure
 * `idempotencyStore` + pass `idempotencyKey` so **callers** can safely retry
 * after definite failures (or resolve `unknown` via `getPayment` first).
 *
 * Mutation fence clear/keep uses {@link isMoyasarDefiniteMutationFailure}
 * (fail-closed: keep reservation unless Moyasar definitively rejected).
 */
function isMoyasarRetryableError(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return true;
  }
  if (error instanceof GatewayApiError) {
    const status = (error.rawError as { status?: number } | undefined)?.status;
    return typeof status === "number" && (status >= 500 || status === 429);
  }
  return false;
}

/**
 * True only when Moyasar is known to have **rejected** the mutation (definite
 * client error). Used by `runIdempotentMutation` to clear the idempotency fence.
 *
 * Fail-closed (MOYASAR-1 / NEW-MOYASAR-4XX / NEW-MOYASAR-JSON-1): anything
 * else — network, 5xx, 408/409/425/429, **post-2xx** invalid JSON
 * (`NetworkError` with `afterProviderSubmit`, not `GatewayApiError` status
 * 2xx), mapping/`MoneyAmountError` after a successful HTTP body, unexpected
 * throws — is treated as indeterminate so the reservation is kept (`unknown`)
 * and a caller retry cannot double-apply. Moyasar has no native mutation
 * idempotency. 408/409/425 are the same class as 429 (timeout / conflict /
 * too early), not a definite reject.
 */
function isMoyasarDefiniteMutationFailure(error: unknown): boolean {
  if (error instanceof GatewayApiError) {
    const status = (error.rawError as { status?: number } | undefined)?.status;
    return (
      typeof status === "number" &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 409 &&
      status !== 425 &&
      status !== 429
    );
  }
  return false;
}

const NEVER_RETRY = () => false;

// ═══════════════════════════════════════════════════════════════════════════════
// Moyasar API Types (matching official OpenAPI spec)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Moyasar payment status values from official API
 * @see https://docs.moyasar.com/api/payments/08-payment-status-reference
 */
type MoyasarPaymentStatus =
  | "initiated"
  | "paid"
  | "authorized"
  | "failed"
  | "abandoned"
  | "refunded"
  | "captured"
  | "voided"
  | "verified";

/**
 * Moyasar card company/scheme
 */
type MoyasarCardCompany = "mada" | "visa" | "master" | "amex";

/**
 * Moyasar payment source type
 */
type MoyasarSourceType =
  | "creditcard"
  | "applepay"
  | "samsungpay"
  | "stcpay"
  | "token";

const DEFAULT_TIMEOUT_MS = 30_000;
const MOYASAR_MAX_METADATA_VALUE_LENGTH = 500;

/**
 * Full Moyasar payment response matching official OpenAPI spec
 */
interface MoyasarPaymentResponse {
  /** Payment ID (UUID) */
  id: string;
  /** Payment status */
  status: MoyasarPaymentStatus;
  /** Amount in smallest currency unit (halalas/fils) */
  amount: number;
  /** Fee charged by Moyasar (in smallest unit, includes VAT) */
  fee: number;
  /** ISO 4217 currency code */
  currency: string;
  /** Amount refunded so far (in smallest unit) */
  refunded: number;
  /** Amount captured so far (in smallest unit) */
  captured: number;
  /** Formatted amount with currency (e.g., "100 SAR") */
  amount_format: string;
  /** Formatted fee */
  fee_format: string;
  /** Formatted refunded amount */
  refunded_format: string;
  /** Formatted captured amount */
  captured_format: string;
  /** Customer IP address */
  ip: string | null;
  /** Payment creation timestamp */
  created_at: string;
  /** Last update timestamp */
  updated_at: string;
  /** Refund timestamp (null if not refunded) */
  refunded_at: string | null;
  /** Capture timestamp (null if not captured) */
  captured_at: string | null;
  /** Void timestamp (null if not voided) */
  voided_at: string | null;
  /** Payment description */
  description: string | null;
  /** Associated invoice ID */
  invoice_id: string | null;
  /** Callback URL for redirects */
  callback_url: string | null;
  /** User-provided metadata */
  metadata: Record<string, unknown>;
  /** Payment source details */
  source: {
    /** Source type */
    type: MoyasarSourceType;
    /** Card scheme (for card payments) */
    company?: MoyasarCardCompany;
    /** Cardholder name */
    name?: string | null;
    /** Masked card number */
    number?: string;
    /** Gateway reference ID */
    gateway_id?: string;
    /** Token for future payments */
    token?: string | null;
    /** Response message from processor */
    message?: string | null;
    /** 3DS challenge URL (for initiated payments) */
    transaction_url?: string | null;
    /** Retrieval Reference Number (RRN) */
    reference_number?: string | null;
    /** Authorization response code */
    response_code?: string | null;
    /** Authorization code from issuer */
    authorization_code?: string | null;
  };
}

/**
 * Moyasar API error response
 */
interface MoyasarErrorResponse {
  /** Error type category */
  type:
  | "invalid_request"
  | "invalid_request_error"
  | "authentication_error"
  | "authorization_error"
  | "rate_limit_error"
  | "api_connection_error"
  | "account_inactive_error"
  | "api_error"
  | "record_not_found"
  | "3ds_auth_error";
  /** Error message */
  message: string;
  /** Detailed validation errors (field -> messages) */
  errors?: Record<string, string[]>;
}

/**
 * Moyasar payment gateway implementation
 * @see https://docs.moyasar.com/api/api-introduction
 */
export class MoyasarGateway extends BaseGateway {
  readonly name = "moyasar" as const;

  private readonly baseUrl = "https://api.moyasar.com/v1";
  private readonly moyasarConfig: MoyasarConfig;

  constructor(
    config: MoyasarConfig,
    hooks: HooksManager,
    logger?: Logger,
    runtime?: GatewayRuntimeDeps,
  ) {
    super(config, hooks, logger, MOYASAR_CAPABILITIES, runtime);
    this.moyasarConfig = config;
    this.assertIdempotencyStoreValid();
    this.warnIfIdempotencyStoreUnsafe();
  }

  private assertIdempotencyStoreValid(): void {
    const store = this.moyasarConfig.idempotencyStore as unknown as { reserve?: unknown } | undefined;
    if (store !== undefined && typeof store.reserve !== "function") {
      throw new InvalidRequestError(
        "idempotencyStore.reserve required; use InMemoryIdempotencyStore or a store with atomic reserve() (e.g. Redis SET NX or SQL unique constraint)",
        [{ path: ["idempotencyStore"] }],
      );
    }
  }

  /**
   * Construction-time heads-up: capture/refund/void/confirmStcPayOtp **require**
   * a store that implements atomic `reserve()` and an `idempotencyKey` (see
   * {@link runIdempotentMutation}). Warn so a missing store is visible before
   * the first mutation throws `InvalidRequestError`.
   */
  private warnIfIdempotencyStoreUnsafe(): void {
    const store = this.moyasarConfig.idempotencyStore;
    if (!store) {
      this.logger.warn(
        "[Moyasar] idempotencyStore is required for capture, refund, void, and " +
          "confirmStcPayOtp. Those mutations throw InvalidRequestError until " +
          "moyasar.idempotencyStore (with atomic reserve()) and idempotencyKey " +
          "are provided — Moyasar has no native mutation idempotency " +
          "(double-refund / double-OTP class).",
      );
      return;
    }
    // Reserve shape now validated fail-fast in assertIdempotencyStoreValid(); no second warn needed.
  }

  /**
   * Guard a non-idempotent mutation (refund/capture/void/STC OTP confirm) with
   * an injectable dedupe store, keyed by idempotencyKey + operation + paymentId.
   * Moyasar has no native idempotency for these endpoints, so this prevents a
   * **caller** retry from applying the mutation twice (e.g. a double refund).
   *
   * This does **not** wrap the HTTP call in `withRetry`. Auto-retry after a
   * network blip is unsafe: the first request may already have succeeded on
   * Moyasar. The store only enables safe **caller** retries (and caches
   * completed results).
   *
   * Behavior:
   * - Missing store, missing key, or store without atomic `reserve()`: throws
   *   `InvalidRequestError` (fail-closed; never runs unguarded).
   * - Already completed for this key: returns the cached result (no API call).
   * - In progress / outcome unknown for this key: refuses, instead of risking
   *   a duplicate mutation.
   * - Definite failure only (`GatewayApiError` with 4xx except 408/409/425/429
   *   — Moyasar rejected the mutation): clears the reservation so the caller
   *   can safely retry.
   * - Indeterminate failures keep an `unknown` marker (never silently re-apply):
   *   network, 5xx, 408/409/425/429, **post-2xx parse/map failures** (invalid
   *   JSON or mapping errors after HTTP may already have applied the mutation),
   *   and any other non-definite throw. Resolve via `getPayment` before
   *   retrying with the same key (MOYASAR-1 / NEW-MOYASAR-4XX).
   */
  private async runIdempotentMutation<R>(
    operation:
      | "capturePayment"
      | "refundPayment"
      | "voidPayment"
      | "confirmStcPayOtp",
    paymentId: string,
    idempotencyKey: string | undefined,
    fingerprintInput: unknown,
    executor: () => Promise<R>,
  ): Promise<R> {
    const store: IdempotencyStore | undefined = this.moyasarConfig.idempotencyStore;
    // Capture/refund/void have no native Moyasar idempotency.
    // Require store + key so retries cannot double-apply (double refund class).
    if (!store) {
      throw new InvalidRequestError(
        `Moyasar ${operation} requires moyasar.idempotencyStore and idempotencyKey. ` +
          "Capture, refund, void, and confirmStcPayOtp have no native Moyasar " +
          "idempotency; unguarded retries or multi-worker races can double-apply " +
          "the mutation. Configure idempotencyStore (with atomic reserve()) and " +
          "pass idempotencyKey.",
        [{ path: ["idempotencyKey"] }],
      );
    }
    if (!idempotencyKey) {
      throw new InvalidRequestError(
        `Moyasar ${operation} requires idempotencyKey when idempotencyStore is configured. ` +
          "Pass a stable idempotencyKey so caller retries are deduped.",
        [{ path: ["idempotencyKey"] }],
      );
    }

    // reserve shape validated fail-fast at construction (assertIdempotencyStoreValid); no dead TOCTOU check here.
    const key = `moyasar:${operation}:${paymentId}:${idempotencyKey}`;
    const fingerprint = fingerprintParams(fingerprintInput);
    const createdAt = this.clock.nowMs();

    const existing = await store.reserve(key, {
      status: "in_progress",
      fingerprint,
      createdAt,
    });

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new InvalidRequestError(
          `Moyasar ${operation} idempotencyKey was reused with different parameters`,
          [{ path: ["idempotencyKey"] }],
        );
      }
      if (existing.status === "completed") {
        return existing.result as R;
      }
      throw new InvalidRequestError(
        `Moyasar ${operation} with this idempotencyKey is already in progress or its outcome is unknown; resolve it before retrying`,
        [{ path: ["idempotencyKey"] }],
      );
    }

    try {
      const result = await executor();
      // The mutation already succeeded; a failure to persist the record must
      // not turn a successful refund into an error (which could trigger a
      // double-refund on retry). Best-effort persist, then return.
      await this.safeStoreWrite(operation, () =>
        store.set(key, {
          status: "completed",
          fingerprint,
          createdAt: this.clock.nowMs(),
          result,
        }),
      );
      return result;
    } catch (error) {
      // MOYASAR-1 / NEW-MOYASAR-4XX: only clear when Moyasar definitively
      // rejected the mutation (4xx except 408/409/425/429). Post-2xx parse/map
      // failures, network, 5xx, 408/409/425/429, and unexpected throws are
      // indeterminate — keep the fence so a retry cannot double-apply a
      // mutation that may already have succeeded server-side.
      if (isMoyasarDefiniteMutationFailure(error)) {
        await this.safeStoreWrite(operation, () => store.delete(key));
      } else {
        await this.safeStoreWrite(operation, () =>
          store.set(key, {
            status: "unknown",
            fingerprint,
            createdAt: this.clock.nowMs(),
          }),
        );
      }
      throw error;
    }
  }

  /** Run a best-effort idempotency-store write, never throwing on failure. */
  private async safeStoreWrite(
    operation: string,
    write: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(
        `[Moyasar] Failed to persist ${operation} idempotency record; protection for this key may be reduced.`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Payment Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a payment using Moyasar's Payment API.
   * Backend-safe sources: token (Moyasar.js), applepay, samsungpay, stcpay.
   * Raw `creditcard` (PAN/CVC) sources are rejected before any HTTP request —
   * send cardholder data only via Moyasar.js tokenization.
   * @see https://docs.moyasar.com/api/payments/01-create-payment
   * @note `success: true` only means the payment is not mapped to `failed`
   *   (provider `failed`/`abandoned`, or an unmapped status). An `initiated`
   *   payment maps to `success: true` with `status: 'pending'`. Always check
   *   `status` (and complete 3DS/OTP) before fulfillment — fulfill only on
   *   `status === 'paid'` / `isPaidOutcome`. `authorized` is not fulfillment.
   */
  async createPayment(params: CreatePaymentParams): Promise<GatewayPaymentResult>;
  async createPayment(params: MoyasarCreatePaymentParams): Promise<GatewayPaymentResult>;
  async createPayment(
    params: CreatePaymentParams | MoyasarCreatePaymentParams,
  ): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("createPayment", params, async (p) => {
      // Build source payload from moyasarSource or legacy tokenId
      const sourcePayload = this.buildSourcePayload(p);
      const requiresCallback = sourcePayload.type === "token";

      if (requiresCallback && !p.callbackUrl) {
        throw new InvalidRequestError(
          "callbackUrl is required for Moyasar token payments",
        );
      }

      const metadata = this.buildPaymentMetadata(p);
      const currency = p.currency.toUpperCase();
      const requestBody: Record<string, unknown> = {
        amount: this.toMinorUnits(p.amount, currency),
        currency,
        description: p.description ?? "Payment",
        source: sourcePayload,
      };

      if (metadata !== undefined) {
        requestBody.metadata = metadata;
      }

      if (p.callbackUrl) {
        requestBody.callback_url = p.callbackUrl;
      }

      // Add idempotency key (becomes the payment ID)
      if (p.idempotencyKey) {
        requestBody.given_id = p.idempotencyKey;
      }

      // Add coupon flag if specified
      if ((p as unknown as MoyasarCreatePaymentParams).applyCoupon !== undefined) {
        requestBody.apply_coupon = (p as unknown as MoyasarCreatePaymentParams).applyCoupon;
      }

      // Split amounts are major units in the public API; Moyasar expects minor ints.
      if ("splits" in p && p.splits !== undefined) {
        requestBody.splits = p.splits.map((split) => ({
          ...split,
          amount: this.toMinorUnits(split.amount, currency, {
            allowNonPositive: true,
          }),
        }));
      }

      if ("recipient" in p && p.recipient !== undefined) {
        requestBody.recipient = p.recipient;
      }

      if ("sender" in p && p.sender !== undefined) {
        requestBody.sender = p.sender;
      }

      // Only retry create on transient errors when given_id (idempotencyKey)
      // is present, so Moyasar deduplicates a re-sent request.
      const createInit: RequestInit = {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(requestBody),
      };
      const createSignal = extractAbortSignal(p);
      if (createSignal) {
        createInit.signal = createSignal;
      }

      const data = (await withRetry(
        () =>
          this.requestJson(
            "/payments",
            createInit,
            "Failed to create payment",
          ),
        { isRetryable: p.idempotencyKey ? isMoyasarRetryableError : NEVER_RETRY },
      )) as
        | MoyasarPaymentResponse
        | MoyasarErrorResponse;

      const payment = data as MoyasarPaymentResponse;
      // NEW-MOYASAR-1: HTTP 200 `{}` / missing id is post-submit unknown.
      // create is not fenced — throw NetworkError.afterProviderSubmit so
      // executeWithHooks returns indeterminate (not declined/failed) and
      // callers reconcile via given_id / getPayment.
      return this.mapPaymentResponse(payment);
    }, MoyasarCreatePaymentParamsSchema);
  }

  /**
   * Build the source payload for Moyasar API from typed `moyasarSource`.
   * `tokenId` was removed in 1.0 — pass `moyasarSource: { type: "token", token }`.
   */
  private buildSourcePayload(
    params: MoyasarCreatePaymentParams | CreatePaymentParams,
  ): Record<string, unknown> {
    const src = (params as unknown as MoyasarCreatePaymentParams).moyasarSource;
    if (!src) {
      throw new InvalidRequestError(
        "moyasarSource is required for Moyasar payments — use moyasarSource: { type: \"token\", token }",
      );
    }
    return this.mapMoyasarSource(src, params.capture);
  }

  private buildPaymentMetadata(
    params: MoyasarCreatePaymentParams | CreatePaymentParams,
  ): Record<string, string> | undefined {
    const metadata = {
      ...(params.metadata as Record<string, string> | undefined),
    };

    if (params.orderId) {
      if (params.orderId.length > MOYASAR_MAX_METADATA_VALUE_LENGTH) {
        throw new InvalidRequestError(
          `Moyasar orderId must be ${MOYASAR_MAX_METADATA_VALUE_LENGTH} characters or fewer because it is stored in metadata`,
        );
      }
      metadata.orderId ??= params.orderId;
      metadata.paymentId ??= params.orderId;
    }

    return this.validatePaymentMetadata(metadata);
  }

  private validatePaymentMetadata(
    metadata: Record<string, string>,
  ): Record<string, string> | undefined {
    const entries = Object.entries(metadata);

    if (entries.length === 0) {
      return undefined;
    }

    if (entries.length > 30) {
      throw new InvalidRequestError(
        "Moyasar metadata can include at most 30 keys",
      );
    }

    for (const [key, value] of entries) {
      if (key.length > 40) {
        throw new InvalidRequestError(
          `Moyasar metadata key "${key}" must be 40 characters or fewer`,
        );
      }

      if (typeof value !== "string") {
        throw new InvalidRequestError(
          `Moyasar metadata value for "${key}" must be a string`,
        );
      }

      if (value.length > MOYASAR_MAX_METADATA_VALUE_LENGTH) {
        throw new InvalidRequestError(
          `Moyasar metadata value for "${key}" must be ${MOYASAR_MAX_METADATA_VALUE_LENGTH} characters or fewer`,
        );
      }
    }

    return metadata;
  }

  /**
   * Map our typed MoyasarPaymentSource to Moyasar API payload.
   * Raw `creditcard` is rejected — this backend never forwards PAN/CVC.
   */
  private mapMoyasarSource(
    source: MoyasarPaymentSource,
    capture?: boolean,
  ): Record<string, unknown> {
    const manual =
      "manualCapture" in source && source.manualCapture !== undefined
        ? source.manualCapture
        : capture === false
          ? true
          : undefined;

    switch (source.type) {
      case "creditcard":
        throw new InvalidRequestError(
          "Moyasar raw creditcard source is not supported by this backend SDK. Use Moyasar.js tokenization, Apple Pay, Samsung Pay, or STC Pay so cardholder data is sent directly to Moyasar.",
        );

      case "token":
        return {
          type: "token",
          token: source.token,
          ...(source.cvc && { cvc: source.cvc }),
          ...(source.statementDescriptor && {
            statement_descriptor: source.statementDescriptor,
          }),
          ...(source._3ds !== undefined && { "3ds": source._3ds }),
          ...(manual !== undefined && { manual }),
        };

      case "applepay":
        // Check if this is an encrypted token or decrypted DPAN
        if ("token" in source && source.token) {
          return {
            type: "applepay",
            token: source.token,
            ...(manual !== undefined && { manual }),
            ...(source.saveCard !== undefined && {
              save_card: source.saveCard,
            }),
            ...(source.statementDescriptor && {
              statement_descriptor: source.statementDescriptor,
            }),
          };
        }
        // Decrypted Apple Pay token (DPAN). Moyasar's ApplePayDecryptTokenRequest
        // has no `manual` field — fail closed rather than silently auto-capturing
        // when the caller asked for authorize-only.
        if ("dpan" in source) {
          if (manual === true) {
            throw new InvalidRequestError(
              "Moyasar decrypted Apple Pay (DPAN) does not support manual capture (capture: false). Use an encrypted Apple Pay token source for authorize-only payments, or omit capture: false for auto-capture.",
            );
          }
          return {
            type: "applepay",
            number: source.dpan,
            month: source.month,
            year: source.year,
            cryptogram: source.cryptogram,
            device_id: source.deviceId,
            ...(source.lastFour && { last_four: source.lastFour }),
            ...(source.eci && { eci: source.eci }),
          };
        }
        throw new InvalidRequestError(
          "Invalid Apple Pay source: must have either token or dpan",
        );

      case "samsungpay":
        return {
          type: "samsungpay",
          token: source.token,
          ...(manual !== undefined && { manual }),
          ...(source.saveCard !== undefined && { save_card: source.saveCard }),
          ...(source.statementDescriptor && {
            statement_descriptor: source.statementDescriptor,
          }),
        };

      case "stcpay":
        // STC Pay has no `manual` capture field — fail closed rather than
        // silently auto-capturing when the caller asked for authorize-only.
        if (manual === true) {
          throw new InvalidRequestError(
            "Moyasar STC Pay does not support manual capture (capture: false). Omit capture: false; STC Pay captures after successful OTP confirmation.",
          );
        }
        return {
          type: "stcpay",
          mobile: source.mobile,
          ...(source.cashier && { cashier: source.cashier }),
          ...(source.branch && { branch: source.branch }),
        };

      default:
        // Exhaustive check - TypeScript will error if we miss a case
        const _exhaustiveCheck: never = source;
        throw new GatewayApiError(
          `Unknown payment source type: ${(source as Record<string, unknown>).type}`,
          "moyasar",
          { code: "UNKNOWN_SOURCE_TYPE" },
        );
    }
  }

  /**
   * Capture an authorized payment.
   * @see https://docs.moyasar.com/api/payments/06-capture-payment
   * @note Moyasar auto-captures by default; use this only for manual-capture flows.
   * @note Not auto-retried by `withRetry`. Pass `idempotencyKey` with
   *   `moyasar.idempotencyStore` so **caller** retries are deduped (Moyasar has
   *   no native capture idempotency).
   */
  async capturePayment(params: CaptureParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("capturePayment", params, async (p) => {
      const requestBody: Record<string, unknown> = {};
      const captureSignal = extractAbortSignal(p);

      // Only include amount for partial captures. Bind minors to payment currency
      // (MOYASAR-3) — never convert with caller-only currency (JPY/USD scale drift).
      // Resolve before the idempotency fence so validation failures never stick the key.
      if (p.amount !== undefined) {
        if (!p.currency) {
          throw new InvalidRequestError(
            "currency is required for Moyasar partial captures so the amount can be converted to minor units correctly",
          );
        }
        const paymentCurrency = await this.resolvePaymentCurrencyForPartial(
          p.gatewayPaymentId,
          "capture",
          captureSignal,
        );
        const callerCurrency = p.currency.trim().toUpperCase();
        if (callerCurrency !== paymentCurrency) {
          throw new InvalidRequestError(
            `Moyasar capture currency ${callerCurrency} does not match payment currency ${paymentCurrency}`,
            [{ path: ["currency"] }],
          );
        }
        requestBody.amount = this.toMinorUnits(p.amount, paymentCurrency);
      }

      const hasBody = Object.keys(requestBody).length > 0;
      const init: RequestInit = {
        method: "POST",
        headers: this.getHeaders({ contentType: hasBody }),
      };
      if (hasBody) {
        init.body = JSON.stringify(requestBody);
      }
      if (captureSignal) {
        init.signal = captureSignal;
      }

      return this.runIdempotentMutation(
        "capturePayment",
        p.gatewayPaymentId,
        p.idempotencyKey,
        { amount: p.amount, currency: p.currency },
        async () => {
          const data = (await this.requestJson(
            this.paymentPath(p.gatewayPaymentId, "capture"),
            init,
            "Failed to capture payment",
          )) as MoyasarPaymentResponse | MoyasarErrorResponse;

          return this.mapPaymentResponse(data as MoyasarPaymentResponse);
        },
      );
    }, MoyasarCaptureParamsSchema);
  }

  /**
   * Refund a payment (full or partial).
   * @see https://docs.moyasar.com/api/payments/05-refund-payment
   * @note Moyasar returns the updated payment object, not a separate refund entity.
   * @note Not auto-retried by `withRetry`. Pass `idempotencyKey` with
   *   `moyasar.idempotencyStore` so **caller** retries are deduped (Moyasar has
   *   no native refund idempotency).
   */
  async refundPayment(params: RefundParams): Promise<GatewayRefundResult> {
    return this.executeWithHooks("refundPayment", params, async (p) => {
      const requestBody: Record<string, unknown> = {};
      const refundSignal = extractAbortSignal(p);

      // Only include amount for partial refunds. Bind minors to payment currency
      // (MOYASAR-3) — never convert with caller-only currency.
      // Resolve before the idempotency fence so validation failures never stick the key.
      if (p.amount !== undefined) {
        if (!p.currency) {
          throw new InvalidRequestError(
            "currency is required for Moyasar partial refunds so the amount can be converted to minor units correctly",
          );
        }
        const paymentCurrency = await this.resolvePaymentCurrencyForPartial(
          p.gatewayPaymentId,
          "refund",
          refundSignal,
        );
        const callerCurrency = p.currency.trim().toUpperCase();
        if (callerCurrency !== paymentCurrency) {
          throw new InvalidRequestError(
            `Moyasar refund currency ${callerCurrency} does not match payment currency ${paymentCurrency}`,
            [{ path: ["currency"] }],
          );
        }
        requestBody.amount = this.toMinorUnits(p.amount, paymentCurrency);
      }

      const hasBody = Object.keys(requestBody).length > 0;
      const init: RequestInit = {
        method: "POST",
        headers: this.getHeaders({ contentType: hasBody }),
      };
      if (hasBody) {
        init.body = JSON.stringify(requestBody);
      }
      if (refundSignal) {
        init.signal = refundSignal;
      }

      return this.runIdempotentMutation(
        "refundPayment",
        p.gatewayPaymentId,
        p.idempotencyKey,
        { amount: p.amount, currency: p.currency },
        async () => {
          const data = (await this.requestJson(
            this.paymentPath(p.gatewayPaymentId, "refund"),
            init,
            "Failed to refund payment",
          )) as MoyasarPaymentResponse | MoyasarErrorResponse;

          const payment = data as MoyasarPaymentResponse;
          // NEW-MOYASAR-REFUND-ID: HTTP 200 `{}` / missing id is post-submit
          // unknown. Throw NetworkError.afterProviderSubmit so the fence stays
          // `unknown` — never persist completed pending with undefined
          // gatewayRefundId (a new key would double-refund).
          this.assertObservedPaymentId(payment);
          const paymentStatus = this.resolvePaymentStatus(payment);
          const refundedMinor =
            typeof payment.refunded === "number" &&
            Number.isFinite(payment.refunded)
              ? payment.refunded
              : undefined;
          const currency =
            typeof payment.currency === "string" &&
            payment.currency.trim().length > 0
              ? payment.currency.trim().toUpperCase()
              : undefined;

          // Proven refund money only (full or partial). `refund_completed` is the
          // fail-closed incomplete-money marker — never claim completed/succeeded
          // with totalRefunded=0 (MOYASAR-2).
          const provenRefund =
            (refundedMinor !== undefined && refundedMinor > 0) ||
            paymentStatus === "refunded" ||
            paymentStatus === "partially_refunded";

          if (provenRefund && refundedMinor !== undefined && currency !== undefined) {
            return applyOutcomeToGatewayRefundResult(
              {
                // Payment ID (Moyasar has no separate refund entity)
                gatewayRefundId: payment.id,
                status: "completed",
                totalRefunded: this.fromMinorUnits(refundedMinor, currency),
                refundedAt: payment.refunded_at
                  ? new Date(payment.refunded_at)
                  : undefined,
                rawResponse: payment,
              },
              "succeeded",
            );
          }

          // Incomplete snapshot or refund not yet reflected: pending, omit invented 0.
          return applyOutcomeToGatewayRefundResult(
            {
              gatewayRefundId: payment.id,
              status: "pending",
              ...(refundedMinor !== undefined &&
              currency !== undefined &&
              refundedMinor > 0
                ? {
                    totalRefunded: this.fromMinorUnits(refundedMinor, currency),
                  }
                : {}),
              refundedAt: payment.refunded_at
                ? new Date(payment.refunded_at)
                : undefined,
              rawResponse: payment,
            },
            "pending",
          );
        },
      );
    }, MoyasarRefundParamsSchema);
  }

  /**
   * Void a payment while Moyasar still allows reversal.
   * @see https://docs.moyasar.com/api/payments/07-void-payment
   * @note Allowed for **authorized** (uncaptured) holds, and for **paid** /
   *   auto-captured payments only within Moyasar's short settlement window
   *   (commonly ~2 hours per Payment Operations). After that window, use
   *   {@link refundPayment} instead.
   * @note Not auto-retried by `withRetry`. Pass `idempotencyKey` with
   *   `moyasar.idempotencyStore` so **caller** retries are deduped (Moyasar has
   *   no native void idempotency).
   */
  async voidPayment(params: VoidParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("voidPayment", params, async (p) => {
      return this.runIdempotentMutation(
        "voidPayment",
        p.gatewayPaymentId,
        p.idempotencyKey,
        {},
        async () => {
          const voidInit: RequestInit = {
            method: "POST",
            // Empty body — omit Content-Type so intermediaries don't expect JSON.
            headers: this.getHeaders({ contentType: false }),
          };
          const voidSignal = extractAbortSignal(p);
          if (voidSignal) {
            voidInit.signal = voidSignal;
          }
          const data = (await this.requestJson(
            this.paymentPath(p.gatewayPaymentId, "void"),
            voidInit,
            "Failed to void payment",
          )) as MoyasarPaymentResponse | MoyasarErrorResponse;

          const payment = data as MoyasarPaymentResponse;
          // MOYASAR-2/5: force operation-succeeded only when provider confirms
          // voided (→ cancelled). Residual 2xx still paid keeps natural
          // paid/succeeded (money-honest: isPaidOutcome true) — callers must
          // key void-complete on status === cancelled, not outcome alone.
          return this.mapPaymentResponse(payment, {
            ...(payment.status === "voided"
              ? { forceOutcome: "succeeded" as const }
              : {}),
          });
        },
      );
    }, MoyasarVoidParamsSchema);
  }

  /**
   * Confirm an initiated STC Pay payment using the OTP sent to the customer.
   * Mutation POST — fenced like capture/refund/void (NEW-MOYASAR-3).
   * @see https://docs.moyasar.com/guides/stc-pay/custom-ui/
   */
  async confirmStcPayOtp(
    params: MoyasarConfirmStcPayOtpParams & { idempotencyKey?: string },
  ): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("confirmStcPayOtp", params, async (p) => {
      return this.confirmStcPayOtpRequest(p);
    });
  }

  private async confirmStcPayOtpRequest(
    params: MoyasarConfirmStcPayOtpParams & { idempotencyKey?: string },
  ): Promise<GatewayPaymentResult> {
    if (!params.transactionUrl) {
      throw new InvalidRequestError(
        "transactionUrl is required for Moyasar STC Pay OTP confirmation",
      );
    }
    if (
      params.otpValue === "" ||
      params.otpValue === undefined ||
      params.otpValue === null
    ) {
      throw new InvalidRequestError(
        "otpValue is required for Moyasar STC Pay OTP confirmation",
      );
    }

    const transactionUrl = this.assertMoyasarStcTransactionUrl(
      params.transactionUrl,
    );
    // Validate URL/OTP before the fence so a bad URL never sticks the key.
    const fenceKey =
      typeof params.idempotencyKey === "string" &&
      params.idempotencyKey.trim().length > 0
        ? params.idempotencyKey.trim()
        : undefined;

    return this.runIdempotentMutation(
      "confirmStcPayOtp",
      transactionUrl,
      fenceKey,
      { transactionUrl, otpValue: params.otpValue },
      async () => {
        const otpInit: RequestInit = {
          method: "POST",
          headers: this.getHeaders({ auth: false }),
          body: JSON.stringify({ otp_value: params.otpValue }),
        };
        const otpSignal = extractAbortSignal(params);
        if (otpSignal) {
          otpInit.signal = otpSignal;
        }
        const data = (await this.requestJson(
          transactionUrl,
          otpInit,
          "Failed to confirm STC Pay OTP",
        )) as MoyasarPaymentResponse | MoyasarErrorResponse;

        return this.mapPaymentResponse(data as MoyasarPaymentResponse);
      },
    );
  }

  /**
   * Map Moyasar errors to standardized SDK errors
   */
  protected mapError(error: unknown): Error {
    if (error instanceof GatewayApiError && error.gatewayName === "moyasar") {
      const raw = error.rawError as { type?: string; message?: string; status?: number };
      const type = raw?.type;
      const message = raw?.message ?? error.message;
      const status = raw?.status;

      switch (type) {
        case "invalid_request":
        case "invalid_request_error":
          return new InvalidRequestError(message);
        case "authentication_error":
        case "authorization_error":
          return new AuthenticationError(message);
        case "rate_limit_error":
          return new RateLimitError("moyasar", extractRetryAfterSeconds(error));
        case "api_connection_error":
          return new NetworkError(message);
        case "record_not_found":
          return new ResourceNotFoundError(message, raw);
        // 3DS challenge failure is a card/auth step failure at the issuer, not
        // an SDK/API credentials failure — do not map to AuthenticationError.
        case "3ds_auth_error":
          return new CardDeclinedError(message, raw);
      }

      if (status === 400) {
        return new InvalidRequestError(message);
      }
      if (status === 401 || status === 403) {
        return new AuthenticationError(message);
      }
      if (status === 429) {
        return new RateLimitError("moyasar", extractRetryAfterSeconds(error));
      }
      if (status === 404) {
        return new ResourceNotFoundError(message, raw);
      }
    }
    return super.mapError(error);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // Webhook Handling
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify Moyasar webhook using secret_token in payload
   * @see https://docs.moyasar.com/guides/dashboard/webhooks
   */
  verifyWebhook(payload: unknown, _signature?: string): boolean {
    if (!this.moyasarConfig.webhookSecret) {
      this.logger.warn(
        "[Moyasar] No webhook secret configured, rejecting webhook",
      );
      return false;
    }

    let normalized: unknown = payload;
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed.length === 0) return false;
      try {
        normalized = JSON.parse(trimmed) as unknown;
      } catch {
        return false;
      }
    } else if (payload instanceof Uint8Array) {
      const text = new TextDecoder().decode(payload).trim();
      if (text.length === 0) return false;
      try {
        normalized = JSON.parse(text) as unknown;
      } catch {
        return false;
      }
    }

    if (!this.isRecord(normalized)) return false;
    const record = normalized;
    if (typeof record.secret_token !== "string") return false;

    return this.constantTimeEquals(
      record.secret_token,
      this.moyasarConfig.webhookSecret,
    );
  }

  /**
   * Parse Moyasar webhook payload into normalized WebhookEvent.
   *
   * Dual-writes Phase 7 {@link import('../../types/payment-event').PaymentEvent}
   * on `event` / `stableType` / `provider` while keeping provider-native `type`.
   * Hash a compact identity (id/type/created_at/data.id) — not the full tree
   * (NEW-PERF-1). `rawPayload` omits `secret_token` after verification.
   */
  parseWebhookEvent(payload: unknown): WebhookEvent {
    const raw = this.assertMoyasarWebhookPayload(payload);

    // NEW-MOYASAR-2: card_auth_* is a card-authentication object, not a payment.
    // Do not throw InvalidWebhookError — handleWebhook remaps that to retryable
    // InvalidRequestError and authentic card-auth would redeliver forever.
    // Parse as provider.unmapped (setup-like status; never payment.pending).
    if (raw.type.startsWith("card_auth_")) {
      return this.parseCardAuthWebhookEvent(raw);
    }

    const paymentId = this.extractPaymentId(raw.data.metadata);
    const data = raw.data as MoyasarWebhookPayload["data"] & {
      refunded?: number;
      captured?: number;
    };

    // PERF-1: inbox identity is envelope id/type/created_at + payment id.
    // Do not hash the full payment/source tree (or secret_token).
    const payloadHash = hashWebhookPayload(this.compactWebhookIdentity(raw));
    const { secret_token: _secretToken, ...rawWithoutSecret } = raw;

    const eventType = this.normalizeWebhookEventType(raw.type);
    let status = this.resolvePaymentStatus({
      status: data.status,
      amount: data.amount,
      refunded: data.refunded,
      captured: data.captured,
    });
    // payment_refunded envelope without amount-derived refund domain status is an
    // incomplete refund snapshot (e.g. status still paid, refunded missing/zero).
    // Fail closed — never leave domain status as paid-like for a refund event
    // (MOYASAR-2). Aligns with provider-status refunded + missing amount path.
    status = this.failClosedIncompleteRefundWebhookStatus(status, eventType);
    // Phase-7 money fields: use refunded/captured when the event is about those
    // money movements — never report full payment total for a partial slice
    // (MOYASAR-1). Incomplete refund snapshots may omit amount entirely.
    const amount = this.resolveWebhookEventAmount(data, status, eventType);

    const legacy: WebhookEvent = {
      id: raw.id,
      type: eventType,
      gateway: "moyasar",
      paymentId,
      gatewayPaymentId: data.id,
      status,
      ...(amount !== undefined ? { amount } : {}),
      // Normalize to uppercase ISO 4217 for cross-gateway consistency.
      currency: data.currency.toUpperCase(),
      timestamp: new Date(raw.created_at),
      // Moyasar exposes test/live on the envelope as `live`.
      ...(typeof raw.live === "boolean" ? { livemode: raw.live } : {}),
      rawPayload: rawWithoutSecret,
    };

    const attached = attachPaymentEvent(legacy);
    // MOYASAR-3: payment_paid / payment_captured map to settled dual-write from
    // envelope type alone — demote when domain status is not paid-like (paid).
    // Covers amount-derived partially_captured and any other non-paid domain.
    // Incomplete refund_completed must not dual-write refund.completed —
    // type-only handlers would over-settle without proven refunded amount.
    // payment_voided + residual paid/authorized must not dual-write
    // payment.cancelled (type-only restock while funds remain).
    return {
      ...this.demoteResidualVoidWebhookDualWrite(
        this.demoteIncompleteRefundWebhookDualWrite(
          this.demoteNonPaidSettledWebhookDualWrite(attached),
        ),
      ),
      payloadHash,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Query Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get payment status from Moyasar
   * @see https://docs.moyasar.com/api/payments/02-fetch-payment
   */
  async getPaymentStatus(gatewayId: string): Promise<GatewayPaymentStatus> {
    const result = await this.getPayment({ gatewayPaymentId: gatewayId });
    return result.status;
  }

  /**
   * Get full payment details from Moyasar
   * @see https://docs.moyasar.com/api/payments/02-fetch-payment
   */
  async getPayment(params: GetPaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("getPayment", params, async (p) => {
      const { gatewayPaymentId } = p;

      // GET is safe to retry unconditionally.
      const getInit: RequestInit = {
        method: "GET",
        headers: this.getHeaders(),
      };
      const getSignal = extractAbortSignal(p);
      if (getSignal) {
        getInit.signal = getSignal;
      }
      const data = (await withRetry(
        () =>
          this.requestJson(
            this.paymentPath(gatewayPaymentId),
            getInit,
            "Failed to get payment",
          ),
        { isRetryable: isMoyasarRetryableError },
      )) as
        | MoyasarPaymentResponse
        | MoyasarErrorResponse;

      const payment = data as MoyasarPaymentResponse;
      return this.mapPaymentResponse(payment);
    }, MoyasarGetPaymentParamsSchema);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get authorization headers for Moyasar API
   * Moyasar uses HTTP Basic Auth with secret key as username
   * @param options.contentType - When false, omits Content-Type (for empty-body POSTs).
   */
  private getHeaders(
    options: { auth?: boolean; contentType?: boolean } = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (options.contentType !== false) {
      headers["Content-Type"] = "application/json";
    }

    if (options.auth !== false) {
      // Portable Base64 (no node:buffer / btoa-only path).
      const credentials = utf8ToBase64(`${this.moyasarConfig.secretKey}:`);
      headers.Authorization = `Basic ${credentials}`;
    }

    return headers;
  }

  /**
   * Map Moyasar payment response to unified GatewayPaymentResult.
   * Card and STC Pay challenge URLs are returned in transaction_url.
   *
   * Prefer `outcome` (Phase 6). `success` is dual-written for 0.x:
   * false when status maps to SDK `failed` (or outcome declined/failed);
   * true for paid/authorized/pending/requires_action paths. Callers must
   * fulfill only on `status === 'paid'` / `isPaidOutcome` — never on
   * `authorized` or `success` alone.
   */
  private mapPaymentResponse(
    payment: MoyasarPaymentResponse,
    options: { forceOutcome?: PaymentOperationOutcome } = {},
  ): GatewayPaymentResult {
    // NEW-MOYASAR-1: never map a 2xx body with no id to failed/declined.
    this.assertObservedPaymentId(payment);

    const transactionUrl = payment.source?.transaction_url ?? undefined;
    const redirectUrl = payment.source?.type === "stcpay"
      ? undefined
      : transactionUrl;
    const nextAction = this.mapNextAction(payment);
    // Single mapStatus call: failed/abandoned/unmapped → "failed" (warn once)
    const baseStatus = this.mapStatus(payment.status);
    let status = this.resolvePaymentStatus(payment, baseStatus);

    // Finite minors only — never coerce missing/non-finite → 0 while keeping a
    // paid-like settled snapshot (MOYASAR-1). Malformed amount after create must
    // not throw (retry without given_id could double-create).
    const amountMinor =
      typeof payment.amount === "number" && Number.isFinite(payment.amount)
        ? payment.amount
        : undefined;
    const feeMinor =
      typeof payment.fee === "number" && Number.isFinite(payment.fee)
        ? payment.fee
        : undefined;
    const capturedMinor =
      typeof payment.captured === "number" && Number.isFinite(payment.captured)
        ? payment.captured
        : undefined;
    const refundedMinor =
      typeof payment.refunded === "number" && Number.isFinite(payment.refunded)
        ? payment.refunded
        : undefined;

    // MOYASAR-1: publish currency together with any major-unit money fields.
    // Resolve before demotion so missing/blank currency is part of the
    // incomplete-money check (same fail-closed class as missing amount).
    const currency =
      typeof payment.currency === "string" && payment.currency.trim().length > 0
        ? payment.currency.trim().toUpperCase()
        : undefined;

    // Paid-like without a complete money snapshot (finite amount + currency +
    // positive finite captured total): demote so isPaidOutcome stays false.
    // Finite 0 is legitimate only for non-paid paths (e.g. verified →
    // setup_completed). Missing/non-finite/zero captured must not fulfill
    // or publish the authorization total as settled captured
    // (P610-MOY-2 / MOYASAR-CAP-0 / Stripe/Paymob parity).
    if (
      status === "paid" &&
      (amountMinor === undefined ||
        currency === undefined ||
        capturedMinor === undefined ||
        capturedMinor <= 0)
    ) {
      status = "processing";
    }

    const outcome =
      options.forceOutcome ??
      this.mapMoyasarOutcome(status, nextAction, redirectUrl);

    const moneyFields =
      currency !== undefined
        ? {
            currency,
            ...(amountMinor !== undefined
              ? { amount: this.fromMinorUnits(amountMinor, currency) }
              : {}),
            ...(feeMinor !== undefined
              ? { fee: this.fromMinorUnits(feeMinor, currency) }
              : {}),
            ...(capturedMinor !== undefined
              ? {
                  capturedAmount: this.fromMinorUnits(capturedMinor, currency),
                }
              : {}),
            ...(refundedMinor !== undefined
              ? {
                  refundedAmount: this.fromMinorUnits(refundedMinor, currency),
                }
              : {}),
          }
        : {};

    return applyOutcomeToGatewayResult(
      {
        gatewayId: payment.id,
        status,
        rawResponse: payment,
        ...(redirectUrl !== undefined ? { redirectUrl } : {}),
        ...(nextAction !== undefined ? { nextAction } : {}),
        ...moneyFields,
        providerNativeStatus: payment.status,
        gateway: "moyasar",
      },
      outcome,
      outcome === "declined"
        ? {
            decline: {
              code:
                typeof payment.source?.message === "string" &&
                payment.source.message.length > 0
                  ? payment.source.message
                  : payment.status || "DECLINED",
              message:
                typeof payment.source?.message === "string" &&
                payment.source.message.length > 0
                  ? payment.source.message
                  : `Moyasar payment ${payment.status}`,
              providerCode: payment.status,
            },
          }
        : undefined,
    );
  }

  /**
   * Fetch payment currency before partial capture/refund so minor conversion
   * is bound to the provider payment (MOYASAR-3 / Paymob `resolveActionAmountCents`).
   * Runs outside the mutation fence so mismatch never sticks an idempotency key.
   */
  private async resolvePaymentCurrencyForPartial(
    gatewayPaymentId: string,
    operation: "capture" | "refund",
    signal?: AbortSignal,
  ): Promise<string> {
    const getInit: RequestInit = {
      method: "GET",
      headers: this.getHeaders(),
    };
    if (signal) {
      getInit.signal = signal;
    }
    const data = (await this.requestJson(
      this.paymentPath(gatewayPaymentId),
      getInit,
      `Failed to fetch payment currency for Moyasar ${operation}`,
    )) as MoyasarPaymentResponse;

    const currency =
      typeof data.currency === "string" && data.currency.trim().length > 0
        ? data.currency.trim().toUpperCase()
        : undefined;
    if (currency === undefined) {
      throw new InvalidRequestError(
        `Moyasar ${operation} requires payment currency to validate the requested amount`,
        [{ path: ["currency"] }],
      );
    }
    return currency;
  }

  /**
   * Derive Phase 6 outcome from mapped Moyasar status + challenge signals.
   * 3DS / STC OTP / initiated never map to `succeeded`.
   * Cancelled/voided maps to `failed` unless void forces succeeded.
   * Partial capture is open money → `requires_action` (not operation-succeeded);
   * `isPaidOutcome` remains false either way because paid-like is `paid` only.
   */
  private mapMoyasarOutcome(
    status: GatewayPaymentStatus,
    nextAction: PaymentNextAction | undefined,
    redirectUrl: string | undefined,
  ): PaymentOperationOutcome {
    if (status === "failed") {
      return "declined";
    }
    if (status === "cancelled") {
      return "failed";
    }
    if (
      nextAction !== undefined ||
      (status === "pending" &&
        typeof redirectUrl === "string" &&
        redirectUrl.length > 0)
    ) {
      return "requires_action";
    }
    if (status === "pending" || status === "processing") {
      // Initiated without challenge URL still must not be treated as paid.
      return "requires_action";
    }
    // Open money story — align with Paymob demotion (MOYASAR-5).
    if (status === "partially_captured" || status === "refund_completed") {
      return "requires_action";
    }
    // paid | authorized | partially_refunded | refunded | setup_completed
    return "succeeded";
  }

  /**
   * Convert major currency units to Moyasar minor units via shared bigint helpers.
   * @param options.allowNonPositive - For splits, Moyasar allows any non-zero
   *   integer (including negatives). Top-level payment amounts still require >= 1.
   */
  private toMinorUnits(
    amount: AmountInput,
    currency: string,
    options: { allowNonPositive?: boolean } = {},
  ): number {
    const allowNonPositive = options.allowNonPositive === true;
    const currencyCode = currency.toUpperCase();
    // ISO exponents via getCurrencyExponent (shared default). Strict reject
    // on excess precision; never float-multiply.
    const parseOpts = {
      rounding: "reject" as const,
      allowNegative: allowNonPositive,
      allowZero: false,
    };

    const normalized = normalizeAmountInput(amount, currency, parseOpts);
    const minor = sharedToMinorUnits(normalized, parseOpts);

    try {
      return minorAmountToNumber(minor);
    } catch (error) {
      if (error instanceof MoneyAmountError && error.kind === "unsafe_range") {
        throw new InvalidRequestError(
          `Moyasar amount for ${currencyCode} is too large to represent safely in minor units`,
        );
      }
      throw error;
    }
  }

  private fromMinorUnits(amount: number, currency: string): Money {
    // Provider responses use integer minor units; zero fees/refunds are common.
    return sharedFromMinorUnits(amount, currency, {
      allowZero: true,
      allowNegative: true,
    });
  }

  private constantTimeEquals(left: string, right: string): boolean {
    const leftBytes = utf8Encode(left);
    const rightBytes = utf8Encode(right);

    if (leftBytes.length !== rightBytes.length) {
      // Length is not secret; still touch both buffers then reject.
      const length = Math.max(leftBytes.length, rightBytes.length);
      const paddedLeft = new Uint8Array(length);
      const paddedRight = new Uint8Array(length);
      paddedLeft.set(leftBytes);
      paddedRight.set(rightBytes);
      timingSafeEqualBytes(paddedLeft, paddedRight);
      return false;
    }

    return timingSafeEqualBytes(leftBytes, rightBytes);
  }

  /**
   * Require a non-empty payment.id on an HTTP 2xx body.
   * Missing/blank id after a mutating POST is post-submit unknown — throw
   * {@link NetworkError} with `afterProviderSubmit` so create/OTP are not
   * treated as declined/failed (NEW-MOYASAR-1) and mutation fences stay
   * `unknown` instead of clearing.
   */
  private assertObservedPaymentId(payment: unknown): asserts payment is MoyasarPaymentResponse {
    if (payment !== null && typeof payment === "object" && !Array.isArray(payment)) {
      const id = (payment as { id?: unknown }).id;
      if (typeof id === "string" && id.trim().length > 0) {
        return;
      }
    }
    throw new NetworkError(
      "Moyasar API returned HTTP 2xx without a payment id; gateway outcome is unknown — reconcile via given_id/getPayment",
      payment,
      { afterProviderSubmit: true },
    );
  }

  /**
   * Standalone card-auth webhooks: keep provider-native type, dual-write
   * `provider.unmapped`. Never throw — verified payloads must ACK.
   */
  private parseCardAuthWebhookEvent(raw: MoyasarWebhookPayload): WebhookEvent {
    const payloadHash = hashWebhookPayload(this.compactWebhookIdentity(raw));
    const { secret_token: _secretToken, ...rawWithoutSecret } = raw;
    const data = raw.data;
    const currency =
      typeof data.currency === "string" && data.currency.trim().length > 0
        ? data.currency.trim().toUpperCase()
        : undefined;
    const failed =
      /fail/i.test(raw.type) ||
      (typeof data.status === "string" && data.status.toLowerCase() === "failed");
    const amountMinor =
      typeof data.amount === "number" && Number.isFinite(data.amount)
        ? data.amount
        : undefined;
    const legacy: WebhookEvent = {
      id: raw.id,
      type: raw.type,
      gateway: "moyasar",
      paymentId: this.extractPaymentId(data.metadata),
      gatewayPaymentId: data.id,
      // Setup-like when authenticated; failed only for explicit fail types.
      status: failed ? "failed" : "setup_completed",
      ...(currency !== undefined && amountMinor !== undefined
        ? { amount: this.fromMinorUnits(amountMinor, currency), currency }
        : currency !== undefined
          ? { currency }
          : {}),
      timestamp: new Date(raw.created_at),
      ...(typeof raw.live === "boolean" ? { livemode: raw.live } : {}),
      rawPayload: rawWithoutSecret,
    };
    return {
      ...attachPaymentEvent(legacy),
      payloadHash,
    };
  }

  private assertMoyasarWebhookPayload(payload: unknown): MoyasarWebhookPayload {
    let normalized: unknown = payload;
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed.length === 0) {
        throw new InvalidWebhookError("Invalid Moyasar webhook payload");
      }
      try {
        normalized = JSON.parse(trimmed) as unknown;
      } catch {
        throw new InvalidWebhookError("Invalid Moyasar webhook payload");
      }
    } else if (payload instanceof Uint8Array) {
      const text = new TextDecoder().decode(payload).trim();
      if (text.length === 0) {
        throw new InvalidWebhookError("Invalid Moyasar webhook payload");
      }
      try {
        normalized = JSON.parse(text) as unknown;
      } catch {
        throw new InvalidWebhookError("Invalid Moyasar webhook payload");
      }
    }
    if (!this.isRecord(normalized)) {
      throw new InvalidWebhookError("Invalid Moyasar webhook payload");
    }

    const record = normalized;
    const data = record.data;
    if (!this.isRecord(data)) {
      throw new InvalidWebhookError("Invalid Moyasar webhook payload: missing data");
    }

    if (
      typeof record.id !== "string" ||
      typeof record.type !== "string" ||
      typeof record.created_at !== "string" ||
      typeof data.id !== "string" ||
      typeof data.status !== "string" ||
      typeof data.amount !== "number" ||
      typeof data.currency !== "string"
    ) {
      throw new InvalidWebhookError("Invalid Moyasar webhook payload fields");
    }

    return record as unknown as MoyasarWebhookPayload;
  }

  /**
   * Compact webhook identity for `payloadHash` (NEW-PERF-1).
   * Matches Stripe: hash id/type/created + nested object id, not the full tree.
   */
  private compactWebhookIdentity(raw: MoyasarWebhookPayload): {
    id: string;
    type: string;
    created_at: string;
    object: string;
  } {
    return {
      id: raw.id,
      type: raw.type,
      created_at: raw.created_at,
      object: raw.data.id,
    };
  }

  private extractPaymentId(metadata: unknown): string | undefined {
    if (!this.isRecord(metadata)) {
      return undefined;
    }

    if (typeof metadata.paymentId === "string") {
      return metadata.paymentId;
    }

    return typeof metadata.orderId === "string"
      ? metadata.orderId
      : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private paymentPath(
    paymentId: string,
    operation?: "capture" | "refund" | "void",
  ): string {
    const encodedPaymentId = encodeURIComponent(paymentId);
    return operation
      ? `/payments/${encodedPaymentId}/${operation}`
      : `/payments/${encodedPaymentId}`;
  }

  private normalizeWebhookEventType(type: string): string {
    return type === "payment_faild" ? "payment_failed" : type;
  }

  private async requestJson(
    urlOrPath: string,
    init: RequestInit,
    fallbackMessage: string,
  ): Promise<unknown> {
    const { response, data } = await this.request(urlOrPath, init);

    if (!response.ok) {
      throw this.createApiError(
        data as MoyasarErrorResponse,
        fallbackMessage,
        response.status,
        response.headers,
      );
    }

    return data;
  }

  private async request(
    urlOrPath: string,
    init: RequestInit,
  ): Promise<{ response: Response; data: unknown }> {
    const timeoutMs = this.moyasarConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { signal: timeoutSignal, clear } = createTimeoutSignal(timeoutMs);
    const callerSignal = init.signal ?? undefined;
    const signal = combineAbortSignals(callerSignal, timeoutSignal);
    const url = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${this.baseUrl}${urlOrPath}`;
    const abortOptions = {
      callerSignal,
      timeoutSignal,
      timeoutMessage: "Moyasar API request timed out",
      networkMessage: "Failed to connect to Moyasar API",
      callerAbortMessage: "Moyasar API request aborted by caller signal",
      afterProviderSubmit: isMutatingHttpMethod(
        typeof init.method === "string" ? init.method : undefined,
      ),
    };

    try {
      let response: Response;
      try {
        response = await this.fetch(url, {
          ...init,
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (e) {
        throw mapHttpAbortError(e, abortOptions);
      }

      // Keep timeout armed until the body is consumed (P610-ABT-4).
      try {
        const data = await this.parseJsonResponse(response, {
          mutating: abortOptions.afterProviderSubmit === true,
        });
        return { response, data };
      } catch (e) {
        if (isAbortError(e)) {
          throw mapHttpAbortError(e, abortOptions);
        }
        throw e;
      }
    } finally {
      clear();
    }
  }

  /**
   * Parse the provider body. Mutating HTTP 2xx with unreadable JSON is
   * post-submit unknown (NEW-MOYASAR-JSON-1): throw
   * {@link NetworkError} `afterProviderSubmit` so `executeWithHooks` returns
   * indeterminate and `runIdempotentMutation` keeps the fence `unknown`.
   * GET / non-mutating 2xx stay {@link GatewayApiError}.
   */
  private async parseJsonResponse(
    response: Response,
    options?: { mutating?: boolean },
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch (e) {
      // Body-read abort must stay a timeout/caller abort, not invalid JSON.
      if (isAbortError(e)) {
        throw e;
      }
      if (options?.mutating === true && response.ok) {
        throw new NetworkError(
          "Moyasar API returned an invalid JSON response; gateway outcome is unknown — reconcile via getPayment",
          { status: response.status, cause: e },
          { afterProviderSubmit: true },
        );
      }
      throw new GatewayApiError(
        "Moyasar API returned an invalid JSON response",
        "moyasar",
        { status: response.status, cause: e },
      );
    }
  }

  /**
   * Map Moyasar provider status string to unified PaymentStatus.
   * Unmapped values fail closed as `failed` (do not treat as pending fulfillment).
   */
  private mapStatus(moyasarStatus: string): GatewayPaymentStatus {
    const statusMap: Record<string, GatewayPaymentStatus> = {
      initiated: "pending",
      authorized: "authorized",
      // Zero-amount card setup / verification — not an authorization hold.
      verified: "setup_completed",
      captured: "paid",
      paid: "paid",
      abandoned: "failed",
      failed: "failed",
      refunded: "refunded",
      voided: "cancelled",
    };
    const mapped = statusMap[moyasarStatus];
    if (mapped === undefined) {
      this.logger.warn(
        `[Moyasar] Unmapped payment status "${moyasarStatus}"; treating as failed (fail-closed for fulfillment)`,
      );
      return "failed";
    }
    return mapped;
  }

  /**
   * After mapping the provider status string, refine using amount fields so
   * partial refunds/captures surface as partially_refunded / partially_captured.
   *
   * Refund completeness uses a **captured baseline** when `captured > 0`, else
   * the original authorization `amount` (matches Stripe/Paymob + behavioral
   * contracts: full refund of a partial capture is `refunded`).
   *
   * **Fail-closed on incomplete refund snapshots (MOYASAR-2):** provider status
   * `refunded` with missing/zero/non-finite `refunded` amount does **not** map
   * to full `refunded`. It maps to `refund_completed` (refund entity signal
   * without proving full money reversal) so inventory/accounting cannot fully
   * reverse from an incomplete payload. Aligns with Stripe incomplete
   * `charge.refunded` → `refund_completed`. Webhook envelope `payment_refunded`
   * with a non-refund domain status is refined separately via
   * {@link failClosedIncompleteRefundWebhookStatus}.
   *
   * @param baseStatus - Optional precomputed `mapStatus` result (avoids double map/warn).
   */
  private resolvePaymentStatus(
    payment: {
      status: string;
      amount: number;
      refunded?: number;
      captured?: number;
    },
    baseStatus?: GatewayPaymentStatus,
  ): GatewayPaymentStatus {
    const status: GatewayPaymentStatus = baseStatus ?? this.mapStatus(payment.status);
    const refunded =
      typeof payment.refunded === "number" && Number.isFinite(payment.refunded)
        ? payment.refunded
        : 0;
    const captured =
      typeof payment.captured === "number" && Number.isFinite(payment.captured)
        ? payment.captured
        : 0;

    // Full refund of partial capture (refunded === captured < amount) => refunded.
    const refundBaseline = captured > 0 ? captured : payment.amount;
    const providerSaysRefunded =
      status === "refunded" || payment.status === "refunded";

    // Positive refunded amount: amount-based completeness (never invent full).
    if (refunded > 0) {
      if (refundBaseline > 0 && refunded < refundBaseline) {
        return "partially_refunded";
      }
      if (refundBaseline > 0 && refunded >= refundBaseline) {
        return "refunded";
      }
      // Positive refunded with no usable baseline — partial is safer than full.
      return "partially_refunded";
    }

    // Provider claims refunded but refunded amount is missing/zero/non-finite.
    // Do not fail-open to full `refunded` (MOYASAR-2).
    if (providerSaysRefunded) {
      return "refund_completed";
    }

    // Partial capture only when the base status is auth/paid (captured) family.
    if (
      captured > 0 &&
      captured < payment.amount &&
      Number.isFinite(payment.amount) &&
      (status === "authorized" ||
        status === "paid" ||
        payment.status === "authorized" ||
        payment.status === "captured" ||
        payment.status === "paid")
    ) {
      return "partially_captured";
    }

    // Paid/captured family without a positive finite captured total: fail closed
    // (P610-MOY-2 / MOYASAR-CAP-0 / Stripe/Paymob parity). Missing/non-finite
    // or finite 0 captured must not fulfill as paid / isPaidOutcome. Finite 0
    // is legitimate only for non-paid paths (verified → setup_completed).
    if (status === "paid") {
      const capturedAmount = payment.captured;
      const capturedFinite =
        typeof capturedAmount === "number" &&
        Number.isFinite(capturedAmount);
      if (!capturedFinite || capturedAmount <= 0) {
        return "processing";
      }
    }

    return status;
  }

  /**
   * When the Moyasar envelope is `payment_refunded` but amount refinement left a
   * non-refund domain status (typical: `paid` with missing/zero `refunded`),
   * force incomplete `refund_completed` so handlers never treat the payment as
   * still fully settled for fulfillment/restock (MOYASAR-2).
   *
   * Keeps failed/cancelled/etc. as-is; only demotes paid-like / open money
   * statuses that would otherwise false-fulfill.
   */
  private failClosedIncompleteRefundWebhookStatus(
    status: GatewayPaymentStatus,
    eventType: string,
  ): GatewayPaymentStatus {
    if (eventType !== "payment_refunded") {
      return status;
    }
    if (
      status === "refunded" ||
      status === "partially_refunded" ||
      status === "refund_completed" ||
      status === "refund_pending" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return status;
    }
    return "refund_completed";
  }

  private isCardChallenge(
    payment: MoyasarPaymentResponse,
  ): payment is MoyasarPaymentResponse & {
    source: MoyasarPaymentResponse["source"] & { transaction_url: string };
  } {
    return payment.source?.type === "creditcard" && typeof payment.source?.transaction_url === "string" && payment.source.transaction_url.length > 0 && payment.status === "initiated";
  }

  private mapNextAction(payment: MoyasarPaymentResponse): PaymentNextAction | undefined {
    if (this.isCardChallenge(payment)) {
      return {
        type: "redirect",
        url: payment.source.transaction_url,
      };
    }
    if (payment.status === "initiated" && payment.source.type === "stcpay") {
      return {
        type: "stcpay_otp",
        transactionUrl: payment.source.transaction_url ?? "",
        method: "POST",
        parameter: "otp_value",
      };
    }
    return undefined;
  }

  private isResidualHeldWebhookStatus(status: string): boolean {
    return (
      status === "paid" ||
      status === "authorized" ||
      status === "partially_captured" ||
      status === "processing"
    );
  }

  /**
   * Envelope `payment_voided` maps to `payment.cancelled` from the type alone.
   * When the payment snapshot is still paid / authorized / partially captured,
   * demote dual-write to `payment.processing` so type-only handlers cannot
   * restock while funds remain captured or held (MOYASAR-1). Domain status
   * stays residual (money-honest, same as `voidPayment` residual 2xx).
   * Provider-native `event.type` is unchanged.
   */
  private demoteResidualVoidWebhookDualWrite(
    event: WebhookEvent,
  ): WebhookEvent {
    if (!event.event || !event.provider) {
      return event;
    }
    if (!this.isResidualHeldWebhookStatus(event.status)) {
      return event;
    }

    const cancelledArm =
      event.stableType === "payment.cancelled" ||
      event.event.type === "payment.cancelled";
    if (!cancelledArm) {
      return event;
    }

    const payment =
      ("payment" in event.event && event.event.payment
        ? event.event.payment
        : undefined) ?? paymentFromWebhookEvent(event);

    return {
      ...event,
      stableType: "payment.processing",
      event: {
        schemaVersion: PAYMENT_EVENT_SCHEMA_VERSION,
        type: "payment.processing",
        payment,
        provider: event.provider,
      },
    };
  }

  /**
   * When Phase-7 dual-write claims settled money (`payment.succeeded` /
   * `capture.completed`) but domain status is **not** paid-like (`paid`), demote
   * dual-write to `payment.processing` so type-only fulfillment matches
   * `isPaidOutcome` (MOYASAR-3).
   *
   * Moyasar envelope types `payment_paid` / `payment_captured` map to settled
   * stable types from the envelope alone — before amount refinement can yield
   * `partially_captured` or other non-paid domain statuses. Mirrors Stripe
   * incomplete-settled demotion and PayPal non-final capture demotion.
   */
  private demoteNonPaidSettledWebhookDualWrite(
    event: WebhookEvent,
  ): WebhookEvent {
    // Paid-like domain is `paid` only — keep settled dual-write.
    if (event.status === "paid" || !event.event || !event.provider) {
      return event;
    }

    const settledArm =
      event.stableType === "payment.succeeded" ||
      event.stableType === "capture.completed" ||
      event.event.type === "payment.succeeded" ||
      event.event.type === "capture.completed";

    if (!settledArm) {
      return event;
    }

    // capture.completed.payment is optional; payment.processing requires Payment.
    const payment =
      ("payment" in event.event && event.event.payment
        ? event.event.payment
        : undefined) ?? paymentFromWebhookEvent(event);

    return {
      ...event,
      stableType: "payment.processing",
      event: {
        schemaVersion: PAYMENT_EVENT_SCHEMA_VERSION,
        type: "payment.processing",
        payment,
        provider: event.provider,
      },
    };
  }

  /**
   * Incomplete refund snapshots (`status === refund_completed`) must not
   * dual-write `refund.completed` — type-only handlers would mark orders fully
   * refunded without a proven positive `refunded` total (MOYASAR-1).
   * Stripe/Paymob pattern: domain keeps incomplete marker; stable dual-write is
   * `refund.pending`. Proven full/partial (`refunded` / `partially_refunded`)
   * keep `refund.completed`.
   */
  private demoteIncompleteRefundWebhookDualWrite(
    event: WebhookEvent,
  ): WebhookEvent {
    if (
      event.status !== "refund_completed" ||
      event.stableType !== "refund.completed" ||
      !event.event ||
      event.event.type !== "refund.completed" ||
      !event.provider
    ) {
      return event;
    }

    const refund = event.event.refund;

    return {
      ...event,
      stableType: "refund.pending",
      event: {
        schemaVersion: PAYMENT_EVENT_SCHEMA_VERSION,
        type: "refund.pending",
        refund,
        provider: event.provider,
      },
    };
  }

  /**
   * Resolve webhook/Phase-7 money field from the money movement that the event
   * describes (MOYASAR-1).
   *
   * - Refund-like events/statuses → cumulative `refunded` (not payment total).
   * - Capture / partial capture → `captured` when known.
   * - Otherwise → payment `amount` (prefer `captured` for paid settlement when set).
   *
   * Incomplete refund snapshots without a finite `refunded` field omit amount
   * rather than inventing the full payment total.
   */
  private resolveWebhookEventAmount(
    data: {
      amount: number;
      currency: string;
      refunded?: number;
      captured?: number;
    },
    status: GatewayPaymentStatus,
    eventType: string,
  ): Money | undefined {
    const refunded =
      typeof data.refunded === "number" && Number.isFinite(data.refunded)
        ? data.refunded
        : undefined;
    const captured =
      typeof data.captured === "number" && Number.isFinite(data.captured)
        ? data.captured
        : undefined;

    const refundLike =
      eventType === "payment_refunded" ||
      status === "refunded" ||
      status === "partially_refunded" ||
      status === "refund_completed" ||
      status === "refund_pending";

    if (refundLike) {
      if (refunded !== undefined) {
        return this.fromMinorUnits(refunded, data.currency);
      }
      // Incomplete: do not report payment total as the refund money field.
      return undefined;
    }

    const captureLike =
      eventType === "payment_captured" || status === "partially_captured";

    if (captureLike) {
      // Include finite 0 — never invent the authorization total as captured
      // (MOYASAR-CAP-0).
      if (captured !== undefined) {
        return this.fromMinorUnits(captured, data.currency);
      }
      // Partial without captured field — do not invent full authorization total.
      if (status === "partially_captured") {
        return undefined;
      }
    }

    // Paid settlement: prefer captured amount when the snapshot includes it
    // (including finite 0 — do not publish full amount as settled captured).
    if (
      (status === "paid" || eventType === "payment_paid") &&
      captured !== undefined
    ) {
      return this.fromMinorUnits(captured, data.currency);
    }

    return this.fromMinorUnits(data.amount, data.currency);
  }

  private assertMoyasarStcTransactionUrl(transactionUrl: string): string {
    let url: URL;
    try {
      url = new URL(transactionUrl);
    } catch {
      throw new InvalidRequestError(
        "Moyasar STC Pay transactionUrl must be a valid URL",
      );
    }

    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.moyasar.com" ||
      !url.pathname.startsWith("/v1/stc_pays/") ||
      !url.pathname.endsWith("/proceed")
    ) {
      throw new InvalidRequestError(
        "Moyasar STC Pay transactionUrl must be the transaction_url returned by Moyasar",
      );
    }

    return url.toString();
  }

  /**
   * Create a structured API error from Moyasar error response
   */
  private createApiError(
    errorData: MoyasarErrorResponse,
    fallbackMessage: string,
    status?: number,
    headers?: Headers,
  ): GatewayApiError {
    let message = errorData.message ?? fallbackMessage;

    // Append validation errors if present
    if (errorData.errors) {
      const errorDetails = Object.entries(errorData.errors)
        .map(([field, messages]) => {
          const detail = Array.isArray(messages)
            ? messages.join(", ")
            : String(messages);
          return `${field}: ${detail}`;
        })
        .join("; ");
      message = `${message} - ${errorDetails}`;
    }

    const error = new GatewayApiError(message, "moyasar", {
      type: errorData.type,
      message,
      errors: errorData.errors,
      status,
    });

    // Expose Retry-After (seconds) so the retry helper can honor it on 429s.
    const retryAfterSeconds = parseRetryAfterSeconds(headers);
    if (retryAfterSeconds !== undefined) {
      (error as GatewayApiError & { retryAfterSeconds?: number }).retryAfterSeconds =
        retryAfterSeconds;
    }

    return error;
  }
}
