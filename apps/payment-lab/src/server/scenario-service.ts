import type { GatewayPaymentResult } from "@paykernel/core";
import type { AppEnv } from "../env";
import { getGatewayReadiness } from "./gateways/index";
import type { GatewayKey } from "./gateways/types";
import {
  controlSimulatorPayment,
  createSimulatorDriver,
  getSimulatorRefund,
  settleSimulatorRefund,
} from "./gateways/simulator";
import { emitSimulatorWebhook } from "./simulator-http";
import { startPayment } from "./start-payment";
import { performPaymentAction, reconcileAttempt } from "./payment-actions";
import { createOrder } from "./payments/orders";
import { getAttempt } from "./payments/attempts";
import { reserveOperation, markOperationSubmitted, markOperationIndeterminate } from "./payments/operations";
import { listRefundsByAttempt } from "./payments/evidence";
import { getWebhookByEvent } from "./payments/inbox";
import { createTestRun, updateTestRun } from "./payments/testing";
import type { LabTestRun } from "./payments/types";

export const SCENARIOS = [
  { id: "success", label: "Simulator success (paid)" },
  { id: "decline", label: "Simulator decline (failed)" },
  { id: "cancel", label: "Simulator cancel (cancelled)" },
  { id: "pending", label: "Simulator pending" },
  { id: "abandonment", label: "Simulator abandonment (no webhook)" },
  { id: "authorization", label: "Simulator authorization hold" },
  { id: "capture", label: "Simulator authorize then capture" },
  { id: "partial-capture", label: "Simulator partial capture" },
  { id: "void", label: "Simulator void authorization" },
  { id: "refund", label: "Simulator full refund" },
  { id: "partial-refund", label: "Simulator partial refund" },
  { id: "pending-refund", label: "Simulator pending refund" },
  { id: "excessive-amount", label: "Simulator excessive amount rejected" },
  { id: "double-submit", label: "Simulator double submit idempotent" },
  { id: "concurrent-capture-void", label: "Simulator concurrent capture vs void" },
  { id: "duplicate-webhook", label: "Simulator duplicate webhook" },
  { id: "out-of-order", label: "Simulator out-of-order webhook" },
  { id: "invalid-signature", label: "Simulator invalid signature" },
  { id: "amount-mismatch", label: "Simulator amount mismatch" },
  { id: "currency-mismatch", label: "Simulator currency mismatch" },
  { id: "missing-webhook", label: "Simulator missing webhook then reconcile" },
  { id: "retry", label: "Simulator retry (failOnce)" },
  { id: "persistence", label: "Simulator persistence fresh driver" },
  { id: "timeout-after-acceptance", label: "Simulator lost capture response and webhook recovery" },
];

type Step = { label: string; actual: string; expected: string };
type RunOpts = { gateway: GatewayKey; mode: "simulator" | "sandbox"; scenario: string };

function shortError(e: unknown): string {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return m.slice(0, 160);
}
function evt(): string {
  return `evt_${crypto.randomUUID()}`;
}
function key(p: string): string {
  return `${p}_${crypto.randomUUID()}`;
}

