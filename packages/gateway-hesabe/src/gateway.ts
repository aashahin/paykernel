import {
  applyIndeterminatePaymentOutcome,
  applyIndeterminateRefundOutcome,
  BaseGateway,
  InvalidRequestError,
  NetworkError,
  OperationNotSupportedError,
  ResourceNotFoundError,
  sha256Hex,
  toMinorUnits,
  type CaptureParams,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type GatewayRuntimeDeps,
  type HooksManager,
  type Logger,
  type Money,
  type WebhookEvent,
} from "@paykernel/core";
import { HesabeAuth } from "./auth";
import { HESABE_CAPABILITIES } from "./capabilities";
import {
  copyHesabeConfig,
  HESABE_DEFAULT_TIMEOUT_MS,
  resolveHesabeCheckoutBaseUrl,
  resolveHesabeMerchantBaseUrl,
  type HesabeConfig,
} from "./config";
import { hesabeDecryptJson, hesabeEncrypt } from "./crypto";
import { hesabeReadRequest, hesabeRequest } from "./gateway-http";
import { withHesabeReservation } from "./reservations";
import {
  assertHesabeKwdCurrency,
  hesabeDecimalKwd,
  parseHesabeKwdAmount,
  toHesabeKwd,
} from "./money";
import { buildHesabeCheckout, requiredString, transactionToken } from "./payload";
import {
  hesabeTransactionResult,
  parseHesabeCheckout,
  parseHesabeRefund,
  parseHesabeTransaction,
} from "./payment-map";
import { isHesabeCallbackSuccess, mapHesabeEnquiryStatus } from "./status";
import type {
  HesabeCallbackParams,
  HesabeCreatePaymentParams,
  HesabeGetPaymentParams,
  HesabeGetRefundParams,
  HesabeRefundParams,
} from "./types";
import {
  checkedHesabeWebhookFields,
  parseHesabeWebhookEvent,
  type HesabeCheckedWebhook,
} from "./webhooks";

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function assertRefundId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError("Hesabe getRefund requires a numeric gatewayRefundId");
  }
  const id = value.trim();
  if (!/^[0-9]+$/.test(id)) {
    throw new InvalidRequestError("Hesabe getRefund requires a numeric gatewayRefundId");
  }
  const numeric = Number(id);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new InvalidRequestError("Hesabe getRefund requires a positive numeric gatewayRefundId");
  }
  return String(numeric);
}

/**
 * Decode an encrypted Hesabe response body: bare hex, a JSON string of hex,
 * or an object `{response: hex}`. Anything else is a protocol failure.
 */
function extractResponseHex(responseText: string): string {
  const trimmed = responseText.trim();
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed) as unknown;
  } catch {
    // Bare ciphertext is the other documented response encoding.
    if (trimmed.length > 0) return trimmed;
  }
  const hex = typeof envelope === "string" ? envelope : asRecord(envelope).response;
  if (typeof hex === "string" && hex.trim().length > 0) return hex.trim();
  throw new NetworkError("Hesabe API returned an unusable encrypted response");
}

type EncryptedMutation = {
  url: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  accessToken?: string;
  onSubmit: () => void;
};

export class HesabeGateway extends BaseGateway {
  readonly name = "hesabe" as const;
  private readonly hesabeConfig: HesabeConfig;
  private authInstance: HesabeAuth | undefined;
  private readonly verifiedWebhooks = new WeakMap<object, HesabeCheckedWebhook>();

  constructor(
    config: HesabeConfig,
    hooks: HooksManager,
    logger?: Logger,
    runtime?: GatewayRuntimeDeps,
  ) {
    const closed = copyHesabeConfig(config);
    super(closed, hooks, logger, HESABE_CAPABILITIES, runtime);
    this.hesabeConfig = closed;
  }

  private auth(): HesabeAuth {
    if (this.authInstance === undefined) {
      this.authInstance = new HesabeAuth({
        fetch: this.fetch,
        clock: this.clock,
        merchantBaseUrl: resolveHesabeMerchantBaseUrl(this.hesabeConfig),
        username: this.hesabeConfig.username,
        password: this.hesabeConfig.password,
        timeoutMs: this.hesabeConfig.timeoutMs ?? HESABE_DEFAULT_TIMEOUT_MS,
      });
    }
    return this.authInstance;
  }

  private timeoutMs(): number {
    return this.hesabeConfig.timeoutMs ?? HESABE_DEFAULT_TIMEOUT_MS;
  }

