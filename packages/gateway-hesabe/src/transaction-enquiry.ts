import { InvalidRequestError, NetworkError } from "@paykernel/core";
import { requiredString, transactionToken } from "./payload";
import { parseHesabeTransactionData, requireHesabeAcceptedEnvelope } from "./payment-map";
import type {
  HesabeEnquiryTransaction,
  HesabeTransactionEnquiryParams,
  HesabeTransactionEnquiryResult,
} from "./types";

const ENQUIRY_STRING_FIELDS = [
  "TransactionID",
  "PaymentID",
  "Terminal",
  "TrackID",
  "payment_type",
  "service_type",
  "customerName",
  "customerEmail",
  "customerMobile",
  "customerCardType",
  "customerCard",
  "datetime",
] as const;

export function normalizeHesabeEnquiryParams(
  params: HesabeTransactionEnquiryParams,
): HesabeTransactionEnquiryParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new InvalidRequestError("Hesabe enquiry requires a token or orderReferenceNumber");
  }
  if ((params.token !== undefined) === (params.orderReferenceNumber !== undefined)) {
    throw new InvalidRequestError(
      "Hesabe enquiry requires exactly one token or orderReferenceNumber",
    );
  }
  const signal = params.signal === undefined ? {} : { signal: params.signal };
  return params.token !== undefined
    ? { token: transactionToken(requiredString(params.token, "token")), ...signal }
    : {
        orderReferenceNumber: requiredString(params.orderReferenceNumber, "orderReferenceNumber"),
        ...signal,
      };
}

export function encodeHesabeEnquiryIdentifier(identifier: string): string {
  if (identifier === "." || identifier === "..") {
    throw new InvalidRequestError("Hesabe enquiry identifier cannot be a URL dot segment");
  }
  try {
    return encodeURIComponent(identifier);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new InvalidRequestError("Hesabe enquiry identifier contains malformed Unicode");
  }
}

export function parseHesabeTransactionEnquiry(
  envelope: unknown,
  selector: HesabeTransactionEnquiryParams,
): HesabeTransactionEnquiryResult {
  const accepted = requireHesabeAcceptedEnvelope(envelope, "transaction enquiry");
  const enquiry: HesabeTransactionEnquiryResult = {
    status: true,
    data: enquiryTransaction(accepted.data, selector),
  };
  if (accepted.message !== undefined) {
    if (typeof accepted.message !== "string") throw malformedEnquiry();
    enquiry.message = accepted.message;
  }
  if (accepted.results !== undefined) {
    if (!Array.isArray(accepted.results)) throw malformedEnquiry();
    enquiry.results = accepted.results.map((transaction: unknown) =>
      enquiryTransaction(transaction, selector),
    );
  }
  return enquiry;
}

function enquiryTransaction(
  transactionData: unknown,
  selector: HesabeTransactionEnquiryParams,
): HesabeEnquiryTransaction {
  const checked = parseHesabeTransactionData(transactionData, selector);
  // The shared parser has already validated this record and its required fields.
  const record = transactionData as Record<string, unknown>;
  return {
    token: checked.token,
    amount: typeof record.amount === "string" ? record.amount.trim() : checked.amount.amount,
    reference_number: checked.referenceNumber,
    status: checked.nativeStatus,
    ...enquiryDetails(record),
  };
}

function enquiryDetails(record: Record<string, unknown>): Partial<HesabeEnquiryTransaction> {
  const details: Partial<HesabeEnquiryTransaction> = {};
  for (const field of ENQUIRY_STRING_FIELDS) {
    const providerDetail = record[field];
    if (providerDetail === undefined) continue;
    if (providerDetail !== null && typeof providerDetail !== "string") throw malformedEnquiry();
    details[field] = providerDetail;
  }
  if (record.Id !== undefined) {
    const providerId = record.Id;
    if (
      providerId !== null &&
      (typeof providerId !== "number" || !Number.isSafeInteger(providerId) || providerId <= 0)
    ) {
      throw malformedEnquiry();
    }
    details.Id = providerId;
  }
  return details;
}

function malformedEnquiry(): NetworkError {
  return new NetworkError("Hesabe transaction enquiry response malformed");
}
