import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { AppEnv } from "../src/env";
import { createOrder } from "../src/server/payments/orders";
import { reserveAttempt, getAttempt } from "../src/server/payments/attempts";
import { applyPaymentEvidence } from "../src/server/payments/evidence";
import { reserveOperation, markOperationSubmitted, listOperationsByAttempt } from "../src/server/payments/operations";
import { reconcileAttempt, performPaymentAction } from "../src/server/payment-actions";
import { handleGatewayWebhook } from "../src/server/webhook-service";
import { createSandboxDriver } from "../src/server/gateways/index";
import { createGatewayIdempotencyStore } from "../src/server/sdk-stores";
import { createHmac } from "node:crypto";
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('test'); } }", compatibilityDate: "2026-09-09", d1Databases: ["DB"] }));
let env: AppEnv;
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  const db = await runtime.getD1Database("DB");
  for (const name of ["0002_payments", "0003_sdk_stores", "0004_checkout_details", "0005_operation_baseline"]) {
    const sql = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  }
  env = { DB: db, APP_ORIGIN: "https://lab.example", TESTER_EMAILS: "tester@example.com", PAYMOB_API_KEY: "legacy-fixture-key", PAYMOB_SECRET_KEY: "sk_test_fixture", PAYMOB_PUBLIC_KEY: "pk_test_fixture", PAYMOB_INTEGRATION_ID: "123", PAYMOB_HMAC_SECRET: "fixture-hmac" } as AppEnv;
});
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => runtime.dispose());
async function pending() {
  const order = await createOrder(env.DB, { guestTokenHash: crypto.randomUUID(), customerName: "Buyer", customerEmail: "buyer@example.com", currency: "EGP", totalMinor: 1000, items: [{ sku: "book", name: "Book", unitMinor: 1000, quantity: 1 }] });
  const { attempt } = await reserveAttempt(env.DB, { orderId: order.id, gateway: "paymob", mode: "sandbox", amountMinor: 1000, currency: "EGP", captureIntent: "automatic", idempotencyKey: crypto.randomUUID(), fingerprint: "fixture" });
  return (await applyPaymentEvidence(env.DB, { attemptId: attempt.id, expectedVersion: attempt.version, evidence: { status: "pending", amountMinor: 1000, capturedMinor: 0, currency: "EGP", provider: { providerObjectId: "pi_test_" + attempt.id, providerAuthorizationId: "pi_test_" + attempt.id } } })).attempt;
}
let sequence = 0;
function provider(reference: string, amount = 1000) {
  sequence++;
  const transaction = { id: 532812832 + sequence, success: true, pending: false, amount_cents: amount, currency: "EGP", is_auth: false, is_capture: false, is_standalone_payment: true, is_live: false, captured_amount: 0, order: { id: 607277243 + sequence, merchant_order_id: reference, paid_amount_cents: amount, payment_status: "PAID" } };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/auth/tokens")) return Response.json({ token: "fixture-access-token" });
    if (url.endsWith("/transaction_inquiry")) { expect(JSON.parse(String(init?.body)).auth_token).toBe("fixture-access-token"); return Response.json(transaction); }
    if (url.endsWith(`/transactions/${transaction.id}`)) { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-access-token"); return Response.json(transaction); }
    throw new Error("Unexpected provider URL: " + url);
  }, { preconnect: originalFetch.preconnect });
  return transaction;
}
test("reconciliation recovers a paid standalone sale from an intention-only attempt exactly once", async () => {
  const attempt = await pending(); const tx = provider(attempt.id);
  const first = await reconcileAttempt(env, attempt.id);
  expect(first.attempt.status).toBe("paid"); expect(first.attempt.capturedMinor).toBe(1000);
  expect(first.attempt.provider.providerAuthorizationId).toBe(String(tx.id)); expect(first.attempt.provider.providerOrderId).toBe(String(tx.order.id));
  const replay = await reconcileAttempt(env, attempt.id);
  expect(replay.attempt.capturedMinor).toBe(1000); expect(replay.attempt.version).toBe(first.attempt.version);
});
test("reconciliation rejects another attempt's transaction", async () => {
  const attempt = await pending(); provider("att_unrelated");
  await expect(reconcileAttempt(env, attempt.id)).rejects.toThrow(); expect((await getAttempt(env.DB, attempt.id)).capturedMinor).toBe(0);
});
test("reference recovery completes an unresolved create operation", async () => {
  const attempt = await pending(); provider(attempt.id);
  const { operation } = await reserveOperation(env.DB, { attemptId: attempt.id, kind: "create", amountMinor: 1000,
    currency: "EGP", idempotencyKey: crypto.randomUUID(), fingerprint: "lost-create-response" });
  await markOperationSubmitted(env.DB, { operationId: operation.id, expectedVersion: operation.version });
  const recovered = await reconcileAttempt(env, attempt.id);
  expect(recovered.attempt.status).toBe("paid");
  expect(recovered.operation?.status).toBe("completed");
  expect(recovered.attempt.pendingOperationId).toBeUndefined();
});
test("reconciliation rejects mismatched money", async () => {
  const attempt = await pending(); provider(attempt.id, 2000);
  await expect(reconcileAttempt(env, attempt.id)).rejects.toThrow(); expect((await getAttempt(env.DB, attempt.id)).status).toBe("pending");
});
test("signed callback matches an intention through authenticated inquiry", async () => {
  const attempt = await pending();
  const tx = { ...provider(attempt.id), created_at: "2026-09-11T06:05:00", error_occured: false, has_parent_transaction: false, integration_id: 123, is_3d_secure: true, is_refunded: false, is_voided: false, owner: 42, source_data: { pan: "2346", sub_type: "MasterCard", type: "card" } };
  const values = [tx.amount_cents, tx.created_at, tx.currency, tx.error_occured, tx.has_parent_transaction, tx.id, tx.integration_id, tx.is_3d_secure, tx.is_auth, tx.is_capture, tx.is_refunded, tx.is_standalone_payment, tx.is_voided, tx.order.id, tx.owner, tx.pending, tx.source_data.pan, tx.source_data.sub_type, tx.source_data.type, tx.success];
  const hmac = createHmac("sha512", "fixture-hmac").update(values.join("")).digest("hex");
  const request = () => new Request(`https://lab.example/api/webhooks/paymob?hmac=${hmac}`, { method: "POST", body: JSON.stringify({ type: "TRANSACTION", obj: { ...tx, order: { ...tx.order, merchant_order_id: "att_unsigned_spoof" } } }) });
  expect((await handleGatewayWebhook(env, "paymob", request())).status).toBe(200);
  expect((await getAttempt(env.DB, attempt.id)).status).toBe("paid");
  expect((await handleGatewayWebhook(env, "paymob", request())).status).toBe(200);
  expect((await getAttempt(env.DB, attempt.id)).capturedMinor).toBe(1000);
});

