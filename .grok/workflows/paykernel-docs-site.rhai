let meta = #{
    name: "paykernel-docs-site",
    description: "Scaffold Nimbus docs, port verified package docs, gate claims against source, deploy with wrangler",
    phases: [
        #{ title: "Inventory", detail: "catalog publishable packages, exports, and existing markdown" },
        #{ title: "Scaffold", detail: "create apps/docs Nimbus site and wrangler config" },
        #{ title: "Write", detail: "parallel disjoint MDX shards from real source" },
        #{ title: "Guard", detail: "docs-guard every shard against src and package.json" },
        #{ title: "Gate", detail: "adversarial honesty blockers" },
        #{ title: "Remediate", detail: "fix blocking findings only" },
        #{ title: "Verify", detail: "build, lint, claim checker" },
        #{ title: "Deploy", detail: "bunx wrangler deploy to Abdelrahman account" },
        #{ title: "Report", detail: "scratch summary with live URL" },
    ],
    when_to_use: "Build or refresh the public PayKernel Nimbus docs site from real package sources before npm publish",
};

let inventory_schema = #{
    "type": "object",
    "required": ["ok", "package_count", "missing", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "package_count": #{ "type": "integer" },
        "missing": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "summary": #{ "type": "string" },
    },
};

let implement_schema = #{
    "type": "object",
    "required": ["ok", "files_changed", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "files_changed": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 80 },
        "summary": #{ "type": "string" },
        "notes": #{ "type": "string" },
        "url": #{ "type": "string" },
    },
};

let findings_schema = #{
    "type": "object",
    "required": ["blocking", "non_blocking", "summary"],
    "properties": #{
        "blocking": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "non_blocking": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "summary": #{ "type": "string" },
        "pages_checked": #{ "type": "integer" },
    },
};

let gate_schema = #{
    "type": "object",
    "required": ["pass", "blocking", "non_blocking", "summary"],
    "properties": #{
        "pass": #{ "type": "boolean" },
        "blocking": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "non_blocking": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 50 },
        "summary": #{ "type": "string" },
    },
};

let rem_schema = #{
    "type": "object",
    "required": ["ok", "fixed", "remaining", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "fixed": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "remaining": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "summary": #{ "type": "string" },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["ok", "build_ok", "failures", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "build_ok": #{ "type": "boolean" },
        "lint_ok": #{ "type": "boolean" },
        "claims_ok": #{ "type": "boolean" },
        "failures": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 40 },
        "commands_run": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 20 },
        "summary": #{ "type": "string" },
    },
};

let report_schema = #{
    "type": "object",
    "required": ["ok", "summary"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "summary": #{ "type": "string" },
        "url": #{ "type": "string" },
        "page_count": #{ "type": "integer" },
    },
};

let root = if args == () || args.root == () {
    "/home/shahin/Documents/projects/personal/packages/paykernel"
} else {
    args.root
};

let spec = root + "/.grok/docs-site-spec.md";
let site = root + "/apps/docs";
let content = site + "/src/content/docs";

fn safe_summary(r) {
    if r == () { return "no-result"; }
    if !r.success { return "failed"; }
    if r.output == () { return "empty-output"; }
    if r.output.summary == () { return "ok"; }
    r.output.summary
}

fn is_true(r, field) {
    if r == () { return false; }
    if !r.success { return false; }
    if r.output == () { return false; }
    if field == "ok" { return r.output.ok == true; }
    if field == "pass" { return r.output.pass == true; }
    if field == "build_ok" { return r.output.build_ok == true; }
    false
}

fn blocking_list(r) {
    if r == () { return []; }
    if !r.success { return ["agent-failed"]; }
    if r.output == () { return ["empty-output"]; }
    if r.output.blocking == () { return []; }
    r.output.blocking
}

fn count_blocking(items) {
    items.len()
}

// ─── Inventory ───────────────────────────────────────────────────
phase("Inventory");
log("Catalog publishable packages at " + root);

