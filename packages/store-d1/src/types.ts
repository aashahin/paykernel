/**
 * Structural D1 types + store options.
 *
 * Consumers pass Workers `env.DB` (or a mock) without this package importing
 * `cloudflare:workers`. Optional peer `@cloudflare/workers-types` improves DX.
 */

import type {
  ResolvedSchemaNamespace,
  SchemaNamespaceConfig,
} from "@paykernel/sql-foundation";
import type { D1Executor } from "./executor";
import type { StoreClock } from "./clock";

export type { D1Executor, D1ExecutorOptions } from "./executor";
export type { StoreClock } from "./clock";
export type { SchemaNamespaceConfig, ResolvedSchemaNamespace };

/**
 * Minimal structural surface — duck-types real D1Database from Workers.
 * Verified against Cloudflare D1 Workers Binding API docs (2026-08-03).
 */
export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: boolean;
    error?: string;
    meta?: unknown;
  }>;
  run(): Promise<{
    success: boolean;
    error?: string;
    meta?: { changes?: number; [key: string]: unknown };
    results?: unknown[];
  }>;
};

/**
 * Structural D1Database / D1DatabaseSession surface.
 * `withSession` is optional for older bindings / mocks without Sessions API.
 */
export type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
  /** Sessions API — returns a session-scoped DB (or self-like object). */
  withSession?(constraintOrBookmark?: string): D1DatabaseLike;
};

/**
 * Options shared by createD1*Store factories that take an executor.
 *
 * - `executor` is required when not using binding factories.
 * - `clock` is optional; default wall clock. Prefer FakeClock in tests.
 * - `namespace` is validated via createSchemaNamespace — never raw SQL names.
 * - Factories do **not** migrate by default.
 */
export type D1StoreOptions = {
  executor: D1Executor;
  /** Injectable clock for lease expiry / ISO timestamps (FakeClock-compatible). */
  clock?: StoreClock;
  /** Schema/table namespace; validated identifiers only. */
  namespace?: SchemaNamespaceConfig;
};

/**
 * Ergonomic binding options for `createD1PaymentStores({ db })`.
 */
export type D1BindingStoreOptions = {
  /** Workers D1 binding (`env.PAYMENTS_DB` / `env.DB`) or mock. */
  db: D1DatabaseLike;
  clock?: StoreClock;
  namespace?: SchemaNamespaceConfig;
  /**
   * D1 Sessions API constraint / bookmark for read-after-write under read replication.
   *
   * - **Default (omitted):** `"first-primary"` when `db.withSession` exists — primary-first
   *   session so post-claim SELECTs are not served from a stale replica.
   *   Same default as `createD1Executor` / `migrateD1Adapter` on a raw binding.
   * - **string:** explicit constraint/bookmark (e.g. `"first-primary"`, `"first-unconstrained"`, bookmark).
   * - **`false`:** opt out of sessions (stale replica reads possible under D1 read replication).
   *
   * See docs/sessions-and-replication.md.
   */
  session?: string | false;
};

export type D1StoresBundle = {
  idempotency: import("@paykernel/store-contracts").IdempotencyStore;
  webhookInbox: import("@paykernel/store-contracts").WebhookInboxStore;
  reconciliation: import("@paykernel/store-contracts").ReconciliationStore;
  executor: D1Executor;
  namespace: ResolvedSchemaNamespace;
  clock: StoreClock;
  manifest: import("@paykernel/store-contracts").StorageAdapterManifest;
};
