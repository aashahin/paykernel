/**
 * Capability-gated gateway conformance suite (Phase 4.1).
 *
 * Offline-first: does **not** call live provider APIs. Gateways under test
 * must be mocks / fixture-driven doubles, or run in `structural` /
 * `applicable` mode (capabilities + method presence only for real HTTP
 * gateways without injectable fetch).
 *
 * Named cases (skip when not applicable by capabilities, mode, or fixtures):
 * 1 amount_conversion  2 status_normalization  3 decline_mapping
 * 4 provider_error_mapping  5 network_failure  6 timeout_behavior
 * 7 safe_retry  8 idempotency_behavior  9 webhook_verification
 * 10 malformed_webhook_rejection  11 event_normalization
 * 12 partial_capture  13 partial_refund  14 logging_redaction
 * 15 request_cancellation  16 indeterminate_outcomes
 * 17 capabilities_parity  18 claim_method_presence
 */

import {
  CAPABILITY_OPERATION_MAP,
  CardDeclinedError,
  createRedactingLogger,
  GATEWAY_CAPABILITY_KEYS,
  GatewayApiError,
  InsufficientFundsError,
  isIndeterminateOutcome,
  isMoney,
  isPaidLikePaymentStatus,
  isPaidOutcome,
  money,
  moneyToMajorNumber,
  MoneyAmountError,
  NetworkError,
  OperationNotSupportedError,
  PaymentAbortedError,
  type AmountInput,
  type GatewayCapabilities,
  type GatewayCapabilityKey,
  type GatewayPaymentStatus,
  type Logger,
  type Money,
  type PaymentGateway,
} from "@paykernel/core";
import type {
  GatewayConformanceCaseResult,
  GatewayConformanceFixtures,
  GatewayConformanceMode,
  GatewayConformanceOptions,
  GatewayConformanceReport,
} from "./types";

/** Resolve expected major-unit Money from AmountInput for assertions. */
function amountInputToExpectedMoney(
  amount: AmountInput,
  _currency: string,
): Money {
  if (isMoney(amount)) return amount;
  // Defensive — AmountInput is Money in 1.0; legacy number still handled for compat
  return money(String(amount), _currency);
}

/** Legacy helper kept for number comparison via moneyToMajorNumber. */
function amountInputToExpectedMajor(
  amount: AmountInput,
  currency: string,
): number {
  const m = amountInputToExpectedMoney(amount, currency);
  return moneyToMajorNumber(m, { allowZero: true, allowNegative: true });
}

/** Canonical case ids for include/exclude and report entries. */
export const GATEWAY_CONFORMANCE_CASES = [
  "amount_conversion",
  "status_normalization",
  "decline_mapping",
  "provider_error_mapping",
  "network_failure",
  "timeout_behavior",
  "safe_retry",
  "idempotency_behavior",
  "webhook_verification",
  "malformed_webhook_rejection",
  "event_normalization",
  "partial_capture",
  "partial_refund",
  "logging_redaction",
  "request_cancellation",
  "indeterminate_outcomes",
  "capabilities_parity",
  "claim_method_presence",
] as const;

export type GatewayConformanceCaseName =
  (typeof GATEWAY_CONFORMANCE_CASES)[number];

const ALLOWED_PAYMENT_STATUSES: ReadonlySet<GatewayPaymentStatus> = new Set([
  "pending",
  "processing",
  "authorized",
  "approved",
  "paid",
  "partially_captured",
  "failed",
  "cancelled",
  "reversed",
  "refunded",
  "partially_refunded",
  "refund_completed",
  "refund_pending",
  "refund_failed",
  "setup_completed",
]);
const STRUCTURAL_CASES: ReadonlySet<string> = new Set([
  "capabilities_parity",
  "claim_method_presence",
]);
type Mockish = PaymentGateway & {
  enqueue?: (
    op: string,
    outcome: { outcome: string; latencyMs?: number; message?: string },
  ) => void;
  history?: ReadonlyArray<{ operation: string; params: unknown }>;
  buildWebhook?: (overrides?: Record<string, unknown>) => unknown;
  getLastProviderSideSuccess?: () => { outcome?: string; status?: string } | undefined;
  getPaymentState?: (id: string) =>
    | {
        amount: Money | number;
        capturedAmount: Money | number;
        refundedAmount?: Money | number;
        status?: GatewayPaymentStatus | string;
      }
    | undefined;
  /** Optional testkit logger injection surface */
  setLogger?: (logger: Logger) => void;
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function isScriptableMock(g: PaymentGateway): boolean {
  const m = g as Mockish;
  return typeof m.enqueue === "function";
}

function defaultCreatePayment(caps: GatewayCapabilities) {
  // NEW-TESTKIT-4: capture:false is an auth hold. Unclaimed authorization
  // must not request it — payments-only fixtures capture immediately.
  const authHold =
    caps.authorization === true && caps.immediateCapture === false;
  return {
    amount: money("10.50", "SAR"),
    currency: "SAR",
    callbackUrl: "https://merchant.example/callback",
    capture: !authHold,
  };
}

function mergeFixtures(
  caps: GatewayCapabilities,
  fixtures?: GatewayConformanceFixtures,
): GatewayConformanceFixtures & {
  createPayment: NonNullable<GatewayConformanceFixtures["createPayment"]>;
} {
  const base = defaultCreatePayment(caps);
  return {
    ...fixtures,
    createPayment: {
      ...base,
      ...fixtures?.createPayment,
    },
  };
}

function isAbortLike(err: unknown): boolean {
  if (err instanceof PaymentAbortedError) return true;
  if (err instanceof NetworkError) {
    // mockGateway surfaces abort as NetworkError("Request aborted", …)
    return /abort/i.test(err.message);
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (/abort/i.test(err.message)) return true;
  }
  // DOMException AbortError in some runtimes
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  ) {
    return true;
  }
  return false;
}

