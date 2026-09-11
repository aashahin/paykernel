-- payment-lab D1 domain schema (versioned migration 0002).
-- Applies AFTER foundation/auth migration 0001 (owned by another worker).
-- DIALECT: Cloudflare D1 / SQLite. No BEGIN/COMMIT wrappers (D1 apply rejects them).
-- All money is integer minor units. Timestamps are ISO-8601 TEXT.
-- Concurrency is enforced by UNIQUE + partial UNIQUE indexes (no read-then-insert races).

CREATE TABLE IF NOT EXISTS lab_orders (
  id TEXT PRIMARY KEY NOT NULL,
  guest_token_hash TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  items_json TEXT NOT NULL,
  fulfillment TEXT NOT NULL DEFAULT 'unfulfilled',
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(guest_token_hash) BETWEEN 1 AND 256),
  CHECK (length(customer_name) BETWEEN 1 AND 200),
  CHECK (length(customer_email) BETWEEN 3 AND 320),
  CHECK (total_minor > 0 AND total_minor <= 9007199254740991),
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  CHECK (fulfillment IN ('unfulfilled','processing','shipped','delivered','cancelled')),
  CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_updated ON lab_orders (updated_at);
CREATE INDEX IF NOT EXISTS idx_lab_orders_email ON lab_orders (customer_email);

CREATE TABLE IF NOT EXISTS lab_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES lab_orders(id),
  gateway TEXT NOT NULL,
  mode TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  capture_intent TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ambiguous INTEGER NOT NULL DEFAULT 0,
  pending_operation_id TEXT,
  provider_object_id TEXT,
  provider_order_id TEXT,
  provider_authorization_id TEXT,
  provider_capture_id TEXT,
  captured_minor INTEGER NOT NULL DEFAULT 0,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (gateway IN ('moyasar','paypal','paymob','stripe','tap','myfatoorah','hesabe')),
  CHECK (mode IN ('sandbox','simulator')),
  CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  CHECK (capture_intent IN ('automatic','manual')),
  CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  CHECK (length(fingerprint) BETWEEN 1 AND 256),
  CHECK (status IN ('pending','processing','approved','authorized','partially_captured','paid','failed','cancelled','partially_refunded','refunded')),
  CHECK (ambiguous IN (0, 1)),
  CHECK (captured_minor >= 0 AND captured_minor <= 9007199254740991),
  CHECK (refunded_minor >= 0 AND refunded_minor <= 9007199254740991),
  CHECK (refunded_minor <= captured_minor),
  CHECK (captured_minor <= amount_minor),
  CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_lab_attempts_order ON lab_attempts (order_id);
CREATE INDEX IF NOT EXISTS idx_lab_attempts_idem ON lab_attempts (gateway, mode, idempotency_key);
-- Stable idempotency: same gateway+mode+key always addresses one attempt row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_attempts_idem ON lab_attempts (gateway, mode, idempotency_key);
-- At most one blocking (unresolved or funded) attempt per order. Failed/cancelled are terminal-unfunded
-- and do not block a retry with a fresh idempotency key. Enforced by the engine: concurrent
-- INSERTs serialize here, so reserves never rely on read-then-insert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_attempts_single_blocking
  ON lab_attempts (order_id)
  WHERE status IN ('pending','processing','approved','authorized','partially_captured','paid','partially_refunded','refunded');

