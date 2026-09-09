import { describe, expect, it } from "bun:test";
import { parseHesabeWebhookEvent } from "./webhooks";

const clock = { now: () => new Date(1000), nowMs: () => 1000 };
const notification = {
  token: "transaction1",
  amount: "49.000",
  reference_number: "order1",
  status: "SUCCESSFUL",
};

describe("Hesabe notification normalization", () => {
  it.each([
    ["SUCCESSFUL", "payment.succeeded", "paid"],
    ["FAILED", "payment.failed", "failed"],
    ["PENDING", "payment.processing", "pending"],
  ])("keeps %s consistent across both event representations", (native, stable, status) => {
    const event = parseHesabeWebhookEvent({ ...notification, status: native }, clock);
    expect(event.status).toBe(status);
    expect(event.stableType).toBe(stable);
    expect(event.event?.type).toBe(stable);
    expect(event.provider?.eventType).toBe(`transaction.${native}`);
    expect(event.event?.provider.eventType).toBe(event.type);
  });
  it("leaves unknown statuses unmapped", () => {
    const event = parseHesabeWebhookEvent({ ...notification, status: "NEW_STATUS" }, clock);
    expect(event.stableType).toBeUndefined();
    expect(event.event?.type).toBe("provider.unmapped");
  });
  it("deduplicates equivalent amounts and ignores unverified extras", () => {
    const original = parseHesabeWebhookEvent(notification, clock);
    const forged = parseHesabeWebhookEvent(
      JSON.stringify({
        ...notification,
        amount: "49",
        datetime: "2099-01-01",
        refunded: true,
        paymentId: "wrong-order",
        currency: "USD",
        rawPayload: { status: "FAILED" },
      }),
      clock,
    );
    expect(forged.id).toBe(original.id);
    expect(forged.event).toEqual(original.event);
    expect(forged.timestamp).toEqual(clock.now());
    expect(forged.rawPayload).not.toHaveProperty("refunded");
    expect(forged.currency).toBe("KWD");
  });
});
