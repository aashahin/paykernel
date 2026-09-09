import { describe, it, expect } from "bun:test";
import {
  createGatewayRegistry,
  createDynamicGatewayRegistry,
} from "./gateway-registry";
import {
  createDefaultGatewayContext,
  createRedactingTelemetrySink,
} from "./gateway-context";
import type { GatewayAdapter } from "./gateway-adapter";
import type { PaymentGateway } from "./gateway.interface";
import { defineGatewayCapabilities } from "./gateway-capabilities";
import type {
  CreatePaymentParams,
  CaptureParams,
  RefundParams,
  GatewayPaymentResult,
  GatewayRefundResult,
} from "../types/payment.types";
import type { WebhookEvent } from "../types/webhook.types";
import { InvalidRequestError } from "../errors";
import { money } from "../utils/money";

function mockPaymentResult(
  gatewayId: string,
): GatewayPaymentResult {
  return {
    success: true,
    gatewayId,
    status: "paid",
    redirectUrl: undefined,
    rawResponse: {},
  };
}

function createMockGateway<N extends string>(name: N): PaymentGateway<N> {
  const capabilities = defineGatewayCapabilities({});
  return {
    name,
    capabilities,
    supports(capability) {
      return capabilities[capability] === true;
    },
    async createPayment(_params: CreatePaymentParams) {
      return mockPaymentResult(`${name}_pay`);
    },
    async capturePayment(_params: CaptureParams) {
      return mockPaymentResult(`${name}_cap`);
    },
    async refundPayment(_params: RefundParams): Promise<GatewayRefundResult> {
      return {
        success: true,
        gatewayRefundId: `${name}_ref`,
        status: "completed",
        rawResponse: {},
      };
    },
    verifyWebhook() {
      return true;
    },
    parseWebhookEvent(payload: unknown): WebhookEvent {
      return {
        id: "evt_1",
        type: "payment_paid",
        gateway: name,
        paymentId: undefined,
        gatewayPaymentId: "pay_1",
        status: "paid",
        timestamp: new Date(),
        rawPayload: payload,
      };
    },
  };
}

function createMockAdapter<N extends string>(
  name: N,
  displayName?: string,
): GatewayAdapter<N, PaymentGateway<N>> {
  return {
    name,
    manifest: {
      name,
      displayName: displayName ?? name,
      version: "1.0.0",
      metadata: { kind: "test" },
    },
    create() {
      return createMockGateway(name);
    },
  };
}

