import {
  applyIndeterminatePaymentOutcome,
  applyOutcomeToGatewayResult,
  applyOutcomeToGatewayRefundResult,
  BaseGateway,
  buildProviderReferences,
  combineAbortSignals,
  createTimeoutSignal,
  InvalidRequestError,
  mapHttpAbortError,
  NetworkError,
  OperationNotSupportedError,
  PaymentAbortedError,
  RateLimitError,
  ResourceNotFoundError,
  sha256Hex,
  toMinorUnits,
  withRetry,
  type CaptureParams,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type GatewayRuntimeDeps,
  type HooksManager,
  type Logger,
  type WebhookEvent,
} from "@paykernel/core";
import { MYFATOORAH_CAPABILITIES } from "./capabilities";
import {
  MYFATOORAH_COUNTRY_CURRENCY,
  MYFATOORAH_DEFAULT_TIMEOUT_MS,
  assertMyFatoorahHttpsUrl,
  copyMyFatoorahConfig,
  resolveMyFatoorahBaseUrl,
  type MyFatoorahConfig,
} from "./config";
import {
  assertMyFatoorahSuccessEnvelope,
  isMyFatoorahRetryableBeforeSubmit,
  isMyFatoorahRetryableError,
  mapMyFatoorahHttpFailure,
  readMyFatoorahData,
} from "./http";
import { myFatoorahMajorNumber, parseMyFatoorahAmount, stringifyMyFatoorahJsonBody } from "./money";
import {
  myFatoorahRefundBaseCurrency,
  myFatoorahRefundId,
  myFatoorahRefundItems,
  myFatoorahRefundStatus,
  myFatoorahRemainingRefundMajor,
  nestedRefundFromInvoice,
} from "./refund-support";
import {
  assertMyFatoorahDisplayPaymentMethods,
  assertMyFatoorahPaymentMethod,
  assertNoPciCardSource,
  resolveMyFatoorahCustomerReference,
} from "./sources";
import {
  mapMyFatoorahInvoiceOutcome,
  mapMyFatoorahInvoiceStatus,
  mapMyFatoorahRefundEntityStatus,
  mapMyFatoorahTransactionEvidence,
} from "./status";
import type {
  MyFatoorahCreatePaymentParams,
  MyFatoorahGetPaymentParams,
  MyFatoorahRefundParams,
} from "./types";
import {
  parseMyFatoorahPaymentWebhookEvent,
  parseMyFatoorahRefundWebhookEvent,
} from "./webhook-map";
import {
  extractMyFatoorahSignatureHeader,
  myFatoorahWebhookKind,
  verifyMyFatoorahSignature,
} from "./webhooks";
import { normalizeMyFatoorahCurrency } from "./currency";
import { withCreateReservation } from "./create-reservation";
const MYFATOORAH_REFUND_COMMENT_MAX = 500;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

function isMyFatoorahRetryableNetworkError(error: unknown): boolean {
  if (error instanceof PaymentAbortedError) return false;
  if (error instanceof NetworkError && error.message.includes("aborted by caller")) {
    return false;
  }
  return isMyFatoorahRetryableError(error);
}
function isIdempotencyHeaderUnsupported(name: string, err: string): boolean {
  const n = name.toLowerCase();
  const e = err.toLowerCase();
  const mentionsHeader =
    n.includes("idempotency") || e.includes("idempotency-key") || e.includes("idempotency key");
  if (!mentionsHeader) return false;
  const conflict =
    e.includes("already") ||
    e.includes("different") ||
    e.includes("conflict") ||
    e.includes("mismatch");
  if (conflict) return false;
  return (
    e.includes("not supported") ||
    e.includes("unsupported") ||
    e.includes("not available") ||
    e.includes("not honored") ||
    e.includes("not allowed") ||
    e.includes("invalid header")
  );
}

function validationErrorArrayMentionsUnsupportedIdempotencyHeader(arr: unknown): boolean {
  if (!Array.isArray(arr)) return false;
  for (const ve of arr) {
    const rec = asRecord(ve);
    const name = typeof rec.Name === "string" ? rec.Name : "";
    const err = typeof rec.Error === "string" ? rec.Error : "";
    if (isIdempotencyHeaderUnsupported(name, err)) return true;
  }
  return false;
}

function validationBodyMentionsUnsupportedIdempotencyHeader(body: unknown): boolean {
  const rec = asRecord(body);
  // Official field is ValidationErrors; legacy alias FieldsErrors
  const ve = rec.ValidationErrors ?? rec.FieldsErrors;
  return validationErrorArrayMentionsUnsupportedIdempotencyHeader(ve);
}

function hasMyFatoorahIdempotencyValidationError(error: unknown): boolean {
  if (
    !(error instanceof InvalidRequestError) ||
    error.validationErrors === undefined ||
    error.validationErrors.length === 0
  ) {
    return false;
  }
  for (const entry of error.validationErrors) {
    // Entries are the http layer's `{ status, body }` raw snapshots.
    const body = asRecord(entry).body;
    if (typeof body === "string" && body.trim().length > 0) {
      // 2xx IsSuccess:false arrives with the raw response text as body.
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && validationBodyMentionsUnsupportedIdempotencyHeader(parsed)) {
        return true;
      }
      if (isIdempotencyHeaderUnsupported("", body)) return true;
    } else if (validationBodyMentionsUnsupportedIdempotencyHeader(body)) {
      return true;
    }
  }
  return false;
}

