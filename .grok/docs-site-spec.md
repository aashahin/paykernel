# PayKernel docs site — agent contract

Read this file before you write or review any page. Then read the **source files named for your shard**. Do not invent APIs.

Repo root: the PayKernel monorepo. Docs site: `apps/docs` (Nimbus / Astro). Content tree: `apps/docs/src/content/docs/` — the filesystem **is** the URL and the sidebar.

## Honesty (every page)

- Packages are **not published yet**. Version is `0.1.0-next.0`. Never say they are on npm as a released 1.0.
- Folder `packages/observability` publishes as **`@paykernel/opentelemetry`**. Never `@paykernel/observability`.
- `@paykernel/internal-sql-store` is **private**. Never tell readers to install it. Mention only as a BC shim over `@paykernel/sql-foundation`.
- Redis is **optional**. Local SQLite is **single-host**. `:memory:` is one process. Turso is **remote multi-host** and has **no** `/sync` export. D1 ≠ Durable Objects ≠ Turso ≠ local SQLite. Memory stores are **NON-PRODUCTION**.
- No published adapter declares `coordinationScope: "multi-region"`.
- `handleWebhook` verifies and normalizes. It does **not** claim, lease, or set HTTP status.
- **Never fulfill in `onWebhookVerified`.** Fulfill after an inbox **claim**, and only when the rematched event is `payment.succeeded` or `capture.completed` **and** `payment.status === "paid"`, bound to `gatewayPaymentId`.
- `success: true` is not the fulfillment signal. Use `isPaidOutcome` / `outcome`.
- After `outcome === "indeterminate"` or `reconciliationRequired`, **do not** `createPayment` again. Lookup + `decideReconciliationPolicy` only.
- Never auto-route a second gateway after timeout / indeterminate / uncertain 5xx.
- HTTP status codes live in `@paykernel/integration-http` (`mapInboxOutcome`), not in `@paykernel/webhooks`.
- Example `POST /internal/*` routes are unauthenticated test hooks (`enableTestHooks`) and **must not be deployed**.
- Code wins if markdown and implementation disagree. Flag the disagreement; do not paper over it.
- Do not paraphrase upstream PSP docs. Link out. Document only PayKernel’s mapping.
- No mermaid (Nimbus Sätteri does not run remark plugins). Use tables or ASCII.
- No `TODO`, “coming soon”, or unpublished pages in production content (`draft: true` is allowed only for pages you are not shipping).
- No marketing adjectives (“seamless”, “blazingly fast”, “production-ready”) without a repo-verifiable source.

## Stack

- Scaffold: `bunx @cloudflare/create-nimbus-docs@latest apps/docs --yes --package-manager bun --deploy cloudflare --content empty --no-git --skip-install`
- Then add `"apps/*"` to root `package.json` workspaces (keep `packages/*`, `internal/*`, `examples/*`).
- `bun install` at repo root.
- Docs package name: `@paykernel/docs`, `"private": true`. Not in changesets publish.
- Pin whatever `nimbus-docs` version the scaffolder installs.
- Nimbus config (`astro.config.ts`):
  - `title`: PayKernel
  - `description`: Type-safe payment orchestration for TypeScript (MENA providers + modern server runtimes).
  - `github`: `https://github.com/paykernel/paykernel`
  - `editPattern`: `https://github.com/paykernel/paykernel/edit/main/{path}`
  - `site`: `https://paykernel-docs.abdelrahman.workers.dev` until wrangler prints the real `*.workers.dev` URL; then update.
- Sidebar (scaffold owns `astro.config.ts` only):

```ts
sidebar: {
  items: [
    "index",
    "quickstart",
    { label: "Guides", autogenerate: { directory: "guides" } },
    { label: "Packages", autogenerate: { directory: "packages" } },
    { label: "Gateways", autogenerate: { directory: "gateways" } },
    { label: "Stores", autogenerate: { directory: "stores" } },
    { label: "Integrations", autogenerate: { directory: "integrations" } },
    { label: "Examples", autogenerate: { directory: "examples" } },
    { label: "Reference", autogenerate: { directory: "reference" } },
    "contributing",
  ],
}
```

- Wrangler (`apps/docs/wrangler.jsonc`):
  - `name`: `paykernel-docs`
  - `account_id`: `53fb41ede04e54b276ce3fd9bfd270b6` (Abdelrahman)
  - `assets.directory`: `./dist` (keep scaffold Worker `main` if present)
  - `workers_dev`: true
  - no extra bindings
- Root scripts: `docs:dev`, `docs:build`, `docs:deploy` (deploy = `bunx wrangler deploy` in `apps/docs` after build).
- Keep SDK `build` / `test` / `lint` of `packages/*/src` unchanged.

## Page format

Every MDX file:

```yaml
---
title: <page title>
description: <one sentence, no marketing>
sidebar:
  order: <integer>
---
```