test("sandbox refund uses transaction credentials and remains reconciled after settlement", async () => {
  const attempt = await pending(); const tx = provider(attempt.id);
  await reconcileAttempt(env, attempt.id);
  const read = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/void_refund/refund')) {
      posts++;
      const body = JSON.parse(String(init?.body));
      expect(body.auth_token).toBe('fixture-access-token');
      expect(body.amount_cents).toBe(1000);
      Object.assign(tx, { is_refunded: true, refunded_amount_cents: 1000 });
      return Response.json({ id: tx.id + 100000, success: true, pending: false, refunded_amount_cents: 1000, currency: 'EGP' });
    }
    return read(input, init);
  }, { preconnect: originalFetch.preconnect });
  const key = crypto.randomUUID();
  const result = await performPaymentAction(env, attempt.id, { kind: 'refund', idempotencyKey: key });
  expect(result.operation.status).toBe('completed');
  expect(result.attempt.refundedMinor).toBe(1000);
  const again = await reconcileAttempt(env, attempt.id);
  expect(again.attempt.status).toBe('refunded');
  expect(again.attempt.capturedMinor).toBe(1000);
  expect(again.attempt.pendingOperationId).toBeUndefined();
  await performPaymentAction(env, attempt.id, { kind: 'refund', idempotencyKey: key });
  expect(posts).toBe(1);
});