let p_inv = "";
p_inv += "READ-ONLY inventory of PayKernel at " + root + ".\n";
p_inv += "Read " + spec + " first. Use list_dir, read_file, grep. Do not edit. Do not commit.\n";
p_inv += "Walk packages/*/package.json. Record name, version, private, exports keys.\n";
p_inv += "REQUIRED names: @paykernel/core webhooks reconciliation routing opentelemetry gateway-tap gateway-myfatoorah integration-http integration-hono integration-elysia integration-express integration-cloudflare-workers store-contracts sql-foundation store-postgres store-redis store-sqlite store-turso store-d1 store-durable-objects testkit.\n";
p_inv += "Folder packages/observability MUST publish as @paykernel/opentelemetry — if name is wrong, put it in missing.\n";
p_inv += "Confirm internal/sql-store is private. Confirm examples/* are private.\n";
p_inv += "Read packages/core/src/index.ts and packages/core/docs/baseline/public-api.inventory.json so you know createPaymentClient, money, isPaidOutcome exist.\n";
p_inv += "ok=true only if every required package.json exists with the expected name. missing[] = required names not found. package_count = number of packages/* dirs with package.json.\n";
p_inv += "Empty missing is valid only after you opened each package.json. Return {ok, package_count, missing, summary}.\n";

let inventory = agent(p_inv, #{
    label: "inventory:packages",
    capability_mode: "read-only",
    output_schema: inventory_schema,
});
log("Inventory: " + safe_summary(inventory));

// ─── Scaffold ────────────────────────────────────────────────────
phase("Scaffold");
log("Scaffold Nimbus apps/docs");

let p_sc = "";
p_sc += "SCAFFOLD the PayKernel Nimbus docs site. Repo: " + root + ".\n";
p_sc += "Read " + spec + " and follow the Stack section exactly. Use read_file before editing. Do NOT commit or push.\n";
p_sc += "1) If " + site + " does not already contain astro.config.ts, run from " + root + ":\n";
p_sc += "   bunx @cloudflare/create-nimbus-docs@latest apps/docs --yes --package-manager bun --deploy cloudflare --content empty --no-git --skip-install\n";
p_sc += "   If apps/docs already exists with astro.config.ts, do not re-scaffold; adapt it.\n";
p_sc += "2) Set apps/docs/package.json name to @paykernel/docs and private true. Do not add it to changesets.\n";
p_sc += "3) Root package.json: add apps/* to workspaces (keep packages/*, internal/*, examples/*). Add scripts docs:dev, docs:build, docs:deploy that run in apps/docs (dev, build, bunx wrangler deploy after build). Do not change SDK build/test/lint package globs except workspaces.\n";
p_sc += "4) bun install at repo root.\n";
p_sc += "5) astro.config.ts Nimbus defineConfig: title PayKernel; description Type-safe payment orchestration for TypeScript (MENA providers + modern server runtimes).; github https://github.com/aashahin/paykernel; editPattern https://github.com/aashahin/paykernel/edit/main/{path}; site https://paykernel-docs.abdelrahman.workers.dev; sidebar items EXACTLY as in the spec (index, quickstart, autogenerate guides/packages/gateways/stores/integrations/examples/reference, contributing).\n";
p_sc += "6) wrangler.jsonc: name paykernel-docs; account_id 53fb41ede04e54b276ce3fd9bfd270b6; workers_dev true; assets.directory ./dist; keep scaffold main if present; no extra bindings.\n";
p_sc += "7) Delete starter demo MDX under src/content/docs so writers start clean. Create empty directories for guides packages gateways stores integrations examples reference.\n";
p_sc += "8) Do NOT write final documentation pages. Do NOT edit packages/* sources.\n";
p_sc += "OWN: apps/docs (except final MDX), root package.json workspaces+docs scripts only.\n";
p_sc += "Return {ok, files_changed, summary, notes}.\n";

let scaffold = agent(p_sc, #{
    label: "scaffold:nimbus",
    capability_mode: "all",
    output_schema: implement_schema,
});
log("Scaffold: " + safe_summary(scaffold));

// ─── Write ───────────────────────────────────────────────────────
phase("Write");
log("Parallel MDX shards from real source");

