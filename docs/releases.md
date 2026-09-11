# Releases

How this monorepo versions packages, generates release notes, publishes to npm with provenance, and runs prerelease channels.

## Packages

| Package           | Path                        | npm name                                | Notes                                                                 |
| ----------------- | --------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| Core SDK          | `packages/core`             | `@paykernel/core`                | Public, versioned by Changesets                                       |
| Testkit           | `packages/testkit`          | `@paykernel/testkit`            | Public; mocks, store contracts, conformance                           |
| Webhooks          | `packages/webhooks`         | `@paykernel/webhooks`           | Public; Phase 10 inbox engine                                         |
| Reconciliation    | `packages/reconciliation`   | `@paykernel/reconciliation`     | Public; Phase 19 domain primitives (portable; core-only dep)          |
| Observability     | `packages/observability`    | `@paykernel/opentelemetry`      | Public; Phase 20 metrics/spans/redacting telemetry (portable; core-only; optional peer `@opentelemetry/api`) |
| Routing           | `packages/routing`          | `@paykernel/routing`            | Public; Phase 21 select-only gateway routing + restricted post-attempt fallback eligibility (portable; core-only) |
| Integration HTTP  | `packages/integration-http` | `@paykernel/integration-http`   | Public; Phase 24 portable HTTP mapping + `processWebhookHttp` (portable; core + webhooks) |
| Integration Hono  | `packages/integration-hono` | `@paykernel/integration-hono`   | Public; Phase 24 thin Hono adapter (portable; integration-http only) |
| Integration Elysia| `packages/integration-elysia` | `@paykernel/integration-elysia` | Public; Phase 24 thin Elysia adapter (portable; integration-http only) |
| Integration Express| `packages/integration-express` | `@paykernel/integration-express` | Public; Phase 24 thin Express adapter (**node-only**; integration-http only) |
| Integration Workers| `packages/integration-cloudflare-workers` | `@paykernel/integration-cloudflare-workers` | Public; Phase 24 thin Workers adapter (portable; integration-http only) |
| Tap gateway       | `packages/gateway-tap`      | `@paykernel/gateway-tap`        | Public; Phase 23 extra Tap Payments adapter (portable; core-only; **not** a core built-in) |
| MyFatoorah gateway | `packages/gateway-myfatoorah` | `@paykernel/gateway-myfatoorah` | Public; extra MyFatoorah adapter (portable; core-only; **not** a core built-in) |
| Hesabe gateway    | `packages/gateway-hesabe`   | `@paykernel/gateway-hesabe`     | Public; extra Hesabe adapter — KWD hosted checkout, enquiry-verified notifications, refunds (portable; core-only; **not** a core built-in) |
| Postgres adapter  | `packages/store-postgres` | `@paykernel/store-postgres`   | Public; Phase 12 durable stores — **may publish separately** from core |
| Redis adapter     | `packages/store-redis`    | `@paykernel/store-redis`      | Public; Phase 13 optional Redis/Valkey — **may publish separately** from core |
| SQLite adapter    | `packages/store-sqlite`   | `@paykernel/store-sqlite`     | Public; Phase 14 single-host SQLite — **may publish separately** from core |
| Turso adapter     | `packages/store-turso`    | `@paykernel/store-turso`      | Public; Phase 15 multi-host remote Turso/libSQL — **may publish separately** from core |
| Cloudflare D1 adapter | `packages/store-d1` | `@paykernel/store-d1` | Public; Phase 16 multi-host Workers D1 — **may publish separately** from core |
| Cloudflare DO adapter | `packages/store-durable-objects` | `@paykernel/store-durable-objects` | Public; Phase 17 multi-host partitioned SQLite-backed DO — **may publish separately** from core |
| SQL foundation    | `packages/sql-foundation`   | `@paykernel/sql-foundation` | Public; Phase 11 relational foundation (schemas, migrations, claim templates) |
| SQL foundation shim | `internal/sql-store`      | `@paykernel/internal-sql-store` | **`private: true` — never published** (thin re-export of sql-foundation) |
| Monorepo root     | `.`                         | `paykernel`       | `private: true` — never published                                     |

Versioning is **independent** (`fixed: []`, `linked: []` in `.changeset/config.json`). The private monorepo root and **all packages under `internal/*`** are never versioned for npm or published (Changesets skips `"private": true` packages). Each public package under `packages/*` has its own version and `CHANGELOG.md`. Internal packages may keep an in-repo `CHANGELOG.md` for history only — they are **not** npm release units.

**Adapters publish separately.** `@paykernel/store-postgres`, `@paykernel/store-redis`, `@paykernel/store-sqlite`, `@paykernel/store-turso`, `@paykernel/store-d1`, and `@paykernel/store-durable-objects` are versioned independently of core/webhooks/testkit (and of each other). A core release does not require an adapter release (and vice versa). Record changesets against the package that actually changed. Note: relational adapters depend on publishable `@paykernel/sql-foundation` + `@paykernel/store-contracts` at runtime (not private `internal/sql-store`, not full testkit). The **redis** adapter depends only on `@paykernel/store-contracts` among workspace runtime packages (`@paykernel/testkit` is devDependency for conformance).

**Never publish internal packages.** Do not add them to the release workflow publish list, do not set `"private": false`, and do not run `npm publish` from `internal/*`.

## Workflow overview

