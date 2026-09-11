# Workspace dependency boundaries

Living documentation for monorepo package boundaries. Aligns with [roadmap §5.1](../roadmap.md) and is enforced by:

```bash
bun run check:boundaries
# → bun run scripts/check-workspace-boundaries.ts
```

CI runs the same gate after install / before typecheck. Violations exit non-zero with human-readable paths.

## Expected layout

```text
paykernel/
├── packages/
│   ├── core/                 # @paykernel/core (publishable; portable)
│   ├── webhooks/             # @paykernel/webhooks (present; portable)
│   ├── reconciliation/       # @paykernel/reconciliation (Phase 19; present; portable; core-only)
│   ├── observability/        # @paykernel/opentelemetry (Phase 20; present; portable; core-only)
│   ├── routing/              # @paykernel/routing (Phase 21; present; portable; core-only; select-only)
│   ├── store-contracts/      # @paykernel/store-contracts (portable; production contracts)
│   ├── testkit/              # @paykernel/testkit (present; portable; re-exports store-contracts)
│   ├── sql-foundation/       # @paykernel/sql-foundation (publishable relational foundation)
│   ├── store-postgres/       # @paykernel/store-postgres (Phase 12; present)
│   ├── store-redis/          # @paykernel/store-redis (Phase 13; optional Redis/Valkey)
│   ├── store-sqlite/         # @paykernel/store-sqlite (Phase 14; single-host only)
│   ├── store-turso/          # @paykernel/store-turso (Phase 15; multi-host remote)
│   ├── store-d1/             # @paykernel/store-d1 (Phase 16; multi-host D1; cloudflare-only)
│   ├── store-durable-objects/# @paykernel/store-durable-objects (Phase 17; multi-host partitioned SQLite DO; cloudflare-only)
│   ├── store-*/              # further storage adapters
│   ├── gateway-tap/          # @paykernel/gateway-tap (Phase 23; portable Tap Payments adapter)
│   ├── gateway-myfatoorah/   # @paykernel/gateway-myfatoorah (Phase 23; portable MyFatoorah adapter)
│   ├── gateway-hesabe/       # @paykernel/gateway-hesabe (portable KWD Hesabe adapter)
│   ├── integration-http/     # @paykernel/integration-http (Phase 24; portable HTTP mapping)
│   ├── integration-hono/     # @paykernel/integration-hono (Phase 24; portable Hono adapter)
│   ├── integration-elysia/   # @paykernel/integration-elysia (Phase 24; portable Elysia adapter)
│   ├── integration-express/  # @paykernel/integration-express (Phase 24; node-only Express adapter)
│   └── integration-cloudflare-workers/ # @paykernel/integration-cloudflare-workers (Phase 24; portable Workers adapter)
├── internal/                 # private workspaces only (must not publish)
│   └── sql-store/            # @paykernel/internal-sql-store (thin re-export of sql-foundation)
├── examples/                 # private consumer apps (not scanned by the checker)
│   ├── checkout-kernel/      # @paykernel/example-checkout-kernel
│   ├── bun-hono-sqlite/      # thin Hono host (via integration-hono)
│   ├── bun-elysia-sqlite/    # thin Elysia host (via integration-elysia)
│   ├── express-sqlite/       # thin Express host (via integration-express, ephemeral loopback listen(0) — no fixed port)
│   └── cloudflare-workers-fetch/ # thin Workers fetch host (via integration-cloudflare-workers, production D1/DO via createCheckoutKernel({ stores | storeFactory | executor }))
├── scripts/
│   └── check-workspace-boundaries.ts
└── docs/
    ├── workspace-boundaries.md   # this file
    └── adapter-selection.md      # Phase 18 matrix + decision tree (capability honesty)
```

Root `package.json` is private (`paykernel`) and is never published. Workspaces: `["packages/*", "internal/*", "examples/*"]`. Publishable surface: `@paykernel/core`, `@paykernel/webhooks`, `@paykernel/reconciliation`, `@paykernel/opentelemetry`, `@paykernel/routing`, `@paykernel/gateway-tap`, `@paykernel/gateway-myfatoorah`, `@paykernel/gateway-hesabe`, `@paykernel/integration-http`, `@paykernel/integration-hono`, `@paykernel/integration-elysia`, `@paykernel/integration-express`, `@paykernel/integration-cloudflare-workers`, `@paykernel/store-contracts`, `@paykernel/sql-foundation`, `@paykernel/testkit`, `@paykernel/store-postgres`, `@paykernel/store-redis`, `@paykernel/store-sqlite`, `@paykernel/store-turso`, `@paykernel/store-d1`, and `@paykernel/store-durable-objects` (adapters and extra gateways may publish on their own cadence). Internal packages (e.g. `internal/sql-store`) and example apps under `examples/*` are **never** published.

**Name / ownership honesty:**

| Topic | Fact |
| --- | --- |
| Observability folder | Repo path `packages/observability` publishes as **`@paykernel/opentelemetry`** (npm name ≠ directory name). |
| Store interface dual ownership | `WebhookInboxStore` / `ReconciliationStore` are dual-owned: domain packages (`webhooks` / `reconciliation`), slim **`@paykernel/store-contracts`**, and testkit re-exports for BC + conformance. Structural assignability is frozen in tests; apps inject production adapters, not domain memory stores. |
| SQL foundation rename | Public package is **`@paykernel/sql-foundation`**. `@paykernel/internal-sql-store` is a private thin re-export only. |

**Redis is optional infrastructure.** The SDK does not require Redis. PostgreSQL, Turso remote, Cloudflare D1, or partitioned Durable Objects adapters can satisfy Phase 9 contracts. Core and webhooks never depend on Redis clients or `store-redis`.

