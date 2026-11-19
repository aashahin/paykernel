---
"@paykernel/webhooks": patch
---

feat: `engine.processOne({ key, handler, ... })` claims and processes exactly one inbox receipt by key.

It is the by-key counterpart of one `processRetryable` row: `store.get(key)` for the hash and payload snapshot, then the store's own compare-and-set `claim` with `ifMatchPayloadHash`. Lease length (30 s default), attempt accounting, `availableAt` backoff, terminal classification and lease fencing are the store's and are unchanged. No store method is added, so every adapter (memory, SQL, D1, DO, Turso, Postgres, Redis, SQLite) supports it. A caller whose receipt is wanted now no longer depends on it being among the oldest due rows of a global `listRetryable` page. Returns `{ found: false }` for an unknown key, otherwise the same outcome the row would have had in a poll. Additive and optional to use: callers that must also run on 0.1.1 should check `typeof engine.processOne === "function"`.
