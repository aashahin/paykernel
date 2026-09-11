import { runScheduled } from "../src/server/scheduled";
import handler from "vinext/server/fetch-handler";
import type { AppEnv } from "../src/env";
import { createApi } from "../src/server/api";

export default {
  async scheduled(_controller: ScheduledController, env: AppEnv): Promise<void> {
    await runScheduled(env);
  },
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const api = createApi(env);
      return api.fetch(request, env, ctx);
    }
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