**SQLite is single-host only.** Local file SQLite (`store-sqlite`) must never be advertised as multi-host or multi-region coordination. One database file → one durable filesystem authority. Core and webhooks never depend on `store-sqlite`. Root entry of the adapter must not import `bun:sqlite` / `node:sqlite` / `better-sqlite3`.

**Turso is multi-host remote only.** Shared remote Turso / libSQL (`store-turso`) for multi-host durable claims. Do **not** conflate with `store-sqlite`. Root entry must not import `@tursodatabase/serverless` or `@libsql/client` (drivers only on `/serverless`, `/libsql`). **No** `/sync` export; do not advertise untested embedded-replica local-first. Core and webhooks never depend on `store-turso`.

**D1 is multi-host Workers-native only.** Shared Cloudflare D1 (`store-d1`) via Workers binding for multi-host durable claims. Do **not** conflate with `store-sqlite` (local single-host), `store-turso` (libSQL clients), or Durable Objects (`store-durable-objects`). Root entry must **not** static-import `cloudflare:workers` (structural D1 types; optional peer `@cloudflare/workers-types` for DX only). Marked `paymentsSdk.runtime: "cloudflare-only"`. Normal operation uses the binding only — no REST/account token required. Core, webhooks, and testkit never depend on `store-d1`.

**Durable Objects are multi-host partitioned only.** SQLite-backed DO (`store-durable-objects`) via Workers binding + deterministic sharding (`key` | `hash` | `tenant`). Strong coordination is **per partition** — never default all payment work to one global DO. Do **not** conflate with `store-d1` (shared D1), `store-sqlite` (local single-host), or `store-turso`. Root entry must **not** static-import `cloudflare:workers` (structural DO/SqlStorage types; optional peer `@cloudflare/workers-types` for DX only). Marked `paymentsSdk.runtime: "cloudflare-only"`. Requires Wrangler `new_sqlite_classes`. No generic `packages/store-cloudflare` umbrella. Core, webhooks, and testkit never depend on `store-durable-objects`.

**Capability honesty for consumers (Phase 18):** dependency edges above do not tell you *which* adapter to pick. For the unified capability matrix, decision tree, and recommended defaults — values taken from each package’s `StorageAdapterManifest` and guarantees docs, not marketing — see [`docs/adapter-selection.md`](./adapter-selection.md). Matrix cells must not overclaim multi-region, multi-host local SQLite, mandatory Redis, or global DO coordination.

## Policy rules (roadmap §5.1)