  async createPayment(params: HesabeCreatePaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("createPayment", params, async (p) => {
      const built = buildHesabeCheckout(p, this.hesabeConfig);
      const checkoutBaseUrl = resolveHesabeCheckoutBaseUrl(this.hesabeConfig);
      const orderId = built.orderId;
      const key = sha256Hex(
        JSON.stringify([
          "hesabe",
          checkoutBaseUrl,
          this.hesabeConfig.merchantCode,
          "create",
          built.idempotencyKey,
        ]),
      );
      return withHesabeReservation(
        {
          store: this.hesabeConfig.idempotencyStore,
          key,
          fingerprintInput: built.payload,
          createdAt: this.clock.nowMs(),
        },
        async (markSubmitted) => {
          try {
            return await this.postEncrypted(
              {
                url: `${checkoutBaseUrl}/checkout`,
                payload: built.payload,
                signal: p.signal,
                onSubmit: markSubmitted,
              },
              (envelope) =>
                parseHesabeCheckout(envelope, {
                  orderId,
                  amount: built.amount,
                  baseUrl: checkoutBaseUrl,
                }),
            );
          } catch (error) {
            if (!(error instanceof NetworkError) || !error.afterProviderSubmit) throw error;
            return applyIndeterminatePaymentOutcome({
              gateway: "hesabe",
              gatewayId: `checkout:unknown:${orderId}`,
              message: "Hesabe checkout submission is indeterminate; reconcile before retrying",
              errorName: error.name,
            });
          }
        },
      );
    });
  }

  async getPayment(params: HesabeGetPaymentParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("getPayment", params, async (p) => {
      const token = transactionToken(p.gatewayPaymentId);
      const signal = p.signal;
      const transaction = await this.enquireTransaction(token, signal);
      return hesabeTransactionResult(transaction);
    });
  }

  async refundPayment(params: HesabeRefundParams): Promise<GatewayRefundResult> {
    return this.executeWithHooks("refundPayment", params, async (p) => {
      const idempotencyKey = requiredString(p.idempotencyKey, "idempotencyKey");
      const token = transactionToken(p.gatewayPaymentId);
      let canonical: Money | undefined;
      if (p.amount !== undefined) {
        const currency = p.currency ?? p.amount.currency;
        canonical = toHesabeKwd(p.amount, currency);
      } else if (p.currency !== undefined) {
        assertHesabeKwdCurrency(p.currency);
      }
      const refundMethod = canonical !== undefined ? "2" : "1";
      const fingerprintInput = {
        token,
        amount: canonical !== undefined ? hesabeDecimalKwd(canonical) : null,
        currency: "KWD",
        refundMethod,
      };
      const merchantBase = resolveHesabeMerchantBaseUrl(this.hesabeConfig);
      const key = sha256Hex(
        JSON.stringify([
          "hesabe",
          merchantBase,
          this.hesabeConfig.merchantCode,
          "refund",
          idempotencyKey,
        ]),
      );
      const signal = p.signal;
      return withHesabeReservation(
        {
          store: this.hesabeConfig.idempotencyStore,
          key,
          fingerprintInput,
          createdAt: this.clock.nowMs(),
        },
        async (markSubmitted) => {
          const transaction = await this.enquireTransaction(token, signal);
          const confirmed = hesabeTransactionResult(transaction);
          if (confirmed.outcome === "indeterminate") {
            throw new NetworkError(
              "Hesabe could not determine the original payment state; retry enquiry before refunding",
            );
          }
          if (confirmed.status !== "paid") {
            throw new InvalidRequestError("Hesabe refund requires a successful paid transaction");
          }
          let refundAmountMoney: Money;
          if (canonical !== undefined) {
            const totalMinor = toMinorUnits(transaction.amount);
            const requestedMinor = toMinorUnits(canonical);
            if (requestedMinor > totalMinor) {
              throw new InvalidRequestError("Hesabe refund amount exceeds the transaction amount");
            }
            refundAmountMoney = canonical;
          } else {
            refundAmountMoney = transaction.amount;
          }
          const accessToken = await this.auth().getAccessToken(signal);
          const refundPayload = {
            merchantCode: this.hesabeConfig.merchantCode,
            refundAmount: hesabeDecimalKwd(refundAmountMoney),
            refundMethod,
            token,
          };
          try {
            return await this.postEncrypted(
              {
                url: `${merchantBase}/api/v1/refund`,
                payload: refundPayload,
                accessToken,
                signal,
                onSubmit: markSubmitted,
              },
              (envelope) => parseHesabeRefund(envelope, { token, amount: refundAmountMoney }),
            );
          } catch (error) {
            if (!(error instanceof NetworkError) || !error.afterProviderSubmit) throw error;
            return applyIndeterminateRefundOutcome({
              gatewayRefundId: "unknown",
              message: "Hesabe refund submission is indeterminate; reconcile before retrying",
              errorName: error.name,
            });
          }
        },
      );
    });
  }

