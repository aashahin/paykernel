import type { CreatePaymentParams, GetPaymentParams, RefundParams } from "@paykernel/core";

export type HesabeCheckoutMode = "redirect" | "embedded" | "applepay";

/** MPGS, CYBS, KNET debit, KNET credit, KNET international, and AMEX international. */
export type HesabeApplePayPaymentType = 9 | 10 | 11 | 12 | 13 | 14;

type HesabeCheckoutOptions =
  | {
      /** Default: redirect. Embedded mode initializes Hesabe's Hosted Checkout SDK. */
      hesabeCheckoutMode?: "redirect" | "embedded";
      hesabeVariable5?: string;
      hesabeApplePayDomain?: never;
      hesabeApplePayPaymentType?: never;
    }
  | {
      hesabeCheckoutMode: "applepay";
      /** Whitelisted merchant hostname (without scheme, path, or port), sent as `variable5`. */
      hesabeApplePayDomain: string;
      /** The account must enable this payment type. Default: 9 (MPGS Apple Pay). */
      hesabeApplePayPaymentType?: HesabeApplePayPaymentType;
      hesabeVariable5?: never;
    };

/** Pass `sessionId` as the browser SDK's `sessionID`; initialization is not settlement. */
export type HesabeEmbeddedCheckoutAction = {
  type: "hesabe_embedded_checkout";
  sessionId: string;
  environment: "sandbox" | "production";
};

/** Load the Hesabe script on the verified merchant domain; this URL is not a redirect. */
export type HesabeApplePayAction = {
  type: "hesabe_apple_pay";
  checkoutToken: string;
  environment: "sandbox" | "production";
  scriptUrl: string;
};

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
} & HesabeCheckoutOptions;

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