| Rule                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core isolation            | `core` (`@paykernel/core`) must **not** depend on adapters, ORMs, framework packages, provider browser SDKs, `webhooks`, `reconciliation`, `observability`, `routing`, `testkit`, or any `@opentelemetry/*` package.                                                                                                                                                                                                                       |
| Webhooks (Phase 10)       | `@paykernel/webhooks` is **portable** (`paymentsSdk.portable: true`). Depends only on `core`. Must **not** depend on testkit, reconciliation, observability, routing, adapters, or Redis. Owns the inbox **engine**, `WebhookProcessingOutcome`, modes, and a structurally compatible `WebhookInboxStore` contract. Docs: [`webhook-inbox.md`](../packages/webhooks/docs/webhook-inbox.md), [`crash-boundaries.md`](../packages/webhooks/docs/crash-boundaries.md). |
| Reconciliation (Phase 19) | `@paykernel/reconciliation` is **portable** (`paymentsSdk.portable: true`). Depends only on `core`. Must **not** depend on testkit, webhooks, observability, routing, adapters, Redis, or DB drivers. Owns domain primitives (target/snapshots/results, safe lookup, decision-only policy, store-backed scheduler, `createPaymentReconciler`) and dual-owns a structurally compatible `ReconciliationStore`. Docs: [`overview.md`](../packages/reconciliation/docs/overview.md), [`scheduling.md`](../packages/reconciliation/docs/scheduling.md), [`crash-boundaries.md`](../packages/reconciliation/docs/crash-boundaries.md). |
| Observability (Phase 20)  | `@paykernel/opentelemetry` is **portable** (`paymentsSdk.portable: true`). Depends only on `core` among workspace packages. Optional peer `@opentelemetry/api` (never hard-required; root import works without OTEL). Must **not** depend on testkit, webhooks, reconciliation, routing, adapters, Redis, or `internal/sql-store`. **Core must never depend on observability or `@opentelemetry/*`.** App composes redacting sinks / metrics / tracers; webhooks and reconciliation stay free of a hard observability dep. Docs: [`overview.md`](../packages/observability/docs/overview.md), [`opentelemetry.md`](../packages/observability/docs/opentelemetry.md), core [`telemetry.md`](../packages/core/docs/telemetry.md). |
| Routing (Phase 21)        | `@paykernel/routing` is **portable** (`paymentsSdk.portable: true`). Depends only on `core` among workspace packages. **Select-only** — never calls `createPayment` / capture / refund. Must **not** depend on testkit, webhooks, reconciliation, observability, adapters, Redis, or `internal/sql-store`. **Core must never depend on routing.** App composes `decision.gateway` into `PaymentClient.createPayment(..., gateway)` and telemetry. Docs: [`overview.md`](../packages/routing/docs/overview.md), [`routing-inputs.md`](../packages/routing/docs/routing-inputs.md), [`selection.md`](../packages/routing/docs/selection.md), [`safe-fallback.md`](../packages/routing/docs/safe-fallback.md), [`telemetry.md`](../packages/routing/docs/telemetry.md). |
| Framework integrations (Phase 24) | `@paykernel/integration-http` is **portable** (`paymentsSdk.portable: true`). Depends only on `core` + `webhooks`. Must **not** depend on reconciliation, observability, routing, store adapters, sql-foundation, gateways, or Redis. Framework wrappers (`integration-hono`, `integration-elysia`, `integration-express`, `integration-cloudflare-workers`) are thin: depend only on `integration-http` among workspace packages (`testkit` dev-only). `integration-express` is `paymentsSdk.runtime: "node-only"` (not portable); others are portable. Must **not** depend on each other or on core/webhooks/reconciliation/observability/routing/store/gateway. **Core/webhooks/reconciliation/observability/routing/gateways must not depend on integration packages.** |
| Extra gateways (Phase 23) | `@paykernel/gateway-*` packages are **portable** when they set `paymentsSdk.portable: true` (honored by `isPortablePackage` before the gateway-name exclusion). Runtime workspace dep: **core only**. `@paykernel/testkit` is **devDependency** for conformance. Must **not** depend on webhooks, reconciliation, routing, observability, store adapters, or sql-foundation. **Core must never depend on gateway packages.** Shipped adapters: [`@paykernel/gateway-tap`](../packages/gateway-tap/README.md), [`@paykernel/gateway-myfatoorah`](../packages/gateway-myfatoorah/README.md), [`@paykernel/gateway-hesabe`](../packages/gateway-hesabe/README.md). Built-ins stay in core for 0.x. |
| Testkit                   | May depend on `core`, `webhooks`, and optionally `reconciliation` (assignability / dual-type proofs only). **Core must never depend on testkit.** Webhooks, reconciliation, observability, and routing production code must never import testkit.                                                                                                                                                                                                  |
| Store contracts (Phase 9) | Lease-aware `IdempotencyStore` / `WebhookInboxStore` / `ReconciliationStore`, error taxonomy, and adapter manifests live in publishable **`@paykernel/store-contracts`**. `@paykernel/testkit` re-exports them for BC and hosts conformance suites + NON_PRODUCTION memory factories. Phase 10 webhooks dual-owns `WebhookInboxStore`; Phase 19 reconciliation dual-owns `ReconciliationStore` (no domain→testkit import). Distinct from core 0.x `IdempotencyStore` (get/set/reserve). See [`packages/store-contracts/docs/contracts.md`](../packages/store-contracts/docs/contracts.md). |
| SQL foundation (Phase 11) | **`packages/sql-foundation`** (`@paykernel/sql-foundation`) is the **publishable** shared relational foundation: canonical tables/columns, validated namespace, codecs, versioned migrations, pure claim decisions + dialect-tagged SQL templates. **Not** a general ORM. `internal/sql-store` is a private thin re-export. Docs: [`packages/sql-foundation/docs/relational-foundation.md`](../packages/sql-foundation/docs/relational-foundation.md). |
| PostgreSQL adapter (12)   | **`packages/store-postgres`** (`@paykernel/store-postgres`) implements Phase 9 stores against PostgreSQL. **May** depend on `@paykernel/store-contracts` + `@paykernel/sql-foundation` at runtime (`@paykernel/testkit` in devDependencies only). **Must not** be depended on by core or webhooks. Root entry must **not** import optional peer drivers (`pg`, `postgres`, `drizzle-orm`, `bun:sql`, …); drivers only on isolated subpaths (`/pg`, `/postgres-js`, `/bun-sql`, `/drizzle`). Explicit migrate only. Docs: [`packages/store-postgres/docs/overview.md`](../packages/store-postgres/docs/overview.md). |
| Redis adapter (13)        | **`packages/store-redis`** (`@paykernel/store-redis`) implements Phase 9 stores against Redis/Valkey/Upstash via atomic Lua. **May** depend on `@paykernel/store-contracts` at runtime (`@paykernel/testkit` in devDependencies only). **Must not** depend on `internal/sql-store`, core, webhooks, adapter-postgres, or adapter-sqlite. **Must not** be depended on by core or webhooks. Root entry must **not** import optional drivers (`ioredis`, `redis`, `@upstash/redis`, Bun Redis); drivers only on isolated subpaths (`/bun`, `/upstash`, `/ioredis`, `/node-redis`). Redis is **optional** — never required to use the SDK. Docs: [`packages/store-redis/docs/overview.md`](../packages/store-redis/docs/overview.md). |
| SQLite adapter (14)       | **`packages/store-sqlite`** (`@paykernel/store-sqlite`) implements Phase 9 stores against local/embedded SQLite. **May** depend on `@paykernel/store-contracts` + `@paykernel/sql-foundation` at runtime (`@paykernel/testkit` in devDependencies only). **Must not** be depended on by core, webhooks, adapter-postgres, adapter-redis, or adapter-turso. Root entry must **not** import `bun:sqlite`, `node:sqlite`, or `better-sqlite3`; drivers only on isolated subpaths (`/bun`, `/node`, `/better-sqlite3`). Explicit `migrateSqliteAdapter` only — never on import or default create. Claims: `BEGIN IMMEDIATE` (or equivalent) + sql-store templates in one **sync** transaction — never unprotected get-then-set. Manifest: **`coordinationScope: "single-host"`** only (honest; never multi-host for a local file). Docs: [`packages/store-sqlite/docs/overview.md`](../packages/store-sqlite/docs/overview.md), [`deployment-limits.md`](../packages/store-sqlite/docs/deployment-limits.md). |
| Turso adapter (15)        | **`packages/store-turso`** (`@paykernel/store-turso`) implements Phase 9 stores against **shared remote** Turso / libSQL (SQLite-compatible). **May** depend on `@paykernel/store-contracts` + `@paykernel/sql-foundation` at runtime (`@paykernel/testkit` in devDependencies only). **Must not** be depended on by core, webhooks, adapter-postgres, adapter-redis, or adapter-sqlite. Root entry must **not** import `@tursodatabase/serverless` or `@libsql/client`; drivers only on isolated subpaths (`/serverless`, `/libsql`). **No** `./sync` export. Explicit `migrateTursoAdapter` only — never on import or default create. Claims: prefer single-statement UPSERT + RETURNING; multi-statement only in write txn/batch — never unprotected get-then-set. Manifest: **`coordinationScope: "multi-host"`** for shared remote primary; do **not** advertise untested embedded-replica / sync local-first. `@tursodatabase/serverless` and `@libsql/client` are **not interchangeable** — test independently. Docs: [`packages/store-turso/docs/overview.md`](../packages/store-turso/docs/overview.md), [`embedded-replicas.md`](../packages/store-turso/docs/embedded-replicas.md). |
| Cloudflare D1 adapter (16) | **`packages/store-d1`** (`@paykernel/store-d1`) implements Phase 9 stores against **shared** Cloudflare D1 via Workers binding. **May** depend on `@paykernel/store-contracts` + `@paykernel/sql-foundation` at runtime (`@paykernel/testkit` in devDependencies only). **Must not** be depended on by core, webhooks, testkit, adapter-postgres, adapter-redis, adapter-sqlite, adapter-turso, or adapter-cloudflare-do. Root entry must **not** static-import `cloudflare:workers` (structural `D1DatabaseLike` types; optional peer `@cloudflare/workers-types` for DX only). Explicit `migrateD1Adapter` only — never on import or default `createD1PaymentStores`. Claims: prefer single-statement UPSERT + RETURNING; multi-statement only via D1 `batch()` — never unprotected get-then-set. Manifest: **`coordinationScope: "multi-host"`** for shared D1; `readAfterWrite: "session"`; stale reads possible without Sessions under replication. **Not** local SQLite, **not** Turso, **not** Durable Objects. `paymentsSdk.runtime: "cloudflare-only"`. Docs: [`packages/store-d1/docs/overview.md`](../packages/store-d1/docs/overview.md), [`binding.md`](../packages/store-d1/docs/binding.md), [`limits.md`](../packages/store-d1/docs/limits.md). |
| Cloudflare DO adapter (17) | **`packages/store-durable-objects`** (`@paykernel/store-durable-objects`) implements Phase 9 stores against **SQLite-backed Durable Objects** (partitioned multi-host). **May** depend on `@paykernel/store-contracts` + `@paykernel/sql-foundation` at runtime (`@paykernel/testkit` in devDependencies only). **Must not** be depended on by core, webhooks, testkit, adapter-postgres, adapter-redis, adapter-sqlite, adapter-turso, or adapter-cloudflare-d1. Root entry must **not** static-import `cloudflare:workers` (structural `DoStorageLike` / `SqlStorageLike` types; optional peer `@cloudflare/workers-types` for DX only). Explicit `migrateDoAdapter` / `ensureDoSchema` only — never on import or default `createDoPaymentStores`. Claims: prefer single-statement UPSERT + RETURNING via sync `sql.exec`; multi-statement only via `transactionSync` (sync callback; no await external I/O) — never unprotected get-then-set. Manifest: **`coordinationScope: "multi-host"`** partitioned DO; strong claims/RAW **within a partition**; never one global DO. Wrangler **`new_sqlite_classes`** required (not legacy KV-only). **Not** shared D1, **not** local SQLite, **not** Turso. `paymentsSdk.runtime: "cloudflare-only"`. Docs: [`packages/store-durable-objects/docs/overview.md`](../packages/store-durable-objects/docs/overview.md), [`sharding.md`](../packages/store-durable-objects/docs/sharding.md), [`transactions.md`](../packages/store-durable-objects/docs/transactions.md), [`limits.md`](../packages/store-durable-objects/docs/limits.md). |
| Reconciliation            | **Present (Phase 19).** May depend only on `core`. Dual-owns `ReconciliationStore` with testkit (structural compatibility). Must not depend on testkit/adapters/Redis/DB drivers/observability. Core must not depend on reconciliation. No mandatory queue product. |
| Observability             | **Present (Phase 20).** May depend only on `core` among workspace packages. Optional peer `@opentelemetry/api` only. Must not depend on testkit/webhooks/reconciliation/routing/adapters/Redis/`internal/sql-store`. Core must not depend on observability or `@opentelemetry/*`. |
| Routing                   | **Present (Phase 21).** May depend only on `core` among workspace packages. Select-only policies; never mutates payments. Must not depend on testkit/webhooks/reconciliation/observability/adapters/Redis/`internal/sql-store`. Core must not depend on routing. |
| Adapters                  | Runtime contracts come from `@paykernel/store-contracts` (not full testkit). Relational adapters use `@paykernel/sql-foundation`. Redis adapter must **not** use sql-foundation. Driver deps are optional peers or isolated subpaths. Directory names are `packages/store-*`.                                                                                                                                                                                           |
| Adapter root entry        | Importing `@paykernel/store-*` root must **not** auto-import `bun:sqlite`, `bun:sql`, `node:sqlite`, `pg`, `postgres`, `drizzle-orm`, `ioredis`, `redis`, `@upstash/redis`, `better-sqlite3`, `@libsql/client`, `@tursodatabase/serverless`, or other optional peer drivers. D1 and DO roots must not static-import `cloudflare:workers`.                                                                                                                                                                                                                              |
| Cloudflare                | CF packages must not leak Workers-only imports (`cloudflare:workers`, etc.) into Node/Bun/Deno portable packages (core/webhooks/reconciliation/observability/routing/testkit). D1 and DO adapters are `cloudflare-only` and use structural binding/storage types. Do **not** create a generic `packages/store-cloudflare` umbrella or put DO code in the D1 package (or D1 in the DO package).                                                                                                                                                                                                                                                                                                                        |
| Internal                  | Packages under `internal/*` (or `packages/internal/*`) must be `"private": true` and must not be published.                                                                                                                                                                                                                                                                                                                              |
| Examples                  | Private consumer apps under `examples/*` (`"private": true`, not published). **`check-workspace-boundaries.ts` does not scan them** (discovery is `packages/*` + `internal/*` only). They **may** depend on `hono`, `elysia`, `@paykernel/store-sqlite`, `@paykernel/testkit`, and `@paykernel/example-checkout-kernel`. **`packages/*` must never import `examples/*` or `@paykernel/example-*`.** In-memory / local SQLite in these apps is **single-host**, never multi-host. |

