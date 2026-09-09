// file: packages/payments/src/gateways/stripe/stripe.gateway.test.ts

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { StripeGateway } from "./stripe.gateway";
import { HooksManager } from "../../hooks/hooks.manager";
import type { StripeConfig } from "../../types/config.types";
import type { CreatePaymentParams } from "../../types/payment.types";
import {
  assertNoSecretsInEnvelope,
  hashWebhookPayload,
  toPersistedPaymentEventEnvelope,
} from "../../types/payment-event";
import { money, moneyToMajorNumber } from "../../utils/money";
import type { Money } from "../../utils/money";
import { isHostedCheckoutRedirect } from "../../types/checkout.types";
import {
  AuthenticationError,
  InvalidRequestError,
  NetworkError,
  RateLimitError,
} from "../../errors";
import { createHmac } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════════
// Test Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const STRIPE_TEST_CONFIG: StripeConfig = {
  secretKey: "sk_test_123",
  publishableKey: "pk_test_123",
  webhookSecret: "whsec_test_123",
};

// ═══════════════════════════════════════════════════════════════════════════════
// Mock Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function createMockResponse(data: unknown, ok = true, status = 200): Response {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok,
    status,
    json: async () => data,
    text: async () => text,
    headers: new Headers(),
  } as unknown as Response;
}