test("failed refund preflight releases the operation without sending a refund", async () => {
  const attempt = await pending(); provider(attempt.id);
  await reconcileAttempt(env, attempt.id);
  globalThis.fetch = Object.assign(async () => Response.json({ detail: 'Unauthorized' }, { status: 401 }), { preconnect: originalFetch.preconnect });
  await expect(performPaymentAction(env, attempt.id, { kind: 'refund', idempotencyKey: crypto.randomUUID() })).rejects.toThrow('no refund was sent');
  expect((await getAttempt(env.DB, attempt.id)).pendingOperationId).toBeUndefined();
  expect((await listOperationsByAttempt(env.DB, attempt.id)).at(-1)?.status).toBe('failed');
});


test("reconcile recovers a durable refund receipt without submitting a second refund", async () => {
  const attempt = await pending(); const tx = provider(attempt.id);
  await reconcileAttempt(env, attempt.id);
  const read = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/void_refund/refund')) {
      posts++;
      Object.assign(tx, { is_refunded: true, refunded_amount_cents: 1000 });
      return Response.json({ id: tx.id + 100000, success: true, pending: false, refunded_amount_cents: 1000, currency: 'EGP' });
    }
    return read(input, init);
  }, { preconnect: originalFetch.preconnect });
  const key = crypto.randomUUID();
  const { operation } = await reserveOperation(env.DB, { attemptId: attempt.id, kind: 'refund', amountMinor: 1000,
    currency: 'EGP', idempotencyKey: key, fingerprint: 'lost-lab-receipt', providerId: String(tx.id) });
  await markOperationSubmitted(env.DB, { operationId: operation.id, expectedVersion: operation.version });
  const driver = createSandboxDriver({ gateway: 'paymob', secrets: env, idempotencyStore: createGatewayIdempotencyStore(env.DB, 'paymob:sandbox') });
  await driver.refund({ gatewayPaymentId: String(tx.id), currency: 'EGP', idempotencyKey: key });
  const recovered = await reconcileAttempt(env, attempt.id);
  expect(recovered.operation?.status).toBe('completed');
  expect(recovered.attempt.refundedMinor).toBe(1000);
  const again = await reconcileAttempt(env, attempt.id);
  expect(again.attempt.version).toBe(recovered.attempt.version);
  expect(posts).toBe(1);
});

test("reconcile preserves an unknown refund when no receipt proves its outcome", async () => {
  const attempt = await pending(); provider(attempt.id);
  await reconcileAttempt(env, attempt.id);
  const { operation } = await reserveOperation(env.DB, { attemptId: attempt.id, kind: 'refund', amountMinor: 1000,
    currency: 'EGP', idempotencyKey: crypto.randomUUID(), fingerprint: 'unknown-outcome' });
  await markOperationSubmitted(env.DB, { operationId: operation.id, expectedVersion: operation.version });
  const result = await reconcileAttempt(env, attempt.id);
  expect(result.attempt.pendingOperationId).toBe(operation.id);
  expect(result.attempt.refundedMinor).toBe(0);
});

for (const amount of [400, 1000]) test(`pending Paymob refund of ${amount} settles from authenticated inquiry`, async () => {
  const attempt = await pending(); const tx = provider(attempt.id);
  await reconcileAttempt(env, attempt.id);
  const read = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/void_refund/refund')) {
      posts++;
      expect(JSON.parse(String(init?.body)).amount_cents).toBe(amount);
      // Real sandbox refund receipts can report success with a zero cumulative total.
      return Response.json({ id: tx.id + 100000, success: true, pending: false, refunded_amount_cents: 0, currency: 'EGP' });
    }
    return read(input, init);
  }, { preconnect: originalFetch.preconnect });
  const result = await performPaymentAction(env, attempt.id, { kind: 'refund', amountMinor: amount, idempotencyKey: crypto.randomUUID() });
  expect(result.operation.status).toBe('pending');
  expect(result.attempt.refundedMinor).toBe(0);
  Object.assign(tx, { is_refunded: true, refunded_amount_cents: amount });
  const recovered = await reconcileAttempt(env, attempt.id);
  expect(recovered.attempt.refundedMinor).toBe(amount);
  expect(recovered.attempt.capturedMinor).toBe(1000);
  expect(recovered.attempt.status).toBe(amount === 1000 ? 'refunded' : 'partially_refunded');
  expect(recovered.operation?.status).toBe('completed');
  const again = await reconcileAttempt(env, attempt.id);
  expect(again.attempt.version).toBe(recovered.attempt.version);
  expect(posts).toBe(1);
});
