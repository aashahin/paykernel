/** Gateway regressions for audit fixes F3/F8/F9 (real code, in-memory inbox, no network). */
import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { HooksManager } from "../packages/core/src/hooks/hooks.manager";
import { createPaymentClient } from "../packages/core/src/create-payment-client";
import { TapGateway } from "../packages/gateway-tap/src/gateway";
import { tapGateway } from "../packages/gateway-tap/src/factory";
import {
  computeTapHashstring,
  hashFieldsFromTapObject,
} from "../packages/gateway-tap/src/webhooks";
import { authorizedObject, refundedObject } from "../packages/gateway-tap/src/fixtures/charges";
import { MyFatoorahGateway } from "../packages/gateway-myfatoorah/src/gateway";
import {
  canonicalMyFatoorahString,
  computeMyFatoorahSignature,
} from "../packages/gateway-myfatoorah/src/webhooks";
import { paymentWebhook } from "../packages/gateway-myfatoorah/src/fixtures/webhooks";
import { createWebhookInboxEngine } from "../packages/webhooks/src/engine";
import { createMemoryWebhookInboxStore } from "../packages/webhooks/src/memory-store";

const TAP_SECRET = "sk_test_regression_placeholder_not_live";
const MF_SECRET = "whsec_test_regression_placeholder";

const noNetwork = (async () => {
  throw new Error("Unexpected network request");
}) as typeof fetch;

function tapForWebhooks() {
  return new TapGateway({ secretKey: TAP_SECRET }, new HooksManager({}), undefined, {
    fetch: noNetwork,
  });
}

describe("F3 tap authorize/void inbox keeps both statuses and dedupes unsigned replay", () => {
  it("AUTHORIZED then VOID process once each; VOID replay with changed metadata dedupes", async () => {
    const tap = tapForWebhooks();
    const engine = createWebhookInboxEngine({
      store: createMemoryWebhookInboxStore(),
      mode: "inline",
    });
    const seen: string[] = [];
    const outcomes: string[] = [];

    for (const status of ["AUTHORIZED", "VOID"] as const) {
      const raw = authorizedObject({ status });
      const signature = computeTapHashstring(hashFieldsFromTapObject(raw), TAP_SECRET);
      expect(tap.verifyWebhook(raw, signature)).toBe(true);
      const event = tap.parseWebhookEvent(raw);
      expect(event.gatewayPaymentId).toBe(raw.id);
      expect(event.gatewayPaymentId).not.toBe(event.id);
      expect(event.id.startsWith(`${String(raw.id)}:`)).toBe(true);
      const result = await engine.processVerified({
        gateway: "tap",
        providerEventId: event.id,
        payloadHash: event.payloadHash!,
        event,
        handler: async () => {
          seen.push(status);
        },
      });
      outcomes.push(result.outcome);
    }

    // Repeated VOID with changed UNSIGNED metadata: same signed hash, same payloadHash.
    const firstVoid = authorizedObject({ status: "VOID" });
    const firstVoidEvent = tap.parseWebhookEvent(firstVoid);
    const replay = authorizedObject({
      status: "VOID",
      metadata: { note: "changed-unsigned-field" },
    });
    const replaySignature = computeTapHashstring(hashFieldsFromTapObject(replay), TAP_SECRET);
    expect(tap.verifyWebhook(replay, replaySignature)).toBe(true);
    const replayEvent = tap.parseWebhookEvent(replay);
    expect(replayEvent.id).toBe(firstVoidEvent.id);
    expect(replayEvent.payloadHash).toBe(firstVoidEvent.payloadHash);
    expect(replayEvent.gatewayPaymentId).toBe(replay.id);
    expect(replayEvent.gatewayPaymentId).not.toBe(replayEvent.id);
    const payment =
      replayEvent.event !== undefined && "payment" in replayEvent.event
        ? replayEvent.event.payment
        : undefined;
    expect(payment?.references.relatedIds?.authorizationId).toBe(replay.id);

    const replayResult = await engine.processVerified({
      gateway: "tap",
      providerEventId: replayEvent.id,
      payloadHash: replayEvent.payloadHash!,
      event: replayEvent,
      handler: async () => {
        seen.push("VOID-replay");
      },
    });
    outcomes.push(replayResult.outcome);

    expect(seen).toEqual(["AUTHORIZED", "VOID"]);
    expect(outcomes).toEqual(["processed", "processed", "duplicate_completed"]);
  });

  it("refund PENDING then REFUNDED both process with charge identity", async () => {
    const tap = tapForWebhooks();
    const engine = createWebhookInboxEngine({
      store: createMemoryWebhookInboxStore(),
      mode: "inline",
    });
    const outcomes: string[] = [];
    const statuses: string[] = [];
    for (const status of ["PENDING", "REFUNDED"] as const) {
      const raw = refundedObject({ status });
      const signature = computeTapHashstring(hashFieldsFromTapObject(raw), TAP_SECRET);
      expect(tap.verifyWebhook(raw, signature)).toBe(true);
      const event = tap.parseWebhookEvent(raw);
      expect(event.gatewayPaymentId).toBe("chg_testCaptured01");
      expect(event.gatewayPaymentId).not.toBe(event.id);
      statuses.push(event.status);
      const result = await engine.processVerified({
        gateway: "tap",
        providerEventId: event.id,
        payloadHash: event.payloadHash!,
        event,
        handler: async () => {},
      });
      outcomes.push(result.outcome);
    }
    expect(statuses).toEqual(["pending", "refunded"]);
    expect(outcomes).toEqual(["processed", "processed"]);
  });
});

