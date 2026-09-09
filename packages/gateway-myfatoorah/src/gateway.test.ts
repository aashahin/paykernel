import { describe, expect, it } from "bun:test";
import {
  HooksManager,
  InMemoryIdempotencyStore,
  InvalidRequestError,
  isIndeterminateOutcome,
  isPaidOutcome,
  money,
  NetworkError,
  OperationNotSupportedError,
  RateLimitError,
  type IdempotencyStore,
} from "@paykernel/core";
import { MyFatoorahGateway } from "./gateway";
import {
  MYFATOORAH_TEST_API_TOKEN,
  initiatedCreateData,
  myfatoorahEnvelope,
  paidCreateData,
  paidInvoiceStatusData,
  partialRefundStatusData,
  makeRefundData,
  paymentWebhook,
  refundWebhook,
} from "./fixtures/webhooks";
import type { MyFatoorahCountry } from "./config";

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createGateway(
  queue: (Response | Error)[],
  calls: FetchCall[],
  config: {
    country?: MyFatoorahCountry;
    webhookUrl?: string;
    defaultPaymentMethod?: string;
    timeoutMs?: number;
    live?: boolean;
    store?: IdempotencyStore;
  } = {},
): MyFatoorahGateway {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected MyFatoorah fetch: ${String(input)}`);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const { store, ...rest } = config;
  return new MyFatoorahGateway(
    {
      apiToken: MYFATOORAH_TEST_API_TOKEN,
      country: "KWT",
      ...rest,
      idempotencyStore: store ?? new InMemoryIdempotencyStore(),
    },
    new HooksManager({}),
    undefined,
    { fetch: fetchImpl },
  );
}

const createParams = {
  amount: money("10.50", "SAR"),
  currency: "SAR",
  callbackUrl: "https://merchant.example/callback",
  idempotencyKey: "idem-create-1",
} as const;

function bodyOf(call: FetchCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? "{}")) as Record<string, unknown>;
}

describe("MyFatoorahGateway.createPayment", () => {
  it("posts V3 with Idempotency-Key, ISO Order.Amount, and Redirection", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(initiatedCreateData()))], calls);
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("requires_action");
    expect(result.status).toBe("pending");
    expect(result.gatewayId).toBe("915102");
    expect(result.redirectUrl).toBe(initiatedCreateData().PaymentURL);
    expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v3/payments");
    expect(String(calls[0]?.init?.headers?.["Idempotency-Key"] ?? "")).toBe("idem-create-1");
    expect(String(calls[0]?.init?.headers?.Authorization ?? "")).toBe(
      `Bearer ${MYFATOORAH_TEST_API_TOKEN}`,
    );
    const rawBody = String(calls[0]?.init?.body);
    expect(rawBody).toContain('"Amount":10.50');
    expect(rawBody).not.toContain('"Amount":"10.50"');
    const body = bodyOf(calls[0]);
    expect(body.Order).toEqual({ Amount: 10.5, Currency: "SAR" });
    expect(body.IntegrationUrls).toEqual({
      Redirection: "https://merchant.example/callback",
    });
    expect(body.PaymentMethod).toBeUndefined();
    expect(body.OperationType).toBeUndefined();
    expect(body.SaveCardOptions).toBeUndefined();
  });

  it("sends config webhookUrl and PaymentMethod / language / customer", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "Not found" }, 404),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { webhookUrl: "https://merchant.example/webhook", defaultPaymentMethod: "KNET" },
    );
    await gateway.createPayment({
      ...createParams,
      myfatoorahCustomer: { name: "Ada Lovelace", email: "ada@example.com" },
      myfatoorahLanguage: "EN",
      orderId: "ord_01",
    });
    expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v2/GetPaymentStatus");
    expect(calls[1]?.url).toBe("https://apitest.myfatoorah.com/v3/payments");
    const body = bodyOf(calls[1]);
    expect(body.PaymentMethod).toBe("KNET");
    expect(body.Language).toBe("EN");
    expect(body.Order).toEqual({
      Amount: 10.5,
      Currency: "SAR",
      ExternalIdentifier: "ord_01",
    });
    expect(body.IntegrationUrls).toEqual({
      Redirection: "https://merchant.example/callback",
      Webhook: "https://merchant.example/webhook",
    });
    expect(body.Customer).toEqual({
      Name: "Ada Lovelace",
      Email: "ada@example.com",
      Reference: "ord_01",
    });
  });

  it("maps PaymentCompleted + paid evidence to succeeded / paid without redirect", async () => {
    const paid = paidCreateData({
      TransactionDetails: {
        Invoice: { Status: "PAID" },
        Transaction: { Status: "SUCCESS", PaymentId: "07076409988323998875" },
        Amount: {
          BaseCurrency: "SAR",
          ValueInBaseCurrency: 10.5,
          DisplayCurrency: "SAR",
          ValueInDisplayCurrency: 10.5,
          PayCurrency: "SAR",
          ValueInPayCurrency: 10.5,
        },
      },
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(paid))], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(result.status).toBe("paid");
    expect(result.redirectUrl).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
    expect(result.amount).toEqual(money(10.5, "SAR"));
    expect(result.currency).toBe("SAR");
  });

  it("maps legacy flat paid evidence (InvoiceStatus + TransactionDetails.Status) as paid", async () => {
    const legacy = paidCreateData({
      InvoiceStatus: "PAID",
      TransactionDetails: {
        Status: "SUCCESS",
        Amount: {
          BaseCurrency: "SAR",
          ValueInBaseCurrency: 10.5,
          DisplayCurrency: "SAR",
          ValueInDisplayCurrency: 10.5,
          PayCurrency: "SAR",
          ValueInPayCurrency: 10.5,
        },
      },
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(legacy))], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.status).toBe("paid");
    expect(result.amount).toEqual(money(10.5, "SAR"));
  });

  it("retries post-submit network errors on create only for KWT/SAU — timeout abort is indeterminate", async () => {
    // C1/C2: KWT/SAU POST has Idempotency-Key, so a true post-submit timeout
    // (fetch aborted after headers sent) must retry withRetry (maxAttempts 3)
    // and then surface indeterminate with gatewayId = idempotencyKey/orderId.
    // F2: portable fetch rejection after invocation is tagged afterProviderSubmit=true
    // even for TypeError — use AbortError here to exercise the post-submit path deterministically.
    const calls: FetchCall[] = [];
    const timeoutAbort = () => new DOMException("MyFatoorah API request timed out after 10000ms", "AbortError");
    const gateway = createGateway(
      [timeoutAbort(), timeoutAbort(), timeoutAbort()],
      calls,
      { country: "KWT" },
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("indeterminate");
    expect(calls.length).toBe(3);
  });

  it("portable TypeError after fetch is indeterminate outside KWT/SAU — no POST retries (F2)", async () => {
    // F2: portable fetch rejection after invocation does not prove pre-submit;
    // mutating POST is tagged afterProviderSubmit=true → indeterminate.
    // Outside KWT/SAU the POST uses retry:false (requires store fence) so a
    // single POST attempt, not withRetry maxAttempts 3.
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "Not found" }, 404),
        new TypeError("connect ECONNREFUSED"),
      ],
      calls,
      { country: "BHR" },
    );
    const result = await gateway.createPayment({ ...createParams, orderId: "ord_bhr_1" });
    expect(result.outcome).toBe("indeterminate");
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(result.gatewayId).toBe("ord_bhr_1");
    // 1 preflight (404 not-found → allow create) + 1 POST attempt (retry:false, no fan-out)
    expect(calls.length).toBe(2);
  });

  it("returns indeterminate when a mutating 2xx has no InvoiceId", async () => {
    const gateway = createGateway(
      [jsonResponse(myfatoorahEnvelope({ PaymentURL: "https://pay.example" }))],
      [],
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(result.outcome).toBe("indeterminate");
  });

  it("returns indeterminate when a mutating 2xx has neither PaymentURL nor paid evidence", async () => {
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope({ InvoiceId: 915102 }))], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isIndeterminateOutcome(result)).toBe(true);
  });

  it("rejects capture: false with the authorization capability, no fetch", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(gateway.createPayment({ ...createParams, capture: false })).rejects.toThrow(
      OperationNotSupportedError,
    );
    expect(calls.length).toBe(0);
  });

  it("rejects missing idempotencyKey without fetching", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(
      gateway.createPayment({ ...createParams, idempotencyKey: undefined }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.length).toBe(0);
  });

  it("rejects a non-HTTPS callbackUrl without fetching", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(
      gateway.createPayment({
        ...createParams,
        callbackUrl: "http://merchant.example/callback",
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.length).toBe(0);
  });

  it("rejects raw PCI card sources without fetching", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(
      gateway.createPayment({
        ...createParams,
        myfatoorahCard: { Number: "4111111111111111" },
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.length).toBe(0);
  });

  it("rejects both myfatoorahSessionId and myfatoorahToken without fetching", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(
      gateway.createPayment({
        ...createParams,
        myfatoorahSessionId: "sess-1",
        myfatoorahToken: "tok-1",
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.length).toBe(0);
  });

  it("sends SourceOfFund.Token for myfatoorahToken", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(initiatedCreateData()))], calls);
    await gateway.createPayment({ ...createParams, myfatoorahToken: "tok-1" });
    expect(bodyOf(calls[0]).SourceOfFund).toEqual({ Token: "tok-1" });
  });

  it("accepts UDF1..UDF5 string metadata and rejects other keys", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(initiatedCreateData()))], calls);
    await gateway.createPayment({
      ...createParams,
      metadata: { UDF1: "one", UDF5: "five" },
    });
    expect(bodyOf(calls[0]).MetaData).toEqual({ UDF1: "one", UDF5: "five" });
    await expect(
      gateway.createPayment({ ...createParams, metadata: { orderId: "x" } }),
    ).rejects.toThrow(InvalidRequestError);
  });
  it("retries create once without Idempotency-Key on an idempotency validation error", async () => {
    const calls: FetchCall[] = [];
    // KWT honors Idempotency-Key, but provider may still return 2xx IsSuccess:false
    // with ValidationErrors as string body (e.g. FieldsErrors alias). Adapter retries once
    // without header; second request parses as success.
    const gateway = createGateway(
      [
        jsonResponse(
          {
            IsSuccess: false,
            Message: "",
            ValidationErrors: [{ Name: "Idempotency-Key", Error: "Header not supported" }],
          },
          200,
        ),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "KWT" },
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("requires_action");
    expect(calls.length).toBe(2);
    expect(String(calls[0]?.init?.headers?.["Idempotency-Key"] ?? "")).toBe("idem-create-1");
    expect(calls[1]?.init?.headers?.["Idempotency-Key"]).toBeUndefined();
  });
  it("retries create once without Idempotency-Key on a 400 ValidationErrors object body", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          {
            IsSuccess: false,
            Message: "",
            ValidationErrors: [{ Name: "Idempotency-Key", Error: "Header not supported" }],
          },
          400,
        ),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "KWT" },
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("requires_action");
    expect(calls.length).toBe(2);
    expect(calls[1]?.init?.headers?.["Idempotency-Key"]).toBeUndefined();
  });

  it("does not drop Idempotency-Key on an idempotency conflict (different body)", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          {
            IsSuccess: false,
            Message: "",
            ValidationErrors: [
              { Name: "Idempotency-Key", Error: "Key already used with a different request" },
            ],
          },
          200,
        ),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "KWT" },
    );
    await expect(gateway.createPayment({ ...createParams })).rejects.toThrow(InvalidRequestError);
    expect(calls.length).toBe(1);
  });

  it("does not auto-retry the headerless create POST after submit (MF-CRIT-2)", async () => {
    // Headerless retry (KWT header not supported) uses retry:false to avoid double-charge
    // fan-out. A true post-submit timeout (abort after headers) must still be
    // indeterminate. F2: portable TypeError is also indeterminate post-submit —
    // use AbortError to exercise the post-submit path deterministically.
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          {
            IsSuccess: false,
            Message: "",
            ValidationErrors: [{ Name: "Idempotency-Key", Error: "Header not supported" }],
          },
          200,
        ),
        new DOMException("MyFatoorah API request timed out after 10000ms", "AbortError"),
        new TypeError("connect ECONNREFUSED"), // must never be consumed (retry:false)
      ],
      calls,
      { country: "KWT" },
    );
    const result = await gateway.createPayment({ ...createParams });
    expect(result.outcome).toBe("indeterminate");
    expect(calls.length).toBe(2);
  });

  it("does not send Idempotency-Key outside KWT/SAU", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "Not found" }, 404),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_are_no_header",
    });
    expect(result.outcome).toBe("requires_action");
    expect(calls.length).toBe(2);
    expect(calls[1]?.init?.headers?.["Idempotency-Key"]).toBeUndefined();
  });

  it("requires orderId or myfatoorahCustomer.reference outside KWT/SAU", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls, { country: "ARE" });
    await expect(gateway.createPayment({ ...createParams })).rejects.toThrow(
      /orderId|CustomerReference|myfatoorahCustomer\.reference/,
    );
    expect(calls.length).toBe(0);
  });

  it("picks the currency-matching ValueIn* field on paid create", async () => {
    const paid = paidCreateData({
      TransactionDetails: {
        Invoice: { Status: "PAID" },
        Transaction: { Status: "SUCCESS", PaymentId: "07076409988323998875" },
        Amount: {
          BaseCurrency: "KWD",
          ValueInBaseCurrency: 64.772,
          DisplayCurrency: "KWD",
          ValueInDisplayCurrency: 800,
          PayCurrency: "SAR",
          ValueInPayCurrency: 800,
        },
      },
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(paid))], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.amount).toEqual(money(800, "SAR"));
    expect(result.currency).toBe("SAR");
  });

  it("omits the paid amount when no ValueIn* field matches the request currency", async () => {
    const paid = paidCreateData({
      TransactionDetails: {
        Invoice: { Status: "PAID" },
        Transaction: { Status: "SUCCESS", PaymentId: "07076409988323998875" },
        Amount: {
          BaseCurrency: "KWD",
          ValueInBaseCurrency: 64.772,
          DisplayCurrency: "KWD",
          ValueInDisplayCurrency: 64.772,
        },
      },
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(paid))], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.amount).toBeUndefined();
  });
});

describe("MyFatoorahGateway.getPayment", () => {
  it("POSTs GetPaymentStatus with the InvoiceId key", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData()))],
      calls,
    );
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v2/GetPaymentStatus");
    expect(bodyOf(calls[0])).toEqual({ Key: "915102", KeyType: "InvoiceId" });
    expect(result.gatewayId).toBe("915102");
    expect(result.status).toBe("paid");
    expect(result.amount).toEqual(money(10.5, "SAR"));
    expect(result.currency).toBe("SAR");
    expect(result.references?.relatedIds?.paymentId).toBe("07076409988323998875");
  });

  it("keeps a pending invoice pending even when the latest transaction failed", async () => {
    const data = paidInvoiceStatusData();
    data.InvoiceStatus = "Pending";
    const failed = [
      {
        TransactionStatus: "FAILED",
        TransactionId: "t1",
        Currency: "SAR",
      },
    ];
    data.Transactions = failed;
    (data as Record<string, unknown>).InvoiceTransactions = failed;
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.status).toBe("pending");
    expect(result.outcome).toBe("requires_action");
  });

  it("does not treat a Paid invoice without a success transaction as paid", async () => {
    const data = paidInvoiceStatusData();
    const failed = [{ TransactionStatus: "FAILED", Currency: "SAR" }];
    data.Transactions = failed;
    (data as Record<string, unknown>).InvoiceTransactions = failed;
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.status).not.toBe("paid");
    expect(isPaidOutcome(result)).toBe(false);
    expect(result.amount).toBeUndefined();
  });

  it("normalizes the KD currency alias to KWD from the success transaction", async () => {
    const data = paidInvoiceStatusData({
      Transactions: [
        { TransactionStatus: "Succss", PaymentId: "t1", Currency: "KD", PaidCurrency: "KD" },
      ],
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.status).toBe("paid");
    expect(result.currency).toBe("KWD");
  });

  it("publishes official thousand-separated PaidCurrencyValue as pay amount", async () => {
    const data = paidInvoiceStatusData({
      InvoiceValue: 997.123,
      Transactions: [
        {
          TransactionStatus: "Succss",
          PaymentId: "0707",
          Currency: "KWD",
          PaidCurrency: "SAR",
          PaidCurrencyValue: "12,345.00",
          TransationValue: "12,345.00",
        },
      ],
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.amount).toEqual(money(12345, "SAR"));
    expect(result.currency).toBe("SAR");
  });

  it("publishes the pay currency amount when base differs (KWD base, SAR pay)", async () => {
    const data = paidInvoiceStatusData({
      InvoiceValue: 64.772,
      Transactions: [
        {
          TransactionStatus: "Succss",
          PaymentId: "0707",
          Currency: "KWD",
          PaidCurrency: "SAR",
          PaidCurrencyValue: "800",
        },
      ],
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.amount).toEqual(money(800, "SAR"));
    expect(result.currency).toBe("SAR");
  });

  it("maps a refunded invoice as settled but not paid", async () => {
    const data = paidInvoiceStatusData();
    data.InvoiceStatus = "Refunded";
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.status).toBe("refunded");
    expect(result.outcome).toBe("succeeded");
    expect(isPaidOutcome(result)).toBe(false);
  });

  it("maps canceled invoices to cancelled / failed outcome", async () => {
    const data = paidInvoiceStatusData();
    data.InvoiceStatus = "Canceled";
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.status).toBe("cancelled");
    expect(result.outcome).toBe("failed");
  });

  it("rejects non-digit gatewayPaymentId without fetching", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(gateway.getPayment({ gatewayPaymentId: "abc" })).rejects.toThrow(
      InvalidRequestError,
    );
    expect(calls.length).toBe(0);
  });

  it("rejects PaymentId-shaped gatewayPaymentId with the InvoiceId default", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(gateway.getPayment({ gatewayPaymentId: "07076409988323998875" })).rejects.toThrow(
      /PaymentId/,
    );
    expect(calls.length).toBe(0);
  });

  it("queries with KeyType PaymentId when requested", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData()))],
      calls,
    );
    const result = await gateway.getPayment({
      gatewayPaymentId: "07076409988323998875",
      myfatoorahKeyType: "PaymentId",
    });
    expect(bodyOf(calls[0])).toEqual({ Key: "07076409988323998875", KeyType: "PaymentId" });
    expect(result.status).toBe("paid");
  });
});

describe("MyFatoorahGateway.refundPayment", () => {
  function refundQueue() {
    const calls: FetchCall[] = [];
    const queue = [
      jsonResponse(myfatoorahEnvelope(partialRefundStatusData())),
      jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
      jsonResponse(myfatoorahEnvelope(makeRefundData())),
    ];
    return { calls, queue };
  }

  it("posts MakeRefund with ServiceChargeOnCustomer false and ExternalIdentifier", async () => {
    const { calls, queue } = refundQueue();
    const gateway = createGateway(queue, calls);
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-2",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://apitest.myfatoorah.com/v2/GetRefundStatus",
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
      "https://apitest.myfatoorah.com/v2/MakeRefund",
    ]);
    const body = bodyOf(calls[2]);
    expect(body.KeyType).toBe("InvoiceId");
    expect(body.Key).toBe("915102");
    expect(body.ServiceChargeOnCustomer).toBe(false);
    expect(body.ExternalIdentifier).toBe("refund-idem-2");
    expect(String(calls[2]?.init?.headers?.["Idempotency-Key"] ?? "")).toBe("refund-idem-2");
    expect(body.Amount).toBe(0.6); // 0.85 − 0.25 already refunded (KWD base, not SAR pay 10.5)
    // pending — never completed from MakeRefund acceptance
    expect(result.status).toBe("pending");
    expect(result.outcome).toBe("pending");
    expect(result.gatewayRefundId).toBe("22202");
  });

  it("uses the caller amount when provided and under remaining", async () => {
    const { calls, queue } = refundQueue();
    const gateway = createGateway(queue, calls);
    await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-2",
      amount: money("0.300", "KWD"),
      currency: "KWD",
    });
    const body = bodyOf(calls[2]);
    expect(String(calls[2]?.init?.body)).toContain('"Amount":0.300');
    expect(body.Amount).toBe(0.3);
  });

  it("rejects a caller amount over remaining without MakeRefund", async () => {
    const { calls, queue } = refundQueue();
    queue.pop(); // drop the MakeRefund response — it must not be reached
    const gateway = createGateway(queue, calls);
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-idem-2",
        amount: money("0.700", "KWD"),
        currency: "KWD",
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("throws for a currency mismatch without MakeRefund", async () => {
    const { calls, queue } = refundQueue();
    queue.pop();
    const gateway = createGateway(queue, calls);
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-idem-2",
        amount: money("3.00", "USD"),
        currency: "USD",
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("replays a partial refund with same idempotencyKey without posting MakeRefund (MF-CRIT-1)", async () => {
    // Existing partial refund with same ExternalIdentifier should be returned before any MakeRefund,
    // even though remaining > 0 (idempotent retry after partial).
    const refundStatus = partialRefundStatusData({
      Refunds: [
        {
          RefundId: 22201,
          ExternalIdentifier: "refund-idem-2",
          Comment: null,
          InvoiceId: 915102,
          Amount: 0.25,
          ServiceChargeOnCustomer: 0,
          RefundStatus: "Pending",
        },
      ],
    });
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(refundStatus)),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-2",
      amount: money("0.250", "KWD"),
      currency: "KWD",
    });
    expect(result.gatewayRefundId).toBe("22201");
    expect(result.status).toBe("pending");
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("replays a fully refunded invoice from the nested refund when keyed", async () => {
    const refundStatus = partialRefundStatusData({
      Refunds: [
        {
          RefundId: 22201,
          ExternalIdentifier: "refund-idem-2",
          Comment: null,
          InvoiceId: 915102,
          Amount: 0.85,
          ServiceChargeOnCustomer: 0,
          RefundStatus: "Refunded",
        },
      ],
    });
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(refundStatus)),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-2",
    });
    expect(result.gatewayRefundId).toBe("22201");
    expect(result.status).toBe("completed");
    expect(result.outcome).toBe("succeeded");
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("throws for a fully refunded invoice with no matching nested refund", async () => {
    const refundStatus = partialRefundStatusData({
      Refunds: [
        {
          RefundId: 22201,
          ExternalIdentifier: "refund-idem-1",
          Comment: null,
          InvoiceId: 915102,
          Amount: 0.85,
          ServiceChargeOnCustomer: 0,
          RefundStatus: "Refunded",
        },
      ],
    });
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(refundStatus)),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
      ],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-idem-2",
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("does not retry the first MakeRefund POST on 429", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope({ RefundStatusResult: [] })),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
        jsonResponse(myfatoorahEnvelope(makeRefundData())),
      ],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-429-1",
        currency: "KWD",
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls.filter((c) => c.url.endsWith("/v2/MakeRefund")).length).toBe(1);
  });

  it("does not auto-retry the headerless MakeRefund POST (no 429 fan-out)", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope({ RefundStatusResult: [] })),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse(
          {
            IsSuccess: false,
            Message: "",
            ValidationErrors: [{ Name: "Idempotency-Key", Error: "Header not supported" }],
          },
          200,
        ),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
      ],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-headerless-1",
        currency: "KWD",
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    const makeRefundCalls = calls.filter((c) => c.url.endsWith("/v2/MakeRefund"));
    expect(makeRefundCalls.length).toBe(2);
    expect(makeRefundCalls[1]?.init?.headers?.["Idempotency-Key"]).toBeUndefined();
  });

  it("returns indeterminate when MakeRefund 2xx is missing RefundId", async () => {
    const { queue } = refundQueue();
    queue[2] = jsonResponse(myfatoorahEnvelope({}));
    const gateway = createGateway(queue, []);
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-2",
    });
    expect(result.outcome).toBe("indeterminate");
  });

  it("rejects missing idempotencyKey without fetching", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(gateway.refundPayment({ gatewayPaymentId: "915102" })).rejects.toThrow(
      InvalidRequestError,
    );
    expect(calls.length).toBe(0);
  });

  it("rejects PaymentId-shaped gatewayPaymentId unless myfatoorahKeyType is PaymentId", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "07076409988323998875",
        idempotencyKey: "refund-payid-1",
      }),
    ).rejects.toThrow(/PaymentId/);
    expect(calls.length).toBe(0);
  });

  it("refunds with KeyType PaymentId when requested", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse(myfatoorahEnvelope(partialRefundStatusData())),
        jsonResponse(myfatoorahEnvelope(makeRefundData())),
      ],
      calls,
    );
    await gateway.refundPayment({
      gatewayPaymentId: "07076409988323998875",
      idempotencyKey: "refund-payid-2",
      myfatoorahKeyType: "PaymentId",
    });
    expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v2/GetPaymentStatus");
    expect(bodyOf(calls[0])).toEqual({
      Key: "07076409988323998875",
      KeyType: "PaymentId",
    });
    expect(calls[1]?.url).toBe("https://apitest.myfatoorah.com/v2/GetRefundStatus");
    expect(bodyOf(calls[1])).toEqual({ KeyType: "InvoiceId", Key: "915102" });
    expect(bodyOf(calls[2]).KeyType).toBe("PaymentId");
    expect(bodyOf(calls[2]).Key).toBe("07076409988323998875");
  });

  it("throws on an unparseable refund list even with an explicit amount", async () => {
    const refundStatus = {
      Refunds: [{ RefundId: 22201, RefundStatus: "Refunded" }],
    };
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(refundStatus)),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
      ],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-idem-2",
        amount: money("3.000", "KWD"),
        currency: "KWD",
      }),
    ).rejects.toThrow(InvalidRequestError);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("throws on a GetRefundStatus 500 instead of returning indeterminate", async () => {
    const calls: FetchCall[] = [];
    const queue: (Response | Error)[] = [];
    for (let i = 0; i < 3; i += 1) {
      queue.push(jsonResponse({ IsSuccess: false, Message: "boom" }, 500));
    }
    queue.push(jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())));
    const gateway = createGateway(queue, calls);
    let caught: unknown;
    try {
      await gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-idem-2",
      });
      expect.unreachable("must throw");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as NetworkError).afterProviderSubmit).toBe(false);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("fails closed on a first refund whose currency is not the account base (MF-CRIT-1)", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope({ RefundStatusResult: [] })),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
      ],
      calls,
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "refund-idem-3",
        amount: money("50", "SAR"),
        currency: "SAR",
      }),
    ).rejects.toThrow(/base currency/);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("does not treat GetRefundStatus Data array as empty history", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({
          IsSuccess: true,
          Message: "",
          ValidationErrors: null,
          Data: [
            {
              RefundId: 22201,
              ExternalIdentifier: "refund-array-1",
              Amount: 0.25,
              RefundStatus: "Pending",
              BaseCurrency: "KWD",
            },
          ],
        }),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse(myfatoorahEnvelope(makeRefundData())),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-array-1",
      currency: "KWD",
    });
    expect(result.gatewayRefundId).toBe("22201");
    expect(result.status).toBe("pending");
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });
  it("treats GetRefundStatus 2xx official not-found Message as empty history", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({
          IsSuccess: false,
          Message: "No data matches this Key",
          ValidationErrors: null,
          Data: null,
        }),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse(myfatoorahEnvelope(makeRefundData())),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-nf-empty",
      currency: "KWD",
    });
    expect(result.status).toBe("pending");
    expect(calls.map((c) => c.url)).toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("treats a GetRefundStatus 2xx without Data as empty history (MF-CRIT-3)", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: true, Message: "", ValidationErrors: null, Data: null }),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse(myfatoorahEnvelope(makeRefundData())),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-3",
      currency: "KWD",
    });
    expect(result.status).toBe("pending");
    expect(calls.map((c) => c.url)).toContain("https://apitest.myfatoorah.com/v2/MakeRefund");
  });

  it("infers the account base currency on a first refund without explicit currency", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope({ RefundStatusResult: [] })),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse(myfatoorahEnvelope(makeRefundData())),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-3",
    });
    expect(result.status).toBe("pending");
    const makeRefundBody = bodyOf(calls[2]);
    expect(makeRefundBody.Amount).toBe(0.85); // InvoiceValue 0.85 KWD base (not SAR 10.5 pay) in inferred KWD
  });
});

describe("MyFatoorahGateway.capturePayment / webhooks", () => {
  it("capturePayment throws OperationNotSupportedError with the authorization capability", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway([], calls);
    await expect(gateway.capturePayment({ gatewayPaymentId: "915102" })).rejects.toThrow(
      OperationNotSupportedError,
    );
    expect(calls.length).toBe(0);
  });

  it("parses a payment webhook into a paid event with related paymentId", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent(paymentWebhook());
    expect(event.gateway).toBe("myfatoorah");
    expect(event.gatewayPaymentId).toBe("6409988");
    expect(event.paymentId).toBe("asdqwd-f13sdf-fasjkz");
    expect(event.status).toBe("paid");
    expect(event.stableType).toBe("payment.succeeded");
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.amount).toEqual(money(500, "KWD"));
    expect(event.currency).toBe("KWD");
    expect(
      (event.event as { payment?: { references?: { relatedIds?: Record<string, unknown> } } })
        ?.payment?.references?.relatedIds?.paymentId,
    ).toBe("07076409988323998875");
  });

  it("parses a refund webhook into a refunded event with money and invoice identity", () => {
    const gateway = createGateway([], []);
    const event = gateway.parseWebhookEvent(refundWebhook());
    expect(event.gateway).toBe("myfatoorah");
    expect(event.gatewayPaymentId).toBe("5620277");
    expect(event.gatewayObjectId).toBe("111147");
    expect(event.status).toBe("refunded");
    expect(event.stableType).toBe("refund.completed");
    expect(event.amount).toEqual(money(30, "KWD"));
    expect(event.currency).toBe("KWD");
    expect(event.type).toBe("refund.REFUNDED");
  });
  it("does not map refund paymentId from Refund.ExternalIdentifier (MF-HIGH-5)", () => {
    const gateway = createGateway([], []);
    const payload = refundWebhook();
    payload.Data.Refund = { Id: 111147, Status: "REFUNDED", ExternalIdentifier: "refund-idem-1" };
    payload.Data.ReferencedInvoice = { Id: 5620277 };
    const event = gateway.parseWebhookEvent(payload);
    expect(event.paymentId).toBeUndefined();
    expect(event.gatewayObjectId).toBe("111147");
  });
  it("normalizes the KD webhook currency alias to KWD (MF-MED-2)", () => {
    const gateway = createGateway([], []);
    const payload = paymentWebhook();
    payload.Data.Amount = {
      BaseCurrency: "KD",
      ValueInBaseCurrency: 100,
      DisplayCurrency: "KD",
      ValueInDisplayCurrency: 100,
    };
    const event = gateway.parseWebhookEvent(payload);
    expect(event.amount).toEqual(money(100, "KWD"));
    expect(event.currency).toBe("KWD");
  });
});

describe("MyFatoorahGateway MF fixes", () => {
  it("MF-CREATE-REPLAY: ARE country with orderId existing → no POST /v3/payments", async () => {
    const calls: FetchCall[] = [];
    const existing = paidInvoiceStatusData({
      InvoiceId: 777777,
      InvoiceStatus: "Paid",
      InvoiceValue: 10.5,
      Transactions: [
        {
          TransactionStatus: "Succss",
          PaymentId: "07076409988323998877",
          PaidCurrency: "SAR",
          PaidCurrencyValue: "10.50",
          Currency: "SAR",
          TransationValue: "10.50",
        },
      ],
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(existing))], calls, {
      country: "ARE",
    });
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_123",
      myfatoorahCustomer: { reference: "ord_replay_123" },
    });
    expect(result.gatewayId).toBe("777777");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v2/GetPaymentStatus");
    expect(bodyOf(calls[0])).toEqual({ Key: "ord_replay_123", KeyType: "CustomerReference" });
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("KWT create with orderId does not preflight CustomerReference (header dedupes)", async () => {
    // I5 hardening: KWT/SAU best-effort reuse of Paid matching invoice does a
    // GetPaymentStatus preflight but never blocks creation. For a new orderId
    // the lookup is 404 and we still POST /v3/payments with Idempotency-Key.
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "Not found" }, 404),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "KWT" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_kwt_1",
    });
    expect(result.outcome).toBe("requires_action");
    expect(calls.map((c) => c.url)).toEqual([
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
      "https://apitest.myfatoorah.com/v3/payments",
    ]);
    expect(bodyOf(calls[1]).Customer).toEqual({ Reference: "ord_kwt_1" });
  });

  it("MF-CREATE-REPLAY: ARE Pending invoice does not POST a second payment", async () => {
    const calls: FetchCall[] = [];
    const existing = paidInvoiceStatusData({
      InvoiceId: 777778,
      InvoiceStatus: "Pending",
      InvoiceValue: 10.5,
      Transactions: [],
    });
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(existing)),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_pending",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
    ]);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE Paid invoice with a different amount is not reused", async () => {
    const calls: FetchCall[] = [];
    const existing = paidInvoiceStatusData({
      InvoiceId: 777777,
      InvoiceStatus: "Paid",
      InvoiceValue: 1.5,
      Transactions: [
        {
          TransactionStatus: "Succss",
          PaymentId: "07076409988323998877",
          PaidCurrency: "SAR",
          PaidCurrencyValue: "1.50",
          Currency: "SAR",
          TransationValue: "1.50",
        },
      ],
    });
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(existing)),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_amount",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
    ]);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE inquiry 5xx does not POST a second payment", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "boom" }, 500),
        jsonResponse({ IsSuccess: false, Message: "boom" }, 500),
        jsonResponse({ IsSuccess: false, Message: "boom" }, 500),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_5xx",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE lookup 400 does not POST a second payment", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(
          {
            IsSuccess: false,
            Message: "Validation Error",
            ValidationErrors: [{ Name: "KeyType", Error: "KeyType is invalid" }],
          },
          400,
        ),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_400",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE country with orderId present but not found → POSTs /v3/payments", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "Not found" }, 404),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_new_456",
    });
    expect(result.outcome).toBe("requires_action");
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v2/GetPaymentStatus");
    expect(calls[1]?.url).toBe("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE 200 IsSuccess false official not-found Message creates once", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({
          IsSuccess: false,
          Message: "No data matches this Key",
          ValidationErrors: null,
          Data: null,
        }),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_new_200_nf",
    });
    expect(result.outcome).toBe("requires_action");
    expect(calls.map((c) => c.url)).toEqual([
      "https://apitest.myfatoorah.com/v2/GetPaymentStatus",
      "https://apitest.myfatoorah.com/v3/payments",
    ]);
  });

  it("MF-CREATE-REPLAY: ARE 200 IsSuccess false generic Message fails closed", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({
          IsSuccess: false,
          Message: "",
          ValidationErrors: null,
          Data: null,
        }),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_unknown_false",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE success envelope with null Data fails closed", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: true, Message: "", ValidationErrors: null, Data: null }),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_empty_data",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE pending invoice returns indeterminate with InvoiceId", async () => {
    const calls: FetchCall[] = [];
    const existing = paidInvoiceStatusData({
      InvoiceId: 777778,
      InvoiceStatus: "Pending",
      InvoiceValue: 10.5,
      Transactions: [],
    });
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(existing)),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.createPayment({
      ...createParams,
      orderId: "ord_replay_pending_id",
    });
    expect(isIndeterminateOutcome(result)).toBe(true);
    expect(result.gatewayId).toBe("777778");
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });

  it("MF-CREATE-REPLAY: ARE lookup 429 surfaces RateLimitError (not indeterminate)", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
      ],
      calls,
      { country: "ARE" },
    );
    await expect(
      gateway.createPayment({
        ...createParams,
        orderId: "ord_replay_429_lookup",
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls.map((c) => c.url)).not.toContain("https://apitest.myfatoorah.com/v3/payments");
  });
  for (const status of ["Canceled", "Cancelled", "Failed", "Expired"] as const) {
    it(`MF-CREATE-REPLAY: ARE ${status} invoice allows new POST`, async () => {
      const calls: FetchCall[] = [];
      const existing = paidInvoiceStatusData({
        InvoiceId: 777779,
        InvoiceStatus: status,
        InvoiceValue: 10.5,
        Transactions: [],
      });
      const gateway = createGateway(
        [jsonResponse(myfatoorahEnvelope(existing)), jsonResponse(myfatoorahEnvelope(initiatedCreateData()))],
        calls,
        { country: "ARE" },
      );
      const result = await gateway.createPayment({
        ...createParams,
        orderId: `ord_replay_canceled_${status}`,
      });
      expect(result.outcome).toBe("requires_action");
      expect(calls.length).toBe(2);
      expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v2/GetPaymentStatus");
      expect(calls[1]?.url).toBe("https://apitest.myfatoorah.com/v3/payments");
    });
  }

  it("unkeyed ARE create does not retry 429 on /v3/payments", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse({ IsSuccess: false, Message: "Not found" }, 404),
        jsonResponse({ IsSuccess: false, Message: "rate limited" }, 429),
        jsonResponse(myfatoorahEnvelope(initiatedCreateData())),
      ],
      calls,
      { country: "ARE" },
    );
    await expect(
      gateway.createPayment({
        ...createParams,
        orderId: "ord_are_429",
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls.filter((c) => c.url.endsWith("/v3/payments")).length).toBe(1);
  });
describe("myfatoorah PaymentCompleted string handling (I7) and isPaidOutcome amount-optional (I8)", () => {
  it("accepts string \"true\" (case-insensitive, trimmed) as paid via PaymentCompleted", async () => {
    for (const raw of ["true", " True ", "TRUE", " true "] as const) {
      const calls: FetchCall[] = [];
      const data = paidCreateData({ PaymentCompleted: raw });
      const gw = createGateway([jsonResponse(myfatoorahEnvelope(data))], calls);
      const result = await gw.createPayment({ ...createParams });
      expect(isPaidOutcome(result)).toBe(true);
      expect(result.status).toBe("paid");
    }
    // string "false" must not be treated as paid
    {
      const calls: FetchCall[] = [];
      const data = paidCreateData({
        PaymentCompleted: "false",
        PaymentURL: "https://sandbox.pg.apitest.myfatoorah.com/Checkout/Gateway/915102/redirect",
      });
      // When not paid, gateway expects redirect; provide PaymentURL to avoid indeterminate
      const gw = createGateway([jsonResponse(myfatoorahEnvelope(data))], calls);
      const result = await gw.createPayment({ ...createParams });
      expect(isPaidOutcome(result)).toBe(false);
      expect(result.status).toBe("pending");
    }
  });

  it("PaymentCompleted true with no matching ValueIn* omits amount but still paid (I8)", async () => {
    const calls: FetchCall[] = [];
    // Request SAR but only KWD base present — amount must be omitted to avoid KWD-as-SAR drift
    const data = paidCreateData({
      TransactionDetails: {
        Invoice: { Status: "PAID" },
        Transaction: { Status: "SUCCESS", PaymentId: "07076409988323998875" },
        Amount: {
          BaseCurrency: "KWD",
          ValueInBaseCurrency: 64.772,
          DisplayCurrency: "KWD",
          ValueInDisplayCurrency: 64.772,
          // no PayCurrency SAR at all
        },
      },
    });
    const gw = createGateway([jsonResponse(myfatoorahEnvelope(data))], calls);
    const result = await gw.createPayment({ ...createParams }); // createParams currency SAR
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.status).toBe("paid");
    expect(result.amount).toBeUndefined();
    expect(result.currency).toBeUndefined();
    // Same with completely empty Amount (no currencies) — still paid, no amount
    const calls2: FetchCall[] = [];
    const data2 = paidCreateData({
      TransactionDetails: {
        Invoice: { Status: "PAID" },
        Transaction: { Status: "SUCCESS" },
        Amount: {},
      },
    });
    const gw2 = createGateway([jsonResponse(myfatoorahEnvelope(data2))], calls2);
    const result2 = await gw2.createPayment({ ...createParams });
    expect(isPaidOutcome(result2)).toBe(true);
    expect(result2.status).toBe("paid");
    expect(result2.amount).toBeUndefined();
  });
});


  it("MF-SANDBOX-BASE: ARE sandbox first refund without currency infers KWD and posts MakeRefund", async () => {
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope({ RefundStatusResult: [] })),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
        jsonResponse(myfatoorahEnvelope(makeRefundData())),
      ],
      calls,
      { country: "ARE" },
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "sandbox-base-1",
    });
    expect(result.status).toBe("pending");
    expect(bodyOf(calls[2]).Amount).toBe(0.85); // InvoiceValue 0.85 KWD base (not AED) — sandbox always KWD
  });

  it("MF-SANDBOX-BASE: ARE sandbox rejects an AED refund amount (base is KWD)", async () => {
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope({ RefundStatusResult: [] })),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData())),
      ],
      [],
      { country: "ARE" },
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "sandbox-base-2",
        amount: money("1.00", "AED"),
        currency: "AED",
      }),
    ).rejects.toThrow(/base currency.*KWD/);
  });

  it("MF-SANDBOX-BASE: ARE live rejects a KWD refund amount (base is AED)", async () => {
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope({ RefundStatusResult: [] })),
        jsonResponse(myfatoorahEnvelope(paidInvoiceStatusData({ InvoiceValue: 100 }))),
      ],
      [],
      { country: "ARE", live: true },
    );
    await expect(
      gateway.refundPayment({
        gatewayPaymentId: "915102",
        idempotencyKey: "live-base-1",
        amount: money("1.00", "KWD"),
        currency: "KWD",
      }),
    ).rejects.toThrow(/base currency.*AED/);
  });

  it("MF-GETPAYMENT-BASE-MIX: InvoiceValue 64.772 base with SAR transaction → publishes KWD or omits, never 64.772 SAR", async () => {
    const data = paidInvoiceStatusData({
      InvoiceValue: 64.772,
      InvoiceStatus: "Paid",
      Transactions: [
        {
          TransactionStatus: "Succss",
          PaymentId: "t_sar",
          Currency: "SAR",
          TransationValue: undefined,
          PaidCurrency: undefined,
          PaidCurrencyValue: undefined,
        },
      ],
    });
    (data as Record<string, unknown>).InvoiceTransactions = data.Transactions;
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    const isWrongPair =
      result.currency === "SAR" &&
      result.amount !== undefined &&
      result.amount.amount === money(64.772, "KWD").amount;
    expect(isWrongPair).toBe(false);
    if (result.amount !== undefined && result.currency !== undefined) {
      expect(result.currency).toBe("KWD");
      expect(result.amount).toEqual(money(64.772, "KWD"));
    } else {
      expect(result.amount).toBeUndefined();
    }
  });

  it("MF-CREATE-AMOUNT-FALLBACK: bare Value fallback not used as request currency", async () => {
    const paid = paidCreateData({
      TransactionDetails: {
        Invoice: { Status: "PAID" },
        Transaction: { Status: "SUCCESS", PaymentId: "07076409988323998875" },
        Amount: {
          BaseCurrency: "KWD",
          ValueInBaseCurrency: 64.772,
          DisplayCurrency: "KWD",
          ValueInDisplayCurrency: 64.772,
          Value: 999,
        } as unknown as Record<string, unknown>,
      },
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(paid))], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.amount).toBeUndefined();
    expect(result.currency).toBeUndefined();
  });

  it("MF-PAYMENTCOMPLETED-REDIRECT: PaymentCompleted true without nested statuses → paid, not requires_action", async () => {
    const paid = {
      InvoiceId: 915102,
      PaymentCompleted: true,
      PaymentURL:
        "https://sandbox.pg.apitest.myfatoorah.com/payment/result?invoice=915102&result=paid",
      CustomerReference: "payref1",
      UserDefinedField: "order_01",
      PaymentId: "07076409988323998875",
      TransactionDetails: {},
    };
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(paid))], []);
    const result = await gateway.createPayment({ ...createParams });
    expect(isPaidOutcome(result)).toBe(true);
    expect(result.status).toBe("paid");
    expect(result.outcome).toBe("succeeded");
    expect(result.redirectUrl).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it("lower: picks last success transaction not first", async () => {
    const data = paidInvoiceStatusData({
      Transactions: [
        {
          TransactionStatus: "Succss",
          PaymentId: "first_111",
          Currency: "SAR",
          PaidCurrency: "SAR",
          PaidCurrencyValue: "10.00",
        },
        {
          TransactionStatus: "Succss",
          PaymentId: "last_999",
          Currency: "SAR",
          PaidCurrency: "SAR",
          PaidCurrencyValue: "20.00",
        },
      ],
    });
    const gateway = createGateway([jsonResponse(myfatoorahEnvelope(data))], []);
    const result = await gateway.getPayment({ gatewayPaymentId: "915102" });
    expect(result.references?.relatedIds?.paymentId).toBe("last_999");
    expect(result.amount).toEqual(money(20, "SAR"));
    expect(result.currency).toBe("SAR");
  });
  it("lower: existingRefund found doesn't await paymentStatus (survives 500)", async () => {
    const refundStatus = partialRefundStatusData({
      Refunds: [
        {
          RefundId: 22201,
          ExternalIdentifier: "refund-idem-survives",
          InvoiceId: 915102,
          Amount: 0.25,
          RefundStatus: "Pending",
        },
      ],
    });
    const calls: FetchCall[] = [];
    const gateway = createGateway(
      [
        jsonResponse(myfatoorahEnvelope(refundStatus)),
        jsonResponse({ IsSuccess: false, Message: "boom" }, 500),
        jsonResponse({ IsSuccess: false, Message: "boom" }, 500),
        jsonResponse({ IsSuccess: false, Message: "boom" }, 500),
      ],
      calls,
    );
    const result = await gateway.refundPayment({
      gatewayPaymentId: "915102",
      idempotencyKey: "refund-idem-survives",
    });
    expect(result.gatewayRefundId).toBe("22201");
    expect(result.status).toBe("pending");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://apitest.myfatoorah.com/v2/GetRefundStatus");
  });
});
