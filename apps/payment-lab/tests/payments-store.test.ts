import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createOrder, editOrder, getOrder, updateOrderNotes } from "../src/server/payments/orders";
import { getAttempt, listAttemptsByOrder, reserveAttempt } from "../src/server/payments/attempts";
import { applyPaymentEvidence, applyRefundEvidence } from "../src/server/payments/evidence";
import { getOperation, markOperationCompleted, markOperationSubmitted, reserveOperation } from "../src/server/payments/operations";
import type { D1DatabaseLike } from "../src/server/payments/db";
import { createGatewayIdempotencyStore } from "../src/server/sdk-stores";
import { controlSimulatorPayment, createSimulatorDriver, getSimulatorRefund, settleSimulatorRefund } from "../src/server/gateways/simulator";
import { fromMinorUnits, toMinorUnits } from "@paykernel/core";
import { normalizeGatewayPayment } from "../src/server/payment-evidence";

const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-09-09",
  d1Databases: ["DB"],
}));
let db: D1DatabaseLike;
const items = [{ sku: "notebook", name: "Notebook", quantity: 1, unitMinor: 1000 }];

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const migration = await readFile(new URL("../migrations/0002_payments.sql", import.meta.url), "utf8");
  await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  const sdkMigration = await readFile(new URL("../migrations/0003_sdk_stores.sql", import.meta.url), "utf8");
  await db.exec(sdkMigration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  for (const name of ["0004_checkout_details.sql", "0005_operation_baseline.sql"]) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  }
});

async function fundedAttempt(status: "paid" | "authorized" = "paid") {
  const initial = await order();
  const { attempt } = await reserveAttempt(db, {
    orderId: initial.id, gateway: "stripe", mode: "simulator", amountMinor: 1000, currency: "USD",
    captureIntent: status === "paid" ? "automatic" : "manual", idempotencyKey: crypto.randomUUID(), fingerprint: crypto.randomUUID(),
  });
  return (await applyPaymentEvidence(db, { attemptId: attempt.id, expectedVersion: attempt.version,
    evidence: { amountMinor: 1000, currency: "USD", status, capturedMinor: status === "paid" ? 1000 : 0, provider: { providerObjectId: `pi_${attempt.id}` } },
  })).attempt;
}

