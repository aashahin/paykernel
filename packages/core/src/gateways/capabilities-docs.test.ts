// file: packages/core/src/gateways/capabilities-docs.test.ts

/**
 * Unit + drift tests for capability documentation generation (Phase 3.3).
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_DOCS_BANNER,
  generateGatewayCapabilitiesMarkdown,
} from "./capabilities-docs";
import { BUILTIN_GATEWAY_MANIFESTS } from "./builtin-capabilities";
import { GATEWAY_CAPABILITY_KEYS } from "./gateway-capabilities";
import type { GatewayManifest } from "./gateway-manifest";

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKED_IN_DOC = join(CORE_ROOT, "docs", "gateway-capabilities.md");

describe("generateGatewayCapabilitiesMarkdown", () => {
  it("includes partialRefunds and each built-in provider name", () => {
    const md = generateGatewayCapabilitiesMarkdown(BUILTIN_GATEWAY_MANIFESTS);

    expect(md).toContain(CAPABILITY_DOCS_BANNER);
    expect(md).toContain("partialRefunds");
    expect(md).toContain("stripe");
    expect(md).toContain("moyasar");
    expect(md).toContain("paypal");
    expect(md).toContain("paymob");
    expect(md).toContain("Stripe");
    expect(md).toContain("Moyasar");
    expect(md).toContain("PayPal");
    expect(md).toContain("Paymob");
  });

  it("renders a row for every capability key and ✓ for claimed cells", () => {
    const md = generateGatewayCapabilitiesMarkdown(BUILTIN_GATEWAY_MANIFESTS);

    for (const key of GATEWAY_CAPABILITY_KEYS) {
      expect(md).toContain(`| ${key} |`);
    }

    // Stripe hostedCheckout true → ✓ in stripe column (first data column)
    expect(md).toMatch(/\| hostedCheckout \| ✓ \|/);
    expect(md).toMatch(/\| customers \| ✓ \| ✗ \| ✗ \| ✗ \|/);
    expect(md).toMatch(/\| paymentMethods \| ✓ \| ✗ \| ✗ \| ✗ \|/);
    // All deny providerRecurring
    expect(md).toMatch(
      /\| providerRecurring \| ✗ \| ✗ \| ✗ \| ✗ \|/,
    );
    // Moyasar marketplaceSplits
    expect(md).toMatch(/\| marketplaceSplits \| ✗ \| ✓ \| ✗ \| ✗ \|/);
  });

  it("marks missing capabilities as unsupported (all ✗)", () => {
    const bare: GatewayManifest[] = [
      { name: "acme", displayName: "Acme" },
    ];
    const md = generateGatewayCapabilitiesMarkdown(bare);
    expect(md).toContain("Acme");
    expect(md).toContain("| payments | ✗ |");
    expect(md).toContain("| partialRefunds | ✗ |");
  });

  it("handles empty manifest list", () => {
    const md = generateGatewayCapabilitiesMarkdown([]);
    expect(md.startsWith(CAPABILITY_DOCS_BANNER)).toBe(true);
    expect(md).toContain("No gateway manifests");
  });

  it("does not embed credential values or secret material", () => {
    const md = generateGatewayCapabilitiesMarkdown(BUILTIN_GATEWAY_MANIFESTS);
    // No live/test key material or env secret values in generated docs
    expect(md).not.toMatch(/sk_live|sk_test_|pk_live|whsec_/i);
    expect(md).not.toMatch(/process\.env\.[A-Z0-9_]*SECRET/i);
  });
});

describe("checked-in gateway-capabilities.md drift", () => {
  it("matches generateGatewayCapabilitiesMarkdown(BUILTIN_GATEWAY_MANIFESTS)", () => {
    expect(existsSync(CHECKED_IN_DOC)).toBe(true);
    const onDisk = readFileSync(CHECKED_IN_DOC, "utf8");
    const expected = generateGatewayCapabilitiesMarkdown(
      BUILTIN_GATEWAY_MANIFESTS,
    );
    expect(onDisk).toBe(expected);
  });
});
