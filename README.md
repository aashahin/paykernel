# PayKernel

[![npm version](https://img.shields.io/npm/v/@paykernel/core?label=%40paykernel%2Fcore&color=0ea5e9)](https://www.npmjs.com/package/@paykernel/core)
[![npm downloads](https://img.shields.io/npm/dm/@paykernel/core?color=0ea5e9)](https://www.npmjs.com/package/@paykernel/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/aashahin/paykernel/actions/workflows/ci.yml/badge.svg)](https://github.com/aashahin/paykernel/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-paykernel.dev-0ea5e9)](https://paykernel-docs.abshahin.workers.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.0-fbf0df)](https://bun.sh/)

> The payment orchestration kernel for TypeScript.

Type-safe payment orchestration for **MENA + global** providers — **Moyasar, PayPal, Paymob, Stripe, Tap, MyFatoorah, Hesabe** — with portable webhook inbox, reconciliation, and multi-store adapters. Built for modern server runtimes: **Node, Bun, Deno, Cloudflare Workers**.

**Repository:** [aashahin/paykernel](https://github.com/aashahin/paykernel) · **npm scope:** [`@paykernel`](https://www.npmjs.com/org/paykernel) · **Docs:** [paykernel-docs.abshahin.workers.dev](https://paykernel-docs.abshahin.workers.dev) · **License:** MIT

## Why PayKernel

- **One client, many gateways** — unified `createPayment`, `capture`, `refund`, `void`, `getPayment` across providers. Money is always `Money` (bigint minor units), never `number`.
- **Correct by default** — `outcome` + `status === "paid"` gates, indeterminate reconciliation, lease-fenced webhook inbox, and idempotency claims. No double-fulfillment, no `success:true` traps.
- **Portable** — pure Web APIs + Web Crypto. No hard Express/Hono dependency. Works on Node 18+, Bun 1+, Deno, and Cloudflare Workers.
- **Composable storage** — pick Postgres, Redis/Valkey/Upstash, SQLite, Turso/libSQL, D1, or Durable Objects. Core never mandates a store.
- **Observable & testable** — redacting telemetry, OTEL bridge, and a full testkit with mock gateway + conformance harnesses.

## Quick start

```bash
bun add @paykernel/core
# or
npm install @paykernel/core
# or
pnpm add @paykernel/core
```

```typescript
import { createPaymentClient, moyasarGateway, money, isPaidOutcome } from "@paykernel/core";

const client = createPaymentClient({
  gateways: {
    moyasar: moyasarGateway({
      secretKey: process.env.MOYASAR_SECRET_KEY!,
      webhookSecret: process.env.MOYASAR_WEBHOOK_SECRET,
    }),
  },
  defaultGateway: "moyasar",
});

const result = await client.createPayment({
  amount: money("100.00", "SAR"),
  currency: "SAR",
  orderId: "order_123",
  callbackUrl: "https://example.com/callback",
  moyasarSource: { type: "token", token: "token_xxx" },
});

if (isPaidOutcome(result)) {
  // fulfilled only on outcome === "succeeded" && status === "paid"
} else if (result.redirectUrl) {
  // 3DS redirect — do not fulfill yet
} else if (result.outcome === "indeterminate") {
  // reconcile via getPayment — do not retry create
}
```

Full composition (verify → claim → fulfill → reconcile): [`docs/getting-started.md`](./docs/getting-started.md)

## Packages

| Package | npm | Description |
| --- | --- | --- |
| [`packages/core`](./packages/core) | [`@paykernel/core`](https://www.npmjs.com/package/@paykernel/core) | **Core SDK** — Moyasar, PayPal, Paymob, Stripe + plugin registry |
| [`packages/webhooks`](./packages/webhooks) | [`@paykernel/webhooks`](https://www.npmjs.com/package/@paykernel/webhooks) | Portable webhook inbox engine (claim, lease fencing, processing outcomes) |
| [`packages/reconciliation`](./packages/reconciliation) | [`@paykernel/reconciliation`](https://www.npmjs.com/package/@paykernel/reconciliation) | Portable reconciliation primitives (drift, decision-only policy, store-backed scheduling) |
| [`packages/observability`](./packages/observability) | [`@paykernel/opentelemetry`](https://www.npmjs.com/package/@paykernel/opentelemetry) | Portable metrics/spans + redacting telemetry + optional OTEL bridge |
| [`packages/routing`](./packages/routing) | [`@paykernel/routing`](https://www.npmjs.com/package/@paykernel/routing) | Select-only gateway routing + restricted post-attempt fallback |
| [`packages/gateway-tap`](./packages/gateway-tap) | [`@paykernel/gateway-tap`](https://www.npmjs.com/package/@paykernel/gateway-tap) | **Tap Payments** adapter (charges, auth/capture/void, refunds, webhooks) |
| [`packages/gateway-myfatoorah`](./packages/gateway-myfatoorah) | [`@paykernel/gateway-myfatoorah`](https://www.npmjs.com/package/@paykernel/gateway-myfatoorah) | **MyFatoorah** adapter (V3 hosted payments, refunds, Webhook V2) |
| [`packages/gateway-hesabe`](./packages/gateway-hesabe) | [`@paykernel/gateway-hesabe`](https://www.npmjs.com/package/@paykernel/gateway-hesabe) | **Hesabe** adapter (KWD hosted payments, enquiry, refunds, verified callbacks/webhooks) |
| [`packages/testkit`](./packages/testkit) | [`@paykernel/testkit`](https://www.npmjs.com/package/@paykernel/testkit) | Mock gateway, conformance suites, NON-PRODUCTION memory stores |
| [`packages/store-contracts`](./packages/store-contracts) | [`@paykernel/store-contracts`](https://www.npmjs.com/package/@paykernel/store-contracts) | Portable store contracts (lease stores, errors, manifests) |
| [`packages/sql-foundation`](./packages/sql-foundation) | [`@paykernel/sql-foundation`](https://www.npmjs.com/package/@paykernel/sql-foundation) | Relational schemas, migrations, claim SQL templates |
| [`packages/store-postgres`](./packages/store-postgres) | [`@paykernel/store-postgres`](https://www.npmjs.com/package/@paykernel/store-postgres) | PostgreSQL durable stores (idempotency, webhook inbox, reconciliation) |
| [`packages/store-redis`](./packages/store-redis) | [`@paykernel/store-redis`](https://www.npmjs.com/package/@paykernel/store-redis) | Redis/Valkey/Upstash stores (Lua claims) — optional, never required |
| [`packages/store-sqlite`](./packages/store-sqlite) | [`@paykernel/store-sqlite`](https://www.npmjs.com/package/@paykernel/store-sqlite) | Single-host SQLite stores (Bun/Node/better-sqlite3) |
| [`packages/store-turso`](./packages/store-turso) | [`@paykernel/store-turso`](https://www.npmjs.com/package/@paykernel/store-turso) | Multi-host remote Turso/libSQL stores |
| [`packages/store-d1`](./packages/store-d1) | [`@paykernel/store-d1`](https://www.npmjs.com/package/@paykernel/store-d1) | Multi-host Cloudflare D1 stores (Workers binding) |
| [`packages/store-durable-objects`](./packages/store-durable-objects) | [`@paykernel/store-durable-objects`](https://www.npmjs.com/package/@paykernel/store-durable-objects) | Multi-host partitioned Durable Object stores |
| [`packages/integration-http`](./packages/integration-http) | [`@paykernel/integration-http`](https://www.npmjs.com/package/@paykernel/integration-http) | Portable HTTP mapping + `processWebhookHttp` (framework-agnostic) |
| [`packages/integration-hono`](./packages/integration-hono) | [`@paykernel/integration-hono`](https://www.npmjs.com/package/@paykernel/integration-hono) | Thin Hono adapter for webhooks |
| [`packages/integration-elysia`](./packages/integration-elysia) | [`@paykernel/integration-elysia`](https://www.npmjs.com/package/@paykernel/integration-elysia) | Thin Elysia adapter for webhooks |
| [`packages/integration-express`](./packages/integration-express) | [`@paykernel/integration-express`](https://www.npmjs.com/package/@paykernel/integration-express) | Thin Express adapter (raw-body safe, Node-only) |
| [`packages/integration-cloudflare-workers`](./packages/integration-cloudflare-workers) | [`@paykernel/integration-cloudflare-workers`](https://www.npmjs.com/package/@paykernel/integration-cloudflare-workers) | Thin Cloudflare Workers adapter |

`internal/sql-store` (`@paykernel/internal-sql-store`) is a private BC shim — never published. Adapters depend on `@paykernel/sql-foundation`.

### Install — pick what you need

```bash
bun add @paykernel/core                                   # core SDK
bun add @paykernel/webhooks                               # inbox engine
bun add @paykernel/reconciliation                         # reconciliation
bun add @paykernel/opentelemetry                          # observability
bun add @paykernel/routing                                # routing policies
bun add @paykernel/gateway-tap @paykernel/gateway-myfatoorah @paykernel/gateway-hesabe  # extra gateways
bun add @paykernel/store-postgres                         # Postgres (app layer)
bun add @paykernel/store-redis                            # Redis/Valkey/Upstash (optional)
bun add @paykernel/store-sqlite                           # SQLite single-host
bun add @paykernel/store-turso                            # Turso/libSQL multi-host
bun add @paykernel/store-d1                               # Cloudflare D1
bun add @paykernel/store-durable-objects                  # Durable Objects
bun add @paykernel/integration-http @paykernel/integration-hono  # HTTP adapters
# or with npm: npm install @paykernel/core
```

```typescript
import { PaymentClient } from "@paykernel/core";
// optional:
// import { createWebhookInboxEngine } from "@paykernel/webhooks";
// import { createPaymentReconciler } from "@paykernel/reconciliation";
// import { withPaymentOperation, createInMemoryPaymentMetrics } from "@paykernel/opentelemetry";
// import { createPaymentRouter, route } from "@paykernel/routing";
// import { createPostgresStores } from "@paykernel/store-postgres";
// import { createRedisStores } from "@paykernel/store-redis";
// import { createSqliteStores } from "@paykernel/store-sqlite";
// import { createTursoStores } from "@paykernel/store-turso";
// import { createD1PaymentStores } from "@paykernel/store-d1";
// import { createDoPaymentStores } from "@paykernel/store-durable-objects";
```

## Package structure (monorepo)

Workspaces are `packages/*`, `internal/*`, and `examples/*`. The root package is private and is never published. Layout, build order, and commands: [`docs/monorepo.md`](./docs/monorepo.md).

## Development

Root scripts forward into workspace packages so Phase 0 command names stay stable:

```bash
bun install
bun run build
bun test
bun test examples
bun run test:coverage
bun run typecheck
bun run typecheck:types
bun run typecheck:all
bun run format
bun run format:check
bun run lint
bun run check:boundaries
bun run check:runtime-portability
bun run test:runtime
bun run pack:check
bun run publint
bun run attw
bun run validate:package
bun run baseline
```

Package-local work:

```bash
cd packages/core
bun run build
bun test

cd packages/webhooks
bun run build
bun test

cd packages/testkit
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
# default: mock D1 CI path; live/miniflare skip unless harness env set

cd packages/store-durable-objects
bun run build
bun test
# default: mock DO SQL CI path; live/miniflare skip unless harness env set
```

See [`docs/monorepo.md`](./docs/monorepo.md) for layout details, boundary rules, and release notes.

## Documentation

**Docs site:** [https://paykernel-docs.abshahin.workers.dev](https://paykernel-docs.abshahin.workers.dev) — start at [Quickstart](https://paykernel-docs.abshahin.workers.dev/quickstart).

**Start here (in-repo):** [`docs/README.md`](./docs/README.md) · [`docs/getting-started.md`](./docs/getting-started.md) (create payment → verify → inbox claim → fulfill → reconcile)

| Audience | Docs |
| --- | --- |
| First payment / production composition | [`docs/getting-started.md`](./docs/getting-started.md) |
| Which store | [`docs/adapter-selection.md`](./docs/adapter-selection.md) |
| Examples | [`examples/README.md`](./examples/README.md) — private checkout kernel + Bun Hono/Elysia (single-host in-memory SQLite) |
| Core | [`packages/core/README.md`](./packages/core/README.md) · [money](./packages/core/docs/money.md) · [outcomes](./packages/core/docs/operation-results.md) · [webhooks](./packages/core/docs/webhooks.md) · [events](./packages/core/docs/webhook-events.md) · [runtime](./packages/core/docs/runtime.md) |
| Inbox | [`packages/webhooks/README.md`](./packages/webhooks/README.md) · [webhook-inbox.md](./packages/webhooks/docs/webhook-inbox.md) |
| Reconciliation | [`packages/reconciliation/README.md`](./packages/reconciliation/README.md) |
| Routing | [`packages/routing/README.md`](./packages/routing/README.md) |
| Extra gateways | [Tap Payments](./packages/gateway-tap/README.md) (`@paykernel/gateway-tap`) · [MyFatoorah](./packages/gateway-myfatoorah/README.md) (`@paykernel/gateway-myfatoorah`) · [Hesabe](./packages/gateway-hesabe/README.md) (`@paykernel/gateway-hesabe`) — external adapters |
| Observability | [`packages/observability/README.md`](./packages/observability/README.md) (`@paykernel/opentelemetry`) |
| Contracts | [`packages/store-contracts/README.md`](./packages/store-contracts/README.md) · [contracts.md](./packages/store-contracts/docs/contracts.md) |
| SQL foundation | [`packages/sql-foundation/README.md`](./packages/sql-foundation/README.md) · [relational-foundation.md](./packages/sql-foundation/docs/relational-foundation.md) |
| Testkit | [`packages/testkit/README.md`](./packages/testkit/README.md) |
| Stores | [postgres](./packages/store-postgres/README.md) · [redis](./packages/store-redis/README.md) · [sqlite](./packages/store-sqlite/README.md) · [turso](./packages/store-turso/README.md) · [d1](./packages/store-d1/README.md) · [durable objects](./packages/store-durable-objects/README.md) |
| Framework adapters | [integration-http](./packages/integration-http/README.md) · [hono](./packages/integration-hono/README.md) · [elysia](./packages/integration-elysia/README.md) · [express](./packages/integration-express/README.md) · [workers](./packages/integration-cloudflare-workers/README.md) |
| Contributors | [`docs/monorepo.md`](./docs/monorepo.md) · [`docs/workspace-boundaries.md`](./docs/workspace-boundaries.md) · [`docs/releases.md`](./docs/releases.md) |

`roadmap.md` is a completed phase log (0–25 shipped, Phase 23 leftover gateways) plus leftover product work. It is not the consumer index. Phase 25 (1.0): 1.0 contract cut, compat CI, `bun-hono-postgres` RC.

## License

MIT — see [LICENSE](./LICENSE). Copyright © Abdelrahman Shaheen.
