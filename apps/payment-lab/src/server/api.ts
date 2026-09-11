import { createScenarioApi } from "./scenario-api";
import { createCallbackApi } from "./callback-api";
import { ZodError } from "zod";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createLabApi } from "./lab-api";
import { LabConflictError, LabNotFoundError, LabValidationError } from "./payments/errors";
import type { AppEnv } from "../env";
import { isTesterEmail } from "../env";
import { createAuth } from "./auth";
import { createDb } from "./db";

function requestAuth(env: AppEnv) {
  return createAuth(env, createDb(env.DB));
}

export function createApi(env: AppEnv) {
  return new Hono<{ Bindings: AppEnv }>()
    .onError((error, context) => {
      if (error instanceof ZodError) return context.json({ error: "Invalid request." }, 400);
      if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
      if (error instanceof LabConflictError || error instanceof LabNotFoundError || error instanceof LabValidationError) {
        return context.json({ error: error.message }, error.statusCode);
      }
      console.error(JSON.stringify({ event: "api_error", name: error.name }));
      return context.json({ error: "An unexpected error occurred. Please retry." }, 500);
    })
    .get("/api/health", async (context) => {
      const health = await env.DB.prepare("SELECT 1 AS ready").first<{ ready: number }>();
      return context.json({ ok: health?.ready === 1, db: health?.ready === 1 });
    })
    .on(["POST", "GET"], "/api/auth/*", (context) => requestAuth(env).handler(context.req.raw))
    .get("/api/session", async (context) => {
      const session = await requestAuth(env).api.getSession({ headers: context.req.raw.headers });
      if (!session) return context.json({ authenticated: false, user: null } as const);
      return context.json({
        authenticated: true as const,
        seller: isTesterEmail(env, session.user.email),
        user: { id: session.user.id, email: session.user.email, name: session.user.name },
        expiresAt: session.session.expiresAt.toISOString(),
      });
    })
    .get("/api/seller/ping", async (context) => {
      const session = await requestAuth(env).api.getSession({ headers: context.req.raw.headers });
      if (!session) return context.json({ error: "Sign in to continue." }, 401);
      if (!isTesterEmail(env, session.user.email)) return context.json({ error: "Seller access required." }, 403);
      return context.json({ ok: true, email: session.user.email });
    })
    .route("/", createLabApi(env))
    .route("/", createCallbackApi(env))
    .route("/", createScenarioApi(env));
}

export type AppType = ReturnType<typeof createApi>;
