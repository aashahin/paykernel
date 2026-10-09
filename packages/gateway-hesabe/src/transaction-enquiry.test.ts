import { describe, expect, it } from "bun:test";
import {
  AuthenticationError,
  createPaymentClient,
  InMemoryIdempotencyStore,
  InvalidRequestError,
  money,
  NetworkError,
  PaymentAbortedError,
  RateLimitError,
  ResourceNotFoundError,
} from "@paykernel/core";
import {
  hesabeGateway,
  type HesabeConfig,
  type HesabeTransactionEnquiryParams,
  type HesabeTransactionEnquiryResult,
} from "./index";

// https://developer.hesabe.com/docs/guides/transaction-enquiry/
const documentedTransaction = {
  token: "521042117249344539468767555844",
  amount: "45.000",
  reference_number: "1724934434",
  status: "SUCCESSFUL",
  TransactionID: "424210001296274",
  Id: 129179,
  PaymentID: "100424210000015649",
  Terminal: "144301",
  TrackID: "25119",
  payment_type: "KNET",
  service_type: "Payment Gateway",
  customerName: "User Name",
  customerEmail: "user@gmail.com",
  customerMobile: "98726012",
  customerCardType: null,
  customerCard: null,
  datetime: "2024-08-29 15:27:38",
};

const transaction = (fields: Record<string, unknown> = {}) => ({
  token: "tx-1",
  reference_number: "order-1",
  amount: "10.000",
  status: "SUCCESSFUL",
  ...fields,
});
const envelope = (fields: Record<string, unknown> = {}) => ({
  status: true,
  data: transaction(),
  ...fields,
});

function setup(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  overrides: Partial<HesabeConfig> = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createPaymentClient({
    gateways: {
      hesabe: hesabeGateway({
        merchantCode: "842217",
        accessCode: "test-access",
        encryptionKey: "PkW64zMe5NVdrlPVNnjo2Jy9nOb7v1Xg",
        ivKey: "5NVdrlPVNnjo2Jy9",
        username: "merchant",
        password: "test-password",
        idempotencyStore: new InMemoryIdempotencyStore(),
        ...overrides,
      }),
    },
    runtime: {
      fetch: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return handler(String(url), init ?? {});
      }) as typeof fetch,
    },
  });
  return { gateway: client.gateway("hesabe"), calls };
}

