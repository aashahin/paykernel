import { describe, it, expect } from "bun:test";
import {
  stripeGateway,
  moyasarGateway,
  paypalGateway,
  paymobGateway,
} from "./factories";
import { createDefaultGatewayContext } from "./gateway-context";
import { StripeGateway } from "./stripe/stripe.gateway";
import { MoyasarGateway } from "./moyasar/moyasar.gateway";
import { PayPalGateway } from "./paypal/paypal.gateway";
import { PaymobGateway } from "./paymob/paymob.gateway";
import { InvalidRequestError } from "../errors";
import {
  GATEWAY_CAPABILITY_KEYS,
  type GatewayCapabilityKey,
} from "./gateway-capabilities";
import {
  STRIPE_CAPABILITIES,
  MOYASAR_CAPABILITIES,
  PAYPAL_CAPABILITIES,
  PAYMOB_CAPABILITIES,
  BUILTIN_GATEWAY_CAPABILITIES,
  BUILTIN_ADAPTER_VERSION,
} from "./builtin-capabilities";
import type { GatewayAdapter } from "./gateway-adapter";
import type { PaymentGateway } from "./gateway.interface";

function expectCapabilitiesEqual(
  a: Record<GatewayCapabilityKey, boolean>,
  b: Record<GatewayCapabilityKey, boolean>,
): void {
  for (const key of GATEWAY_CAPABILITY_KEYS) {
    expect(a[key], key).toBe(b[key]);
  }
}

