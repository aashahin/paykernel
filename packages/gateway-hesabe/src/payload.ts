import { InvalidRequestError, OperationNotSupportedError, type Money } from "@paykernel/core";
import { assertHesabeHttpsUrl, type HesabeConfig } from "./config";
import { toHesabeKwd } from "./money";
import type { HesabeCreatePaymentParams } from "./types";

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function transactionToken(value: unknown): string {
  const token = requiredString(value, "gatewayPaymentId");
  if (token.toLowerCase().startsWith("checkout:")) {
    throw new InvalidRequestError(
      "A Hesabe checkout ID cannot identify a transaction; use the confirmed paymentToken",
    );
  }
  return token;
}

const OPTIONAL_FIELDS = {
  hesabeName: "name",
  hesabeEmail: "email",
  hesabeMobileNumber: "mobile_number",
  hesabeVariable1: "variable1",
  hesabeVariable2: "variable2",
  hesabeVariable3: "variable3",
  hesabeVariable4: "variable4",
  hesabeVariable5: "variable5",
} as const;

export function buildHesabeCheckout(
  params: HesabeCreatePaymentParams,
  config: HesabeConfig,
): {
  payload: Record<string, unknown>;
  amount: Money;
  orderId: string;
  idempotencyKey: string;
} {
  if (params.capture === false) throw new OperationNotSupportedError("hesabe", "authorizePayment");
  if (params.capture !== undefined && typeof params.capture !== "boolean") {
    throw new InvalidRequestError("capture must be a boolean");
  }
  if (
    params.customerId !== undefined ||
    params.paymentMethodId !== undefined ||
    params.offSession === true
  ) {
    throw new OperationNotSupportedError("hesabe", "paymentMethods");
  }
  const amount = toHesabeKwd(params.amount, params.currency);
  const orderId = requiredString(params.orderId, "orderId");
  const idempotencyKey = requiredString(params.idempotencyKey, "idempotencyKey");
  assertHesabeHttpsUrl(params.callbackUrl, "callbackUrl");
  const failureUrl = params.hesabeFailureUrl ?? params.callbackUrl;
  assertHesabeHttpsUrl(failureUrl, "hesabeFailureUrl");
  const payload: Record<string, unknown> = {
    merchantCode: config.merchantCode,
    amount: amount.amount,
    currency: "KWD",
    paymentType: 0,
    version: "2.0",
    orderReferenceNumber: orderId,
    responseUrl: params.callbackUrl.trim(),
    failureUrl: failureUrl.trim(),
  };
  const webhookUrl = params.hesabeWebhookUrl ?? config.webhookUrl;
  if (webhookUrl !== undefined) {
    assertHesabeHttpsUrl(webhookUrl, "hesabeWebhookUrl");
    payload.webhookUrl = webhookUrl.trim();
  }
  for (const [source, target] of Object.entries(OPTIONAL_FIELDS)) {
    const value = params[source as keyof typeof OPTIONAL_FIELDS];
    if (value !== undefined) {
      if (typeof value !== "string") throw new InvalidRequestError(`${source} must be a string`);
      payload[target] = value;
    }
  }
  if (params.hesabeMobileNumber !== undefined && !/^\d{8}$/.test(params.hesabeMobileNumber)) {
    throw new InvalidRequestError(
      "hesabeMobileNumber must contain 8 digits without a country code",
    );
  }
  return { payload, amount, orderId, idempotencyKey };
}
