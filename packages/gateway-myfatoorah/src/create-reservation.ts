// file: packages/gateway-myfatoorah/src/create-reservation.ts
import {
  fingerprintParams,
  InvalidRequestError,
  type GatewayPaymentResult,
  type IdempotencyStore,
} from "@paykernel/core";

interface CreateReservationInput {
  store: IdempotencyStore | undefined;
  key: string;
  fingerprintInput: unknown;
  createdAt: number;
}

function isCachedMyFatoorahResult(value: unknown): value is GatewayPaymentResult {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.outcome !== "string") return false;
  if (typeof rec.gatewayId !== "string") return false;
  if (typeof rec.status !== "string") return false;
  if (rec.gateway !== undefined && rec.gateway !== "myfatoorah") return false;
  const refs = rec.references;
  if (refs !== undefined && refs !== null && typeof refs === "object") {
    const gateway = (refs as Record<string, unknown>).gateway;
    if (gateway !== undefined && gateway !== "myfatoorah") return false;
  }
  return true;
}

/**
 * Outside KWT/SAU create fence. Caller must call `markSubmitted` before the
 * attempted POST; the fence is retained after submission (including store
 * persistence failures) and cleared only for pre-submit failures.
 */
export async function withCreateReservation(
  { store, key, fingerprintInput, createdAt }: CreateReservationInput,
  execute: (markSubmitted: () => void) => Promise<GatewayPaymentResult>,
): Promise<GatewayPaymentResult> {
  if (!store) {
    throw new InvalidRequestError(
      "MyFatoorah createPayment requires an idempotency store outside KWT/SAU",
    );
  }
  const fingerprint = fingerprintParams(fingerprintInput);
  const existing = await store.reserve(key, {
    status: "in_progress",
    fingerprint,
    createdAt,
  });
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      throw new InvalidRequestError(
        "MyFatoorah idempotency key reuse with different params; refusing second invoice",
      );
    }
    if (existing.status === "completed") {
      if (isCachedMyFatoorahResult(existing.result)) return existing.result;
      throw new InvalidRequestError(
        "MyFatoorah cached idempotency result is not a myfatoorah payment result",
      );
    }
    throw new InvalidRequestError(
      existing.status === "unknown"
        ? "MyFatoorah payment is indeterminate; reconcile before retrying"
        : "MyFatoorah payment is already in progress for this idempotency key",
    );
  }

  let submitted = false;
  const markSubmitted = (): void => {
    submitted = true;
  };
  let result: GatewayPaymentResult;
  try {
    result = await execute(markSubmitted);
  } catch (error) {
    if (!submitted) {
      await store.delete(key);
    }
    throw error;
  }

  if (result.outcome === "indeterminate") {
    if (!submitted) {
      await store.delete(key);
      return result;
    }
    await store.set(key, { status: "unknown", fingerprint, createdAt });
  } else {
    await store.set(key, { status: "completed", fingerprint, createdAt, result });
  }
  return result;
}
