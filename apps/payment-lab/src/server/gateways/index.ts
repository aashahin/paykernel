import {
  MOYASAR_CAPABILITIES,
  PAYMOB_CAPABILITIES,
  PAYPAL_CAPABILITIES,
  STRIPE_CAPABILITIES,
  type GatewayCapabilities,
} from "@paykernel/core";
import { HESABE_CAPABILITIES } from "@paykernel/gateway-hesabe";
import { MYFATOORAH_CAPABILITIES } from "@paykernel/gateway-myfatoorah";
import { TAP_CAPABILITIES } from "@paykernel/gateway-tap";
import { createPaymobMoyasarDriver } from "./paymob-moyasar";
import { createPluginDriver } from "./plugins";
import { createStripePaypalDriver } from "./stripe-paypal";
import {
  GATEWAY_KEYS,
  type CreateSandboxDriverOptions,
  type GatewayKey,
  type GatewayReadiness,
  type GatewaySecrets,
  type SandboxGatewayDriver,
} from "./types";

const CAPABILITIES: Record<GatewayKey, GatewayCapabilities> = {
  stripe: STRIPE_CAPABILITIES,
  paypal: PAYPAL_CAPABILITIES,
  paymob: PAYMOB_CAPABILITIES,
  moyasar: MOYASAR_CAPABILITIES,
  tap: TAP_CAPABILITIES,
  myfatoorah: MYFATOORAH_CAPABILITIES,
  hesabe: HESABE_CAPABILITIES,
};

const DEFAULT_CURRENCIES: Record<GatewayKey, string> = {
  stripe: "USD",
  paypal: "USD",
  paymob: "EGP",
  moyasar: "SAR",
  tap: "KWD",
  myfatoorah: "KWD",
  hesabe: "KWD",
};

/** Lab-facing methods; mirror the method selectors accepted by each driver. */
const PAYMENT_METHODS: Record<GatewayKey, string[]> = {
  stripe: ["elements", "checkout"],
  paypal: ["checkout"],
  paymob: ["card"],
  moyasar: ["card"],
  tap: ["src_all"],
  myfatoorah: ["INVOICE", "CARD", "APPLE_PAY", "GOOGLE_PAY", "KNET"],
  hesabe: ["checkout"],
};

const REQUIRED_SECRETS: Record<GatewayKey, string[]> = {
  stripe: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"],
  paypal: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"],
  paymob: ["PAYMOB_SECRET_KEY", "PAYMOB_API_KEY", "PAYMOB_PUBLIC_KEY", "PAYMOB_INTEGRATION_ID", "PAYMOB_HMAC_SECRET"],
  moyasar: ["MOYASAR_SECRET_KEY", "MOYASAR_PUBLISHABLE_KEY", "MOYASAR_WEBHOOK_SECRET"],
  tap: ["TAP_SECRET_KEY"],
  myfatoorah: ["MYFATOORAH_API_TOKEN", "MYFATOORAH_WEBHOOK_SECRET"],
  hesabe: [
    "HESABE_MERCHANT_CODE",
    "HESABE_ACCESS_CODE",
    "HESABE_ENCRYPTION_KEY",
    "HESABE_IV_KEY",
    "HESABE_USERNAME",
    "HESABE_PASSWORD",
  ],
};

const PUBLIC_KEYS: Record<GatewayKey, string[]> = {
  stripe: ["STRIPE_PUBLISHABLE_KEY"],
  paypal: [],
  paymob: ["PAYMOB_PUBLIC_KEY"],
  moyasar: ["MOYASAR_PUBLISHABLE_KEY"],
  tap: [],
  myfatoorah: [],
  hesabe: [],
};

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sandboxKeyOk(gateway: GatewayKey, secrets: GatewaySecrets): boolean {
  if (gateway === "stripe") {
    const key = trimmed(secrets.STRIPE_SECRET_KEY);
    if (/^(sk_live|rk_live)/i.test(key)) return false;
    return /^sk_test_/i.test(key);
  }
  if (gateway === "moyasar") {
    const key = trimmed(secrets.MOYASAR_SECRET_KEY);
    return key.startsWith("sk_test_");
  }
  if (gateway === "tap") {
    const key = trimmed(secrets.TAP_SECRET_KEY);
    if (/^sk_live/i.test(key)) return false;
    return /^sk_test_/i.test(key);
  }
  if (gateway === "paymob") {
    const secret = trimmed(secrets.PAYMOB_SECRET_KEY);
    const pub = trimmed(secrets.PAYMOB_PUBLIC_KEY);
    if (/^sk_live/i.test(secret) || /^pk_live/i.test(pub)) return false;
    return true;
  }
  return true;
}

export function getGatewayReadiness(gateway: GatewayKey, secrets: GatewaySecrets): GatewayReadiness {
  const required = REQUIRED_SECRETS[gateway];
  const missing = required.filter((name) => !present(secrets[name as keyof GatewaySecrets]));
  const publicKeys: Record<string, boolean> = {};
  for (const name of PUBLIC_KEYS[gateway]) {
    publicKeys[name] = present(secrets[name as keyof GatewaySecrets]);
  }
  const configured = missing.length === 0 && sandboxKeyOk(gateway, secrets);
  return {
    gateway,
    configured,
    missing,
    publicKeys,
    defaultCurrency: DEFAULT_CURRENCIES[gateway],
    paymentMethods: [...PAYMENT_METHODS[gateway]],
    capabilities: CAPABILITIES[gateway],
    sandbox: true,
  };
}

export function listGatewayReadiness(secrets: GatewaySecrets): GatewayReadiness[] {
  return GATEWAY_KEYS.map((gateway) => getGatewayReadiness(gateway, secrets));
}

export function createSandboxDriver(options: CreateSandboxDriverOptions): SandboxGatewayDriver {
  if (options.gateway === "stripe" || options.gateway === "paypal") {
    return createStripePaypalDriver(options);
  }
  if (options.gateway === "paymob" || options.gateway === "moyasar") {
    return createPaymobMoyasarDriver(options);
  }
  return createPluginDriver(options);
}
