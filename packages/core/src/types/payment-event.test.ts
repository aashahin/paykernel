/**
 * Phase 7 — PaymentEvent model, mapping tables, envelope + hash helpers.
 */
import { describe, it, expect } from "bun:test";
import { money, type Money } from "../utils/money";
import type {
  PaymentEvent,
  PersistedPaymentEventEnvelope,
  WebhookEvent,
  RawWebhookPayloadCodec,
} from "../index";
import {
  STABLE_PAYMENT_EVENT_TYPES,
  PAYMENT_EVENT_SCHEMA_VERSION,
  isStablePaymentEventType,
  isPaymentEvent,
  isPaymentSucceededEvent,
  isPaymentFailedEvent,
  isRefundCompletedEvent,
  isProviderUnmappedEvent,
  mapProviderEventTypeToStable,
  webhookEventToPaymentEvent,
  attachPaymentEvent,
  toPersistedPaymentEventEnvelope,
  hashWebhookPayload,
  encryptRawWebhookPayload,
  redactWebhookPayloadSecrets,
  stripRawFromPaymentEvent,
  WEBHOOK_PAYLOAD_SECRET_KEYS,
  assertNoSecretsInEnvelope,
  buildProviderEventMetadata,
  paymentFromWebhookEvent,
} from "../index";

function baseWebhook(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: "evt_1",
    type: "payment_paid",
    gateway: "moyasar",
    paymentId: "order_1",
    gatewayPaymentId: "pay_1",
    status: "paid",
    timestamp: new Date("2024-01-15T12:00:00.000Z"),
    rawPayload: { id: "evt_1", type: "payment_paid" },
    ...overrides,
  };
}

describe("STABLE_PAYMENT_EVENT_TYPES", () => {
  it("contains every documented stable name", () => {
    const expected = [
      "payment.created",
      "payment.processing",
      "payment.authorized",
      "payment.succeeded",
      "payment.failed",
      "payment.cancelled",
      "capture.completed",
      "refund.pending",
      "refund.completed",
      "refund.failed",
      "payment_method.setup_completed",
      "dispute.opened",
      "dispute.updated",
      "dispute.closed",
    ];
    expect([...STABLE_PAYMENT_EVENT_TYPES]).toEqual(expected);
    expect(STABLE_PAYMENT_EVENT_TYPES).toHaveLength(14);
  });

  it("isStablePaymentEventType is true for all stable names", () => {
    for (const t of STABLE_PAYMENT_EVENT_TYPES) {
      expect(isStablePaymentEventType(t)).toBe(true);
    }
  });

  it("isStablePaymentEventType rejects provider-native and unmapped", () => {
    expect(isStablePaymentEventType("payment_paid")).toBe(false);
    expect(isStablePaymentEventType("payment_intent.succeeded")).toBe(false);
    expect(isStablePaymentEventType("provider.unmapped")).toBe(false);
    expect(isStablePaymentEventType("")).toBe(false);
  });

  it("schemaVersion constant is literally '1'", () => {
    expect(PAYMENT_EVENT_SCHEMA_VERSION).toBe("1");
  });
});

