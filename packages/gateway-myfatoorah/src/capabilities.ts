import {
  defineGatewayCapabilities,
  freezeCapabilities,
  type GatewayCapabilities,
} from "@paykernel/core";

/** Adapter package version — must match `packages/gateway-myfatoorah/package.json`. */
export const MYFATOORAH_ADAPTER_VERSION = "1.0.2";

/**
 * Conservative MyFatoorah claims for this adapter surface.
 *
 * V3 `PaymentURL` is a hosted-page **redirect**, not a first-class Checkout
 * Session product (`hostedCheckout` stays false) — same honesty as Tap
 * `src_all`. Authorize / capture / void exist on MyFatoorah but need portal
 * enablement and are not implemented here. Tokenization is claimed because
 * `SourceOfFund.Token` / `SessionId` via `myfatoorahToken` /
 * `myfatoorahSessionId` is implemented and tested (gateway.test.ts:283) —
 * direct card PAN (`SourceOfFund.Card`) is still rejected before any fetch.
 * Customers, payment links, splits, disputes, and recurring are not
 * implemented.
 */
export const MYFATOORAH_CAPABILITIES: GatewayCapabilities = freezeCapabilities(
  defineGatewayCapabilities({
    payments: true,
    immediateCapture: true,
    refunds: true,
    partialRefunds: true,
    authorization: false,
    partialCapture: false,
    voids: false,
    hostedCheckout: false,
    tokenization: true,
    customers: false,
    paymentMethods: false,
    marketplaceSplits: false,
    disputes: false,
    paymentLinks: false,
    providerRecurring: false,
  }),
);
