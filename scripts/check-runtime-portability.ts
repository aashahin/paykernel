#!/usr/bin/env bun
/**
 * check-runtime-portability.ts
 *
 * Phase 8.4 / 8.5 — fail if portable production sources or published dist
 * contain static `node:` / `bun:` / `cloudflare:` / bare Node builtin imports that break
 * Deno / Cloudflare Workers consumers.
 *
 * Usage:
 *   bun run scripts/check-runtime-portability.ts
 *   bun run check:runtime-portability
 *
 * Exit 0 when clean. Exit 1 on any violation.
 *
 * Scope:
 * - packages/core, packages/webhooks, packages/store-contracts production src
 *   (excludes *.test.ts / *.spec.ts / *.types.test.ts)
 * - those packages' dist .js files (if dist present; skip with note when missing)
 *
 * Deno / Workers functional smoke is aspirational when those runtimes are not
 * installed; this static gate is the CI-required substitute.
 *
 * @see packages/core/docs/runtime.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");

/** Portable production packages scanned for node: / bun: / cloudflare: imports. */
export const PORTABLE_PACKAGE_DIRS = [
  "packages/core",
  "packages/webhooks",
  "packages/reconciliation",
  "packages/observability",
  "packages/routing",
  "packages/store-contracts",
  "packages/sql-foundation",
  "packages/testkit",
  "packages/gateway-tap",
  "packages/gateway-myfatoorah",
  "packages/gateway-hesabe",
  "packages/integration-http",
  "packages/integration-hono",
  "packages/integration-elysia",
  "packages/integration-cloudflare-workers",
] as const;
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Any node: / bun: / cloudflare: protocol import is banned in portable prod. */
const PROTOCOL_BUILTIN_RE = /^(node|bun|cloudflare):/;

/**
 * Bare Node builtins that must not appear as static imports in portable
 * production sources or dist (defense in depth vs protocol form).
 */
const BANNED_BARE_BUILTINS = new Set([
  "fs",
  "fs/promises",
  "path",
  "child_process",
  "net",
  "http",
  "https",
  "http2",
  "cluster",
  "worker_threads",
  "dgram",
  "dns",
  "os",
  "tls",
  "zlib",
  "stream",
  "readline",
  "v8",
  "vm",
  "module",
  "perf_hooks",
  "async_hooks",
  "inspector",
  "trace_events",
  "crypto",
  "buffer",
  "url",
  "util",
  "events",
  "assert",
  "querystring",
  "string_decoder",
  "timers",
  "tty",
  "constants",
]);

/** Match static import/export-from and dynamic import("...") / require("..."). */
const IMPORT_RE =
  /(?:(?:import|export)[\s\w*{}$,\n]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]\s*;?/gm;

export type PortabilityViolation = {
  file: string;
  specifier: string;
  reason: string;
};

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

export function isTestFile(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/");
  return /\.(test|spec)\.(ts|tsx|js|mjs|jsx)$/.test(base);
}

function isProductionSourceFile(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/");
  if (isTestFile(base)) return false;
  return (
    base.endsWith(".ts") ||
    base.endsWith(".tsx") ||
    base.endsWith(".js") ||
    base.endsWith(".mjs") ||
    base.endsWith(".jsx")
  );
}

function isDistJsFile(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/");
  return base.endsWith(".js") && !base.endsWith(".d.ts");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    specs.push(m[1]!);
  }
  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = SIDE_EFFECT_IMPORT_RE.exec(source)) !== null) {
    specs.push(sm[1]!);
  }
  return specs;
}

/**
 * Also catch bare `from "node:…"` / `from 'node:…'` strings that minifiers
 * might leave as string literals in comments — primary path is import parsing.
 * Extra: scan for node: protocol tokens inside import-like contexts only via
 * extractImportSpecifiers. For dist, also flag any import/require of node:.
 */
export function classifyPortableSpecifier(
  specifier: string,
): { ok: true } | { ok: false; reason: string } {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  ) {
    return { ok: true };
  }

  if (PROTOCOL_BUILTIN_RE.test(specifier)) {
    // bun:test only in tests (caller filters production files)
    if (specifier === "bun:test") {
      return {
        ok: false,
        reason: `production portable code must not import "bun:test"`,
      };
    }
    return {
      ok: false,
      reason: `banned runtime builtin "${specifier}" (portable packages must use Web APIs / pure helpers)`,
    };
  }

  if (BANNED_BARE_BUILTINS.has(specifier)) {
    return {
      ok: false,
      reason: `banned bare Node builtin "${specifier}" in portable production path`,
    };
  }

  return { ok: true };
}

export function scanFile(
  filePath: string,
  root: string = ROOT,
): PortabilityViolation[] {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const rel = relative(root, filePath).replace(/\\/g, "/");
  const violations: PortabilityViolation[] = [];
  for (const spec of extractImportSpecifiers(source)) {
    const result = classifyPortableSpecifier(spec);
    if (!result.ok) {
      violations.push({
        file: rel,
        specifier: spec,
        reason: result.reason,
      });
    }
  }
  return violations;
}

