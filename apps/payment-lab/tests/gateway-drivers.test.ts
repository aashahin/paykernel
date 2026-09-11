import { afterEach, describe, expect, it } from "bun:test";
import {
  InMemoryIdempotencyStore,
  InvalidRequestError,
  money,
  moneyToMajorNumber,
  OperationNotSupportedError,
} from "@paykernel/core";
import {
  createSandboxDriver,
  getGatewayReadiness,
  listGatewayReadiness,
} from "../src/server/gateways/index";
import type { GatewaySecrets } from "../src/server/gateways/types";

const originalFetch: typeof fetch = globalThis.fetch;

interface FetchCall {
  url: string;
  method: string;
  bodyText: string;
  authorization: string;
}

function readBodyText(init: RequestInit | undefined): string {
  if (init?.body === undefined || init.body === null) return "";
  if (typeof init.body === "string") return init.body;
  if (init.body instanceof URLSearchParams) return init.body.toString();
  return "";
}

function installProviderFetch(
  allowedPrefix: string,
  handler: (url: string, init: RequestInit | undefined) => Response,
  calls: FetchCall[],
): void {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(allowedPrefix)) {
      throw new Error(`unexpected fetch URL: ${url}`);
    }
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      bodyText: readBodyText(init),
      authorization: headers.get("authorization") ?? "",
    });
    return handler(url, init);
  }, { preconnect: originalFetch.preconnect });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const STRIPE_SECRETS: GatewaySecrets = {
  STRIPE_SECRET_KEY: "sk_test_lab_driver_fixture",
  STRIPE_PUBLISHABLE_KEY: "pk_test_lab_driver_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_lab_driver_fixture",
};

const PAYPAL_SECRETS: GatewaySecrets = {
  PAYPAL_CLIENT_ID: "test_client_id",
  PAYPAL_CLIENT_SECRET: "test_client_secret",
  PAYPAL_WEBHOOK_ID: "testwebhookid",
};

const PAYMOB_SECRETS: GatewaySecrets = {
  PAYMOB_API_KEY: "legacy_fixture_key",
  PAYMOB_SECRET_KEY: "sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  PAYMOB_PUBLIC_KEY: "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  PAYMOB_INTEGRATION_ID: "123456",
  PAYMOB_HMAC_SECRET: "test_hmac_secret_key",
};

const MOYASAR_SECRETS: GatewaySecrets = {
  MOYASAR_SECRET_KEY: "sk_test_unit",
  MOYASAR_WEBHOOK_SECRET: "webhook_secret",
};

const TAP_SECRETS: GatewaySecrets = {
  TAP_SECRET_KEY: "sk_test_conformance_placeholder_not_live",
};

const MYFATOORAH_SECRETS: GatewaySecrets = {
  MYFATOORAH_API_TOKEN: "test_secret_myfatoorah_api_token",
  MYFATOORAH_COUNTRY: "KWT",
  MYFATOORAH_WEBHOOK_SECRET: "whsec_test_conformance_placeholder",
};

function hesabeSecrets(): GatewaySecrets {
  return {
    HESABE_MERCHANT_CODE: "842217",
    HESABE_ACCESS_CODE: "test-access",
    HESABE_ENCRYPTION_KEY: "PkW64zMe5NVdrlPVNnjo2Jy9nOb7v1Xg",
    HESABE_IV_KEY: "5NVdrlPVNnjo2Jy9",
    HESABE_USERNAME: "merchant",
    HESABE_PASSWORD: "test-password",
  };
}