describe("payment operations and settlement", () => {
  test("capture reservation retains its balance when webhook evidence arrives first", async () => {
    const attempt = await fundedAttempt("authorized");
    const { operation } = await reserveOperation(db, { attemptId: attempt.id, kind: "capture", amountMinor: 400, currency: "USD", idempotencyKey: crypto.randomUUID(), fingerprint: "capture-400" });
    expect(operation.capturedBeforeMinor).toBe(0);
    const current = await getAttempt(db, attempt.id);
    await applyPaymentEvidence(db, { attemptId: attempt.id, expectedVersion: current.version,
      evidence: { amountMinor: 1000, capturedMinor: 400, currency: "USD", status: "partially_captured", provider: attempt.provider } });
    const durable = await getOperation(db, operation.id);
    const updated = await getAttempt(db, attempt.id);
    expect(updated.capturedMinor - durable.capturedBeforeMinor!).toBe(durable.amountMinor);
  });

  test("Tap partial capture and Paymob child receipts retain nominal amount and original resource", async () => {
    const base = await fundedAttempt("authorized");
    const tap = { ...base, gateway: "tap" as const, mode: "sandbox" as const, provider: { providerObjectId: "auth_owned" } };
    const capture = { outcome: "succeeded" as const, status: "paid" as const, gatewayId: "chg_owned", authorizationId: "auth_owned", amount: fromMinorUnits(400, "USD"), rawResponse: undefined, redirectUrl: undefined };
    const first = normalizeGatewayPayment(tap, capture);
    expect(first.amountMinor).toBe(1000);
    expect(first.capturedMinor).toBe(400);
    expect(first.status).toBe("partially_captured");
    expect(normalizeGatewayPayment({ ...tap, capturedMinor: 400, provider: first.provider }, capture).capturedMinor).toBe(400);
    expect(() => normalizeGatewayPayment(tap, { ...capture, authorizationId: "auth_other" })).toThrow();
    const paymob = { ...base, gateway: "paymob" as const, mode: "sandbox" as const, provider: { providerObjectId: "intention", providerAuthorizationId: "123", providerCaptureId: "123" } };
    const second = normalizeGatewayPayment(paymob, { ...capture, gatewayId: "123", captureId: "456", authorizationId: undefined, amount: undefined, capturedAmount: fromMinorUnits(400, "USD"), status: "partially_captured" });
    expect(second.amountMinor).toBe(1000);
    expect(second.capturedMinor).toBe(400);
    expect(second.provider.providerAuthorizationId).toBe("123");
    expect(second.provider.providerCaptureId).toBe("456");
  });

  test("simulator preserves money across concurrent mutations, retries, and new instances", async () => {
    const driver = createSimulatorDriver(db, "stripe");
    const input = { reference: crypto.randomUUID(), amount: fromMinorUnits(1000, "USD"), customer: { name: "Buyer", email: "buyer@example.com" }, callbackUrl: "https://example.com/return", idempotencyKey: crypto.randomUUID() };
    const creations = await Promise.all([driver.create(input), driver.create(input)]);
    const id = creations[0]!.gatewayId;
    expect(creations[1]!.gatewayId).toBe(id);
    await controlSimulatorPayment(db, "stripe", id, "authorized");
    const captures = await Promise.allSettled([1, 2].map(() => driver.capture({ gatewayPaymentId: id, amount: fromMinorUnits(600, "USD"), idempotencyKey: crypto.randomUUID() })));
    expect(captures.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const fresh = createSimulatorDriver(db, "stripe");
    expect(toMinorUnits((await fresh.lookup(id)).capturedAmount!)).toBe(600n);
    const captureKey = crypto.randomUUID();
    await fresh.capture({ gatewayPaymentId: id, idempotencyKey: captureKey });
    expect((await fresh.capture({ gatewayPaymentId: id, idempotencyKey: captureKey })).status).toBe("paid");
    const refunds = await Promise.allSettled([1, 2].map(() => fresh.refund({ gatewayPaymentId: id, amount: fromMinorUnits(600, "USD"), idempotencyKey: crypto.randomUUID() })));
    expect(refunds.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const refund = refunds.find(result => result.status === "fulfilled");
    if (!refund || refund.status !== "fulfilled") throw new Error("Expected one refund");
    expect(refund.value.status).toBe("pending");
    await settleSimulatorRefund(db, "stripe", refund.value.gatewayRefundId, "completed");
    expect((await getSimulatorRefund(db, "stripe", refund.value.gatewayRefundId)).status).toBe("completed");
    expect((await fresh.lookup(id)).status).toBe("paid");
    await expect(controlSimulatorPayment(db, "stripe", id, "pending")).rejects.toThrow("reverse");
  });
  test("SDK idempotency is shared between instances and unknown outcomes remain blocked", async () => {
    const first = createGatewayIdempotencyStore(db, "stripe:sandbox");
    const second = createGatewayIdempotencyStore(db, "stripe:sandbox");
    const input = { status: "in_progress" as const, fingerprint: "request", createdAt: Date.now() };
    const key = crypto.randomUUID();
    const results = await Promise.all([first.reserve(key, input), second.reserve(key, input)]);
    expect(results.filter(result => result === undefined)).toHaveLength(1);
    const owner = results[0] === undefined ? first : second;
    const other = results[0] === undefined ? second : first;
    await expect(other.set(key, { ...input, status: "completed", result: {} })).rejects.toThrow("ownership");
    await owner.set(key, { ...input, status: "unknown" });
    expect((await other.reserve(key, input))?.status).toBe("unknown");
    const isolated = createGatewayIdempotencyStore(db, "stripe:simulator");
    expect(await isolated.reserve(key, input)).toBeUndefined();
  });
  test("capture and void cannot both reserve an authorization", async () => {
    const attempt = await fundedAttempt("authorized");
    const results = await Promise.allSettled((["capture", "void"] as const).map(kind => reserveOperation(db, {
      attemptId: attempt.id, kind, amountMinor: kind === "void" ? 0 : 1000, currency: "USD",
      idempotencyKey: crypto.randomUUID(), fingerprint: kind,
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await getAttempt(db, attempt.id)).ambiguous).toBe(true);
  });

  test("refund pending does not move money; duplicate completion settles exactly once", async () => {
    const attempt = await fundedAttempt();
    let { operation } = await reserveOperation(db, { attemptId: attempt.id, kind: "refund", amountMinor: 400, currency: "USD", idempotencyKey: crypto.randomUUID(), fingerprint: "refund-400" });
    operation = await markOperationSubmitted(db, { operationId: operation.id, expectedVersion: operation.version });
    const input = { attemptId: attempt.id, operationId: operation.id, evidence: { providerRefundId: "re_" + crypto.randomUUID(), amountMinor: 400, currency: "USD", status: "pending" as const } };
    expect((await applyRefundEvidence(db, input)).attempt.refundedMinor).toBe(0);
    await markOperationCompleted(db, { operationId: operation.id, expectedVersion: operation.version });
    await expect(reserveOperation(db, { attemptId: attempt.id, kind: "refund", amountMinor: 700, currency: "USD", idempotencyKey: crypto.randomUUID(), fingerprint: "too-much" })).rejects.toThrow("exceed");
    const completion = { ...input, evidence: { ...input.evidence, status: "completed" as const } };
    await Promise.all([applyRefundEvidence(db, completion), applyRefundEvidence(db, completion)]);
    const settled = await getAttempt(db, attempt.id);
    expect(settled.refundedMinor).toBe(400);
    expect(settled.status).toBe("partially_refunded");
    expect((await applyRefundEvidence(db, input)).attempt.refundedMinor).toBe(400);
  });

  test("mismatched amounts and resources cannot change payment status", async () => {
    const attempt = await fundedAttempt();
    const input = { attemptId: attempt.id, expectedVersion: attempt.version, evidence: { amountMinor: 1000, currency: "USD", status: "paid" as const, capturedMinor: 1000, provider: { providerObjectId: "pi_someone_else" } } };
    await expect(applyPaymentEvidence(db, input)).rejects.toThrow("resource");
    await expect(applyPaymentEvidence(db, { ...input, evidence: { ...input.evidence, amountMinor: 999, provider: attempt.provider } })).rejects.toThrow("amount");
    expect((await getAttempt(db, attempt.id)).version).toBe(attempt.version);
  });
});
afterAll(() => runtime.dispose());

async function order() {
  return createOrder(db, {
    guestTokenHash: crypto.randomUUID(), customerName: "Test Buyer", customerEmail: "buyer@example.com",
    totalMinor: 1000, currency: "USD", items,
  });
}

describe("durable order and attempt concurrency", () => {
  test("only one competing seller edit succeeds and creates an audit entry", async () => {
    const initial = await order();
    const edits = await Promise.allSettled(["first", "second"].map(notes => updateOrderNotes(db, {
      orderId: initial.id, expectedVersion: initial.version, notes,
    })));
    expect(edits.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await getOrder(db, initial.id)).version).toBe(2);
    const audit = await db.prepare("SELECT count(*) AS count FROM lab_audit WHERE entity_id = ? AND action = 'notes'")
      .bind(initial.id).first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });

  test("competing gateways cannot both reserve the same order", async () => {
    const initial = await order();
    const results = await Promise.allSettled((["stripe", "paypal"] as const).map(gateway => reserveAttempt(db, {
      orderId: initial.id, gateway, mode: "simulator", amountMinor: 1000, currency: "USD",
      captureIntent: "automatic", idempotencyKey: crypto.randomUUID(), fingerprint: gateway,
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await listAttemptsByOrder(db, initial.id)).toHaveLength(1);
    await expect(editOrder(db, { orderId: initial.id, expectedVersion: 1, totalMinor: 1000, currency: "USD", items })).rejects.toThrow();
  });

  test("repeated payment submission returns one attempt and rejects changed input", async () => {
    const initial = await order();
    const input = {
      orderId: initial.id, gateway: "stripe" as const, mode: "simulator" as const,
      amountMinor: 1000, currency: "USD", captureIntent: "automatic" as const,
      idempotencyKey: crypto.randomUUID(), fingerprint: "same-request",
    };
    const [first, second] = await Promise.all([reserveAttempt(db, input), reserveAttempt(db, input)]);
    expect(first.attempt.id).toBe(second.attempt.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    await expect(reserveAttempt(db, { ...input, fingerprint: "changed-request" })).rejects.toThrow("different fingerprint");
  });
});