Lead with the answer. Import paths in samples must match `package.json` `exports`. Copy samples from in-repo docs/examples that already compile. Show the failure path. Internal links use site paths (`/guides/money`), not repo-relative markdown.

## Expected tree (`apps/docs/src/content/docs/`)

```
index.mdx
quickstart.mdx
contributing.mdx
guides/index.mdx
guides/getting-started.mdx
guides/money.mdx
guides/outcomes.mdx
guides/webhooks.mdx
guides/adapter-selection.mdx
guides/composition.mdx
guides/runtime.mdx
guides/best-practices.mdx
guides/migrate-to-1-0.mdx
packages/index.mdx
packages/core.mdx
packages/webhooks.mdx
packages/reconciliation.mdx
packages/routing.mdx
packages/opentelemetry.mdx
packages/store-contracts.mdx
packages/sql-foundation.mdx
packages/testkit.mdx
gateways/index.mdx
gateways/moyasar.mdx
gateways/paypal.mdx
gateways/paymob.mdx
gateways/stripe.mdx
gateways/tap.mdx
gateways/myfatoorah.mdx
gateways/custom.mdx
stores/index.mdx
stores/postgres.mdx
stores/redis.mdx
stores/sqlite.mdx
stores/turso.mdx
stores/d1.mdx
stores/durable-objects.mdx
integrations/index.mdx
integrations/http.mdx
integrations/hono.mdx
integrations/elysia.mdx
integrations/express.mdx
integrations/cloudflare-workers.mdx
examples/index.mdx
examples/checkout-kernel.mdx
examples/bun-hono-sqlite.mdx
examples/bun-hono-postgres.mdx
examples/bun-elysia-sqlite.mdx
examples/express-sqlite.mdx
examples/cloudflare-workers-fetch.mdx
reference/index.mdx
reference/packages.mdx
reference/core-api.mdx
reference/errors.mdx
reference/events.mdx
reference/capabilities.mdx
```

Contributor-only files stay **out** of the primary nav: `docs/monorepo.md`, `docs/workspace-boundaries.md`, `docs/releases.md`, `packages/core/docs/baseline/*`, `roadmap.md`. `contributing.mdx` may link to them on GitHub.

## Shards (disjoint writes)

### scaffold

Owns: `apps/docs/**` **except** `src/content/docs/**` after first create (you may add empty dirs). Owns root `package.json` workspaces + docs scripts. Owns `apps/docs/astro.config.ts`, `wrangler.jsonc`, `package.json` name/private. Delete starter demo pages. Do not write final MDX (writers do).

### home

Owns:

- `apps/docs/src/content/docs/index.mdx`
- `apps/docs/src/content/docs/quickstart.mdx`
- `apps/docs/src/content/docs/contributing.mdx`
- `apps/docs/src/content/docs/guides/best-practices.mdx`
- Root `README.md` Documentation section (link to site + existing in-repo docs)

Sources: `README.md`, `docs/README.md`, `docs/getting-started.md` (first payment only), `packages/core/docs/behavioral-contracts.md` (rules, not the whole matrix), `docs/stability.md` (link).

Quickstart: `createPaymentClient` + `moyasarGateway` + `money` + `isPaidOutcome` from `docs/getting-started.md` section 1. Show declined / indeterminate branches.

### guides

Owns all `guides/*.mdx` except `best-practices.mdx`.

| Page | Source |
| --- | --- |
| `guides/index.mdx` | landing that routes |
| `getting-started.mdx` | `docs/getting-started.md` (full composition) |
| `money.mdx` | `packages/core/docs/money.md` |
| `outcomes.mdx` | `packages/core/docs/operation-results.md` |
| `webhooks.mdx` | `packages/core/docs/webhooks.md` + `packages/core/docs/webhook-events.md` + `packages/webhooks/docs/webhook-inbox.md` |
| `adapter-selection.mdx` | `docs/adapter-selection.md` + `docs/adapter-capability-matrix.json` (tables, no mermaid) |
| `composition.mdx` | getting-started production section + routing overview |
| `runtime.mdx` | `packages/core/docs/runtime.md` |
| `migrate-to-1-0.mdx` | `docs/migrations/1.0.md` |

### core

Owns: `packages/core.mdx`, `packages/index.mdx` (package map), `gateways/index.mdx`, `gateways/moyasar.mdx`, `paypal.mdx`, `paymob.mdx`, `stripe.mdx`, `custom.mdx`.

Sources: `packages/core/README.md`, `packages/core/docs/{moyasar,paypal,paymob,stripe,custom-gateways,plugin-architecture,hooks,customers,hosted-checkout,disputes,marketplace,payment-links,logging,telemetry,storage-adapters,gateway-capabilities}.md`, `packages/core/src/index.ts`, `packages/core/docs/baseline/public-api.inventory.json`.

Built-ins are in core. Tap/MyFatoorah are **not** `BuiltInGatewayName` — link to `/gateways/tap` and `/gateways/myfatoorah`.

`packages/index.mdx` lists every publishable package with correct npm names.

### engines

