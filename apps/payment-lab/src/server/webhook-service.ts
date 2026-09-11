import { hashWebhookPayload, minorAmountToNumber, toMinorUnits, type WebhookEvent } from "@paykernel/core";
import { createWebhookInboxEngine, type WebhookHandlerContext } from "@paykernel/webhooks";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { createSandboxDriver, getGatewayReadiness } from "./gateways";
import { GATEWAY_KEYS, type GatewayKey } from "./gateways/types";
import { normalizeGatewayPayment, applyGatewayPayment } from "./payment-evidence";
import { getAttempt } from "./payments/attempts";
import { applyPaymentEvidence, applyRefundEvidence, listRefundsByAttempt } from "./payments/evidence";
import { getWebhookByEvent, recordWebhook, markWebhookFailed, markWebhookProcessed } from "./payments/inbox";
import { getOperation, markOperationCompleted, markOperationFailed } from "./payments/operations";
import { createSdkStores, createGatewayIdempotencyStore } from "./sdk-stores";
import { verifySimulatorRequest } from "./simulator-http";
import { listTestRuns, updateTestRun } from "./payments/testing";
import { reconcileAttempt } from "./payment-actions";

const paymentSchema = z.object({
  amountMinor: z.number().int().positive(), currency: z.string(), capturedMinor: z.number().int().nonnegative(),
  status: z.enum(["pending", "processing", "approved", "authorized", "partially_captured", "paid", "failed", "cancelled", "partially_refunded", "refunded"]),
  provider: z.object({ providerObjectId: z.string().optional(), providerOrderId: z.string().optional(), providerAuthorizationId: z.string().optional(), providerCaptureId: z.string().optional() }),
});
const refundSchema = z.object({ providerRefundId: z.string(), amountMinor: z.number().int().positive(), currency: z.string(), status: z.enum(["pending", "completed", "failed"]) });
const envelopeSchema = z.object({
  gateway: z.enum(GATEWAY_KEYS), mode: z.enum(["sandbox", "simulator"]), eventId: z.string(),
  attemptId: z.string().optional(), payment: paymentSchema.optional(), refund: refundSchema.optional(),
  failOnce: z.boolean().optional(), lookup: z.boolean().optional(), lookupId: z.string().optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;

function engine(env: AppEnv) {
  return createWebhookInboxEngine({ store: createSdkStores(env.DB).webhookInbox, mode: "durable_retry", workerGuaranteed: true });
}

async function handleEnvelope(env: AppEnv, context: WebhookHandlerContext) {
  const event = envelopeSchema.parse(context.event);
  const row = await getWebhookByEvent(env.DB, event.gateway, event.mode, event.eventId);
  if (!row) throw new Error("Webhook evidence missing");
  try {
    if (event.failOnce && context.record.attempts === 1) throw new Error("Simulated processing failure");
    if (event.attemptId) {
      const attempt = await getAttempt(env.DB, event.attemptId);
      if (attempt.gateway !== event.gateway || attempt.mode !== event.mode) throw new Error("Webhook scope mismatch");
      if (event.payment) {
        await applyPaymentEvidence(env.DB, { attemptId: attempt.id, expectedVersion: attempt.version, evidence: event.payment });
      } else if (event.lookup) {
        const root = event.lookupId ?? (["paymob", "hesabe"].includes(event.gateway) ? attempt.provider.providerCaptureId : attempt.provider.providerObjectId);
        if (!root) throw new Error("Provider reference unavailable");
        const driver = createSandboxDriver({ gateway: event.gateway, secrets: env, idempotencyStore: createGatewayIdempotencyStore(env.DB, `${event.gateway}:sandbox`) });
        const confirmed = await driver.lookup(root);
        // Correlation was established from the verified event before persisting this envelope.
        const linked = { ...confirmed, references: { ...confirmed.references, gateway: event.gateway,
          providerObjectId: confirmed.gatewayId, normalizedStatus: confirmed.status, internalReference: confirmed.references?.internalReference ?? attempt.id } };
        await applyGatewayPayment(env, attempt.id, linked);
        if (attempt.pendingOperationId) await reconcileAttempt(env, attempt.id);
      }
      if (event.refund) {
        const refunds = await listRefundsByAttempt(env.DB, attempt.id);
        const refund = refunds.find(item => item.providerRefundId === event.refund?.providerRefundId);
        if (!refund) throw new Error("Refund operation not yet correlated");
        await applyRefundEvidence(env.DB, { attemptId: attempt.id, operationId: refund.operationId, evidence: event.refund });
        const op = await getOperation(env.DB, refund.operationId);
        if (op.status !== "completed" && op.status !== "failed" && event.refund.status !== "pending") {
          const mark = event.refund.status === "completed" ? markOperationCompleted : markOperationFailed;
          await mark(env.DB, { operationId: op.id, expectedVersion: op.version });
        }
      }
    }
    await markWebhookProcessed(env.DB, { webhookId: row.id });
  } catch (error) {
    await markWebhookFailed(env.DB, { webhookId: row.id, lastError: error instanceof Error ? error.name : "processing_error", nextRetryAt: new Date(Date.now() + 60_000).toISOString() });
    throw error;
  }
}

async function receive(env: AppEnv, envelope: Envelope) {
  const hash = await hashWebhookPayload(envelope);
  const previous = await getWebhookByEvent(env.DB, envelope.gateway, envelope.mode, envelope.eventId);
  if (previous && previous.evidenceJson !== JSON.stringify(envelope)) throw new HTTPException(409, { message: "Event ID reused with a different payload." });
  await recordWebhook(env.DB, { gateway: envelope.gateway, mode: envelope.mode, providerEventId: envelope.eventId,
    ...(envelope.attemptId ? { attemptId: envelope.attemptId } : {}), effect: envelope.attemptId ? "matched" : "unmatched", evidenceJson: JSON.stringify(envelope) });
  const outcome = await engine(env).processVerified({ gateway: `${envelope.mode}_${envelope.gateway}`, providerEventId: envelope.eventId, payloadHash: hash, event: envelope, envelope, handler: ctx => handleEnvelope(env, ctx) });
  const accepted = ["processed", "duplicate_completed", "scheduled_for_retry", "already_processing"].includes(outcome.outcome);
  if (!accepted) console.warn(JSON.stringify({ event: "webhook_rejected", ...outcome }));
  return Response.json(outcome, { status: accepted ? 200 : outcome.outcome === "payload_conflict" ? 409 : 503 });
}

export async function handleSimulatorWebhook(env: AppEnv, gateway: GatewayKey, request: Request) {
  const payload = await verifySimulatorRequest(env, request);
  const attempt = await getAttempt(env.DB, payload.attemptId);
  if (attempt.mode !== "simulator" || attempt.gateway !== gateway) throw new HTTPException(409, { message: "Simulator attempt mismatch." });
  const envelope: Envelope = { gateway, mode: "simulator", eventId: payload.eventId, attemptId: attempt.id, failOnce: payload.failOnce };
  if (payload.kind === "payment" && "gatewayId" in payload.result) {
    envelope.payment = normalizeGatewayPayment(attempt, { ...payload.result, redirectUrl: undefined, rawResponse: undefined });
  } else if (payload.kind === "refund" && "gatewayRefundId" in payload.result) {
    const result = payload.result;
    if (!result.totalRefunded) throw new HTTPException(400, { message: "Refund amount missing." });
    envelope.refund = refundSchema.parse({ providerRefundId: result.gatewayRefundId, amountMinor: minorAmountToNumber(toMinorUnits(result.totalRefunded)), currency: result.totalRefunded.currency, status: result.status });
  } else throw new HTTPException(400, { message: "Invalid simulator event kind." });
  return receive(env, envelope);
}

async function matchAttempt(env: AppEnv, gateway: GatewayKey, event: WebhookEvent) {
  const stable = event.event;
  const refs = stable && ("payment" in stable ? stable.payment?.references : "refund" in stable ? stable.refund.references : "capture" in stable ? stable.capture.references : undefined);
  const ids = [...new Set([event.gatewayPaymentId, event.gatewayObjectId, refs?.providerObjectId, refs?.parentId, ...Object.values(refs?.relatedIds ?? {})].filter((id): id is string => !!id))];
  for (const id of ids) {
    const row = await env.DB.prepare(`SELECT id FROM lab_attempts WHERE gateway = ? AND mode = 'sandbox' AND (provider_object_id = ? OR provider_order_id = ? OR provider_authorization_id = ? OR provider_capture_id = ?) LIMIT 1`)
      .bind(gateway, id, id, id, id).first<{ id: string }>();
    if (row) return getAttempt(env.DB, row.id);
  }
  if (event.paymentId) {
    const row = await env.DB.prepare("SELECT id FROM lab_attempts WHERE id = ? AND gateway = ? AND mode = 'sandbox'").bind(event.paymentId, gateway).first<{ id: string }>();
    if (row) return getAttempt(env.DB, row.id);
  }
  if (gateway === "paymob" && event.gatewayPaymentId && /^\d+$/.test(event.gatewayPaymentId)) {
    // merchant_order_id is not HMAC-covered. Recover it only through authenticated inquiry.
    const driver = createSandboxDriver({ gateway, secrets: env });
    const payment = await driver.lookup(event.gatewayPaymentId);
    const reference = payment.references?.internalReference;
    if (reference) {
      const row = await env.DB.prepare("SELECT id FROM lab_attempts WHERE id = ? AND gateway = 'paymob' AND mode = 'sandbox'")
        .bind(reference).first<{ id: string }>();
      if (row) return getAttempt(env.DB, row.id);
    }
  }
  return null;
}

export async function handleGatewayWebhook(env: AppEnv, gateway: GatewayKey, request: Request) {
  if (!getGatewayReadiness(gateway, env).configured) return Response.json({ error: "Gateway setup incomplete." }, { status: 503 });
  const rawBody = await request.text();
  if (rawBody.length > 65536) throw new HTTPException(413);
  const driver = createSandboxDriver({ gateway, secrets: env, idempotencyStore: createGatewayIdempotencyStore(env.DB, `${gateway}:sandbox`) });
  let event: WebhookEvent;
  try {
    event = await driver.verifyAndParseWebhook({ rawBody, headers: Object.fromEntries(request.headers), query: Object.fromEntries(new URL(request.url).searchParams) });
  } catch {
    throw new HTTPException(401, { message: "Webhook verification failed." });
  }
  if (event.livemode === true) throw new HTTPException(400, { message: "Live events are disabled." });
  const attempt = await matchAttempt(env, gateway, event);
  const envelope: Envelope = { gateway, mode: "sandbox", eventId: gateway === "paymob" ? `${event.id}:${event.type}:${event.status}` : event.id };
  if (attempt) {
    envelope.attemptId = attempt.id;
    const stable = event.event;
    if (gateway === "moyasar" && stable?.type.startsWith("refund.")) {
      // Moyasar's refund ID and amount describe the payment's cumulative refunds.
      envelope.lookup = true;
    } else if (stable && (stable.type === "refund.completed" || stable.type === "refund.pending" || stable.type === "refund.failed")) {
      const amount = stable.refund.amount;
      if (!amount) throw new HTTPException(400, { message: "Refund amount missing." });
      envelope.refund = refundSchema.parse({ providerRefundId: stable.refund.references.providerObjectId, amountMinor: minorAmountToNumber(toMinorUnits(amount)), currency: amount.currency, status: stable.type.slice(7) });
    } else {
      if (event.currency && event.currency !== attempt.currency) throw new HTTPException(409, { message: "Webhook currency mismatch." });
      if (event.amount && !stable?.type.startsWith("capture.") && minorAmountToNumber(toMinorUnits(event.amount)) !== attempt.amountMinor) throw new HTTPException(409, { message: "Webhook amount mismatch." });
      envelope.lookup = true;
      if (["paymob", "hesabe"].includes(gateway)) {
        // Capture callbacks can name a child transaction. Enquire the payment
        // already bound to this attempt once the initial transaction is known.
        envelope.lookupId = (gateway === "paymob" && /^\d+$/.test(attempt.provider.providerAuthorizationId ?? "") ? attempt.provider.providerAuthorizationId : undefined)
          ?? attempt.provider.providerCaptureId ?? event.gatewayPaymentId;
      }
    }
  }
  return receive(env, envelope);
}

export async function retryWebhooks(env: AppEnv) {
  const result = await engine(env).processRetryable({ limit: 20, handler: ctx => handleEnvelope(env, ctx) });
  const runs = await listTestRuns(env.DB, 200);
  for (const run of runs) {
    if (run.verdict !== "running" || run.scenario !== "retry" || run.mode !== "simulator") continue;
    const evidence = z.object({ attemptId: z.string(), webhookEventId: z.string(), steps: z.array(z.unknown()) }).passthrough().parse(JSON.parse(run.evidenceJson));
    const webhook = await getWebhookByEvent(env.DB, run.gateway, run.mode, evidence.webhookEventId);
    if (webhook?.status !== "processed") continue;
    const attempt = await getAttempt(env.DB, evidence.attemptId);
    await updateTestRun(env.DB, { id: run.id, verdict: attempt.status === "paid" ? "passed" : "failed",
      evidenceJson: JSON.stringify({ ...evidence, error: undefined, steps: [...evidence.steps, { label: "retry applied verified payment", actual: attempt.status, expected: "paid" }] }),
    });
  }
  return result;
}
