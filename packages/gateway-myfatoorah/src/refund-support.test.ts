import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "@paykernel/core";
import { myFatoorahRemainingRefundMajor, nestedRefundFromInvoice } from "./refund-support";
import { partialRefundStatusData } from "./fixtures/webhooks";

describe("myfatoorah refund support", () => {
  it("computes remaining from InvoiceValue minus non-canceled refunds", () => {
    const data = partialRefundStatusData();
    expect(myFatoorahRemainingRefundMajor(data.InvoiceAmount, data.Refunds, "KWD")).toBe(0.6); // 0.85 − 0.25
  });
  it("ignores canceled refunds in the sum", () => {
    const data = partialRefundStatusData();
    data.Refunds.push({
      RefundId: 22299,
      ExternalIdentifier: "canceled-1",
      Comment: null,
      InvoiceId: 915102,
      Amount: 0.5,
      ServiceChargeOnCustomer: 0,
      RefundStatus: "Canceled",
    });
    expect(myFatoorahRemainingRefundMajor(data.InvoiceAmount, data.Refunds, "KWD")).toBe(0.6);
  });

  it("ignores FAILED, REJECTED and unknown statuses in remaining", () => {
    const data = partialRefundStatusData();
    // Existing Refunded 0.25 => remaining 0.6. FAILED/REJECTED/unknown must not subtract.
    data.Refunds.push(
      {
        RefundId: 22298,
        ExternalIdentifier: "failed-1",
        Comment: null,
        InvoiceId: 915102,
        Amount: 0.5,
        ServiceChargeOnCustomer: 0,
        RefundStatus: "Failed",
      },
      {
        RefundId: 22297,
        ExternalIdentifier: "rejected-1",
        Comment: null,
        InvoiceId: 915102,
        Amount: 0.1,
        ServiceChargeOnCustomer: 0,
        RefundStatus: "Rejected",
      },
      {
        RefundId: 22296,
        ExternalIdentifier: "unknown-1",
        Comment: null,
        InvoiceId: 915102,
        Amount: 999,
        ServiceChargeOnCustomer: 0,
        RefundStatus: "SomethingWeird",
      },
    );
    expect(myFatoorahRemainingRefundMajor(data.InvoiceAmount, data.Refunds, "KWD")).toBe(0.6);
  });

  it("counts only REFUNDED and PENDING, pending aliases included", () => {
    // Invoice 0.850, Refunded 0.25 + Pending 0.10 + Failed 0.50 => remaining 0.50 (0.85 - 0.35)
    const data = partialRefundStatusData();
    data.Refunds.push({
      RefundId: 22295,
      ExternalIdentifier: "pending-1",
      Comment: null,
      InvoiceId: 915102,
      Amount: 0.1,
      ServiceChargeOnCustomer: 0,
      RefundStatus: "PENDING",
    });
    data.Refunds.push({
      RefundId: 22294,
      ExternalIdentifier: "failed-2",
      Comment: null,
      InvoiceId: 915102,
      Amount: 0.5,
      ServiceChargeOnCustomer: 0,
      RefundStatus: "FAILED",
    });
    expect(myFatoorahRemainingRefundMajor(data.InvoiceAmount, data.Refunds, "KWD")).toBe(0.5);
  });

  it("parses thousand-separated amounts via comma stripping for remaining", () => {
    // Invoice "12,345.000" KWD, refund "2,345.000" => remaining 10000
    const refunds = [
      {
        RefundId: 1,
        ExternalIdentifier: "k1",
        InvoiceId: 1,
        Amount: "2,345.000",
        RefundStatus: "Refunded",
      },
    ];
    expect(myFatoorahRemainingRefundMajor("12,345.000", refunds, "KWD")).toBe(10_000);
    // Also mixed: numeric invoice with comma-string refund
    expect(myFatoorahRemainingRefundMajor("12,345.000", [{ ...refunds[0], Amount: "12,345.000", RefundStatus: "PENDING" }], "KWD")).toBe(0);
  });

  it("returns 0 when fully refunded", () => {
    const data = partialRefundStatusData();
    data.Refunds = [
      {
        RefundId: 22201,
        ExternalIdentifier: "refund-idem-1",
        Comment: null,
        InvoiceId: 915102,
        Amount: 0.85,
        ServiceChargeOnCustomer: 0,
        RefundStatus: "Refunded",
      },
    ];
    expect(myFatoorahRemainingRefundMajor(data.InvoiceAmount, data.Refunds, "KWD")).toBe(0);
  });
  it("throws when remaining is negative", () => {
    const data = partialRefundStatusData();
    data.Refunds = [
      {
        RefundId: 22201,
        ExternalIdentifier: "refund-idem-1",
        Comment: null,
        InvoiceId: 915102,
        Amount: 20,
        ServiceChargeOnCustomer: 0,
        RefundStatus: "Refunded",
      },
    ];
    expect(() => myFatoorahRemainingRefundMajor(data.InvoiceAmount, data.Refunds, "KWD")).toThrow(
      InvalidRequestError,
    );
  });

  it("throws when the invoice amount or refund list is unparseable", () => {
    expect(() => myFatoorahRemainingRefundMajor(undefined, [], "KWD")).toThrow(InvalidRequestError);
    // No refunds yet — remaining is full invoice amount (does not throw)
    expect(myFatoorahRemainingRefundMajor(10.5, undefined, "KWD")).toBe(10.5);
    expect(myFatoorahRemainingRefundMajor(10.5, [], "KWD")).toBe(10.5);
    // Unknown/failed status with missing amount is ignored (not counted)
    expect(myFatoorahRemainingRefundMajor(10.5, [{ RefundId: 1 }], "KWD")).toBe(10.5);
    expect(myFatoorahRemainingRefundMajor(10.5, [{ RefundId: 1, RefundStatus: "Failed" }], "KWD")).toBe(10.5);
    expect(myFatoorahRemainingRefundMajor(10.5, [{ RefundId: 1, RefundStatus: "Rejected", Amount: "1.000" }], "KWD")).toBe(10.5);
    // Refunded/Pending with missing or unparseable amount must fail closed
    expect(() => myFatoorahRemainingRefundMajor(10.5, [{ RefundId: 1, RefundStatus: "Refunded" }], "KWD")).toThrow(
      InvalidRequestError,
    );
    expect(() => myFatoorahRemainingRefundMajor(10.5, [{ RefundId: 1, RefundStatus: "Pending", Amount: "not-a-number" }], "KWD")).toThrow(
      InvalidRequestError,
    );
  });

  it("matches a nested refund by ExternalIdentifier", () => {
    const data = partialRefundStatusData();
    expect(nestedRefundFromInvoice(data.Refunds, "refund-idem-1")).toMatchObject({
      RefundId: 22201,
    });
  });

  it("maps a single nested refund without an ExternalIdentifier", () => {
    const refunds = [
      {
        RefundId: 22201,
        Comment: null,
        InvoiceId: 915102,
        Amount: 2.5,
        RefundStatus: "Refunded",
      },
    ];
    // Single unkeyed refund must not be mapped to an unrelated key (fail-closed)
    expect(nestedRefundFromInvoice(refunds, "any-key")).toBeUndefined();
    // Without a key, a single entry is still mappable
    expect(nestedRefundFromInvoice(refunds)).toMatchObject({
      RefundId: 22201,
    });
  });

  it("does not map a single nested refund with a different key", () => {
    const data = partialRefundStatusData();
    expect(nestedRefundFromInvoice(data.Refunds, "different-key")).toBeUndefined();
  });

  it("does not map multiple unmatched refunds", () => {
    const data = partialRefundStatusData();
    data.Refunds.push({
      RefundId: 22202,
      ExternalIdentifier: "refund-idem-2",
      Comment: null,
      InvoiceId: 915102,
      Amount: 1,
      ServiceChargeOnCustomer: 0,
      RefundStatus: "Pending",
    });
    expect(nestedRefundFromInvoice(data.Refunds, "other-key")).toBeUndefined();
  });

  it("returns undefined for empty / missing lists", () => {
    expect(nestedRefundFromInvoice([], "k")).toBeUndefined();
    expect(nestedRefundFromInvoice(undefined, "k")).toBeUndefined();
  });
});