let rules = "";
rules += "Repo: " + root + ". Spec: " + spec + " — READ IT. Content root: " + content + ".\n";
rules += "Use read_file and grep on SOURCE files before writing. Port, do not invent. Do NOT commit or push.\n";
rules += "Do NOT edit packages/*/src. Do NOT edit other shards' MDX files. Do NOT edit astro.config.ts or wrangler.jsonc unless you are the home shard updating site URL (you are not).\n";
rules += "Every MDX file: title+description frontmatter, sidebar.order, honesty rules from the spec, real imports/exports, failure paths, internal links as /guides/... paths.\n";
rules += "No mermaid. No TODO. No npm-already-published. Never @paykernel/observability. Never install internal-sql-store. Never fulfill in onWebhookVerified.\n";
rules += "Nimbus MDX: :::note / :::caution admonitions ok. No unpublished draft pages in your owned list.\n";
rules += "Return {ok, files_changed, summary, notes}.\n";

let p_home = "";
p_home += rules;
p_home += "SHARD home. OWN ONLY:\n";
p_home += content + "/index.mdx\n";
p_home += content + "/quickstart.mdx\n";
p_home += content + "/contributing.mdx\n";
p_home += content + "/guides/best-practices.mdx\n";
p_home += "and the Documentation section of " + root + "/README.md (do not rewrite the rest).\n";
p_home += "Sources: root README, docs/README.md, docs/getting-started.md section 1, packages/core/docs/behavioral-contracts.md rules, docs/stability.md.\n";
p_home += "index.mdx: docs-first landing, package map, honesty bullets, CTA to /quickstart.\n";
p_home += "quickstart.mdx: createPaymentClient + moyasarGateway + money + isPaidOutcome copied from getting-started; show indeterminate/declined branches.\n";

let p_guides = "";
p_guides += rules;
p_guides += "SHARD guides. OWN " + content + "/guides/*.mdx EXCEPT best-practices.mdx (home owns that).\n";
p_guides += "Write: index, getting-started, money, outcomes, webhooks, adapter-selection, composition, runtime, migrate-to-1-0.\n";
p_guides += "Sources listed in the spec table. adapter-selection: convert mermaid to tables; copy matrix honesty from docs/adapter-selection.md and docs/adapter-capability-matrix.json.\n";
p_guides += "getting-started must include inbox+postgres composition from docs/getting-started.md including migratePostgresAdapter, processWebhookHttp, isPaidFulfillmentEvent, findOrderForEvent.\n";

let p_core = "";
p_core += rules;
p_core += "SHARD core. OWN:\n";
p_core += content + "/packages/index.mdx\n";
p_core += content + "/packages/core.mdx\n";
p_core += content + "/gateways/index.mdx\n";
p_core += content + "/gateways/moyasar.mdx\n";
p_core += content + "/gateways/paypal.mdx\n";
p_core += content + "/gateways/paymob.mdx\n";
p_core += content + "/gateways/stripe.mdx\n";
p_core += content + "/gateways/custom.mdx\n";
p_core += "Do NOT write tap.mdx or myfatoorah.mdx. Link to /gateways/tap and /gateways/myfatoorah as extra packages, not BuiltInGatewayName.\n";
p_core += "Sources: packages/core/README.md, packages/core/docs/*.md (not baseline product guide), packages/core/src/index.ts, public-api.inventory.json.\n";
p_core += "packages/index.mdx lists every publishable package with CORRECT npm names (@paykernel/opentelemetry not observability).\n";

let p_eng = "";
p_eng += rules;
p_eng += "SHARD engines. OWN ONLY:\n";
p_eng += content + "/packages/webhooks.mdx\n";
p_eng += content + "/packages/reconciliation.mdx\n";
p_eng += content + "/packages/routing.mdx\n";
p_eng += content + "/packages/opentelemetry.mdx\n";
p_eng += "Sources: packages/webhooks, packages/reconciliation, packages/routing, packages/observability (publish name @paykernel/opentelemetry, subpath ./otel). Read each src/index.ts and README+docs.\n";
p_eng += "webhooks: createWebhookInboxEngine, resolveInboxPayloadHash, no HTTP status in this package.\n";
p_eng += "routing: select-only; no auto retry after indeterminate.\n";