function currenciesMismatch(requested: unknown, retrieved: unknown): boolean {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    return false;
  }
  if (typeof retrieved !== "string" || retrieved.trim().length === 0) {
    return false;
  }
  const req = normalizeMyFatoorahCurrency(requested) ?? requested.trim().toUpperCase();
  const ret = normalizeMyFatoorahCurrency(retrieved) ?? retrieved.trim().toUpperCase();
  return req !== ret;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringOrNumberId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export class MyFatoorahGateway extends BaseGateway {
  readonly name = "myfatoorah" as const;
  private readonly myfatoorahConfig: MyFatoorahConfig;

  constructor(
    config: MyFatoorahConfig,
    hooks: HooksManager,
    logger?: Logger,
    runtime?: GatewayRuntimeDeps,
  ) {
    const closed = copyMyFatoorahConfig(config);
    super(closed, hooks, logger, MYFATOORAH_CAPABILITIES, runtime);
    this.myfatoorahConfig = closed;
  }

  async createPayment(params: MyFatoorahCreatePaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("createPayment", params, async (p) => {
      const idempotencyKey = this.assertMutationKey(p.idempotencyKey, "createPayment");
      if ((p as unknown as Record<string, unknown>).offSession === true) {
        throw new OperationNotSupportedError(this.name, "createPayment", {
          capability: "paymentMethods",
          claimedSupport: false,
        });
      }
      assertNoPciCardSource(p as unknown as Record<string, unknown>);
      // `authorization` is unclaimed; the base-class post-hook gate rejects
      // `capture: false` first. Explicit fail-closed guard for direct callers.
      if (p.capture === false) {
        throw new OperationNotSupportedError(this.name, "createPayment", {
          capability: "authorization",
          claimedSupport: false,
        });
      }
      assertMyFatoorahHttpsUrl(p.callbackUrl, "callbackUrl");
      // Idempotency-Key is only honored in KWT/SAU. Elsewhere we omit the header
      // and use CustomerReference lookup to avoid double-charge on replay.
      const idempotencySupported = this.supportsNativeIdempotency();
      // MF-CREATE-REPLAY: only when the header is omitted. CustomerReference is
      // not unique — reuse a Paid invoice only when amount+currency match.
      // Pending / mismatch / refunded / partially_refunded fail closed
      // (indeterminate) instead of creating a second invoice. Cancelled/Failed
      // (including Expired→failed via mapMyFatoorahInvoiceStatus) are terminal
      // and allow a new invoice with the same CustomerReference.
      // CustomerReference returns last invoice per https://docs.myfatoorah.com/docs/payment-inquiry
      // and status mapping per docs/status-mapping.md (CANCELED/CANCELLED→cancelled,
      // REFUNDED/PARTIALLY_REFUNDED→refunded/partially_refunded, unknown/Expired→failed).
      const replayReference = this.customerReferenceForReplay(p);
      if (!idempotencySupported && replayReference === undefined) {
        throw new InvalidRequestError(
          "MyFatoorah createPayment requires orderId or myfatoorahCustomer.reference outside KWT/SAU (Idempotency-Key is omitted; CustomerReference is the replay key)",
        );
      }
      const executeCreate = async (markSubmitted: () => void): Promise<GatewayPaymentResult> => {
        const replay = await this.lookupCreateReplay(p, replayReference);
        if (replay !== undefined) return replay;
        return this.submitCreatePayment(p, idempotencyKey, markSubmitted);
      };
      if (idempotencySupported) {
        return executeCreate(() => {});
      }
      return withCreateReservation(
        {
          store: this.myfatoorahConfig.idempotencyStore,
          key: `myfatoorah:create:${sha256Hex(JSON.stringify([this.myfatoorahConfig.apiToken, this.myfatoorahConfig.country, this.myfatoorahConfig.live ?? false, replayReference]))}`,
          fingerprintInput: p,
          createdAt: this.clock.nowMs(),
        },
        executeCreate,
      );
    });
  }

  async capturePayment(params: CaptureParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("capturePayment", params, async () => {
      this.assertCapability("authorization", "capturePayment");
      // Unreachable — assertCapability always throws for this adapter.
      throw new OperationNotSupportedError(this.name, "capturePayment", {
        capability: "authorization",
        claimedSupport: false,
      });
    });
  }

  async refundPayment(params: MyFatoorahRefundParams): Promise<GatewayRefundResult> {
    return this.executeWithHooks("refundPayment", params, async (p) => {
      const idempotencyKey = this.assertMutationKey(p.idempotencyKey, "refundPayment");
      const refundKey = this.resolveRefundKey(p);

      let invoiceId = refundKey.keyType === "InvoiceId" ? refundKey.key : undefined;
      let paymentStatusData: Record<string, unknown> | undefined;
      if (invoiceId === undefined) {
        const paymentStatusForId = await this.myfatoorahRequest(
          "POST",
          "/v2/GetPaymentStatus",
          { Key: refundKey.key, KeyType: "PaymentId" },
          { signal: p.signal, retry: true, postSubmit: false },
        );
        paymentStatusData = paymentStatusForId.data;
        invoiceId = stringOrNumberId(paymentStatusForId.data.InvoiceId);
        if (invoiceId === undefined) {
          throw new InvalidRequestError("MyFatoorah GetPaymentStatus response missing InvoiceId");
        }
      }

      // Fetch GetRefundStatus first — if an existing refund with this idempotencyKey is found,
      // return immediately without awaiting GetPaymentStatus (cheap path).
      // Official GetRefundStatus keys are InvoiceId / RefundId / RefundReference — not PaymentId.
      let refundsRaw: unknown = {};
      try {
        const refundStatus = await this.myfatoorahRequest(
          "POST",
          "/v2/GetRefundStatus",
          { KeyType: "InvoiceId", Key: invoiceId },
          // Data is nullable per OpenAPI — no refunds yet is a valid empty history.
          { signal: p.signal, retry: true, postSubmit: false, allowMissingData: true },
        );
        refundsRaw = refundStatus.data;
      } catch (error) {
        if (p.signal?.aborted) throw error;
        // Official empty-history can be 2xx IsSuccess:false + not-found Message
        // (same envelope as GetPaymentStatus). That is ResourceNotFoundError,
        // not a missing invoice — treat as no refunds yet.
        if (!(error instanceof ResourceNotFoundError)) throw error;
      }
      // MF-CRIT-1: ExternalIdentifier is not provider-deduped. Check for an existing
      // refund with the same idempotencyKey before any MakeRefund, even when
      // remaining > 0, to avoid double-refunding on partial-replay / crash-retry.
      const existingRefund = nestedRefundFromInvoice(refundsRaw, idempotencyKey);
      if (existingRefund !== undefined) {
        return this.mapNestedRefundObject(existingRefund);
      }

      const paymentStatus =
        paymentStatusData !== undefined
          ? { data: paymentStatusData }
          : await this.myfatoorahRequest(
              "POST",
              "/v2/GetPaymentStatus",
              { Key: refundKey.key, KeyType: refundKey.keyType },
              { signal: p.signal, retry: true, postSubmit: false },
            );

      const currency = this.refundCurrency(
        p,
        refundsRaw !== null && typeof refundsRaw === "object" && !Array.isArray(refundsRaw)
          ? (refundsRaw as Record<string, unknown>)
          : undefined,
      );
      this.assertCurrencyMatch(p.currency, currency, "refund");

      const invoiceAmount = this.invoiceValue(paymentStatus.data);
      // Official GetRefundStatus uses RefundStatusResult; fallback to legacy Refunds.
      // Pass the whole Data object so myFatoorahRefundItems can handle both shapes.
      if (invoiceAmount === undefined) {
        throw new InvalidRequestError(
          "MyFatoorah refund requires amount (invoice does not expose remaining)",
        );
      }
      const remaining = myFatoorahRemainingRefundMajor(invoiceAmount, refundsRaw, currency);

      if (remaining === 0) {
        // No matching ExternalIdentifier and nothing remaining -> already fully refunded.
        throw new InvalidRequestError(
          "MyFatoorah invoice is already fully refunded (nothing remaining)",
        );
      }

      let outboundMajor: number;
      if (p.amount !== undefined) {
        const requested = this.myfatoorahOutboundMajor(p.amount, currency);
        // Compare via minor units to avoid IEEE float errors.
        const reqMinor = toMinorUnits(parseMyFatoorahAmount(requested, currency));
        const remMinor = toMinorUnits(parseMyFatoorahAmount(remaining, currency));
        if (reqMinor > remMinor) {
          throw new InvalidRequestError(
            "MyFatoorah refund amount exceeds the remaining refundable amount",
          );
        }
        outboundMajor = requested;
      } else {
        outboundMajor = remaining;
      }

      return this.postMyFatoorahRefund({
        invoiceId: refundKey.key,
        keyType: refundKey.keyType,
        amount: outboundMajor,
        currency,
        params: p,
        idempotencyKey,
      });
    });
  }

  async getPayment(params: MyFatoorahGetPaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("getPayment", params, async (p) => {
      const id = this.assertInvoiceId(p.gatewayPaymentId, "getPayment");
      const keyType = p.myfatoorahKeyType ?? "InvoiceId";
      if (keyType !== "InvoiceId" && keyType !== "PaymentId") {
        throw new InvalidRequestError(
          'MyFatoorah myfatoorahKeyType must be "InvoiceId" or "PaymentId"',
        );
      }
      // InvoiceId guard: real InvoiceIds are ~6-10 digits per fixtures (e.g., 915102),
      // PaymentId is 14–20 digits (often "07..." prefix). Heuristic length >=14
      // catches PaymentId vs InvoiceId mixups; future InvoiceId growth beyond 14
      // would need myfatoorahKeyType override. Error hints at myfatoorahKeyType.
      // Guard against accidental PaymentId lookup via InvoiceId keyType.
      if (keyType === "InvoiceId" && id.length >= 14) {
        throw new InvalidRequestError(
          `MyFatoorah getPayment gatewayPaymentId "${id}" looks like a PaymentId (use myfatoorahKeyType: "PaymentId" for the callback paymentId)`,
        );
      }
      const { data, raw } = await this.myfatoorahRequest(
        "POST",
        "/v2/GetPaymentStatus",
        { Key: id, KeyType: keyType },
        { signal: p.signal, retry: true, postSubmit: false },
      );
      return this.mapGetPaymentResult(data, raw);
    });
  }

  verifyWebhook(
    payload: unknown,
    signature?: string,
    headers?: Record<string, string | string[]>,
  ): boolean {
    const provided = extractMyFatoorahSignatureHeader(signature, headers);
    return verifyMyFatoorahSignature(payload, this.myfatoorahConfig.webhookSecret, provided);
  }

  parseWebhookEvent(payload: unknown): WebhookEvent {
    const kind = myFatoorahWebhookKind(payload);
    return kind === "payment"
      ? parseMyFatoorahPaymentWebhookEvent(payload)
      : parseMyFatoorahRefundWebhookEvent(payload);
  }

  // ─── HTTP transport ─────────────────────────────────────────────────────

  private async myfatoorahRequest(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    options: {
      signal?: AbortSignal | undefined;
      retry: boolean;
      idempotencyKey?: string;
      /** True for money-mutating calls (create / MakeRefund). */
      postSubmit?: boolean;
      /** Currency for top-level `Amount` ISO padding (MakeRefund). */
      currency?: string;
      isRetryable?: (error: unknown) => boolean;
      /** Return empty data instead of throwing on a 2xx body without Data (inquiries only). */
      allowMissingData?: boolean;
    },
  ): Promise<{ data: Record<string, unknown>; raw: unknown }> {
    if (body !== undefined) assertNoPciCardSource(body);
    const run = () =>
      this.myfatoorahRequestOnce(
        method,
        path,
        body,
        options.signal,
        options.idempotencyKey,
        options.postSubmit === true,
        options.currency,
        options.allowMissingData === true,
      );
    if (options.retry) {
      return withRetry(run, {
        isRetryable: options.isRetryable ?? isMyFatoorahRetryableNetworkError,
      });
    }
    return run();
  }

  private async myfatoorahRequestOnce(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    callerSignal: AbortSignal | undefined,
    idempotencyKey: string | undefined,
    postSubmit: boolean,
    currency: string | undefined,
    allowMissingData: boolean,
  ): Promise<{ data: Record<string, unknown>; raw: unknown }> {
    if (callerSignal?.aborted) {
      throw new PaymentAbortedError("MyFatoorah API request aborted by caller signal");
    }
    const timeoutMs = this.myfatoorahConfig.timeoutMs ?? MYFATOORAH_DEFAULT_TIMEOUT_MS;
    const { signal: timeoutSignal, clear } = createTimeoutSignal(timeoutMs);
    const signal = combineAbortSignals(callerSignal, timeoutSignal);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.myfatoorahConfig.apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    // Idempotency-Key is only honored in KWT/SAU per https://docs.myfatoorah.com/docs/idempotency.
    // Outside those countries we omit the header entirely to avoid a validation rejection.
    const idempotencySupported = this.supportsNativeIdempotency();
    if (idempotencyKey !== undefined && postSubmit && idempotencySupported) {
      headers["Idempotency-Key"] = idempotencyKey;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = stringifyMyFatoorahJsonBody(body, currency);
    }
    if (signal !== undefined) init.signal = signal;

    let response: Response;
    let responseText = "";
    try {
      response = await this.fetch(
        `${resolveMyFatoorahBaseUrl(this.myfatoorahConfig)}${path}`,
        init,
      );
      responseText = await response.text();
    } catch (error) {
      // Portable fetch rejection before response headers does not prove the
      // server did not accept the POST; treat any fetch failure on a mutating
      // request as after provider submit.
      throw mapHttpAbortError(error, {
        callerSignal,
        timeoutSignal,
        timeoutMessage: `MyFatoorah API request timed out after ${timeoutMs}ms`,
        networkMessage: "Failed to reach MyFatoorah API",
        callerAbortMessage: "MyFatoorah API request aborted by caller signal",
        afterProviderSubmit: postSubmit,
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
      throw mapMyFatoorahHttpFailure({
        status: response.status,
        body: jsonParseFailed ? { body: responseText } : data,
        method,
        headers: response.headers,
        postSubmit,
      });
    }

    assertMyFatoorahSuccessEnvelope({
      method,
      status: response.status,
      responseText,
      jsonParseFailed,
      data,
      postSubmit,
    });

    const raw = data;
    const unwrapped = readMyFatoorahData(raw);
    if (unwrapped === undefined) {
      if (allowMissingData && !postSubmit) {
        return { data: {}, raw };
      }
      if (postSubmit) {
        throw new NetworkError(
          "MyFatoorah API returned a 2xx body missing Data",
          { status: response.status, body: raw },
          { afterProviderSubmit: true },
        );
      }
      throw new InvalidRequestError("MyFatoorah API returned a 2xx body missing Data");
    }
    return { data: unwrapped, raw };
  }

  // ─── Create helpers ─────────────────────────────────────────────────────

  private supportsNativeIdempotency(): boolean {
    return this.myfatoorahConfig.country === "KWT" || this.myfatoorahConfig.country === "SAU";
  }

  private async lookupCreateReplay(
    params: MyFatoorahCreatePaymentParams,
    reference: string | undefined,
  ): Promise<GatewayPaymentResult | undefined> {
    if (reference === undefined) return undefined;
    try {
      const { data, raw } = await this.myfatoorahRequest(
        "POST",
        "/v2/GetPaymentStatus",
        { Key: reference, KeyType: "CustomerReference" },
        { signal: params.signal, retry: true, postSubmit: false },
      );
      return this.mapCreateReplay({ data, raw, reference }, params);
    } catch (error) {
      if (params.signal?.aborted || error instanceof PaymentAbortedError) throw error;
      if (error instanceof NetworkError && error.message.includes("aborted by caller")) throw error;
      // Native header deduplication makes the KWT/SAU lookup best-effort.
      if (this.supportsNativeIdempotency() || this.isCreateReplayNotFound(error)) return undefined;
      if (error instanceof RateLimitError) throw error;
      return applyIndeterminatePaymentOutcome({
        gateway: this.name,
        gatewayId: reference,
        message: "MyFatoorah createPayment replay lookup failed; refusing to create a second invoice",
        errorName: "NetworkError",
      });
    }
  }

  private mapCreateReplay(
    inquiry: { data: Record<string, unknown>; raw: unknown; reference: string },
    params: MyFatoorahCreatePaymentParams,
  ): GatewayPaymentResult | undefined {
    const { data, raw, reference } = inquiry;
    const invoiceId = stringOrNumberId(data.InvoiceId);
    const status = mapMyFatoorahInvoiceStatus(
      typeof data.InvoiceStatus === "string" ? data.InvoiceStatus : "",
    );
    if (invoiceId !== undefined && status === "paid" && this.replayInvoiceMatchesRequest(data, params)) {
      return this.mapGetPaymentResult(data, raw);
    }
    if (this.supportsNativeIdempotency()) return undefined;
    if (invoiceId !== undefined && (status === "cancelled" || status === "failed")) return undefined;
    // Inquiry cannot recover PaymentURL. Preserve the invoice identity so the
    // caller can reconcile instead of creating a second chargeable invoice.
    const message = invoiceId === undefined
      ? "MyFatoorah createPayment replay lookup returned no InvoiceId; refusing to create a second invoice"
      : status === "pending"
        ? "MyFatoorah createPayment found a pending invoice for this CustomerReference; refusing to create a second invoice"
        : "MyFatoorah createPayment found an existing invoice for this CustomerReference that does not match the request; refusing to create a second invoice";
    return applyIndeterminatePaymentOutcome({
      gateway: this.name,
      gatewayId: invoiceId ?? reference,
      message,
      errorName: "NetworkError",
    });
  }

  private async submitCreatePayment(
    params: MyFatoorahCreatePaymentParams,
    idempotencyKey: string,
    markSubmitted: () => void,
  ): Promise<GatewayPaymentResult> {
    const body = this.buildCreateBody(params);
    const idempotencySupported = this.supportsNativeIdempotency();
    const requestOptions = {
      signal: params.signal,
      retry: idempotencySupported,
      idempotencyKey,
      postSubmit: true as const,
      isRetryable: idempotencySupported
        ? isMyFatoorahRetryableNetworkError
        : isMyFatoorahRetryableBeforeSubmit,
    };
    if (params.signal?.aborted) {
      throw new PaymentAbortedError("MyFatoorah API request aborted by caller signal");
    }
    markSubmitted();
    try {
      const { data, raw } = await this.myfatoorahRequest("POST", "/v3/payments", body, requestOptions);
      return this.mapCreateResult(data, raw, params.currency.trim().toUpperCase());
    } catch (error) {
      if (!hasMyFatoorahIdempotencyValidationError(error)) throw error;
      // Retry a rejected header once; headerless mutations cannot be retried
      // after transport errors because the provider may have accepted them.
      const { data, raw } = await this.myfatoorahRequest("POST", "/v3/payments", body, {
        signal: params.signal,
        retry: false,
        postSubmit: true,
      });
      return this.mapCreateResult(data, raw, params.currency.trim().toUpperCase());
    }
  }

  private buildCreateBody(params: MyFatoorahCreatePaymentParams): Record<string, unknown> {
    const currency = params.currency.trim().toUpperCase();
    if (currency.length !== 3 || !CURRENCY_CODE.test(currency)) {
      throw new InvalidRequestError(
        `MyFatoorah createPayment currency "${currency}" is not a 3-letter code`,
      );
    }
    const webhookUrl = this.resolveWebhookUrl(params);
    const body: Record<string, unknown> = {
      Order: {
        Amount: this.myfatoorahOutboundMajor(params.amount, currency),
        Currency: currency,
        // Order.ExternalIdentifier is returned as Invoice.ExternalIdentifier in PAYMENT_STATUS_CHANGED webhooks
        // for merchant paymentId correlation (Critical 12) — use orderId here.
        ...(params.orderId !== undefined && params.orderId.trim().length > 0
          ? { ExternalIdentifier: params.orderId.trim() }
          : {}),
      },
      IntegrationUrls: {
        Redirection: params.callbackUrl.trim(),
        ...(webhookUrl !== undefined ? { Webhook: webhookUrl } : {}),
      },
    };
    const method = params.myfatoorahPaymentMethod ?? this.myfatoorahConfig.defaultPaymentMethod;
    if (method !== undefined) {
      assertMyFatoorahPaymentMethod(method);
      body.PaymentMethod = method;
    }
    const customer = this.serializeCustomer(params);
    // Official payment webhook Invoice.ExternalIdentifier is populated from Customer.Reference
    // (CustomerIdentifier). To make `orderId` reliably appear as webhook `paymentId`,
    // we send it as Customer.Reference when no explicit customer reference exists.
    // Keep Order.ExternalIdentifier for back-compat.
    let customerForBody = customer;
    const orderRef = params.orderId !== undefined ? params.orderId.trim() : "";
    if (orderRef.length > 0) {
      if (customerForBody === undefined) {
        customerForBody = { Reference: orderRef };
      } else if (
        typeof customerForBody.Reference !== "string" ||
        (customerForBody.Reference as string).trim().length === 0
      ) {
        customerForBody = { ...customerForBody, Reference: orderRef };
      }
    }
    if (customerForBody !== undefined) body.Customer = customerForBody;
    if (params.myfatoorahLanguage !== undefined) {
      if (params.myfatoorahLanguage !== "EN" && params.myfatoorahLanguage !== "AR") {
        throw new InvalidRequestError('MyFatoorah myfatoorahLanguage must be "EN" or "AR"');
      }
      body.Language = params.myfatoorahLanguage;
    }
    if (
      params.myfatoorahDisplayPaymentMethods !== undefined &&
      params.myfatoorahDisplayPaymentMethods.length > 0
    ) {
      assertMyFatoorahDisplayPaymentMethods(params.myfatoorahDisplayPaymentMethods);
      body.DisplayPaymentMethods = params.myfatoorahDisplayPaymentMethods;
    }
    const sourceOfFund = this.buildSourceOfFund(params);
    if (sourceOfFund !== undefined) body.SourceOfFund = sourceOfFund;
    const metaData = this.toMyFatoorahMetaData(params.metadata);
    if (metaData !== undefined) body.MetaData = metaData;
    return body;
  }

  private resolveWebhookUrl(params: MyFatoorahCreatePaymentParams): string | undefined {
    const override = params.myfatoorahWebhookUrl;
    if (override !== undefined) {
      assertMyFatoorahHttpsUrl(override, "myfatoorahWebhookUrl");
      return override.trim();
    }
    return this.myfatoorahConfig.webhookUrl;
  }

  private serializeCustomer(
    params: MyFatoorahCreatePaymentParams,
  ): Record<string, unknown> | undefined {
    const customer = params.myfatoorahCustomer;
    if (customer !== undefined) {
      const out: Record<string, unknown> = {};
      if (customer.name !== undefined && customer.name.trim().length > 0) {
        out.Name = customer.name.trim();
      }
      if (customer.email !== undefined && customer.email.trim().length > 0) {
        out.Email = customer.email.trim();
      }
      if (customer.mobile !== undefined) {
        out.Mobile = {
          CountryCode: customer.mobile.countryCode,
          Number: customer.mobile.number,
        };
      }
      if (customer.reference !== undefined && customer.reference.trim().length > 0) {
        out.Reference = customer.reference.trim();
      }
      if (customer.civilId !== undefined && customer.civilId.trim().length > 0) {
        out.CivilId = customer.civilId.trim();
      }
      // Avoid emitting empty Customer:{} which provider may reject.
      if (Object.keys(out).length === 0) return undefined;
      return out;
    }
    // Customer.Reference is the webhook paymentId (Invoice.ExternalIdentifier).
    // Per official V3 it must be orderId or explicit myfatoorahCustomer.reference — never customerId.
    // buildCreateBody already injects orderId as Customer.Reference when needed; serializeCustomer
    // therefore must NOT map customerId → Reference. Use sources.ts/resolveMyFatoorahCustomerReference
    // for the canonical priority logic.
    return undefined;
  }

  private customerReferenceForReplay(params: MyFatoorahCreatePaymentParams): string | undefined {
    return resolveMyFatoorahCustomerReference({
      orderId: params.orderId,
      myfatoorahCustomerReference: params.myfatoorahCustomer?.reference,
    });
  }

  /** Only typed not-found (HTTP 404 or official 2xx empty inquiry) may create. */
  private isCreateReplayNotFound(error: unknown): boolean {
    return error instanceof ResourceNotFoundError;
  }

  /** Reuse only when the existing invoice amount is in the request currency and equals it. */
  private replayInvoiceMatchesRequest(
    data: Record<string, unknown>,
    params: MyFatoorahCreatePaymentParams,
  ): boolean {
    const mapped = this.mapGetPaymentResult(data, data);
    if (mapped.amount === undefined || mapped.currency === undefined) return false;
    const requested = normalizeMyFatoorahCurrency(params.currency) ?? params.currency.trim().toUpperCase();
    const retrieved =
      normalizeMyFatoorahCurrency(mapped.currency) ?? mapped.currency.trim().toUpperCase();
    if (requested !== retrieved) return false;
    const amountCurrency =
      normalizeMyFatoorahCurrency(mapped.amount.currency) ??
      mapped.amount.currency.trim().toUpperCase();
    if (amountCurrency !== retrieved) return false;
    try {
      const requestedMinor = toMinorUnits(
        parseMyFatoorahAmount(this.myfatoorahOutboundMajor(params.amount, requested), requested),
      );
      const retrievedMinor = toMinorUnits(mapped.amount);
      return requestedMinor === retrievedMinor;
    } catch {
      return false;
    }
  }

  private buildSourceOfFund(
    params: MyFatoorahCreatePaymentParams,
  ): Record<string, unknown> | undefined {
    const sessionId = params.myfatoorahSessionId;
    const token = params.myfatoorahToken;
    const hasSession = typeof sessionId === "string" && sessionId.trim().length > 0;
    const hasToken = typeof token === "string" && token.trim().length > 0;
    if (hasSession && hasToken) {
      throw new InvalidRequestError(
        "MyFatoorah createPayment accepts only one of myfatoorahSessionId or myfatoorahToken",
      );
    }
    if (hasSession) return { SessionId: sessionId!.trim() };
    if (hasToken) return { Token: token!.trim() };
    return undefined;
  }

  private toMyFatoorahMetaData(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, string> | undefined {
    if (metadata === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!/^UDF[1-5]$/.test(key)) {
        throw new InvalidRequestError(`MyFatoorah metadata keys must be UDF1..UDF5 (got "${key}")`);
      }
      if (typeof value !== "string") {
        throw new InvalidRequestError(`MyFatoorah metadata ${key} must be a string`);
      }
      if (value.length > 0) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private mapCreateResult(
    data: Record<string, unknown>,
    raw: unknown,
    requestCurrency: string,
  ): GatewayPaymentResult {
    const invoiceId = this.requireInvoiceId(data);
    const paymentCompletedRaw = data.PaymentCompleted;
    const paymentCompleted =
      paymentCompletedRaw === true ||
      (typeof paymentCompletedRaw === "string" && paymentCompletedRaw.trim().toLowerCase() === "true");
    const paymentUrl = typeof data.PaymentURL === "string" ? data.PaymentURL.trim() : "";

    // Official V3 paid body nests Invoice status under TransactionDetails.Invoice.Status
    // (legacy: top-level InvoiceStatus). PaymentCompleted is authoritative per V3 for
    // non-3DS paid completions; nested statuses are only for providerNativeStatus.
    const transactionDetails = asRecord(data.TransactionDetails);
    const legacyInvoiceStatusRaw =
      typeof data.InvoiceStatus === "string" ? data.InvoiceStatus.trim() : "";
    const nestedInvoice = asRecord(transactionDetails.Invoice);
    const invoiceStatusRaw =
      (typeof nestedInvoice.Status === "string" ? nestedInvoice.Status.trim() : "") ||
      legacyInvoiceStatusRaw;

    // MF-PAYMENTCOMPLETED-REDIRECT: PaymentCompleted true is definitive paid evidence
    // even when nested statuses are missing; PaymentURL then is Result URL, not checkout.
    const paidEvidence = paymentCompleted;
    const paymentId = this.paymentIdFromData(data);
    const references = buildProviderReferences({
      gateway: "myfatoorah",
      gatewayId: invoiceId,
      status: paidEvidence ? "paid" : "pending",
      providerNativeStatus: invoiceStatusRaw,
      ...(paymentId !== undefined ? { relatedIds: { paymentId } } : {}),
    });

    const amount = paidEvidence
      ? this.createResultAmount(transactionDetails, requestCurrency)
      : undefined;

    if (paidEvidence) {
      return applyOutcomeToGatewayResult(
        {
          gateway: "myfatoorah",
          gatewayId: invoiceId,
          status: "paid",
          redirectUrl: undefined,
          rawResponse: raw,
          references,
          providerNativeStatus: invoiceStatusRaw,
          ...(amount !== undefined ? { amount } : {}),
          ...(amount !== undefined ? { currency: requestCurrency } : {}),
        },
        "succeeded",
      );
    }

    if (paymentUrl.length > 0) {
      return applyOutcomeToGatewayResult(
        {
          gateway: "myfatoorah",
          gatewayId: invoiceId,
          status: "pending",
          redirectUrl: paymentUrl,
          rawResponse: raw,
          references,
          providerNativeStatus: invoiceStatusRaw,
        },
        "requires_action",
        { action: { type: "redirect" as const, url: paymentUrl } },
      );
    }

    throw new NetworkError(
      "MyFatoorah create response missing PaymentURL and paid evidence",
      { body: raw },
      { afterProviderSubmit: true },
    );
  }

  /** Amount in request currency; picks the matching ValueIn* field by currency. */
  private createResultAmount(
    transactionDetails: Record<string, unknown>,
    currency: string,
  ): import("@paykernel/core").Money | undefined {
    const amount = asRecord(transactionDetails.Amount);
    const requested = normalizeMyFatoorahCurrency(currency) ?? currency.trim().toUpperCase();
    const payCurrency =
      normalizeMyFatoorahCurrency(amount.PayCurrency) ??
      (typeof amount.PayCurrency === "string"
        ? amount.PayCurrency.trim().toUpperCase()
        : undefined);
    const displayCurrency =
      normalizeMyFatoorahCurrency(amount.DisplayCurrency) ??
      (typeof amount.DisplayCurrency === "string"
        ? amount.DisplayCurrency.trim().toUpperCase()
        : undefined);
    const baseCurrency =
      normalizeMyFatoorahCurrency(amount.BaseCurrency) ??
      (typeof amount.BaseCurrency === "string"
        ? amount.BaseCurrency.trim().toUpperCase()
        : undefined);
    let value: unknown;
    if (
      payCurrency !== undefined &&
      payCurrency === requested &&
      amount.ValueInPayCurrency !== undefined
    ) {
      value = amount.ValueInPayCurrency;
    } else if (
      displayCurrency !== undefined &&
      displayCurrency === requested &&
      amount.ValueInDisplayCurrency !== undefined
    ) {
      value = amount.ValueInDisplayCurrency;
    } else if (
      baseCurrency !== undefined &&
      baseCurrency === requested &&
      amount.ValueInBaseCurrency !== undefined
    ) {
      value = amount.ValueInBaseCurrency;
    } else {
      // MF-CREATE-AMOUNT-FALLBACK: if no ValueIn* currency matched request, omit amount.
      // Do not use bare Value/Amount as request currency — avoids publishing KWD base as SAR, etc.
      return undefined;
    }
    return this.parseMajor(value, currency);
  }

  private paymentIdFromData(data: Record<string, unknown>): string | undefined {
    const td = asRecord(data.TransactionDetails);
    return (
      stringOrNumberId(data.PaymentId) ??
      stringOrNumberId(td.PaymentId) ??
      stringOrNumberId(asRecord(td.Transaction).PaymentId) ??
      stringOrNumberId(asRecord(td.Invoice).PaymentId)
    );
  }

  private requireInvoiceId(data: Record<string, unknown>): string {
    const id = data.InvoiceId;
    if (typeof id === "string" && id.trim().length > 0) return id.trim();
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    throw new NetworkError(
      "MyFatoorah create response missing InvoiceId",
      { body: data },
      { afterProviderSubmit: true },
    );
  }

  // ─── GetPayment helpers ─────────────────────────────────────────────────

  private mapGetPaymentResult(data: Record<string, unknown>, raw: unknown): GatewayPaymentResult {
    const invoiceId = stringOrNumberId(data.InvoiceId);
    if (invoiceId === undefined) {
      throw new InvalidRequestError("MyFatoorah GetPaymentStatus response missing InvoiceId");
    }
    const invoiceStatusRaw = typeof data.InvoiceStatus === "string" ? data.InvoiceStatus : "";
    const invoiceStatus = mapMyFatoorahInvoiceStatus(invoiceStatusRaw);
    const successTransaction = this.successTransaction(data);

    // A pending invoice stays pending even when the latest transaction
    // failed — the customer can retry the same invoice.
    // Official: invoice is Paid only when a SUCCESS/SUCCSS transaction exists.
    // InvoiceStatus=Paid without that evidence is not fulfillable.
    const status =
      invoiceStatus === "pending" ||
      (invoiceStatus === "paid" && successTransaction === undefined)
        ? "pending"
        : invoiceStatus === "paid"
          ? "paid"
          : invoiceStatus;

    // Amount: MF-GETPAYMENT-BASE-MIX — never pair InvoiceValue (base) with transaction pay Currency.
    // Prefer PaidCurrency/PaidCurrencyValue, else TransationValue/Currency (transaction Currency), else InvoiceValue with base Currency field.
    let currency: string | undefined;
    let amount: import("@paykernel/core").Money | undefined;
    if (successTransaction !== undefined) {
      const paidCurrency = normalizeMyFatoorahCurrency(successTransaction.PaidCurrency);
      const paidValue = successTransaction.PaidCurrencyValue;
      if (paidCurrency !== undefined && paidValue !== undefined) {
        const parsedPaid = this.parseMajor(paidValue, paidCurrency);
        if (parsedPaid !== undefined) {
          currency = paidCurrency;
          amount = parsedPaid;
        }
      }
      if (currency === undefined) {
        const txCurrency = normalizeMyFatoorahCurrency(successTransaction.Currency);
        const txValue = successTransaction.TransationValue;
        if (txCurrency !== undefined && txValue !== undefined) {
          const parsedTx = this.parseMajor(txValue, txCurrency);
          if (parsedTx !== undefined) {
            currency = txCurrency;
            amount = parsedTx;
          }
        }
      }
      if (currency === undefined) {
        const invoiceAmount = this.invoiceValue(data);
        if (invoiceAmount !== undefined) {
          const baseCurrency =
            normalizeMyFatoorahCurrency((data as Record<string, unknown>).Currency) ??
            normalizeMyFatoorahCurrency((data as Record<string, unknown>).BaseCurrency) ??
            normalizeMyFatoorahCurrency((data as Record<string, unknown>).InvoiceCurrency) ??
            (this.myfatoorahConfig.live === true
              ? MYFATOORAH_COUNTRY_CURRENCY[this.myfatoorahConfig.country]
              : "KWD");
          // Guard: if PaidCurrency was missing, we must not have already used InvoiceValue+SAR via tier2.
          // Tier2 already handled pay currency via TransationValue, so tier3 uses base only.
          if (baseCurrency !== undefined) {
            const parsedBase = this.parseMajor(invoiceAmount, baseCurrency);
            if (parsedBase !== undefined) {
              currency = baseCurrency;
              amount = parsedBase;
            }
          }
        }
      }
    }
    const transactionPaymentId = this.successTransactionPaymentId(successTransaction);
    const references = buildProviderReferences({
      gateway: "myfatoorah",
      gatewayId: invoiceId,
      status,
      providerNativeStatus: invoiceStatusRaw,
      ...(transactionPaymentId !== undefined
        ? { relatedIds: { paymentId: transactionPaymentId } }
        : {}),
    });

    return applyOutcomeToGatewayResult(
      {
        gateway: "myfatoorah",
        gatewayId: invoiceId,
        status,
        redirectUrl: undefined,
        rawResponse: raw,
        references,
        providerNativeStatus: invoiceStatusRaw,
        ...(amount !== undefined ? { amount } : {}),
        ...(currency !== undefined ? { currency } : {}),
      },
      mapMyFatoorahInvoiceOutcome(status),
    );
  }

  private successTransaction(data: Record<string, unknown>): Record<string, unknown> | undefined {
    const candidates: unknown[] | undefined =
      (Array.isArray(data.InvoiceTransactions) ? data.InvoiceTransactions : undefined) ??
      (Array.isArray(data.Transactions) ? data.Transactions : undefined);
    if (candidates === undefined) return undefined;
    let lastMatch: Record<string, unknown> | undefined;
    for (const transaction of candidates) {
      const rec = asRecord(transaction);
      if (mapMyFatoorahTransactionEvidence(rec.TransactionStatus) === "success") {
        lastMatch = rec;
      }
    }
    return lastMatch;
  }
  private successTransactionPaymentId(
    transaction: Record<string, unknown> | undefined,
  ): string | undefined {
    if (transaction === undefined) return undefined;
    return stringOrNumberId(transaction.PaymentId);
  }

  private invoiceValue(data: Record<string, unknown>): unknown {
    return data.InvoiceValue;
  }

  private parseMajor(value: unknown, currency: string): import("@paykernel/core").Money | undefined {
    try {
      if (
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.trim().length > 0)
      ) {
        return parseMyFatoorahAmount(value, currency);
      }
    } catch {
      // Unparseable invoice value: omit amount rather than guess.
    }
    return undefined;
  }

  private refundCurrency(
    params: MyFatoorahRefundParams,
    refundStatus?: Record<string, unknown>,
  ): string {
    // MakeRefund Amount is account base currency (e.g. KWD), not display/pay currency (e.g. SAR).
    // Prefer BaseCurrency from GetRefundStatus RefundStatusResult when available.
    if (refundStatus !== undefined) {
      const baseFromRefund = myFatoorahRefundBaseCurrency(refundStatus);
      const normalizedBase =
        baseFromRefund !== undefined ? normalizeMyFatoorahCurrency(baseFromRefund) : undefined;
      if (normalizedBase !== undefined) {
        const requested = typeof params.currency === "string" ? params.currency.trim() : "";
        if (requested.length > 0) {
          const normReq = normalizeMyFatoorahCurrency(requested) ?? requested.trim().toUpperCase();
          if (normReq !== normalizedBase) {
            throw new InvalidRequestError(
              `MyFatoorah refund currency "${requested}" does not match account base currency "${normalizedBase}" (MakeRefund is base-only; see docs/refunds.md)`,
            );
          }
        }
        return normalizedBase;
      }
    }
    // No BaseCurrency yet (first refund, empty history): the portal country fixes the base currency.
    // Sandbox always KWD (country host is ignored there).
    const inferredBase =
      this.myfatoorahConfig.live === true
        ? MYFATOORAH_COUNTRY_CURRENCY[this.myfatoorahConfig.country]
        : "KWD";
    const requested = typeof params.currency === "string" ? params.currency.trim() : "";
    if (requested.length > 0) {
      const normReq = normalizeMyFatoorahCurrency(requested);
      if (normReq === undefined) {
        throw new InvalidRequestError(
          `MyFatoorah refund currency "${requested}" is not a 3-letter code`,
        );
      }
      if (normReq !== inferredBase) {
        throw new InvalidRequestError(
          `MyFatoorah refund currency "${requested}" does not match account base currency "${inferredBase}" (MakeRefund is base-only; see docs/refunds.md)`,
        );
      }
      return normReq;
    }
    return inferredBase;
  }

  private assertCurrencyMatch(
    requested: string | undefined,
    retrieved: string,
    operation: "refund",
  ): void {
    if (!currenciesMismatch(requested, retrieved)) return;
    throw new InvalidRequestError(
      `MyFatoorah ${operation} currency "${String(requested)}" does not match retrieved currency "${String(retrieved)}"`,
    );
  }
  private async postMyFatoorahRefund(input: {
    invoiceId: string;
    keyType: "InvoiceId" | "PaymentId";
    amount: number;
    currency: string;
    params: MyFatoorahRefundParams;
    idempotencyKey: string;
  }): Promise<GatewayRefundResult> {
    const comment = this.refundComment(input.params);
    const body: Record<string, unknown> = {
      KeyType: input.keyType,
      Key: input.invoiceId,
      ServiceChargeOnCustomer: false,
      Amount: input.amount,
      ExternalIdentifier: input.idempotencyKey,
      ...(comment !== undefined ? { Comment: comment } : {}),
    };
    const requestOptions = {
      signal: input.params.signal,
      retry: true,
      idempotencyKey: input.idempotencyKey,
      postSubmit: true,
      currency: input.currency,
      isRetryable: isMyFatoorahRetryableBeforeSubmit,
    };
    try {
      const { data, raw } = await this.myfatoorahRequest(
        "POST",
        "/v2/MakeRefund",
        body,
        requestOptions,
      );
      return this.mapMakeRefundResult(data, raw);
    } catch (error) {
      // Contingency: the Idempotency-Key header is only honored in KWT/SAU.
      // On a provider validation rejection elsewhere, retry once without the
      // header; `ExternalIdentifier` still carries the caller key for replay.
      if (!hasMyFatoorahIdempotencyValidationError(error)) throw error;
      const retryWithoutHeader = {
        signal: requestOptions.signal,
        retry: false as const,
        postSubmit: requestOptions.postSubmit,
        currency: requestOptions.currency,
      };
      const { data, raw } = await this.myfatoorahRequest(
        "POST",
        "/v2/MakeRefund",
        body,
        retryWithoutHeader,
      );
      return this.mapMakeRefundResult(data, raw);
    }
  }

  private refundComment(params: MyFatoorahRefundParams): string | undefined {
    const raw = params.myfatoorahComment ?? params.reason;
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length > MYFATOORAH_REFUND_COMMENT_MAX) {
      throw new InvalidRequestError(
        `MyFatoorah refund comment must be ${MYFATOORAH_REFUND_COMMENT_MAX} characters or fewer`,
      );
    }
    return trimmed;
  }

  private mapMakeRefundResult(data: Record<string, unknown>, raw: unknown): GatewayRefundResult {
    const refundId = myFatoorahRefundId(data);
    if (refundId === undefined) {
      throw new NetworkError(
        "MyFatoorah refund response missing RefundId",
        { body: raw },
        { afterProviderSubmit: true },
      );
    }
    // MakeRefund acceptance is never settlement. Completed status arrives via
    // REFUND_STATUS_CHANGED or GetRefundStatus `Refunded`.
    return applyOutcomeToGatewayRefundResult(
      {
        gatewayRefundId: refundId,
        status: "pending",
        rawResponse: raw,
      },
      "pending",
    );
  }

  private mapNestedRefundObject(raw: unknown): GatewayRefundResult {
    const refundId = myFatoorahRefundId(raw);
    if (refundId === undefined) {
      throw new InvalidRequestError("MyFatoorah refund object missing RefundId");
    }
    const entityStatus = mapMyFatoorahRefundEntityStatus(myFatoorahRefundStatus(raw));
    const outcome =
      entityStatus === "completed"
        ? "succeeded"
        : entityStatus === "pending"
          ? "pending"
          : "failed";
    return applyOutcomeToGatewayRefundResult(
      {
        gatewayRefundId: refundId,
        status: entityStatus,
        rawResponse: raw,
      },
      outcome,
    );
  }

  // ─── Shared validation helpers ──────────────────────────────────────────

  private myfatoorahOutboundMajor(
    amount: import("@paykernel/core").Money,
    currency: string,
  ): number {
    const major = myFatoorahMajorNumber(amount, currency);
    if (major === 0) {
      throw new InvalidRequestError("MyFatoorah amount must be greater than 0");
    }
    return major;
  }

  private assertMutationKey(key: string | undefined, operation: string): string {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new InvalidRequestError(`MyFatoorah ${operation} requires idempotencyKey`);
    }
    return key.trim();
  }

  private resolveRefundKey(params: MyFatoorahRefundParams): {
    key: string;
    keyType: "InvoiceId" | "PaymentId";
  } {
    const keyType = params.myfatoorahKeyType ?? "InvoiceId";
    if (keyType !== "InvoiceId" && keyType !== "PaymentId") {
      throw new InvalidRequestError(
        'MyFatoorah myfatoorahKeyType must be "InvoiceId" or "PaymentId"',
      );
    }
    const key = this.assertInvoiceId(params.gatewayPaymentId, "refundPayment");
    // InvoiceId guard: real InvoiceIds are ~6-10 digits per fixtures, PaymentId
    // 14–20 digits. Length >=14 heuristic treats long id as PaymentId; future
    // growth beyond 14 would need myfatoorahKeyType override. Error hints at
    // myfatoorahKeyType. Alternative heuristic: check "07" prefix or length>12
    // and not all zeros — kept minimal per assignment.
    if (keyType === "InvoiceId" && key.length >= 14) {
      throw new InvalidRequestError(
        `MyFatoorah refundPayment gatewayPaymentId "${key}" looks like a PaymentId (use myfatoorahKeyType: "PaymentId" for the callback paymentId)`,
      );
    }
    return { key, keyType };
  }

  private assertInvoiceId(id: string, operation: string): string {
    const trimmed = id.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new InvalidRequestError(
        `MyFatoorah ${operation} expects an InvoiceId (digits) as gatewayPaymentId (got "${id}")`,
      );
    }
    return trimmed;
  }
}
