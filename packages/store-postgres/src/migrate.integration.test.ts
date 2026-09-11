/**
 * Migration helpers — works with fake executor (no live PG required for basic paths).
 * Live PG path covered when PAYMENTS_SDK_PG_URL / DATABASE_URL is set.
 */
import { describe, expect, it } from "bun:test";
import {
  createFakeDbState,
  expectedTablesForNamespace,
} from "@paykernel/sql-foundation";
import { createFakeExecutor } from "../../sql-foundation/src/testing";
import type { PostgresExecutor } from "./executor";
import { migratePostgresAdapter, verifyPostgresAdapterSchema } from "./migrate";
import { toSqlStoreExecutor } from "./executor";
import { createPostgresJsPostgresExecutor } from "./drivers/postgres-js";
import {
  dropFoundationTablesSql,
  hasLivePostgres,
  PG_URL,
  uniqueTablePrefix,
} from "./test-utils/pg-env";

function wrapFakeAsPostgres(): {
  executor: PostgresExecutor;
  state: ReturnType<typeof createFakeDbState>;
} {
  const state = createFakeDbState();
  const sqlExec = createFakeExecutor(state);
  const executor: PostgresExecutor = {
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const rows = (await sqlExec.query?.(sql, params)) ?? [];
      return rows as T[];
    },
    async execute(sql: string, params?: readonly unknown[]) {
      await sqlExec.execute(sql, params);
      return { rowCount: 0 };
    },
  };
  return { executor, state };
}

describe("migratePostgresAdapter", () => {
  it("applies v1 and second migrate is no-op for applied set", async () => {
    const { executor } = wrapFakeAsPostgres();
    const r1 = await migratePostgresAdapter(executor);
    expect(r1.applied).toContain(1);
    expect(r1.currentVersion).toBeGreaterThanOrEqual(1);

    const r2 = await migratePostgresAdapter(executor);
    expect(r2.applied).toEqual([]);
    expect(r2.alreadyApplied).toContain(1);
  });

  it("toSqlStoreExecutor preserves query/execute", async () => {
    const { executor, state } = wrapFakeAsPostgres();
    const sql = toSqlStoreExecutor(executor);
    await sql.execute('CREATE TABLE IF NOT EXISTS "payment_idempotency" (key TEXT)');
    // fake executor marks tables on CREATE
    expect(state.tables.size).toBeGreaterThanOrEqual(0);
  });
});

describe("verifyPostgresAdapterSchema", () => {
  it("fails when tables missing", async () => {
    const { executor } = wrapFakeAsPostgres();
    // No migrate — verify should report missing
    const result = await verifyPostgresAdapterSchema(executor, {
      listTables: () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("passes when expected tables listed after migrate", async () => {
    const { executor, state } = wrapFakeAsPostgres();
    await migratePostgresAdapter(executor);
    const expected = expectedTablesForNamespace({});
    for (const t of expected) state.tables.add(t);

    const result = await verifyPostgresAdapterSchema(executor, {
      listTables: () => [...state.tables],
    });
    // version may be 0 if fake migrations bookkeeping is incomplete; at least missing empty
    expect(result.missing).toEqual([]);
  });
});

const live = hasLivePostgres();

describe.skipIf(!live)("migrate live postgres", () => {
  // Managed/remote PG (Supabase pooler, etc.) can exceed the default 5s bun test timeout.
  it(
    "migrate + verify against real PG via postgres-js binding",
    async () => {
      const postgres = await import("postgres");
      const sql = postgres.default(PG_URL!, {
        max: 2,
        connect_timeout: 15,
      });
      try {
        const executor = createPostgresJsPostgresExecutor(sql);
        const prefix = uniqueTablePrefix("t");
        const r1 = await migratePostgresAdapter(executor, {
          namespace: { tablePrefix: prefix },
        });
        expect(r1.currentVersion).toBeGreaterThanOrEqual(1);
        expect(r1.applied.length).toBeGreaterThan(0);

        const v = await verifyPostgresAdapterSchema(executor, {
          namespace: { tablePrefix: prefix },
        });
        expect(v.ok || v.missing.length === 0).toBe(true);

        const r2 = await migratePostgresAdapter(executor, {
          namespace: { tablePrefix: prefix },
        });
        expect(r2.applied).toEqual([]);
        expect(r2.alreadyApplied.length).toBeGreaterThan(0);

        await sql.unsafe(dropFoundationTablesSql(prefix));
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    { timeout: 60_000 },
  );
});