let p_gw = "";
p_gw += rules;
p_gw += "SHARD extra-gateways. OWN ONLY:\n";
p_gw += content + "/gateways/tap.mdx\n";
p_gw += content + "/gateways/myfatoorah.mdx\n";
p_gw += "Sources: packages/gateway-tap and packages/gateway-myfatoorah README, docs, src/index.ts (tapGateway, myfatoorah factory as actually exported).\n";
p_gw += "They are extra packages depending on @paykernel/core only. Not built-ins.\n";

let p_st = "";
p_st += rules;
p_st += "SHARD stores. OWN " + content + "/stores/** and " + content + "/packages/store-contracts.mdx and " + content + "/packages/sql-foundation.mdx.\n";
p_st += "Write stores/index plus postgres redis sqlite turso d1 durable-objects.\n";
p_st += "Subpaths ONLY as in spec. No /sync on turso. sqlite single-host. redis optional. d1 not DO. migrate explicitly.\n";
p_st += "Sources: each packages/store-*/README.md, docs/, package.json exports, packages/store-contracts, packages/sql-foundation, docs/adapter-selection.md.\n";

let p_int = "";
p_int += rules;
p_int += "SHARD integrations. OWN " + content + "/integrations/**.\n";
p_int += "Write index, http, hono, elysia, express, cloudflare-workers.\n";
p_int += "Sources: packages/integration-*/README.md, docs/overview.md, src/index.ts.\n";
p_int += "Raw body before verify. mapInboxOutcome from integration-http (re-exported by hono/elysia/express/workers).\n";

let p_ex = "";
p_ex += rules;
p_ex += "SHARD examples. OWN " + content + "/examples/**.\n";
p_ex += "Write index plus checkout-kernel, bun-hono-sqlite, bun-hono-postgres, bun-elysia-sqlite, express-sqlite, cloudflare-workers-fetch.\n";
p_ex += "Sources: examples/README.md and each example README/src. Private, not published. :memory: sqlite is single-process. enableTestHooks must not be deployed. Link to GitHub paths under examples/.\n";

let p_ref = "";
p_ref += rules;
p_ref += "SHARD reference. OWN " + content + "/reference/** and " + site + "/scripts/check-doc-claims.ts.\n";
p_ref += "packages.mdx: table from packages/*/package.json name version exports. Mark internal-sql-store not published.\n";
p_ref += "core-api.mdx: list runtime exports FROM packages/core/docs/baseline/public-api.inventory.json (do not hand-type from memory).\n";
p_ref += "errors.mdx: classes exported from packages/core/src/errors.ts via index.ts.\n";
p_ref += "events.mdx: webhook-events.md + STABLE_PAYMENT_EVENT_TYPES from source.\n";
p_ref += "capabilities.mdx: port packages/core/docs/gateway-capabilities.md (generated).\n";
p_ref += "check-doc-claims.ts: bun script that greps MDX for @paykernel/ specifiers; fail unknown names, fail @paykernel/observability, fail install of internal-sql-store. Known names = packages/*/package.json name fields.\n";

let writers = parallel([
    #{ prompt: p_home, label: "write:home", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_guides, label: "write:guides", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_core, label: "write:core", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_eng, label: "write:engines", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_gw, label: "write:extra-gateways", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_st, label: "write:stores", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_int, label: "write:integrations", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_ex, label: "write:examples", capability_mode: "all", output_schema: implement_schema },
    #{ prompt: p_ref, label: "write:reference", capability_mode: "all", output_schema: implement_schema },
]);

let wi = 0;
for w in writers {
    log("Write " + wi.to_string() + ": " + safe_summary(w));
    wi += 1;
}

// ─── Guard ───────────────────────────────────────────────────────
phase("Guard");
log("Docs-guard each shard against source");

