import type { CreatePaymentParams, GetPaymentParams, RefundParams } from "@paykernel/core";

/**
 * Typed Hesabe create payload. Extends the common create shape with
 * Hesabe-only fields. Do not add these keys to core `CreatePaymentParams`.
 */
export type HesabeCreatePaymentParams = CreatePaymentParams & {
  /** Customer display name sent as encrypted `name`. */
  hesabeName?: string;
  /** Customer email sent as encrypted `email`. */
  hesabeEmail?: string;
  /**
   * Customer mobile without country code: exactly 8 digits
   * (sent as encrypted `mobile_number`).
   */
  hesabeMobileNumber?: string;
  /** Per-request encrypted `webhookUrl` override. Must be HTTPS. */
  hesabeWebhookUrl?: string;
  /** Per-request `failureUrl` override (default: `callbackUrl`). Must be HTTPS. */
  hesabeFailureUrl?: string;
  hesabeVariable1?: string;
  hesabeVariable2?: string;
  hesabeVariable3?: string;
  hesabeVariable4?: string;
  hesabeVariable5?: string;
};

export type HesabeRefundParams = RefundParams;

export type HesabeGetPaymentParams = GetPaymentParams;

/** Encrypted callback query: `data` is AES-256-CBC hex. */
export type HesabeCallbackParams = {
  data: string;
  signal?: AbortSignal;
};

/** Merchant refund-details lookup by numeric refund id. */
export type HesabeGetRefundParams = {
  gatewayRefundId: string;
  signal?: AbortSignal;
};

/** Plain-JSON webhook body (verified later via enquiry). */
export type HesabeWebhookPayload = {
  token?: unknown;
  amount?: unknown;
  reference_number?: unknown;
  status?: unknown;
  [key: string]: unknown;
};
