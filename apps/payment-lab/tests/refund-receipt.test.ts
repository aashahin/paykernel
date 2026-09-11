import { describe, expect, it } from "bun:test";
import type { GatewayRefundResult } from "@paykernel/core";
import { normalizeRefundReceipt } from "../src/server/refund-receipt";
import type { LabAttempt, LabOperation } from "../src/server/payments/types";

function attempt(over: Partial<LabAttempt> = {}): LabAttempt {
  return {
    id: "att_1",
    orderId: "ord_1",
    gateway: "moyasar",
    mode: "sandbox",
    amountMinor: 10000,
    currency: "SAR",
    captureIntent: "automatic",
    idempotencyKey: "idem",
    fingerprint: "fp",
    status: "paid",
    ambiguous: false,
    pendingOperationId: undefined,
    provider: {},
    capturedMinor: 10000,
    refundedMinor: 0,
    version: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

function operation(over: Partial<LabOperation> = {}): LabOperation {
  return {
    id: "op_1",
    attemptId: "att_1",
    kind: "refund",
    idempotencyKey: "op-idem",
    fingerprint: "fp",
    amountMinor: 2000,
    currency: "SAR",
    providerId: "pay_123",
    status: "submitted",
    attempts: 1,
    nextRetryAt: undefined,
    lastError: undefined,
    version: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

function refund(over: Partial<GatewayRefundResult> = {}): GatewayRefundResult {
  return {
    outcome: "succeeded",
    gatewayRefundId: "pay_123",
    status: "completed",
    rawResponse: {},
    ...over,
  };
}

describe("normalizeRefundReceipt", () => {
  it("moyasar repeated partial uses cumulative delta and namespaces id", () => {
    const first = normalizeRefundReceipt(
      attempt({ gateway: "moyasar", refundedMinor: 0 }),
      operation({ id: "op_1", amountMinor: 2000 }),
      refund({ status: "completed", totalRefunded: { amount: "20.00", currency: "SAR" } }),
    );
    expect(first.amountMinor).toBe(2000);
    expect(first.status).toBe("completed");
    expect(first.providerRefundId).toBe("pay_123:op_1");
    const second = normalizeRefundReceipt(
      attempt({ gateway: "moyasar", refundedMinor: 2000 }),
      operation({ id: "op_2", amountMinor: 3000 }),
      refund({ status: "completed", totalRefunded: { amount: "50.00", currency: "SAR" } }),
    );
    expect(second.amountMinor).toBe(3000);
    expect(second.providerRefundId).toBe("pay_123:op_2");
  });

  it("paymob cumulative completed delta and pending without total", () => {
    const done = normalizeRefundReceipt(
      attempt({ gateway: "paymob", refundedMinor: 1000 }),
      operation({ amountMinor: 2000, providerId: "txn_1" }),
      refund({ gatewayRefundId: "re_paymob_1", status: "completed", outcome: "succeeded", totalRefunded: { amount: "30.00", currency: "SAR" } }),
    );
    expect(done.amountMinor).toBe(2000);
    expect(done.providerRefundId).toBe("re_paymob_1");
    const pending = normalizeRefundReceipt(
      attempt({ gateway: "paymob", refundedMinor: 1000 }),
      operation({ amountMinor: 2000, providerId: "txn_1" }),
      refund({ gatewayRefundId: "re_paymob_2", status: "pending", outcome: "pending", totalRefunded: undefined }),
    );
    expect(pending.status).toBe("pending");
    expect(pending.amountMinor).toBe(2000);
  });

  it("tap completed uses raw id/amount and checks charge correlation", () => {
    const got = normalizeRefundReceipt(
      attempt({ gateway: "tap" }),
      operation({ amountMinor: 2000, providerId: "chg_123" }),
      refund({ gatewayRefundId: "re_tap_1", status: "completed", rawResponse: { id: "re_tap_1", amount: 20, currency: "SAR", charge_id: "chg_123" } }),
    );
    expect(got.amountMinor).toBe(2000);
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "tap" }),
        operation({ amountMinor: 2000, providerId: "chg_123" }),
        refund({ gatewayRefundId: "re_tap_1", status: "completed", rawResponse: { id: "re_tap_1", amount: 20, currency: "SAR", charge_id: "chg_other" } }),
      ),
    ).toThrow("refund amount mismatch");
  });

  it("hesabe completed uses token correlation and KWD amount", () => {
    const got = normalizeRefundReceipt(
      attempt({ gateway: "hesabe", currency: "KWD", amountMinor: 10000, capturedMinor: 10000 }),
      operation({ amountMinor: 10000, currency: "KWD", providerId: "tx_123" }),
      refund({ gatewayRefundId: "1467", status: "completed", rawResponse: { id: "1467", token: "tx_123", amount: "10.000", currency: "KWD", status: 1, refund_at: "2024-05-01T10:00:00.000Z" } }),
    );
    expect(got.amountMinor).toBe(10000);
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "hesabe", currency: "KWD", amountMinor: 10000, capturedMinor: 10000 }),
        operation({ amountMinor: 10000, currency: "KWD", providerId: "tx_123" }),
        refund({ gatewayRefundId: "1467", status: "completed", rawResponse: { id: "1467", token: "tx_other", amount: "10.000", currency: "KWD", status: 1, refund_at: null } }),
      ),
    ).toThrow("refund amount mismatch");
  });

  it("simulator pending uses per-refund total", () => {
    const got = normalizeRefundReceipt(
      attempt({ gateway: "moyasar", mode: "simulator", currency: "USD", amountMinor: 5000, capturedMinor: 5000 }),
      operation({ amountMinor: 5000, currency: "USD", providerId: "sim_stripe_ref" }),
      refund({ gatewayRefundId: "sim_ref_1", status: "pending", outcome: "pending", totalRefunded: { amount: "50.00", currency: "USD" } }),
    );
    expect(got.status).toBe("pending");
    expect(got.amountMinor).toBe(5000);
    expect(got.providerRefundId).toBe("sim_ref_1");
  });

  it("myfatoorah pending without money uses operation amount; completed without money throws", () => {
    const pending = normalizeRefundReceipt(
      attempt({ gateway: "myfatoorah", currency: "KWD", amountMinor: 10000, capturedMinor: 10000 }),
      operation({ amountMinor: 10000, currency: "KWD", providerId: "915102" }),
      refund({ gatewayRefundId: "mf_re_1", status: "pending", outcome: "pending", totalRefunded: undefined, rawResponse: { stable: true } }),
    );
    expect(pending.amountMinor).toBe(10000);
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "myfatoorah", currency: "KWD", amountMinor: 10000, capturedMinor: 10000 }),
        operation({ amountMinor: 10000, currency: "KWD", providerId: "915102" }),
        refund({ gatewayRefundId: "mf_re_1", status: "completed", outcome: "succeeded", totalRefunded: undefined, rawResponse: {} }),
      ),
    ).toThrow("refund amount mismatch");
  });

  it("stripe completed without proven money throws", () => {
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "stripe", currency: "USD", amountMinor: 2000, capturedMinor: 2000 }),
        operation({ amountMinor: 2000, currency: "USD" }),
        refund({ gatewayRefundId: "re_123", status: "completed", totalRefunded: undefined, rawResponse: {} }),
      ),
    ).toThrow("refund amount mismatch");
  });

  it("rejects currency, delta, indeterminate and reconciliation mismatches", () => {
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "moyasar", refundedMinor: 0 }),
        operation({ amountMinor: 2000 }),
        refund({ status: "completed", totalRefunded: { amount: "20.00", currency: "USD" } }),
      ),
    ).toThrow("refund amount mismatch");
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "moyasar", refundedMinor: 0 }),
        operation({ amountMinor: 2000 }),
        refund({ status: "completed", totalRefunded: { amount: "30.00", currency: "SAR" } }),
      ),
    ).toThrow("refund amount mismatch");
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "stripe", currency: "USD", amountMinor: 2000, capturedMinor: 2000 }),
        operation({ amountMinor: 2000, currency: "USD" }),
        refund({ gatewayRefundId: "re_1", status: "pending", outcome: "indeterminate", rawResponse: {} }),
      ),
    ).toThrow("reconcile required");
    expect(() =>
      normalizeRefundReceipt(
        attempt({ gateway: "stripe", currency: "USD", amountMinor: 2000, capturedMinor: 2000 }),
        operation({ amountMinor: 2000, currency: "USD" }),
        refund({ gatewayRefundId: "re_1", status: "pending", outcome: "pending", reconciliationRequired: true, rawResponse: {} }),
      ),
    ).toThrow("reconcile required");
  });
});