let g_common = "";
g_common += "READ-ONLY docs-guard. Repo: " + root + ". Spec: " + spec + ".\n";
g_common += "Use read_file and grep. Do not edit. Do not trust writer summaries.\n";
g_common += "Open EVERY MDX file in your shard. Extract symbols, imports, subpaths, env vars, routes, status codes.\n";
g_common += "Verify each against packages/*/src, package.json exports, or the named source doc. Cite file:line.\n";
g_common += "blocking[] = false claims (invented API, wrong package name, honesty violation).\n";
g_common += "non_blocking[] = filler, missing failure-path, weak internal links.\n";
g_common += "Empty blocking is valid ONLY after you opened the pages. If a required file is missing, that is blocking.\n";
g_common += "Return {blocking, non_blocking, summary, pages_checked}.\n";

let g_home = g_common;
g_home += "SHARD home. Check " + content + "/index.mdx quickstart.mdx contributing.mdx guides/best-practices.mdx.\n";
g_home += "createPaymentClient, moyasarGateway, money, isPaidOutcome must exist in packages/core/src/index.ts.\n";

let g_guides = g_common;
g_guides += "SHARD guides. Check all " + content + "/guides/*.mdx except you may skip best-practices if home covers it — still check getting-started composition imports against store-postgres/pg and webhooks src.\n";

let g_core = g_common;
g_core += "SHARD core. Check packages/index.mdx packages/core.mdx and gateways moyasar paypal paymob stripe custom index. Built-in factory names from packages/core/src/index.ts. No tap/myfatoorah claimed as BuiltInGatewayName.\n";

let g_eng = g_common;
g_eng += "SHARD engines. Check packages/webhooks.mdx reconciliation.mdx routing.mdx opentelemetry.mdx against those packages' src/index.ts. Folder observability must be documented as @paykernel/opentelemetry.\n";

let g_gw = g_common;
g_gw += "SHARD extra-gateways. Check gateways/tap.mdx and myfatoorah.mdx against packages/gateway-tap and gateway-myfatoorah src/index.ts.\n";

let g_st = g_common;
g_st += "SHARD stores. Check stores/* and packages/store-contracts.mdx sql-foundation.mdx. Subpaths must match package.json exports. Flag /sync, multi-host sqlite, redis-required, D1=DO.\n";

let g_int = g_common;
g_int += "SHARD integrations. Check integrations/*.mdx against packages/integration-*/src/index.ts. Raw-body requirement must match code.\n";

let g_ex = g_common;
g_ex += "SHARD examples. Check examples/*.mdx against examples/README.md and example src. Test hooks must be labeled do-not-deploy.\n";

let g_ref = g_common;
g_ref += "SHARD reference. Check reference/*.mdx against public-api.inventory.json, package.json names, errors.ts. Confirm check-doc-claims.ts exists and encodes the banned names.\n";

let guards = parallel([
    #{ prompt: g_home, label: "guard:home", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_guides, label: "guard:guides", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_core, label: "guard:core", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_eng, label: "guard:engines", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_gw, label: "guard:extra-gateways", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_st, label: "guard:stores", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_int, label: "guard:integrations", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_ex, label: "guard:examples", capability_mode: "read-only", output_schema: findings_schema },
    #{ prompt: g_ref, label: "guard:reference", capability_mode: "read-only", output_schema: findings_schema },
]);

let all_blocking = [];
let gi = 0;
for g in guards {
    log("Guard " + gi.to_string() + ": " + safe_summary(g));
    let bl = blocking_list(g);
    for b in bl {
        all_blocking.push(b);
    }
    gi += 1;
}
log("Guard blocking count: " + all_blocking.len().to_string());

// ─── Gate ────────────────────────────────────────────────────────
phase("Gate");
log("Adversarial honesty gate");

