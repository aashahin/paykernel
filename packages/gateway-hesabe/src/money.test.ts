import { describe, expect, it } from "bun:test";
import { InvalidRequestError, money } from "@paykernel/core";
import { hesabeDecimalKwd, parseHesabeKwdAmount, toHesabeKwd } from "./money";

describe("Hesabe KWD amounts", () => {
  it("preserves a fils without floating-point conversion", () => {
    expect(hesabeDecimalKwd(money("1.001", "KWD"))).toBe("1.001");
    expect(hesabeDecimalKwd(money("100000.000", "KWD"))).toBe("100000.000");
    expect(parseHesabeKwdAmount("49.000")).toEqual(money("49.000", "KWD"));
  });
  it("rejects other currencies, mismatches, and custom scales", () => {
    expect(() => hesabeDecimalKwd(money("1.00", "USD"))).toThrow(InvalidRequestError);
    expect(() => toHesabeKwd(money("1.00", "USD"), "KWD")).toThrow(InvalidRequestError);
    expect(() => toHesabeKwd(money("1.00", "KWD", { exponent: 2 }), "KWD")).toThrow(
      InvalidRequestError,
    );
  });
  it.each(["0", "-1", "1.0001", "NaN", "", null, {}, Infinity])(
    "rejects invalid provider amount %s",
    (amount) => {
      expect(() => parseHesabeKwdAmount(amount)).toThrow(InvalidRequestError);
    },
  );
});
