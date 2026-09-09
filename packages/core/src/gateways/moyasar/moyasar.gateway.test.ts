import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HooksManager } from "../../hooks/hooks.manager";
import {
  AuthenticationError,
  CardDeclinedError,
  GatewayApiError,
  InvalidRequestError,
  InvalidWebhookError,
  NetworkError,
  PaymentAbortedError,
  RateLimitError,
  ResourceNotFoundError,
} from "../../errors";
import type { PaymentHooks } from "../../hooks/hooks.types";
import type { MoyasarConfig } from "../../types/config.types";
import {
  assertNoSecretsInEnvelope,
  hashWebhookPayload,
  toPersistedPaymentEventEnvelope,
} from "../../types/payment-event";
import { isPaidOutcome, mapGatewayResultToOperationResult } from "../../types/operation-result";
import { MoyasarGateway } from "./moyasar.gateway";
import { InMemoryIdempotencyStore } from "../../utils/idempotency";
import { money, isMoney, type Money } from "../../utils/money";

function majorFromMoney(value: unknown): unknown {
  return isMoney(value) ? Number((value as Money).amount) : value;
}
const CONFIG: MoyasarConfig = {
  secretKey: "sk_test_unit",
  webhookSecret: "webhook_secret",
};

const PAYMENT_ID = "760878ec-d1d3-5f72-9056-191683f55872";
const MISSING_PAYMENT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const originalFetch = globalThis.fetch;

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

const DEFAULT_MUTATION_IDEMPOTENCY_KEY =
  "a1168bd1-47a4-4b97-8a50-dd5caaccacf2";

function createGateway(
  config: MoyasarConfig = CONFIG,
  hooks: PaymentHooks = {},
): MoyasarGateway {
  // MOYASAR-1/2: mutations require store + key; tests default to atomic in-memory store.
  const withStore: MoyasarConfig = {
    idempotencyStore: new InMemoryIdempotencyStore(),
    ...config,
  };
  return new MoyasarGateway(withStore, new HooksManager(hooks));
}

function paymentResponse(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: PAYMENT_ID,
    status: "paid",
    amount: 10000,
    fee: 250,
    currency: "SAR",
    refunded: 0,
    captured: 10000,
    amount_format: "100.00 SAR",
    fee_format: "2.50 SAR",
    refunded_format: "0.00 SAR",
    captured_format: "100.00 SAR",
    ip: "127.0.0.1",
    created_at: "2026-05-21T10:00:00Z",
    updated_at: "2026-05-21T10:00:00Z",
    refunded_at: null,
    captured_at: "2026-05-21T10:00:00Z",
    voided_at: null,
    description: "Payment",
    invoice_id: null,
    callback_url: "https://example.com/callback",
    metadata: {},
    source: {
      type: "token",
      transaction_url: null,
    },
    ...overrides,
  };
}

function mockFetchJson(body: unknown, status = 200): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function mockFetchError(error: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    throw error;
  }) as typeof fetch;
}

