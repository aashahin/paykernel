# Monorepo developer guide

This repository is a **Bun workspaces** monorepo. The publishable SDK lives under `packages/core` and keeps the npm name `@paykernel/core`. The portable webhook inbox engine is `@paykernel/webhooks` under `packages/webhooks`. The portable reconciliation domain package is `@paykernel/reconciliation` under `packages/reconciliation` (Phase 19: safe lookup, machine-readable drift, decision-only policy, store-backed scheduling — **no** mandatory queue). The portable observability package is `@paykernel/opentelemetry` under `packages/observability` (Phase 20: portable `PaymentMetrics`, optional span instrumentation, redacting telemetry glue, optional OTEL bridge — **no** hard OTEL dep in core). The portable routing package is `@paykernel/routing` under `packages/routing` (Phase 21: deterministic select-only gateway choice, money-safe amount ranges, restricted post-attempt fallback eligibility — **no** auto multi-gateway retry after indeterminate). The portable test kit is `@paykernel/testkit` under `packages/testkit`. The Phase 12 PostgreSQL adapter is `@paykernel/store-postgres` under `packages/store-postgres`. The Phase 13 Redis/Valkey/Upstash adapter is `@paykernel/store-redis` under `packages/store-redis` (**optional** — Redis is never required to use the SDK). The Phase 14 local SQLite adapter is `@paykernel/store-sqlite` under `packages/store-sqlite` (**single-host only** — never multi-host for a local file). The Phase 15 Turso / libSQL adapter is `@paykernel/store-turso` under `packages/store-turso` (**multi-host remote** shared SQLite-compatible — not local single-host SQLite; **no** `/sync` export). The Phase 16 Cloudflare D1 adapter is `@paykernel/store-d1` under `packages/store-d1` (**multi-host** shared D1 via Workers binding — **not** local SQLite, **not** Turso, **not** Durable Objects). The Phase 17 Cloudflare Durable Objects adapter is `@paykernel/store-durable-objects` under `packages/store-durable-objects` (**multi-host partitioned** SQLite-backed DO — **not** shared D1, **not** local SQLite, **not** Turso; never one global DO). Shared relational foundation is publishable `@paykernel/sql-foundation` under `packages/sql-foundation` (Phase 11). Slim production contracts live in `@paykernel/store-contracts`. `internal/sql-store` remains a private thin re-export of sql-foundation (never published).

## Layout

