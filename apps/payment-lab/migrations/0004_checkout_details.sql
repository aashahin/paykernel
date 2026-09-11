CREATE TABLE lab_checkout_details (
 attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES lab_attempts(id),
 client_secret TEXT,
 redirect_url TEXT,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_refunds_operation ON lab_refunds(operation_id);
