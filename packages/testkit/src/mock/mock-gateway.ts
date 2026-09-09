/**
 * Scriptable mock PaymentGateway for application tests and conformance golden path.
 *
 * Behaviors:
 * - FIFO scripted outcomes per operation (last-step / defaultOutcome after drain)
 * - latencyMs / delayMs (FakeClock advances virtually; otherwise real setTimeout)
 * - AbortSignal cancellation, timeout / network_error / indeterminate
 * - provider-side success + client-side timeout dual outcome
 * - partial capture/refund with over-capture / over-refund rejection
 * - redacted request history + assertHistory
 * - HMAC webhook sign / verify + duplicate / out-of-order helpers
 *
 * Never hits real networks. NON-PRODUCTION test double only.
 */

import {
  applyIndeterminateCheckoutSessionOutcome,
  applyOutcomeToGatewayResult,
  applyOutcomeToGatewayRefundResult,
  buildProviderReferences,
  CardDeclinedError,
  createRedactingLogger,
  defineGatewayCapabilities,
  fingerprintParams,
  freezeCapabilities,
  fromMinorUnits,
  GatewayApiError,
  getCurrencyExponent,
  InsufficientFundsError,
  InvalidRequestError,
  isMoney,
  isPaidLikePaymentStatus,
  minorAmountToNumber,
  money,
  moneyToMajorNumber,
  NetworkError,
  noopLogger,
  normalizeAmountInput,
  OperationNotSupportedError,
  redact,
  toMinorUnits,
  type AmountInput,
  type AttachPaymentMethodParams,
  type CaptureParams,
  type CheckoutSessionOperationResult,
  type CommonCheckoutSessionInput,
  type CreateCustomerParams,
  type Customer,
  type CreatePaymentLinkParams,
  type CreatePaymentParams,
  type CustomerOperationResult,
  type DeactivatePaymentLinkParams,
  type DetachPaymentMethodParams,
  type DisputeOperationResult,
  type GatewayCapabilities,
  type GatewayCapabilityKey,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type GetCheckoutSessionParams,
  type GetCustomerParams,
  type GetDisputeParams,
  type GetPaymentLinkParams,
  type GetPaymentParams,
  type ListDisputesParams,
  type ListDisputesResult,
  type ListPaymentMethodsParams,
  type ListPaymentMethodsResult,
  type Logger,
  type Money,
  type PaymentGateway,
  type PaymentLinkOperationResult,
  type PaymentMethodOperationResult,
  type PaymentOperationOutcome,
  type GatewayPaymentStatus,
  type RefundParams,
  type SubmitDisputeEvidenceParams,
  type VoidParams,
  type WebhookEvent,
} from "@paykernel/core";

import type { Clock, FakeClock } from "../memory/fake-clock";
import type {
  HistoryAssertion,
  MockRequestRecord,
  ScriptedPaymentOutcome,
  ScriptedRefundOutcome,
  ScriptedThrowStep,
} from "./outcomes";
import {
  defaultPaymentResult,
  defaultRefundResult,
  paymentStatusToOperationOutcome,
  stepDelayMs,
} from "./outcomes";
import {
  computeMockWebhookSignature,
  createMockWebhookPayload,
  DEFAULT_MOCK_WEBHOOK_SECRET,
  generateDuplicateWebhooks,
  generateOutOfOrderWebhooks,
  generateWebhookEvent,
  mockPayloadToWebhookEvent,
  outOfOrderWebhooks,
  signMockWebhook,
  signWebhook,
  withDuplicateWebhook,
  type MockWebhookPayload,
  type SignMockWebhookOptions,
} from "./webhook-helpers";

/**
 * Pure conversion options for test helpers (allow zero/negative so the helper
 * is not charge-policy; charge paths use {@link resolveChargeAmount} instead).
 */
const CONVERSION_OPTS = {
  allowZero: true,
  allowNegative: true,
} as const;

/**
 * Convert major units → integer minor units via core bigint helpers.
 * Does **not** use `amount * 10**n` float math.
 *
 * Accepts deprecated `number` majors or {@link Money}. Excess precision is
 * rejected (same default as `@paykernel/core` money model).
 */
export function majorToMinor(amount: number | Money, currency: string): number {
  const m = isMoney(amount) ? amount : money(String(amount), currency, CONVERSION_OPTS);
  const normalized = normalizeAmountInput(m, m.currency, CONVERSION_OPTS);
  return minorAmountToNumber(toMinorUnits(normalized, CONVERSION_OPTS));
}

/**
 * Convert integer minor units → major-unit JS number via core helpers.
 * Prefer {@link Money} / minor integers for financial logic; the returned
 * number is for legacy result shapes and test assertions only.
 */
export function minorToMajor(minor: number, currency: string): number {
  const m = fromMinorUnits(minor, currency, CONVERSION_OPTS);
  return moneyToMajorNumber(m, CONVERSION_OPTS);
}

/**
 * Normalize a charge/capture/refund amount at the mock boundary.
 * Uses shared money primitives (strict precision; non-zero by default).
 */
function resolveChargeAmount(
  amount: AmountInput,
  currency: string,
): { major: number; minor: number; money: Money } {
  const m = normalizeAmountInput(amount, currency);
  return {
    money: m,
    major: moneyToMajorNumber(m),
    minor: minorAmountToNumber(toMinorUnits(m)),
  };
}

/**
 * Capture is valid on an open auth hold, incremental capture, or a
 * partially_refunded payment that still has uncaptured hold
 * (NEW-TESTKIT-2: refunding captured funds must not freeze remaining hold).
 * Remaining-amount checks still reject fully captured ledgers.
 */
function isCapturableMockStatus(status: GatewayPaymentStatus): boolean {
  return (
    status === "authorized" || status === "partially_captured" || status === "partially_refunded"
  );
}

/**
 * Identity fields that must participate in createPayment idempotency.
 * Different order / payment-method / source + same key → fingerprint_conflict
 * (NEW-TESTKIT-1). Token/source ids only — never PAN/CVC/dpan leaves.
 * Includes stripeCustomerId / paymobIntegrationId / paymobPaymentMethods
 * (NEW-TESTKIT-7) plus stripeSetupFutureUsage / paymobIframeId
 * (NEW-TESTKIT-FP-1).
 */
function createPaymentIdentityFields(params: CreatePaymentParams): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  if (params.orderId !== undefined) identity.orderId = params.orderId;
  if (params.customerId !== undefined) identity.customerId = params.customerId;
  if (params.paymentMethodId !== undefined) {
    identity.paymentMethodId = params.paymentMethodId;
  }
  if (params.offSession !== undefined) identity.offSession = params.offSession;
  const bag = params as unknown as Record<string, unknown>;
  if (bag.stripePaymentMethodId !== undefined) {
    identity.stripePaymentMethodId = bag.stripePaymentMethodId;
  }
  if (bag.stripeCustomerId !== undefined) {
    identity.stripeCustomerId = bag.stripeCustomerId;
  }
  if (bag.stripeSetupFutureUsage !== undefined) {
    identity.stripeSetupFutureUsage = bag.stripeSetupFutureUsage;
  }
  if (bag.tokenId !== undefined) identity.tokenId = bag.tokenId;
  if (bag.paymobIntegrationId !== undefined) {
    identity.paymobIntegrationId = bag.paymobIntegrationId;
  }
  if (bag.paymobPaymentMethods !== undefined) {
    identity.paymobPaymentMethods = bag.paymobPaymentMethods;
  }
  if (bag.paymobIframeId !== undefined) {
    identity.paymobIframeId = bag.paymobIframeId;
  }
  if (bag.moyasarSource !== undefined) {
    const source = bag.moyasarSource;
    if (typeof source === "object" && source !== null) {
      const srcBag = source as unknown as Record<string, unknown>;
      const src: Record<string, unknown> = {};
      if (srcBag.type !== undefined) src.type = srcBag.type;
      if (typeof srcBag.token === "string") src.token = srcBag.token;
      if (typeof srcBag.tokenId === "string") src.tokenId = srcBag.tokenId;
      if (typeof srcBag.mobile === "string") src.mobile = srcBag.mobile;
      identity.moyasarSource = src;
    } else {
      identity.moyasarSource = source;
    }
  }
  return identity;
}

/**
 * Convert a capture/refund major using the **payment** currency (TESTKIT-2).
 * Caller currency (or a Money leaf) that disagrees is rejected — same posture
 * as Stripe / Paymob / Moyasar. Never scale with the caller's exponent.
 */
function resolveMutationMinor(
  operation: "capturePayment" | "refundPayment",
  amount: AmountInput,
  callerCurrency: string | undefined,
  paymentCurrency: string,
): number {
  const expected = paymentCurrency.toUpperCase();
  if (callerCurrency !== undefined && callerCurrency.toUpperCase() !== expected) {
    throw new InvalidRequestError(
      `Mock ${operation} currency ${callerCurrency.toUpperCase()} does not match payment currency ${expected}`,
    );
  }
  if (isMoney(amount) && amount.currency.toUpperCase() !== expected) {
    throw new InvalidRequestError(
      `Mock ${operation} currency ${amount.currency.toUpperCase()} does not match payment currency ${expected}`,
    );
  }
  return resolveChargeAmount(amount, expected).minor;
}

export type MockGatewayOptions = {
  name?: string;
  capabilities?: GatewayCapabilities | Partial<Record<GatewayCapabilityKey, boolean>>;
  /** Queue of outcomes for createPayment (FIFO). Default: always succeeded. */
  createPayment?: ScriptedPaymentOutcome[];
  capturePayment?: ScriptedPaymentOutcome[];
  refundPayment?: ScriptedRefundOutcome[];
  voidPayment?: ScriptedPaymentOutcome[];
  getPayment?: ScriptedPaymentOutcome[];
  createCheckoutSession?: ScriptedPaymentOutcome[];
  getCheckoutSession?: ScriptedPaymentOutcome[];
  createCustomer?: ScriptedPaymentOutcome[];
  getCustomer?: ScriptedPaymentOutcome[];
  attachPaymentMethod?: ScriptedPaymentOutcome[];
  listPaymentMethods?: ScriptedPaymentOutcome[];
  detachPaymentMethod?: ScriptedPaymentOutcome[];
  getDispute?: ScriptedPaymentOutcome[];
  listDisputes?: ScriptedPaymentOutcome[];
  submitDisputeEvidence?: ScriptedPaymentOutcome[];
  createPaymentLink?: ScriptedPaymentOutcome[];
  getPaymentLink?: ScriptedPaymentOutcome[];
  deactivatePaymentLink?: ScriptedPaymentOutcome[];
  /**
   * Outcome used when a queue is empty and no last step was consumed.
   * When omitted, empty queues fall back to last-step replay or synthetic success.
   */
  defaultOutcome?: ScriptedPaymentOutcome;
  /** Shared secret for mock webhook signatures (test-only placeholder). */
  webhookSecret?: string;
  /** Default latency for operations without per-outcome latencyMs/delayMs. */
  defaultLatencyMs?: number;
  /**
   * Injectable clock. When a FakeClock is provided, delays advance the clock
   * virtually (no real wait) for deterministic tests; timestamps use the clock.
   */
  clock?: Clock | FakeClock;
  /**
   * When true, operations honor AbortSignal on params if present via
   * testkit extension `signal` (for cancellation tests). Default true.
   */
  respectAbort?: boolean;
  /**
   * Optional logger (wrapped with {@link createRedactingLogger}).
   * Used by conformance `logging_redaction` and app tests.
   */
  logger?: Logger;
  /**
   * When true (default), same `idempotencyKey` on createPayment returns the
   * same gatewayId without double-charging (process-local map only).
   */
  honorIdempotencyKey?: boolean;
};

