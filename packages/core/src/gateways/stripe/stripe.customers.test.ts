/**
 * Stripe Phase 22.1 — first-class customers and stored payment methods.
 *
 * Offline: mocks `fetch`. Unique coverage vs the vault acceptance suite:
 * Stripe HTTP paths, id validation, idempotency, mapping of common
 * `customerId` / `paymentMethodId` / `offSession` onto PaymentIntents.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { StripeGateway } from "./stripe.gateway";
import { HooksManager } from "../../hooks/hooks.manager";
import type { StripeConfig } from "../../types/config.types";
import { InvalidRequestError, NetworkError, createPaymentClient, stripeGateway, money } from "../../index";


const STRIPE_TEST_CONFIG: StripeConfig = {
  secretKey: "sk_test_123",
  publishableKey: "pk_test_123",
  webhookSecret: "whsec_test_123",
};

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

describe("StripeGateway customers and payment methods", () => {
  let gateway: StripeGateway;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    gateway = new StripeGateway(STRIPE_TEST_CONFIG, new HooksManager({}));
    globalThis.fetch = originalFetch;
  });

  it("createCustomer POSTs /v1/customers and returns a succeeded snapshot", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedKey = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(opts.body ?? "");
      capturedKey = new Headers(opts.headers).get("Idempotency-Key") ?? "";
      return createMockResponse({
        id: "cus_123",
        object: "customer",
        email: "buyer@example.com",
        name: "Buyer",
        metadata: { userId: "u_1" },
      });
    }) as unknown as typeof fetch;

    const result = await gateway.createCustomer({
      email: "buyer@example.com",
      name: "Buyer",
      metadata: { userId: "u_1" },
      idempotencyKey: "idem_cus_1",
    });

    expect(capturedUrl).toBe("https://api.stripe.com/v1/customers");
    expect(capturedKey).toBe("idem_cus_1");
    const body = new URLSearchParams(capturedBody);
    expect(body.get("email")).toBe("buyer@example.com");
    expect(body.get("name")).toBe("Buyer");
    expect(body.get("metadata[userId]")).toBe("u_1");
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("createCustomer must succeed");
    }
    expect(result.customer.status).toBe("active");
    expect(result.customer.email).toBe("buyer@example.com");
    expect(result.customer.name).toBe("Buyer");
    expect(result.customer.references.providerObjectId).toBe("cus_123");
    expect(result.customer.references.gateway).toBe("stripe");
    expect(result.customer.references.relatedIds?.customerId).toBe("cus_123");
    expect(result.customer.metadata).toEqual({ userId: "u_1" });
  });

  it("createCustomer requires a caller idempotencyKey before POST", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return createMockResponse({ id: "cus_x" });
    }) as unknown as typeof fetch;

    await expect(gateway.createCustomer({ email: "buyer@example.com" })).rejects.toThrow(
      /idempotencyKey/i,
    );
    expect(fetchCalls).toBe(0);
  });

  it("createCustomer HTTP 200 without id is indeterminate", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse({ object: "customer", email: "buyer@example.com" }),
    ) as unknown as typeof fetch;

    const result = await gateway.createCustomer({
      email: "buyer@example.com",
      idempotencyKey: "idem_cus_noid",
    });
    expect(result.outcome).toBe("indeterminate");
    if (result.outcome !== "indeterminate") {
      expect.unreachable("missing id must be indeterminate");
    }
    expect(result.reconciliationRequired).toBe(true);
  });

  it("createCustomer empty HTTP 200 is indeterminate, not a throw", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse(""),
    ) as unknown as typeof fetch;

    const result = await gateway.createCustomer({
      email: "buyer@example.com",
      idempotencyKey: "idem_cus_empty",
    });
    expect(result.outcome).toBe("indeterminate");
    if (result.outcome !== "indeterminate") {
      expect.unreachable("empty body must be indeterminate");
    }
    expect(result.reconciliationRequired).toBe(true);
  });

  it("getCustomer GETs /v1/customers/:id", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url) => {
      capturedUrl = String(url);
      return createMockResponse({
        id: "cus_abc",
        object: "customer",
        email: "buyer@example.com",
        name: "Buyer",
        metadata: { userId: "u_1" },
      });
    }) as unknown as typeof fetch;

    const result = await gateway.getCustomer({ customerId: "cus_abc" });
    expect(capturedUrl).toBe("https://api.stripe.com/v1/customers/cus_abc");
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("getCustomer must succeed");
    }
    expect(result.customer.references.providerObjectId).toBe("cus_abc");
    expect(result.customer.metadata).toEqual({ userId: "u_1" });
  });

  it("getCustomer maps deleted customers", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse({
        id: "cus_del",
        object: "customer",
        deleted: true,
      }),
    ) as unknown as typeof fetch;

    const result = await gateway.getCustomer({ customerId: "cus_del" });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("deleted customer is a succeeded snapshot");
    }
    expect(result.customer.status).toBe("deleted");
  });

  it("getCustomer rejects malformed ids before fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return createMockResponse({});
    }) as unknown as typeof fetch;

    await expect(
      gateway.getCustomer({ customerId: "not_a_customer" }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchCalls).toBe(0);
  });

  it("P22-GET-FLAG-2: GET 200 customer body without id is not afterProviderSubmit", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse({ object: "customer", email: "buyer@example.com" }),
    ) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await gateway.getCustomer({ customerId: "cus_noid" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    if (!(thrown instanceof NetworkError)) {
      expect.unreachable("GET missing id must throw NetworkError");
    }
    expect(thrown.afterProviderSubmit).not.toBe(true);
    expect(thrown).not.toEqual(
      expect.objectContaining({ outcome: "indeterminate" }),
    );
  });

  it("getCustomer 404 is a failed outcome, not a throw", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse(
        { error: { message: "No such customer: cus_missing", type: "invalid_request_error" } },
        false,
        404,
      ),
    ) as unknown as typeof fetch;

    const result = await gateway.getCustomer({ customerId: "cus_missing" });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") {
      expect.unreachable("404 must be failed");
    }
    expect(result.error.code).toBe("GATEWAY_API_ERROR");
  });

  it("attachPaymentMethod POSTs /v1/payment_methods/:id/attach", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(opts.body ?? "");
      return createMockResponse({
        id: "pm_card_1",
        object: "payment_method",
        customer: "cus_123",
        type: "card",
        card: { brand: "visa", last4: "4242" },
      });
    }) as unknown as typeof fetch;

    const result = await gateway.attachPaymentMethod({
      customerId: "cus_123",
      paymentMethodId: "pm_card_1",
      idempotencyKey: "idem_pm_attach",
    });

    expect(capturedUrl).toBe(
      "https://api.stripe.com/v1/payment_methods/pm_card_1/attach",
    );
    expect(new URLSearchParams(capturedBody).get("customer")).toBe("cus_123");
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("attach must succeed");
    }
    expect(result.paymentMethod.id).toBe("pm_card_1");
    expect(result.paymentMethod.customerId).toBe("cus_123");
    expect(result.paymentMethod.type).toBe("card");
    expect(result.paymentMethod.brand).toBe("visa");
    expect(result.paymentMethod.last4).toBe("4242");
  });

  it("attachPaymentMethod converts tok_ into a PaymentMethod then attaches it", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const idempotencyKeys: string[] = [];
    globalThis.fetch = mock(async (url, opts: RequestInit) => {
      urls.push(String(url));
      bodies.push(String(opts.body ?? ""));
      idempotencyKeys.push(
        new Headers(opts.headers).get("Idempotency-Key") ?? "",
      );
      if (String(url).endsWith("/payment_methods")) {
        return createMockResponse({
          id: "pm_from_tok",
          object: "payment_method",
          type: "card",
          card: { brand: "visa", last4: "4242" },
        });
      }
      return createMockResponse({
        id: "pm_from_tok",
        object: "payment_method",
        customer: "cus_123",
        type: "card",
        card: { brand: "visa", last4: "4242" },
      });
    }) as unknown as typeof fetch;

    const result = await gateway.attachPaymentMethod({
      customerId: "cus_123",
      token: "tok_visa",
      idempotencyKey: "idem_pm_tok",
    });

    expect(urls).toEqual([
      "https://api.stripe.com/v1/payment_methods",
      "https://api.stripe.com/v1/payment_methods/pm_from_tok/attach",
    ]);
    expect(new URLSearchParams(bodies[0] ?? "").get("type")).toBe("card");
    expect(new URLSearchParams(bodies[0] ?? "").get("card[token]")).toBe(
      "tok_visa",
    );
    expect(new URLSearchParams(bodies[1] ?? "").get("customer")).toBe(
      "cus_123",
    );
    expect(idempotencyKeys[0]).toBe("idem_pm_tok:create");
    expect(idempotencyKeys[1]).toBe("idem_pm_tok:attach");
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("tok_ attach must succeed");
    }
    expect(result.paymentMethod.id).toBe("pm_from_tok");
    expect(result.paymentMethod.customerId).toBe("cus_123");
    expect(result.paymentMethod.last4).toBe("4242");
  });

  it("attachPaymentMethod with a pm_ token attaches directly", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url) => {
      urls.push(String(url));
      return createMockResponse({
        id: "pm_direct",
        object: "payment_method",
        customer: "cus_123",
        type: "card",
        card: { brand: "visa", last4: "1111" },
      });
    }) as unknown as typeof fetch;

    const result = await gateway.attachPaymentMethod({
      customerId: "cus_123",
      token: "pm_direct",
      idempotencyKey: "idem_pm_direct",
    });
    expect(urls).toEqual([
      "https://api.stripe.com/v1/payment_methods/pm_direct/attach",
    ]);
    expect(result.outcome).toBe("succeeded");
  });

  it("P22R3-ATTACH-XOR: paymentMethodId and token that differ do not fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return createMockResponse({});
    }) as unknown as typeof fetch;

    await expect(
      gateway.attachPaymentMethod({
        customerId: "cus_123",
        paymentMethodId: "pm_card_1",
        token: "tok_visa",
        idempotencyKey: "idem_pm_xor",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchCalls).toBe(0);
  });

  it("P22R3-IDEM-TRUNC: 255-char keys that differ only in the tail produce different step keys", async () => {
    const capturedKeys: string[] = [];
    globalThis.fetch = mock(async (_url, opts: RequestInit) => {
      capturedKeys.push(new Headers(opts.headers).get("Idempotency-Key") ?? "");
      if (String(_url).endsWith("/payment_methods")) {
        return createMockResponse({
          id: "pm_from_tok",
          object: "payment_method",
          type: "card",
          card: { brand: "visa", last4: "4242" },
        });
      }
      return createMockResponse({
        id: "pm_from_tok",
        object: "payment_method",
        customer: "cus_123",
        type: "card",
        card: { brand: "visa", last4: "4242" },
      });
    }) as unknown as typeof fetch;

    const prefix = "k".repeat(254);
    const keyA = `${prefix}a`;
    const keyB = `${prefix}b`;
    expect(keyA).toHaveLength(255);
    expect(keyB).toHaveLength(255);
    expect(keyA.slice(0, 254)).toBe(keyB.slice(0, 254));

    await gateway.attachPaymentMethod({
      customerId: "cus_123",
      token: "tok_visa",
      idempotencyKey: keyA,
    });
    const createA = capturedKeys[0];
    const attachA = capturedKeys[1];
    capturedKeys.length = 0;

    await gateway.attachPaymentMethod({
      customerId: "cus_123",
      token: "tok_visa",
      idempotencyKey: keyB,
    });
    const createB = capturedKeys[0];
    const attachB = capturedKeys[1];

    expect(createA).toBeTruthy();
    expect(createB).toBeTruthy();
    expect(createA).not.toBe(createB);
    expect(attachA).not.toBe(attachB);
    expect(createA!.length).toBeLessThanOrEqual(255);
    expect(createB!.length).toBeLessThanOrEqual(255);
    expect(attachA!.length).toBeLessThanOrEqual(255);
    expect(attachB!.length).toBeLessThanOrEqual(255);
  });

  it("attachPaymentMethod rejects unknown token prefixes before fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return createMockResponse({});
    }) as unknown as typeof fetch;

    await expect(
      gateway.attachPaymentMethod({
        customerId: "cus_123",
        token: "src_unknown",
        idempotencyKey: "idem_pm_bad",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchCalls).toBe(0);
  });

  it("attachPaymentMethod tok_ create without id is indeterminate and skips attach", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url) => {
      urls.push(String(url));
      return createMockResponse({
        object: "payment_method",
        type: "card",
      });
    }) as unknown as typeof fetch;

    const result = await gateway.attachPaymentMethod({
      customerId: "cus_123",
      token: "tok_visa",
      idempotencyKey: "idem_pm_noid",
    });
    expect(urls).toEqual(["https://api.stripe.com/v1/payment_methods"]);
    expect(result.outcome).toBe("indeterminate");
    if (result.outcome !== "indeterminate") {
      expect.unreachable("missing pm id must be indeterminate");
    }
    expect(result.reconciliationRequired).toBe(true);
  });

  it("listPaymentMethods GETs /v1/customers/:id/payment_methods", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url) => {
      capturedUrl = String(url);
      return createMockResponse({
        object: "list",
        data: [
          {
            id: "pm_1",
            object: "payment_method",
            customer: "cus_123",
            type: "card",
            card: { brand: "mastercard", last4: "4444" },
          },
        ],
        has_more: false,
      });
    }) as unknown as typeof fetch;

    const result = await gateway.listPaymentMethods({ customerId: "cus_123" });
    expect(capturedUrl).toContain(
      "https://api.stripe.com/v1/customers/cus_123/payment_methods",
    );
    expect(capturedUrl).toContain("limit=100");
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("list must succeed");
    }
    expect(result.paymentMethods).toHaveLength(1);
    expect(result.paymentMethods[0]?.last4).toBe("4444");
    expect(result.paymentMethods[0]?.brand).toBe("mastercard");
  });

  it("P22-LIST-TRUNC: listPaymentMethods pages while has_more is true", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url) => {
      urls.push(String(url));
      if (String(url).includes("starting_after=pm_1")) {
        return createMockResponse({
          object: "list",
          data: [
            {
              id: "pm_2",
              object: "payment_method",
              customer: "cus_123",
              type: "card",
              card: { brand: "visa", last4: "4242" },
            },
          ],
          has_more: false,
        });
      }
      return createMockResponse({
        object: "list",
        data: [
          {
            id: "pm_1",
            object: "payment_method",
            customer: "cus_123",
            type: "card",
            card: { brand: "mastercard", last4: "4444" },
          },
        ],
        has_more: true,
      });
    }) as unknown as typeof fetch;

    const result = await gateway.listPaymentMethods({ customerId: "cus_123" });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/customers/cus_123/payment_methods");
    expect(urls[0]).toContain("limit=100");
    expect(urls[0]).not.toContain("starting_after");
    expect(urls[1]).toContain("limit=100");
    expect(urls[1]).toContain("starting_after=pm_1");
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("paged list must succeed");
    }
    expect(result.paymentMethods.map((pm) => pm.id)).toEqual(["pm_1", "pm_2"]);
  });

  it("P22R3-LIST-PM-CAP: listPaymentMethods throws NetworkError after 20 pages if has_more", async () => {
    let pages = 0;
    globalThis.fetch = mock(async () => {
      pages += 1;
      return createMockResponse({
        object: "list",
        data: [
          {
            id: `pm_${pages}`,
            object: "payment_method",
            customer: "cus_123",
            type: "card",
            card: { brand: "visa", last4: "4242" },
          },
        ],
        has_more: true,
      });
    }) as unknown as typeof fetch;

    await expect(
      gateway.listPaymentMethods({ customerId: "cus_123" }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(pages).toBe(20);
  });

  it("P22R3-LIST-404: listPaymentMethods 404 is failed", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse(
        {
          error: {
            message: "No such customer: cus_missing",
            type: "invalid_request_error",
          },
        },
        false,
        404,
      ),
    ) as unknown as typeof fetch;

    const result = await gateway.listPaymentMethods({
      customerId: "cus_missing",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") {
      expect.unreachable("404 must be failed");
    }
    expect(result.error.code).toBe("GATEWAY_API_ERROR");
    expect(result).not.toEqual(expect.objectContaining({ paymentMethods: [] }));
  });

  it("P22R3-LAST4: last4 is published only when it is 2-4 digits", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse({
        id: "pm_bad_last4",
        object: "payment_method",
        customer: "cus_123",
        type: "card",
        card: { brand: "visa", last4: "xx42" },
      }),
    ) as unknown as typeof fetch;

    const result = await gateway.attachPaymentMethod({
      customerId: "cus_123",
      paymentMethodId: "pm_bad_last4",
      idempotencyKey: "idem_pm_last4",
    });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("attach must succeed");
    }
    expect(result.paymentMethod.last4).toBeUndefined();
  });

  it("detachPaymentMethod POSTs /v1/payment_methods/:id/detach", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url) => {
      capturedUrl = String(url);
      return createMockResponse({
        id: "pm_card_1",
        object: "payment_method",
        customer: null,
        type: "card",
        card: { brand: "visa", last4: "4242" },
      });
    }) as unknown as typeof fetch;

    const result = await gateway.detachPaymentMethod({
      paymentMethodId: "pm_card_1",
      customerId: "cus_123",
      idempotencyKey: "idem_pm_detach",
    });
    expect(capturedUrl).toBe(
      "https://api.stripe.com/v1/payment_methods/pm_card_1/detach",
    );
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("detach must succeed");
    }
    expect(result.paymentMethod.id).toBe("pm_card_1");
    expect(result.paymentMethod.customerId).toBeUndefined();
    expect(result.paymentMethod.references.relatedIds?.customerId).toBeUndefined();
    expect(result.paymentMethod.references.normalizedStatus).not.toBe("active");
    expect(result.paymentMethod.references.normalizedStatus).toBe("detached");
  });

  it("P22-EMPTY-CUS: detach without customerId does not publish empty customerId", async () => {
    globalThis.fetch = mock(async () =>
      createMockResponse({
        id: "pm_card_1",
        object: "payment_method",
        customer: null,
        type: "card",
        card: { brand: "visa", last4: "4242" },
      }),
    ) as unknown as typeof fetch;

    const result = await gateway.detachPaymentMethod({
      paymentMethodId: "pm_card_1",
      idempotencyKey: "idem_pm_detach_nocust",
    });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("detach must succeed");
    }
    expect(result.paymentMethod.customerId).not.toBe("");
    expect(result.paymentMethod.customerId).toBeUndefined();
    expect(result.paymentMethod.references.relatedIds?.customerId).not.toBe("");
    expect(result.paymentMethod.references.relatedIds?.customerId).toBeUndefined();
  });

  it("P22-OFFSESSION-CUS: off-session without customer does not fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return createMockResponse({});
    }) as unknown as typeof fetch;

    await expect(
      gateway.createPayment({
        amount: money(10, "SAR"),
        currency: "SAR",
        callbackUrl: "https://merchant.example/callback",
        paymentMethodId: "pm_card_1",
        offSession: true,
        idempotencyKey: "idem_off_no_cus",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchCalls).toBe(0);
  });

  it("createPayment maps customerId and paymentMethodId onto the PaymentIntent", async () => {
    let capturedBody = "";
    globalThis.fetch = mock(async (_url, opts: RequestInit) => {
      capturedBody = String(opts.body ?? "");
      return createMockResponse({
        id: "pi_off",
        object: "payment_intent",
        status: "succeeded",
        amount: 1000,
        amount_received: 1000,
        currency: "sar",
      });
    }) as unknown as typeof fetch;

    const result = await gateway.createPayment({
      amount: money(10, "SAR"),
      currency: "SAR",
      callbackUrl: "https://merchant.example/callback",
      customerId: "cus_123",
      paymentMethodId: "pm_card_1",
      offSession: true,
      idempotencyKey: "idem_pi_off",
    });

    const body = new URLSearchParams(capturedBody);
    expect(body.get("customer")).toBe("cus_123");
    expect(body.get("payment_method")).toBe("pm_card_1");
    expect(body.get("confirm")).toBe("true");
    expect(body.get("off_session")).toBe("true");
    expect(body.get("automatic_payment_methods[allow_redirects]")).toBe(
      "never",
    );
    expect(body.get("return_url")).toBeNull();
    expect(result.outcome).toBe("succeeded");
    expect(result.gatewayId).toBe("pi_off");
  });

  it("createPayment rejects conflicting customerId and stripeCustomerId", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return createMockResponse({});
    }) as unknown as typeof fetch;

    await expect(
      gateway.createPayment({
        amount: money(10, "SAR"),
        currency: "SAR",
        callbackUrl: "https://merchant.example/callback",
        customerId: "cus_a",
        stripeCustomerId: "cus_b",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchCalls).toBe(0);
  });

  it("PaymentClient createCustomer reaches Stripe HTTP", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url) => {
      capturedUrl = String(url);
      return createMockResponse({
        id: "cus_client",
        object: "customer",
        email: "buyer@example.com",
      });
    }) as unknown as typeof fetch;

    const client = createPaymentClient({
      gateways: { stripe: stripeGateway(STRIPE_TEST_CONFIG) },
      defaultGateway: "stripe",
    });
    const result = await client.createCustomer({
      email: "buyer@example.com",
      idempotencyKey: "idem_client_cus",
    });
    expect(capturedUrl).toBe("https://api.stripe.com/v1/customers");
    expect(result.outcome).toBe("succeeded");
  });
});