describe("Hesabe transaction enquiry", () => {
  it("returns the documented transaction and every documented result unchanged", async () => {
    const response: HesabeTransactionEnquiryResult = {
      status: true,
      message: "Transaction found",
      data: documentedTransaction,
      results: [documentedTransaction],
    };
    const { gateway } = setup(() => Response.json(response));
    expect(await gateway.getTransactionEnquiry({ token: documentedTransaction.token })).toEqual(
      response,
    );
  });

  it.each([
    { selector: "token", live: false, host: "https://sandbox.hesabe.com", query: "" },
    {
      selector: "orderReferenceNumber",
      live: false,
      host: "https://sandbox.hesabe.com",
      query: "?isOrderReference=1",
    },
    { selector: "token", live: true, host: "https://api.hesabe.com", query: "" },
    {
      selector: "orderReferenceNumber",
      live: true,
      host: "https://api.hesabe.com",
      query: "?isOrderReference=1",
    },
  ])(
    "uses the $selector enquiry route with live=$live without merchant login",
    async ({ selector, live, host, query }) => {
      const identifier = "value /&?#+ طلب😀";
      const data = transaction({
        [selector === "token" ? "token" : "reference_number"]: identifier,
      });
      const { gateway, calls } = setup(() => Response.json(envelope({ data })), { live });
      const params: HesabeTransactionEnquiryParams =
        selector === "token"
          ? { token: `  ${identifier}  ` }
          : { orderReferenceNumber: `  ${identifier}  ` };
      expect((await gateway.getTransactionEnquiry(params)).data).toEqual(data);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        `${host}/api/transaction/${encodeURIComponent(identifier)}${query}`,
      );
      expect(calls[0]?.init.method).toBe("GET");
      expect(calls[0]?.init.body).toBeUndefined();
      expect(new Headers(calls[0]?.init.headers).get("accessCode")).toBe("test-access");
      expect(new Headers(calls[0]?.init.headers).get("Accept")).toBe("application/json");
      expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBeNull();
    },
  );

  it.each([
    { name: "neither selector", params: {} },
    { name: "both selectors", params: { token: "tx-1", orderReferenceNumber: "order-1" } },
    { name: "blank token", params: { token: "  " } },
    { name: "blank order reference", params: { orderReferenceNumber: "" } },
    { name: "nonstring token", params: { token: 123 } },
    { name: "nonstring order reference", params: { orderReferenceNumber: null } },
    { name: "checkout token", params: { token: " ChEcKoUt:session " } },
    ...[".", " .. ", "\uD800", "\uDC00"].flatMap((identifier) => [
      {
        name: `unsafe token ${JSON.stringify(identifier)}`,
        params: { token: identifier },
      },
      {
        name: `unsafe order reference ${JSON.stringify(identifier)}`,
        params: { orderReferenceNumber: identifier },
      },
    ]),
  ])("rejects $name before sending a request", async ({ params }) => {
    const { gateway, calls } = setup(() => {
      throw new Error("unexpected enquiry request");
    });
    await expect(
      gateway.getTransactionEnquiry(params as HesabeTransactionEnquiryParams),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it("returns multiple order attempts in provider order without selecting a successful winner", async () => {
    const data = transaction({ status: "FAILED", token: "failed-attempt" });
    const results = [
      data,
      transaction({ status: "SUCCESSFUL", token: "paid-attempt" }),
      transaction({ status: "NEW_PROVIDER_STATUS", token: "new-attempt" }),
    ];
    const { gateway } = setup(() => Response.json(envelope({ data, results })));
    expect(await gateway.getTransactionEnquiry({ orderReferenceNumber: "order-1" })).toEqual({
      status: true,
      data,
      results,
    });
  });

  it.each([
    {
      name: "absent results",
      response: { status: true, data: transaction() } satisfies HesabeTransactionEnquiryResult,
    },
    {
      name: "empty results",
      response: {
        status: true,
        data: transaction(),
        results: [],
      } satisfies HesabeTransactionEnquiryResult,
    },
  ])("preserves $name", async ({ response }) => {
    const { gateway } = setup(() => Response.json(response));
    expect(await gateway.getTransactionEnquiry({ token: "tx-1" })).toEqual(response);
  });

  it("retains nullable details and strips unrecognized envelope and transaction fields", async () => {
    const data = transaction({
      TransactionID: null,
      Id: null,
      PaymentID: null,
      Terminal: null,
      TrackID: null,
      payment_type: null,
      service_type: null,
      customerName: null,
      customerEmail: null,
      customerMobile: null,
      customerCardType: null,
      customerCard: null,
      datetime: null,
    });
    const extra = { ...data, accessCode: "secret", unexpected: { nested: "secret" } };
    const { gateway } = setup(() =>
      Response.json(envelope({ data: extra, results: [extra], extra: "secret" })),
    );
    expect(await gateway.getTransactionEnquiry({ token: "tx-1" })).toEqual({
      status: true,
      data,
      results: [data],
    });
  });

  it.each([
    { amount: "45.000", expected: "45.000" },
    { amount: " 45.1 ", expected: "45.1" },
    { amount: 45.1, expected: money("45.1", "KWD").amount },
  ])("validates amount $amount while retaining decimal text", async ({ amount, expected }) => {
    const { gateway } = setup(() => Response.json(envelope({ data: transaction({ amount }) })));
    expect((await gateway.getTransactionEnquiry({ token: "tx-1" })).data.amount).toBe(expected);
  });

  it.each([
    { name: "nonobject envelope", response: [] },
    { name: "missing envelope status", response: { data: transaction() } },
    { name: "nonboolean envelope status", response: envelope({ status: "true" }) },
    { name: "missing transaction", response: { status: true } },
    { name: "null transaction", response: envelope({ data: null }) },
    { name: "array transaction", response: envelope({ data: [] }) },
    { name: "nonstring message", response: envelope({ message: 1 }) },
    { name: "null message", response: envelope({ message: null }) },
    { name: "nonarray results", response: envelope({ results: {} }) },
    { name: "null results", response: envelope({ results: null }) },
    { name: "invalid result row", response: envelope({ results: [null] }) },
    {
      name: "missing result amount",
      response: envelope({
        results: [{ token: "tx-1", reference_number: "order-1", status: "FAILED" }],
      }),
    },
    ...["token", "reference_number", "status"].flatMap((field) => [
      {
        name: `missing ${field}`,
        response: envelope({ data: transaction({ [field]: undefined }) }),
      },
      { name: `blank ${field}`, response: envelope({ data: transaction({ [field]: " " }) }) },
      { name: `nonstring ${field}`, response: envelope({ data: transaction({ [field]: 123 }) }) },
    ]),
    ...[null, "", "invalid", "0.000", "-1.000", "1.0001", true, {}].map((amount) => ({
      name: `invalid amount ${JSON.stringify(amount)}`,
      response: envelope({ data: transaction({ amount }) }),
    })),
  ])("rejects $name as a protocol failure", async ({ response }) => {
    const { gateway, calls } = setup(() => Response.json(response));
    await expect(gateway.getTransactionEnquiry({ token: "tx-1" })).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    ...[
      "TransactionID",
      "PaymentID",
      "Terminal",
      "TrackID",
      "payment_type",
      "service_type",
      "customerName",
      "customerEmail",
      "customerMobile",
      "customerCardType",
      "customerCard",
      "datetime",
    ].map((field) => ({ field, value: 123 })),
    ...["129179", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ field: "Id", value })),
  ])("rejects malformed optional $field=$value details", async ({ field, value }) => {
    const { gateway } = setup(() =>
      Response.json(
        envelope({
          results: [transaction({ [field]: value })],
        }),
      ),
    );
    await expect(gateway.getTransactionEnquiry({ token: "tx-1" })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it.each(
    [
      { selector: "token", field: "token", expected: "tx-1" },
      { selector: "orderReferenceNumber", field: "reference_number", expected: "order-1" },
    ].flatMap((lookup) => [
      { ...lookup, location: "data" },
      { ...lookup, location: "results" },
    ]),
  )(
    "rejects a $selector identity mismatch in $location",
    async ({ selector, field, expected, location }) => {
      const wrong = transaction({ [field]: "unrelated-transaction" });
      const response =
        location === "data"
          ? envelope({ data: wrong, results: [transaction()] })
          : envelope({ results: [transaction(), wrong] });
      const { gateway } = setup(() => Response.json(response));
      const params: HesabeTransactionEnquiryParams =
        selector === "token" ? { token: expected } : { orderReferenceNumber: expected };
      await expect(gateway.getTransactionEnquiry(params)).rejects.toBeInstanceOf(NetworkError);
    },
  );

  it("keeps normalized getPayment usable with unneeded malformed provider details", async () => {
    const { gateway } = setup(() =>
      Response.json(
        envelope({
          data: transaction({ customerCard: { unexpected: true }, Id: "not-numeric" }),
          message: false,
          results: "not-an-array",
        }),
      ),
    );
    const payment = await gateway.getPayment({ gatewayPaymentId: "tx-1" });
    expect(payment.status).toBe("paid");
    expect(payment.amount).toEqual(money("10", "KWD"));
    expect(payment.rawResponse).toEqual({
      token: "tx-1",
      amount: money("10", "KWD").amount,
      currency: "KWD",
      reference_number: "order-1",
      status: "SUCCESSFUL",
    });
  });

  it.each([
    {
      name: "provider rejection",
      response: () => Response.json({ status: false, message: "secret" }),
      expected: InvalidRequestError,
    },
    {
      name: "HTTP 404",
      response: () => new Response("secret", { status: 404 }),
      expected: ResourceNotFoundError,
    },
    {
      name: "HTTP 401",
      response: () => new Response("secret", { status: 401 }),
      expected: AuthenticationError,
    },
    {
      name: "invalid JSON",
      response: () => new Response("secret invalid JSON"),
      expected: NetworkError,
    },
  ])(
    "classifies $name without retrying or leaking the response body",
    async ({ response, expected }) => {
      const { gateway, calls } = setup(response);
      const error = await gateway
        .getTransactionEnquiry({ token: "tx-1" })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(expected);
      expect(String(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(calls).toHaveLength(1);
    },
  );

  it.each([true, false])(
    "bounds retries for rate limits with eventual success=%s",
    async (success) => {
      let attempts = 0;
      const { gateway, calls } = setup(() => {
        attempts += 1;
        return success && attempts === 3
          ? Response.json(envelope())
          : new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      });
      const pending = gateway.getTransactionEnquiry({ token: "tx-1" });
      if (success) {
        expect((await pending).data.token).toBe("tx-1");
      } else {
        await expect(pending).rejects.toBeInstanceOf(RateLimitError);
      }
      expect(calls).toHaveLength(3);
    },
  );

  it("does not fetch for an already aborted enquiry", async () => {
    const controller = new AbortController();
    controller.abort();
    const { gateway, calls } = setup(() => Response.json(envelope()));
    await expect(
      gateway.getTransactionEnquiry({ token: "tx-1", signal: controller.signal }),
    ).rejects.toBeInstanceOf(PaymentAbortedError);
    expect(calls).toHaveLength(0);
  });

  it("aborts a pending enquiry fetch without waiting for the transport", async () => {
    const controller = new AbortController();
    const { gateway, calls } = setup(() => {
      queueMicrotask(() => controller.abort());
      return new Promise<Response>(() => {});
    });
    await expect(
      gateway.getTransactionEnquiry({ token: "tx-1", signal: controller.signal }),
    ).rejects.toBeInstanceOf(PaymentAbortedError);
    expect(calls).toHaveLength(1);
  }, 500);

  it("cancels retry backoff before issuing another enquiry", async () => {
    const controller = new AbortController();
    const { gateway, calls } = setup(
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }),
    );
    const pending = gateway.getTransactionEnquiry({
      orderReferenceNumber: "order-1",
      signal: controller.signal,
    });
    const cancel = setTimeout(() => controller.abort(), 20);
    try {
      await expect(pending).rejects.toBeInstanceOf(PaymentAbortedError);
      expect(calls).toHaveLength(1);
    } finally {
      clearTimeout(cancel);
    }
  }, 500);

  it("times out hanging fetches and stops after the bounded read attempts", async () => {
    const { gateway, calls } = setup(() => new Promise<Response>(() => {}), { timeoutMs: 10 });
    const error = await gateway
      .getTransactionEnquiry({ token: "tx-1" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NetworkError);
    expect(String(error)).toContain("timed out");
    expect((error as NetworkError).afterProviderSubmit).toBe(false);
    expect(calls).toHaveLength(3);
  }, 5000);
});
