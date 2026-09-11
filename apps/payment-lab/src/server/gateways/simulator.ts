import {
  InvalidRequestError,
  OperationNotSupportedError,
  applyOutcomeToGatewayRefundResult,
  applyOutcomeToGatewayResult,
  buildProviderReferences,
  fromMinorUnits,
  minorAmountToNumber,
  toMinorUnits,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type WebhookEvent,
} from "@paykernel/core";
import { LabConflictError } from "../payments/errors";
import type { D1DatabaseLike } from "../payments/db";
import type {
  GatewayKey,
  SandboxCaptureInput,
  SandboxCompleteReturnInput,
  SandboxCreateInput,
  SandboxGatewayDriver,
  SandboxRefundInput,
  SandboxVoidInput,
  SandboxWebhookInput,
} from "./types";

export type SimulatorControlOutcome = "paid" | "authorized" | "failed" | "cancelled" | "pending";
export type SimulatorRefundSettlement = "completed" | "failed";

type SimPayStatus = "pending" | "authorized" | "paid" | "partially_captured" | "failed" | "cancelled";
type SimRefundStatus = "pending" | "completed" | "failed";

type SimPaymentState = {
  version: number;
  providerId: string;
  gateway: string;
  reference: string;
  amountMinor: number;
  currency: string;
  status: SimPayStatus;
  capturedMinor: number;
  createdAt: string;
  updatedAt: string;
};

type SimRefundState = {
  version: number;
  refundId: string;
  gateway: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  status: SimRefundStatus;
  createdAt: string;
  updatedAt: string;
};

type SimIdemRecord = {
  fingerprint: string;
  kind: string;
  result: GatewayPaymentResult | GatewayRefundResult;
};


function nowIso(): string {
  return new Date().toISOString();
}

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function toMinorNumber(amount: { amount: string; currency: string }, currency: string): number {
  if (amount.currency.toUpperCase() !== currency.toUpperCase()) {
    throw new InvalidRequestError(`Money currency ${amount.currency} does not match expected currency ${currency}`);
  }
  return minorAmountToNumber(toMinorUnits(amount));
}

function paymentKey(providerId: string): string {
  return `payment:${providerId}`;
}

function refundKey(refundId: string): string {
  return `refund:${refundId}`;
}

function resultKey(idempotencyKey: string): string {
  return `result:${idempotencyKey}`;
}

function providerIdFor(gateway: string, reference: string): string {
  return `sim_${gateway}_${reference}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaymentState(json: string): SimPaymentState {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new InvalidRequestError("corrupt simulator payment state");
  const providerId = parsed["providerId"];
  const gateway = parsed["gateway"];
  const reference = parsed["reference"];
  const amountMinor = parsed["amountMinor"];
  const currency = parsed["currency"];
  const status = parsed["status"];
  const capturedMinor = parsed["capturedMinor"];
  if (typeof providerId !== "string" || typeof gateway !== "string" || typeof reference !== "string") {
    throw new InvalidRequestError("corrupt simulator payment state");
  }
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new InvalidRequestError("corrupt simulator payment state");
  }
  if (typeof currency !== "string" || typeof status !== "string") {
    throw new InvalidRequestError("corrupt simulator payment state");
  }
  if (typeof capturedMinor !== "number" || !Number.isSafeInteger(capturedMinor) || capturedMinor < 0) {
    throw new InvalidRequestError("corrupt simulator payment state");
  }
  if (
    status !== "pending" &&
    status !== "authorized" &&
    status !== "paid" &&
    status !== "partially_captured" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new InvalidRequestError("corrupt simulator payment state");
  }
  return parsed as unknown as SimPaymentState;
}

function parseRefundState(json: string): SimRefundState {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new InvalidRequestError("corrupt simulator refund state");
  const status = parsed["status"];
  if (status !== "pending" && status !== "completed" && status !== "failed") {
    throw new InvalidRequestError("corrupt simulator refund state");
  }
  return parsed as unknown as SimRefundState;
}

function parseIdemRecord(json: string): SimIdemRecord {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || typeof parsed["fingerprint"] !== "string" || typeof parsed["kind"] !== "string") {
    throw new InvalidRequestError("corrupt simulator idempotency state");
  }
  if (!isRecord(parsed["result"])) throw new InvalidRequestError("corrupt simulator idempotency state");
  return parsed as unknown as SimIdemRecord;
}

async function readStateJson(
  db: D1DatabaseLike,
  gateway: string,
  stateKey: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT state_json FROM lab_simulator_state WHERE gateway = ? AND mode = 'simulator' AND state_key = ?`,
    )
    .bind(gateway, stateKey)
    .first<{ state_json: unknown }>();
  if (row === null) return null;
  if (typeof row.state_json !== "string") throw new InvalidRequestError("corrupt simulator state row");
  return row.state_json;
}

