// file: packages/core/src/gateways/builtin-capabilities.ts

/**
 * Conservative capability claims for first-party built-in adapters.
 *
 * Source of truth for:
 * - factory {@link import('./gateway-manifest').GatewayManifest.capabilities}
 * - gateway instance {@link import('./gateway.interface').PaymentGateway.capabilities}
 * - generated docs (`generateGatewayCapabilitiesMarkdown`)
 *
 * Policy: claim only what this SDK surface implements with a viable operation
 * path. Do not over-claim provider APIs that are not first-class on the adapter
 * (disputes, payment links, tokenization CRUD, providerRecurring).
 */

import {
  defineGatewayCapabilities,
  freezeCapabilities,
  type GatewayCapabilities,
} from "./gateway-capabilities";
import type { GatewayManifest } from "./gateway-manifest";

/** Built-in adapter package version — must match `packages/core/package.json`. */
export const BUILTIN_ADAPTER_VERSION = "1.0.0";

/**
 * Stripe PaymentIntent + Checkout Session + Customer / PaymentMethod +
 * Disputes + Payment Links surface.
 * hostedCheckout = createCheckoutSession only (not every redirect).
 * tokenization stays false: attachPaymentMethod may accept a Stripe `tok_…`
 * as a paymentMethods convenience; that is not a SetupIntent / save-card API.
 * providerRecurring stays false: Checkout `mode: subscription` alone is not a
 * first-class recurring billing adapter surface.
 */
export const STRIPE_CAPABILITIES: GatewayCapabilities = freezeCapabilities(
  defineGatewayCapabilities({
    payments: true,
    immediateCapture: true,
    authorization: true,
    partialCapture: true,
    refunds: true,
    partialRefunds: true,
    voids: true,
    hostedCheckout: true,
    tokenization: false,
    customers: true,
    paymentMethods: true,
    marketplaceSplits: false,
    disputes: true,
    paymentLinks: true,
    providerRecurring: false,
  }),
);

/**
 * Moyasar payments surface including create-time marketplace `splits`.
 * Hosted checkout session product is not implemented.
 */
export const MOYASAR_CAPABILITIES: GatewayCapabilities = freezeCapabilities(
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
    marketplaceSplits: true,
    disputes: false,
    paymentLinks: false,
    providerRecurring: false,
  }),
);

/**
 * PayPal Orders + authorizations surface.
 *
 * Keep `partialCapture` true: the authorization-capture path accepts `amount`.
 * PayPal order captures reject amount; callers must use
 * `paypalCaptureType: "authorization"` (authorize-then-capture) for partials.
 */
export const PAYPAL_CAPABILITIES: GatewayCapabilities = freezeCapabilities(
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

/**
 * Paymob Intention / auth-capture / void / refund surface.
 * No createCheckoutSession product on this adapter.
 */
export const PAYMOB_CAPABILITIES: GatewayCapabilities = freezeCapabilities(
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

/** Lookup by built-in gateway name. */
export const BUILTIN_GATEWAY_CAPABILITIES = Object.freeze({
  stripe: STRIPE_CAPABILITIES,
  moyasar: MOYASAR_CAPABILITIES,
  paypal: PAYPAL_CAPABILITIES,
  paymob: PAYMOB_CAPABILITIES,
}) satisfies Readonly<Record<string, GatewayCapabilities>>;

export type BuiltinGatewayCapabilityName =
  keyof typeof BUILTIN_GATEWAY_CAPABILITIES;

/**
 * Secret-free manifest snapshots for docs generation and claim tests.
 * Matches factory identity fields + capability claims.
 */
export const BUILTIN_GATEWAY_MANIFESTS: readonly GatewayManifest[] =
  Object.freeze([
    Object.freeze({
      name: "stripe",
      displayName: "Stripe",
      version: BUILTIN_ADAPTER_VERSION,
      capabilities: STRIPE_CAPABILITIES,
    }),
    Object.freeze({
      name: "moyasar",
      displayName: "Moyasar",
      version: BUILTIN_ADAPTER_VERSION,
      capabilities: MOYASAR_CAPABILITIES,
    }),
    Object.freeze({
      name: "paypal",
      displayName: "PayPal",
      version: BUILTIN_ADAPTER_VERSION,
      capabilities: PAYPAL_CAPABILITIES,
    }),
    Object.freeze({
      name: "paymob",
      displayName: "Paymob",
      version: BUILTIN_ADAPTER_VERSION,
      capabilities: PAYMOB_CAPABILITIES,
    }),
  ]);