describe("built-in gateway adapter factories", () => {
  const ctx = createDefaultGatewayContext();

  describe("stripeGateway", () => {
    it("exposes name/manifest and create() returns StripeGateway", () => {
      const adapter = stripeGateway({ secretKey: "sk_test_mock" });
      expect(adapter.name).toBe("stripe");
      expect(adapter.manifest.name).toBe("stripe");
      expect(adapter.manifest.displayName).toBe("Stripe");
      expect(adapter.manifest.version).toBe(BUILTIN_ADAPTER_VERSION);
      expect(adapter.manifest.capabilities).toEqual(STRIPE_CAPABILITIES);
      const gateway = adapter.create(ctx);
      expect(gateway).toBeInstanceOf(StripeGateway);
      expect(gateway.name).toBe("stripe");
    });

    it("rejects empty secretKey at factory call time", () => {
      expect(() => stripeGateway({ secretKey: "" })).toThrow(
        InvalidRequestError,
      );
      expect(() => stripeGateway({ secretKey: "   " })).toThrow(
        /stripe\.secretKey must be a non-empty string/,
      );
    });
  });

  describe("moyasarGateway", () => {
    it("exposes name/manifest and create() returns MoyasarGateway", () => {
      const adapter = moyasarGateway({ secretKey: "sk_test_mock" });
      expect(adapter.name).toBe("moyasar");
      expect(adapter.manifest.name).toBe("moyasar");
      expect(adapter.manifest.displayName).toBe("Moyasar");
      expect(adapter.manifest.version).toBe(BUILTIN_ADAPTER_VERSION);
      expect(adapter.manifest.capabilities).toEqual(MOYASAR_CAPABILITIES);
      const gateway = adapter.create(ctx);
      expect(gateway).toBeInstanceOf(MoyasarGateway);
      expect(gateway.name).toBe("moyasar");
    });

    it("rejects empty secretKey at factory call time", () => {
      expect(() => moyasarGateway({ secretKey: "" })).toThrow(
        InvalidRequestError,
      );
    });
  });

  describe("paypalGateway", () => {
    it("exposes name/manifest and create() returns PayPalGateway", () => {
      const adapter = paypalGateway({
        clientId: "client_id",
        clientSecret: "client_secret",
      });
      expect(adapter.name).toBe("paypal");
      expect(adapter.manifest.name).toBe("paypal");
      expect(adapter.manifest.displayName).toBe("PayPal");
      expect(adapter.manifest.version).toBe(BUILTIN_ADAPTER_VERSION);
      expect(adapter.manifest.capabilities).toEqual(PAYPAL_CAPABILITIES);
      const gateway = adapter.create(ctx);
      expect(gateway).toBeInstanceOf(PayPalGateway);
      expect(gateway.name).toBe("paypal");
    });

    it("rejects missing client credentials at factory call time", () => {
      expect(() =>
        paypalGateway({ clientId: "", clientSecret: "secret" }),
      ).toThrow(/paypal\.clientId must be a non-empty string/);
      expect(() =>
        paypalGateway({ clientId: "id", clientSecret: "" }),
      ).toThrow(/paypal\.clientSecret must be a non-empty string/);
    });
  });

  describe("paymobGateway", () => {
    it("exposes name/manifest and create() returns PaymobGateway (secretKey)", () => {
      const adapter = paymobGateway({ secretKey: "egy_sk_test" });
      expect(adapter.name).toBe("paymob");
      expect(adapter.manifest.name).toBe("paymob");
      expect(adapter.manifest.displayName).toBe("Paymob");
      expect(adapter.manifest.version).toBe(BUILTIN_ADAPTER_VERSION);
      expect(adapter.manifest.capabilities).toEqual(PAYMOB_CAPABILITIES);
      const gateway = adapter.create(ctx);
      expect(gateway).toBeInstanceOf(PaymobGateway);
      expect(gateway.name).toBe("paymob");
    });

    it("accepts legacy apiKey only", () => {
      const adapter = paymobGateway({ apiKey: "legacy_api_key" });
      expect(adapter.name).toBe("paymob");
      expect(adapter.create(ctx).name).toBe("paymob");
    });

    it("rejects when neither secretKey nor apiKey is non-empty", () => {
      expect(() => paymobGateway({})).toThrow(
        /paymob requires secretKey or apiKey/,
      );
      expect(() => paymobGateway({ secretKey: "", apiKey: "  " })).toThrow(
        InvalidRequestError,
      );
    });
  });

  it("manifest does not include credential fields", () => {
    const adapters = [
      stripeGateway({ secretKey: "sk_secret_value" }),
      moyasarGateway({ secretKey: "sk_secret_value" }),
      paypalGateway({ clientId: "id", clientSecret: "sec" }),
      paymobGateway({ secretKey: "sk" }),
    ];
    for (const adapter of adapters) {
      const json = JSON.stringify(adapter.manifest);
      expect(json).not.toMatch(/sk_secret|clientSecret|apiKey/i);
      expect(adapter.manifest).not.toHaveProperty("secretKey");
      expect(adapter.manifest).not.toHaveProperty("clientSecret");
      expect(adapter.manifest).not.toHaveProperty("apiKey");
    }
  });

  describe("manifest.capabilities matches gateway.capabilities", () => {
    // Full honesty matrix lives in capability-claims.test.ts (Phase 3.4).
    // Factories only assert wiring: manifest → instance → shared constant.
    const cases: Array<{
      name: keyof typeof BUILTIN_GATEWAY_CAPABILITIES;
      adapter: GatewayAdapter;
      expected: typeof STRIPE_CAPABILITIES;
    }> = [
      {
        name: "stripe",
        adapter: stripeGateway({ secretKey: "sk_test_mock" }),
        expected: STRIPE_CAPABILITIES,
      },
      {
        name: "moyasar",
        adapter: moyasarGateway({ secretKey: "sk_test_mock" }),
        expected: MOYASAR_CAPABILITIES,
      },
      {
        name: "paypal",
        adapter: paypalGateway({
          clientId: "client_id",
          clientSecret: "client_secret",
        }),
        expected: PAYPAL_CAPABILITIES,
      },
      {
        name: "paymob",
        adapter: paymobGateway({ secretKey: "egy_sk_test" }),
        expected: PAYMOB_CAPABILITIES,
      },
    ];

    for (const { name, adapter, expected } of cases) {
      it(`${name}: factory manifest equals create().capabilities for all keys`, () => {
        const gateway = adapter.create(ctx) as PaymentGateway;
        expect(adapter.manifest.capabilities).toBeDefined();
        expectCapabilitiesEqual(
          adapter.manifest.capabilities!,
          gateway.capabilities,
        );
        expectCapabilitiesEqual(gateway.capabilities, expected);
        expectCapabilitiesEqual(
          adapter.manifest.capabilities!,
          BUILTIN_GATEWAY_CAPABILITIES[name],
        );
      });
    }
  });
});
