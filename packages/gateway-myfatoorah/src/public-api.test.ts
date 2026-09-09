import { describe, expect, it } from "bun:test";
import * as myfatoorah from "./index";

describe("public API runtime surface", () => {
  it("re-exports documented runtime symbols", () => {
    expect(typeof myfatoorah.myfatoorahGateway).toBe("function");
    expect(typeof myfatoorah.MyFatoorahGateway).toBe("function");
    expect(myfatoorah.MYFATOORAH_ADAPTER_VERSION).toBe("0.1.0-next.0");
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.payments).toBe(true);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.immediateCapture).toBe(true);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.refunds).toBe(true);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.partialRefunds).toBe(true);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.tokenization).toBe(true);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.authorization).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.partialCapture).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.voids).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.hostedCheckout).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.customers).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.paymentMethods).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.marketplaceSplits).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.disputes).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.paymentLinks).toBe(false);
    expect(myfatoorah.MYFATOORAH_CAPABILITIES.providerRecurring).toBe(false);
  });
});