## Automated rules (enforced now)

These fail CI today when violated. Packages under `packages/*` are discovered automatically (`core`, `webhooks`, `reconciliation`, `observability`, `routing`, `testkit`, `store-postgres`, `store-redis`, `store-sqlite`, `store-turso`, `store-d1`, `store-durable-objects`, …). **`examples/*` is a Bun workspace glob but is not discovered** — example apps are consumer composition and may pull frameworks the portable matrix forbids. Policy still holds: no `packages/*` → `examples/*` import.

### a) Core / Phase 10 / Phase 19 / Phase 20 / Phase 21 dependency matrix

Package named `@paykernel/core` must not list in any of `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`:

- names matching `@paykernel/store-*` or `@paykernel/provider-*`
- path / workspace refs into `packages/adapter-*` or `packages/gateway-*`
- `@paykernel/webhooks`, `@paykernel/reconciliation`, `@paykernel/opentelemetry`, `@paykernel/routing`, or `@paykernel/testkit` (core isolation)
- any `@opentelemetry/*` package (optional OTEL bridge lives only in observability)

`@paykernel/webhooks` must not depend on testkit, reconciliation, observability, routing, adapter/gateway packages, Redis clients (`ioredis`, `redis`, `@redis/client`, `@upstash/redis`, …), or `internal/sql-store`. Storage is injected.

