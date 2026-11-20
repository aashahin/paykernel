/**
 * `processOne(key)`: the by-key counterpart of one `processRetryable` row.
 * Same lease/attempt/backoff semantics, no other key is touched.
 */
import { describe, it, expect } from "bun:test";
import { createWebhookInboxEngine } from "./engine";
import { createMemoryWebhookInboxStore } from "./memory-store";
import { createTestClock } from "./test-clock";

const EVENT = { id: "evt", type: "payment.succeeded" };

function setup(opts: { maxAttempts?: number; retryAfterMs?: number } = {}) {
  const clock = createTestClock();
  const store = createMemoryWebhookInboxStore({ clock });
  const inline = createWebhookInboxEngine({ store, mode: "inline", clock });
  const engine = createWebhookInboxEngine({
    store,
    mode: "durable_retry",
    clock,
    defaultRetryAfterMs: opts.retryAfterMs ?? 0,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  });
  /** Park a row as pending with a stored payloadRef (first delivery fails once). */
  async function park(id: string) {
    await inline.processVerified({
      gateway: "stripe",
      providerEventId: id,
      payloadHash: `h-${id}`,
      event: { ...EVENT, id },
      handler: async () => {
        throw new Error("transient");
      },
    });
    return `stripe:${id}`;
  }
  return { clock, store, engine, inline, park };
}

