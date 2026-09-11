import {
  applyOutcomeToGatewayResult,
  applyOutcomeToGatewayRefundResult,
  attachPaymentEvent,
  BaseGateway,
  buildProviderReferences,
  combineAbortSignals,
  createTimeoutSignal,
  hashWebhookPayload,
  InvalidRequestError,
  mapHttpAbortError,
  NetworkError,
  toMinorUnits,
  withRetry,
  type Money,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type GatewayRuntimeDeps,
  type GetPaymentParams,
  type HooksManager,
  type Logger,
  type VoidParams,
  type WebhookEvent,
} from "@paykernel/core";
import { TAP_CAPABILITIES } from "./capabilities";
import {
  TAP_API_BASE_URL,
  TAP_DEFAULT_TIMEOUT_MS,
  assertTapHttpsUrl,
  copyTapConfig,
  type TapConfig,
} from "./config";
import {
  assertTapSuccessBody,
  isMutatingMethod,
  isTapRetryableError as isTapHttpRetryableError,
  mapTapHttpFailure,
  tapResponseCode,
  tapStatusMissing,
} from "./http";
import { parseTapAmount, stringifyTapJsonBody, tapMajorNumber } from "./money";
import {
  isMappableRefundObject,
  nestedRefundFromCharge,
  refundIdFromUnknown,
  tapRemainingRefundMajor,
} from "./refund-support";
import { assertNoPciCardSource, resolveTapSourceId } from "./sources";
import {
  inferTapStableType,
  isTapDeclineStatus,
  mapTapChargeOutcome,
  mapTapChargeStatus,
  mapTapRefundEntityStatus,
  mapTapRefundPaymentStatus,
} from "./status";
import type {
  TapApiObject,
  TapCaptureParams,
  TapCreatePaymentParams,
  TapCustomerInput,
  TapRefundParams,
  TapRefundReason,
} from "./types";
import {
  authorizeIdFromSource,
  chargeIdFromAuthorize,
  parseTapInvoiceWebhookEvent,
  tapMetadataPaymentId,
  tapWebhookTimestamp,
  withRelatedIdsOnPaymentEvent,
} from "./webhook-map";
import {
  coerceTapPayload,
  extractHashstringHeader,
  tapCreatedRaw,
  tapObjectKind,
  tapWebhookEventId,
  verifyTapHashstring,
} from "./webhooks";

const TAP_REFUND_REASONS = new Set<TapRefundReason>([
  "duplicate",
  "fraudulent",
  "requested_by_customer",
]);

function isTapRetryableError(error: unknown): boolean {
  if (
    error instanceof NetworkError &&
    error.message.includes("aborted by caller")
  ) {
    return false;
  }
  return isTapHttpRetryableError(error);
}

function isTapRetryableBeforeSubmit(error: unknown): boolean {
  return (
    isTapRetryableError(error) &&
    !(error instanceof NetworkError && error.afterProviderSubmit === true)
  );
}

function currenciesMismatch(requested: unknown, retrieved: unknown): boolean {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    return false;
  }
  if (typeof retrieved !== "string" || retrieved.trim().length === 0) {
    return false;
  }
  return requested.trim().toUpperCase() !== retrieved.trim().toUpperCase();
}

export class TapGateway extends BaseGateway {
  readonly name = "tap" as const;
  private readonly tapConfig: TapConfig;

  constructor(
    config: TapConfig,
    hooks: HooksManager,
    logger?: Logger,
    runtime?: GatewayRuntimeDeps,
  ) {
    const closed = copyTapConfig(config);
    super(closed, hooks, logger, TAP_CAPABILITIES, runtime);
    this.tapConfig = closed;
  }

  async createPayment(params: TapCreatePaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("createPayment", params, async (p) => {
      const idempotencyKey = this.assertMutationKey(
        p.idempotencyKey,
        "createPayment",
      );
      const capture = p.capture !== false;
      const tap = this.readTapCreate(p);
      const body = this.buildCreateBody(p, tap, idempotencyKey);
      const path = capture ? "/charges" : "/authorize";
      const raw = await this.tapRequest("POST", path, body, {
        signal: p.signal,
        retry: true,
      });
      return this.mapPaymentObject(raw, capture ? "charge" : "authorize");
    });
  }

