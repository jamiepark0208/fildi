---
name: Express route ordering — specific before wildcard
description: Specific string routes must be registered before wildcard/param routes in Express.
---

**Rule:** In Express, `router.get("/options/position-quote", ...)` must be declared BEFORE `router.get("/options/:ticker", ...)`. If the wildcard is first, it captures "position-quote" as the `:ticker` parameter.

**Why:** Express matches routes in registration order. A path parameter like `:ticker` matches any string including "position-quote".

**How to apply:** Always register specific literal-path routes above wildcard routes in the same router file. This applies to all `routes/*.ts` files in the api-server.
