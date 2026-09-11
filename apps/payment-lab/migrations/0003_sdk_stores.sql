-- Cloudflare D1 foundation schema (SQLite dialect).
-- Applied via migrateD1Adapter / sql-store migrate(dialect: "sqlite").
-- DO NOT wrap statements in BEGIN/COMMIT — D1 apply path rejects transaction wrappers
-- and sql-store foundation DDL is already statement-split without BEGIN/COMMIT.
--
-- Prefer: await migrateD1Adapter(db) or await migrateD1Adapter(executor)
-- This file is a reference packaging for Wrangler `d1 migrations` workflows.
-- Keep in sync with @paykernel/internal-sql-store FOUNDATION_SQL_SQLITE.
--
-- Operators using sql-store migrate get the authoritative multi-statement apply
-- (includes migrations ledger rows). When using wrangler d1 migrations apply alone,
-- ensure each statement is valid for D1 and still call migrateD1Adapter for ledger parity
-- OR understand that this file is the table/index DDL snapshot only.
--
-- Numeric portability: IDs, tokens, hashes, timestamps, and money-like values use TEXT.
-- Integer counters (attempts, generation) remain INTEGER.
--
-- Verified packaging: no BEGIN/COMMIT wrappers.

CREATE TABLE IF NOT EXISTS "payment_idempotency" (
  key TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tenant_id TEXT,
  completed_at TEXT,
  indeterminate_at TEXT,
  error_sanitized TEXT,
  CHECK (status IN ('reserved', 'completed', 'indeterminate', 'expired')),
  CHECK (attempts >= 0),
  CHECK (generation >= 0)
);
CREATE INDEX IF NOT EXISTS idx_payment_idempotency_lease_expires ON "payment_idempotency" (lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_idempotency_status ON "payment_idempotency" (status);
CREATE INDEX IF NOT EXISTS idx_payment_idempotency_tenant ON "payment_idempotency" (tenant_id);
CREATE TABLE IF NOT EXISTS "payment_webhook_inbox" (
  key TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  gateway TEXT,
  provider_event_id TEXT,
  payload_ref TEXT,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  available_at TEXT,
  first_received_at TEXT,
  last_received_at TEXT,
  completed_at TEXT,
  last_error_sanitized TEXT,
  tenant_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'dead_letter')),
  CHECK (attempts >= 0),
  CHECK (generation >= 0)
);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_inbox_lease_expires ON "payment_webhook_inbox" (lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_inbox_available ON "payment_webhook_inbox" (available_at);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_inbox_status ON "payment_webhook_inbox" (status);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_inbox_tenant ON "payment_webhook_inbox" (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_inbox_payload_hash ON "payment_webhook_inbox" (payload_hash);
CREATE TABLE IF NOT EXISTS "payment_reconciliation_jobs" (
  key TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  subject_id TEXT,
  reason TEXT,
  due_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  last_error_sanitized TEXT,
  tenant_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (status IN ('scheduled', 'claimed', 'completed', 'failed', 'manual_review')),
  CHECK (attempts >= 0),
  CHECK (generation >= 0)
);
CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_lease_expires ON "payment_reconciliation_jobs" (lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_due ON "payment_reconciliation_jobs" (due_at);
CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_status ON "payment_reconciliation_jobs" (status);
CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_tenant ON "payment_reconciliation_jobs" (tenant_id);
CREATE TABLE IF NOT EXISTS "payment_storage_migrations" (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT
);
-- payments-storage v1 sqlite: TEXT timestamps + CHECK;

-- PERF-3: composite list/cleanup indexes for already-applied v1 databases.
-- Do not rewrite 0001_foundation.sql. CREATE INDEX IF NOT EXISTS is a no-op
-- when migrate() / current v1 DDL already created these names.
-- Applied via migrateD1Adapter (sql-foundation v2) or Wrangler `d1 migrations`.
-- DO NOT wrap statements in BEGIN/COMMIT.

CREATE INDEX IF NOT EXISTS idx_payment_webhook_inbox_st_avail ON "payment_webhook_inbox" (status, available_at);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_inbox_st_lexp ON "payment_webhook_inbox" (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_st_due ON "payment_reconciliation_jobs" (status, due_at);
CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_jobs_st_lexp ON "payment_reconciliation_jobs" (status, lease_expires_at);
