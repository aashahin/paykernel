import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as tap from "./index";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as { version: string };

describe("public API runtime surface", () => {
  it("re-exports documented runtime symbols", () => {
    expect(typeof tap.tapGateway).toBe("function");
    expect(typeof tap.TapGateway).toBe("function");
    expect(tap.TAP_ADAPTER_VERSION).toBe(pkg.version);
    expect(tap.tapGateway({ secretKey: "sk_test_x" }).manifest.version).toBe(pkg.version);
    expect(tap.TAP_CAPABILITIES.payments).toBe(true);
    expect(tap.TAP_CAPABILITIES.hostedCheckout).toBe(false);
    expect(tap.TAP_CAPABILITIES.customers).toBe(false);
    expect(tap.TAP_CAPABILITIES.paymentLinks).toBe(false);
    expect(tap.TAP_CAPABILITIES.providerRecurring).toBe(false);
  });
});
