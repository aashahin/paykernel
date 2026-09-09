// file: packages/core/src/gateways/capability-claims.test.ts

/**
 * Phase 3.4 claim-validation harness (core-local, not full Phase 4 testkit).
 *
 * Verifies built-in factory capability claims match instance snapshots and
 * method presence boundaries. Does **not** call real provider APIs.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripeGateway,
  moyasarGateway,
  paypalGateway,
  paymobGateway,
} from "./factories";
import { createDefaultGatewayContext } from "./gateway-context";
import {
  GATEWAY_CAPABILITY_KEYS,
  CAPABILITY_OPERATION_MAP,
  defineGatewayCapabilities,
  type GatewayCapabilityKey,
  type GatewayCapabilities,
} from "./gateway-capabilities";
import {
  BUILTIN_ADAPTER_VERSION,
  BUILTIN_GATEWAY_CAPABILITIES,
  BUILTIN_GATEWAY_MANIFESTS,
  STRIPE_CAPABILITIES,
  MOYASAR_CAPABILITIES,
  PAYPAL_CAPABILITIES,
  PAYMOB_CAPABILITIES,
} from "./builtin-capabilities";
import { generateGatewayCapabilitiesMarkdown } from "./capabilities-docs";
import { BaseGateway } from "./base.gateway";
import type { GatewayAdapter } from "./gateway-adapter";
import type { PaymentGateway } from "./gateway.interface";
import type {
  CreatePaymentParams,
  CaptureParams,
  RefundParams,
  GatewayPaymentResult,
  GatewayRefundResult,
} from "../types/payment.types";
import type { WebhookEvent } from "../types/webhook.types";
import { HooksManager } from "../hooks/hooks.manager";
import { InvalidRequestError } from "../errors";
import { money } from "../utils/money";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, "../..");
const ctx = createDefaultGatewayContext();

type BuiltinCase = {
  name: keyof typeof BUILTIN_GATEWAY_CAPABILITIES;
  adapter: GatewayAdapter;
  expected: GatewayCapabilities;
};

const BUILTIN_CASES: BuiltinCase[] = [
  {
    name: "stripe",
    adapter: stripeGateway({ secretKey: "sk_test_claim_validation" }),
    expected: STRIPE_CAPABILITIES,
  },
  {
    name: "moyasar",
    adapter: moyasarGateway({ secretKey: "sk_test_claim_validation" }),
    expected: MOYASAR_CAPABILITIES,
  },
  {
    name: "paypal",
    adapter: paypalGateway({
      clientId: "client_id_claim",
      clientSecret: "client_secret_claim",
    }),
    expected: PAYPAL_CAPABILITIES,
  },
  {
    name: "paymob",
    adapter: paymobGateway({ secretKey: "sk_test_claim_validation" }),
    expected: PAYMOB_CAPABILITIES,
  },
];

/** Structural method presence when a capability is claimed true and mapped. */
function assertClaimImpliesMethod(
  gateway: PaymentGateway,
  key: GatewayCapabilityKey,
): void {
  const operation = CAPABILITY_OPERATION_MAP[key];
  if (operation === undefined) {
    // Extension / multi-method surfaces — no single required method boundary.
    return;
  }
  const method = (gateway as PaymentGateway & Record<string, unknown>)[operation];
  expect(
    typeof method === "function",
    `${gateway.name}.${key} → ${operation}`,
  ).toBe(true);
}