function createStripeSignature(
  payload: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac("sha256", STRIPE_TEST_CONFIG.webhookSecret!)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function createStripeRefundList(
  data: Array<Record<string, unknown>>,
  hasMore = false,
) {
  return {
    object: "list",
    data,
    has_more: hasMore,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe("StripeGateway", () => {
  let gateway: StripeGateway;
  let hooksManager: HooksManager;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    hooksManager = new HooksManager({});
    gateway = new StripeGateway(STRIPE_TEST_CONFIG, hooksManager);
    globalThis.fetch = originalFetch;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Webhook Verification Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("verifyWebhook", () => {
    it("should return true for valid signature", () => {
      const payload = JSON.stringify({ id: "evt_123" });
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${payload}`;
      const signature = createHmac("sha256", STRIPE_TEST_CONFIG.webhookSecret!)
        .update(signedPayload)
        .digest("hex");

      const result = gateway.verifyWebhook(payload, undefined, {
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      });

      expect(result).toBe(true);
    });

    it("should fail for invalid signature", () => {
      const payload = JSON.stringify({ id: "evt_123" });
      const timestamp = Math.floor(Date.now() / 1000);

      const result = gateway.verifyWebhook(payload, undefined, {
        "stripe-signature": `t=${timestamp},v1=invalid_sig`,
      });

      expect(result).toBe(false);
    });

    it("should fail for old timestamp", () => {
      const payload = JSON.stringify({ id: "evt_123" });
      const timestamp = Math.floor(Date.now() / 1000) - 600; // 10 mins ago
      const signedPayload = `${timestamp}.${payload}`;
      const signature = createHmac("sha256", STRIPE_TEST_CONFIG.webhookSecret!)
        .update(signedPayload)
        .digest("hex");

      const result = gateway.verifyWebhook(payload, undefined, {
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      });

      expect(result).toBe(false);
    });

    it("should reject aged timestamps older than 300 seconds", () => {
      const payload = JSON.stringify({ id: "evt_aged" });
      const timestamp = Math.floor(Date.now() / 1000) - 301;
      const signature = createStripeSignature(payload, timestamp);

      expect(gateway.verifyWebhook(payload, signature)).toBe(false);
    });

    it("should reject far-future timestamps outside bidirectional 300s tolerance (STRIPE-4)", () => {
      const payload = JSON.stringify({ id: "evt_future" });
      // 10 minutes in the future — |now - t| > 300 is rejected (stripe-node parity)
      const timestamp = Math.floor(Date.now() / 1000) + 600;
      const signature = createStripeSignature(payload, timestamp);

      expect(gateway.verifyWebhook(payload, signature)).toBe(false);
    });

    it("should accept near-future timestamps within bidirectional 300s tolerance", () => {
      const payload = JSON.stringify({ id: "evt_near_future" });
      const timestamp = Math.floor(Date.now() / 1000) + 60;
      const signature = createStripeSignature(payload, timestamp);

      expect(gateway.verifyWebhook(payload, signature)).toBe(true);
    });

    it("should throw InvalidRequestError when webhook secret is missing (I10)", () => {
      const insecureGateway = new StripeGateway(
        {
          secretKey: "sk_test_123",
        },
        hooksManager,
      );

      expect(() =>
        insecureGateway.verifyWebhook(
          JSON.stringify({ id: "evt_123" }),
          "t=1,v1=test",
        ),
      ).toThrow(InvalidRequestError);
      expect(() =>
        insecureGateway.verifyWebhook(
          JSON.stringify({ id: "evt_123" }),
          "t=1,v1=test",
        ),
      ).toThrow(/stripe\.webhookSecret is required for webhook verification/);
    });

    it("should accept any matching v1 signature in the header", () => {
      const payload = JSON.stringify({ id: "evt_123" });
      const timestamp = Math.floor(Date.now() / 1000);
      const validSignature = createStripeSignature(payload, timestamp);

      const result = gateway.verifyWebhook(
        payload,
        `t=${timestamp},v1=bad_signature,${validSignature.split(",")[1]}`,
      );

      expect(result).toBe(true);
    });

    it("should read stripe-signature headers case-insensitively", () => {
      const payload = JSON.stringify({ id: "evt_123" });
      const signature = createStripeSignature(payload);

      const result = gateway.verifyWebhook(payload, undefined, {
        "STRIPE-SIGNATURE": signature,
      });

      expect(result).toBe(true);
    });

    it("should reject parsed objects because raw body is required", () => {
      const payload = { id: "evt_123" };
      const rawPayload = JSON.stringify(payload);
      const signature = createStripeSignature(rawPayload);

      expect(gateway.verifyWebhook(payload, signature)).toBe(false);
    });

    it("should verify Buffer payloads using the exact raw bytes", () => {
      const payload = Buffer.from([
        0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0xff, 0x7d,
      ]);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", STRIPE_TEST_CONFIG.webhookSecret!)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), payload]))
        .digest("hex");

      expect(
        gateway.verifyWebhook(payload, `t=${timestamp},v1=${signature}`),
      ).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Webhook Parsing Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("parseWebhookEvent", () => {
    it("should parse payment_intent.succeeded event", () => {
      const payload = {
        id: "evt_123",
        type: "payment_intent.succeeded",
        api_version: "2026-02-25.clover",
        created: 1623456789,
        data: {
          object: {
            id: "pi_123",
            object: "payment_intent",
            status: "succeeded",
            amount: 1000,
            amount_received: 1000,
            currency: "usd",
            latest_charge: "ch_123",
            metadata: { paymentId: "internal_123" },
          },
        },
        livemode: false,
      };

      const event = gateway.parseWebhookEvent(payload);

      expect(event.gateway).toBe("stripe");
      expect(event.type).toBe("payment_intent.succeeded");
      expect(event.status).toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(10); // 1000 cents = 10.00
      expect(event.gatewayPaymentId).toBe("pi_123");
      expect(event.paymentId).toBe("internal_123");
      expect(event.livemode).toBe(false);
      expect(event.apiVersion).toBe("2026-02-25.clover");
    });

    it("should not reject Stripe webhook API versions unless explicitly configured", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_default_version",
        type: "payment_intent.succeeded",
        api_version: "2026-04-22.dahlia",
        created: 1623456789,
        data: {
          object: {
            id: "pi_default_version",
            object: "payment_intent",
            status: "succeeded",
            amount: 1000,
            amount_received: 1000,
            currency: "usd",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.apiVersion).toBe("2026-04-22.dahlia");
      expect(event.gatewayPaymentId).toBe("pi_default_version");
    });

    it("should allow configured Stripe webhook API versions", () => {
      const versionedGateway = new StripeGateway(
        {
          ...STRIPE_TEST_CONFIG,
          webhookApiVersion: "2026-04-22.dahlia",
        },
        hooksManager,
      );

      const event = versionedGateway.parseWebhookEvent({
        id: "evt_configured_version",
        type: "payment_intent.succeeded",
        api_version: "2026-04-22.dahlia",
        created: 1623456789,
        data: {
          object: {
            id: "pi_configured_version",
            object: "payment_intent",
            status: "succeeded",
            amount: 1000,
            amount_received: 1000,
            currency: "usd",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.apiVersion).toBe("2026-04-22.dahlia");
      expect(event.gatewayPaymentId).toBe("pi_configured_version");
    });

    it("should reject Stripe webhooks that mismatch an explicit webhook API version", () => {
      const versionedGateway = new StripeGateway(
        {
          ...STRIPE_TEST_CONFIG,
          webhookApiVersion: "2026-02-25.clover",
        },
        hooksManager,
      );

      expect(() =>
        versionedGateway.parseWebhookEvent({
          id: "evt_wrong_version",
          type: "payment_intent.succeeded",
          api_version: "2026-04-22.dahlia",
          created: 1623456789,
          data: {
            object: {
              id: "pi_wrong_version",
              object: "payment_intent",
              status: "succeeded",
              amount: 1000,
              currency: "usd",
              metadata: {},
            },
          },
          livemode: false,
        }),
      ).toThrow(
        "Stripe webhook API version 2026-04-22.dahlia does not match expected 2026-02-25.clover",
      );
    });

    it("should parse raw Buffer payloads", () => {
      const payload = Buffer.from(
        JSON.stringify({
          id: "evt_buffer",
          type: "payment_intent.succeeded",
          created: 1623456789,
          data: {
            object: {
              id: "pi_buffer",
              object: "payment_intent",
              status: "succeeded",
              amount: 1000,
              amount_received: 1000,
              currency: "usd",
              metadata: {},
            },
          },
          livemode: false,
        }),
      );

      const event = gateway.parseWebhookEvent(payload);

      expect(event.gatewayPaymentId).toBe("pi_buffer");
      expect(event.status).toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(10);
    });

    it("should parse checkout.session.completed event", () => {
      const payload = {
        id: "evt_checkout",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_123",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 2000,
            currency: "usd",
            payment_intent: "pi_checkout_123",
            metadata: { paymentId: "internal_checkout_123" },
          },
        },
        livemode: false,
      };

      const event = gateway.parseWebhookEvent(payload);

      expect(event.gateway).toBe("stripe");
      expect(event.type).toBe("checkout.session.completed");
      // S19-CKO-UNEXPANDED: string payment_intent cannot rematch refunds.
      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("payment.processing");
      expect(event.gatewayPaymentId).toBe("pi_checkout_123");
      expect(event.gatewayObjectId).toBe("cs_123");
      expect(event.paymentId).toBe("internal_checkout_123");
    });

    it("STRIPE-CKO-1: hydrated checkout.session.completed after refund is not paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_hydrated_refunded",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_hydrated_refunded",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_hydrated_refunded",
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 10000,
              latest_charge: {
                id: "ch_cs_hydrated_refunded",
                amount_captured: 10000,
                amount_refunded: 10000,
                refunded: true,
                currency: "usd",
              },
            },
            metadata: { paymentId: "order_cs_refunded" },
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(100);
      expect(event.currency).toBe("USD");
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.succeeded");
    });

    it("STRIPE-CKO-1: hydrated checkout.session.completed partial refund is not paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_hydrated_partial_refund",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_hydrated_partial_refund",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_hydrated_partial_refund",
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 10000,
              latest_charge: {
                id: "ch_cs_hydrated_partial_refund",
                amount_captured: 10000,
                amount_refunded: 2500,
                refunded: false,
                currency: "usd",
              },
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(25);
      expect(event.currency).toBe("USD");
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-CKO-1: hydrated checkout.session.completed with charges.data refund is not paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_hydrated_charges_data",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_hydrated_charges_data",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_hydrated_charges_data",
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 10000,
              charges: {
                data: [
                  {
                    id: "ch_cs_hydrated_charges_data",
                    amount_captured: 10000,
                    amount_refunded: 10000,
                    refunded: true,
                    currency: "usd",
                  },
                ],
              },
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(100);
      expect(event.currency).toBe("USD");
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("S19-CKO-AMOUNT: hydrated checkout.session.completed publishes amount_received not amount_total", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_amount_received",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_amount_received",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_amount_received",
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 6000,
              latest_charge: {
                id: "ch_cs_amount_received",
                amount_captured: 6000,
                amount_refunded: 0,
                currency: "usd",
              },
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_captured");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(60);
      expect(moneyToMajorNumber(event.amount!)).not.toBe(100);
      expect(event.currency).toBe("USD");
    });

    it("S19-CKO-UNEXPANDED: classic string payment_intent is processing not paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_string_pi",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_string_pi",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: "pi_cs_string",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-CKO-1: hydrated checkout.session.completed without charge snapshot is processing", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_thin_hydrate",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_thin_hydrate",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_thin_hydrate",
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 10000,
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-CKO-1: async_payment_succeeded after refund is not paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_async_refunded",
        type: "checkout.session.async_payment_succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "cs_async_refunded",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 8000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_async_refunded",
              object: "payment_intent",
              status: "succeeded",
              amount: 8000,
              amount_received: 8000,
              latest_charge: {
                id: "ch_cs_async_refunded",
                amount_captured: 8000,
                amount_refunded: 8000,
                refunded: true,
                currency: "usd",
              },
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(80);
      expect(event.currency).toBe("USD");
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("should parse setup checkout completion as setup_completed", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_setup",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_setup_done",
            object: "checkout.session",
            mode: "setup",
            payment_status: "no_payment_required",
            status: "complete",
            currency: "usd",
            metadata: { paymentId: "setup_123" },
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("setup_completed");
      expect(event.gatewayPaymentId).toBe("cs_setup_done");
      expect(event.paymentId).toBe("setup_123");
    });

    it("should use SetupIntent ID for setup checkout completion when Stripe includes it", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_setup_intent",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_setup_done",
            object: "checkout.session",
            mode: "setup",
            payment_status: "no_payment_required",
            status: "complete",
            setup_intent: "seti_123",
            currency: "usd",
            metadata: { paymentId: "setup_123" },
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("setup_completed");
      expect(event.gatewayPaymentId).toBe("seti_123");
      expect(event.gatewayObjectId).toBe("cs_setup_done");
    });

    it("should mark payment-mode no_payment_required complete as paid (not setup_completed)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_free_payment",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_free_payment",
            object: "checkout.session",
            mode: "payment",
            payment_status: "no_payment_required",
            status: "complete",
            amount_total: 0,
            currency: "usd",
            metadata: { paymentId: "free_order" },
          },
        },
        livemode: false,
      });

      // $0 / free / 100% coupon Checkout: complete + no_payment_required is
      // fulfillment-ready paid. Never setup_completed (vault only).
      expect(event.status).toBe("paid");
      expect(event.status).not.toBe("setup_completed");
      expect(event.status).not.toBe("pending");
      expect(event.stableType).toBe("payment.succeeded");
      expect(event.event?.type).toBe("payment.succeeded");
    });

    it("payment-mode no_payment_required with unset amount_total stays paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_free_unset_total",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_free_unset_total",
            object: "checkout.session",
            mode: "payment",
            payment_status: "no_payment_required",
            status: "complete",
            currency: "usd",
            metadata: { paymentId: "free_unset" },
          },
        },
        livemode: false,
      });

      // Documented: mode payment + omitted amount_total is still $0/coupon paid.
      expect(event.status).toBe("paid");
      expect(event.status).not.toBe("setup_completed");
      expect(event.stableType).toBe("payment.succeeded");
      expect(event.event?.type).toBe("payment.succeeded");
    });

    it("payment-mode no_payment_required with amount_total > 0 must not invent paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_npr_positive",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_npr_positive",
            object: "checkout.session",
            mode: "payment",
            payment_status: "no_payment_required",
            status: "complete",
            amount_total: 2000,
            currency: "usd",
            payment_intent: "pi_npr_positive",
            metadata: { paymentId: "order_npr_positive" },
          },
        },
        livemode: false,
      });

      // Inconsistent snapshot: money is due but Stripe said no payment required.
      // Do not invent paid / payment.succeeded.
      expect(event.status).not.toBe("paid");
      expect(event.status).toBe("pending");
      expect(event.status).not.toBe("setup_completed");
      expect(event.stableType).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.succeeded");
      expect(moneyToMajorNumber(event.amount!)).toBe(20);
      expect(event.gatewayPaymentId).toBe("pi_npr_positive");
    });

    it("STRIPE-2: subscription-mode no_payment_required must not complete as paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_sub_trial",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_sub_trial",
            object: "checkout.session",
            mode: "subscription",
            payment_status: "no_payment_required",
            status: "complete",
            subscription: "sub_trial_123",
            amount_total: 0,
            currency: "usd",
            metadata: { paymentId: "order_sub_trial" },
          },
        },
        livemode: false,
      });

      // Unpaid trial / no-charge subscription signup — not fulfillment-ready.
      // Aligns with customer.subscription trialing → pending.
      expect(event.status).toBe("pending");
      expect(event.status).not.toBe("paid");
      expect(event.status).not.toBe("setup_completed");
      expect(event.stableType).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.succeeded");
      expect(event.gatewayPaymentId).toBe("sub_trial_123");
    });

    it("STRIPE-3: no_payment_required with missing mode fails closed to pending (not paid)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_no_mode",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_no_mode",
            object: "checkout.session",
            // mode intentionally omitted
            payment_status: "no_payment_required",
            status: "complete",
            amount_total: 0,
            currency: "usd",
            metadata: { paymentId: "order_no_mode" },
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("pending");
      expect(event.status).not.toBe("paid");
      expect(event.status).not.toBe("setup_completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("should use Subscription ID for subscription checkout completion", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_subscription",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_sub_done",
            object: "checkout.session",
            mode: "subscription",
            payment_status: "paid",
            status: "complete",
            subscription: "sub_123",
            amount_total: 2000,
            currency: "usd",
            metadata: { paymentId: "order_sub_123" },
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.gatewayPaymentId).toBe("sub_123");
      expect(event.gatewayObjectId).toBe("cs_sub_done");
      expect(moneyToMajorNumber(event.amount!)).toBe(20);
    });

    it("should prefer Subscription ID over PaymentIntent when both are present on subscription checkout", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_checkout_sub_with_pi",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_sub_with_pi",
            object: "checkout.session",
            mode: "subscription",
            payment_status: "paid",
            status: "complete",
            payment_intent: "pi_first_invoice",
            subscription: "sub_preferred",
            amount_total: 2000,
            currency: "usd",
            metadata: { paymentId: "order_sub_both" },
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.gatewayPaymentId).toBe("sub_preferred");
      expect(event.gatewayObjectId).toBe("cs_sub_with_pi");
      expect(event.paymentId).toBe("order_sub_both");
    });

    it("should parse JPY webhook amounts without dividing by 100", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_jpy",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_jpy",
            object: "payment_intent",
            status: "succeeded",
            amount: 500,
            amount_received: 500,
            currency: "jpy",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(moneyToMajorNumber(event.amount!)).toBe(500);
      expect(event.currency).toBe("JPY");
    });

    it("STRIPE-2: omits amount on checkout.session when currency is missing (no usd default)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_no_currency",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_no_currency",
            object: "checkout.session",
            status: "complete",
            payment_status: "paid",
            // amount_total present but currency omitted — must not scale as USD
            amount_total: 5000,
            payment_intent: "pi_cs_no_currency",
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("processing");
      expect(event.currency).toBeUndefined();
      expect(event.amount).toBeUndefined();
    });

    it("STRIPE-2: omits amount on invoice when currency is missing (no usd default)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_inv_no_currency",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_no_currency",
            object: "invoice",
            status: "paid",
            amount_paid: 10000,
            total: 10000,
            // currency omitted — zero-decimal vs two-decimal scale risk
            payment_intent: "pi_inv_no_currency",
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("paid");
      expect(event.currency).toBeUndefined();
      expect(event.amount).toBeUndefined();
    });

    it("should use related PaymentIntent for charge refund events", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_charge_refunded",
        type: "charge.refunded",
        created: 1623456789,
        data: {
          object: {
            id: "ch_123",
            object: "charge",
            status: "succeeded",
            amount: 2500,
            currency: "usd",
            payment_intent: "pi_from_charge",
            metadata: { paymentId: "internal_charge" },
          },
        },
        livemode: false,
      });

      // Incomplete snapshot (no refunded / amount_refunded): fail-closed, not full refunded
      expect(event.status).toBe("refund_completed");
      expect(event.status).not.toBe("refunded");
      expect(event.gatewayPaymentId).toBe("pi_from_charge");
      expect(event.gatewayObjectId).toBe("ch_123");
      // STRIPE-3: omit amount when amount_refunded is incomplete (do not publish charge total)
      expect(event.amount).toBeUndefined();
      // STRIPE-2: incomplete must not dual-write refund.completed
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
      expect(event.stableType).not.toBe("refund.completed");
    });

    it("should mark charge.refunded partial refunds as partially_refunded", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_charge_partial_refunded",
        type: "charge.refunded",
        created: 1623456789,
        data: {
          object: {
            id: "ch_partial",
            object: "charge",
            status: "succeeded",
            amount: 2500,
            amount_refunded: 1200,
            currency: "usd",
            payment_intent: "pi_partial_refund",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_refunded");
      expect(event.gatewayPaymentId).toBe("pi_partial_refund");
      // STRIPE-3: amount is cumulative amount_refunded, not payment/captured total
      expect(moneyToMajorNumber(event.amount!)).toBe(12);
      expect(moneyToMajorNumber(event.amount!)).not.toBe(25);
      // Proven partial dual-writes refund.completed
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      if (event.event?.type === "refund.completed") {
        // Dual-write Refund.amount must match amount_refunded (not charge total)
        expect(moneyToMajorNumber(event.event.refund.amount!)).toBe(12);
      }
    });

    it("should treat charge.refunded===true as full refund and use amount_refunded for amount", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_charge_refunded_flag",
        type: "charge.refunded",
        created: 1623456789,
        data: {
          object: {
            id: "ch_flag_full",
            object: "charge",
            status: "succeeded",
            amount: 10000,
            amount_captured: 6000,
            amount_refunded: 6000,
            refunded: true,
            currency: "usd",
            payment_intent: "pi_flag_full",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      // STRIPE-3: amount from amount_refunded (equals captured on full refund of partial capture)
      expect(moneyToMajorNumber(event.amount!)).toBe(60);
      expect(event.gatewayPaymentId).toBe("pi_flag_full");
      expect(event.stableType).toBe("refund.completed");
    });

    it("should fail closed on charge.refunded when amount_refunded is 0 (not partially_refunded)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_charge_refunded_zero",
        type: "charge.refunded",
        created: 1623456789,
        data: {
          object: {
            id: "ch_zero_refund",
            object: "charge",
            status: "succeeded",
            amount: 2500,
            amount_captured: 2500,
            amount_refunded: 0,
            refunded: false,
            currency: "usd",
            payment_intent: "pi_zero_refund",
            metadata: {},
          },
        },
        livemode: false,
      });

      // Zero amount_refunded is not a proven partial refund.
      expect(event.status).toBe("refund_completed");
      expect(event.status).not.toBe("partially_refunded");
      expect(event.status).not.toBe("refunded");
      // STRIPE-3: omit amount on incomplete refund money
      expect(event.amount).toBeUndefined();
      // STRIPE-2: incomplete dual-write is refund.pending, not refund.completed
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
    });

    it("should compare charge.refunded amount_refunded to amount_captured when present", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_charge_captured_base",
        type: "charge.refunded",
        created: 1623456789,
        data: {
          object: {
            id: "ch_captured_base",
            object: "charge",
            status: "succeeded",
            amount: 10000,
            amount_captured: 6000,
            amount_refunded: 3000,
            refunded: false,
            currency: "usd",
            payment_intent: "pi_captured_base",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_refunded");
      // STRIPE-3: amount is amount_refunded (30), not captured total (60)
      expect(moneyToMajorNumber(event.amount!)).toBe(30);
      expect(moneyToMajorNumber(event.amount!)).not.toBe(60);
    });

    it("should use related PaymentIntent for legacy refund update events", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_updated",
        type: "charge.refund.updated",
        created: 1623456789,
        data: {
          object: {
            id: "re_123",
            object: "refund",
            status: "succeeded",
            amount: 1200,
            currency: "usd",
            payment_intent: "pi_from_refund",
            metadata: { paymentId: "internal_refund" },
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refund_completed");
      expect(event.gatewayPaymentId).toBe("pi_from_refund");
      expect(event.gatewayObjectId).toBe("re_123");
      expect(moneyToMajorNumber(event.amount!)).toBe(12);
      // STRIPE-2: incomplete aggregate → dual-write refund.pending (not completed)
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
    });

    it("should not guess full or partial refund status without expanded charge totals", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_updated_modern",
        type: "refund.updated",
        created: 1623456789,
        data: {
          object: {
            id: "re_modern",
            object: "refund",
            status: "succeeded",
            amount: 1200,
            currency: "usd",
            payment_intent: "pi_modern_refund",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refund_completed");
      expect(event.gatewayPaymentId).toBe("pi_modern_refund");
      expect(moneyToMajorNumber(event.amount!)).toBe(12);
      // STRIPE-2: incomplete aggregate dual-write is pending, not completed
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
    });

    it("should mark refund.created succeeded as completed when aggregate payment state is unknown", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_created_modern",
        type: "refund.created",
        created: 1623456789,
        data: {
          object: {
            id: "re_created",
            object: "refund",
            status: "succeeded",
            amount: 2500,
            currency: "usd",
            payment_intent: "pi_created_refund",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refund_completed");
      expect(event.gatewayPaymentId).toBe("pi_created_refund");
      expect(event.gatewayObjectId).toBe("re_created");
      expect(moneyToMajorNumber(event.amount!)).toBe(25);
      // STRIPE-2: incomplete aggregate dual-write is pending, not completed
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
    });

    it("should mark refund events as fully refunded when expanded charge totals prove it", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_full",
        type: "refund.updated",
        created: 1623456789,
        data: {
          object: {
            id: "re_full",
            object: "refund",
            status: "succeeded",
            amount: 2500,
            currency: "usd",
            payment_intent: "pi_full_refund",
            charge: {
              id: "ch_full",
              amount: 2500,
              amount_refunded: 2500,
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.gatewayPaymentId).toBe("pi_full_refund");
      expect(moneyToMajorNumber(event.amount!)).toBe(25);
    });

    it("should use amount_captured as refund completeness base on expanded charge", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_captured_base",
        type: "refund.updated",
        created: 1623456789,
        data: {
          object: {
            id: "re_captured_base",
            object: "refund",
            status: "succeeded",
            amount: 6000,
            currency: "usd",
            payment_intent: "pi_refund_captured_base",
            charge: {
              id: "ch_refund_captured_base",
              amount: 10000,
              amount_captured: 6000,
              amount_refunded: 6000,
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.gatewayPaymentId).toBe("pi_refund_captured_base");
    });

    it("should treat expanded charge.refunded===true as full refund on refund webhooks", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_flag",
        type: "refund.updated",
        created: 1623456789,
        data: {
          object: {
            id: "re_flag",
            object: "refund",
            status: "succeeded",
            amount: 1000,
            currency: "usd",
            payment_intent: "pi_refund_flag",
            charge: {
              id: "ch_refund_flag",
              amount: 10000,
              amount_captured: 6000,
              amount_refunded: 1000,
              refunded: true,
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      // STRIPE-3: when refunded:true and amount_refunded > 0, amount is cumulative
      expect(moneyToMajorNumber(event.amount!)).toBe(10);
    });

    it("STRIPE-1: refund.* with expanded charge amount_refunded===0 is fail-closed (not partially_refunded)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_zero_agg",
        type: "refund.updated",
        created: 1623456789,
        data: {
          object: {
            id: "re_zero_agg",
            object: "refund",
            status: "succeeded",
            amount: 2500,
            currency: "usd",
            payment_intent: "pi_zero_agg",
            charge: {
              id: "ch_zero_agg",
              amount: 2500,
              amount_captured: 2500,
              amount_refunded: 0,
              refunded: false,
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      // Zero aggregate refunded money is not a proven partial refund.
      expect(event.status).toBe("refund_completed");
      // Dual-write demoted — type-only handlers must not settle as completed.
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
      // Incomplete aggregate keeps per-refund face amount (object.amount).
      expect(moneyToMajorNumber(event.amount!)).toBe(25);
    });

    it.each([
      {
        label: "refund.failed",
        type: "refund.failed",
        objectId: "re_failed",
        stripeStatus: "failed",
        paymentIntent: "pi_refund_failed",
        amount: 2500,
        status: "refund_failed",
        stableType: "refund.failed",
      },
      {
        label: "refund.updated canceled",
        type: "refund.updated",
        objectId: "re_canceled",
        stripeStatus: "canceled",
        paymentIntent: "pi_refund_canceled",
        amount: 1200,
        status: "refund_failed",
        stableType: "refund.failed",
      },
      {
        label: "in-flight refund.updated",
        type: "refund.updated",
        objectId: "re_pending_wh",
        stripeStatus: "pending",
        paymentIntent: "pi_refund_pending",
        amount: 800,
        status: "refund_pending",
        stableType: "refund.pending",
      },
    ] as const)(
      "STRIPE-1: $label maps to $status not payment status",
      ({
        type,
        objectId,
        stripeStatus,
        paymentIntent,
        amount,
        status,
        stableType,
      }) => {
        const event = gateway.parseWebhookEvent({
          id: `evt_${objectId}`,
          type,
          created: 1623456789,
          data: {
            object: {
              id: objectId,
              object: "refund",
              status: stripeStatus,
              amount,
              currency: "usd",
              payment_intent: paymentIntent,
              metadata: {},
            },
          },
          livemode: false,
        });

        expect(event.status).toBe(status);
        expect(event.status).not.toBe("failed");
        expect(event.status).not.toBe("pending");
        expect(event.gatewayPaymentId).toBe(paymentIntent);
        expect(event.stableType).toBe(stableType);
        expect(event.event?.type).toBe(stableType);
        expect(event.stableType).not.toBe("payment.failed");
      },
    );

    it("STRIPE-3: refund.* proven aggregate status publishes amount_refunded not per-refund face", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_refund_agg_amount",
        type: "refund.updated",
        created: 1623456789,
        data: {
          object: {
            id: "re_agg_amount",
            object: "refund",
            status: "succeeded",
            // This single refund is $10; charge already has $35 cumulative refunded.
            amount: 1000,
            currency: "usd",
            payment_intent: "pi_agg_amount",
            charge: {
              id: "ch_agg_amount",
              amount: 10000,
              amount_captured: 10000,
              amount_refunded: 3500,
              refunded: false,
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_refunded");
      // Cumulative amount_refunded (35), not this refund's face (10).
      expect(moneyToMajorNumber(event.amount!)).toBe(35);
      expect(event.stableType).toBe("refund.completed");
      if (event.event?.type === "refund.completed") {
        expect(moneyToMajorNumber(event.event.refund.amount!)).toBe(35);
      }
    });

    it("should normalize paid subscription invoice events", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_invoice_paid",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_123",
            object: "invoice",
            status: "paid",
            amount_paid: 3000,
            total: 3000,
            currency: "usd",
            metadata: {},
            parent: {
              subscription_details: {
                subscription: "sub_invoice_123",
                metadata: { paymentId: "internal_sub_123" },
              },
            },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("paid");
      expect(event.gatewayPaymentId).toBe("sub_invoice_123");
      expect(event.gatewayObjectId).toBe("in_123");
      expect(event.paymentId).toBe("internal_sub_123");
      expect(moneyToMajorNumber(event.amount!)).toBe(30);
    });

    it("should resolve invoice gatewayPaymentId from top-level subscription when payment_intent is absent", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_invoice_sub_only",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_sub_only",
            object: "invoice",
            status: "paid",
            amount_paid: 1500,
            total: 1500,
            currency: "usd",
            subscription: "sub_top_level",
            metadata: { paymentId: "internal_sub_only" },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("paid");
      expect(event.gatewayPaymentId).toBe("sub_top_level");
      expect(event.gatewayObjectId).toBe("in_sub_only");
      expect(event.paymentId).toBe("internal_sub_only");
    });

    it("should prefer payment_intent for invoice.paid and keep subscription as gatewaySubscriptionId", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_invoice_basil",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_basil",
            object: "invoice",
            status: "paid",
            amount_paid: 2000,
            total: 2000,
            currency: "usd",
            payment_intent: "pi_legacy",
            subscription: "sub_legacy_field",
            parent: {
              subscription_details: {
                subscription: "sub_basil_parent",
                metadata: {},
              },
            },
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      // Money events: PI for refunds/captures; dual-ID surfaces the subscription.
      expect(event.gatewayPaymentId).toBe("pi_legacy");
      expect(event.gatewaySubscriptionId).toBe("sub_basil_parent");
      expect(event.gatewayObjectId).toBe("in_basil");
    });

    it("should use payments.data default payment_intent when subscription fields are absent", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_invoice_payments_data",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_payments_data",
            object: "invoice",
            status: "paid",
            amount_paid: 1800,
            total: 1800,
            currency: "usd",
            payments: {
              data: [
                {
                  is_default: true,
                  payment: { payment_intent: "pi_from_payments_data" },
                },
              ],
            },
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      expect(event.gatewayPaymentId).toBe("pi_from_payments_data");
      expect(event.gatewayObjectId).toBe("in_payments_data");
    });

    it("NEW-STRIPE-INV-1: invoice.paid with post-payment credit notes is not full paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_invoice_credit_notes",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_credit_notes",
            object: "invoice",
            status: "paid",
            amount_paid: 3000,
            total: 3000,
            amount_due: 0,
            post_payment_credit_notes_amount: 500,
            currency: "usd",
            payment_intent: "pi_credit_notes",
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(30);
    });

    it("NEW-STRIPE-INV-1: invoice.paid amount does not use amount_due as collected", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_invoice_due_only",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_due_only",
            object: "invoice",
            status: "paid",
            amount_due: 9900,
            total: 9900,
            currency: "usd",
            payment_intent: "pi_due_only",
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      expect(event.amount).toBeUndefined();
      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
    });

    it("NEW-STRIPE-INV-1: invoice.paid void/uncollectible object status is not paid", () => {
      const voided = gateway.parseWebhookEvent({
        id: "evt_invoice_paid_void",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_paid_void",
            object: "invoice",
            status: "void",
            amount_paid: 2000,
            amount_due: 2000,
            currency: "usd",
            payment_intent: "pi_paid_void",
            metadata: {},
          },
        },
        livemode: false,
      } as any);
      expect(voided.status).toBe("cancelled");
      expect(voided.status).not.toBe("paid");

      const uncollectible = gateway.parseWebhookEvent({
        id: "evt_invoice_paid_uncollectible",
        type: "invoice.payment_succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "in_paid_uncollectible",
            object: "invoice",
            status: "uncollectible",
            amount_paid: 2000,
            currency: "usd",
            payment_intent: "pi_paid_uncollectible",
            metadata: {},
          },
        },
        livemode: false,
      } as any);
      expect(uncollectible.status).toBe("failed");
      expect(uncollectible.status).not.toBe("paid");
    });

    it("NEW-STRIPE-SETUP-1: setup_intent.succeeded status is setup_completed", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_seti_succeeded",
        type: "setup_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "seti_ok",
            object: "setup_intent",
            status: "succeeded",
            metadata: { paymentId: "setup_internal" },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("setup_completed");
      expect(event.status).not.toBe("pending");
      expect(event.stableType).toBe("payment_method.setup_completed");
      expect(event.event?.type).toBe("payment_method.setup_completed");
      expect(event.gatewayPaymentId).toBe("seti_ok");
    });

    it("should prefer amount_received for succeeded PaymentIntent webhooks", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_amount_received",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_amount_received",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 10000,
            currency: "usd",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(100);
    });

    it("should mark payment_intent.succeeded partial captures as partially_captured", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_partial_capture_webhook",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_partial_capture_webhook",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 6000,
            currency: "usd",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_captured");
      expect(moneyToMajorNumber(event.amount!)).toBe(60);
      // Phase 7 dual-write: partial ≠ payment.succeeded (Paymob parity)
      expect(event.type).toBe("payment_intent.succeeded");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-3: incomplete settled (no amount_received) dual-write is payment.processing not payment.succeeded", () => {
      // payment_intent.succeeded with no settled snapshot must demote domain
      // status and Phase-7 dual-write (type-only handlers would over-fulfill).
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_missing_received",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_missing_received",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            // amount_received / amount_captured intentionally omitted
            currency: "usd",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.status).not.toBe("partially_captured");
      expect(moneyToMajorNumber(event.amount!)).toBe(100); // authorized amount only (display)
      expect(event.type).toBe("payment_intent.succeeded");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      expect(event.stableType).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.succeeded");
    });

    it("should use amount_captured fallback when amount_received is missing", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_captured_fallback",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_captured_fallback",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
            latest_charge: {
              id: "ch_captured_fallback",
              amount_captured: 6000,
              amount_refunded: 0,
              currency: "usd",
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_captured");
      expect(moneyToMajorNumber(event.amount!)).toBe(60);
      expect(event.stableType).toBe("payment.processing");
    });

    it("should treat amount_captured equal to amount as paid when amount_received missing", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_full_via_captured",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_full_via_captured",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
            latest_charge: {
              id: "ch_full_via_captured",
              amount_captured: 10000,
              amount_refunded: 0,
              currency: "usd",
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(100);
      expect(event.stableType).toBe("payment.succeeded");
    });

    it("STRIPE-2: payment_intent.succeeded with amount_refunded is not paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_succeeded_refunded",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_succeeded_refunded",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 10000,
            currency: "usd",
            latest_charge: {
              id: "ch_succeeded_refunded",
              amount_captured: 10000,
              amount_refunded: 10000,
              refunded: true,
              currency: "usd",
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(100);
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-2: payment_intent.succeeded with partial amount_refunded is partially_refunded", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_succeeded_partial_refund",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_succeeded_partial_refund",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 10000,
            currency: "usd",
            latest_charge: {
              id: "ch_succeeded_partial_refund",
              amount_captured: 10000,
              amount_refunded: 2500,
              refunded: false,
              currency: "usd",
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(25);
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it.each([
      {
        label: "string latest_charge",
        id: "evt_pi_unexpanded_charge",
        pi: "pi_unexpanded_charge",
        latest_charge: "ch_unexpanded_id" as const,
      },
      {
        label: "id-only latest_charge object",
        id: "evt_pi_id_only_charge",
        pi: "pi_id_only_charge",
        latest_charge: { id: "ch_id_only" },
      },
    ])(
      "STRIPE-2: payment_intent.succeeded with $label + amount_received is paid",
      ({ id, pi, latest_charge }) => {
        const event = gateway.parseWebhookEvent({
          id,
          type: "payment_intent.succeeded",
          created: 1623456789,
          data: {
            object: {
              id: pi,
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 10000,
              currency: "usd",
              latest_charge,
              metadata: {},
            },
          },
          livemode: false,
        });

        expect(event.status).toBe("paid");
        expect(moneyToMajorNumber(event.amount!)).toBe(100);
        expect(event.stableType).toBe("payment.succeeded");
        expect(event.event?.type).toBe("payment.succeeded");
      },
    );

    it("STRIPE-2: unexpanded latest_charge without amount_received stays processing", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_unexpanded_missing_received",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_unexpanded_missing_received",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
            latest_charge: "ch_unexpanded_id",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-CHG-1: payment_intent.succeeded omitted latest_charge + charges.data amount_refunded is not paid", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_charges_data_refunded",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_charges_data_refunded",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 10000,
            currency: "usd",
            charges: {
              data: [
                {
                  id: "ch_charges_data_refunded",
                  amount_captured: 10000,
                  amount_refunded: 10000,
                  refunded: true,
                  currency: "usd",
                },
              ],
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(100);
      expect(event.currency).toBe("USD");
      expect(event.stableType).toBe("refund.completed");
      expect(event.event?.type).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("S19-STRIPE-LATE-REFUND: payment_intent.succeeded after charge.refunded is not paid when charges.data proves refunds", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_late_refund",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_late_refund",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            // Stripe does not decrement amount_received on refund.
            amount_received: 10000,
            currency: "usd",
            latest_charge: "ch_late_refund",
            charges: {
              data: [
                {
                  id: "ch_late_refund",
                  amount_captured: 10000,
                  amount_refunded: 4000,
                  refunded: false,
                  currency: "usd",
                },
              ],
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("partially_refunded");
      expect(event.status).not.toBe("paid");
      expect(moneyToMajorNumber(event.amount!)).toBe(40);
      expect(event.stableType).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-CHG-1: unexpanded latest_charge still uses observable charges.data refunds", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_pi_unexpanded_uses_charges_data",
        type: "payment_intent.succeeded",
        created: 1623456789,
        data: {
          object: {
            id: "pi_unexpanded_uses_charges_data",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 10000,
            currency: "usd",
            latest_charge: "ch_unexpanded_id",
            charges: {
              data: [
                {
                  id: "ch_unexpanded_id",
                  amount_captured: 10000,
                  amount_refunded: 10000,
                  refunded: true,
                  currency: "usd",
                },
              ],
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("refund.completed");
      expect(event.stableType).not.toBe("payment.succeeded");
    });

    it("STRIPE-CHG-1: hydrated checkout string latest_charge rematches charges.data refund", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_string_charge_refund",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_string_charge_refund",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_string_charge_refund",
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 10000,
              latest_charge: "ch_cs_string_refund",
              charges: {
                data: [
                  {
                    id: "ch_cs_string_refund",
                    amount_captured: 10000,
                    amount_refunded: 10000,
                    refunded: true,
                    currency: "usd",
                  },
                ],
              },
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("refunded");
      expect(event.status).not.toBe("paid");
      expect(event.status).not.toBe("processing");
      expect(event.stableType).toBe("refund.completed");
    });

    it("NEW-STRIPE-2: hydrated checkout.session.completed with id-only latest_charge is processing", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_cs_id_only_charge",
        type: "checkout.session.completed",
        created: 1623456789,
        data: {
          object: {
            id: "cs_id_only_charge",
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            amount_total: 10000,
            currency: "usd",
            payment_intent: {
              id: "pi_cs_id_only_charge",
              object: "payment_intent",
              status: "succeeded",
              amount: 10000,
              amount_received: 10000,
              latest_charge: { id: "ch_cs_id_only" },
            },
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
    });

    it("S19-STRIPE-DISPUTE: charge.dispute.created does not map a paid envelope to pending", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_dispute_created",
        type: "charge.dispute.created",
        created: 1623456789,
        data: {
          object: {
            id: "dp_created",
            object: "dispute",
            status: "needs_response",
            amount: 10000,
            currency: "usd",
            payment_intent: "pi_disputed_paid",
            charge: "ch_disputed_paid",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).not.toBe("pending");
      expect(event.status).not.toBe("paid");
      expect(event.status).toBe("needs_response");
      expect(event.gatewayPaymentId).toBe("pi_disputed_paid");
      expect(event.stableType).toBe("dispute.opened");
      expect(event.event?.type).toBe("dispute.opened");
      expect(event.event?.type).not.toBe("payment.processing");
      expect(event.event?.type).not.toBe("payment.succeeded");
      if (event.event?.type === "dispute.opened") {
        expect(event.event.dispute.status).toBe("needs_response");
      }
    });

    it("P22R3-PLINK-WH: payment_link.updated is not pending and not a paid payment", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_plink_updated",
        type: "payment_link.updated",
        created: 1623456789,
        data: {
          object: {
            id: "plink_updated",
            object: "payment_link",
            active: true,
            url: "https://buy.stripe.com/test",
          },
        },
        livemode: false,
      });

      expect(event.status).not.toBe("pending");
      expect(event.status).not.toBe("paid");
      expect(event.status).toBe("processing");
      expect(event.stableType).toBeUndefined();
      expect(event.event?.type).toBe("provider.unmapped");
      expect(event.event?.type).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.processing");
    });

    it("S19-STRIPE-DISPUTE: charge.dispute.closed lost is not pending", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_dispute_lost",
        type: "charge.dispute.closed",
        created: 1623456789,
        data: {
          object: {
            id: "dp_lost",
            object: "dispute",
            status: "lost",
            amount: 5000,
            currency: "usd",
            payment_intent: "pi_dispute_lost",
            metadata: {},
          },
        },
        livemode: false,
      });

      expect(event.status).not.toBe("pending");
      expect(event.status).toBe("lost");
      expect(event.stableType).toBe("dispute.closed");
      expect(event.event?.type).toBe("dispute.closed");
    });

    it("should omit currency when Stripe omits it on the webhook object", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_no_currency",
        type: "customer.subscription.deleted",
        created: 1623456789,
        data: {
          object: {
            id: "sub_no_currency",
            object: "subscription",
            status: "canceled",
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      expect(event.currency).toBeUndefined();
      expect(event.gatewayPaymentId).toBe("sub_no_currency");
    });

    it("should normalize failed invoice payment events", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_invoice_failed",
        type: "invoice.payment_failed",
        created: 1623456789,
        data: {
          object: {
            id: "in_failed",
            object: "invoice",
            status: "open",
            amount_due: 4500,
            amount_paid: 0,
            amount_remaining: 4500,
            currency: "usd",
            payment_intent: "pi_invoice_failed",
            metadata: { paymentId: "internal_invoice_failed" },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("failed");
      expect(event.gatewayPaymentId).toBe("pi_invoice_failed");
      expect(event.gatewayObjectId).toBe("in_failed");
      expect(moneyToMajorNumber(event.amount!)).toBe(45);
    });

    it("should normalize subscription lifecycle events", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_sub_deleted",
        type: "customer.subscription.deleted",
        created: 1623456789,
        data: {
          object: {
            id: "sub_deleted",
            object: "subscription",
            status: "canceled",
            currency: "usd",
            metadata: { paymentId: "internal_deleted_sub" },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("cancelled");
      expect(event.gatewayPaymentId).toBe("sub_deleted");
      expect(event.paymentId).toBe("internal_deleted_sub");
    });

    it("should map unpaid subscription status to pending (not cancelled)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_sub_unpaid",
        type: "customer.subscription.updated",
        created: 1623456789,
        data: {
          object: {
            id: "sub_unpaid",
            object: "subscription",
            status: "unpaid",
            currency: "usd",
            metadata: { paymentId: "internal_unpaid_sub" },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("pending");
      expect(event.gatewayPaymentId).toBe("sub_unpaid");
      expect(event.paymentId).toBe("internal_unpaid_sub");
    });

    it("should map trialing subscription status to pending (not paid)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_sub_trialing",
        type: "customer.subscription.updated",
        created: 1623456789,
        data: {
          object: {
            id: "sub_trialing",
            object: "subscription",
            status: "trialing",
            currency: "usd",
            metadata: { paymentId: "internal_trialing_sub" },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("pending");
      expect(event.gatewayPaymentId).toBe("sub_trialing");
    });

    it("should map active subscription status to processing not paid (STRIPE-1)", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_sub_active",
        type: "customer.subscription.updated",
        created: 1623456789,
        data: {
          object: {
            id: "sub_active",
            object: "subscription",
            status: "active",
            currency: "usd",
            metadata: { paymentId: "internal_active_sub" },
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.gatewayPaymentId).toBe("sub_active");
    });

    it("should map incomplete_expired subscription status to cancelled", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_sub_incomplete_expired",
        type: "customer.subscription.updated",
        created: 1623456789,
        data: {
          object: {
            id: "sub_incomplete_expired",
            object: "subscription",
            status: "incomplete_expired",
            currency: "usd",
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      expect(event.status).toBe("cancelled");
    });

    it("should leave unhandled non-payment_intent events pending even for foreign statuses like active", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_unhandled_active",
        type: "customer.tax_id.created",
        created: 1623456789,
        data: {
          object: {
            id: "txi_active",
            object: "tax_id",
            status: "active",
            metadata: {},
          },
        },
        livemode: false,
      } as any);

      // Must not route through PaymentIntent mapStatus (which fails-closed to failed).
      expect(event.status).toBe("pending");
      expect(event.status).not.toBe("failed");
    });

    it("should reject non-snapshot webhook payloads with a clear error", () => {
      expect(() =>
        gateway.parseWebhookEvent({
          id: "evt_thin",
          type: "payment_intent.succeeded",
          created: 1623456789,
          data: {
            object: {
              id: "pi_thin",
              object: "payment_intent",
            },
          },
          livemode: false,
        }),
      ).toThrow(
        "Invalid Stripe webhook payload: expected a snapshot payment_intent object",
      );
    });

    it("Phase 7 dual-write: payment_intent.succeeded → payment.succeeded", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_phase7_ok",
        type: "payment_intent.succeeded",
        api_version: "2026-02-25.clover",
        created: 1623456789,
        data: {
          object: {
            id: "pi_phase7",
            object: "payment_intent",
            status: "succeeded",
            amount: 1000,
            amount_received: 1000,
            currency: "usd",
            metadata: { paymentId: "internal_123" },
          },
        },
        livemode: false,
      });

      expect(event.type).toBe("payment_intent.succeeded");
      expect(event.status).toBe("paid");
      expect(event.schemaVersion).toBe("1");
      expect(event.stableType).toBe("payment.succeeded");
      expect(event.event?.schemaVersion).toBe("1");
      expect(event.event?.type).toBe("payment.succeeded");
      expect(event.provider?.eventType).toBe("payment_intent.succeeded");
      expect(event.provider?.apiVersion).toBe("2026-02-25.clover");
      expect(event.provider?.livemode).toBe(false);
      expect(event.provider?.occurredAt).toBe(
        new Date(1623456789 * 1000).toISOString(),
      );
      expect(event.payloadHash).toBeDefined();
      expect(event.payloadHash).toBe(
        hashWebhookPayload({
          id: "evt_phase7_ok",
          type: "payment_intent.succeeded",
          created: 1623456789,
          object: "pi_phase7",
        }),
      );
      expect(event.payloadHash).not.toBe(hashWebhookPayload(event.rawPayload));

      const envelope = toPersistedPaymentEventEnvelope(event.event!, {
        payloadHash: event.payloadHash,
      });
      assertNoSecretsInEnvelope(envelope);
    });

    it("Phase 7 dual-write: failed / cancelled / refunded stable types", () => {
      const failed = gateway.parseWebhookEvent({
        id: "evt_f",
        type: "payment_intent.payment_failed",
        created: 1623456789,
        data: {
          object: {
            id: "pi_f",
            object: "payment_intent",
            status: "requires_payment_method",
            amount: 1000,
            currency: "usd",
            metadata: {},
          },
        },
        livemode: true,
      });
      expect(failed.stableType).toBe("payment.failed");
      expect(failed.event?.type).toBe("payment.failed");
      if (failed.event?.type === "payment.failed") {
        expect(failed.event.failure).toBeDefined();
      }

      const cancelled = gateway.parseWebhookEvent({
        id: "evt_c",
        type: "payment_intent.canceled",
        created: 1623456789,
        data: {
          object: {
            id: "pi_c",
            object: "payment_intent",
            status: "canceled",
            amount: 1000,
            currency: "usd",
            metadata: {},
          },
        },
        livemode: false,
      });
      expect(cancelled.stableType).toBe("payment.cancelled");

      const refunded = gateway.parseWebhookEvent({
        id: "evt_r",
        type: "charge.refunded",
        created: 1623456789,
        data: {
          object: {
            id: "ch_r",
            object: "charge",
            status: "succeeded",
            amount: 1000,
            amount_refunded: 1000,
            refunded: true,
            currency: "usd",
            metadata: {},
            payment_intent: "pi_r",
          },
        },
        livemode: false,
      });
      expect(refunded.type).toBe("charge.refunded");
      expect(refunded.stableType).toBe("refund.completed");
      expect(refunded.event?.type).toBe("refund.completed");
    });

    it("Phase 7 dual-write: invoice events stay provider.unmapped", () => {
      const event = gateway.parseWebhookEvent({
        id: "evt_inv",
        type: "invoice.paid",
        created: 1623456789,
        data: {
          object: {
            id: "in_1",
            object: "invoice",
            status: "paid",
            amount_paid: 1000,
            total: 1000,
            currency: "usd",
            metadata: {},
            parent: {
              subscription_details: {
                subscription: "sub_invoice_1",
                metadata: {},
              },
            },
          },
        },
        livemode: false,
      } as any);
      expect(event.type).toBe("invoice.paid");
      expect(event.stableType).toBeUndefined();
      expect(event.event?.type).toBe("provider.unmapped");
      expect(event.provider?.eventType).toBe("invoice.paid");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Create Payment Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("createPayment", () => {
    it("should create payment intent", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_321",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 5000,
          currency: "usd",
          client_secret: "pi_321_secret",
          next_action: {
            type: "redirect_to_url",
            redirect_to_url: { url: "https://stripe.example/next" },
          },
        });
      }) as unknown as typeof fetch;

      const params: CreatePaymentParams = {
        amount: money(50, "USD"),
        currency: "USD",
        callbackUrl: "https://example.com",
        description: "Test Charge",
      };

      const result = await gateway.createPayment(params);

      expect(result.gatewayId).toBe("pi_321");
      expect(moneyToMajorNumber(result.amount!)).toBe(50);
      expect(result.status).toBe("pending");
      expect(result.clientSecret).toBe("pi_321_secret");
      expect(result.nextAction).toEqual({
        type: "redirect_to_url",
        redirect_to_url: { url: "https://stripe.example/next" },
      });
      expect(result.redirectUrl).toBe("https://stripe.example/next");
      expect(new URLSearchParams(capturedBody).get("amount")).toBe("5000");
      // Phase 6: requires_payment_method / next_action is requires_action, not succeeded
      expect(result.outcome).toBe("requires_action");
      expect(result.outcome).not.toBe("succeeded");
      expect(result.references?.providerObjectId).toBe("pi_321");
      expect(result.references?.providerNativeStatus).toBe(
        "requires_payment_method",
      );
    });

    it("should create JPY payment intent without multiplying by 100", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_jpy",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 5000,
          currency: "jpy",
          client_secret: "pi_jpy_secret",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(5000, "JPY"),
        currency: "JPY",
        callbackUrl: "https://example.com",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("amount")).toBe("5000");
      expect(params.get("currency")).toBe("jpy");
      expect(moneyToMajorNumber(result.amount!)).toBe(5000);
    });

    it("should reject unknown currency codes like JYP (not default exponent 2)", async () => {
      await expect(
        gateway.createPayment({
          amount: { amount: "1000", currency: "JYP" } as Money,
          currency: "JYP",
          callbackUrl: "https://example.com",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it.each([
      // Stripe zero-decimal (ISO MGA is 2) — 500 majors → 500 minor
      { currency: "MGA", amount: 500, expectedMinor: "500" },
      // Stripe two-decimal specials (ISO ISK/UGX are 0) — 10 majors → 1000 minor
      { currency: "ISK", amount: 10, expectedMinor: "1000" },
      { currency: "UGX", amount: 10, expectedMinor: "1000" },
    ] as const)(
      "keeps Stripe-specific exponent tables for $currency",
      async ({ currency, amount, expectedMinor }) => {
        let capturedBody = "";
        globalThis.fetch = mock(async (_url, opts: RequestInit) => {
          capturedBody = opts.body as string;
          return createMockResponse({
            id: "pi_stripe_exp",
            object: "payment_intent",
            status: "requires_payment_method",
            amount: Number(expectedMinor),
            currency: currency.toLowerCase(),
            client_secret: "pi_stripe_exp_secret",
          });
        }) as unknown as typeof fetch;

        await gateway.createPayment({
          amount: money(amount, currency),
          currency,
          callbackUrl: "https://example.com",
        });

        expect(new URLSearchParams(capturedBody).get("amount")).toBe(
          expectedMinor,
        );
      },
    );

    it("should create three-decimal currency payment intents in minor units", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_kwd",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 1230,
          currency: "kwd",
          client_secret: "pi_kwd_secret",
        });
      }) as unknown as typeof fetch;

      // Stripe three-decimal amounts must be divisible by 10 in minor units (1.230 → 1230).
      const result = await gateway.createPayment({
        amount: money(1.23, "KWD"),
        currency: "KWD",
        callbackUrl: "https://example.com",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("amount")).toBe("1230");
      expect(params.get("currency")).toBe("kwd");
      expect(moneyToMajorNumber(result.amount!)).toBe(1.23);
    });

    it("should reject three-decimal currency amounts not divisible by 10 in minor units", async () => {
      await expect(
        gateway.createPayment({
          amount: money(1.234, "KWD"),
          currency: "KWD",
          callbackUrl: "https://example.com",
        }),
      ).rejects.toThrow(
        "Stripe KWD minor-unit amounts must be divisible by 10",
      );
    });

    it("should confirm payment if method ID provided", async () => {
      // Mock fetch to verify body params
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_confirmed",
          status: "succeeded",
          amount: 2000,
        });
      }) as unknown as typeof fetch;

      await gateway.createPayment({
        amount: money(20, "USD"),
        currency: "USD",
        callbackUrl: "http://cb",
        stripePaymentMethodId: "pm_card_visa",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("confirm")).toBe("true");
      expect(params.get("payment_method")).toBe("pm_card_visa");
      expect(params.get("return_url")).toBe("http://cb");
      expect(
        params.get("automatic_payment_methods[allow_redirects]"),
      ).toBeNull();
    });

    it("should disable redirect payment methods when confirming without callbackUrl", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_no_return_url",
          status: "succeeded",
          amount: 2000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.createPayment({
        amount: money(20, "USD"),
        currency: "USD",
        stripePaymentMethodId: "pm_card_visa",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("confirm")).toBe("true");
      expect(params.get("return_url")).toBeNull();
      expect(params.get("automatic_payment_methods[enabled]")).toBe("true");
      expect(params.get("automatic_payment_methods[allow_redirects]")).toBe(
        "never",
      );
    });

    it("should create payment with manual capture when capture is false", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_manual",
          status: "requires_capture",
          amount: 5000,
        });
      }) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
        callbackUrl: "http://cb",
        capture: false,
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("capture_method")).toBe("manual");
      expect(result.status).toBe("authorized");
    });

    it("should not force automatic capture when capture is true/defaulted", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_default_capture",
          status: "requires_payment_method",
          amount: 5000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
        callbackUrl: "http://cb",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("capture_method")).toBeNull();
    });

    it("should reject metadata objects because Stripe metadata is scalar strings", async () => {
      await expect(
        gateway.createPayment({
          amount: money(50, "USD"),
          currency: "USD",
          callbackUrl: "http://cb",
          metadata: { nested: { id: "x" } },
        }),
      ).rejects.toThrow(
        'Stripe metadata value for "nested" must be a string, number, or boolean',
      );
    });

    it("should reject amounts with too many decimals", async () => {
      await expect(
        gateway.createPayment({
          amount: { amount: "10.999", currency: "USD" } as Money,
          currency: "USD",
          callbackUrl: "http://cb",
        }),
      ).rejects.toThrow(
        "Stripe USD amounts cannot have more decimal places than the currency supports",
      );
    });

    it("should accept Money amount input for createPayment", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_money",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 1050,
          currency: "usd",
          client_secret: "pi_money_secret",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money("10.50", "USD"),
        currency: "USD",
        callbackUrl: "https://example.com",
      });

      expect(new URLSearchParams(capturedBody).get("amount")).toBe("1050");
      expect(moneyToMajorNumber(result.amount!)).toBe(10.5);
    });

    it("should leave settlement-dependent minimum amount validation to Stripe", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_small",
          status: "requires_payment_method",
          amount: 49,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.createPayment({
        amount: money(0.49, "USD"),
        currency: "USD",
        callbackUrl: "http://cb",
      });

      expect(new URLSearchParams(capturedBody).get("amount")).toBe("49");
    });

    it("should reject charges above the currency-specific Stripe maximum", async () => {
      await expect(
        gateway.createPayment({
          amount: money(1000000, "USD"),
          currency: "USD",
          callbackUrl: "http://cb",
        }),
      ).rejects.toThrow("Stripe USD amount must be at most 99999999");
    });

    it("should allow higher Stripe maximums for currencies that support them", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_large_jpy",
          status: "requires_payment_method",
          amount: 100000000,
          currency: "jpy",
        });
      }) as unknown as typeof fetch;

      await gateway.createPayment({
        amount: money(100000000, "JPY"),
        currency: "JPY",
        callbackUrl: "http://cb",
      });

      expect(new URLSearchParams(capturedBody).get("amount")).toBe("100000000");
    });

    it("should reject JPY charges above the 12-digit card maximum", async () => {
      await expect(
        gateway.createPayment({
          amount: money(1000000000000, "JPY"), // 13 digits in minor units (JPY is zero-decimal)
          currency: "JPY",
          callbackUrl: "http://cb",
        }),
      ).rejects.toThrow(
        "Stripe JPY amount must be at most 999999999999",
      );
    });

    it("should accept valid decimal amounts affected by floating point representation", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_decimal",
          status: "requires_payment_method",
          amount: 129,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(1.29, "USD"),
        currency: "USD",
      });

      expect(new URLSearchParams(capturedBody).get("amount")).toBe("129");
      expect(moneyToMajorNumber(result.amount!)).toBe(1.29);
      // STRIPE-1: currency published with major-unit amount
      expect(result.currency).toBe("USD");
    });

    it("STRIPE-1: createPayment publishes currency with major-unit amount", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_currency",
          status: "requires_payment_method",
          amount: 5000,
          currency: "usd",
          client_secret: "cs_test",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
      });

      expect(moneyToMajorNumber(result.amount!)).toBe(50);
      expect(result.currency).toBe("USD");
    });

    it("should fail closed on createPayment when PI succeeded but settled amount missing", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_create_incomplete",
          object: "payment_intent",
          status: "succeeded",
          amount: 5000,
          currency: "usd",
          client_secret: null,
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
        stripePaymentMethodId: "pm_card_visa",
      });

      // STRIPE-3: never map succeeded→paid without settled amount.
      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(result.outcome).not.toBe("succeeded");
      expect(moneyToMajorNumber(result.amount!)).toBe(50);
    });

    it("NEW-STRIPE-3: empty HTTP 200 on create is indeterminate, not failed/pending", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse(""),
      ) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.status).not.toBe("pending");
    });

    it("NEW-STRIPE-3: HTTP 200 {} on create is indeterminate, not failed/pending", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({}),
      ) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.status).not.toBe("pending");
      expect(result.amount).toBeUndefined();
    });

    it("NEW-STRIPE-3: create HTTP 200 with id but no status is indeterminate, not failed", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({ id: "pi_missing_status", object: "payment_intent" }),
      ) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
    });

    it("NEW-STRIPE-3: non-JSON HTTP 200 on create is indeterminate, not failed", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse("<html>upstream</html>"),
      ) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
    });

    it("should mark createPayment paid when succeeded with amount_received", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_create_paid",
          object: "payment_intent",
          status: "succeeded",
          amount: 5000,
          amount_received: 5000,
          currency: "usd",
          client_secret: null,
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.createPayment({
        amount: money(50, "USD"),
        currency: "USD",
        stripePaymentMethodId: "pm_card_visa",
      });

      expect(result.status).toBe("paid");
      expect(result.outcome).toBe("succeeded");
    });

    it("should reject Stripe metadata keys that exceed Stripe limits", async () => {
      await expect(
        gateway.createPayment({
          amount: money(50, "USD"),
          currency: "USD",
          metadata: { ["x".repeat(41)]: "value" },
        }),
      ).rejects.toThrow("must be 40 characters or fewer");
    });

    it("should reject Stripe metadata keys with square brackets", async () => {
      await expect(
        gateway.createPayment({
          amount: money(50, "USD"),
          currency: "USD",
          metadata: { "bad[key]": "value" },
        }),
      ).rejects.toThrow("cannot contain square brackets");
    });

    it("should revalidate params modified by hooks before sending to Stripe", async () => {
      const hookGateway = new StripeGateway(
        STRIPE_TEST_CONFIG,
        new HooksManager({
          beforeCreatePayment: (ctx) => ({
            proceed: true,
            params: {
              ...(ctx.params as CreatePaymentParams),
              amount: -1,
            },
          }),
        }),
      );

      await expect(
        hookGateway.createPayment({
          amount: money(50, "USD"),
          currency: "USD",
          callbackUrl: "http://cb",
        }),
      ).rejects.toThrow("Validation failed for createPayment");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Capture Payment Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("capturePayment", () => {
    it("should capture payment intent", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_cap",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.capturePayment({
        gatewayPaymentId: "pi_cap",
        idempotencyKey: "idem_stripe_test_key",
      });
      expect(result.status).toBe("paid");
      expect(moneyToMajorNumber(result.amount!)).toBe(100);
      // STRIPE-1: currency accompanies amount
      expect(result.currency).toBe("USD");
      expect(new URLSearchParams(capturedBody).toString()).toBe("");
      expect(result.outcome).toBe("succeeded");
      expect(result.references?.providerObjectId).toBe("pi_cap");
      expect(result.references?.providerNativeStatus).toBe("succeeded");
    });

    it("should mark partial capturePayment as partially_captured", async () => {
      // STRIPE-1: GET PI (currency bind) then POST capture — same currency shape works for both.
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_cap_partial",
          status: "succeeded",
          amount: 10000,
          amount_received: 6000,
          currency: "usd",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.capturePayment({
        gatewayPaymentId: "pi_cap_partial",
        amount: money(60, "USD"),
        currency: "USD",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.status).toBe("partially_captured");
      expect(moneyToMajorNumber(result.amount!)).toBe(60);
      // STRIPE-2: open money is not outcome-succeeded (Paymob parity / isPaidOutcome).
      expect(result.outcome).toBe("requires_action");
      expect(result.outcome).not.toBe("succeeded");
    });

    it("should fail closed when capture response omits amount_received and amount_captured", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_cap_incomplete",
          status: "succeeded",
          amount: 10000,
          currency: "usd",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.capturePayment({
        gatewayPaymentId: "pi_cap_incomplete",
        idempotencyKey: "idem_stripe_test_key",
      });

      // STRIPE-2: missing settled amount → not paid; amount uses auth (not 0).
      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(moneyToMajorNumber(result.amount!)).toBe(100);
      expect(result.outcome).not.toBe("succeeded");
    });

    it("NEW-STRIPE-3: capture HTTP 200 with id but no status is indeterminate, not failed", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({ id: "pi_cap_missing_status", object: "payment_intent" }),
      ) as unknown as typeof fetch;

      const result = await gateway.capturePayment({
        gatewayPaymentId: "pi_cap_missing_status",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
    });

    it("should use amount_captured for capture status/amount when amount_received missing", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_cap_via_charge",
          status: "succeeded",
          amount: 10000,
          currency: "usd",
          latest_charge: {
            id: "ch_cap_via_charge",
            amount_captured: 6000,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.capturePayment({
        gatewayPaymentId: "pi_cap_via_charge",
        amount: money(60, "USD"),
        currency: "USD",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.status).toBe("partially_captured");
      expect(moneyToMajorNumber(result.amount!)).toBe(60);
    });

    it("should capture JPY partial amount without multiplying by 100", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        // Capture POST body only (STRIPE-1 GET PI first for currency bind).
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.method === "POST" && opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "pi_cap_jpy",
          status: "succeeded",
          amount: 750,
          amount_received: 750,
          currency: "jpy",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.capturePayment({
        gatewayPaymentId: "pi_cap_jpy",
        amount: money(750, "JPY"),
        currency: "JPY",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(new URLSearchParams(capturedBody).get("amount_to_capture")).toBe(
        "750",
      );
      expect(moneyToMajorNumber(result.amount!)).toBe(750);
      expect(result.status).toBe("paid");
    });

    it("should leave capturable amount limits to Stripe for partial captures", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.method === "POST" && opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "pi_cap_large",
          status: "succeeded",
          amount: 100000000,
          amount_received: 100000000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.capturePayment({
        gatewayPaymentId: "pi_cap_large",
        amount: money(1000000, "USD"),
        currency: "USD",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(new URLSearchParams(capturedBody).get("amount_to_capture")).toBe(
        "100000000",
      );
    });

    it("should reject partial capture without currency", async () => {
      await expect(
        gateway.capturePayment({
          gatewayPaymentId: "pi_cap_missing_currency",
          amount: money(10, "USD"),
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toThrow(
        "Stripe capturePayment requires currency when amount is provided",
      );
    });

    it("STRIPE-1: rejects partial capture when caller currency mismatches PaymentIntent", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_cap_currency_mismatch",
          object: "payment_intent",
          status: "requires_capture",
          amount: 10000,
          currency: "usd",
        }),
      ) as unknown as typeof fetch;

      // PI is USD; caller claims JPY → would convert 50 (zero-decimal) instead of 5000 cents.
      await expect(
        gateway.capturePayment({
          gatewayPaymentId: "pi_cap_currency_mismatch",
          amount: money(50, "JPY"),
          currency: "JPY",
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toThrow(
        /capturePayment currency JPY does not match PaymentIntent currency USD/i,
      );
    });

    it("STRIPE-1: partial capture converts majors with PaymentIntent currency scale", async () => {
      let capturedBody: string = "";
      let getCount = 0;
      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        if (opts.method === "GET" || opts.body === undefined) {
          getCount += 1;
          return createMockResponse({
            id: "pi_cap_usd_scale",
            object: "payment_intent",
            status: "requires_capture",
            amount: 10000,
            currency: "usd",
          });
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "pi_cap_usd_scale",
          status: "succeeded",
          amount: 10000,
          amount_received: 5000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.capturePayment({
        gatewayPaymentId: "pi_cap_usd_scale",
        amount: money(50, "USD"),
        currency: "USD",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(getCount).toBeGreaterThanOrEqual(1);
      expect(new URLSearchParams(capturedBody).get("amount_to_capture")).toBe(
        "5000",
      );
      expect(result.status).toBe("partially_captured");
      expect(moneyToMajorNumber(result.amount!)).toBe(50);
      expect(result.currency).toBe("USD");
    });

    it("should reject malformed PaymentIntent IDs before building request URLs", async () => {
      await expect(
        gateway.capturePayment({
          gatewayPaymentId: "pi_cap/../charges",
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toThrow("Stripe PaymentIntent ID must start with pi_");
    });

    it("S19-EPHEMERAL-KEY: capturePayment requires caller idempotencyKey before POST", async () => {
      let fetchCalls = 0;
      globalThis.fetch = mock(async () => {
        fetchCalls += 1;
        return createMockResponse({
          id: "pi_cap_nokey",
          status: "succeeded",
          amount: 1000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await expect(
        gateway.capturePayment({ gatewayPaymentId: "pi_cap_nokey" }),
      ).rejects.toThrow(/requires idempotencyKey/i);
      expect(fetchCalls).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Void Payment Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("voidPayment", () => {
    it("should cancel payment intent", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_cancel",
          status: "canceled",
          amount: 5000,
          currency: "usd",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.voidPayment({
        gatewayPaymentId: "pi_cancel",
        idempotencyKey: "idem_stripe_test_key",
      });
      expect(result.outcome).toBe("succeeded");
      expect(result.status).toBe("cancelled");
    });

    it("NEW-STRIPE-VOID-1: HTTP 200 {id} without status is not declined", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_void_missing_status",
          object: "payment_intent",
          amount: 5000,
          currency: "usd",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.voidPayment({
        gatewayPaymentId: "pi_void_missing_status",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.outcome).not.toBe("declined");
      expect(result.outcome).not.toBe("succeeded");
      expect(result.status).not.toBe("failed");
      expect(result.status).not.toBe("cancelled");
    });

    it("S19-EPHEMERAL-KEY: voidPayment requires caller idempotencyKey before POST", async () => {
      let fetchCalls = 0;
      globalThis.fetch = mock(async () => {
        fetchCalls += 1;
        return createMockResponse({
          id: "pi_void_nokey",
          status: "canceled",
          amount: 1000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await expect(
        gateway.voidPayment({ gatewayPaymentId: "pi_void_nokey" }),
      ).rejects.toThrow(/requires idempotencyKey/i);
      expect(fetchCalls).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Checkout Session Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("createCheckoutSession", () => {
    it("should create checkout session with simple amount", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "cs_test_123",
          object: "checkout.session",
          url: "https://checkout.stripe.com/test",
          status: "open",
          payment_status: "unpaid",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      const params = new URLSearchParams(capturedBody);
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(result.session.references.providerObjectId).toBe("cs_test_123");
      expect(result.session.url).toBe("https://checkout.stripe.com/test");

      expect(params.get("mode")).toBe("payment");
      expect(params.get("success_url")).toBe("https://success");
      // Check line items structure for simple amount
      expect(params.get("line_items[0][price_data][unit_amount]")).toBe(
        "10000",
      ); // 100 * 100
      expect(params.get("line_items[0][quantity]")).toBe("1");
      // No amount_total on the 200 body — do not invent major 0.
      expect(result.session.amount).toBeUndefined();
    });

    it("P22-CKO-CREATE-AMOUNT: HTTP 200 with amount_total and currency publishes major amount", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_amount_total",
          object: "checkout.session",
          url: "https://checkout.stripe.com/test",
          status: "open",
          payment_status: "unpaid",
          amount_total: 10000,
          currency: "usd",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(moneyToMajorNumber(result.session.amount!)).toBe(100);
      expect(result.session.currency).toBe("USD");
    });

    it("P22-CKO-CREATE-PI: HTTP 200 maps payment_intent onto relatedIds.paymentIntentId", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_with_pi",
          object: "checkout.session",
          url: "https://checkout.stripe.com/test",
          status: "open",
          payment_status: "unpaid",
          payment_intent: "pi_from_create",
        }),
      ) as unknown as typeof fetch;

      const asString = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_create_pi_string",
      });

      expect(asString.outcome).toBe("succeeded");
      if (asString.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(asString.session.references.relatedIds?.paymentIntentId).toBe(
        "pi_from_create",
      );

      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_with_pi_obj",
          object: "checkout.session",
          url: "https://checkout.stripe.com/test",
          status: "open",
          payment_status: "unpaid",
          payment_intent: { id: "pi_from_create_obj" },
        }),
      ) as unknown as typeof fetch;

      const asObject = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_create_pi_obj",
      });

      expect(asObject.outcome).toBe("succeeded");
      if (asObject.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(asObject.session.references.relatedIds?.paymentIntentId).toBe(
        "pi_from_create_obj",
      );
    });

    it("P22-CKO-CREATE-AMOUNT: amount_total without currency omits amount", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_amount_no_currency",
          object: "checkout.session",
          url: "https://checkout.stripe.com/test",
          status: "open",
          payment_status: "unpaid",
          amount_total: 10000,
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(result.session.currency).toBeUndefined();
      expect(result.session.amount).toBeUndefined();
    });

    it("NEW-STRIPE-CKO-200 / S19-CKO-TIMEOUT: empty HTTP 200 on createCheckoutSession is checkout-shaped indeterminate, not success:true", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse(""),
      ) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.session?.references.providerObjectId).toBe(
        "idem_stripe_test_key",
      );
      expect(result.session?.status).not.toBe("open");
      expect(result).not.toEqual(
        expect.objectContaining({ status: "processing" }),
      );
      expect(result).not.toEqual(
        expect.objectContaining({ gatewayId: "idem_stripe_test_key" }),
      );
      expect(result).not.toEqual(
        expect.objectContaining({ success: true }),
      );
    });

    it("NEW-STRIPE-CKO-200 / S19-CKO-TIMEOUT: HTTP 200 {} on createCheckoutSession is checkout-shaped indeterminate, not success:true", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({}),
      ) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result).not.toEqual(expect.objectContaining({ success: true }));
      expect(result).not.toEqual(
        expect.objectContaining({ status: "processing" }),
      );
    });

    it("NEW-STRIPE-CKO-URL: createCheckoutSession null url is not a string url", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_no_url",
          object: "checkout.session",
          url: null,
          status: "open",
          payment_status: "unpaid",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(result.session.references.providerObjectId).toBe("cs_no_url");
      expect(typeof result.session.url).not.toBe("string");
      expect(result.session.url).toBeUndefined();
    });

    it("P22R3-URL-SCHEME: javascript: session url is omitted", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_js_url",
          object: "checkout.session",
          url: "javascript:alert(1)",
          status: "open",
          payment_status: "unpaid",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money(100, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(result.session.url).toBeUndefined();
      expect(isHostedCheckoutRedirect(result)).toBe(false);
    });

    it("should accept Money amount input for simple createCheckoutSession", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "cs_money_simple",
          object: "checkout.session",
          url: "https://checkout.stripe.com/money-simple",
          status: "open",
          payment_status: "unpaid",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.createCheckoutSession({
        amount: money("100.00", "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      const params = new URLSearchParams(capturedBody);
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("createCheckoutSession must succeed");
      }
      expect(result.session.references.providerObjectId).toBe("cs_money_simple");
      expect(params.get("line_items[0][price_data][unit_amount]")).toBe("10000");
      expect(params.get("line_items[0][price_data][currency]")).toBe("usd");
    });

    it("should create checkout session with JPY simple amount without multiplying by 100", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "cs_jpy",
          object: "checkout.session",
          url: "https://checkout.stripe.com/jpy",
          status: "open",
          payment_status: "unpaid",
        });
      }) as unknown as typeof fetch;

      await gateway.createCheckoutSession({
        amount: money(5000, "JPY"),
        currency: "JPY",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("line_items[0][price_data][currency]")).toBe("jpy");
      expect(params.get("line_items[0][price_data][unit_amount]")).toBe("5000");
    });

    it("payment-mode createCheckoutSession without cancelUrl is rejected before fetch", async () => {
      let fetchCalls = 0;
      globalThis.fetch = mock(async () => {
        fetchCalls += 1;
        return createMockResponse({});
      }) as unknown as typeof fetch;

      await expect(
        gateway.createCheckoutSession({
          amount: money(20, "USD"),
          currency: "USD",
          successUrl: "https://success",
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
      expect(fetchCalls).toBe(0);
    });

    it("should create checkout session with line items and customer email", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "cs_test_lines",
          url: "https://checkout",
        });
      }) as unknown as typeof fetch;

      await gateway.createCheckoutSession({
        successUrl: "https://s",
        cancelUrl: "https://c",
        customerEmail: "test@example.com",
        lineItems: [
          {
            price: "price_123",
            quantity: 2,
          },
        ],
        idempotencyKey: "idem_stripe_test_key",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("customer_email")).toBe("test@example.com");
      expect(params.get("line_items[0][price]")).toBe("price_123");
      expect(params.get("line_items[0][quantity]")).toBe("2");
    });

    it("should reject checkout sessions that include both customerId and customerEmail", async () => {
      await expect(
        gateway.createCheckoutSession({
          amount: money(20, "USD"),
          currency: "USD",
          successUrl: "https://success",
          cancelUrl: "https://cancel",
          customerId: "cus_123",
          customerEmail: "test@example.com",
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toThrow(
        "Stripe Checkout Sessions cannot include both customerId and customerEmail",
      );
    });

    it("S19-EPHEMERAL-KEY: createCheckoutSession requires caller idempotencyKey", async () => {
      let fetchCalls = 0;
      globalThis.fetch = mock(async () => {
        fetchCalls += 1;
        return createMockResponse({
          id: "cs_auto_idem",
          object: "checkout.session",
          url: "https://checkout.stripe.com/auto-idem",
          status: "open",
          payment_status: "unpaid",
        });
      }) as unknown as typeof fetch;

      await expect(
        gateway.createCheckoutSession({
          amount: money(20, "USD"),
          currency: "USD",
          successUrl: "https://success",
          cancelUrl: "https://cancel",
        }),
      ).rejects.toThrow(/requires idempotencyKey/i);
      expect(fetchCalls).toBe(0);
    });

    it("should reject whitespace-only idempotencyKey at validation", async () => {
      await expect(
        gateway.createCheckoutSession({
          amount: money(20, "USD"),
          currency: "USD",
          successUrl: "https://success",
          cancelUrl: "https://cancel",
          idempotencyKey: "   ",
        }),
      ).rejects.toThrow(/idempotencyKey|Validation failed/i);
    });

    it("S19-CKO-TIMEOUT: mutating checkout POST timeout is not a retryable failed-create", async () => {
      const timeoutGateway = new StripeGateway(
        {
          ...STRIPE_TEST_CONFIG,
          timeoutMs: 1,
        },
        hooksManager,
      );

      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }) as unknown as typeof fetch;

      const result = await timeoutGateway.createCheckoutSession({
        amount: money(10, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_cko_timeout",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.session?.references.providerObjectId).toBe(
        "idem_cko_timeout",
      );
      expect(result.session?.status).not.toBe("open");
      expect(result).not.toEqual(
        expect.objectContaining({ status: "failed" }),
      );
      expect(result).not.toEqual(
        expect.objectContaining({ status: "processing" }),
      );
    });
  });

  it("should create checkout session in subscription mode", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_sub_123",
        object: "checkout.session",
        mode: "subscription",
        url: "https://checkout.stripe.com/sub",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      mode: "subscription",
      lineItems: [{ price: "price_recurring_123", quantity: 1 }],
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("mode")).toBe("subscription");
    expect(params.get("line_items[0][price]")).toBe("price_recurring_123");
  });

  it("should create checkout session in setup mode (no line items)", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_setup_123",
        object: "checkout.session",
        mode: "setup",
        url: "https://checkout.stripe.com/setup",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      mode: "setup",
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      currency: "USD",
      customerId: "cus_123",
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("mode")).toBe("setup");
    expect(params.get("currency")).toBe("usd");
    expect(params.get("customer")).toBe("cus_123");
    // Ensure no line items are sent for setup mode defaults
    expect(params.toString().includes("line_items")).toBe(false);
  });

  it("should create checkout session with base-unit priceData amount", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_amount_price_data",
        object: "checkout.session",
        url: "https://checkout.stripe.com/amount",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      lineItems: [
        {
          priceData: {
            currency: "USD",
            productData: { name: "Plan" },
            amount: money(20, "USD"),
          },
          quantity: 1,
        },
      ],
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("2000");
  });

  it("should accept Money priceData.amount for checkout line items", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_money_price_data",
        object: "checkout.session",
        url: "https://checkout.stripe.com/money-price-data",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      lineItems: [
        {
          priceData: {
            currency: "USD",
            productData: { name: "Plan" },
            amount: money("20.00", "USD"),
          },
          quantity: 1,
        },
      ],
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("2000");
    expect(params.get("line_items[0][price_data][currency]")).toBe("usd");
  });

  it("should reject Money priceData.amount when currency mismatches priceData.currency", async () => {
    await expect(
      gateway.createCheckoutSession({
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [
          {
            priceData: {
              currency: "USD",
              productData: { name: "Plan" },
              amount: money("20.00", "EUR"),
            },
            quantity: 1,
          },
        ],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should enforce charge limits on major-unit priceData.amount path", async () => {
    await expect(
      gateway.createCheckoutSession({
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [
          {
            priceData: {
              currency: "USD",
              productData: { name: "Huge" },
              // Above default non-card 8-digit max (99999999 minor = 999999.99 major)
              amount: money(1000000, "USD"),
            },
            quantity: 1,
          },
        ],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Stripe USD amount must be at most 99999999");
  });

  it("should propagate checkout metadata to the PaymentIntent data", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_metadata",
        object: "checkout.session",
        url: "https://checkout.stripe.com/metadata",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      amount: money(20, "USD"),
      currency: "USD",
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      metadata: { paymentId: "order_123" },
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("metadata[paymentId]")).toBe("order_123");
    expect(params.get("payment_intent_data[metadata][paymentId]")).toBe(
      "order_123",
    );
  });

  it("should stringify scalar checkout metadata values consistently", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_scalar_metadata",
        object: "checkout.session",
        url: "https://checkout.stripe.com/scalar-metadata",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      amount: money(20, "USD"),
      currency: "USD",
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      metadata: { attempt: 2, testMode: true },
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("metadata[attempt]")).toBe("2");
    expect(params.get("metadata[testMode]")).toBe("true");
    expect(params.get("payment_intent_data[metadata][attempt]")).toBe("2");
    expect(params.get("payment_intent_data[metadata][testMode]")).toBe("true");
  });

  it("should reject setup checkout without currency or payment method types", async () => {
    await expect(
      gateway.createCheckoutSession({
        mode: "setup",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        customerId: "cus_123",
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject payment checkout without line items or simple amount", async () => {
    await expect(
      gateway.createCheckoutSession({
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject checkout line item without price or priceData", async () => {
    await expect(
      gateway.createCheckoutSession({
        mode: "payment",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [{ quantity: 1 } as any],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject checkout line item with both price and priceData", async () => {
    await expect(
      gateway.createCheckoutSession({
        mode: "payment",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [
          {
            price: "price_123",
            priceData: {
              currency: "USD",
              productData: { name: "Plan" },
              unitAmount: 1000,
            },
            quantity: 1,
          },
        ],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject empty checkout line items instead of sending an empty Stripe payload", async () => {
    await expect(
      gateway.createCheckoutSession({
        amount: money(20, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject checkout sessions that mix line items with amount fields", async () => {
    await expect(
      gateway.createCheckoutSession({
        amount: money(20, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [{ price: "price_123", quantity: 1 }],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject unsupported checkout passthrough fields instead of dropping them", async () => {
    await expect(
      gateway.createCheckoutSession({
        amount: money(20, "USD"),
        currency: "USD",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        allowPromotionCodes: true,
        idempotencyKey: "idem_stripe_test_key",
      } as any),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject payment checkout sessions above Stripe line item limits", async () => {
    await expect(
      gateway.createCheckoutSession({
        mode: "payment",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: Array.from({ length: 101 }, (_, index) => ({
          price: `price_${index}`,
          quantity: 1,
        })),
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject subscription checkout sessions above Stripe recurring line item limits", async () => {
    await expect(
      gateway.createCheckoutSession({
        mode: "subscription",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: Array.from({ length: 21 }, (_, index) => ({
          priceData: {
            currency: "USD",
            productData: { name: `Plan ${index}` },
            amount: 20,
            recurring: { interval: "month" as const },
          },
          quantity: 1,
        })),
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject setup checkout sessions with line items", async () => {
    await expect(
      gateway.createCheckoutSession({
        mode: "setup",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        currency: "USD",
        lineItems: [{ price: "price_123", quantity: 1 }],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should reject inline subscription priceData without recurring settings", async () => {
    await expect(
      gateway.createCheckoutSession({
        mode: "subscription",
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [
          {
            priceData: {
              currency: "USD",
              productData: { name: "Plan" },
              amount: money(20, "USD"),
            },
            quantity: 1,
          },
        ],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow("Validation failed for createCheckoutSession");
  });

  it("should send recurring settings for inline subscription priceData", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_sub_inline",
        object: "checkout.session",
        url: "https://checkout.stripe.com/sub-inline",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      mode: "subscription",
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      lineItems: [
        {
          priceData: {
            currency: "USD",
            productData: { name: "Plan" },
            amount: money(20, "USD"),
            recurring: { interval: "month", intervalCount: 1 },
          },
          quantity: 1,
        },
      ],
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("line_items[0][price_data][recurring][interval]")).toBe(
      "month",
    );
    expect(
      params.get("line_items[0][price_data][recurring][interval_count]"),
    ).toBe("1");
  });

  it("should allow zero-amount checkout line item priceData", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_zero_amount",
        object: "checkout.session",
        url: "https://checkout.stripe.com/zero",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      lineItems: [
        {
          priceData: {
            currency: "USD",
            productData: { name: "Free setup" },
            amount: money(0, "USD", { allowZero: true }),
          },
          quantity: 1,
        },
      ],
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("0");
  });

  it("should allow zero-amount checkout line item unitAmount", async () => {
    let capturedBody: string = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return createMockResponse({
        id: "cs_zero_unit_amount",
        object: "checkout.session",
        url: "https://checkout.stripe.com/zero-unit",
      });
    }) as unknown as typeof fetch;

    await gateway.createCheckoutSession({
      successUrl: "https://success",
      cancelUrl: "https://cancel",
      lineItems: [
        {
          priceData: {
            currency: "USD",
            productData: { name: "Free item" },
            unitAmount: 0,
          },
          quantity: 1,
        },
      ],
      idempotencyKey: "idem_stripe_test_key",
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("0");
  });

  it("should reject three-decimal unitAmount not divisible by 10", async () => {
    await expect(
      gateway.createCheckoutSession({
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [
          {
            priceData: {
              currency: "KWD",
              productData: { name: "Item" },
              // 1234 minor units is not divisible by 10 (three-decimal rule)
              unitAmount: 1234,
            },
            quantity: 1,
          },
        ],
        idempotencyKey: "idem_stripe_test_key",
      }),
    ).rejects.toThrow(
      "Stripe KWD minor-unit amounts must be divisible by 10",
    );
  });

  it.each([
    // ISK is Stripe two-decimal special but whole-major only: 1050 = 10.50 ISK
    {
      label: "ISK fractional unitAmount",
      priceData: {
        currency: "ISK",
        productData: { name: "Item" },
        unitAmount: 1050,
      },
      message: "Stripe ISK amounts must be whole currency units",
    },
    {
      label: "UGX fractional unitAmount",
      priceData: {
        currency: "UGX",
        productData: { name: "Item" },
        unitAmount: 50, // 0.50 UGX — not a whole unit
      },
      message: "Stripe UGX amounts must be whole currency units",
    },
    {
      label: "ISK fractional major-unit amount",
      priceData: {
        currency: "ISK",
        productData: { name: "Item" },
        amount: money(10.5, "ISK", { exponent: 2 }),
      },
      message: "Stripe ISK amounts must be whole currency units",
    },
  ] as const)(
    "STRIPE-1: rejects $label on checkout line item",
    async ({ priceData, message }) => {
      await expect(
        gateway.createCheckoutSession({
          successUrl: "https://success",
          cancelUrl: "https://cancel",
          lineItems: [{ priceData, quantity: 1 }],
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toThrow(message);
    },
  );

  it.each([
    {
      label: "whole-unit ISK unitAmount",
      currency: "ISK",
      unitAmount: 1000, // 10.00 ISK
      expected: "1000",
    },
    {
      label: "zero-decimal JPY unitAmount",
      currency: "JPY",
      unitAmount: 500, // whole majors
      expected: "500",
    },
  ] as const)(
    "STRIPE-1: accepts $label and posts unit_amount=$expected",
    async ({ currency, unitAmount, expected }) => {
      let capturedBody = "";
      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "cs_whole_unit",
          object: "checkout.session",
          url: "https://checkout.stripe.com/whole-unit",
        });
      }) as unknown as typeof fetch;

      await gateway.createCheckoutSession({
        successUrl: "https://success",
        cancelUrl: "https://cancel",
        lineItems: [
          {
            priceData: {
              currency,
              productData: { name: `${currency} item` },
              unitAmount,
            },
            quantity: 1,
          },
        ],
        idempotencyKey: "idem_stripe_test_key",
      });
      expect(
        new URLSearchParams(capturedBody).get(
          "line_items[0][price_data][unit_amount]",
        ),
      ).toBe(expected);
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Apple Pay Simulation Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Apple Pay Simulation", () => {
    it("should enable automatic payment methods for Apple Pay support", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return createMockResponse({
          id: "pi_apple_pay",
          status: "requires_payment_method",
        });
      }) as unknown as typeof fetch;

      await gateway.createPayment({
        amount: money(100, "USD"),
        currency: "USD",
        callbackUrl: "https://example.com",
        description: "Apple Pay Test",
      });

      const params = new URLSearchParams(capturedBody);
      // automatic_payment_methods[enabled]=true includes Apple Pay by default in Stripe
      expect(params.get("automatic_payment_methods[enabled]")).toBe("true");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Refund Payment Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe("refundPayment", () => {
    it("should refund payment intent and return cumulative refunded amount", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        const href = String(url);
        // STRIPE-1: GET PaymentIntent for currency bind before POST /refunds.
        if (href.includes("/payment_intents/")) {
          return createMockResponse({
            id: "pi_ref",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
          });
        }
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_old",
                status: "succeeded",
                amount: 200,
                currency: "usd",
              },
              {
                id: "re_123",
                status: "succeeded",
                amount: 500,
                currency: "usd",
              },
              {
                id: "re_pending",
                status: "pending",
                amount: 300,
                currency: "usd",
              },
              {
                id: "re_action",
                status: "requires_action",
                amount: 400,
                currency: "usd",
              },
            ]),
          );
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "re_123",
          status: "succeeded",
          amount: 500,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref",
        amount: money(5, "USD"),
        currency: "USD",
        idempotencyKey: "idem_stripe_test_key",
      });
      expect(result.outcome).toBe("succeeded");
      expect(result.status).toBe("completed");
      expect(moneyToMajorNumber(result.totalRefunded!)).toBe(7);
      expect(new URLSearchParams(capturedBody).get("amount")).toBe("500");
    });

    it("NEW-STRIPE-REFUND-0: succeeded refund + empty list does not publish totalRefunded 0", async () => {
      globalThis.fetch = mock(async (url) => {
        const href = String(url);
        if (href.includes("/refunds?")) {
          return createMockResponse(createStripeRefundList([]));
        }
        return createMockResponse({
          id: "re_empty_list",
          status: "succeeded",
          amount: 500,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref_empty_list",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.status).toBe("completed");
      expect(result.outcome).toBe("succeeded");
      expect(result.totalRefunded).toBeUndefined();
    });

    it("NEW-STRIPE-REFUND-0: pending-only refund list does not publish totalRefunded 0", async () => {
      globalThis.fetch = mock(async (url) => {
        const href = String(url);
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_pending_only",
                status: "pending",
                amount: 500,
                currency: "usd",
              },
              {
                id: "re_action_only",
                status: "requires_action",
                amount: 200,
                currency: "usd",
              },
            ]),
          );
        }
        return createMockResponse({
          id: "re_pending_only",
          status: "succeeded",
          amount: 500,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref_pending_only",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.status).toBe("completed");
      expect(result.outcome).toBe("succeeded");
      expect(result.totalRefunded).toBeUndefined();
    });

    it("NEW-STRIPE-REFUND-0: empty list falls back to charge.amount_refunded when proven > 0", async () => {
      globalThis.fetch = mock(async (url) => {
        const href = String(url);
        if (href.includes("/refunds?")) {
          return createMockResponse(createStripeRefundList([]));
        }
        return createMockResponse({
          id: "re_empty_recover",
          status: "succeeded",
          amount: 500,
          currency: "usd",
          charge: {
            id: "ch_empty_recover",
            amount_refunded: 700,
            currency: "usd",
          },
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref_empty_recover",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.status).toBe("completed");
      expect(moneyToMajorNumber(result.totalRefunded!)).toBe(7);
    });

    it("NEW-STRIPE-REFUND-0: list error + charge.amount_refunded 0 omits totalRefunded", async () => {
      globalThis.fetch = mock(async (url) => {
        const href = String(url);
        if (href.includes("/refunds?")) {
          return createMockResponse(
            { error: { message: "refund list failed", type: "api_error" } },
            false,
            400,
          );
        }
        return createMockResponse({
          id: "re_list_err_zero",
          status: "succeeded",
          amount: 500,
          currency: "usd",
          charge: {
            id: "ch_list_err_zero",
            amount_refunded: 0,
            currency: "usd",
          },
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref_list_err_zero",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.status).toBe("completed");
      expect(result.totalRefunded).toBeUndefined();
    });

    it("NEW-STRIPE-3: empty HTTP 200 on refund is indeterminate, not pending/success", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse(""),
      ) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_refund_empty_body",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.outcome).not.toBe("succeeded");
    });

    it("NEW-STRIPE-3: HTTP 200 {} on refund is indeterminate, not pending/success", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({}),
      ) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_refund_empty_obj",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.outcome).not.toBe("succeeded");
    });

    it("NEW-STRIPE-3: refund HTTP 200 with id but no status is indeterminate", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({ id: "re_missing_status" }),
      ) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_refund_missing_status",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("completed");
      expect(result.outcome).not.toBe("succeeded");
    });

    it("should reject partial refund without currency", async () => {
      await expect(
        gateway.refundPayment({
          gatewayPaymentId: "pi_ref_missing_currency",
          amount: money(5, "USD"),
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toThrow(
        "Stripe refundPayment requires currency when amount is provided",
      );
    });

    it("STRIPE-1: rejects partial refund when caller currency mismatches PaymentIntent", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_ref_currency_mismatch",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          currency: "usd",
        }),
      ) as unknown as typeof fetch;

      await expect(
        gateway.refundPayment({
          gatewayPaymentId: "pi_ref_currency_mismatch",
          amount: money(50, "JPY"),
          currency: "JPY",
          idempotencyKey: "idem_stripe_test_key",
        }),
      ).rejects.toThrow(
        /refundPayment currency JPY does not match PaymentIntent currency USD/i,
      );
    });

    it("STRIPE-1: partial refund converts majors with PaymentIntent currency scale", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        const href = String(url);
        if (href.includes("/payment_intents/")) {
          return createMockResponse({
            id: "pi_ref_usd_scale",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
          });
        }
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_usd_scale",
                status: "succeeded",
                amount: 5000,
                currency: "usd",
              },
            ]),
          );
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "re_usd_scale",
          status: "succeeded",
          amount: 5000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref_usd_scale",
        amount: money(50, "USD"),
        currency: "USD",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(new URLSearchParams(capturedBody).get("amount")).toBe("5000");
      expect(moneyToMajorNumber(result.totalRefunded!)).toBe(50);
      expect(result.status).toBe("completed");
    });

    it("should refund JPY amount without multiplying by 100", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        const href = String(url);
        if (href.includes("/payment_intents/")) {
          return createMockResponse({
            id: "pi_ref_jpy",
            object: "payment_intent",
            status: "succeeded",
            amount: 500,
            currency: "jpy",
          });
        }
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_jpy",
                status: "succeeded",
                amount: 500,
                currency: "jpy",
              },
            ]),
          );
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "re_jpy",
          status: "succeeded",
          amount: 500,
          currency: "jpy",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref_jpy",
        amount: money(500, "JPY"),
        currency: "JPY",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(new URLSearchParams(capturedBody).get("amount")).toBe("500");
      expect(moneyToMajorNumber(result.totalRefunded!)).toBe(500);
    });

    it("should leave refundable amount limits to Stripe for partial refunds", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        const href = String(url);
        if (href.includes("/payment_intents/")) {
          return createMockResponse({
            id: "pi_ref_large",
            object: "payment_intent",
            status: "succeeded",
            amount: 100000000,
            currency: "usd",
          });
        }
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_large",
                status: "succeeded",
                amount: 100000000,
                currency: "usd",
              },
            ]),
          );
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "re_large",
          status: "succeeded",
          amount: 100000000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.refundPayment({
        gatewayPaymentId: "pi_ref_large",
        amount: money(1000000, "USD"),
        currency: "USD",
        idempotencyKey: "idem_stripe_test_key",
      });

      expect(new URLSearchParams(capturedBody).get("amount")).toBe("100000000");
      expect(moneyToMajorNumber(result.totalRefunded!)).toBe(1_000_000);
    });

    it("should send official Stripe refund reasons as reason", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        const href = String(url);
        if (href.includes("/payment_intents/")) {
          return createMockResponse({
            id: "pi_ref",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
          });
        }
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_reason",
                status: "succeeded",
                amount: 500,
                currency: "usd",
              },
            ]),
          );
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "re_reason",
          status: "succeeded",
          amount: 500,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.refundPayment({
        gatewayPaymentId: "pi_ref",
        amount: money(5, "USD"),
        currency: "USD",
        reason: "requested_by_customer",
        idempotencyKey: "idem_stripe_test_key",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("reason")).toBe("requested_by_customer");
      expect(params.get("metadata[reason]")).toBeNull();
    });

    it("should send custom refund reasons as metadata", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        const href = String(url);
        if (href.includes("/payment_intents/")) {
          return createMockResponse({
            id: "pi_ref",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
          });
        }
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_custom_reason",
                status: "succeeded",
                amount: 500,
                currency: "usd",
              },
            ]),
          );
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "re_custom_reason",
          status: "succeeded",
          amount: 500,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.refundPayment({
        gatewayPaymentId: "pi_ref",
        amount: money(5, "USD"),
        currency: "USD",
        reason: "warehouse_return",
        idempotencyKey: "idem_stripe_test_key",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("reason")).toBeNull();
      expect(params.get("metadata[reason]")).toBe("warehouse_return");
    });

    it("should attach caller metadata to Stripe refunds", async () => {
      let capturedBody: string = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        const href = String(url);
        if (href.includes("/payment_intents/")) {
          return createMockResponse({
            id: "pi_ref",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            currency: "usd",
          });
        }
        if (href.includes("/refunds?")) {
          return createMockResponse(
            createStripeRefundList([
              {
                id: "re_metadata",
                status: "succeeded",
                amount: 500,
                currency: "usd",
              },
            ]),
          );
        }
        // Body is URLSearchParams from toUrlEncoded — stringify for URLSearchParams parsing.
        if (opts.body != null) {
          capturedBody = String(opts.body);
        }
        return createMockResponse({
          id: "re_metadata",
          status: "succeeded",
          amount: 500,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.refundPayment({
        gatewayPaymentId: "pi_ref",
        amount: money(5, "USD"),
        currency: "USD",
        metadata: {
          transactionId: "tx-1",
          tenantId: "tenant-1",
        },
        idempotencyKey: "idem_stripe_test_key",
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("metadata[transactionId]")).toBe("tx-1");
      expect(params.get("metadata[tenantId]")).toBe("tenant-1");
    });

    it("S19-EPHEMERAL-KEY: refundPayment requires caller idempotencyKey before POST", async () => {
      let fetchCalls = 0;
      globalThis.fetch = mock(async () => {
        fetchCalls += 1;
        return createMockResponse({
          id: "re_nokey",
          status: "succeeded",
          amount: 500,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await expect(
        gateway.refundPayment({ gatewayPaymentId: "pi_ref_nokey" }),
      ).rejects.toThrow(/requires idempotencyKey/i);
      expect(fetchCalls).toBe(0);
    });
  });

  describe("getPayment", () => {
    it("should reject empty payment IDs before calling Stripe", async () => {
      await expect(
        gateway.getPayment({ gatewayPaymentId: "" }),
      ).rejects.toThrow("Validation failed for getPayment");
    });

    it("should reject malformed payment IDs before calling Stripe", async () => {
      await expect(
        gateway.getPayment({
          gatewayPaymentId: "pi_get?expand[]=charges",
        }),
      ).rejects.toThrow("Stripe PaymentIntent ID must start with pi_");
    });

    it("should retrieve JPY payment intent without dividing by 100", async () => {
      // STRIPE-7: include amount_received so status is paid (not processing fail-closed).
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_get_jpy",
          object: "payment_intent",
          status: "succeeded",
          amount: 5000,
          amount_received: 5000,
          currency: "jpy",
          client_secret: "pi_get_jpy_secret",
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_get_jpy",
      });

      expect(moneyToMajorNumber(result.amount!)).toBe(5000);
      // STRIPE-1: currency with major-unit amount
      expect(result.currency).toBe("JPY");
      expect(result.status).toBe("paid");
      expect(result.clientSecret).toBe("pi_get_jpy_secret");
    });

    it("should expand latest charge and return cumulative refunded amount", async () => {
      let requestedUrl = "";
      globalThis.fetch = mock(async (url) => {
        requestedUrl = String(url);
        return createMockResponse({
          id: "pi_get_refunded",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          client_secret: "pi_get_refunded_secret",
          latest_charge: {
            id: "ch_refunded",
            amount_captured: 10000,
            amount_refunded: 10000,
            currency: "usd",
          },
        });
      }) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_get_refunded",
      });

      expect(requestedUrl).toContain("expand[]=latest_charge");
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(100);
      // STRIPE-1: currency accompanies refundedAmount / amount
      expect(result.currency).toBe("USD");
      expect(result.status).toBe("refunded");
    });

    it("STRIPE-4: getPayment does not treat refund as full when captured base is missing", async () => {
      // amount_refunded present but no amount_received / amount_captured —
      // must not fall back to authorized amount and claim full refunded.
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_refund_no_captured_base",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          currency: "usd",
          latest_charge: {
            id: "ch_refund_no_captured_base",
            amount_refunded: 10000,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_refund_no_captured_base",
      });

      expect(result.status).toBe("partially_refunded");
      expect(result.status).not.toBe("refunded");
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(100);
    });

    it("should mark fully refunded PaymentIntents as refunded", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_full_refund",
          object: "payment_intent",
          status: "succeeded",
          amount: 5000,
          amount_received: 5000,
          currency: "usd",
          latest_charge: {
            id: "ch_full_refund",
            amount_refunded: 5000,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_full_refund",
      });

      expect(result.status).toBe("refunded");
      expect(moneyToMajorNumber(result.amount!)).toBe(50);
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(50);
      expect(result.currency).toBe("USD");
    });

    it("should mark partial refunds as partially_refunded", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_partial_refund",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          latest_charge: {
            id: "ch_partial_refund",
            amount_refunded: 2500,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_partial_refund",
      });

      expect(result.status).toBe("partially_refunded");
      expect(moneyToMajorNumber(result.amount!)).toBe(100);
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(25);
    });

    it("should prefer amount_received and mark partial captures as partially_captured", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_partial_capture",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 6000,
          currency: "usd",
          latest_charge: {
            id: "ch_partial_capture",
            amount_refunded: 0,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_partial_capture",
      });

      expect(result.status).toBe("partially_captured");
      expect(moneyToMajorNumber(result.amount!)).toBe(60);
    });

    it("should prefer refund status over partial capture when both apply", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_partial_then_refund",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 6000,
          currency: "usd",
          latest_charge: {
            id: "ch_partial_then_refund",
            amount_refunded: 6000,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_partial_then_refund",
      });

      // Full refund of captured base (amount_received=6000) overrides partially_captured.
      // amount=10000, amount_received=6000, amount_refunded=6000 => refunded
      expect(result.status).toBe("refunded");
      expect(moneyToMajorNumber(result.amount!)).toBe(60);
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(60);
    });

    it("should mark full refund of captured base using amount_captured when amount_received absent", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_refund_via_captured",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          currency: "usd",
          latest_charge: {
            id: "ch_refund_via_captured",
            amount_captured: 6000,
            amount_refunded: 6000,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_refund_via_captured",
      });

      expect(result.status).toBe("refunded");
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(60);
    });

    it("should mark partial capture via amount_captured when amount_received absent", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_partial_via_captured",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          currency: "usd",
          latest_charge: {
            id: "ch_partial_via_captured",
            amount_captured: 6000,
            amount_refunded: 0,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_partial_via_captured",
      });

      expect(result.status).toBe("partially_captured");
      expect(moneyToMajorNumber(result.amount!)).toBe(60);
    });

    it("should fail closed on getPayment when succeeded but settled amount fields missing", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_incomplete_settled",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          currency: "usd",
          latest_charge: {
            id: "ch_incomplete_settled",
            amount_refunded: 0,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_incomplete_settled",
      });

      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(moneyToMajorNumber(result.amount!)).toBe(100);
    });

    it("STRIPE-1: re-fetches unexpanded string latest_charge and maps full refund", async () => {
      const urls: string[] = [];
      globalThis.fetch = mock(async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.includes("/charges/")) {
          return createMockResponse({
            id: "ch_unexpanded_full",
            amount: 10000,
            amount_captured: 10000,
            amount_refunded: 10000,
            currency: "usd",
            refunded: true,
          });
        }
        return createMockResponse({
          id: "pi_unexpanded_full",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          // Stripe returned charge as unexpanded string despite expand[]
          latest_charge: "ch_unexpanded_full",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_unexpanded_full",
      });

      expect(urls.some((u) => u.includes("expand[]=latest_charge"))).toBe(true);
      expect(urls.some((u) => u.includes("/charges/ch_unexpanded_full"))).toBe(
        true,
      );
      expect(result.status).toBe("refunded");
      expect(result.status).not.toBe("paid");
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(100);
      expect(moneyToMajorNumber(result.amount!)).toBe(100);
      expect(result.references?.relatedIds?.chargeId).toBe("ch_unexpanded_full");
    });

    it("STRIPE-1: re-fetches unexpanded string latest_charge and maps partial refund", async () => {
      globalThis.fetch = mock(async (url) => {
        if (String(url).includes("/charges/")) {
          return createMockResponse({
            id: "ch_unexpanded_partial",
            amount: 10000,
            amount_captured: 10000,
            amount_refunded: 2500,
            currency: "usd",
            refunded: false,
          });
        }
        return createMockResponse({
          id: "pi_unexpanded_partial",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          latest_charge: "ch_unexpanded_partial",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_unexpanded_partial",
      });

      expect(result.status).toBe("partially_refunded");
      expect(result.status).not.toBe("paid");
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(25);
    });

    it("STRIPE-1: fail-closed to processing when unexpanded charge re-fetch fails", async () => {
      globalThis.fetch = mock(async (url) => {
        if (String(url).includes("/charges/")) {
          return createMockResponse(
            { error: { message: "Charge not found", type: "invalid_request_error" } },
            false,
            404,
          );
        }
        return createMockResponse({
          id: "pi_unexpanded_fail",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          latest_charge: "ch_missing",
        });
      }) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_unexpanded_fail",
      });

      // Must not report paid after refund when charge refund state is unobservable.
      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(result.references?.relatedIds?.chargeId).toBe("ch_missing");
      expect(result.refundedAmount).toBeUndefined();
    });

    it("NEW-STRIPE-1: omitted latest_charge + charges.data[0].amount_refunded is not paid", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_charges_data_get",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          charges: {
            data: [
              {
                id: "ch_charges_data_get",
                amount_captured: 10000,
                amount_refunded: 10000,
                refunded: true,
                currency: "usd",
              },
            ],
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_charges_data_get",
      });

      expect(result.status).toBe("refunded");
      expect(result.status).not.toBe("paid");
      expect(moneyToMajorNumber(result.refundedAmount!)).toBe(100);
      expect(result.currency).toBe("USD");
    });

    it("NEW-STRIPE-1: getPayment refunded:true without amount_refunded is refunded not paid", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "pi_refunded_flag_only",
          object: "payment_intent",
          status: "succeeded",
          amount: 5000,
          amount_received: 5000,
          currency: "usd",
          latest_charge: {
            id: "ch_refunded_flag_only",
            refunded: true,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_refunded_flag_only",
      });

      expect(result.status).toBe("refunded");
      expect(result.status).not.toBe("paid");
    });

    it("S19-STRIPE-CHARGE-SWALLOW: GET /charges 401 is AuthenticationError, not processing", async () => {
      globalThis.fetch = mock(async (url) => {
        if (String(url).includes("/charges/")) {
          return createMockResponse(
            {
              error: {
                message: "Invalid API Key provided",
                type: "invalid_request_error",
              },
            },
            false,
            401,
          );
        }
        return createMockResponse({
          id: "pi_charge_401",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          latest_charge: "ch_charge_401",
        });
      }) as unknown as typeof fetch;

      await expect(
        gateway.getPayment({ gatewayPaymentId: "pi_charge_401" }),
      ).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("S19-STRIPE-CHARGE-SWALLOW: GET /charges 500 is NetworkError, not processing", async () => {
      globalThis.fetch = mock(async (url) => {
        if (String(url).includes("/charges/")) {
          return createMockResponse(
            {
              error: {
                message: "Stripe API unavailable",
                type: "api_error",
              },
            },
            false,
            500,
          );
        }
        return createMockResponse({
          id: "pi_charge_500",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          latest_charge: "ch_charge_500",
        });
      }) as unknown as typeof fetch;

      await expect(
        gateway.getPayment({ gatewayPaymentId: "pi_charge_500" }),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it("S19-STRIPE-CHARGE-SWALLOW: GET /charges 429 is RateLimitError, not processing", async () => {
      globalThis.fetch = mock(async (url) => {
        if (String(url).includes("/charges/")) {
          return createMockResponse(
            { error: { message: "Too many requests", type: "api_error" } },
            false,
            429,
          );
        }
        return createMockResponse({
          id: "pi_charge_429",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          latest_charge: "ch_charge_429",
        });
      }) as unknown as typeof fetch;

      await expect(
        gateway.getPayment({ gatewayPaymentId: "pi_charge_429" }),
      ).rejects.toBeInstanceOf(RateLimitError);
    });

    it("NEW-STRIPE-2: getPayment id-only latest_charge is processing not paid", async () => {
      globalThis.fetch = mock(async (url) => {
        if (String(url).includes("/charges/")) {
          return createMockResponse(
            { error: { message: "Charge not found", type: "invalid_request_error" } },
            false,
            404,
          );
        }
        return createMockResponse({
          id: "pi_get_id_only",
          object: "payment_intent",
          status: "succeeded",
          amount: 10000,
          amount_received: 10000,
          currency: "usd",
          latest_charge: { id: "ch_get_id_only" },
        });
      }) as unknown as typeof fetch;

      const result = await gateway.getPayment({
        gatewayPaymentId: "pi_get_id_only",
      });

      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(result.references?.relatedIds?.chargeId).toBe("ch_get_id_only");
    });
  });

  describe("getCheckoutSession", () => {
    it("should retrieve a Checkout Session and expose its PaymentIntent ID", async () => {
      let requestedUrl = "";
      globalThis.fetch = mock(async (url) => {
        requestedUrl = String(url);
        return createMockResponse({
          id: "cs_test_session_1",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/session",
          status: "complete",
          payment_status: "paid",
          amount_total: 1000,
          currency: "usd",
          payment_intent: { id: "pi_from_session" },
          metadata: {},
        });
      }) as unknown as typeof fetch;

      const result = await gateway.getCheckoutSession({
        sessionId: "cs_test_session_1",
      });

      expect(requestedUrl).toContain("/checkout/sessions/cs_test_session_1");
      expect(requestedUrl).toContain("expand[]=payment_intent");
      expect(requestedUrl).toContain("expand[]=payment_intent.latest_charge");
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("getCheckoutSession must succeed");
      }
      expect(result.session.references.relatedIds?.paymentIntentId).toBe(
        "pi_from_session",
      );
      expect(moneyToMajorNumber(result.session.amount!)).toBe(10);
      expect(result.session.currency).toBe("USD");
      // Id-only expanded PI has no charge snapshot — fail-closed (S19-CKO-GET).
      expect(result.session.paymentStatus).toBe("processing");
      expect(result.session.paymentStatus).not.toBe("paid");
    });

    it("S19-CKO-GET: expanded PI amount_received is published, not amount_total", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_expanded_received",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/session",
          status: "complete",
          payment_status: "paid",
          amount_total: 10000,
          currency: "usd",
          payment_intent: {
            id: "pi_expanded_received",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 6000,
            currency: "usd",
            latest_charge: {
              id: "ch_expanded_received",
              amount_captured: 6000,
              amount_refunded: 0,
              currency: "usd",
            },
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getCheckoutSession({
        sessionId: "cs_expanded_received",
      });

      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("getCheckoutSession must succeed");
      }
      expect(result.session.references.relatedIds?.paymentIntentId).toBe(
        "pi_expanded_received",
      );
      expect(moneyToMajorNumber(result.session.amount!)).toBe(60);
      expect(moneyToMajorNumber(result.session.amount!)).not.toBe(100);
      expect(result.session.currency).toBe("USD");
      expect(result.session.paymentStatus).toBe("partially_captured");
      expect(result.session.paymentStatus).not.toBe("paid");
    });

    it("S19-CKO-GET: expanded PI with amount_refunded is not paid", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_expanded_refunded",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/session",
          status: "complete",
          payment_status: "paid",
          amount_total: 10000,
          currency: "usd",
          payment_intent: {
            id: "pi_expanded_refunded",
            object: "payment_intent",
            status: "succeeded",
            amount: 10000,
            amount_received: 10000,
            currency: "usd",
            latest_charge: {
              id: "ch_expanded_refunded",
              amount_captured: 10000,
              amount_refunded: 10000,
              refunded: true,
              currency: "usd",
            },
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getCheckoutSession({
        sessionId: "cs_expanded_refunded",
      });

      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("getCheckoutSession must succeed");
      }
      expect(result.session.paymentStatus).toBe("refunded");
      expect(result.session.paymentStatus).not.toBe("paid");
      expect(moneyToMajorNumber(result.session.amount!)).toBe(100);
      expect(moneyToMajorNumber(result.session.refundedAmount!)).toBe(100);
      expect(result.session.currency).toBe("USD");
    });

    it("P22-CKO-GET-ZERO: open unpaid GET publishes amount_total, not amount_received 0", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_open_unpaid",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/session",
          status: "open",
          payment_status: "unpaid",
          amount_total: 1000,
          currency: "usd",
          payment_intent: {
            id: "pi_open_unpaid",
            amount: 1000,
            amount_received: 0,
            currency: "usd",
          },
        }),
      ) as unknown as typeof fetch;

      const result = await gateway.getCheckoutSession({
        sessionId: "cs_open_unpaid",
      });

      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") {
        expect.unreachable("getCheckoutSession must succeed");
      }
      expect(result.session.status).toBe("open");
      expect(result.session.paymentStatus).toBe("unpaid");
      expect(moneyToMajorNumber(result.session.amount!)).toBe(10);
      expect(result.session.currency).toBe("USD");
    });

    it("S19-CKO-TIMEOUT: getCheckoutSession GET timeout still throws", async () => {
      const timeoutGateway = new StripeGateway(
        {
          ...STRIPE_TEST_CONFIG,
          timeoutMs: 1,
        },
        hooksManager,
      );

      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }) as unknown as typeof fetch;

      await expect(
        timeoutGateway.getCheckoutSession({ sessionId: "cs_get_timeout" }),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it("NEW-STRIPE-0: missing amount_total is omitted, not major 0", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_missing_amount",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/session",
          status: "open",
          payment_status: "unpaid",
          currency: "usd",
          payment_intent: { id: "pi_missing_amount" },
          metadata: {},
        }),
      ) as unknown as typeof fetch;

      const omitted = await gateway.getCheckoutSession({
        sessionId: "cs_missing_amount",
      });

      expect(omitted.outcome).toBe("succeeded");
      if (omitted.outcome !== "succeeded") {
        expect.unreachable("getCheckoutSession must succeed");
      }
      expect(omitted.session.currency).toBe("USD");
      expect(omitted.session.amount).toBeUndefined();

      globalThis.fetch = mock(async () =>
        createMockResponse({
          id: "cs_null_amount",
          object: "checkout.session",
          url: "https://checkout.stripe.com/c/session",
          status: "open",
          payment_status: "unpaid",
          amount_total: null,
          currency: "usd",
          payment_intent: { id: "pi_null_amount" },
          metadata: {},
        }),
      ) as unknown as typeof fetch;

      const nulled = await gateway.getCheckoutSession({
        sessionId: "cs_null_amount",
      });

      expect(nulled.outcome).toBe("succeeded");
      if (nulled.outcome !== "succeeded") {
        expect.unreachable("getCheckoutSession must succeed");
      }
      expect(nulled.session.currency).toBe("USD");
      expect(nulled.session.amount).toBeUndefined();
    });

    it("getCheckoutSession 404 is a failed outcome, not a throw", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse(
          {
            error: {
              message: "No such checkout session: cs_missing",
              type: "invalid_request_error",
            },
          },
          false,
          404,
        ),
      ) as unknown as typeof fetch;

      const result = await gateway.getCheckoutSession({
        sessionId: "cs_missing",
      });
      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed") {
        expect.unreachable("404 must be failed");
      }
      expect(result.error.code).toBe("GATEWAY_API_ERROR");
    });

    it("NEW-STRIPE-CKO-200: HTTP 200 {} on getCheckoutSession is not success:true", async () => {
      globalThis.fetch = mock(async () =>
        createMockResponse({}),
      ) as unknown as typeof fetch;

      let thrown: unknown;
      try {
        await gateway.getCheckoutSession({ sessionId: "cs_missing_id_body" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(NetworkError);
      expect(thrown).not.toEqual(
        expect.objectContaining({ success: true, sessionId: undefined }),
      );
    });

    it("should reject malformed Checkout Session IDs before calling Stripe", async () => {
      await expect(
        gateway.getCheckoutSession({ sessionId: "cs_bad?expand[]=payment_intent" }),
      ).rejects.toThrow("Stripe Checkout Session ID must start with cs_");
    });
  });

  describe("error mapping", () => {
    it("should map authentication_required to CardDeclinedError (not AuthenticationError)", async () => {
      const { CardDeclinedError, AuthenticationError } = await import(
        "../../errors"
      );

      globalThis.fetch = mock(async () =>
        createMockResponse(
          {
            error: {
              message: "This payment requires authentication.",
              type: "card_error",
              code: "authentication_required",
            },
          },
          false,
          402,
        ),
      ) as unknown as typeof fetch;

      let caught: unknown;
      try {
        await gateway.createPayment({
          amount: money(10, "USD"),
          currency: "USD",
          callbackUrl: "https://example.com",
          stripePaymentMethodId: "pm_card_authenticationRequired",
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CardDeclinedError);
      expect(caught).not.toBeInstanceOf(AuthenticationError);
      expect((caught as Error).message).toBe(
        "This payment requires authentication.",
      );
    });

    it("should map HTTP 401 to AuthenticationError", async () => {
      const { AuthenticationError } = await import("../../errors");

      globalThis.fetch = mock(async () =>
        createMockResponse(
          {
            error: {
              message: "Invalid API Key provided",
              type: "invalid_request_error",
            },
          },
          false,
          401,
        ),
      ) as unknown as typeof fetch;

      await expect(
        gateway.createPayment({
          amount: money(10, "USD"),
          currency: "USD",
          callbackUrl: "https://example.com",
        }),
      ).rejects.toThrow(AuthenticationError);
    });
  });

  describe("stripeRequest headers", () => {
    it("should pin the default Stripe API version", async () => {
      let capturedVersion = "";
      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        capturedVersion = new Headers(opts.headers).get("Stripe-Version") ?? "";
        return createMockResponse({
          id: "pi_headers",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 1000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      await gateway.createPayment({
        amount: money(10, "USD"),
        currency: "USD",
        callbackUrl: "https://example.com",
      });

      expect(capturedVersion).toBe("2026-02-25.clover");
    });

    it("should reject idempotency keys longer than Stripe allows", async () => {
      await expect(
        gateway.createPayment({
          amount: money(10, "USD"),
          currency: "USD",
          idempotencyKey: "x".repeat(256),
        }),
      ).rejects.toThrow(
        "Stripe idempotency keys must be 255 characters or fewer",
      );
    });

    it("should time out hanging Stripe requests", async () => {
      const timeoutGateway = new StripeGateway(
        {
          ...STRIPE_TEST_CONFIG,
          timeoutMs: 1,
        },
        hooksManager,
      );

      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }) as unknown as typeof fetch;

      const timedOut = await timeoutGateway.createPayment({
        amount: money(10, "USD"),
        currency: "USD",
      });
      expect(timedOut.outcome).toBe("indeterminate");
      expect(timedOut.reconciliationRequired).toBe(true);
    });

    it("should time out while reading a hanging Stripe response body", async () => {
      const timeoutGateway = new StripeGateway(
        {
          ...STRIPE_TEST_CONFIG,
          timeoutMs: 1,
        },
        hooksManager,
      );

      globalThis.fetch = mock(async (url, opts: RequestInit) => {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () =>
            new Promise<string>((_resolve, reject) => {
              opts.signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const hungBody = await timeoutGateway.createPayment({
        amount: money(10, "USD"),
        currency: "USD",
      });
      expect(hungBody.outcome).toBe("indeterminate");
      expect(hungBody.reconciliationRequired).toBe(true);
    });

    it("rejects createPayment with pre-aborted signal without hanging", async () => {
      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        if (opts.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return createMockResponse({
          id: "pi_x",
          status: "requires_payment_method",
          amount: 1000,
          currency: "usd",
        });
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      controller.abort();

      // NEW-CORE-1: caller abort after a mutating POST is indeterminate
      // (NetworkError afterProviderSubmit), not PaymentAbortedError.
      const aborted = await gateway.createPayment({
        amount: money(10, "USD"),
        currency: "USD",
        signal: controller.signal,
      });
      expect(aborted.outcome).toBe("indeterminate");
      expect(aborted.reconciliationRequired).toBe(true);
    });

    it("aborts in-flight createPayment when caller signal fires", async () => {
      const controller = new AbortController();

      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        if (opts.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Promise<Response>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          // Abort mid-flight
          setTimeout(() => controller.abort(), 5);
        });
      }) as unknown as typeof fetch;

      // Post-submit abort is indeterminate, not a clean PaymentAbortedError.
      const aborted = await gateway.createPayment({
        amount: money(10, "USD"),
        currency: "USD",
        signal: controller.signal,
      });
      expect(aborted.outcome).toBe("indeterminate");
      expect(aborted.reconciliationRequired).toBe(true);
    });

    it("survives Zod validation — signal is not stripped before HTTP", async () => {
      let sawSignal = false;
      globalThis.fetch = mock(async (_url, opts: RequestInit) => {
        sawSignal = opts.signal instanceof AbortSignal;
        return createMockResponse({
          id: "pi_signal_ok",
          object: "payment_intent",
          amount: 1000,
          currency: "usd",
          status: "requires_payment_method",
          client_secret: "cs_test",
        });
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      await gateway.createPayment({
        amount: money(10, "USD"),
        currency: "USD",
        signal: controller.signal,
      });
      expect(sawSignal).toBe(true);
    });
  });
});
