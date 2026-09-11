import { minorAmountToNumber, toMinorUnits } from "@paykernel/core";
import type { GatewayRefundResult } from "@paykernel/core";
import { z } from "zod";
import { LabConflictError } from "./payments/errors";
import type { LabAttempt, LabOperation, LabRefundEvidence } from "./payments/types";

function mismatch(message: string): never {
  throw new LabConflictError(message);
}

function indeterminate(message: string): never {
  throw new LabConflictError(`${message}; reconcile required`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIndeterminateMarker(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return raw.reconciliationRequired === true || raw.indeterminate === true || raw.outcome === "indeterminate";
}

function moneyMinor(value: unknown, expectedCurrency: string): number {
  if (!isRecord(value) || typeof value.amount !== "string" || typeof value.currency !== "string") {
    mismatch("refund amount mismatch");
  }
  const currency = value.currency.trim().toUpperCase();
  if (currency !== expectedCurrency) mismatch("refund amount mismatch");
  try {
    return minorAmountToNumber(toMinorUnits({ amount: value.amount, currency }));
  } catch {
    mismatch("refund amount mismatch");
  }
}

const tapRefundSchema = z.object({
  id: z.string().min(1),
  amount: z.number().finite().positive(),
  currency: z.string().min(1),
  charge_id: z.string().min(1).optional(),
});

const hesabeRefundSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1),
  status: z.union([z.number(), z.string()]).optional(),
  refund_at: z.union([z.string(), z.null()]).optional(),
});

export function normalizeRefundReceipt(
  attempt: LabAttempt,
  operation: LabOperation,
  result: GatewayRefundResult,
): LabRefundEvidence {
  if (result.reconciliationRequired === true || result.outcome === "indeterminate") {
    indeterminate("refund indeterminate");
  }
  if (hasIndeterminateMarker(result.rawResponse)) indeterminate("refund indeterminate");
  const refundId = result.gatewayRefundId?.trim();
  if (!refundId || refundId === "unknown") indeterminate("refund indeterminate");
  const expectedCurrency = attempt.currency.trim().toUpperCase();
  if (operation.currency.trim().toUpperCase() !== expectedCurrency) mismatch("refund amount mismatch");
  const status = result.status;
  if (status !== "completed" && status !== "pending" && status !== "failed") indeterminate("refund indeterminate");
  const gateway = attempt.mode === "simulator" ? "simulator" : attempt.gateway;
  if (status === "completed" && result.outcome !== "succeeded") indeterminate("refund outcome mismatch");
  const namespacedId = gateway === "moyasar" ? `${refundId}:${operation.id}` : refundId;

  if (gateway === "moyasar" || gateway === "paymob") {
    if (status === "completed") {
      if (result.totalRefunded === undefined) mismatch("refund amount mismatch");
      const totalMinor = moneyMinor(result.totalRefunded, expectedCurrency);
      const delta = totalMinor - attempt.refundedMinor;
      if (!Number.isSafeInteger(delta) || delta !== operation.amountMinor) mismatch("refund amount mismatch");
      return { providerRefundId: namespacedId, amountMinor: operation.amountMinor, currency: attempt.currency, status };
    }
    if (result.totalRefunded !== undefined) moneyMinor(result.totalRefunded, expectedCurrency);
    return { providerRefundId: namespacedId, amountMinor: operation.amountMinor, currency: attempt.currency, status };
  }

  if (gateway === "tap") {
    const parsed = tapRefundSchema.safeParse(result.rawResponse);
    if (!parsed.success) {
      if (status === "completed") mismatch("refund amount mismatch");
      return { providerRefundId: refundId, amountMinor: operation.amountMinor, currency: attempt.currency, status };
    }
    if (parsed.data.id !== refundId) mismatch("refund amount mismatch");
    if (parsed.data.currency.trim().toUpperCase() !== expectedCurrency) mismatch("refund amount mismatch");
    if (parsed.data.charge_id !== undefined && operation.providerId !== undefined && parsed.data.charge_id !== operation.providerId) {
      mismatch("refund amount mismatch");
    }
    const perMinor = moneyMinor({ amount: String(parsed.data.amount), currency: parsed.data.currency }, expectedCurrency);
    if (perMinor !== operation.amountMinor) mismatch("refund amount mismatch");
    return { providerRefundId: refundId, amountMinor: perMinor, currency: attempt.currency, status };
  }

  if (gateway === "hesabe") {
    const parsed = hesabeRefundSchema.safeParse(result.rawResponse);
    if (!parsed.success) {
      if (status === "completed") mismatch("refund amount mismatch");
      return { providerRefundId: refundId, amountMinor: operation.amountMinor, currency: attempt.currency, status };
    }
    if (parsed.data.id !== refundId) mismatch("refund amount mismatch");
    if (parsed.data.currency.trim().toUpperCase() !== expectedCurrency) mismatch("refund amount mismatch");
    if (operation.providerId !== undefined && parsed.data.token !== operation.providerId) mismatch("refund amount mismatch");
    const perMinor = moneyMinor({ amount: parsed.data.amount, currency: parsed.data.currency }, expectedCurrency);
    if (perMinor !== operation.amountMinor) mismatch("refund amount mismatch");
    return { providerRefundId: refundId, amountMinor: perMinor, currency: attempt.currency, status };
  }

  if (result.totalRefunded !== undefined) {
    const perMinor = moneyMinor(result.totalRefunded, expectedCurrency);
    if (perMinor !== operation.amountMinor) mismatch("refund amount mismatch");
    return { providerRefundId: refundId, amountMinor: perMinor, currency: attempt.currency, status };
  }
  if (status === "completed") mismatch("refund amount mismatch");
  return { providerRefundId: refundId, amountMinor: operation.amountMinor, currency: attempt.currency, status };
}
