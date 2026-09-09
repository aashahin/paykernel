import { describe, expect, it } from "bun:test";
import { InvalidRequestError, NetworkError, money } from "@paykernel/core";
import {
  hesabeTransactionResult,
  parseHesabeCheckout,
  parseHesabeRefund,
  parseHesabeTransaction,
} from "./payment-map";

const kwd = (amount: string) => money(amount, "KWD");

function enquiry(status: unknown, extraData: Record<string, unknown> = {}) {
  return {
    status: true,
    data: {
      token: "tok_123",
      amount: "45.000",
      reference_number: "order1",
      status,
      ...extraData,
    },
  };
}

function refundEnvelope(inner: Record<string, unknown> = {}) {
  return {
    status: true,
    response: {
      id: 1467,
      token: "transaction",
      amount: "10.000",
      status: 0,
      refund_at: null,
      order_reference_number: "order1",
      total_refunded_amount: "10.000",
      ...inner,
    },
  };
}

describe("parseHesabeTransaction", () => {
  it("parses the enquiry shape", () => {
    const tx = parseHesabeTransaction(enquiry("SUCCESSFUL"), "tok_123");
    expect(tx.token).toBe("tok_123");
    expect(tx.referenceNumber).toBe("order1");
    expect(tx.amount).toEqual(kwd("45.000"));
    expect(tx.nativeStatus).toBe("SUCCESSFUL");
  });
  it("rejects token mismatch", () => {
    expect(() => parseHesabeTransaction(enquiry("SUCCESSFUL"), "other")).toThrow(NetworkError);
  });
  it("rejects missing reference", () => {
    expect(() =>
      parseHesabeTransaction(enquiry("SUCCESSFUL", { reference_number: "" }), "tok_123"),
    ).toThrow(NetworkError);
  });
  it("rejects explicit provider rejection without secrets", () => {
    try {
      parseHesabeTransaction({ status: false, data: {} }, "tok_123");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect(String((error as Error).message)).not.toContain("tok_123");
    }
  });
  it("rejects malformed envelopes", () => {
    expect(() => parseHesabeTransaction(null, "tok_123")).toThrow(NetworkError);
    expect(() => parseHesabeTransaction({ status: true }, "tok_123")).toThrow(NetworkError);
  });
});

describe("hesabeTransactionResult", () => {
  it("maps SUCCESSFUL to paid/succeeded with captured amount", () => {
    const tx = parseHesabeTransaction(enquiry("SUCCESSFUL"), "tok_123");
    const result = hesabeTransactionResult(tx);
    expect(result.status).toBe("paid");
    expect(result.outcome).toBe("succeeded");
    expect(result.gatewayId).toBe("tok_123");
    expect(result.orderId).toBe("order1");
    expect(result.capturedAmount).toEqual(kwd("45.000"));
    expect(result.references?.providerObjectId).toBe("tok_123");
  });
  it("maps FAILED to failed", () => {
    const tx = parseHesabeTransaction(enquiry("FAILED"), "tok_123");
    const result = hesabeTransactionResult(tx);
    expect(result.status).toBe("failed");
    expect(result.outcome).toBe("failed");
    expect(result.capturedAmount).toBeUndefined();
  });
  it("maps PENDING to pending", () => {
    const tx = parseHesabeTransaction(enquiry("PENDING"), "tok_123");
    const result = hesabeTransactionResult(tx);
    expect(result.status).toBe("pending");
    expect(result.capturedAmount).toBeUndefined();
  });
  it("maps unknown status to indeterminate with reconciliation", () => {
    const tx = parseHesabeTransaction(enquiry("WEIRD"), "tok_123");
    const result = hesabeTransactionResult(tx);
    expect(result.outcome).toBe("indeterminate");
    expect(result.reconciliationRequired).toBe(true);
    expect(result.gatewayId).toBe("tok_123");
  });
  it("sanitizes raw response", () => {
    const tx = parseHesabeTransaction(
      enquiry("SUCCESSFUL", { secret: "s3cr3t", card: "4111" }),
      "tok_123",
    );
    const result = hesabeTransactionResult(tx);
    expect(result.rawResponse).not.toHaveProperty("secret");
    expect(result.rawResponse).not.toHaveProperty("card");
  });
});

