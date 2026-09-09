// file: packages/gateway-myfatoorah/src/create-reservation.test.ts
import { describe, expect, it } from "bun:test";
import {
  HooksManager,
  InMemoryIdempotencyStore,
  InvalidRequestError,
  money,
  RateLimitError,
  type IdempotencyStore,
} from "@paykernel/core";
import { MyFatoorahGateway } from "./gateway";
import {
  MYFATOORAH_TEST_API_TOKEN,
  initiatedCreateData,
  myfatoorahEnvelope,
  paidInvoiceStatusData,
} from "./fixtures/webhooks";

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function countReads(calls: FetchCall[]): number {
  return calls.filter((c) => c.url.endsWith("/v2/GetPaymentStatus")).length;
}

function countPosts(calls: FetchCall[]): number {
  return calls.filter((c) => c.url.endsWith("/v3/payments")).length;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeGateway(
  calls: FetchCall[],
  handler: (url: string, init?: RequestInit) => Response | Error | Promise<Response | Error>,
  country: "ARE" | "KWT",
  store: IdempotencyStore | undefined,
): MyFatoorahGateway {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const next = await handler(url, init);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return new MyFatoorahGateway(
    {
      apiToken: MYFATOORAH_TEST_API_TOKEN,
      country,
      ...(store !== undefined ? { idempotencyStore: store } : {}),
    },
    new HooksManager({}),
    undefined,
    { fetch: fetchImpl },
  );
}

describe("MyFatoorah create reservation (real gateway + real store)", () => {
  it("ARE concurrent fence: second rejects in_progress before HTTP, replay cached, conflict no HTTP", async () => {
    const calls: FetchCall[] = [];
    const store = new InMemoryIdempotencyStore();
    const gate = deferred();
    const entered = deferred();
    let inquirySeen = false;
    const expectedUrl =
      "https://sandbox.pg.apitest.myfatoorah.com/Checkout/Gateway/915102/concurrent-fence-000001";

    const handler = async (url: string): Promise<Response | Error> => {
      if (url.endsWith("/v2/GetPaymentStatus")) {
        if (!inquirySeen) {
          inquirySeen = true;
          entered.resolve();
          await gate.promise;
        }
        return jsonResponse({ IsSuccess: false, Message: "Not found" }, 404);
      }
      if (url.endsWith("/v3/payments")) {
        return jsonResponse(myfatoorahEnvelope(initiatedCreateData({ PaymentURL: expectedUrl })));
      }
      throw new Error(`unexpected MyFatoorah fetch: ${url}`);
    };

    const gwA = makeGateway(calls, handler, "ARE", store);
    const gwB = makeGateway(calls, handler, "ARE", store);
    const params = {
      amount: money("10.50", "SAR"),
      currency: "SAR",
      callbackUrl: "https://merchant.example/callback",
      idempotencyKey: "idem-are-fence-1",
      orderId: "ord_are_fence_1",
    };

    const firstPromise = gwA.createPayment({ ...params });
    try {
      await entered.promise;
      const beforeSecond = calls.length;
      expect(beforeSecond).toBe(1);
      expect(countReads(calls)).toBe(1);
      await expect(gwB.createPayment({ ...params })).rejects.toThrow(/already in progress/);
      expect(calls.length).toBe(beforeSecond);
      expect(countReads(calls)).toBe(1);
      expect(countPosts(calls)).toBe(0);
    } finally {
      gate.resolve();
    }

    const first = await firstPromise;
    expect(first.outcome).toBe("requires_action");
    expect(first.status).toBe("pending");
    expect(first.gatewayId).toBe("915102");
    expect(first.redirectUrl).toBe(expectedUrl);
    expect(countReads(calls)).toBe(1);
    expect(countPosts(calls)).toBe(1);

    const beforeReplay = calls.length;
    const replay = await gwB.createPayment({ ...params });
    expect(replay.redirectUrl).toBe(expectedUrl);
    expect(replay.gatewayId).toBe("915102");
    expect(calls.length).toBe(beforeReplay);
    expect(countReads(calls)).toBe(1);
    expect(countPosts(calls)).toBe(1);

    const beforeConflict = calls.length;
    const conflict = gwB.createPayment({ ...params, amount: money("11.50", "SAR") });
    await expect(conflict).rejects.toThrow(InvalidRequestError);
    await expect(conflict).rejects.toThrow(/different params/);
    expect(calls.length).toBe(beforeConflict);
    expect(countReads(calls)).toBe(1);
    expect(countPosts(calls)).toBe(1);
  });

  const postFailureVariants = [
    { name: "post TypeError", kind: "type-error" as const, expectThrow: false },
    { name: "post HTTP429", kind: "http-429" as const, expectThrow: true },
    { name: "post malformed 2xx", kind: "malformed-2xx" as const, expectThrow: false },
  ] as const;

  for (const variant of postFailureVariants) {
    it(`ARE post-submit failure ${variant.name}: single POST then retry rejects in_progress/unknown`, async () => {
      const calls: FetchCall[] = [];
      const store = new InMemoryIdempotencyStore();
      const handler = (url: string): Response | Error => {
        if (url.endsWith("/v2/GetPaymentStatus")) {
          return jsonResponse({ IsSuccess: false, Message: "Not found" }, 404);
        }
        if (url.endsWith("/v3/payments")) {
          if (variant.kind === "type-error") return new TypeError("connect ECONNREFUSED");
          if (variant.kind === "http-429") {
            return jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429);
          }
          return jsonResponse({
            IsSuccess: true,
            Message: "OK",
            ValidationErrors: null,
            Data: { PaymentURL: "https://pay.example/orphan" },
          });
        }
        throw new Error(`unexpected MyFatoorah fetch: ${url}`);
      };
      const gwA = makeGateway(calls, handler, "ARE", store);
      const gwB = makeGateway(calls, handler, "ARE", store);
      const params = {
        amount: money("10.50", "SAR"),
        currency: "SAR",
        callbackUrl: "https://merchant.example/callback",
        idempotencyKey: `idem-are-post-${variant.kind}`,
        orderId: `ord_are_post_${variant.kind}`,
      };

      if (variant.expectThrow) {
        await expect(gwA.createPayment({ ...params })).rejects.toThrow(RateLimitError);
      } else {
        const first = await gwA.createPayment({ ...params });
        expect(first.outcome).toBe("indeterminate");
      }
      expect(countReads(calls)).toBe(1);
      expect(countPosts(calls)).toBe(1);

      const beforeRetry = calls.length;
      const retry = gwB.createPayment({ ...params });
      await expect(retry).rejects.toThrow(InvalidRequestError);
      await expect(retry).rejects.toThrow(/already in progress|indeterminate/);
      expect(calls.length).toBe(beforeRetry);
      expect(countPosts(calls)).toBe(1);
    });
  }

  it("failed inquiry releases the reservation so the same request can succeed later", async () => {
    const calls: FetchCall[] = [];
    const store = new InMemoryIdempotencyStore();
    let inquiryAvailable = false;
    const gateway = makeGateway(
      calls,
      (url) => {
        if (url.endsWith("/v2/GetPaymentStatus")) {
          return inquiryAvailable
            ? jsonResponse({ IsSuccess: false, Message: "Not found" }, 404)
            : jsonResponse({ IsSuccess: false, Message: "Unauthorized" }, 401);
        }
        if (url.endsWith("/v3/payments")) {
          return jsonResponse(myfatoorahEnvelope(initiatedCreateData()));
        }
        throw new Error(`unexpected MyFatoorah fetch: ${url}`);
      },
      "ARE",
      store,
    );
    const params = {
      amount: money("10.50", "SAR"),
      currency: "SAR",
      callbackUrl: "https://merchant.example/callback",
      idempotencyKey: "lookup-recovery",
      orderId: "order-lookup-recovery",
    };

    expect((await gateway.createPayment(params)).outcome).toBe("indeterminate");
    expect(countPosts(calls)).toBe(0);
    inquiryAvailable = true;
    const recovered = await gateway.createPayment(params);
    expect(recovered.outcome).toBe("requires_action");
    expect(recovered.gatewayId).toBe("915102");
    expect(countPosts(calls)).toBe(1);
  });

  it("failed response persistence retains the fence and prevents a second charge", async () => {
    const calls: FetchCall[] = [];
    const persisted = new InMemoryIdempotencyStore();
    const persistenceError = new Error("idempotency storage unavailable");
    // Inject a storage outage only after the real atomic reservation succeeds.
    const store: IdempotencyStore = {
      get: (key) => persisted.get(key),
      reserve: (key, record) => persisted.reserve(key, record),
      delete: (key) => persisted.delete(key),
      set: () => {
        throw persistenceError;
      },
    };
    const handler = (url: string): Response => {
      if (url.endsWith("/v2/GetPaymentStatus")) {
        return jsonResponse({ IsSuccess: false, Message: "Not found" }, 404);
      }
      if (url.endsWith("/v3/payments")) {
        return jsonResponse(myfatoorahEnvelope(initiatedCreateData()));
      }
      throw new Error(`unexpected MyFatoorah fetch: ${url}`);
    };
    const firstGateway = makeGateway(calls, handler, "ARE", store);
    const retryGateway = makeGateway(calls, handler, "ARE", persisted);
    const params = {
      amount: money("10.50", "SAR"),
      currency: "SAR",
      callbackUrl: "https://merchant.example/callback",
      idempotencyKey: "persistence-failure",
      orderId: "order-persistence-failure",
    };

    await expect(firstGateway.createPayment(params)).rejects.toThrow(persistenceError.message);
    const callsBeforeRetry = calls.length;
    await expect(retryGateway.createPayment(params)).rejects.toThrow(/already in progress/);
    expect(calls.length).toBe(callsBeforeRetry);
    expect(countPosts(calls)).toBe(1);
  });

  it("ARE without store rejects before any HTTP", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      throw new Error("must not fetch without store");
    }) as typeof fetch;
    const gateway = new MyFatoorahGateway(
      { apiToken: MYFATOORAH_TEST_API_TOKEN, country: "ARE" },
      new HooksManager({}),
      undefined,
      { fetch: fetchImpl },
    );
    await expect(
      gateway.createPayment({
        amount: money("10.50", "SAR"),
        currency: "SAR",
        callbackUrl: "https://merchant.example/callback",
        idempotencyKey: "idem-are-nostore-1",
        orderId: "ord_are_nostore_1",
      }),
    ).rejects.toThrow(/idempotency store/);
    expect(calls.length).toBe(0);
    expect(countReads(calls)).toBe(0);
    expect(countPosts(calls)).toBe(0);
  });

  for (const country of ["KWT", "ARE"] as const) {
    it(`F1 ${country}: paid inquiry 10 KWD exact returns succeeded with one inquiry zero POST`, async () => {
      const calls: FetchCall[] = [];
      const store = new InMemoryIdempotencyStore();
      const paid = paidInvoiceStatusData({
        InvoiceId: 915102,
        InvoiceStatus: "Paid",
        InvoiceValue: 10,
        InvoiceCurrency: "KWD",
        BaseCurrency: "KWD",
        Currency: "KWD",
        Transactions: [
          {
            TransactionStatus: "Succss",
            PaymentId: "07076409988323998875",
            Currency: "KWD",
            PaidCurrency: "KWD",
            PaidCurrencyValue: "10.000",
            TransationValue: "10.000",
          },
        ],
      });
      const handler = (url: string): Response | Error => {
        if (url.endsWith("/v2/GetPaymentStatus")) {
          return jsonResponse(myfatoorahEnvelope(paid));
        }
        throw new Error(`unexpected MyFatoorah fetch (zero POST expected): ${url}`);
      };
      const gateway = makeGateway(calls, handler, country, country === "ARE" ? store : undefined);
      const result = await gateway.createPayment({
        amount: money("10.000", "KWD"),
        currency: "KWD",
        callbackUrl: "https://merchant.example/callback",
        idempotencyKey: `idem-f1-${country.toLowerCase()}-1`,
        orderId: `ord_f1_${country.toLowerCase()}_1`,
      });
      expect(result.outcome).toBe("succeeded");
      expect(result.status).toBe("paid");
      expect(result.gatewayId).toBe("915102");
      expect(result.amount).toEqual(money("10.000", "KWD"));
      expect(result.currency).toBe("KWD");
      expect(countReads(calls)).toBe(1);
      expect(countPosts(calls)).toBe(0);
      expect(calls.length).toBe(1);
    });
  }
});