Owns: `packages/webhooks.mdx`, `packages/reconciliation.mdx`, `packages/routing.mdx`, `packages/opentelemetry.mdx`.

Sources: each package `README.md` + `docs/` + `src/index.ts`. Observability folder → `@paykernel/opentelemetry` and mention `./otel` subpath.

### extra-gateways

Owns: `gateways/tap.mdx`, `gateways/myfatoorah.mdx`, `gateways/hesabe.mdx`.

Sources: `packages/gateway-tap/**`, `packages/gateway-myfatoorah/**`, `packages/gateway-hesabe/**` (README, docs, `src/index.ts`). They depend only on `@paykernel/core`.

### stores

Owns: `stores/**`, `packages/store-contracts.mdx`, `packages/sql-foundation.mdx`.

Sources: each store README + docs + `package.json` exports.

Real subpaths (do not invent others):

- `@paykernel/store-postgres` `.` `/bun-sql` `/postgres-js` `/pg` `/drizzle`
- `@paykernel/store-redis` `.` `/bun` `/upstash` `/ioredis` `/node-redis`
- `@paykernel/store-sqlite` `.` `/bun` `/node` `/better-sqlite3`
- `@paykernel/store-turso` `.` `/serverless` `/libsql` — **no** `/sync`
- `@paykernel/store-d1` `.` only
- `@paykernel/store-durable-objects` `.` only — never one global DO

Migrate explicitly. Importing a store package does not apply DDL.

### integrations

Owns: `integrations/**`.

Sources: each `packages/integration-*/README.md`, `docs/overview.md`, `src/index.ts`. Hono/Elysia/Express/Workers re-export HTTP helpers; webhook routes must read **raw body** (`text()`), never `json()`, before verify.

### examples

Owns: `examples/**`.

Sources: `examples/README.md` and each example README/`src`. Private, never published. Document routes, honesty, and `enableTestHooks`. Link to GitHub source paths, do not paste entire apps.

### reference

Owns: `reference/**` and `apps/docs/scripts/check-doc-claims.ts`.

- `reference/packages.mdx`: table from each `packages/*/package.json` (`name`, `version`, `exports` keys, `private` false). Include observability publish name. Mark `internal/sql-store` as not published.
- `reference/core-api.mdx`: generated from `packages/core/docs/baseline/public-api.inventory.json` + `packages/core/src/index.ts`. List runtime exports. Do not hand-type the list.
- `reference/errors.mdx`: error classes from core `src/errors.ts` exports.
- `reference/events.mdx`: `packages/core/docs/webhook-events.md` + `STABLE_PAYMENT_EVENT_TYPES`.
- `reference/capabilities.mdx`: `packages/core/docs/gateway-capabilities.md` (generated from code — do not invent cells).
- `check-doc-claims.ts`: walk `src/content/docs/**/*.mdx`, fail if a `@paykernel/<name>` specifier is not in the known publishable set, fail on `@paykernel/observability`, fail on install instructions for `internal-sql-store`. Known set = the `name` fields of `packages/*/package.json` plus documented subpaths.

## Publishable packages (must all appear)

`@paykernel/core`, `@paykernel/webhooks`, `@paykernel/reconciliation`, `@paykernel/routing`, `@paykernel/opentelemetry`, `@paykernel/gateway-tap`, `@paykernel/gateway-myfatoorah`, `@paykernel/gateway-hesabe`, `@paykernel/integration-http`, `@paykernel/integration-hono`, `@paykernel/integration-elysia`, `@paykernel/integration-express`, `@paykernel/integration-cloudflare-workers`, `@paykernel/store-contracts`, `@paykernel/sql-foundation`, `@paykernel/store-postgres`, `@paykernel/store-redis`, `@paykernel/store-sqlite`, `@paykernel/store-turso`, `@paykernel/store-d1`, `@paykernel/store-durable-objects`, `@paykernel/testkit`.

## Docs-guard

For every MDX page you review: extract symbols, imports, subpaths, env vars, routes, status codes. Verify each against source with `file:line`. Unverified = blocking. Empty findings are valid **only after** you opened the MDX and the matching `src/index.ts` / docs.

## Adversarial blockers

- Invented export or subpath
- Wrong package name (`@paykernel/observability`, `@paykernel/gateway-stripe` as a package)
- Fulfill in `onWebhookVerified` or on webhook verify alone
- `createPayment` retry after indeterminate
- SQLite/memory described as multi-host
- `/sync` on Turso
- D1 and Durable Objects treated as interchangeable
- Internal sql-store as an install
- Claim that packages are already published to npm
- Test-hook routes documented as production
- HTTP status invented in `@paykernel/webhooks`

## Deploy

Account `53fb41ede04e54b276ce3fd9bfd270b6`. From `apps/docs` after a green `bun run build`: `bunx wrangler deploy`. Worker `paykernel-docs`. Do not create custom domains. After deploy, put the live URL in root README Documentation and in Nimbus `site` if it differs.