`@paykernel/reconciliation` must not depend on testkit, webhooks, observability, routing, adapter/gateway packages, Redis clients, or `internal/sql-store`. Depends on **core only**. Storage is injected (`ReconciliationStore`).

`@paykernel/opentelemetry` must not depend on testkit, webhooks, reconciliation, routing, adapter/gateway packages, Redis clients, or `internal/sql-store`. Depends on **core only** among workspace packages. Optional peer `@opentelemetry/api` is allowed (not hard-required). App composes metrics/telemetry; domain packages do not hard-depend on observability.

`@paykernel/routing` must not depend on testkit, webhooks, reconciliation, observability, adapter/gateway packages, Redis clients, or `internal/sql-store`. Depends on **core only** among workspace packages. Select-only (no payment mutation). App composes `decision.gateway` into `PaymentClient`.

Core must not depend on `@paykernel/sql-foundation` or `@paykernel/internal-sql-store` (or path refs into `packages/sql-foundation` / `internal/sql-store`).

`@paykernel/sql-foundation` and the private `internal-sql-store` re-export must not depend on core, webhooks, reconciliation, testkit, or store-contracts.

Allowed workspace edges today:

- `webhooks → core`
- `reconciliation → core`
- `observability → core` (optional peer `@opentelemetry/api` only for the bridge)
- `routing → core`
- `gateway-tap → core` (testkit dev-only)
- `gateway-myfatoorah → core` (testkit dev-only)
- `gateway-hesabe → core` (testkit dev-only)
- `integration-http → core`, `integration-http → webhooks` (testkit dev-only)
- `integration-hono → integration-http` (testkit dev-only; portable)
- `integration-elysia → integration-http` (testkit dev-only; portable)
- `integration-express → integration-http` (testkit dev-only; node-only)
- `integration-cloudflare-workers → integration-http` (testkit dev-only; portable)
- `testkit → core`, `testkit → webhooks`, `testkit → reconciliation`, `testkit → store-contracts` (re-exports contracts; assignability / integration proofs)
- `store-postgres → store-contracts`, `store-postgres → sql-foundation` (testkit dev-only)
- `store-redis → store-contracts` only (no sql-foundation; testkit dev-only)
- `store-sqlite → store-contracts`, `store-sqlite → sql-foundation` (testkit dev-only)
- `store-turso → store-contracts`, `store-turso → sql-foundation` (testkit dev-only)
- `store-d1 → store-contracts`, `store-d1 → sql-foundation` (testkit dev-only)
- `store-durable-objects → store-contracts`, `store-durable-objects → sql-foundation` (testkit dev-only)
- `internal-sql-store → sql-foundation` (private thin re-export only)

### b) Portable production source import policy

Portable packages scanned by `scripts/check-runtime-portability.ts` (`PORTABLE_PACKAGE_DIRS`: `packages/core`, `packages/webhooks`, `packages/reconciliation`, `packages/observability`, `packages/routing`, `packages/store-contracts`, `packages/sql-foundation`, `packages/testkit`, `packages/gateway-tap`, `packages/gateway-myfatoorah`, `packages/gateway-hesabe`, `packages/integration-http`, `packages/integration-hono`, `packages/integration-elysia`, `packages/integration-cloudflare-workers`) — plus any extra `gateway-*` with `paymentsSdk.portable: true` — unless marked node-only via `paymentsSdk.runtime: "node-only"` (e.g. `integration-express` is `node-only` and excluded) must not import, in **production** files under `src/`:

- **Any** `node:`, `bun:`, or `cloudflare:` protocol builtin (Phase 8: allowlist is **empty**)
- filesystem / process / network Node builtins as bare names: `fs`, `fs/promises`, `path`, `child_process`, `net`, `http`, `https`, `http2`, `cluster`, `worker_threads`, `dgram`, `dns`, `os`, `tls`, `zlib`, `stream`, `readline`, `v8`, `vm`, `module`, `perf_hooks`, `async_hooks`, `inspector`, `trace_events`, `crypto`, `buffer`, `url`, `util`, `events`, `assert`, `querystring`, `string_decoder`, `timers`, `tty`, `constants` (11 additional: `crypto`, `buffer`, `url`, `util`, `events`, `assert`, `querystring`, `string_decoder`, `timers`, `tty`, `constants`)
- `bun:sqlite`, `node:sqlite`
- `cloudflare:workers` (and similar CF-only protocol imports)