let p_gate = "";
p_gate += "READ-ONLY adversarial gate. Repo: " + root + ". Spec: " + spec + ". Content: " + content + ".\n";
p_gate += "Use grep and read_file. Do not trust writers or guards. Fail closed. pass=true only if ALL blockers are gone with file:line.\n";
p_gate += "BLOCKERS (grep the MDX tree):\n";
p_gate += "DOC-OBS: any @paykernel/observability install/import (must be @paykernel/opentelemetry).\n";
p_gate += "DOC-INTERNAL: telling readers to bun add / npm i @paykernel/internal-sql-store.\n";
p_gate += "DOC-FULFILL: fulfill inside onWebhookVerified or on handleWebhook alone.\n";
p_gate += "DOC-INDET: createPayment again after indeterminate / reconciliationRequired.\n";
p_gate += "DOC-SQLITE: local sqlite or memory described as multi-host.\n";
p_gate += "DOC-SYNC: turso /sync export.\n";
p_gate += "DOC-D1DO: D1 and Durable Objects treated as the same store.\n";
p_gate += "DOC-NPM: claiming packages are already published / 1.0 is on npm (version is 0.1.0-next.0).\n";
p_gate += "DOC-HOOKS: example /internal/* presented as production routes.\n";
p_gate += "DOC-HTTP: HTTP status codes owned by @paykernel/webhooks.\n";
p_gate += "DOC-MISSING: any expected path from the spec tree is absent under " + content + ".\n";
p_gate += "DOC-SITE: apps/docs astro.config.ts and wrangler.jsonc exist; wrangler name paykernel-docs; account_id 53fb41ede04e54b276ce3fd9bfd270b6.\n";
p_gate += "Non-blocking: prose polish, extra examples, token color, missing OG image.\n";
p_gate += "Return {pass, blocking, non_blocking, summary}.\n";

let gate = agent(p_gate, #{
    label: "gate:honesty",
    capability_mode: "read-only",
    output_schema: gate_schema,
});
log("Gate: " + safe_summary(gate));

let gate_blocking = blocking_list(gate);
for b in gate_blocking {
    all_blocking.push(b);
}

// ─── Remediate ───────────────────────────────────────────────────
phase("Remediate");

let gate_ok = is_true(gate, "pass") && all_blocking.len() == 0;
let rem_summary = "skipped";
let rem_ok = true;

if !gate_ok {
    log("Remediating blocking docs findings");
    let p_r = "";
    p_r += "FIX blocking docs-site findings in " + root + ". Spec: " + spec + ". Do NOT commit.\n";
    p_r += "Stay inside apps/docs/** and the Documentation section of root README.md. Do not change payment runtime logic in packages/*/src unless a sample import is wrong and you only fix the MDX.\n";
    p_r += "Prefer fixing MDX to match code. If in-package markdown is the lie, you MAY fix that source doc too.\n";
    p_r += "Guard+gate blocking JSON: " + json_encode(all_blocking) + "\n";
    p_r += "Gate summary: " + safe_summary(gate) + "\n";
    p_r += "Return {ok, fixed, remaining, summary}. ok only if blockers are gone.\n";
    let rem = agent(p_r, #{
        label: "remediate:docs",
        capability_mode: "all",
        output_schema: rem_schema,
    });
    rem_summary = safe_summary(rem);
    rem_ok = is_true(rem, "ok");
    log("Remediate: " + rem_summary);
} else {
    log("Gate passed with no blocking; skip remediate");
}

// ─── Verify ──────────────────────────────────────────────────────
phase("Verify");
log("Build docs site and run claim checker");

let p_v = "";
p_v += "VERIFY the docs site at " + site + ". EXECUTE commands. Paste failing lines. Do not commit.\n";
p_v += "You MAY bun install if node_modules is missing. You MAY add a tiny missing script; do not rewrite content unless build fails on MDX syntax — then fix syntax only.\n";
p_v += "1) cd " + site + " && bun run build   (or bunx astro build). ok only if exit 0.\n";
p_v += "2) If nimbus-docs lint or bun run lint:docs exists, run it. lint failure is non-fatal unless error-severity and you can fix quickly.\n";
p_v += "3) If " + site + "/scripts/check-doc-claims.ts exists, run bun " + site + "/scripts/check-doc-claims.ts. Failure is fatal.\n";
p_v += "4) Confirm expected MDX files from the spec exist (list_dir " + content + "). Missing expected page = failure.\n";
p_v += "Return {ok, build_ok, lint_ok, claims_ok, failures, commands_run, summary}. ok=true only if build_ok and no missing expected pages and claims checker did not fail (skip claims_ok=true if script missing AND you listed that as a failure).\n";

let verify = agent(p_v, #{
    label: "verify:build",
    capability_mode: "all",
    output_schema: verify_schema,
});
log("Verify: " + safe_summary(verify));