```
paykernel/                         # private workspace root (not published)
├── packages/
│   ├── core/                         # @paykernel/core (publishable)
│   │   ├── src/
│   │   ├── dist/
│   │   ├── docs/
│   │   ├── package.json
│   │   └── README.md
│   ├── webhooks/                     # @paykernel/webhooks (portable; publishable)
│   │   ├── src/
│   │   ├── dist/
│   │   ├── docs/                     # webhook-inbox.md, crash-boundaries.md
│   │   ├── package.json
│   │   └── README.md
│   ├── reconciliation/               # @paykernel/reconciliation (Phase 19; portable; publishable)
│   │   ├── src/
│   │   ├── dist/
│   │   ├── docs/                     # overview, reconciliation, safe-lookup, scheduling, batch, crash-boundaries
│   │   ├── package.json
│   │   └── README.md
│   ├── observability/                # @paykernel/opentelemetry (Phase 20; portable; publishable)
│   │   ├── src/                      # metrics, spans, otel bridge, instrumentation, redaction re-exports
│   │   ├── dist/
│   │   ├── docs/                     # overview, operation-context, metrics, redaction, opentelemetry, instrumentation
│   │   ├── package.json              # paymentsSdk.portable: true; optional peer @opentelemetry/api
│   │   └── README.md
│   ├── routing/                      # @paykernel/routing (Phase 21; portable; publishable)
│   ├── integration-http/             # @paykernel/integration-http (Phase 24; portable; publishable)
│   ├── integration-hono/             # @paykernel/integration-hono (Phase 24; portable; publishable)
│   ├── integration-elysia/           # @paykernel/integration-elysia (Phase 24; portable; publishable)
│   ├── integration-express/          # @paykernel/integration-express (Phase 24; node-only; publishable)
│   ├── integration-cloudflare-workers/ # @paykernel/integration-cloudflare-workers (Phase 24; portable; publishable)
│   ├── gateway-tap/                  # @paykernel/gateway-tap (Phase 23; portable Tap adapter; not a built-in)
│   │   ├── src/                      # router, route builder, matchers, safe fallback eligibility
│   │   ├── dist/
│   │   ├── docs/                     # overview, routing-inputs, selection, safe-fallback, telemetry
│   │   ├── package.json              # paymentsSdk.portable: true; depends on core only
│   │   └── README.md
│   ├── gateway-hesabe/              # @paykernel/gateway-hesabe (portable KWD adapter; not a built-in)
│   ├── gateway-myfatoorah/           # @paykernel/gateway-myfatoorah (Phase 23; portable MyFatoorah adapter; not a built-in)
│   │   ├── src/                      # gateway, types, money, idempotency, docs
│   │   ├── dist/
│   │   ├── docs/                     # overview, charges, refunds, webhooks, ...
│   │   ├── package.json              # paymentsSdk.portable: true; depends on core only
│   │   └── README.md
│   ├── store-contracts/              # @paykernel/store-contracts (portable; publishable)
│   │   ├── src/                      # lease-aware contracts + StoreError + manifests
│   │   ├── dist/
│   │   ├── package.json              # zero runtime workspace deps
│   │   └── README.md
│   ├── testkit/                      # @paykernel/testkit (portable; publishable)
│   │   ├── src/
│   │   ├── dist/
│   │   ├── docs/                     # store-contracts.md (Phase 9; re-exports store-contracts)
│   │   ├── package.json
│   │   └── README.md
│   ├── sql-foundation/               # @paykernel/sql-foundation (publishable relational foundation)
│   │   ├── src/                      # schemas, codecs, migrations, claims
│   │   ├── dist/
│   │   ├── docs/
│   │   ├── package.json
│   │   └── README.md
│   ├── store-postgres/               # @paykernel/store-postgres (Phase 12; publishable)
│   │   ├── src/                      # stores, migrate, drivers (subpaths), tests
│   │   ├── dist/
│   │   ├── docs/                     # overview, drivers, migrations, crash-boundaries, …
│   │   ├── package.json
│   │   └── README.md
│   ├── store-redis/                  # @paykernel/store-redis (Phase 13; optional; publishable)
│   │   ├── src/                      # port, Lua scripts, stores, drivers (subpaths), tests
│   │   ├── dist/
│   │   ├── docs/                     # overview, drivers, persistence, hybrid-examples, …
│   │   ├── package.json
│   │   └── README.md
│   ├── store-sqlite/                 # @paykernel/store-sqlite (Phase 14; single-host; publishable)
│   │   ├── src/                      # stores, migrate, pragmas, drivers (/bun|/node|/better-sqlite3)
│   │   ├── dist/
│   │   ├── docs/                     # overview, claims, drivers, deployment-limits, …
│   │   ├── package.json
│   │   └── README.md
│   ├── store-turso/                  # @paykernel/store-turso (Phase 15; multi-host remote; publishable)
│   │   ├── src/                      # stores, migrate, drivers (/serverless|/libsql), tests
│   │   ├── dist/
│   │   ├── docs/                     # overview, drivers, claims, crash-boundaries, …
│   │   ├── package.json
│   │   └── README.md
│   ├── store-d1/                     # @paykernel/store-d1 (Phase 16; multi-host D1; publishable)
│   │   ├── src/                      # stores, migrate, executor, sessions, mock D1 tests
│   │   ├── dist/
│   │   ├── docs/                     # overview, binding, claims, sessions-and-replication, …
│   │   ├── examples/                 # wrangler.toml
│   │   ├── migrations/               # D1-compatible SQL (no BEGIN/COMMIT)
│   │   ├── package.json              # paymentsSdk.runtime: cloudflare-only
│   │   └── README.md
│   └── store-durable-objects/        # @paykernel/store-durable-objects (Phase 17; partitioned SQLite DO; publishable)
│       ├── src/                      # stores, client, sharding, object, mock DO tests
│       ├── dist/
│       ├── docs/                     # overview, sharding, claims, transactions, alarms, limits, …
│       ├── examples/                 # wrangler.toml (new_sqlite_classes)
│       ├── package.json              # paymentsSdk.runtime: cloudflare-only
│       └── README.md
├── examples/                         # private consumer apps (not published)
│   ├── checkout-kernel/              # @paykernel/example-checkout-kernel (shared composition)
│   ├── bun-hono-sqlite/              # thin Hono fetch host (via integration-hono)
│   ├── bun-hono-postgres/            # RC Postgres host (store-postgres/pg, describe.skipIf)
│   ├── bun-elysia-sqlite/            # thin Elysia fetch host (via integration-elysia)
│   ├── express-sqlite/               # thin Express host (via integration-express, ephemeral loopback listen(0) — no fixed port)
│   └── cloudflare-workers-fetch/     # thin Workers fetch host (via integration-cloudflare-workers, production D1/DO via createCheckoutKernel({ stores | storeFactory | executor }))
├── docs/
│   ├── monorepo.md                   # this guide
│   ├── workspace-boundaries.md       # package boundary policy + gate
│   ├── releases.md                   # changesets / publish / provenance
│   ├── adapter-selection.md          # Phase 18 capability matrix + decision tree + defaults
│   └── adapter-capability-matrix.json # Phase 18 machine-readable matrix (TS twin in testkit)
├── scripts/                          # baseline, pack, smoke, boundaries, honesty cross-check
├── package.json                      # private root + workspaces ["packages/*","internal/*","examples/*"]
├── tsconfig.base.json                # shared TypeScript options
├── eslint.config.js                  # shared ESLint flat config
├── .prettierrc                       # shared Prettier options
├── bunfig.toml
├── bun.lock
└── roadmap.md
```

Root workspaces: `["packages/*", "internal/*", "examples/*"]`. `examples/*` are private consumer apps (not published); the boundary checker does not scan them. Production adapters live under `packages/store-*` (Phase 12: `store-postgres`; Phase 13: `store-redis` — **optional**; Phase 14: `store-sqlite` — **single-host only**; Phase 15: `store-turso` — **multi-host remote** Turso/libSQL; Phase 16: `store-d1` — **multi-host** Workers D1 binding; Phase 17: `store-durable-objects` — **multi-host partitioned** SQLite-backed Durable Objects). Domain packages: `webhooks` (Phase 10), `reconciliation` (Phase 19), `observability` (Phase 20), and `routing` (Phase 21) — all portable; webhooks/reconciliation/observability/routing depend on **core only** among workspace packages (storage / OTEL injected at the app layer; routing never depends on observability). Further adapters and plugins land later without changing the core consumer import path. `@paykernel/sql-foundation` is the shared foundation for **relational** adapters only — Redis adapter must **not** depend on it. Adapters depend on `@paykernel/store-contracts` at runtime (not full testkit).