**No allowlist** for `node:crypto` / `node:buffer` / `node:url` / `node:util` etc in portable production sources.
Use pure helpers / Web APIs (`packages/core/src/runtime/crypto-portable.ts`). Tests
(`*.test.ts`, `*.spec.ts`, `*.types.test.ts`) may still use `node:crypto` /
`node:fs` for fixtures and `bun:test`. Production files must not import `bun:test`.

Published core dist is also gated by `bun run check:runtime-portability` (fails if
`dist/**/*.js` contains `node:` imports). See [runtime.md](../packages/core/docs/runtime.md).

**Note:** `store-postgres`, `store-redis`, `store-sqlite`, and `store-turso` are marked `paymentsSdk.runtime: "node-or-bun"` / non-portable for driver bindings; `store-d1` and `store-durable-objects` are `paymentsSdk.runtime: "cloudflare-only"` / non-portable (structural D1/DO types; no static `cloudflare:workers` on root). `integration-express` is `paymentsSdk.runtime: "node-only"` / non-portable (Express peer). Portable rules above still apply to core/webhooks/reconciliation/observability/routing/testkit/gateway-*/integration-http/hono/elysia/cloudflare-workers/store-contracts/sql-foundation. Adapter **root** entries remain free of optional drivers / Workers protocol imports as documented.

### c) Adapter root entry must not pull optional drivers

For any package whose name matches `*-store-* / *-adapter-*` or `@paykernel/store-*`:

- resolve package root entry (`exports["."]`, then `main` / `module`)
- static imports from that entry (and relative follow-ups within the package) must not include optional peer drivers: `pg`, `postgres`, `drizzle-orm`, `ioredis`, `redis`, `@upstash/redis`, `better-sqlite3`, `bun:sqlite`, `bun:sql`, `bun:redis`, `node:sqlite`, `mysql2`, `sqlite3`, `@libsql/client`, `@tursodatabase/serverless`, `cloudflare:workers`, …

Drivers belong on optional peer deps and isolated subpath exports only.

**SQLite specifically:** `@paykernel/store-sqlite` root must not import `bun:sqlite` / `node:sqlite` / `better-sqlite3`. Those appear only under `/bun`, `/node`, and `/better-sqlite3`.

**Turso specifically:** `@paykernel/store-turso` root must not import `@tursodatabase/serverless` / `@libsql/client`. Those appear only under `/serverless` and `/libsql`. There is **no** `/sync` export.

**D1 specifically:** `@paykernel/store-d1` root must not static-import `cloudflare:workers`. Production code uses structural `D1DatabaseLike` duck types for the Workers binding. Optional peer `@cloudflare/workers-types` is DX-only and must not force portable packages to depend on Workers types. There is **no** generic `adapter-cloudflare` package and **no** Durable Objects code in this package (DO is `store-durable-objects`).

**DO specifically:** `@paykernel/store-durable-objects` root must not static-import `cloudflare:workers`. Production code uses structural `DoStorageLike` / `SqlStorageLike` / `DoNamespaceLike` duck types. Optional peer `@cloudflare/workers-types` is DX-only. Worker **application** code may subclass `DurableObject` from `cloudflare:workers`; that import must not appear in core/webhooks/testkit. There is **no** D1 code in this package and **no** generic `adapter-cloudflare` umbrella.

### d) No circular workspace package dependencies

Build a graph from workspace package names referenced in dependency fields (including `workspace:*` and relative `file:` / path deps). Fail with a printed cycle path if any cycle exists.

### e) Internal packages stay private

Any workspace package whose directory is under `internal/` or `packages/internal/` must have `"private": true`.

**Phase 11 foundation:** publishable **`@paykernel/sql-foundation`** (`packages/sql-foundation`) is the shared relational foundation for adapters. **`internal/sql-store`** is `@paykernel/internal-sql-store` with `"private": true` and `"paymentsSdk": { "privateInternal": true }` — a **thin re-export shim** only (never published). Core and webhooks must not depend on either. **`store-postgres` (Phase 12), `store-sqlite` (Phase 14), `store-turso` (Phase 15), `store-d1` (Phase 16), and `store-durable-objects` (Phase 17) depend on `@paykernel/sql-foundation` at runtime** (not private `internal/*`). **`store-redis` must not** depend on sql-foundation.

## Negative examples (must fail the checker)

```jsonc
// packages/core/package.json — FORBIDDEN
{
  "name": "@paykernel/core",
  "dependencies": {
    "@paykernel/store-postgres": "workspace:*",
  },
}
```

```ts
// packages/core/src/utils/bad.ts — FORBIDDEN in portable production source
import { readFileSync } from "node:fs";
import { join } from "path";
import { Database } from "bun:sqlite";
```

```ts
// packages/store-postgres/src/index.ts (root export) — FORBIDDEN
import pg from "pg"; // drivers only via subpath
export * from "./types";
```

```ts
// packages/store-redis/src/index.ts (root export) — FORBIDDEN
import Redis from "ioredis"; // drivers only via /ioredis, /bun, …
export * from "./types";
```

```ts
// packages/store-sqlite/src/index.ts (root export) — FORBIDDEN
import { Database } from "bun:sqlite"; // drivers only via /bun, /node, /better-sqlite3
export * from "./types";
```

```ts
// packages/store-turso/src/index.ts (root export) — FORBIDDEN
import { createClient } from "@libsql/client"; // drivers only via /libsql, /serverless
export * from "./types";
```

