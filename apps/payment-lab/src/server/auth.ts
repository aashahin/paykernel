import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { AppEnv } from "../env";
import { authSecret } from "../env";
import { schema } from "../db/schema";
import type { LabDatabase } from "./db";

export function createAuth(env: AppEnv, db: LabDatabase) {
  const appOrigin = env.APP_ORIGIN;

  return betterAuth({
    baseURL: appOrigin,
    secret: authSecret(env),
    trustedOrigins: [appOrigin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
    },
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    advanced: {
      useSecureCookies: new URL(appOrigin).protocol === "https:",
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
  });
}

export type LabAuth = ReturnType<typeof createAuth>;
