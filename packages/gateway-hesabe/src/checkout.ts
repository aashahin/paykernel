import { InvalidRequestError } from "@paykernel/core";
import { HESABE_LIVE_CHECKOUT_BASE_URL } from "./config";
import type {
  HesabeApplePayAction,
  HesabeCheckoutMode,
  HesabeCreatePaymentParams,
  HesabeEmbeddedCheckoutAction,
} from "./types";

function applePayDomain(domain: unknown): string {
  if (typeof domain !== "string" || domain.trim().length === 0) {
    throw new InvalidRequestError("hesabeApplePayDomain is required for direct Apple Pay");
  }
  const hostname = domain.trim().toLowerCase();
  // Validate DNS labels directly so URL parsing cannot silently discard paths or credentials.
  if (
    hostname.length > 253 ||
    /[^a-z0-9.-]/.test(hostname) ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new InvalidRequestError(
      "hesabeApplePayDomain must be a bare hostname without a scheme, path, or port",
    );
  }
  return hostname;
}

function applePayPayload(params: HesabeCreatePaymentParams): Record<string, unknown> {
  if (params.hesabeVariable5 !== undefined) {
    throw new InvalidRequestError(
      "Direct Apple Pay reserves hesabeVariable5 for hesabeApplePayDomain",
    );
  }
  const paymentType =
    params.hesabeApplePayPaymentType === undefined ? 9 : params.hesabeApplePayPaymentType;
  if (![9, 10, 11, 12, 13, 14].includes(paymentType)) {
    throw new InvalidRequestError("hesabeApplePayPaymentType must be 9, 10, 11, 12, 13, or 14");
  }
  return { paymentType, version: "2.0", variable5: applePayDomain(params.hesabeApplePayDomain) };
}

const CHECKOUT_PAYLOADS: Record<
  HesabeCheckoutMode,
  (params: HesabeCreatePaymentParams) => Record<string, unknown>
> = {
  redirect: () => ({ paymentType: 0, version: "2.0" }),
  embedded: () => ({ paymentType: 0, version: "3.0", embeddedPayment: true }),
  applepay: applePayPayload,
};

export function normalizeHesabeCheckout(params: HesabeCreatePaymentParams): {
  mode: HesabeCheckoutMode;
  payload: Record<string, unknown>;
} {
  const mode = params.hesabeCheckoutMode === undefined ? "redirect" : params.hesabeCheckoutMode;
  if (mode !== "redirect" && mode !== "embedded" && mode !== "applepay") {
    throw new InvalidRequestError("hesabeCheckoutMode must be redirect, embedded, or applepay");
  }
  if (
    mode !== "applepay" &&
    (params.hesabeApplePayDomain !== undefined || params.hesabeApplePayPaymentType !== undefined)
  ) {
    throw new InvalidRequestError("Apple Pay fields require hesabeCheckoutMode: applepay");
  }
  return { mode, payload: CHECKOUT_PAYLOADS[mode](params) };
}

type CheckoutAction =
  { type: "redirect"; url: string } | HesabeEmbeddedCheckoutAction | HesabeApplePayAction;

type CheckoutActionContext = {
  checkoutToken: string;
  baseUrl: string;
  environment: "sandbox" | "production";
};

const CHECKOUT_ACTIONS: Record<
  HesabeCheckoutMode,
  (context: CheckoutActionContext) => CheckoutAction
> = {
  redirect: ({ checkoutToken, baseUrl }) => ({
    type: "redirect",
    url: `${baseUrl}/payment?data=${encodeURIComponent(checkoutToken)}`,
  }),
  embedded: ({ checkoutToken, environment }) => ({
    type: "hesabe_embedded_checkout",
    sessionId: checkoutToken,
    environment,
  }),
  applepay: ({ checkoutToken, baseUrl, environment }) => ({
    type: "hesabe_apple_pay",
    checkoutToken,
    environment,
    scriptUrl: `${baseUrl}/applepay?data=${encodeURIComponent(checkoutToken)}`,
  }),
};

export function hesabeCheckoutAction(
  mode: HesabeCheckoutMode,
  checkoutToken: string,
  baseUrl: string,
): CheckoutAction {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return CHECKOUT_ACTIONS[mode]({
    checkoutToken,
    baseUrl: normalizedBase,
    environment: normalizedBase === HESABE_LIVE_CHECKOUT_BASE_URL ? "production" : "sandbox",
  });
}

function isCheckoutActionRecord(action: unknown): action is Record<string, unknown> {
  return action !== null && typeof action === "object" && !Array.isArray(action);
}

function isNonEmptyString(field: unknown): field is string {
  return typeof field === "string" && field.trim().length > 0;
}

/** Checks action shape, not origin; only initialize the browser SDK from your trusted backend. */
export function isHesabeEmbeddedCheckoutAction(
  action: unknown,
): action is HesabeEmbeddedCheckoutAction {
  return (
    isCheckoutActionRecord(action) &&
    action.type === "hesabe_embedded_checkout" &&
    isNonEmptyString(action.sessionId) &&
    (action.environment === "sandbox" || action.environment === "production")
  );
}

/** Checks action shape, not script trust; only load scripts returned by your trusted backend. */
export function isHesabeApplePayAction(action: unknown): action is HesabeApplePayAction {
  return (
    isCheckoutActionRecord(action) &&
    action.type === "hesabe_apple_pay" &&
    isNonEmptyString(action.checkoutToken) &&
    isNonEmptyString(action.scriptUrl) &&
    (action.environment === "sandbox" || action.environment === "production")
  );
}