describe("createGatewayRegistry", () => {
  it("registers two adapters, builds, and reports matching names", () => {
    const registry = createGatewayRegistry()
      .register(createMockAdapter("alpha"))
      .register(createMockAdapter("beta"))
      .build();

    expect(registry.names()).toEqual(["alpha", "beta"]);
    expect(registry.has("alpha")).toBe(true);
    expect(registry.has("beta")).toBe(true);
    expect(registry.has("gamma")).toBe(false);
    expect(registry.getAdapter("alpha")?.name).toBe("alpha");
    expect(registry.getAdapterByName("beta")?.name).toBe("beta");
    expect(registry.getAdapterByName("missing")).toBeUndefined();
  });

  it("throws InvalidRequestError on duplicate register", () => {
    const builder = createGatewayRegistry().register(createMockAdapter("dup"));
    expect(() => builder.register(createMockAdapter("dup"))).toThrow(
      InvalidRequestError,
    );
  });

  it("replace overwrites in place and preserves registration order", () => {
    const first = createMockAdapter("custom", "First");
    const second = createMockAdapter("custom", "Second");

    const registry = createGatewayRegistry()
      .register(first)
      .register(createMockAdapter("other"))
      .replace(second)
      .build();

    expect(registry.names()).toEqual(["custom", "other"]);
    expect(registry.getAdapter("custom")?.manifest.displayName).toBe("Second");
  });

  it("replace inserts when name was not previously registered", () => {
    const registry = createGatewayRegistry()
      .replace(createMockAdapter("only"))
      .build();
    expect(registry.names()).toEqual(["only"]);
    expect(registry.has("only")).toBe(true);
  });

  it("built registry is frozen; second build is independent", () => {
    const builder = createGatewayRegistry().register(createMockAdapter("a"));
    const first = builder.build();
    const second = builder.register(createMockAdapter("b")).build();

    expect(first.names()).toEqual(["a"]);
    expect(second.names()).toEqual(["a", "b"]);

    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      // @ts-expect-error — registry surface is readonly
      first.names = () => ["mutated"];
    }).toThrow();

    // Mutating names() return should not affect subsequent calls (frozen array)
    const names = first.names() as string[];
    expect(Object.isFrozen(names)).toBe(true);
    expect(() => {
      (names as string[]).push("hacked");
    }).toThrow();
  });

  it("freezes manifests (mutation is a no-op or throws in strict mode)", () => {
    const registry = createGatewayRegistry()
      .register(createMockAdapter("m"))
      .build();

    const [manifest] = registry.manifests();
    expect(manifest).toBeDefined();
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest!.metadata)).toBe(true);

    expect(() => {
      (manifest as { name: string }).name = "hacked";
    }).toThrow();

    expect(() => {
      (manifest!.metadata as { kind: string }).kind = "hacked";
    }).toThrow();

    expect(manifest!.name).toBe("m");
    expect(manifest!.metadata).toEqual({ kind: "test" });
  });

  it("createAll materializes instances once per name via context", async () => {
    let createCount = 0;
    const adapter: GatewayAdapter<"count", PaymentGateway<"count">> = {
      name: "count",
      manifest: { name: "count" },
      create(ctx) {
        createCount += 1;
        expect(ctx.hooks).toBeDefined();
        expect(typeof ctx.uuid()).toBe("string");
        return createMockGateway("count");
      },
    };

    const registry = createGatewayRegistry().register(adapter).build();
    const ctx = createDefaultGatewayContext();
    const gateways = registry.createAll(ctx);

    expect(createCount).toBe(1);
    expect(gateways.count.name).toBe("count");
    expect(Object.isFrozen(gateways)).toBe(true);

    const result = await gateways.count.createPayment({
      amount: money(1, "USD"),
      currency: "USD",
      callbackUrl: "https://example.com/cb",
    });
    expect(result.gatewayId).toBe("count_pay");
  });

  it("createAll wraps hand-built telemetry so secrets do not reach the sink", () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const adapter: GatewayAdapter<"t", PaymentGateway<"t">> = {
      name: "t",
      manifest: { name: "t" },
      create(ctx) {
        ctx.telemetry?.emit?.("x", { cardNumber: "4242424242424242" });
        return createMockGateway("t");
      },
    };
    createGatewayRegistry()
      .register(adapter)
      .build()
      .createAll({
        ...createDefaultGatewayContext(),
        telemetry: {
          emit(_event, data) {
            seen.push(data);
          },
        },
      });
    expect(seen[0]?.cardNumber).toBe("[REDACTED]");
    expect(JSON.stringify(seen[0])).not.toContain("4242424242424242");
  });

  it("rejects adapter when manifest.name does not match adapter.name", () => {
    const bad: GatewayAdapter = {
      name: "left",
      manifest: { name: "right" },
      create: () => createMockGateway("left"),
    };
    expect(() => createGatewayRegistry().register(bad)).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects empty or whitespace-only adapter names", () => {
    const empty: GatewayAdapter = {
      name: "",
      manifest: { name: "" },
      create: () => createMockGateway("x"),
    };
    const blank: GatewayAdapter = {
      name: "   ",
      manifest: { name: "   " },
      create: () => createMockGateway("x"),
    };
    expect(() => createGatewayRegistry().register(empty)).toThrow(
      InvalidRequestError,
    );
    expect(() => createGatewayRegistry().register(blank)).toThrow(
      InvalidRequestError,
    );
  });

  it("snapshots adapter at register so later mutation does not affect build", () => {
    const mutable = createMockAdapter("stable");
    const builder = createGatewayRegistry().register(mutable);
    // Mutating the original after register must not change the registry entry.
    (mutable as { name: string }).name = "hacked";
    (mutable.manifest as { name: string }).name = "hacked";
    const registry = builder.build();
    expect(registry.names()).toEqual(["stable"]);
    expect(registry.getAdapter("stable")?.name).toBe("stable");
    expect(registry.getAdapter("stable")?.manifest.name).toBe("stable");
  });

  it("createAll throws when instance name mismatches adapter name", () => {
    const bad: GatewayAdapter<"x", PaymentGateway<"x">> = {
      name: "x",
      manifest: { name: "x" },
      create: () => createMockGateway("y") as PaymentGateway<"x">,
    };
    const registry = createGatewayRegistry().register(bad).build();
    expect(() => registry.createAll(createDefaultGatewayContext())).toThrow(
      InvalidRequestError,
    );
  });

  it("registerDynamic accepts a loosely typed adapter and rejects duplicates", () => {
    const adapter = createMockAdapter("dyn-via-registerDynamic");
    const builder = createGatewayRegistry().registerDynamic(
      adapter as GatewayAdapter<string, PaymentGateway>,
    );
    const registry = builder.build();
    expect(registry.names()).toEqual(["dyn-via-registerDynamic"]);
    expect(registry.has("dyn-via-registerDynamic")).toBe(true);

    const again = createGatewayRegistry().registerDynamic(
      adapter as GatewayAdapter<string, PaymentGateway>,
    );
    expect(() =>
      again.registerDynamic(adapter as GatewayAdapter<string, PaymentGateway>),
    ).toThrow(InvalidRequestError);
  });
});