async function compareAndSetState(db: D1DatabaseLike, gateway: string, stateKey: string, previous: string, next: string) {
  const update = await db.prepare(`UPDATE lab_simulator_state SET state_json = ?, updated_at = ? WHERE gateway = ? AND mode = 'simulator' AND state_key = ? AND state_json = ?`)
    .bind(next, nowIso(), gateway, stateKey, previous).run();
  if (update.meta.changes !== 1) throw new LabConflictError("Simulator state changed concurrently; retry.");
}

async function commitPaymentMutation(
  db: D1DatabaseLike,
  gateway: string,
  input: { previous: SimPaymentState | null; next: SimPaymentState; idempotencyKey: string; fingerprint: string; kind: string; result: GatewayPaymentResult | GatewayRefundResult; refund?: SimRefundState },
): Promise<GatewayPaymentResult | GatewayRefundResult> {
  const { previous, next, idempotencyKey, fingerprint, kind, result, refund } = input;
  const condition = previous
    ? `EXISTS (SELECT 1 FROM lab_simulator_state WHERE gateway = ? AND mode = 'simulator' AND state_key = ? AND state_json = ?)`
    : `NOT EXISTS (SELECT 1 FROM lab_simulator_state WHERE gateway = ? AND mode = 'simulator' AND state_key = ?)`;
  const guard = previous ? [gateway, paymentKey(next.providerId), JSON.stringify(previous)] : [gateway, paymentKey(next.providerId)];
  const statements = [
    db.prepare(`INSERT INTO lab_simulator_state (gateway,mode,state_key,state_json,updated_at)
      SELECT ?, 'simulator', ?, ?, ? WHERE ${condition} ON CONFLICT(gateway,mode,state_key) DO NOTHING`)
      .bind(gateway, resultKey(idempotencyKey), JSON.stringify({ fingerprint, kind, result }), next.updatedAt, ...guard),
    previous
      ? db.prepare(`UPDATE lab_simulator_state SET state_json = ?, updated_at = ? WHERE gateway = ? AND mode = 'simulator' AND state_key = ? AND changes() = 1`)
        .bind(JSON.stringify(next), next.updatedAt, gateway, paymentKey(next.providerId))
      : db.prepare(`INSERT INTO lab_simulator_state(gateway,mode,state_key,state_json,updated_at) SELECT ?, 'simulator', ?, ?, ? WHERE changes() = 1`)
        .bind(gateway, paymentKey(next.providerId), JSON.stringify(next), next.updatedAt),
  ];
  if (refund) statements.push(db.prepare(`INSERT INTO lab_simulator_state(gateway,mode,state_key,state_json,updated_at) SELECT ?, 'simulator', ?, ?, ? WHERE changes() = 1`)
    .bind(gateway, refundKey(refund.refundId), JSON.stringify(refund), next.updatedAt));
  const writes = await db.batch(statements);
  if (writes[0]?.meta.changes === 1) return result;
  const replay = await readIdem(db, gateway, idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint || replay.kind !== kind) throw new InvalidRequestError("idempotency key reuse with different input");
    return replay.result;
  }
  throw new LabConflictError("Simulator state changed concurrently; retry.");
}

async function readPayment(db: D1DatabaseLike, gateway: string, providerId: string): Promise<SimPaymentState> {
  const json = await readStateJson(db, gateway, paymentKey(providerId));
  if (json === null) throw new InvalidRequestError(`simulator payment not found: ${providerId}`);
  const state = parsePaymentState(json);
  if (state.gateway !== gateway || state.providerId !== providerId) {
    throw new InvalidRequestError("simulator payment gateway mismatch");
  }
  return state;
}

async function readIdem(
  db: D1DatabaseLike,
  gateway: string,
  idempotencyKey: string,
): Promise<SimIdemRecord | null> {
  const json = await readStateJson(db, gateway, resultKey(idempotencyKey));
  return json === null ? null : parseIdemRecord(json);
}

function paymentOutcomeFor(status: SimPayStatus): GatewayPaymentResult["outcome"] {
  if (status === "pending") return "requires_action";
  if (status === "failed") return "failed";
  return "succeeded";
}

