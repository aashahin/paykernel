import { expect, it } from "bun:test";
import { createDefaultGatewayContext, InMemoryIdempotencyStore } from "@paykernel/core";
import { runGatewayConformanceSuite } from "@paykernel/testkit";
import { hesabeGateway } from "./index";

it("passes applicable gateway conformance without provider HTTP", async () => {
  // Signed-webhook cases do not apply: Hesabe confirms facts via async enquiry.
  // That path is exercised with injected fetch in gateway.test.ts.
  const report = await runGatewayConformanceSuite({
    name: "hesabe",
    mode: "applicable",
    createGateway: () =>
      hesabeGateway({
        merchantCode: "test",
        accessCode: "test",
        encryptionKey: "a".repeat(32),
        ivKey: "b".repeat(16),
        username: "test",
        password: "test",
        idempotencyStore: new InMemoryIdempotencyStore(),
      }).create(createDefaultGatewayContext()),
  });
  expect(report.failed).toEqual([]);
  expect(report.passed).toContain("capabilities_parity");
  expect(report.passed).toContain("claim_method_presence");
});
