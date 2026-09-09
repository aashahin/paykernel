import {
  applyIndeterminatePaymentOutcome,
  applyIndeterminateRefundOutcome,
  fingerprintParams,
  InvalidRequestError,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type IdempotencyStore,
} from "@paykernel/core";

type HesabeMutationResult = GatewayPaymentResult | GatewayRefundResult;

function isCachedHesabeResult(value: unknown): value is HesabeMutationResult {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.outcome !== "string") return false;
  if (typeof rec.status !== "string") return false;
  if ("gatewayId" in rec && typeof rec.gatewayId !== "string") return false;
  if ("gatewayRefundId" in rec && typeof rec.gatewayRefundId !== "string") {
    return false;
  }
  if (!("gatewayId" in rec) && !("gatewayRefundId" in rec)) return false;
  if (rec.gateway !== undefined && rec.gateway !== "hesabe") return false;
  return true;
}

/**
 * One shared reservation implementation for Hesabe payment + refund
 * mutations. Reserve before the mutation, replay completed results, reject
 * changed params / concurrent in-progress. Mark submitted immediately before
 * the real fetch. Release only on definitely pre-submit errors; retain on
 * all post-submit ambiguous failures. Indeterminate results persist as
 * `unknown` (never auto-available); the persistent store must retain
 * uncertain records beyond the retry horizon.
 */
export async function withHesabeReservation<T extends HesabeMutationResult>(
  input: {
    store: IdempotencyStore;
    key: string;
    fingerprintInput: unknown;
    createdAt: number;
  },
  execute: (markSubmitted: () => void) => Promise<T>,
): Promise<T> {
  const fingerprint = fingerprintParams(input.fingerprintInput);
  const existing = await input.store.reserve(input.key, {
    status: "in_progress",
    fingerprint,
    createdAt: input.createdAt,
  });
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      throw new InvalidRequestError("Hesabe idempotency key reuse with different params");
    }
    if (existing.status === "completed") {
      if (isCachedHesabeResult(existing.result)) {
        return existing.result as T;
      }
      throw new InvalidRequestError("Hesabe cached idempotency result is not a hesabe result");
    }
    throw new InvalidRequestError(
      existing.status === "unknown"
        ? "Hesabe operation is indeterminate; reconcile before retrying"
        : "Hesabe operation is already in progress for this idempotency key",
    );
  }

  let submitted = false;
  const markSubmitted = (): void => {
    submitted = true;
  };
  let result: T;
  try {
    result = await execute(markSubmitted);
  } catch (error) {
    if (!submitted) {
      await input.store.delete(input.key);
    }
    throw error;
  }

  if (result.outcome === "indeterminate" && !submitted) {
    await input.store.delete(input.key);
    return result;
  }
  try {
    await input.store.set(input.key, {
      status: result.outcome === "indeterminate" ? "unknown" : "completed",
      fingerprint,
      createdAt: input.createdAt,
      ...(result.outcome === "indeterminate" ? {} : { result }),
    });
  } catch (error) {
    if (!submitted) throw error;
    // A provider submission cannot be undone when local persistence fails.
    // The original reservation remains; return a reconciliation outcome.
    return persistenceFailureOutcome(result) as T;
  }
  return result;
}

function persistenceFailureOutcome(result: HesabeMutationResult): HesabeMutationResult {
  if (result.outcome === "indeterminate") return result;
  const details = {
    message: "Hesabe submission could not be persisted; reconcile before retrying",
    errorName: "IdempotencyPersistenceError",
  };
  return "gatewayId" in result
    ? applyIndeterminatePaymentOutcome({
        ...details,
        gateway: "hesabe",
        gatewayId: result.gatewayId,
      })
    : applyIndeterminateRefundOutcome({ ...details, gatewayRefundId: result.gatewayRefundId });
}