function toPaymentResult(state: SimPaymentState): GatewayPaymentResult {
  const currency = state.currency;
  const amount = fromMinorUnits(state.amountMinor, currency, { allowZero: true });
  const capturedAmount = fromMinorUnits(state.capturedMinor, currency, { allowZero: true });
  const references = buildProviderReferences({
    gateway: state.gateway,
    gatewayId: state.providerId,
    status: state.status,
    internalReference: state.reference,
  });
  const outcome = paymentOutcomeFor(state.status);
  return applyOutcomeToGatewayResult(
    {
      gatewayId: state.providerId,
      status: state.status,
      rawResponse: {
        simulator: true,
        gateway: state.gateway,
        providerId: state.providerId,
        reference: state.reference,
        status: state.status,
        amountMinor: state.amountMinor,
        capturedMinor: state.capturedMinor,
        currency,
      },
      amount,
      currency,
      capturedAmount,
      references,
      gateway: state.gateway,
      internalReference: state.reference,
    },
    outcome,
  );
}

function toRefundResult(state: SimRefundState): GatewayRefundResult {
  const totalRefunded = fromMinorUnits(state.amountMinor, state.currency, { allowZero: true });
  const outcome = state.status === "completed" ? "succeeded" : state.status === "failed" ? "failed" : "pending";
  return applyOutcomeToGatewayRefundResult(
    {
      gatewayRefundId: state.refundId,
      status: state.status,
      rawResponse: {
        simulator: true,
        gateway: state.gateway,
        refundId: state.refundId,
        paymentId: state.paymentId,
        status: state.status,
        amountMinor: state.amountMinor,
        currency: state.currency,
      },
      totalRefunded,
    },
    outcome,
  );
}