  async getRefund(params: HesabeGetRefundParams): Promise<GatewayRefundResult> {
    const refundId = assertRefundId(params.gatewayRefundId);
    const signal = params.signal;
    const merchantBase = resolveHesabeMerchantBaseUrl(this.hesabeConfig);
    const timeoutMs = this.timeoutMs();
    const crypto = this.runtime.crypto;
    const encryptionKey = this.hesabeConfig.encryptionKey;
    const ivKey = this.hesabeConfig.ivKey;
    const accessToken = await this.auth().getAccessToken(signal);
    const enquiryHex = await hesabeEncrypt(
      JSON.stringify({ merchantCode: this.hesabeConfig.merchantCode }),
      encryptionKey,
      ivKey,
      crypto,
    );
    const responseText = await hesabeReadRequest({
      fetch: this.fetch,
      timeoutMs,
      url: `${merchantBase}/api/v1/refund/${refundId}?data=${encodeURIComponent(enquiryHex)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        accessCode: this.hesabeConfig.accessCode,
        Accept: "application/json",
      },
      ...(signal !== undefined ? { signal } : {}),
    });
    const responseHex = extractResponseHex(responseText);
    const envelope = await this.decryptResponse(responseHex);
    return parseHesabeRefund(envelope, { id: refundId });
  }

  async resolveCallback(params: HesabeCallbackParams): Promise<GatewayPaymentResult> {
    const rawData = params.data;
    if (typeof rawData !== "string" || rawData.trim().length === 0) {
      throw new InvalidRequestError("Hesabe callback requires encrypted data");
    }
    const crypto = this.runtime.crypto;
    const envelope = await hesabeDecryptJson(
      rawData.trim(),
      this.hesabeConfig.encryptionKey,
      this.hesabeConfig.ivKey,
      crypto,
    );
    if (asRecord(envelope).status !== true)
      throw new InvalidRequestError("Hesabe callback was not accepted");
    const nested = asRecord(asRecord(envelope).response).data;
    const record = asRecord(nested);
    const paymentToken = record.paymentToken;
    if (typeof paymentToken !== "string" || paymentToken.trim().length === 0) {
      throw new InvalidRequestError("Hesabe callback missing paymentToken");
    }
    const orderReferenceNumber = record.orderReferenceNumber;
    if (typeof orderReferenceNumber !== "string" || orderReferenceNumber.trim().length === 0) {
      throw new InvalidRequestError("Hesabe callback missing orderReferenceNumber");
    }
    const resultCode = record.resultCode;
    if (typeof resultCode !== "string" || resultCode.trim().length === 0) {
      throw new InvalidRequestError("Hesabe callback missing resultCode");
    }
    const callbackAmount = parseHesabeKwdAmount(record.amount);
    const token = paymentToken.trim();
    if (token.toLowerCase().startsWith("checkout:")) {
      throw new InvalidRequestError("Hesabe callback paymentToken is not a transaction token");
    }
    const transaction = await this.enquireTransaction(token, params.signal);
    if (transaction.token !== token) {
      throw new InvalidRequestError("Hesabe callback does not match transaction enquiry");
    }
    if (transaction.referenceNumber !== orderReferenceNumber.trim()) {
      throw new InvalidRequestError("Hesabe callback does not match transaction enquiry");
    }
    if (
      transaction.amount.amount !== callbackAmount.amount ||
      transaction.amount.currency !== callbackAmount.currency
    ) {
      throw new InvalidRequestError("Hesabe callback does not match transaction enquiry");
    }
    const confirmed = hesabeTransactionResult(transaction);
    if (isHesabeCallbackSuccess(resultCode)) {
      if (confirmed.status !== "paid") {
        throw new InvalidRequestError("Hesabe callback success does not match transaction enquiry");
      }
      return confirmed;
    }
    if (confirmed.status === "failed" || confirmed.status === "pending") {
      return confirmed;
    }
    throw new InvalidRequestError("Hesabe callback failure does not match transaction enquiry");
  }

  async capturePayment(params: CaptureParams): Promise<GatewayPaymentResult> {
    return this.executeWithHooks("capturePayment", params, async () => {
      throw new OperationNotSupportedError(this.name, "capturePayment", {
        capability: "authorization",
        claimedSupport: false,
      });
    });
  }

  verifyWebhook(
    _payload: unknown,
    _signature?: string,
    _headers?: Record<string, string>,
  ): boolean {
    return false;
  }

  async verifyWebhookAsync(
    payload: unknown,
    _signatureOrHeaders?: string | Record<string, string>,
    _headers?: Record<string, string>,
  ): Promise<boolean> {
    if (payload !== null && typeof payload === "object") this.verifiedWebhooks.delete(payload);
    let checked: HesabeCheckedWebhook;
    try {
      checked = checkedHesabeWebhookFields(payload);
    } catch {
      return false;
    }
    const snapshot = {
      token: checked.token,
      referenceNumber: checked.referenceNumber,
      amount: checked.amount.amount,
      currency: checked.amount.currency,
      status: checked.status,
    };
    let transaction: {
      token: string;
      referenceNumber: string;
      amount: Money;
      nativeStatus: string;
    };
    try {
      transaction = await this.enquireTransaction(checked.token, undefined);
    } catch (error) {
      if (error instanceof InvalidRequestError || error instanceof ResourceNotFoundError) {
        return false;
      }
      throw error;
    }
    const webhookStatus = snapshot.status.trim().toUpperCase();
    const enquiryStatus = transaction.nativeStatus.trim().toUpperCase();
    if (mapHesabeEnquiryStatus(webhookStatus) === undefined) return false;
    if (mapHesabeEnquiryStatus(enquiryStatus) === undefined) return false;
    if (webhookStatus !== enquiryStatus) return false;
    if (transaction.token !== snapshot.token) return false;
    if (transaction.referenceNumber !== snapshot.referenceNumber) return false;
    if (
      transaction.amount.amount !== snapshot.amount ||
      transaction.amount.currency !== snapshot.currency
    ) {
      return false;
    }
    let rechecked: HesabeCheckedWebhook;
    try {
      rechecked = checkedHesabeWebhookFields(payload);
    } catch {
      return false;
    }
    if (
      rechecked.token !== snapshot.token ||
      rechecked.referenceNumber !== snapshot.referenceNumber ||
      rechecked.amount.amount !== snapshot.amount ||
      rechecked.amount.currency !== snapshot.currency ||
      rechecked.status !== snapshot.status
    ) {
      return false;
    }
    if (payload !== null && typeof payload === "object")
      this.verifiedWebhooks.set(payload, checked);
    return true;
  }

  parseWebhookEvent(payload: unknown): WebhookEvent {
    const checked =
      payload !== null && typeof payload === "object"
        ? this.verifiedWebhooks.get(payload)
        : undefined;
    return parseHesabeWebhookEvent(
      checked
        ? {
            token: checked.token,
            amount: checked.amount.amount,
            reference_number: checked.referenceNumber,
            status: checked.status,
          }
        : payload,
      this.clock,
    );
  }

  private async postEncrypted<T>(
    request: EncryptedMutation,
    parseResponse: (envelope: unknown) => T,
  ): Promise<T> {
    const ciphertext = await hesabeEncrypt(
      JSON.stringify(request.payload),
      this.hesabeConfig.encryptionKey,
      this.hesabeConfig.ivKey,
      this.runtime.crypto,
    );
    const responseText = await hesabeRequest({
      fetch: this.fetch,
      timeoutMs: this.timeoutMs(),
      url: request.url,
      method: "POST",
      headers: {
        accessCode: this.hesabeConfig.accessCode,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(request.accessToken === undefined
          ? {}
          : { Authorization: `Bearer ${request.accessToken}` }),
      },
      body: JSON.stringify({ data: ciphertext }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onSubmit: request.onSubmit,
    });
    try {
      return parseResponse(await this.decryptResponse(extractResponseHex(responseText)));
    } catch (error) {
      if (error instanceof InvalidRequestError) throw error;
      // Once submitted, an unusable response cannot establish whether money moved.
      throw new NetworkError("Hesabe submission returned an unusable response", undefined, {
        afterProviderSubmit: true,
      });
    }
  }

  private async decryptResponse(hex: string): Promise<unknown> {
    try {
      return await hesabeDecryptJson(
        hex,
        this.hesabeConfig.encryptionKey,
        this.hesabeConfig.ivKey,
        this.runtime.crypto,
      );
    } catch {
      // A malformed provider response is a protocol failure, even when its
      // ciphertext fails the same validation used for caller-supplied callbacks.
      throw new NetworkError("Hesabe returned an invalid encrypted response");
    }
  }

  private async enquireTransaction(
    token: string,
    signal?: AbortSignal,
  ): Promise<{
    token: string;
    referenceNumber: string;
    amount: Money;
    nativeStatus: string;
  }> {
    const checkoutBaseUrl = resolveHesabeCheckoutBaseUrl(this.hesabeConfig);
    const responseText = await hesabeReadRequest({
      fetch: this.fetch,
      timeoutMs: this.timeoutMs(),
      url: `${checkoutBaseUrl}/api/transaction/${encodeURIComponent(token)}`,
      headers: {
        accessCode: this.hesabeConfig.accessCode,
        Accept: "application/json",
      },
      ...(signal !== undefined ? { signal } : {}),
    });
    let envelope: unknown;
    try {
      envelope = JSON.parse(responseText) as unknown;
    } catch {
      throw new NetworkError("Hesabe transaction enquiry returned invalid JSON");
    }
    return parseHesabeTransaction(envelope, token);
  }
}