**Redis is optional infrastructure.** PostgreSQL alone can satisfy Phase 9 store contracts. Do not introduce Redis solely because this monorepo ships an adapter.

### Naming and dual-ownership honesty

| Topic | Detail |
| --- | --- |
| **Observability package name** | Folder `packages/observability` publishes as **`@paykernel/opentelemetry`**. Install/import `@paykernel/opentelemetry`, not a folder-shaped name. |
| **SQL foundation package name** | Public **`@paykernel/sql-foundation`**. Private `@paykernel/internal-sql-store` is a thin re-export of the same surface (never publish). |
| **Store interface dual ownership** | `WebhookInboxStore` and `ReconciliationStore` appear in domain packages (`@paykernel/webhooks`, `@paykernel/reconciliation`), in slim **`@paykernel/store-contracts`**, and via testkit re-exports. Assignability is CI-frozen. Domain packages also keep **non-exported** memory stores for package tests that can drift from testkit — production apps use `@paykernel/store-*` adapters. |
| **IdempotencyStore name collision** | Core may expose a simpler/legacy `IdempotencyStore` shape for gateway-side keys; lease-aware Phase 9/store-contracts `IdempotencyStore` is the durable multi-host contract. Do not conflate them. |

**SQLite is single-host.** Local file SQLite (`store-sqlite`) must never be advertised as multi-host or multi-region coordination. For multi-host SQL, use PostgreSQL, **Turso remote** (`store-turso`), **Cloudflare D1** (`store-d1`), or **partitioned Durable Objects** (`store-durable-objects`) — do not conflate those with local SQLite.

**Turso is multi-host remote.** Shared remote Turso / libSQL only for production multi-host claims. Subpaths: `/serverless`, `/libsql` only — **no** `/sync`; do not advertise untested embedded-replica local-first.

**D1 is multi-host Workers-native.** Shared Cloudflare D1 via Workers binding (`store-d1`). **Not** local SQLite, **not** Turso/libSQL clients, **not** Durable Objects. Marked `paymentsSdk.runtime: "cloudflare-only"`. Normal operation needs the binding only — no REST/account token.

**Durable Objects are multi-host partitioned.** SQLite-backed DO via Workers binding + deterministic sharding (`store-durable-objects`). Strong coordination is **per partition** (per DO instance) — never a silent global DO. **Not** shared D1, **not** local SQLite, **not** Turso. Separate package from D1; no generic `adapter-cloudflare` umbrella. Marked `paymentsSdk.runtime: "cloudflare-only"`. Requires Wrangler `new_sqlite_classes`.

## Choosing a storage adapter (Phase 18)

**Start here when picking production storage:** [`docs/adapter-selection.md`](./adapter-selection.md).

That guide is the single consumer-facing selection home. It includes:

- Honesty preamble (Redis optional; local SQLite single-host; D1 ≠ DO ≠ Turso ≠ local SQLite; memory NON-PRODUCTION; no multi-region without tests)
- Capability matrix aligned to each package’s `StorageAdapterManifest` + conformance (not marketing)
- Mermaid + Q&A decision tree
- Recommended defaults
- Deep links to each adapter’s overview / guarantees / crash-boundaries and [store-contracts §7](../packages/store-contracts/docs/contracts.md)

**Quick reaffirmations** (same rules as the banners above):

| Topic | Honest rule |
| ----- | ----------- |
| Redis | **Optional** — never required to use the SDK |
| Local SQLite | **Single-host only** — never multi-host for a local file |
| Turso | **Multi-host remote** — not local SQLite; no `/sync` |
| D1 vs DO | **Separate packages** — shared D1 ≠ partitioned Durable Objects |
| Multi-region | **Not claimed** by any published adapter manifest |

**Money model (Phase 5):** prefer `money("10.50", "SAR")` from `@paykernel/core`. Testkit mock conversion uses the same shared helpers — see [`packages/core/docs/money.md`](../packages/core/docs/money.md).

**Operation outcomes (Phase 6):** prefer `isPaidOutcome(result)` / `outcome` over `success` for fulfillment. Full guide: [`packages/core/docs/operation-results.md`](../packages/core/docs/operation-results.md). The testkit mock dual-writes `outcome` + `references` so app tests learn the Phase 6 shape.

**Safe routing (Phase 21):** prefer `createPaymentRouter` + pure `select` from `@paykernel/routing`, then pass `decision.gateway` into `createPayment` / `OperationContext.gateway`. Select-time `fallback` is **not** post-attempt recovery. Never auto-route after indeterminate / timeout / connection reset / uncertain 5xx. Full guide: [`packages/routing/docs/overview.md`](../packages/routing/docs/overview.md), [`safe-fallback.md`](../packages/routing/docs/safe-fallback.md).

## Install

From the repository root:

```bash
bun install
```

## Common commands (root)