  async capturePayment(params: TapCaptureParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("capturePayment", params, async (p) => {
      const idempotencyKey = this.assertMutationKey(
        p.idempotencyKey,
        "capturePayment",
      );
      const authorizeId = this.assertIdPrefix(p.gatewayPaymentId, "auth_");
      const existing = await this.tapRequest("GET", `/authorize/${authorizeId}`, undefined, {
        signal: p.signal,
        retry: true,
      });
      const obj = existing as TapApiObject;
      const tapStatus = obj.status;
      const normalized =
        typeof tapStatus === "string" ? tapStatus.trim().toUpperCase() : "";
      if (normalized === "CAPTURED") {
        return this.mapCapturedAuthorize(existing, authorizeId, p.signal);
      }
      if (normalized !== "AUTHORIZED") {
        throw new InvalidRequestError(
          `Tap capture requires AUTHORIZED or CAPTURED authorize status (got "${String(tapStatus)}")`,
        );
      }
      this.assertCurrencyMatch(p.currency, obj.currency, "capture");
      const currency =
        p.currency ??
        (typeof obj.currency === "string" ? obj.currency : undefined);
      if (currency === undefined || currency.trim().length === 0) {
        throw new InvalidRequestError(
          "Tap capture requires currency (pass CaptureParams.currency or retrieve it from the authorize object)",
        );
      }
      const isPartialCapture = this.assertCaptureAmount(p.amount, obj.amount, currency);
      const amount = this.tapOutboundMajor(
        p.amount !== undefined ? p.amount : parseTapAmount(obj.amount, currency),
        currency,
      );
      const redirectUrl = this.captureRedirectUrl(p, existing);
      const customer = this.customerFromObject(existing);
      if (p.tapThreeDSecure === false) {
        throw new InvalidRequestError(
          "Tap capture cannot set threeDSecure false (Tap requires it not false on authorize capture)",
        );
      }
      if (p.tapCustomerInitiated === false) {
        throw new InvalidRequestError(
          "Tap capture cannot set customer_initiated false (Tap requires it not false on authorize capture)",
        );
      }
      const body: Record<string, unknown> = {
        amount,
        currency: currency.trim().toUpperCase(),
        customer_initiated: true,
        threeDSecure: true,
        save_card: false,
        source: { id: authorizeId },
        redirect: { url: redirectUrl },
        reference: { idempotent: idempotencyKey },
      };
      if (customer !== undefined) body.customer = customer;
      if (this.tapConfig.merchantId !== undefined) {
        body.merchant = { id: this.tapConfig.merchantId };
      }
      if (this.tapConfig.webhookUrl !== undefined) {
        body.post = { url: this.tapConfig.webhookUrl };
      }
      const raw = await this.tapRequest("POST", "/charges", body, {
        signal: p.signal,
        retry: true,
      });
      const mapped = this.mapPaymentObject(raw, "charge", authorizeId);
      if (!isPartialCapture) return mapped;
      // Only normalize after a confirmed capture to preserve decline/failure detail.
      if (mapped.status !== "paid" || mapped.outcome !== "succeeded") return mapped;
      return applyOutcomeToGatewayResult(
        {
          gateway: "tap",
          gatewayId: mapped.gatewayId,
          status: "partially_captured",
          redirectUrl: undefined,
          rawResponse: mapped.rawResponse,
          references: mapped.references,
          ...(mapped.amount !== undefined ? { amount: mapped.amount } : {}),
          ...(mapped.currency !== undefined ? { currency: mapped.currency } : {}),
          ...(mapped.authorizationId !== undefined
            ? { authorizationId: mapped.authorizationId }
            : {}),
        },
        "requires_action",
      );
    });
  }

