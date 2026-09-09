// file: packages/core/src/gateways/gateway-runtime-injection.test.ts
/**
 * Phase 8 Stream B — gateways must use injected runtime fetch/crypto/clock,
 * not bare global fetch or node: builtins in production sources.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HooksManager } from "../hooks/hooks.manager";
import { createDefaultGatewayContext } from "./gateway-context";
import {
  stripeGateway,
  moyasarGateway,
  paypalGateway,
  paymobGateway,
} from "./factories";
import { StripeGateway } from "./stripe/stripe.gateway";
import { MoyasarGateway } from "./moyasar/moyasar.gateway";
import { PayPalGateway } from "./paypal/paypal.gateway";
import { PaymobGateway } from "./paymob/paymob.gateway";
import { hmacSha256Hex, hmacSha512Hex } from "../runtime/crypto-portable";
import { createPaymentClient } from "../create-payment-client";
import { money } from "../utils/money";

const CORE_SRC = join(import.meta.dir, "..");

function walkProductionTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkProductionTs(full, out);
      continue;
    }
    if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".spec.ts") &&
      !name.endsWith(".types.test.ts") &&
      !name.endsWith(".acceptance.test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("gateway injected runtime (Stream B)", () => {
  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;

  beforeEach(() => {
    globalFetchCalls = 0;
    globalThis.fetch = (async () => {
      globalFetchCalls += 1;
      throw new Error(
        "globalThis.fetch must not be used when runtime.fetch is injected",
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("StripeGateway uses injected fetch (ctor runtime) without touching globalThis.fetch", async () => {
    const urls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        id: "pi_injected",
        object: "payment_intent",
        status: "requires_payment_method",
        amount: 1000,
        currency: "usd",
        client_secret: "pi_injected_secret",
        metadata: {},
        latest_charge: null,
        receipt_email: null,
      });
    }) as typeof fetch;

    const gw = new StripeGateway(
      { secretKey: "sk_test_inject" },
      new HooksManager({}),
      undefined,
      { fetch: mockFetch },
    );

    const result = await gw.createPayment({
      amount: money(10, "USD"),
      currency: "USD",
      callbackUrl: "https://example.com/cb",
    });

    expect(result.gatewayId).toBe("pi_injected");
    expect(urls.some((u) => u.includes("api.stripe.com"))).toBe(true);
    expect(globalFetchCalls).toBe(0);
  });

  it("MoyasarGateway uses injected fetch (ctor runtime) without touching globalThis.fetch", async () => {
    const paymentId = "11111111-1111-4111-8111-111111111111";
    const urls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        id: paymentId,
        status: "paid",
        amount: 1000,
        fee: 0,
        currency: "SAR",
        refunded: 0,
        refunded_at: null,
        captured: 1000,
        captured_at: "2026-01-01T00:00:00Z",
        voided_at: null,
        description: "t",
        amount_format: "10.00 SAR",
        fee_format: "0.00 SAR",
        invoice_id: null,
        ip: null,
        callback_url: "https://example.com",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        metadata: {},
        source: { type: "creditcard", company: "visa", name: "T", number: "4111", message: null, transaction_url: null },
      });
    }) as typeof fetch;

    const gw = new MoyasarGateway(
      { secretKey: "sk_test_inject" },
      new HooksManager({}),
      undefined,
      { fetch: mockFetch },
    );

    const result = await gw.getPayment({ gatewayPaymentId: paymentId });
    expect(result.gatewayId).toBe(paymentId);
    expect(urls.some((u) => u.includes("api.moyasar.com"))).toBe(true);
    expect(globalFetchCalls).toBe(0);
  });

  it("PaymobGateway uses injected fetch (ctor runtime) without touching globalThis.fetch", async () => {
    const urls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        id: "pi_paymob_injected",
        client_secret: "csk_injected",
        status: "intended",
        amount: 1000,
        currency: "EGP",
      });
    }) as typeof fetch;

    const gw = new PaymobGateway(
      {
        secretKey: "egy_sk_test",
        publicKey: "egy_pk_test",
        integrationId: 123,
        hmacSecret: "hmac_test",
        region: "eg",
      },
      new HooksManager({}),
      undefined,
      { fetch: mockFetch },
    );

    const result = await gw.createPayment({
      amount: money(10, "EGP"),
      currency: "EGP",
      callbackUrl: "https://example.com/cb",
      metadata: {
        email: "customer@example.com",
        firstName: "Test",
        lastName: "User",
        phone: "+201000000000",
      },
    });

    expect(result.gatewayId).toBe("pi_paymob_injected");
    expect(urls.length).toBeGreaterThan(0);
    expect(globalFetchCalls).toBe(0);
  });

  it("PayPalGateway uses injected fetch (ctor runtime) without touching globalThis.fetch", async () => {
    const urls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/v1/oauth2/token")) {
        return jsonResponse({
          access_token: "tok_injected",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.includes("/v2/checkout/orders/")) {
        return jsonResponse({
          id: "ORDER_INJECTED",
          status: "COMPLETED",
          intent: "CAPTURE",
          purchase_units: [
            {
              amount: { currency_code: "USD", value: "10.00" },
              payments: {
                captures: [
                  {
                    id: "CAP_INJECTED",
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "10.00" },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ name: "NOT_FOUND", message: "unexpected" }, 404);
    }) as typeof fetch;

    const gw = new PayPalGateway(
      { clientId: "cid", clientSecret: "csec", sandbox: true },
      new HooksManager({}),
      undefined,
      { fetch: mockFetch },
    );

    const result = await gw.getPayment({ gatewayPaymentId: "ORDER_INJECTED" });
    expect(result.gatewayId).toBe("ORDER_INJECTED");
    expect(urls.some((u) => u.includes("oauth2/token"))).toBe(true);
    expect(globalFetchCalls).toBe(0);
  });

  it("factory create(context) passes context.fetch into Stripe HTTP path", async () => {
    const urls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        id: "pi_factory",
        object: "payment_intent",
        status: "requires_payment_method",
        amount: 500,
        currency: "usd",
        client_secret: "sec",
        metadata: {},
        latest_charge: null,
        receipt_email: null,
      });
    }) as typeof fetch;

    const ctx = createDefaultGatewayContext({ fetch: mockFetch });
    const gw = stripeGateway({ secretKey: "sk_factory" }).create(ctx);

    await gw.createPayment({
      amount: money(5, "USD"),
      currency: "USD",
      callbackUrl: "https://example.com",
    });

    expect(urls.some((u) => u.includes("api.stripe.com"))).toBe(true);
    expect(globalFetchCalls).toBe(0);
  });

  it("createPaymentClient runtime.fetch reaches gateway HTTP", async () => {
    const urls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        id: "pi_client_rt",
        object: "payment_intent",
        status: "requires_payment_method",
        amount: 100,
        currency: "usd",
        client_secret: "sec",
        metadata: {},
        latest_charge: null,
        receipt_email: null,
      });
    }) as typeof fetch;

    const client = createPaymentClient({
      gateways: {
        stripe: stripeGateway({ secretKey: "sk_client_rt" }),
      },
      defaultGateway: "stripe",
      runtime: { fetch: mockFetch },
    });

    await client.createPayment({
      amount: money(1, "USD"),
      currency: "USD",
      callbackUrl: "https://example.com",
    });

    expect(urls.some((u) => u.includes("api.stripe.com"))).toBe(true);
    expect(globalFetchCalls).toBe(0);
  });

  it("configured default gateway runtime.fetch reaches Stripe HTTP", async () => {
    const urls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({
        id: "pi_legacy_rt",
        object: "payment_intent",
        status: "requires_payment_method",
        amount: 100,
        currency: "usd",
        client_secret: "sec",
        metadata: {},
        latest_charge: null,
        receipt_email: null,
      });
    }) as typeof fetch;

    const client = createPaymentClient({
      gateways: { stripe: stripeGateway({ secretKey: "sk_legacy_rt" }) },
      defaultGateway: "stripe",
      runtime: { fetch: mockFetch },
    });

    await client.createPayment({
      amount: money(1, "USD"),
      currency: "USD",
      callbackUrl: "https://example.com",
    });

    expect(urls.some((u) => u.includes("api.stripe.com"))).toBe(true);
    expect(globalFetchCalls).toBe(0);
  });

  it("default runtime still delegates to live globalThis.fetch (compat)", async () => {
    // Restore real-ish mock on globalThis — defaultFetch must follow it.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      globalFetchCalls += 1;
      expect(String(input)).toContain("api.stripe.com");
      return jsonResponse({
        id: "pi_global_default",
        object: "payment_intent",
        status: "requires_payment_method",
        amount: 200,
        currency: "usd",
        client_secret: "sec",
        metadata: {},
        latest_charge: null,
        receipt_email: null,
      });
    }) as typeof fetch;

    const gw = new StripeGateway(
      { secretKey: "sk_default" },
      new HooksManager({}),
    );

    const result = await gw.createPayment({
      amount: money(2, "USD"),
      currency: "USD",
      callbackUrl: "https://example.com",
    });

    expect(result.gatewayId).toBe("pi_global_default");
    expect(globalFetchCalls).toBeGreaterThan(0);
  });
});

describe("portable webhook verify (no node:crypto in production path)", () => {
  it("Stripe verifyWebhook accepts portable HMAC-SHA256 signature", () => {
    const secret = "whsec_portable_test";
    const payload = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1" } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const expected = hmacSha256Hex(secret, `${timestamp}.${payload}`);
    const header = `t=${timestamp},v1=${expected}`;

    const gw = new StripeGateway(
      { secretKey: "sk_test", webhookSecret: secret },
      new HooksManager({}),
    );
    expect(gw.verifyWebhook(payload, header)).toBe(true);
    expect(gw.verifyWebhook(payload, `t=${timestamp},v1=deadbeef`)).toBe(false);
  });

  it("Stripe verifyWebhook respects injected clock for skew", () => {
    const secret = "whsec_clock";
    const payload = "{}";
    const eventTs = 1_700_000_000;
    const expected = hmacSha256Hex(secret, `${eventTs}.${payload}`);
    const header = `t=${eventTs},v1=${expected}`;

    const fresh = new StripeGateway(
      { secretKey: "sk_test", webhookSecret: secret },
      new HooksManager({}),
      undefined,
      {
        clock: {
          now: () => new Date(eventTs * 1000 + 60_000),
          nowMs: () => eventTs * 1000 + 60_000,
        },
      },
    );
    expect(fresh.verifyWebhook(payload, header)).toBe(true);

    const stale = new StripeGateway(
      { secretKey: "sk_test", webhookSecret: secret },
      new HooksManager({}),
      undefined,
      {
        clock: {
          now: () => new Date(eventTs * 1000 + 400_000),
          nowMs: () => eventTs * 1000 + 400_000,
        },
      },
    );
    expect(stale.verifyWebhook(payload, header)).toBe(false);
  });

  it("Paymob verifyWebhook accepts portable HMAC-SHA512", () => {
    const hmacSecret = "paymob_hmac_secret";
    // Minimal transaction obj fields used by HMAC_FIELDS
    const obj = {
      amount_cents: 1000,
      created_at: "2024-01-01T00:00:00",
      currency: "EGP",
      error_occured: false,
      has_parent_transaction: false,
      id: 99,
      integration_id: 1,
      is_3d_secure: false,
      is_auth: false,
      is_capture: false,
      is_refunded: false,
      is_standalone_payment: true,
      is_voided: false,
      order: { id: 55 },
      owner: 1,
      pending: false,
      source_data: { pan: "1234", sub_type: "MasterCard", type: "card" },
      success: true,
    };

    const gw = new PaymobGateway(
      {
        secretKey: "egy_sk",
        hmacSecret,
        integrationId: 1,
      },
      new HooksManager({}),
    );

    const dataString = (
      gw as unknown as {
        buildHmacString: (o: typeof obj) => string;
      }
    ).buildHmacString(obj);
    const hmac = hmacSha512Hex(hmacSecret, dataString);

    expect(
      gw.verifyWebhook({ type: "TRANSACTION", obj, hmac }),
    ).toBe(true);
    expect(
      gw.verifyWebhook({ type: "TRANSACTION", obj, hmac: "0".repeat(128) }),
    ).toBe(false);
  });

  it("Moyasar verifyWebhook uses portable timing-safe compare", () => {
    const secret = "moyasar_whsec";
    const payload = {
      id: "evt_m1",
      type: "payment_paid",
      created_at: "2024-01-01T00:00:00Z",
      secret_token: secret,
      data: {
        id: "pay_1",
        status: "paid",
        amount: 1000,
        currency: "SAR",
      },
    };

    const gw = new MoyasarGateway(
      { secretKey: "sk", webhookSecret: secret },
      new HooksManager({}),
    );

    // Moyasar verifies secret_token field equals configured secret (timing-safe).
    expect(gw.verifyWebhook(payload)).toBe(true);
    expect(
      gw.verifyWebhook({ ...payload, secret_token: "wrong" }),
    ).toBe(false);
  });
});

describe("production core src has zero node: imports", () => {
  it("no production .ts under packages/core/src imports node:*", () => {
    const files = walkProductionTs(CORE_SRC);
    expect(files.length).toBeGreaterThan(20);

    const nodeImportRe =
      /(?:from|import)\s*['"]node:[^'"]+['"]|require\s*\(\s*['"]node:[^'"]+['"]\s*\)/;
    const violations: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (nodeImportRe.test(text)) {
        violations.push(relative(CORE_SRC, file));
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("factory runtime wiring", () => {
  it("all four factories forward context fetch/crypto/clock/uuid", async () => {
    const seen: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      // Stripe-shaped default for createPayment probes
      if (String(input).includes("stripe.com")) {
        return jsonResponse({
          id: "pi_x",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 100,
          currency: "usd",
          client_secret: "s",
          metadata: {},
          latest_charge: null,
          receipt_email: null,
        });
      }
      if (String(input).includes("moyasar.com")) {
        return jsonResponse({
          id: "22222222-2222-4222-8222-222222222222",
          status: "paid",
          amount: 100,
          fee: 0,
          currency: "SAR",
          refunded: 0,
          refunded_at: null,
          captured: 100,
          captured_at: null,
          voided_at: null,
          description: "t",
          amount_format: "1.00 SAR",
          fee_format: "0",
          invoice_id: null,
          ip: null,
          callback_url: null,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          metadata: {},
          source: { type: "creditcard", company: "visa", name: "T", number: "4111", message: null, transaction_url: null },
        });
      }
      if (String(input).includes("paypal.com") && String(input).includes("oauth2")) {
        return jsonResponse({
          access_token: "t",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (String(input).includes("paypal.com")) {
        return jsonResponse({
          id: "ORDER_X",
          status: "CREATED",
          intent: "CAPTURE",
          purchase_units: [
            { amount: { currency_code: "USD", value: "1.00" } },
          ],
        });
      }
      // paymob
      return jsonResponse({
        id: "pi_x",
        client_secret: "csk",
        status: "intended",
        amount: 100,
        currency: "EGP",
      });
    }) as typeof fetch;

    const fixedMs = 1_700_000_123_000;
    const ctx = createDefaultGatewayContext({
      fetch: mockFetch,
      clock: { now: () => new Date(fixedMs), nowMs: () => fixedMs },
      randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    const moyasarPaymentId = "22222222-2222-4222-8222-222222222222";
    const stripe = stripeGateway({ secretKey: "sk" }).create(ctx);
    const moyasar = moyasarGateway({ secretKey: "sk" }).create(ctx);
    const paypal = paypalGateway({
      clientId: "id",
      clientSecret: "sec",
      sandbox: true,
    }).create(ctx);
    const paymob = paymobGateway({
      secretKey: "egy_sk",
      publicKey: "egy_pk",
      integrationId: 1,
      hmacSecret: "h",
      region: "eg",
    }).create(ctx);

    await stripe.createPayment({
      amount: money(1, "USD"),
      currency: "USD",
      callbackUrl: "https://example.com",
    });
    await moyasar.getPayment({ gatewayPaymentId: moyasarPaymentId });
    await paypal.getPayment({ gatewayPaymentId: "ORDER_X" });
    await paymob.createPayment({
      amount: money(1, "EGP"),
      currency: "EGP",
      callbackUrl: "https://example.com",
      metadata: {
        email: "customer@example.com",
        firstName: "Test",
        lastName: "User",
        phone: "+201000000000",
      },
    });

    expect(seen.some((u) => u.includes("stripe.com"))).toBe(true);
    expect(seen.some((u) => u.includes("moyasar.com"))).toBe(true);
    expect(seen.some((u) => u.includes("paypal.com"))).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });
});