Root scripts forward into workspace packages so Phase 0 command names stay stable:

| Command                            | Purpose                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `bun run build`                    | Build core → webhooks → reconciliation → observability → routing → gateway-tap → gateway-myfatoorah → gateway-hesabe → integration-http → integration-hono/elysia/express/cloudflare-workers → store-contracts → testkit → sql-foundation → internal-sql-store → store-postgres → store-redis → store-sqlite → store-turso → store-d1 → store-durable-objects |
| `bun test`                         | Run core + store-contracts + testkit + webhooks + reconciliation + observability + routing + sql-foundation + internal-sql-store + store-* adapters + `examples` |
| `bun run test:examples`            | Example apps only (`bun test examples`)                                                      |
| `bun run test:coverage`            | Core tests with coverage thresholds (`bunfig.toml`; core-focused)                            |
| `bun run test:testkit`             | Testkit tests only                                                                           |
| `bun run test:sql-store`           | Private sql-store tests only                                                                 |
| `bun run test:observability`       | Observability package tests only (metrics / redacting telemetry / optional OTEL bridge)      |
| `bun run test:routing`             | Routing package tests only (select / match / safe fallback eligibility)                      |
| `bun run test:adapter-postgres`    | PostgreSQL adapter tests (live PG suites skip unless URL set)                                |
| `bun run test:adapter-redis`       | Redis adapter tests (live Redis suites skip unless URL set)                                  |
| `bun run test:adapter-sqlite`      | SQLite adapter tests (Bun default; node/better-sqlite3 skip-clean when unavailable)          |
| `bun run test:adapter-turso`       | Turso adapter tests (file: libsql CI; live remote skip unless TURSO_*/LIBSQL_* set)          |
| `bun run test:adapter-cloudflare-d1` | D1 adapter tests (mock D1 CI; live/miniflare skip unless harness env set)                  |
| `bun run test:adapter-cloudflare-do` | DO adapter tests (mock DO SQL CI; live/miniflare skip unless harness env set)              |
| `bun run typecheck`                | `tsc --noEmit` for core, webhooks, reconciliation, observability, routing, testkit, sql-store, postgres, redis, sqlite, turso, D1, DO adapters, and `examples/*` |
| `bun run typecheck:types`          | Public API type tests (core)                                                                 |
| `bun run typecheck:all`            | Both typecheck gates                                                                         |
| `bun run format`                   | Prettier write                                                                               |
| `bun run format:check`             | Prettier check (no write)                                                                    |
| `bun run lint`                     | ESLint over `packages/*/src`, `internal/*/src`, and `examples/*/src`                         |
| `bun run check:boundaries`         | Workspace dependency / import boundary gate                                                  |
| `bun run pack:check`               | Dry-run npm pack of core                                                                     |
| `bun run publint` / `bun run attw` | Package surface validation (core)                                                            |
| `bun run validate:package`         | Full package gate (typecheck/test/build/pack/smoke)                                          |
| `bun run baseline`                 | Regenerate Phase 0 API + package baselines                                                   |
| `bun run changeset`                | Record a Changeset for the next release                                                      |

**Build order:** `core` first (no internal workspace deps), then `webhooks` (depends on core), then `reconciliation` (depends on core only), then `observability` (depends on core only; optional peer `@opentelemetry/api`), then `routing` (depends on core only), then `gateway-tap` / `gateway-myfatoorah` / `gateway-hesabe` (each depends on core only), then `integration-http` (core + webhooks), then `integration-hono`/`integration-elysia`/`integration-express`/`integration-cloudflare-workers` (each depends on integration-http only), then `store-contracts` (zero workspace deps), then `testkit` (core + webhooks + reconciliation + store-contracts; re-exports contracts for BC), then `sql-foundation` (publishable relational foundation), then `internal/sql-store` (private thin re-export), then `store-postgres` / `store-sqlite` / `store-turso` / `store-d1` …

Package-local work:

```bash
cd packages/core
bun run build
bun test

cd packages/webhooks
bun run build
bun test

cd packages/reconciliation
bun run build
bun test

cd packages/observability
bun run build
bun test

cd packages/routing
bun run build
bun test

cd packages/testkit
bun run build
bun test

cd internal/sql-store
bun run build
bun test

cd packages/store-postgres
bun run build
bun test
# live PG: export PAYMENTS_SDK_PG_URL=postgres://… then bun test

cd packages/store-redis
bun run build
bun test
# live Redis: export PAYMENTS_SDK_REDIS_URL=redis://… then bun test

cd packages/store-sqlite
bun run build
bun test

cd packages/store-turso
bun run build
bun test
# live Turso: export TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… then bun test

cd packages/store-d1
bun run build
bun test
# default: mock D1; live/miniflare only when harness env marks binding available

cd packages/store-durable-objects
bun run build
bun test
# default: mock DO SQL; live/miniflare only when harness env marks DO available

cd examples/checkout-kernel
bun test
# in-memory Bun SQLite after migrateSqliteAdapter — single-host, not multi-host
```

## Shared TypeScript

- Root: `tsconfig.base.json` (strict shared options; `exactOptionalPropertyTypes: true`).
- Packages extend it (e.g. `packages/core/tsconfig.json`).
- Root `tsconfig.json` is a solution-style shell with project references.

## Formatting & lint