describe("PaymentEvent discrimination", () => {
  it("switch on type narrows payment vs refund vs dispute arms", () => {
    function label(event: PaymentEvent): string {
      switch (event.type) {
        case "payment.created":
        case "payment.processing":
        case "payment.authorized":
        case "payment.succeeded":
        case "payment.cancelled":
          return `payment:${event.payment.status}`;
        case "payment.failed":
          return `failed:${event.failure.code}`;
        case "capture.completed":
          return `capture:${event.capture.status}`;
        case "refund.pending":
        case "refund.completed":
          return `refund:${event.refund.status}`;
        case "refund.failed":
          return `refund-failed:${event.refund.status}`;
        case "payment_method.setup_completed":
          return `setup:${event.setup.status}`;
        case "dispute.opened":
        case "dispute.updated":
        case "dispute.closed":
          return `dispute:${event.dispute.status}`;
        case "provider.unmapped":
          return `unmapped:${event.provider.eventType}`;
        default: {
          const _n: never = event;
          return String(_n);
        }
      }
    }

    const succeeded = webhookEventToPaymentEvent(
      baseWebhook({ type: "payment_paid", status: "paid" }),
    );
    expect(isPaymentSucceededEvent(succeeded)).toBe(true);
    expect(label(succeeded)).toBe("payment:paid");

    const failed = webhookEventToPaymentEvent(
      baseWebhook({
        type: "payment_failed",
        status: "failed",
        gateway: "moyasar",
      }),
    );
    expect(isPaymentFailedEvent(failed)).toBe(true);
    expect(label(failed)).toContain("failed:");

    const refund = webhookEventToPaymentEvent(
      baseWebhook({
        type: "charge.refunded",
        gateway: "stripe",
        status: "refunded",
      }),
    );
    expect(isRefundCompletedEvent(refund)).toBe(true);
    expect(label(refund)).toContain("refund:");

    const unmapped = webhookEventToPaymentEvent(
      baseWebhook({
        type: "invoice.paid",
        gateway: "stripe",
        status: "paid",
      }),
    );
    expect(isProviderUnmappedEvent(unmapped)).toBe(true);
    expect(label(unmapped)).toBe("unmapped:invoice.paid");
  });

  it("isPaymentEvent requires schemaVersion 1 + type + complete provider + entity arm", () => {
    const e = webhookEventToPaymentEvent(baseWebhook());
    expect(isPaymentEvent(e)).toBe(true);
    expect(isPaymentEvent({ type: "payment.succeeded" })).toBe(false);
    expect(isPaymentEvent(null)).toBe(false);
    // CORE-4: thin 3-field shape is not a trusted PaymentEvent.
    expect(
      isPaymentEvent({
        schemaVersion: "1",
        type: "payment.succeeded",
        provider: {},
      }),
    ).toBe(false);
    expect(
      isPaymentEvent({
        schemaVersion: "1",
        type: "payment.succeeded",
        provider: {
          gateway: "custom",
          eventId: "evt_1",
          eventType: "payment_paid",
          occurredAt: "2024-01-01T00:00:00.000Z",
          receivedAt: "2024-01-01T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });
});

describe("webhookEventToPaymentEvent", () => {
  it("maps payment_paid → payment.succeeded with Payment + provider metadata", () => {
    const event = webhookEventToPaymentEvent(
      baseWebhook({
        type: "payment_paid",
        status: "paid",
        amount: money("10.50", "SAR"),
        currency: "SAR",
        livemode: false,
      }),
      { receivedAt: "2024-01-15T12:00:01.000Z", requestId: "req_1" },
    );

    expect(event.schemaVersion).toBe("1");
    expect(event.type).toBe("payment.succeeded");
    if (event.type !== "payment.succeeded") throw new Error("narrow");
    expect(event.payment.amount).toEqual(money("10.50", "SAR"));
    expect(event.payment.currency).toBe("SAR");
    expect(event.payment.references.providerObjectId).toBe("pay_1");
    expect(event.payment.references.gateway).toBe("moyasar");
    expect(event.provider.eventType).toBe("payment_paid");
    expect(event.provider.eventId).toBe("evt_1");
    expect(event.provider.occurredAt).toBe("2024-01-15T12:00:00.000Z");
    expect(event.provider.receivedAt).toBe("2024-01-15T12:00:01.000Z");
    expect(event.provider.requestId).toBe("req_1");
    expect(event.provider.livemode).toBe(false);
    // raw not on payment by default
    expect(event.payment.rawResponse).toBeUndefined();
  });

  it("maps failed → payment.failed with failure", () => {
    const event = webhookEventToPaymentEvent(
      baseWebhook({ type: "payment_failed", status: "failed" }),
    );
    expect(event.type).toBe("payment.failed");
    if (event.type !== "payment.failed") throw new Error("narrow");
    expect(event.failure.code).toBe("payment_failed");
    expect(event.failure.providerCode).toBe("failed");
  });

  it("unknown provider type → provider.unmapped preserving provider.eventType", () => {
    const event = webhookEventToPaymentEvent(
      baseWebhook({
        type: "weird.custom.event",
        gateway: "stripe",
        status: "pending",
      }),
    );
    expect(event.type).toBe("provider.unmapped");
    if (event.type !== "provider.unmapped") throw new Error("narrow");
    expect(event.provider.eventType).toBe("weird.custom.event");
    expect(event.note).toContain("weird.custom.event");
  });

  it("does not invent misleading payment raw from webhook by default", () => {
    const payment = paymentFromWebhookEvent(
      baseWebhook({ rawPayload: { secret_token: "s" } }),
    );
    expect(payment.rawResponse).toBeUndefined();
  });

  it("omits amount without currency on paymentFromWebhookEvent (CORE-3)", () => {
    const incomplete = paymentFromWebhookEvent(
      baseWebhook({ amount: money("12.50", "USD"), currency: undefined }),
    );
    expect(incomplete.amount).toBeUndefined();
    expect(incomplete.currency).toBeUndefined();

    const complete = paymentFromWebhookEvent(
      baseWebhook({ amount: money("12.50", "USD"), currency: "usd" }),
    );
    expect(complete.amount).toEqual(money("12.50", "USD"));
    expect(complete.currency).toBe("USD");

    const currencyOnly = paymentFromWebhookEvent(
      baseWebhook({ amount: undefined, currency: "SAR" }),
    );
    expect(currencyOnly.amount).toBeUndefined();
    expect(currencyOnly.currency).toBe("SAR");
  });

  it("NEW-MONEY-3: omit non-finite amount even when currency is set", () => {
    const nanAmount = paymentFromWebhookEvent(
      baseWebhook({
        amount: Number.NaN as unknown as Money,
        currency: "usd",
      }),
    );
    expect(nanAmount.currency).toBe("USD");
    expect(nanAmount.amount).toBeUndefined();

    const infAmount = paymentFromWebhookEvent(
      baseWebhook({
        amount: Number.POSITIVE_INFINITY as unknown as Money,
        currency: "SAR",
      }),
    );
    expect(infAmount.currency).toBe("SAR");
    expect(infAmount.amount).toBeUndefined();

    const negInf = paymentFromWebhookEvent(
      baseWebhook({
        amount: Number.NEGATIVE_INFINITY as unknown as Money,
        currency: "EGP",
      }),
    );
    expect(negInf.currency).toBe("EGP");
    expect(negInf.amount).toBeUndefined();

    const viaEvent = webhookEventToPaymentEvent(
      baseWebhook({
        type: "payment_paid",
        status: "paid",
        amount: Number.NaN as unknown as Money,
        currency: "usd",
      }),
    );
    expect(viaEvent.type).toBe("payment.succeeded");
    if (viaEvent.type !== "payment.succeeded") throw new Error("narrow");
    expect(viaEvent.payment.currency).toBe("USD");
    expect(viaEvent.payment.amount).toBeUndefined();
  });

  it("capture dual-write uses partially_completed for partials (CORE-4)", () => {
    // NEW-CORE-4: Paymob is_capture + partial is payment.processing, not
    // capture.completed (open money must not look fully captured).
    const paymobPartial = webhookEventToPaymentEvent(
      baseWebhook({
        type: "TRANSACTION",
        gateway: "paymob",
        status: "partially_captured",
        amount: money("5.00", "EGP"),
        currency: "EGP",
      }),
      {
        mapContext: {
          status: "partially_captured",
          flags: { success: true, isCapture: true },
        },
      },
    );
    expect(paymobPartial.type).toBe("payment.processing");
    if (paymobPartial.type !== "payment.processing") throw new Error("narrow");
    expect(paymobPartial.payment.status).toBe("partially_captured");
    expect(paymobPartial.payment.amount).toEqual(money("5.00", "EGP"));
    expect(paymobPartial.payment.currency).toBe("EGP");

    // NEW-CORE-8: Moyasar payment_captured + open-money status rematches
    // to payment.processing (not capture.completed). Type-only fulfillment
    // must not treat a partial / still-processing capture as settled.
    const capturePartial = webhookEventToPaymentEvent(
      baseWebhook({
        type: "payment_captured",
        gateway: "moyasar",
        status: "partially_captured",
        amount: money("5.00", "EGP"),
        currency: "EGP",
      }),
    );
    expect(capturePartial.type).toBe("payment.processing");
    if (capturePartial.type !== "payment.processing") throw new Error("narrow");
    expect(capturePartial.payment.status).toBe("partially_captured");
    expect(capturePartial.payment.amount).toEqual(money("5.00", "EGP"));
    expect(capturePartial.payment.currency).toBe("EGP");

    const full = webhookEventToPaymentEvent(
      baseWebhook({
        type: "payment_captured",
        gateway: "moyasar",
        status: "paid",
        amount: money("10.00", "USD"),
        currency: "USD",
      }),
    );
    expect(full.type).toBe("capture.completed");
    if (full.type !== "capture.completed") throw new Error("narrow");
    expect(full.capture.status).toBe("completed");
  });
});

describe("attachPaymentEvent dual-write", () => {
  it("keeps provider-native type and sets stableType + event", () => {
    const legacy = baseWebhook({ type: "payment_paid", status: "paid" });
    const dual = attachPaymentEvent(legacy, {
      receivedAt: "2024-06-01T00:00:00.000Z",
    });

    expect(dual.type).toBe("payment_paid"); // legacy preserved
    expect(dual.stableType).toBe("payment.succeeded");
    expect(dual.schemaVersion).toBe("1");
    expect(dual.event?.type).toBe("payment.succeeded");
    expect(dual.provider?.eventType).toBe("payment_paid");
    expect(legacy.event).toBeUndefined(); // input not mutated
  });

  it("omits stableType when unmapped", () => {
    const dual = attachPaymentEvent(
      baseWebhook({ type: "invoice.created", gateway: "stripe", status: "pending" }),
    );
    expect(dual.type).toBe("invoice.created");
    expect(dual.stableType).toBeUndefined();
    expect(dual.event?.type).toBe("provider.unmapped");
  });

  it("computePayloadHash sets payloadHash from redacted raw", () => {
    const dual = attachPaymentEvent(
      baseWebhook({
        rawPayload: { id: "x", secret_token: "shh", amount: 1 },
      }),
      { computePayloadHash: true },
    );
    expect(dual.payloadHash).toBeDefined();
    expect(dual.payloadHash).toBe(
      hashWebhookPayload({ id: "x", secret_token: "shh", amount: 1 }),
    );
  });

  it("PERF-6: computePayloadHash does not overwrite an existing payloadHash", () => {
    const dual = attachPaymentEvent(
      baseWebhook({
        rawPayload: { id: "x", amount: 1 },
        payloadHash: "abc",
      }),
      { computePayloadHash: true },
    );
    expect(dual.payloadHash).toBe("abc");
  });
});

describe("mapProviderEventTypeToStable tables", () => {
  describe("stripe", () => {
    const cases: Array<[string, string]> = [
      ["payment_intent.succeeded", "payment.succeeded"],
      ["payment_intent.payment_failed", "payment.failed"],
      ["payment_intent.canceled", "payment.cancelled"],
      ["payment_intent.created", "payment.created"],
      ["payment_intent.processing", "payment.processing"],
      ["checkout.session.async_payment_succeeded", "payment.succeeded"],
      ["checkout.session.expired", "payment.cancelled"],
      ["setup_intent.succeeded", "payment_method.setup_completed"],
      ["charge.refunded", "refund.completed"],
      ["refund.failed", "refund.failed"],
      ["charge.dispute.created", "dispute.opened"],
      ["charge.dispute.closed", "dispute.closed"],
    ];

    for (const [native, stable] of cases) {
      it(`${native} → ${stable}`, () => {
        expect(mapProviderEventTypeToStable("stripe", native)).toBe(stable);
      });
    }

    it("checkout.session.completed paid → payment.succeeded", () => {
      expect(
        mapProviderEventTypeToStable("stripe", "checkout.session.completed", {
          paymentStatus: "paid",
        }),
      ).toBe("payment.succeeded");
      expect(
        mapProviderEventTypeToStable("stripe", "checkout.session.completed", {
          status: "paid",
        }),
      ).toBe("payment.succeeded");
    });

    it("checkout.session.completed setup → payment_method.setup_completed", () => {
      expect(
        mapProviderEventTypeToStable("stripe", "checkout.session.completed", {
          paymentStatus: "no_payment_required",
          mode: "setup",
        }),
      ).toBe("payment_method.setup_completed");
      expect(
        mapProviderEventTypeToStable("stripe", "checkout.session.completed", {
          status: "setup_completed",
        }),
      ).toBe("payment_method.setup_completed");
    });

    it("invoice/subscription → provider.unmapped", () => {
      expect(mapProviderEventTypeToStable("stripe", "invoice.paid")).toBe(
        "provider.unmapped",
      );
      expect(
        mapProviderEventTypeToStable("stripe", "customer.subscription.updated"),
      ).toBe("provider.unmapped");
    });

    it("refund.created without status → refund.pending", () => {
      expect(mapProviderEventTypeToStable("stripe", "refund.created")).toBe(
        "refund.pending",
      );
    });

    it("refund.updated succeeded → refund.completed", () => {
      expect(
        mapProviderEventTypeToStable("stripe", "refund.updated", {
          status: "succeeded",
        }),
      ).toBe("refund.completed");
    });

    it.each([
      ["refund.updated", undefined],
      ["refund.updated", ""],
      ["refund.updated", "mystery_status"],
      ["refund.updated", "refund_completed"],
      ["charge.refund.updated", undefined],
      ["charge.refund.updated", "unknown"],
    ] as const)(
      "CORE-1: stripe %s status=%s → refund.pending (not completed)",
      (providerEventType, status) => {
        expect(
          mapProviderEventTypeToStable(
            "stripe",
            providerEventType,
            status === undefined ? undefined : { status },
          ),
        ).toBe("refund.pending");
      },
    );

    it("CORE-2: charge.refunded + refund_completed → refund.pending (not completed)", () => {
      expect(
        mapProviderEventTypeToStable("stripe", "charge.refunded", {
          status: "refund_completed",
        }),
      ).toBe("refund.pending");
    });

    it("CORE-2: charge.refunded + refunded/partially_refunded → refund.completed", () => {
      expect(
        mapProviderEventTypeToStable("stripe", "charge.refunded", {
          status: "refunded",
        }),
      ).toBe("refund.completed");
      expect(
        mapProviderEventTypeToStable("stripe", "charge.refunded", {
          status: "partially_refunded",
        }),
      ).toBe("refund.completed");
    });

    it("CORE-2: attachPaymentEvent demotes incomplete charge.refunded snapshots", () => {
      const dual = attachPaymentEvent(
        baseWebhook({
          type: "charge.refunded",
          status: "refund_completed",
          gateway: "stripe",
        }),
      );
      expect(dual.stableType).toBe("refund.pending");
      expect(dual.event?.type).toBe("refund.pending");
      expect(dual.type).toBe("charge.refunded"); // provider-native preserved
    });

    it("payment_intent.succeeded + partially_captured → payment.processing", () => {
      expect(
        mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
          status: "partially_captured",
        }),
      ).toBe("payment.processing");
      // case-insensitive status
      expect(
        mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
          status: "Partially_Captured",
        }),
      ).toBe("payment.processing");
    });

    it("payment_intent.succeeded + paid / no status → payment.succeeded", () => {
      expect(
        mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
          status: "paid",
        }),
      ).toBe("payment.succeeded");
      expect(
        mapProviderEventTypeToStable("stripe", "payment_intent.succeeded"),
      ).toBe("payment.succeeded");
    });
  });

  describe("moyasar", () => {
    const cases: Array<[string, string]> = [
      ["payment_paid", "payment.succeeded"],
      ["payment_failed", "payment.failed"],
      ["payment_faild", "payment.failed"],
      ["payment_authorized", "payment.authorized"],
      ["payment_abandoned", "payment.failed"],
      ["payment_voided", "payment.cancelled"],
      ["payment_refunded", "refund.completed"],
      ["payment_captured", "capture.completed"],
      ["payment_verified", "payment_method.setup_completed"],
    ];

    for (const [native, stable] of cases) {
      it(`${native} → ${stable}`, () => {
        expect(mapProviderEventTypeToStable("moyasar", native)).toBe(stable);
      });
    }

    it("NEW-CORE-8: payment_captured + partially_captured/processing → payment.processing", () => {
      expect(
        mapProviderEventTypeToStable("moyasar", "payment_captured", {
          status: "partially_captured",
        }),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("moyasar", "payment_captured", {
          status: "processing",
        }),
      ).toBe("payment.processing");
      // Full paid capture stays capture-domain.
      expect(
        mapProviderEventTypeToStable("moyasar", "payment_captured", {
          status: "paid",
        }),
      ).toBe("capture.completed");
    });

    it("P610-MAP-1: unknown type stays provider.unmapped even when status is paid", () => {
      expect(
        mapProviderEventTypeToStable("moyasar", "unknown_event", {
          status: "paid",
        }),
      ).toBe("provider.unmapped");
      expect(
        mapProviderEventTypeToStable("moyasar", "unknown_event", {
          status: "approved",
        }),
      ).toBe("provider.unmapped");
      expect(
        mapProviderEventTypeToStable("moyasar", "card_auth_succeeded", {
          status: "paid",
        }),
      ).toBe("provider.unmapped");

      const pe = webhookEventToPaymentEvent(
        baseWebhook({
          type: "unknown_event",
          gateway: "moyasar",
          status: "paid",
        }),
      );
      expect(pe.type).toBe("provider.unmapped");
      expect(pe.provider.eventType).toBe("unknown_event");
    });
  });

  describe("paypal", () => {
    const cases: Array<[string, string]> = [
      ["PAYMENT.CAPTURE.COMPLETED", "capture.completed"],
      ["PAYMENT.CAPTURE.DENIED", "payment.failed"],
      ["PAYMENT.CAPTURE.DECLINED", "payment.failed"],
      ["PAYMENT.CAPTURE.PENDING", "payment.processing"],
      ["PAYMENT.REFUND.COMPLETED", "refund.completed"],
      ["PAYMENT.REFUND.PENDING", "refund.pending"],
      ["PAYMENT.REFUND.FAILED", "refund.failed"],
      ["PAYMENT.AUTHORIZATION.CREATED", "payment.authorized"],
      ["PAYMENT.AUTHORIZATION.VOIDED", "payment.cancelled"],
      ["CHECKOUT.ORDER.APPROVED", "payment.processing"],
      ["CUSTOMER.DISPUTE.CREATED", "dispute.opened"],
    ];

    for (const [native, stable] of cases) {
      it(`${native} → ${stable}`, () => {
        expect(mapProviderEventTypeToStable("paypal", native)).toBe(stable);
      });
    }

    it.each([
      [undefined, "refund.pending"],
      ["refunded", "refund.completed"],
      ["partially_refunded", "refund.pending"],
    ] as const)(
      "PAYPAL-DW-1: CAPTURE.REFUNDED status=%s → %s",
      (status, stable) => {
        expect(
          mapProviderEventTypeToStable(
            "paypal",
            "PAYMENT.CAPTURE.REFUNDED",
            status === undefined ? undefined : { status },
          ),
        ).toBe(stable);
      },
    );

    it("PAYMENT.CAPTURE.REVERSED stays unmapped (no stable reversed arm)", () => {
      expect(
        mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.REVERSED"),
      ).toBe("provider.unmapped");
    });

    it("CHECKOUT.ORDER.COMPLETED + paid status → payment.succeeded", () => {
      expect(
        mapProviderEventTypeToStable("paypal", "CHECKOUT.ORDER.COMPLETED", {
          status: "paid",
        }),
      ).toBe("payment.succeeded");
    });

    it("CHECKOUT.ORDER.COMPLETED + approved → processing (not succeeded)", () => {
      expect(
        mapProviderEventTypeToStable("paypal", "CHECKOUT.ORDER.COMPLETED", {
          status: "approved",
        }),
      ).toBe("payment.processing");
    });

    it("partial auth capture dual-writes payment.processing; full auth capture stays capture.completed", () => {
      expect(
        mapProviderEventTypeToStable(
          "paypal",
          "PAYMENT.AUTHORIZATION.PARTIALLY_CAPTURED",
        ),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable(
          "paypal",
          "PAYMENT.AUTHORIZATION.PARTIALLY_CAPTURED",
          { status: "partially_captured" },
        ),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("paypal", "PAYMENT.AUTHORIZATION.CAPTURED"),
      ).toBe("capture.completed");
    });
  });

  describe("paymob", () => {
    it("TOKEN → payment_method.setup_completed", () => {
      expect(mapProviderEventTypeToStable("paymob", "TOKEN")).toBe(
        "payment_method.setup_completed",
      );
    });

    it("TRANSACTION success flag → payment.succeeded", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { success: true },
        }),
      ).toBe("payment.succeeded");
    });

    it("I3-PAYMOB-FLAGS-PENDING: flags success+pending, no status → payment.processing", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { success: true, pending: true },
        }),
      ).toBe("payment.processing");
    });

    it("S19-MAP-REFUND-PENDING: flags pending+success+isRefund, no status → payment.processing", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { pending: true, success: true, isRefund: true },
        }),
      ).toBe("payment.processing");
    });

    it("S19-MAP-REFUND-PENDING: refundedAmountCents + flags.pending is not refund.completed", () => {
      const mapped = mapProviderEventTypeToStable("paymob", "TRANSACTION", {
        flags: { pending: true },
        amounts: { refundedAmountCents: 2500 },
      });
      expect(["payment.processing", "refund.pending"]).toContain(mapped);
      expect(mapped).not.toBe("refund.completed");
    });

    it("S19-MAP-REFUND-PENDING: refund_pending → refund.pending; refund_failed → refund.failed", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "refund_pending",
        }),
      ).toBe("refund.pending");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "refund_failed",
        }),
      ).toBe("refund.failed");
    });

    it("TRANSACTION failed → payment.failed", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { success: false },
        }),
      ).toBe("payment.failed");
    });

    it("TRANSACTION void → payment.cancelled", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { isVoid: true, success: true },
        }),
      ).toBe("payment.cancelled");
    });

    it("TRANSACTION refund → refund.completed", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { isRefund: true, success: true },
        }),
      ).toBe("refund.completed");
    });

    it("TRANSACTION auth → payment.authorized", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { isAuth: true, success: true },
        }),
      ).toBe("payment.authorized");
    });

    it("TRANSACTION capture → capture.completed", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { isCapture: true, success: true },
        }),
      ).toBe("capture.completed");
    });

    it("TRANSACTION_RESPONSE without status → unmapped", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION_RESPONSE"),
      ).toBe("provider.unmapped");
    });

    it("TRANSACTION_RESPONSE with paid/success → payment.processing (not succeeded)", () => {
      // Redirect/query callbacks must not dual-write fulfillment-ready settlement.
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION_RESPONSE", {
          status: "paid",
        }),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION_RESPONSE", {
          flags: { success: true },
        }),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION_RESPONSE", {
          flags: { success: true, isCapture: true },
        }),
      ).toBe("payment.processing");
    });

    it("PAYMOB-AUTH-REDIR: TRANSACTION_RESPONSE + authorized/is_auth → payment.processing", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION_RESPONSE", {
          status: "authorized",
        }),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION_RESPONSE", {
          flags: { isAuth: true, success: true },
        }),
      ).toBe("payment.processing");
      // Processed server TRANSACTION still publishes confirmed auth.
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { isAuth: true, success: true },
        }),
      ).toBe("payment.authorized");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "authorized",
        }),
      ).toBe("payment.authorized");
    });

    it("S20: TRANSACTION_RESPONSE cancelled/failed/refund stables → payment.processing", () => {
      const redirectHints = [
        { status: "cancelled" },
        { flags: { isVoid: true, success: true } },
        { flags: { isVoided: true } },
        { status: "failed" },
        { flags: { success: false } },
        { flags: { isRefund: true, success: true } },
        { status: "refunded" },
        { status: "refund_pending" },
        { status: "refund_failed" },
      ] as const;
      for (const hints of redirectHints) {
        expect(
          mapProviderEventTypeToStable("paymob", "TRANSACTION_RESPONSE", hints),
        ).toBe("payment.processing");
      }
      // Processed HMAC TRANSACTION still publishes terminal restock arms.
      const processed = [
        [{ status: "cancelled" }, "payment.cancelled"],
        [{ flags: { success: false } }, "payment.failed"],
        [{ flags: { isRefund: true, success: true } }, "refund.completed"],
      ] as const;
      for (const [hints, stable] of processed) {
        expect(mapProviderEventTypeToStable("paymob", "TRANSACTION", hints)).toBe(
          stable,
        );
      }
    });

    it("TRANSACTION with paid status still → payment.succeeded", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "paid",
        }),
      ).toBe("payment.succeeded");
    });

    it("TRANSACTION status approved → payment.processing (not succeeded)", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "approved",
        }),
      ).toBe("payment.processing");
    });

    it("TRANSACTION amount-only refund status beats success → refund.completed", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "partially_refunded",
          flags: { success: true, isRefund: false, isRefunded: false },
        }),
      ).toBe("refund.completed");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "refunded",
          flags: { success: true },
        }),
      ).toBe("refund.completed");
    });

    it("TRANSACTION amount-only refund via amounts without status → refund.completed", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { success: true, isRefund: false, isRefunded: false },
          amounts: { amountCents: 10000, refundedAmountCents: 2500 },
        }),
      ).toBe("refund.completed");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          amounts: { amountCents: 10000, refundedAmountCents: 2500 },
        }),
      ).toBe("refund.completed");
    });

    it("S20-PAYMOB-AMOUNT-REFUND: paid+refund cents without flags stays paid, not refund.completed", () => {
      const rows = [
        [
          {
            status: "paid",
            amounts: { amountCents: 10000, refundedAmountCents: 2500 },
          },
          "payment.succeeded",
        ],
        [
          { status: "cancelled", amounts: { refundedAmountCents: 2500 } },
          "payment.cancelled",
        ],
        [
          { status: "failed", amounts: { refundedAmountCents: 2500 } },
          "payment.failed",
        ],
      ] as const;
      for (const [hints, stable] of rows) {
        expect(mapProviderEventTypeToStable("paymob", "TRANSACTION", hints)).toBe(
          stable,
        );
      }
    });

    it("TRANSACTION is_auth + paid/partially_captured status is not payment.authorized", () => {
      // Partial capture is open money story → processing (not payment.succeeded).
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "partially_captured",
          flags: { success: true, isAuth: true },
        }),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "paid",
          flags: { success: true, isAuth: true },
        }),
      ).toBe("payment.succeeded");
    });

    it("TRANSACTION partially_captured status alone → payment.processing not succeeded", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "partially_captured",
        }),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "partially_captured",
          flags: { success: true },
        }),
      ).toBe("payment.processing");
    });

    it("TRANSACTION is_auth + partial captured amount without status → payment.processing", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { success: true, isAuth: true },
          amounts: { amountCents: 10000, capturedAmountCents: 5000 },
        }),
      ).toBe("payment.processing");
    });

    it("TRANSACTION is_auth + full captured amount without status → payment.succeeded", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { success: true, isAuth: true },
          amounts: { amountCents: 10000, capturedAmountCents: 10000 },
        }),
      ).toBe("payment.succeeded");
    });

    it("TRANSACTION is_capture + partially_captured → payment.processing (NEW-CORE-4)", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "partially_captured",
          flags: { success: true, isCapture: true },
        }),
      ).toBe("payment.processing");
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          flags: { success: true, isCapture: true },
          amounts: { amountCents: 10000, capturedAmountCents: 5000 },
        }),
      ).toBe("payment.processing");
      // Full capture still stays capture-domain.
      expect(
        mapProviderEventTypeToStable("paymob", "TRANSACTION", {
          status: "paid",
          flags: { success: true, isCapture: true },
        }),
      ).toBe("capture.completed");
    });

    it("P610-MAP-2: unknown type stays provider.unmapped even if flags.success", () => {
      expect(
        mapProviderEventTypeToStable("paymob", "CARD_TOKENIZED", {
          flags: { success: true },
        }),
      ).toBe("provider.unmapped");
      expect(
        mapProviderEventTypeToStable("paymob", "UNKNOWN_CALLBACK", {
          status: "paid",
          flags: { success: true, isRefund: true },
        }),
      ).toBe("provider.unmapped");
    });
  });

  it("custom gateway unknown type → provider.unmapped", () => {
    expect(mapProviderEventTypeToStable("acme", "order.paid")).toBe(
      "provider.unmapped",
    );
  });

  it("mapping is idempotent for already-stable names", () => {
    expect(
      mapProviderEventTypeToStable("stripe", "payment.succeeded"),
    ).toBe("payment.succeeded");
  });

  it("CORE-6: stable payment.succeeded does not survive failed/pending status", () => {
    expect(
      mapProviderEventTypeToStable("stripe", "payment.succeeded", {
        status: "failed",
      }),
    ).toBe("payment.failed");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment.succeeded", {
        status: "pending",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("paypal", "payment.succeeded", {
        status: "processing",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("stripe", "payment.succeeded", {
        status: "paid",
      }),
    ).toBe("payment.succeeded");
    expect(
      mapProviderEventTypeToStable("stripe", "payment.failed", {
        status: "failed",
      }),
    ).toBe("payment.failed");
  });

  it("CORE-6-EXT: stable payment.succeeded rematches auth/approved/partial/refunded", () => {
    // NEW-CORE-11: authorized rematch matches handleWebhook
    // rematchSucceededTypeFromDomainStatus (not processing).
    expect(
      mapProviderEventTypeToStable("stripe", "payment.succeeded", {
        status: "authorized",
      }),
    ).toBe("payment.authorized");
    expect(
      mapProviderEventTypeToStable("paypal", "payment.succeeded", {
        status: "approved",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("paymob", "payment.succeeded", {
        status: "partially_captured",
      }),
    ).toBe("payment.processing");
    // No refund entity on this mapper — do not invent refund.completed.
    expect(
      mapProviderEventTypeToStable("moyasar", "payment.succeeded", {
        status: "refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("stripe", "payment.succeeded", {
        status: "partially_refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("stripe", "payment.authorized", {
        status: "authorized",
      }),
    ).toBe("payment.authorized");
  });

  it("NEW-CORE-8: already-stable capture.completed / refund.completed rematch open money", () => {
    expect(
      mapProviderEventTypeToStable("moyasar", "capture.completed", {
        status: "partially_captured",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("paypal", "capture.completed", {
        status: "processing",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "partially_captured",
      }),
    ).toBe("payment.processing");
    // NEW-CORE-11: rematchRefundCompletedTypeFromDomainStatus → refund.pending.
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "processing",
      }),
    ).toBe("refund.pending");
    // Proven full capture / refund stay settlement-ready.
    expect(
      mapProviderEventTypeToStable("moyasar", "capture.completed", {
        status: "paid",
      }),
    ).toBe("capture.completed");
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "refunded",
      }),
    ).toBe("refund.completed");
  });

  it("NEW-CORE-11: payment_intent.succeeded rematches refunded/failed/cancelled/authorized", () => {
    expect(
      mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
        status: "refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
        status: "partially_refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
        status: "failed",
      }),
    ).toBe("payment.failed");
    expect(
      mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
        status: "cancelled",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
        status: "reversed",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("stripe", "payment_intent.succeeded", {
        status: "authorized",
      }),
    ).toBe("payment.authorized");
    expect(
      mapProviderEventTypeToStable(
        "stripe",
        "checkout.session.async_payment_succeeded",
        { status: "refunded" },
      ),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable(
        "stripe",
        "checkout.session.async_payment_succeeded",
        { status: "failed" },
      ),
    ).toBe("payment.failed");
  });

  it("NEW-CORE-11: PAYMENT.CAPTURE.COMPLETED rematches open/failed/cancelled money", () => {
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "partially_captured",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "processing",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "failed",
      }),
    ).toBe("payment.failed");
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "cancelled",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "reversed",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "authorized",
      }),
    ).toBe("payment.authorized");
    expect(
      mapProviderEventTypeToStable("paypal", "PAYMENT.CAPTURE.COMPLETED", {
        status: "paid",
      }),
    ).toBe("capture.completed");
  });

  it("NEW-CORE-11: moyasar catalog rematches cancelled/failed/refunded/authorized", () => {
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_paid", {
        status: "failed",
      }),
    ).toBe("payment.failed");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_paid", {
        status: "cancelled",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_paid", {
        status: "reversed",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_paid", {
        status: "refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_captured", {
        status: "failed",
      }),
    ).toBe("payment.failed");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_captured", {
        status: "refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_captured", {
        status: "authorized",
      }),
    ).toBe("payment.authorized");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_captured", {
        status: "cancelled",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_refunded", {
        status: "failed",
      }),
    ).toBe("refund.pending");
    expect(
      mapProviderEventTypeToStable("moyasar", "payment_refunded", {
        status: "processing",
      }),
    ).toBe("refund.pending");
  });

  it("NEW-CORE-11: already-stable settlement rematches cancelled/reversed/failed/refunded/authorized", () => {
    expect(
      mapProviderEventTypeToStable("stripe", "payment.succeeded", {
        status: "cancelled",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("stripe", "payment.succeeded", {
        status: "reversed",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("paypal", "capture.completed", {
        status: "failed",
      }),
    ).toBe("payment.failed");
    expect(
      mapProviderEventTypeToStable("paypal", "capture.completed", {
        status: "cancelled",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("moyasar", "capture.completed", {
        status: "refunded",
      }),
    ).toBe("payment.processing");
    expect(
      mapProviderEventTypeToStable("stripe", "capture.completed", {
        status: "authorized",
      }),
    ).toBe("payment.authorized");
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "failed",
      }),
    ).toBe("refund.pending");
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "cancelled",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "reversed",
      }),
    ).toBe("payment.cancelled");
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "authorized",
      }),
    ).toBe("payment.authorized");
    expect(
      mapProviderEventTypeToStable("stripe", "refund.completed", {
        status: "refund_completed",
      }),
    ).toBe("refund.pending");
  });
});

