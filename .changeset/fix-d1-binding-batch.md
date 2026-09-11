---
"@paykernel/store-d1": patch
---

Accept Cloudflare's native D1 database binding in store factories by correcting the structural batch return type. Consumers can pass env.DB without casting the binding.