describe("capability claim validation (Phase 3.4)", () => {
  describe("built-in factories", () => {
    for (const { name, adapter, expected } of BUILTIN_CASES) {
      describe(name, () => {
        it("create() gateway supports/capabilities match manifest and constants", () => {
          const gateway = adapter.create(ctx) as PaymentGateway;
          const manifestCaps = adapter.manifest.capabilities;
          expect(manifestCaps).toBeDefined();

          for (const key of GATEWAY_CAPABILITY_KEYS) {
            const claim = expected[key] === true;
            expect(gateway.supports(key), `supports(${key})`).toBe(claim);
            expect(gateway.capabilities[key], `capabilities.${key}`).toBe(claim);
            expect(manifestCaps![key], `manifest.capabilities.${key}`).toBe(
              claim,
            );
            expect(
              BUILTIN_GATEWAY_CAPABILITIES[name][key],
              `BUILTIN_GATEWAY_CAPABILITIES.${name}.${key}`,
            ).toBe(claim);
          }

          expect(Object.isFrozen(gateway.capabilities)).toBe(true);
        });

        it("claimed capabilities imply required method presence", () => {
          const gateway = adapter.create(ctx) as PaymentGateway;
          for (const key of GATEWAY_CAPABILITY_KEYS) {
            if (gateway.supports(key)) {
              assertClaimImpliesMethod(gateway, key);
            }
          }
        });
      });
    }

    it("only Stripe claims hostedCheckout; only Moyasar claims marketplaceSplits", () => {
      expect(STRIPE_CAPABILITIES.hostedCheckout).toBe(true);
      expect(MOYASAR_CAPABILITIES.hostedCheckout).toBe(false);
      expect(PAYPAL_CAPABILITIES.hostedCheckout).toBe(false);
      expect(PAYMOB_CAPABILITIES.hostedCheckout).toBe(false);

      expect(MOYASAR_CAPABILITIES.marketplaceSplits).toBe(true);
      expect(STRIPE_CAPABILITIES.marketplaceSplits).toBe(false);
      expect(PAYPAL_CAPABILITIES.marketplaceSplits).toBe(false);
      expect(PAYMOB_CAPABILITIES.marketplaceSplits).toBe(false);
    });

    it("only Stripe claims disputes and paymentLinks; all deny providerRecurring", () => {
      expect(STRIPE_CAPABILITIES.disputes).toBe(true);
      expect(STRIPE_CAPABILITIES.paymentLinks).toBe(true);
      expect(MOYASAR_CAPABILITIES.disputes).toBe(false);
      expect(PAYPAL_CAPABILITIES.disputes).toBe(false);
      expect(PAYMOB_CAPABILITIES.disputes).toBe(false);
      expect(MOYASAR_CAPABILITIES.paymentLinks).toBe(false);
      expect(PAYPAL_CAPABILITIES.paymentLinks).toBe(false);
      expect(PAYMOB_CAPABILITIES.paymentLinks).toBe(false);
      for (const caps of Object.values(BUILTIN_GATEWAY_CAPABILITIES)) {
        expect(caps.providerRecurring).toBe(false);
        // tok_ on Stripe attach is paymentMethods, not this key.
        expect(caps.tokenization).toBe(false);
      }
      expect(STRIPE_CAPABILITIES.customers).toBe(true);
      expect(STRIPE_CAPABILITIES.paymentMethods).toBe(true);
      expect(MOYASAR_CAPABILITIES.customers).toBe(false);
      expect(MOYASAR_CAPABILITIES.paymentMethods).toBe(false);
      expect(PAYPAL_CAPABILITIES.customers).toBe(false);
      expect(PAYPAL_CAPABILITIES.paymentMethods).toBe(false);
      expect(PAYMOB_CAPABILITIES.customers).toBe(false);
      expect(PAYMOB_CAPABILITIES.paymentMethods).toBe(false);
    });

    it("BUILTIN_GATEWAY_MANIFESTS names match factory adapters", () => {
      const names = BUILTIN_GATEWAY_MANIFESTS.map((m) => m.name).sort();
      expect(names).toEqual(["moyasar", "paymob", "paypal", "stripe"]);
      for (const manifest of BUILTIN_GATEWAY_MANIFESTS) {
        const key = manifest.name as keyof typeof BUILTIN_GATEWAY_CAPABILITIES;
        expect(manifest.capabilities).toEqual(BUILTIN_GATEWAY_CAPABILITIES[key]);
      }
    });

    it("BUILTIN_ADAPTER_VERSION matches packages/core/package.json version (P05-VER-1)", () => {
      const pkg = JSON.parse(
        readFileSync(join(CORE_ROOT, "package.json"), "utf8"),
      ) as { version: string };
      expect(pkg.version.length).toBeGreaterThan(0);
      expect(BUILTIN_ADAPTER_VERSION).toBe(pkg.version);
      for (const manifest of BUILTIN_GATEWAY_MANIFESTS) {
        expect(manifest.version).toBe(pkg.version);
      }
    });

    it("PayPal keeps partialCapture true; order captures reject amount (P05-PAYPAL-1)", async () => {
      // Auth-path captures accept amount — keep the claim true.
      expect(PAYPAL_CAPABILITIES.partialCapture).toBe(true);
      expect(PAYPAL_CAPABILITIES.authorization).toBe(true);

      const claimsSrc = readFileSync(
        join(HERE, "builtin-capabilities.ts"),
        "utf8",
      );
      expect(claimsSrc).toMatch(/partialCapture:\s*true/);
      expect(claimsSrc).toMatch(/paypalCaptureType/);
      expect(claimsSrc).toMatch(/order captures reject amount/i);

      const generated = generateGatewayCapabilitiesMarkdown(
        BUILTIN_GATEWAY_MANIFESTS,
      );
      expect(generated).toMatch(/paypalCaptureType/);
      expect(generated).toMatch(/order captures reject amount/i);

      const customGateways = readFileSync(
        join(CORE_ROOT, "docs", "custom-gateways.md"),
        "utf8",
      );
      expect(customGateways).toMatch(/paypalCaptureType/);
      expect(customGateways).toMatch(/order captures reject amount/i);

      // Provider boundary still rejects a Money amount on order captures.
      const paypal = paypalGateway({
        clientId: "client_id_claim",
        clientSecret: "client_secret_claim",
      }).create(ctx);
      await expect(
        paypal.capturePayment({
          gatewayPaymentId: "ORDER-1",
          amount: money("10.00", "USD"),
          currency: "USD",
          idempotencyKey: "idem-paypal-order-reject",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    });
  });

  describe("custom adapter with all-false capabilities", () => {
    class AllFalseGateway extends BaseGateway {
      readonly name = "all-false-caps";

      constructor() {
        super({}, new HooksManager(), undefined, defineGatewayCapabilities({}));
      }

      async createPayment(
        _params: CreatePaymentParams,
      ): Promise<GatewayPaymentResult> {
        return {
          success: true,
          status: "paid",
          gatewayId: "af_1",
          rawResponse: {},
        };
      }

      async capturePayment(
        _params: CaptureParams,
      ): Promise<GatewayPaymentResult> {
        return {
          success: true,
          status: "paid",
          gatewayId: "af_cap",
          rawResponse: {},
        };
      }

      async refundPayment(
        _params: RefundParams,
      ): Promise<GatewayRefundResult> {
        return {
          success: true,
          gatewayRefundId: "af_ref",
          status: "completed",
          rawResponse: {},
        };
      }

      // Intentionally implements voidPayment method while claiming voids:false
      // to prove supports() is claim-driven, not duck-typed.
      async voidPayment(): Promise<GatewayPaymentResult> {
        return {
          success: true,
          status: "cancelled",
          gatewayId: "af_void",
          rawResponse: {},
        };
      }

      verifyWebhook(): boolean {
        return true;
      }

      parseWebhookEvent(payload: unknown): WebhookEvent {
        return {
          id: "evt_af",
          type: "payment_paid",
          gateway: "all-false-caps",
          paymentId: undefined,
          gatewayPaymentId: "af_1",
          status: "paid",
          timestamp: new Date(),
          rawPayload: payload,
        };
      }
    }

    it("supports never true for any GatewayCapabilityKey", () => {
      const gateway = new AllFalseGateway();
      for (const key of GATEWAY_CAPABILITY_KEYS) {
        expect(gateway.supports(key)).toBe(false);
        expect(gateway.capabilities[key]).toBe(false);
      }
      expect(gateway.supports("voids")).toBe(false);
      // Method exists but claim is false
      expect(typeof gateway.voidPayment).toBe("function");
    });
  });

  describe("snapshot immutability", () => {
    it("gateway.capabilities is frozen and complete", () => {
      for (const { adapter } of BUILTIN_CASES) {
        const gateway = adapter.create(ctx) as PaymentGateway;
        expect(Object.isFrozen(gateway.capabilities)).toBe(true);
        for (const key of GATEWAY_CAPABILITY_KEYS) {
          expect(typeof gateway.capabilities[key]).toBe("boolean");
        }
        expect(() => {
          (gateway.capabilities as { payments: boolean }).payments = false;
        }).toThrow();
      }
    });
  });
});
