---
name: drizzle-schema-build-gotchas
description: Two gotchas when adding/changing a table in lib/db/src/schema/index.ts — non-interactive drizzle-kit push failure, and stale composite tsc build hiding new exports
metadata:
  type: project
---

## drizzle-kit push fails non-interactively if the DB has any table drizzle doesn't manage

Running `pnpm run push` (or `push-force`) from `lib/db` throws `Error: Interactive prompts require a TTY terminal` even for a purely additive new table, whenever the live DB has a table that isn't in the Drizzle schema at all. In this repo that's the `session` table (owned by `connect-pg-simple`, never defined in `schema/index.ts`). drizzle-kit's `tablesResolver` sees "1 removed, 1 added" and tries to prompt "did you rename X to Y?" — which can't render without a TTY, so it just throws.

**Why:** confirmed 2026-07-23 adding the `fetch_queue` table — diffed `pg_tables` against every `pgTable(...)` name in the schema file and the *only* mismatch was `session` (DB-only, expected). No actual rename ambiguity existed; drizzle-kit's heuristic just can't tell that from outside a TTY.

**How to apply:**
1. Before assuming `pnpm run push` will work, run this diff to confirm the only DB-not-in-schema table is `session`:
   ```bash
   grep -o "pgTable('[a-z_]*'" lib/db/src/schema/index.ts | sed "s/pgTable('//;s/'//" | sort > /tmp/schema_tables.txt
   psql "$DATABASE_URL" -Atc "select tablename from pg_tables where schemaname='public'" | sort > /tmp/db_tables.txt
   comm -13 /tmp/schema_tables.txt /tmp/db_tables.txt   # DB-only (expect: session)
   comm -23 /tmp/schema_tables.txt /tmp/db_tables.txt   # schema-only = new tables to create
   ```
2. If the only diff is `session` plus your genuinely-new table(s), don't fight the prompt — just apply the equivalent `CREATE TABLE ... ; CREATE INDEX ...;` directly via `psql "$DATABASE_URL"`, matching the Drizzle column types/defaults exactly (snake_case columns, `timestamp with time zone`, etc.). Re-run the diff above afterward to confirm schema and DB are back in sync.
3. Don't burn a second attempt with `push-force` first — it hits the exact same TTY wall (force only skips destructive-data warnings, not the rename-resolver prompt).

## Composite tsc project cache goes stale after editing schema/index.ts

`lib/db` is a composite TS project (`tsconfig.json` has `composite: true`, `emitDeclarationOnly: true`, `outDir: dist`) with a checked-in `tsconfig.tsbuildinfo`. After adding a new export (e.g. a new `pgTable`) to `src/schema/index.ts`, downstream packages' `tsc --noEmit` (e.g. `artifacts/api-server`) will report `Module '"@workspace/db"' has no exported member 'X'` even though the source is correct — because they resolve against the stale `lib/db/dist/*.d.ts`.

**Why:** confirmed 2026-07-23 — `fetchQueue` export was present in source but api-server's `tsc --noEmit` failed until `lib/db`'s declaration output was rebuilt.

**How to apply:** after any edit to `lib/db/src/schema/index.ts` (or any other `lib/db/src` file), run `npx tsc -b lib/db` from the repo root before typechecking or trusting typecheck results in any package that imports `@workspace/db`. This is separate from the runtime build (`node build.mjs` in api-server bundles from source via esbuild and isn't affected) — it only matters for `tsc --noEmit` correctness.
