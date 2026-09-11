/** Lab domain types. Pure types only — no D1 imports, no I/O. */

export type LabGateway =
  | "moyasar"
  | "paypal"
  | "paymob"
  | "stripe"
  | "tap"
  | "myfatoorah"
  | "hesabe";

export type LabMode = "sandbox" | "simulator";

export type LabFulfillment =
  | "unfulfilled"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";

export type LabFinancialStatus =
  | "pending"
  | "processing"
  | "approved"
  | "authorized"
  | "partially_captured"
  | "paid"
  | "failed"
  | "cancelled"
  | "partially_refunded"
  | "refunded";

export type LabOperationKind =
  | "create"
  | "capture"
  | "void"
  | "refund"
  | "complete-return";

export type LabOperationStatus =
  | "reserved"
  | "submitted"
  | "pending"
  | "completed"
  | "failed"
  | "indeterminate";

export type LabRefundStatus = "pending" | "completed" | "failed";

export type LabCaptureIntent = "automatic" | "manual";

export type LabWebhookEffect = "matched" | "mismatched" | "unmatched";

export type LabWebhookStatus = "received" | "processed" | "failed";

export type LabTestVerdict =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "unsupported";

export type LabLineItem = {
  name: string;
  quantity: number;
  unitMinor: number;
  sku?: string | undefined;
};

export type LabOrder = {
  id: string;
  guestTokenHash: string;
  customerName: string;
  customerEmail: string;
  totalMinor: number;
  currency: string;
  items: LabLineItem[];
  fulfillment: LabFulfillment;
  notes: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LabProviderRefs = {
  providerObjectId?: string | undefined;
  providerOrderId?: string | undefined;
  providerAuthorizationId?: string | undefined;
  providerCaptureId?: string | undefined;
};

export type LabAttempt = {
  id: string;
  orderId: string;
  gateway: LabGateway;
  mode: LabMode;
  amountMinor: number;
  currency: string;
  captureIntent: LabCaptureIntent;
  idempotencyKey: string;
  fingerprint: string;
  status: LabFinancialStatus;
  ambiguous: boolean;
  pendingOperationId: string | undefined;
  provider: LabProviderRefs;
  capturedMinor: number;
  refundedMinor: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LabOperation = {
  capturedBeforeMinor?: number | undefined;
  id: string;
  attemptId: string;
  kind: LabOperationKind;
  idempotencyKey: string;
  fingerprint: string;
  amountMinor: number;
  currency: string;
  providerId: string | undefined;
  status: LabOperationStatus;
  attempts: number;
  nextRetryAt: string | undefined;
  lastError: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LabRefund = {
  id: string;
  attemptId: string;
  operationId: string;
  providerRefundId: string;
  amountMinor: number;
  currency: string;
  status: LabRefundStatus;
  createdAt: string;
  updatedAt: string;
};

export type LabWebhook = {
  id: string;
  gateway: LabGateway;
  mode: LabMode;
  providerEventId: string;
  attemptId: string | undefined;
  effect: LabWebhookEffect;
  status: LabWebhookStatus;
  evidenceJson: string;
  attempts: number;
  nextRetryAt: string | undefined;
  lastError: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type LabTestRun = {
  id: string;
  scenario: string;
  gateway: LabGateway;
  mode: LabMode;
  verdict: LabTestVerdict;
  evidenceJson: string;
  createdAt: string;
  updatedAt: string;
};

/** Safe normalized provider payment evidence. Never raw provider payloads. */
export type LabPaymentEvidence = {
  amountMinor: number;
  status: LabFinancialStatus;
  /** Newly captured minor total reported by the provider (monotonic). */
  capturedMinor: number;
  currency: string;
  provider: LabProviderRefs;
  providerEventId?: string | undefined;
  eventTime?: string | undefined;
};

/** Safe normalized provider refund evidence (separate entity). */
export type LabRefundEvidence = {
  providerRefundId: string;
  amountMinor: number;
  currency: string;
  status: LabRefundStatus;
};

/* ── Request objects (public function inputs) ── */

export type CreateOrderRequest = {
  id?: string | undefined;
  guestTokenHash: string;
  customerName: string;
  customerEmail: string;
  totalMinor: number;
  currency: string;
  items: LabLineItem[];
  notes?: string | undefined;
};

export type EditOrderRequest = {
  orderId: string;
  expectedVersion: number;
  totalMinor: number;
  currency: string;
  items: LabLineItem[];
};

export type UpdateFulfillmentRequest = {
  orderId: string;
  expectedVersion: number;
  fulfillment: LabFulfillment;
};

export type UpdateNotesRequest = {
  orderId: string;
  expectedVersion: number;
  notes: string;
};

export type ReserveAttemptRequest = {
  id?: string | undefined;
  orderId: string;
  gateway: LabGateway;
  mode: LabMode;
  amountMinor: number;
  currency: string;
  captureIntent: LabCaptureIntent;
  idempotencyKey: string;
  fingerprint: string;
};

export type ReserveOperationRequest = {
  id?: string | undefined;
  attemptId: string;
  kind: LabOperationKind;
  idempotencyKey: string;
  fingerprint: string;
  amountMinor: number;
  currency: string;
  providerId?: string | undefined;
};

export type ApplyPaymentEvidenceRequest = {
  attemptId: string;
  expectedVersion: number;
  evidence: LabPaymentEvidence;
};

export type ApplyRefundEvidenceRequest = {
  attemptId: string;
  operationId: string;
  evidence: LabRefundEvidence;
};

export type RecordWebhookRequest = {
  id?: string | undefined;
  gateway: LabGateway;
  mode: LabMode;
  providerEventId: string;
  attemptId?: string | undefined;
  effect: LabWebhookEffect;
  /** Redacted normalized evidence JSON (caller-sanitized). */
  evidenceJson?: string | undefined;
};

export type CreateTestRunRequest = {
  id?: string | undefined;
  scenario: string;
  gateway: LabGateway;
  mode: LabMode;
};

export type UpdateTestRunRequest = {
  id: string;
  verdict: LabTestVerdict;
  evidenceJson?: string | undefined;
};

/* ── Result objects (replay flags let callers skip duplicate provider work) ── */

export type ReserveAttemptResult = {
  attempt: LabAttempt;
  /** True when the idempotency key already owned this attempt (no new provider request). */
  replayed: boolean;
};

export type ReserveOperationResult = {
  operation: LabOperation;
  /** True when the idempotency key already owned this operation. */
  replayed: boolean;
};

export type ApplyPaymentEvidenceResult = {
  attempt: LabAttempt;
};

export type ApplyRefundEvidenceResult = {
  refund: LabRefund;
  attempt: LabAttempt;
  /** True when this provider refund id was already settled/recorded. */
  replayed: boolean;
};

export type RecordWebhookResult = {
  webhook: LabWebhook;
  /** True when this provider event id was already recorded (dedupe hit). */
  replayed: boolean;
};

export type MarkOperationRequest = {
  operationId: string;
  expectedVersion: number;
  nextRetryAt?: string | undefined;
  lastError?: string | undefined;
};

export type MarkWebhookRequest = {
  webhookId: string;
  nextRetryAt?: string | undefined;
  lastError?: string | undefined;
};

export type SimulatorState = {
  gateway: LabGateway;
  mode: "simulator";
  stateKey: string;
  stateJson: string;
  updatedAt: string;
};

export type PutSimulatorStateRequest = {
  gateway: LabGateway;
  /** Must be "simulator"; sandbox targeting is rejected. */
  mode: LabMode;
  stateKey: string;
  stateJson?: string | undefined;
};
