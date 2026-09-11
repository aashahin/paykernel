/**
 * SDK store factories for the payment lab.
 *
 * Apply migrations/0003_sdk_stores.sql before use; these factories never
 * auto-migrate.
 */
import type {
  IdempotencyRecord as CoreRecord,
  IdempotencyStore as CoreStore,
} from "@paykernel/core";
import {
  createD1IdempotencyStoreFromBinding,
  createD1PaymentStores,
} from "@paykernel/store-d1";
import type { IdempotencyRecord as LeaseRecord } from "@paykernel/store-contracts";
import type { D1DatabaseLike } from "./payments/db";

const LEASE_MS = 24 * 60 * 60 * 1000;

/** Cache normalized SDK values without retaining provider payloads or card inputs. */
export function sanitizeCachedResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCachedResult);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["rawResponse", "rawPayload", "card", "pan", "cvv", "cvc", "securityCode"].includes(key))
    .map(([key, item]) => [key, sanitizeCachedResult(item)]));
}

export function createSdkStores(db: D1DatabaseLike) {
  return createD1PaymentStores({ db: db });
}

function toCore(record: LeaseRecord): CoreRecord {
  const status: CoreRecord["status"] =
    record.status === "completed"
      ? "completed"
      : record.status === "indeterminate" || record.status === "expired"
        ? "unknown"
        : "in_progress";
  const parsed = Date.parse(record.createdAt);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid idempotency timestamp");
  const createdAt = parsed;
  const out: CoreRecord = { status, fingerprint: record.fingerprint, createdAt };
  if (record.result !== undefined) out.result = record.result;
  return out;
}

/**
 * Core legacy IdempotencyStore over the lease-aware D1 store.
 * Ownership Map holds lease tokens only (post-reserve); all records read from D1.
 * Keys are scoped as `<namespace>:<key>`; D1 tables keep the default namespace.
 */
export function createGatewayIdempotencyStore(db: D1DatabaseLike, namespace: string): CoreStore {
  const lease = createD1IdempotencyStoreFromBinding({
    db: db,
  });
  const owner = `payment-lab:${namespace}`;
  const owned = new Map<string, string>();
  const scoped = (key: string): string => (namespace.length > 0 ? `${namespace}:${key}` : key);

  return {
    async get(key: string): Promise<CoreRecord | undefined> {
      const found = await lease.get(scoped(key));
      return found === undefined ? undefined : toCore(found);
    },
    async set(key: string, record: CoreRecord): Promise<void> {
      const sk = scoped(key);
      const token = owned.get(sk);
      if (token !== undefined) {
        if (record.status === "completed") {
          await lease.complete({
            key: sk,
            leaseToken: token,
            result: "result" in record ? sanitizeCachedResult(record.result) : null,
          });
          owned.delete(sk);
        } else if (record.status === "unknown") {
          await lease.markIndeterminate({ key: sk, leaseToken: token });
          owned.delete(sk);
        }
        return;
      }
      throw new Error("Idempotency completion requires ownership of the reservation");
    },
    async delete(key: string): Promise<void> {
      const sk = scoped(key);
      const token = owned.get(sk);
      if (token === undefined) return;
      // The legacy interface cannot prove that a provider did not accept the request.
      await lease.markIndeterminate({ key: sk, leaseToken: token });
      owned.delete(sk);
    },
    async reserve(key: string, record: CoreRecord): Promise<CoreRecord | undefined> {
      const sk = scoped(key);
      const existing = await lease.get(sk);
      if (existing) return toCore(existing);
      const res = await lease.reserve({
        key: sk,
        fingerprint: record.fingerprint,
        owner,
        leaseMs: LEASE_MS,
      });
      if (res.kind === "acquired") {
        owned.set(sk, res.leaseToken);
        return undefined;
      }
      return toCore(res.record);
    },
  };
}
