// file: packages/payments/src/gateways/paypal/paypal.gateway.ts

import { BaseGateway } from "../base.gateway";
import type {
  AmountInput,
  CaptureParams,
  GetPaymentParams,
  GatewayPaymentResult,
  GatewayRefundResult,
  PayPalCreatePaymentParams,
  RefundParams,
  VoidParams,
} from "../../types/payment.types";
import type { GatewayPaymentStatus } from "../../types/domain-status";
import {
  applyOutcomeToGatewayResult,
  applyOutcomeToGatewayRefundResult,
  type PaymentOperationOutcome,
  type RefundOperationOutcome,
} from "../../types/operation-result";
import type { PayPalWebhookPayload, WebhookEvent, } from "../../types/webhook.types";
import {
  attachPaymentEvent,
  hashWebhookPayload,
  paymentFromWebhookEvent,
  PAYMENT_EVENT_SCHEMA_VERSION,
} from "../../types/payment-event";
import type { PayPalConfig } from "../../types/config.types";
import type { HooksManager } from "../../hooks/hooks.manager";
import {
  PayPalCreatePaymentParamsSchema,
  CaptureParamsSchema,
  GetPaymentParamsSchema,
  RefundParamsSchema,
  VoidParamsSchema,
} from "../../types/validation";
import {
  GatewayApiError,
  CardDeclinedError,
  InsufficientFundsError,
  AuthenticationError,
  RateLimitError,
  InvalidRequestError,
  NetworkError,
  ResourceNotFoundError,
} from "../../errors";
import { withRetry as withRetryShared } from "../../utils/retry";
import type { Logger } from "../../utils/logger";
import {
  fromMinorUnits as sharedFromMinorUnits,
  moneyToMajorNumber,
  MoneyAmountError,
  money,
  normalizeAmountInput,
  toMinorUnits as sharedToMinorUnits,
  type Money,
} from "../../utils/money";
import { getCurrencyExponent } from "../../utils/currency";
import { PAYPAL_CAPABILITIES } from "../builtin-capabilities";
import type { GatewayRuntimeDeps } from "../../runtime/payment-runtime";
import {
  combineAbortSignals,
  createTimeoutSignal,
  extractAbortSignal,
  isMutatingHttpMethod,
  mapHttpAbortError,
} from "../../runtime/abort";

type PayPalRefundStatus = "pending" | "completed" | "failed";

class PayPalApiError extends GatewayApiError {
  constructor(
    message: string,
    rawError: unknown,
    public readonly paypalStatusCode: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message, "paypal", rawError);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PayPal API Response Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Capture / authorization resource as embedded on a PayPal order. */
type PayPalEmbeddedCapture = {
  id: string;
  status: string;
  amount: {
    currency_code: string;
    value: string;
  };
  /** When not strictly true (omitted/undefined/false), capture is non-final. */
  final_capture?: boolean;
  create_time?: string;
  update_time?: string;
};

type PayPalEmbeddedAuthorization = {
  id: string;
  status: string;
  amount: {
    currency_code: string;
    value: string;
  };
  create_time?: string;
  update_time?: string;
};

interface PayPalOrderResponse {
  id: string;
  status: string;
  intent?: "CAPTURE" | "AUTHORIZE";
  amount?: {
    currency_code: string;
    value: string;
  };
  /** Present on authorization-capture API responses (Payments v2 capture object). */
  final_capture?: boolean;
  message?: string;
  name?: string;
  details?: Array<{
    issue?: string;
    description?: string;
    field?: string;
    value?: string;
  }>;
  links?: Array<{ rel: string; href: string }>;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: {
      currency_code: string;
      value: string;
    };
    payments?: {
      captures?: Array<PayPalEmbeddedCapture>;
      authorizations?: Array<PayPalEmbeddedAuthorization>;
    };
  }>;
}

interface PayPalRefundResponse {
  id: string;
  status: string;
  /** Present when Prefer: return=representation (this refund's amount). */
  amount?: {
    currency_code: string;
    value: string;
  };
  /**
   * Present on representation responses after refund.
   * `total_refunded_amount` is capture-wide cumulative (not this-op only).
   */
  seller_payable_breakdown?: {
    total_refunded_amount?: PayPalMoney;
    gross_amount?: PayPalMoney;
    net_amount?: PayPalMoney;
    paypal_fee?: PayPalMoney;
  };
  message?: string;
  name?: string;
  details?: Array<{
    issue?: string;
    description?: string;
  }>;
}

type PayPalMoney = {
  currency_code: string;
  value: string;
};

type PayPalPaymentResource = {
  id: string;
  status: string;
  amount: PayPalMoney;
  final_capture?: boolean;
  /**
   * Capture activity breakdown. `total_refunded_amount` is cumulative refunded
   * on this capture when present (used for remaining-held + totalRefunded).
   */
  seller_receivable_breakdown?: {
    gross_amount?: PayPalMoney;
    net_amount?: PayPalMoney;
    paypal_fee?: PayPalMoney;
    total_refunded_amount?: PayPalMoney;
  };
  supplementary_data?: {
    related_ids?: {
      order_id?: string;
      authorization_id?: string;
      capture_id?: string;
    };
  };
  links?: Array<{ rel: string; href: string }>;
};

interface PayPalTokenResponse {
  access_token: string;
  expires_in: number;
  message?: string;
}

interface PayPalWebhookVerifyRequest {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: unknown;
}

interface PayPalWebhookVerifyResponse {
  verification_status: "SUCCESS" | "FAILURE";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Retry Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const PAYPAL_ZERO_DECIMAL_CURRENCIES = new Set(["HUF", "JPY", "TWD"]);
const PAYPAL_ORDER_REQUEST_ID_MAX_LENGTH = 108;
const PAYPAL_PAYMENTS_REQUEST_ID_MAX_LENGTH = 10_000;
const PAYPAL_CUSTOM_ID_MAX_LENGTH = 127;
/** PayPal purchase_unit.description max length. */
const PAYPAL_DESCRIPTION_MAX_LENGTH = 127;
/** PayPal purchase_unit.reference_id (SDK orderId) max length. */
const PAYPAL_ORDER_ID_MAX_LENGTH = 256;
/** PayPal refund note_to_payer max length (SDK reason). */
const PAYPAL_REFUND_NOTE_MAX_LENGTH = 255;
const PAYPAL_WEBHOOK_ID_MAX_LENGTH = 50;
/**
 * Soft age threshold for `paypal-transmission-time`. Transmissions older than
 * this still proceed to PayPal signature verify (post-outage retries) but log a
 * warning. Far-future timestamps beyond this window are hard-rejected (clock skew).
 * Replay protection relies on PayPal verify + merchant `event.id` dedupe.
 */
const PAYPAL_WEBHOOK_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** Age at which we start warning about late deliveries (still accepted for verify). */
const PAYPAL_WEBHOOK_WARN_AGE_MS = 15 * 60 * 1000;
/** Heuristic for unknown resource statuses that appear terminal (fail-closed). */
const PAYPAL_TERMINAL_RESOURCE_STATUS_PATTERN =
  /FAIL|DENIED|DECLIN|CANCEL|VOID|EXPIR|REJECT|ERROR|ABORT|BLOCK/i;
const PAYPAL_WEBHOOK_HEADER_LIMITS = {
  authAlgo: 100,
  certUrl: 500,
  transmissionId: 50,
  transmissionSig: 500,
  transmissionTime: 100,
} as const;
const PAYPAL_WEBHOOK_ID_PATTERN = /^[A-Za-z0-9]+$/;
/** Events that never carry amount, or may intentionally omit remaining-held. */
const PAYPAL_WEBHOOK_EVENTS_WITHOUT_AMOUNT = new Set([
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
  // May omit amount when PARTIALLY_REFUNDED lacks net remaining (fail-closed).
  "PAYMENT.CAPTURE.REFUNDED",
  // Publishes 0 remaining when face present; omit is still valid if no money data.
  "PAYMENT.CAPTURE.REVERSED",
  // Dispute webhooks dual-write dispute.*; amount is optional.
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
]);
const PAYPAL_WEBHOOK_EVENTS_WITHOUT_RESOURCE_ID = new Set([
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
]);
const PAYPAL_WEBHOOK_EVENTS_WITHOUT_RESOURCE_STATUS = new Set([
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
]);

function isPayPalCustomerDisputeEventType(eventType: string): boolean {
  return (
    eventType === "CUSTOMER.DISPUTE.CREATED" ||
    eventType === "CUSTOMER.DISPUTE.UPDATED" ||
    eventType === "CUSTOMER.DISPUTE.RESOLVED"
  );
}

/**
 * Envelope status for PayPal dispute webhooks is the dispute lifecycle —
 * never `paid`, never generic payment `pending`. Does not widen PaymentStatus;
 * lifecycle strings are asserted onto the 0.x envelope field (P22-ENVELOPE).
 */
function paypalDisputeEnvelopeStatus(
  eventType: string,
  resourceStatus?: string,
  outcomeCode?: string,
): GatewayPaymentStatus {
  const native = (resourceStatus ?? "").trim().toUpperCase();
  const outcome = (outcomeCode ?? "").trim().toUpperCase();

  if (native === "WAITING_FOR_SELLER_RESPONSE" || native === "OPEN") {
    return "needs_response" as GatewayPaymentStatus;
  }
  if (
    native === "UNDER_REVIEW" ||
    native === "WAITING_FOR_BUYER_RESPONSE"
  ) {
    return "under_review" as GatewayPaymentStatus;
  }
  if (native === "RESOLVED" || eventType === "CUSTOMER.DISPUTE.RESOLVED") {
    if (
      outcome === "RESOLVED_SELLER" ||
      outcome === "CANCELED_BY_BUYER" ||
      outcome === "DENIED"
    ) {
      return "won" as GatewayPaymentStatus;
    }
    if (outcome === "RESOLVED_BUYER" || outcome === "ACCEPTED") {
      return "lost" as GatewayPaymentStatus;
    }
    return "processing";
  }
  if (eventType === "CUSTOMER.DISPUTE.CREATED") {
    return "needs_response" as GatewayPaymentStatus;
  }
  return "processing";
}

function readPayPalDisputeOutcomeCode(
  resource: PayPalWebhookPayload["resource"],
): string | undefined {
  const outcome = (
    resource as { dispute_outcome?: { outcome_code?: unknown } }
  ).dispute_outcome;
  if (
    outcome !== null &&
    typeof outcome === "object" &&
    typeof outcome.outcome_code === "string" &&
    outcome.outcome_code.trim().length > 0
  ) {
    return outcome.outcome_code;
  }
  return undefined;
}

/**
 * Retry with exponential backoff.
 *
 * Thin adapter over the shared {@link withRetryShared} helper, preserving
 * PayPal's original call signature. The shared helper's default backoff already
 * honors `retryAfterSeconds` on the error (PayPalApiError exposes it), so 429
 * Retry-After values are respected.
 */
function withRetry<T>(
  operation: () => Promise<T>,
  isRetryable: (error: unknown) => boolean = () => false,
): Promise<T> {
  return withRetryShared(operation, { isRetryable });
}

/**
 * Check if error is retryable (5xx or network errors)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof PayPalApiError) {
    const status = error.paypalStatusCode;
    if (status >= 500 || status === 429) {
      return true;
    }

    const raw = error.rawError as {
      name?: string;
      details?: Array<{ issue?: string }>;
    };
    return status === 409 &&
      raw?.name === "RESOURCE_CONFLICT" &&
      raw.details?.some((detail) => detail.issue === "PREVIOUS_REQUEST_IN_PROGRESS") === true;
  }
  // Network errors (timeout maps to NetworkError). Caller aborts map to
  // PaymentAbortedError and must not be retried.
  // HTTP 200 with unreadable id/status is already an observed mutation
  // outcome — do not re-POST (timeouts/drops still retry via Request-Id).
  if (error instanceof NetworkError) {
    return !(
      error.afterProviderSubmit === true &&
      error.message.includes("Invalid PayPal")
    );
  }
  return error instanceof TypeError;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PayPal Gateway Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PayPal payment gateway implementation
 * Uses PayPal REST API v2
 * @see https://developer.paypal.com/docs/api/orders/v2/
 */
export class PayPalGateway extends BaseGateway {
  readonly name = "paypal" as const;

  private readonly paypalConfig: PayPalConfig;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;

  /** Promise for in-flight token fetch (prevents race conditions) */
  private tokenFetchPromise: Promise<string> | null = null;

  private get baseUrl(): string {
    return this.paypalConfig.sandbox
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";
  }

