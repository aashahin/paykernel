import { fromMinorUnits, type GatewayPaymentResult } from "@paykernel/core";
import type { AppEnv } from "../env";
import { createSandboxDriver, getGatewayReadiness } from "./gateways/index";
import { createSimulatorDriver } from "./gateways/simulator";
import type { GatewayKey } from "./gateways/types";
import { applyGatewayPayment } from "./payment-evidence";
import { createGatewayIdempotencyStore } from "./sdk-stores";
import type { D1DatabaseLike } from "./payments/db";
import { systemClock } from "./payments/db";
import { getAttempt, reserveAttempt } from "./payments/attempts";
import { getOrder } from "./payments/orders";
import {
  getOperationByIdempotency,
  markOperationIndeterminate,
  markOperationCompleted,
  markOperationFailed,
  markOperationSubmitted,
  reserveOperation,
} from "./payments/operations";
import { LabValidationError } from "./payments/errors";
import type { LabAttempt, LabCaptureIntent, LabMode } from "./payments/types";

export type StartPaymentInput = {
  gateway: GatewayKey;
  mode: LabMode;
  captureIntent: LabCaptureIntent;
  idempotencyKey: string;
  sourceToken?: string;
  phone?: string;
  method?: string;
};

export type StartPaymentCheckout = {
  clientSecret?: string;
  redirectUrl?: string;
};

const GATEWAYS: readonly string[] = ["stripe", "paypal", "paymob", "moyasar", "tap", "myfatoorah", "hesabe"];

function assertStartInput(input: StartPaymentInput): void {
  if (!GATEWAYS.includes(input.gateway)) throw new LabValidationError(`unknown gateway: ${input.gateway}`);
  if (input.mode !== "sandbox" && input.mode !== "simulator") throw new LabValidationError(`unknown mode: ${input.mode}`);
  if (input.captureIntent !== "automatic" && input.captureIntent !== "manual") {
    throw new LabValidationError(`unknown captureIntent: ${input.captureIntent}`);
  }
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 128) {
    throw new LabValidationError("idempotencyKey must be 1..128 chars");
  }
  if (input.sourceToken !== undefined && (input.sourceToken.length === 0 || input.sourceToken.length > 256)) {
    throw new LabValidationError("sourceToken must be 1..256 chars");
  }
  if (input.phone !== undefined && (input.phone.length < 5 || input.phone.length > 32)) {
    throw new LabValidationError("phone must be 5..32 chars");
  }
  if (input.method !== undefined && (input.method.length === 0 || input.method.length > 128)) {
    throw new LabValidationError("method must be 1..128 chars");
  }
}