- **Prettier** (`.prettierrc`): `semi: true`, double quotes (majority of current core imports), `trailingComma: all`, `printWidth: 100`.
- **ESLint** (`eslint.config.js`): flat config with `@eslint/js` recommended + `typescript-eslint` recommended, scoped to `packages/*/src/**/*.ts`, `internal/*/src/**/*.ts`, and `examples/*/src/**/*.ts`. Rules are tuned so existing core code stays clean without mass rewrites.
- `.prettierignore` excludes build artifacts, lockfiles, `resources/`, Changeset markdown, and **pre-Phase-1** trees (`packages/core/src`, `packages/core/docs`, legacy baseline scripts) so `format:check` stays green without a mass style rewrite.

```bash
bun run format:check
bun run lint
```

Do not mass-reformat gateway/business source unless intentionally adopting a style change. To include core sources under Prettier later, remove those ignore entries and run `bun run format` (expect a large diff).

## Package boundaries

Policy and enforcement live in:

- [`docs/workspace-boundaries.md`](./workspace-boundaries.md) — living rules (roadmap §5.1)
- `scripts/check-workspace-boundaries.ts` — automated gate

```bash
bun run check:boundaries
```

Summary:

- **Core must not import adapter packages** (including `store-postgres`, `store-redis`, `store-sqlite`, `store-turso`, `store-d1`, and `store-durable-objects`), `webhooks`, `reconciliation`, `observability`, `routing`, `testkit`, `@paykernel/sql-foundation` (or private internal re-export), or any `@opentelemetry/*` package.
- **Webhooks must not depend on adapters or `@paykernel/sql-foundation` (or private internal re-export)** (storage is injected at the app/adapter layer). Webhooks must not depend on Redis clients, testkit, reconciliation, observability, or routing.
- **Reconciliation must not depend on adapters, testkit, webhooks, observability, routing, Redis clients, or `@paykernel/sql-foundation` (or private internal re-export)** (storage is injected; depends on core only). Portable (`paymentsSdk.portable: true`).
- **Observability must not depend on adapters, testkit, webhooks, reconciliation, routing, Redis clients, or `@paykernel/sql-foundation` (or private internal re-export)** (depends on core only; optional peer `@opentelemetry/api` for the OTEL bridge). Portable (`paymentsSdk.portable: true`). Core must never depend on observability or OTEL.
- **Routing must not depend on adapters, testkit, webhooks, reconciliation, observability, Redis clients, or `@paykernel/sql-foundation` (or private internal re-export)** (depends on core only; select-only — never mutates payments). Portable (`paymentsSdk.portable: true`). Core must never depend on routing.
- **Internal packages** under `internal/*` must be `"private": true` and are never published (e.g. `@paykernel/internal-sql-store`).
- **Example apps** under `examples/*` are private consumer apps. The boundary checker does not scan them. They may depend on `hono` / `elysia` / `store-sqlite` / `testkit`. `packages/*` must never import them.
- **store-postgres** may depend on store-contracts + sql-foundation (testkit in devDependencies only); optional drivers only on subpaths.
- **store-redis** may depend on store-contracts at runtime (testkit in devDependencies only); **must not** depend on sql-store, core, or webhooks; optional Redis drivers only on subpaths; root entry imports no drivers.
- **store-sqlite** may depend on store-contracts + sql-foundation (testkit in devDependencies only); root entry must **not** import `bun:sqlite` / `node:sqlite` / `better-sqlite3` (drivers only on `/bun`, `/node`, `/better-sqlite3`); **single-host** only (honest manifest); must not be depended on by core/webhooks/postgres/redis/turso/d1/do.
- **store-turso** may depend on store-contracts + sql-foundation (testkit in devDependencies only); root entry must **not** import `@tursodatabase/serverless` / `@libsql/client` (drivers only on `/serverless`, `/libsql`); **multi-host remote** honesty; **no** `/sync`; must not be depended on by core/webhooks/postgres/redis/sqlite/d1/do.
- **store-d1** may depend on store-contracts + sql-foundation (testkit in devDependencies only); root entry must **not** static-import `cloudflare:workers` (structural D1 types); **multi-host** shared D1 honesty; `paymentsSdk.runtime: "cloudflare-only"`; must not be depended on by core/webhooks/testkit/postgres/redis/sqlite/turso/do; must not leak Workers protocol imports into portable packages.
- **store-durable-objects** may depend on store-contracts + sql-foundation (testkit in devDependencies only); root entry must **not** static-import `cloudflare:workers` (structural DO/SqlStorage types); **multi-host partitioned** DO honesty (never silent global DO); `paymentsSdk.runtime: "cloudflare-only"`; must not be depended on by core/webhooks/testkit/postgres/redis/sqlite/turso/d1; separate package from D1 (no generic `adapter-cloudflare`).
- Portable packages must not accidentally pull Node-only modules outside an explicit allowlist.
- Adapter package roots must not import optional peer drivers.
- Circular package dependencies are forbidden.
- **Redis remains optional** — PostgreSQL (or Turso remote, or D1/DO on Workers) can satisfy contracts without Redis.
- **SQLite remains single-host** — never multi-host for a local file.
- **Turso is multi-host remote** — never advertise untested `/sync` or embedded-replica local-first.
- **D1 is multi-host Workers-native** — never conflate with local SQLite, Turso, or Durable Objects.
- **DO is multi-host partitioned** — never conflate with D1, local SQLite, or Turso; never default one global DO.