describe("createDynamicGatewayRegistry", () => {
  it("accepts string-keyed adapters and builds a usable registry", () => {
    const registry = createDynamicGatewayRegistry()
      .register(createMockAdapter("dyn-a"))
      .register(createMockAdapter("dyn-b"))
      .build();

    expect(registry.names()).toEqual(["dyn-a", "dyn-b"]);
    const gateways = registry.createAll(createDefaultGatewayContext());
    expect(gateways["dyn-a"]?.name).toBe("dyn-a");
  });

  it("still rejects duplicate register", () => {
    const builder = createDynamicGatewayRegistry().register(
      createMockAdapter("same"),
    );
    expect(() => builder.register(createMockAdapter("same"))).toThrow(
      InvalidRequestError,
    );
  });

  it("registerDynamic on dynamic builder works end-to-end", () => {
    const registry = createDynamicGatewayRegistry()
      .registerDynamic(
        createMockAdapter("rd1") as GatewayAdapter<string, PaymentGateway>,
      )
      .registerDynamic(
        createMockAdapter("rd2") as GatewayAdapter<string, PaymentGateway>,
      )
      .build();
    expect(registry.names()).toEqual(["rd1", "rd2"]);
    const instances = registry.createAll(createDefaultGatewayContext());
    expect(instances["rd1"]?.name).toBe("rd1");
  });
});

describe("createDefaultGatewayContext", () => {
  it("provides portable defaults without secrets", () => {
    const ctx = createDefaultGatewayContext();
    expect(ctx.hooks).toBeDefined();
    expect(typeof ctx.fetch).toBe("function");
    expect(ctx.clock.now()).toBeInstanceOf(Date);
    expect(typeof ctx.clock.nowMs()).toBe("number");
    expect(typeof ctx.crypto.randomUUID()).toBe("string");
    expect(typeof ctx.uuid()).toBe("string");
    // Phase 8: GatewayContext extends PaymentRuntime
    expect(typeof ctx.randomUUID).toBe("function");
    expect(ctx.randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const bytes = new Uint8Array(4);
    ctx.crypto.getRandomValues(bytes);
    // Not all zeros with overwhelming probability
    expect(bytes.some((b) => b !== 0) || bytes.length === 0).toBe(true);
  });

  it("honors partial overrides", () => {
    const customLogger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
    let uuidCalls = 0;
    const ctx = createDefaultGatewayContext({
      logger: customLogger,
      uuid: () => {
        uuidCalls += 1;
        return "fixed-uuid";
      },
    });
    expect(ctx.logger).toBe(customLogger);
    expect(ctx.uuid()).toBe("fixed-uuid");
    expect(uuidCalls).toBe(1);
  });

  it("falls back to getRandomValues UUID when randomUUID is missing", () => {
    const original = globalThis.crypto;
    const getRandomValues = (array: ArrayBufferView) => {
      const view = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
      );
      for (let i = 0; i < view.length; i++) {
        view[i] = (i * 17 + 3) & 0xff;
      }
      return array;
    };
    // Minimal Web Crypto surface without randomUUID
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues },
    });
    try {
      const ctx = createDefaultGatewayContext();
      const id = ctx.crypto.randomUUID();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(ctx.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: original,
      });
    }
  });

  it("throws when Web Crypto is absent (no Math.random fallback; CORE-3)", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(() => createDefaultGatewayContext()).toThrow(
        /Web Crypto API is unavailable/,
      );
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: original,
      });
    }
  });

  it("attaches optional telemetry when provided", () => {
    const events: string[] = [];
    const ctx = createDefaultGatewayContext({
      telemetry: {
        emit(event) {
          events.push(event);
        },
      },
    });
    expect(ctx.telemetry).toBeDefined();
    ctx.telemetry?.emit?.("test.event");
    expect(events).toEqual(["test.event"]);
  });

  it("wraps provided telemetry so cardNumber/secret emits are redacted (P20-TELEMETRY-WRAP)", () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const ctx = createDefaultGatewayContext({
      telemetry: {
        emit(_event, data) {
          seen.push(data);
        },
      },
    });
    ctx.telemetry?.emit?.("payment.operation", {
      cardNumber: "4242424242424242",
      secret: "sk_live_abc123secret",
      providerRequestId: "req_ok",
    });
    const data = seen[0]!;
    expect(data.cardNumber).toBe("[REDACTED]");
    expect(data.secret).toBe("[REDACTED]");
    expect(data.providerRequestId).toBe("req_ok");
    expect(JSON.stringify(data)).not.toContain("4242424242424242");
    expect(JSON.stringify(data)).not.toContain("sk_live");
  });

  it("double-wraps already-redacting telemetry without unmasking secrets (P20-TELEMETRY-WRAP)", () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const ctx = createDefaultGatewayContext({
      telemetry: createRedactingTelemetrySink({
        emit(_event, data) {
          seen.push(data);
        },
      }),
    });
    ctx.telemetry?.emit?.("payment.operation", {
      cardNumber: "4111111111111111",
      token: "tok_secret",
    });
    expect(seen[0]!.cardNumber).toBe("[REDACTED]");
    expect(seen[0]!.token).toBe("[REDACTED]");
    expect(JSON.stringify(seen[0])).not.toContain("4111111111111111");
  });
});
