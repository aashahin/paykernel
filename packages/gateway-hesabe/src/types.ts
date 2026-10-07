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

/** Enquire using a confirmed transaction token or the checkout's order reference. */
export type HesabeTransactionEnquiryParams = (
  { token: string; orderReferenceNumber?: never } | { orderReferenceNumber: string; token?: never }
) & {
  signal?: AbortSignal;
};

/** Provider field names and native status are retained; amounts remain decimal strings. */
export type HesabeEnquiryTransaction = {
  token: string;
  amount: string;
  reference_number: string;
  status: string;
  TransactionID?: string | null;
  Id?: number | null;
  PaymentID?: string | null;
  Terminal?: string | null;
  TrackID?: string | null;
  payment_type?: string | null;
  service_type?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerMobile?: string | null;
  customerCardType?: string | null;
  customerCard?: string | null;
  /** Provider timestamp without an inferred timezone. */
  datetime?: string | null;
};

/** Accepted enquiry envelope. Provider errors are thrown using core error types. */
export type HesabeTransactionEnquiryResult = {
  status: true;
  message?: string;
  data: HesabeEnquiryTransaction;
  results?: HesabeEnquiryTransaction[];
};

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
