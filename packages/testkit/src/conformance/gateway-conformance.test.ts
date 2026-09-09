import { describe, expect, it } from "bun:test";
import { defineGatewayCapabilities, money } from "@paykernel/core";
import {
  GATEWAY_CONFORMANCE_CASES,
  mockGateway,
  runGatewayConformanceSuite,
} from "../index";

const fullCaps = defineGatewayCapabilities({
  payments: true,
  immediateCapture: true,
  authorization: true,
  partialCapture: true,
  refunds: true,
  partialRefunds: true,
  voids: true,
});

describe("runGatewayConformanceSuite", () => {
  it("golden-path mockGateway passes full suite (all cases)", async () => {
    const report = await runGatewayConformanceSuite({
      name: "mock-golden",
      mode: "full",
      createGateway: () =>
        mockGateway({
          name: "mock-golden",
          capabilities: fullCaps,
        }),
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.passed.length).toBeGreaterThan(0);
    // Every named case should appear as passed or skipped (not missing)
    const seen = new Set([
      ...report.passed,
      ...report.failed.map((f) => f.case),
      ...report.skipped.map((s) => s.case),
    ]);
    for (const c of GATEWAY_CONFORMANCE_CASES) {
      expect(seen.has(c)).toBe(true);
    }
    // Full mock path: no skips expected for full capabilities
    expect(report.skipped).toEqual([]);
  });

  it("skips partial_capture when capability unclaimed", async () => {
    const caps = defineGatewayCapabilities({
      payments: true,
      immediateCapture: true,
      refunds: true,
    });
    const report = await runGatewayConformanceSuite({
      name: "limited",
      mode: "full",
      createGateway: () =>
        mockGateway({
          name: "limited",
          capabilities: caps,
        }),
      capabilities: caps,
    });
    expect(report.ok).toBe(true);
    const partial = report.skipped.find((s) => s.case === "partial_capture");
    expect(partial).toBeDefined();
    expect(partial?.reason).toMatch(/partialCapture/);
  });

  it("structural mode only runs capabilities_parity + claim_method_presence", async () => {
    const report = await runGatewayConformanceSuite({
      name: "structural-mock",
      mode: "structural",
      createGateway: () => mockGateway({ capabilities: fullCaps }),
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(true);
    expect(report.passed).toContain("capabilities_parity");
    expect(report.passed).toContain("claim_method_presence");
    expect(report.passed.length).toBe(2);
    expect(report.skipped.length).toBeGreaterThan(0);
  });

  it("include/exclude filters named cases", async () => {
    const report = await runGatewayConformanceSuite({
      name: "filtered",
      mode: "full",
      include: ["capabilities_parity", "amount_conversion"],
      exclude: ["amount_conversion"],
      createGateway: () => mockGateway({ capabilities: fullCaps }),
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(true);
    expect(report.passed).toEqual(["capabilities_parity"]);
    expect(report.skipped.some((s) => s.case === "amount_conversion")).toBe(
      true,
    );
  });

  it("report shape: passed string[], failed/skipped objects", async () => {
    const report = await runGatewayConformanceSuite({
      name: "shape",
      mode: "structural",
      createGateway: () => mockGateway({ capabilities: fullCaps }),
      capabilities: fullCaps,
    });
    expect(typeof report.name).toBe("string");
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.passed)).toBe(true);
    expect(Array.isArray(report.failed)).toBe(true);
    expect(Array.isArray(report.skipped)).toBe(true);
  });

  it("partial_capture and partial_refund cases pass with strict money asserts (TESTKIT-1)", async () => {
    const report = await runGatewayConformanceSuite({
      name: "partial-money",
      mode: "full",
      include: ["partial_capture", "partial_refund", "safe_retry"],
      createGateway: () =>
        mockGateway({
          name: "partial-money",
          capabilities: fullCaps,
        }),
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.passed).toContain("partial_capture");
    expect(report.passed).toContain("partial_refund");
    expect(report.passed).toContain("safe_retry");
  });

  it("amount_conversion fails when result.amount is omitted (P05-CONF-1)", async () => {
    const report = await runGatewayConformanceSuite({
      name: "amount-omitted",
      mode: "full",
      include: ["amount_conversion"],
      createGateway: () => {
        const g = mockGateway({
          name: "amount-omitted",
          capabilities: fullCaps,
        });
        const orig = g.createPayment.bind(g);
        g.createPayment = async (params) => {
          const result = await orig(params);
          const { amount: _omit, ...rest } = result;
          return rest;
        };
        return g;
      },
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(false);
    const fail = report.failed.find((f) => f.case === "amount_conversion");
    expect(fail).toBeDefined();
    expect(fail?.error).toMatch(/amount/i);
  });

  it("logging_redaction fails when setLogger is a no-op (P05-CONF-1)", async () => {
    const report = await runGatewayConformanceSuite({
      name: "logger-noop",
      mode: "full",
      include: ["logging_redaction"],
      createGateway: () => {
        const g = mockGateway({
          name: "logger-noop",
          capabilities: fullCaps,
        });
        g.setLogger = () => {
          /* swallow injection — sink must not stay empty */
        };
        return g;
      },
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(false);
    const fail = report.failed.find((f) => f.case === "logging_redaction");
    expect(fail).toBeDefined();
    expect(fail?.error).toMatch(/inject logger|sink|PAN|apiSecret/i);
  });

  it("network_failure fails when result is outcome:succeeded paid (P05-CONF-1)", async () => {
    const report = await runGatewayConformanceSuite({
      name: "network-success-true",
      mode: "full",
      include: ["network_failure"],
      createGateway: () => {
        const g = mockGateway({
          name: "network-success-true",
          capabilities: fullCaps,
        });
        g.createPayment = async () => ({
          outcome: "succeeded" as const,
          status: "paid" as const,
          gatewayId: "pay_network_lie",
          amount: money("1.00", "USD"),
          currency: "USD",
          redirectUrl: undefined,
          rawResponse: { lie: "silent-paid-during-network-failure" },
        });
        return g;
      },
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(false);
    const fail = report.failed.find((f) => f.case === "network_failure");
    expect(fail).toBeDefined();
    expect(fail?.error).toMatch(/network_error should surface NetworkError/i);
  });

  it("indeterminate_outcomes fails when indeterminate is remapped to paid (P05-CONF-1)", async () => {
    const report = await runGatewayConformanceSuite({
      name: "indeterminate-paid",
      mode: "full",
      include: ["indeterminate_outcomes"],
      createGateway: () => {
        const g = mockGateway({
          name: "indeterminate-paid",
          capabilities: fullCaps,
        });
        const origEnqueue = g.enqueue.bind(g);
        g.enqueue = (operation, outcome) => {
          const name =
            outcome && typeof outcome === "object" && "outcome" in outcome
              ? (outcome as { outcome?: string }).outcome
              : undefined;
          if (name === "indeterminate") {
            origEnqueue(operation, { outcome: "succeeded" });
            return;
          }
          origEnqueue(operation, outcome);
        };
        return g;
      },
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(false);
    const fail = report.failed.find((f) => f.case === "indeterminate_outcomes");
    expect(fail).toBeDefined();
    expect(fail?.error).toMatch(/indeterminate|success|paid/i);
  });

  it("safe_retry fails when gatewayId diverges on retry (TESTKIT-2)", async () => {
    const report = await runGatewayConformanceSuite({
      name: "unsafe-retry",
      mode: "full",
      include: ["safe_retry"],
      createGateway: () =>
        mockGateway({
          name: "split",
          capabilities: fullCaps,
          // Disable process-local idempotency so retries mint new gatewayIds
          honorIdempotencyKey: false,
        }),
      capabilities: fullCaps,
    });
    expect(report.ok).toBe(false);
    const fail = report.failed.find((f) => f.case === "safe_retry");
    expect(fail).toBeDefined();
    expect(fail?.error).toMatch(/same gatewayId/i);
  });
});