/**
 * In-memory ledger. Amounts are tracked as integer **minor** units for
 * capture/refund remaining math (no float epsilon). {@link getPaymentState}
 * still exposes major-unit numbers for test inspection / conformance.
 */
type PaymentStateInternal = {
  amountMinor: number;
  currency: string;
  status: GatewayPaymentStatus;
  capturedAmountMinor: number;
  refundedAmountMinor: number;
  authorized: boolean;
};

/** Public ledger snapshot (major units) returned by {@link MockGateway.getPaymentState}. */
export type PaymentState = {
  amount: number;
  currency: string;
  status: GatewayPaymentStatus;
  capturedAmount: number;
  refundedAmount: number;
  authorized: boolean;
};

function toPublicPaymentState(state: PaymentStateInternal): PaymentState {
  return {
    amount: minorToMajor(state.amountMinor, state.currency),
    currency: state.currency,
    status: state.status,
    capturedAmount: minorToMajor(state.capturedAmountMinor, state.currency),
    refundedAmount: minorToMajor(state.refundedAmountMinor, state.currency),
    authorized: state.authorized,
  };
}

export type MockGateway = PaymentGateway & {
  /**
   * Frozen snapshot of recorded operations (redacted params/results).
   * Each read is a new copy; mutating it does not affect the mock ledger.
   */
  readonly history: readonly MockRequestRecord[];
  /** Same as {@link history}: frozen snapshot of the request ledger. */
  getHistory(): readonly MockRequestRecord[];
  /** Clear request history. */
  clearHistory(): void;
  /**
   * Assert history contains expected operations in order (partial match).
   * Throws Error with detail when mismatch.
   */
  assertHistory(expected: HistoryAssertion[]): void;
  /** Remaining scripted outcomes per operation (queued only, not last-step). */
  remainingOutcomes(): Record<string, number>;
  /** Push additional outcomes at runtime. */
  enqueue(
    operation:
      | "createPayment"
      | "capturePayment"
      | "refundPayment"
      | "voidPayment"
      | "getPayment"
      | "createCheckoutSession"
      | "getCheckoutSession"
      | "createCustomer"
      | "getCustomer"
      | "attachPaymentMethod"
      | "listPaymentMethods"
      | "detachPaymentMethod"
      | "getDispute"
      | "listDisputes"
      | "submitDisputeEvidence"
      | "createPaymentLink"
      | "getPaymentLink"
      | "deactivatePaymentLink",
    outcome: ScriptedPaymentOutcome | ScriptedRefundOutcome,
  ): void;
  /**
   * Dual-outcome: provider recorded success but client sees timeout/NetworkError.
   * Returns the provider-side result for reconciliation tests.
   */
  getLastProviderSideSuccess(): GatewayPaymentResult | undefined;
  /** Build a signed mock webhook payload. */
  buildWebhook(
    overrides?: Partial<MockWebhookPayload>,
    signOptions?: SignMockWebhookOptions,
  ): MockWebhookPayload;
  /** signWebhook(payload, secret?) → signature string */
  signWebhook(payload: unknown, secret?: string): string;
  /** generateWebhookEvent helper bound to this mock name/secret. */
  generateWebhookEvent: typeof generateWebhookEvent;
  generateDuplicateWebhooks: typeof generateDuplicateWebhooks;
  generateOutOfOrderWebhooks: typeof generateOutOfOrderWebhooks;
  /** Duplicate + out-of-order helpers (legacy names). */
  webhookHelpers: {
    withDuplicate: typeof withDuplicateWebhook;
    outOfOrder: typeof outOfOrderWebhooks;
    sign: typeof signMockWebhook;
    computeSignature: typeof computeMockWebhookSignature;
    signWebhook: typeof signWebhook;
    generateWebhookEvent: typeof generateWebhookEvent;
    generateDuplicateWebhooks: typeof generateDuplicateWebhooks;
    generateOutOfOrderWebhooks: typeof generateOutOfOrderWebhooks;
  };
  /** In-memory payment ledger (test inspection). */
  getPaymentState(gatewayPaymentId: string): PaymentState | undefined;
  /** Replace logger at runtime (always redacting). */
  setLogger(logger: Logger): void;
};

function asCapabilities(
  input?: GatewayCapabilities | Partial<Record<GatewayCapabilityKey, boolean>>,
): GatewayCapabilities {
  if (!input) {
    return freezeCapabilities(
      defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
        hostedCheckout: false,
      }),
    );
  }
  if (
    typeof (input as GatewayCapabilities).payments === "boolean" &&
    Object.keys(input).length >= 15
  ) {
    return freezeCapabilities(input as GatewayCapabilities);
  }
  return freezeCapabilities(defineGatewayCapabilities(input));
}

function isFakeClock(clock: Clock | FakeClock | undefined): clock is FakeClock {
  return (
    !!clock &&
    typeof (clock as FakeClock).advance === "function" &&
    typeof (clock as FakeClock).set === "function"
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NetworkError("Request aborted", signal.reason));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new NetworkError("Request aborted", signal?.reason));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isThrowStep(
  step: ScriptedPaymentOutcome | ScriptedRefundOutcome | undefined,
): step is ScriptedThrowStep {
  return !!step && "throw" in step && step.throw !== undefined;
}

/**
 * getPayment scripted arms that are retrieve faults, not money settlement.
 * `succeeded` is intentionally excluded so it cannot rewrite a ledger snapshot
 * to paid (NEW-TESTKIT-3).
 */
function isGetPaymentScriptedFault(
  step: ScriptedPaymentOutcome | undefined,
): step is ScriptedPaymentOutcome {
  if (!step) return false;
  if (isThrowStep(step)) return true;
  const o = step.outcome;
  return (
    o === "custom" ||
    o === "declined" ||
    o === "insufficient_funds" ||
    o === "network_error" ||
    o === "timeout" ||
    o === "gateway_api_error" ||
    o === "indeterminate" ||
    o === "failed" ||
    o === "provider_ok_client_timeout" ||
    o === "provider_success_client_timeout"
  );
}

/**
 * History error summary: name + optional code only.
 * Never stores raw Error.message / stacks (may carry tokens or card fragments).
 */
function errorSummary(err: unknown): MockRequestRecord["error"] {
  if (err instanceof Error) {
    const code =
      "code" in err && typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : undefined;
    return code
      ? { name: err.name, message: "[REDACTED]", code }
      : { name: err.name, message: "[REDACTED]" };
  }
  return { name: "Error", message: "[REDACTED]" };
}

/**
 * True when a resolved gateway result should settle the mock money ledger.
 *
 * TESTKIT-3: do **not** settle on bare `outcome === "succeeded"` — auth holds,
 * voids, and partial captures also use succeeded while money semantics differ.
 * Non-success Phase 6 outcomes never mutate captured/refunded/void state.
 * Domain status decides: paid / partially_captured (capture), cancelled (void),
 * authorized (auth hold), refunded / partially_refunded. Prefer `isPaidOutcome`
 * for fulfillment assertions; this helper only gates mock ledger mutations.
 */
function isLedgerSettlingResult(result: GatewayPaymentResult): boolean {
  if (
    result.outcome === "failed" ||
    result.outcome === "indeterminate" ||
    result.outcome === "declined"
  ) {
    return false;
  }
  // Domain status — never pending/processing from success:true or outcome alone.
  // CORE-1 remaps `partially_captured` to outcome `requires_action` (open money,
  // not fulfillment). The capture still applied; skip only failed/indeterminate/
  // declined so scripted 3DS create (`requires_action` + pending) stays uncaptured.
  return (
    result.status === "paid" ||
    result.status === "partially_captured" ||
    result.status === "cancelled" ||
    result.status === "authorized" ||
    result.status === "refunded" ||
    result.status === "partially_refunded"
  );
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (typeof expected !== "object" || expected === null) {
    return Object.is(actual, expected);
  }
  if (typeof actual !== "object" || actual === null) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((item, i) => partialMatch(actual[i], item));
  }
  const exp = expected as Record<string, unknown>;
  const act = actual as Record<string, unknown>;
  for (const key of Object.keys(exp)) {
    if (!partialMatch(act[key], exp[key])) return false;
  }
  return true;
}

/**
 * Create a scriptable mock gateway implementing PaymentGateway.
 */
