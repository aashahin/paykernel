import { describe, expect, it } from "bun:test";
import {
  InMemoryIdempotencyStore,
  money,
  type GatewayPaymentResult,
  type GatewayRefundResult,
  type IdempotencyStore,
} from "@paykernel/core";
import { withHesabeReservation } from "./reservations";

const payment: GatewayPaymentResult = {
  gatewayId: "checkout:token",
  outcome: "requires_action",
  status: "pending",
  redirectUrl: "https://sandbox.hesabe.com/payment?data=token",
  amount: money("1.234", "KWD"),
  currency: "KWD",
  rawResponse: {},
};

function input(store: IdempotencyStore, amount = "1.234") {
  return {
    store,
    key: "hesabe-reservation-test",
    fingerprintInput: { amount: money(amount, "KWD") },
    createdAt: 100,
  };
}

describe("Hesabe mutation reservations", () => {
  it("replays the first result and rejects changed inputs without another submission", async () => {
    const store = new InMemoryIdempotencyStore();
    let submissions = 0;
    const submit = async (markSubmitted: () => void) => {
      markSubmitted();
      submissions++;
      return payment;
    };
    await withHesabeReservation(input(store), submit);
    const replay = await withHesabeReservation(input(store), submit);
    expect(replay).toEqual(payment);
    await expect(withHesabeReservation(input(store, "2.000"), submit)).rejects.toThrow(
      "different params",
    );
    expect(submissions).toBe(1);
  });

  it("allows only one concurrent submission", async () => {
    const store = new InMemoryIdempotencyStore();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submissions = 0;
    const first = withHesabeReservation(input(store), async (markSubmitted) => {
      markSubmitted();
      submissions++;
      await pending;
      return payment;
    });
    await expect(
      withHesabeReservation(input(store), async () => {
        submissions++;
        return payment;
      }),
    ).rejects.toThrow("already in progress");
    release();
    await first;
    expect(submissions).toBe(1);
  });

  it("releases a reservation only when failure occurred before submission", async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(
      withHesabeReservation(input(store), async () => {
        throw new Error("authentication unavailable");
      }),
    ).rejects.toThrow("authentication unavailable");
    expect(store.get(input(store).key)).toBeUndefined();
    await expect(
      withHesabeReservation(input(store), async (markSubmitted) => {
        markSubmitted();
        throw new Error("connection lost");
      }),
    ).rejects.toThrow("connection lost");
    expect(store.get(input(store).key)?.status).toBe("in_progress");
  });

  it("retains unknown outcomes and never submits them again", async () => {
    const store = new InMemoryIdempotencyStore();
    const uncertain: GatewayPaymentResult = {
      ...payment,
      outcome: "indeterminate",
      reconciliationRequired: true,
    };
    await withHesabeReservation(input(store), async (markSubmitted) => {
      markSubmitted();
      return uncertain;
    });
    expect(store.get(input(store).key)?.status).toBe("unknown");
    await expect(withHesabeReservation(input(store), async () => payment)).rejects.toThrow(
      "reconcile",
    );
  });

  it.each([
    payment,
    {
      gatewayRefundId: "1467",
      outcome: "pending",
      status: "pending",
      rawResponse: {},
    } satisfies GatewayRefundResult,
  ])("returns indeterminate when submitted results cannot be persisted", async (result) => {
    const backing = new InMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      get: backing.get.bind(backing),
      reserve: backing.reserve.bind(backing),
      delete: backing.delete.bind(backing),
      set: () => {
        throw new Error("storage unavailable");
      },
    };
    let submissions = 0;
    const execute = async (markSubmitted: () => void) => {
      markSubmitted();
      submissions++;
      return result;
    };
    const uncertain = await withHesabeReservation(input(store), execute);
    expect(uncertain.outcome).toBe("indeterminate");
    expect(uncertain.reconciliationRequired).toBe(true);
    expect(backing.get(input(store).key)?.status).toBe("in_progress");
    await expect(withHesabeReservation(input(store), execute)).rejects.toThrow("in progress");
    expect(submissions).toBe(1);
  });
});