async function sumNonFailedRefunds(db: D1DatabaseLike, gateway: string, paymentId: string): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(SUM(json_extract(state_json, '$.amountMinor')),0) AS total FROM lab_simulator_state WHERE gateway = ? AND mode = 'simulator' AND state_key LIKE 'refund:%' AND json_extract(state_json, '$.paymentId') = ? AND json_extract(state_json, '$.status') != 'failed'`)
    .bind(gateway,paymentId).first<{total:number}>();
  if (!row || !Number.isSafeInteger(row.total)) throw new InvalidRequestError("corrupt simulator refund total");
  return row.total;
}

export async function controlSimulatorPayment(
  db: D1DatabaseLike,
  gateway: GatewayKey,
  providerId: string,
  outcome: SimulatorControlOutcome,
): Promise<GatewayPaymentResult> {
  const id = assertNonEmpty(providerId, "providerId");
  const state = await readPayment(db, gateway, id);
  if (state.capturedMinor > 0 && outcome !== "paid") throw new InvalidRequestError("Cannot reverse captured simulator money");
  const now = nowIso();
  let next: SimPaymentState;
  if (outcome === "paid") {
    next = { ...state, version: state.version + 1, status: "paid", capturedMinor: state.amountMinor, updatedAt: now };
  } else if (outcome === "authorized") {
    next = { ...state, version: state.version + 1, status: "authorized", capturedMinor: 0, updatedAt: now };
  } else if (outcome === "pending") {
    next = { ...state, version: state.version + 1, status: "pending", capturedMinor: 0, updatedAt: now };
  } else if (outcome === "failed") {
    next = { ...state, version: state.version + 1, status: "failed", updatedAt: now };
  } else {
    next = { ...state, version: state.version + 1, status: "cancelled", updatedAt: now };
  }
  await compareAndSetState(db, gateway, paymentKey(id), JSON.stringify(state), JSON.stringify(next));
  return toPaymentResult(next);
}

export async function getSimulatorRefund(
  db: D1DatabaseLike,
  gateway: GatewayKey,
  refundId: string,
): Promise<GatewayRefundResult> {
  const id = assertNonEmpty(refundId, "refundId");
  const json = await readStateJson(db, gateway, refundKey(id));
  if (json === null) throw new InvalidRequestError(`simulator refund not found: ${id}`);
  const state = parseRefundState(json);
  if (state.gateway !== gateway || state.refundId !== id) {
    throw new InvalidRequestError("simulator refund gateway mismatch");
  }
  return toRefundResult(state);
}

export async function settleSimulatorRefund(
  db: D1DatabaseLike,
  gateway: GatewayKey,
  refundId: string,
  outcome: SimulatorRefundSettlement,
): Promise<GatewayRefundResult> {
  const id = assertNonEmpty(refundId, "refundId");
  const json = await readStateJson(db, gateway, refundKey(id));
  if (json === null) throw new InvalidRequestError(`simulator refund not found: ${id}`);
  const state = parseRefundState(json);
  const target: SimRefundStatus = outcome === "completed" ? "completed" : "failed";
  if (state.status === target) return toRefundResult(state);
  if (state.status !== "pending") {
    throw new InvalidRequestError(`simulator refund already settled: ${id}`);
  }
  const now = nowIso();
  const next: SimRefundState = { ...state, version: state.version + 1, status: target, updatedAt: now };
  await compareAndSetState(db, gateway, refundKey(id), json, JSON.stringify(next));
  return toRefundResult(next);
}

export function createSimulatorDriver(db: D1DatabaseLike, gateway: GatewayKey): SandboxGatewayDriver {
  return {
    gateway,
    async create(input: SandboxCreateInput): Promise<GatewayPaymentResult> {
      const reference = assertNonEmpty(input.reference, "reference");
      const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
      if (typeof input.amount.currency !== "string" || input.amount.currency.trim().length === 0) {
        throw new InvalidRequestError("amount.currency must be a non-empty string");
      }
      const currency = input.amount.currency.trim().toUpperCase();
      const amountMinor = toMinorNumber(input.amount, currency);
      if (amountMinor <= 0) throw new InvalidRequestError("amount must be greater than zero");
      const fingerprint = JSON.stringify({
        kind: "create",
        reference,
        amountMinor,
        currency,
        capture: input.capture ?? true,
      });
      const existing = await readIdem(db, gateway, idempotencyKey);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) {
          throw new InvalidRequestError("idempotency key reuse with different input");
        }
        return existing.result as GatewayPaymentResult;
      }
      const providerId = providerIdFor(gateway, reference);
      const already = await readStateJson(db, gateway, paymentKey(providerId));
      if (already !== null) {
        const kept = parsePaymentState(already);
        if (kept.amountMinor !== amountMinor || kept.currency !== currency || kept.reference !== reference) {
          throw new InvalidRequestError("simulator payment already exists with different input");
        }
        const result = toPaymentResult(kept);
        const now = nowIso();
        return await commitPaymentMutation(db, gateway, { previous: kept, next: { ...kept, version: kept.version + 1, updatedAt: now }, idempotencyKey, fingerprint, kind: "create", result }) as GatewayPaymentResult;
      }
      const now = nowIso();
      const state: SimPaymentState = {
        version: 1,
        providerId,
        gateway,
        reference,
        amountMinor,
        currency,
        status: "pending",
        capturedMinor: 0,
        createdAt: now,
        updatedAt: now,
      };
      const result = toPaymentResult(state);
      return await commitPaymentMutation(db, gateway, { previous: null, next: state, idempotencyKey, fingerprint, kind: "create", result }) as GatewayPaymentResult;
    },

    async lookup(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
      const id = assertNonEmpty(gatewayPaymentId, "gatewayPaymentId");
      return toPaymentResult(await readPayment(db, gateway, id));
    },

    async capture(input: SandboxCaptureInput): Promise<GatewayPaymentResult> {
      const id = assertNonEmpty(input.gatewayPaymentId, "gatewayPaymentId");
      const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
      const state = await readPayment(db, gateway, id);
      if (input.currency !== undefined && input.currency.trim().toUpperCase() !== state.currency) {
        throw new InvalidRequestError(`capture currency ${input.currency} does not match payment currency ${state.currency}`);
      }
      let captureMinor: number;
      if (input.amount !== undefined) {
        captureMinor = toMinorNumber(input.amount, state.currency);
      } else {
        captureMinor = state.amountMinor - state.capturedMinor;
      }
      const fingerprint = JSON.stringify({ kind: "capture", gatewayPaymentId: id, requestedAmount: input.amount ?? null, currency: state.currency });
      const existing = await readIdem(db, gateway, idempotencyKey);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) {
          throw new InvalidRequestError("idempotency key reuse with different input");
        }
        return existing.result as GatewayPaymentResult;
      }
      if (state.status !== "authorized" && state.status !== "partially_captured") {
        throw new InvalidRequestError(`only authorized payments can be captured (status ${state.status})`);
      }
      if (captureMinor <= 0) throw new InvalidRequestError("capture amount must be greater than zero");
      const remaining = state.amountMinor - state.capturedMinor;
      if (captureMinor > remaining) {
        throw new InvalidRequestError(`capture amount exceeds remaining authorized amount (${remaining})`);
      }
      const nextCaptured = state.capturedMinor + captureMinor;
      const nextStatus: SimPayStatus = nextCaptured === state.amountMinor ? "paid" : "partially_captured";
      const now = nowIso();
      const next: SimPaymentState = { ...state, version: state.version + 1, status: nextStatus, capturedMinor: nextCaptured, updatedAt: now };
      const result = toPaymentResult(next);
      return await commitPaymentMutation(db, gateway, { previous: state, next, idempotencyKey, fingerprint, kind: "capture", result }) as GatewayPaymentResult;
    },

    async void(input: SandboxVoidInput): Promise<GatewayPaymentResult> {
      const id = assertNonEmpty(input.gatewayPaymentId, "gatewayPaymentId");
      const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
      const fingerprint = JSON.stringify({ kind: "void", gatewayPaymentId: id });
      const existing = await readIdem(db, gateway, idempotencyKey);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) {
          throw new InvalidRequestError("idempotency key reuse with different input");
        }
        return existing.result as GatewayPaymentResult;
      }
      const state = await readPayment(db, gateway, id);
      if (state.capturedMinor > 0) {
        throw new InvalidRequestError("captured payments cannot be voided; refund instead");
      }
      if (state.status !== "pending" && state.status !== "authorized") {
        throw new InvalidRequestError(`only pending or authorized payments can be voided (status ${state.status})`);
      }
      const now = nowIso();
      const next: SimPaymentState = { ...state, version: state.version + 1, status: "cancelled", updatedAt: now };
      const result = toPaymentResult(next);
      return await commitPaymentMutation(db, gateway, { previous: state, next, idempotencyKey, fingerprint, kind: "void", result }) as GatewayPaymentResult;
    },

    async refund(input: SandboxRefundInput): Promise<GatewayRefundResult> {
      const id = assertNonEmpty(input.gatewayPaymentId, "gatewayPaymentId");
      const idempotencyKey = assertNonEmpty(input.idempotencyKey, "idempotencyKey");
      const state = await readPayment(db, gateway, id);
      if (input.currency !== undefined && input.currency.trim().toUpperCase() !== state.currency) {
        throw new InvalidRequestError(`refund currency ${input.currency} does not match payment currency ${state.currency}`);
      }
      if (state.status !== "paid" && state.status !== "partially_captured") {
        throw new InvalidRequestError(`only captured payments can be refunded (status ${state.status})`);
      }
      if (state.capturedMinor <= 0) throw new InvalidRequestError("nothing captured to refund");
      const reserved = await sumNonFailedRefunds(db, gateway, id);
      const remaining = state.capturedMinor - reserved;
      let refundMinor: number;
      if (input.amount !== undefined) {
        refundMinor = toMinorNumber(input.amount, state.currency);
      } else {
        refundMinor = remaining;
      }
      const reason = input.reason;
      const fingerprint = JSON.stringify({
        kind: "refund",
        gatewayPaymentId: id,
        requestedAmount: input.amount ?? null,
        currency: state.currency,
        reason: reason ?? null,
      });
      const existing = await readIdem(db, gateway, idempotencyKey);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) {
          throw new InvalidRequestError("idempotency key reuse with different input");
        }
        return existing.result as GatewayRefundResult;
      }
      if (refundMinor <= 0) throw new InvalidRequestError("refund amount must be greater than zero");
      if (refundMinor > remaining) {
        throw new InvalidRequestError(`refund amount exceeds refundable balance (${remaining})`);
      }
      const now = nowIso();
      const refundId = `sim_ref_${gateway}_${crypto.randomUUID()}`;
      const refundState: SimRefundState = {
        version: 1,
        refundId,
        gateway,
        paymentId: id,
        amountMinor: refundMinor,
        currency: state.currency,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      const result = toRefundResult(refundState);
      return await commitPaymentMutation(db, gateway, { previous: state, next: { ...state, version: state.version + 1, updatedAt: now }, idempotencyKey, fingerprint, kind: "refund", result, refund: refundState }) as GatewayRefundResult;
    },

    async lookupRefund(gatewayRefundId: string): Promise<GatewayRefundResult> {
      return getSimulatorRefund(db, gateway, gatewayRefundId);
    },

    async completeReturn(input: SandboxCompleteReturnInput): Promise<GatewayPaymentResult> {
      const stored = assertNonEmpty(input.storedGatewayPaymentId, "storedGatewayPaymentId");
      return toPaymentResult(await readPayment(db, gateway, stored));
    },

    async verifyAndParseWebhook(_input: SandboxWebhookInput): Promise<WebhookEvent> {
      throw new OperationNotSupportedError(gateway, "verifyAndParseWebhook", { claimedSupport: false });
    },
  };
}