```jsonc
// packages/store-redis/package.json — FORBIDDEN (no sql-foundation / sql-store)
{
  "name": "@paykernel/store-redis",
  "dependencies": {
    "@paykernel/sql-foundation": "workspace:*",
    // also forbidden: "@paykernel/internal-sql-store"
  },
}
```

```jsonc
// packages/store-postgres/package.json — FORBIDDEN (no dependency on sqlite adapter)
{
  "name": "@paykernel/store-postgres",
  "dependencies": {
    "@paykernel/store-sqlite": "workspace:*",
  },
}
```

```jsonc
// internal/sql-store/package.json — FORBIDDEN if publishable
{
  "name": "@paykernel/internal-sql-store",
  "private": false,
}
```

```jsonc
// packages/core/package.json — FORBIDDEN (core must not depend on sql-foundation)
{
  "name": "@paykernel/core",
  "dependencies": {
    "@paykernel/sql-foundation": "workspace:*",
    // also forbidden: "@paykernel/internal-sql-store"
  },
}
```

```jsonc
// packages/webhooks/package.json — FORBIDDEN (webhooks must not depend on sql-foundation)
{
  "name": "@paykernel/webhooks",
  "dependencies": {
    "@paykernel/sql-foundation": "workspace:*",
    // also forbidden: "@paykernel/internal-sql-store"
  },
}
```

```jsonc
// packages/webhooks/package.json — FORBIDDEN (webhooks must not depend on adapter)
{
  "name": "@paykernel/webhooks",
  "dependencies": {
    "@paykernel/store-redis": "workspace:*",
  },
}
```

```jsonc
// packages/reconciliation/package.json — FORBIDDEN (reconciliation must not depend on testkit)
{
  "name": "@paykernel/reconciliation",
  "dependencies": {
    "@paykernel/testkit": "workspace:*",
  },
}
```

```jsonc
// packages/core/package.json — FORBIDDEN (core must not depend on reconciliation)
{
  "name": "@paykernel/core",
  "dependencies": {
    "@paykernel/reconciliation": "workspace:*",
  },
}
```

```jsonc
// packages/core/package.json — FORBIDDEN (core must not depend on observability)
{
  "name": "@paykernel/core",
  "dependencies": {
    "@paykernel/opentelemetry": "workspace:*",
  },
}
```

```jsonc
// packages/core/package.json — FORBIDDEN (core must not depend on routing)
{
  "name": "@paykernel/core",
  "dependencies": {
    "@paykernel/routing": "workspace:*",
  },
}
```

```jsonc
// packages/core/package.json — FORBIDDEN (core must not depend on OpenTelemetry)
{
  "name": "@paykernel/core",
  "dependencies": {
    "@opentelemetry/api": "^1.0.0",
  },
}
```

```jsonc
// packages/observability/package.json — FORBIDDEN (observability must not depend on testkit)
{
  "name": "@paykernel/opentelemetry",
  "dependencies": {
    "@paykernel/testkit": "workspace:*",
  },
}
```

```jsonc
// packages/routing/package.json — FORBIDDEN (routing must not depend on testkit)
{
  "name": "@paykernel/routing",
  "dependencies": {
    "@paykernel/testkit": "workspace:*",
  },
}
```

```jsonc
// packages/reconciliation/package.json — ALLOWED shape (Phase 19)
{
  "name": "@paykernel/reconciliation",
  "dependencies": {
    "@paykernel/core": "workspace:*",
  },
  "paymentsSdk": { "portable": true },
}
```

```jsonc
// packages/observability/package.json — ALLOWED shape (Phase 20)
{
  "name": "@paykernel/opentelemetry",
  "dependencies": {
    "@paykernel/core": "workspace:*",
  },
  "peerDependencies": {
    "@opentelemetry/api": ">=1.0.0",
  },
  "peerDependenciesMeta": {
    "@opentelemetry/api": { "optional": true },
  },
  "paymentsSdk": { "portable": true },
}
```

```jsonc
// packages/routing/package.json — ALLOWED shape (Phase 21)
{
  "name": "@paykernel/routing",
  "dependencies": {
    "@paykernel/core": "workspace:*",
  },
  "paymentsSdk": { "portable": true },
}
```

```jsonc
// packages/core/package.json — FORBIDDEN (packages/* must never depend on examples)
{
  "name": "@paykernel/core",
  "dependencies": {
    "@paykernel/example-checkout-kernel": "workspace:*",
  },
}
```

## Positive examples (allowed)

```ts
// packages/core/src/gateways/stripe/stripe.gateway.ts — ALLOWED (allowlisted historical paths only where policy permits)
// Prefer portable Web crypto helpers in new code.
```

```ts
// packages/core/src/client.test.ts — ALLOWED (test file)
import { describe, it, expect } from "bun:test";
```

```jsonc
// packages/store-postgres/package.json — ALLOWED shape (Phase 12)
{
  "name": "@paykernel/store-postgres",
  "exports": {
    ".": "./dist/index.js",
    "./pg": "./dist/pg.js",
    "./postgres-js": "./dist/postgres-js.js",
    "./bun-sql": "./dist/bun-sql.js",
    "./drizzle": "./dist/drizzle.js",
  },
  "dependencies": {
    "@paykernel/store-contracts": "workspace:*",
    "@paykernel/sql-foundation": "workspace:*",
  },
  "devDependencies": {
    "@paykernel/testkit": "workspace:*",
  },
  "peerDependencies": {
    "pg": ">=8.11.0",
    "postgres": ">=3.4.0",
    "drizzle-orm": ">=0.29.0",
  },
  "peerDependenciesMeta": {
    "pg": { "optional": true },
    "postgres": { "optional": true },
    "drizzle-orm": { "optional": true },
  },
}
```

