import { hc } from "hono/client";
import type { AppType } from "../server/api";

/** Typed Hono RPC client for the browser (`hc<AppType>`). */
export function createApiClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

export type ApiClient = ReturnType<typeof createApiClient>;
