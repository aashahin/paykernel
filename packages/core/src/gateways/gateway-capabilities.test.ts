// file: packages/core/src/gateways/gateway-capabilities.test.ts

import { describe, it, expect } from "bun:test";
import {
  GATEWAY_CAPABILITY_KEYS,
  DEFAULT_GATEWAY_CAPABILITIES,
  defineGatewayCapabilities,
  isGatewayCapabilityKey,
  CAPABILITY_OPERATION_MAP,
  freezeCapabilities,
  requiredCapabilitiesForOperation,
  type GatewayCapabilities,
  type GatewayCapabilityKey,
} from "./gateway-capabilities";
import { BaseGateway } from "./base.gateway";
import { OperationNotSupportedError } from "../errors";
import { HooksManager } from "../hooks/hooks.manager";
import type {
  CreatePaymentParams,
  CaptureParams,
  RefundParams,
  GatewayPaymentResult,
  GatewayRefundResult,
} from "../types/payment.types";
import type { WebhookEvent } from "../types/webhook.types";

/** Minimal concrete BaseGateway for capability unit tests */
class TestCapabilityGateway extends BaseGateway {
  readonly name = "test-caps";

  constructor(
    capabilities?: Partial<GatewayCapabilities> | GatewayCapabilities,
  ) {
    super({}, new HooksManager(), undefined, capabilities);
  }

  async createPayment(
    _params: CreatePaymentParams,
  ): Promise<GatewayPaymentResult> {
    return {
      success: true,
      status: "paid",
      gatewayId: "test_1",
      rawResponse: {},
    };
  }

  async capturePayment(
    _params: CaptureParams,
  ): Promise<GatewayPaymentResult> {
    return {
      success: true,
      status: "paid",
      gatewayId: "test_cap",
      rawResponse: {},
    };
  }

  async refundPayment(
    _params: RefundParams,
  ): Promise<GatewayRefundResult> {
    return {
      success: true,
      gatewayRefundId: "test_ref",
      status: "completed",
      rawResponse: {},
    };
  }

  verifyWebhook(): boolean {
    return true;
  }

  parseWebhookEvent(payload: unknown): WebhookEvent {
    return {
      id: "evt_1",
      type: "payment_paid",
      gateway: "test-caps",
      paymentId: undefined,
      gatewayPaymentId: "pay_1",
      status: "paid",
      timestamp: new Date(),
      rawPayload: payload,
    };
  }

  /** Expose protected assertCapability for tests */
  tryAssert(capability: GatewayCapabilityKey, operation: string): void {
    this.assertCapability(capability, operation);
  }
}

