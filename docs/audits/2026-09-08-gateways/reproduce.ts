// Audit probes: synthetic provider responses, real gateway/client/inbox code, no network.
// Run from repository root: bun docs/audits/2026-09-08-gateways/reproduce.ts
import { strict as assert } from 'node:assert';
import { HooksManager, money, createPaymentClient } from '../../../packages/core/dist/index.js';
import { TapGateway } from '../../../packages/gateway-tap/src/gateway';
import { tapGateway } from '../../../packages/gateway-tap/src/factory';
import { MyFatoorahGateway } from '../../../packages/gateway-myfatoorah/src/gateway';
import { canonicalMyFatoorahString, computeMyFatoorahSignature } from '../../../packages/gateway-myfatoorah/src/webhooks';
import { computeTapHashstring, hashFieldsFromTapObject } from '../../../packages/gateway-tap/src/webhooks';
import { authorizedObject, declinedCharge } from '../../../packages/gateway-tap/src/fixtures/charges';
import { paymentWebhook } from '../../../packages/gateway-myfatoorah/src/fixtures/webhooks';
import { createWebhookInboxEngine } from '../../../packages/webhooks/src/engine';
import { createMemoryWebhookInboxStore } from '../../../packages/webhooks/src/memory-store';
import { MoyasarGateway } from '../../../packages/core/src/gateways/moyasar/moyasar.gateway';
import { HooksManager as SourceHooks } from '../../../packages/core/src/hooks/hooks.manager';
import { money as sourceMoney } from '../../../packages/core/src/utils/money';
import { mapGatewayResultToOperationResult } from '../../../packages/core/src/types/operation-result';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const noNetwork = (async () => { throw new Error('Unexpected network request'); }) as typeof fetch;
const tapSecret = 'sk_test_audit';
const tap = new TapGateway({ secretKey: tapSecret }, new HooksManager({}), undefined, { fetch: noNetwork });
const record = (name: string, observed: unknown) => console.log(JSON.stringify({ name, observed }));

// Partial capture must preserve a provider decline, not invent captured money.
{
  const queue = [authorizedObject(), declinedCharge({ amount: 5 })];
  const gateway = new TapGateway({ secretKey: tapSecret }, new HooksManager({}), undefined, {
    fetch: (async () => json(queue.shift())) as typeof fetch,
  });
  const result = await gateway.capturePayment({ gatewayPaymentId: 'auth_testAuthorize01', amount: money('5', 'SAR'), currency: 'SAR', idempotencyKey: 'capture-audit' });
  assert.equal(result.status, 'partially_captured');
  assert.equal(result.outcome, 'requires_action');
  record('tap_declined_partial_capture', { status: result.status, outcome: result.outcome, decline: result.decline });
}

// MyFatoorah's paid-invoice replay match is always false after the Money migration.
for (const country of ['KWT', 'ARE'] as const) {
  const calls: string[] = [];
  const gateway = new MyFatoorahGateway({ apiToken: 'audit', country }, new HooksManager({}), undefined, {
    fetch: (async (url) => {
      calls.push(String(url));
      return json({ IsSuccess: true, Data: String(url).endsWith('/v2/GetPaymentStatus')
        ? { InvoiceId: 123456, InvoiceStatus: 'Paid', InvoiceValue: 10, InvoiceTransactions: [{ TransactionStatus: 'Succss', PaymentId: 'payment-audit', PaidCurrency: 'KWD', PaidCurrencyValue: 10 }] }
        : { InvoiceId: 234567, PaymentCompleted: false, PaymentURL: 'https://pay.example/second' } });
    }) as typeof fetch,
  });
  const result = await gateway.createPayment({ amount: money('10', 'KWD'), currency: 'KWD', orderId: 'order-audit', callbackUrl: 'https://merchant.example/callback', idempotencyKey: 'create-audit' });
  assert.equal(result.outcome, country === 'KWT' ? 'requires_action' : 'indeterminate');
  assert.equal(calls.length, country === 'KWT' ? 2 : 1);
  record('myfatoorah_paid_replay_' + country, { outcome: result.outcome, gatewayId: result.gatewayId, requests: calls });
}

// An authentic invoice PAID event is exposed as cancelled by the real client.
{
  const client = createPaymentClient({ gateways: { tap: tapGateway({ secretKey: tapSecret }) }, runtime: { fetch: noNetwork } });
  const raw = { id: 'inv_audit', object: 'invoice', status: 'PAID', amount: 10, currency: 'SAR', created: '1750000000000', updated: '1750000001000' };
  const signature = computeTapHashstring(hashFieldsFromTapObject(raw), tapSecret);
  const result = await client.handleWebhook('tap', JSON.stringify(raw), signature);
  assert.equal(result.status, 'cancelled');
  record('tap_paid_invoice', { nativeType: result.type, status: result.status, stableType: result.stableType });
}

