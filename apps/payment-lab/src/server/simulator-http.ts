import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { GatewayPaymentResult, GatewayRefundResult, ProviderReferences } from "@paykernel/core";
import type { AppEnv } from "../env";
import type { GatewayKey } from "./gateways/types";

const MAX_BODY_BYTES = 64 * 1024;
const TIMESTAMP_SKEW_SEC = 5 * 60;

const moneySchema = z.strictObject({
  amount: z.string().regex(/^-?\d+(\.\d+)?$/),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
});

const referencesSchema = z.strictObject({
  providerObjectId: z.string().min(1).max(256),
  normalizedStatus: z.string().min(1).max(64),
  gateway: z.string().min(1).max(64),
  internalReference: z.string().max(256).optional(),
  providerRequestId: z.string().max(256).optional(),
  parentId: z.string().max(256).optional(),
  providerNativeStatus: z.string().max(64).optional(),
  relatedIds: z.record(z.string(), z.string().max(256)).optional(),
}).transform((refs): ProviderReferences => ({
  providerObjectId: refs.providerObjectId, normalizedStatus: refs.normalizedStatus, gateway: refs.gateway,
  ...(refs.internalReference !== undefined ? { internalReference: refs.internalReference } : {}),
  ...(refs.parentId !== undefined ? { parentId: refs.parentId } : {}),
  ...(refs.relatedIds !== undefined ? { relatedIds: refs.relatedIds } : {}),
}));

const PAYMENT_STATUSES = [
  "pending", "processing", "authorized", "approved", "paid",
  "partially_captured", "failed", "cancelled", "reversed",
  "refunded", "partially_refunded", "completed", "requires_action",
  "succeeded", "refund_pending", "refund_completed", "refund_failed",
  "setup_completed",
] as const;

const paymentResultSchema = z.object({
  outcome: z.enum(["succeeded", "requires_action", "declined", "failed", "indeterminate"]),
  gatewayId: z.string().min(1).max(256),
  status: z.enum(PAYMENT_STATUSES),
  amount: moneySchema.optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  fee: moneySchema.optional(),
  capturedAmount: moneySchema.optional(),
  refundedAmount: moneySchema.optional(),
  redirectUrl: z.string().max(2048).optional(),
  clientSecret: z.string().max(512).optional(),
  references: referencesSchema.optional(),
  reconciliationRequired: z.boolean().optional(),
  providerRequestId: z.string().max(256).optional(),
});

const refundResultSchema = z.object({
  outcome: z.enum(["succeeded", "failed", "pending", "indeterminate"]),
  gatewayRefundId: z.string().min(1).max(256),
  status: z.enum(["pending", "completed", "failed"]),
  totalRefunded: moneySchema.optional(),
  refundedAt: z.string().max(64).optional(),
  reconciliationRequired: z.boolean().optional(),
  providerRequestId: z.string().max(256).optional(),
});

const webhookSchema = z.discriminatedUnion("kind", [
  z.strictObject({ eventId: z.string().min(1).max(128), attemptId: z.string().min(1).max(128), failOnce: z.boolean().optional(), kind: z.literal("payment"), result: paymentResultSchema }),
  z.strictObject({ eventId: z.string().min(1).max(128), attemptId: z.string().min(1).max(128), failOnce: z.boolean().optional(), kind: z.literal("refund"), result: refundResultSchema }),
]);

export type SimulatorWebhookPayload =
  | { eventId: string; attemptId: string; kind: "payment"; result: GatewayPaymentResult }
  | { eventId: string; attemptId: string; kind: "refund"; result: GatewayRefundResult };

export type EmitSimulatorWebhookInput = {
  eventId: string; attemptId: string; kind: "payment" | "refund";
  result: GatewayPaymentResult | GatewayRefundResult; failOnce?: boolean;
};

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function emitSimulatorWebhook(env: AppEnv, gateway: GatewayKey, payload: EmitSimulatorWebhookInput, opts?: { timestamp?: string; tamperSignature?: boolean }): Promise<{ status: number; ok: boolean; eventId: string }> {
  const secret = env.SIMULATOR_SECRET;
  if (!secret) throw new Error("SIMULATOR_SECRET is not configured.");
  const safeResult = payload.kind === "payment" ? paymentResultSchema.parse(payload.result) : refundResultSchema.parse(payload.result);
  const body = JSON.stringify({ eventId: payload.eventId, attemptId: payload.attemptId, kind: payload.kind, result: safeResult, failOnce: payload.failOnce });
  const timestamp = opts?.timestamp ?? String(Math.floor(Date.now() / 1000));
  let signature = await hmacHex(secret, `${timestamp}.${body}`);
  if (opts?.tamperSignature) signature = `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
  // NB: result is a transport snapshot only, not a financial authorization;
  // the parent correlates eventId/attemptId and runs the normalizer.
  const url = `${env.APP_ORIGIN.replace(/\/+$/, "")}/api/simulator/webhooks/${gateway}`;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-lab-timestamp": timestamp, "x-lab-signature": signature }, body });
  return { status: res.status, ok: res.ok, eventId: payload.eventId };
}

export async function verifySimulatorRequest(env: AppEnv, request: Request): Promise<z.infer<typeof webhookSchema>> {
  const secret = env.SIMULATOR_SECRET;
  if (!secret) throw new HTTPException(500, { message: "Simulator is not configured." });
  const timestamp = request.headers.get("x-lab-timestamp")?.trim() ?? "";
  const signatureHex = request.headers.get("x-lab-signature")?.trim().toLowerCase() ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || signatureHex.length !== 64) throw new HTTPException(401, { message: "Bad signature." });
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > TIMESTAMP_SKEW_SEC) throw new HTTPException(401, { message: "Bad signature." });
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new HTTPException(400, { message: "Body too large." });
  const sigBytes = hexToBytes(signatureHex);
  if (!sigBytes) throw new HTTPException(401, { message: "Bad signature." });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${timestamp}.${body}`));
  if (!ok) throw new HTTPException(401, { message: "Bad signature." });
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new HTTPException(400, { message: "Malformed JSON." }); }
  const validated = webhookSchema.safeParse(parsed);
  if (!validated.success) throw new HTTPException(400, { message: "Malformed webhook payload." });
  return validated.data;
}