  constructor(
    config: PayPalConfig,
    hooks: HooksManager,
    logger?: Logger,
    runtime?: GatewayRuntimeDeps,
  ) {
    super(config, hooks, logger, PAYPAL_CAPABILITIES, runtime);
    if (
      config.webhookId !== undefined &&
      !PayPalGateway.isValidWebhookId(config.webhookId)
    ) {
      throw new InvalidRequestError(
        `PayPal webhookId must be ${PAYPAL_WEBHOOK_ID_MAX_LENGTH} or fewer alphanumeric characters`,
      );
    }
    this.paypalConfig = config;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Retrieve order details by ID
   */
  async getPayment(params: GetPaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("getPayment", params, async (p) => {
      const { gatewayPaymentId } = p;

      const callerSignal = extractAbortSignal(p);
      return withRetry(async () => {
        const response = await this.fetchWithAccessToken(
          `${this.baseUrl}/v2/checkout/orders/${gatewayPaymentId}`,
          (token) => ({
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          }),
          callerSignal,
        );

        const data = await this.parseJsonResponse<PayPalOrderResponse>(response);

        if (!response.ok) {
          if (response.status === 404) {
            return this.getPaymentResource(gatewayPaymentId, callerSignal);
          }

          throw this.createApiError(data, response.status, response.headers);
        }

        this.assertOrderResponse(data, "get payment");

        const captures = data.purchase_units?.[0]?.payments?.captures;
        // Preferred capture is for status mapping only — not a multi-capture refund target.
        const capture = this.preferLastCapture(captures);
        // PAYPAL-1: only dual-write captureId when a single refundable capture remains.
        // Multiple captures + aggregated amount + one latest id implies a false full refund path.
        const singleRefundableCaptureId =
          this.selectSingleRefundableCaptureId(captures);
        const authorization = data.purchase_units?.[0]?.payments?.authorizations?.[0];
        const purchaseUnitAmount = data.purchase_units?.[0]?.amount;
        const status = this.mapPaymentResultStatus(
          data,
          capture,
          authorization,
          captures,
        );
        // Aggregate remaining held capture money (excludes fully REFUNDED face amounts).
        const aggregatedCaptured = this.sumSuccessfulCaptureAmounts(
          captures,
          "get payment",
        );
        // When captures exist, do not fall back to a single capture's face amount if
        // the aggregate is empty (e.g. all REFUNDED / PARTIALLY_REFUNDED without net).
        const singleMoney = (() => {
          if (captures && captures.length > 0) {
            return undefined;
          }
          const singleAmount =
            capture?.amount ?? authorization?.amount ?? purchaseUnitAmount;
          return singleAmount
            ? this.tryParsePayPalMoney(singleAmount, "get payment")
            : undefined;
        })();
        const amountMoney =
          aggregatedCaptured ?? singleMoney;
        const moneyCurrency =
          aggregatedCaptured?.currency ?? singleMoney?.currency;
        return this.mapPayPalPaymentResult({
          gatewayId: data.id,
          orderId: data.id,
          status,
          rawResponse: data,
          providerNativeStatus:
            capture?.status ?? authorization?.status ?? data.status,
          ...(singleRefundableCaptureId !== undefined
            ? { captureId: singleRefundableCaptureId }
            : {}),
          ...(authorization?.id !== undefined
            ? { authorizationId: authorization.id }
            : {}),
          ...(amountMoney !== undefined ? { amount: amountMoney } : {}),
          ...(aggregatedCaptured !== undefined
            ? { capturedAmount: aggregatedCaptured }
            : {}),
          ...(moneyCurrency !== undefined ? { currency: moneyCurrency } : {}),
        });
      }, isRetryableError);
    }, GetPaymentParamsSchema);
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(gatewayId: string): Promise<GatewayPaymentStatus> {
    const result = await this.getPayment({ gatewayPaymentId: gatewayId });
    return result.status;
  }

  /**
   * Create a PayPal order
   */
  async createPayment(
    params: PayPalCreatePaymentParams,
  ): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("createPayment", params, async (p) => {
      // PayPal experience_context needs return + cancel URLs.
      // Success return: returnUrl | callbackUrl. Cancel: cancelUrl | callbackUrl | returnUrl.
      // returnUrl-only is legal (both return_url and cancel_url use returnUrl).
      if (!(p as unknown as PayPalCreatePaymentParams).returnUrl && !p.callbackUrl) {
        throw new InvalidRequestError(
          "PayPal createPayment requires returnUrl or callbackUrl",
        );
      }
      if (!(p as unknown as PayPalCreatePaymentParams).cancelUrl && !p.callbackUrl && !(p as unknown as PayPalCreatePaymentParams).returnUrl) {
        throw new InvalidRequestError(
          "PayPal createPayment requires cancelUrl, callbackUrl, or returnUrl for cancel fallback",
        );
      }
      // Shipping address payload is not yet supported on createPayment.
      if ((p as unknown as PayPalCreatePaymentParams).paypalShippingPreference === "SET_PROVIDED_ADDRESS") {
        throw new InvalidRequestError(
          "PayPal shipping_preference SET_PROVIDED_ADDRESS is not supported: shipping address payload is not yet available. Use NO_SHIPPING (default) or GET_FROM_FILE.",
        );
      }

      const requestId = this.getRequestId(p.idempotencyKey, PAYPAL_ORDER_REQUEST_ID_MAX_LENGTH, {
        operation: "createPayment",
        policy: "ephemeral-ok",
      });
      this.assertMaxLength(
        p.orderId,
        PAYPAL_ORDER_ID_MAX_LENGTH,
        "PayPal orderId (reference_id)",
      );
      this.assertMaxLength(
        p.description,
        PAYPAL_DESCRIPTION_MAX_LENGTH,
        "PayPal description",
      );
      return withRetry(async () => {
        const customId = this.getCustomId(p.metadata);
        const body = JSON.stringify({
          intent: p.capture === false ? "AUTHORIZE" : "CAPTURE",
          purchase_units: [
            {
              reference_id: p.orderId,
              description: p.description,
              custom_id: customId,
              amount: {
                currency_code: this.normalizeCurrencyCode(p.currency),
                value: this.formatAmount(p.amount, p.currency),
              },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
                return_url: (p as unknown as PayPalCreatePaymentParams).returnUrl ?? p.callbackUrl,
                cancel_url: (p as unknown as PayPalCreatePaymentParams).cancelUrl ?? p.callbackUrl ?? (p as unknown as PayPalCreatePaymentParams).returnUrl,
                shipping_preference: (p as unknown as PayPalCreatePaymentParams).paypalShippingPreference ?? "NO_SHIPPING",
                user_action: "PAY_NOW",
              },
            },
          },
        });

        const response = await this.fetchWithAccessToken(
          `${this.baseUrl}/v2/checkout/orders`,
          (token) => ({
            method: "POST",
            headers: this.createJsonHeaders(token, requestId),
            body,
          }),
          extractAbortSignal(p),
        );

        const data = await this.parseJsonResponse<PayPalOrderResponse>(response, {
          afterProviderSubmit: true,
        });

        if (!response.ok) {
          throw this.createApiError(data, response.status, response.headers);
        }

        this.assertOrderResponse(data, "create payment", {
          afterProviderSubmit: true,
        });

        // Find approval URL
        const approvalLink = data.links?.find(
          (link) => link.rel === "payer-action" || link.rel === "approve",
        );
        if (!approvalLink?.href) {
          throw this.createMalformedResponseError(
            "Invalid PayPal create payment response: missing approval link",
            data,
            { afterProviderSubmit: true },
          );
        }

        const status = this.mapStatus(data.status);
        const redirectUrl = approvalLink.href;
        // Create always returns an approval redirect → requires_action (never paid).
        const outcome: PaymentOperationOutcome =
          status === "failed" ? "declined" : "requires_action";
        return applyOutcomeToGatewayResult(
          {
            gatewayId: data.id,
            orderId: data.id,
            status,
            redirectUrl,
            rawResponse: data,
            providerNativeStatus: data.status,
            gateway: "paypal",
          },
          outcome,
          outcome === "declined"
            ? {
                decline: {
                  code: data.status ?? "DECLINED",
                  message: `PayPal order status ${data.status}`,
                  providerCode: data.status,
                },
              }
            : undefined,
        );
      }, isRetryableError);
    }, PayPalCreatePaymentParamsSchema);
  }

  /**
   * Capture a PayPal order after customer approval
   * @returns Result including capture ID in rawResponse for use in refunds
   */
  async capturePayment(params: CaptureParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("capturePayment", params, async (p) => {
      const isAuthorizationCapture = p.paypalCaptureType === "authorization";
      const requestId = this.getRequestId(
        p.idempotencyKey,
        isAuthorizationCapture
          ? PAYPAL_PAYMENTS_REQUEST_ID_MAX_LENGTH
          : PAYPAL_ORDER_REQUEST_ID_MAX_LENGTH,
        { operation: "capturePayment", policy: "require-caller" },
      );
      return withRetry(async () => {
        if (!isAuthorizationCapture && p.amount !== undefined) {
          throw new InvalidRequestError(
            "PayPal order captures do not support amount. Create an AUTHORIZE-intent order and capture the authorization for partial captures.",
          );
        }

        const url = isAuthorizationCapture
          ? `${this.baseUrl}/v2/payments/authorizations/${p.gatewayPaymentId}/capture`
          : `${this.baseUrl}/v2/checkout/orders/${p.gatewayPaymentId}/capture`;

        const body: Record<string, unknown> = {};
        if (isAuthorizationCapture && p.amount !== undefined) {
          if (!p.currency) {
            throw new InvalidRequestError(
              "Currency is required for partial PayPal authorization captures",
            );
          }
          body.amount = {
            value: this.formatAmount(p.amount, p.currency),
            currency_code: this.normalizeCurrencyCode(p.currency),
          };
        }

        // PayPal API defaults final_capture to false. SDK product defaults
        // apply only to authorization captures (Orders sale capture does not send it):
        // - full capture (no amount): true (capture remaining balance and close auth)
        // - partial (amount set): false unless paypalFinalCapture === true
        if (isAuthorizationCapture) {
          body.final_capture =
            p.amount !== undefined
              ? p.paypalFinalCapture === true
              : (p.paypalFinalCapture ?? true);
        }

        const response = await this.fetchWithAccessToken(
          url,
          (token) => ({
            method: "POST",
            headers: this.createJsonHeaders(token, requestId, "return=representation"),
            body: JSON.stringify(body),
          }),
          extractAbortSignal(p),
        );

        const data = await this.parseJsonResponse<PayPalOrderResponse>(response, {
          afterProviderSubmit: true,
        });

        if (!response.ok) {
          throw this.createApiError(data, response.status, response.headers);
        }

        this.assertOrderResponse(data, "capture payment", {
          afterProviderSubmit: true,
        });

        // Extract capture details (prefer last capture on multi-capture order responses)
        const capture = isAuthorizationCapture
          ? {
            id: data.id,
            status: data.status,
            amount: data.amount,
            final_capture: data.final_capture,
          }
          : this.preferLastCapture(
            data.purchase_units?.[0]?.payments?.captures,
          );

        this.assertPaymentResource(capture, "capture payment", {
          afterProviderSubmit: true,
        });

        let status = capture
          ? this.mapResourceStatus(capture.status)
          : this.mapStatus(data.status);

        // NEW-PAYPAL-7: paid only when response final_capture === true.
        // Same rule as GET / webhook. Do not fall back to request intent —
        // sale/order captures never send final_capture; a request-true fallback
        // fulfills on capture then looks open on poll.
        const responseFinalCapture =
          typeof capture.final_capture === "boolean"
            ? capture.final_capture
            : typeof data.final_capture === "boolean"
              ? data.final_capture
              : undefined;
        if (status === "paid" && responseFinalCapture !== true) {
          status = "partially_captured";
        }

        // PayPal can return HTTP 200 with capture status PENDING (echeck, review).
        // success remains true for pending API outcomes via requires_action dual-write;
        // callers must require outcome succeeded + status paid before fulfill.
        // Terminal failed statuses set success:false (outcome declined).
        // partially_captured dual-writes requires_action (not succeeded).
        if (status === "pending") {
          this.logger.warn(
            "[PayPal] Capture returned pending status; do not fulfill until status is paid (webhook or poll)",
          );
        } else if (status === "partially_captured") {
          this.logger.warn(
            "[PayPal] Capture is non-final (final_capture is not true); do not fulfill remaining auth — status is partially_captured, not paid",
          );
        }

        const captureMoney = this.parsePayPalMoney(
          capture.amount,
          "capture payment",
        );
        return this.mapPayPalPaymentResult({
          gatewayId: capture.id,
          captureId: capture.id,
          status,
          amount: captureMoney,
          currency: captureMoney.currency,
          // Include capture ID for downstream refund use
          rawResponse: {
            ...data,
            captureId: capture?.id,
            orderId: isAuthorizationCapture ? undefined : data.id,
            authorizationId: isAuthorizationCapture
              ? p.gatewayPaymentId
              : undefined,
          },
          providerNativeStatus: capture.status ?? data.status,
          ...(!isAuthorizationCapture ? { orderId: data.id } : {}),
          ...(isAuthorizationCapture
            ? { authorizationId: p.gatewayPaymentId }
            : {}),
        });
      }, isRetryableError);
    }, CaptureParamsSchema);
  }

  /**
   * Refund a captured PayPal payment
   * Note: gatewayPaymentId should be the CAPTURE ID, not order ID
   */
  async refundPayment(params: RefundParams): Promise<GatewayRefundResult> {
    return this.executeWithHooks("refundPayment", params, async (p) => {
      const requestId = this.getRequestId(p.idempotencyKey, PAYPAL_PAYMENTS_REQUEST_ID_MAX_LENGTH, {
        operation: "refundPayment",
        policy: "require-caller",
      });
      this.assertMaxLength(
        p.reason,
        PAYPAL_REFUND_NOTE_MAX_LENGTH,
        "PayPal refund reason (note_to_payer)",
      );
      return withRetry(async () => {
        // Build refund body
        const body: Record<string, unknown> = {};

        if (p.amount !== undefined) {
          if (!p.currency) {
            throw new InvalidRequestError(
              "Currency is required for partial PayPal refunds",
            );
          }
          body.amount = {
            value: this.formatAmount(p.amount, p.currency),
            currency_code: this.normalizeCurrencyCode(p.currency),
          };
        }

        if (p.reason) {
          body.note_to_payer = p.reason;
        }

        const response = await this.fetchWithAccessToken(
          `${this.baseUrl}/v2/payments/captures/${p.gatewayPaymentId}/refund`,
          (token) => ({
            method: "POST",
            headers: this.createJsonHeaders(token, requestId, "return=representation"),
            body: JSON.stringify(body),
          }),
          extractAbortSignal(p),
        );

        const data = await this.parseJsonResponse<PayPalRefundResponse>(response, {
          afterProviderSubmit: true,
        });

        if (!response.ok) {
          // Refunds hit /v2/payments/captures/{id}/refund — order/auth IDs 404 here.
          if (
            response.status === 404 ||
            (data as { name?: string }).name === "RESOURCE_NOT_FOUND"
          ) {
            throw new PayPalApiError(
              "PayPal refund requires capture ID from capturePayment, not order/authorization ID",
              data,
              response.status,
              this.parseRetryAfterSeconds(response.headers),
            );
          }
          throw this.createApiError(data, response.status, response.headers);
        }

        this.assertRefundResponse(data, { afterProviderSubmit: true });

        const status = this.mapRefundStatus(data.status);
        const outcome: RefundOperationOutcome =
          status === "completed"
            ? "succeeded"
            : status === "failed"
              ? "failed"
              : "pending";
        // PAYPAL-2: totalRefunded is capture-wide cumulative (prior + this op),
        // matching JSDoc / Stripe / Moyasar. Never publish this-op alone as total.
        // Prefer seller_payable_breakdown.total_refunded_amount, else capture GET.
        // Only publish on completed refunds (pending must not book ledgers).
        let totalRefunded: Money | undefined;
        if (status === "completed") {
          totalRefunded = await this.resolveCaptureTotalRefunded(
            p.gatewayPaymentId,
            data,
            extractAbortSignal(p),
          );
        }
        // Terminal failed/cancelled refunds → outcome failed → success false.
        return applyOutcomeToGatewayRefundResult(
          {
            gatewayRefundId: data.id,
            status,
            rawResponse: data,
            ...(totalRefunded !== undefined ? { totalRefunded } : {}),
          },
          outcome,
        );
      }, isRetryableError);
    }, RefundParamsSchema);
  }