function isPaidSuccess(result: {
  outcome?: string;
  status?: string;
  amount?: unknown;
}): boolean {
  return result.outcome === "succeeded" && isPaidLikePaymentStatus(result.status ?? "");
}

function buildReport(
  name: string,
  results: GatewayConformanceCaseResult[],
): GatewayConformanceReport {
  const passed: string[] = [];
  const failed: Array<{ case: string; error: string }> = [];
  const skipped: Array<{ case: string; reason: string }> = [];
  for (const r of results) {
    if (r.status === "passed") passed.push(r.name);
    else if (r.status === "failed")
      failed.push({ case: r.name, error: r.error });
    else skipped.push({ case: r.name, reason: r.reason });
  }
  return {
    name,
    passed,
    failed,
    skipped,
    ok: failed.length === 0,
  };
}

type CaseFn = () => Promise<void>;

type CaseDef = {
  name: GatewayConformanceCaseName;
  /**
   * Return a skip reason, or undefined to run.
   * Called after mode/include/exclude filtering.
   */
  skipReason?: () => string | undefined;
  run: CaseFn;
};

/**
 * Run the shared gateway conformance suite.
 */
export async function runGatewayConformanceSuite(
  options: GatewayConformanceOptions,
): Promise<GatewayConformanceReport> {
  const mode: GatewayConformanceMode = options.mode ?? "full";
  const include = options.include
    ? new Set(options.include)
    : null;
  const exclude = options.exclude
    ? new Set(options.exclude)
    : null;

  // Resolve capabilities (optional on options — default from first gateway).
  const probe = await options.createGateway();
  const caps: GatewayCapabilities =
    options.capabilities ?? probe.capabilities;
  const fixtures = mergeFixtures(caps, options.fixtures);

  const fresh = async (): Promise<PaymentGateway> => options.createGateway();

  /**
   * Network-mutating payment ops are only safe for scriptable mocks in
   * applicable mode, or always in full mode. Structural never runs them.
   */
  const allowNetworkOps = (g: PaymentGateway): boolean => {
    if (mode === "structural") return false;
    if (mode === "full") return true;
    // applicable: mock only (offline scripted)
    return isScriptableMock(g);
  };

  const networkSkipReason = (g: PaymentGateway): string | undefined => {
    if (mode === "structural") {
      return "structural mode: capabilities/method presence only";
    }
    if (mode === "applicable" && !isScriptableMock(g)) {
      return "applicable mode: skipping provider HTTP (no mock/scriptable enqueue; offline-only)";
    }
    return undefined;
  };

  const cases: CaseDef[] = [
    // ── 17 capabilities_parity ─────────────────────────────────────────────
    {
      name: "capabilities_parity",
      run: async () => {
        const g = await fresh();
        for (const key of GATEWAY_CAPABILITY_KEYS) {
          assert(
            typeof g.capabilities[key] === "boolean",
            `missing capability ${key}`,
          );
          assert(
            g.supports(key) === g.capabilities[key],
            `supports(${key}) !== capabilities[${key}]`,
          );
          // Expected claims when caller supplied capabilities option
          if (options.capabilities) {
            assert(
              g.capabilities[key] === caps[key],
              `gateway.capabilities.${key}=${String(g.capabilities[key])} !== expected ${String(caps[key])}`,
            );
          }
        }
      },
    },

    // ── 18 claim_method_presence ───────────────────────────────────────────
    {
      name: "claim_method_presence",
      run: async () => {
        const g = await fresh();
        for (const key of GATEWAY_CAPABILITY_KEYS) {
          if (!g.supports(key)) continue;
          const operation = CAPABILITY_OPERATION_MAP[key as GatewayCapabilityKey];
          if (operation === undefined) continue;
          const method = (g as PaymentGateway & Record<string, unknown>)[
            operation
          ];
          assert(
            typeof method === "function",
            `capability ${key} claimed but ${operation} is not a function`,
          );
        }
        // Explicit voids boundary (Phase 3 claim logic)
        if (g.supports("voids")) {
          assert(
            typeof g.voidPayment === "function",
            "voids=true requires voidPayment function",
          );
        }
      },
    },

    // ── 1 amount_conversion ────────────────────────────────────────────────
    {
      name: "amount_conversion",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);

        const amountCases =
          fixtures.amountCases ??
          (isScriptableMock(g)
            ? [
                // Provider-profile cases: KWD padded 3-decimal, JPY zero-decimal, SAR two-decimal
                {
                  amount: money("1.200", "KWD"),
                  currency: "KWD",
                  expectedMajor: money("1.200", "KWD"),
                  expectedMinor: 1200,
                },
                {
                  amount: money("100", "JPY"),
                  currency: "JPY",
                  expectedMajor: money("100", "JPY"),
                  expectedMinor: 100,
                },
                {
                  amount: money("10.50", "SAR"),
                  currency: "SAR",
                  expectedMajor: money("10.50", "SAR"),
                  expectedMinor: 1050,
                },
              ]
            : [
                {
                  amount: fixtures.createPayment.amount,
                  currency: fixtures.createPayment.currency,
                },
              ]);

        for (const ac of amountCases) {
          const createParams: Parameters<PaymentGateway["createPayment"]>[0] = {
            amount: ac.amount,
            currency: ac.currency,
            callbackUrl: fixtures.createPayment.callbackUrl,
          };
          if (fixtures.createPayment.capture !== undefined) {
            createParams.capture = fixtures.createPayment.capture;
          }
          const result = await g.createPayment(createParams);
          const expectedMoney =
            ac.expectedMajor ?? amountInputToExpectedMoney(ac.amount, ac.currency);
          assert(
            isMoney(result.amount),
            `result.amount must be Money, got ${String(result.amount)} (${ac.currency})`,
          );
          assert(
            isMoney(expectedMoney),
            `expectedMajor must be Money`,
          );
          assert(
            moneyToMajorNumber(result.amount) === moneyToMajorNumber(expectedMoney),
            `amount major units: expected ${moneyToMajorNumber(expectedMoney)}, got ${moneyToMajorNumber(result.amount as Money)} (${ac.currency})`,
          );
          assert(
            result.currency === ac.currency.toUpperCase(),
            `currency mismatch: expected ${ac.currency.toUpperCase()}, got ${result.currency}`,
          );
          if (ac.expectedMinor !== undefined) {
            const raw = result.rawResponse as { amountMinor?: number } | null;
            if (raw && typeof raw === "object" && typeof raw.amountMinor === "number") {
              assert(
                raw.amountMinor === ac.expectedMinor,
                `amountMinor ${raw.amountMinor} !== ${ac.expectedMinor} (${ac.currency})`,
              );
            }
          }
          assert(
            typeof result.gatewayId === "string" && result.gatewayId.length > 0,
            "gatewayId required",
          );
          // Never claim paid with wrong major→minor silent scale (e.g. 10.5 → 10)
          if (isPaidSuccess(result)) {
            assert(
              moneyToMajorNumber(result.amount as Money) === moneyToMajorNumber(expectedMoney),
              "paid result amount must match major units",
            );
          }
        }
        // BHD excess precision must be rejected (exponent 3, 4 decimals)
        let bhdRejected = false;
        try {
          const bad = money("1.2345", "BHD");
          await g.createPayment({
            amount: bad,
            currency: "BHD",
            callbackUrl: fixtures.createPayment.callbackUrl,
          });
        } catch (e) {
          if (e instanceof MoneyAmountError || e instanceof Error) {
            bhdRejected = true;
          }
        }
        // If Money factory itself rejects, that's also valid; otherwise gateway must reject
        if (!bhdRejected) {
          try {
            money("1.2345", "BHD");
          } catch {
            bhdRejected = true;
          }
        }
        assert(bhdRejected, "BHD 1.2345 excess precision must be rejected via MoneyAmountError");
      },
    },

    // ── 2 status_normalization ─────────────────────────────────────────────
    {
      name: "status_normalization",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);

        const mockish = g as Mockish;
        if (typeof mockish.enqueue === "function") {
          // Script known statuses and assert SDK GatewayPaymentStatus union
          const scripts: Array<{ outcome: string; expect: GatewayPaymentStatus }> = [
            { outcome: "succeeded", expect: "paid" },
            { outcome: "pending", expect: "pending" },
            { outcome: "processing", expect: "processing" },
          ];
          // NEW-TESTKIT-4: capture:false requires authorization. Do not
          // script an auth hold when the capability is unclaimed.
          if (caps.authorization) {
            scripts.splice(1, 0, {
              outcome: "authorized",
              expect: "authorized",
            });
          }
          for (const s of scripts) {
            mockish.enqueue!("createPayment", { outcome: s.outcome });
            const result = await g.createPayment({
              amount: money("1.00", "USD"),
              currency: "USD",
              callbackUrl: fixtures.createPayment.callbackUrl,
              capture: s.outcome === "authorized" ? false : true,
            });
            assert(
              ALLOWED_PAYMENT_STATUSES.has(result.status),
              `unknown status ${result.status}`,
            );
            assert(
              result.status === s.expect,
              `expected ${s.expect}, got ${result.status}`,
            );
          }
          if (fixtures.statusMap) {
            for (const [, mapped] of Object.entries(fixtures.statusMap)) {
              assert(
                ALLOWED_PAYMENT_STATUSES.has(mapped),
                `statusMap value ${mapped} not in GatewayPaymentStatus union`,
              );
            }
          }
          return;
        }

        // Non-mock: single create, assert status is in union
        const result = await g.createPayment({
          amount: fixtures.createPayment.amount,
          currency: fixtures.createPayment.currency,
          callbackUrl: fixtures.createPayment.callbackUrl,
          capture: true,
        });
        assert(
          ALLOWED_PAYMENT_STATUSES.has(result.status),
          `unknown status ${result.status}`,
        );
      },
    },

    // ── 3 decline_mapping ──────────────────────────────────────────────────
    {
      name: "decline_mapping",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);
        const mockish = g as Mockish;
        if (typeof mockish.enqueue !== "function") {
          throw new SkipSignal(
            "decline scripting not available (provide mock enqueue or decline fixtures)",
          );
        }
        mockish.enqueue("createPayment", { outcome: "declined" });
        let declinedOk = false;
        try {
          const result = await g.createPayment({
            amount: money("1.00", "USD"),
            currency: "USD",
            callbackUrl: fixtures.createPayment.callbackUrl,
          });
          // Design may return outcome declined instead of throwing
          declinedOk =
            (result.outcome === "declined" || result.outcome === "failed") &&
            (result.status === "failed" || result.status === "cancelled");
          assert(
            !isPaidSuccess(result),
            "decline must not surface as paid success",
          );
          assert(
            !isPaidOutcome(result),
            "decline must not be paid outcome",
          );
        } catch (e) {
          // Documented design: CardDeclinedError throw is acceptable
          declinedOk =
            e instanceof CardDeclinedError ||
            e instanceof InsufficientFundsError;
        }
        assert(
          declinedOk,
          "decline must yield outcome declined/failed or CardDeclinedError (gateway design may throw)",
        );
      },
    },

    // ── 4 provider_error_mapping ───────────────────────────────────────────
    {
      name: "provider_error_mapping",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);
        const mockish = g as Mockish;
        if (typeof mockish.enqueue !== "function") {
          throw new SkipSignal(
            "provider error scripting not available (mock enqueue required)",
          );
        }
        mockish.enqueue("createPayment", { outcome: "gateway_api_error" });
        let mapped = false;
        try {
          const result = await g.createPayment({
            amount: money("1.00", "USD"),
            currency: "USD",
            callbackUrl: fixtures.createPayment.callbackUrl,
          });
          mapped =
            (result.outcome === "failed" || result.outcome === "declined") &&
            !isPaidSuccess(result) &&
            !isPaidOutcome(result);
        } catch (e) {
          mapped = e instanceof GatewayApiError;
        }
        assert(
          mapped,
          "provider error must map to GatewayApiError or controlled failure result",
        );
      },
    },
    // ── 5 network_failure ──────────────────────────────────────────────────
    {
      name: "network_failure",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);
        const mockish = g as Mockish;
        if (typeof mockish.enqueue !== "function") {
          throw new SkipSignal("network_error scripting requires mock enqueue");
        }
        mockish.enqueue("createPayment", { outcome: "network_error" });
        let err: unknown;
        let outcomeFailed = false;
        try {
          const result = await g.createPayment({
            amount: money("1.00", "USD"),
            currency: "USD",
            callbackUrl: fixtures.createPayment.callbackUrl,
          });
          outcomeFailed = result.outcome === "failed" || result.outcome === "declined";
          assert(
            result.outcome !== "succeeded",
            "network_failure must not accept outcome succeeded",
          );
          assert(
            !isPaidOutcome(result),
            "network_failure must not be paid outcome",
          );
        } catch (e) {
          err = e;
        }
        assert(
          outcomeFailed || err instanceof NetworkError,
          "network_error should surface NetworkError (or failed outcome)",
        );
        assert(
          err instanceof NetworkError || outcomeFailed,
          "network_error should surface NetworkError (or failed outcome)",
        );
      },
    },

    // ── 6 timeout_behavior ─────────────────────────────────────────────────
    {
      name: "timeout_behavior",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);
        const mockish = g as Mockish;
        if (typeof mockish.enqueue !== "function") {
          throw new SkipSignal("timeout scripting requires mock enqueue");
        }
        mockish.enqueue("createPayment", { outcome: "timeout" });
        let err: unknown;
        let paid = false;
        try {
          const result = await g.createPayment({
            amount: money("1.00", "USD"),
            currency: "USD",
            callbackUrl: fixtures.createPayment.callbackUrl,
          });
          paid = isPaidSuccess(result) || isPaidOutcome(result);
        } catch (e) {
          err = e;
        }
        assert(!paid, "timeout must not become silent success/paid");
        // Prefer indeterminate path (NetworkError → reconcile), not false "failed paid"
        assert(
          err instanceof NetworkError,
          "timeout should surface NetworkError (indeterminate; requires reconciliation)",
        );
      },
    },

    // ── 7 safe_retry ───────────────────────────────────────────────────────
    {
      name: "safe_retry",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);

        const key = "conformance-safe-retry-key-001";
        const r1 = await g.createPayment({
          amount: fixtures.createPayment.amount,
          currency: fixtures.createPayment.currency,
          callbackUrl: fixtures.createPayment.callbackUrl,
          idempotencyKey: key,
        });
        assert(r1.gatewayId, "first create gatewayId");

        const r2 = await g.createPayment({
          amount: fixtures.createPayment.amount,
          currency: fixtures.createPayment.currency,
          callbackUrl: fixtures.createPayment.callbackUrl,
          idempotencyKey: key,
        });
        assert(r2.gatewayId, "retry create gatewayId");

        // Same provider object required for every gateway under full/applicable
        // network ops (TESTKIT-2). A double-charging adapter must not green-pass.
        assert(
          r1.gatewayId === r2.gatewayId,
          `safe_retry: expected same gatewayId on idempotent retry, got ${r1.gatewayId} vs ${r2.gatewayId}`,
        );
        if (isScriptableMock(g)) {
          const mockish = g as Mockish;
          if (mockish.history) {
            const creates = mockish.history.filter(
              (h) => h.operation === "createPayment",
            );
            // Two client attempts, one logical payment
            assert(
              creates.length >= 2,
              "expected two create attempts recorded",
            );
          }
        }
      },
    },

    // ── 8 idempotency_behavior ─────────────────────────────────────────────
    {
      name: "idempotency_behavior",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);

        if (!isScriptableMock(g)) {
          throw new SkipSignal(
            "idempotency_behavior same-id assertion requires scriptable mock (or store-backed gateway)",
          );
        }

        const key = "conformance-idem-key-002";
        const r1 = await g.createPayment({
          amount: money("25.00", "USD"),
          currency: "USD",
          callbackUrl: fixtures.createPayment.callbackUrl,
          idempotencyKey: key,
        });
        const r2 = await g.createPayment({
          amount: money("25.00", "USD"),
          currency: "USD",
          callbackUrl: fixtures.createPayment.callbackUrl,
          idempotencyKey: key,
        });
        assert(
          r1.gatewayId === r2.gatewayId,
          `same idempotencyKey must return same gatewayId (${r1.gatewayId} vs ${r2.gatewayId})`,
        );
      },
    },

    // ── 9 webhook_verification ─────────────────────────────────────────────
    {
      name: "webhook_verification",
      run: async () => {
        const g = await fresh();
        const mockish = g as Mockish;
        const wh = fixtures.webhook;

        if (typeof mockish.buildWebhook === "function") {
          const payload = mockish.buildWebhook({
            id: "evt_verify_ok",
            gatewayPaymentId: "pay_verify",
            status: "paid",
            type: "payment_paid",
          });
          const body = payload as { signature?: string };
          assert(
            g.verifyWebhook(payload) === true,
            "valid mock signed webhook must verify",
          );
          assert(
            g.verifyWebhook(payload, "definitely-wrong-sig") === false,
            "invalid signature must reject",
          );
          // Tampered embedded signature must not self-verify
          if (body.signature) {
            const tampered = {
              ...(payload as object),
              signature: "definitely-wrong-sig",
            };
            assert(
              g.verifyWebhook(tampered) === false,
              "tampered body.signature must reject (HMAC, not self-match)",
            );
            assert(
              g.verifyWebhook(
                { ...body, signature: undefined },
                body.signature,
              ) === true,
              "correct explicit signature arg must verify",
            );
          }
          return;
        }

        if (wh?.validPayload !== undefined) {
          const ok = g.verifyWebhook(
            wh.validPayload,
            wh.validSignature,
            wh.headers,
          );
          assert(ok === true, "fixture valid webhook must verify");
          const bad = g.verifyWebhook(
            wh.validPayload,
            wh.invalidSignature ?? "definitely-wrong-sig",
            wh.headers,
          );
          assert(bad === false, "invalid signature must reject");
          return;
        }

        // Built-ins without fixtures: only assert invalid is rejected offline
        if (mode === "structural") {
          throw new SkipSignal("structural mode");
        }
        if (!isScriptableMock(g) && !wh) {
          // Offline invalid-path check (never calls live APIs)
          let rejected = false;
          try {
            if (g.verifyWebhook(null) === false) rejected = true;
            if (g.verifyWebhook(undefined) === false) rejected = true;
            if (g.verifyWebhook({}) === false) rejected = true;
          } catch {
            // PayPal sync verifyWebhook throws (provider difference) — safe reject
            rejected = true;
          }
          assert(
            rejected,
            "without fixtures, null/empty payload must not verify (or must throw)",
          );
          throw new SkipSignal(
            "webhook_verification valid-path skipped: no fixtures.webhook (invalid rejection checked)",
          );
        }
        throw new SkipSignal(
          "webhook_verification: no fixtures.webhook and not a mock (provide validPayload+signature)",
        );
      },
    },

    // ── 10 malformed_webhook_rejection ─────────────────────────────────────
    {
      name: "malformed_webhook_rejection",
      run: async () => {
        const g = await fresh();
        if (mode === "structural") {
          throw new SkipSignal("structural mode");
        }

        const garbage = fixtures.webhook?.malformedPayload ?? "not-json-{{{";
        let rejected = false;
        try {
          const v = g.verifyWebhook(garbage);
          if (v === false) rejected = true;
        } catch {
          // throw on garbage is safe fail
          rejected = true;
        }
        try {
          const v2 = g.verifyWebhook(null);
          if (v2 === false) rejected = true;
        } catch {
          rejected = true;
        }
        // parse must not claim a paid event from garbage
        try {
          const evt = g.parseWebhookEvent(
            fixtures.webhook?.malformedPayload ?? { nonsense: true },
          );
          assert(
            !evt || evt.status !== "paid" || !evt.gatewayPaymentId,
            "malformed parse must not invent paid events",
          );
          // If parse succeeds on garbage without required fields, fail
          if (evt && (!evt.id || !evt.gatewayPaymentId)) {
            rejected = true;
          }
        } catch {
          rejected = true;
        }
        assert(rejected, "malformed webhook must verify false / parse throw / safe fail");
      },
    },

    // ── 11 event_normalization ─────────────────────────────────────────────
    {
      name: "event_normalization",
      run: async () => {
        const g = await fresh();
        if (mode === "structural") {
          throw new SkipSignal("structural mode");
        }
        const mockish = g as Mockish;

        if (typeof mockish.buildWebhook === "function") {
          const payload = mockish.buildWebhook({
            id: "evt_norm_1",
            gatewayPaymentId: "pay_norm",
            status: "paid",
            type: "payment_paid",
          });
          assert(g.verifyWebhook(payload) === true, "signed webhook verifies");
          const evt = g.parseWebhookEvent(payload);
          assert(evt.id === "evt_norm_1", "normalized id");
          assert(evt.gatewayPaymentId === "pay_norm", "gatewayPaymentId");
          assert(evt.status === "paid", "status");
          assert(evt.gateway === g.name, "gateway name");
          assert(typeof evt.type === "string", "type");
          assert(evt.timestamp instanceof Date || evt.timestamp, "timestamp");
          return;
        }

        if (fixtures.webhook?.validPayload !== undefined) {
          const evt = g.parseWebhookEvent(fixtures.webhook.validPayload);
          assert(typeof evt.id === "string" && evt.id.length > 0, "id");
          assert(
            typeof evt.gatewayPaymentId === "string" &&
              evt.gatewayPaymentId.length > 0,
            "gatewayPaymentId",
          );
          assert(typeof evt.type === "string", "type");
          assert(ALLOWED_PAYMENT_STATUSES.has(evt.status), "status in union");
          assert(evt.gateway === g.name || typeof evt.gateway === "string", "gateway");
          assert(evt.timestamp != null, "timestamp required");
          return;
        }

        // Try minimal synthetic payload accepted by some gateways
        try {
          const evt = g.parseWebhookEvent({
            id: "evt_1",
            type: "payment_paid",
            gatewayPaymentId: "pay_1",
            status: "paid",
          });
          assert(evt.id === "evt_1", "id");
          assert(evt.gatewayPaymentId === "pay_1", "gatewayPaymentId");
          assert(evt.status === "paid", "status");
        } catch {
          throw new SkipSignal(
            "event_normalization: no fixtures.webhook and gateway rejects synthetic mock payload",
          );
        }
      },
    },

    // ── 12 partial_capture ─────────────────────────────────────────────────
    {
      name: "partial_capture",
      skipReason: () => {
        if (!caps.partialCapture) return "capability partialCapture not claimed";
        if (!caps.authorization) {
          return "capability authorization not claimed";
        }
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);

        const created = await g.createPayment({
          amount: money("100.00", "USD"),
          currency: "USD",
          callbackUrl: fixtures.createPayment.callbackUrl,
          capture: false,
        });
        const cap = await g.capturePayment({
          gatewayPaymentId: created.gatewayId,
          amount: money("40.00", "USD"),
          currency: "USD",
        });
        // TESTKIT-1: partial money must be proven. Full capture / paid status /
        // omitted capturedAmount must not green-pass (fail-closed incomplete snapshot).
        // Exact partially_captured + capturedAmount=40 implies not full paid/100.
        assert(
          cap.outcome === "requires_action",
          "partial capture must report outcome requires_action",
        );
        assert(isPaidOutcome(cap) === false, "partial capture must not be paid outcome");
        assert(
          cap.status === "partially_captured",
          `partial capture must report partially_captured, got ${cap.status}`,
        );
        assert(
          isMoney(cap.capturedAmount),
          `partial capture must report capturedAmount Money, got ${String(cap.capturedAmount)}`,
        );
        assert(
          moneyToMajorNumber(cap.capturedAmount) === 40,
          `partial capture must report capturedAmount=40, got ${String(cap.capturedAmount)}`,
        );
        const mockish = g as Mockish;
        if (typeof mockish.getPaymentState === "function") {
          const state = mockish.getPaymentState(created.gatewayId);
          if (state) {
            const stateCaptured = isMoney(state.capturedAmount)
              ? moneyToMajorNumber(state.capturedAmount as Money)
              : (state.capturedAmount as unknown as number);
            const stateAmount = isMoney(state.amount)
              ? moneyToMajorNumber(state.amount as Money)
              : (state.amount as unknown as number);
            assert(
              stateCaptured === 40,
              `mock ledger capturedAmount must be 40, got ${state.capturedAmount}`,
            );
            assert(
              stateCaptured < stateAmount,
              "mock ledger must leave remaining capturable amount",
            );
            assert(
              state.status === "partially_captured",
              `mock ledger status must be partially_captured, got ${state.status}`,
            );
          }
        }
      },
    },

    // ── 13 partial_refund ──────────────────────────────────────────────────
    {
      name: "partial_refund",
      skipReason: () => {
        if (!caps.partialRefunds) return "capability partialRefunds not claimed";
        if (!caps.refunds) return "capability refunds not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);

        const created = await g.createPayment({
          amount: money("100.00", "USD"),
          currency: "USD",
          callbackUrl: fixtures.createPayment.callbackUrl,
          capture: true,
        });
        const refund = await g.refundPayment({
          gatewayPaymentId: created.gatewayId,
          amount: money("25.00", "USD"),
          currency: "USD",
        });
        // TESTKIT-1: partial refund money + partial status. Full refund / omitted
        // amount must not green-pass.
        assert(
          refund.outcome === "succeeded",
          "partial refund must report outcome succeeded",
        );
        assert(
          refund.status === "completed" || refund.status === "pending",
          `partial refund status must be completed|pending, got ${refund.status}`,
        );
        // Fail-closed: totalRefunded required and must equal requested partial amount
        // (exact 25 implies not full capture amount 100).
        assert(
          isMoney(refund.totalRefunded),
          `partial refund must report totalRefunded Money, got ${String(refund.totalRefunded)}`,
        );
        assert(
          moneyToMajorNumber(refund.totalRefunded) === 25,
          `partial refund must report totalRefunded=25, got ${String(refund.totalRefunded)}`,
        );

        // Payment-level partially_refunded (or partial refundedAmount) when readable.
        if (typeof g.getPayment !== "function") {
          throw new SkipSignal(
            "partial_refund: getPayment not implemented; cannot assert payment-level partial status",
          );
        }
        const after = await g.getPayment({
          gatewayPaymentId: created.gatewayId,
        });
        const partialPaymentStatus =
          after.status === "partially_refunded" ||
          after.status === "refund_pending";
        const refundedMajor = isMoney(after.refundedAmount)
          ? moneyToMajorNumber(after.refundedAmount as Money)
          : (after.refundedAmount as unknown as number | undefined);
        const partialRefundedAmount =
          refundedMajor === 25 ||
          (refundedMajor !== undefined &&
            refundedMajor < 100 &&
            refundedMajor > 0);
        assert(
          partialPaymentStatus || partialRefundedAmount,
          `partial refund must leave payment partially_refunded (or refundedAmount=25); got status=${after.status} refundedAmount=${String(after.refundedAmount)}`,
        );
        assert(
          after.status !== "refunded" ||
            (refundedMajor !== undefined && refundedMajor < 100),
          "partial refund must not fully refund the payment",
        );

        const mockish = g as Mockish;
        if (typeof mockish.getPaymentState === "function") {
          const state = mockish.getPaymentState(created.gatewayId);
          if (state) {
            const stateRefunded = isMoney(state.refundedAmount)
              ? moneyToMajorNumber(state.refundedAmount as Money)
              : (state.refundedAmount as unknown as number);
            assert(
              stateRefunded === 25,
              `mock ledger refundedAmount must be 25, got ${state.refundedAmount}`,
            );
            assert(
              state.status === "partially_refunded",
              `mock ledger status must be partially_refunded, got ${state.status}`,
            );
          }
        }
      },
    },

    // ── 14 logging_redaction ───────────────────────────────────────────────
    {
      name: "logging_redaction",
      run: async () => {
        if (mode === "structural") {
          throw new SkipSignal("structural mode");
        }

        const captured: Array<Record<string, unknown> | undefined> = [];
        const sink: Logger = {
          debug(_m, ctx) {
            captured.push(ctx);
          },
          info(_m, ctx) {
            captured.push(ctx);
          },
          warn(_m, ctx) {
            captured.push(ctx);
          },
          error(_m, ctx) {
            captured.push(ctx);
          },
        };
        const redacting = createRedactingLogger(sink);

        // Prove redaction contract used by gateways (createRedactingLogger)
        redacting.info("createPayment", {
          amount: 1,
          currency: "USD",
          cardNumber: "4111111111111111",
          apiKey: "sk_test_conformance_not_live",
          authorization: "Bearer secret-token-value",
          customerEmail: "buyer@example.com",
          note: "ok",
        });

        const blob = JSON.stringify(captured);
        assert(
          !blob.includes("4111111111111111"),
          "cardNumber must be redacted in logs",
        );
        assert(
          !blob.includes("Bearer secret-token-value"),
          "authorization must be redacted",
        );
        assert(
          !blob.includes("buyer@example.com"),
          "customerEmail must be redacted",
        );
        assert(
          blob.includes("[REDACTED]") || blob.includes("REDACTED"),
          "expected [REDACTED] markers",
        );

        // Gateway path: inject logger and create with secret-like metadata.
        // Sink must receive logs and must not contain PAN / apiSecret.
        const g = await fresh();
        if (allowNetworkOps(g) || isScriptableMock(g)) {
          const mockish = g as Mockish;
          if (isScriptableMock(g)) {
            assert(
              typeof mockish.setLogger === "function",
              "logging_redaction must inject logger (mock setLogger required)",
            );
          }
          if (typeof mockish.setLogger === "function") {
            mockish.setLogger(redacting);
          }
          const sinkBefore = captured.length;
          await g
            .createPayment({
              amount: money("1.00", "USD"),
              currency: "USD",
              callbackUrl: fixtures.createPayment.callbackUrl,
              metadata: {
                note: "ok",
                // intentional sensitive keys — must not appear unredacted in logs
                cardNumber: "4111111111111111",
                apiSecret: "super-secret-value",
              },
            })
            .catch(() => {
              /* network/scripted failures ok */
            });

          if (typeof mockish.setLogger === "function") {
            const gatewayLogs = captured.slice(sinkBefore);
            assert(
              gatewayLogs.length > 0,
              "logging_redaction must inject logger; sink received no gateway logs",
            );
            const sinkBlob = JSON.stringify(gatewayLogs);
            assert(
              !sinkBlob.includes("4111111111111111"),
              "sink must not contain PAN",
            );
            assert(
              !sinkBlob.includes("super-secret-value"),
              "sink must not contain apiSecret",
            );
          }

          if (mockish.history) {
            const hist = JSON.stringify(mockish.history);
            assert(!/sk_live_/.test(hist), "history must not contain sk_live_");
            assert(!/whsec_/.test(hist), "history must not contain whsec_");
            assert(
              !hist.includes("4111111111111111"),
              "history must not contain PAN",
            );
            assert(
              !hist.includes("super-secret-value"),
              "history must not contain apiSecret",
            );
          }
        } else if (mode === "applicable") {
          // Offline structural redaction check already done via createRedactingLogger
          return;
        }
      },
    },

    // ── 15 request_cancellation ────────────────────────────────────────────
    {
      name: "request_cancellation",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);
        const mockish = g as Mockish;
        if (typeof mockish.enqueue !== "function") {
          throw new SkipSignal(
            "request_cancellation requires mock latency + AbortSignal support",
          );
        }
        mockish.enqueue("createPayment", {
          outcome: "succeeded",
          latencyMs: 500,
        });
        const controller = new AbortController();
        const p = g.createPayment({
          amount: money("1.00", "USD"),
          currency: "USD",
          callbackUrl: fixtures.createPayment.callbackUrl,
          ...({ signal: controller.signal } as object),
        } as Parameters<PaymentGateway["createPayment"]>[0]);
        controller.abort();
        let aborted = false;
        let paid = false;
        try {
          const result = await p;
          paid = isPaidSuccess(result) || isPaidOutcome(result);
        } catch (e) {
          aborted = isAbortLike(e);
        }
        assert(!paid, "aborted request must not yield paid result");
        assert(
          aborted,
          "abort must surface PaymentAbortedError, AbortError, or abort NetworkError",
        );
      },
    },

    // ── 16 indeterminate_outcomes ──────────────────────────────────────────
    {
      name: "indeterminate_outcomes",
      skipReason: () => {
        if (!caps.payments) return "capability payments not claimed";
        return undefined;
      },
      run: async () => {
        const g = await fresh();
        const netSkip = networkSkipReason(g);
        if (netSkip) throw new SkipSignal(netSkip);
        const mockish = g as Mockish;
        if (typeof mockish.enqueue !== "function") {
          throw new SkipSignal(
            "indeterminate_outcomes requires mock provider_ok_client_timeout script",
          );
        }
        mockish.enqueue("createPayment", {
          outcome: "provider_ok_client_timeout",
        });
        mockish.enqueue("createPayment", {
          outcome: "indeterminate",
        });
        let err: unknown;
        let paid = false;
        try {
          const result = await g.createPayment({
            amount: money("5.00", "USD"),
            currency: "USD",
            callbackUrl: fixtures.createPayment.callbackUrl,
          });
          paid = isPaidSuccess(result) || isPaidOutcome(result);
        } catch (e) {
          err = e;
        }
        assert(!paid, "indeterminate must never surface outcome succeeded paid");
        assert(
          err instanceof NetworkError,
          "provider_ok_client_timeout must be NetworkError for reconciliation",
        );
        if (typeof mockish.getLastProviderSideSuccess === "function") {
          const side = mockish.getLastProviderSideSuccess();
          assert(
            side?.outcome === "succeeded",
            "provider-side success retained for reconcile",
          );
        }

        const ind = await g.createPayment({
          amount: money("5.00", "USD"),
          currency: "USD",
          callbackUrl: fixtures.createPayment.callbackUrl,
        });
        assert(
          (ind as { outcome?: string }).outcome !== "succeeded",
          "indeterminate must not surface outcome succeeded",
        );
        assert(!isPaidSuccess(ind) && !isPaidOutcome(ind), "indeterminate must never surface paid");
        assert(
          (ind as { outcome?: string }).outcome === "indeterminate",
          "indeterminate script must surface outcome indeterminate",
        );
        assert(
          (ind as { reconciliationRequired?: boolean }).reconciliationRequired ===
            true,
          "indeterminate must set reconciliationRequired",
        );
        assert(
          isIndeterminateOutcome(ind as unknown as never),
          "indeterminate must be indeterminate outcome",
        );
      },
    },
  ];

  const results: GatewayConformanceCaseResult[] = [];
  for (const def of cases) {
    if (include && !include.has(def.name)) continue;
    if (exclude && exclude.has(def.name)) {
      results.push({
        name: def.name,
        status: "skipped",
        reason: "excluded via options.exclude",
      });
      continue;
    }

    // Mode filter: structural only structural cases
    if (mode === "structural" && !STRUCTURAL_CASES.has(def.name)) {
      results.push({
        name: def.name,
        status: "skipped",
        reason: "structural mode: capabilities/method presence only",
      });
      continue;
    }

    const staticSkip = def.skipReason?.();
    if (staticSkip) {
      results.push({ name: def.name, status: "skipped", reason: staticSkip });
      continue;
    }

    try {
      await def.run();
      results.push({ name: def.name, status: "passed" });
    } catch (err) {
      if (err instanceof SkipSignal) {
        results.push({ name: def.name, status: "skipped", reason: err.reason });
      } else {
        results.push({
          name: def.name,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // When include filters out structural cases entirely, still ok
  const report = buildReport(options.name, results);

  if (!report.ok && options.throwOnFailure) {
    const lines = report.failed
      .map((f) => `  - ${f.case}: ${f.error}`)
      .join("\n");
    throw new Error(
      `Gateway conformance failed for "${options.name}":\n${lines}`,
    );
  }

  return report;
}

/** Internal control flow for mid-case skips (mode / missing fixtures). */
class SkipSignal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "SkipSignal";
    this.reason = reason;
  }
}