// Authorize status snapshots share an inbox key; VOID is lost after AUTHORIZED.
{
  const engine = createWebhookInboxEngine({ store: createMemoryWebhookInboxStore(), mode: 'inline' });
  const seen: string[] = [];
  const outcomes: string[] = [];
  for (const status of ['AUTHORIZED', 'VOID']) {
    const raw = authorizedObject({ status });
    const signature = computeTapHashstring(hashFieldsFromTapObject(raw), tapSecret);
    assert.equal(tap.verifyWebhook(raw, signature), true);
    const event = tap.parseWebhookEvent(raw);
    const result = await engine.processVerified({ gateway: 'tap', providerEventId: event.id, payloadHash: event.payloadHash!, event, handler: async () => { seen.push(status); } });
    outcomes.push(result.outcome);
  }
  assert.deepEqual(seen, ['AUTHORIZED']);
  record('tap_authorize_void_inbox', { seen, outcomes });
}

// Same authentic webhook verifies as a string, fails as a standard raw byte body.
{
  const gateway = new MyFatoorahGateway({ apiToken: 'audit', country: 'KWT', webhookSecret: 'audit-secret' }, new HooksManager({}), undefined, { fetch: noNetwork });
  const raw = JSON.stringify(paymentWebhook());
  const signature = computeMyFatoorahSignature(canonicalMyFatoorahString(raw), 'audit-secret');
  const stringAccepted = gateway.verifyWebhook(raw, signature);
  const bytesAccepted = gateway.verifyWebhook(new TextEncoder().encode(raw), signature);
  assert.equal(stringAccepted, true);
  assert.equal(bytesAccepted, false);
  record('myfatoorah_raw_bytes', { stringAccepted, bytesAccepted });
}

// The advertised AFT fields are rejected by the strict runtime schema.
{
  const gateway = new MoyasarGateway({ secretKey: 'sk_test_audit' }, new SourceHooks({}), undefined, { fetch: noNetwork });
  let observed: unknown;
  try {
    await gateway.createPayment({ amount: sourceMoney('10', 'SAR'), currency: 'SAR', moyasarSource: { type: 'applepay', token: 'encrypted_audit' }, recipient: { first_name: 'Ada', last_name: 'Lovelace', address: 'Riyadh' } });
    assert.fail('AFT unexpectedly accepted');
  } catch (error: any) {
    observed = error.validationErrors;
    assert.ok(error.validationErrors?.some((e: any) => e.code === 'unrecognized_keys' && e.keys.includes('recipient')));
  }
  record('moyasar_aft_schema', observed);
}

// A real creditcard-shaped 3DS response uses a non-normalized action type.
{
  const raw = { id: '760878ec-d1d3-5f72-9056-191683f55872', status: 'initiated', amount: 1000, currency: 'SAR', captured: 0, refunded: 0, source: { type: 'creditcard', transaction_url: 'https://api.moyasar.com/v1/3ds/audit' } };
  const gateway = new MoyasarGateway({ secretKey: 'sk_test_audit' }, new SourceHooks({}), undefined, { fetch: (async () => json(raw)) as typeof fetch });
  const result = await gateway.createPayment({ amount: sourceMoney('10', 'SAR'), currency: 'SAR', callbackUrl: 'https://merchant.example/callback', moyasarSource: { type: 'token', token: 'token_audit' } });
  assert.equal(result.nextAction?.type, 'redirect_to_url');
  const mapped = mapGatewayResultToOperationResult(result);
  record('moyasar_3ds_action', { nextAction: result.nextAction, operation: mapped });
}

// The same key can pass two simultaneous preflights outside native-idempotency countries.
{
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const mutations: Array<{ url: string; idempotencyHeader: string | null }> = [];
  const gateway = new MyFatoorahGateway({ apiToken: 'audit', country: 'ARE', live: true }, new HooksManager({}), undefined, {
    fetch: (async (url, init) => {
      if (String(url).endsWith('/v2/GetPaymentStatus')) {
        if (++reads === 2) release();
        await barrier;
        return json({ IsSuccess: false, Message: 'No data matches this key', Data: null });
      }
      mutations.push({ url: String(url), idempotencyHeader: new Headers(init?.headers).get('Idempotency-Key') });
      return json({ IsSuccess: true, Data: { InvoiceId: String(123456 + mutations.length), PaymentCompleted: false, PaymentURL: 'https://pay.example/' + mutations.length } });
    }) as typeof fetch,
  });
  const params = { amount: money('10', 'AED'), currency: 'AED', orderId: 'same-order', callbackUrl: 'https://merchant.example/callback', idempotencyKey: 'same-key' };
  const results = await Promise.all([gateway.createPayment(params), gateway.createPayment(params)]);
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every((m) => m.idempotencyHeader === null));
  record('myfatoorah_concurrent_same_key_create', { mutations, invoices: results.map((r) => r.gatewayId) });
}