describe("F8 tap invoice PAID stays native unmapped processing", () => {
  it("signed invoice PAID via public handleWebhook never fulfills payment", async () => {
    const client = createPaymentClient({
      gateways: { tap: tapGateway({ secretKey: TAP_SECRET }) },
      runtime: { fetch: noNetwork },
    });
    const raw = {
      id: "inv_regression01",
      object: "invoice",
      status: "PAID",
      amount: 10,
      currency: "SAR",
      created: "1750000000000",
      updated: "1750000001000",
    };
    const signature = computeTapHashstring(hashFieldsFromTapObject(raw), TAP_SECRET);
    const event = await client.handleWebhook("tap", JSON.stringify(raw), signature);

    expect(event.type).toBe("invoice.PAID");
    // Nonterminal placeholder: never paid/cancelled/refunded/failed.
    expect(event.status).toBe("processing");
    expect(event.gatewayPaymentId).toBe("inv_regression01");
    expect(event.stableType).toBeUndefined();
    expect(event.event?.type).toBe("provider.unmapped");
    expect(event.provider?.eventType).toBe("invoice.PAID");
    if (event.event !== undefined && "payment" in event.event) {
      expect(event.event.provider.eventType).toBe("invoice.PAID");
    } else {
      throw new Error("expected dual-write payment event for invoice");
    }
    expect((event.rawPayload as { status?: unknown }).status).toBe("PAID");
  });
});

describe("F9 myfatoorah raw-body signature accepts string/Buffer/Uint8Array", () => {
  it("identical signature verifies across body shapes; malformed inputs fail closed", () => {
    const gateway = new MyFatoorahGateway(
      { apiToken: "audit-token", country: "KWT", webhookSecret: MF_SECRET },
      new HooksManager({}),
      undefined,
      { fetch: noNetwork },
    );
    const raw = JSON.stringify(paymentWebhook());
    const signature = computeMyFatoorahSignature(canonicalMyFatoorahString(raw), MF_SECRET);

    expect(gateway.verifyWebhook(raw, signature)).toBe(true);
    expect(gateway.verifyWebhook(Buffer.from(raw, "utf8"), signature)).toBe(true);
    expect(gateway.verifyWebhook(new TextEncoder().encode(raw), signature)).toBe(true);

    expect(gateway.verifyWebhook(new Uint8Array([0xff, 0xfe, 0xfd]), signature)).toBe(false);
    expect(gateway.verifyWebhook("not-json{{{", signature)).toBe(false);
    expect(gateway.verifyWebhook(raw, "not-base64!")).toBe(false);
    expect(gateway.verifyWebhook(raw, "abcd")).toBe(false);
  });
});