  async voidPayment(params: VoidParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("voidPayment", params, async (p) => {
      const idempotencyKey = this.assertMutationKey(
        p.idempotencyKey,
        "voidPayment",
      );
      const authorizeId = this.assertIdPrefix(p.gatewayPaymentId, "auth_");
      const existing = await this.tapRequest(
        "GET",
        `/authorize/${authorizeId}`,
        undefined,
        {
          signal: p.signal,
          retry: true,
        },
      );
      const obj = existing as TapApiObject;
      const tapStatus = obj.status;
      const normalized =
        typeof tapStatus === "string" ? tapStatus.trim().toUpperCase() : "";
      if (normalized === "VOID") {
        return this.mapPaymentObject(existing, "authorize");
      }
      if (normalized !== "AUTHORIZED") {
        throw new InvalidRequestError(
          `Tap void requires AUTHORIZED authorize status (got "${String(tapStatus)}")`,
        );
      }
      const raw = await this.tapRequest(
        "POST",
        `/authorize/${authorizeId}/void`,
        { reference: { idempotent: idempotencyKey } },
        {
          signal: p.signal,
          retry: true,
          isRetryable: isTapRetryableBeforeSubmit,
        },
      );
      const mapped = this.mapPaymentObject(raw, "authorize");
      if (mapped.status !== "cancelled") return mapped;
      return applyOutcomeToGatewayResult(
        {
          gateway: "tap",
          gatewayId: mapped.gatewayId,
          status: "cancelled",
          redirectUrl: undefined,
          rawResponse: mapped.rawResponse,
          references: mapped.references,
          ...(mapped.amount !== undefined ? { amount: mapped.amount } : {}),
          ...(mapped.currency !== undefined ? { currency: mapped.currency } : {}),
          ...(mapped.authorizationId !== undefined
            ? { authorizationId: mapped.authorizationId }
            : {}),
          ...(mapped.references?.providerNativeStatus !== undefined
            ? { providerNativeStatus: mapped.references.providerNativeStatus }
            : {}),
        },
        "succeeded",
      );
    });
  }

  async refundPayment(params: TapRefundParams): Promise<GatewayRefundResult> {
    return this.executeWithHooks("refundPayment", params, async (p) => {
      const idempotencyKey = this.assertMutationKey(
        p.idempotencyKey,
        "refundPayment",
      );
      const chargeId = this.assertIdPrefix(p.gatewayPaymentId, "chg_");
      const existing = await this.tapRequest("GET", `/charges/${chargeId}`, undefined, {
        signal: p.signal,
        retry: true,
      });
      const obj = existing as TapApiObject;
      const existingStatus =
        typeof obj.status === "string" ? obj.status.trim().toUpperCase() : "";
      this.assertCurrencyMatch(p.currency, obj.currency, "refund");
      const currency =
        p.currency ?? (typeof obj.currency === "string" ? obj.currency : undefined);
      if (currency === undefined || currency.trim().length === 0) {
        throw new InvalidRequestError(
          "Tap refund requires currency (pass RefundParams.currency or retrieve it from the charge)",
        );
      }
      if (existingStatus === "REFUNDED") {
        const embedded = await this.mapEmbeddedRefund(obj, p.signal, idempotencyKey);
        if (embedded !== undefined) return embedded;
        throw new InvalidRequestError(
          "Tap charge is already fully refunded (nothing remaining)",
        );
      }
      let remaining: number | undefined;
      try {
        remaining = tapRemainingRefundMajor(obj, currency);
      } catch (error) {
        if (
          p.amount === undefined ||
          !(error instanceof InvalidRequestError) ||
          !error.message.includes("does not expose remaining/refunded")
        ) {
          throw error;
        }
      }
      if (remaining === 0) {
        const embedded = await this.mapEmbeddedRefund(obj, p.signal, idempotencyKey);
        if (embedded !== undefined) return embedded;
        throw new InvalidRequestError(
          "Tap charge is already fully refunded (nothing remaining)",
        );
      }
      const amount =
        p.amount !== undefined
          ? this.tapOutboundMajor(p.amount, currency)
          : remaining;
      if (amount === undefined) {
        throw new InvalidRequestError(
          "Tap refund requires amount (charge does not expose remaining/refunded)",
        );
      }
      return this.postTapRefund({
        chargeId,
        amount,
        currency,
        params: p,
        idempotencyKey,
      });
    });
  }

  async getPayment(params: GetPaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("getPayment", params, async (p) => {
      const id = p.gatewayPaymentId;
      const kind = this.kindFromId(id);
      const path = kind === "authorize" ? `/authorize/${id}` : `/charges/${id}`;
      const raw = await this.tapRequest("GET", path, undefined, {
        signal: p.signal,
        retry: true,
      });
      if (kind === "authorize") {
        const obj = raw as TapApiObject;
        const tapStatus =
          typeof obj.status === "string" ? obj.status.trim().toUpperCase() : "";
        if (tapStatus === "CAPTURED") {
          return this.mapCapturedAuthorize(raw, id, p.signal);
        }
      }
      return this.mapPaymentObject(raw, kind);
    });
  }

