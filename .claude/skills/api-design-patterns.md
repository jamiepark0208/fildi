# API Design Patterns — FILDI

## Auth
Primitives: req.session.userId (number), req.session.role ('admin'|'member')
Middleware location: artifacts/api-server/src/middleware/
- requireAuth — 401 if no session
- requireAdmin — 401 if no session, 403 if not admin
- validate(schema) — Zod validation middleware factory

Always apply requireAuth or requireAdmin before route handlers.
Never trust req.body without validate() middleware on mutating routes.

## Validation pattern
```ts
import { z } from 'zod'
import { validate } from '../middleware/validate'

const mySchema = z.object({
  ticker: z.string().min(1).max(10),
  value:  z.number().positive(),
})

router.post('/route', requireAuth, validate(mySchema), async (req, res, next) => {
  // req.body is typed and validated here
})
```
Zod schemas live in: artifacts/api-server/src/lib/validators/

## Error handling
Never call res.status(500) directly in route handlers.
Always use next(err) — the global error handler in middleware/errorHandler.ts
catches it and returns { code, message } JSON with no stack trace leakage.

```ts
try {
  // ...
} catch (err) {
  next(err)  // always this, never res.status(500).json(...)
}
```

## Rate limiting
generalLimiter (200 req/15min): applied globally in app.ts — no action needed
authLimiter (20 req/15min): apply to any auth-related route manually
Import: import { authLimiter } from '../middleware/rateLimiter'

## Route file structure (follow this order)
1. Imports
2. Cache instances (TTLCache, exported)
3. Validation schemas (or import from lib/validators/)
4. Router definition
5. Route handlers (keep thin — call lib/ functions, don't inline business logic)
6. Export router

## Admin-only endpoints
These are always requireAdmin — never open them up:
- POST /api/fundamentals/refresh
- POST /api/technicals/refresh
- POST /api/admin/invite
- GET/DELETE /api/admin/cache/*

## No background jobs
This is a prototype. No setInterval, no cron, no polling.
Data freshness is handled by TTL caches and manual admin refresh.
If you are about to add a background job — stop and discuss first.

## DB patterns
ORM: Drizzle. Schema: lib/db/src/schema/index.ts
After any schema change:
  1. cd lib/db && npx drizzle-kit push
  2. cd lib/db && pnpm build  (rebuilds compiled dist so other packages see new exports)
Forgetting step 2 causes "missing export" tsc errors in api-server.

## Numeric fields from Postgres
Drizzle returns numeric() columns as strings. Always parse before returning:
  const value = parseFloat(row.someNumericField ?? '0')
Or use a shared helper if one exists in lib/utils.ts.

## Social / Feed conventions
- Max 3 OPEN trade posts per user (enforced server-side)
- PnL formula: (premiumPerContract - closePremium) × contracts × 100
- Market snapshot fields (ivRankAtEntry etc.) are auto-populated at
  submission from scanner data — never ask user to enter them
- Status flow: OPEN → CLOSED | EXPIRED_WIN | EXPIRED_LOSS | ASSIGNED
- No auto-resolution job — manual only in prototype