---
"@paykernel/core": patch
---

Move request validation to zod 4 (`^4.6.7`). zod 3 has no release patched for GHSA-mrhx-c7xc-m3w5, a memory exhaustion while validating oversized constrained collections. Behaviour is unchanged: records keep string keys, UUID fields keep zod 3's permissive 8-4-4-4-12 match (`z.guid()`), and `InvalidRequestError` details carry the zod issue list as before.
