import {
  defineGatewayCapabilities,
  freezeCapabilities,
  type GatewayCapabilities,
} from "@paykernel/core";

/** Adapter package version — must match `packages/gateway-tap/package.json`. */
export const TAP_ADAPTER_VERSION = "1.0.2";

/**
 * Conservative Tap Payments claims for this adapter surface.
 *
 * Hosted `src_all` / `src_card` / local method sources are redirects, not a
 * first-class Checkout Session product (`hostedCheckout` stays false).
 * Customers, payment methods, invoices/links, destinations, and recurring
 * exist on Tap’s API but are not implemented here.
 */
export const TAP_CAPABILITIES: GatewayCapabilities = freezeCapabilities(
  defineGatewayCapabilities({
    payments: true,
    immediateCapture: true,
    authorization: true,
    partialCapture: true,
    refunds: true,
    partialRefunds: true,
    voids: true,
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
