import { describe, expect, it } from "bun:test";
import {
  createDefaultGatewayContext,
  createPaymentClient,
  HooksManager,
  InvalidRequestError,
} from "@paykernel/core";
import { MYFATOORAH_CAPABILITIES } from "./capabilities";
import { copyMyFatoorahConfig, resolveMyFatoorahBaseUrl } from "./config";
import { myfatoorahGateway } from "./factory";
import { MYFATOORAH_TEST_API_TOKEN, MYFATOORAH_TEST_WEBHOOK_SECRET } from "./fixtures/webhooks";
import { MyFatoorahGateway } from "./gateway";

describe("myfatoorahGateway", () => {
  it("rejects empty apiToken", () => {
    expect(() => myfatoorahGateway({ apiToken: "  ", country: "KWT" })).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects unknown country", () => {
    expect(() =>
      myfatoorahGateway({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "USA" as never,
      }),
    ).toThrow(InvalidRequestError);
  });

  it.each(["http://merchant.example/webhook", "not-a-url"] as const)(
    "rejects non-HTTPS webhookUrl %s",
    (webhookUrl) => {
      expect(() =>
        myfatoorahGateway({
          apiToken: MYFATOORAH_TEST_API_TOKEN,
          country: "KWT",
          webhookUrl,
        }),
      ).toThrow(InvalidRequestError);
    },
  );

  it("accepts HTTPS webhookUrl", () => {
    expect(() =>
      myfatoorahGateway({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        webhookUrl: "https://merchant.example/webhook",
      }),
    ).not.toThrow();
  });

  it("accepts a public hostname that starts with 10.", () => {
    expect(() =>
      myfatoorahGateway({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        webhookUrl: "https://10.example.com/webhook",
      }),
    ).not.toThrow();
  });

  it.each([
    "https://10.0.0.1/webhook",
    "https://192.168.1.1/webhook",
    "https://169.254.1.1/webhook",
    "https://[fd12:3456:789a::1]/webhook",
  ] as const)("rejects non-public webhook host %s", (webhookUrl) => {
    expect(() =>
      myfatoorahGateway({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        webhookUrl,
      }),
    ).toThrow(InvalidRequestError);
  });

  it("trims apiToken and webhookSecret", () => {
    const copied = copyMyFatoorahConfig({
      apiToken: `  ${MYFATOORAH_TEST_API_TOKEN}  `,
      country: "KWT",
      webhookSecret: `  ${MYFATOORAH_TEST_WEBHOOK_SECRET}  `,
    });
    expect(copied.apiToken).toBe(MYFATOORAH_TEST_API_TOKEN);
    expect(copied.webhookSecret).toBe(MYFATOORAH_TEST_WEBHOOK_SECRET);
  });

  it("rejects non-string webhookSecret", () => {
    expect(() =>
      copyMyFatoorahConfig({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        webhookSecret: 123 as unknown as string,
      }),
    ).toThrow(InvalidRequestError);
    expect(() =>
      copyMyFatoorahConfig({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        webhookSecret: true as unknown as string,
      }),
    ).toThrow(InvalidRequestError);
    expect(() =>
      myfatoorahGateway({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        webhookSecret: 123 as unknown as string,
      }),
    ).toThrow(InvalidRequestError);
  });

  it("rejects non-positive timeoutMs on the factory and the gateway", () => {
    expect(() =>
      myfatoorahGateway({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        timeoutMs: 0,
      }),
    ).toThrow(InvalidRequestError);
    expect(
      () =>
        new MyFatoorahGateway(
          {
            apiToken: MYFATOORAH_TEST_API_TOKEN,
            country: "KWT",
            timeoutMs: Number.NaN,
          },
          new HooksManager({}),
        ),
    ).toThrow(InvalidRequestError);
  });

  it("resolves sandbox and live base URLs by country", () => {
    expect(
      resolveMyFatoorahBaseUrl({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "ARE",
      }),
    ).toBe("https://apitest.myfatoorah.com");
    expect(
      resolveMyFatoorahBaseUrl({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "ARE",
        live: true,
      }),
    ).toBe("https://api-ae.myfatoorah.com");
    expect(
      resolveMyFatoorahBaseUrl({
        apiToken: MYFATOORAH_TEST_API_TOKEN,
        country: "KWT",
        live: true,
      }),
    ).toBe("https://api.myfatoorah.com");
  });

  it("closes over secrets and keeps them off the manifest", () => {
    const adapter = myfatoorahGateway({
      apiToken: MYFATOORAH_TEST_API_TOKEN,
      country: "KWT",
      webhookSecret: MYFATOORAH_TEST_WEBHOOK_SECRET,
    });
    expect(adapter.name).toBe("myfatoorah");
    expect(adapter.manifest.name).toBe("myfatoorah");
    expect(adapter.manifest.capabilities).toEqual(MYFATOORAH_CAPABILITIES);
    expect(JSON.stringify(adapter.manifest)).not.toContain(MYFATOORAH_TEST_API_TOKEN);
    expect(JSON.stringify(adapter.manifest)).not.toContain(MYFATOORAH_TEST_WEBHOOK_SECRET);
    const gateway = adapter.create(createDefaultGatewayContext());
    expect(gateway).toBeInstanceOf(MyFatoorahGateway);
    expect(gateway.name).toBe("myfatoorah");
    expect(gateway.supports("payments")).toBe(true);
    expect(gateway.supports("refunds")).toBe(true);
    expect(gateway.supports("authorization")).toBe(false);
    expect(gateway.supports("voids")).toBe(false);
    expect(gateway.supports("hostedCheckout")).toBe(false);
  });

  it("composes with createPaymentClient without core factory edits", () => {
    const client = createPaymentClient({
      gateways: {
        myfatoorah: myfatoorahGateway({
          apiToken: MYFATOORAH_TEST_API_TOKEN,
          country: "KWT",
        }),
      },
      defaultGateway: "myfatoorah",
    });
    expect(client.gateway("myfatoorah")).toBeInstanceOf(MyFatoorahGateway);
    expect(client.hasGateway("myfatoorah")).toBe(true);
  });
});