```jsonc
// packages/store-redis/package.json — ALLOWED shape (Phase 13)
{
  "name": "@paykernel/store-redis",
  "exports": {
    ".": "./dist/index.js",
    "./bun": "./dist/bun.js",
    "./upstash": "./dist/upstash.js",
    "./ioredis": "./dist/ioredis.js",
    "./node-redis": "./dist/node-redis.js",
  },
  "dependencies": {
    "@paykernel/store-contracts": "workspace:*",
  },
  "devDependencies": {
    "@paykernel/testkit": "workspace:*",
  },
  "peerDependencies": {
    "ioredis": ">=5.0.0",
    "redis": ">=4.0.0",
    "@upstash/redis": ">=1.0.0",
  },
  "peerDependenciesMeta": {
    "ioredis": { "optional": true },
    "redis": { "optional": true },
    "@upstash/redis": { "optional": true },
  },
}
```

```jsonc
// packages/store-sqlite/package.json — ALLOWED shape (Phase 14)
{
  "name": "@paykernel/store-sqlite",
  "exports": {
    ".": "./dist/index.js",
    "./bun": "./dist/bun.js",
    "./node": "./dist/node.js",
    "./better-sqlite3": "./dist/better-sqlite3.js",
  },
  "dependencies": {
    "@paykernel/store-contracts": "workspace:*",
    "@paykernel/sql-foundation": "workspace:*",
  },
  "devDependencies": {
    "@paykernel/testkit": "workspace:*",
  },
  "peerDependencies": {
    "better-sqlite3": ">=9.0.0",
  },
  "peerDependenciesMeta": {
    "better-sqlite3": { "optional": true },
  },
}
```

```jsonc
// packages/store-turso/package.json — ALLOWED shape (Phase 15)
{
  "name": "@paykernel/store-turso",
  "exports": {
    ".": "./dist/index.js",
    "./serverless": "./dist/serverless.js",
    "./libsql": "./dist/libsql.js",
    // NO "./sync"
  },
  "dependencies": {
    "@paykernel/store-contracts": "workspace:*",
    "@paykernel/sql-foundation": "workspace:*",
  },
  "devDependencies": {
    "@paykernel/testkit": "workspace:*",
  },
  "peerDependencies": {
    "@libsql/client": ">=0.14.0",
    "@tursodatabase/serverless": ">=1.0.0",
  },
  "peerDependenciesMeta": {
    "@libsql/client": { "optional": true },
    "@tursodatabase/serverless": { "optional": true },
  },
}
```

```jsonc
// packages/store-d1/package.json — ALLOWED shape (Phase 16)
{
  "name": "@paykernel/store-d1",
  "exports": {
    ".": "./dist/index.js",
  },
  "dependencies": {
    "@paykernel/store-contracts": "workspace:*",
    "@paykernel/sql-foundation": "workspace:*",
  },
  "devDependencies": {
    "@paykernel/testkit": "workspace:*",
  },
  "peerDependencies": {
    "@cloudflare/workers-types": ">=4.0.0",
  },
  "peerDependenciesMeta": {
    "@cloudflare/workers-types": { "optional": true },
  },
  "paymentsSdk": {
    "portable": false,
    "runtime": "cloudflare-only",
  },
}
// Root src must NOT static-import "cloudflare:workers"
```

```jsonc
// packages/store-durable-objects/package.json — ALLOWED shape (Phase 17)
{
  "name": "@paykernel/store-durable-objects",
  "exports": {
    ".": "./dist/index.js",
  },
  "dependencies": {
    "@paykernel/store-contracts": "workspace:*",
    "@paykernel/sql-foundation": "workspace:*",
  },
  "devDependencies": {
    "@paykernel/testkit": "workspace:*",
  },
  "peerDependencies": {
    "@cloudflare/workers-types": ">=4.0.0",
  },
  "peerDependenciesMeta": {
    "@cloudflare/workers-types": { "optional": true },
  },
  "paymentsSdk": {
    "portable": false,
    "runtime": "cloudflare-only",
  },
}
// Root src must NOT static-import "cloudflare:workers"
// Separate package from adapter-cloudflare-d1 — no generic adapter-cloudflare
```

```jsonc
// internal/sql-store/package.json — ALLOWED
{
  "name": "@paykernel/internal-sql-store",
  "private": true,
  "paymentsSdk": { "portable": true, "privateInternal": true },
}
```

```jsonc
// examples/bun-hono-sqlite/package.json — ALLOWED (private consumer app; checker does not scan)
{
  "name": "@paykernel/example-bun-hono-sqlite",
  "private": true,
  "dependencies": {
    "@paykernel/example-checkout-kernel": "workspace:*",
    "hono": "^4.0.0",
  },
}
```

Example apps may also depend on `elysia`, `@paykernel/store-sqlite`, and `@paykernel/testkit`. That is application-layer composition, not an SDK package edge.

## Running and extending

```bash
# Full monorepo gate
bun run check:boundaries

# Optional unit tests for pure helpers
bun test scripts/check-workspace-boundaries.test.ts
```

When adding a new package:

1. Place it under `packages/<name>/` (or `internal/<name>/` if private-only). Consumer walkthroughs go under `examples/<name>/` (`"private": true`) — the checker will not pick them up.
2. Respect the dependency matrix above. Publishable packages must not import `examples/*`.
3. If a package is intentionally Node-only, set:

```json
"paymentsSdk": { "runtime": "node-only" }
```

4. Re-run `bun run check:boundaries` before opening a PR.

## Relation to Phase 0 gates

Boundary checks are additive. They do not replace typecheck, tests, coverage thresholds, pack, publint, attw, or consumer smoke. See `packages/core/docs/baseline/` and `scripts/validate-package.sh`.