## Versioning & releases

See [`docs/releases.md`](./releases.md) for Changesets, prerelease channels, and npm provenance.

```bash
bun run changeset          # record a change
bun run version-packages   # bump versions + changelogs
bun run release            # publish (CI; OIDC provenance)
```

The monorepo root package is **private** and must never be published. Publishable packages include `@paykernel/core`, `@paykernel/webhooks`, `@paykernel/reconciliation`, `@paykernel/opentelemetry`, `@paykernel/routing`, `@paykernel/store-contracts`, `@paykernel/sql-foundation`, `@paykernel/testkit`, `@paykernel/store-postgres`, `@paykernel/store-redis`, `@paykernel/store-sqlite`, `@paykernel/store-turso`, `@paykernel/store-d1`, and `@paykernel/store-durable-objects` (adapters may version and publish **separately** from core). **Never** publish packages under `internal/*` or `examples/*`. Relational adapters depend on publishable `@paykernel/sql-foundation` + `@paykernel/store-contracts` at runtime (not private internal-sql-store, not full testkit). Redis depends only on `@paykernel/store-contracts` among workspace runtime deps (testkit is devDependency for conformance).

## Consumer import (unchanged for core)

```bash
bun add @paykernel/core
```

```typescript
import { PaymentClient } from "@paykernel/core";
```

Webhook inbox engine (optional domain package; depends only on core):

```bash
bun add @paykernel/webhooks
```

```typescript
import { createWebhookInboxEngine } from "@paykernel/webhooks";
```

Reconciliation primitives (optional domain package; depends only on core; no mandatory queue):

```bash
bun add @paykernel/reconciliation
```

```typescript
import {
  createPaymentReconciler,
  createReconciliationScheduler,
  type ReconciliationStore,
} from "@paykernel/reconciliation";
```

Observability helpers (optional; depends only on core; optional peer `@opentelemetry/api` for the bridge):

```bash
bun add @paykernel/opentelemetry
# optional OTEL bridge only (not required for metrics / redacting telemetry):
# bun add @opentelemetry/api
```

```typescript
import {
  createInMemoryPaymentMetrics,
  createRedactingTelemetrySink,
  createOperationContext,
  withPaymentOperation,
  createOpenTelemetryBridge,
} from "@paykernel/opentelemetry";
// App injects redacting TelemetrySink / metrics / tracer — core never imports this package.
// createOpenTelemetryBridge needs an injected @opentelemetry/api (optional peer).
```

Core still exports `OperationContext` builders and `createRedactingTelemetrySink` without this package. Guides: [`packages/observability/README.md`](../packages/observability/README.md), [`packages/core/docs/telemetry.md`](../packages/core/docs/telemetry.md).

Safe routing policies (optional; depends only on core; **select-only** — app passes `decision.gateway` into `createPayment`):

```bash
bun add @paykernel/routing
```

```typescript
import {
  createPaymentRouter,
  route,
  evaluateFallback,
  isSafeFallbackEligible,
} from "@paykernel/routing";
import { PaymentClient } from "@paykernel/core";

// const client = new PaymentClient({ /* gateways, defaultGateway, … */ });
const router = createPaymentRouter({
  rules: [route({ currency: "SAR" }).to("moyasar")],
  fallback: "stripe", // select-time only — not post-attempt recovery
});
const decision = router.select({ currency: "SAR", amount: "10.00" });
// App-owned execution — router never calls createPayment:
// await client.createPayment(params, decision.gateway);
```

Guides: [`packages/routing/README.md`](../packages/routing/README.md), [`overview.md`](../packages/routing/docs/overview.md), [`safe-fallback.md`](../packages/routing/docs/safe-fallback.md).

Dev/test dependency for conformance and mocks (does not change core imports):

```bash
bun add -d @paykernel/testkit
```

```typescript
import {
  mockGateway,
  runGatewayConformanceSuite,
  sanitizeFixture,
  createMemoryWebhookInboxStore,
} from "@paykernel/testkit";
```

PostgreSQL durable stores (app-layer injection; core/webhooks do not import this):

```bash
bun add @paykernel/store-postgres
bun add pg   # or postgres
```

```typescript
import {
  createPostgresStoresFromPg,
  migratePostgresAdapter,
} from "@paykernel/store-postgres/pg";
```

Redis / Valkey coordination stores (**optional**; core/webhooks do not import this):

```bash
bun add @paykernel/store-redis
bun add ioredis   # or redis / @upstash/redis; Bun uses /bun with no npm peer
```

```typescript
import { createRedisStoresFromIoredis } from "@paykernel/store-redis/ioredis";
// or root: createRedisStores({ port }) with a RedisCommandPort
```

SQLite single-host stores (app-layer injection; core/webhooks do not import this):

```bash
bun add @paykernel/store-sqlite
# optional Node peer:
bun add better-sqlite3
```

```typescript
import {
  createBunSqliteStores,
  migrateSqliteAdapter,
  applyRecommendedPragmas,
} from "@paykernel/store-sqlite/bun";
// root entry has no drivers — use /bun, /node, or /better-sqlite3
```

Turso multi-host remote stores (app-layer injection; core/webhooks do not import this):

```bash
bun add @paykernel/store-turso
bun add @libsql/client
# or
bun add @tursodatabase/serverless
```

