import { describe, expect, it } from "bun:test";
import * as tap from "./index";

describe("public API runtime surface", () => {
  it("re-exports documented runtime symbols", () => {
    expect(typeof tap.tapGateway).toBe("function");
    expect(typeof tap.TapGateway).toBe("function");
    expect(tap.TAP_ADAPTER_VERSION).toBe("0.1.0-next.0");
    expect(tap.TAP_CAPABILITIES.payments).toBe(true);
    expect(tap.TAP_CAPABILITIES.hostedCheckout).toBe(false);
    expect(tap.TAP_CAPABILITIES.customers).toBe(false);
    expect(tap.TAP_CAPABILITIES.paymentLinks).toBe(false);
    expect(tap.TAP_CAPABILITIES.providerRecurring).toBe(false);
  });
});