export async function runScenario(env: AppEnv, opts: RunOpts): Promise<LabTestRun> {
  const db = env.DB;
  const run = await createTestRun(db, { scenario: opts.scenario, gateway: opts.gateway, mode: opts.mode });
  const steps: Step[] = [];
  let createdOrderId: string | undefined;
  let createdAttemptId: string | undefined;
  let webhookEventId: string | undefined;
  const rec = (label: string, actual: unknown, expected: unknown) => {
    steps.push({ label, actual: String(actual), expected: String(expected) });
  };
  const done = (verdict: LabTestRun["verdict"], orderId?: string, attemptId?: string, error?: string) =>
    updateTestRun(db, {
      id: run.id,
      verdict,
      evidenceJson: JSON.stringify({ orderId: orderId ?? createdOrderId ?? null, attemptId: attemptId ?? createdAttemptId ?? null, webhookEventId, steps, ...(error ? { error } : {}) }),
    });

  if (opts.mode === "sandbox") {
    const r = getGatewayReadiness(opts.gateway, env);
    rec("sandbox never fake-passes", "blocked", "blocked");
    rec("gateway readiness checked", r.configured ? "configured" : `missing:${r.missing.join(",") || "human-checkout"}`, "checked");
    return done("blocked", undefined, undefined, `sandbox blocked: credential readiness or human checkout required (${r.missing.join(",") || "manual"})`);
  }

  const scenario = opts.scenario;
  if (!SCENARIOS.some((s) => s.id === scenario)) {
    rec("known scenario", scenario, "known");
    return done("failed", undefined, undefined, `unknown scenario: ${scenario}`);
  }

  try {
    const readiness = getGatewayReadiness(opts.gateway, env);
    const caps = readiness.capabilities;
    const currency = readiness.defaultCurrency;
    const unsupported = ((): string | null => {
      if (!caps.payments) return "gateway does not support payments";
      const manual = ["authorization", "capture", "partial-capture", "void", "concurrent-capture-void", "timeout-after-acceptance"].includes(scenario);
      if (manual && !caps.authorization) return "gateway does not support authorization";
      if (manual && scenario === "partial-capture" && !caps.partialCapture) return "gateway does not support partial capture";
      if (["void", "concurrent-capture-void"].includes(scenario) && !caps.voids) return "gateway does not support voids";
      if (["refund", "partial-refund", "pending-refund"].includes(scenario) && !caps.refunds) return "gateway does not support refunds";
      if (scenario === "partial-refund" && !caps.partialRefunds) return "gateway does not support partial refunds";
      return null;
    })();
    if (unsupported) {
      rec("capability gate", "unsupported", "unsupported");
      return done("unsupported", undefined, undefined, unsupported);
    }

    const boot = async (intent: "automatic" | "manual") => {
      const order = await createOrder(db, {
        guestTokenHash: crypto.randomUUID(),
        customerName: "Lab Tester",
        customerEmail: "tester@example.com",
        totalMinor: 1000,
        currency,
        items: [{ name: "Test notebook", quantity: 1, unitMinor: 1000, sku: "notebook" }],
      });
      createdOrderId = order.id;
      const started = await startPayment(env, order.id, {
        gateway: opts.gateway, mode: "simulator", captureIntent: intent, idempotencyKey: key("scn"),
      });
      const attempt = await getAttempt(db, started.attempt.id);
      createdAttemptId = attempt.id;
      rec("order amount", order.totalMinor, 1000);
      rec("attempt durable", attempt.id.length > 0 ? "reserved" : "missing", "reserved");
      return { order, attempt };
    };
    const providerId = (attemptId: string) => getAttempt(db, attemptId).then((a) => {
      const pid = a.provider.providerObjectId;
      if (!pid) throw new Error("missing provider resource; reconcile required");
      return pid;
    });
    const emitPay = (attemptId: string, result: GatewayPaymentResult, eventId: string, extra?: { failOnce?: boolean; tamperSignature?: boolean }) =>
      emitSimulatorWorkout(env, opts.gateway, attemptId, result, eventId, extra);

    // Simple terminal payment flows
    if (["success", "decline", "cancel", "pending", "authorization"].includes(scenario)) {
      const map: Record<string, { control: "paid" | "failed" | "cancelled" | "pending" | "authorized"; expect: string; manual: boolean }> = {
        success: { control: "paid", expect: "paid", manual: false },
        decline: { control: "failed", expect: "failed", manual: false },
        cancel: { control: "cancelled", expect: "cancelled", manual: false },
        pending: { control: "pending", expect: "pending", manual: false },
        authorization: { control: "authorized", expect: "authorized", manual: true },
      };
      const m = map[scenario]!;
      const { order, attempt } = await boot(m.manual ? "manual" : "automatic");
      const pid = await providerId(attempt.id);
      const controlled = await controlSimulatorPayment(db, opts.gateway, pid, m.control);
      const eid = evt();
      const sent = await emitPay(attempt.id, controlled, eid);
      rec("webhook http", sent.status, 200);
      const fresh = await getAttempt(db, attempt.id);
      rec("durable status", fresh.status, m.expect);
      const pass = fresh.status === m.expect && sent.status === 200;
      return done(pass ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "abandonment") {
      const { order, attempt } = await boot("automatic");
      const fresh = await getAttempt(db, attempt.id);
      rec("durable status without webhook", fresh.status, "pending");
      return done(fresh.status === "pending" ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "capture") {
      const { order, attempt } = await boot("manual");
      const pid = await providerId(attempt.id);
      const auth = await controlSimulatorPayment(db, opts.gateway, pid, "authorized");
      const e1 = evt();
      const s1 = await emitPay(attempt.id, auth, e1);
      rec("auth webhook", s1.status, 200);
      const mid = await getAttempt(db, attempt.id);
      rec("authorized durable", mid.status, "authorized");
      if (mid.status !== "authorized") return done("failed", order.id, attempt.id);
      await performPaymentAction(env, attempt.id, { kind: "capture", idempotencyKey: key("cap") });
      const fresh = await getAttempt(db, attempt.id);
      rec("captured durable", `${fresh.status}:${fresh.capturedMinor}`, `paid:1000`);
      return done(fresh.status === "paid" && fresh.capturedMinor === 1000 ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "partial-capture") {
      const { order, attempt } = await boot("manual");
      const pid = await providerId(attempt.id);
      const auth = await controlSimulatorPayment(db, opts.gateway, pid, "authorized");
      await emitPay(attempt.id, auth, evt());
      await performPaymentAction(env, attempt.id, { kind: "capture", amountMinor: 500, idempotencyKey: key("pcap") });
      const fresh = await getAttempt(db, attempt.id);
      rec("partial capture durable", `${fresh.status}:${fresh.capturedMinor}`, "partially_captured:500");
      return done(fresh.status === "partially_captured" && fresh.capturedMinor === 500 ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "void") {
      const { order, attempt } = await boot("manual");
      const pid = await providerId(attempt.id);
      const auth = await controlSimulatorPayment(db, opts.gateway, pid, "authorized");
      await emitPay(attempt.id, auth, evt());
      await performPaymentAction(env, attempt.id, { kind: "void", idempotencyKey: key("void") });
      const fresh = await getAttempt(db, attempt.id);
      rec("void durable", fresh.status, "cancelled");
      return done(fresh.status === "cancelled" ? "passed" : "failed", order.id, attempt.id);
    }

    if (["refund", "partial-refund", "pending-refund"].includes(scenario)) {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      const paid = await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      await emitPay(attempt.id, paid, evt());
      const ready = await getAttempt(db, attempt.id);
      if (ready.status !== "paid") { rec("pre-refund paid", ready.status, "paid"); return done("failed", order.id, attempt.id); }
      const amt = scenario === "partial-refund" ? 400 : 1000;
      await performPaymentAction(env, attempt.id, { kind: "refund", amountMinor: amt, idempotencyKey: key("ref") });
      const refunds0 = await listRefundsByAttempt(db, attempt.id);
      const row0 = refunds0.find((r) => r.amountMinor === amt);
      rec("refund pending durable", row0?.status ?? "missing", "pending");
      if (!row0 || row0.status !== "pending") return done("failed", order.id, attempt.id);
      const simPending = await getSimulatorRefund(db, opts.gateway, row0.providerRefundId);
      rec("simulator refund pending", simPending.status, "pending");
      if (scenario === "pending-refund") {
        const held = await getAttempt(db, attempt.id);
        rec("pending refund does not settle money", held.refundedMinor, 0);
        return done(held.refundedMinor === 0 && held.ambiguous && simPending.status === "pending" ? "passed" : "failed", order.id, attempt.id);
      }
      const settled = await settleSimulatorRefund(db, opts.gateway, row0.providerRefundId, "completed");
      const s = await emitSimulatorWebhook(env, opts.gateway, { eventId: evt(), attemptId: attempt.id, kind: "refund", result: settled });
      rec("refund webhook http", s.status, 200);
      const refunds1 = await listRefundsByAttempt(db, attempt.id);
      const total = refunds1.filter((r) => r.status !== "failed").reduce((n, r) => n + r.amountMinor, 0);
      const fresh = await getAttempt(db, attempt.id);
      rec("refund total durable", `${total}:${fresh.refundedMinor}`, `${amt}:${amt}`);
      const pass = total === amt && fresh.refundedMinor === amt;
      return done(pass ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "excessive-amount") {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      await emitPay(attempt.id, await controlSimulatorPayment(db, opts.gateway, pid, "paid"), evt());
      let rejected = "";
      try {
        await performPaymentAction(env, attempt.id, { kind: "refund", amountMinor: 5000, idempotencyKey: key("exc") });
      } catch (e) { rejected = shortError(e); }
      rec("excessive rejected", rejected.length > 0 ? "rejected" : "accepted", "rejected");
      const fresh = await getAttempt(db, attempt.id);
      rec("no financial change", fresh.refundedMinor, 0);
      return done(rejected.length > 0 && fresh.refundedMinor === 0 ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "timeout-after-acceptance") {
      const { order, attempt } = await boot("manual");
      const pid = await providerId(attempt.id);
      await emitPay(attempt.id, await controlSimulatorPayment(db, opts.gateway, pid, "authorized"), evt());
      const { operation } = await reserveOperation(db, { attemptId: attempt.id, kind: "capture", amountMinor: 1000,
        currency, providerId: pid, idempotencyKey: key("lost-response"), fingerprint: "capture:1000" });
      const submitted = await markOperationSubmitted(db, { operationId: operation.id, expectedVersion: operation.version });
      // The provider accepts, but the action handler never receives this response.
      const driver = createSimulatorDriver(db, opts.gateway);
      await driver.capture({ gatewayPaymentId: pid, idempotencyKey: submitted.idempotencyKey });
      await markOperationIndeterminate(db, { operationId: submitted.id, expectedVersion: submitted.version, lastError: "simulated_lost_response" });
      const held = await getAttempt(db, attempt.id);
      rec("lost response holds operation", held.ambiguous, true);
      await emitPay(attempt.id, await driver.lookup(pid), evt());
      const recovered = await reconcileAttempt(env, attempt.id);
      rec("webhook before reconciliation unlocks", recovered.attempt.ambiguous, false);
      rec("capture counted once", recovered.attempt.capturedMinor, 1000);
      return done(held.ambiguous && !recovered.attempt.ambiguous && recovered.attempt.capturedMinor === 1000 && recovered.operation?.status === "completed" ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "double-submit") {
      const { order, attempt } = await boot("automatic");
      const input = { gateway: opts.gateway, mode: "simulator" as const, captureIntent: "automatic" as const, idempotencyKey: attempt.idempotencyKey };
      const [first, second] = await Promise.all([startPayment(env, order.id, input), startPayment(env, order.id, input)]);
      rec("both submissions reuse attempt", first.attempt.id === attempt.id && second.attempt.id === attempt.id, true);
      rec("provider resource stable", first.attempt.provider.providerObjectId, second.attempt.provider.providerObjectId);
      return done(first.attempt.id === attempt.id && second.attempt.id === attempt.id ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "concurrent-capture-void") {
      const { order, attempt } = await boot("manual");
      const pid = await providerId(attempt.id);
      await emitPay(attempt.id, await controlSimulatorPayment(db, opts.gateway, pid, "authorized"), evt());
      const outcomes = await Promise.allSettled([
        performPaymentAction(env, attempt.id, { kind: "capture", idempotencyKey: key("cc") }),
        performPaymentAction(env, attempt.id, { kind: "void", idempotencyKey: key("cv") }),
      ]);
      const winners = outcomes.filter(outcome => outcome.status === "fulfilled").length;
      const fresh = await getAttempt(db, attempt.id);
      rec("concurrent mutation winners", winners, 1);
      rec("exclusive financial result", `${fresh.status}:${fresh.capturedMinor}`, "paid:1000 or cancelled:0");
      const valid = (fresh.status === "paid" && fresh.capturedMinor === 1000) || (fresh.status === "cancelled" && fresh.capturedMinor === 0);
      return done(winners === 1 && valid ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "duplicate-webhook") {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      const paid = await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      const eid = evt();
      const s1 = await emitPay(attempt.id, paid, eid);
      rec("first webhook", s1.status, 200);
      const v1 = (await getAttempt(db, attempt.id)).version;
      const s2 = await emitPay(attempt.id, paid, eid);
      rec("replay webhook", s2.status, 200);
      const v2 = (await getAttempt(db, attempt.id)).version;
      rec("version not changed", v2, v1);
      return done(s1.status === 200 && s2.status === 200 && v1 === v2 ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "out-of-order") {
      const { order, attempt } = await boot("automatic");
      const fresh0 = createSimulatorDriver(db, opts.gateway);
      const stalePending = await fresh0.lookup(await providerId(attempt.id));
      const pid = await providerId(attempt.id);
      const paid = await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      const s1 = await emitPay(attempt.id, paid, evt());
      rec("paid webhook", s1.status, 200);
      const mid = await getAttempt(db, attempt.id);
      if (mid.status !== "paid") { rec("paid durable", mid.status, "paid"); return done("failed", order.id, attempt.id); }
      const s2 = await emitPay(attempt.id, stalePending, evt());
      rec("stale replay http", s2.status, 200);
      const fresh = await getAttempt(db, attempt.id);
      rec("no regression durable", fresh.status, "paid");
      return done(fresh.status === "paid" ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "invalid-signature") {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      const paid = await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      const before = await getAttempt(db, attempt.id);
      const bad = await emitPay(attempt.id, paid, evt(), { tamperSignature: true });
      rec("tampered http", bad.status, 401);
      const after = await getAttempt(db, attempt.id);
      rec("no financial change", `${after.status}:${after.version}`, `${before.status}:${before.version}`);
      return done(bad.status === 401 && after.status === before.status && after.version === before.version ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "amount-mismatch" || scenario === "currency-mismatch") {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      const paid = await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      const tampered = { ...paid };
      if (scenario === "amount-mismatch") {
        tampered["amount"] = { amount: "99999.00", currency };
        tampered["currency"] = currency;
      } else {
        const other = currency === "USD" ? "EUR" : "USD";
        tampered["amount"] = { amount: "10.00", currency: other };
        tampered["currency"] = other;
        tampered["capturedAmount"] = { amount: "10.00", currency: other };
      }
      const before = await getAttempt(db, attempt.id);
      const res = await emitPay(attempt.id, tampered, evt());
      rec("mismatch http 4xx", res.status >= 400 && res.status < 500 ? "4xx" : String(res.status), "4xx");
      const after = await getAttempt(db, attempt.id);
      rec("no financial change", `${after.status}:${after.version}`, `${before.status}:${before.version}`);
      const pass = res.status >= 400 && res.status < 500 && after.version === before.version;
      return done(pass ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "missing-webhook") {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      const before = await getAttempt(db, attempt.id);
      rec("provider-only no durable change", before.status, "pending");
      const reconciled = await reconcileAttempt(env, attempt.id);
      rec("reconcile durable", reconciled.attempt.status, "paid");
      return done(reconciled.attempt.status === "paid" ? "passed" : "failed", order.id, attempt.id);
    }

    if (scenario === "retry") {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      const paid = await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      const eid = evt();
      webhookEventId = eid;
      const sent = await emitPay(attempt.id, paid, eid, { failOnce: true });
      rec("first submit http", sent.status, 200);
      const row = await getWebhookByEvent(db, opts.gateway, "simulator", eid);
      rec("webhook row failed (scheduled)", row?.status ?? "missing", "failed");
      if (!row || row.status !== "failed") {
        const fresh = await getAttempt(db, attempt.id);
        return done(fresh.status === "paid" ? "passed" : "failed", order.id, attempt.id);
      }
      return done("running", order.id, attempt.id, "retry scheduled; awaiting cron");
    }

    if (scenario === "persistence") {
      const { order, attempt } = await boot("automatic");
      const pid = await providerId(attempt.id);
      const controlled = await controlSimulatorPayment(db, opts.gateway, pid, "paid");
      const freshDriver = createSimulatorDriver(db, opts.gateway);
      const looked = await freshDriver.lookup(pid);
      rec("fresh lookup durable", looked.status, controlled.status);
      const s = await emitPay(attempt.id, controlled, evt());
      rec("webhook http", s.status, 200);
      const fresh = await getAttempt(db, attempt.id);
      rec("durable after control", fresh.status, "paid");
      return done(fresh.status === "paid" ? "passed" : "failed", order.id, attempt.id);
    }

    return done("failed", undefined, undefined, `unhandled scenario: ${scenario}`);
  } catch (e) {
    return done("failed", undefined, undefined, shortError(e));
  }
}

async function emitSimulatorWorkout(
  env: AppEnv,
  gateway: GatewayKey,
  attemptId: string,
  result: GatewayPaymentResult,
  eventId: string,
  extra?: { failOnce?: boolean; tamperSignature?: boolean },
): Promise<{ status: number; ok: boolean; eventId: string }> {
  return emitSimulatorWebhook(
    env,
    gateway,
    { eventId, attemptId, kind: "payment", result, ...(extra?.failOnce ? { failOnce: true } : {}) },
    { ...(extra?.tamperSignature ? { tamperSignature: true } : {}) },
  );
}
