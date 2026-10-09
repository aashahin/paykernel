import { describe, expect, it } from "bun:test";
import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPaymentClient,
  createPaymentRuntime,
  InMemoryIdempotencyStore,
  InvalidRequestError,
  NetworkError,
  OperationNotSupportedError,
  PaymentAbortedError,
  money,
  type PaymentHooks,
} from "@paykernel/core";
import {
  HESABE_ADAPTER_VERSION,
  hesabeGateway,
  isHesabeApplePayAction,
  isHesabeEmbeddedCheckoutAction,
  type HesabeConfig,
  type HesabeCreatePaymentParams,
} from "./index";
import { hesabeEncrypt, hesabeDecryptJson } from "./crypto";

const cryptoProvider = createPaymentRuntime().crypto;
const packageVersion = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const config = (overrides: Partial<HesabeConfig> = {}): HesabeConfig => ({
  merchantCode: "842217",
  accessCode: "test-access",
  encryptionKey: "PkW64zMe5NVdrlPVNnjo2Jy9nOb7v1Xg",
  ivKey: "5NVdrlPVNnjo2Jy9",
  username: "merchant",
  password: "test-password",
  idempotencyStore: new InMemoryIdempotencyStore(),
  ...overrides,
});
const createParams = () => ({
  amount: money("10", "KWD"),
  currency: "KWD",
  orderId: "order-1",
  idempotencyKey: "create-1",
  callbackUrl: "https://shop.example/callback",
});
const tx = (extra: Record<string, unknown> = {}) => ({
  status: true,
  data: {
    token: "tx-1",
    reference_number: "order-1",
    amount: "10.000",
    status: "SUCCESSFUL",
    ...extra,
  },
});
const hook = (extra: Record<string, unknown> = {}) => ({
  token: "tx-1",
  reference_number: "order-1",
  amount: "10.000",
  status: "SUCCESSFUL",
  ...extra,
});
async function encrypted(value: unknown): Promise<string> {
  const c = config();
  return hesabeEncrypt(JSON.stringify(value), c.encryptionKey, c.ivKey, cryptoProvider);
}
function legacyEncrypted(value: unknown): string {
  const c = config();
  const bytes = Buffer.from(JSON.stringify(value));
  const pad = 32 - (bytes.length % 32);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(c.encryptionKey), Buffer.from(c.ivKey));
  cipher.setAutoPadding(false);
  return Buffer.concat([
    cipher.update(Buffer.concat([bytes, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString("hex");
}
async function decode(body: unknown): Promise<Record<string, unknown>> {
  const c = config();
  return (await hesabeDecryptJson(
    JSON.parse(String(body)).data,
    c.encryptionKey,
    c.ivKey,
    cryptoProvider,
  )) as Record<string, unknown>;
}
function setup(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  overrides: Partial<HesabeConfig> = {},
  hooks: PaymentHooks = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createPaymentClient({
    gateways: { hesabe: hesabeGateway(config(overrides)) },
    hooks,
    runtime: {
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return handler(String(url), init ?? {});
      }) as typeof fetch,
    },
  });
  return { gateway: client.gateway("hesabe"), client, calls };
}
const json = (body: unknown) => Response.json(body);

const browserCheckouts = [
  { hesabeCheckoutMode: "embedded" },
  { hesabeCheckoutMode: "applepay", hesabeApplePayDomain: "shop.example" },
] as const;
const checkoutModes = [{ hesabeCheckoutMode: "redirect" }, ...browserCheckouts] as const;

describe("Hesabe adapter integration", () => {
  it("registers without network or credential exposure", () => {
    const adapter = hesabeGateway(config());
    expect(HESABE_ADAPTER_VERSION).toBe(packageVersion);
    expect(adapter.manifest.version).toBe(packageVersion);
    expect(adapter.manifest.apiVersion).toBe("2.0/3.0");
    expect(JSON.stringify(adapter)).not.toContain("test-password");
    expect(JSON.stringify(adapter)).not.toContain("test-access");
    const { gateway, calls } = setup(() => {
      throw new Error("unexpected");
    });
    expect(calls).toHaveLength(0);
    expect(gateway.supports("refunds")).toBe(true);
    expect(gateway.supports("hostedCheckout")).toBe(false);
  });
  it("creates encrypted checkout and replays one POST", async () => {
    let payload: Record<string, unknown> = {};
    const { gateway, calls } = setup(async (_url, init) => {
      payload = await decode(init.body);
      return new Response(await encrypted({ status: true, response: { data: "session&1" } }));
    });
    const result = await gateway.createPayment(createParams());
    expect(calls[0]?.url).toBe("https://sandbox.hesabe.com/checkout");
    expect(new Headers(calls[0]?.init.headers).get("accessCode")).toBe("test-access");
    expect(result.outcome).toBe("requires_action");
    expect(result.gatewayId).toBe("checkout:session&1");
    expect(result.redirectUrl).toBe("https://sandbox.hesabe.com/payment?data=session%261");
    expect(payload).toEqual({
      merchantCode: "842217",
      amount: "10.000",
      currency: "KWD",
      paymentType: 0,
      version: "2.0",
      orderReferenceNumber: "order-1",
      responseUrl: "https://shop.example/callback",
      failureUrl: "https://shop.example/callback",
    });
    expect(await gateway.createPayment(createParams())).toEqual(result);
    expect(
      await gateway.createPayment({ ...createParams(), hesabeCheckoutMode: "redirect" }),
    ).toEqual(result);
    expect(calls).toHaveLength(1);
    await expect(
      gateway.createPayment({ ...createParams(), amount: money("11", "KWD") }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
  it("opens checkout from Hesabe's legacy padded response", async () => {
    const { gateway, calls } = setup(
      () => new Response(legacyEncrypted({ status: true, response: { data: "session" } })),
    );
    const result = await gateway.createPayment(createParams());
    expect(result.outcome).toBe("requires_action");
    expect(result.gatewayId).toBe("checkout:session");
    expect(result.redirectUrl).toBe("https://sandbox.hesabe.com/payment?data=session");
    expect(calls).toHaveLength(1);
  });
  it.each([
    { name: "missing idempotency key", change: { idempotencyKey: "" } },
    { name: "missing order ID", change: { orderId: "" } },
    { name: "unsupported currency", change: { currency: "USD" } },
    { name: "insecure callback URL", change: { callbackUrl: "http://shop.example" } },
    { name: "international mobile number", change: { hesabeMobileNumber: "96512345678" } },
  ])("rejects $name before fetch", async ({ change }) => {
    const { gateway, calls } = setup(() => {
      throw new Error("unexpected");
    });
    await expect(gateway.createPayment({ ...createParams(), ...change })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(calls).toHaveLength(0);
  });
  it("rejects delayed capture before fetch", async () => {
    const { gateway, calls } = setup(() => {
      throw new Error("unexpected");
    });
    await expect(
      gateway.createPayment({ ...createParams(), capture: false }),
    ).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(gateway.capturePayment({ gatewayPaymentId: "tx-1" })).rejects.toBeInstanceOf(
      OperationNotSupportedError,
    );
    expect(calls).toHaveLength(0);
  });
  it.each([...checkoutModes])(
    "fences concurrent $hesabeCheckoutMode requests across instances sharing a store",
    async (options) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = new InMemoryIdempotencyStore();
      let started!: () => void;
      const submitted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const first = setup(
        async () => {
          started();
          await gate;
          return new Response(await encrypted({ status: true, response: { data: "session" } }));
        },
        { idempotencyStore: store },
      );
      const second = setup(
        () => {
          throw new Error("duplicate");
        },
        { idempotencyStore: store },
      );
      const params = { ...createParams(), ...options };
      const pending = first.gateway.createPayment(params);
      await submitted;
      try {
        await expect(second.gateway.createPayment(params)).rejects.toBeInstanceOf(
          InvalidRequestError,
        );
        expect(second.calls).toHaveLength(0);
      } finally {
        release();
        await pending;
      }
    },
  );
  it.each([
    {
      name: "transport error",
      response: () => {
        throw new Error("secret in transport");
      },
    },
    { name: "malformed response", response: () => new Response("not-hex") },
    { name: "server failure", response: () => new Response("outage", { status: 503 }) },
  ])("keeps an uncertain checkout blocked after $name", async ({ response }) => {
    const { gateway, calls } = setup(response);
    const result = await gateway.createPayment(createParams());
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret in transport");
    await expect(gateway.createPayment(createParams())).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(1);
  });
  it("queries plaintext enquiry without merchant login and rejects checkout IDs", async () => {
    const { gateway, calls } = setup(() => json(tx()));
    expect((await gateway.getPayment({ gatewayPaymentId: "tx-1" })).status).toBe("paid");
    expect(calls[0]?.url).toBe("https://sandbox.hesabe.com/api/transaction/tx-1");
    await expect(
      gateway.getPayment({ gatewayPaymentId: "checkout:session" }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(1);
  });
  it("confirms callbacks through enquiry and rejects changed amounts", async () => {
    const { gateway } = setup(() => json(tx()));
    const callback = (amount: string) =>
      encrypted({
        status: true,
        code: 1,
        response: {
          data: {
            resultCode: "CAPTURED",
            amount,
            paymentToken: "tx-1",
            orderReferenceNumber: "order-1",
          },
        },
      });
    expect((await gateway.resolveCallback({ data: await callback("10.000") })).outcome).toBe(
      "succeeded",
    );
    await expect(
      gateway.resolveCallback({ data: await callback("11.000") }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
  it("verifies webhook facts, rejects forgery, and dual-writes stable events", async () => {
    const { gateway } = setup(() => json(tx()));
    expect(gateway.verifyWebhook(hook())).toBe(false);
    expect(await gateway.verifyWebhookAsync(hook())).toBe(true);
    expect(await gateway.verifyWebhookAsync(hook({ amount: "11.000" }))).toBe(false);
    expect(await gateway.verifyWebhookAsync(hook({ status: "FAILED" }))).toBe(false);
    expect(await gateway.verifyWebhookAsync(hook({ reference_number: "other" }))).toBe(false);
    const event = gateway.parseWebhookEvent(
      hook({ datetime: "2099-01-01", capturedAmount: "9000" }),
    );
    expect(event.event?.type).toBe("payment.succeeded");
    expect(event.amount).toEqual(money("10", "KWD"));
    expect(event.rawPayload).not.toHaveProperty("capturedAmount");
  });
  it("rejects mutation of webhook facts while enquiry is pending", async () => {
    const payload = hook();
    const { gateway } = setup(() => {
      payload.amount = "900.000";
      return json(tx());
    });
    expect(await gateway.verifyWebhookAsync(payload)).toBe(false);
  });
  it("performs lazy auth and encrypted partial refund, then encrypted details lookup", async () => {
    const bodies: Record<string, unknown>[] = [];
    let detailsPayload: Record<string, unknown> | undefined;
    const { gateway, calls } = setup(async (url, init) => {
      if (url.endsWith("/api/transaction/tx-1")) return json(tx());
      if (url.endsWith("/api/v1/login"))
        return json({
          status: true,
          response: {
            token: {
              token_type: "Bearer",
              access_token: "bearer-1",
              refresh_token: "refresh-1",
              expires_in: 900,
            },
          },
        });
      if (init.method === "POST") {
        bodies.push(await decode(init.body));
        return json({
          response: await encrypted({
            status: true,
            response: { id: 1467, token: "tx-1", amount: "2.500", status: 0, refund_at: null },
          }),
        });
      }
      detailsPayload = await decode(
        JSON.stringify({ data: new URL(url).searchParams.get("data") }),
      );
      return json({
        response: await encrypted({
          status: true,
          response: {
            id: 1467,
            token: "tx-1",
            amount: "2.500",
            status: 1,
            refund_at: "2026-09-09",
          },
        }),
      });
    });
    const params = {
      gatewayPaymentId: "tx-1",
      idempotencyKey: "refund-1",
      amount: money("2.5", "KWD"),
      currency: "KWD",
    };
    const result = await gateway.refundPayment(params);
    expect(result.outcome).toBe("pending");
    expect(result.gatewayRefundId).toBe("1467");
    expect(bodies).toEqual([
      { merchantCode: "842217", refundAmount: "2.500", refundMethod: "2", token: "tx-1" },
    ]);
    expect(await gateway.refundPayment(params)).toEqual(result);
    expect((await gateway.getRefund({ gatewayRefundId: "1467" })).outcome).toBe("succeeded");
    const refundCalls = calls.filter((call) => call.url.includes("/api/v1/refund"));
    expect(refundCalls).toHaveLength(2);
    expect(refundCalls.map((call) => new Headers(call.init.headers).get("Authorization"))).toEqual([
      "Bearer bearer-1",
      "Bearer bearer-1",
    ]);
    expect(refundCalls.map((call) => new Headers(call.init.headers).get("accessCode"))).toEqual([
      "test-access",
      "test-access",
    ]);
    expect(
      refundCalls[1]?.url.startsWith(
        "https://merchantapisandbox.hesabe.com/api/v1/refund/1467?data=",
      ),
    ).toBe(true);
    expect(detailsPayload).toEqual({ merchantCode: "842217" });
    expect(calls.filter((x) => x.url.endsWith("/api/v1/login"))).toHaveLength(1);
    expect(calls.filter((x) => x.url.endsWith("/api/v1/refund"))).toHaveLength(1);
  });
  it("does not swallow webhook enquiry outages", async () => {
    const { gateway } = setup(() => new Response("down", { status: 503 }));
    await expect(gateway.verifyWebhookAsync(hook())).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("Hesabe browser checkout initialization", () => {
  it.each(
    browserCheckouts.flatMap((options) => [
      { options, live: false, baseUrl: "https://sandbox.hesabe.com", environment: "sandbox" },
      { options, live: true, baseUrl: "https://api.hesabe.com", environment: "production" },
    ]),
  )(
    "initializes $options.hesabeCheckoutMode in $environment without reporting settlement",
    async ({ options, live, baseUrl, environment }) => {
      let payload: Record<string, unknown> = {};
      const checkoutToken = "session +/&=?";
      const { client, gateway, calls } = setup(
        async (_url, init) => {
          payload = await decode(init.body);
          return new Response(
            await encrypted({ status: true, response: { data: checkoutToken }, private: "hidden" }),
          );
        },
        { live },
      );
      const params = {
        ...createParams(),
        ...options,
        hesabeName: "Aïcha",
        hesabeEmail: "customer@example.com",
        hesabeMobileNumber: "12345678",
        hesabeVariable1: "cart__123",
        hesabeWebhookUrl: "https://shop.example/webhook",
        hesabeFailureUrl: "https://shop.example/failed",
      };
      const result = await client.createPayment(params, "hesabe");
      expect(calls[0]?.url).toBe(`${baseUrl}/checkout`);
      expect(payload).toMatchObject({
        amount: "10.000",
        currency: "KWD",
        orderReferenceNumber: "order-1",
        responseUrl: "https://shop.example/callback",
        failureUrl: "https://shop.example/failed",
        webhookUrl: "https://shop.example/webhook",
        name: "Aïcha",
        email: "customer@example.com",
        mobile_number: "12345678",
        variable1: "cart__123",
      });
      expect(result.outcome).toBe("requires_action");
      expect(result.status).toBe("pending");
      expect(result.capturedAmount).toBeUndefined();
      expect(result.redirectUrl).toBeUndefined();
      expect(result.gatewayId).toBe(`checkout:${checkoutToken}`);
      expect(result.references?.relatedIds?.checkoutToken).toBe(checkoutToken);
      expect(result.amount).toEqual(money("10", "KWD"));
      expect(result.rawResponse).toEqual({ checkoutToken });
      if (options.hesabeCheckoutMode === "embedded") {
        expect(payload).toMatchObject({ paymentType: 0, version: "3.0", embeddedPayment: true });
        expect(isHesabeEmbeddedCheckoutAction(result.nextAction)).toBe(true);
        expect(result.nextAction).toEqual({
          type: "hesabe_embedded_checkout",
          sessionId: checkoutToken,
          environment,
        });
      } else {
        expect(payload).toMatchObject({
          paymentType: 9,
          version: "2.0",
          variable5: "shop.example",
        });
        expect(payload).not.toHaveProperty("embeddedPayment");
        expect(isHesabeApplePayAction(result.nextAction)).toBe(true);
        expect(result.nextAction).toEqual({
          type: "hesabe_apple_pay",
          checkoutToken,
          environment,
          scriptUrl: `${baseUrl}/applepay?data=session%20%2B%2F%26%3D%3F`,
        });
      }
      expect(await gateway.createPayment(params)).toEqual(result);
      expect(calls).toHaveLength(1);
    },
  );

  it.each([9, 10, 11, 12, 13, 14] as const)(
    "selects Apple Pay type %s and normalizes the merchant domain",
    async (paymentType) => {
      let payload: Record<string, unknown> = {};
      const { gateway } = setup(async (_url, init) => {
        payload = await decode(init.body);
        return new Response(await encrypted({ status: true, response: { data: "session" } }));
      });
      const params: HesabeCreatePaymentParams = {
        ...createParams(),
        hesabeCheckoutMode: "applepay",
        hesabeApplePayDomain: " Shop.Example ",
        hesabeApplePayPaymentType: paymentType,
      };
      const result = await gateway.createPayment(params);
      expect(payload).toMatchObject({ paymentType, variable5: "shop.example" });
      expect(isHesabeApplePayAction(result.nextAction)).toBe(true);
    },
  );

  it.each([
    { name: "unknown mode", fields: { hesabeCheckoutMode: "other" } },
    { name: "null mode", fields: { hesabeCheckoutMode: null } },
    { name: "Apple Pay domain without mode", fields: { hesabeApplePayDomain: "shop.example" } },
    {
      name: "Apple Pay type in embedded mode",
      fields: { hesabeCheckoutMode: "embedded", hesabeApplePayPaymentType: 9 },
    },
    { name: "missing domain", fields: { hesabeCheckoutMode: "applepay" } },
    ...[
      "",
      "https://shop.example",
      "shop.example/path",
      "shop.example:443",
      "user@shop.example",
      "shop.example?x=1",
      "shop.example#fragment",
      "shop..example",
      "-shop.example",
      "shop.example\\path",
      "shop\n.example",
      `${"a".repeat(64)}.example`,
      `${"a.".repeat(125)}test`,
    ].map((domain) => ({
      name: `invalid domain ${domain}`,
      fields: { hesabeCheckoutMode: "applepay", hesabeApplePayDomain: domain },
    })),
    ...[0, 15, "9", null].map((paymentType) => ({
      name: `invalid Apple Pay type ${String(paymentType)}`,
      fields: {
        hesabeCheckoutMode: "applepay",
        hesabeApplePayDomain: "shop.example",
        hesabeApplePayPaymentType: paymentType,
      },
    })),
    {
      name: "reserved variable5",
      fields: {
        hesabeCheckoutMode: "applepay",
        hesabeApplePayDomain: "shop.example",
        hesabeVariable5: "shop.example",
      },
    },
  ])("rejects $name before contacting the provider", async ({ fields }) => {
    const { gateway, calls } = setup(() => {
      throw new Error("unexpected request");
    });
    // JS callers and hook-supplied input do not carry TypeScript's discriminated union.
    const params = { ...createParams(), ...fields } as HesabeCreatePaymentParams;
    await expect(gateway.createPayment(params)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    { from: { hesabeCheckoutMode: "redirect" }, to: { hesabeCheckoutMode: "embedded" } },
    { from: browserCheckouts[0], to: browserCheckouts[1] },
    { from: browserCheckouts[1], to: browserCheckouts[0] },
    {
      from: browserCheckouts[1],
      to: { ...browserCheckouts[1], hesabeApplePayDomain: "other.example" },
    },
    { from: browserCheckouts[1], to: { ...browserCheckouts[1], hesabeApplePayPaymentType: 10 } },
  ] as const)(
    "does not reuse an idempotency key after changing $from to $to",
    async ({ from, to }) => {
      const { gateway, calls } = setup(
        async () => new Response(await encrypted({ status: true, response: { data: "session" } })),
      );
      await gateway.createPayment({ ...createParams(), ...from });
      await expect(gateway.createPayment({ ...createParams(), ...to })).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(calls).toHaveLength(1);
    },
  );

  it.each([...browserCheckouts])(
    "keeps $hesabeCheckoutMode indeterminate after an unusable response",
    async (options) => {
      const { gateway, calls } = setup(
        async () => new Response(await encrypted({ status: true, response: { data: "" } })),
      );
      const params = { ...createParams(), ...options };
      const result = await gateway.createPayment(params);
      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.nextAction).toBeUndefined();
      expect(result.redirectUrl).toBeUndefined();
      await expect(gateway.createPayment(params)).rejects.toBeInstanceOf(InvalidRequestError);
      expect(calls).toHaveLength(1);
    },
  );

  it.each([...browserCheckouts])(
    "retains $hesabeCheckoutMode reservations when the transport times out",
    async (options) => {
      const { gateway, calls } = setup(() => new Promise<Response>(() => {}), { timeoutMs: 10 });
      const params = { ...createParams(), ...options };
      expect((await gateway.createPayment(params)).outcome).toBe("indeterminate");
      await expect(gateway.createPayment(params)).rejects.toBeInstanceOf(InvalidRequestError);
      expect(calls).toHaveLength(1);
    },
  );

  it("builds the action from the post-hook mode and protects it from after-hook mutation", async () => {
    let payload: Record<string, unknown> = {};
    const { gateway, calls } = setup(
      async (_url, init) => {
        payload = await decode(init.body);
        return new Response(await encrypted({ status: true, response: { data: "session" } }));
      },
      {},
      {
        beforeCreatePayment: (ctx) => ({
          proceed: true,
          params: { ...ctx.params, ...browserCheckouts[1] },
        }),
        afterCreatePayment: (_ctx, result) => {
          result.status = "paid";
          result.outcome = "succeeded";
          if (isHesabeApplePayAction(result.nextAction))
            result.nextAction.scriptUrl = "https://other.example/script";
          return { proceed: true, modifiedResult: result };
        },
      },
    );
    const result = await gateway.createPayment(createParams());
    expect(payload).toMatchObject({ paymentType: 9, version: "2.0", variable5: "shop.example" });
    expect(result.outcome).toBe("requires_action");
    expect(result.status).toBe("pending");
    expect(result.nextAction).toMatchObject({
      type: "hesabe_apple_pay",
      scriptUrl: "https://sandbox.hesabe.com/applepay?data=session",
    });
    expect(await gateway.createPayment(createParams())).toEqual(result);
    expect(calls).toHaveLength(1);
  });
});

it("full refunds use original enquiry amount and retain uncertain submissions", async () => {
  let posted: Record<string, unknown> | undefined;
  const { gateway, calls } = setup(async (url, init) => {
    if (url.endsWith("/api/transaction/tx-1")) return json(tx());
    if (url.endsWith("/login"))
      return json({
        status: true,
        response: {
          token: {
            token_type: "Bearer",
            access_token: "bearer",
            refresh_token: "refresh",
            expires_in: 900,
          },
        },
      });
    posted = await decode(init.body);
    throw new Error("connection lost after submit");
  });
  const params = { gatewayPaymentId: "tx-1", idempotencyKey: "full-1" };
  const result = await gateway.refundPayment(params);
  expect(posted).toEqual({
    merchantCode: "842217",
    refundAmount: "10.000",
    refundMethod: "1",
    token: "tx-1",
  });
  expect(result.outcome).toBe("indeterminate");
  expect(result.gatewayRefundId).toBe("unknown");
  await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(InvalidRequestError);
  expect(calls.filter((c) => c.url.endsWith("/api/v1/refund"))).toHaveLength(1);
});

it("refund preflight failures release reservations and never submit funds", async () => {
  let failEnquiry = true;
  const { gateway, calls } = setup(async (url) => {
    if (url.endsWith("/api/transaction/tx-1")) {
      if (failEnquiry) return new Response("down", { status: 503 });
      return json(tx());
    }
    if (url.endsWith("/login"))
      return json({
        status: true,
        response: {
          token: {
            token_type: "Bearer",
            access_token: "bearer",
            refresh_token: "refresh",
            expires_in: 900,
          },
        },
      });
    return json({
      response: await encrypted({
        status: true,
        response: { id: 1468, token: "tx-1", amount: "10.000", status: 0 },
      }),
    });
  });
  const params = { gatewayPaymentId: "tx-1", idempotencyKey: "preflight-1" };
  await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(NetworkError);
  expect(calls.filter((c) => c.url.endsWith("/api/v1/refund"))).toHaveLength(0);
  failEnquiry = false;
  expect((await gateway.refundPayment(params)).outcome).toBe("pending");
});

it("blocks over-refund, non-KWD and missing refund keys before submission", async () => {
  const { gateway, calls } = setup(() => json(tx()));
  await expect(gateway.refundPayment({ gatewayPaymentId: "tx-1" })).rejects.toBeInstanceOf(
    InvalidRequestError,
  );
  await expect(
    gateway.refundPayment({
      gatewayPaymentId: "tx-1",
      idempotencyKey: "r",
      amount: money("11", "KWD"),
    }),
  ).rejects.toBeInstanceOf(InvalidRequestError);
  await expect(
    gateway.refundPayment({ gatewayPaymentId: "tx-1", idempotencyKey: "r", currency: "USD" }),
  ).rejects.toBeInstanceOf(InvalidRequestError);
  expect(calls.every((c) => c.init.method === "GET")).toBe(true);
});

it("holds confirmed webhook snapshots between verify and parse", async () => {
  const { gateway, client } = setup(() => json(tx()));
  const payload = hook();
  expect(await gateway.verifyWebhookAsync(payload)).toBe(true);
  payload.amount = "999.000";
  expect(gateway.parseWebhookEvent(payload).amount).toEqual(money("10", "KWD"));
  const event = await client.handleWebhook("hesabe", JSON.stringify(hook()));
  expect(event.event?.type).toBe("payment.succeeded");
});

it.each([...checkoutModes])(
  "pre-aborted $hesabeCheckoutMode makes no fetch and the same key can be used later",
  async (options) => {
    const { gateway, calls } = setup(
      async () => new Response(await encrypted({ status: true, response: { data: "session" } })),
    );
    const controller = new AbortController();
    controller.abort();
    const params = { ...createParams(), ...options };
    await expect(
      gateway.createPayment({ ...params, signal: controller.signal }),
    ).rejects.toBeInstanceOf(PaymentAbortedError);
    expect(calls).toHaveLength(0);
    expect((await gateway.createPayment(params)).outcome).toBe("requires_action");
  },
);

it("does not cache definitive success when storing its result fails", async () => {
  const store = new InMemoryIdempotencyStore();
  const persist = store.set.bind(store);
  store.set = (key, record) => {
    if (record.status !== "in_progress") throw new Error("database down");
    return persist(key, record);
  };
  const { gateway, calls } = setup(
    async () => new Response(await encrypted({ status: true, response: { data: "session" } })),
    { idempotencyStore: store },
  );
  const result = await gateway.createPayment(createParams());
  expect(result.outcome).toBe("indeterminate");
  expect(result.gatewayId).toBe("checkout:session");
  await expect(gateway.createPayment(createParams())).rejects.toBeInstanceOf(InvalidRequestError);
  expect(calls).toHaveLength(1);
});

it("reports a decrypted provider rejection as an error while retaining its submission fence", async () => {
  const { gateway, calls } = setup(
    async () => new Response(await encrypted({ status: false, message: "rejected" })),
  );
  await expect(gateway.createPayment(createParams())).rejects.toBeInstanceOf(InvalidRequestError);
  await expect(gateway.createPayment(createParams())).rejects.toBeInstanceOf(InvalidRequestError);
  expect(calls).toHaveLength(1);
});

it("retries rate-limited enquiry reads until a successful response", async () => {
  let attempt = 0;
  const { gateway, calls } = setup(() =>
    ++attempt < 3
      ? new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } })
      : json(tx()),
  );
  expect((await gateway.getPayment({ gatewayPaymentId: "tx-1" })).status).toBe("paid");
  expect(calls).toHaveLength(3);
  expect(calls.every((c) => c.init.method === "GET")).toBe(true);
});

it("cancels a rate-limit wait without another enquiry request", async () => {
  const controller = new AbortController();
  const { gateway, calls } = setup(
    () => new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }),
  );
  const pending = gateway.getPayment({ gatewayPaymentId: "tx-1", signal: controller.signal });
  const cancel = setTimeout(() => controller.abort(), 20);
  try {
    await expect(pending).rejects.toBeInstanceOf(PaymentAbortedError);
    expect(calls).toHaveLength(1);
  } finally {
    clearTimeout(cancel);
  }
}, 500);

it("leaves refund retryable when enquiry cannot establish the original payment state", async () => {
  const { gateway, calls } = setup(() => json(tx({ status: "UNKNOWN_NEW_STATUS" })));
  const params = { gatewayPaymentId: "tx-1", idempotencyKey: "uncertain-payment-refund" };
  await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(NetworkError);
  await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(NetworkError);
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.init.method === "GET")).toBe(true);
});