// ─── Deploy ──────────────────────────────────────────────────────
phase("Deploy");

let verify_ok = is_true(verify, "ok") && is_true(verify, "build_ok");
let deploy_summary = "skipped";
let deploy_ok = false;
let deploy_url = "";

if verify_ok && rem_ok {
    log("Deploying paykernel-docs with bunx wrangler");
    let p_d = "";
    p_d += "DEPLOY the PayKernel docs site. Repo: " + root + ". App: " + site + ".\n";
    p_d += "Do NOT commit. Do NOT create custom domains. Do NOT use any Cloudflare account except wrangler.jsonc account_id 53fb41ede04e54b276ce3fd9bfd270b6 (Abdelrahman).\n";
    p_d += "1) Confirm wrangler.jsonc name is paykernel-docs and account_id is set.\n";
    p_d += "2) bunx wrangler whoami (from " + site + " or repo root). If the account is wrong, stop and return ok=false with notes.\n";
    p_d += "3) If dist/ is missing, bun run build in " + site + ".\n";
    p_d += "4) bunx wrangler deploy  — run inside " + site + ". Capture the workers.dev URL.\n";
    p_d += "5) If the live URL differs from astro site config, update Nimbus site URL in astro.config.ts to the real URL and rebuild+redeploy once if needed.\n";
    p_d += "6) Update " + root + "/README.md Documentation section to lead with the live URL.\n";
    p_d += "Return {ok, files_changed, summary, notes, url} where url is the public https URL.\n";
    let dep = agent(p_d, #{
        label: "deploy:wrangler",
        capability_mode: "all",
        output_schema: implement_schema,
    });
    deploy_summary = safe_summary(dep);
    deploy_ok = is_true(dep, "ok");
    if dep != () && dep.success && dep.output != () && dep.output.url != () {
        deploy_url = dep.output.url;
    }
    log("Deploy: " + deploy_summary);
} else {
    log("Skip deploy; verify or remediate not green");
    deploy_summary = "skipped-not-green";
}

// ─── Report ──────────────────────────────────────────────────────
phase("Report");

let final_ok = is_true(inventory, "ok") && is_true(scaffold, "ok") && verify_ok && rem_ok && deploy_ok;

let report = "";
report += "# PayKernel docs site\n\n";
if final_ok {
    report += "Status: passed\n\n";
} else {
    report += "Status: failed-or-partial\n\n";
}
report += "Inventory: " + safe_summary(inventory) + "\n";
report += "Scaffold: " + safe_summary(scaffold) + "\n";
report += "Gate: " + safe_summary(gate) + "\n";
report += "Remediate: " + rem_summary + "\n";
report += "Verify: " + safe_summary(verify) + "\n";
report += "Deploy: " + deploy_summary + "\n";
if deploy_url != "" {
    report += "URL: " + deploy_url + "\n";
}
report += "Blocking count: " + all_blocking.len().to_string() + "\n";

let p_rep = "";
p_rep += "READ-ONLY wrap-up. Repo: " + root + ". Spec: " + spec + ".\n";
p_rep += "list_dir " + content + " and count MDX files. Confirm wrangler.jsonc exists.\n";
p_rep += "Draft:\n" + report + "\n";
p_rep += "Return {ok, summary, url, page_count}. ok if the site tree exists and deploy succeeded when verify was green. url from draft if present.\n";

let reporter = agent(p_rep, #{
    label: "report:docs",
    capability_mode: "read-only",
    output_schema: report_schema,
});
log("Report: " + safe_summary(reporter));

let path = write_scratch_file("paykernel-docs-site.md", report);
complete(#{
    ok: final_ok,
    path: path,
    url: deploy_url,
    inventory: safe_summary(inventory),
    scaffold: safe_summary(scaffold),
    gate: safe_summary(gate),
    remediate: rem_summary,
    verify: safe_summary(verify),
    deploy: deploy_summary,
    summary: if reporter != () && reporter.success && reporter.output != () && reporter.output.summary != () {
        reporter.output.summary
    } else {
        report
    },
});
