import type { GatewaySecrets } from "./server/gateways/types";

export interface AppSecrets extends GatewaySecrets {
  SIMULATOR_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
}

export type AppEnv = Env & AppSecrets;

export function isTesterEmail(env: AppEnv, email: string): boolean {
  return env.TESTER_EMAILS.split(",").some(
    (tester) => tester.trim().toLowerCase() === email.trim().toLowerCase(),
  );
}

export function authSecret(env: AppEnv): string {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }
  return env.BETTER_AUTH_SECRET;
}
