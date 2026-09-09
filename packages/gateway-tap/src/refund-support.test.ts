import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "@paykernel/core";
import { capturedCharge } from "./fixtures/charges";
import { nestedRefundFromCharge, tapRemainingRefundMajor } from "./refund-support";

describe("tapRemainingRefundMajor", () => {
  it.each([
    ["remaining", { remaining: 6.5 }, 6.5],
    ["refundable", { refundable: 6.5 }, 6.5],
    ["amount_refunded", { amount: 10.5, amount_refunded: 4 }, 6.5],
    ["refunds list sum", { amount: 10.5, refunds: [{ amount: 4 }] }, 6.5],
    ["full amount_refunded", { amount: 10.5, amount_refunded: 10.5 }, 0],
  ] as const)("uses %s when exposed", (_label, overrides, expected) => {
    expect(tapRemainingRefundMajor(capturedCharge({ ...overrides }), "SAR")).toBe(
      expected,
    );
  });

  it("throws when remaining is negative", () => {
    expect(() =>
      tapRemainingRefundMajor(capturedCharge({ remaining: -1 }), "SAR"),
    ).toThrow(InvalidRequestError);
  });

  it("throws when a refunds list mixes parseable and opaque amounts", () => {
    expect(() =>
      tapRemainingRefundMajor(
        capturedCharge({
          refunds: [{ amount: 4 }, { id: "re_testRefund01" }],
        }),
        "SAR",
      ),
    ).toThrow(InvalidRequestError);
  });

  it("throws when the charge does not expose remaining or refunded", () => {
    expect(() => tapRemainingRefundMajor(capturedCharge(), "SAR")).toThrow(
      InvalidRequestError,
    );
  });
});

describe("nestedRefundFromCharge", () => {
  it("returns the refund whose reference.idempotent matches", () => {
    const nested = nestedRefundFromCharge(
      capturedCharge({
        refunds: [
          { id: "re_a", status: "REFUNDED", reference: { idempotent: "k-a" } },
          { id: "re_b", status: "REFUNDED", reference: { idempotent: "k-b" } },
        ],
      }),
      "k-b",
    );
    expect((nested as { id: string }).id).toBe("re_b");
  });

  it("returns undefined when multiple nested refunds do not match the key", () => {
    expect(
      nestedRefundFromCharge(
        capturedCharge({
          refunds: [
            { id: "re_a", status: "REFUNDED" },
            { id: "re_b", status: "REFUNDED" },
          ],
        }),
        "k-missing",
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the only nested refund has a different idempotent key", () => {
    expect(
      nestedRefundFromCharge(
        capturedCharge({
          refunds: [
            { id: "re_a", status: "REFUNDED", reference: { idempotent: "k-a" } },
          ],
        }),
        "k-b",
      ),
    ).toBeUndefined();
  });

  it("returns the only nested refund when Tap omitted the idempotent field", () => {
    const nested = nestedRefundFromCharge(
      capturedCharge({
        refunds: [{ id: "re_a", status: "REFUNDED" }],
      }),
      "k-b",
    );
    expect((nested as { id: string }).id).toBe("re_a");
  });
});
