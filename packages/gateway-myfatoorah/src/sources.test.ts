import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "@paykernel/core";
import {
  assertMyFatoorahDisplayPaymentMethods,
  assertMyFatoorahPaymentMethod,
  assertNoPciCardSource,
} from "./sources";

describe("myfatoorah sources / PCI fence", () => {
  it("accepts documented uppercase PaymentMethod values", () => {
    for (const method of ["INVOICE", "CARD", "APPLE_PAY", "GOOGLE_PAY", "KNET"]) {
      expect(() => assertMyFatoorahPaymentMethod(method)).not.toThrow();
    }
  });

  it("rejects legacy regional methods as PaymentMethod (use DisplayPaymentMethods)", () => {
    for (const method of ["BENEFIT", "STC_PAY", "MADA", "QPAY", "OMANNET"]) {
      expect(() => assertMyFatoorahPaymentMethod(method)).toThrow(InvalidRequestError);
    }
  });

  it("rejects lowercase and PAN-shaped PaymentMethod values", () => {
    expect(() => assertMyFatoorahPaymentMethod("knet")).toThrow(InvalidRequestError);
    expect(() => assertMyFatoorahPaymentMethod("4111111111111111")).toThrow(InvalidRequestError);
    expect(() => assertMyFatoorahPaymentMethod(undefined)).toThrow(InvalidRequestError);
  });

  it("rejects bad DisplayPaymentMethods tokens", () => {
    expect(() =>
      assertMyFatoorahDisplayPaymentMethods(["card", "knet", "googlepay"]),
    ).not.toThrow();
    expect(() => assertMyFatoorahDisplayPaymentMethods(["CARD"])).toThrow(InvalidRequestError);
    expect(() => assertMyFatoorahDisplayPaymentMethods(["card", "has space"])).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects SourceOfFund.Card blobs", () => {
    expect(() =>
      assertNoPciCardSource({
        SourceOfFund: { Card: { Number: "4111111111111111" } },
      }),
    ).toThrow(InvalidRequestError);
  });

  it("rejects myfatoorahCard / source.card blobs", () => {
    expect(() => assertNoPciCardSource({ myfatoorahCard: { Number: "4111111111111111" } })).toThrow(
      InvalidRequestError,
    );
    expect(() => assertNoPciCardSource({ source: { card: {} } })).toThrow(InvalidRequestError);
  });

  it("rejects Card.Number / SecurityCode blobs", () => {
    expect(() => assertNoPciCardSource({ Card: { Number: "4111111111111111" } })).toThrow(
      InvalidRequestError,
    );
    expect(() => assertNoPciCardSource({ Card: { SecurityCode: "123" } })).toThrow(
      InvalidRequestError,
    );
  });

  it("allows SourceOfFund SessionId / Token (never raw cards)", () => {
    expect(() => assertNoPciCardSource({ SourceOfFund: { SessionId: "sess-1" } })).not.toThrow();
    expect(() => assertNoPciCardSource({ SourceOfFund: { Token: "tok-1" } })).not.toThrow();
  });
});