describe("sandbox gateway drivers (SDK HTTP fixtures)", () => {
  it("stripe Elements create serializes a payment_intent and preserves pi id", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://api.stripe.com",
      (url: string) => {
        if (!url.includes("/v1/payment_intents")) {
          throw new Error(`unexpected stripe URL: ${url}`);
        }
        return jsonResponse({
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
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "stripe", secrets: STRIPE_SECRETS });
    const result = await driver.create({
      reference: "order-elements-1",
      amount: money(50, "USD"),
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
      callbackUrl: "https://example.com",
      idempotencyKey: "idem-stripe-elements-1",
      description: "Test Charge",
    });
    expect(result.gatewayId).toBe("pi_321");
    expect(result.status).toBe("pending");
    expect(result.outcome).toBe("requires_action");
    expect(result.redirectUrl).toBe("https://stripe.example/next");
    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(calls[0]?.bodyText ?? "");
    expect(body.get("amount")).toBe("5000");
    expect(body.get("currency")).toBe("usd");
  });

  it("stripe Checkout create serializes a hosted session and preserves cs id", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://api.stripe.com",
      (url: string) => {
        if (!url.includes("/v1/checkout/sessions")) {
          throw new Error(`unexpected stripe URL: ${url}`);
        }
        return jsonResponse({
          id: "cs_test_123",
          object: "checkout.session",
          url: "https://checkout.stripe.com/test",
          status: "open",
          payment_status: "unpaid",
        });
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "stripe", secrets: STRIPE_SECRETS });
    const result = await driver.create({
      reference: "order-checkout-1",
      amount: money(100, "USD"),
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
      callbackUrl: "https://example.com/return",
      idempotencyKey: "idem-stripe-checkout-1",
      method: "checkout",
    });
    expect(result.gatewayId).toBe("cs_test_123");
    expect(result.redirectUrl).toBe("https://checkout.stripe.com/test");
    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(calls[0]?.bodyText ?? "");
    expect(body.get("mode")).toBe("payment");
    expect(body.get("success_url")).toBe("https://example.com/return");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("10000");
  });

  it("stripe completeReturn routes cs_ ids to checkout sessions, not payment intents", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://api.stripe.com",
      (url: string) => {
        if (!url.includes("/v1/checkout/sessions/cs_test_123")) {
          throw new Error(`unexpected stripe lookup URL: ${url}`);
        }
        return jsonResponse({
          id: "cs_test_123",
          object: "checkout.session",
          url: "https://checkout.stripe.com/test",
          status: "open",
          payment_status: "unpaid",
        });
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "stripe", secrets: STRIPE_SECRETS });
    const result = await driver.completeReturn({
      storedGatewayPaymentId: "cs_test_123",
      query: { status: "paid" },
    });
    expect(result.gatewayId).toBe("cs_test_123");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/v1/checkout/sessions/cs_test_123");
    expect(calls[0]?.url).not.toContain("/v1/payment_intents");
  });

  it("stripe sandbox driver rejects live keys and reports unconfigured readiness", () => {
    expect(() =>
      createSandboxDriver({
        gateway: "stripe",
        secrets: { ...STRIPE_SECRETS, STRIPE_SECRET_KEY: "sk_live_rejected" },
      }),
    ).toThrow(InvalidRequestError);
    const readiness = getGatewayReadiness("stripe", {
      ...STRIPE_SECRETS,
      STRIPE_SECRET_KEY: "sk_live_rejected",
    });
    expect(readiness.configured).toBe(false);
  });

  it("paypal create serializes a CAPTURE order and preserves approval redirect", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://api-m.sandbox.paypal.com",
      (url: string) => {
        if (url.includes("/v1/oauth2/token")) {
          return jsonResponse({ access_token: "test_token", expires_in: 3600 });
        }
        if (!url.endsWith("/v2/checkout/orders")) {
          throw new Error(`unexpected paypal URL: ${url}`);
        }
        return jsonResponse({
          id: "ORDER-123",
          status: "CREATED",
          links: [{ rel: "approve", href: "https://paypal.com/approve/ORDER-123" }],
        });
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "paypal", secrets: PAYPAL_SECRETS });
    const result = await driver.create({
      reference: "order-001",
      amount: money(99.99, "USD"),
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
      callbackUrl: "https://example.com/callback",
      idempotencyKey: "idem-paypal-create-1",
      description: "Test payment",
    });
    expect(result.gatewayId).toBe("ORDER-123");
    expect(result.status).toBe("pending");
    expect(result.outcome).toBe("requires_action");
    expect(result.redirectUrl).toBe("https://paypal.com/approve/ORDER-123");
    const orderCall = calls.find((call) => call.url.endsWith("/v2/checkout/orders"));
    expect(orderCall).toBeDefined();
    const body = JSON.parse(orderCall?.bodyText ?? "{}") as Record<string, unknown>;
    expect(body["intent"]).toBe("CAPTURE");
    const units = body["purchase_units"] as Array<Record<string, unknown>>;
    expect(units[0]?.["reference_id"]).toBe("order-001");
    const amount = units[0]?.["amount"] as Record<string, unknown>;
    expect(amount["currency_code"]).toBe("USD");
    expect(amount["value"]).toBe("99.99");
  });

  it("paypal completeReturn captures by default and authorizes on capture:false", async () => {
    const captureCalls: FetchCall[] = [];
    installProviderFetch(
      "https://api-m.sandbox.paypal.com",
      (url: string) => {
        if (url.includes("/v1/oauth2/token")) {
          return jsonResponse({ access_token: "test_token", expires_in: 3600 });
        }
        if ((url.endsWith("/v2/checkout/orders/ORDER-789/capture") || url.endsWith("/v2/checkout/orders/ORDER-789"))) {
          return jsonResponse({
            id: "ORDER-789",
            status: "COMPLETED",
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: "CAPTURE-XYZ",
                      status: "COMPLETED",
                      amount: { currency_code: "USD", value: "150.00" },
                    },
                  ],
                },
              },
            ],
          });
        }
        throw new Error(`unexpected paypal capture URL: ${url}`);
      },
      captureCalls,
    );
    const captureDriver = createSandboxDriver({ gateway: "paypal", secrets: PAYPAL_SECRETS });
    const captured = await captureDriver.completeReturn({
      storedGatewayPaymentId: "ORDER-789",
      idempotencyKey: "idem-paypal-capture-1",
    });
    expect(captured.gatewayId).toBe("ORDER-789");
    expect(captured.captureId).toBe("CAPTURE-XYZ");
    expect(moneyToMajorNumber(captured.amount ?? money(0, "USD"))).toBe(150);
    expect(captureCalls.some((call) => call.url.endsWith("/v2/checkout/orders/ORDER-789/capture"))).toBe(
      true,
    );

    const authCalls: FetchCall[] = [];
    installProviderFetch(
      "https://api-m.sandbox.paypal.com",
      (url: string) => {
        if (url.includes("/v1/oauth2/token")) {
          return jsonResponse({ access_token: "test_token", expires_in: 3600 });
        }
        if ((url.endsWith("/v2/checkout/orders/ORDER-AUTH/authorize") || url.endsWith("/v2/checkout/orders/ORDER-AUTH"))) {
          return jsonResponse({
            id: "ORDER-AUTH",
            status: "COMPLETED",
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: "AUTH-XYZ",
                      status: "CREATED",
                      amount: { currency_code: "USD", value: "150.00" },
                    },
                  ],
                },
              },
            ],
          });
        }
        throw new Error(`unexpected paypal authorize URL: ${url}`);
      },
      authCalls,
    );
    const authDriver = createSandboxDriver({ gateway: "paypal", secrets: PAYPAL_SECRETS });
    const authorized = await authDriver.completeReturn({
      storedGatewayPaymentId: "ORDER-AUTH",
      capture: false,
      idempotencyKey: "idem-paypal-auth-1",
    });
    expect(authorized.authorizationId).toBe("AUTH-XYZ");
    expect(authorized.status).toBe("authorized");
    expect(authCalls.some((call) => call.url.endsWith("/v2/checkout/orders/ORDER-AUTH/authorize"))).toBe(
      true,
    );
    expect(authCalls.some((call) => call.url.includes("/capture"))).toBe(false);
  });

  it("paypal completeReturn rejects a return token that does not match stored payment", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://api-m.sandbox.paypal.com",
      () => {
        throw new Error("paypal mismatch must throw before fetch");
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "paypal", secrets: PAYPAL_SECRETS });
    await expect(
      driver.completeReturn({
        storedGatewayPaymentId: "ORDER-123",
        query: { token: "ORDER-OTHER" },
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it("paymob create posts an intention with Token auth and unified checkout redirect", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://accept.paymob.com",
      (url: string) => {
        if (url !== "https://accept.paymob.com/v1/intention/") {
          throw new Error(`unexpected paymob URL: ${url}`);
        }
        return jsonResponse({ id: "pi_test_123", intention_order_id: 12345678, client_secret: "csk_test_123", status: "intended" });
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "paymob", secrets: PAYMOB_SECRETS });
    const result = await driver.create({
      reference: "order_paymob_1",
      amount: money("100.00", "EGP"),
      customer: { name: "Mohammed Ali", email: "customer@example.com", phone: "+966500000000" },
      callbackUrl: "https://example.com/webhook",
      idempotencyKey: "idem-paymob-1",
    });
    expect(result.gatewayId).toBe("pi_test_123");
    expect(result.orderId).toBe("12345678");
    expect(result.outcome).toBe("requires_action");
    expect(result.status).toBe("pending");
    expect(result.redirectUrl).toBe(
      "https://accept.paymob.com/unifiedcheckout/?publicKey=pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&clientSecret=csk_test_123",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Token sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    const body = JSON.parse(calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    expect(body["amount"]).toBe(10000);
    expect(body["payment_methods"]).toEqual([123456]);
    expect(body["redirection_url"]).toBe("https://example.com/webhook");
  });

  it("moyasar create sends browser token only and never raw PAN", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://api.moyasar.com",
      (url: string) => {
        if (!url.startsWith("https://api.moyasar.com/v1/payments")) {
          throw new Error(`unexpected moyasar URL: ${url}`);
        }
        return jsonResponse({
          id: "760878ec-d1d3-5f72-9056-191683f55872",
          status: "paid",
          amount: 10000,
          fee: 250,
          currency: "SAR",
          refunded: 0,
          captured: 10000,
          source: { type: "token", transaction_url: null },
        });
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "moyasar", secrets: MOYASAR_SECRETS });
    const result = await driver.create({
      reference: "order_moyasar_1",
      amount: money("100", "SAR"),
      customer: { name: "Saleh Ali", email: "saleh@example.com" },
      callbackUrl: "https://example.com/callback",
      idempotencyKey: "a1168bd1-47a4-4b97-8a50-dd5caaccacf2",
      sourceToken: "token_test_123",
    });
    expect(result.gatewayId).toBe("760878ec-d1d3-5f72-9056-191683f55872");
    expect(result.status).toBe("paid");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    const source = body["source"] as Record<string, unknown>;
    expect(source["type"]).toBe("token");
    expect(source["token"]).toBe("token_test_123");
    expect(calls[0]?.bodyText).not.toContain("4111111111111111");
    expect(calls[0]?.bodyText).not.toContain("cvc");

    const countBefore = calls.length;
    await expect(
      driver.create({
        reference: "order_moyasar_2",
        amount: money("100", "SAR"),
        customer: { name: "Saleh Ali", email: "saleh@example.com" },
        callbackUrl: "https://example.com/callback",
        idempotencyKey: "b2268bd1-47a4-4b97-8a50-dd5caaccacf3",
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.length).toBe(countBefore);
  });

  it("tap hosted charge posts major amount with src_all and lookup confirms stored id", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://api.tap.company",
      (url: string) => {
        if (!url.includes("/charges") && !url.includes("/authorize")) {
          throw new Error(`unexpected tap URL: ${url}`);
        }
        return jsonResponse({
          id: "chg_testInitiated01",
          object: "charge",
          live_mode: false,
          api_version: "V2",
          status: "CAPTURED",
          amount: 10.5,
          currency: "SAR",
          transaction: { created: "1000000000" },
          reference: { gateway: "", payment: "payref1", order: "ord_01" },
          response: { code: "000", message: "Captured" },
          customer: { id: "cus_testCustomer01", first_name: "Ada", email: "ada@example.com" },
          source: { object: "source", id: "src_all" },
          redirect: { status: "PENDING", url: "https://merchant.example/callback" },
          post: { status: "PENDING", url: "https://merchant.example/post" },
        });
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "tap", secrets: TAP_SECRETS });
    const created = await driver.create({
      reference: "ord_01",
      amount: money("10.50", "SAR"),
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
      callbackUrl: "https://merchant.example/callback",
      idempotencyKey: "idem-tap-1",
    });
    expect(created.gatewayId).toBe("chg_testInitiated01");
    expect(created.status).toBe("paid");
    const body = JSON.parse(calls[0]?.bodyText ?? "{}") as Record<string, unknown>;
    expect(body["amount"]).toBe(10.5);
    expect(body["currency"]).toBe("SAR");
    expect(body["source"]).toEqual({ id: "src_all" });

    const confirmed = await driver.completeReturn({ storedGatewayPaymentId: "chg_testInitiated01" });
    expect(confirmed.gatewayId).toBe("chg_testInitiated01");
    expect(confirmed.status).toBe("paid");
  });

  it("myfatoorah hosted invoice posts v3 payments and lookup uses InvoiceId key", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://apitest.myfatoorah.com",
      (url: string, init: RequestInit | undefined) => {
        if (url === "https://apitest.myfatoorah.com/v2/GetPaymentStatus") {
          const body = JSON.parse(readBodyText(init) || "{}") as Record<string, unknown>;
          if (body["Key"] === "915102" && body["KeyType"] === "InvoiceId") {
            return jsonResponse({
              IsSuccess: true,
              Message: "Ok",
              ValidationErrors: null,
              Data: {
                InvoiceId: 915102,
                InvoiceStatus: "Paid",
                InvoiceValue: 0.85,
                InvoiceCurrency: "KWD",
                InvoiceTransactions: [
                  {
                    TransactionStatus: "Succss",
                    PaymentId: "07076409988323998875",
                    Currency: "SAR",
                    PaidCurrency: "SAR",
                    PaidCurrencyValue: "10.500",
                    TransationValue: "10.500",
                  },
                ],
                Transactions: [
                  {
                    TransactionStatus: "Succss",
                    PaymentId: "07076409988323998875",
                    Currency: "SAR",
                    PaidCurrency: "SAR",
                    PaidCurrencyValue: "10.500",
                    TransationValue: "10.500",
                  },
                ],
              },
            });
          }
          return jsonResponse({ IsSuccess: false, Message: "Not found" }, 404);
        }
        if (url === "https://apitest.myfatoorah.com/v3/payments") {
          return jsonResponse({
            IsSuccess: true,
            Message: "Ok",
            ValidationErrors: null,
            Data: {
              InvoiceId: 915102,
              IsDirectPayment: false,
              PaymentURL:
                "https://sandbox.pg.apitest.myfatoorah.com/Checkout/Gateway/915102/2c7bee7e-9a1f-4d0a-8c3b-testfixture000001",
              CustomerReference: "payref1",
              UserDefinedField: "order_01",
              RecurringId: null,
            },
          });
        }
        throw new Error(`unexpected myfatoorah URL: ${url}`);
      },
      calls,
    );
    const driver = createSandboxDriver({ gateway: "myfatoorah", secrets: MYFATOORAH_SECRETS });
    const created = await driver.create({
      reference: "order_01",
      amount: money("10.50", "SAR"),
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
      callbackUrl: "https://merchant.example/callback",
      idempotencyKey: "idem-myfatoorah-1",
    });
    expect(created.gatewayId).toBe("915102");
    expect(created.redirectUrl).toBe(
      "https://sandbox.pg.apitest.myfatoorah.com/Checkout/Gateway/915102/2c7bee7e-9a1f-4d0a-8c3b-testfixture000001",
    );
    const post = calls.find((call) => call.url === "https://apitest.myfatoorah.com/v3/payments");
    expect(post).toBeDefined();
    const postBody = JSON.parse(post?.bodyText ?? "{}") as Record<string, unknown>;
    expect(postBody["Order"]).toEqual({ Amount: 10.5, Currency: "SAR", ExternalIdentifier: "order_01" });

    const lookedUp = await driver.lookup("915102");
    expect(lookedUp.gatewayId).toBe("915102");
    expect(lookedUp.status).toBe("paid");
    const statusCall = calls.find(
      (call) =>
        call.url === "https://apitest.myfatoorah.com/v2/GetPaymentStatus" &&
        call.bodyText.includes("915102"),
    );
    expect(statusCall).toBeDefined();
    expect(JSON.parse(statusCall?.bodyText ?? "{}")).toEqual({ Key: "915102", KeyType: "InvoiceId" });
  });

  it("hesabe driver enforces KWD, checkout-id lookup, unsupported capture, and store", async () => {
    const calls: FetchCall[] = [];
    installProviderFetch(
      "https://sandbox.hesabe.com",
      () => {
        throw new Error("hesabe guards must throw before fetch");
      },
      calls,
    );
    const driver = createSandboxDriver({
      gateway: "hesabe",
      secrets: hesabeSecrets(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    await expect(
      driver.create({
        reference: "order-hesabe-1",
        amount: money("10", "USD"),
        customer: { name: "Ada Lovelace", email: "ada@example.com" },
        callbackUrl: "https://shop.example/callback",
        idempotencyKey: "hesabe-create-1",
      }),
    ).rejects.toThrow(InvalidRequestError);
    await expect(driver.lookup("checkout:session")).rejects.toThrow(InvalidRequestError);
    await expect(
      driver.capture({ gatewayPaymentId: "tx-1", idempotencyKey: "hesabe-capture-1" }),
    ).rejects.toThrow(OperationNotSupportedError);
    expect(() => createSandboxDriver({ gateway: "hesabe", secrets: hesabeSecrets() })).toThrow(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it("readiness reports missing secrets for all seven gateways when empty", () => {
    const readiness = listGatewayReadiness({});
    expect(readiness).toHaveLength(7);
    const byGateway = new Map(readiness.map((entry) => [entry.gateway, entry]));
    expect(byGateway.get("stripe")?.missing).toContain("STRIPE_SECRET_KEY");
    expect(byGateway.get("paypal")?.missing).toContain("PAYPAL_CLIENT_ID");
    expect(byGateway.get("paymob")?.missing).toContain("PAYMOB_SECRET_KEY");
    expect(byGateway.get("moyasar")?.missing).toContain("MOYASAR_SECRET_KEY");
    expect(byGateway.get("tap")?.missing).toContain("TAP_SECRET_KEY");
    expect(byGateway.get("myfatoorah")?.missing).toContain("MYFATOORAH_API_TOKEN");
    expect(byGateway.get("hesabe")?.missing).toContain("HESABE_MERCHANT_CODE");
    for (const entry of readiness) {
      expect(entry.configured).toBe(false);
      expect(entry.sandbox).toBe(true);
    }
  });
});

it("Moyasar paid sales settle even when its separate manual-capture total is zero", async () => {
  const calls: FetchCall[] = [];
  installProviderFetch("https://api.moyasar.com/", () => jsonResponse({
    id: "550e8400-e29b-41d4-a716-446655440011", status: "paid", amount: 1000, currency: "SAR", captured: 0,
    captured_at: null, refunded: 0, source: { type: "creditcard", message: "APPROVED" },
  }), calls);
  const driver = createSandboxDriver({ gateway: "moyasar", secrets: MOYASAR_SECRETS });
  const payment = await driver.lookup("550e8400-e29b-41d4-a716-446655440011");
  expect(payment.status).toBe("paid");
  expect(payment.outcome).toBe("succeeded");
  expect(payment.capturedAmount).toEqual(money("10.00", "SAR"));
});

it("Moyasar authorization with no capture remains unsettled", async () => {
  const calls: FetchCall[] = [];
  installProviderFetch("https://api.moyasar.com/", () => jsonResponse({
    id: "550e8400-e29b-41d4-a716-446655440012", status: "authorized", amount: 1000, currency: "SAR", captured: 0,
    captured_at: null, refunded: 0, source: { type: "creditcard" },
  }), calls);
  const payment = await createSandboxDriver({ gateway: "moyasar", secrets: MOYASAR_SECRETS }).lookup("550e8400-e29b-41d4-a716-446655440012");
  expect(payment.status).toBe("authorized");
  expect(payment.capturedAmount?.amount).toBe("0.00");
});

for (const refunded of [400, 1000]) it(`Moyasar sale preserves its captured total after refunding ${refunded}`, async () => {
  const calls: FetchCall[] = [];
  const id = "550e8400-e29b-41d4-a716-446655440013";
  installProviderFetch("https://api.moyasar.com/", () => jsonResponse({
    id, status: "refunded", amount: 1000, currency: "SAR", captured: 0,
    captured_at: null, refunded, source: { type: "creditcard" },
  }), calls);
  const payment = await createSandboxDriver({ gateway: "moyasar", secrets: MOYASAR_SECRETS }).lookup(id);
  expect(payment.status).toBe(refunded === 1000 ? "refunded" : "partially_refunded");
  expect(payment.capturedAmount).toEqual(money("10.00", "SAR"));
});