  verifyWebhook(
    payload: unknown,
    signature?: string,
    headers?: Record<string, string>,
  ): boolean {
    const provided = extractHashstringHeader(signature, headers);
    return verifyTapHashstring(payload, this.tapConfig.secretKey, provided);
  }

  parseWebhookEvent(payload: unknown): WebhookEvent {
    const normalized = coerceTapPayload(payload);
    if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
      if ((normalized as TapApiObject).object === "invoice") {
        return parseTapInvoiceWebhookEvent(normalized as TapApiObject);
      }
    }
    const kind = tapObjectKind(normalized);
    const obj = normalized as TapApiObject;
    const id = this.requireString(obj.id, "id");
    const currency =
      typeof obj.currency === "string" ? obj.currency.toUpperCase() : undefined;
    const tapStatus = typeof obj.status === "string" ? obj.status : "";
    const gatewayStatus =
      kind === "refund"
        ? mapTapRefundPaymentStatus(tapStatus)
        : mapTapChargeStatus(tapStatus);
    // WebhookEvent.status is WebhookEnvelopeStatus — map Gateway refund_pending/failed to domain pending/failed
    const statusForWebhook: import("@paykernel/core").WebhookEnvelopeStatus =
      kind === "refund"
        ? gatewayStatus === "refund_pending"
          ? "pending"
          : gatewayStatus === "refund_failed"
            ? "failed"
            : gatewayStatus === "refunded"
              ? "refunded"
              : (gatewayStatus as unknown as import("@paykernel/core").WebhookEnvelopeStatus)
        : (gatewayStatus as unknown as import("@paykernel/core").WebhookEnvelopeStatus);
    const status = gatewayStatus;
    const authorizeChargeId =
      kind === "authorize" ? chargeIdFromAuthorize(obj) : undefined;
    const chargeId =
      kind === "refund" && typeof obj.charge_id === "string"
        ? obj.charge_id
        : (authorizeChargeId ?? id);
    let amount: Money | undefined;
    if (obj.amount !== undefined && currency !== undefined) {
      amount = parseTapAmount(obj.amount, currency);
    }
    const liveMode = typeof obj.live_mode === "boolean" ? obj.live_mode : undefined;
    const apiVersion =
      typeof obj.api_version === "string" ? obj.api_version : undefined;
    const paymentId = tapMetadataPaymentId(obj);
    const nativeType = `${kind}.${tapStatus}`;
    const stable = inferTapStableType(kind, status);
    const createdRaw = tapCreatedRaw(obj);
    if (createdRaw === undefined) {
      throw new InvalidRequestError("Tap webhook missing created timestamp");
    }
    const created = tapWebhookTimestamp(createdRaw);

    const legacy: WebhookEvent = {
      id: tapWebhookEventId(normalized),
      type: stable ?? nativeType,
      gateway: "tap",
      paymentId,
      gatewayPaymentId: chargeId,
      status: statusForWebhook,
      timestamp: created,
      rawPayload: normalized,
    };
    if (kind === "refund") legacy.gatewayObjectId = id;
    if (amount !== undefined) {
      legacy.amount = amount;
      legacy.currency = amount.currency;
    } else if (currency !== undefined) {
      legacy.currency = currency;
    }
    if (liveMode !== undefined) legacy.livemode = liveMode;
    if (apiVersion !== undefined) legacy.apiVersion = apiVersion;