describe("gateway capabilities foundation", () => {
  describe("GATEWAY_CAPABILITY_KEYS", () => {
    it("includes the stable Phase 3 key set", () => {
      const expected = [
        "payments",
        "immediateCapture",
        "authorization",
        "partialCapture",
        "refunds",
        "partialRefunds",
        "voids",
        "hostedCheckout",
        "tokenization",
        "customers",
        "paymentMethods",
        "marketplaceSplits",
        "disputes",
        "paymentLinks",
        "providerRecurring",
      ];
      expect([...GATEWAY_CAPABILITY_KEYS]).toEqual(expected);
      expect(GATEWAY_CAPABILITY_KEYS).toHaveLength(15);
    });
  });

  describe("defineGatewayCapabilities", () => {
    it("merges partial claims; unspecified keys are false", () => {
      const caps = defineGatewayCapabilities({
        payments: true,
        refunds: true,
        partialRefunds: false,
      });

      expect(caps.payments).toBe(true);
      expect(caps.refunds).toBe(true);
      expect(caps.partialRefunds).toBe(false);
      expect(caps.voids).toBe(false);
      expect(caps.authorization).toBe(false);
      expect(caps.hostedCheckout).toBe(false);
      expect(caps.providerRecurring).toBe(false);

      for (const key of GATEWAY_CAPABILITY_KEYS) {
        expect(typeof caps[key]).toBe("boolean");
      }
    });

    it("returns all-false for empty partial", () => {
      const caps = defineGatewayCapabilities({});
      for (const key of GATEWAY_CAPABILITY_KEYS) {
        expect(caps[key]).toBe(false);
      }
      expect(caps).toEqual({ ...DEFAULT_GATEWAY_CAPABILITIES });
    });

    it("coerces non-true values to false", () => {
      const caps = defineGatewayCapabilities({
        payments: true,
        // @ts-expect-error — runtime guard for non-boolean
        refunds: 1,
      });
      expect(caps.payments).toBe(true);
      expect(caps.refunds).toBe(false);
    });
  });

  describe("isGatewayCapabilityKey", () => {
    it("returns true for known keys", () => {
      expect(isGatewayCapabilityKey("payments")).toBe(true);
      expect(isGatewayCapabilityKey("providerRecurring")).toBe(true);
      expect(isGatewayCapabilityKey("hostedCheckout")).toBe(true);
    });

    it("returns false for unknown strings", () => {
      expect(isGatewayCapabilityKey("")).toBe(false);
      expect(isGatewayCapabilityKey("partial_refunds")).toBe(false);
      expect(isGatewayCapabilityKey("subscriptions")).toBe(false);
    });
  });

  describe("freezeCapabilities", () => {
    it("returns a frozen snapshot", () => {
      const caps = defineGatewayCapabilities({ payments: true });
      const frozen = freezeCapabilities(caps);
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(frozen.payments).toBe(true);
      expect(() => {
        (frozen as { payments: boolean }).payments = false;
      }).toThrow();
    });

    it("does not mutate the input object", () => {
      const caps = defineGatewayCapabilities({ refunds: true });
      const frozen = freezeCapabilities(caps);
      expect(frozen).not.toBe(caps);
      expect(caps.refunds).toBe(true);
    });
  });

  describe("CAPABILITY_OPERATION_MAP", () => {
    it("maps every client-gated capability to a method name; remaining extension keys stay unmapped", () => {
      // Drift guard: claim-validation harness uses this map for method presence.
      const mapped: Partial<Record<GatewayCapabilityKey, string>> = {
        payments: "createPayment",
        immediateCapture: "createPayment",
        authorization: "capturePayment",
        partialCapture: "capturePayment",
        refunds: "refundPayment",
        partialRefunds: "refundPayment",
        voids: "voidPayment",
        hostedCheckout: "createCheckoutSession",
        customers: "createCustomer",
        paymentMethods: "attachPaymentMethod",
        disputes: "getDispute",
        paymentLinks: "createPaymentLink",
      };
      for (const key of GATEWAY_CAPABILITY_KEYS) {
        expect(CAPABILITY_OPERATION_MAP[key]).toBe(mapped[key]);
      }
    });

    it("requiredCapabilitiesForOperation encodes create/refund/void/capture gates", () => {
      expect(requiredCapabilitiesForOperation("createPayment", { capture: true }))
        .toEqual(["payments"]);
      expect(
        requiredCapabilitiesForOperation("createPayment", { capture: false }),
      ).toEqual(["payments", "authorization"]);
      expect(
        requiredCapabilitiesForOperation("createPayment", {
          splits: [{ amount: 1 }],
        }),
      ).toEqual(["payments", "marketplaceSplits"]);
      expect(
        requiredCapabilitiesForOperation("createPayment", {
          offSession: true,
        }),
      ).toEqual(["payments", "paymentMethods"]);
      expect(requiredCapabilitiesForOperation("refundPayment", {})).toEqual([
        "refunds",
      ]);
      expect(
        requiredCapabilitiesForOperation("refundPayment", { amount: 1 }),
      ).toEqual(["refunds", "partialRefunds"]);
      expect(requiredCapabilitiesForOperation("voidPayment", {})).toEqual([
        "voids",
      ]);
      expect(requiredCapabilitiesForOperation("capturePayment", {})).toEqual([]);
      expect(
        requiredCapabilitiesForOperation("capturePayment", { amount: 1 }),
      ).toEqual(["partialCapture"]);
      expect(
        requiredCapabilitiesForOperation("createCheckoutSession", {}),
      ).toEqual(["hostedCheckout"]);
      expect(
        requiredCapabilitiesForOperation("getCheckoutSession", {}),
      ).toEqual(["hostedCheckout"]);
      expect(requiredCapabilitiesForOperation("getDispute", {})).toEqual([
        "disputes",
      ]);
      expect(
        requiredCapabilitiesForOperation("createPaymentLink", {}),
      ).toEqual(["paymentLinks"]);
      expect(requiredCapabilitiesForOperation("createCustomer", {})).toEqual([
        "customers",
      ]);
      expect(requiredCapabilitiesForOperation("getCustomer", {})).toEqual([
        "customers",
      ]);
      expect(
        requiredCapabilitiesForOperation("attachPaymentMethod", {}),
      ).toEqual(["paymentMethods"]);
      expect(requiredCapabilitiesForOperation("listPaymentMethods", {})).toEqual(
        ["paymentMethods"],
      );
      expect(
        requiredCapabilitiesForOperation("detachPaymentMethod", {}),
      ).toEqual(["paymentMethods"]);
    });
  });

  describe("BaseGateway supports + capabilities", () => {
    it("defaults to all-false when no claims are passed", () => {
      const gw = new TestCapabilityGateway();
      expect(Object.isFrozen(gw.capabilities)).toBe(true);
      for (const key of GATEWAY_CAPABILITY_KEYS) {
        expect(gw.supports(key)).toBe(false);
        expect(gw.capabilities[key]).toBe(false);
      }
    });

    it("returns expected supports() values for explicit claims", () => {
      const gw = new TestCapabilityGateway({
        payments: true,
        refunds: true,
        partialRefunds: true,
        voids: false,
      });
      expect(gw.supports("payments")).toBe(true);
      expect(gw.supports("refunds")).toBe(true);
      expect(gw.supports("partialRefunds")).toBe(true);
      expect(gw.supports("voids")).toBe(false);
      expect(gw.supports("hostedCheckout")).toBe(false);
    });

    it("assertCapability throws OperationNotSupportedError with metadata", () => {
      const gw = new TestCapabilityGateway({ payments: true });
      try {
        gw.tryAssert("voids", "voidPayment");
        expect.unreachable("should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(OperationNotSupportedError);
        const err = error as OperationNotSupportedError;
        expect(err.gatewayName).toBe("test-caps");
        expect(err.operation).toBe("voidPayment");
        expect(err.capability).toBe("voids");
        expect(err.claimedSupport).toBe(false);
        expect(err.code).toBe("OPERATION_NOT_SUPPORTED");
        expect(err.statusCode).toBe(400);
        expect(err.message).toContain("voidPayment");
        expect(err.message).toContain("voids");
      }
    });

    it("assertCapability is a no-op when capability is claimed", () => {
      const gw = new TestCapabilityGateway({ voids: true });
      expect(() => gw.tryAssert("voids", "voidPayment")).not.toThrow();
    });
  });

  describe("OperationNotSupportedError capability metadata", () => {
    it("two-arg form remains backward compatible", () => {
      const err = new OperationNotSupportedError("moyasar", "voidPayment");
      expect(err.gatewayName).toBe("moyasar");
      expect(err.operation).toBe("voidPayment");
      expect(err.capability).toBeUndefined();
      expect(err.claimedSupport).toBeUndefined();
      expect(err.message).toBe(
        "Gateway 'moyasar' does not support voidPayment",
      );
      expect(err.code).toBe("OPERATION_NOT_SUPPORTED");
      expect(err.statusCode).toBe(400);
    });

    it("carries capability metadata when provided", () => {
      const err = new OperationNotSupportedError("stripe", "createCheckoutSession", {
        capability: "hostedCheckout",
        claimedSupport: false,
      });
      expect(err.capability).toBe("hostedCheckout");
      expect(err.claimedSupport).toBe(false);
      expect(err.message).toContain("hostedCheckout");
      expect(err.message).toContain("createCheckoutSession");
    });

    it("accepts a custom message override", () => {
      const err = new OperationNotSupportedError("acme", "refundPayment", {
        capability: "refunds",
        claimedSupport: false,
        message: "custom unsupported message",
      });
      expect(err.message).toBe("custom unsupported message");
      expect(err.capability).toBe("refunds");
    });
  });
});