function mockFetchSequence(
  ...responses: Array<{ body: unknown; status?: number } | Error>
): void {
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    const next = responses[index++];
    if (next === undefined) {
      throw new Error("Unexpected fetch call");
    }
    if (next instanceof Error) {
      throw next;
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function lastRequestBody(): Record<string, any> {
  const body = fetchCalls.at(-1)?.init?.body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string);
}

function lastRequestBodyOrUndefined(): unknown {
  const body = fetchCalls.at(-1)?.init?.body;
  return typeof body === "string" ? JSON.parse(body) : undefined;
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MoyasarGateway", () => {
  describe("createPayment", () => {
    it("maps capture false to Moyasar source.manual for token payments", async () => {
      mockFetchJson(paymentResponse({ status: "authorized", captured: 0 }));

      await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        capture: false,
        moyasarSource: {
          type: "token",
          token: "token_test_123",
        },
      });

      const body = lastRequestBody();
      expect(majorFromMoney(body.amount)).toBe(10000);
      expect(body.callback_url).toBe("https://example.com/callback");
      expect(body.source).toEqual({
        type: "token",
        token: "token_test_123",
        manual: true,
      });
    });

    it("rejects raw credit card sources before sending cardholder data to the backend API", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          callbackUrl: "https://example.com/callback",
          moyasarSource: {
            type: "creditcard",
            name: "Saleh Ali",
            number: "4111111111111111",
            month: 12,
            year: 2029,
            cvc: "123",
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("lets manualCapture override capture false", async () => {
      mockFetchJson(paymentResponse());

      await createGateway().createPayment({
        amount: money("50", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        capture: false,
        moyasarSource: {
          type: "token",
          token: "token_test_123",
          manualCapture: false,
        },
      });

      expect(lastRequestBody().source.manual).toBe(false);
    });

    it("requires callbackUrl for token payments", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("10", "SAR"),
          currency: "SAR",
          moyasarSource: {
            type: "token",
            token: "token_test_123",
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("requires a Moyasar source before making an API request", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("10", "SAR"),
          currency: "SAR",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("marks API-successful failed payments as unsuccessful", async () => {
      mockFetchJson(
        paymentResponse({
          status: "failed",
          source: {
            type: "token",
            message: "Declined",
            transaction_url: null,
          },
        }),
        201,
      );

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: {
          type: "token",
          token: "token_test_123",
        },
      });

      expect(result.outcome).not.toBe("succeeded");
      expect(result.status).toBe("failed");
      expect(result.outcome).toBe("declined");
      expect(result.references?.providerObjectId).toBe(result.gatewayId);
      expect(result.decline?.message).toBe("Declined");
    });

    it("marks unmapped provider statuses as unsuccessful (success false)", async () => {
      const warnings: string[] = [];
      const logger = {
        debug() {},
        info() {},
        warn: (message: string) => warnings.push(message),
        error() {},
      };
      mockFetchJson(
        paymentResponse({
          status: "totally_unknown_status",
        }),
        201,
      );

      const result = await new MoyasarGateway(
        CONFIG,
        new HooksManager(),
        logger,
      ).createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: {
          type: "token",
          token: "token_test_123",
        },
      });

      expect(result.outcome).not.toBe("succeeded");
      expect(result.status).toBe("failed");
      expect(warnings.some((w) => w.includes("Unmapped payment status"))).toBe(
        true,
      );
    });

    it("marks abandoned payments as unsuccessful", async () => {
      mockFetchJson(
        paymentResponse({
          status: "abandoned",
        }),
        201,
      );

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: {
          type: "token",
          token: "token_test_123",
        },
      });

      expect(result.outcome).not.toBe("succeeded");
      expect(result.status).toBe("failed");
    });

    it("does not require callbackUrl for STC Pay and returns OTP nextAction", async () => {
      mockFetchJson(
        paymentResponse({
          status: "initiated",
          captured: 0,
          source: {
            type: "stcpay",
            transaction_url: "https://api.moyasar.com/stc/otp",
          },
        }),
      );

      const result = await createGateway().createPayment({
        amount: money("75", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "stcpay",
          mobile: "0512345678",
        },
      });

      const body = lastRequestBody();
      expect(body.callback_url).toBeUndefined();
      expect(result.redirectUrl).toBeUndefined();
      expect(result.nextAction).toEqual({
        type: "stcpay_otp",
        transactionUrl: "https://api.moyasar.com/stc/otp",
        method: "POST",
        parameter: "otp_value",
      });
      // Phase 6: OTP challenge is requires_action, never succeeded
      expect(result.outcome).toBe("requires_action");
      expect(result.outcome).not.toBe("succeeded");
      expect(result.references?.providerObjectId).toBe(result.gatewayId);
      expect(result.references?.providerNativeStatus).toBe("initiated");
    });

    it("accepts Moyasar's documented local STC Pay mobile number without plus prefix", async () => {
      mockFetchJson(
        paymentResponse({
          status: "initiated",
          captured: 0,
          source: {
            type: "stcpay",
            transaction_url: "https://api.moyasar.com/stc/otp",
          },
        }),
      );

      await createGateway().createPayment({
        amount: money("75", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "stcpay",
          mobile: "966512345678",
        },
      });

      expect(lastRequestBody().source.mobile).toBe("966512345678");
    });

    it("rejects metadata that cannot be represented safely in Moyasar metadata", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          moyasarSource: {
            type: "stcpay",
            mobile: "0512345678",
          },
          metadata: {
            nested: { id: "not-supported" },
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects non-string metadata values before sending the request", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          moyasarSource: {
            type: "stcpay",
            mobile: "0512345678",
          },
          metadata: {
            customerId: 123,
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("validates final metadata after adding order correlation keys", async () => {
      const metadata: Record<string, string> = {};
      for (let index = 0; index < 29; index += 1) {
        metadata[`key${index}`] = `value${index}`;
      }

      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          orderId: "order_123",
          moyasarSource: {
            type: "stcpay",
            mobile: "0512345678",
          },
          metadata,
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("uses currency minor units for create response mapping", async () => {
      mockFetchJson(
        paymentResponse({
          amount: 1234,
          fee: 12,
          captured: 1234,
          refunded: 0,
          currency: "KWD",
        }),
      );

      const result = await createGateway().createPayment({
        amount: money("1.234", "KWD"),
        currency: "KWD",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      expect(lastRequestBody().amount).toBe(1234);
      expect(majorFromMoney(result.amount)).toBe(1.234);
      expect(majorFromMoney(result.fee)).toBe(0.012);
      expect(majorFromMoney(result.capturedAmount)).toBe(1.234);
      // MOYASAR-1: currency travels with major-unit money fields
      expect(result.currency).toBe("KWD");
    });

    it("fail-closes non-finite amount after 2xx without inventing paid 0 (MOYASAR-1)", async () => {
      mockFetchJson(
        paymentResponse({
          amount: Number.NaN,
          fee: 250,
          captured: Number.NaN,
          refunded: 0,
          currency: "SAR",
        }),
      );

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      // Incomplete amount must not throw post-create (retry could double-charge).
      // Paid-like + missing amount demotes; omit coerced-0 majors (MOYASAR-1).
      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(isPaidOutcome(result)).toBe(false);
      expect(result.amount).toBeUndefined();
      expect(result.capturedAmount).toBeUndefined();
      expect(majorFromMoney(result.fee)).toBe(2.5);
      expect(majorFromMoney(result.refundedAmount)).toBe(0);
      expect(result.currency).toBe("SAR");
    });

    it("fail-closes currency-stripped paid after 2xx (MOYASAR-1 incomplete money)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          fee: 250,
          captured: 10000,
          currency: "",
        }),
      );

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      // Currency-stripped paid must not keep isPaidOutcome (same class as
      // missing amount). No major-unit money fields without currency.
      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(isPaidOutcome(result)).toBe(false);
      expect(result.currency).toBeUndefined();
      expect(result.amount).toBeUndefined();
      expect(result.fee).toBeUndefined();
      expect(result.capturedAmount).toBeUndefined();
      expect(result.refundedAmount).toBeUndefined();
    });

    it("fail-closes missing currency on paid getPayment (MOYASAR-1)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: 10000,
          currency: "   ",
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("processing");
      expect(isPaidOutcome(result)).toBe(false);
      expect(result.currency).toBeUndefined();
      expect(result.amount).toBeUndefined();
    });

    it("fail-closes paid/captured family without a finite captured total (P610-MOY-2)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: undefined,
        }),
      );

      const missing = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      expect(missing.status).toBe("processing");
      expect(missing.status).not.toBe("paid");
      expect(isPaidOutcome(missing)).toBe(false);

      mockFetchJson(
        paymentResponse({
          status: "captured",
          amount: 10000,
          captured: Number.NaN,
        }),
      );

      const nonFinite = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(nonFinite.status).toBe("processing");
      expect(nonFinite.status).not.toBe("paid");
      expect(isPaidOutcome(nonFinite)).toBe(false);
    });

    it("fail-closes paid + finite captured 0 (MOYASAR-CAP-0)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: 0,
        }),
      );

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(isPaidOutcome(result)).toBe(false);
      expect(result.outcome).not.toBe("succeeded");
      expect(result.currency).toBe("SAR");
      expect(majorFromMoney(result.amount)).toBe(100);
      // Known captured 0 — do not invent the authorization total as captured.
      expect(majorFromMoney(result.capturedAmount)).toBe(0);
    });

    it("fail-closes provider captured + finite captured 0 on getPayment (MOYASAR-CAP-0)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "captured",
          amount: 10000,
          captured: 0,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("processing");
      expect(result.status).not.toBe("paid");
      expect(isPaidOutcome(result)).toBe(false);
      expect(majorFromMoney(result.capturedAmount)).toBe(0);
      expect(result.currency).toBe("SAR");
    });

    it("accepts Money amount input for createPayment (bigint minor conversion)", async () => {
      mockFetchJson(paymentResponse({ amount: 1050, currency: "SAR" }));

      const result = await createGateway().createPayment({
        amount: money("10.50", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      expect(lastRequestBody().amount).toBe(1050);
      expect(majorFromMoney(result.amount)).toBe(10.5);
    });

    it("keeps Money.exponent through Zod so OMR override is 2012 not 20120 (P05-MONEY-1)", async () => {
      mockFetchJson(
        paymentResponse({
          amount: 2012,
          fee: 0,
          captured: 2012,
          refunded: 0,
          currency: "OMR",
        }),
      );

      await createGateway().createPayment({
        amount: money("20.12", "OMR", { exponentOverrides: { OMR: 2 } }),
        currency: "OMR",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      expect(lastRequestBody().amount).toBe(2012);
      expect(lastRequestBody().amount).not.toBe(20120);
    });

    it("rejects Money amounts with excess currency precision", async () => {
      await expect(
        createGateway().createPayment({
          // Money-shaped input (not pre-validated by money()) so gateway conversion rejects.
          amount: { amount: "10.999", currency: "SAR" },
          currency: "SAR",
          moyasarSource: {
            type: "applepay",
            token: "encrypted_token",
          },
        }),
      ).rejects.toThrow(InvalidRequestError);
      expect(fetchCalls).toHaveLength(0);
    });

    it("maps decrypted Apple Pay fields to Moyasar API names", async () => {
      mockFetchJson(paymentResponse());

      await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "applepay",
          dpan: "4111111111111111",
          month: 12,
          year: 2029,
          cryptogram: "cryptogram",
          deviceId: "device123",
          lastFour: "1111",
          eci: "05",
        },
      });

      expect(lastRequestBody().source).toEqual({
        type: "applepay",
        number: "4111111111111111",
        month: 12,
        year: 2029,
        cryptogram: "cryptogram",
        device_id: "device123",
        last_four: "1111",
        eci: "05",
      });
    });

    it("rejects invalid Apple Pay shape with InvalidRequestError (not GatewayApiError)", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          moyasarSource: {
            type: "applepay",
            // Neither encrypted token nor decrypted DPAN fields
          } as any,
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects capture:false for decrypted Apple Pay (DPAN) sources", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          capture: false,
          moyasarSource: {
            type: "applepay",
            dpan: "4111111111111111",
            month: 12,
            year: 2029,
            cryptogram: "cryptogram",
            deviceId: "device123",
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects capture:false for STC Pay sources", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          capture: false,
          moyasarSource: {
            type: "stcpay",
            mobile: "0512345678",
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("uppercases currency on create payment requests", async () => {
      mockFetchJson(paymentResponse());

      await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "sar",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      expect(lastRequestBody().currency).toBe("SAR");
    });

    it("converts split amounts from major units to Moyasar minor units", async () => {
      mockFetchJson(paymentResponse());

      await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        idempotencyKey: "a1168bd1-47a4-4b97-8a50-dd5caaccacf2",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
        splits: [
          {
            amount: money("50", "SAR"), // major units → 5000 halalas
            recipient_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            reference: "split_1",
            fee_source: true,
          },
        ],
        recipient: {
          first_name: "Saleh",
          last_name: "Ali",
          address: "Riyadh",
        },
        sender: {
          account: {
            funds_source: "01",
            number: "123456789",
          },
          first_name: "Sara",
          last_name: "Ali",
          address: "Riyadh",
          country_code: "SA",
          id_type: "NTID",
          id: "1234567890",
          phone_number: "0512345678",
        },
      });

      const body = lastRequestBody();
      expect(body.given_id).toBe("a1168bd1-47a4-4b97-8a50-dd5caaccacf2");
      expect(body.splits).toEqual([
        {
          amount: 5000,
          recipient_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          reference: "split_1",
          fee_source: true,
        },
      ]);
      expect(body.recipient.first_name).toBe("Saleh");
      expect(body.sender.account.funds_source).toBe("01");
    });

    it("converts negative split amounts to minor units when reverse splits are used", async () => {
      mockFetchJson(paymentResponse());

      await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
        splits: [
          {
            amount: money("120", "SAR"),
            recipient_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          },
          {
            amount: money("-20", "SAR", { allowNegative: true }),
            recipient_id: "4fa85f64-5717-4562-b3fc-2c963f66afa6",
          },
        ],
      });

      expect(lastRequestBody().splits.map((s: { amount: number }) => s.amount)).toEqual([
        12000,
        -2000,
      ]);
    });

    it("copies orderId into Moyasar metadata for webhook correlation", async () => {
      mockFetchJson(paymentResponse());

      await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        orderId: "order_123",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
        metadata: {
          customerId: "customer_456",
        },
      });

      expect(lastRequestBody().metadata).toEqual({
        customerId: "customer_456",
        orderId: "order_123",
        paymentId: "order_123",
      });
    });

    it("does not overwrite explicit metadata order correlation fields", async () => {
      mockFetchJson(paymentResponse());

      await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        orderId: "order_123",
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
        metadata: {
          orderId: "external_order",
          paymentId: "payment_789",
        },
      });

      expect(lastRequestBody().metadata).toEqual({
        orderId: "external_order",
        paymentId: "payment_789",
      });
    });

    it("requires Moyasar idempotencyKey to be a UUID", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          idempotencyKey: "order_123",
          moyasarSource: {
            type: "applepay",
            token: "encrypted_token",
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects legacy tokenId values that do not match Moyasar token format", async () => {
      await expect(
        createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          callbackUrl: "https://example.com/callback",
          moyasarSource: { type: "token", token: "bad_token" },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects amounts below one minor unit", async () => {
      await expect(
        createGateway().createPayment({
          amount: { amount: "0.001", currency: "SAR" } as unknown as Money,
          currency: "SAR",
          moyasarSource: {
            type: "applepay",
            token: "encrypted_token",
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects amounts with unsupported currency precision", async () => {
      await expect(
        createGateway().createPayment({
          amount: { amount: "1.235", currency: "SAR" } as unknown as Money,
          currency: "SAR",
          moyasarSource: {
            type: "applepay",
            token: "encrypted_token",
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("treats HTTP 200 empty {} as indeterminate, not declined failed (NEW-MOYASAR-1)", async () => {
      mockFetchJson({});

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: {
          type: "token",
          token: "token_test_123",
        },
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.outcome).not.toBe("declined");
      expect(result.status).not.toBe("paid");
      expect(isPaidOutcome(result)).toBe(false);
      expect(result.outcome).not.toBe("succeeded");
      expect(result.gatewayId).not.toBeUndefined();
    });

    it("treats HTTP 200 missing payment.id as indeterminate even when status is paid (NEW-MOYASAR-1)", async () => {
      mockFetchJson({
        status: "paid",
        amount: money("10000", "SAR"),
        currency: "SAR",
        captured: 10000,
      });

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
        moyasarSource: {
          type: "applepay",
          token: "encrypted_token",
        },
      });

      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.outcome).not.toBe("declined");
      expect(isPaidOutcome(result)).toBe(false);
      // given_id is the only handle callers can reconcile with
      expect(result.gatewayId).toBe(DEFAULT_MUTATION_IDEMPOTENCY_KEY);
    });

    it("forwards minimal AFT recipient and sender without account or country_code", async () => {
      mockFetchJson(paymentResponse());

      const recipient = {
        first_name: "Saleh",
        last_name: "Ali",
        address: "Riyadh",
      };
      const sender = {
        first_name: "Sara",
        last_name: "Ali",
        address: "Riyadh",
        id_type: "NTID" as const,
        id: "1234567890",
        phone_number: "0512345678",
      };

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: {
          type: "token",
          token: "token_test_123",
        },
        recipient,
        sender,
      });

      const body = lastRequestBody();
      expect(body.recipient).toEqual(recipient);
      expect(body.sender).toEqual(sender);
      expect(body.sender).not.toHaveProperty("account");
      expect(body.sender).not.toHaveProperty("country_code");
      expect(result.status).toBe("paid");
      expect(result.outcome).toBe("succeeded");
      expect(isPaidOutcome(result)).toBe(true);
    });

    it("maps initiated creditcard transaction_url to redirect nextAction and operation action", async () => {
      const transactionUrl = "https://api.moyasar.com/3ds/challenge";
      mockFetchJson(
        paymentResponse({
          status: "initiated",
          captured: 0,
          source: {
            type: "creditcard",
            transaction_url: transactionUrl,
          },
        }),
      );

      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: {
          type: "token",
          token: "token_test_123",
        },
      });

      expect(result.nextAction).toEqual({
        type: "redirect",
        url: transactionUrl,
      });
      expect(result.redirectUrl).toBe(transactionUrl);
      const operation = mapGatewayResultToOperationResult(result, {
        gateway: "moyasar",
      });
      expect(operation.outcome).toBe("requires_action");
      if (operation.outcome === "requires_action") {
        expect(operation.action).toMatchObject({
          type: "redirect",
          url: transactionUrl,
        });
      }
    });
  });

  describe("capturePayment and refundPayment", () => {
    it("uses provided currency minor units for partial capture", async () => {
      mockFetchJson(paymentResponse({ currency: "KWD", amount: 1234, captured: 1234 }));

      await createGateway().capturePayment({
        gatewayPaymentId: PAYMENT_ID,
        amount: money("1.234", "KWD"),
        currency: "KWD",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      // Preflight GET binds currency to payment (MOYASAR-3); then capture POST.
      expect(fetchCalls[0]?.url).toBe(
        `https://api.moyasar.com/v1/payments/${PAYMENT_ID}`,
      );
      expect(fetchCalls[1]?.url).toBe(
        `https://api.moyasar.com/v1/payments/${PAYMENT_ID}/capture`,
      );
      expect(lastRequestBody().amount).toBe(1234);
    });

    it("rejects partial capture currency that does not match payment (MOYASAR-3)", async () => {
      mockFetchJson(paymentResponse({ currency: "SAR", amount: 10000, captured: 0 }));

      await expect(
        createGateway().capturePayment({
          gatewayPaymentId: PAYMENT_ID,
          amount: money("50", "JPY"),
          currency: "JPY",
          idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
        }),
      ).rejects.toThrow(/does not match payment currency/);

      // Preflight GET only — mutation must not run on currency mismatch.
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe(
        `https://api.moyasar.com/v1/payments/${PAYMENT_ID}`,
      );
    });

    it("requires currency for partial captures instead of defaulting to SAR", async () => {
      await expect(
        createGateway().capturePayment({
          gatewayPaymentId: PAYMENT_ID,
          amount: money("10", "SAR"),
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("omits request body and Content-Type for full capture", async () => {
      mockFetchJson(paymentResponse({ status: "captured" }));

      await createGateway().capturePayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(lastRequestBodyOrUndefined()).toBeUndefined();
      const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
    });

    it("maps refund totals using response currency minor units", async () => {
      mockFetchJson(
        paymentResponse({
          status: "refunded",
          currency: "KWD",
          amount: 1234,
          refunded: 1234,
          refunded_at: "2026-05-21T10:05:00Z",
        }),
      );

      const result = await createGateway().refundPayment({
        gatewayPaymentId: PAYMENT_ID,
        amount: money("1.234", "KWD"),
        currency: "KWD",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(lastRequestBody().amount).toBe(1234);
      expect(result.status).toBe("completed");
      expect(result.outcome).toBe("succeeded");
      expect(result.outcome).toBe("succeeded");
      expect(majorFromMoney(result.totalRefunded)).toBe(1.234);
      expect(result.refundedAt).toEqual(new Date("2026-05-21T10:05:00Z"));
    });

    it("marks partial refunds completed even when provider status is still paid", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: 10000,
          refunded: 4000,
          refunded_at: "2026-05-21T10:05:00Z",
        }),
      );

      const result = await createGateway().refundPayment({
        gatewayPaymentId: PAYMENT_ID,
        amount: money("40", "SAR"),
        currency: "SAR",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(result.status).toBe("completed");
      expect(result.outcome).toBe("succeeded");
      expect(result.outcome).toBe("succeeded");
      expect(majorFromMoney(result.totalRefunded)).toBe(40);
    });

    it("treats incomplete refund snapshot as pending without inventing totalRefunded=0 (MOYASAR-2)", async () => {
      // Provider status refunded but no positive refunded amount — payment domain
      // is refund_completed; refund op must not claim completed/succeeded with 0.
      mockFetchJson(
        paymentResponse({
          status: "refunded",
          amount: 10000,
          captured: 10000,
          refunded: 0,
          refunded_at: "2026-05-21T10:05:00Z",
        }),
      );

      const result = await createGateway().refundPayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(result.status).toBe("pending");
      expect(result.outcome).toBe("pending");
      expect(result.outcome).toBe("pending"); // pending dual-writes success true in 0.x — now outcome pending
      expect(result.totalRefunded).toBeUndefined();
      expect(result.totalRefunded).not.toBe(0);
      expect(result.totalRefunded).not.toBe(100);
    });

    it("rejects partial refund currency that does not match payment (MOYASAR-3)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          currency: "SAR",
          amount: 10000,
          captured: 10000,
        }),
      );

      await expect(
        createGateway().refundPayment({
          gatewayPaymentId: PAYMENT_ID,
          amount: money("50", "JPY"),
          currency: "JPY",
          idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
        }),
      ).rejects.toThrow(/does not match payment currency/);

      expect(fetchCalls).toHaveLength(1);
      expect(String(fetchCalls[0]?.url)).not.toContain("/refund");
    });

    it("maps getPayment partial refund amounts to partially_refunded", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: 10000,
          refunded: 2500,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("partially_refunded");
      expect(majorFromMoney(result.refundedAmount)).toBe(25);
    });

    it("maps full refund of partial capture to refunded (captured baseline)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: 3000,
          refunded: 3000,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("refunded");
      expect(majorFromMoney(result.refundedAmount)).toBe(30);
      expect(majorFromMoney(result.capturedAmount)).toBe(30);
    });

    it("maps partial refund of partial capture to partially_refunded", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: 3000,
          refunded: 1000,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("partially_refunded");
      expect(majorFromMoney(result.refundedAmount)).toBe(10);
      expect(majorFromMoney(result.capturedAmount)).toBe(30);
    });

    it("maps full refund of full capture to refunded", async () => {
      mockFetchJson(
        paymentResponse({
          status: "refunded",
          amount: 10000,
          captured: 10000,
          refunded: 10000,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("refunded");
      expect(majorFromMoney(result.refundedAmount)).toBe(100);
    });

    it("maps provider refunded + zero refunded amount to refund_completed (not full refunded)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "refunded",
          amount: 10000,
          captured: 10000,
          refunded: 0,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("refund_completed");
      expect(result.status).not.toBe("refunded");
      expect(result.status).not.toBe("partially_refunded");
      expect(majorFromMoney(result.refundedAmount)).toBe(0);
      expect(result.outcome).toBe("requires_action");
      expect(result.outcome).not.toBe("succeeded");
    });

    it("maps provider refunded + missing refunded amount to refund_completed", async () => {
      mockFetchJson(
        paymentResponse({
          status: "refunded",
          amount: 10000,
          captured: 10000,
          refunded: undefined,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("refund_completed");
      expect(result.status).not.toBe("refunded");
      expect(result.status).not.toBe("partially_refunded");
      expect(result.outcome).toBe("requires_action");
    });

    it("maps provider refunded + non-finite refunded amount to refund_completed", async () => {
      mockFetchJson(
        paymentResponse({
          status: "refunded",
          amount: 10000,
          captured: 10000,
          refunded: Number.NaN,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("refund_completed");
      expect(result.status).not.toBe("refunded");
      // MOYASAR-1: omit non-finite refunded rather than invent major 0.
      expect(result.refundedAmount).toBeUndefined();
    });

    it("uses authorization amount as refund baseline when captured is 0", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 10000,
          captured: 0,
          refunded: 4000,
        }),
      );

      const partial = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });
      expect(partial.status).toBe("partially_refunded");

      mockFetchJson(
        paymentResponse({
          status: "refunded",
          amount: 10000,
          captured: 0,
          refunded: 10000,
        }),
      );

      const full = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });
      expect(full.status).toBe("refunded");
    });

    it("maps Moyasar verified status to setup_completed (not authorized)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "verified",
          amount: 0,
          captured: 0,
          refunded: 0,
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.status).toBe("setup_completed");
    });

    it("maps partial capture amounts to partially_captured", async () => {
      mockFetchJson(
        paymentResponse({
          status: "authorized",
          amount: 10000,
          captured: 3000,
          refunded: 0,
        }),
      );

      const result = await createGateway().capturePayment({
        gatewayPaymentId: PAYMENT_ID,
        amount: money("30", "SAR"),
        currency: "SAR",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(result.status).toBe("partially_captured");
      expect(majorFromMoney(result.capturedAmount)).toBe(30);
      // MOYASAR-1: currency accompanies major-unit amounts on capture path
      expect(result.currency).toBe("SAR");
      expect(majorFromMoney(result.amount)).toBe(100);
      // Open money story: not operation-succeeded (MOYASAR-5); still not paid-like.
      expect(result.outcome).toBe("requires_action");
      expect(result.outcome).not.toBe("succeeded");
    });

    it("publishes currency with amounts on full capture (MOYASAR-1)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "captured",
          amount: 10000,
          captured: 10000,
          currency: "SAR",
        }),
      );

      const result = await createGateway().capturePayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(majorFromMoney(result.amount)).toBe(100);
      expect(majorFromMoney(result.capturedAmount)).toBe(100);
      expect(result.currency).toBe("SAR");
      expect(majorFromMoney(result.fee)).toBe(2.5);
      expect(majorFromMoney(result.refundedAmount)).toBe(0);
    });

    it("requires currency for partial refunds instead of defaulting to SAR", async () => {
      await expect(
        createGateway().refundPayment({
          gatewayPaymentId: PAYMENT_ID,
          amount: { amount: "1.234", currency: "SAR" } as unknown as Money,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("omits request body and Content-Type for full refund", async () => {
      mockFetchJson(paymentResponse({ status: "refunded" }));

      await createGateway().refundPayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(lastRequestBodyOrUndefined()).toBeUndefined();
      const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
    });

    it("omits Content-Type for void (empty body)", async () => {
      mockFetchJson(paymentResponse({ status: "voided" }));

      await createGateway().voidPayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(lastRequestBodyOrUndefined()).toBeUndefined();
      const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
    });

    it("voidPayment forceOutcome succeeded only when provider status is voided (MOYASAR-5)", async () => {
      mockFetchJson(paymentResponse({ status: "voided" }));

      const voided = await createGateway().voidPayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(voided.status).toBe("cancelled");
      expect(voided.outcome).toBe("succeeded");
      expect(voided.outcome).toBe("succeeded");
    });

    it("voidPayment residual paid is money-honest (not void-complete) (MOYASAR-2)", async () => {
      // Residual 2xx body still paid — forceOutcome is skipped; natural paid
      // maps to outcome succeeded. Callers must key void-complete on cancelled.
      mockFetchJson(paymentResponse({ status: "paid" }));

      const notVoided = await createGateway().voidPayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(notVoided.status).toBe("paid");
      expect(notVoided.status).not.toBe("cancelled");
      expect(notVoided.outcome).toBe("succeeded");
      // Money-honest residual: still settled funds, not void success.
      expect(isPaidOutcome(notVoided)).toBe(true);
      expect(majorFromMoney(notVoided.amount)).toBe(100);
      expect(notVoided.currency).toBe("SAR");
    });

    it("voidPayment does not force succeeded on failed residual body (MOYASAR-5)", async () => {
      mockFetchJson(paymentResponse({ status: "failed" }));

      const failed = await createGateway().voidPayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(failed.status).toBe("failed");
      expect(failed.outcome).toBe("declined");
      expect(failed.outcome).not.toBe("succeeded");
    });

    it("keeps Moyasar validation error details when error fields are not arrays", async () => {
      mockFetchJson(
        {
          type: "invalid_request_error",
          message: "Invalid request",
          errors: {
            amount: "must be a positive integer",
          },
        },
        400,
      );

      await expect(
        createGateway().refundPayment({
          gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      }),
      ).rejects.toThrow("amount: must be a positive integer");
    });

    it("maps Moyasar documented invalid_request errors to InvalidRequestError", async () => {
      mockFetchJson(
        {
          type: "invalid_request",
          message: "Invalid request",
          errors: {
            amount: ["must be positive"],
          },
        },
        400,
      );

      await expect(
        createGateway().refundPayment({
          gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it("maps Moyasar not-found responses to ResourceNotFoundError", async () => {
      mockFetchJson(
        {
          type: "record_not_found",
          message: "Payment was not found",
          errors: null,
        },
        404,
      );

      await expect(
        createGateway().refundPayment({
          gatewayPaymentId: MISSING_PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      }),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("maps 3ds_auth_error to CardDeclinedError (not AuthenticationError)", async () => {
      mockFetchJson(
        {
          type: "3ds_auth_error",
          message: "3DS authentication failed",
          errors: null,
        },
        400,
      );

      let caught: unknown;
      try {
        await createGateway().createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          callbackUrl: "https://example.com/callback",
          moyasarSource: { type: "token", token: "token_abc" },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CardDeclinedError);
      expect(caught).not.toBeInstanceOf(AuthenticationError);
      expect((caught as CardDeclinedError).message).toBe(
        "3DS authentication failed",
      );
    });

    it("keeps authentication_error as AuthenticationError", async () => {
      mockFetchJson(
        {
          type: "authentication_error",
          message: "Invalid secret key",
          errors: null,
        },
        401,
      );

      await expect(
        createGateway().getPayment({ gatewayPaymentId: PAYMENT_ID }),
      ).rejects.toBeInstanceOf(AuthenticationError);
    });
  });

  describe("confirmStcPayOtp", () => {
    it("posts otp_value to the Moyasar STC Pay transaction URL", async () => {
      const transactionUrl =
        "https://api.moyasar.com/v1/stc_pays/6187b1f9-ihn2-457b-a8bc-e2j5c808ff94/proceed?otp_token=abc";
      mockFetchJson(
        paymentResponse({
          status: "paid",
          source: {
            type: "stcpay",
            transaction_url: transactionUrl,
          },
        }),
      );

      const result = await createGateway().confirmStcPayOtp({
        transactionUrl,
        otpValue: "123456",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(fetchCalls[0]?.url).toBe(transactionUrl);
      expect(fetchCalls[0]?.init?.headers).not.toHaveProperty("Authorization");
      expect(lastRequestBody()).toEqual({ otp_value: "123456" });
      expect(result.status).toBe("paid");
      expect(result.outcome).toBe("succeeded");
      expect(result.references?.providerObjectId).toBe(result.gatewayId);
    });

    it("runs global lifecycle hooks for OTP confirmation", async () => {
      const transactionUrl =
        "https://api.moyasar.com/v1/stc_pays/6187b1f9-ihn2-457b-a8bc-e2j5c808ff94/proceed?otp_token=abc";
      const operations: string[] = [];
      mockFetchJson(
        paymentResponse({
          status: "paid",
          source: {
            type: "stcpay",
            transaction_url: transactionUrl,
          },
        }),
      );

      await createGateway(CONFIG, {
        onBefore: (ctx) => {
          operations.push(`before:${ctx.operation}`);
          return { proceed: true };
        },
        onAfter: (ctx) => {
          operations.push(`after:${ctx.operation}`);
          return { proceed: true };
        },
      }).confirmStcPayOtp({
        transactionUrl,
        otpValue: "123456",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(operations).toEqual([
        "before:confirmStcPayOtp",
        "after:confirmStcPayOtp",
      ]);
    });

    it("rejects non-Moyasar STC Pay transaction URLs", async () => {
      await expect(
        createGateway().confirmStcPayOtp({
          transactionUrl: "https://example.com/v1/stc_pays/abc/proceed",
          otpValue: "123456",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("throws when store/key is missing for OTP confirm (NEW-MOYASAR-3)", async () => {
      const transactionUrl =
        "https://api.moyasar.com/v1/stc_pays/6187b1f9-ihn2-457b-a8bc-e2j5c808ff94/proceed?otp_token=abc";
      mockFetchJson(paymentResponse({ status: "paid" }));

      const noStore = new MoyasarGateway(CONFIG, new HooksManager());
      await expect(
        noStore.confirmStcPayOtp({
          transactionUrl,
          otpValue: "123456",
          idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
        }),
      ).rejects.toThrow(/requires moyasar\.idempotencyStore and idempotencyKey/);

      await expect(
        createGateway().confirmStcPayOtp({
          transactionUrl,
          otpValue: "123456",
        }),
      ).rejects.toThrow(/requires idempotencyKey/);

      expect(fetchCalls).toHaveLength(0);
    });

    it("keeps the OTP fence after a post-submit transport error (NEW-MOYASAR-3)", async () => {
      const transactionUrl =
        "https://api.moyasar.com/v1/stc_pays/6187b1f9-ihn2-457b-a8bc-e2j5c808ff94/proceed?otp_token=abc";
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchError(new Error("socket closed"));

      const params = {
        transactionUrl,
        otpValue: "123456",
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      };

      const first = await gateway.confirmStcPayOtp(params);
      expect(first.outcome).toBe("indeterminate");
      expect(first.reconciliationRequired).toBe(true);
      await expect(gateway.confirmStcPayOtp(params)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(fetchCalls).toHaveLength(1);
    });
  });

  describe("getPayment", () => {
    it("publishes currency with major-unit amounts (MOYASAR-1)", async () => {
      mockFetchJson(
        paymentResponse({
          status: "paid",
          amount: 1234,
          fee: 12,
          captured: 1234,
          refunded: 0,
          currency: "KWD",
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(majorFromMoney(result.amount)).toBe(1.234);
      expect(majorFromMoney(result.fee)).toBe(0.012);
      expect(majorFromMoney(result.capturedAmount)).toBe(1.234);
      expect(majorFromMoney(result.refundedAmount)).toBe(0);
      expect(result.currency).toBe("KWD");
      // Docs post-3DS check: status + amount + currency must all be present
      expect(result.status).toBe("paid");
      expect(
        result.status === "paid" &&
          (isMoney(result.amount) ? Number((result.amount as Money).amount) === 1.234 : result.amount === 1.234) &&
          result.currency === "KWD",
      ).toBe(true);
    });

    it("uppercases provider currency on getPayment money snapshot", async () => {
      mockFetchJson(
        paymentResponse({
          amount: 5000,
          captured: 5000,
          currency: "sar",
        }),
      );

      const result = await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
      });

      expect(result.currency).toBe("SAR");
      expect(majorFromMoney(result.amount)).toBe(50);
      expect(majorFromMoney(result.capturedAmount)).toBe(50);
    });

    it("validates gatewayPaymentId before fetching", async () => {
      await expect(
        createGateway().getPayment({ gatewayPaymentId: "" }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("rejects non-UUID Moyasar payment IDs before making API requests", async () => {
      await expect(
        createGateway().getPayment({ gatewayPaymentId: "pay_123" }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      await expect(
        createGateway().capturePayment({
          gatewayPaymentId: "pay_123",
          idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      await expect(
        createGateway().refundPayment({
          gatewayPaymentId: "pay_123",
          idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      await expect(
        createGateway().voidPayment({
          gatewayPaymentId: "pay_123",
          idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);

      expect(fetchCalls).toHaveLength(0);
    });

    it("maps fetch failures to NetworkError", async () => {
      mockFetchError(new Error("offline"));

      await expect(
        createGateway().getPayment({ gatewayPaymentId: PAYMENT_ID }),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it("treats GET HTTP 200 invalid JSON as GatewayApiError, not afterProviderSubmit (NEW-MOYASAR-JSON-1)", async () => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return new Response("not-json{{{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      await expect(
        createGateway().getPayment({ gatewayPaymentId: PAYMENT_ID }),
      ).rejects.toBeInstanceOf(GatewayApiError);
    });

    it("aborts requests that exceed the configured timeout", async () => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        throw new Error("unreachable");
      }) as typeof fetch;

      await expect(
        createGateway({ ...CONFIG, timeoutMs: 1 }).getPayment({
          gatewayPaymentId: PAYMENT_ID,
        }),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it("rejects getPayment with pre-aborted signal without hanging", async () => {
      const controller = new AbortController();
      controller.abort();

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response(JSON.stringify(paymentResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      await expect(
        createGateway().getPayment({
          gatewayPaymentId: PAYMENT_ID,
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(PaymentAbortedError);
    });

    it("treats mid-flight createPayment caller abort as indeterminate (NEW-CORE-1)", async () => {
      const controller = new AbortController();

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          setTimeout(() => controller.abort(), 5);
        });
        throw new Error("unreachable");
      }) as typeof fetch;

      // POST may already have been accepted — not PaymentAbortedError (clean
      // cancel / retry-as-failed). executeWithHooks maps afterProviderSubmit
      // NetworkError to an indeterminate result.
      const result = await createGateway().createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: { type: "token", token: "token_test_abc" },
        signal: controller.signal,
      });
      expect(result.outcome).toBe("indeterminate");
      expect(result.reconciliationRequired).toBe(true);
      expect(result.status).not.toBe("failed");
      expect(result.outcome).not.toBe("declined");
    });

    it("keeps timeout NetworkError when no caller signal is provided", async () => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        throw new Error("unreachable");
      }) as typeof fetch;

      const timedOut = await createGateway({ ...CONFIG, timeoutMs: 1 }).createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/callback",
        moyasarSource: { type: "token", token: "token_test_abc" },
      });
      expect(timedOut.outcome).toBe("indeterminate");
      expect(timedOut.reconciliationRequired).toBe(true);
      expect(timedOut.outcome).not.toBe("succeeded");
    });

    it("does not strip signal through Moyasar schema validation before HTTP", async () => {
      let sawSignal = false;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        sawSignal = init?.signal instanceof AbortSignal;
        return new Response(JSON.stringify(paymentResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const controller = new AbortController();
      await createGateway().getPayment({
        gatewayPaymentId: PAYMENT_ID,
        signal: controller.signal,
      });
      expect(sawSignal).toBe(true);
    });

    it("keeps timeout until the response body is consumed (P610-ABT-4)", async () => {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(_input), init });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            }),
        } as Response;
      }) as typeof fetch;

      await expect(
        createGateway({ ...CONFIG, timeoutMs: 20 }).getPayment({
          gatewayPaymentId: PAYMENT_ID,
        }),
      ).rejects.toBeInstanceOf(NetworkError);
    });
  });

  describe("webhooks", () => {
    it("fails closed when webhookSecret is not configured", () => {
      const gateway = createGateway({ secretKey: "sk_test_unit" });

      expect(
        gateway.verifyWebhook({
          secret_token: "anything",
        }),
      ).toBe(false);
    });

    it("verifies secret_token exactly", () => {
      const gateway = createGateway();

      expect(gateway.verifyWebhook({ secret_token: "webhook_secret" })).toBe(true);
      expect(gateway.verifyWebhook({ secret_token: "wrong" })).toBe(false);
      expect(gateway.verifyWebhook({})).toBe(false);
      expect(gateway.verifyWebhook(null)).toBe(false);
    });

    it.each([
      // Same length as "webhook_secret" (14 chars) but different content
      ["an equal-length token with different content", "webhook_secreX"],
      // Longer than the configured secret (length-guard padded comparison)
      ["a token longer than the configured secret", "webhook_secret_extra"],
      // Shorter / empty tokens
      ["a shorter token", "webhook"],
      ["an empty token", ""],
    ])("rejects %s timing-safely", (_label, secretToken) => {
      expect(createGateway().verifyWebhook({ secret_token: secretToken })).toBe(
        false,
      );
    });

    it("rejects non-string tokens timing-safely", () => {
      expect(createGateway().verifyWebhook({ secret_token: 123 })).toBe(false);
    });

    it("rejects malformed webhook payloads during parsing", () => {
      expect(() => createGateway().parseWebhookEvent({})).toThrow(
        InvalidWebhookError,
      );
    });

    it("parses Moyasar underscore event names and currency minor units", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 1234,
          currency: "KWD",
          captured: 1234,
          metadata: {
            paymentId: "internal_123",
          },
        },
      });

      expect(event.type).toBe("payment_paid");
      expect(event.status).toBe("paid");
      expect(majorFromMoney(event.amount)).toBe(1.234);
      expect(event.paymentId).toBe("internal_123");
      expect(event.gatewayPaymentId).toBe(PAYMENT_ID);
    });

    it("strips secret_token from webhook rawPayload", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
        },
      });

      expect(event.rawPayload).toEqual({
        id: "wh_123",
        type: "payment_paid",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
        },
      });
      expect(
        (event.rawPayload as Record<string, unknown>).secret_token,
      ).toBeUndefined();
    });

    it("maps verified webhook status to setup_completed", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_verified",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "verified",
          amount: 0,
          currency: "SAR",
        },
      });

      expect(event.status).toBe("setup_completed");
    });

    it("sets livemode true when webhook envelope live is true", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        live: true,
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
        },
      });

      expect(event.livemode).toBe(true);
    });

    it("sets livemode false when webhook envelope live is false", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        live: false,
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
        },
      });

      expect(event.livemode).toBe(false);
    });

    it("maps partial refund amounts on webhooks to partially_refunded", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          refunded: 2500,
          captured: 10000,
        },
      });

      expect(event.status).toBe("partially_refunded");
      // Money field is refunded slice, not full payment total (MOYASAR-1).
      expect(majorFromMoney(event.amount)).toBe(25);
      expect(event.event?.type).toBe("refund.completed");
      if (event.event?.type === "refund.completed") {
        expect(majorFromMoney(event.event.refund.amount)).toBe(25);
      }
    });

    it("maps full refund of partial capture on webhooks to refunded (captured baseline)", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          refunded: 3000,
          captured: 3000,
        },
      });

      expect(event.status).toBe("refunded");
      expect(majorFromMoney(event.amount)).toBe(30);
    });

    it("maps provider refunded + zero refunded amount on webhooks to refund_completed", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "refunded",
          amount: 10000,
          currency: "SAR",
          refunded: 0,
          captured: 10000,
        },
      });

      expect(event.status).toBe("refund_completed");
      expect(event.status).not.toBe("refunded");
      expect(event.status).not.toBe("partially_refunded");
      // Explicit zero refunded is honest money (not full payment total).
      expect(majorFromMoney(event.amount)).toBe(0);
      // MOYASAR-1: incomplete refund_completed must not dual-write refund.completed
      // (type-only handlers would over-settle). Stripe/Paymob → refund.pending.
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
      if (event.event?.type === "refund.pending") {
        expect(majorFromMoney(event.event.refund.amount)).toBe(0);
      }
    });

    it("maps provider refunded + missing refunded amount on webhooks to refund_completed without inventing total", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "refunded",
          amount: 10000,
          currency: "SAR",
          // refunded omitted
        },
      });

      expect(event.status).toBe("refund_completed");
      expect(event.status).not.toBe("refunded");
      expect(event.status).not.toBe("partially_refunded");
      // Incomplete: do not surface payment total as refund money field.
      expect(event.amount).toBeUndefined();
      // MOYASAR-1: demote dual-write to refund.pending (not refund.completed).
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
      if (event.event?.type === "refund.pending") {
        expect(event.event.refund.amount).toBeUndefined();
      }
    });

    it("maps payment_refunded + paid-like status without refund amount to refund_completed (not paid)", () => {
      // Moyasar partial-refund path keeps payment status paid; when the
      // refunded amount is also missing/zero the snapshot is incomplete —
      // must not remain paid (false-fulfill / no restock gate).
      const missing = createGateway().parseWebhookEvent({
        id: "wh_refund_paid_missing",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
          // refunded omitted
        },
      });

      expect(missing.status).toBe("refund_completed");
      expect(missing.status).not.toBe("paid");
      expect(missing.status).not.toBe("refunded");
      expect(missing.amount).toBeUndefined();
      // MOYASAR-1: incomplete dual-write is refund.pending, not completed.
      expect(missing.stableType).toBe("refund.pending");
      expect(missing.event?.type).toBe("refund.pending");

      const zero = createGateway().parseWebhookEvent({
        id: "wh_refund_paid_zero",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
          refunded: 0,
        },
      });

      expect(zero.status).toBe("refund_completed");
      expect(zero.status).not.toBe("paid");
      expect(majorFromMoney(zero.amount)).toBe(0);
      expect(zero.stableType).toBe("refund.pending");
      expect(zero.event?.type).toBe("refund.pending");
    });

    it("maps payment_refunded + non-finite refunded amount to refund_completed without inventing total", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_refund_nan",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "refunded",
          amount: 10000,
          currency: "SAR",
          refunded: Number.NaN,
          captured: 10000,
        },
      });

      expect(event.status).toBe("refund_completed");
      expect(event.status).not.toBe("refunded");
      // Non-finite is not a usable refunded minor — omit rather than invent total.
      expect(event.amount).toBeUndefined();
      expect(event.stableType).toBe("refund.pending");
      expect(event.event?.type).toBe("refund.pending");
    });

    it("uses captured amount on capture webhooks (not authorization total)", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_captured",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "captured",
          amount: 10000,
          currency: "SAR",
          captured: 4000,
          refunded: 0,
        },
      });

      expect(event.status).toBe("partially_captured");
      expect(majorFromMoney(event.amount)).toBe(40);
      // Dual-write demotion: not capture.completed (type-only over-fulfill).
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      // Provider-native type stays on the envelope.
      expect(event.type).toBe("payment_captured");
    });

    it("demotes payment_paid + amount-derived partially_captured dual-write to payment.processing", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_partial_paid",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 4000,
          refunded: 0,
        },
      });

      expect(event.status).toBe("partially_captured");
      expect(majorFromMoney(event.amount)).toBe(40);
      // Never dual-write payment.succeeded while domain status is partial.
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      expect(event.type).toBe("payment_paid");
      expect(event.provider?.eventType).toBe("payment_paid");
    });

    it.each([
      {
        label: "paid residual",
        id: "wh_void_paid",
        data: {
          status: "paid",
          amount: 10000,
          captured: 10000,
          refunded: 0,
        },
        status: "paid",
        amount: 100,
      },
      {
        label: "incomplete paid residual (captured 0)",
        id: "wh_void_paid_cap0",
        data: {
          status: "paid",
          amount: 10000,
          captured: 0,
          refunded: 0,
        },
        status: "processing",
        amount: 100,
      },
      {
        label: "authorized residual",
        id: "wh_void_auth",
        data: {
          status: "authorized",
          amount: 10000,
          captured: 0,
          refunded: 0,
        },
        status: "authorized",
        amount: 100,
      },
      {
        label: "partially_captured residual",
        id: "wh_void_partial",
        data: {
          status: "paid",
          amount: 10000,
          captured: 4000,
          refunded: 0,
        },
        status: "partially_captured",
        amount: 40,
      },
    ] as const)(
      "fail-closes payment_voided + $label (MOYASAR-1)",
      ({ id, data, status, amount }) => {
        const event = createGateway().parseWebhookEvent({
          id,
          type: "payment_voided",
          secret_token: "webhook_secret",
          created_at: "2026-05-21T10:00:00Z",
          data: {
            id: PAYMENT_ID,
            currency: "SAR",
            ...data,
          },
        });

        expect(event.status).toBe(status);
        expect(event.status).not.toBe("cancelled");
        expect(majorFromMoney(event.amount)).toBe(amount);
        expect(event.currency).toBe("SAR");
        expect(event.type).toBe("payment_voided");
        expect(event.stableType).toBe("payment.processing");
        expect(event.event?.type).toBe("payment.processing");
        expect(event.stableType).not.toBe("payment.cancelled");
        expect(event.provider?.eventType).toBe("payment_voided");
      },
    );

    it("maps consistent payment_voided + voided snapshot to cancelled (MOYASAR-1)", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_void_ok",
        type: "payment_voided",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "voided",
          amount: 10000,
          currency: "SAR",
          captured: 0,
          refunded: 0,
        },
      });

      expect(event.status).toBe("cancelled");
      expect(majorFromMoney(event.amount)).toBe(100);
      expect(event.currency).toBe("SAR");
      expect(event.type).toBe("payment_voided");
      expect(event.stableType).toBe("payment.cancelled");
      expect(event.event?.type).toBe("payment.cancelled");
    });

    it("demotes payment_paid dual-write when domain status is not paid-like (MOYASAR-3)", () => {
      // Envelope payment_paid maps to payment.succeeded, but provider status
      // authorized is not paid-like — dual-write must not settle from type alone.
      // Catalog rematch (authorized domain) yields payment.authorized; local
      // demote still covers residual settled arms (e.g. partially_captured).
      const event = createGateway().parseWebhookEvent({
        id: "wh_paid_auth_mismatch",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "authorized",
          amount: 10000,
          currency: "SAR",
          captured: 0,
          refunded: 0,
        },
      });

      expect(event.status).toBe("authorized");
      expect(event.type).toBe("payment_paid");
      expect(event.stableType).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.succeeded");
      expect(event.stableType).toBe("payment.authorized");
      expect(event.event?.type).toBe("payment.authorized");
      expect(event.provider?.eventType).toBe("payment_paid");
    });

    it("uses full captured amount on payment_paid when captured is present", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
        },
      });

      expect(event.status).toBe("paid");
      expect(majorFromMoney(event.amount)).toBe(100);
      // Full settlement keeps payment.succeeded dual-write.
      expect(event.stableType).toBe("payment.succeeded");
      expect(event.event?.type).toBe("payment.succeeded");
    });

    it("fail-closes payment_paid / payment_captured without a finite captured total (P610-MOY-2)", () => {
      const missing = createGateway().parseWebhookEvent({
        id: "wh_paid_no_captured",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
        },
      });

      expect(missing.status).toBe("processing");
      expect(missing.status).not.toBe("paid");
      expect(missing.stableType).toBe("payment.processing");
      expect(missing.event?.type).toBe("payment.processing");

      const nonFinite = createGateway().parseWebhookEvent({
        id: "wh_captured_nan",
        type: "payment_captured",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "captured",
          amount: 10000,
          currency: "SAR",
          captured: Number.NaN,
        },
      });

      expect(nonFinite.status).toBe("processing");
      expect(nonFinite.status).not.toBe("paid");
      expect(nonFinite.stableType).toBe("payment.processing");
      expect(nonFinite.event?.type).toBe("payment.processing");
    });

    it("fail-closes payment_paid + finite captured 0 (MOYASAR-CAP-0)", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_paid_captured_zero",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 0,
        },
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).toBe("payment.processing");
      expect(event.stableType).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.succeeded");
      // Do not publish the authorization total as settled captured.
      expect(majorFromMoney(event.amount)).toBe(0);
      expect(event.currency).toBe("SAR");
    });

    it("fail-closes payment_captured + finite captured 0 (MOYASAR-CAP-0)", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_captured_zero",
        type: "payment_captured",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "captured",
          amount: 10000,
          currency: "SAR",
          captured: 0,
        },
      });

      expect(event.status).toBe("processing");
      expect(event.status).not.toBe("paid");
      expect(event.stableType).toBe("payment.processing");
      expect(event.event?.type).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("capture.completed");
      expect(majorFromMoney(event.amount)).toBe(0);
      expect(event.currency).toBe("SAR");
    });

    it("hashes webhook via compact identity, not the full tree (NEW-PERF-1)", () => {
      const payload = {
        id: "wh_hash",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
        },
      };
      const compactIdentity = {
        id: "wh_hash",
        type: "payment_paid",
        created_at: "2026-05-21T10:00:00Z",
        object: PAYMENT_ID,
      };

      const event = createGateway().parseWebhookEvent(payload);

      expect(event.payloadHash).toBe(hashWebhookPayload(compactIdentity));
      expect(event.payloadHash).not.toBe(hashWebhookPayload(payload));
      expect(event.payloadHash).not.toBe(hashWebhookPayload(event.rawPayload));
      expect(
        (event.rawPayload as Record<string, unknown>).secret_token,
      ).toBeUndefined();
    });

    it("does not dual-write payment.succeeded for a free-form type with paid status", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_freeform",
        type: "totally_custom_moyasar_event",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
        },
      });

      expect(event.type).toBe("totally_custom_moyasar_event");
      expect(event.stableType).not.toBe("payment.succeeded");
      expect(event.event?.type).not.toBe("payment.succeeded");
      // Mapper stream owns webhook-event-map (no status fallback).
      expect(event.stableType).toBeUndefined();
      expect(event.event?.type).toBe("provider.unmapped");
    });

    it("maps unmapped provider statuses to failed (fail-closed)", () => {
      const warnings: string[] = [];
      const logger = {
        debug() {},
        info() {},
        warn: (message: string) => warnings.push(message),
        error() {},
      };
      const gateway = new MoyasarGateway(CONFIG, new HooksManager(), logger);

      const event = gateway.parseWebhookEvent({
        id: "wh_123",
        type: "payment_unknown",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "totally_unknown_status",
          amount: 10000,
          currency: "SAR",
        },
      });

      expect(event.status).toBe("failed");
      expect(warnings.some((w) => w.includes("Unmapped payment status"))).toBe(
        true,
      );
    });

    it("falls back to metadata.orderId when paymentId is absent", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
          metadata: {
            orderId: "order_123",
          },
        },
      });

      expect(event.paymentId).toBe("order_123");
    });

    it("maps Moyasar abandoned webhooks to failed status", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_abandoned",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "abandoned",
          amount: 10000,
          currency: "SAR",
          metadata: {
            paymentId: "internal_123",
          },
        },
      });

      expect(event.type).toBe("payment_abandoned");
      expect(event.status).toBe("failed");
    });

    it("normalizes Moyasar's documented failed webhook event spelling", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_123",
        type: "payment_faild",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "failed",
          amount: 10000,
          currency: "SAR",
          metadata: {
            paymentId: "internal_123",
          },
        },
      });

      expect(event.type).toBe("payment_failed");
      expect(event.status).toBe("failed");
    });

    it("parses verified card_auth_* as provider.unmapped, not InvalidWebhookError (NEW-MOYASAR-2)", () => {
      const authenticated = createGateway().parseWebhookEvent({
        id: "wh_card_auth",
        type: "card_auth_authenticated",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: "ca_2a1b3c4d",
          status: "authenticated",
          amount: 10000,
          currency: "SAR",
        },
      });

      expect(authenticated.type).toBe("card_auth_authenticated");
      expect(authenticated.event?.type).toBe("provider.unmapped");
      expect(authenticated.stableType).toBeUndefined();
      expect(authenticated.status).toBe("setup_completed");
      expect(authenticated.status).not.toBe("pending");
      expect(authenticated.status).not.toBe("paid");

      const failed = createGateway().parseWebhookEvent({
        id: "wh_card_auth_fail",
        type: "card_auth_failed",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: "ca_2a1b3c4d",
          status: "failed",
          amount: 10000,
          currency: "SAR",
        },
      });

      expect(failed.type).toBe("card_auth_failed");
      expect(failed.event?.type).toBe("provider.unmapped");
      expect(failed.stableType).toBeUndefined();
      expect(failed.status).toBe("failed");
    });

    it("Phase 7 dual-write: payment_paid → payment.succeeded + redacted envelope", () => {
      const event = createGateway().parseWebhookEvent({
        id: "wh_phase7_paid",
        type: "payment_paid",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        live: false,
        data: {
          id: PAYMENT_ID,
          status: "paid",
          amount: 10000,
          currency: "SAR",
          captured: 10000,
          metadata: { paymentId: "internal_123" },
        },
      });

      expect(event.type).toBe("payment_paid");
      expect(event.schemaVersion).toBe("1");
      expect(event.stableType).toBe("payment.succeeded");
      expect(event.event).toBeDefined();
      expect(event.event?.schemaVersion).toBe("1");
      expect(event.event?.type).toBe("payment.succeeded");
      expect(event.provider?.eventType).toBe("payment_paid");
      expect(event.provider?.eventId).toBe("wh_phase7_paid");
      expect(event.provider?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.provider?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event.payloadHash).toBeDefined();
      expect(
        (event.rawPayload as Record<string, unknown>).secret_token,
      ).toBeUndefined();

      const envelope = toPersistedPaymentEventEnvelope(event.event!, {
        payloadHash: event.payloadHash,
      });
      assertNoSecretsInEnvelope(envelope);
      expect(JSON.stringify(envelope)).not.toContain("webhook_secret");
      expect(JSON.stringify(envelope)).not.toContain("secret_token");
    });

    it("Phase 7 dual-write: payment_failed / payment_authorized / payment_refunded", () => {
      const failed = createGateway().parseWebhookEvent({
        id: "wh_f",
        type: "payment_faild",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "failed",
          amount: 10000,
          currency: "SAR",
        },
      });
      expect(failed.type).toBe("payment_failed");
      expect(failed.stableType).toBe("payment.failed");
      expect(failed.event?.type).toBe("payment.failed");
      if (failed.event?.type === "payment.failed") {
        expect(failed.event.failure.code).toBeDefined();
      }

      const auth = createGateway().parseWebhookEvent({
        id: "wh_a",
        type: "payment_authorized",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "authorized",
          amount: 10000,
          currency: "SAR",
        },
      });
      expect(auth.stableType).toBe("payment.authorized");
      expect(auth.status).toBe("authorized");

      const refunded = createGateway().parseWebhookEvent({
        id: "wh_r",
        type: "payment_refunded",
        secret_token: "webhook_secret",
        created_at: "2026-05-21T10:00:00Z",
        data: {
          id: PAYMENT_ID,
          status: "refunded",
          amount: 10000,
          currency: "SAR",
          refunded: 10000,
        },
      });
      expect(refunded.stableType).toBe("refund.completed");
      expect(refunded.event?.type).toBe("refund.completed");
    });
  });

  describe("clock injection", () => {
    it("uses this.clock.nowMs() for mutation createdAt (P610-CLK-2)", async () => {
      const createdAts: number[] = [];
      const store = new InMemoryIdempotencyStore();
      const reserve = store.reserve.bind(store);
      const set = store.set.bind(store);
      store.reserve = (key, record) => {
        createdAts.push(record.createdAt);
        return reserve(key, record);
      };
      store.set = (key, record) => {
        createdAts.push(record.createdAt);
        return set(key, record);
      };

      const fixedMs = 1_700_000_123_000;
      const gateway = new MoyasarGateway(
        { ...CONFIG, idempotencyStore: store },
        new HooksManager(),
        undefined,
        {
          clock: {
            now: () => new Date(fixedMs),
            nowMs: () => fixedMs,
          },
        },
      );

      mockFetchJson(paymentResponse({ status: "voided" }));
      await gateway.voidPayment({
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: DEFAULT_MUTATION_IDEMPOTENCY_KEY,
      });

      expect(createdAts.length).toBeGreaterThan(0);
      expect(createdAts.every((value) => value === fixedMs)).toBe(true);
    });
  });

  describe("idempotent mutations", () => {
    it("replays a completed refund without a second API call", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchJson(paymentResponse({ status: "refunded", refunded: 10000 }));

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "refund-key-1",
      };

      const first = await gateway.refundPayment(params);
      const second = await gateway.refundPayment(params);

      expect(first.status).toBe("completed");
      expect(second).toEqual(first);
      // Only one network call despite two refundPayment invocations.
      expect(fetchCalls).toHaveLength(1);
    });

    it("does not double-refund: a retry after success is a no-op", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchJson(paymentResponse({ status: "refunded", refunded: 5000 }));

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        amount: money("50", "SAR"),
        currency: "SAR",
        idempotencyKey: "refund-key-2",
      };

      await gateway.refundPayment(params);
      await gateway.refundPayment(params);
      await gateway.refundPayment(params);

      // Mutation POST exactly once (preflight GETs may repeat before fence hits cache).
      const refundPosts = fetchCalls.filter((c) =>
        String(c.url).includes("/refund"),
      );
      expect(refundPosts).toHaveLength(1);
    });

    it("rejects reusing an idempotency key with different parameters", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchJson(paymentResponse({ status: "refunded", refunded: 5000 }));

      await gateway.refundPayment({
        gatewayPaymentId: PAYMENT_ID,
        amount: money("50", "SAR"),
        currency: "SAR",
        idempotencyKey: "refund-key-3",
      });

      await expect(
        gateway.refundPayment({
          gatewayPaymentId: PAYMENT_ID,
          amount: money("60", "SAR"),
          currency: "SAR",
          idempotencyKey: "refund-key-3",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it("blocks replay after an indeterminate (network) refund failure", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchError(new Error("socket closed"));

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "refund-key-4",
      };

      const first = await gateway.refundPayment(params);
      expect(first.outcome).toBe("indeterminate");
      expect(first.reconciliationRequired).toBe(true);
      // The outcome is unknown, so a retry with the same key is refused rather
      // than risking a double refund.
      await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it("allows retry after a definite (4xx) refund failure", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchSequence(
        { body: { type: "invalid_request", message: "bad", errors: null }, status: 400 },
        { body: paymentResponse({ status: "refunded", refunded: 10000 }) },
      );

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "refund-key-5",
      };

      await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(InvalidRequestError);
      // Definite failure cleared the reservation, so a retry runs the real call.
      const retried = await gateway.refundPayment(params);
      expect(retried.status).toBe("completed");
      expect(fetchCalls).toHaveLength(2);
    });

    it("treats refund HTTP 200 {} as indeterminate and does not complete the fence (NEW-MOYASAR-REFUND-ID)", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchJson({});

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "refund-key-empty-2xx",
      };

      const first = await gateway.refundPayment(params);
      expect(first.outcome).toBe("indeterminate");
      expect(first.reconciliationRequired).toBe(true);
      expect(first.status).not.toBe("completed");
      expect(first.outcome).not.toBe("succeeded");
      expect(first.outcome).not.toBe("pending");
      expect(first.outcome).not.toBe("succeeded");

      const fence = await idempotencyStore.get(
        `moyasar:refundPayment:${PAYMENT_ID}:refund-key-empty-2xx`,
      );
      expect(fence?.status).toBe("unknown");
      expect(fence?.status).not.toBe("completed");
      expect(fence?.result).toBeUndefined();

      await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(fetchCalls).toHaveLength(1);
    });

    it("treats refund HTTP 200 missing payment.id as indeterminate even when status is refunded (NEW-MOYASAR-REFUND-ID)", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchJson({
        status: "refunded",
        amount: money("10000", "SAR"),
        currency: "SAR",
        refunded: 10000,
      });

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "refund-key-missing-id-2xx",
      };

      const first = await gateway.refundPayment(params);
      expect(first.outcome).toBe("indeterminate");
      expect(first.reconciliationRequired).toBe(true);
      expect(first.status).not.toBe("completed");
      expect(first.outcome).not.toBe("succeeded");

      const fence = await idempotencyStore.get(
        `moyasar:refundPayment:${PAYMENT_ID}:refund-key-missing-id-2xx`,
      );
      expect(fence?.status).toBe("unknown");
      expect(fence?.result).toBeUndefined();

      await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(fetchCalls).toHaveLength(1);
    });

    it("keeps the refund fence after HTTP 408 (NEW-MOYASAR-4XX)", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchJson({ type: "api_error", message: "request timeout" }, 408);

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "refund-key-408",
      };

      await expect(gateway.refundPayment(params)).rejects.toBeTruthy();

      const fence = await idempotencyStore.get(
        `moyasar:refundPayment:${PAYMENT_ID}:refund-key-408`,
      );
      expect(fence?.status).toBe("unknown");
      expect(fence?.status).not.toBe("completed");

      await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(fetchCalls).toHaveLength(1);
    });

    it("keeps the refund fence after HTTP 409 and 425 (NEW-MOYASAR-4XX)", async () => {
      for (const status of [409, 425] as const) {
        fetchCalls = [];
        const idempotencyStore = new InMemoryIdempotencyStore();
        const gateway = createGateway({ ...CONFIG, idempotencyStore });
        mockFetchJson({ type: "api_error", message: `http ${status}` }, status);
        const key = `refund-key-${status}`;
        const params = {
          gatewayPaymentId: PAYMENT_ID,
          idempotencyKey: key,
        };

        await expect(gateway.refundPayment(params)).rejects.toBeTruthy();
        const fence = await idempotencyStore.get(
          `moyasar:refundPayment:${PAYMENT_ID}:${key}`,
        );
        expect(fence?.status).toBe("unknown");
        await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(
          InvalidRequestError,
        );
        expect(fetchCalls).toHaveLength(1);
      }
    });

    it("treats refund HTTP 200 invalid JSON as indeterminate and keeps fence unknown (NEW-MOYASAR-JSON-1)", async () => {
      // Mutating HTTP 2xx with unreadable JSON: POST may already have applied.
      // executeWithHooks maps NetworkError.afterProviderSubmit → indeterminate.
      // Fence stays unknown; same key must not POST again.
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return new Response("not-json{{{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "refund-key-bad-json-2xx",
      };

      const first = await gateway.refundPayment(params);
      expect(first.outcome).toBe("indeterminate");
      expect(first.reconciliationRequired).toBe(true);
      expect(first.status).not.toBe("completed");
      expect(first.outcome).not.toBe("succeeded");
      expect(first.outcome).not.toBe("pending");
      expect(first.outcome).not.toBe("succeeded");

      const fence = await idempotencyStore.get(
        `moyasar:refundPayment:${PAYMENT_ID}:refund-key-bad-json-2xx`,
      );
      expect(fence?.status).toBe("unknown");
      expect(fence?.status).not.toBe("completed");
      expect(fence?.result).toBeUndefined();

      await expect(gateway.refundPayment(params)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(fetchCalls).toHaveLength(1);
    });

    it("treats capture HTTP 200 invalid JSON as indeterminate and keeps fence unknown (NEW-MOYASAR-JSON-1)", async () => {
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return new Response("not-json{{{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "capture-key-bad-json-2xx",
      };

      const first = await gateway.capturePayment(params);
      expect(first.outcome).toBe("indeterminate");
      expect(first.reconciliationRequired).toBe(true);
      expect(first.status).not.toBe("paid");
      expect(first.outcome).not.toBe("succeeded");

      const fence = await idempotencyStore.get(
        `moyasar:capturePayment:${PAYMENT_ID}:capture-key-bad-json-2xx`,
      );
      expect(fence?.status).toBe("unknown");
      expect(fence?.status).not.toBe("completed");
      expect(fence?.result).toBeUndefined();

      await expect(gateway.capturePayment(params)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      const capturePosts = fetchCalls.filter((c) =>
        String(c.url).includes("/capture"),
      );
      expect(capturePosts).toHaveLength(1);
      expect(fetchCalls).toHaveLength(1);
    });

    it("keeps reservation after 2xx map failure on capture (MOYASAR-1)", async () => {
      // Valid JSON 2xx body that fails money mapping after HTTP may have applied.
      // Keep fence; do not allow a second capture attempt with the same key.
      // Full capture (no amount) — no preflight GET so the only call is the mutation.
      const idempotencyStore = new InMemoryIdempotencyStore();
      const gateway = createGateway({ ...CONFIG, idempotencyStore });
      mockFetchJson(
        paymentResponse({
          status: "captured",
          // Non-integer minor units → fromMinorUnits throws after HTTP success.
          amount: 10000.5,
          captured: 5000.5,
        }),
      );

      const params = {
        gatewayPaymentId: PAYMENT_ID,
        idempotencyKey: "capture-key-map-fail-2xx",
      };

      await expect(gateway.capturePayment(params)).rejects.toBeTruthy();
      await expect(gateway.capturePayment(params)).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(fetchCalls).toHaveLength(1);
    });

    it("retries a 5xx error on createPayment when an idempotency key is present", async () => {
      const gateway = createGateway();
      mockFetchSequence(
        { body: { type: "api_error", message: "server error" }, status: 503 },
        { body: paymentResponse() },
      );

      const result = await gateway.createPayment({
        amount: money("100", "SAR"),
        currency: "SAR",
        callbackUrl: "https://example.com/cb",
        moyasarSource: { type: "token", token: "token_abc" },
        idempotencyKey: "8f1e4d2a-1c3b-4a5e-9f60-2b7c8d9e0a11",
      });

      expect(result.outcome).toBe("succeeded");
      expect(result.outcome).toBe("succeeded");
      expect(result.status).toBe("paid");
      expect(result.references?.providerObjectId).toBe(result.gatewayId);
      expect(fetchCalls).toHaveLength(2);
    });

    it("does not retry createPayment without an idempotency key", async () => {
      const gateway = createGateway();
      mockFetchSequence(
        { body: { type: "api_error", message: "server error" }, status: 503 },
        { body: paymentResponse() },
      );

      await expect(
        gateway.createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          callbackUrl: "https://example.com/cb",
          moyasarSource: { type: "token", token: "token_abc" },
        }),
      ).rejects.toBeTruthy();
      // No idempotency key => no retry => exactly one call.
      expect(fetchCalls).toHaveLength(1);
    });
  });

  describe("rate limiting", () => {
    it("preserves Retry-After seconds when mapping 429 to RateLimitError", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            type: "rate_limit_error",
            message: "Too many requests",
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "retry-after": "30",
            },
          },
        )) as typeof fetch;

      const gateway = createGateway();
      let caught: unknown;
      try {
        // No idempotencyKey => no retry => fast, single attempt.
        await gateway.createPayment({
          amount: money("100", "SAR"),
          currency: "SAR",
          callbackUrl: "https://example.com/callback",
          moyasarSource: { type: "token", token: "token_abc" },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RateLimitError);
      expect((caught as RateLimitError).retryAfterSeconds).toBe(30);
    });
  });

  describe("idempotency store safety", () => {
    const captureWarnings = () => {
      const warnings: string[] = [];
      const logger = {
        debug() {},
        info() {},
        warn: (message: string) => warnings.push(message),
        error() {},
      };
      return { warnings, logger };
    };

    it("warns that idempotencyStore is required when none is configured", () => {
      const { warnings, logger } = captureWarnings();

      new MoyasarGateway(CONFIG, new HooksManager(), logger);

      expect(
        warnings.some(
          (w) =>
            w.includes("idempotencyStore is required") &&
            (w.includes("InvalidRequestError") || w.includes("double-refund")),
        ),
      ).toBe(true);
    });

    it("throws when the idempotency store lacks atomic reserve() (fail-fast)", () => {
      const storeWithoutReserve = {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      };
      expect(
        () =>
          new MoyasarGateway(
            { ...CONFIG, idempotencyStore: storeWithoutReserve },
            new HooksManager(),
          ),
      ).toThrow(/idempotencyStore\.reserve required/);
    });

    it("does not warn when the store implements reserve()", () => {
      const { warnings, logger } = captureWarnings();

      new MoyasarGateway(
        { ...CONFIG, idempotencyStore: new InMemoryIdempotencyStore() },
        new HooksManager(),
        logger,
      );

      expect(warnings.some((w) => w.includes("atomic reserve"))).toBe(false);
      expect(warnings.some((w) => w.includes("idempotencyStore is required"))).toBe(
        false,
      );
      expect(warnings.some((w) => w.includes("No idempotencyStore"))).toBe(
        false,
      );
    });

    it("fails closed when no store is configured (MOYASAR-2)", async () => {
      const { logger } = captureWarnings();
      const gateway = new MoyasarGateway(CONFIG, new HooksManager(), logger);
      mockFetchJson(paymentResponse({ status: "refunded", refunded: 10000 }));

      await expect(
        gateway.refundPayment({
          gatewayPaymentId: PAYMENT_ID,
          idempotencyKey: "unguarded-key",
        }),
      ).rejects.toThrow(/requires moyasar\.idempotencyStore and idempotencyKey/);

      await expect(
        gateway.capturePayment({
          gatewayPaymentId: PAYMENT_ID,
          idempotencyKey: "unguarded-capture",
        }),
      ).rejects.toThrow(/requires moyasar\.idempotencyStore and idempotencyKey/);

      await expect(
        gateway.voidPayment({
          gatewayPaymentId: PAYMENT_ID,
          idempotencyKey: "unguarded-void",
        }),
      ).rejects.toThrow(/requires moyasar\.idempotencyStore and idempotencyKey/);

      await expect(
        gateway.confirmStcPayOtp({
          transactionUrl:
            "https://api.moyasar.com/v1/stc_pays/6187b1f9-ihn2-457b-a8bc-e2j5c808ff94/proceed?otp_token=abc",
          otpValue: "123456",
          idempotencyKey: "unguarded-otp",
        }),
      ).rejects.toThrow(/requires moyasar\.idempotencyStore and idempotencyKey/);

      // Must not hit the network — unguarded mutations are refused.
      expect(fetchCalls).toHaveLength(0);
    });

    it("fails closed when store lacks atomic reserve (MOYASAR-1) — fail-fast at construction", () => {
      const storeWithoutReserve = {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      };
      expect(
        () =>
          new MoyasarGateway(
            { ...CONFIG, idempotencyStore: storeWithoutReserve },
            new HooksManager(),
          ),
      ).toThrow(/idempotencyStore\.reserve required/);
    });

    it("fails closed when store is present but idempotencyKey is omitted (MOYASAR-2)", async () => {
      const gateway = createGateway();
      mockFetchJson(paymentResponse({ status: "refunded", refunded: 10000 }));

      await expect(
        gateway.refundPayment({
          gatewayPaymentId: PAYMENT_ID,
        }),
      ).rejects.toThrow(/requires idempotencyKey/);
      expect(fetchCalls).toHaveLength(0);
    });
  });
});