1. **Develop** on a branch; open a PR.
2. **Record intent** with `bun run changeset` (committed under `.changeset/`).
3. **Merge to `main`**. The Release workflow either:
   - opens/updates a **Version packages** PR (when unpublished changesets exist), or
   - **publishes** to npm when that version PR is merged (versions already bumped).
4. Consumers install the new version from npm (`@paykernel/core`, and optionally `@paykernel/testkit` / `@paykernel/webhooks` / `@paykernel/reconciliation` / `@paykernel/opentelemetry` / `@paykernel/routing` / `@paykernel/gateway-tap` / `@paykernel/gateway-myfatoorah` / `@paykernel/gateway-hesabe` / `@paykernel/integration-http` / `@paykernel/integration-hono` / `@paykernel/integration-elysia` / `@paykernel/integration-express` / `@paykernel/integration-cloudflare-workers` / `@paykernel/store-postgres` / `@paykernel/store-redis` / `@paykernel/store-sqlite` / `@paykernel/store-turso` / `@paykernel/store-d1` / `@paykernel/store-durable-objects`).

### Commands (root)

| Script                        | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `bun run changeset`           | Interactive: add a changeset                     |
| `bun run version-packages`    | Apply changesets → version bump + `CHANGELOG.md` |
| `bun run release`             | `changeset publish` (used by CI)                 |
| `bun run changeset:pre:enter` | Enter `canary` prerelease mode                   |
| `bun run changeset:pre:exit`  | Exit prerelease mode                             |

## Release notes

Changesets is the release-notes mechanism:

- Each changeset summary becomes an entry in the package changelog.
- `bun run version-packages` (`changeset version`) updates `packages/*/CHANGELOG.md` and bumps versions.
- GitHub Releases / tags may be created by `changesets/action` on publish.

Pre-Changesets history (before this pipeline) lives in **git tags** and commit history. See the stub note at the top of `packages/core/CHANGELOG.md`.

## npm provenance

Published builds from CI use **npm provenance** (sigstore / OIDC):

- Workflow: `.github/workflows/release.yml`
- Permissions: `id-token: write` (OIDC), `contents: write`, `pull-requests: write`
- Env: `NPM_CONFIG_PROVENANCE=true`
- Package: `packages/core` also sets `"publishConfig": { "access": "public", "provenance": true }`

Provenance requires publish from GitHub Actions with OIDC — not from a random local `npm publish`. Secrets:

- `NPM_TOKEN` — automation token with publish rights (repository secret)
- `GITHUB_TOKEN` — provided by Actions (PRs / tags)

No tokens are hardcoded in the repo.

## Prerelease channels (canary / beta)

Use prerelease mode when you want installable RCs without promoting stable.

### Enter canary (default script)

```bash
bun run changeset:pre:enter
# → changeset pre enter canary
```

### Enter beta (or another tag)

```bash
bunx changeset pre enter beta
```

### While in pre mode

1. Add changesets as usual (`bun run changeset`).
2. Version: `bun run version-packages` → e.g. `0.9.0-canary.0`.
3. Publish via CI (merge to `main` under the release workflow) or maintainer `bun run release`.
4. Consumers install with a dist-tag, e.g.:

   ```bash
   npm install @paykernel/core@canary
   # or
   bun add @paykernel/core@canary
   ```

### Exit prerelease → stable

```bash
bun run changeset:pre:exit
# → changeset pre exit
```

Then add a normal changeset, version, and publish for the stable bump (e.g. `0.9.0`).

### Stable vs canary/beta

| Channel    | How                                        | When                              |
| ---------- | ------------------------------------------ | --------------------------------- |
| **Stable** | No pre mode; normal changesets on `main` | Production releases               |
| **Canary** | `changeset pre enter canary`               | Continuous / bleeding-edge RCs    |
| **Beta**   | `changeset pre enter beta`                 | Feature-complete RC before stable |

Only one pre tag is active at a time; exit before switching or cutting stable.

## Stability (1.0)

Versioning, event/schema/runtime, and provider/driver guarantees are documented in [Stability](./stability.md) (canonical decisions in [ADR 0025](./adr/0025-1-0-stability.md)).

## Local publish (escape hatch only)

```bash
bun install --frozen-lockfile
bun run build
bun run release
```

Prefer CI so provenance and the Version PR flow stay intact. Do not publish from untrusted environments.

## Related files

- `.changeset/config.json` — independent versioning, public access, `baseBranch: main`
- `.changeset/README.md` — short CLI cheat sheet
- `.github/workflows/release.yml` — version PR + publish with provenance
- `packages/core/CHANGELOG.md` — generated notes for `@paykernel/core`
- `packages/testkit/CHANGELOG.md` — `@paykernel/testkit`
- `packages/webhooks/CHANGELOG.md` — `@paykernel/webhooks`
- `packages/store-postgres/CHANGELOG.md` — `@paykernel/store-postgres` (independent adapter releases)
- `packages/store-redis/CHANGELOG.md` — `@paykernel/store-redis` (independent optional adapter releases)
- `packages/store-sqlite/CHANGELOG.md` — `@paykernel/store-sqlite` (independent single-host adapter releases)
- `packages/store-turso/CHANGELOG.md` — `@paykernel/store-turso` (independent multi-host remote adapter releases)
- `packages/store-d1/CHANGELOG.md` — `@paykernel/store-d1` (independent multi-host D1 adapter releases)
- `packages/store-durable-objects/CHANGELOG.md` — `@paykernel/store-durable-objects` (independent multi-host partitioned DO adapter releases)
- `internal/sql-store/CHANGELOG.md` — in-repo only; package is never published