```typescript
import {
  createTursoStoresFromLibsql,
  migrateTursoAdapter,
} from "@paykernel/store-turso/libsql";
// root entry has no drivers — use /libsql or /serverless (no /sync)
```

Cloudflare D1 multi-host stores (Workers binding; core/webhooks do not import this):

```bash
bun add @paykernel/store-d1
# optional DX:
bun add -d @cloudflare/workers-types
```

```typescript
import {
  createD1PaymentStores,
  migrateD1Adapter,
} from "@paykernel/store-d1";

// await migrateD1Adapter(env.PAYMENTS_DB); // explicit ops/CI only
const stores = createD1PaymentStores({ db: env.PAYMENTS_DB });
```

Cloudflare Durable Object multi-host **partitioned** stores (Workers DO binding; core/webhooks do not import this):

```bash
bun add @paykernel/store-durable-objects
# optional DX:
bun add -d @cloudflare/workers-types
```

```typescript
import {
  createDoPaymentStores,
  migrateDoAdapter,
} from "@paykernel/store-durable-objects";

// Explicit sharding required — NEVER a silent global Durable Object.
const stores = createDoPaymentStores({
  namespace: env.PAYMENTS_DO,
  sharding: { kind: "hash", partitions: 32 },
});
// Schema: ensure/migrate inside DO lifecycle or ops — never on import / default factory.
```

**Boundaries:**

- **Core** must never depend on webhooks, reconciliation, observability, routing, testkit, adapters, `@paykernel/sql-foundation` (or private internal re-export), or `@opentelemetry/*`.
- **Webhooks** depends on core only (`workspace:*`). Must not depend on testkit, reconciliation, observability, routing, adapters, Redis, or `@paykernel/sql-foundation` (or private internal re-export).
- **Reconciliation** depends on core only (`workspace:*`). Must not depend on testkit, webhooks, observability, routing, adapters, Redis, or `@paykernel/sql-foundation` (or private internal re-export). Dual-owns a structurally compatible `ReconciliationStore` with testkit (no recon→testkit import).
- **Observability** depends on core only (`workspace:*`). Optional peer `@opentelemetry/api` (never a hard dep in core). Must not depend on testkit, webhooks, reconciliation, routing, adapters, Redis, or `@paykernel/sql-foundation` (or private internal re-export). Root import works without OTEL installed.
- **Routing** depends on core only (`workspace:*`). Select-only (never mutates payments). Must not depend on testkit, webhooks, reconciliation, observability, adapters, Redis, or `@paykernel/sql-foundation` (or private internal re-export). App composes `decision.gateway` into `PaymentClient`.
- **Testkit** depends on core and may depend on webhooks and reconciliation (engine/domain integration / structural assignability proofs). Does not require sql-store for Phase 9 contracts.
- **`@paykernel/sql-foundation`** is the **publishable** shared relational foundation for adapters (Phase 11+). Must not depend on core or the webhooks/reconciliation engines. **`@paykernel/internal-sql-store`** (`internal/sql-store`) is a private thin re-export only — never published; production adapters depend on `@paykernel/sql-foundation` at runtime.
- **`store-postgres`** runtime deps: store-contracts + sql-foundation (testkit dev-only); must not be depended on by core/webhooks; must not depend on other store adapters.
- **`store-redis`** runtime deps: store-contracts only (testkit dev-only); must not depend on sql-foundation, core, webhooks, or other store adapters; must not be depended on by core/webhooks.
- **`store-sqlite`** runtime deps: store-contracts + sql-foundation (testkit dev-only); single-host only; root imports no SQLite drivers.
- **`store-turso`** runtime deps: store-contracts + sql-foundation (testkit dev-only); multi-host remote only; root imports no Turso/libsql drivers; no untested `/sync`.
- **`store-d1`** runtime deps: store-contracts + sql-foundation (testkit dev-only); multi-host shared D1; root has no static `cloudflare:workers` import.
- **`store-durable-objects`** runtime deps: store-contracts + sql-foundation (testkit dev-only); multi-host partitioned DO only; never one global DO; root has no static `cloudflare:workers` import.

## Related docs