  /**
   * Capture-wide cumulative refunded major units after a successful refund.
   * PAYPAL-2: never invent this-op amount as totalRefunded.
   */
  private async resolveCaptureTotalRefunded(
    captureId: string,
    refund: PayPalRefundResponse,
    callerSignal?: AbortSignal,
  ): Promise<Money | undefined> {
    const fromRefund = this.tryParsePayPalMoney(
      refund.seller_payable_breakdown?.total_refunded_amount,
      "refund total_refunded_amount",
    );
    if (fromRefund) {
      return fromRefund;
    }

    // Capture GET often carries seller_receivable_breakdown.total_refunded_amount.
    try {
      const response = await this.fetchWithAccessToken(
        `${this.baseUrl}/v2/payments/captures/${captureId}`,
        (token) => ({
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        }),
        callerSignal,
      );
      const capture = await this.parseJsonResponse<PayPalPaymentResource>(response);
      if (!response.ok) {
        return undefined;
      }

      const fromCapture = this.tryParsePayPalMoney(
        capture.seller_receivable_breakdown?.total_refunded_amount,
        "capture total_refunded_amount",
      );
      if (fromCapture) {
        return fromCapture;
      }

      // Fully refunded capture without breakdown → face amount is the cumulative total.
      const mapped = this.mapResourceStatus(capture.status);
      if (mapped === "refunded") {
        const face = this.tryParsePayPalMoney(capture.amount, "capture face");
        return face;
      }
    } catch {
      // Secondary capture GET is best-effort; omit total rather than this-op lie.
    }

    return undefined;
  }

  /**
   * Void an authorized PayPal payment
   * Note: This only works for orders created with intent: AUTHORIZE
   * gatewayPaymentId should be the AUTHORIZATION ID, not order ID
   * @see https://developer.paypal.com/docs/api/payments/v2/#authorizations_void
   */
  async voidPayment(params: VoidParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("voidPayment", params, async (p) => {
      const requestId = this.getRequestId(p.idempotencyKey, PAYPAL_PAYMENTS_REQUEST_ID_MAX_LENGTH, {
        operation: "voidPayment",
        policy: "require-caller",
      });
      return withRetry(async () => {
        const response = await this.fetchWithAccessToken(
          `${this.baseUrl}/v2/payments/authorizations/${p.gatewayPaymentId}/void`,
          (token) => ({
            method: "POST",
            headers: this.createJsonHeaders(token, requestId),
          }),
          extractAbortSignal(p),
        );

        // PayPal returns 204 No Content on successful void
        if (response.status === 204) {
          return this.mapPayPalPaymentResult({
            gatewayId: p.gatewayPaymentId,
            authorizationId: p.gatewayPaymentId,
            status: "cancelled",
            rawResponse: null,
            providerNativeStatus: "VOIDED",
            forceOutcome: "succeeded",
          });
        }

        // If not 204, try to parse the response for error details
        const data = await this.parseJsonResponse<PayPalOrderResponse>(response, {
          afterProviderSubmit: true,
        });

        if (!response.ok) {
          throw this.createApiError(data, response.status, response.headers);
        }

        this.assertOrderResponse(data, "void payment", {
          afterProviderSubmit: true,
        });

        return this.mapPayPalPaymentResult({
          gatewayId: data.id ?? p.gatewayPaymentId,
          authorizationId: data.id ?? p.gatewayPaymentId,
          status: this.mapStatus(data.status ?? "VOIDED"),
          rawResponse: data,
          providerNativeStatus: data.status ?? "VOIDED",
          forceOutcome: "succeeded",
        });
      }, isRetryableError);
    }, VoidParamsSchema);
  }

  /**
   * Authorize an approved PayPal AUTHORIZE-intent order.
   * Use the returned authorizationId to capture or void the hold later.
   */
  async authorizePayment(params: CaptureParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("authorizePayment", params, async (p) => {
      this.assertAuthorizeParams(p);
      const requestId = this.getRequestId(p.idempotencyKey, PAYPAL_ORDER_REQUEST_ID_MAX_LENGTH, {
        operation: "authorizePayment",
        policy: "require-caller",
      });
      return withRetry(async () => {
        const response = await this.fetchWithAccessToken(
          `${this.baseUrl}/v2/checkout/orders/${p.gatewayPaymentId}/authorize`,
          (token) => ({
            method: "POST",
            headers: this.createJsonHeaders(token, requestId, "return=representation"),
            body: "{}",
          }),
          extractAbortSignal(p),
        );

        const data = await this.parseJsonResponse<PayPalOrderResponse>(response, {
          afterProviderSubmit: true,
        });

        if (!response.ok) {
          throw this.createApiError(data, response.status, response.headers);
        }

        this.assertOrderResponse(data, "authorize payment", {
          afterProviderSubmit: true,
        });
        const authorization = data.purchase_units?.[0]?.payments?.authorizations?.[0];
        this.assertPaymentResource(authorization, "authorize payment", {
          afterProviderSubmit: true,
        });

        const status = this.mapResourceStatus(authorization.status);
        const authMoney = this.parsePayPalMoney(
          authorization.amount,
          "authorize payment",
        );
        return this.mapPayPalPaymentResult({
          // Match capturePayment: terminal failed statuses are not successful outcomes.
          gatewayId: authorization.id,
          orderId: data.id,
          authorizationId: authorization.id,
          status,
          amount: authMoney,
          currency: authMoney.currency,
          providerNativeStatus: authorization.status,
          rawResponse: {
            ...data,
            authorizationId: authorization.id,
          },
        });
      }, isRetryableError);
    }, CaptureParamsSchema);
  }

  /**
   * Map PayPal errors to standardized SDK errors
   */
  protected mapError(error: unknown): Error {
    if (error instanceof PayPalApiError) {
      const raw = error.rawError as {
        name?: string;
        details?: Array<{ issue?: string }>;
      };
      const name = raw?.name;
      const issues = raw?.details
        ?.map((detail) => detail.issue)
        .filter((issue): issue is string => Boolean(issue)) ?? [];
      const hasIssue = (patterns: string[]): boolean =>
        issues.some((issue) => patterns.some((pattern) => issue.includes(pattern)));

      if (error.paypalStatusCode === 401 || name === "AUTHENTICATION_FAILURE") {
        return new AuthenticationError(error.message, raw);
      }
      if (error.paypalStatusCode === 404 || name === "RESOURCE_NOT_FOUND") {
        return new ResourceNotFoundError(error.message, raw);
      }
      if (error.paypalStatusCode === 429 || name === "RATE_LIMIT_REACHED") {
        return new RateLimitError("paypal", error.retryAfterSeconds);
      }
      if (hasIssue(["INSUFFICIENT_FUNDS"])) {
        return new InsufficientFundsError(error.message, raw);
      }
      if (hasIssue([
        "INSTRUMENT_DECLINED",
        "CARD_EXPIRED",
        "CARD_BRAND_NOT_SUPPORTED",
        "CARD_COUNTRY_NOT_SUPPORTED",
        "CARD_TYPE_NOT_SUPPORTED",
        "COMPLIANCE_VIOLATION",
        "DECLINED_DUE_TO_RELATED_TXN",
        "PAYEE_BLOCKED_TRANSACTION",
      ])) {
        return new CardDeclinedError(error.message, raw);
      }
      if (
        error.paypalStatusCode === 400 ||
        error.paypalStatusCode === 422 ||
        name === "INVALID_REQUEST" ||
        name === "MALFORMED_REQUEST" ||
        name === "VALIDATION_ERROR" ||
        name === "UNPROCESSABLE_ENTITY"
      ) {
        return new InvalidRequestError(error.message, [raw]);
      }
    }
    return super.mapError(error);
  }


  /**
   * Verify PayPal webhook signature (synchronous).
   *
   * PayPal signature verification requires an API round-trip. This method
   * always throws — use {@link verifyWebhookAsync} or `client.handleWebhook`.
   *
   * Prefer the **raw** request body (string / Buffer / Uint8Array). Parsed
   * objects are accepted by the async path but may fail verification because
   * re-serialization can change key order and whitespace.
   *
   * @throws {InvalidRequestError} Always — sync verification is not supported.
   * @see https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature
   */
  verifyWebhook(
    _payload?: unknown,
    _signatureOrHeaders?: string | Record<string, string>,
    _headers?: Record<string, string>,
  ): boolean {
    throw new InvalidRequestError(
      "PayPal does not support synchronous webhook verification. Use verifyWebhookAsync or client.handleWebhook",
    );
  }