describe("parseHesabeCheckout", () => {
  const params = { orderId: "order1", amount: kwd("45.000"), baseUrl: "https://shop.example" };
  it("maps checkout token to requires_action redirect", () => {
    const result = parseHesabeCheckout(
      { status: true, code: 200, response: { data: "checkout_token" } },
      params,
    );
    expect(result.outcome).toBe("requires_action");
    expect(result.gatewayId).toBe("checkout:checkout_token");
    expect(result.redirectUrl).toBe("https://shop.example/payment?data=checkout_token");
    expect(result.references?.relatedIds?.checkoutToken).toBe("checkout_token");
    expect(result.amount).toEqual(kwd("45.000"));
  });
  it("does not require code 200", () => {
    const result = parseHesabeCheckout({ status: true, response: { data: "abc" } }, params);
    expect(result.gatewayId).toBe("checkout:abc");
  });
  it("escapes redirect tokens", () => {
    const result = parseHesabeCheckout({ status: true, response: { data: "a b&c?" } }, params);
    expect(result.redirectUrl).toBe(
      `https://shop.example/payment?data=${encodeURIComponent("a b&c?")}`,
    );
  });
  it("rejects missing token and outer rejection", () => {
    expect(() => parseHesabeCheckout({ status: true, response: {} }, params)).toThrow(NetworkError);
    expect(() => parseHesabeCheckout({ status: false, response: {} }, params)).toThrow(
      InvalidRequestError,
    );
  });
});

describe("parseHesabeRefund", () => {
  it("treats outer true with inner 0 as pending, not completed", () => {
    const result = parseHesabeRefund(refundEnvelope(), {});
    expect(result.status).toBe("pending");
    expect(result.outcome).toBe("pending");
    expect(result.gatewayRefundId).toBe("1467");
    expect(result.totalRefunded).toBeUndefined();
    expect(result.refundedAt).toBeUndefined();
  });
  it("completes inner 1 with valid refund_at", () => {
    const result = parseHesabeRefund(
      refundEnvelope({ status: 1, refund_at: "2024-05-01T10:00:00.000Z" }),
      {},
    );
    expect(result.status).toBe("completed");
    expect(result.outcome).toBe("succeeded");
    expect(result.gatewayRefundId).toBe("1467");
    expect(result.refundedAt).toBeInstanceOf(Date);
  });
  it("accepts YYYY-MM-DD refund_at as UTC", () => {
    const result = parseHesabeRefund(refundEnvelope({ status: 1, refund_at: "2024-05-01" }), {});
    expect(result.outcome).toBe("succeeded");
    expect(result.refundedAt?.toISOString()).toBe("2024-05-01T00:00:00.000Z");
  });
  it("keeps refund id on unknown status as indeterminate", () => {
    const result = parseHesabeRefund(refundEnvelope({ status: 9 }), {});
    expect(result.status).toBe("pending");
    expect(result.outcome).toBe("indeterminate");
    expect(result.gatewayRefundId).toBe("1467");
    expect(result.reconciliationRequired).toBe(true);
  });
  it("never completes on invalid date", () => {
    const result = parseHesabeRefund(refundEnvelope({ status: 1, refund_at: "not-a-date" }), {});
    expect(result.outcome).toBe("indeterminate");
    expect(result.status).toBe("pending");
    expect(result.refundedAt).toBeUndefined();
  });
  it("rejects wrong id/token/amount and outer rejection", () => {
    expect(() => parseHesabeRefund(refundEnvelope(), { id: "9999" })).toThrow();
    expect(() => parseHesabeRefund(refundEnvelope(), { token: "nope" })).toThrow();
    expect(() => parseHesabeRefund(refundEnvelope(), { amount: kwd("99.000") })).toThrow();
    expect(() => parseHesabeRefund({ status: false, response: {} }, {})).toThrow(
      InvalidRequestError,
    );
  });
  it("sanitizes raw response and omits cumulative total", () => {
    const result = parseHesabeRefund(refundEnvelope(), {});
    expect(result.rawResponse).not.toHaveProperty("total_refunded_amount");
    expect(result.rawResponse).not.toHaveProperty("order_reference_number");
    expect(result.totalRefunded).toBeUndefined();
  });
});

it("does not complete a refund with a rolled-over calendar date", () => {
  const result = parseHesabeRefund(refundEnvelope({ status: 1, refund_at: "2026-02-30" }), {});
  expect(result.outcome).toBe("indeterminate");
});