- **Docs home / getting started:** [`docs/README.md`](./README.md) · [`docs/getting-started.md`](./getting-started.md)
- **Examples (private consumer apps):** [`examples/README.md`](../examples/README.md)
- **Adapter selection (Phase 18):** [`docs/adapter-selection.md`](./adapter-selection.md) — capability matrix, decision tree, recommended defaults
- Workspace boundaries: [`docs/workspace-boundaries.md`](./workspace-boundaries.md)
- Releases / Changesets: [`docs/releases.md`](./releases.md)
- Package README: [`packages/core/README.md`](../packages/core/README.md)
- Webhooks README: [`packages/webhooks/README.md`](../packages/webhooks/README.md)
- Webhook inbox engine (full): [`packages/webhooks/docs/webhook-inbox.md`](../packages/webhooks/docs/webhook-inbox.md)
- Crash boundaries (10.6): [`packages/webhooks/docs/crash-boundaries.md`](../packages/webhooks/docs/crash-boundaries.md)
- Inbox cheat sheet: [`packages/webhooks/docs/inbox-engine.md`](../packages/webhooks/docs/inbox-engine.md)
- Reconciliation README: [`packages/reconciliation/README.md`](../packages/reconciliation/README.md)
- Reconciliation overview (19): [`packages/reconciliation/docs/overview.md`](../packages/reconciliation/docs/overview.md)
- Reconciliation types/policy: [`packages/reconciliation/docs/reconciliation.md`](../packages/reconciliation/docs/reconciliation.md)
- Safe lookup: [`packages/reconciliation/docs/safe-lookup.md`](../packages/reconciliation/docs/safe-lookup.md)
- Scheduling (no mandatory queue): [`packages/reconciliation/docs/scheduling.md`](../packages/reconciliation/docs/scheduling.md)
- Batch reconcile: [`packages/reconciliation/docs/batch.md`](../packages/reconciliation/docs/batch.md)
- Reconciliation crash boundaries (19): [`packages/reconciliation/docs/crash-boundaries.md`](../packages/reconciliation/docs/crash-boundaries.md)
- Observability README (20): [`packages/observability/README.md`](../packages/observability/README.md)
- Observability overview: [`packages/observability/docs/overview.md`](../packages/observability/docs/overview.md)
- Operation context: [`packages/observability/docs/operation-context.md`](../packages/observability/docs/operation-context.md)
- Metrics: [`packages/observability/docs/metrics.md`](../packages/observability/docs/metrics.md)
- Redaction (telemetry): [`packages/observability/docs/redaction.md`](../packages/observability/docs/redaction.md)
- Optional OTEL: [`packages/observability/docs/opentelemetry.md`](../packages/observability/docs/opentelemetry.md)
- Instrumentation: [`packages/observability/docs/instrumentation.md`](../packages/observability/docs/instrumentation.md)
- Core telemetry: [`packages/core/docs/telemetry.md`](../packages/core/docs/telemetry.md)
- Routing README (21): [`packages/routing/README.md`](../packages/routing/README.md)
- Routing overview: [`packages/routing/docs/overview.md`](../packages/routing/docs/overview.md)
- Routing inputs: [`packages/routing/docs/routing-inputs.md`](../packages/routing/docs/routing-inputs.md)
- Selection: [`packages/routing/docs/selection.md`](../packages/routing/docs/selection.md)
- Safe fallback eligibility: [`packages/routing/docs/safe-fallback.md`](../packages/routing/docs/safe-fallback.md)
- Routing telemetry: [`packages/routing/docs/telemetry.md`](../packages/routing/docs/telemetry.md)
- Matching: [`packages/routing/docs/matching.md`](../packages/routing/docs/matching.md)
- Testkit README: [`packages/testkit/README.md`](../packages/testkit/README.md)
- Phase 9 store contracts (lease-aware stores + manifests in testkit; dual-type with webhooks + reconciliation):
  [`packages/store-contracts/docs/contracts.md`](../packages/store-contracts/docs/contracts.md)
- Phase 11 SQL foundation: [`packages/sql-foundation/README.md`](../packages/sql-foundation/README.md),
  [`relational-foundation.md`](../packages/sql-foundation/docs/relational-foundation.md)
- Phase 12 PostgreSQL adapter: [`packages/store-postgres/README.md`](../packages/store-postgres/README.md),
  [`overview.md`](../packages/store-postgres/docs/overview.md)
- Phase 13 Redis adapter (optional): [`packages/store-redis/README.md`](../packages/store-redis/README.md),
  [`overview.md`](../packages/store-redis/docs/overview.md)
- Phase 14 SQLite adapter (single-host): [`packages/store-sqlite/README.md`](../packages/store-sqlite/README.md),
  [`overview.md`](../packages/store-sqlite/docs/overview.md),
  [`deployment-limits.md`](../packages/store-sqlite/docs/deployment-limits.md)
- Phase 15 Turso adapter (multi-host remote): [`packages/store-turso/README.md`](../packages/store-turso/README.md),
  [`overview.md`](../packages/store-turso/docs/overview.md),
  [`embedded-replicas.md`](../packages/store-turso/docs/embedded-replicas.md)
- Phase 16 Cloudflare D1 adapter (multi-host Workers): [`packages/store-d1/README.md`](../packages/store-d1/README.md),
  [`overview.md`](../packages/store-d1/docs/overview.md),
  [`binding.md`](../packages/store-d1/docs/binding.md),
  [`sessions-and-replication.md`](../packages/store-d1/docs/sessions-and-replication.md),
  [`limits.md`](../packages/store-d1/docs/limits.md)
- Phase 17 Cloudflare Durable Objects adapter (multi-host partitioned): [`packages/store-durable-objects/README.md`](../packages/store-durable-objects/README.md),
  [`overview.md`](../packages/store-durable-objects/docs/overview.md),
  [`sharding.md`](../packages/store-durable-objects/docs/sharding.md),
  [`transactions.md`](../packages/store-durable-objects/docs/transactions.md),
  [`limits.md`](../packages/store-durable-objects/docs/limits.md)
- Storage adapters pointer (core docs): [`packages/core/docs/storage-adapters.md`](../packages/core/docs/storage-adapters.md)
- Behavioral contracts: [`packages/core/docs/behavioral-contracts.md`](../packages/core/docs/behavioral-contracts.md)
- Phase 0 baselines: [`packages/core/docs/baseline/`](../packages/core/docs/baseline/)
- Roadmap: [`roadmap.md`](../roadmap.md)