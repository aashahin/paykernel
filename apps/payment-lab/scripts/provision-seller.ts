/** Provision a seller with Better Auth password hashing. Read the password from stdin or the environment. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hashPassword } from "better-auth/crypto";

interface Args {
  email: string;
  target: "local" | "remote";
}

function parseArgs(argv: string[]): Args {
  let email: string | undefined;
  let target: Args["target"] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--email") {
      email = argv[i + 1];
      i += 1;
    } else if (token === "--local") {
      if (target) throw new Error("Pass exactly one of --local | --remote.");
      target = "local";
    } else if (token === "--remote") {
      if (target) throw new Error("Pass exactly one of --local | --remote.");
      target = "remote";
    } else if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    } else {
      printUsage();
      throw new Error(`Unknown flag: ${token}`);
    }
  }
  if (!email || !target) {
    printUsage();
    throw new Error("Missing required flags: --email <address> and exactly one of --local | --remote.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Invalid email shape (value redacted).");
  }
  return { email: email.trim().toLowerCase(), target };
}

function printUsage(): void {
  console.log(
    [
      "Usage: bun ./scripts/provision-seller.ts --email <address> (--local | --remote)",
      "",
      "Password source (in order): PAYKERNEL_SELLER_PASSWORD env, else stdin.",
      "Never pass the password as a CLI argument.",
    ].join("\n"),
  );
}

/** Strict SQLite text-literal escaper for the temp SQL file (hash/ids/email only). */
function lit(value: string): string {
  if (value.includes("\0")) throw new Error("Refusing value containing NUL.");
  return `'${value.replace(/'/g, "''")}'`;
}

function readPassword(): string {
  const fromEnv = process.env.PAYKERNEL_SELLER_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  if (process.stdin.isTTY) {
    throw new Error(
      "Password missing. Set PAYKERNEL_SELLER_PASSWORD or pipe it via stdin (never --password).",
    );
  }
  const piped = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (piped.length === 0) {
    throw new Error("Empty password received on stdin.");
  }
  return piped;
}

function buildSql(params: { userId: string; accountId: string; email: string; hash: string; now: number }): string {
  const { userId, accountId, email, hash, now } = params;
  const name = email.split("@")[0] ?? "seller";
  return [
    `INSERT INTO "user" ("id", "name", "email", "email_verified", "image", "created_at", "updated_at")`,
    `VALUES (${lit(userId)}, ${lit(name)}, ${lit(email)}, 1, NULL, ${now}, ${now})`,
    `ON CONFLICT("email") DO UPDATE SET "name"=excluded."name", "updated_at"=excluded."updated_at";`,
    `DELETE FROM "account" WHERE "provider_id" = 'credential' AND "user_id" = (SELECT "id" FROM "user" WHERE "email" = ${lit(email)});`,
    `INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "password", "created_at", "updated_at")`,
    `VALUES (${lit(accountId)}, (SELECT "id" FROM "user" WHERE "email" = ${lit(email)}), 'credential', (SELECT "id" FROM "user" WHERE "email" = ${lit(email)}), ${lit(hash)}, ${now}, ${now});`,
  ].join("\n");
}

function runWrangler(sqlText: string, target: "local" | "remote", email: string): void {
  const dir = mkdtempSync(join(tmpdir(), "paykernel-seller-"));
  const file = join(dir, "provision.sql");
  try {
    writeFileSync(file, sqlText, { mode: 0o600 });
    const result = spawnSync(
      "wrangler",
      [
        "d1",
        "execute",
        "paykernel-lab",
        target === "local" ? "--local" : "--remote",
        "--config",
        "wrangler.jsonc",
        "--file",
        file,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      // Wrangler output only; the SQL file content (hash) is never printed.
      throw new Error(`wrangler d1 execute failed (${target}): ${result.stderr || result.stdout}`);
    }
    console.log(`Seller provisioned (${target}) for ${email}.`);

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = readPassword();
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }

  // BetterAuth password hash (scrypt). Plaintext is dropped right after.
  const passwordHash = await hashPassword(password);

  runWrangler(
    buildSql({
      userId: randomUUID(),
      accountId: randomUUID(),
      email: args.email,
      hash: passwordHash,
      now: Date.now(),
    }),
    args.target,
    args.email,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "provision-seller failed");
  process.exit(1);
});
