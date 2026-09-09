import { describe, expect, it } from "bun:test";
import {
  CardDeclinedError,
  GatewayApiError,
  InvalidRequestError,
  NetworkError,
  OperationNotSupportedError,
  defineGatewayCapabilities,
  isIndeterminateOutcome,
  isPaidOutcome,
  isPaymentEvent,
  isPaymentSucceededEvent,
  isRequiresActionOutcome,
  money,
  toMinorUnits,
  minorAmountToNumber,
  PAYMENT_EVENT_SCHEMA_VERSION,
} from "@paykernel/core";
import {
  mockGateway,
  majorToMinor,
  minorToMajor,
  withDuplicateWebhook,
  outOfOrderWebhooks,
  generateDuplicateWebhooks,
  generateOutOfOrderWebhooks,
  generateWebhookEvent,
  mockPayloadToWebhookEvent,
  createMockWebhookPayload,
  signWebhook,
  computeMockWebhookSignature,
  createFakeClock,
  paymentStatusToOperationOutcome,
} from "../index";

const baseCreate = {
  amount: money("10.00", "USD"),
  currency: "USD" as const,
  callbackUrl: "https://ex.test/cb",
};

describe("paymentStatusToOperationOutcome", () => {
  it("maps paid → succeeded and approved → requires_action (not paid-like)", () => {
    expect(paymentStatusToOperationOutcome("paid")).toBe("succeeded");
    expect(paymentStatusToOperationOutcome("approved")).toBe("requires_action");
    expect(paymentStatusToOperationOutcome("pending")).toBe("requires_action");
    expect(paymentStatusToOperationOutcome("authorized")).toBe("succeeded");
  });

  it("does not map refund_failed or unknown to succeeded (TESTKIT-4)", () => {
    expect(paymentStatusToOperationOutcome("refund_failed")).toBe("failed");
    expect(paymentStatusToOperationOutcome("failed")).toBe("failed");
    expect(
      paymentStatusToOperationOutcome("not_a_status" as never),
    ).toBe("failed");
    expect(paymentStatusToOperationOutcome("refund_completed")).toBe(
      "succeeded",
    );
    const snapshot = {
      gatewayId: "pay_x",
      status: "refund_failed" as const,
      outcome: paymentStatusToOperationOutcome("refund_failed"),
    };
    expect(snapshot.outcome).toBe("failed");
    expect(isPaidOutcome(snapshot)).toBe(false);
  });
});