describe("envelope + hash + secrets", () => {
  it("toPersistedPaymentEventEnvelope has no rawPayload key anywhere", () => {
    const pe = webhookEventToPaymentEvent(
      baseWebhook({
        rawPayload: {
          secret_token: "super-secret",
          signature: "sig",
          data: { amount: 100 },
        },
      }),
      { includeRawOnPayment: true },
    );
    // force raw on payment for the strip test
    if ("payment" in pe && pe.payment) {
      pe.payment.rawResponse = { secret_token: "x" };
    }

    const envelope = toPersistedPaymentEventEnvelope(pe, {
      rawForHash: {
        secret_token: "super-secret",
        data: { amount: 100 },
      },
      storedAt: "2024-01-15T12:05:00.000Z",
    });

    expect(envelope.schemaVersion).toBe("1");
    expect(envelope.storedAt).toBe("2024-01-15T12:05:00.000Z");
    expect(envelope.payloadHash).toMatch(/^[a-f0-9]{64}$/);

    const json = JSON.stringify(envelope);
    expect(json).not.toContain("rawPayload");
    expect(json).not.toContain("rawResponse");
    expect(json).not.toContain("super-secret");
    expect(json).not.toContain("secret_token");

    assertNoSecretsInEnvelope(envelope);
  });

  it("CORE-3: toPersistedPaymentEventEnvelope fails closed without payloadHash/rawForHash", () => {
    const pe = webhookEventToPaymentEvent(baseWebhook());
    expect(() => toPersistedPaymentEventEnvelope(pe)).toThrow(
      /payloadHash or rawForHash/,
    );
    expect(() => toPersistedPaymentEventEnvelope(pe, {})).toThrow(
      /payloadHash or rawForHash/,
    );
    expect(() =>
      toPersistedPaymentEventEnvelope(pe, { payloadHash: "" }),
    ).toThrow(/non-empty string/);
    expect(() =>
      toPersistedPaymentEventEnvelope(pe, { payloadHash: "   " }),
    ).toThrow(/non-empty string/);
    // Explicit rawForHash (even empty object) is intentional — not the silent default.
    const withEmptyRaw = toPersistedPaymentEventEnvelope(pe, {
      rawForHash: {},
    });
    expect(withEmptyRaw.payloadHash).toBe(hashWebhookPayload({}));
    const withHash = toPersistedPaymentEventEnvelope(pe, {
      payloadHash: "a".repeat(64),
    });
    expect(withHash.payloadHash).toBe("a".repeat(64));
  });

  it("hashWebhookPayload redacts secret_token / signature", () => {
    const withSecrets = hashWebhookPayload({
      id: "1",
      secret_token: "shh",
      signature: "sig",
      amount: 10,
    });
    const redacted = hashWebhookPayload({
      id: "1",
      secret_token: "[REDACTED]",
      signature: "[REDACTED]",
      amount: 10,
    });
    expect(withSecrets).toBe(redacted);

    const withoutSecrets = hashWebhookPayload({ id: "1", amount: 10 });
    expect(withSecrets).not.toBe(withoutSecrets);
  });

  it("hashWebhookPayload returns 64-char lowercase hex (portable sha256)", () => {
    const h = hashWebhookPayload({ id: "1", amount: 10 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Stable known input — pure sha256 of redacted canonical JSON
    expect(h).toBe(hashWebhookPayload({ id: "1", amount: 10 }));
  });

  it("hash is key-order independent", () => {
    const a = hashWebhookPayload({ b: 2, a: 1 });
    const b = hashWebhookPayload({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("redactWebhookPayloadSecrets replaces nested secrets", () => {
    const out = redactWebhookPayloadSecrets({
      outer: { secret_token: "x", keep: 1 },
      hmac: "h",
    }) as Record<string, unknown>;
    expect((out.outer as Record<string, unknown>).secret_token).toBe(
      "[REDACTED]",
    );
    expect((out.outer as Record<string, unknown>).keep).toBe(1);
    expect(out.hmac).toBe("[REDACTED]");
  });

  it("P610-HASH-1: redactDeep / hashWebhookPayload parse JSON strings and redact", () => {
    const secret = "super-secret-hash-value";
    const asString = JSON.stringify({
      id: "1",
      secret_token: secret,
      amount: 10,
    });
    const redacted = redactWebhookPayloadSecrets(asString);
    const redactedText =
      typeof redacted === "string" ? redacted : JSON.stringify(redacted);
    expect(redactedText).not.toContain(secret);
    expect(redactedText).toContain("[REDACTED]");

    const nested = {
      wrapper: JSON.stringify({ secret_token: "nested-secret-xyz", ok: true }),
    };
    expect(JSON.stringify(redactWebhookPayloadSecrets(nested))).not.toContain(
      "nested-secret-xyz",
    );

    const h1 = hashWebhookPayload(
      JSON.stringify({ id: "1", secret_token: "a", amount: 10 }),
    );
    const h2 = hashWebhookPayload(
      JSON.stringify({ id: "1", secret_token: "[REDACTED]", amount: 10 }),
    );
    expect(h1).toBe(h2);

    // WEBHOOKS-2: string vs object digests may still differ after redaction.
    expect(hashWebhookPayload(JSON.stringify({ id: "1", amount: 10 }))).not.toBe(
      hashWebhookPayload({ id: "1", amount: 10 }),
    );
  });

  it("P610-HASH-2: hashes actual Uint8Array/Buffer bytes, not length markers", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(a.length).toBe(b.length);
    expect(hashWebhookPayload(a)).not.toBe(hashWebhookPayload(b));
    expect(hashWebhookPayload(a)).toBe(hashWebhookPayload(new Uint8Array(a)));
    expect(hashWebhookPayload(a)).toBe(hashWebhookPayload(Buffer.from(a)));
    expect(hashWebhookPayload(Buffer.from(a))).toBe(
      hashWebhookPayload(Buffer.from(a)),
    );

    const nestedA = hashWebhookPayload({ bin: new Uint8Array([1, 2, 3]) });
    const nestedB = hashWebhookPayload({ bin: new Uint8Array([9, 8, 7]) });
    expect(nestedA).not.toBe(nestedB);
  });

  it("P610-RED-1: camelCase secret aliases are redacted", () => {
    expect(WEBHOOK_PAYLOAD_SECRET_KEYS).toEqual(
      expect.arrayContaining([
        "clientSecret",
        "secretToken",
        "webhookSecret",
        "accessToken",
      ]),
    );

    const out = redactWebhookPayloadSecrets({
      clientSecret: "cs_live_xxx",
      secretToken: "st_live_xxx",
      webhookSecret: "whsec_xxx",
      accessToken: "tok_xxx",
      keep: 1,
    }) as Record<string, unknown>;
    expect(out.clientSecret).toBe("[REDACTED]");
    expect(out.secretToken).toBe("[REDACTED]");
    expect(out.webhookSecret).toBe("[REDACTED]");
    expect(out.accessToken).toBe("[REDACTED]");
    expect(out.keep).toBe(1);

    expect(
      hashWebhookPayload({ id: "1", clientSecret: "cs_live_xxx", n: 1 }),
    ).toBe(
      hashWebhookPayload({ id: "1", clientSecret: "[REDACTED]", n: 1 }),
    );
  });

  it("NEW-MONEY-2: PAN/CVC keys the logger scrubs are redacted", () => {
    expect(WEBHOOK_PAYLOAD_SECRET_KEYS).toEqual(
      expect.arrayContaining(["number", "cvc", "cvv", "pan", "card"]),
    );

    const out = redactWebhookPayloadSecrets({
      number: "4111111111111111",
      cvc: "123",
      cvv: "456",
      pan: "5555555555554444",
      card: { number: "4242424242424242" },
      keep: 1,
    }) as Record<string, unknown>;
    expect(out.number).toBe("[REDACTED]");
    expect(out.cvc).toBe("[REDACTED]");
    expect(out.cvv).toBe("[REDACTED]");
    expect(out.pan).toBe("[REDACTED]");
    expect(out.card).toBe("[REDACTED]");
    expect(out.keep).toBe(1);
  });

  it("P610-RED-1: stripRawFromPaymentEvent strips nested nextAction.clientSecret", () => {
    const pe = webhookEventToPaymentEvent(baseWebhook());
    if (!("payment" in pe) || !pe.payment) throw new Error("expected payment");
    pe.payment.clientSecret = "cs_live_top";
    pe.payment.nextAction = {
      type: "redirect",
      url: "https://example.com/3ds",
      clientSecret: "cs_live_nested",
    };

    const stripped = stripRawFromPaymentEvent(pe);
    if (!("payment" in stripped) || !stripped.payment) {
      throw new Error("expected payment");
    }
    expect(stripped.payment.clientSecret).toBeUndefined();
    expect(
      (stripped.payment.nextAction as { clientSecret?: string } | undefined)
        ?.clientSecret,
    ).toBeUndefined();
    expect(
      (stripped.payment.nextAction as { url?: string } | undefined)?.url,
    ).toBe("https://example.com/3ds");

    const envelope = toPersistedPaymentEventEnvelope(pe, {
      rawForHash: { id: "1" },
    });
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("cs_live_top");
    expect(json).not.toContain("cs_live_nested");
    expect(json).toContain("https://example.com/3ds");
    assertNoSecretsInEnvelope(envelope);
  });

  it("encryptRawWebhookPayload roundtrips with fake codec", async () => {
    const codec: RawWebhookPayloadCodec = {
      encrypt(plaintext) {
        const s =
          typeof plaintext === "string"
            ? plaintext
            : new TextDecoder().decode(plaintext);
        return `enc:${s}`;
      },
      decrypt(ciphertext) {
        return ciphertext.replace(/^enc:/, "");
      },
    };

    const raw = { id: "evt", secret_token: "s", n: 1 };
    const record = await encryptRawWebhookPayload(raw, codec, {
      codecId: "test-codec",
    });

    expect(record.schemaVersion).toBe("1");
    expect(record.codecId).toBe("test-codec");
    expect(record.payloadHash).toBe(hashWebhookPayload(raw));
    expect(record.ciphertext.startsWith("enc:")).toBe(true);

    const decrypted = await Promise.resolve(codec.decrypt(record.ciphertext));
    expect(typeof decrypted === "string" ? decrypted : "").toContain("evt");
  });

  it("encryptRawWebhookPayload redacts secret keys in JSON string before codec", async () => {
    let seen: string | Uint8Array | undefined;
    const codec: RawWebhookPayloadCodec = {
      encrypt(plaintext) {
        seen = plaintext;
        return typeof plaintext === "string"
          ? `enc:${plaintext}`
          : "enc:bin";
      },
      decrypt(ciphertext) {
        return ciphertext.replace(/^enc:/, "");
      },
    };

    const raw = JSON.stringify({
      id: "evt",
      secret_token: "super-secret-value",
      n: 1,
    });
    const record = await encryptRawWebhookPayload(raw, codec);

    expect(typeof seen).toBe("string");
    const plaintext = seen as string;
    expect(plaintext).not.toContain("super-secret-value");
    expect(plaintext).toContain("[REDACTED]");
    expect(plaintext).toContain("evt");
    expect(record.payloadHash).toBe(hashWebhookPayload(raw));
    expect(record.ciphertext).not.toContain("super-secret-value");
  });

  it("buildProviderEventMetadata uses ISO times", () => {
    const meta = buildProviderEventMetadata(
      baseWebhook({
        apiVersion: "2024-01-01",
        livemode: true,
      }),
      { receivedAt: "2024-02-01T00:00:00.000Z" },
    );
    expect(meta.occurredAt).toBe("2024-01-15T12:00:00.000Z");
    expect(meta.receivedAt).toBe("2024-02-01T00:00:00.000Z");
    expect(meta.apiVersion).toBe("2024-01-01");
    expect(meta.livemode).toBe(true);
  });
});

describe("envelope type shape", () => {
  it("PersistedPaymentEventEnvelope requires schemaVersion 1", () => {
    const event = webhookEventToPaymentEvent(baseWebhook());
    const envelope: PersistedPaymentEventEnvelope = {
      schemaVersion: "1",
      event,
      payloadHash: hashWebhookPayload({}),
      storedAt: new Date().toISOString(),
    };
    expect(envelope.schemaVersion).toBe("1");
  });
});

describe("P22-DASH-URL dispute webhook dashboard URLs", () => {
  function stripeDisputeWebhook(input: {
    charge?: unknown;
    livemode?: boolean;
    disputeId?: string;
  }): WebhookEvent {
    const disputeId = input.disputeId ?? "dp_1";
    const livemode = input.livemode ?? false;
    return {
      id: "evt_dp",
      type: "charge.dispute.created",
      gateway: "stripe",
      paymentId: undefined,
      gatewayPaymentId: "pi_1",
      gatewayObjectId: disputeId,
      status: "needs_response",
      timestamp: new Date(),
      livemode,
      rawPayload: {
        id: "evt_dp",
        type: "charge.dispute.created",
        data: {
          object: {
            id: disputeId,
            object: "dispute",
            status: "needs_response",
            charge: input.charge,
            payment_intent: "pi_1",
            livemode,
          },
        },
      },
    };
  }

  function openedDashboardUrl(
    event: ReturnType<typeof webhookEventToPaymentEvent>,
  ): string {
    expect(event.type).toBe("dispute.opened");
    if (event.type !== "dispute.opened") {
      expect.unreachable("must be dispute.opened");
    }
    expect(event.dispute.dashboardUrl).toBeDefined();
    return event.dispute.dashboardUrl as string;
  }

  it("uses /test/payments/{id} for a canonical charge id in test mode", () => {
    expect(
      openedDashboardUrl(
        webhookEventToPaymentEvent(
          stripeDisputeWebhook({ charge: "ch_1", livemode: false }),
        ),
      ),
    ).toBe("https://dashboard.stripe.com/test/payments/ch_1");
  });

  it("uses the live host (no /test) when livemode is true", () => {
    const url = openedDashboardUrl(
      webhookEventToPaymentEvent(
        stripeDisputeWebhook({ charge: "ch_live_abc", livemode: true }),
      ),
    );
    expect(url).toBe("https://dashboard.stripe.com/payments/ch_live_abc");
    expect(url).not.toContain("/test/");
  });

  it.each([
    "ch_",
    "ch_abc-def",
    "ch_abc/../x",
    "ch_abc.def",
    "ch_abc?foo=1",
    "ch_abc def",
  ])(
    "does not treat prefix-only charge id %s as a payments URL",
    (charge) => {
      const event = webhookEventToPaymentEvent(
        stripeDisputeWebhook({ charge, livemode: false }),
      );
      expect(openedDashboardUrl(event)).toBe(
        "https://dashboard.stripe.com/test/disputes/dp_1",
      );
      if (event.type !== "dispute.opened") {
        expect.unreachable("must be dispute.opened");
      }
      expect(event.dispute.references.relatedIds?.chargeId).toBe(charge);
    },
  );

  it("accepts an expanded charge object with a canonical id", () => {
    expect(
      openedDashboardUrl(
        webhookEventToPaymentEvent(
          stripeDisputeWebhook({
            charge: { id: "ch_expanded_1" },
            livemode: false,
          }),
        ),
      ),
    ).toBe("https://dashboard.stripe.com/test/payments/ch_expanded_1");
  });

  it("falls back to /disputes/{id} for an expanded charge with a non-canonical id", () => {
    expect(
      openedDashboardUrl(
        webhookEventToPaymentEvent(
          stripeDisputeWebhook({
            charge: { id: "ch_bad-id" },
            livemode: true,
          }),
        ),
      ),
    ).toBe("https://dashboard.stripe.com/disputes/dp_1");
  });
});