export function mockGateway(options: MockGatewayOptions = {}): MockGateway {
  const name = options.name ?? "mock";
  const capabilities = asCapabilities(options.capabilities);
  const webhookSecret = options.webhookSecret ?? DEFAULT_MOCK_WEBHOOK_SECRET;
  const defaultLatencyMs = options.defaultLatencyMs ?? 0;
  const clock = options.clock;
  const defaultOutcome = options.defaultOutcome;
  let logger: Logger = createRedactingLogger(options.logger ?? noopLogger);

  const queues = {
    createPayment: [...(options.createPayment ?? [])] as ScriptedPaymentOutcome[],
    capturePayment: [...(options.capturePayment ?? [])] as ScriptedPaymentOutcome[],
    refundPayment: [...(options.refundPayment ?? [])] as ScriptedRefundOutcome[],
    voidPayment: [...(options.voidPayment ?? [])] as ScriptedPaymentOutcome[],
    getPayment: [...(options.getPayment ?? [])] as ScriptedPaymentOutcome[],
    createCheckoutSession: [...(options.createCheckoutSession ?? [])] as ScriptedPaymentOutcome[],
    getCheckoutSession: [...(options.getCheckoutSession ?? [])] as ScriptedPaymentOutcome[],
    createCustomer: [...(options.createCustomer ?? [])] as ScriptedPaymentOutcome[],
    getCustomer: [...(options.getCustomer ?? [])] as ScriptedPaymentOutcome[],
    attachPaymentMethod: [...(options.attachPaymentMethod ?? [])] as ScriptedPaymentOutcome[],
    listPaymentMethods: [...(options.listPaymentMethods ?? [])] as ScriptedPaymentOutcome[],
    detachPaymentMethod: [...(options.detachPaymentMethod ?? [])] as ScriptedPaymentOutcome[],
    getDispute: [...(options.getDispute ?? [])] as ScriptedPaymentOutcome[],
    listDisputes: [...(options.listDisputes ?? [])] as ScriptedPaymentOutcome[],
    submitDisputeEvidence: [...(options.submitDisputeEvidence ?? [])] as ScriptedPaymentOutcome[],
    createPaymentLink: [...(options.createPaymentLink ?? [])] as ScriptedPaymentOutcome[],
    getPaymentLink: [...(options.getPaymentLink ?? [])] as ScriptedPaymentOutcome[],
    deactivatePaymentLink: [...(options.deactivatePaymentLink ?? [])] as ScriptedPaymentOutcome[],
  };

  const lastStep: {
    createPayment?: ScriptedPaymentOutcome;
    capturePayment?: ScriptedPaymentOutcome;
    refundPayment?: ScriptedRefundOutcome;
    voidPayment?: ScriptedPaymentOutcome;
    getPayment?: ScriptedPaymentOutcome;
    createCheckoutSession?: ScriptedPaymentOutcome;
    getCheckoutSession?: ScriptedPaymentOutcome;
    createCustomer?: ScriptedPaymentOutcome;
    getCustomer?: ScriptedPaymentOutcome;
    attachPaymentMethod?: ScriptedPaymentOutcome;
    listPaymentMethods?: ScriptedPaymentOutcome;
    detachPaymentMethod?: ScriptedPaymentOutcome;
    getDispute?: ScriptedPaymentOutcome;
    listDisputes?: ScriptedPaymentOutcome;
    submitDisputeEvidence?: ScriptedPaymentOutcome;
    createPaymentLink?: ScriptedPaymentOutcome;
    getPaymentLink?: ScriptedPaymentOutcome;
    deactivatePaymentLink?: ScriptedPaymentOutcome;
  } = {};

  const history: MockRequestRecord[] = [];
  const payments = new Map<string, PaymentStateInternal>();
  const customers = new Map<string, Customer>();
  /**
   * Idempotency key → completed createPayment result + request fingerprint
   * (process-local). Includes provider-side dual-timeout successes so retries
   * never double-charge. Same key + different params → fingerprint_conflict
   * (TESTKIT-1; mirrors lease-aware store semantics).
   */
  const idempotencyResults = new Map<
    string,
    { result: GatewayPaymentResult; fingerprint: string }
  >();
  /**
   * In-flight createPayment promises by idempotency key (+ fingerprint of the
   * first waiter so concurrent same-key / different-params fail closed).
   */
  const idempotencyInflight = new Map<
    string,
    { promise: Promise<GatewayPaymentResult>; fingerprint: string }
  >();
  /**
   * Per-payment serialization chain for capture / refund / void ledger mutations.
   * Without this, concurrent Promise.all partial captures/refunds race on
   * remaining/refunded minors and can over-capture or over-refund.
   */
  const paymentLedgerChains = new Map<string, Promise<unknown>>();
  let seq = 0;
  let lastProviderSideSuccess: GatewayPaymentResult | undefined;
  const honorIdempotencyKey = options.honorIdempotencyKey !== false;

  const nowMs = () => (clock ? clock.nowMs() : Date.now());

  function nextId(prefix: string): string {
    seq += 1;
    return `${prefix}_${name}_${seq}`;
  }

  /**
   * Fingerprint charge-identity params for createPayment idempotency.
   * Uses resolved integer **minor** units (not raw major number / Money shape)
   * so economically identical amounts collide; capture/callback/metadata still
   * participate. Includes orderId + provider PM/source ids (NEW-TESTKIT-1).
   * Omits idempotencyKey / AbortSignal.
   */
  function createPaymentFingerprint(
    params: CreatePaymentParams,
    resolved: { minor: number },
  ): string {
    return fingerprintParams({
      amountMinor: resolved.minor,
      currency: params.currency.toUpperCase(),
      capture: params.capture !== false,
      callbackUrl: params.callbackUrl,
      ...createPaymentIdentityFields(params),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
    });
  }

  function fingerprintConflictError(idemKey: string): InvalidRequestError {
    return new InvalidRequestError(
      `createPayment idempotency fingerprint_conflict for key ${idemKey} (mock): same key with different amount/params`,
    );
  }

  function cacheIdempotentResult(
    idemKey: string,
    fingerprint: string,
    result: GatewayPaymentResult,
  ): void {
    idempotencyResults.set(idemKey, {
      fingerprint,
      result: { ...result },
    });
  }

  /**
   * Serialize money-mutating ops for one gateway payment id (capture/refund/void).
   * Chains settle independently of success/failure so a rejected op never
   * deadlocks subsequent work on the same payment.
   */
  function withPaymentLedgerLock<T>(paymentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = paymentLedgerChains.get(paymentId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    paymentLedgerChains.set(
      paymentId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  function takePaymentStep(
    op: keyof typeof lastStep & keyof typeof queues,
  ): ScriptedPaymentOutcome | undefined {
    const q = queues[op] as ScriptedPaymentOutcome[];
    if (q.length > 0) {
      const step = q.shift()!;
      lastStep[op] = step as never;
      return step;
    }
    if (defaultOutcome) return defaultOutcome;
    return lastStep[op] as ScriptedPaymentOutcome | undefined;
  }

  function takeRefundStep(): ScriptedRefundOutcome | undefined {
    if (queues.refundPayment.length > 0) {
      const step = queues.refundPayment.shift()!;
      lastStep.refundPayment = step;
      return step;
    }
    if (defaultOutcome && isThrowStep(defaultOutcome)) {
      return defaultOutcome;
    }
    if (defaultOutcome && !isThrowStep(defaultOutcome)) {
      // Map payment default outcomes that are valid for refund scripting
      const o = defaultOutcome.outcome;
      const refundable = new Set([
        "succeeded",
        "network_error",
        "timeout",
        "gateway_api_error",
        "indeterminate",
        "failed",
        "custom",
        "provider_ok_client_timeout",
        "provider_success_client_timeout",
      ]);
      if (typeof o === "string" && refundable.has(o)) {
        return defaultOutcome as ScriptedRefundOutcome;
      }
    }
    return lastStep.refundPayment;
  }

  async function applyLatency(
    step: { latencyMs?: number; delayMs?: number; respectAbort?: boolean } | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const ms = stepDelayMs(step, defaultLatencyMs);
    const respect = step?.respectAbort ?? options.respectAbort ?? true;
    const effectiveSignal = respect ? signal : undefined;

    if (ms <= 0) {
      if (effectiveSignal?.aborted) {
        throw new NetworkError("Request aborted", effectiveSignal.reason);
      }
      return;
    }

    if (isFakeClock(clock)) {
      if (effectiveSignal?.aborted) {
        throw new NetworkError("Request aborted", effectiveSignal.reason);
      }
      clock.advance(ms);
      // Yield so abort listeners scheduled against this turn (or queued
      // before the call) can fire after virtual time advances.
      await Promise.resolve();
      if (effectiveSignal?.aborted) {
        throw new NetworkError("Request aborted", effectiveSignal.reason);
      }
      return;
    }

    await sleep(ms, effectiveSignal);
  }

  function getSignal(params: unknown): AbortSignal | undefined {
    if (params && typeof params === "object" && "signal" in params) {
      const s = (params as { signal?: unknown }).signal;
      if (s instanceof AbortSignal) return s;
    }
    return undefined;
  }

  async function track<T>(
    operation: MockRequestRecord["operation"],
    params: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const redactedParams = redact(params);
    try {
      const result = await fn();
      const rec: MockRequestRecord = {
        operation,
        params: redactedParams,
        result: redact(result),
        atMs: nowMs(),
      };
      history.push(rec);
      logger.debug(`mock.${operation}`, {
        operation,
        result: rec.result as Record<string, unknown> | undefined,
      });
      return result;
    } catch (err) {
      const summary = errorSummary(err);
      const rec: MockRequestRecord = {
        operation,
        params: redactedParams,
        atMs: nowMs(),
      };
      if (summary) rec.error = summary;
      history.push(rec);
      logger.debug(`mock.${operation}.error`, {
        operation,
        error: summary as unknown as Record<string, unknown>,
      });
      throw err;
    }
  }

  function handleThrowStep(step: ScriptedThrowStep): never {
    if (step.throw === "abort") {
      throw new NetworkError("Request aborted (scripted)");
    }
    throw step.throw;
  }

  /**
   * Phase 22 ops honor the same throw/timeout/network_error arms as createPayment.
   * Do not fall through to a silent succeeded snapshot.
   */
  function throwIfScriptedFault(step: ScriptedPaymentOutcome | undefined): void {
    if (!step) return;
    if (isThrowStep(step)) {
      handleThrowStep(step);
    }
    switch (step.outcome) {
      case "declined":
        throw new CardDeclinedError(step.message ?? "Card declined (mock)");
      case "insufficient_funds":
        throw new InsufficientFundsError(step.message ?? "Insufficient funds (mock)");
      case "network_error":
        throw new NetworkError(step.message ?? "Network error (mock)");
      case "timeout":
        throw new NetworkError(step.message ?? "Request timed out (mock)");
      case "gateway_api_error":
        throw new GatewayApiError(step.message ?? "Gateway API error (mock)", name);
      case "custom":
        if (step.error) throw step.error;
        return;
      case "provider_ok_client_timeout":
      case "provider_success_client_timeout":
        throw new NetworkError(
          step.message ??
            "Client timeout after provider-side success (mock; reconcile via getLastProviderSideSuccess)",
        );
      default:
        return;
    }
  }

  function isScriptedFailed(
    step: ScriptedPaymentOutcome | undefined,
  ): step is Exclude<ScriptedPaymentOutcome, ScriptedThrowStep> & { outcome: "failed" } {
    return !!step && !isThrowStep(step) && step.outcome === "failed";
  }

  function isScriptedIndeterminate(
    step: ScriptedPaymentOutcome | undefined,
  ): step is Exclude<ScriptedPaymentOutcome, ScriptedThrowStep> & {
    outcome: "indeterminate";
  } {
    return !!step && !isThrowStep(step) && step.outcome === "indeterminate";
  }

  function scriptedFailedError(
    step: Exclude<ScriptedPaymentOutcome, ScriptedThrowStep> & { outcome: "failed" },
    fallback: string,
  ): { name: string; message: string; code: string } {
    return {
      name: "Error",
      message: step.message ?? fallback,
      code: "FAILED",
    };
  }

  async function consumePhase22Step(
    op: Exclude<keyof typeof lastStep, "refundPayment">,
    params: unknown,
  ): Promise<ScriptedPaymentOutcome | undefined> {
    const step = takePaymentStep(op);
    await applyLatency(step, getSignal(params));
    throwIfScriptedFault(step);
    return step;
  }

  function paramLookup(params: unknown, keys: readonly string[]): string {
    if (params === null || typeof params !== "object") {
      return "unknown";
    }
    const record = params as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    return "unknown";
  }

  function unknownRefs(lookupId: string) {
    return buildProviderReferences({
      gateway: name,
      gatewayId: lookupId,
      status: "unknown",
      providerNativeStatus: "indeterminate",
      ...(lookupId !== "unknown" ? { internalReference: lookupId } : {}),
    });
  }

  /**
   * Dual-write Phase 6 `outcome` + `references` (+ reconciliationRequired)
   * onto a gateway result while preserving legacy flat fields.
   */
  function withPhase6Outcome(
    result: GatewayPaymentResult,
    outcome: PaymentOperationOutcome,
    extras?: {
      decline?: NonNullable<GatewayPaymentResult["decline"]>;
      message?: string;
      action?: NonNullable<GatewayPaymentResult["nextAction"]>;
      reconciliationRequired?: boolean;
    },
  ): GatewayPaymentResult {
    const base: Parameters<typeof applyOutcomeToGatewayResult>[0] = {
      gatewayId: result.gatewayId,
      status: result.status,
      rawResponse: result.rawResponse,
      gateway: name,
      redirectUrl: result.redirectUrl,
    };
    if (result.gatewayObjectId !== undefined) {
      base.gatewayObjectId = result.gatewayObjectId;
    }
    if (result.orderId !== undefined) base.orderId = result.orderId;
    if (result.captureId !== undefined) base.captureId = result.captureId;
    if (result.authorizationId !== undefined) {
      base.authorizationId = result.authorizationId;
    }
    if (result.amount !== undefined) base.amount = result.amount;
    // Always publish currency with major-unit amount fields (incomplete-money fail-closed).
    if (result.currency !== undefined) base.currency = result.currency;
    if (result.fee !== undefined) base.fee = result.fee;
    if (result.capturedAmount !== undefined) {
      base.capturedAmount = result.capturedAmount;
    }
    if (result.refundedAmount !== undefined) {
      base.refundedAmount = result.refundedAmount;
    }
    if (result.clientSecret !== undefined) {
      base.clientSecret = result.clientSecret;
    }
    if (result.nextAction !== undefined) base.nextAction = result.nextAction;
    // Always rebuild references from current status/ids so a paid fallback
    // spread cannot leave stale normalizedStatus after outcome remapping.
    if (result.decline !== undefined) base.decline = result.decline;
    if (result.providerRequestId !== undefined) {
      base.providerRequestId = result.providerRequestId;
    }
    return applyOutcomeToGatewayResult(base, outcome, extras);
  }

  function applyResultOverrides(
    base: GatewayPaymentResult,
    step: ScriptedPaymentOutcome | undefined,
  ): GatewayPaymentResult {
    if (!step || isThrowStep(step)) return base;
    let next = { ...base };
    if (step.amount !== undefined) next.amount = step.amount;
    if (step.status !== undefined) next.status = step.status;
    if ("result" in step && step.result) {
      next = { ...next, ...step.result };
    }
    // Currency must travel with major-unit amount fields.
    if (
      next.currency === undefined &&
      base.currency !== undefined &&
      (next.amount !== undefined ||
        next.capturedAmount !== undefined ||
        next.refundedAmount !== undefined ||
        next.fee !== undefined)
    ) {
      next.currency = base.currency;
    }
    // TESTKIT-1: re-seal Phase 6 identity after merges. Status overrides must
    // not leave a stale outcome/references dual-write (e.g. status failed with
    // leftover outcome succeeded). Explicit step.result.outcome wins.
    const statusOverridden =
      (step.status !== undefined && step.status !== base.status) ||
      ("result" in step && step.result?.status !== undefined && step.result.status !== base.status);
    const outcomeExplicit =
      "result" in step && step.result?.outcome !== undefined ? step.result.outcome : undefined;
    const sealedOutcome =
      outcomeExplicit ??
      (statusOverridden
        ? paymentStatusToOperationOutcome(next.status)
        : (next.outcome ?? paymentStatusToOperationOutcome(next.status)));
    const sealed = withPhase6Outcome(
      next,
      sealedOutcome,
      next.reconciliationRequired === true ? { reconciliationRequired: true } : undefined,
    );
    if (next.reconciliationRequired === true) {
      sealed.reconciliationRequired = true;
    }
    if (next.decline !== undefined) {
      sealed.decline = next.decline;
    }
    return sealed;
  }

  function ensurePaymentLedger(
    id: string,
    params: { amount: AmountInput; currency: string },
    result: GatewayPaymentResult,
    resolved?: { major: number; minor: number },
  ): void {
    if (!result.gatewayId) return;
    const key = result.gatewayId;
    const currency = params.currency;
    if (payments.has(key)) {
      const state = payments.get(key)!;
      state.status = result.status;
      if (result.capturedAmount !== undefined) {
        // TESTKIT-4: clamp scripted captured to charge total
        state.capturedAmountMinor = Math.max(
          0,
          Math.min(majorToMinor(result.capturedAmount, currency), state.amountMinor),
        );
      }
      if (result.refundedAmount !== undefined) {
        // TESTKIT-4: clamp scripted refunded to captured total
        state.refundedAmountMinor = Math.max(
          0,
          Math.min(majorToMinor(result.refundedAmount, currency), state.capturedAmountMinor),
        );
      }
      return;
    }
    const amountMinor =
      resolved?.minor ??
      (result.amount !== undefined
        ? majorToMinor(result.amount, currency)
        : majorToMinor(params.amount as number | Money, currency));
    // Only paid settles full capture by default. partially_captured without an
    // explicit capturedAmount fails closed to 0 (incomplete money snapshot).
    // pending / requires_action / authorized / processing / failed → 0 capture
    // even when deprecated success:true (API-ok is not money settled).
    let capturedMinor: number;
    if (result.capturedAmount !== undefined) {
      capturedMinor = majorToMinor(result.capturedAmount, currency);
    } else if (isPaidLikePaymentStatus(result.status)) {
      capturedMinor = amountMinor;
    } else {
      capturedMinor = 0;
    }
    // TESTKIT-4: never let scripted captured/refunded exceed charge / captured.
    capturedMinor = Math.max(0, Math.min(capturedMinor, amountMinor));
    let refundedMinor =
      result.refundedAmount !== undefined ? majorToMinor(result.refundedAmount, currency) : 0;
    refundedMinor = Math.max(0, Math.min(refundedMinor, capturedMinor));
    payments.set(key, {
      amountMinor,
      currency,
      status: result.status,
      capturedAmountMinor: capturedMinor,
      refundedAmountMinor: refundedMinor,
      authorized: result.status === "authorized",
    });
    // Also map generated id if different
    if (id !== key && !payments.has(id)) {
      payments.set(id, payments.get(key)!);
    }
  }

  async function resolvePaymentOutcome(
    outcome: ScriptedPaymentOutcome | undefined,
    fallback: () => GatewayPaymentResult,
    signal?: AbortSignal,
    ledgerOnProviderSuccess?: (result: GatewayPaymentResult) => void,
  ): Promise<GatewayPaymentResult> {
    await applyLatency(outcome, signal);

    if (!outcome) {
      return fallback();
    }

    if (isThrowStep(outcome)) {
      handleThrowStep(outcome);
    }

    if (outcome.outcome === "custom") {
      if (outcome.error) throw outcome.error;
      if (outcome.result) return outcome.result;
      return fallback();
    }

    const dualTimeout =
      outcome.outcome === "provider_ok_client_timeout" ||
      outcome.outcome === "provider_success_client_timeout";

    switch (outcome.outcome) {
      case "declined":
        throw new CardDeclinedError(outcome.message ?? "Card declined (mock)");
      case "insufficient_funds":
        throw new InsufficientFundsError(outcome.message ?? "Insufficient funds (mock)");
      case "network_error":
        throw new NetworkError(outcome.message ?? "Network error (mock)");
      case "timeout":
        // Transport-level indeterminate: never map to definitive failure at provider
        throw new NetworkError(outcome.message ?? "Request timed out (mock)");
      case "gateway_api_error":
        throw new GatewayApiError(outcome.message ?? "Gateway API error (mock)", name);
      case "provider_ok_client_timeout":
      case "provider_success_client_timeout": {
        // Provider ledger settles success; client still times out.
        // Auth-only creates (fallback status authorized) stay authorized —
        // do not force a full paid capture (TESTKIT-2).
        const fb = fallback();
        const providerStatus: GatewayPaymentStatus = fb.status === "authorized" ? "authorized" : "paid";
        const providerBase = { ...fb, status: providerStatus };
        const providerResult = applyResultOverrides(
          withPhase6Outcome(providerBase, "succeeded"),
          outcome,
        );
        lastProviderSideSuccess = providerResult;
        ledgerOnProviderSuccess?.(providerResult);
        throw new NetworkError(
          outcome.message ??
            "Client timeout after provider-side success (mock; reconcile via getLastProviderSideSuccess)",
        );
      }
      case "indeterminate": {
        // Explicit Phase 6 arm — never looks like a card decline or paid.
        const base = fallback();
        const status = outcome.status ?? "processing";
        return applyResultOverrides(
          withPhase6Outcome(
            {
              ...base,
              status,
              rawResponse: {
                mock: true,
                status,
                error: {
                  code: "INDETERMINATE",
                  message:
                    outcome.message ??
                    "Payment outcome indeterminate (mock); reconciliation required",
                },
                reconciliationRequired: true,
              },
            },
            "indeterminate",
          ),
          outcome,
        );
      }
      case "failed":
        return applyResultOverrides(
          withPhase6Outcome({ ...fallback(), status: "failed" }, "failed"),
          outcome,
        );
      case "succeeded": {
        // NEW-TESTKIT-6: do not force paid. Auth-only create fallback is
        // authorized + capturedAmount 0; capture/void keep their fallback status.
        const fb = fallback();
        const succeeded: GatewayPaymentResult = { ...fb };
        if (succeeded.status === "authorized" && succeeded.capturedAmount === undefined) {
          const cur = (succeeded.amount as Money | undefined)?.currency ?? (fb.amount as Money | undefined)?.currency ?? "USD";
          succeeded.capturedAmount = money("0", cur, CONVERSION_OPTS);
          if ((succeeded as unknown as Record<string, unknown>).currency === undefined && (fb as unknown as Record<string, unknown>).currency !== undefined) {
            (succeeded as unknown as Record<string, unknown>).currency = (fb as unknown as Record<string, unknown>).currency;
          }
        }
        return applyResultOverrides(withPhase6Outcome(succeeded, "succeeded"), outcome);
      }
      case "authorized":
        return applyResultOverrides(
          withPhase6Outcome({ ...fallback(), status: "authorized" }, "succeeded"),
          outcome,
        );
      case "requires_action": {
        const nextAction = {
          type: "redirect" as const,
          url: "https://mock.test/3ds",
        };
        return applyResultOverrides(
          withPhase6Outcome(
            {
              ...fallback(),
              status: "pending",
              redirectUrl: "https://mock.test/3ds",
              nextAction,
            },
            "requires_action",
            { action: nextAction },
          ),
          outcome,
        );
      }
      case "pending":
        return applyResultOverrides(
          withPhase6Outcome({ ...fallback(), status: "pending" }, "requires_action"),
          outcome,
        );
      case "processing":
        return applyResultOverrides(
          withPhase6Outcome({ ...fallback(), status: "processing" }, "requires_action"),
          outcome,
        );
      case "partial_capture":
        return applyResultOverrides(
          withPhase6Outcome({ ...fallback(), status: "partially_captured" }, "succeeded"),
          outcome,
        );
      case "voided":
        return applyResultOverrides(
          withPhase6Outcome({ ...fallback(), status: "cancelled" }, "succeeded"),
          outcome,
        );
      default: {
        // Exhaustiveness: dualTimeout already handled; seal fallback with Phase 6
        void dualTimeout;
        const fb = fallback();
        return withPhase6Outcome(fb, fb.outcome ?? paymentStatusToOperationOutcome(fb.status));
      }
    }
  }

  function signWebhookBound(payload: unknown, secret?: string): string {
    return signWebhook(payload, secret ?? webhookSecret);
  }

  function generateWebhookEventBound(
    opts: Parameters<typeof generateWebhookEvent>[0] = {},
  ): ReturnType<typeof generateWebhookEvent> {
    const args: Parameters<typeof generateWebhookEvent>[0] = {
      gateway: name,
      secret: webhookSecret,
      ...opts,
    };
    if (args.createdAt === undefined && clock) {
      args.createdAt = new Date(clock.nowMs()).toISOString();
    }
    return generateWebhookEvent(args);
  }

  const gateway: MockGateway = {
    name,
    capabilities,
    supports(capability: GatewayCapabilityKey): boolean {
      return capabilities[capability] === true;
    },

    setLogger(next: Logger) {
      logger = next && next !== noopLogger ? createRedactingLogger(next) : noopLogger;
    },

    get history() {
      // Snapshot + freeze so callers cannot mutate the internal ledger.
      return Object.freeze([...history]);
    },

    getHistory() {
      return Object.freeze([...history]);
    },

    clearHistory() {
      history.length = 0;
    },

    assertHistory(expected: HistoryAssertion[]) {
      let hi = 0;
      for (let i = 0; i < expected.length; i++) {
        const exp = expected[i]!;
        let found = false;
        while (hi < history.length) {
          const rec = history[hi]!;
          hi += 1;
          if (rec.operation !== exp.operation) continue;
          if (exp.params !== undefined && !partialMatch(rec.params, exp.params)) {
            continue;
          }
          if (exp.result !== undefined && !partialMatch(rec.result, exp.result)) {
            continue;
          }
          if (exp.error !== undefined) {
            if (exp.error === true) {
              if (!rec.error) continue;
            } else if (exp.error === false) {
              if (rec.error) continue;
            } else {
              if (!rec.error) continue;
              if (exp.error.name && rec.error.name !== exp.error.name) continue;
              if (exp.error.code && rec.error.code !== exp.error.code) continue;
            }
          }
          found = true;
          break;
        }
        if (!found) {
          throw new Error(
            `assertHistory: expected entry #${i} (${exp.operation}) not found in remaining history. ` +
              `History ops: [${history.map((h) => h.operation).join(", ")}]`,
          );
        }
      }
    },

    remainingOutcomes() {
      return {
        createPayment: queues.createPayment.length,
        capturePayment: queues.capturePayment.length,
        refundPayment: queues.refundPayment.length,
        voidPayment: queues.voidPayment.length,
        getPayment: queues.getPayment.length,
        createCheckoutSession: queues.createCheckoutSession.length,
        getCheckoutSession: queues.getCheckoutSession.length,
        createCustomer: queues.createCustomer.length,
        getCustomer: queues.getCustomer.length,
        attachPaymentMethod: queues.attachPaymentMethod.length,
        listPaymentMethods: queues.listPaymentMethods.length,
        detachPaymentMethod: queues.detachPaymentMethod.length,
        getDispute: queues.getDispute.length,
        listDisputes: queues.listDisputes.length,
        submitDisputeEvidence: queues.submitDisputeEvidence.length,
        createPaymentLink: queues.createPaymentLink.length,
        getPaymentLink: queues.getPaymentLink.length,
        deactivatePaymentLink: queues.deactivatePaymentLink.length,
      };
    },

    enqueue(operation, outcome) {
      (queues[operation] as unknown[]).push(outcome);
    },

    getLastProviderSideSuccess() {
      return lastProviderSideSuccess;
    },

    buildWebhook(overrides = {}, signOptions = {}) {
      const base: Partial<MockWebhookPayload> = { ...overrides };
      if (base.createdAt === undefined && clock) {
        base.createdAt = new Date(clock.nowMs()).toISOString();
      }
      const payload = createMockWebhookPayload(base);
      return signMockWebhook(payload, {
        secret: signOptions.secret ?? webhookSecret,
        ...signOptions,
      });
    },

    signWebhook(payload: unknown, secret?: string) {
      return signWebhookBound(payload, secret);
    },

    generateWebhookEvent(opts = {}) {
      return generateWebhookEventBound(opts);
    },

    generateDuplicateWebhooks,
    generateOutOfOrderWebhooks,

    webhookHelpers: {
      withDuplicate: withDuplicateWebhook,
      outOfOrder: outOfOrderWebhooks,
      sign: (payload, options = {}) =>
        signMockWebhook(payload, { secret: webhookSecret, ...options }),
      computeSignature: computeMockWebhookSignature,
      signWebhook: signWebhookBound,
      generateWebhookEvent: generateWebhookEventBound,
      generateDuplicateWebhooks,
      generateOutOfOrderWebhooks,
    },

    getPaymentState(id: string): PaymentState | undefined {
      const state = payments.get(id);
      return state ? toPublicPaymentState(state) : undefined;
    },

    async createPayment(params: CreatePaymentParams): Promise<GatewayPaymentResult> {
      return track("createPayment", params, async () => {
        if (!capabilities.payments) {
          throw new OperationNotSupportedError(name, "createPayment", {
            capability: "payments",
            claimedSupport: false,
          });
        }
        // NEW-TESTKIT-4: capture:false is authorization, not a silent paid create.
        if (params.capture === false && !capabilities.authorization) {
          throw new OperationNotSupportedError(name, "createPayment", {
            capability: "authorization",
            claimedSupport: false,
          });
        }

        const resolved = resolveChargeAmount(params.amount, params.currency);
        const major = resolved.major;
        const minor = resolved.minor;

        const idemKey =
          honorIdempotencyKey && params.idempotencyKey ? params.idempotencyKey : undefined;
        const requestFingerprint = idemKey
          ? createPaymentFingerprint(params, { minor })
          : undefined;

        // Process-local idempotency: same key + same fingerprint → same gatewayId
        // (no double-charge). Same key + different amount/params → conflict.
        if (idemKey && requestFingerprint && idempotencyResults.has(idemKey)) {
          const cached = idempotencyResults.get(idemKey)!;
          if (cached.fingerprint !== requestFingerprint) {
            throw fingerprintConflictError(idemKey);
          }
          logger.info("createPayment idempotent replay", {
            gatewayId: cached.result.gatewayId,
            idempotencyKey: idemKey,
          });
          return { ...cached.result };
        }

        // Join in-flight same-key work so concurrent Promise.all does not charge twice.
        if (idemKey && requestFingerprint) {
          const pending = idempotencyInflight.get(idemKey);
          if (pending) {
            if (pending.fingerprint !== requestFingerprint) {
              throw fingerprintConflictError(idemKey);
            }
            logger.info("createPayment idempotent join in-flight", {
              idempotencyKey: idemKey,
            });
            // TESTKIT-2: concurrent joiners must observe the same settlement as
            // the primary (including dual-timeout NetworkError). Do not convert
            // a rejection into cached provider success mid-flight — that trains
            // false concurrent symmetry. Sequential retry after the primary
            // settles hits the top-level idempotency cache instead.
            return { ...(await pending.promise) };
          }
        }

        const runCreate = async (): Promise<GatewayPaymentResult> => {
          const outcome = takePaymentStep("createPayment");
          const id = nextId("pay");
          const capture = params.capture !== false;
          const signal = getSignal(params);

          logger.info("createPayment", {
            amount: major,
            currency: params.currency,
            idempotencyKey: params.idempotencyKey,
            metadata: params.metadata,
          });

          /** Provider-side success under dual-timeout (client still throws). */
          let dualProviderResult: GatewayPaymentResult | undefined;

          try {
            // fallback builds result shape only — does NOT write paid/authorized ledger.
            // Success / processing / terminal failure write after resolve; dual-timeout
            // provider-side paid goes through ledgerOnProviderSuccess only.
            const currencyCode = params.currency.toUpperCase();
            const result = await resolvePaymentOutcome(
              outcome,
              () => {
                const status: GatewayPaymentStatus =
                  !capture && capabilities.authorization ? "authorized" : "paid";
                const base = defaultPaymentResult(id, status, major, name, currencyCode);
                return {
                  ...base,
                  ...(status === "authorized"
                    ? { capturedAmount: money("0", currencyCode, CONVERSION_OPTS) }
                    : {}),
                  rawResponse: {
                    mock: true,
                    amountMinor: minor,
                    currency: currencyCode,
                    exponent: getCurrencyExponent(params.currency),
                  },
                };
              },
              signal,
              (providerResult) => {
                // Dual-outcome: provider applied success even though client times out
                const pid = providerResult.gatewayId || id;
                const withId = !providerResult.gatewayId
                  ? { ...providerResult, gatewayId: pid }
                  : providerResult;
                dualProviderResult = withId;
                const dualMajor = withId.amount ?? major;
                const dualMinor = majorToMinor(dualMajor, params.currency);
                const dualStatus =
                  withId.status ?? (!capture && capabilities.authorization ? "authorized" : "paid");
                // TESTKIT-3: settle capture money from paid-domain status /
                // explicit capturedAmount — not bare outcome===succeeded.
                // Auth-only / non-paid → 0 capture. Partial without amount → 0.
                let dualCapturedMinor = 0;
                if (withId.capturedAmount !== undefined) {
                  dualCapturedMinor = Math.max(
                    0,
                    Math.min(majorToMinor(withId.capturedAmount, params.currency), dualMinor),
                  );
                } else if (isPaidLikePaymentStatus(dualStatus)) {
                  dualCapturedMinor = dualMinor;
                }
                payments.set(pid, {
                  amountMinor: dualMinor,
                  currency: params.currency,
                  status: dualStatus,
                  capturedAmountMinor: dualCapturedMinor,
                  refundedAmountMinor: 0,
                  authorized: dualStatus === "authorized",
                });
                // Cache before throw so sequential retries never double-charge
                if (idemKey && requestFingerprint && withId.gatewayId) {
                  cacheIdempotentResult(idemKey, requestFingerprint, withId);
                }
              },
            );

            // Prefer stable id from fallback when scripted result omitted gatewayId.
            // Always publish currency with major-unit amounts (incomplete-money fail-closed).
            const withId = !result.gatewayId ? { ...result, gatewayId: id } : result;
            const finalResult: GatewayPaymentResult =
              withId.currency === undefined &&
              (withId.amount !== undefined ||
                withId.capturedAmount !== undefined ||
                withId.refundedAmount !== undefined ||
                withId.fee !== undefined)
                ? { ...withId, currency: currencyCode }
                : withId;

            // NEW-TESTKIT-6: auth-only creates must publish capturedAmount 0
            // (currency travels with the major-unit field).
            const settledResult: GatewayPaymentResult =
              !capture &&
              capabilities.authorization &&
              finalResult.status === "authorized" &&
              finalResult.capturedAmount === undefined
                ? {
                    ...finalResult,
                    capturedAmount: money(
                      "0",
                      finalResult.amount?.currency ?? currencyCode,
                      CONVERSION_OPTS,
                    ),
                    ...(finalResult.currency === undefined ? { currency: currencyCode } : {}),
                  }
                : finalResult;

            if (isLedgerSettlingResult(settledResult)) {
              ensurePaymentLedger(id, params, settledResult, resolved);
            } else {
              // Honest ledger for non-settling outcomes — record amount/status
              // with zero money movement (never leave paid hanging, never claim capture).
              const key = finalResult.gatewayId || id;
              payments.set(key, {
                amountMinor: minor,
                currency: params.currency,
                status: finalResult.status,
                capturedAmountMinor: 0,
                refundedAmountMinor: 0,
                authorized: false,
              });
              if (id !== key && !payments.has(id)) {
                payments.set(id, payments.get(key)!);
              }
            }

            // Cache any resolved create with a gatewayId — including non-throw
            // indeterminate (success:false / reconciliationRequired). Skipping
            // that arm mints a second payment on same-key retry and trains a
            // false "safe retry after indeterminate".
            if (idemKey && requestFingerprint && settledResult.gatewayId) {
              cacheIdempotentResult(idemKey, requestFingerprint, settledResult);
            }
            return settledResult;
          } catch (err) {
            // Dual-timeout: cache already set in ledger callback; rethrow client error.
            // Plain timeout/network without provider success: no cache (indeterminate).
            void dualProviderResult;
            throw err;
          }
        };

        if (!idemKey || !requestFingerprint) {
          return runCreate();
        }

        const inflight = runCreate().finally(() => {
          idempotencyInflight.delete(idemKey);
        });
        idempotencyInflight.set(idemKey, {
          promise: inflight,
          fingerprint: requestFingerprint,
        });
        return inflight;
      });
    },

    async capturePayment(params: CaptureParams): Promise<GatewayPaymentResult> {
      return track("capturePayment", params, () =>
        // Serialize per payment so concurrent captures re-check remaining (TESTKIT-1).
        withPaymentLedgerLock(params.gatewayPaymentId, async () => {
          const outcome = takePaymentStep("capturePayment");
          const signal = getSignal(params);
          const state = payments.get(params.gatewayPaymentId);
          // Defer ledger mutation until the resolved outcome is money-settling.
          // Scripted failed/indeterminate/requires_action must not change balances.
          let applyLedger: (() => void) | undefined;

          const result = await resolvePaymentOutcome(
            outcome,
            () => {
              if (!state) {
                throw new GatewayApiError(
                  `Payment ${params.gatewayPaymentId} not found (mock)`,
                  name,
                );
              }
              // TESTKIT-1: do not resurrect voided / failed / pending ledgers.
              if (!isCapturableMockStatus(state.status)) {
                throw new InvalidRequestError(
                  `Cannot capture payment ${params.gatewayPaymentId} in status ${state.status} (mock)`,
                );
              }
              const remainingMinor = state.amountMinor - state.capturedAmountMinor;
              if (remainingMinor <= 0) {
                throw new InvalidRequestError(
                  `Payment ${params.gatewayPaymentId} has no capturable amount remaining (mock)`,
                );
              }
              const captureMinor =
                params.amount !== undefined
                  ? resolveMutationMinor(
                      "capturePayment",
                      params.amount,
                      params.currency,
                      state.currency,
                    )
                  : remainingMinor;
              if (captureMinor <= 0) {
                throw new InvalidRequestError(
                  `Capture amount must be positive (got ${minorToMajor(captureMinor, state.currency)}) (mock)`,
                );
              }
              if (captureMinor > remainingMinor) {
                throw new InvalidRequestError(
                  `Over-capture: requested ${minorToMajor(captureMinor, state.currency)}, remaining capturable ${minorToMajor(remainingMinor, state.currency)} (mock)`,
                );
              }
              if (
                params.amount !== undefined &&
                captureMinor < remainingMinor &&
                !capabilities.partialCapture
              ) {
                throw new OperationNotSupportedError(name, "partialCapture", {
                  capability: "partialCapture",
                  claimedSupport: false,
                });
              }
              const nextCapturedMinor = state.capturedAmountMinor + captureMinor;
              const fullyCaptured = nextCapturedMinor >= state.amountMinor;
              const finalCapturedMinor = fullyCaptured ? state.amountMinor : nextCapturedMinor;
              // Refunded captured funds do not close remaining hold
              // (NEW-TESTKIT-2). Full capture with prior refund stays
              // partially_refunded — not a silent paid rewrite.
              const nextStatus: GatewayPaymentStatus = fullyCaptured
                ? state.refundedAmountMinor > 0
                  ? "partially_refunded"
                  : "paid"
                : state.refundedAmountMinor > 0
                  ? "partially_refunded"
                  : "partially_captured";
              const amountMoney = fromMinorUnits(state.amountMinor, state.currency);
              const capturedMoney = fromMinorUnits(finalCapturedMinor, state.currency);
              applyLedger = () => {
                state.capturedAmountMinor = finalCapturedMinor;
                state.authorized = false;
                state.status = nextStatus;
              };
              return {
                ...defaultPaymentResult(
                  params.gatewayPaymentId,
                  nextStatus,
                  amountMoney,
                  name,
                  state.currency,
                ),
                capturedAmount: capturedMoney,
                amount: amountMoney,
                currency: state.currency,
              };
            },
            signal,
            // Dual-timeout: provider-side success must settle even though client throws.
            () => {
              applyLedger?.();
            },
          );

          if (applyLedger && isLedgerSettlingResult(result)) {
            applyLedger();
            // TESTKIT-1: ledger is source of truth after successful capture.
            // Scripted result overrides must not desync reported money/status
            // from the settled ledger (dual-write honesty).
            const settledState = state!;
            return withPhase6Outcome(
              {
                ...result,
                status: settledState.status,
                amount: fromMinorUnits(settledState.amountMinor, settledState.currency, CONVERSION_OPTS),
                currency: settledState.currency,
                capturedAmount: fromMinorUnits(
                  settledState.capturedAmountMinor,
                  settledState.currency,
                  CONVERSION_OPTS,
                ),
                refundedAmount: fromMinorUnits(
                  settledState.refundedAmountMinor,
                  settledState.currency,
                  CONVERSION_OPTS,
                ),
              },
              paymentStatusToOperationOutcome(settledState.status),
              result.reconciliationRequired === true ? { reconciliationRequired: true } : undefined,
            );
          }
          return result;
        }),
      );
    },

    async refundPayment(params: RefundParams): Promise<GatewayRefundResult> {
      return track("refundPayment", params, async () => {
        if (!capabilities.refunds) {
          throw new OperationNotSupportedError(name, "refundPayment", {
            capability: "refunds",
            claimedSupport: false,
          });
        }
        // Serialize per payment so concurrent refunds re-check remaining (TESTKIT-1).
        return withPaymentLedgerLock(params.gatewayPaymentId, async () => {
          const outcome = takeRefundStep();
          const signal = getSignal(params);
          await applyLatency(outcome, signal);

          if (outcome && isThrowStep(outcome)) {
            handleThrowStep(outcome);
          }

          if (outcome?.outcome === "custom") {
            if (outcome.error) throw outcome.error;
            if (outcome.result) return outcome.result;
          }
          if (outcome?.outcome === "network_error" || outcome?.outcome === "timeout") {
            throw new NetworkError(outcome.message ?? "Network error (mock)");
          }
          if (outcome?.outcome === "gateway_api_error") {
            throw new GatewayApiError(outcome.message ?? "Gateway API error (mock)", name);
          }
          if (outcome?.outcome === "indeterminate") {
            return applyOutcomeToGatewayRefundResult(
              {
                gatewayRefundId: nextId("ref"),
                status: "pending",
                rawResponse: {
                  mock: true,
                  error: { code: "INDETERMINATE" },
                  reconciliationRequired: true,
                },
              },
              "indeterminate",
            );
          }
          if (outcome?.outcome === "failed") {
            return applyOutcomeToGatewayRefundResult(
              {
                gatewayRefundId: nextId("ref"),
                status: "failed",
                rawResponse: { mock: true, status: "failed" },
              },
              "failed",
            );
          }

          const state = payments.get(params.gatewayPaymentId);
          if (!state) {
            throw new GatewayApiError(`Payment ${params.gatewayPaymentId} not found (mock)`, name);
          }
          const remainingMinor = state.capturedAmountMinor - state.refundedAmountMinor;
          if (remainingMinor <= 0) {
            throw new InvalidRequestError(
              `Payment ${params.gatewayPaymentId} has no refundable amount remaining (mock)`,
            );
          }
          const refundMinor =
            params.amount !== undefined
              ? resolveMutationMinor(
                  "refundPayment",
                  params.amount,
                  params.currency,
                  state.currency,
                )
              : remainingMinor;
          if (refundMinor <= 0) {
            throw new InvalidRequestError(
              `Refund amount must be positive (got ${minorToMajor(refundMinor, state.currency)}) (mock)`,
            );
          }
          if (refundMinor > remainingMinor) {
            throw new InvalidRequestError(
              `Over-refund: requested ${minorToMajor(refundMinor, state.currency)}, remaining refundable ${minorToMajor(remainingMinor, state.currency)} (mock)`,
            );
          }
          if (
            params.amount !== undefined &&
            refundMinor < remainingMinor &&
            !capabilities.partialRefunds
          ) {
            throw new OperationNotSupportedError(name, "partialRefund", {
              capability: "partialRefunds",
              claimedSupport: false,
            });
          }

          state.refundedAmountMinor += refundMinor;
          if (state.refundedAmountMinor >= state.capturedAmountMinor) {
            state.status = "refunded";
            state.refundedAmountMinor = state.capturedAmountMinor;
          } else {
            state.status = "partially_refunded";
          }

          const refundId = nextId("ref");
          // Ledger-derived totals are authoritative (TESTKIT-3). Scripted
          // `result` may add metadata but must not override reported money
          // fields after the ledger has already been mutated.
          const base = defaultRefundResult(
            refundId,
            "completed",
            fromMinorUnits(state.refundedAmountMinor, state.currency, CONVERSION_OPTS),
          );
          const result =
            outcome?.outcome === "partial_refund" || outcome?.result
              ? {
                  ...base,
                  ...((outcome.result ?? {}) as Partial<GatewayRefundResult>),
                  // Re-assert ledger-derived money identity after spread
                  status: base.status,
                  totalRefunded: base.totalRefunded,
                  outcome: base.outcome,
                  gatewayRefundId:
                    ((outcome.result ?? {}) as Partial<GatewayRefundResult>).gatewayRefundId ??
                    base.gatewayRefundId,
                }
              : base;
          if (
            outcome?.outcome === "provider_ok_client_timeout" ||
            outcome?.outcome === "provider_success_client_timeout"
          ) {
            throw new NetworkError(
              outcome.message ??
                "Client timeout after provider-side success (mock; reconcile via getPaymentState)",
            );
          }
          return result;
        });
      });
    },

    async voidPayment(params: VoidParams): Promise<GatewayPaymentResult> {
      return track("voidPayment", params, async () => {
        if (!capabilities.voids) {
          throw new OperationNotSupportedError(name, "voidPayment", {
            capability: "voids",
            claimedSupport: false,
          });
        }
        // Serialize with capture/refund so void cannot race capture (TESTKIT-1).
        return withPaymentLedgerLock(params.gatewayPaymentId, async () => {
          const outcome = takePaymentStep("voidPayment");
          const signal = getSignal(params);
          const state = payments.get(params.gatewayPaymentId);
          // Defer cancel mutation until outcome is money-settling (void success).
          let applyLedger: (() => void) | undefined;

          const result = await resolvePaymentOutcome(
            outcome,
            () => {
              // TESTKIT-3: fail closed for unknown payment IDs (match capture/refund/get).
              if (!state) {
                throw new GatewayApiError(
                  `Payment ${params.gatewayPaymentId} not found (mock)`,
                  name,
                );
              }
              if (state.capturedAmountMinor > 0) {
                throw new InvalidRequestError(
                  `Cannot void payment ${params.gatewayPaymentId} after capture (mock)`,
                );
              }
              applyLedger = () => {
                state.status = "cancelled";
                state.authorized = false;
              };
              return defaultPaymentResult(
                params.gatewayPaymentId,
                "cancelled",
                undefined,
                name,
                state.currency,
              );
            },
            signal,
            () => {
              applyLedger?.();
            },
          );

          if (applyLedger && isLedgerSettlingResult(result)) {
            applyLedger();
            // TESTKIT-1: re-assert ledger status after void (no money amounts).
            return withPhase6Outcome(
              {
                ...result,
                status: "cancelled",
                currency: state?.currency ?? result.currency,
              },
              "succeeded",
              result.reconciliationRequired === true ? { reconciliationRequired: true } : undefined,
            );
          }
          return result;
        });
      });
    },

    async getPayment(params: GetPaymentParams): Promise<GatewayPaymentResult> {
      return track("getPayment", params, async () => {
        const outcome = takePaymentStep("getPayment");
        const signal = getSignal(params);

        const ledgerSnapshot = (): GatewayPaymentResult => {
          const state = payments.get(params.gatewayPaymentId);
          if (!state) {
            throw new GatewayApiError(`Payment ${params.gatewayPaymentId} not found (mock)`, name);
          }
          return {
            ...defaultPaymentResult(
              params.gatewayPaymentId,
              state.status,
              fromMinorUnits(state.amountMinor, state.currency, CONVERSION_OPTS),
              name,
              state.currency,
            ),
            currency: state.currency,
            capturedAmount: fromMinorUnits(
              state.capturedAmountMinor,
              state.currency,
              CONVERSION_OPTS,
            ),
            refundedAmount: fromMinorUnits(
              state.refundedAmountMinor,
              state.currency,
              CONVERSION_OPTS,
            ),
          };
        };

        // NEW-TESTKIT-3: getPayment is a read. Scripted succeeded / defaultOutcome
        // must not rewrite the returned (or stored) ledger to paid. Fault
        // outcomes still apply so retrieve failures stay testable.
        if (isGetPaymentScriptedFault(outcome)) {
          if (
            !isThrowStep(outcome) &&
            (outcome.outcome === "provider_ok_client_timeout" ||
              outcome.outcome === "provider_success_client_timeout")
          ) {
            await applyLatency(outcome, signal);
            throw new NetworkError(
              outcome.message ??
                "Client timeout after provider-side success (mock; reconcile via getPaymentState)",
            );
          }
          return resolvePaymentOutcome(outcome, ledgerSnapshot, signal);
        }

        await applyLatency(outcome, signal);
        return ledgerSnapshot();
      });
    },

    async getPaymentStatus(gatewayId: string): Promise<GatewayPaymentStatus> {
      return track("getPaymentStatus", { gatewayId }, async () => {
        const state = payments.get(gatewayId);
        if (!state) {
          throw new GatewayApiError(`Payment ${gatewayId} not found (mock)`, name);
        }
        return state.status;
      });
    },

    /**
     * Hosted checkout session (capability `hostedCheckout`).
     * Present so claim_method_presence passes when caps claim hostedCheckout.
     */
    async createCheckoutSession(
      params: CommonCheckoutSessionInput,
    ): Promise<CheckoutSessionOperationResult> {
      return track("createCheckoutSession", params, async () => {
        if (!capabilities.hostedCheckout) {
          throw new OperationNotSupportedError(name, "createCheckoutSession", {
            capability: "hostedCheckout",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("createCheckoutSession", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Checkout session failed (mock)"),
          };
        }
        if (isScriptedIndeterminate(step)) {
          const lookupId =
            typeof params.idempotencyKey === "string" && params.idempotencyKey.length > 0
              ? params.idempotencyKey
              : "unknown";
          return applyIndeterminateCheckoutSessionOutcome({
            sessionId: lookupId,
            message: step.message ?? "Checkout session outcome indeterminate (mock)",
            errorName: "NetworkError",
            gateway: name,
          });
        }
        const sessionId = nextId("cs");
        return {
          outcome: "succeeded" as const,
          session: {
            status: "open",
            url: `https://mock.test/checkout/${sessionId}`,
            references: buildProviderReferences({
              gateway: name,
              gatewayId: sessionId,
              status: "open",
            }),
          },
        };
      });
    },

    async getCheckoutSession(
      params: GetCheckoutSessionParams,
    ): Promise<CheckoutSessionOperationResult> {
      return track("getCheckoutSession", params, async () => {
        if (!capabilities.hostedCheckout) {
          throw new OperationNotSupportedError(name, "getCheckoutSession", {
            capability: "hostedCheckout",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("getCheckoutSession", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Get checkout session failed (mock)"),
          };
        }
        return {
          outcome: "succeeded" as const,
          session: {
            status: "open",
            url: `https://mock.test/checkout/${params.sessionId}`,
            references: buildProviderReferences({
              gateway: name,
              gatewayId: params.sessionId,
              status: "open",
            }),
          },
        };
      });
    },

    async createCustomer(params: CreateCustomerParams): Promise<CustomerOperationResult> {
      return track("createCustomer", params, async () => {
        if (!capabilities.customers) {
          throw new OperationNotSupportedError(name, "createCustomer", {
            capability: "customers",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("createCustomer", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Create customer failed (mock)"),
          };
        }
        if (isScriptedIndeterminate(step)) {
          const lookupId = paramLookup(params, ["idempotencyKey", "customerId"]);
          return {
            outcome: "indeterminate" as const,
            reconciliationRequired: true as const,
            message: step.message ?? "Create customer indeterminate (mock)",
            customer: {
              status: "unknown",
              references: unknownRefs(lookupId),
            },
          };
        }
        const id = nextId("cus");
        const customer: Customer = {
          status: "active",
          ...(typeof params.email === "string" ? { email: params.email } : {}),
          ...(typeof params.name === "string" ? { name: params.name } : {}),
          references: buildProviderReferences({
            gateway: name,
            gatewayId: id,
            status: "active",
            customerId: id,
          }),
        };
        customers.set(id, customer);
        return {
          outcome: "succeeded" as const,
          customer,
        };
      });
    },

    async getCustomer(params: GetCustomerParams): Promise<CustomerOperationResult> {
      return track("getCustomer", params, async () => {
        if (!capabilities.customers) {
          throw new OperationNotSupportedError(name, "getCustomer", {
            capability: "customers",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("getCustomer", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Get customer failed (mock)"),
          };
        }
        const stored = customers.get(params.customerId);
        if (stored !== undefined) {
          return {
            outcome: "succeeded" as const,
            customer: stored,
          };
        }
        return {
          outcome: "failed" as const,
          error: {
            name: "GatewayApiError",
            message: `Customer ${params.customerId} not found (mock)`,
            code: "GATEWAY_API_ERROR",
            statusCode: 404,
          },
        };
      });
    },

    async attachPaymentMethod(
      params: AttachPaymentMethodParams,
    ): Promise<PaymentMethodOperationResult> {
      return track("attachPaymentMethod", params, async () => {
        if (!capabilities.paymentMethods) {
          throw new OperationNotSupportedError(name, "attachPaymentMethod", {
            capability: "paymentMethods",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("attachPaymentMethod", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Attach payment method failed (mock)"),
          };
        }
        if (isScriptedIndeterminate(step)) {
          const lookupId = paramLookup(params, [
            "paymentMethodId",
            "token",
            "idempotencyKey",
          ]);
          return {
            outcome: "indeterminate" as const,
            reconciliationRequired: true as const,
            message: step.message ?? "Attach payment method indeterminate (mock)",
            paymentMethod: {
              id: lookupId,
              type: "other" as const,
              references: unknownRefs(lookupId),
            },
          };
        }
        const id = params.paymentMethodId ?? nextId("pm");
        return {
          outcome: "succeeded" as const,
          paymentMethod: {
            id,
            customerId: params.customerId,
            type: "card",
            references: buildProviderReferences({
              gateway: name,
              gatewayId: id,
              status: "active",
              customerId: params.customerId,
            }),
          },
        };
      });
    },

    async listPaymentMethods(params: ListPaymentMethodsParams): Promise<ListPaymentMethodsResult> {
      return track("listPaymentMethods", params, async () => {
        if (!capabilities.paymentMethods) {
          throw new OperationNotSupportedError(name, "listPaymentMethods", {
            capability: "paymentMethods",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("listPaymentMethods", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "List payment methods failed (mock)"),
          };
        }
        return { outcome: "succeeded" as const, paymentMethods: [] };
      });
    },

    async detachPaymentMethod(
      params: DetachPaymentMethodParams,
    ): Promise<PaymentMethodOperationResult> {
      return track("detachPaymentMethod", params, async () => {
        if (!capabilities.paymentMethods) {
          throw new OperationNotSupportedError(name, "detachPaymentMethod", {
            capability: "paymentMethods",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("detachPaymentMethod", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Detach payment method failed (mock)"),
          };
        }
        // Detached methods omit customerId even if params.customerId was set.
        return {
          outcome: "succeeded" as const,
          paymentMethod: {
            id: params.paymentMethodId,
            type: "card",
            references: buildProviderReferences({
              gateway: name,
              gatewayId: params.paymentMethodId,
              status: "detached",
            }),
          },
        };
      });
    },

    async getDispute(params: GetDisputeParams): Promise<DisputeOperationResult> {
      return track("getDispute", params, async () => {
        if (!capabilities.disputes) {
          throw new OperationNotSupportedError(name, "getDispute", {
            capability: "disputes",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("getDispute", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Get dispute failed (mock)"),
          };
        }
        return {
          outcome: "succeeded" as const,
          dispute: {
            status: "needs_response",
            references: buildProviderReferences({
              gateway: name,
              gatewayId: params.disputeId,
              status: "needs_response",
            }),
          },
        };
      });
    },

    async listDisputes(params: ListDisputesParams): Promise<ListDisputesResult> {
      return track("listDisputes", params, async () => {
        if (!capabilities.disputes) {
          throw new OperationNotSupportedError(name, "listDisputes", {
            capability: "disputes",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("listDisputes", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "List disputes failed (mock)"),
          };
        }
        return { outcome: "succeeded" as const, disputes: [] };
      });
    },

    async submitDisputeEvidence(
      params: SubmitDisputeEvidenceParams,
    ): Promise<DisputeOperationResult> {
      return track("submitDisputeEvidence", params, async () => {
        if (!capabilities.disputes) {
          throw new OperationNotSupportedError(name, "submitDisputeEvidence", {
            capability: "disputes",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("submitDisputeEvidence", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Submit dispute evidence failed (mock)"),
          };
        }
        return {
          outcome: "succeeded" as const,
          dispute: {
            status: "under_review",
            references: buildProviderReferences({
              gateway: name,
              gatewayId: params.disputeId,
              status: "under_review",
            }),
          },
        };
      });
    },

    async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkOperationResult> {
      return track("createPaymentLink", params, async () => {
        if (!capabilities.paymentLinks) {
          throw new OperationNotSupportedError(name, "createPaymentLink", {
            capability: "paymentLinks",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("createPaymentLink", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Create payment link failed (mock)"),
          };
        }
        if (isScriptedIndeterminate(step)) {
          const lookupId = paramLookup(params, ["idempotencyKey", "paymentLinkId"]);
          return {
            outcome: "indeterminate" as const,
            reconciliationRequired: true as const,
            message: step.message ?? "Create payment link indeterminate (mock)",
            paymentLink: {
              status: "unknown",
              references: unknownRefs(lookupId),
            },
          };
        }
        const id = nextId("plink");
        return {
          outcome: "succeeded" as const,
          paymentLink: {
            status: "active",
            url: `https://mock.test/pay/${id}`,
            references: buildProviderReferences({
              gateway: name,
              gatewayId: id,
              status: "active",
            }),
          },
        };
      });
    },

    async getPaymentLink(params: GetPaymentLinkParams): Promise<PaymentLinkOperationResult> {
      return track("getPaymentLink", params, async () => {
        if (!capabilities.paymentLinks) {
          throw new OperationNotSupportedError(name, "getPaymentLink", {
            capability: "paymentLinks",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("getPaymentLink", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Get payment link failed (mock)"),
          };
        }
        return {
          outcome: "succeeded" as const,
          paymentLink: {
            status: "active",
            url: `https://mock.test/pay/${params.paymentLinkId}`,
            references: buildProviderReferences({
              gateway: name,
              gatewayId: params.paymentLinkId,
              status: "active",
            }),
          },
        };
      });
    },

    async deactivatePaymentLink(
      params: DeactivatePaymentLinkParams,
    ): Promise<PaymentLinkOperationResult> {
      return track("deactivatePaymentLink", params, async () => {
        if (!capabilities.paymentLinks) {
          throw new OperationNotSupportedError(name, "deactivatePaymentLink", {
            capability: "paymentLinks",
            claimedSupport: false,
          });
        }
        const step = await consumePhase22Step("deactivatePaymentLink", params);
        if (isScriptedFailed(step)) {
          return {
            outcome: "failed" as const,
            error: scriptedFailedError(step, "Deactivate payment link failed (mock)"),
          };
        }
        return {
          outcome: "succeeded" as const,
          paymentLink: {
            status: "inactive",
            url: `https://mock.test/pay/${params.paymentLinkId}`,
            references: buildProviderReferences({
              gateway: name,
              gatewayId: params.paymentLinkId,
              status: "inactive",
            }),
          },
        };
      });
    },

    verifyWebhook(
      payload: unknown,
      signature?: string,
      _headers?: Record<string, string>,
    ): boolean {
      // Sync history for verify (no async track)
      const redactedParams = redact({ payload, signature });
      const push = (ok: boolean) => {
        history.push({
          operation: "verifyWebhook",
          params: redactedParams,
          result: { valid: ok },
          atMs: nowMs(),
        });
      };

      if (payload === null || payload === undefined) {
        push(false);
        return false;
      }
      if (typeof payload !== "object") {
        push(false);
        return false;
      }
      const body = payload as MockWebhookPayload & { signature?: string };
      // Sign over the payload without the signature field (HMAC body).
      const expected = computeMockWebhookSignature(
        { ...body, signature: undefined },
        webhookSecret,
      );
      // Prefer explicit signature arg; otherwise use body.signature.
      // Never accept "sig equals itself" — only compare to the computed HMAC.
      const sig = signature ?? body.signature;
      if (!sig) {
        push(false);
        return false;
      }
      const ok = sig === expected;
      push(ok);
      return ok;
    },

    parseWebhookEvent(payload: unknown): WebhookEvent {
      const redactedParams = redact(payload);
      try {
        if (payload === null || typeof payload !== "object") {
          throw new GatewayApiError("Invalid webhook payload (mock)", name);
        }
        const body = payload as MockWebhookPayload;
        if (!body.id || !body.gatewayPaymentId || !body.status) {
          throw new GatewayApiError("Malformed webhook payload (mock)", name);
        }
        // TESTKIT-3: never invent payment_paid / payment.succeeded for a
        // typeless payload. Missing type is malformed, not a paid event.
        const type = typeof body.type === "string" ? body.type.trim() : "";
        if (!type) {
          throw new GatewayApiError("Malformed webhook payload (mock)", name);
        }
        const normalized: MockWebhookPayload = {
          id: body.id,
          type,
          gatewayPaymentId: body.gatewayPaymentId,
          status: body.status,
        };
        if (body.paymentId !== undefined) normalized.paymentId = body.paymentId;
        if (body.amount !== undefined) normalized.amount = body.amount;
        if (body.currency !== undefined) normalized.currency = body.currency;
        if (body.createdAt !== undefined) normalized.createdAt = body.createdAt;
        if (body.signature !== undefined) normalized.signature = body.signature;
        if (body.sequence !== undefined) normalized.sequence = body.sequence;
        const evt = mockPayloadToWebhookEvent(normalized, name);
        history.push({
          operation: "parseWebhookEvent",
          params: redactedParams,
          result: redact(evt),
          atMs: nowMs(),
        });
        return evt;
      } catch (err) {
        const summary = errorSummary(err);
        const rec: MockRequestRecord = {
          operation: "parseWebhookEvent",
          params: redactedParams,
          atMs: nowMs(),
        };
        if (summary) rec.error = summary;
        history.push(rec);
        throw err;
      }
    },
  };

  return gateway;
}
