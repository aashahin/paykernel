import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../env";
import { isGatewayKey } from "./gateways/types";
import { controlSimulatorPayment, settleSimulatorRefund } from "./gateways/simulator";
import { getAttempt } from "./payments/attempts";
import { listRefundsByAttempt } from "./payments/evidence";
import { buyerScopeCheck, requireSeller } from "./lab-api";
import { performPaymentAction, reconcileAttempt } from "./payment-actions";
import { handleGatewayWebhook, handleSimulatorWebhook, retryWebhooks } from "./webhook-service";
import { emitSimulatorWebhook } from "./simulator-http";

const controlSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("payment"), outcome: z.enum(["paid", "authorized", "failed", "cancelled", "pending"]), eventId: z.string().min(1).max(128).optional(), failOnce: z.boolean().optional(), deliver: z.boolean().default(true) }),
  z.object({ kind: z.literal("refund"), refundId: z.string().min(1), outcome: z.enum(["completed", "failed"]), eventId: z.string().min(1).max(128).optional(), failOnce: z.boolean().optional(), deliver: z.boolean().default(true) }),
]);

export function createCallbackApi(env: AppEnv) {
  return new Hono<{ Bindings: AppEnv }>()
    .use("*", bodyLimit({ maxSize: 65536 }))
    .post("/api/webhooks/:gateway", async c => {
      const gateway = c.req.param("gateway");
      if (!isGatewayKey(gateway)) throw new HTTPException(404);
      return handleGatewayWebhook(env, gateway, c.req.raw);
    })
    .post("/api/simulator/webhooks/:gateway", async c => {
      const gateway = c.req.param("gateway");
      if (!isGatewayKey(gateway)) throw new HTTPException(404);
      return handleSimulatorWebhook(env, gateway, c.req.raw);
    })
    .post("/api/returns/:id", async c => {
      const attempt = await getAttempt(env.DB, c.req.param("id"));
      if (attempt.gateway !== "paymob" || attempt.mode !== "sandbox") throw new HTTPException(404);
      return handleGatewayWebhook(env, "paymob", c.req.raw);
    })
    .get("/api/returns/:id", async c => {
      const attempt = await getAttempt(env.DB, c.req.param("id"));
      await buyerScopeCheck(env, c, attempt.orderId);
      if (attempt.mode === "sandbox" && attempt.gateway === "paymob" && c.req.query("hmac")) {
        const verified = await handleGatewayWebhook(env, "paymob", c.req.raw);
        if (!verified.ok) return verified;
      } else if (attempt.mode === "sandbox" && ["paypal", "hesabe"].includes(attempt.gateway) && ["pending", "approved", "processing"].includes(attempt.status)) {
        await performPaymentAction(env, attempt.id, { kind: "complete-return", idempotencyKey: `return:${attempt.id}`, query: c.req.query() });
      } else {
        await reconcileAttempt(env, attempt.id);
      }
      return c.redirect(`/orders/${encodeURIComponent(attempt.orderId)}`);
    })
    .post("/api/seller/simulator/:id", validator("json", value => controlSchema.parse(value)), async c => {
      const seller = await requireSeller(env, c.req.raw);
      if (!seller.ok) throw new HTTPException(seller.status);
      if (c.req.header("origin") !== env.APP_ORIGIN) throw new HTTPException(403);
      const input = c.req.valid("json");
      const attempt = await getAttempt(env.DB, c.req.param("id"));
      if (attempt.mode !== "simulator") throw new HTTPException(409, { message: "Simulator controls cannot modify sandbox payments." });
      const providerId = attempt.provider.providerObjectId;
      if (!providerId) throw new HTTPException(409, { message: "Payment creation is unresolved." });
      if (input.kind === "refund" && !(await listRefundsByAttempt(env.DB, attempt.id)).some(r => r.providerRefundId === input.refundId)) throw new HTTPException(404);
      const result = input.kind === "payment"
        ? await controlSimulatorPayment(env.DB, attempt.gateway, providerId, input.outcome)
        : await settleSimulatorRefund(env.DB, attempt.gateway, input.refundId, input.outcome);
      const delivery = input.deliver ? await emitSimulatorWebhook(env, attempt.gateway, {
        eventId: input.eventId ?? crypto.randomUUID(), attemptId: attempt.id, kind: input.kind, result,
        ...(input.failOnce !== undefined ? { failOnce: input.failOnce } : {}),
      }) : null;
      return c.json({ delivery, attempt: await getAttempt(env.DB, attempt.id) });
    })
    .post("/api/seller/webhooks/retry", async c => {
      const seller = await requireSeller(env, c.req.raw);
      if (!seller.ok) throw new HTTPException(seller.status);
      if (c.req.header("origin") !== env.APP_ORIGIN) throw new HTTPException(403);
      return c.json(await retryWebhooks(env));
    });
}