describe("mockGateway", () => {
  it("scripts outcomes FIFO", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "requires_action" }, { outcome: "succeeded" }],
    });
    const a = await g.createPayment({
      amount: money("10.00", "SAR"),
      currency: "SAR",
      callbackUrl: "https://ex.test/cb",
    });
    expect(a.status).toBe("pending");
    expect(a.redirectUrl).toBeTruthy();
    expect(a.outcome).toBe("requires_action");
    expect("success" in a).toBe(false); // 1.0: success removed; not paid
    expect(isRequiresActionOutcome(a)).toBe(true);
    expect(isPaidOutcome(a)).toBe(false);
    expect(a.references?.providerObjectId).toBe(a.gatewayId);
    expect(a.references?.gateway).toBe("mock");
    const b = await g.createPayment({
      amount: money("10.00", "SAR"),
      currency: "SAR",
      callbackUrl: "https://ex.test/cb",
    });
    expect(b.status).toBe("paid");
    expect(b.outcome).toBe("succeeded");
    expect(isPaidOutcome(b)).toBe(true);
    expect(b.references?.normalizedStatus).toBe("paid");
  });

  it("replays last step after queue exhaustion", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "declined" }],
    });
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      CardDeclinedError,
    );
    // Last step replayed
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      CardDeclinedError,
    );
  });

  it("uses explicit defaultOutcome when queues empty", async () => {
    const g = mockGateway({
      defaultOutcome: { outcome: "requires_action" },
    });
    const r = await g.createPayment(baseCreate);
    expect(r.status).toBe("pending");
    expect(r.redirectUrl).toBeTruthy();
    expect(r.outcome).toBe("requires_action");
    expect(isPaidOutcome(r)).toBe(false);
  });

  it("maps declines and records history with error summary", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "declined" }],
    });
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      CardDeclinedError,
    );
    expect(g.history.some((h) => h.operation === "createPayment")).toBe(true);
    const rec = g.history.find((h) => h.operation === "createPayment");
    expect(rec?.error?.name).toBe("CardDeclinedError");
    // Never store raw Error.message (may carry secrets)
    expect(rec?.error?.message).toBe("[REDACTED]");
  });

  it("history redacts error messages that look like secrets", async () => {
    const g = mockGateway({
      createPayment: [
        { throw: new Error("Card sk_live_SECRET_TOKEN_12345 declined") },
      ],
    });
    await expect(g.createPayment(baseCreate)).rejects.toThrow(/sk_live/);
    const rec = g.history.find((h) => h.operation === "createPayment");
    expect(rec?.error?.name).toBe("Error");
    expect(rec?.error?.message).toBe("[REDACTED]");
    expect(JSON.stringify(g.getHistory())).not.toContain("sk_live");
  });

  it("provider_ok_client_timeout dual outcome records ledger success", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "provider_ok_client_timeout" }],
    });
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      NetworkError,
    );
    const side = g.getLastProviderSideSuccess();
    expect(side?.outcome).toBe("succeeded");
    expect(side?.status).toBe("paid");
    expect(side?.references?.providerObjectId).toBe(side?.gatewayId);
    // Provider-side payment exists for reconciliation
    expect(g.getPaymentState(side!.gatewayId)?.status).toBe("paid");
  });

  it("accepts provider_success_client_timeout alias", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "provider_success_client_timeout" }],
    });
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(g.getLastProviderSideSuccess()?.outcome).toBe("succeeded");
  });

  it("indeterminate outcome is Phase 6 arm, never decline/paid", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "indeterminate" }],
    });
    const r = await g.createPayment(baseCreate);
    expect(r.outcome).toBe("indeterminate");
    expect("success" in r).toBe(false); // 1.0: success removed — do not treat as decline
    expect(r.status).toBe("processing");
    expect(r.reconciliationRequired).toBe(true);
    expect(isIndeterminateOutcome(r)).toBe(true);
    expect(isPaidOutcome(r)).toBe(false);
    expect(r.references?.providerObjectId).toBe(r.gatewayId);
    const raw = r.rawResponse as {
      reconciliationRequired?: boolean;
      error?: { code?: string };
    };
    expect(raw.reconciliationRequired).toBe(true);
    expect(raw.error?.code).toBe("INDETERMINATE");
  });

  it("failed outcome is definitive failed status failed", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "failed" }],
    });
    const r = await g.createPayment(baseCreate);
    expect(r.outcome).toBe("failed");
    expect(r.status).toBe("failed");
    expect(isPaidOutcome(r)).toBe(false);
    expect(r.references?.normalizedStatus).toBe("failed");
    // Ledger must be honest failed — never leave paid + full capture hanging
    const state = g.getPaymentState(r.gatewayId);
    expect(state).toBeDefined();
    expect(state!.status).toBe("failed");
    expect(state!.status).not.toBe("paid");
    expect(state!.capturedAmount).toBe(0);
    expect(state!.authorized).toBe(false);
  });

  it("default/succeeded createPayment still writes paid ledger", async () => {
    const gDefault = mockGateway();
    const d = await gDefault.createPayment(baseCreate);
    expect(d.outcome).toBe("succeeded");
    expect(d.status).toBe("paid");
    const dState = gDefault.getPaymentState(d.gatewayId);
    expect(dState?.status).toBe("paid");
    expect(dState?.capturedAmount).toBe(10);
    expect(dState?.authorized).toBe(false);

    const gScripted = mockGateway({
      createPayment: [{ outcome: "succeeded" }],
    });
    const s = await gScripted.createPayment(baseCreate);
    expect(s.outcome).toBe("succeeded");
    expect(s.status).toBe("paid");
    const sState = gScripted.getPaymentState(s.gatewayId);
    expect(sState?.status).toBe("paid");
    expect(sState?.capturedAmount).toBe(10);
  });

  it("throw form steps", async () => {
    const g = mockGateway({
      createPayment: [
        { throw: "abort" },
        { throw: new Error("custom boom") },
      ],
    });
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      NetworkError,
    );
    await expect(g.createPayment(baseCreate)).rejects.toThrow("custom boom");
  });

  it("delayMs alias and FakeClock virtual latency", async () => {
    const clock = createFakeClock({ initialMs: 1_000 });
    const g = mockGateway({
      clock,
      createPayment: [{ outcome: "succeeded", delayMs: 250 }],
    });
    const start = clock.nowMs();
    const r = await g.createPayment(baseCreate);
    expect(r.outcome).toBe("succeeded");
    expect(isPaidOutcome(r)).toBe(true);
    expect(clock.nowMs() - start).toBe(250);
    expect(g.history[0]?.atMs).toBe(1_250);
  });

  it("timeout and network_error throw NetworkError", async () => {
    const g = mockGateway({
      createPayment: [
        { outcome: "timeout" },
        { outcome: "network_error" },
      ],
    });
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      NetworkError,
    );
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("timeout does not leave paid ledger", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "timeout" }],
    });
    await expect(g.createPayment(baseCreate)).rejects.toBeInstanceOf(
      NetworkError,
    );
    // Plain timeout never calls provider success path; no paid reconciliation entry
    expect(g.getLastProviderSideSuccess()).toBeUndefined();
    // History records the failed call but no payment ledger was written as paid
    const rec = g.history.find((h) => h.operation === "createPayment");
    expect(rec?.error?.name).toBe("NetworkError");
    expect(rec?.result).toBeUndefined();
    // Known ids from dual-timeout/success paths would be pay_mock_N; timeout still
    // allocates an id internally but must not leave it as paid in the ledger.
    // Probe sequential ids that would exist if fallback had written paid.
    for (let i = 1; i <= 3; i++) {
      const state = g.getPaymentState(`pay_mock_${i}`);
      if (state) {
        expect(state.status).not.toBe("paid");
        expect(state.capturedAmount).toBe(0);
      }
    }
  });

  it("partial capture and refund with remaining tracking", async () => {
    const g = mockGateway({
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    const pay = await g.createPayment({
      amount: money("100.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: false,
    });
    expect(pay.status).toBe("authorized");
    const cap = await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("40.00", "USD"),
      currency: "USD",
    });
    expect(cap.status).toBe("partially_captured");
    const full = await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("60.00", "USD"),
      currency: "USD",
    });
    expect(full.status).toBe("paid");
    const ref = await g.refundPayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("10.00", "USD"),
      currency: "USD",
    });
    expect(ref.outcome).toBe("succeeded");
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("partially_refunded");
  });

  it("rejects over-capture and over-refund", async () => {
    const g = mockGateway();
    const pay = await g.createPayment({
      amount: money("50.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: false,
    });
    await expect(
      g.capturePayment({
        gatewayPaymentId: pay.gatewayId,
        amount: money("51.00", "USD"),
        currency: "USD",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);

    const paid = await g.createPayment({
      amount: money("20.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: true,
    });
    await expect(
      g.refundPayment({
        gatewayPaymentId: paid.gatewayId,
        amount: money("21.00", "USD"),
        currency: "USD",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("concurrent partial captures serialize and reject over-capture (TESTKIT-1)", async () => {
    const g = mockGateway({
      defaultLatencyMs: 1,
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    const pay = await g.createPayment({
      amount: money("100.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: false,
    });
    // Two concurrent captures for the full remaining amount: only one may settle.
    const results = await Promise.allSettled([
      g.capturePayment({
        gatewayPaymentId: pay.gatewayId,
        amount: money("100.00", "USD"),
        currency: "USD",
      }),
      g.capturePayment({
        gatewayPaymentId: pay.gatewayId,
        amount: money("100.00", "USD"),
        currency: "USD",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InvalidRequestError,
    );
    const state = g.getPaymentState(pay.gatewayId)!;
    expect(state.capturedAmount).toBe(100);
    expect(state.status).toBe("paid");
  });

  it("concurrent partial captures that fit remaining both settle without over-capture (TESTKIT-1)", async () => {
    const g = mockGateway({
      defaultLatencyMs: 1,
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    const pay = await g.createPayment({
      amount: money("100.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: false,
    });
    const [a, b] = await Promise.all([
      g.capturePayment({
        gatewayPaymentId: pay.gatewayId,
        amount: money("40.00", "USD"),
        currency: "USD",
      }),
      g.capturePayment({
        gatewayPaymentId: pay.gatewayId,
        amount: money("60.00", "USD"),
        currency: "USD",
      }),
    ]);
    expect(a.outcome).toBe("requires_action");
    expect(b.outcome).toBe("succeeded");
    const state = g.getPaymentState(pay.gatewayId)!;
    expect(state.capturedAmount).toBe(100);
    expect(state.status).toBe("paid");
  });

  it("concurrent partial refunds serialize and reject over-refund (TESTKIT-1)", async () => {
    const g = mockGateway({
      defaultLatencyMs: 1,
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    const paid = await g.createPayment({
      amount: money("50.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: true,
    });
    const results = await Promise.allSettled([
      g.refundPayment({
        gatewayPaymentId: paid.gatewayId,
        amount: money("50.00", "USD"),
        currency: "USD",
      }),
      g.refundPayment({
        gatewayPaymentId: paid.gatewayId,
        amount: money("50.00", "USD"),
        currency: "USD",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InvalidRequestError,
    );
    const state = g.getPaymentState(paid.gatewayId)!;
    expect(state.refundedAmount).toBe(50);
    expect(state.status).toBe("refunded");
  });

  it("provider_ok_client_timeout preserves auth-only provider success (TESTKIT-2)", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "provider_ok_client_timeout" }],
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    await expect(
      g.createPayment({
        amount: money("30.00", "USD"),
        currency: "USD",
        callbackUrl: "https://ex.test/cb",
        capture: false,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    const side = g.getLastProviderSideSuccess();
    expect(side?.status).toBe("authorized");
    expect(side?.outcome).toBe("succeeded");
    expect(isPaidOutcome(side!)).toBe(false);
    const state = g.getPaymentState(side!.gatewayId)!;
    expect(state.status).toBe("authorized");
    expect(state.capturedAmount).toBe(0);
    expect(state.authorized).toBe(true);
  });

  it("amount conversion minor units in rawResponse", async () => {
    const g = mockGateway();
    const r = await g.createPayment({
      amount: money("10.50", "SAR"),
      currency: "SAR",
      callbackUrl: "https://ex.test/cb",
    });
    const raw = r.rawResponse as { amountMinor: number };
    expect(raw.amountMinor).toBe(majorToMinor(10.5, "SAR"));
    expect(raw.amountMinor).toBe(1050);
    // Shared core bigint path (not silent Math.round float)
    expect(raw.amountMinor).toBe(
      minorAmountToNumber(toMinorUnits(10.5, "SAR")),
    );
  });

  it("majorToMinor / minorToMajor use core money helpers", () => {
    expect(majorToMinor(10.5, "SAR")).toBe(1050);
    expect(majorToMinor(100, "JPY")).toBe(100);
    expect(majorToMinor(1.234, "KWD")).toBe(1234);
    expect(majorToMinor(money("10.50", "SAR"), "SAR")).toBe(1050);
    expect(minorToMajor(1050, "SAR")).toBe(10.5);
    // Strict precision — no silent float rounding
    expect(() => majorToMinor(10.999, "SAR")).toThrow(InvalidRequestError);
    expect(() => majorToMinor(0.1 + 0.2, "SAR")).toThrow(InvalidRequestError);
  });

  it("accepts Money amount input on createPayment", async () => {
    const g = mockGateway();
    const r = await g.createPayment({
      amount: money("10.50", "SAR"),
      currency: "SAR",
      callbackUrl: "https://ex.test/cb",
    });
    expect(r.outcome).toBe("succeeded");
    expect(isPaidOutcome(r)).toBe(true);
    expect(r.amount).toEqual(money("10.50", "SAR"));
    expect(r.references?.gateway).toBe("mock");
    const raw = r.rawResponse as { amountMinor: number };
    expect(raw.amountMinor).toBe(1050);
  });

  it("tracks partial capture remaining in integer minor units", async () => {
    const g = mockGateway({
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    const pay = await g.createPayment({
      amount: money("10.50", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: false,
    });
    const cap = await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("4.25", "USD"),
      currency: "USD",
    });
    expect(cap.status).toBe("partially_captured");
    expect(cap.capturedAmount).toEqual(money("4.25", "USD"));
    const state = g.getPaymentState(pay.gatewayId);
    expect(state?.amount).toBe(10.5);
    expect(state?.capturedAmount).toBe(4.25);
  });

  it("history redacts secrets and assertHistory works", async () => {
    const g = mockGateway();
    await g.createPayment({
      ...baseCreate,
      metadata: {
        note: "ok",
        apiKey: "sk_test_fake_should_redact",
        cardNumber: "4242424242424242",
      },
    });
    const blob = JSON.stringify(g.getHistory());
    expect(blob).not.toContain("sk_test_fake_should_redact");
    expect(blob).not.toContain("4242424242424242");
    expect(blob).toContain("[REDACTED]");

    g.assertHistory([
      {
        operation: "createPayment",
        result: {
          status: "paid",
          outcome: "succeeded",
        },
      },
    ]);
    expect(() =>
      g.assertHistory([{ operation: "refundPayment" }]),
    ).toThrow(/assertHistory/);
  });

  it("webhook HMAC sign / verify / OOO / duplicate", () => {
    const g = mockGateway({ name: "mock" });
    const a = g.buildWebhook({
      id: "e1",
      sequence: 1,
      gatewayPaymentId: "p1",
      status: "paid",
    });
    const b = g.buildWebhook({
      id: "e2",
      sequence: 2,
      gatewayPaymentId: "p1",
      status: "paid",
    });
    expect(a.signature?.startsWith("mocksig_")).toBe(true);
    expect(g.verifyWebhook(a)).toBe(true);
    expect(g.verifyWebhook(a, "bad")).toBe(false);
    expect(g.signWebhook(a)).toBe(
      computeMockWebhookSignature(a, "testkit_mock_secret"),
    );

    // Tampered body.signature alone must not self-verify (HMAC compare only).
    const tampered = { ...a, signature: "mocksig_deadbeef" };
    expect(g.verifyWebhook(tampered)).toBe(false);
    expect(g.verifyWebhook(tampered, "mocksig_deadbeef")).toBe(false);
    // Matching wrong external + body signature still fails vs computed HMAC.
    expect(g.verifyWebhook({ ...a, signature: "x" }, "x")).toBe(false);
    // Correct explicit signature still works
    expect(g.verifyWebhook({ ...a, signature: undefined }, a.signature)).toBe(
      true,
    );

    const dup = withDuplicateWebhook([a, b]);
    expect(dup).toHaveLength(3);
    expect(generateDuplicateWebhooks([a, b])).toHaveLength(3);
    const ooo = outOfOrderWebhooks([a, b]);
    expect(ooo[0]?.sequence).toBe(2);
    expect(generateOutOfOrderWebhooks([a, b])[0]?.sequence).toBe(2);

    const evt = g.parseWebhookEvent(a);
    expect(evt.gateway).toBe("mock");
    expect(evt.status).toBe("paid");
    // Phase 7 dual-write on parseWebhookEvent
    expect(evt.schemaVersion).toBe(PAYMENT_EVENT_SCHEMA_VERSION);
    expect(evt.type).toBe("payment_paid"); // legacy free-form preserved
    expect(evt.stableType).toBe("payment.succeeded");
    expect(evt.event).toBeDefined();
    expect(isPaymentEvent(evt.event)).toBe(true);
    expect(evt.event?.type).toBe("payment.succeeded");
    expect(evt.provider?.eventType).toBe("payment_paid");
    expect(evt.provider?.gateway).toBe("mock");
    expect(typeof evt.provider?.occurredAt).toBe("string");
    expect(typeof evt.provider?.receivedAt).toBe("string");
    expect(evt.rawPayload).toBeDefined();

    const generated = generateWebhookEvent({
      gatewayPaymentId: "p9",
      status: "paid",
      type: "payment_paid",
    });
    expect(generated.signature.startsWith("mocksig_")).toBe(true);
    expect(generated.event.gatewayPaymentId).toBe("p9");
    expect(signWebhook(generated.raw)).toBe(generated.signature);
    expect(generated.event.stableType).toBe("payment.succeeded");
    expect(generated.event.event?.schemaVersion).toBe("1");
  });

  it("webhookHelpers.signWebhook and generateWebhookEvent bind instance secret and name (P05-TK-3)", () => {
    const secret = "instance_bound_secret";
    const g = mockGateway({ name: "acme", webhookSecret: secret });
    const payload = createMockWebhookPayload({
      id: "e_bound",
      type: "payment_paid",
      gatewayPaymentId: "pay_bound",
    });
    expect(g.webhookHelpers.signWebhook(payload)).toBe(
      computeMockWebhookSignature(payload, secret),
    );
    expect(g.webhookHelpers.signWebhook(payload)).toBe(g.signWebhook(payload));
    expect(g.webhookHelpers.signWebhook(payload)).not.toBe(
      signWebhook(payload),
    );

    const generated = g.webhookHelpers.generateWebhookEvent({
      id: "e_gen",
      gatewayPaymentId: "pay_bound",
      status: "paid",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    expect(generated.event.gateway).toBe("acme");
    expect(generated.signature).toBe(
      computeMockWebhookSignature(generated.raw, secret),
    );
    expect(g.verifyWebhook(generated.raw)).toBe(true);
    expect(
      g.generateWebhookEvent({
        id: "e_gen",
        gatewayPaymentId: "pay_bound",
        status: "paid",
        createdAt: "2024-01-01T00:00:00.000Z",
      }).event.gateway,
    ).toBe("acme");
  });

  it("Phase 7 dual-write: stable type option and free-form mapping", () => {
    // Stable name as type → PaymentEvent.type matches; free-form type is that name
    const stable = generateWebhookEvent({
      type: "payment.succeeded",
      status: "paid",
      gatewayPaymentId: "pay_stable",
      computePayloadHash: true,
    });
    expect(stable.event.type).toBe("payment.succeeded");
    expect(stable.event.stableType).toBe("payment.succeeded");
    expect(stable.event.event?.type).toBe("payment.succeeded");
    expect(stable.event.schemaVersion).toBe("1");
    expect(stable.event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    if (stable.event.event && isPaymentSucceededEvent(stable.event.event)) {
      expect(stable.event.event.payment.references.gateway).toBe("mock");
      expect(stable.event.event.payment.references.providerObjectId).toBe(
        "pay_stable",
      );
    } else {
      throw new Error("expected payment.succeeded arm");
    }

    // Free-form refund alias
    const refund = mockPayloadToWebhookEvent(
      createMockWebhookPayload({
        type: "payment_refunded",
        status: "refunded",
        gatewayPaymentId: "pay_r1",
      }),
      "mock",
    );
    expect(refund.type).toBe("payment_refunded");
    expect(refund.stableType).toBe("refund.completed");
    expect(refund.event?.type).toBe("refund.completed");
    expect(refund.provider?.eventType).toBe("payment_refunded");

    // Built-in gateway name uses core map (Stripe native → stable)
    const stripeish = generateWebhookEvent({
      gateway: "stripe",
      type: "payment_intent.succeeded",
      status: "paid",
      gatewayPaymentId: "pi_test",
    });
    expect(stripeish.event.type).toBe("payment_intent.succeeded");
    expect(stripeish.event.stableType).toBe("payment.succeeded");
    expect(stripeish.event.provider?.eventType).toBe(
      "payment_intent.succeeded",
    );

    // TESTKIT-1: Moyasar free-form aliases must NOT dual-write under built-in
    // gateway names (stripe + payment_paid is not a production Stripe map entry).
    const stripeMoyasarAlias = mockPayloadToWebhookEvent(
      createMockWebhookPayload({
        type: "payment_paid",
        status: "paid",
        gatewayPaymentId: "pi_no_alias",
      }),
      "stripe",
    );
    expect(stripeMoyasarAlias.type).toBe("payment_paid");
    expect(stripeMoyasarAlias.stableType === "payment.succeeded").toBe(false);
    expect(
      stripeMoyasarAlias.event?.type === "payment.succeeded",
    ).toBe(false);

    // mock gateway still gets Moyasar-shaped free-form convenience dual-write
    const mockAlias = mockPayloadToWebhookEvent(
      createMockWebhookPayload({
        type: "payment_paid",
        status: "paid",
        gatewayPaymentId: "mock_paid",
      }),
      "mock",
    );
    expect(mockAlias.stableType).toBe("payment.succeeded");

    // TESTKIT-2: payment.succeeded dual-write requires paid status
    const unpaidStable = generateWebhookEvent({
      type: "payment.succeeded",
      status: "pending",
      gatewayPaymentId: "pay_unpaid",
    });
    expect(unpaidStable.event.status).toBe("pending");
    expect(unpaidStable.event.stableType).toBe("payment.processing");
    expect(unpaidStable.event.event?.type).toBe("payment.processing");
    expect(
      unpaidStable.event.event &&
        isPaymentSucceededEvent(unpaidStable.event.event),
    ).toBe(false);

    const unpaidAlias = mockPayloadToWebhookEvent(
      createMockWebhookPayload({
        type: "payment_paid",
        status: "authorized",
        gatewayPaymentId: "pay_auth_only",
      }),
      "mock",
    );
    expect(unpaidAlias.status).toBe("authorized");
    expect(unpaidAlias.stableType).toBe("payment.authorized");
    expect(unpaidAlias.event?.type).toBe("payment.authorized");

    const partialAlias = mockPayloadToWebhookEvent(
      createMockWebhookPayload({
        type: "payment_paid",
        status: "partially_captured",
        gatewayPaymentId: "pay_partial",
      }),
      "mock",
    );
    expect(partialAlias.stableType).toBe("payment.processing");
    expect(partialAlias.event?.type).toBe("payment.processing");

    // Unknown free-form → provider.unmapped (no invented stable name)
    const unknown = generateWebhookEvent({
      type: "invoice.paid",
      status: "paid",
    });
    expect(unknown.event.type).toBe("invoice.paid");
    expect(unknown.event.stableType).toBeUndefined();
    expect(unknown.event.event?.type).toBe("provider.unmapped");
  });

  it("defaults webhook status from type, not paid, for failed events (NEW-TESTKIT-8)", () => {
    const failed = createMockWebhookPayload({ type: "payment_failed" });
    expect(failed.type).toBe("payment_failed");
    expect(failed.status).toBe("failed");
    expect(failed.status).not.toBe("paid");

    const alias = createMockWebhookPayload({ type: "failed" });
    expect(alias.status).toBe("failed");

    const stripeFailed = generateWebhookEvent({
      type: "payment_intent.payment_failed",
      gatewayPaymentId: "pi_fail",
    });
    expect(stripeFailed.raw.status).toBe("failed");
    expect(stripeFailed.event.status).toBe("failed");
    expect(stripeFailed.event.status).not.toBe("paid");

    const paidDefault = createMockWebhookPayload({});
    expect(paidDefault.type).toBe("payment_paid");
    expect(paidDefault.status).toBe("paid");

    const explicit = createMockWebhookPayload({
      type: "payment_failed",
      status: "processing",
    });
    expect(explicit.status).toBe("processing");
  });

  it("history getter returns a frozen snapshot callers cannot mutate", async () => {
    const g = mockGateway();
    await g.createPayment(baseCreate);
    const snap = g.history;
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      // @ts-expect-error readonly contract
      snap.push({} as never);
    }).toThrow();
    expect(g.history).toHaveLength(1);
    expect(g.getHistory()).toHaveLength(1);
    expect(Object.isFrozen(g.getHistory())).toBe(true);
  });

  it("rejects malformed webhook parse", () => {
    const g = mockGateway();
    expect(() => g.parseWebhookEvent({})).toThrow();
    expect(() => g.parseWebhookEvent(null)).toThrow();
  });

  it("does not default missing webhook type to payment_paid (TESTKIT-3)", () => {
    const g = mockGateway();
    const typeless = {
      id: "evt_no_type",
      gatewayPaymentId: "pay_no_type",
      status: "paid" as const,
    };
    expect(() => g.parseWebhookEvent(typeless)).toThrow(GatewayApiError);
    expect(() => g.parseWebhookEvent({ ...typeless, type: "" })).toThrow(
      GatewayApiError,
    );
    expect(() =>
      g.parseWebhookEvent({ ...typeless, type: "   " }),
    ).toThrow(GatewayApiError);

    const explicit = g.parseWebhookEvent({
      ...typeless,
      type: "invoice.paid",
    });
    expect(explicit.type).toBe("invoice.paid");
    expect(explicit.stableType).toBeUndefined();
    expect(explicit.event?.type).toBe("provider.unmapped");
    expect(isPaymentSucceededEvent(explicit.event)).toBe(false);
  });

  it("aborts long latency create via AbortSignal", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "succeeded", latencyMs: 200 }],
    });
    const c = new AbortController();
    const p = g.createPayment({
      amount: money("1.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      signal: c.signal,
    });
    c.abort();
    await expect(p).rejects.toBeInstanceOf(NetworkError);
  });

  it("FakeClock applyLatency re-checks abort after advance (P05-TK-1)", async () => {
    const clock = createFakeClock({ initialMs: 1_000 });
    const g = mockGateway({
      clock,
      createPayment: [{ outcome: "succeeded", latencyMs: 50 }],
    });
    const c = new AbortController();
    const p = g.createPayment({
      amount: money("1.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      signal: c.signal,
    });
    c.abort();
    await expect(p).rejects.toBeInstanceOf(NetworkError);
    expect(clock.nowMs()).toBe(1_050);
    expect(g.getLastProviderSideSuccess()).toBeUndefined();
    expect(g.getPaymentState("pay_mock_1")).toBeUndefined();
  });

  it("FakeClock applyLatency yields so a pre-queued abort is observed (P05-TK-1)", async () => {
    const clock = createFakeClock({ initialMs: 2_000 });
    const g = mockGateway({
      clock,
      createPayment: [{ outcome: "succeeded", latencyMs: 10 }],
    });
    const c = new AbortController();
    queueMicrotask(() => {
      c.abort();
    });
    await expect(
      g.createPayment({
        amount: money("1.00", "USD"),
        currency: "USD",
        callbackUrl: "https://ex.test/cb",
        signal: c.signal,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(clock.nowMs()).toBe(2_010);
    expect(g.getPaymentState("pay_mock_1")).toBeUndefined();
  });

  it("void authorized payment", async () => {
    const g = mockGateway();
    const pay = await g.createPayment({
      ...baseCreate,
      amount: money("30.00", "USD"),
      capture: false,
    });
    const voided = await g.voidPayment!({ gatewayPaymentId: pay.gatewayId });
    expect(voided.status).toBe("cancelled");
    expect(await g.getPaymentStatus!(pay.gatewayId)).toBe("cancelled");
  });

  it.each([
    {
      label: "voided auth",
      setup: async () => {
        const g = mockGateway();
        const auth = await g.createPayment({
          ...baseCreate,
          amount: money("30.00", "USD"),
          capture: false,
        });
        await g.voidPayment!({ gatewayPaymentId: auth.gatewayId });
        return { g, id: auth.gatewayId, status: "cancelled" as const };
      },
    },
    {
      label: "failed create",
      setup: async () => {
        const g = mockGateway({
          createPayment: [{ outcome: "failed" }],
        });
        const failed = await g.createPayment(baseCreate);
        return { g, id: failed.gatewayId, status: "failed" as const };
      },
    },
    {
      label: "pending requires_action",
      setup: async () => {
        const g = mockGateway({
          createPayment: [{ outcome: "requires_action" }],
        });
        const pending = await g.createPayment(baseCreate);
        return { g, id: pending.gatewayId, status: "pending" as const };
      },
    },
  ])("does not capture after $label (TESTKIT-1)", async ({ setup }) => {
    const { g, id, status } = await setup();
    await expect(
      g.capturePayment({ gatewayPaymentId: id }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(g.getPaymentState(id)?.status).toBe(status);
    expect(g.getPaymentState(id)?.capturedAmount).toBe(0);
  });

  it("converts capture/refund majors with payment currency (TESTKIT-2)", async () => {
    const g = mockGateway({
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    const pay = await g.createPayment({
      amount: money("10.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
      capture: false,
    });
    // Caller JPY (0-decimal) must not rescale 1 → 1 minor (1¢) of a USD hold.
    await expect(
      g.capturePayment({
        gatewayPaymentId: pay.gatewayId,
        amount: money("1", "JPY"),
        currency: "JPY",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(0);

    const cap = await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("1.00", "USD"),
      currency: "USD",
    });
    expect(cap.status).toBe("partially_captured");
    expect(cap.outcome).toBe("requires_action");
    expect(cap.capturedAmount).toEqual(money("1.00", "USD"));
    expect(cap.currency).toBe("USD");
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(1);

    const paid = await g.createPayment({
      amount: money("20.00", "USD"),
      currency: "USD",
      callbackUrl: "https://ex.test/cb",
    });
    await expect(
      g.refundPayment({
        gatewayPaymentId: paid.gatewayId,
        amount: money("1", "JPY"),
        currency: "JPY",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(g.getPaymentState(paid.gatewayId)?.refundedAmount).toBe(0);

    const refunded = await g.refundPayment({
      gatewayPaymentId: paid.gatewayId,
      amount: money("1.00", "USD"),
      currency: "USD",
    });
    expect(refunded.outcome).toBe("succeeded");
    expect(refunded.totalRefunded).toEqual(money("1.00", "USD"));
    expect(g.getPaymentState(paid.gatewayId)?.refundedAmount).toBe(1);
  });

  it("voidPayment fails closed for unknown payment IDs (TESTKIT-3)", async () => {
    const g = mockGateway();
    await expect(
      g.voidPayment!({ gatewayPaymentId: "pay_does_not_exist" }),
    ).rejects.toBeInstanceOf(GatewayApiError);
    // Align with capture/refund/get not-found posture
    await expect(
      g.capturePayment({ gatewayPaymentId: "pay_does_not_exist" }),
    ).rejects.toBeInstanceOf(GatewayApiError);
    await expect(
      g.getPayment({ gatewayPaymentId: "pay_does_not_exist" }),
    ).rejects.toBeInstanceOf(GatewayApiError);
  });

  it("enqueue extends queues at runtime", async () => {
    const g = mockGateway();
    g.enqueue("createPayment", { outcome: "requires_action" });
    const r = await g.createPayment(baseCreate);
    expect(r.status).toBe("pending");
    expect(r.outcome).toBe("requires_action");
  });

  it("default create dual-writes outcome succeeded + references", async () => {
    const g = mockGateway({ name: "demo" });
    const r = await g.createPayment(baseCreate);
    expect(r.outcome).toBe("succeeded");
    expect(r.status).toBe("paid");
    expect("success" in r).toBe(false); // 1.0: success removed; paid via outcome
    expect(isPaidOutcome(r)).toBe(true);
    expect(r.references).toMatchObject({
      providerObjectId: r.gatewayId,
      normalizedStatus: "paid",
      gateway: "demo",
    });
  });

  it("requires_action is not type-confusable with paid via isPaidOutcome", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "requires_action" }],
    });
    const r = await g.createPayment(baseCreate);
    expect("success" in r).toBe(false); // 1.0: success removed
    expect(r.outcome).toBe("requires_action");
    expect(isRequiresActionOutcome(r)).toBe(true);
    expect(isPaidOutcome(r)).toBe(false);
  });

  it("requires_action/pending create does not full-capture ledger", async () => {
    const g3ds = mockGateway({
      createPayment: [{ outcome: "requires_action" }],
    });
    const r3ds = await g3ds.createPayment(baseCreate);
    expect(r3ds.status).toBe("pending");
    expect(r3ds.outcome).toBe("requires_action");
    expect("success" in r3ds).toBe(false); // API ok — not money settled
    const s3ds = g3ds.getPaymentState(r3ds.gatewayId);
    expect(s3ds).toBeDefined();
    expect(s3ds!.status).toBe("pending");
    expect(s3ds!.capturedAmount).toBe(0);
    expect(s3ds!.authorized).toBe(false);
    // Void of pre-capture 3DS hold must remain valid
    const voided = await g3ds.voidPayment!({
      gatewayPaymentId: r3ds.gatewayId,
    });
    expect(voided.status).toBe("cancelled");
    expect(g3ds.getPaymentState(r3ds.gatewayId)?.status).toBe("cancelled");

    const gPending = mockGateway({
      createPayment: [{ outcome: "pending" }],
    });
    const rp = await gPending.createPayment(baseCreate);
    expect(rp.status).toBe("pending");
    const sp = gPending.getPaymentState(rp.gatewayId);
    expect(sp?.capturedAmount).toBe(0);
    expect(sp?.status).toBe("pending");
  });

  it("non-success scripted capture does not mutate ledger", async () => {
    const g = mockGateway();
    const pay = await g.createPayment({
      ...baseCreate,
      amount: money("50.00", "USD"),
      capture: false,
    });
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(0);
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("authorized");

    g.enqueue("capturePayment", { outcome: "failed" });
    const failed = await g.capturePayment({ gatewayPaymentId: pay.gatewayId });
    expect(failed.outcome).toBe("failed");
    expect(failed.status).toBe("failed");
    // Ledger must stay authorized with zero capture after failed capture
    const afterFailed = g.getPaymentState(pay.gatewayId)!;
    expect(afterFailed.capturedAmount).toBe(0);
    expect(afterFailed.status).toBe("authorized");

    g.enqueue("capturePayment", { outcome: "indeterminate" });
    const ind = await g.capturePayment({ gatewayPaymentId: pay.gatewayId });
    expect(ind.outcome).toBe("indeterminate");
    const afterInd = g.getPaymentState(pay.gatewayId)!;
    expect(afterInd.capturedAmount).toBe(0);
    expect(afterInd.status).toBe("authorized");

    // Successful capture still settles (explicit enqueue — last-step would replay indeterminate)
    g.enqueue("capturePayment", { outcome: "succeeded" });
    const ok = await g.capturePayment({ gatewayPaymentId: pay.gatewayId });
    expect(ok.status).toBe("paid");
    expect(ok.outcome).toBe("succeeded");
    expect(ok.capturedAmount).toEqual(money("50.00", "USD"));
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(50);
  });

  it("non-success scripted void does not cancel ledger (ledger integrity)", async () => {
    const g = mockGateway({
      voidPayment: [
        { outcome: "failed" },
        { outcome: "indeterminate" },
        { outcome: "voided" },
      ],
    });
    const pay = await g.createPayment({
      ...baseCreate,
      amount: money("20.00", "USD"),
      capture: false,
    });
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("authorized");

    const failed = await g.voidPayment!({ gatewayPaymentId: pay.gatewayId });
    expect(failed.outcome).toBe("failed");
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("authorized");

    const ind = await g.voidPayment!({ gatewayPaymentId: pay.gatewayId });
    expect(ind.outcome).toBe("indeterminate");
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("authorized");

    // Success void still cancels
    const voided = await g.voidPayment!({ gatewayPaymentId: pay.gatewayId });
    expect(voided.status).toBe("cancelled");
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("cancelled");
  });

  it("scripted refund result cannot override ledger totals (TESTKIT-3)", async () => {
    const g = mockGateway({
      refundPayment: [
        {
          outcome: "succeeded",
          result: {
            gatewayRefundId: "ref_forged",
            status: "failed",
            totalRefunded: money("0.00", "USD", { allowZero: true }),
          },
        },
      ],
    });
    const pay = await g.createPayment({ ...baseCreate, amount: money("40.00", "USD") });
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(40);

    const refunded = await g.refundPayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("15.00", "USD"),
    });
    // Ledger advanced by 15 — reported result must agree (not forged totals)
    expect(refunded.status).toBe("completed");
    expect(refunded.totalRefunded).toEqual(money("15.00", "USD"));
    expect(refunded.outcome).toBe("succeeded");
    expect(refunded.gatewayRefundId).toBe("ref_forged"); // metadata override OK
    const st = g.getPaymentState(pay.gatewayId)!;
    expect(st.refundedAmount).toBe(15);
    expect(st.status).toBe("partially_refunded");
  });

  it("refundPayment provider_ok_client_timeout settles ledger then throws (P05-TK-2)", async () => {
    for (const outcome of [
      "provider_ok_client_timeout",
      "provider_success_client_timeout",
    ] as const) {
      const g = mockGateway({
        refundPayment: [{ outcome }],
      });
      const paid = await g.createPayment({
        amount: money("20.00", "USD"),
        currency: "USD",
        callbackUrl: "https://ex.test/cb",
        capture: true,
      });
      await expect(
        g.refundPayment({
          gatewayPaymentId: paid.gatewayId,
          amount: money("20.00", "USD"),
          currency: "USD",
        }),
      ).rejects.toBeInstanceOf(NetworkError);
      const state = g.getPaymentState(paid.gatewayId);
      expect(state?.status).toBe("refunded");
      expect(state?.refundedAmount).toBe(20);
    }
  });

  it("implements PaymentGateway surface (name, capabilities, supports)", () => {
    const g = mockGateway({ name: "custom-mock" });
    expect(g.name).toBe("custom-mock");
    expect(g.supports("payments")).toBe(true);
    expect(g.supports("partialCapture")).toBe(true);
    expect(typeof g.capabilities.refunds).toBe("boolean");
    expect(Object.isFrozen(g.capabilities)).toBe(true);
  });

  it("redacting logger never receives cleartext secrets", async () => {
    const seen: Array<{ message: string; context?: Record<string, unknown> }> =
      [];
    const sink = {
      debug(message: string, context?: Record<string, unknown>) {
        seen.push({ message, context });
      },
      info(message: string, context?: Record<string, unknown>) {
        seen.push({ message, context });
      },
      warn(message: string, context?: Record<string, unknown>) {
        seen.push({ message, context });
      },
      error(message: string, context?: Record<string, unknown>) {
        seen.push({ message, context });
      },
    };
    const g = mockGateway({ logger: sink });
    await g.createPayment({
      ...baseCreate,
      metadata: { apiKey: "sk_test_should_not_appear", note: "ok" },
    });
    const blob = JSON.stringify(seen);
    expect(blob).not.toContain("sk_test_should_not_appear");
    // setLogger re-wraps with redaction
    g.setLogger(sink);
    await g.createPayment({
      ...baseCreate,
      metadata: { cardNumber: "4111111111111111" },
    });
    expect(JSON.stringify(seen)).not.toContain("4111111111111111");
  });

  it("concurrent same idempotencyKey does not double-charge", async () => {
    const g = mockGateway({
      // force a microtask yield so Promise.all would race without in-flight map
      defaultLatencyMs: 1,
    });
    const params = {
      amount: money("25.00", "USD"),
      currency: "USD" as const,
      callbackUrl: "https://ex.test/cb",
      idempotencyKey: "race-key",
    };
    const [a, b] = await Promise.all([
      g.createPayment(params),
      g.createPayment(params),
    ]);
    expect(a.gatewayId).toBe(b.gatewayId);
    expect(a.outcome).toBe("succeeded");
    expect(isPaidOutcome(a)).toBe(true);
    // Only one payment id on the ledger
    const ids = new Set(
      g
        .getHistory()
        .filter((h) => h.operation === "createPayment" && !h.error)
        .map((h) => (h.result as { gatewayId?: string } | undefined)?.gatewayId),
    );
    expect([...ids].filter(Boolean)).toHaveLength(1);
  });

  it("provider_ok_client_timeout caches so idempotent retry is not a double charge", async () => {
    const g = mockGateway({
      createPayment: [
        { outcome: "provider_ok_client_timeout" },
        { outcome: "succeeded" }, // must not be consumed on retry
      ],
    });
    const params = {
      amount: money("10.00", "USD"),
      currency: "USD" as const,
      callbackUrl: "https://ex.test/cb",
      idempotencyKey: "dual-timeout-key",
    };
    await expect(g.createPayment(params)).rejects.toBeInstanceOf(NetworkError);
    const side = g.getLastProviderSideSuccess();
    expect(side?.gatewayId).toBeTruthy();
    // Retry must return the provider-side payment, not create pay_mock_2
    const retry = await g.createPayment(params);
    expect(retry.gatewayId).toBe(side!.gatewayId);
    expect(retry.outcome).toBe("succeeded");
    expect(isPaidOutcome(retry)).toBe(true);
    expect(g.remainingOutcomes().createPayment).toBe(1); // second script unused
  });

  it("honors idempotencyKey with same gatewayId (process-local)", async () => {
    const g = mockGateway();
    const a = await g.createPayment({
      ...baseCreate,
      idempotencyKey: "idem-key-1",
    });
    const b = await g.createPayment({
      ...baseCreate,
      idempotencyKey: "idem-key-1",
    });
    expect(a.gatewayId).toBe(b.gatewayId);
    const c = await g.createPayment({
      ...baseCreate,
      idempotencyKey: "idem-key-2",
    });
    expect(c.gatewayId).not.toBe(a.gatewayId);
  });

  it("caches non-throw indeterminate under idempotencyKey", async () => {
    const g = mockGateway({
      createPayment: [
        { outcome: "indeterminate" },
        { outcome: "succeeded" }, // must not be consumed on same-key retry
      ],
    });
    const params = {
      ...baseCreate,
      amount: money("12.00", "USD"),
      idempotencyKey: "indeterminate-key",
    };
    const first = await g.createPayment(params);
    expect(first.outcome).toBe("indeterminate");
    expect(isPaidOutcome(first)).toBe(false);
    expect(first.reconciliationRequired).toBe(true);
    // Same-key retry must not mint a second gatewayId / consume next script
    const retry = await g.createPayment(params);
    expect(retry.gatewayId).toBe(first.gatewayId);
    expect(retry.outcome).toBe("indeterminate");
    expect(g.remainingOutcomes().createPayment).toBe(1);
    // Different key still drains the next scripted outcome
    const other = await g.createPayment({
      ...baseCreate,
      amount: money("12.00", "USD"),
      idempotencyKey: "other-key",
    });
    expect(other.outcome).toBe("succeeded");
    expect(other.gatewayId).not.toBe(first.gatewayId);
  });

  it("same idempotencyKey with different amount is fingerprint_conflict (TESTKIT-1)", async () => {
    const g = mockGateway();
    const a = await g.createPayment({
      ...baseCreate,
      amount: money("10.00", "USD"),
      idempotencyKey: "fp-key",
    });
    expect(a.gatewayId).toBeTruthy();
    await expect(
      g.createPayment({
        ...baseCreate,
        amount: money("99.00", "USD"),
        idempotencyKey: "fp-key",
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      g.createPayment({
        ...baseCreate,
        amount: money("99.00", "USD"),
        idempotencyKey: "fp-key",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    // Same amount + key still replays
    const replay = await g.createPayment({
      ...baseCreate,
      amount: money("10.00", "USD"),
      idempotencyKey: "fp-key",
    });
    expect(replay.gatewayId).toBe(a.gatewayId);
    // Capture-mode flip is also a fingerprint mismatch
    await expect(
      g.createPayment({
        ...baseCreate,
        amount: money("10.00", "USD"),
        capture: false,
        idempotencyKey: "fp-key",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
  });

  it("capture scripted money overrides cannot desync ledger dual-write (TESTKIT-1)", async () => {
    const g = mockGateway({
      capturePayment: [
        {
          outcome: "succeeded",
          result: {
            // Forged money — must not win over ledger-derived capture total
            capturedAmount: money("999.00", "USD"),
            amount: money("999.00", "USD"),
            status: "paid",
          },
        },
      ],
    });
    const pay = await g.createPayment({
      ...baseCreate,
      amount: money("40.00", "USD"),
      capture: false,
    });
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(0);

    const cap = await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("15.00", "USD"),
      currency: "USD",
    });
    // Ledger remaining math settled 15; reported result must match
    expect(cap.status).toBe("partially_captured");
    expect(cap.outcome).toBe("requires_action");
    expect(cap.capturedAmount).toEqual(money("15.00", "USD"));
    expect(cap.amount).toEqual(money("40.00", "USD"));
    expect(cap.currency).toBe("USD");
    expect(isPaidOutcome(cap)).toBe(false);
    const state = g.getPaymentState(pay.gatewayId)!;
    expect(state.capturedAmount).toBe(15);
    expect(state.status).toBe("partially_captured");
  });

  it("scripted capture status failed does not settle ledger (TESTKIT-3)", async () => {
    const g = mockGateway({
      capturePayment: [
        {
          outcome: "succeeded",
          // Status override demotes — bare outcome succeeded must not settle
          status: "failed",
        },
      ],
    });
    const pay = await g.createPayment({
      ...baseCreate,
      amount: money("25.00", "USD"),
      capture: false,
    });
    const cap = await g.capturePayment({ gatewayPaymentId: pay.gatewayId });
    expect(cap.status).toBe("failed");
    expect(isPaidOutcome(cap)).toBe(false);
    const state = g.getPaymentState(pay.gatewayId)!;
    expect(state.capturedAmount).toBe(0);
    expect(state.status).toBe("authorized");
  });

  it("ensurePaymentLedger clamps scripted captured/refunded to charge total (TESTKIT-4)", async () => {
    const g = mockGateway({
      createPayment: [
        {
          outcome: "succeeded",
          result: {
            amount: money("10.00", "USD"),
            currency: "USD",
            capturedAmount: money("500.00", "USD"),
            refundedAmount: money("400.00", "USD"),
            status: "paid",
          },
        },
      ],
    });
    const r = await g.createPayment(baseCreate);
    expect(r.status).toBe("paid");
    const state = g.getPaymentState(r.gatewayId)!;
    // Captured cannot exceed charge total (10); refunded cannot exceed captured
    expect(state.amount).toBe(10);
    expect(state.capturedAmount).toBe(10);
    expect(state.refundedAmount).toBe(10);
  });

  it("concurrent dual-timeout joiners all reject (TESTKIT-2 no false symmetry)", async () => {
    const g = mockGateway({
      createPayment: [{ outcome: "provider_ok_client_timeout", latencyMs: 5 }],
    });
    const params = {
      amount: money("12.00", "USD"),
      currency: "USD" as const,
      callbackUrl: "https://ex.test/cb",
      idempotencyKey: "dual-join-key",
    };
    const results = await Promise.allSettled([
      g.createPayment(params),
      g.createPayment(params),
    ]);
    // Both concurrent callers see NetworkError — not one success / one throw
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(NetworkError);
    }
    const side = g.getLastProviderSideSuccess();
    expect(side?.gatewayId).toBeTruthy();
    // Sequential retry after settle returns cached provider success (no double charge)
    const retry = await g.createPayment(params);
    expect(retry.gatewayId).toBe(side!.gatewayId);
    expect(isPaidOutcome(retry)).toBe(true);
  });

  it("economically equivalent noncanonical vs canonical Money shares fingerprint (TESTKIT-1)", async () => {
    const g = mockGateway();
    const a = await g.createPayment({
      ...baseCreate,
      amount: { amount: "10.5", currency: "SAR" },
      currency: "SAR",
      idempotencyKey: "money-fp",
    });
    const b = await g.createPayment({
      ...baseCreate,
      amount: money("10.50", "SAR"),
      currency: "SAR",
      idempotencyKey: "money-fp",
    });
    expect(b.gatewayId).toBe(a.gatewayId);
  });

  it("same idempotencyKey with different orderId/PM identity is fingerprint_conflict (NEW-TESTKIT-1)", async () => {
    const g = mockGateway();
    const a = await g.createPayment({
      ...baseCreate,
      orderId: "ord_a",
      stripePaymentMethodId: "pm_aaa",
      idempotencyKey: "identity-fp",
    });
    await expect(
      g.createPayment({
        ...baseCreate,
        orderId: "ord_b",
        stripePaymentMethodId: "pm_aaa",
        idempotencyKey: "identity-fp",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        orderId: "ord_a",
        stripePaymentMethodId: "pm_bbb",
        idempotencyKey: "identity-fp",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        orderId: "ord_a",
        stripePaymentMethodId: "pm_aaa",
        tokenId: "token_other",
        idempotencyKey: "identity-fp",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        orderId: "ord_a",
        stripePaymentMethodId: "pm_aaa",
        moyasarSource: { type: "token", token: "token_other" },
        idempotencyKey: "identity-fp",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    const replay = await g.createPayment({
      ...baseCreate,
      orderId: "ord_a",
      stripePaymentMethodId: "pm_aaa",
      idempotencyKey: "identity-fp",
    });
    expect(replay.gatewayId).toBe(a.gatewayId);
  });

  it("remaining capturable hold after partial refund stays capturable (NEW-TESTKIT-2)", async () => {
    const g = mockGateway({
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: true,
        partialCapture: true,
        refunds: true,
        partialRefunds: true,
        voids: true,
      }),
    });
    const pay = await g.createPayment({
      ...baseCreate,
      amount: money("100.00", "USD"),
      capture: false,
    });
    const first = await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("40.00", "USD"),
      currency: "USD",
    });
    expect(first.status).toBe("partially_captured");
    expect(first.outcome).toBe("requires_action");
    expect(first.capturedAmount).toEqual(money("40.00", "USD"));
    const refunded = await g.refundPayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("10.00", "USD"),
      currency: "USD",
    });
    expect(refunded.outcome).toBe("succeeded");
    expect(refunded.totalRefunded).toEqual(money("10.00", "USD"));
    const mid = g.getPaymentState(pay.gatewayId)!;
    expect(mid.status).toBe("partially_refunded");
    expect(mid.capturedAmount).toBe(40);
    expect(mid.refundedAmount).toBe(10);
    // Remaining 60 of the 100 hold must still capture — refund must not freeze it.
    const rest = await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("60.00", "USD"),
      currency: "USD",
    });
    expect(rest.outcome).toBe("succeeded");
    expect(rest.capturedAmount).toEqual(money("100.00", "USD"));
    expect(rest.currency).toBe("USD");
    const after = g.getPaymentState(pay.gatewayId)!;
    expect(after.capturedAmount).toBe(100);
    expect(after.refundedAmount).toBe(10);
    expect(after.status).toBe("partially_refunded");
  });

  it("getPayment does not rewrite ledger to paid on outcome succeeded (NEW-TESTKIT-3)", async () => {
    const g = mockGateway({
      getPayment: [{ outcome: "succeeded" }, { outcome: "succeeded" }],
    });
    const pay = await g.createPayment({
      ...baseCreate,
      amount: money("50.00", "USD"),
      capture: false,
    });
    expect(pay.status).toBe("authorized");
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("authorized");
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(0);

    const got = await g.getPayment({ gatewayPaymentId: pay.gatewayId });
    expect(got.status).toBe("authorized");
    expect(got.outcome).toBe("succeeded");
    expect(got.amount).toEqual(money("50.00", "USD"));
    expect(got.currency).toBe("USD");
    expect(got.capturedAmount).toEqual(
      money("0.00", "USD", { allowZero: true }),
    );
    expect(got.refundedAmount).toEqual(
      money("0.00", "USD", { allowZero: true }),
    );
    expect(isPaidOutcome(got)).toBe(false);
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("authorized");
    expect(g.getPaymentState(pay.gatewayId)?.capturedAmount).toBe(0);

    await g.capturePayment({
      gatewayPaymentId: pay.gatewayId,
      amount: money("20.00", "USD"),
      currency: "USD",
    });
    const afterPartial = await g.getPayment({
      gatewayPaymentId: pay.gatewayId,
    });
    expect(afterPartial.status).toBe("partially_captured");
    expect(afterPartial.outcome).toBe("requires_action");
    expect(afterPartial.capturedAmount).toEqual(money("20.00", "USD"));
    expect(afterPartial.amount).toEqual(money("50.00", "USD"));
    expect(isPaidOutcome(afterPartial)).toBe(false);
    expect(g.getPaymentState(pay.gatewayId)?.status).toBe("partially_captured");
  });

  it("capture:false without authorization capability is OperationNotSupportedError (NEW-TESTKIT-4)", async () => {
    const g = mockGateway({
      capabilities: defineGatewayCapabilities({
        payments: true,
        immediateCapture: true,
        authorization: false,
      }),
    });
    await expect(
      g.createPayment({
        ...baseCreate,
        capture: false,
      }),
    ).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(
      g.createPayment({
        ...baseCreate,
        capture: false,
      }),
    ).rejects.toThrow(/authorization/);
    expect(g.getPaymentState("pay_mock_1")).toBeUndefined();
    const paid = await g.createPayment({
      ...baseCreate,
      capture: true,
    });
    expect(paid.status).toBe("paid");
    expect(g.getPaymentState(paid.gatewayId)?.status).toBe("paid");
  });

  it("scripted/defaultOutcome succeeded + capture:false is authorized (NEW-TESTKIT-6)", async () => {
    const scripted = mockGateway({
      createPayment: [{ outcome: "succeeded" }],
    });
    const s = await scripted.createPayment({
      ...baseCreate,
      capture: false,
    });
    expect(s.status).toBe("authorized");
    expect(s.status).not.toBe("paid");
    expect(s.outcome).toBe("succeeded");
    expect(s.capturedAmount).toEqual(
      money("0.00", "USD", { allowZero: true }),
    );
    expect(s.currency).toBe("USD");
    expect(isPaidOutcome(s)).toBe(false);
    const sState = scripted.getPaymentState(s.gatewayId)!;
    expect(sState.status).toBe("authorized");
    expect(sState.capturedAmount).toBe(0);
    expect(sState.authorized).toBe(true);

    const def = mockGateway({
      defaultOutcome: { outcome: "succeeded" },
    });
    const d = await def.createPayment({
      ...baseCreate,
      capture: false,
    });
    expect(d.status).toBe("authorized");
    expect(d.capturedAmount).toEqual(
      money("0.00", "USD", { allowZero: true }),
    );
    expect(d.currency).toBe("USD");
    const dState = def.getPaymentState(d.gatewayId)!;
    expect(dState.status).toBe("authorized");
    expect(dState.capturedAmount).toBe(0);

    const immediate = mockGateway({
      createPayment: [{ outcome: "succeeded" }],
    });
    const paid = await immediate.createPayment({
      ...baseCreate,
      capture: true,
    });
    expect(paid.status).toBe("paid");
    expect(immediate.getPaymentState(paid.gatewayId)?.capturedAmount).toBe(10);
  });

  it("same idempotencyKey with different stripeCustomer/paymob identity is fingerprint_conflict (NEW-TESTKIT-7)", async () => {
    const g = mockGateway();
    const a = await g.createPayment({
      ...baseCreate,
      stripeCustomerId: "cus_aaa",
      paymobIntegrationId: 111,
      paymobPaymentMethods: ["card"],
      idempotencyKey: "identity-fp-7",
    });
    await expect(
      g.createPayment({
        ...baseCreate,
        stripeCustomerId: "cus_bbb",
        paymobIntegrationId: 111,
        paymobPaymentMethods: ["card"],
        idempotencyKey: "identity-fp-7",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        stripeCustomerId: "cus_aaa",
        paymobIntegrationId: 222,
        paymobPaymentMethods: ["card"],
        idempotencyKey: "identity-fp-7",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        stripeCustomerId: "cus_aaa",
        paymobIntegrationId: 111,
        paymobPaymentMethods: ["wallet"],
        idempotencyKey: "identity-fp-7",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    const replay = await g.createPayment({
      ...baseCreate,
      stripeCustomerId: "cus_aaa",
      paymobIntegrationId: 111,
      paymobPaymentMethods: ["card"],
      idempotencyKey: "identity-fp-7",
    });
    expect(replay.gatewayId).toBe(a.gatewayId);
  });

  it("same idempotencyKey with different setup_future_usage/iframe is fingerprint_conflict (NEW-TESTKIT-FP-1)", async () => {
    const g = mockGateway();
    const a = await g.createPayment({
      ...baseCreate,
      stripeSetupFutureUsage: "on_session",
      paymobIframeId: 111,
      idempotencyKey: "identity-fp-setup-iframe",
    });
    await expect(
      g.createPayment({
        ...baseCreate,
        stripeSetupFutureUsage: "off_session",
        paymobIframeId: 111,
        idempotencyKey: "identity-fp-setup-iframe",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        stripeSetupFutureUsage: "on_session",
        paymobIframeId: 222,
        idempotencyKey: "identity-fp-setup-iframe",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        stripeSetupFutureUsage: "on_session",
        paymobIframeId: "111",
        idempotencyKey: "identity-fp-setup-iframe",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    const replay = await g.createPayment({
      ...baseCreate,
      stripeSetupFutureUsage: "on_session",
      paymobIframeId: 111,
      idempotencyKey: "identity-fp-setup-iframe",
    });
    expect(replay.gatewayId).toBe(a.gatewayId);
  });

  it("same idempotencyKey with different customerId/paymentMethodId/offSession is fingerprint_conflict", async () => {
    const g = mockGateway();
    const a = await g.createPayment({
      ...baseCreate,
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      offSession: true,
      idempotencyKey: "identity-fp-vault",
    });
    await expect(
      g.createPayment({
        ...baseCreate,
        customerId: "cus_2",
        paymentMethodId: "pm_1",
        offSession: true,
        idempotencyKey: "identity-fp-vault",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        customerId: "cus_1",
        paymentMethodId: "pm_2",
        offSession: true,
        idempotencyKey: "identity-fp-vault",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    await expect(
      g.createPayment({
        ...baseCreate,
        customerId: "cus_1",
        paymentMethodId: "pm_1",
        offSession: false,
        idempotencyKey: "identity-fp-vault",
      }),
    ).rejects.toThrow(/fingerprint_conflict/);
    const replay = await g.createPayment({
      ...baseCreate,
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      offSession: true,
      idempotencyKey: "identity-fp-vault",
    });
    expect(replay.gatewayId).toBe(a.gatewayId);
  });

  const phase22Caps = defineGatewayCapabilities({
    payments: true,
    hostedCheckout: true,
    customers: true,
    paymentMethods: true,
    disputes: true,
    paymentLinks: true,
  });

  it("P22-MOCK: defaultOutcome timeout on createCheckoutSession is not a silent succeeded session", async () => {
    const g = mockGateway({
      capabilities: phase22Caps,
      defaultOutcome: { outcome: "timeout" },
    });
    await expect(
      g.createCheckoutSession!({
        successUrl: "https://ex.test/ok",
        amount: 10,
        currency: "USD",
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("P22-MOCK: defaultOutcome throw fails createCustomer/getDispute/createPaymentLink/listPaymentMethods", async () => {
    const boom = new Error("scripted boom");
    const g = mockGateway({
      capabilities: phase22Caps,
      defaultOutcome: { throw: boom },
    });
    await expect(g.createCustomer!({})).rejects.toBe(boom);
    await expect(g.getDispute!({ disputeId: "dp_1" })).rejects.toBe(boom);
    await expect(g.createPaymentLink!({})).rejects.toBe(boom);
    await expect(
      g.listPaymentMethods!({ customerId: "cus_1" }),
    ).rejects.toBe(boom);
  });

  it("P22-MOCK: listPaymentMethods does not always return [] when defaultOutcome is timeout", async () => {
    const g = mockGateway({
      capabilities: phase22Caps,
      defaultOutcome: { outcome: "timeout" },
    });
    await expect(
      g.listPaymentMethods!({ customerId: "cus_1" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("P22-MOCK: enqueue createCheckoutSession timeout is not succeeded", async () => {
    const g = mockGateway({ capabilities: phase22Caps });
    g.enqueue("createCheckoutSession", { outcome: "timeout" });
    await expect(
      g.createCheckoutSession!({
        successUrl: "https://ex.test/ok",
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    g.enqueue("createCheckoutSession", { outcome: "succeeded" });
    const ok = await g.createCheckoutSession!({
      successUrl: "https://ex.test/ok",
    });
    expect(ok.outcome).toBe("succeeded");
    expect(ok.session.status).toBe("open");
  });

  it("P22-MOCK: scripted indeterminate on createCustomer is not succeeded", async () => {
    const g = mockGateway({
      capabilities: phase22Caps,
      defaultOutcome: { outcome: "indeterminate" },
    });
    const result = await g.createCustomer!({
      email: "buyer@example.com",
      idempotencyKey: "idem_cus_ind",
    });
    expect(result.outcome).toBe("indeterminate");
    if (result.outcome !== "indeterminate") {
      expect.unreachable("must be indeterminate");
    }
    expect(result.reconciliationRequired).toBe(true);
    expect(result.customer?.status).toBe("unknown");
    expect(result.customer?.references.providerObjectId).toBe("idem_cus_ind");
  });

  it("P22-EMPTY-CUS: mock detach omits empty customerId", async () => {
    const g = mockGateway({ capabilities: phase22Caps });
    const result = await g.detachPaymentMethod!({
      paymentMethodId: "pm_detached",
    });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("detach must succeed");
    }
    expect(result.paymentMethod.customerId).toBeUndefined();
    expect(result.paymentMethod.id).toBe("pm_detached");
    expect(result.paymentMethod.references.normalizedStatus).toBe("detached");
  });

  it("P22R3-MOCK-GET: detach with customerId does not publish customerId", async () => {
    const g = mockGateway({ capabilities: phase22Caps });
    const result = await g.detachPaymentMethod!({
      paymentMethodId: "pm_detached_cus",
      customerId: "cus_should_not_publish",
    });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") {
      expect.unreachable("detach must succeed");
    }
    expect(result.paymentMethod.customerId).toBeUndefined();
    expect(
      result.paymentMethod.references.relatedIds?.customerId,
    ).toBeUndefined();
    expect(result.paymentMethod.id).toBe("pm_detached_cus");
  });

  it("P22R3-MOCK-GET: getCustomer unknown id is failed 404, not invented active", async () => {
    const g = mockGateway({ capabilities: phase22Caps });
    const missing = await g.getCustomer!({ customerId: "cus_never" });
    expect(missing.outcome).toBe("failed");
    if (missing.outcome !== "failed") {
      expect.unreachable("unknown customer must fail");
    }
    expect(missing.error.statusCode).toBe(404);
    expect(missing.customer).toBeUndefined();
  });

  it("P22R3-MOCK-GET: getCustomer after create returns the stored snapshot", async () => {
    const g = mockGateway({ capabilities: phase22Caps });
    const created = await g.createCustomer!({
      email: "buyer@example.com",
      name: "Buyer",
    });
    expect(created.outcome).toBe("succeeded");
    if (created.outcome !== "succeeded") {
      expect.unreachable("create must succeed");
    }
    const id = created.customer.references.providerObjectId;
    const fetched = await g.getCustomer!({ customerId: id });
    expect(fetched.outcome).toBe("succeeded");
    if (fetched.outcome !== "succeeded") {
      expect.unreachable("stored customer must succeed");
    }
    expect(fetched.customer.email).toBe("buyer@example.com");
    expect(fetched.customer.references.providerObjectId).toBe(id);
  });
});