    const attached = attachPaymentEvent(legacy);
    const provider = attached.provider
      ? { ...attached.provider, eventType: nativeType }
      : attached.provider;
    const nested = attached.event
      ? withRelatedIdsOnPaymentEvent(
          {
            ...attached.event,
            provider: { ...attached.event.provider, eventType: nativeType },
          },
          {
            authorizationId:
              authorizeIdFromSource(obj) ??
              (kind === "authorize" ? id : undefined),
            chargeId: authorizeChargeId,
          },
        )
      : attached.event;
    return {
      ...attached,
      type: nativeType,
      ...(provider !== undefined ? { provider } : {}),
      ...(nested !== undefined ? { event: nested } : {}),
      payloadHash: hashWebhookPayload({
        id,
        object: kind,
        status: tapStatus,
        created: createdRaw,
      }),
    };
  }

  private async tapRequest(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    options: {
      signal?: AbortSignal | undefined;
      retry: boolean;
      isRetryable?: (error: unknown) => boolean;
    },
  ): Promise<unknown> {
    if (body !== undefined) assertNoPciCardSource(body);
    const run = () => this.tapRequestOnce(method, path, body, options.signal);
    if (options.retry) {
      return withRetry(run, {
        isRetryable: options.isRetryable ?? isTapRetryableError,
      });
    }
    return run();
  }

  private async tapRequestOnce(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    callerSignal?: AbortSignal | undefined,
  ): Promise<unknown> {
    const timeoutMs = this.tapConfig.timeoutMs ?? TAP_DEFAULT_TIMEOUT_MS;
    const { signal: timeoutSignal, clear } = createTimeoutSignal(timeoutMs);
    const signal = combineAbortSignals(callerSignal, timeoutSignal);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tapConfig.secretKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined && isMutatingMethod(method)) {
      init.body = stringifyTapJsonBody(body);
    }
    if (signal !== undefined) init.signal = signal;

    let response: Response;
    let responseText = "";
    try {
      response = await this.fetch(`${TAP_API_BASE_URL}${path}`, init);
      responseText = await response.text();
    } catch (error) {
      throw mapHttpAbortError(error, {
        callerSignal,
        timeoutSignal,
        timeoutMessage: `Tap API request timed out after ${timeoutMs}ms`,
        networkMessage: "Failed to reach Tap API",
        callerAbortMessage: "Tap API request aborted by caller signal",
        afterProviderSubmit: isMutatingMethod(method),
      });
    } finally {
      clear();
    }

    let data: unknown = {};
    let jsonParseFailed = false;
    if (responseText.length > 0) {
      try {
        data = JSON.parse(responseText) as unknown;
      } catch {
        jsonParseFailed = true;
      }
    }

    if (!response.ok) {
      throw mapTapHttpFailure({
        status: response.status,
        body: jsonParseFailed ? { body: responseText } : data,
        method,
        headers: response.headers,
      });
    }

    assertTapSuccessBody({
      method,
      status: response.status,
      responseText,
      jsonParseFailed,
      data,
    });
    if (
      !isMutatingMethod(method) &&
      tapStatusMissing((data as { status?: unknown }).status)
    ) {
      throw new InvalidRequestError("Tap API returned a 2xx GET body missing status");
    }
    return data;
  }

  private mapPaymentObject(
    raw: unknown,
    kind: "charge" | "authorize",
    authorizationId?: string,
  ): GatewayPaymentResult {
    if (raw === null || typeof raw !== "object") {
      throw new InvalidRequestError("Tap payment response must be an object");
    }
    const obj = raw as TapApiObject;
    const id = this.requireString(obj.id, "id");
    const tapStatus = obj.status as string;
    const status = mapTapChargeStatus(tapStatus);
    const currency =
      typeof obj.currency === "string" ? obj.currency.toUpperCase() : undefined;
    const redirectUrl = this.redirectUrl(obj);
    const code = tapResponseCode(obj);
    const tapStatusNormalized =
      typeof tapStatus === "string" ? tapStatus.trim().toUpperCase() : "";
    const outcome =
      tapStatusNormalized === "VOID" && kind === "authorize"
        ? "succeeded"
        : mapTapChargeOutcome(tapStatus, status, code);
    const omitCapturedHoldAmount =
      kind === "authorize" && tapStatusNormalized === "CAPTURED";
    let amount: Money | undefined;
    if (
      obj.amount !== undefined &&
      currency !== undefined &&
      !omitCapturedHoldAmount
    ) {
      amount = parseTapAmount(obj.amount, currency);
    }
    const declineMessage =
      typeof (obj.response as { message?: unknown } | undefined)?.message ===
      "string"
        ? (obj.response as { message: string }).message
        : tapStatus;
    const isDecline = isTapDeclineStatus(tapStatus, code);
    const decline = isDecline
      ? {
          code: code ?? tapStatus,
          message: declineMessage,
          ...(code !== undefined ? { providerCode: code } : {}),
        }
      : undefined;

    const authId = authorizationId ?? (kind === "authorize" ? id : undefined);
    const references = buildProviderReferences({
      gateway: "tap",
      gatewayId: id,
      status,
      providerNativeStatus: tapStatus,
      ...(authId !== undefined ? { authorizationId: authId } : {}),
      ...(kind === "charge" ? { chargeId: id } : {}),
    });

    const extras =
      decline !== undefined && outcome === "declined"
        ? { decline }
        : redirectUrl !== undefined && outcome === "requires_action"
          ? { action: { type: "redirect" as const, url: redirectUrl } }
          : undefined;

    return applyOutcomeToGatewayResult(
      {
        gateway: "tap",
        gatewayId: id,
        status,
        redirectUrl: outcome === "requires_action" ? redirectUrl : undefined,
        rawResponse: raw,
        references,
        ...(amount !== undefined ? { amount, currency: amount.currency } : currency !== undefined ? { currency } : {}),
        ...(authId !== undefined ? { authorizationId: authId } : {}),
        providerNativeStatus: tapStatus,
      },
      outcome,
      extras,
    );
  }

  private async mapEmbeddedRefund(
    obj: TapApiObject,
    signal: AbortSignal | undefined,
    idempotencyKey: string,
  ): Promise<GatewayRefundResult | undefined> {
    const nested = nestedRefundFromCharge(obj, idempotencyKey);
    if (nested === undefined) return undefined;
    if (isMappableRefundObject(nested)) {
      return this.mapRefundObject(nested);
    }
    const refundId = refundIdFromUnknown(nested);
    if (refundId === undefined) return undefined;
    const raw = await this.tapRequest("GET", `/refunds/${refundId}`, undefined, {
      signal,
      retry: true,
    });
    return this.mapRefundObject(raw);
  }

  private async postTapRefund(input: {
    chargeId: string;
    amount: number;
    currency: string;
    params: TapRefundParams;
    idempotencyKey: string;
  }): Promise<GatewayRefundResult> {
    const reason = this.refundReason(input.params);
    const body: Record<string, unknown> = {
      charge_id: input.chargeId,
      amount: input.amount,
      currency: input.currency.trim().toUpperCase(),
      reason,
      reference: { idempotent: input.idempotencyKey },
    };
    const metadata = this.toTapMetadata(input.params.metadata);
    if (metadata !== undefined) body.metadata = metadata;
    if (this.tapConfig.webhookUrl !== undefined) {
      body.post = { url: this.tapConfig.webhookUrl };
    }
    const raw = await this.tapRequest("POST", "/refunds", body, {
      signal: input.params.signal,
      retry: true,
    });
    return this.mapRefundObject(raw);
  }

  private mapRefundObject(raw: unknown): GatewayRefundResult {
    if (raw === null || typeof raw !== "object") {
      throw new InvalidRequestError("Tap refund response must be an object");
    }
    const obj = raw as TapApiObject;
    const id = this.requireString(obj.id, "id");
    const tapStatus = obj.status as string;
    const status = mapTapRefundEntityStatus(tapStatus);
    const outcome =
      status === "completed"
        ? "succeeded"
        : status === "pending"
          ? "pending"
          : "failed";
    return applyOutcomeToGatewayRefundResult(
      {
        gatewayRefundId: id,
        status,
        rawResponse: raw,
      },
      outcome,
    );
  }

  private buildCreateBody(
    params: TapCreatePaymentParams,
    tap: {
      customer: TapCustomerInput;
      sourceId: string;
      postUrl: string | undefined;
      threeDSecure: boolean;
      merchantId: string | undefined;
    },
    idempotencyKey: string,
  ): Record<string, unknown> {
    const currency = params.currency.toUpperCase();
    const body: Record<string, unknown> = {
      amount: this.tapOutboundMajor(params.amount, currency),
      currency,
      customer_initiated: true,
      threeDSecure: tap.threeDSecure,
      save_card: false,
      customer: this.serializeCustomer(tap.customer),
      source: { id: tap.sourceId },
      redirect: { url: params.callbackUrl },
      reference: {
        idempotent: idempotencyKey,
        ...(params.orderId !== undefined ? { order: params.orderId } : {}),
      },
    };
    if (params.description !== undefined) body.description = params.description;
    const metadata = this.toTapMetadata(params.metadata);
    if (metadata !== undefined) body.metadata = metadata;
    if (tap.postUrl !== undefined) body.post = { url: tap.postUrl };
    if (tap.merchantId !== undefined) body.merchant = { id: tap.merchantId };
    if (params.capture === false && this.tapConfig.autoVoidHours !== undefined) {
      const sourceId = tap.sourceId.toLowerCase();
      if (sourceId === "src_all" || sourceId === "src_card") {
        throw new InvalidRequestError(
          "Tap autoVoidHours cannot be used with src_all or src_card",
        );
      }
      body.auto = { type: "VOID", time: this.tapConfig.autoVoidHours };
    }
    return body;
  }

  private readTapCreate(params: TapCreatePaymentParams): {
    customer: TapCustomerInput;
    sourceId: string;
    postUrl: string | undefined;
    threeDSecure: boolean;
    merchantId: string | undefined;
  } {
    if (typeof params.callbackUrl !== "string" || params.callbackUrl.trim().length === 0) {
      throw new InvalidRequestError("Tap createPayment requires callbackUrl");
    }
    const customer = params.tapCustomer ??
      (typeof params.customerId === "string" && params.customerId.length > 0
        ? { id: params.customerId }
        : undefined);
    if (customer === undefined) {
      throw new InvalidRequestError(
        "Tap createPayment requires tapCustomer or customerId",
      );
    }
    const sourceId =
      params.tapSource === undefined && params.capture === false
        ? "src_card"
        : resolveTapSourceId(params.tapSource);
    if (sourceId.toLowerCase().startsWith("auth_")) {
      throw new InvalidRequestError(
        "Tap createPayment does not accept auth_ source ids; use capturePayment",
      );
    }
    if (params.tapPostUrl !== undefined) {
      assertTapHttpsUrl(params.tapPostUrl, "tapPostUrl");
    }
    const postUrl = params.tapPostUrl ?? this.tapConfig.webhookUrl;
    const threeDSecure = params.tapThreeDSecure !== false;
    const merchantId = params.tapMerchantId ?? this.tapConfig.merchantId;
    return { customer, sourceId, postUrl, threeDSecure, merchantId };
  }

  private serializeCustomer(customer: TapCustomerInput): Record<string, unknown> {
    if ("id" in customer && customer.id.length > 0) {
      return { id: customer.id };
    }
    if ("firstName" in customer) {
      const firstName = customer.firstName.trim();
      const lastName = customer.lastName.trim();
      const email = customer.email.trim();
      if (firstName.length === 0) {
        throw new InvalidRequestError(
          "Tap createPayment inline customer requires firstName",
        );
      }
      if (lastName.length === 0) {
        throw new InvalidRequestError(
          "Tap createPayment inline customer requires lastName",
        );
      }
      if (email.length === 0) {
        throw new InvalidRequestError(
          "Tap createPayment inline customer requires email",
        );
      }
      const out: Record<string, unknown> = {
        first_name: firstName,
        last_name: lastName,
        email,
      };
      if (customer.middleName !== undefined) out.middle_name = customer.middleName;
      if (customer.phone !== undefined) {
        out.phone = {
          country_code: customer.phone.countryCode,
          number: customer.phone.number,
        };
      }
      return out;
    }
    throw new InvalidRequestError("Tap customer requires id or firstName+lastName+email");
  }

  private async mapCapturedAuthorize(
    existing: unknown,
    authorizeId: string,
    signal?: AbortSignal,
  ): Promise<GatewayPaymentResult> {
    const chargeId = chargeIdFromAuthorize(existing as TapApiObject);
    if (chargeId !== undefined) {
      const charge = await this.tapRequest("GET", `/charges/${chargeId}`, undefined, {
        signal,
        retry: true,
      });
      return this.mapPaymentObject(charge, "charge", authorizeId);
    }
    return this.mapPaymentObject(existing, "authorize", authorizeId);
  }

  private assertCurrencyMatch(
    requested: string | undefined,
    retrieved: unknown,
    operation: "capture" | "refund",
  ): void {
    if (!currenciesMismatch(requested, retrieved)) return;
    throw new InvalidRequestError(
      `Tap ${operation} currency "${String(requested)}" does not match retrieved currency "${String(retrieved)}"`,
    );
  }

  private captureRedirectUrl(
    params: TapCaptureParams,
    existing: unknown,
  ): string {
    const override = params.tapRedirectUrl;
    if (typeof override === "string" && override.trim().length > 0) {
      return override.trim();
    }
    const fromAuthorize = this.merchantRedirectUrl(existing);
    if (fromAuthorize !== undefined) return fromAuthorize;
    throw new InvalidRequestError(
      "Tap capture requires redirect.url (authorize.redirect.url or tapRedirectUrl)",
    );
  }

  private merchantRedirectUrl(raw: unknown): string | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const redirect = (raw as TapApiObject).redirect;
    if (redirect === null || typeof redirect !== "object" || Array.isArray(redirect)) {
      return undefined;
    }
    const url = (redirect as { url?: unknown }).url;
    if (typeof url !== "string") return undefined;
    const trimmed = url.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private customerFromObject(raw: unknown): Record<string, unknown> | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const customer = (raw as TapApiObject).customer;
    if (customer !== null && typeof customer === "object" && !Array.isArray(customer)) {
      const id = (customer as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) return { id };
    }
    return undefined;
  }

  private toTapMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, string> | undefined {
    if (metadata === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined || value === null) continue;
      if (value !== null && typeof value === "object") {
        throw new InvalidRequestError(
          "Tap metadata values must be scalar strings, numbers, or booleans",
        );
      }
      out[key] = String(value);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private tapOutboundMajor(amount: Money, currency: string): number {
    const major = tapMajorNumber(amount, currency);
    if (major === 0) {
      throw new InvalidRequestError("Tap amount must be greater than 0");
    }
    return major;
  }

  private assertCaptureAmount(
    requested: Money | undefined,
    authorizeAmount: unknown,
    currency: string,
  ): boolean {
    if (requested === undefined) return false;
    const requestedMinor = toMinorUnits(requested);
    const authorizedMinor = toMinorUnits(parseTapAmount(authorizeAmount, currency));
    if (requestedMinor > authorizedMinor) {
      throw new InvalidRequestError(
        "Tap capture amount exceeds the authorized amount",
      );
    }
    return requestedMinor < authorizedMinor;
  }

  private assertMutationKey(key: string | undefined, operation: string): string {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new InvalidRequestError(`Tap ${operation} requires idempotencyKey`);
    }
    return key.trim();
  }

  private assertIdPrefix(id: string, prefix: string): string {
    if (!id.startsWith(prefix)) {
      throw new InvalidRequestError(
        `Tap expected an id starting with ${prefix} (got "${id}")`,
      );
    }
    return id;
  }

  private kindFromId(id: string): "charge" | "authorize" {
    if (id.startsWith("auth_")) return "authorize";
    if (id.startsWith("chg_")) return "charge";
    throw new InvalidRequestError(
      `Tap getPayment expected chg_… or auth_… (got "${id}")`,
    );
  }

  private refundReason(params: TapRefundParams): string {
    if (params.tapReason !== undefined && TAP_REFUND_REASONS.has(params.tapReason)) {
      return params.tapReason;
    }
    const raw = params.reason;
    if (typeof raw !== "string") return "requested_by_customer";
    const trimmed = raw.trim();
    if (trimmed.length === 0) return "requested_by_customer";
    if (trimmed.length > 249) {
      throw new InvalidRequestError(
        "Tap refund reason must be 249 characters or fewer",
      );
    }
    const normalized = trimmed.toLowerCase().replace(/ /g, "_");
    if (TAP_REFUND_REASONS.has(normalized as TapRefundReason)) {
      return normalized;
    }
    return trimmed;
  }

  private redirectUrl(obj: TapApiObject): string | undefined {
    const tx = obj.transaction;
    if (tx !== null && typeof tx === "object" && !Array.isArray(tx)) {
      const url = (tx as { url?: unknown }).url;
      if (typeof url === "string" && url.length > 0) return url;
    }
    return undefined;
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new InvalidRequestError(`Tap response missing ${field}`);
    }
    return value;
  }

}