function ensurePreReserve(env: AppEnv, input: StartPaymentInput): void {
  const readiness = getGatewayReadiness(input.gateway, env);
  if (input.mode === "sandbox" && !readiness.configured) {
    throw new LabValidationError(`gateway not configured: missing ${readiness.missing.join(",") || "sandbox key"}`);
  }
  const caps = readiness.capabilities;
  if (!caps.payments) throw new LabValidationError(`gateway does not support payments: ${input.gateway}`);
  if (input.captureIntent === "manual" && !caps.authorization) {
    throw new LabValidationError(`gateway does not support manual capture: ${input.gateway}`);
  }
  if (input.captureIntent === "automatic" && !caps.immediateCapture) {
    throw new LabValidationError(`gateway does not support immediate capture: ${input.gateway}`);
  }
  if (input.mode === "simulator") return;
  if (input.gateway === "moyasar") {
    if (input.sourceToken === undefined || !input.sourceToken.startsWith("token_")) {
      throw new LabValidationError("moyasar.sourceToken must be a browser token (token_…)");
    }
    if (input.method !== undefined) throw new LabValidationError("Moyasar driver does not accept method");
  } else if (input.sourceToken !== undefined) {
    throw new LabValidationError(`${input.gateway} driver does not accept sourceToken`);
  }
  if (input.gateway === "paymob") {
    if (input.phone === undefined || input.phone.trim().length < 5) {
      throw new LabValidationError("customer.phone is required for Paymob");
    }
    const authId = typeof env.PAYMOB_AUTH_INTEGRATION_ID === "string" ? env.PAYMOB_AUTH_INTEGRATION_ID.trim() : "";
    const method = typeof input.method === "string" ? input.method.trim() : "";
    if (input.captureIntent === "manual" && authId.length === 0 && method.length === 0) {
      throw new LabValidationError("paymob capture:false requires PAYMOB_AUTH_INTEGRATION_ID or method override");
    }
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fingerprintInput(orderId: string, input: StartPaymentInput, tokenDigest: string): string {
  return JSON.stringify({
    orderId,
    gateway: input.gateway,
    mode: input.mode,
    intent: input.captureIntent,
    method: input.method ?? "",
    token: tokenDigest,
    phone: input.phone ?? "",
  });
}

function safeCheckout(result: GatewayPaymentResult): StartPaymentCheckout {
  const next = (result.nextAction ?? {}) as { url?: unknown; checkoutUrl?: unknown; clientSecret?: unknown };
  const clientSecret = typeof result.clientSecret === "string" && result.clientSecret.length > 0
    ? result.clientSecret
    : typeof next.clientSecret === "string" && next.clientSecret.length > 0
      ? next.clientSecret
      : undefined;
  const redirectUrl = typeof result.redirectUrl === "string" && result.redirectUrl.length > 0
    ? result.redirectUrl
    : typeof next.url === "string" && next.url.length > 0
      ? next.url
      : typeof next.checkoutUrl === "string" && next.checkoutUrl.length > 0
        ? next.checkoutUrl
        : undefined;
  return { ...(clientSecret !== undefined ? { clientSecret } : {}), ...(redirectUrl !== undefined ? { redirectUrl } : {}) };
}

function isIndeterminate(result: GatewayPaymentResult): boolean {
  return result.outcome === "indeterminate" || result.reconciliationRequired === true;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name : "gateway_call_failed";
}

function labUrls(env: AppEnv, gateway: GatewayKey, attemptId: string): { callbackUrl: string; webhookUrl: string } {
  const base = env.APP_ORIGIN.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new LabValidationError("APP_ORIGIN must be an HTTP(S) URL");
  const callbackUrl = `${base}/api/returns/${attemptId}`;
  const webhookUrl = gateway === "paymob" ? callbackUrl : `${base}/api/webhooks/${gateway}?attempt=${attemptId}`;
  return { callbackUrl, webhookUrl };
}

export async function readCheckout(db: D1DatabaseLike, attemptId: string): Promise<StartPaymentCheckout> {
  const row = await db
    .prepare(`SELECT client_secret, redirect_url FROM lab_checkout_details WHERE attempt_id = ?`)
    .bind(attemptId)
    .first<{ client_secret: unknown; redirect_url: unknown }>();
  if (row === null) return {};
  const out: StartPaymentCheckout = {};
  if (typeof row.client_secret === "string" && row.client_secret.length > 0) out.clientSecret = row.client_secret;
  if (typeof row.redirect_url === "string" && row.redirect_url.length > 0) out.redirectUrl = row.redirect_url;
  return out;
}

async function persistCheckout(db: D1DatabaseLike, attemptId: string, checkout: StartPaymentCheckout): Promise<void> {
  const now = systemClock().nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO lab_checkout_details (attempt_id, client_secret, redirect_url, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (attempt_id) DO UPDATE SET client_secret = excluded.client_secret, redirect_url = excluded.redirect_url, updated_at = excluded.updated_at`,
      )
      .bind(attemptId, checkout.clientSecret ?? null, checkout.redirectUrl ?? null, now),
  ]);
}

export async function startPayment(
  env: AppEnv,
  orderId: string,
  input: StartPaymentInput,
): Promise<{ attempt: LabAttempt; checkout: StartPaymentCheckout }> {
  assertStartInput(input);
  const db = env.DB;
  const order = await getOrder(db, orderId);
  ensurePreReserve(env, input);
  const tokenDigest = input.sourceToken === undefined ? "" : await sha256Hex(input.sourceToken);
  const fingerprint = await sha256Hex(fingerprintInput(orderId, input, tokenDigest));
  const driver = input.mode === "simulator"
    ? createSimulatorDriver(db, input.gateway)
    : createSandboxDriver({ gateway: input.gateway, secrets: env, idempotencyStore: createGatewayIdempotencyStore(db, `${input.gateway}:${input.mode}`) });
  labUrls(env, input.gateway, "validation");
  const reserved = await reserveAttempt(db, {
    orderId,
    gateway: input.gateway,
    mode: input.mode,
    amountMinor: order.totalMinor,
    currency: order.currency,
    captureIntent: input.captureIntent,
    idempotencyKey: input.idempotencyKey,
    fingerprint,
  });
  if (reserved.replayed) {
    return { attempt: await getAttempt(db, reserved.attempt.id), checkout: await readCheckout(db, reserved.attempt.id) };
  }
  const attempt = reserved.attempt;
  const opReserved = await reserveOperation(db, {
    attemptId: attempt.id,
    kind: "create",
    idempotencyKey: input.idempotencyKey,
    fingerprint,
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
  });
  if (opReserved.replayed) {
    return { attempt: await getAttempt(db, attempt.id), checkout: await readCheckout(db, attempt.id) };
  }
  const op = await markOperationSubmitted(db, { operationId: opReserved.operation.id, expectedVersion: opReserved.operation.version });
  const { callbackUrl, webhookUrl } = labUrls(env, input.gateway, attempt.id);
  const amount = fromMinorUnits(BigInt(attempt.amountMinor), attempt.currency);
  let result: GatewayPaymentResult;
  try {
    result = await driver.create({
      reference: attempt.id,
      amount,
      customer: { name: order.customerName, email: order.customerEmail, ...(input.phone !== undefined ? { phone: input.phone } : {}) },
      callbackUrl,
      webhookUrl,
      capture: input.captureIntent === "automatic",
      idempotencyKey: op.idempotencyKey,
      ...(input.sourceToken !== undefined ? { sourceToken: input.sourceToken } : {}),
      ...(input.method !== undefined && input.method !== "card" ? { method: input.method } : {}),
    });
  } catch (error) {
    await markOperationIndeterminate(db, { operationId: op.id, expectedVersion: op.version, lastError: safeError(error) });
    return { attempt: await getAttempt(db, attempt.id), checkout: await readCheckout(db, attempt.id) };
  }
  await persistCheckout(db, attempt.id, safeCheckout(result));
  if (isIndeterminate(result)) {
    const current = await getOperationByIdempotency(db, attempt.id, op.idempotencyKey);
    if (current !== null && current.id === op.id && current.status === "submitted") {
      await markOperationIndeterminate(db, { operationId: op.id, expectedVersion: op.version, lastError: "indeterminate gateway result" });
    }
    return { attempt: await getAttempt(db, attempt.id), checkout: await readCheckout(db, attempt.id) };
  }
  try {
    await applyGatewayPayment(env, attempt.id, result);
    if (result.outcome === "failed" || result.outcome === "declined") {
      await markOperationFailed(db, { operationId: op.id, expectedVersion: op.version });
    } else {
      await markOperationCompleted(db, { operationId: op.id, expectedVersion: op.version });
    }
    return { attempt: await getAttempt(db, attempt.id), checkout: await readCheckout(db, attempt.id) };
  } catch {
    const current = await getOperationByIdempotency(db, attempt.id, op.idempotencyKey);
    if (current !== null && current.id === op.id && current.status === "submitted") {
      await markOperationIndeterminate(db, { operationId: op.id, expectedVersion: op.version, lastError: "evidence apply failed" });
    }
    return { attempt: await getAttempt(db, attempt.id), checkout: await readCheckout(db, attempt.id) };
  }
}