describe("processOne", () => {
  it("processes only the named key, however many older rows are due", async () => {
    const { engine, store, park, clock } = setup();
    const older: string[] = [];
    for (let i = 0; i < 12; i++) {
      older.push(await park(`old${i}`));
      clock.advance?.(1);
    }
    const target = await park("target");
    const ran: string[] = [];
    const r = await engine.processOne({
      key: target,
      handler: async (ctx) => {
        ran.push(ctx.key);
      },
    });
    expect(r).toEqual({ key: target, found: true, outcome: { outcome: "processed" } });
    expect(ran).toEqual([target]);
    expect((await store.get(target))?.status).toBe("completed");
    for (const k of older) expect((await store.get(k))?.status).toBe("pending");
  });

  it("reports an unknown key without running the handler", async () => {
    const { engine } = setup();
    let runs = 0;
    const r = await engine.processOne({ key: "stripe:nope", handler: async () => void runs++ });
    expect(r).toEqual({ key: "stripe:nope", found: false });
    expect(runs).toBe(0);
  });

  it("reports completed and dead-lettered rows as terminal and never re-runs them", async () => {
    const { engine, store, park } = setup();
    const done = await park("done");
    await engine.processOne({ key: done, handler: async () => {} });
    const again = await engine.processOne({ key: done, handler: async () => { throw new Error("must not run"); } });
    expect(again).toEqual({ key: done, found: true, outcome: { outcome: "duplicate_completed" } });

    const dead = await park("dead");
    await engine.processOne({
      key: dead,
      handler: async () => {
        throw new (await import("./types")).NonRetryableHandlerError("bad");
      },
    });
    expect((await store.get(dead))?.status).toBe("dead_letter");
    const r = await engine.processOne({ key: dead, handler: async () => { throw new Error("must not run"); } });
    expect(r).toEqual({ key: dead, found: true, outcome: { outcome: "handler_failed", retryable: false } });
  });

  it("honours a live lease: a second claim is already_processing and the handler does not run", async () => {
    const { engine, park } = setup();
    const key = await park("leased");
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const first = engine.processOne({ key, handler: async () => gate });
    await new Promise((r) => setTimeout(r, 5));
    let secondRuns = 0;
    const second = await engine.processOne({ key, handler: async () => void secondRuns++ });
    expect(second.found && second.outcome.outcome).toBe("already_processing");
    expect(secondRuns).toBe(0);
    release();
    expect(await first).toEqual({ key, found: true, outcome: { outcome: "processed" } });
  });

  it("concurrent processOne on one key runs the handler once", async () => {
    const { engine, park } = setup();
    const key = await park("race");
    let runs = 0;
    const handler = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 5));
    };
    const rs = await Promise.all([1, 2, 3].map(() => engine.processOne({ key, handler })));
    expect(runs).toBe(1);
    expect(rs.filter((r) => r.found && r.outcome.outcome === "processed")).toHaveLength(1);
  });

  it("respects availableAt backoff: not due yet runs nothing and spends no attempt", async () => {
    const { engine, store, park, clock } = setup({ retryAfterMs: 60_000 });
    const key = await park("backoff");
    // first delivery failure set availableAt = now + 0 (inline default); push it out via a by-key failure
    await engine.processOne({ key, handler: async () => { throw new Error("again"); } });
    const before = await store.get(key);
    expect(before?.status).toBe("pending");
    let runs = 0;
    const r = await engine.processOne({ key, handler: async () => void runs++ });
    expect(r.found && r.outcome.outcome).toBe("scheduled_for_retry");
    expect(runs).toBe(0);
    expect((await store.get(key))?.attempts).toBe(before?.attempts);
    clock.advance?.(60_001);
    const later = await engine.processOne({ key, handler: async () => void runs++ });
    expect(later.found && later.outcome.outcome).toBe("processed");
    expect(runs).toBe(1);
  });

  it("recovers an expired lease without burning an attempt, and fences the old token", async () => {
    const { engine, store, park, clock } = setup();
    const key = await park("crash");
    // simulate a crashed holder: claim and never finish
    const claim = await store.claim({ key, payloadHash: "h-crash", owner: "dead", leaseMs: 30_000 });
    expect(claim.kind).toBe("acquired");
    const attemptsHeld = (await store.get(key))?.attempts ?? 0;
    clock.advance?.(30_001);
    const r = await engine.processOne({ key, handler: async () => {} });
    expect(r).toEqual({ key, found: true, outcome: { outcome: "processed" } });
    expect(attemptsHeld).toBeGreaterThan(0);
    if (claim.kind === "acquired") {
      await expect(store.complete({ key, leaseToken: claim.leaseToken })).rejects.toThrow();
    }
  });

  it("forwards a custom owner and leaseMs, and defaults the lease to 30s", async () => {
    const { engine, store, park, clock } = setup();
    const custom = await park("lease-custom");
    const dflt = await park("lease-default");
    let owner: string | undefined;
    let customMs = 0;
    let defaultMs = 0;
    await engine.processOne({
      key: custom,
      owner: "worker-x",
      leaseMs: 45_000,
      handler: async () => {
        const rec = await store.get(custom);
        owner = rec?.leaseOwner;
        customMs = Date.parse(rec?.leaseExpiresAt ?? "") - clock.nowMs();
      },
    });
    await engine.processOne({
      key: dflt,
      handler: async () => {
        const rec = await store.get(dflt);
        defaultMs = Date.parse(rec?.leaseExpiresAt ?? "") - clock.nowMs();
      },
    });
    expect(owner).toBe("worker-x");
    expect(customMs).toBe(45_000);
    expect(defaultMs).toBe(30_000);
  });

  it("a row without a payloadRef is left pending, retryable, and the handler does not run", async () => {
    const { engine, store } = setup();
    await store.claim({ key: "stripe:bare", payloadHash: "h", owner: "o", leaseMs: 1 });
    const rec0 = await store.get("stripe:bare");
    // release it to pending without a payloadRef
    await store.fail({ key: "stripe:bare", leaseToken: rec0!.leaseToken!, error: "x" });
    let runs = 0;
    const r = await engine.processOne({ key: "stripe:bare", handler: async () => void runs++ });
    expect(r).toEqual({ key: "stripe:bare", found: true, outcome: { outcome: "handler_failed", retryable: true } });
    expect(runs).toBe(0);
  });

  it("throws on an inline engine, like processRetryable", async () => {
    const { inline } = setup();
    await expect(inline.processOne({ key: "stripe:x", handler: async () => {} })).rejects.toThrow(/durable_retry/);
  });

  it("matches processRetryable for the same single row", async () => {
    const a = setup();
    const b = setup();
    const ka = await a.park("same");
    await b.park("same");
    const viaOne = await a.engine.processOne({ key: ka, handler: async () => {} });
    const viaList = await b.engine.processRetryable({ handler: async () => {} });
    expect(viaOne.found && viaOne.outcome).toEqual(viaList.items[0]?.outcome);
    expect(await a.store.get(ka)).toMatchObject({ status: "completed", attempts: (await b.store.get(ka))?.attempts });
  });
});
