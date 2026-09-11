import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";

/** Create a per-request drizzle D1 client (no mutable global). */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type LabDatabase = ReturnType<typeof createDb>;
