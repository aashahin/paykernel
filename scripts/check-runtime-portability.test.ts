/**
 * Unit tests for Phase 8.4/8.5 runtime portability checker.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PORTABLE_PACKAGE_DIRS,
  classifyPortableSpecifier,
  extractImportSpecifiers,
  isTestFile,
  scanCoreDist,
  scanCoreSrc,
  scanFile,
  scanPackageDist,
  scanPackageSrc,
} from "./check-runtime-portability";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "runtime-port-"));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("isTestFile", () => {
  it.each([
    ["src/client.test.ts", true],
    ["src/public-api.types.test.ts", true],
    ["src/client.ts", false],
    ["dist/index.js", false],
  ] as const)("%s → %s", (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

describe("extractImportSpecifiers", () => {
  it("extracts static and dynamic imports", () => {
    const source = `
      import { a } from "node:crypto";
      import { b } from "./local";
      const x = await import("zod");
      import "side-effect";
    `;
    const specs = extractImportSpecifiers(source);
    expect(specs).toEqual(
      expect.arrayContaining(["node:crypto", "./local", "zod", "side-effect"]),
    );
  });
});

describe("classifyPortableSpecifier", () => {
  it.each([
    ["./x", true],
    ["../runtime", true],
    ["zod", true],
  ] as const)("allows %s", (spec, ok) => {
    expect(classifyPortableSpecifier(spec).ok).toBe(ok);
  });

  it.each([
    ["node:crypto", false],
    ["node:buffer", false],
    ["node:fs", false],
    ["bun:sqlite", false],
    ["cloudflare:workers", false],
    ["crypto", false],
    ["buffer", false],
    ["url", false],
    ["util", false],
    ["events", false],
    ["assert", false],
    ["querystring", false],
    ["string_decoder", false],
    ["timers", false],
    ["tty", false],
    ["constants", false],
    ["fs", false],
  ] as const)("rejects %s", (spec, ok) => {
    expect(classifyPortableSpecifier(spec).ok).toBe(ok);
  });
});

describe("scanFile", () => {
  it("flags node:crypto imports", () => {
    const root = createTempRoot();
    const file = join(root, "bad.ts");
    writeFileSync(file, `import { createHmac } from "node:crypto";\n`);
    const v = scanFile(file, root);
    expect(v.length).toBe(1);
    expect(v[0]!.specifier).toBe("node:crypto");
  });

  it("allows pure relative imports", () => {
    const root = createTempRoot();
    const file = join(root, "ok.ts");
    writeFileSync(file, `import { hmacSha256Hex } from "./crypto-portable";\n`);
    expect(scanFile(file, root)).toEqual([]);
  });
});

describe("scanCoreSrc (live monorepo)", () => {
  it("packages/core production sources have no banned node: imports", () => {
    const root = join(import.meta.dir, "..");
    const violations = scanCoreSrc(root);
    expect(violations).toEqual([]);
  });
});

describe("scanCoreDist fixture", () => {
  it("flags node: in dist js when present", () => {
    const root = createTempRoot();
    const dist = join(root, "packages", "core", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "index.js"),
      `import { createHash } from "node:crypto";\nexport {};\n`,
    );
    const result = scanCoreDist(root);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.violations.some((v) => v.specifier === "node:crypto")).toBe(
        true,
      );
    }
  });
});

describe("scanCoreDist (live monorepo, when built)", () => {
  it("packages/core/dist has no banned node: imports when present", () => {
    const root = join(import.meta.dir, "..");
    const result = scanCoreDist(root);
    if (result.skipped) {
      // Build may not have run in an isolated unit-test path; src scan still gates.
      expect(result.reason).toMatch(/missing|build/i);
      return;
    }
    expect(result.violations).toEqual([]);
  });
});

describe("PORTABLE_PACKAGE_DIRS", () => {
  it("includes core, webhooks, reconciliation, observability, routing, store-contracts, sql-foundation, testkit, gateway-tap, and gateway-myfatoorah", () => {
    expect([...PORTABLE_PACKAGE_DIRS]).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });
});

describe("scanPackageSrc fixture", () => {
  it("flags node: in webhooks production src and ignores tests", () => {
    const root = createTempRoot();
    const src = join(root, "packages", "webhooks", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "engine.ts"), `import fs from "node:fs";\n`);
    writeFileSync(
      join(src, "engine.test.ts"),
      `import { test } from "bun:test";\n`,
    );
    const violations = scanPackageSrc(root, "packages/webhooks");
    expect(violations.some((v) => v.specifier === "node:fs")).toBe(true);
    expect(violations.some((v) => v.file.includes("engine.test"))).toBe(false);
  });

  it("flags bun: and cloudflare: in store-contracts production src", () => {
    const root = createTempRoot();
    const src = join(root, "packages", "store-contracts", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "contracts.ts"),
      `import { DurableObject } from "cloudflare:workers";\n`,
    );
    writeFileSync(join(src, "sqlite.ts"), `import db from "bun:sqlite";\n`);
    const violations = scanPackageSrc(root, "packages/store-contracts");
    expect(violations.some((v) => v.specifier === "cloudflare:workers")).toBe(
      true,
    );
    expect(violations.some((v) => v.specifier === "bun:sqlite")).toBe(true);
  });
});

describe("scanPackageDist fixture", () => {
  it("flags node: in webhooks dist", () => {
    const root = createTempRoot();
    const dist = join(root, "packages", "webhooks", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "index.js"),
      `import { createHash } from "node:crypto";\nexport {};\n`,
    );
    const result = scanPackageDist(root, "packages/webhooks");
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.violations.some((v) => v.specifier === "node:crypto")).toBe(
        true,
      );
    }
  });

  it("flags cloudflare: in store-contracts dist", () => {
    const root = createTempRoot();
    const dist = join(root, "packages", "store-contracts", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "index.js"),
      `import { DurableObject } from "cloudflare:workers";\nexport {};\n`,
    );
    const result = scanPackageDist(root, "packages/store-contracts");
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(
        result.violations.some((v) => v.specifier === "cloudflare:workers"),
      ).toBe(true);
    }
  });
});

describe("scanPackageSrc (live monorepo)", () => {
  it("webhooks and store-contracts production sources have no banned runtime imports", () => {
    const root = join(import.meta.dir, "..");
    expect(scanPackageSrc(root, "packages/webhooks")).toEqual([]);
    expect(scanPackageSrc(root, "packages/store-contracts")).toEqual([]);
  });
});

describe("scanPackageDist (live monorepo, when built)", () => {
  it.each(["packages/webhooks", "packages/store-contracts"] as const)(
    "%s/dist has no banned imports when present",
    (pkg) => {
      const root = join(import.meta.dir, "..");
      const result = scanPackageDist(root, pkg);
      if (result.skipped) {
        expect(result.reason).toMatch(/missing|build/i);
        return;
      }
      expect(result.violations).toEqual([]);
    },
  );
});