  /**
   * Verify PayPal webhook signature asynchronously.
   * This is the recommended method for webhook verification.
   *
   * **Raw body required for reliable verification**: pass the exact bytes
   * PayPal signed (string, Buffer, or Uint8Array). The SDK embeds that JSON
   * text as `webhook_event` without parse→stringify reordering. Already-parsed
   * objects are still accepted but log a warning — verification may fail.
   *
   * Also rejects `paypal-transmission-time` values that are unparseable or
   * far in the future (clock skew). Aged transmissions soft-accept with a warn
   * and still call PayPal verify (dedupe by `event.id` required).
   *
   * Certificate URLs are allowlisted to HTTPS hosts under `*.paypal.com` before
   * any verify API call.
   */
  async verifyWebhookAsync(
    payload: unknown,
    signatureOrHeaders?: string | Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<boolean> {
    if (!this.paypalConfig.webhookId) {
      throw new InvalidRequestError(
        "paypal.webhookId is required for webhook verification",
      );
    }

    const normalizedHeaders = this.normalizeHeaders(
      typeof signatureOrHeaders === "string" ? headers : signatureOrHeaders,
    );
    const transmissionId = normalizedHeaders["paypal-transmission-id"];
    const transmissionTime = normalizedHeaders["paypal-transmission-time"];
    const transmissionSig =
      typeof signatureOrHeaders === "string"
        ? signatureOrHeaders
        : normalizedHeaders["paypal-transmission-sig"];
    const certUrl = normalizedHeaders["paypal-cert-url"];
    const authAlgo = normalizedHeaders["paypal-auth-algo"];

    if (
      !transmissionId ||
      !transmissionTime ||
      !transmissionSig ||
      !certUrl ||
      !authAlgo
    ) {
      this.logger.warn("[PayPal] Missing required webhook headers");
      return false;
    }

    if (!this.isValidWebhookHeaders({
      authAlgo,
      certUrl,
      transmissionId,
      transmissionSig,
      transmissionTime,
    })) {
      // Reason already logged inside isValidWebhookHeaders when specific.
      this.logger.warn("[PayPal] Invalid webhook header values");
      return false;
    }

    const verifyBody = this.buildWebhookVerifyBody({
      authAlgo,
      certUrl,
      transmissionId,
      transmissionSig,
      transmissionTime,
      webhookId: this.paypalConfig.webhookId,
      payload,
    });
    if (verifyBody === undefined) {
      this.logger.warn(
        "[PayPal] Webhook verification failed: payload is not a valid JSON object",
      );
      return false;
    }

    const response = await withRetry(async () => {
      const verificationResponse = await this.fetchWithAccessToken(
        `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
        (token) => ({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: verifyBody,
        }),
      );

      if (!verificationResponse.ok) {
        const errorData = await this.parseJsonResponse<PayPalOrderResponse>(verificationResponse);
        throw this.createApiError(errorData, verificationResponse.status, verificationResponse.headers);
      }

      return verificationResponse;
    }, isRetryableError);

    const data = await this.parseJsonResponse<PayPalWebhookVerifyResponse>(response);
    if (
      data.verification_status !== "SUCCESS" &&
      data.verification_status !== "FAILURE"
    ) {
      throw this.createMalformedResponseError(
        "Invalid PayPal webhook verification response: missing verification_status",
        data,
      );
    }

    return data.verification_status === "SUCCESS";
  }

  /**
   * Parse PayPal webhook payload into normalized WebhookEvent.
   * Accepts a parsed object, or a raw JSON string/Buffer (same shapes as verify).
   *
   * Dual-writes Phase 7 PaymentEvent. Note: `PAYMENT.CAPTURE.COMPLETED` maps to
   * stable `capture.completed` (not `payment.succeeded`) — see webhook-events.md.
   * `CUSTOMER.DISPUTE.CREATED` / `UPDATED` / `RESOLVED` dual-write `dispute.*`
   * with dispute-lifecycle envelope status (never `paid` / payment `pending`).
   *
   * NEW-PERF-1: `payloadHash` is a compact identity
   * `{ id, type, create_time, resource }` (resource.id), not the full raw tree.
   * Inbox claim must use `event.payloadHash`; re-hashing `rawPayload` will not match.
   */
  parseWebhookEvent(payload: unknown): WebhookEvent {
    const raw = this.validateWebhookPayload(this.coerceWebhookPayload(payload));

    if (isPayPalCustomerDisputeEventType(raw.event_type)) {
      return this.parseCustomerDisputeWebhookEvent(raw);
    }

    // Extract capture ID if available. Refund webhooks identify the refund as
    // resource.id and link back to the affected capture with rel="up".
    // Resolved before status mapping so CHECKOUT.ORDER.COMPLETED is only
    // treated as paid when a capture is present (not auth-only completed orders).
    const captureId = this.extractWebhookCaptureId(raw);
    const resourceFinalCapture = this.readResourceFinalCapture(raw.resource);
    const orderCaptures = this.extractWebhookOrderCaptures(raw);
    const orderAuthorization = this.extractWebhookOrderAuthorization(raw);
    const lastOrderCapture = this.preferLastCapture(orderCaptures);

    // Nested capture final_capture (ORDER multi-capture) + top-level capture resource.
    const nestedFinalCapture =
      typeof lastOrderCapture?.final_capture === "boolean"
        ? lastOrderCapture.final_capture
        : undefined;
    const effectiveFinalCapture =
      resourceFinalCapture !== undefined
        ? resourceFinalCapture
        : nestedFinalCapture;

    let status = this.mapWebhookStatus(raw.event_type, raw.resource.status, {
      // Nested captures only — a related_ids.capture_id string is not settlement.
      hasCapture: Boolean(lastOrderCapture),
      hasAuthorization: Boolean(orderAuthorization),
      ...(effectiveFinalCapture !== undefined
        ? { finalCapture: effectiveFinalCapture }
        : {}),
    });
    if (!status) {
      throw new InvalidRequestError(
        `Unsupported PayPal webhook event: ${raw.event_type}`,
      );
    }

    // Align ORDER.COMPLETED with getPayment for every branch:
    // - nested capture(s) present → paid / partially_captured / refund aggregates
    // - auth-only → authorized (PAYPAL-2; not approved)
    // - bare COMPLETED without payments → processing (PAYPAL-1; not paid)
    // - capture_id string only (no purchase_units[].payments.captures) → processing
    if (raw.event_type === "CHECKOUT.ORDER.COMPLETED") {
      // Build a minimal order snapshot for status mapping (cast avoids EOPT noise
      // on optional amount/purchase_units from the webhook resource shape).
      const orderLike = {
        id: raw.resource.id ?? captureId ?? "order",
        status: raw.resource.status ?? "COMPLETED",
        ...(raw.resource.amount !== undefined
          ? { amount: raw.resource.amount }
          : {}),
        ...(raw.resource.purchase_units !== undefined
          ? { purchase_units: raw.resource.purchase_units }
          : {}),
      } as PayPalOrderResponse;
      // Do not invent a COMPLETED capture from related_ids.capture_id.
      // Absent nested purchase_units[].payments.captures → same as bare COMPLETED.
      status = this.mapPaymentResultStatus(
        orderLike,
        lastOrderCapture,
        orderAuthorization,
        orderCaptures,
      );
    }

    const webhookAmount = this.extractWebhookAmount(raw);
    if (!webhookAmount && this.webhookEventRequiresAmount(raw.event_type)) {
      // Incomplete multi-capture partial-refund snapshots omit amount honestly
      // (REFUNDED+PENDING siblings, PARTIALLY_REFUNDED without net remaining).
      // Deliver status; do not throw and drop the event.
      const incompletePartialRefund =
        orderCaptures !== undefined &&
        orderCaptures.length > 0 &&
        this.aggregateCaptureRefundStatus(orderCaptures) ===
          "partially_refunded";
      if (!incompletePartialRefund) {
        throw new InvalidRequestError(
          `PayPal webhook event ${raw.event_type} is missing amount information`,
        );
      }
    }
    const amount = webhookAmount
      ? this.parseAmount(webhookAmount, "webhook")
      : undefined;
    const eventTimestamp = new Date(raw.create_time);
    if (!Number.isFinite(eventTimestamp.getTime())) {
      throw new GatewayApiError(
        "Invalid webhook payload: invalid create_time",
        "paypal",
        raw,
      );
    }

    const paymentId = this.extractWebhookPaymentId(raw);

    // PAYPAL-1: multi-capture order webhooks aggregate amount across captures.
    // Never dual-write that aggregate with a single latest capture id (false full-refund target).
    // Prefer order id when more than one refundable capture is present.
    // PAYPAL-ID-1: when siblings exist and exactly one is still held, publish
    // that capture — last / related_ids.capture_id can be the already-refunded slice.
    const refundableCaptureCount =
      this.listRefundableCaptures(orderCaptures).length;
    const multiCaptureOrder = refundableCaptureCount > 1;
    const orderResourceId = raw.resource.id ?? raw.resource.order_id;
    const singleRefundableCaptureId =
      this.selectSingleRefundableCaptureId(orderCaptures);
    const gatewayPaymentId =
      multiCaptureOrder && orderResourceId
        ? orderResourceId
        : (singleRefundableCaptureId ?? captureId ?? orderResourceId);
    if (!gatewayPaymentId) {
      throw new GatewayApiError(
        "Invalid webhook payload: missing gateway payment identifier",
        "paypal",
        raw,
      );
    }
    // Single-capture order events: object id is the order when gatewayPaymentId is the capture.
    // Multi-capture: primary id is already the order — do not invent a single capture object id.
    const gatewayObjectId =
      multiCaptureOrder
        ? undefined
        : raw.resource.id && captureId && captureId !== raw.resource.id
          ? raw.resource.id
          : undefined;

    const event: WebhookEvent = {
      id: raw.id,
      type: raw.event_type,
      gateway: "paypal",
      paymentId,
      gatewayPaymentId,
      gatewayObjectId,
      status,
      timestamp: eventTimestamp,
      rawPayload: raw,
    };

    if (webhookAmount) {
      event.amount = amount;
      // Normalize to uppercase ISO 4217 for cross-gateway consistency.
      event.currency = webhookAmount.currency_code.toUpperCase();
    }

    const attached = attachPaymentEvent(event);
    // PERF-6 / NEW-PERF-1: inbox keys PayPal events by `event.id`. Hash a
    // compact identity instead of redact+stringify the full resource tree.
    attached.payloadHash = hashWebhookPayload({
      id: raw.id,
      type: raw.event_type,
      create_time: raw.create_time,
      resource: raw.resource.id,
    });
    // Non-final / partial captures must not dual-write fulfillment-ready types.
    // Demote to payment.processing so type-only handlers match isPaidOutcome.
    // Incomplete refund_completed / CAPTURE.REFUNDED+partially_refunded must
    // dual-write refund.pending (not refund.completed) — PAYPAL-DW-1.
    // PAYPAL-5: AUTHORIZATION.CAPTURED without a capture id must not dual-write
    // capture.completed against a non-refundable authorization id.
    return this.demoteAuthCapturedWithoutCaptureId(
      this.demoteIncompleteRefundWebhookDualWrite(
        this.demotePartialCaptureWebhookDualWrite(attached),
      ),
      captureId,
    );
  }

  /**
   * CUSTOMER.DISPUTE.* — dual-write dispute.opened/updated/closed.
   * Envelope IDs are the dispute resource id (not a capture). Amount optional.
   */
  private parseCustomerDisputeWebhookEvent(
    raw: PayPalWebhookPayload,
  ): WebhookEvent {
    const disputeId = raw.resource.id;
    if (!disputeId) {
      throw new GatewayApiError(
        "Invalid webhook payload: missing dispute identifier",
        "paypal",
        raw,
      );
    }

    const disputeOutcome = readPayPalDisputeOutcomeCode(raw.resource);
    const status = this.mapWebhookStatus(raw.event_type, raw.resource.status, {
      ...(disputeOutcome !== undefined ? { disputeOutcome } : {}),
    });
    if (!status) {
      throw new InvalidRequestError(
        `Unsupported PayPal webhook event: ${raw.event_type}`,
      );
    }

    const eventTimestamp = new Date(raw.create_time);
    if (!Number.isFinite(eventTimestamp.getTime())) {
      throw new GatewayApiError(
        "Invalid webhook payload: invalid create_time",
        "paypal",
        raw,
      );
    }

    const event: WebhookEvent = {
      id: raw.id,
      type: raw.event_type,
      gateway: "paypal",
      paymentId: this.extractWebhookPaymentId(raw),
      gatewayPaymentId: disputeId,
      gatewayObjectId: disputeId,
      status,
      timestamp: eventTimestamp,
      rawPayload: raw,
    };

    const attached = attachPaymentEvent(event);
    attached.payloadHash = hashWebhookPayload({
      id: raw.id,
      type: raw.event_type,
      create_time: raw.create_time,
      resource: raw.resource.id,
    });
    return attached;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate webhook payload structure
   */
  private validateWebhookPayload(payload: unknown): PayPalWebhookPayload {
    if (!payload || typeof payload !== "object") {
      throw new GatewayApiError(
        "Invalid webhook payload: not an object",
        "paypal",
        payload,
      );
    }

    const p = payload as Record<string, unknown>;

    if (typeof p.id !== "string") {
      throw new GatewayApiError(
        "Invalid webhook payload: missing id",
        "paypal",
        payload,
      );
    }

    if (typeof p.event_type !== "string") {
      throw new GatewayApiError(
        "Invalid webhook payload: missing event_type",
        "paypal",
        payload,
      );
    }

    if (typeof p.create_time !== "string") {
      throw new GatewayApiError(
        "Invalid webhook payload: missing create_time",
        "paypal",
        payload,
      );
    }

    if (!p.resource || typeof p.resource !== "object") {
      throw new GatewayApiError(
        "Invalid webhook payload: missing resource",
        "paypal",
        payload,
      );
    }

    const resource = p.resource as Record<string, unknown>;

    if (
      typeof resource.id !== "string" &&
      !PAYPAL_WEBHOOK_EVENTS_WITHOUT_RESOURCE_ID.has(p.event_type)
    ) {
      throw new GatewayApiError(
        "Invalid webhook payload: missing resource.id",
        "paypal",
        payload,
      );
    }

    if (
      typeof resource.status !== "string" &&
      !PAYPAL_WEBHOOK_EVENTS_WITHOUT_RESOURCE_STATUS.has(p.event_type)
    ) {
      throw new GatewayApiError(
        "Invalid webhook payload: missing resource.status",
        "paypal",
        payload,
      );
    }

    return payload as PayPalWebhookPayload;
  }

  private async getPaymentResource(
    gatewayPaymentId: string,
    callerSignal?: AbortSignal,
  ): Promise<GatewayPaymentResult> {
    const captureResult = await this.tryGetPaymentResource(
      gatewayPaymentId,
      "capture",
      callerSignal,
    );

    if (captureResult) {
      return captureResult;
    }

    return this.getAuthorizationResource(gatewayPaymentId, callerSignal);
  }

  private async tryGetPaymentResource(
    gatewayPaymentId: string,
    resourceType: "capture",
    callerSignal?: AbortSignal,
  ): Promise<GatewayPaymentResult | undefined> {
    const response = await this.fetchWithAccessToken(
      `${this.baseUrl}/v2/payments/captures/${gatewayPaymentId}`,
      (token) => ({
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }),
      callerSignal,
    );

    const data = await this.parseJsonResponse<PayPalPaymentResource>(response);

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw this.createApiError(data, response.status, response.headers);
    }

    this.assertPaymentResource(data, `get ${resourceType}`);

    // Capture-resource GET must honor final_capture the same as capturePayment /
    // order getPayment / webhooks. PayPal API default is false; omitted/undefined
    // is not final. COMPLETED is only a slice unless final_capture === true.
    let status = this.mapResourceStatus(data.status);
    if (status === "paid" && data.final_capture !== true) {
      status = "partially_captured";
      this.logger.warn(
        "[PayPal] Capture resource is non-final (final_capture is not true); getPayment status is partially_captured, not paid",
      );
    }

    // PAYPAL-3: PARTIALLY_REFUNDED/REFUNDED must not publish original face as held.
    const held = this.captureRemainingHeldAmount(
      data,
      status,
      `get ${resourceType}`,
    );

    const relatedIds = data.supplementary_data?.related_ids;
    return this.mapPayPalPaymentResult({
      gatewayId: data.id,
      captureId: data.id,
      status,
      ...(held !== undefined
        ? { amount: held, currency: held.currency }
        : {}),
      rawResponse: data,
      providerNativeStatus: data.status,
      ...(relatedIds?.order_id !== undefined
        ? { orderId: relatedIds.order_id }
        : {}),
      ...(relatedIds?.authorization_id !== undefined
        ? { authorizationId: relatedIds.authorization_id }
        : {}),
    });
  }

  private async getAuthorizationResource(
    gatewayPaymentId: string,
    callerSignal?: AbortSignal,
  ): Promise<GatewayPaymentResult> {
    const response = await this.fetchWithAccessToken(
      `${this.baseUrl}/v2/payments/authorizations/${gatewayPaymentId}`,
      (token) => ({
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }),
      callerSignal,
    );

    const data = await this.parseJsonResponse<PayPalPaymentResource>(response);

    if (!response.ok) {
      throw this.createApiError(data, response.status, response.headers);
    }

    this.assertPaymentResource(data, "get authorization");
    const relatedIds = data.supplementary_data?.related_ids;
    const authMoney = this.parsePayPalMoney(data.amount, "get authorization");

    // related_ids.capture_id is a single string with no sibling list.
    // Multi-capture can point refunds at the wrong slice. Auth id is not
    // refundable — omit captureId unless a single held capture is proven.
    return this.mapPayPalPaymentResult({
      gatewayId: data.id,
      authorizationId: data.id,
      status: this.mapResourceStatus(data.status),
      amount: authMoney,
      currency: authMoney.currency,
      rawResponse: data,
      providerNativeStatus: data.status,
      ...(relatedIds?.order_id !== undefined
        ? { orderId: relatedIds.order_id }
        : {}),
    });
  }

  /**
   * Build GatewayPaymentResult with Phase 6 outcome + ProviderReferences.
   * Dual-writes legacy orderId/captureId/authorizationId for 0.x callers.
   * PAYPAL-1: always publish `currency` whenever major-unit amount fields are set.
   */
  private mapPayPalPaymentResult(input: {
    gatewayId: string;
    status: GatewayPaymentStatus;
    rawResponse: unknown;
    orderId?: string | undefined;
    captureId?: string | undefined;
    authorizationId?: string | undefined;
    amount?: Money | number | string | undefined;
    /** ISO 4217 — required whenever amount/capturedAmount are published. */
    currency?: string | undefined;
    capturedAmount?: Money | number | string | undefined;
    redirectUrl?: string | undefined;
    providerNativeStatus?: string | undefined;
    forceOutcome?: PaymentOperationOutcome | undefined;
  }): GatewayPaymentResult {
    const outcome =
      input.forceOutcome ?? this.mapPayPalOutcome(input.status, input.redirectUrl);

    // Fail-closed: never publish naked major-unit amounts without currency.
    const hasMoney =
      input.amount !== undefined || input.capturedAmount !== undefined;
    const currency =
      typeof input.currency === "string" && input.currency.length === 3
        ? this.normalizeCurrencyCode(input.currency)
        : undefined;
    const toMoney = (v: Money | number | string | undefined, cur: string|undefined): Money|undefined => {
      if (v === undefined || cur === undefined) return undefined;
      if (typeof v === "object" && "amount" in (v as any) && "currency" in (v as any)) return v as Money;
      if (typeof v === "number") return money(String(v), cur, { allowZero: true, allowNegative: true });
      if (typeof v === "string") return money(v, cur, { allowZero: true, allowNegative: true });
      return undefined;
    };
    const amount =
      hasMoney && currency !== undefined ? toMoney(input.amount, currency) : undefined;
    const capturedAmount =
      hasMoney && currency !== undefined ? toMoney(input.capturedAmount, currency) : undefined;

    return applyOutcomeToGatewayResult(
      {
        gatewayId: input.gatewayId,
        status: input.status,
        rawResponse: input.rawResponse,
        ...(input.redirectUrl !== undefined
          ? { redirectUrl: input.redirectUrl }
          : {}),
        ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
        ...(input.captureId !== undefined ? { captureId: input.captureId } : {}),
        ...(input.authorizationId !== undefined
          ? { authorizationId: input.authorizationId }
          : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(capturedAmount !== undefined ? { capturedAmount } : {}),
        ...(currency !== undefined && hasMoney ? { currency } : {}),
        ...(input.providerNativeStatus !== undefined
          ? { providerNativeStatus: input.providerNativeStatus }
          : {}),
        gateway: "paypal",
      },
      outcome,
      outcome === "declined"
        ? {
            decline: {
              code: input.providerNativeStatus ?? input.status,
              message: `PayPal payment status ${input.status}`,
              ...(input.providerNativeStatus !== undefined
                ? { providerCode: input.providerNativeStatus }
                : {}),
            },
          }
        : undefined,
    );
  }

  /**
   * Map normalized PayPal payment status to operation outcome.
   * Approval redirects, buyer `approved` (pre-capture), pending captures,
   * and non-final `partially_captured` slices are never `succeeded`.
   * Reversals are not charge success (`failed`).
   */
  private mapPayPalOutcome(
    status: GatewayPaymentStatus,
    redirectUrl?: string,
  ): PaymentOperationOutcome {
    if (status === "failed") {
      return "declined";
    }
    if (
      (typeof redirectUrl === "string" && redirectUrl.length > 0) ||
      status === "pending" ||
      status === "processing" ||
      status === "approved" ||
      status === "partially_captured"
    ) {
      // Buyer APPROVED = pre-capture; funds not settled. Keep requires_action
      // so isPaidOutcome / poll helpers cannot treat approval as fulfillment.
      // Non-final partial captures stay open (more may follow on the auth).
      return "requires_action";
    }
    if (status === "cancelled" || status === "reversed") {
      // voidPayment forces succeeded; VOIDED / REVERSED reads are not charge success.
      return "failed";
    }
    // paid | authorized | refunded
    return "succeeded";
  }

  private assertAuthorizeParams(params: CaptureParams): void {
    if (
      params.amount !== undefined ||
      params.currency !== undefined ||
      params.paypalCaptureType !== undefined ||
      params.paypalFinalCapture !== undefined
    ) {
      throw new InvalidRequestError(
        "PayPal authorizePayment only accepts gatewayPaymentId and idempotencyKey",
      );
    }
  }

  /**
   * Get OAuth access token for PayPal API
   * Uses promise-based singleton to prevent race conditions
   */
  private async getAccessToken(callerSignal?: AbortSignal): Promise<string> {
    // Return cached token if still valid (injectable clock, not wall `Date`).
    if (
      this.accessToken &&
      this.tokenExpiry &&
      this.tokenExpiry.getTime() > this.clock.nowMs()
    ) {
      return this.accessToken;
    }

    // If there's already a token fetch in progress, wait for it
    if (this.tokenFetchPromise) {
      return this.tokenFetchPromise;
    }

    // Start new token fetch
    this.tokenFetchPromise = this.fetchAccessToken(callerSignal);

    try {
      return await this.tokenFetchPromise;
    } finally {
      this.tokenFetchPromise = null;
    }
  }

  private invalidateAccessToken(): void {
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  private async fetchWithAccessToken(
    url: string,
    initFactory: (token: string) => RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const withSignal = (init: RequestInit): RequestInit => {
      if (!callerSignal) {
        return init;
      }
      return { ...init, signal: callerSignal };
    };

    let token = await this.getAccessToken(callerSignal);
    let response = await this.performFetch(url, withSignal(initFactory(token)));

    if (response.status !== 401) {
      return response;
    }

    this.invalidateAccessToken();
    token = await this.getAccessToken(callerSignal);
    response = await this.performFetch(url, withSignal(initFactory(token)));
    return response;
  }

  /**
   * Fetch new access token from PayPal
   */
  private async fetchAccessToken(callerSignal?: AbortSignal): Promise<string> {
    const credentials = btoa(
      `${this.paypalConfig.clientId}:${this.paypalConfig.clientSecret}`,
    );

    const response = await this.performFetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: "grant_type=client_credentials",
      ...(callerSignal !== undefined ? { signal: callerSignal } : {}),
    });

    const data = await this.parseJsonResponse<PayPalTokenResponse>(response);

    if (!response.ok) {
      throw new PayPalApiError(
        "Failed to get PayPal access token",
        data,
        response.status,
        this.parseRetryAfterSeconds(response.headers),
      );
    }

    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
      throw this.createMalformedResponseError(
        "Invalid PayPal token response: missing access_token",
        data,
      );
    }

    if (
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw this.createMalformedResponseError(
        "Invalid PayPal token response: missing expires_in",
        data,
      );
    }

    this.accessToken = data.access_token;
    // Refresh early to avoid using a token that expires mid-request: up to 5
    // minutes early, or half the lifetime for short-lived tokens.
    const refreshSkewSeconds = Math.min(300, Math.floor(data.expires_in / 2));
    this.tokenExpiry = new Date(
      this.clock.nowMs() + (data.expires_in - refreshSkewSeconds) * 1000,
    );

    return this.accessToken;
  }

  /**
   * Create a structured API error from PayPal response
   */
  private createApiError(
    data: PayPalOrderResponse | PayPalRefundResponse,
    statusCode: number,
    headers?: Headers,
  ): GatewayApiError {
    // Build detailed error message from details array
    let message = data.message ?? data.name ?? "PayPal API error";

    if (data.details && data.details.length > 0) {
      const detailMessages = data.details
        .map((d) => d.description ?? d.issue ?? "Unknown issue")
        .join("; ");
      message = `${message}: ${detailMessages}`;
    }

    return new PayPalApiError(
      message,
      data,
      statusCode,
      headers ? this.parseRetryAfterSeconds(headers) : undefined,
    );
  }

  /**
   * Unreadable provider body. After a mutating POST, throw NetworkError with
   * afterProviderSubmit so executeWithHooks maps to indeterminate — never
   * PayPalApiError status 0, which app retries treat as a clean failure and
   * mint a new PayPal-Request-Id.
   */
  private createMalformedResponseError(
    message: string,
    rawResponse: unknown,
    options?: { afterProviderSubmit?: boolean },
  ): PayPalApiError | NetworkError {
    if (options?.afterProviderSubmit === true) {
      return new NetworkError(message, rawResponse, {
        afterProviderSubmit: true,
      });
    }
    return new PayPalApiError(message, rawResponse, 0);
  }

  private async performFetch(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = this.paypalConfig.timeoutMs ?? 30_000;
    const { signal: timeoutSignal, clear } = createTimeoutSignal(timeoutMs);
    const callerSignal = init.signal ?? undefined;
    const signal = combineAbortSignals(callerSignal, timeoutSignal);

    try {
      const response = await this.fetch(url, {
        ...init,
        ...(signal !== undefined ? { signal } : {}),
      });
      // Keep timeout armed until the body is buffered (Stripe shape).
      // Hung body reads must abort; callers then parse a replayable buffer.
      const text = await response.text();
      return new Response(text === "" ? null : text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      throw mapHttpAbortError(error, {
        callerSignal,
        timeoutSignal,
        timeoutMessage: `PayPal API request timed out after ${timeoutMs}ms`,
        networkMessage: "PayPal network request failed",
        callerAbortMessage: "PayPal API request aborted by caller signal",
        afterProviderSubmit:
          isMutatingHttpMethod(
            typeof init.method === "string" ? init.method : undefined,
          ) && !url.includes("/v1/oauth2/token"),
      });
    } finally {
      clear();
    }
  }

  private parseRetryAfterSeconds(headers: Headers): number | undefined {
    const retryAfter = headers.get("retry-after");
    if (!retryAfter) {
      return undefined;
    }

    const numericRetryAfter = Number(retryAfter);
    if (Number.isFinite(numericRetryAfter) && numericRetryAfter >= 0) {
      return numericRetryAfter;
    }

    const retryDate = new Date(retryAfter);
    const retryAfterSeconds = Math.ceil(
      (retryDate.getTime() - this.clock.nowMs()) / 1000,
    );
    return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : undefined;
  }

  /**
   * Parse a PayPal JSON body. Must not swallow empty / invalid JSON as `{}`
   * (S20-PAYPAL-JSON): GET inquiry would then throw status-0 "missing id",
   * and a caller could treat that as a clean miss.
   *
   * Mutating HTTP 2xx empty or non-JSON → {@link NetworkError}
   * `afterProviderSubmit` (indeterminate; fence stays unknown).
   * GET / non-mutating empty or non-JSON → {@link GatewayApiError}.
   * Mutating non-2xx empty or non-JSON keeps the HTTP status so 4xx HTML
   * still maps through {@link PayPalApiError} (e.g. InvalidRequestError).
   */
  private async parseJsonResponse<T>(
    response: Response,
    options?: { afterProviderSubmit?: boolean },
  ): Promise<T> {
    const text = await response.text();
    const trimmed = text.trim();
    const failClosed = (detail: string, cause?: unknown): never => {
      const raw = {
        status: response.status,
        body: text.slice(0, 200),
        ...(cause !== undefined ? { cause } : {}),
      };
      if (options?.afterProviderSubmit === true && response.ok) {
        throw this.createMalformedResponseError(detail, raw, {
          afterProviderSubmit: true,
        });
      }
      if (response.ok) {
        throw this.createMalformedResponseError(detail, raw);
      }
      throw new PayPalApiError(
        detail,
        raw,
        response.status,
        this.parseRetryAfterSeconds(response.headers),
      );
    };

    if (!trimmed) {
      return failClosed("Invalid PayPal response: empty body");
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch (error) {
      return failClosed("Invalid PayPal response: invalid JSON", error);
    }
  }

  private createJsonHeaders(
    token: string,
    requestId: string,
    prefer?: "return=minimal" | "return=representation",
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      // requestId is always a non-empty PayPal-Request-Id: caller key, or
      // createPayment's ephemeral UUID. require-caller mutations throw first.
      "PayPal-Request-Id": requestId,
    };

    if (prefer) {
      headers.Prefer = prefer;
    }

    return headers;
  }

  /**
   * Resolve PayPal-Request-Id (Stripe Idempotency-Key parity).
   * Empty / whitespace is omitted — `"" ?? uuid` would keep "" and skip the header.
   *
   * S19-EPHEMERAL-KEY: capture / refund / void / authorize **require** a caller
   * `idempotencyKey`. createPayment may mint an ephemeral UUID for in-process
   * `withRetry` only (warns).
   */
  private getRequestId(
    idempotencyKey: string | undefined,
    maxLength: number,
    mode: {
      operation: string;
      policy: "require-caller" | "ephemeral-ok";
    },
  ): string {
    const trimmed = idempotencyKey?.trim();
    if (trimmed) {
      if (trimmed.length > maxLength) {
        throw new InvalidRequestError(
          `PayPal idempotencyKey must be ${maxLength} characters or fewer for this operation`,
        );
      }
      return trimmed;
    }
    if (mode.policy === "require-caller") {
      throw new InvalidRequestError(
        `PayPal ${mode.operation} requires idempotencyKey so crash retries do not duplicate the mutation`,
        [{ path: ["idempotencyKey"] }],
      );
    }
    this.logger.warn(
      `[PayPal] ${mode.operation} omitted idempotencyKey; minted an ephemeral PayPal-Request-Id for in-process withRetry only. Crash retries mint a new key and can double-mutate.`,
    );
    return this.runtime.randomUUID();
  }

  /**
   * Optional `webhookMaxAgeMs` on {@link PayPalConfig} clamps far-future
   * rejection. Soft path always allows aged transmissions to reach PayPal verify.
   */
  private getWebhookMaxAgeMs(): number {
    const configured = this.paypalConfig.webhookMaxAgeMs;
    if (
      typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured > 0
    ) {
      return configured;
    }
    return PAYPAL_WEBHOOK_MAX_AGE_MS;
  }

  private static isValidWebhookId(webhookId: string): boolean {
    return webhookId.length > 0 &&
      webhookId.length <= PAYPAL_WEBHOOK_ID_MAX_LENGTH &&
      PAYPAL_WEBHOOK_ID_PATTERN.test(webhookId);
  }

  private isValidWebhookHeaders(fields: {
    authAlgo: string;
    certUrl: string;
    transmissionId: string;
    transmissionSig: string;
    transmissionTime: string;
  }): boolean {
    if (
      fields.authAlgo.length > PAYPAL_WEBHOOK_HEADER_LIMITS.authAlgo ||
      fields.certUrl.length > PAYPAL_WEBHOOK_HEADER_LIMITS.certUrl ||
      fields.transmissionId.length > PAYPAL_WEBHOOK_HEADER_LIMITS.transmissionId ||
      fields.transmissionSig.length > PAYPAL_WEBHOOK_HEADER_LIMITS.transmissionSig ||
      fields.transmissionTime.length > PAYPAL_WEBHOOK_HEADER_LIMITS.transmissionTime
    ) {
      this.logger.warn(
        "[PayPal] Webhook header rejected: value exceeds length limits",
      );
      return false;
    }

    if (!/^[A-Za-z0-9]+$/.test(fields.authAlgo)) {
      this.logger.warn(
        "[PayPal] Webhook header rejected: invalid auth_algo format",
      );
      return false;
    }

    if (!this.isAllowedPayPalCertUrl(fields.certUrl)) {
      this.logger.warn(
        "[PayPal] Webhook header rejected: cert_url is not an allowed PayPal HTTPS host",
      );
      return false;
    }

    const transmissionMs = new Date(fields.transmissionTime).getTime();
    if (!Number.isFinite(transmissionMs)) {
      this.logger.warn(
        "[PayPal] Webhook header rejected: transmission_time is unparseable",
      );
      return false;
    }

    const ageMs = this.clock.nowMs() - transmissionMs;
    const maxAgeMs = this.getWebhookMaxAgeMs();

    // Soft path: aged transmissions still proceed to PayPal signature verify so
    // post-outage / long retries are not dropped. Merchants must dedupe event.id.
    if (ageMs > PAYPAL_WEBHOOK_WARN_AGE_MS) {
      this.logger.warn(
        `[PayPal] Webhook transmission_time is aged (ageMs=${ageMs}); accepting for PayPal verify — dedupe by event.id required`,
      );
    }

    // Reject far-future timestamps (clock skew / malformed clocks).
    if (ageMs < -maxAgeMs) {
      this.logger.warn(
        "[PayPal] Webhook header rejected: transmission_time is too far in the future",
      );
      return false;
    }

    return true;
  }

  /**
   * Allow only HTTPS certificate URLs hosted on PayPal domains
   * (e.g. api.paypal.com, api-m.paypal.com, *.sandbox.paypal.com).
   */
  private isAllowedPayPalCertUrl(certUrl: string): boolean {
    try {
      const url = new URL(certUrl);
      if (url.protocol !== "https:") {
        return false;
      }

      const host = url.hostname.toLowerCase();
      return (
        host === "api.paypal.com" ||
        host === "api-m.paypal.com" ||
        host === "api.sandbox.paypal.com" ||
        host === "api-m.sandbox.paypal.com" ||
        host.endsWith(".paypal.com")
      );
    } catch {
      return false;
    }
  }

  /**
   * Build the verify-webhook-signature POST body.
   *
   * For raw string/Buffer/Uint8Array payloads, embeds the original JSON text as
   * `webhook_event` without parse→stringify (which can break signatures).
   * For already-parsed objects, falls back to JSON.stringify and warns.
   *
   * Returns undefined when the payload cannot be used as a JSON object event.
   */
  private buildWebhookVerifyBody(fields: {
    authAlgo: string;
    certUrl: string;
    transmissionId: string;
    transmissionSig: string;
    transmissionTime: string;
    webhookId: string;
    payload: unknown;
  }): string | undefined {
    const rawJsonText = this.extractRawWebhookJsonText(fields.payload);
    if (rawJsonText !== undefined) {
      // Trim a copy only for empty/JSON-object validation; embed original text
      // (including trailing whitespace/newlines) so signature bytes match.
      const trimmedForValidation = rawJsonText.trim();
      if (!this.isValidRawWebhookEventJson(trimmedForValidation)) {
        return undefined;
      }
      // Embed original JSON bytes for webhook_event — do not re-serialize or trim.
      return (
        '{"auth_algo":' + JSON.stringify(fields.authAlgo) +
        ',"cert_url":' + JSON.stringify(fields.certUrl) +
        ',"transmission_id":' + JSON.stringify(fields.transmissionId) +
        ',"transmission_sig":' + JSON.stringify(fields.transmissionSig) +
        ',"transmission_time":' + JSON.stringify(fields.transmissionTime) +
        ',"webhook_id":' + JSON.stringify(fields.webhookId) +
        ',"webhook_event":' + rawJsonText +
        "}"
      );
    }

    if (
      !fields.payload ||
      typeof fields.payload !== "object" ||
      Array.isArray(fields.payload)
    ) {
      return undefined;
    }

    this.logger.warn(
      "[PayPal] Webhook verification with a parsed object re-serializes webhook_event; " +
        "signature verification may fail due to key reordering/whitespace. " +
        "Prefer the raw request body (string/Buffer/Uint8Array).",
    );

    const verifyRequest: PayPalWebhookVerifyRequest = {
      auth_algo: fields.authAlgo,
      cert_url: fields.certUrl,
      transmission_id: fields.transmissionId,
      transmission_sig: fields.transmissionSig,
      transmission_time: fields.transmissionTime,
      webhook_id: fields.webhookId,
      webhook_event: fields.payload,
    };
    return JSON.stringify(verifyRequest);
  }

  /**
   * Extract UTF-8 JSON text from raw webhook body shapes.
   * Returns undefined for already-parsed objects / unsupported types.
   */
  private extractRawWebhookJsonText(payload: unknown): string | undefined {
    if (typeof payload === "string") {
      return payload;
    }

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(payload)) {
      return payload.toString("utf8");
    }

    if (payload instanceof Uint8Array) {
      return new TextDecoder().decode(payload);
    }

    return undefined;
  }

  /**
   * True when text is a JSON object (starts with `{`) and JSON.parse succeeds.
   */
  private isValidRawWebhookEventJson(text: string): boolean {
    if (!text.startsWith("{")) {
      return false;
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }

  /**
   * Accept object, JSON string, Buffer, or Uint8Array payloads for parse paths.
   */
  private coerceWebhookPayload(payload: unknown): unknown {
    if (typeof payload === "string") {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        throw new GatewayApiError(
          "Invalid webhook payload: not valid JSON",
          "paypal",
          payload,
        );
      }
    }

    if (typeof Buffer !== "undefined" && Buffer.isBuffer(payload)) {
      try {
        return JSON.parse(payload.toString("utf8")) as unknown;
      } catch {
        throw new GatewayApiError(
          "Invalid webhook payload: not valid JSON",
          "paypal",
          payload,
        );
      }
    }

    if (payload instanceof Uint8Array) {
      try {
        return JSON.parse(new TextDecoder().decode(payload)) as unknown;
      } catch {
        throw new GatewayApiError(
          "Invalid webhook payload: not valid JSON",
          "paypal",
          payload,
        );
      }
    }

    return payload;
  }

  /**
   * Prefer the most recent capture when PayPal returns multiple on an order.
   * Uses `update_time` / `create_time` when present; otherwise the last array element.
   */
  private preferLastCapture<T>(
    captures:
      | Array<T & { create_time?: string; update_time?: string }>
      | undefined,
  ): (T & { create_time?: string; update_time?: string }) | undefined {
    if (!captures || captures.length === 0) {
      return undefined;
    }

    // noUncheckedIndexedAccess: index access is T | undefined; length check
    // guarantees at least one element, so fall back only for the type system.
    let latest = captures[captures.length - 1];
    if (latest === undefined) {
      return undefined;
    }
    let latestTime = this.captureTimestampMs(latest);

    for (let i = captures.length - 2; i >= 0; i--) {
      const candidate = captures[i];
      if (candidate === undefined) {
        continue;
      }
      const candidateTime = this.captureTimestampMs(candidate);
      // Strict greater-than keeps later array index on ties / missing timestamps.
      if (
        Number.isFinite(candidateTime) &&
        (!Number.isFinite(latestTime) || candidateTime > latestTime)
      ) {
        latest = candidate;
        latestTime = candidateTime;
      }
    }

    return latest;
  }

  private captureTimestampMs(
    capture: { create_time?: string; update_time?: string },
  ): number {
    const raw = capture.update_time ?? capture.create_time;
    if (!raw) {
      return Number.NaN;
    }
    return new Date(raw).getTime();
  }

  private normalizeHeaders(
    headers?: Record<string, string>,
  ): Record<string, string> {
    const normalized: Record<string, string> = {};

    if (!headers) {
      return normalized;
    }

    for (const [key, value] of Object.entries(headers)) {
      normalized[key.toLowerCase()] = value;
    }

    return normalized;
  }

  private assertOrderResponse(
    data: PayPalOrderResponse,
    operation: string,
    options?: { afterProviderSubmit?: boolean },
  ): asserts data is PayPalOrderResponse {
    if (typeof data.id !== "string" || data.id.length === 0) {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing id`,
        data,
        options,
      );
    }

    if (typeof data.status !== "string" || data.status.length === 0) {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing status`,
        data,
        options,
      );
    }
  }

  private assertRefundResponse(
    data: PayPalRefundResponse,
    options?: { afterProviderSubmit?: boolean },
  ): asserts data is PayPalRefundResponse {
    if (typeof data.id !== "string" || data.id.length === 0) {
      throw this.createMalformedResponseError(
        "Invalid PayPal refund response: missing id",
        data,
        options,
      );
    }

    if (typeof data.status !== "string" || data.status.length === 0) {
      throw this.createMalformedResponseError(
        "Invalid PayPal refund response: missing status",
        data,
        options,
      );
    }
  }

  private assertPaymentResource(
    resource: unknown,
    operation: string,
    options?: { afterProviderSubmit?: boolean },
  ): asserts resource is PayPalPaymentResource {
    if (!resource || typeof resource !== "object") {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing payment resource`,
        resource,
        options,
      );
    }

    const paymentResource = resource as Partial<PayPalPaymentResource>;
    if (typeof paymentResource.id !== "string" || paymentResource.id.length === 0) {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing payment resource id`,
        resource,
        options,
      );
    }

    if (typeof paymentResource.status !== "string" || paymentResource.status.length === 0) {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing payment resource status`,
        resource,
        options,
      );
    }

    this.parseAmount(paymentResource.amount, operation, options);
  }

  private normalizeCurrencyCode(currency: string): string {
    return currency.toUpperCase();
  }

  private getCustomId(metadata?: Record<string, unknown>): string | undefined {
    const customId = metadata?.paymentId;

    if (customId === undefined) {
      return undefined;
    }

    if (typeof customId !== "string" || customId.length === 0) {
      throw new InvalidRequestError("PayPal metadata.paymentId must be a non-empty string");
    }

    if (customId.length > PAYPAL_CUSTOM_ID_MAX_LENGTH) {
      throw new InvalidRequestError(
        `PayPal metadata.paymentId must be ${PAYPAL_CUSTOM_ID_MAX_LENGTH} characters or fewer`,
      );
    }

    return customId;
  }

  /**
   * Enforce PayPal field max lengths client-side before the API call.
   */
  private assertMaxLength(
    value: string | undefined,
    maxLength: number,
    label: string,
  ): void {
    if (value === undefined) {
      return;
    }

    if (value.length > maxLength) {
      throw new InvalidRequestError(
        `${label} must be ${maxLength} characters or fewer (got ${value.length})`,
      );
    }
  }

  /**
   * PayPal amount scale: ISO 4217 minor units, with PayPal zero-decimal
   * overrides (HUF/JPY/TWD). Do not force 2dp for GCC 3-decimal currencies
   * (KWD/BHD/OMR/…) — that rejects or mis-parses real PayPal payloads (PAYPAL-3).
   */
  private getCurrencyScale(currency: string): number {
    const code = this.normalizeCurrencyCode(currency);
    if (PAYPAL_ZERO_DECIMAL_CURRENCIES.has(code)) {
      return 0;
    }
    return getCurrencyExponent(code);
  }

  private formatAmount(
    amount: AmountInput,
    currency: string,
    options?: { allowZero?: boolean },
  ): string {
    const normalizedCurrency = this.normalizeCurrencyCode(currency);
    // PayPal zero-decimal set (HUF/JPY/TWD) is the exponent source — not ISO.
    const scale = this.getCurrencyScale(normalizedCurrency);
    const allowZero = options?.allowZero === true;
    const parseOpts = {
      rounding: "reject" as const,
      exponent: scale,
      allowZero,
      allowNegative: false,
    };

    try {
      const normalized = normalizeAmountInput(amount as unknown as Money, currency, parseOpts);
      // Convert through bigint minor units, then format canonical major string
      // (exactly `scale` fractional digits, or none when scale is 0).
      const minor = sharedToMinorUnits(normalized, parseOpts);
      return sharedFromMinorUnits(minor, normalizedCurrency, {
        ...parseOpts,
        allowZero: true,
      }).amount;
    } catch (error) {
      if (error instanceof MoneyAmountError && error.kind === "excess_precision") {
        throw new InvalidRequestError(
          `PayPal ${normalizedCurrency} amounts support at most ${scale} decimal place${scale === 1 ? "" : "s"}`,
        );
      }
      throw error;
    }
  }

  /**
   * Parse PayPal Money object into major units + ISO currency (PAYPAL-1).
   * Always returns currency together with the major amount.
   */
  private parsePayPalMoney(
    amount: unknown,
    operation: string,
    options?: { afterProviderSubmit?: boolean },
  ): Money {
    if (!amount || typeof amount !== "object") {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing amount`,
        amount,
        options,
      );
    }

    const payload = amount as Partial<PayPalMoney>;
    if (typeof payload.currency_code !== "string" || payload.currency_code.length !== 3) {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing amount currency`,
        amount,
        options,
      );
    }

    if (typeof payload.value !== "string" || payload.value.length === 0) {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: missing amount value`,
        amount,
        options,
      );
    }

    // Parse provider decimal strings via shared money helpers — no Number()/parseFloat.
    try {
      const code = this.normalizeCurrencyCode(payload.currency_code);
      const scale = this.getCurrencyScale(code);
      const parsed = money(payload.value, code, {
        rounding: "reject",
        exponent: scale,
        allowZero: true,
        allowNegative: true,
      });
      return parsed;
    } catch {
      throw this.createMalformedResponseError(
        `Invalid PayPal ${operation} response: invalid amount value`,
        amount,
        options,
      );
    }
  }

  /** Major-unit only convenience; prefer {@link parsePayPalMoney} when currency is needed. */
  private parseAmount(
    amount: unknown,
    operation: string,
    options?: { afterProviderSubmit?: boolean },
  ): Money {
    return this.parsePayPalMoney(amount, operation, options);
  }

  /**
   * Try parse optional PayPal Money without throwing (for breakdown fields).
   */
  private tryParsePayPalMoney(
    amount: unknown,
    operation: string,
  ): Money | undefined {
    try {
      return this.parsePayPalMoney(amount, operation);
    } catch {
      return undefined;
    }
  }

  /**
   * Net still-held major units on a capture resource after refunds/reversals.
   * Never treat original face as held when status is refunded / partially_refunded /
   * reversed without a proven remaining balance.
   *
   * Subtraction is bigint minor units (same path as {@link sumSuccessfulCaptureAmounts});
   * never major-unit JS float subtract — `remaining === 0` is exact on minor bigint.
   */
  private captureRemainingHeldAmount(
    data: PayPalPaymentResource,
    status: GatewayPaymentStatus,
    operation: string,
  ): Money | undefined {
    // Full chargeback/reversal: no still-held funds (do not publish face).
    if (status === "reversed") {
      return undefined;
    }

    if (status !== "partially_refunded" && status !== "refunded") {
      return this.tryParsePayPalMoney(data.amount, operation);
    }

    const faceMoney = data.amount;
    if (
      !faceMoney ||
      typeof faceMoney.currency_code !== "string" ||
      typeof faceMoney.value !== "string" ||
      faceMoney.value.length === 0
    ) {
      return undefined;
    }

    const totalRefundedMoney =
      data.seller_receivable_breakdown?.total_refunded_amount;
    if (
      !totalRefundedMoney ||
      typeof totalRefundedMoney.currency_code !== "string" ||
      typeof totalRefundedMoney.value !== "string" ||
      totalRefundedMoney.value.length === 0
    ) {
      // No cumulative refund breakdown: fail-closed — omit face as still-held.
      return undefined;
    }

    try {
      const faceCode = this.normalizeCurrencyCode(faceMoney.currency_code);
      const refundCode = this.normalizeCurrencyCode(
        totalRefundedMoney.currency_code,
      );
      if (faceCode !== refundCode) {
        return undefined;
      }

      const scale = this.getCurrencyScale(faceCode);
      const parseOpts = {
        rounding: "reject" as const,
        exponent: scale,
        allowZero: true,
        allowNegative: false,
      };

      const faceParsed = money(faceMoney.value, faceCode, parseOpts);
      const faceMinor = sharedToMinorUnits(faceParsed, parseOpts);
      const refundParsed = money(totalRefundedMoney.value, refundCode, parseOpts);
      const refundMinor = sharedToMinorUnits(refundParsed, parseOpts);

      const remainingMinor = faceMinor - refundMinor;
      if (remainingMinor < 0n) {
        return undefined;
      }
      // Fully refunded (status) or exact zero remaining on minor bigint → no held.
      if (status === "refunded" || remainingMinor === 0n) {
        return undefined;
      }

      return sharedFromMinorUnits(remainingMinor, faceCode, parseOpts);
    } catch {
      this.logger.warn(
        `[PayPal] Failed to compute remaining held amount during ${operation}; omitting`,
      );
      return undefined;
    }
  }

  private extractWebhookAmount(raw: PayPalWebhookPayload): {
    currency_code: string;
    value: string;
  } | undefined {
    // Multi-capture order webhooks: aggregate still-held capture amounts so
    // event.amount matches getPayment (not last-slice only; excludes REFUNDED).
    const orderCaptures = this.extractWebhookOrderCaptures(raw);
    if (orderCaptures && orderCaptures.length > 0) {
      const aggregated = this.sumSuccessfulCaptureAmounts(
        orderCaptures,
        "webhook",
      );
      const currencyCode =
        aggregated?.currency ??
        orderCaptures.find((c) => c.amount?.currency_code)?.amount
          ?.currency_code;
      if (aggregated !== undefined && currencyCode) {
        try {
          return {
            currency_code: currencyCode,
            value: this.formatAmount(aggregated, currencyCode),
          };
        } catch {
          // Incomplete aggregate format — omit amount rather than last-slice face.
          return undefined;
        }
      }
      // Captures present but none still held: do not fall back to REFUNDED face
      // amounts or order total. Fully refunded/reversed → 0 remaining (PAYPAL-5:
      // allowZero so formatAmount(0) is live, not dead catch→undefined).
      // PARTIALLY_REFUNDED without net → omit (fail-closed incomplete snapshot).
      const refundAgg = this.aggregateCaptureRefundStatus(orderCaptures);
      if (
        (refundAgg === "refunded" || refundAgg === "reversed") &&
        currencyCode
      ) {
        try {
          return {
            currency_code: currencyCode,
            value: this.formatAmount(money("0", currencyCode, { allowZero: true }), currencyCode, { allowZero: true }),
          };
        } catch {
          return undefined;
        }
      }
      return undefined;
    }

    // Single-resource capture after refund/reversal: never publish original face
    // as still-held (audit PAYPAL-1 / PAYPAL-2). Align with getPayment remaining-held.
    // Refund *resources* (PAYMENT.REFUND.*) keep their own op amount below.
    const singleCaptureHeld = this.extractSingleCaptureWebhookHeldAmount(raw);
    if (singleCaptureHeld !== undefined) {
      return singleCaptureHeld === null ? undefined : singleCaptureHeld;
    }

    return raw.resource.amount ??
      raw.resource.purchase_units?.[0]?.amount;
  }

  /**
   * Single-resource CAPTURE.REFUNDED / CAPTURE.REVERSED / capture status
   * refunded|partially_refunded|reversed: publish remaining held (or 0 / omit),
   * never original capture face.
   *
   * @returns money object when rewritten; `null` when amount must be omitted;
   *   `undefined` when this path does not apply (fall through to face amount).
   */
  private extractSingleCaptureWebhookHeldAmount(
    raw: PayPalWebhookPayload,
  ):
    | { currency_code: string; value: string }
    | null
    | undefined {
    // PAYMENT.REFUND.* resources publish this-op refund amount (not remaining held).
    if (raw.event_type.startsWith("PAYMENT.REFUND.")) {
      return undefined;
    }
    // CAPTURE.REFUNDED + refund resource: this-op amount is not capture settlement.
    // Remaining-held rewrite needs a capture face; omit rather than publish refund face.
    if (
      raw.event_type === "PAYMENT.CAPTURE.REFUNDED" &&
      raw.resource_type === "refund"
    ) {
      return null;
    }
    if (raw.resource_type === "refund") {
      return undefined;
    }

    const isCaptureEvent =
      raw.resource_type === "capture" ||
      raw.event_type === "PAYMENT.CAPTURE.REFUNDED" ||
      raw.event_type === "PAYMENT.CAPTURE.REVERSED";
    if (!isCaptureEvent) {
      return undefined;
    }

    const faceMoney =
      raw.resource.amount ?? raw.resource.purchase_units?.[0]?.amount;
    if (!faceMoney) {
      return undefined;
    }

    const resourceMapped = raw.resource.status
      ? this.mapResourceStatus(raw.resource.status)
      : undefined;
    const isCaptureRefundOrReverseEvent =
      raw.event_type === "PAYMENT.CAPTURE.REFUNDED" ||
      raw.event_type === "PAYMENT.CAPTURE.REVERSED";
    // CAPTURE.REFUNDED / REVERSED must rewrite remaining-held even when the
    // resource is this-op COMPLETED / order-shaped (maps to paid). Unproven
    // completeness → fail-closed partially_refunded / reversed (omit face).
    const effectiveStatus: GatewayPaymentStatus | undefined = isCaptureRefundOrReverseEvent
      ? resourceMapped === "partially_refunded" ||
        resourceMapped === "refunded" ||
        resourceMapped === "reversed"
        ? resourceMapped
        : raw.event_type === "PAYMENT.CAPTURE.REVERSED"
          ? "reversed"
          : "partially_refunded"
      : resourceMapped;

    if (
      effectiveStatus !== "partially_refunded" &&
      effectiveStatus !== "refunded" &&
      effectiveStatus !== "reversed"
    ) {
      return undefined;
    }

    const resourceExtra = raw.resource as {
      seller_receivable_breakdown?: PayPalPaymentResource["seller_receivable_breakdown"];
    };
    // Prefer provider status string; fall back to PayPal API labels (not domain
    // PaymentStatus) when the event type implies refund/reverse without status.
    const apiStatus =
      raw.resource.status ??
      (effectiveStatus === "reversed"
        ? "REVERSED"
        : effectiveStatus === "partially_refunded"
          ? "PARTIALLY_REFUNDED"
          : "REFUNDED");
    const resourceLike: PayPalPaymentResource = {
      id: raw.resource.id ?? "webhook-capture",
      status: apiStatus,
      amount: faceMoney,
      ...(resourceExtra.seller_receivable_breakdown !== undefined
        ? {
            seller_receivable_breakdown:
              resourceExtra.seller_receivable_breakdown,
          }
        : {}),
    };

    const held = this.captureRemainingHeldAmount(
      resourceLike,
      effectiveStatus,
      "webhook",
    );
    if (held) {
      // formatAmount throws on bad currency/scale — omit amount (fail-closed).
      try {
        return {
          currency_code: held.currency,
          value: this.formatAmount(held, held.currency, {
            allowZero: true,
          }),
        };
      } catch {
        return null;
      }
    }

    // Fully refunded/reversed with known currency → 0 remaining (multi-capture parity).
    if (
      (effectiveStatus === "refunded" || effectiveStatus === "reversed") &&
      faceMoney.currency_code
    ) {
      try {
        return {
          currency_code: faceMoney.currency_code,
          value: this.formatAmount(money("0", faceMoney.currency_code, { allowZero: true }), faceMoney.currency_code, {
            allowZero: true,
          }),
        };
      } catch {
        return null;
      }
    }

    // PARTIALLY_REFUNDED without proven net remaining → omit (fail-closed).
    return null;
  }

  /**
   * Nested order captures from CHECKOUT.ORDER.* webhooks (includes optional
   * final_capture when PayPal embeds it).
   */
  private extractWebhookOrderCaptures(
    raw: PayPalWebhookPayload,
  ): PayPalEmbeddedCapture[] | undefined {
    const payments = raw.resource.purchase_units?.[0]?.payments as
      | {
          captures?: Array<
            PayPalEmbeddedCapture & {
              create_time?: string;
              update_time?: string;
            }
          >;
        }
      | undefined;
    const captures = payments?.captures;
    if (!captures || captures.length === 0) {
      return undefined;
    }
    return captures;
  }

  private extractWebhookOrderAuthorization(
    raw: PayPalWebhookPayload,
  ): PayPalEmbeddedAuthorization | undefined {
    const payments = raw.resource.purchase_units?.[0]?.payments as
      | { authorizations?: PayPalEmbeddedAuthorization[] }
      | undefined;
    return payments?.authorizations?.[0];
  }

  private extractWebhookPaymentId(raw: PayPalWebhookPayload): string | undefined {
    if (raw.resource_type === "refund" || raw.event_type.startsWith("PAYMENT.REFUND.")) {
      return raw.resource.purchase_units?.[0]?.custom_id ??
        raw.resource.purchase_units?.[0]?.reference_id;
    }

    return raw.resource.custom_id ??
      raw.resource.purchase_units?.[0]?.custom_id ??
      raw.resource.purchase_units?.[0]?.reference_id;
  }

  private webhookEventRequiresAmount(eventType: string): boolean {
    return !PAYPAL_WEBHOOK_EVENTS_WITHOUT_AMOUNT.has(eventType);
  }

  /**
   * Resolve a capture ID from a webhook resource when present.
   * Prefers the last capture when multiple are listed.
   *
   * For AUTHORIZATION.* events without a linked capture id, returns undefined —
   * callers fall back to resource.id (authorization id). That id is **not**
   * refundable; refunds require a capture ID.
   */
  private extractWebhookCaptureId(raw: PayPalWebhookPayload): string | undefined {
    const lastCapture = this.preferLastCapture(
      raw.resource.purchase_units?.[0]?.payments?.captures,
    );
    return raw.resource.supplementary_data?.related_ids?.capture_id ??
      lastCapture?.id ??
      this.extractLinkedCaptureId(raw.resource.links);
  }

  private extractLinkedCaptureId(
    links?: Array<{ href: string; rel: string }>,
  ): string | undefined {
    const upLink = links?.find((link) => link.rel === "up");
    if (!upLink) {
      return undefined;
    }

    try {
      const url = new URL(upLink.href);
      const match = url.pathname.match(/\/v2\/payments\/captures\/([^/]+)$/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  /**
   * Map PayPal order status to unified PaymentStatus
   */
  private mapStatus(paypalStatus: string): GatewayPaymentStatus {
    const statusMap: Record<string, GatewayPaymentStatus> = {
      CREATED: "pending",
      SAVED: "pending",
      APPROVED: "approved",
      VOIDED: "cancelled",
      COMPLETED: "paid",
      PAYER_ACTION_REQUIRED: "pending",
    };

    const mapped = statusMap[paypalStatus];
    if (!mapped) {
      this.logger.warn(`[PayPal] Unmapped order status: ${paypalStatus}`);
      return "pending";
    }
    return mapped;
  }

  /**
   * Map PayPal resource status to unified PaymentStatus.
   * Unknown statuses that look terminal map to `failed` (fail-closed); otherwise `pending`.
   */
  private mapResourceStatus(status: string): GatewayPaymentStatus {
    const statusMap: Record<string, GatewayPaymentStatus> = {
      CREATED: "authorized",
      APPROVED: "authorized",
      COMPLETED: "paid",
      CAPTURED: "paid",
      PARTIALLY_CAPTURED: "partially_captured",
      DENIED: "failed",
      DECLINED: "failed",
      PARTIALLY_REFUNDED: "partially_refunded",
      PENDING: "pending",
      REFUNDED: "refunded",
      REVERSED: "reversed",
      FAILED: "failed",
      VOIDED: "cancelled",
      EXPIRED: "cancelled",
    };

    const mapped = statusMap[status];
    if (!mapped) {
      const looksTerminal = PAYPAL_TERMINAL_RESOURCE_STATUS_PATTERN.test(status);
      const fallback: GatewayPaymentStatus = looksTerminal ? "failed" : "pending";
      this.logger.warn(
        `[PayPal] Unmapped resource status: ${status} (mapped to ${fallback})`,
      );
      return fallback;
    }
    return mapped;
  }

  private mapRefundStatus(status: string): PayPalRefundStatus {
    const statusMap: Record<string, PayPalRefundStatus> = {
      COMPLETED: "completed",
      PENDING: "pending",
      FAILED: "failed",
      CANCELLED: "failed",
    };

    const mapped = statusMap[status];
    if (!mapped) {
      // HTTP 200 accepted the refund POST. Unknown provider status must not
      // look failed — retrying with a new PayPal-Request-Id can refund twice
      // (S20-PAYPAL-REFUND-UNKNOWN). Pending keeps the fence / waits on GET.
      this.logger.warn(
        `[PayPal] Unmapped refund status: ${status} (mapped to pending)`,
      );
      return "pending";
    }
    return mapped;
  }

  private mapWebhookStatus(
    eventType: string,
    resourceStatus?: string,
    options?: {
      hasCapture?: boolean;
      hasAuthorization?: boolean;
      finalCapture?: boolean;
      disputeOutcome?: string;
    },
  ): GatewayPaymentStatus | undefined {
    if (isPayPalCustomerDisputeEventType(eventType)) {
      return paypalDisputeEnvelopeStatus(
        eventType,
        resourceStatus,
        options?.disputeOutcome,
      ) as GatewayPaymentStatus;
    }

    if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
      const resourceMappedStatus = resourceStatus
        ? this.mapResourceStatus(resourceStatus)
        : undefined;

      // Capture-resource completeness only when PayPal says REFUNDED / PARTIALLY_REFUNDED.
      if (
        resourceMappedStatus === "partially_refunded" ||
        resourceMappedStatus === "refunded"
      ) {
        return resourceMappedStatus as GatewayPaymentStatus;
      }

      // resource_type=refund + COMPLETED maps to paid via mapResourceStatus —
      // that is this-op refund, not capture settlement. Missing/unknown status
      // is equally unproven. Fail-closed: never default to full refunded.
      return "partially_refunded";
    }

    // Order completed without a capture (e.g. AUTHORIZE-intent) must not look paid.
    // Prefer PAYMENT.CAPTURE.COMPLETED as the fulfillment signal (when final).
    // PAYPAL-2: auth-only → authorized (align getPayment). PAYPAL-1: bare → processing.
    if (eventType === "CHECKOUT.ORDER.COMPLETED") {
      if (options?.hasCapture) {
        return "paid";
      }
      if (options?.hasAuthorization) {
        return "authorized";
      }
      return "processing";
    }

    // Non-final capture: PayPal API default for final_capture is false.
    // Missing/undefined is not paid / isPaidOutcome.
    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      if (options?.finalCapture === true) {
        return "paid";
      }
      return "partially_captured";
    }

    const eventStatusMap: Record<string, GatewayPaymentStatus> = {
      "CHECKOUT.ORDER.APPROVED": "approved",
      "CHECKOUT.PAYMENT-APPROVAL.REVERSED": "cancelled",
      "PAYMENT.AUTHORIZATION.CREATED": "authorized",
      "PAYMENT.AUTHORIZATION.CAPTURED": "paid",
      "PAYMENT.AUTHORIZATION.PARTIALLY_CAPTURED": "partially_captured",
      "PAYMENT.AUTHORIZATION.VOIDED": "cancelled",
      "PAYMENT.CAPTURE.DENIED": "failed",
      "PAYMENT.CAPTURE.DECLINED": "failed",
      "PAYMENT.CAPTURE.PENDING": "pending",
      "PAYMENT.CAPTURE.REVERSED": "reversed",
      "PAYMENT.REFUND.PENDING": "refund_pending",
      // PAYPAL-2: refund resource COMPLETED proves this refund op finished, not
      // that the capture is fully refunded. Prefer incomplete `refund_completed`
      // (dual-write demoted to refund.pending) over full `refunded` overstatement.
      // Aggregate completeness comes from CAPTURE.REFUNDED capture status or getPayment.
      "PAYMENT.REFUND.COMPLETED": "refund_completed",
      "PAYMENT.REFUND.FAILED": "refund_failed",
    };

    return eventStatusMap[eventType] ?? undefined;
  }

  /**
   * Resolve getPayment status from order + captures + authorization.
   *
   * Authorization `PARTIALLY_CAPTURED` wins over any capture `COMPLETED` so
   * polling after a non-final partial does not report paid / isPaidOutcome.
   * Multi-capture totals vs order/auth amount demote COMPLETED → partially_captured
   * when captured sum is strictly less than the authorized/order total.
   *
   * PAYPAL-2: sibling captures matter — latest COMPLETED must not force `paid`
   * when another capture is REFUNDED / PARTIALLY_REFUNDED.
   */
  private mapPaymentResultStatus(
    order: PayPalOrderResponse,
    capture?: { status: string; final_capture?: boolean },
    authorization?: { status: string; amount?: { currency_code: string; value: string } },
    captures?: Array<PayPalEmbeddedCapture>,
  ): GatewayPaymentStatus {
    // Sibling refund/reversal across the capture set wins over preferred-last COMPLETED.
    const siblingRefundStatus = this.aggregateCaptureRefundStatus(captures);
    if (siblingRefundStatus !== undefined) {
      return siblingRefundStatus;
    }

    if (authorization) {
      const authMapped = this.mapResourceStatus(authorization.status);
      // Open partial auth must not be overridden by a COMPLETED capture slice.
      if (
        authMapped === "partially_captured" ||
        authMapped === "cancelled" ||
        authMapped === "failed" ||
        authMapped === "pending"
      ) {
        return authMapped;
      }
      // Fully captured auth — still prefer refund/reversal on capture resources.
      if (authMapped === "paid" && capture) {
        const capMapped = this.mapResourceStatus(capture.status);
        if (
          capMapped === "refunded" ||
          capMapped === "partially_refunded" ||
          capMapped === "reversed"
        ) {
          return capMapped;
        }
        return "paid";
      }
      if (authMapped === "paid") {
        return "paid";
      }
      // Auth still authorized/created with captures present → partial take.
      if (
        authMapped === "authorized" &&
        captures &&
        captures.length > 0
      ) {
        return "partially_captured";
      }
    }

    if (capture) {
      let capMapped = this.mapResourceStatus(capture.status);
      if (capMapped === "paid" && capture.final_capture !== true) {
        capMapped = "partially_captured";
      }
      // Multi-capture: COMPLETED slices that sum to less than order/auth total
      // are not full settlement.
      if (
        capMapped === "paid" &&
        this.isAggregateCapturePartial(order, authorization, captures)
      ) {
        return "partially_captured";
      }
      return capMapped;
    }

    if (authorization) {
      return this.mapResourceStatus(authorization.status);
    }

    // PAYPAL-1: bare order COMPLETED without payments.captures / authorizations
    // must not map to paid / isPaidOutcome. Fail-closed to processing so poll
    // paths cannot fulfill on a partial/missing payments payload.
    const mapped = this.mapStatus(order.status);
    if (mapped === "paid") {
      this.logger.warn(
        "[PayPal] Order COMPLETED without captures or authorizations; refusing paid (processing)",
      );
      return "processing";
    }
    return mapped;
  }

  /**
   * Aggregate refund/reversal status across sibling captures.
   * Returns undefined when no capture is refunded/reversed so callers continue
   * paid / partially_captured mapping.
   *
   * PENDING siblings are open money paths: REFUNDED+PENDING must not report
   * full `refunded` (PAYPAL-3).
   */
  private aggregateCaptureRefundStatus(
    captures: Array<PayPalEmbeddedCapture> | undefined,
  ): GatewayPaymentStatus | undefined {
    if (!captures || captures.length === 0) {
      return undefined;
    }

    let hasRefunded = false;
    let hasPartialRefund = false;
    let hasReversed = false;
    let hasHeld = false; // COMPLETED / non-final still holding funds
    let hasPending = false; // PENDING — may still settle; not full-refund evidence
    let moneyCount = 0;

    for (const capture of captures) {
      const mapped = this.mapResourceStatus(capture.status);
      if (mapped === "pending") {
        hasPending = true;
        continue;
      }
      if (mapped === "failed" || mapped === "cancelled") {
        continue;
      }
      moneyCount += 1;
      if (mapped === "refunded") {
        hasRefunded = true;
      } else if (mapped === "partially_refunded") {
        hasPartialRefund = true;
      } else if (mapped === "reversed") {
        hasReversed = true;
      } else if (mapped === "paid" || mapped === "partially_captured") {
        hasHeld = true;
      }
    }

    if (moneyCount === 0) {
      return undefined;
    }

    // Mix of held/pending + refunded/reversed, or any partial refund → partially_refunded.
    // PENDING siblings block full refunded/reversed (open settlement path).
    if (
      hasPartialRefund ||
      ((hasHeld || hasPending) && (hasRefunded || hasReversed))
    ) {
      return "partially_refunded";
    }

    if (hasRefunded && !hasHeld && !hasPending) {
      return "refunded";
    }

    if (hasReversed && !hasHeld && !hasPending && !hasRefunded) {
      return "reversed";
    }

    return undefined;
  }

  /**
   * Captures that can still be targeted for a refund (held / partially refunded).
   * Fully REFUNDED / REVERSED / failed / pending are not refund targets.
   */
  private listRefundableCaptures(
    captures: Array<PayPalEmbeddedCapture> | undefined,
  ): Array<PayPalEmbeddedCapture> {
    if (!captures || captures.length === 0) {
      return [];
    }
    return captures.filter((capture) => {
      const mapped = this.mapResourceStatus(capture.status);
      return (
        mapped === "paid" ||
        mapped === "partially_refunded" ||
        mapped === "partially_captured"
      );
    });
  }

  /**
   * PAYPAL-1: only surface a captureId when exactly one refundable capture remains.
   * Multi-capture aggregates must not dual-write one latest id as a full-order refund target.
   */
  private selectSingleRefundableCaptureId(
    captures: Array<PayPalEmbeddedCapture> | undefined,
  ): string | undefined {
    const refundable = this.listRefundableCaptures(captures);
    if (refundable.length !== 1) {
      return undefined;
    }
    return refundable[0]?.id;
  }

  /**
   * True when successful capture amounts sum to less than the order/auth total.
   * Missing/unparsable order/auth total (or capture sum) is incomplete — not paid.
   */
  private isAggregateCapturePartial(
    order: PayPalOrderResponse,
    authorization?: { amount?: { currency_code: string; value: string } },
    captures?: Array<PayPalEmbeddedCapture>,
  ): boolean {
    if (!captures || captures.length === 0) {
      return false;
    }
    const capturedSum = this.sumSuccessfulCaptureAmounts(
      captures,
      "get payment aggregate",
    );
    if (capturedSum === undefined) {
      return true;
    }
    const totalMoney =
      authorization?.amount ??
      order.purchase_units?.[0]?.amount ??
      order.amount;
    if (!totalMoney) {
      return true;
    }
    try {
      const total = this.parseAmount(totalMoney, "get payment aggregate");
      const capturedMinor = sharedToMinorUnits(capturedSum as Money, { exponent: this.getCurrencyScale(capturedSum.currency), allowZero: true, allowNegative: false });
      const totalMinor = sharedToMinorUnits(total as Money, { exponent: this.getCurrencyScale((total as Money).currency), allowZero: true, allowNegative: false });
      return capturedMinor < totalMinor;
    } catch {
      return true;
    }
  }

  /**
   * Sum amounts of captures that still hold funds (COMPLETED / non-final partial).
   *
   * Exclude fully REFUNDED face amounts (they are not held).
   * PARTIALLY_REFUNDED face amounts overstate remaining without refund breakdown —
   * fail-closed: omit them from the sum (status is partially_refunded separately).
   * Returns currency together with major amount (PAYPAL-1).
   */
  private sumSuccessfulCaptureAmounts(
    captures: Array<PayPalEmbeddedCapture> | undefined,
    operation: string,
  ): Money | undefined {
    if (!captures || captures.length === 0) {
      return undefined;
    }

    let totalMinor: bigint | undefined;
    let currency: string | undefined;
    let scale: number | undefined;
    let sawPartialRefundWithoutNet = false;

    for (const capture of captures) {
      const mapped = this.mapResourceStatus(capture.status);
      // Only fully held slices contribute. REFUNDED face is not remaining funds.
      // PARTIALLY_REFUNDED lacks net remaining on embedded order captures.
      if (mapped === "partially_refunded") {
        sawPartialRefundWithoutNet = true;
        continue;
      }
      if (mapped !== "paid" && mapped !== "partially_captured") {
        // refunded / pending / failed / voided / reversed do not contribute
        continue;
      }
      if (!capture.amount) {
        continue;
      }
      try {
        const code = this.normalizeCurrencyCode(capture.amount.currency_code);
        const captureScale = this.getCurrencyScale(code);
        const parsed = money(capture.amount.value, code, {
          rounding: "reject",
          exponent: captureScale,
          allowZero: true,
          allowNegative: false,
        });
        const minor = sharedToMinorUnits(parsed, {
          rounding: "reject",
          exponent: captureScale,
          allowZero: true,
          allowNegative: false,
        });
        if (currency === undefined) {
          currency = code;
          scale = captureScale;
          totalMinor = minor;
        } else if (currency !== code) {
          this.logger.warn(
            `[PayPal] Mixed capture currencies on order (${currency} vs ${code}); skipping amount aggregate`,
          );
          return undefined;
        } else {
          totalMinor = (totalMinor ?? 0n) + minor;
        }
      } catch {
        this.logger.warn(
          `[PayPal] Failed to parse capture amount during ${operation}; skipping aggregate`,
        );
        return undefined;
      }
    }

    // Only PARTIALLY_REFUNDED slices (no COMPLETED siblings): incomplete money snapshot.
    // Do not report original face amounts as held funds.
    if (
      totalMinor === undefined ||
      currency === undefined ||
      scale === undefined
    ) {
      if (sawPartialRefundWithoutNet) {
        return undefined;
      }
      return undefined;
    }

    return sharedFromMinorUnits(totalMinor, currency, {
          rounding: "reject",
          exponent: scale,
          allowZero: true,
          allowNegative: false,
        });
  }

  private readResourceFinalCapture(
    resource: PayPalWebhookPayload["resource"] | Record<string, unknown>,
  ): boolean | undefined {
    const value = (resource as { final_capture?: unknown }).final_capture;
    return typeof value === "boolean" ? value : undefined;
  }

  /**
   * Incomplete refund snapshots must not dual-write `refund.completed` —
   * type-only handlers would mark captures fully refunded (P610-PP-3 / PAYPAL-DW-1):
   * - `status === refund_completed` (this-op PAYMENT.REFUND.COMPLETED)
   * - `PAYMENT.CAPTURE.REFUNDED` + `partially_refunded` (refund-shaped COMPLETED
   *   resource or incomplete capture settlement)
   * Domain keeps the incomplete marker; stable dual-write is `refund.pending`.
   * Proven full `refunded` keeps `refund.completed`.
   * Provider-native `event.type` / `provider.eventType` stay unchanged.
   */
  private demoteIncompleteRefundWebhookDualWrite(
    event: WebhookEvent,
  ): WebhookEvent {
    const isThisOpRefundCompleted = event.status === "refund_completed";
    const isIncompleteCaptureRefunded =
      event.type === "PAYMENT.CAPTURE.REFUNDED" &&
      event.status === "partially_refunded";
    if (
      (!isThisOpRefundCompleted && !isIncompleteCaptureRefunded) ||
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
   * When status is partially_captured on capture/order completion events, demote
   * dual-write away from fulfillment-ready types (capture.completed /
   * payment.succeeded / provider.unmapped) → payment.processing so type-only
   * handlers stay aligned with isPaidOutcome.
   */
  private demotePartialCaptureWebhookDualWrite(
    event: WebhookEvent,
  ): WebhookEvent {
    if (event.status !== "partially_captured" || !event.provider) {
      return event;
    }

    const isPartialCaptureLifecycle =
      event.type === "PAYMENT.CAPTURE.COMPLETED" ||
      event.type === "CHECKOUT.ORDER.COMPLETED";
    if (!isPartialCaptureLifecycle) {
      return event;
    }

    // Already processing (e.g. AUTHORIZATION.PARTIALLY_CAPTURED path) — leave alone.
    if (
      event.stableType === "payment.processing" &&
      event.event?.type === "payment.processing"
    ) {
      return event;
    }

    // Rebuild payment snapshot from the envelope (domain status already partial).
    const payment =
      (event.event &&
      "payment" in event.event &&
      event.event.payment !== undefined
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
   * PAYPAL-5: `PAYMENT.AUTHORIZATION.CAPTURED` maps domain status to `paid`, but
   * without a linked capture id `gatewayPaymentId` is the authorization id — not
   * refundable. Do not dual-write `capture.completed` (implies a capture resource).
   * Prefer `payment.succeeded` so refund paths are not pointed at an auth id.
   */
  private demoteAuthCapturedWithoutCaptureId(
    event: WebhookEvent,
    captureId: string | undefined,
  ): WebhookEvent {
    if (
      event.type !== "PAYMENT.AUTHORIZATION.CAPTURED" ||
      captureId ||
      !event.provider
    ) {
      return event;
    }

    if (
      event.stableType !== "capture.completed" &&
      event.event?.type !== "capture.completed"
    ) {
      return event;
    }

    const payment =
      (event.event &&
      "payment" in event.event &&
      event.event.payment !== undefined
        ? event.event.payment
        : undefined) ?? paymentFromWebhookEvent(event);

    return {
      ...event,
      stableType: "payment.succeeded",
      event: {
        schemaVersion: PAYMENT_EVENT_SCHEMA_VERSION,
        type: "payment.succeeded",
        payment,
        provider: event.provider,
      },
    };
  }
}
