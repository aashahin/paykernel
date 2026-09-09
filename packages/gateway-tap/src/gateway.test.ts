import { describe, expect, it } from "bun:test";
import {
  HooksManager,
  InvalidRequestError,
  isIndeterminateOutcome,
  isPaidOutcome,
  money,
  NetworkError,
} from "@paykernel/core";
import { TapGateway } from "./gateway";
import {
  authorizedObject,
  capturedCharge,
  declinedCharge,
  initiatedCharge,
  refundedObject,
  TAP_TEST_SECRET,
} from "./fixtures/charges";
import { computeTapHashstring, hashFieldsFromTapObject } from "./webhooks";

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function emptyResponse(status = 200): Response {
  return new Response("", { status });
}

function queued(response: Response, copies: number): Response[] {
  return Array.from({ length: copies }, () => response.clone());
}

function createGateway(
  queue: Response[],
  calls: FetchCall[],
  config: { merchantId?: string; autoVoidHours?: number } = {},
): TapGateway {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected Tap fetch: ${String(input)}`);
    return next;
  }) as typeof fetch;
  return new TapGateway(
    {
      secretKey: TAP_TEST_SECRET,
      webhookUrl: "https://merchant.example/post",
      ...config,
    },
    new HooksManager({}),
    undefined,
    { fetch: fetchImpl, randomUUID: () => "minted-idem-key" },
  );
}

const createParams = {
  amount: money("10.50", "SAR"),
  currency: "SAR",
  callbackUrl: "https://merchant.example/callback",
  tapCustomer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  idempotencyKey: "idem-create-1",
} as const;

describe("TapGateway.createPayment", () => {
  it("posts a charge with ISO major amount, customer, src_all, and idempotent reference", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(capturedCharge())], calls);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.status).toBe("paid");
    expect(result.outcome).toBe("succeeded");
    expect(result.gatewayId).toBe("chg_testInitiated01");
    expect(calls[0]?.url).toContain("/charges");
    const rawBody = String(calls[0]?.init?.body);
    expect(rawBody).toContain('"amount":10.50');
    expect(rawBody).not.toContain('"amount":"10.50"');
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body.amount).toBe(10.5);
    expect(body.currency).toBe("SAR");
    expect(body.source).toEqual({ id: "src_all" });
    expect(body.customer).toMatchObject({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
    });
    expect(body.redirect).toEqual({ url: "https://merchant.example/callback" });
    expect(body.save_card).toBe(false);
    expect((body.reference as { idempotent: string }).idempotent).toBe(
      "idem-create-1",
    );
    expect(body.post).toEqual({ url: "https://merchant.example/post" });
    expect(String(calls[0]?.init?.headers?.Authorization ?? "")).toMatch(
      /^Bearer sk_test_/,
    );
  });

  it("maps INITIATED + transaction.url to requires_action", async () => {
    const gateway = createGateway([jsonResponse(initiatedCharge())], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("requires_action");
    expect(result.status).toBe("pending");
    expect(result.redirectUrl).toContain("checkout.payments.tap.company");
    expect(isPaidOutcome(result)).toBe(false);
  });

  it("does not treat merchant redirect.url as checkout redirect on CAPTURED charges", async () => {
    const gateway = createGateway([jsonResponse(capturedCharge())], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.redirectUrl).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it("does not treat leftover transaction.url as nextAction on CAPTURED charges", async () => {
    const gateway = createGateway(
      [
        jsonResponse(
          capturedCharge({
            transaction: {
              created: "1000000000",
              url: "https://checkout.payments.tap.company/receipt",
            },
          }),
        ),
      ],
      [],
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.redirectUrl).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it("does not treat merchant redirect.url as checkout redirect on AUTHORIZED authorize", async () => {
    const gateway = createGateway(
      [
        jsonResponse(
          authorizedObject({
            redirect: { url: "https://merchant.example/callback" },
          }),
        ),
      ],
      [],
    );
    const result = await gateway.createPayment({
      ...createParams,
      capture: false,
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("authorized");
    expect(result.redirectUrl).toBeUndefined();
  });

  it("posts /authorize when capture is false", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(authorizedObject())], calls);
    const result = await gateway.createPayment({ ...createParams, capture: false });
    expect(calls[0]?.url).toContain("/authorize");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      source: { id: string };
      auto?: unknown;
    };
    expect(body.source.id).toBe("src_card");
    expect(body.auto).toBeUndefined();
    expect(result.status).toBe("authorized");
    expect(result.outcome).toBe("succeeded");
    expect(isPaidOutcome(result)).toBe(false);
  });

  it("sends auto VOID hours on authorize when autoVoidHours is set", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(authorizedObject())], calls, {
      autoVoidHours: 24,
    });
    await gateway.createPayment({
      ...createParams,
      capture: false,
      tapSource: { id: "tok_testToken01" },
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      auto?: { type: string; time: number };
    };
    expect(body.auto).toEqual({ type: "VOID", time: 24 });
  });

  it("rejects autoVoidHours on authorize when source is omitted (src_card)", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls, { autoVoidHours: 24 });
    await expect(
      gateway.createPayment({ ...createParams, capture: false }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it("does not send auto on charges even when autoVoidHours is set", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(capturedCharge())], calls, {
      autoVoidHours: 24,
    });
    await gateway.createPayment({ ...createParams });
    const body = JSON.parse(String(calls[0]?.init?.body)) as { auto?: unknown };
    expect(body.auto).toBeUndefined();
  });

  it("rejects auth_ tapSource on createPayment and does not fetch", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    try {
      await gateway.createPayment({
        ...createParams,
        tapSource: { id: "auth_testAuthorize01" },
      });
      expect.unreachable("createPayment must reject auth_ sources");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as Error).message).toMatch(/capturePayment/);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects zero create amounts before fetch", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(
      gateway.createPayment({
        ...createParams,
        amount: money(0, "SAR", { allowZero: true }),
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it("maps DECLINED to declined outcome", async () => {
    const gateway = createGateway([jsonResponse(declinedCharge())], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("declined");
    expect(isPaidOutcome(result)).toBe(false);
    expect(result.decline).toEqual({
      code: "505",
      message: "Declined, Insufficient Funds",
      providerCode: "505",
    });
  });

  it.each(["505", 505] as const)(
    "maps FAILED + response.code %s to declined with decline extras",
    async (code) => {
      const gateway = createGateway(
        [
          jsonResponse(
            initiatedCharge({
              status: "FAILED",
              response: { code, message: "Declined, Insufficient Funds" },
              transaction: { created: "1000000000" },
            }),
          ),
        ],
        [],
      );
      const result = await gateway.createPayment({ ...createParams });
      expect(result.outcome).toBe("declined");
      expect(result.status).toBe("failed");
      expect(isPaidOutcome(result)).toBe(false);
      expect(result.decline).toEqual({
        code: "505",
        message: "Declined, Insufficient Funds",
        providerCode: "505",
      });
    },
  );

  it("maps FAILED without a 501–516 response.code as failed with no decline extras", async () => {
    const gateway = createGateway(
      [
        jsonResponse(
          initiatedCharge({
            status: "FAILED",
            response: { code: "999", message: "Failed" },
            transaction: { created: "1000000000" },
          }),
        ),
      ],
      [],
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("failed");
    expect(result.status).toBe("failed");
    expect(result.decline).toBeUndefined();
  });

  it.each([
    [
      "lastName",
      { firstName: "Ada", lastName: "  ", email: "ada@example.com" },
    ],
    [
      "firstName",
      { firstName: "  ", lastName: "Lovelace", email: "ada@example.com" },
    ],
    [
      "email",
      { firstName: "Ada", lastName: "Lovelace", email: "  " },
    ],
  ] as const)(
    "rejects inline customer with blank %s",
    async (_field, tapCustomer) => {
      const gateway = createGateway([], []);
      await expect(
        gateway.createPayment({
          amount: 10,
          currency: "SAR",
          callbackUrl: "https://merchant.example/callback",
          tapCustomer,
          idempotencyKey: "idem-create-blank-customer",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    },
  );

  it("trims createPayment idempotencyKey on reference.idempotent", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(capturedCharge())], calls);
    await gateway.createPayment({
      ...createParams,
      idempotencyKey: "  idem-create-1  ",
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      reference: { idempotent: string };
    };
    expect(body.reference.idempotent).toBe("idem-create-1");
  });

  it("requires customer and callbackUrl", async () => {
    const gateway = createGateway([], []);
    await expect(
      gateway.createPayment({
        amount: 10,
        currency: "SAR",
        callbackUrl: "https://merchant.example/callback",
        idempotencyKey: "idem-create-customer",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      gateway.createPayment({
        amount: 10,
        currency: "SAR",
        callbackUrl: "",
        tapCustomer: { id: "cus_testCustomer01" },
        idempotencyKey: "idem-create-callback",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("requires idempotencyKey when the caller omits one", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    const { idempotencyKey: _omit, ...rest } = createParams;
    await expect(gateway.createPayment({ ...rest })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(calls).toHaveLength(0);
  });

});

describe("TapGateway mutations", () => {
  it("requires idempotencyKey on capture / void / refund", async () => {
    const gateway = createGateway([], []);
    await expect(
      gateway.capturePayment({ gatewayPaymentId: "auth_testAuthorize01" }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      gateway.voidPayment({ gatewayPaymentId: "auth_testAuthorize01" }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      gateway.refundPayment({ gatewayPaymentId: "chg_testInitiated01" }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("captures an authorize via POST /charges with source.id = auth id", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject()), jsonResponse(capturedCharge())],
      calls,
      { merchantId: "merchant_test01" },
    );
    const result = await gateway.capturePayment({
      gatewayPaymentId: "auth_testAuthorize01",
      amount: money("10.50", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-cap-1",
    });
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls[1]?.url).toContain("/charges");
    const body = JSON.parse(String(calls[1]?.init?.body)) as {
      source: { id: string };
      amount: number;
      threeDSecure?: boolean;
      customer_initiated?: boolean;
      save_card?: boolean;
      redirect?: { url?: string };
      post?: { url?: string };
      merchant?: { id?: string };
    };
    expect(body.source.id).toBe("auth_testAuthorize01");
    expect(body.amount).toBe(10.5);
    expect(body.threeDSecure).toBe(true);
    expect(body.customer_initiated).toBe(true);
    expect(body.save_card).toBe(false);
    expect(body.redirect?.url).toBe("https://merchant.example/callback");
    expect(body.post?.url).toBe("https://merchant.example/post");
    expect(body.merchant?.id).toBe("merchant_test01");
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("paid");
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.authorizationId).toBe("auth_testAuthorize01");
    expect(result.gatewayId).toBe("chg_testInitiated01");
    expect(result.references?.relatedIds?.authorizationId).toBe(
      "auth_testAuthorize01",
    );
  });

  it("maps a partial capture as partially_captured not paid", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject()), jsonResponse(capturedCharge({ amount: 4 }))],
      calls,
    );
    const result = await gateway.capturePayment({
      gatewayPaymentId: "auth_testAuthorize01",
      amount: money("4", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-cap-partial",
    });
    expect(calls[1]?.url).toContain("/charges");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(result.status).toBe("partially_captured");
    expect(isPaidOutcome(result)).toBe(false);
    expect(result.gatewayId).toBe("chg_testInitiated01");
  });

  it("preserves decline detail on partial-amount declined capture", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject()), jsonResponse(declinedCharge({ amount: 5 }))],
      calls,
    );
    const result = await gateway.capturePayment({
      gatewayPaymentId: "auth_testAuthorize01",
      amount: money("5", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-cap-declined-partial",
    });
    expect(calls[1]?.url).toContain("/charges");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(result.status).toBe("failed");
    expect(result.status).not.toBe("partially_captured");
    expect(result.outcome).toBe("declined");
    expect(isPaidOutcome(result)).toBe(false);
    expect(result.decline).toEqual({
      code: "505",
      message: "Declined, Insufficient Funds",
      providerCode: "505",
    });
    expect(result.gatewayId).toBe("chg_testInitiated01");
  });

  it("rejects capture when the amount exceeds the authorized amount", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(authorizedObject())], calls);
    await expect(
      gateway.capturePayment({
        gatewayPaymentId: "auth_testAuthorize01",
        amount: money("20", "SAR"),
        currency: "SAR",
        idempotencyKey: "idem-cap-over",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
  });

  it("prefers tapRedirectUrl over authorize.redirect.url on capture", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject()), jsonResponse(capturedCharge())],
      calls,
    );
    await gateway.capturePayment({
      gatewayPaymentId: "auth_testAuthorize01",
      amount: money("10.50", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-cap-redirect",
      tapRedirectUrl: "https://merchant.example/capture-return",
    });
    const body = JSON.parse(String(calls[1]?.init?.body)) as {
      redirect?: { url?: string };
    };
    expect(body.redirect?.url).toBe("https://merchant.example/capture-return");
  });

  it("rejects capture when authorize has no redirect.url and tapRedirectUrl is omitted", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ redirect: {} }))],
      calls,
    );
    await expect(
      gateway.capturePayment({
        gatewayPaymentId: "auth_testAuthorize01",
        idempotencyKey: "idem-cap-noredirect",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
  });

  it.each(["tapThreeDSecure", "tapCustomerInitiated"] as const)(
    "rejects capture when %s is false",
    async (flag) => {
      const calls: FetchCall[] = [];
      const gateway = createGateway([jsonResponse(authorizedObject())], calls);
      await expect(
        gateway.capturePayment({
          gatewayPaymentId: "auth_testAuthorize01",
          idempotencyKey: `idem-cap-${flag}`,
          [flag]: false,
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
      expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
    },
  );

  it("rejects capture when the authorize status is VOID", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: "VOID" }))],
      calls,
    );
    try {
      await gateway.capturePayment({
        gatewayPaymentId: "auth_testAuthorize01",
        idempotencyKey: "idem-cap-void",
      });
      expect.unreachable("capture of VOID authorize must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as Error).message).toMatch(/authorize status/i);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
  });

  it("maps GET CAPTURED authorize as paid without POST /charges", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: "CAPTURED" }))],
      calls,
    );
    const result = await gateway.capturePayment({
      gatewayPaymentId: "auth_testAuthorize01",
      amount: money("10.50", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-cap-replay",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("paid");
    expect(result.authorizationId).toBe("auth_testAuthorize01");
  });

  it("GETs the nested charge when CAPTURED authorize includes charge_id", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          authorizedObject({
            status: "CAPTURED",
            charge_id: "chg_testInitiated01",
          }),
        ),
        jsonResponse(capturedCharge()),
      ],
      calls,
    );
    const result = await gateway.capturePayment({
      gatewayPaymentId: "auth_testAuthorize01",
      idempotencyKey: "idem-cap-captured-chg",
    });
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls[1]?.url).toContain("/charges/chg_testInitiated01");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(
      calls.some(
        (call) =>
          call.url.includes("/charges") && call.init?.method === "POST",
      ),
    ).toBe(false);
    expect(result.status).toBe("paid");
    expect(result.gatewayId).toBe("chg_testInitiated01");
    expect(result.authorizationId).toBe("auth_testAuthorize01");
  });

  it("rejects capture when caller currency does not match authorize currency", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(authorizedObject())], calls);
    await expect(
      gateway.capturePayment({
        gatewayPaymentId: "auth_testAuthorize01",
        amount: money("10.50", "USD"),
        currency: "USD",
        idempotencyKey: "idem-cap-ccy",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
  });

  it("rejects capture when the authorize status is INITIATED", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: "INITIATED" }))],
      calls,
    );
    try {
      await gateway.capturePayment({
        gatewayPaymentId: "auth_testAuthorize01",
        idempotencyKey: "idem-cap-initiated",
      });
      expect.unreachable("capture of INITIATED authorize must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as Error).message).toMatch(/authorize status/i);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
  });

  it("rejects capture when the authorize object omits status", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: undefined }))],
      calls,
    );
    await expect(
      gateway.capturePayment({
        gatewayPaymentId: "auth_testAuthorize01",
        idempotencyKey: "idem-cap-nostatus",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("/charges"))).toBe(false);
  });

  it("voids an authorize", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(authorizedObject()),
        jsonResponse(authorizedObject({ status: "VOID" })),
      ],
      calls,
    );
    const result = await gateway.voidPayment({
      gatewayPaymentId: "auth_testAuthorize01",
      idempotencyKey: "idem-void-1",
    });
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[1]?.url).toContain("/authorize/auth_testAuthorize01/void");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(result.status).toBe("cancelled");
    expect(result.outcome).toBe("succeeded");
  });

  it("returns an already-VOID authorize without posting void", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: "VOID" }))],
      calls,
    );
    const result = await gateway.voidPayment({
      gatewayPaymentId: "auth_testAuthorize01",
      idempotencyKey: "idem-void-replay",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls.some((call) => call.url.includes("/void"))).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(result.outcome).toBe("succeeded");
  });

  it("rejects void when the authorize status is INITIATED", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: "INITIATED" }))],
      calls,
    );
    await expect(
      gateway.voidPayment({
        gatewayPaymentId: "auth_testAuthorize01",
        idempotencyKey: "idem-void-initiated",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/void"))).toBe(false);
  });

  it("posts remaining amount when refund amount is omitted", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(capturedCharge({ amount: 10.5, amount_refunded: 4 })),
        jsonResponse(refundedObject({ amount: 6.5 })),
      ],
      calls,
    );
    await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      idempotencyKey: "idem-ref-remaining",
    });
    expect(calls[1]?.url).toContain("/refunds");
    const body = JSON.parse(String(calls[1]?.init?.body)) as { amount: number };
    expect(body.amount).toBe(6.5);
  });

  it("rejects refund when the charge status is already REFUNDED", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge({ status: "REFUNDED" }))],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        idempotencyKey: "idem-ref-refunded",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("rejects a caller amount refund when the charge is already REFUNDED", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge({ status: "REFUNDED" }))],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        amount: money("10.50", "SAR"),
        currency: "SAR",
        idempotencyKey: "idem-ref-refunded-amount",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("maps an embedded refund on an already-REFUNDED charge without posting", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          capturedCharge({
            status: "REFUNDED",
            refunds: [refundedObject()],
          }),
        ),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      idempotencyKey: "idem-ref-nested",
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("completed");
    expect(result.gatewayRefundId).toBe("re_testRefund01");
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("maps the nested refund whose reference.idempotent matches", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          capturedCharge({
            status: "REFUNDED",
            refunds: [
              refundedObject({
                id: "re_other",
                reference: { idempotent: "idem-other" },
              }),
              refundedObject({
                id: "re_match",
                reference: { idempotent: "idem-ref-match" },
              }),
            ],
          }),
        ),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      idempotencyKey: "idem-ref-match",
    });
    expect(result.gatewayRefundId).toBe("re_match");
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("rejects unmatched nested refunds on an already-REFUNDED charge without posting", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          capturedCharge({
            status: "REFUNDED",
            refunds: [
              refundedObject({ id: "re_one" }),
              refundedObject({ id: "re_two" }),
            ],
          }),
        ),
      ],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        idempotencyKey: "idem-ref-multi",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("GETs a nested refund id on an already-REFUNDED charge", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          capturedCharge({
            status: "REFUNDED",
            refunds: { data: [{ id: "re_testRefund01" }] },
          }),
        ),
        jsonResponse(refundedObject()),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      idempotencyKey: "idem-ref-get-nested",
    });
    expect(calls[1]?.url).toContain("/refunds/re_testRefund01");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("completed");
  });

  it("throws when omitted refund amount and remaining is 0 without posting", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge({ amount: 10.5, amount_refunded: 10.5 }))],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        idempotencyKey: "idem-ref-remaining-zero",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("throws when remaining is 0 even if the caller passes amount", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge({ amount: 10.5, amount_refunded: 10.5 }))],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        amount: money("10.50", "SAR"),
        currency: "SAR",
        idempotencyKey: "idem-ref-remaining-zero-explicit",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("maps a nested refund when remaining is 0 without posting", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          capturedCharge({
            amount: 10.5,
            amount_refunded: 10.5,
            refunds: [refundedObject()],
          }),
        ),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      idempotencyKey: "idem-ref-remaining-zero-nested",
    });
    expect(result.gatewayRefundId).toBe("re_testRefund01");
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("rejects omitted refund amount when remaining is not exposed", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(capturedCharge())], calls);
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        idempotencyKey: "idem-ref-no-remaining",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("rejects http tapPostUrl before fetch", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(
      gateway.createPayment({
        ...createParams,
        tapPostUrl: "http://merchant.example/post",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it("rejects omitted refund amount when refunds list has no parseable amounts", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge({ refunds: [{ id: "re_testRefund01" }] }))],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        idempotencyKey: "idem-ref-opaque-refunds",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("rejects refund when caller currency does not match charge currency", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(capturedCharge())], calls);
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        amount: money("10.50", "USD"),
        currency: "USD",
        idempotencyKey: "idem-ref-ccy",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls.some((call) => call.url.includes("/refunds"))).toBe(false);
  });

  it("refunds a charge", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge()), jsonResponse(refundedObject())],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      amount: money("10.50", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-ref-1",
    });
    expect(calls[1]?.url).toContain("/refunds");
    const body = JSON.parse(String(calls[1]?.init?.body)) as {
      charge_id: string;
      reason: string;
      post?: { url?: string };
    };
    expect(body.charge_id).toBe("chg_testInitiated01");
    expect(body.reason).toBe("requested_by_customer");
    expect(body.post?.url).toBe("https://merchant.example/post");
    expect(result.status).toBe("completed");
    expect(result.outcome).toBe("succeeded");
    expect(result.totalRefunded).toBeUndefined();
  });

  it("sends a free-text refund reason instead of requested_by_customer", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge()), jsonResponse(refundedObject())],
      calls,
    );
    await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      amount: money("10.50", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-ref-stock",
      reason: "The product is out of stock",
    });
    const body = JSON.parse(String(calls[1]?.init?.body)) as { reason: string };
    expect(body.reason).toBe("The product is out of stock");
  });

  it("maps known refund reasons case-insensitively with spaces to underscore", async () => {
    for (const [reason, expected] of [
      ["duplicate", "duplicate"],
      ["Fraudulent", "fraudulent"],
      ["requested by customer", "requested_by_customer"],
    ] as const) {
      const calls: FetchCall[] = [];
      const gateway = createGateway(
        [jsonResponse(capturedCharge()), jsonResponse(refundedObject())],
        calls,
      );
      await gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        amount: money("10.50", "SAR"),
        currency: "SAR",
        idempotencyKey: `idem-ref-${expected}`,
        reason,
      });
      const body = JSON.parse(String(calls[1]?.init?.body)) as { reason: string };
      expect(body.reason).toBe(expected);
    }
  });

  it("rejects refund reasons longer than 249 characters", async () => {
    const gateway = createGateway([jsonResponse(capturedCharge())], []);
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "chg_testInitiated01",
        amount: money("10.50", "SAR"),
        currency: "SAR",
        idempotencyKey: "idem-ref-long",
        reason: "x".repeat(250),
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("does not retry void after a mutating 5xx", async () => {
    const calls: FetchCall[] = [];
    const boom = { errors: [{ code: "9999", description: "boom" }] };
    const gateway = createGateway(
      [jsonResponse(authorizedObject()), jsonResponse(boom, 500)],
      calls,
    );
    const result = await gateway.voidPayment({
      gatewayPaymentId: "auth_testAuthorize01",
      idempotencyKey: "idem-void-500",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(
      calls.filter(
        (call) =>
          call.url.includes("/void") && call.init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("rejects capture of a charge id and refund of an authorize id", async () => {
    const gateway = createGateway([], []);
    await expect(
      gateway.capturePayment({
        gatewayPaymentId: "chg_testInitiated01",
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "auth_testAuthorize01",
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe("TapGateway.getPayment and errors", () => {
  it("dispatches chg_ vs auth_ and rejects unknown prefixes", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(capturedCharge()), jsonResponse(authorizedObject())],
      calls,
    );
    await gateway.getPayment({ gatewayPaymentId: "chg_testInitiated01" });
    expect(calls[0]?.url).toContain("/charges/chg_testInitiated01");
    const auth = await gateway.getPayment({
      gatewayPaymentId: "auth_testAuthorize01",
    });
    expect(calls[1]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(auth.status).toBe("authorized");
    await expect(
      gateway.getPayment({ gatewayPaymentId: "pay_other" }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("maps getPayment of a REFUNDED charge to refunded, not failed", async () => {
    const gateway = createGateway(
      [jsonResponse(capturedCharge({ status: "REFUNDED" }))],
      [],
    );
    const result = await gateway.getPayment({
      gatewayPaymentId: "chg_testInitiated01",
    });
    expect(result.status).toBe("refunded");
    expect(result.outcome).toBe("succeeded");
    expect(isPaidOutcome(result)).toBe(false);
  });

  it("GETs the nested charge on getPayment of CAPTURED authorize with charge_id", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          authorizedObject({
            status: "CAPTURED",
            charge_id: "chg_testInitiated01",
          }),
        ),
        jsonResponse(capturedCharge()),
      ],
      calls,
    );
    const result = await gateway.getPayment({
      gatewayPaymentId: "auth_testAuthorize01",
    });
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls[1]?.url).toContain("/charges/chg_testInitiated01");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(
      calls.some(
        (call) =>
          call.url.includes("/charges") && call.init?.method === "POST",
      ),
    ).toBe(false);
    expect(result.status).toBe("paid");
    expect(result.gatewayId).toBe("chg_testInitiated01");
    expect(result.authorizationId).toBe("auth_testAuthorize01");
  });

  it("maps getPayment of CAPTURED authorize without charge_id as paid", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: "CAPTURED" }))],
      calls,
    );
    const result = await gateway.getPayment({
      gatewayPaymentId: "auth_testAuthorize01",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/authorize/auth_testAuthorize01");
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    expect(result.status).toBe("paid");
    expect(result.outcome).toBe("succeeded");
    expect(result.authorizationId).toBe("auth_testAuthorize01");
    expect(result.gatewayId).toBe("auth_testAuthorize01");
    expect(result.amount).toBeUndefined();
  });

  it("maps getPayment of a VOID authorize to succeeded cancelled", async () => {
    const gateway = createGateway(
      [jsonResponse(authorizedObject({ status: "VOID" }))],
      [],
    );
    const result = await gateway.getPayment({
      gatewayPaymentId: "auth_testAuthorize01",
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("cancelled");
  });

  it("maps getPayment of a VOID charge to failed cancelled", async () => {
    const result = await createGateway(
      [jsonResponse(capturedCharge({ status: "VOID" }))],
      [],
    ).getPayment({ gatewayPaymentId: "chg_testInitiated01" });
    expect(result.outcome).toBe("failed");
    expect(result.status).toBe("cancelled");
    expect(isPaidOutcome(result)).toBe(false);
  });

  it("maps ABANDONED createPayment and getPayment to failed", async () => {
    const createCalls: FetchCall[] = [];
    const created = await createGateway(
      [jsonResponse(authorizedObject({ status: "ABANDONED" }))],
      createCalls,
    ).createPayment({ ...createParams, capture: false });
    expect(created.outcome).toBe("failed");
    expect(created.status).toBe("cancelled");

    const got = await createGateway(
      [jsonResponse(authorizedObject({ status: "ABANDONED" }))],
      [],
    ).getPayment({ gatewayPaymentId: "auth_testAuthorize01" });
    expect(got.outcome).toBe("failed");
    expect(got.status).toBe("cancelled");
  });

  it("does not retry a mutating POST aborted by the caller", async () => {
    const calls: FetchCall[] = [];
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    const gateway = new TapGateway(
      {
        secretKey: TAP_TEST_SECRET,
        webhookUrl: "https://merchant.example/post",
      },
      new HooksManager({}),
      undefined,
      { fetch: fetchImpl, randomUUID: () => "minted-idem-key" },
    );
    try {
      const result = await gateway.createPayment({
        ...createParams,
        signal: controller.signal,
      });
      expect(isIndeterminateOutcome(result)).toBe(true);
    } catch {
      // thrown is acceptable; caller abort must not be retried
    }
    expect(calls).toHaveLength(1);
  });

  it("maps post-submit 5xx on create to indeterminate", async () => {
    const boom = { errors: [{ code: "9999", description: "boom" }] };
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(boom, 500), jsonResponse(boom, 500), jsonResponse(boom, 500)],
      calls,
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(result.reconciliationRequired).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("maps empty mutating 2xx to indeterminate, not InvalidRequestError", async () => {
    const gateway = createGateway(queued(emptyResponse(), 3), []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(result.reconciliationRequired).toBe(true);
  });

  it("maps mutating HTML 5xx to indeterminate after retries", async () => {
    const gateway = createGateway(
      queued(textResponse("<html>upstream</html>", 500), 3),
      [],
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(result.reconciliationRequired).toBe(true);
  });

  it("GET empty 2xx is a thrown NetworkError, not afterProviderSubmit", async () => {
    const gateway = createGateway(queued(emptyResponse(), 3), []);
    try {
      await gateway.getPayment({ gatewayPaymentId: "chg_testInitiated01" });
      expect.unreachable("empty GET body must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).afterProviderSubmit).not.toBe(true);
    }
  });

  it("maps mutating 2xx charge without status to indeterminate", async () => {
    const gateway = createGateway(
      queued(jsonResponse({ id: "chg_testInitiated01", object: "charge" }), 3),
      [],
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(result.reconciliationRequired).toBe(true);
  });

  it("maps mutating 2xx refund without status to indeterminate", async () => {
    const gateway = createGateway(
      [
        jsonResponse(capturedCharge()),
        ...queued(jsonResponse({ id: "re_testRefund01", object: "refund" }), 3),
      ],
      [],
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "chg_testInitiated01",
      amount: money("10.50", "SAR"),
      currency: "SAR",
      idempotencyKey: "idem-ref-nostatus",
    });
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
  });

  it("GET charge without status throws InvalidRequestError without retry", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse({ id: "chg_testInitiated01", object: "charge" })],
      calls,
    );
    await expect(
      gateway.getPayment({ gatewayPaymentId: "chg_testInitiated01" }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(1);
  });

  it("maps 401 to AuthenticationError via getPayment (GET throws)", async () => {
    const gateway = createGateway(
      [jsonResponse({ errors: [{ code: "2104", description: "bad key" }] }, 401)],
      [],
    );
    await expect(
      gateway.getPayment({ gatewayPaymentId: "chg_testInitiated01" }),
    ).rejects.toMatchObject({ name: "AuthenticationError" });
  });
});

describe("TapGateway webhooks", () => {
  it("verifies hashstring and dual-writes a paid event", () => {
    const gateway = createGateway([], []);
    const payload = capturedCharge({ amount: 10.5 });
    const signature = computeTapHashstring(
      hashFieldsFromTapObject(payload),
      TAP_TEST_SECRET,
    );
    expect(gateway.verifyWebhook(payload, signature)).toBe(true);
    expect(gateway.verifyWebhook(payload)).toBe(false);
    const event = gateway.parseWebhookEvent(payload);
    expect(event.gateway).toBe("tap");
    expect(event.status).toBe("paid");
    expect(event.stableType).toBe("payment.succeeded");
    expect(event.payloadHash).toBeDefined();
    expect(event.timestamp.toISOString()).toBe(
      new Date(1_000_000_000 * 1000).toISOString(),
    );
  });

  it("parses 13-digit created values as milliseconds", () => {
    const gateway = createGateway([], []);
    const createdMs = 1_698_392_719_404;
    const event = gateway.parseWebhookEvent(
      capturedCharge({ transaction: { created: createdMs } }),
    );
    expect(event.timestamp.toISOString()).toBe(new Date(createdMs).toISOString());
  });

  it("rejects webhook payloads without a created timestamp", () => {
    const gateway = createGateway([], []);
    expect(() =>
      gateway.parseWebhookEvent(
        capturedCharge({ transaction: { url: "https://checkout.example" } }),
      ),
    ).toThrow(InvalidRequestError);
  });

  it("does not treat charge source.id auth_ as gatewayPaymentId", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent(
      capturedCharge({
        source: { object: "authorize", id: "auth_testAuthorize01" },
      }),
    );
    expect(event.gatewayPaymentId).toBe("chg_testInitiated01");
    expect(event.gatewayPaymentId).not.toMatch(/^auth_/);
    const payment =
      event.event !== undefined && "payment" in event.event
        ? event.event.payment
        : undefined;
    expect(payment?.references.relatedIds?.authorizationId).toBe(
      "auth_testAuthorize01",
    );
  });

  it("parses authorize and refund webhooks", () => {
    const gateway = createGateway([], []);
    const auth = gateway.parseWebhookEvent(authorizedObject());
    expect(auth.status).toBe("authorized");
    expect(auth.id).toMatch(/^auth_testAuthorize01:[0-9a-f]{64}$/);
    expect(auth.gatewayPaymentId).toBe("auth_testAuthorize01");
    const refund = gateway.parseWebhookEvent(refundedObject());
    expect(refund.status).toBe("refunded");
    expect(refund.id).toMatch(/^re_testRefund01:[0-9a-f]{64}$/);
    expect(refund.gatewayPaymentId).toBe("chg_testCaptured01");
  });

  it("maps a charge object with status REFUNDED to refunded, not failed", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent(
      capturedCharge({ status: "REFUNDED" }),
    );
    expect(event.status).toBe("refunded");
    expect(event.stableType).toBe("refund.completed");
    expect(event.gatewayPaymentId).toBe("chg_testInitiated01");
  });

  it("rejects invoice objects missing created timestamp", () => {
    const gateway = createGateway([], []);
    expect(() =>
      gateway.parseWebhookEvent({ object: "invoice", id: "inv_1", status: "PAID" }),
    ).toThrow(InvalidRequestError);
  });

  it("rejects invoice objects missing id", () => {
    const gateway = createGateway([], []);
    expect(() =>
      gateway.parseWebhookEvent({
        object: "invoice",
        status: "PAID",
        created: "1000000000",
      }),
    ).toThrow(InvalidRequestError);
  });

  it("parses invoice webhook objects as native unmapped processing", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent({
      object: "invoice",
      id: "inv_1",
      status: "PAID",
      created: "1000000000",
      updated: "1000000001",
      amount: 10.5,
      currency: "SAR",
    });
    expect(event.gateway).toBe("tap");
    expect(event.id).toMatch(/^inv_1:[0-9a-f]{64}$/);
    expect(event.type).toBe("invoice.PAID");
    expect(event.status).not.toBe("paid");
    expect(event.status).toBe("processing");
    expect(event.gatewayPaymentId).toBe("inv_1");
    expect(event.stableType).toBeUndefined();
    expect(event.provider?.eventType).toBe("invoice.PAID");
    expect(event.event?.type).toBe("provider.unmapped");
    const payment =
      event.event !== undefined && "payment" in event.event
        ? event.event.payment
        : undefined;
    expect(payment?.status).not.toBe("paid");
  });

  it("attaches charge_id on CAPTURED authorize webhook relatedIds", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent(
      authorizedObject({
        status: "CAPTURED",
        charge_id: "chg_testInitiated01",
      }),
    );
    expect(event.id).toMatch(/^auth_testAuthorize01:[0-9a-f]{64}$/);
    expect(event.gatewayPaymentId).toBe("chg_testInitiated01");
    const payment =
      event.event !== undefined && "payment" in event.event
        ? event.event.payment
        : undefined;
    expect(payment?.references.relatedIds?.authorizationId).toBe(
      "auth_testAuthorize01",
    );
    expect(payment?.references.relatedIds?.chargeId).toBe(
      "chg_testInitiated01",
    );
  });

  it("does not treat metadata.udf1 as paymentId", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent(
      capturedCharge({
        metadata: { udf1: "test_data_1" },
        reference: { order: "ord_01", payment: "payref1" },
      }),
    );
    expect(event.paymentId).toBe("ord_01");
    expect(event.paymentId).not.toBe("test_data_1");
  });

  it("prefers metadata.paymentId over orderId and reference.order", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent(
      capturedCharge({
        metadata: {
          paymentId: "pay_meta",
          orderId: "ord_meta",
          udf1: "test_data_1",
        },
        reference: { order: "ord_01", payment: "payref1" },
      }),
    );
    expect(event.paymentId).toBe("pay_meta");
  });
});
