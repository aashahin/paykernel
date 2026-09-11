import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireSeller } from "./lab-api";
import { GATEWAY_KEYS } from "./gateways/types";
import { runScenario, SCENARIOS } from "./scenario-service";

const inputSchema = z.object({ gateway: z.enum(GATEWAY_KEYS), mode: z.enum(["sandbox", "simulator"]), scenario: z.string().min(1).max(100) });

export function createScenarioApi(env: AppEnv) {
  return new Hono<{ Bindings: AppEnv }>()
    .use("/api/seller/scenarios", async (c, next) => {
      const seller = await requireSeller(env, c.req.raw);
      if (!seller.ok) throw new HTTPException(seller.status);
      await next();
    })
    .get("/api/seller/scenarios", c => c.json({ scenarios: SCENARIOS }))
    .post("/api/seller/scenarios", async c => {
      if (c.req.header("origin") !== env.APP_ORIGIN) throw new HTTPException(403);
      const input = inputSchema.parse(await c.req.json());
      if (!SCENARIOS.some(scenario => scenario.id === input.scenario)) throw new HTTPException(400, { message: "Unknown scenario." });
      return c.json({ run: await runScenario(env, input) });
    });
}
