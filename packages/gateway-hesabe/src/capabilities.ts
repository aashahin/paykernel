import {
  defineGatewayCapabilities,
  freezeCapabilities,
  type GatewayCapabilities,
} from "@paykernel/core";

/** Adapter package version — must match `packages/gateway-hesabe/package.json`. */
export const HESABE_ADAPTER_VERSION = "0.3.0";

/**
 * Conservative Hesabe claims for this adapter surface.
 *
 * Checkout uses createPayment with redirect, embedded, or Apple Pay actions
 * (not the core Checkout Session API).
 * Authorize / capture / void, tokenization, customers, payment methods,
 * splits, disputes, links, and recurring are not implemented.
 */
export const HESABE_CAPABILITIES: GatewayCapabilities = freezeCapabilities(
  defineGatewayCapabilities({
    payments: true,
    immediateCapture: true,
    refunds: true,
    partialRefunds: true,
    authorization: false,
    partialCapture: false,
    voids: false,
    hostedCheckout: false,
    tokenization: false,
    customers: false,
    paymentMethods: false,
    marketplaceSplits: false,
    disputes: false,
    paymentLinks: false,
    providerRecurring: false,
  }),
);