export function scanPackageSrc(
  root: string,
  packageDir: string,
): PortabilityViolation[] {
  const srcDir = join(root, packageDir, "src");
  if (!existsSync(srcDir)) {
    return [
      {
        file: `${packageDir}/src`,
        specifier: "",
        reason: `${packageDir}/src missing`,
      },
    ];
  }
  const files = walkFiles(srcDir).filter(isProductionSourceFile);
  const out: PortabilityViolation[] = [];
  for (const f of files) {
    out.push(...scanFile(f, root));
  }
  return out;
}

export function scanPackageDist(
  root: string,
  packageDir: string,
):
  | { skipped: true; reason: string }
  | { skipped: false; violations: PortabilityViolation[] } {
  const distDir = join(root, packageDir, "dist");
  if (!existsSync(distDir) || !existsSync(join(distDir, "index.js"))) {
    return {
      skipped: true,
      reason: `${packageDir}/dist/index.js missing — run build first for dist gate`,
    };
  }
  const files = walkFiles(distDir).filter(isDistJsFile);
  const violations: PortabilityViolation[] = [];
  for (const f of files) {
    violations.push(...scanFile(f, root));
  }
  return { skipped: false, violations };
}

export function scanCoreSrc(root: string = ROOT): PortabilityViolation[] {
  return scanPackageSrc(root, "packages/core");
}

export function scanCoreDist(
  root: string = ROOT,
):
  | { skipped: true; reason: string }
  | { skipped: false; violations: PortabilityViolation[] } {
  return scanPackageDist(root, "packages/core");
}

/**
 * Optional Deno smoke: if `deno` is on PATH, try a minimal import of dist.
 * Missing deno is SKIP (not failure) — static analysis is the required gate.
 */
export function tryDenoImportSmoke(
  root: string = ROOT,
): { status: "ok" | "skip" | "fail"; message: string } {
  const distIndex = join(root, "packages", "core", "dist", "index.js");
  if (!existsSync(distIndex)) {
    return { status: "skip", message: "dist/index.js missing — Deno smoke skipped" };
  }

  // Detect deno without spawning when absent
  const which = Bun.spawnSync(["sh", "-c", "command -v deno"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (which.exitCode !== 0) {
    return {
      status: "skip",
      message:
        "deno binary not found — Deno import smoke skipped (static node: scan is required)",
    };
  }

  // Deno needs a file URL; use --allow-read for local dist
  const fileUrl = `file://${distIndex}`;
  const code = `
    const mod = await import(${JSON.stringify(fileUrl)});
    if (typeof mod.createPaymentRuntime !== "function") {
      console.error("createPaymentRuntime missing");
      Deno.exit(1);
    }
    if (typeof mod.hmacSha256Hex !== "function") {
      console.error("hmacSha256Hex missing");
      Deno.exit(1);
    }
    console.log("deno ok: portable runtime exports present");
  `;
  const result = Bun.spawnSync(
    ["deno", "eval", "--allow-read", code],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    const err = new TextDecoder().decode(result.stderr || result.stdout);
    return {
      status: "fail",
      message: `Deno import smoke failed:\n${err}`,
    };
  }
  return {
    status: "ok",
    message: new TextDecoder().decode(result.stdout).trim() || "deno ok",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  console.log("==> check runtime portability (Phase 8.4 / 8.5)");
  console.log(`    root: ${ROOT}`);
  console.log(`    packages: ${PORTABLE_PACKAGE_DIRS.join(", ")}`);

  let failed = false;

  for (const packageDir of PORTABLE_PACKAGE_DIRS) {
    const srcViolations = scanPackageSrc(ROOT, packageDir);
    const distResult = scanPackageDist(ROOT, packageDir);

    if (srcViolations.length === 0) {
      console.log(
        `==> ${packageDir}/src production sources: no banned node:/bun:/cloudflare: imports`,
      );
    } else {
      failed = true;
      console.error(
        `\nerror: ${srcViolations.length} portable source violation(s) under ${packageDir}/src:\n`,
      );
      for (const v of srcViolations) {
        console.error(
          `  - ${v.file}: ${v.reason} (specifier: ${JSON.stringify(v.specifier)})`,
        );
      }
    }

    if (distResult.skipped) {
      console.warn(`==> ${packageDir}/dist scan SKIP: ${distResult.reason}`);
    } else if (distResult.violations.length === 0) {
      console.log(
        `==> ${packageDir}/dist: no banned node:/bun:/cloudflare: imports (Workers/Deno gate)`,
      );
    } else {
      failed = true;
      console.error(
        `\nerror: ${distResult.violations.length} portable dist violation(s) under ${packageDir}:\n`,
      );
      for (const v of distResult.violations) {
        console.error(
          `  - ${v.file}: ${v.reason} (specifier: ${JSON.stringify(v.specifier)})`,
        );
      }
    }
  }

  const deno = tryDenoImportSmoke(ROOT);
  if (deno.status === "ok") {
    console.log(`==> Deno smoke: ${deno.message}`);
  } else if (deno.status === "skip") {
    console.log(`==> Deno smoke SKIP: ${deno.message}`);
  } else {
    failed = true;
    console.error(`\nerror: ${deno.message}`);
  }

  if (failed) {
    console.error(
      "\nSee packages/core/docs/runtime.md § Runtime matrix and docs/workspace-boundaries.md.",
    );
    process.exit(1);
  }

  console.log("==> runtime portability OK");
  process.exit(0);
}

if (import.meta.main) {
  main();
}
