import { describe, expect, it } from "bun:test";
import { money } from "@paykernel/core";
import { majorToMinor, mockGateway } from "./mock-gateway";

describe("mock accounting conversions", () => {
  // The 1.0 migration applied charge validation before conversion options.
  it.each([
    { label: "zero balance", amount: 0, minor: 0 },
    { label: "negative adjustment", amount: -1.23, minor: -123 },
  ])("converts a $label to minor units", ({ amount, minor }) => {
    expect(majorToMinor(amount, "USD")).toBe(minor);
  });

  it("preserves KWD currency and fils in refund totals", async () => {
    const gateway = mockGateway();
    const payment = await gateway.createPayment({
      amount: money("3.456", "KWD"),
      currency: "KWD",
      callbackUrl: "https://shop.example/callback",
    });
    const refund = await gateway.refundPayment({
      gatewayPaymentId: payment.gatewayId,
      amount: money("1.234", "KWD"),
      currency: "KWD",
    });
    expect(refund.outcome).toBe("succeeded");
    expect(refund.totalRefunded).toEqual(money("1.234", "KWD"));
  });
});
