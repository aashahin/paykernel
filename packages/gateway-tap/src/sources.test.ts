import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "@paykernel/core";
import {
  assertAllowedTapSourceId,
  assertNoPciCardSource,
  resolveTapSourceId,
} from "./sources";

describe("Tap sources", () => {
  it("defaults to src_all", () => {
    expect(resolveTapSourceId(undefined)).toBe("src_all");
  });

  it("allows tokens, hosted lists, local methods, and authorize ids", () => {
    expect(() => assertAllowedTapSourceId("tok_testToken01")).not.toThrow();
    expect(() => assertAllowedTapSourceId("src_all")).not.toThrow();
    expect(() => assertAllowedTapSourceId("src_card")).not.toThrow();
    expect(() => assertAllowedTapSourceId("src_kw.knet")).not.toThrow();
    expect(() => assertAllowedTapSourceId("auth_testAuthorize01")).not.toThrow();
    expect(() => assertAllowedTapSourceId("tok_1234567890123")).not.toThrow();
  });

  it("rejects PAN-shaped ids and PCI source.card", () => {
    expect(() => assertAllowedTapSourceId("4242424242424242")).toThrow(
      InvalidRequestError,
    );
    expect(() =>
      assertNoPciCardSource({ source: { card: "encrypted-blob" } }),
    ).toThrow(InvalidRequestError);
    expect(() =>
      assertNoPciCardSource({ source: { on_file: true, id: "src_all" } }),
    ).toThrow(InvalidRequestError);
  });
});