CREATE TABLE IF NOT EXISTS lab_operations (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES lab_attempts(id),
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'reserved',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_sanitized TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (kind IN ('create','capture','void','refund','complete-return')),
  CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  CHECK (length(fingerprint) BETWEEN 1 AND 256),
  CHECK (amount_minor >= 0 AND amount_minor <= 9007199254740991),
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  CHECK (status IN ('reserved','submitted','pending','completed','failed','indeterminate')),
  CHECK (attempts >= 0),
  CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS idx_lab_operations_attempt ON lab_operations (attempt_id);
CREATE INDEX IF NOT EXISTS idx_lab_operations_retry ON lab_operations (status, next_retry_at);
-- Stable idempotency per attempt: replay with same key addresses one ledger row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_operations_idem ON lab_operations (attempt_id, idempotency_key);
-- Single unresolved mutation per attempt: concurrent reserves serialize here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_operations_single_unresolved
  ON lab_operations (attempt_id)
  WHERE status IN ('reserved','submitted','pending','indeterminate');

CREATE TABLE IF NOT EXISTS lab_refunds (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES lab_attempts(id),
  operation_id TEXT NOT NULL REFERENCES lab_operations(id),
  provider_refund_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(provider_refund_id) BETWEEN 1 AND 256),
  CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  CHECK (status IN ('pending','completed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_lab_refunds_attempt ON lab_refunds (attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_refunds_operation ON lab_refunds (operation_id);
-- Duplicate provider completion evidence is idempotent, never double-counted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_refunds_provider ON lab_refunds (attempt_id, provider_refund_id);

-- Trusted webhook deliveries. Dedupe key is (gateway, mode, provider_event_id).
-- Only signature-verified deliveries claim this key (see lab_webhook_rejections).
CREATE TABLE IF NOT EXISTS lab_webhooks (
  id TEXT PRIMARY KEY NOT NULL,
  gateway TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  attempt_id TEXT REFERENCES lab_attempts(id),
  effect TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error_sanitized TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (gateway IN ('moyasar','paypal','paymob','stripe','tap','myfatoorah','hesabe')),
  CHECK (mode IN ('sandbox','simulator')),
  CHECK (length(provider_event_id) BETWEEN 1 AND 256),
  CHECK (effect IN ('matched','mismatched','unmatched')),
  CHECK (status IN ('received','processed','failed')),
  CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_webhooks_dedupe ON lab_webhooks (gateway, mode, provider_event_id);
CREATE INDEX IF NOT EXISTS idx_lab_webhooks_retry ON lab_webhooks (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_lab_webhooks_attempt ON lab_webhooks (attempt_id);

-- Invalid-signature deliveries: recorded for observability but MUST NOT claim the
-- trusted dedupe key, so a later valid delivery with the same provider event id still processes.
CREATE TABLE IF NOT EXISTS lab_webhook_rejections (
  id TEXT PRIMARY KEY NOT NULL,
  gateway TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  reason_sanitized TEXT NOT NULL DEFAULT 'invalid_signature',
  payload_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_webhook_rejections_event ON lab_webhook_rejections (gateway, mode, provider_event_id);

CREATE TABLE IF NOT EXISTS lab_test_runs (
  id TEXT PRIMARY KEY NOT NULL,
  scenario TEXT NOT NULL,
  gateway TEXT NOT NULL,
  mode TEXT NOT NULL,
  verdict TEXT NOT NULL DEFAULT 'running',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(scenario) BETWEEN 1 AND 200),
  CHECK (gateway IN ('moyasar','paypal','paymob','stripe','tap','myfatoorah','hesabe')),
  CHECK (mode IN ('sandbox','simulator')),
  CHECK (verdict IN ('running','passed','failed','blocked','unsupported'))
);
CREATE INDEX IF NOT EXISTS idx_lab_test_runs_scenario ON lab_test_runs (scenario, gateway, mode);

-- Simulator provider state. Independent from attempt financial status: never alias one as the other.
-- Primary key includes mode so sandbox and simulator state never mix.
CREATE TABLE IF NOT EXISTS lab_simulator_state (
  gateway TEXT NOT NULL,
  mode TEXT NOT NULL,
  state_key TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (gateway, mode, state_key),
  CHECK (gateway IN ('moyasar','paypal','paymob','stripe','tap','myfatoorah','hesabe')),
  CHECK (mode IN ('sandbox','simulator')),
  CHECK (length(state_key) BETWEEN 1 AND 256)
);

-- Generic audit log. Writes are paired with their state transition in one D1 batch()
-- and guarded by the new version (SELECT ... WHERE version = newVersion), so an audit
-- row is only inserted when the conditional transition actually matched.
CREATE TABLE IF NOT EXISTS lab_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CHECK (entity_kind IN ('order','attempt','operation','refund','webhook','test_run')),
  CHECK (length(entity_id) BETWEEN 1 AND 256),
  CHECK (length(action) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS idx_lab_audit_entity ON lab_audit (entity_kind, entity_id, id);
