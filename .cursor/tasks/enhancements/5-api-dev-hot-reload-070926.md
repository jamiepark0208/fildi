# api-dev-hot-reload

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | infra |
| **Effort** | S (~30–60 min) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | `.claude/skills/build-and-run.md` |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Give api-server a watch-mode dev path so backend edits don’t require a full esbuild rebuild + manual restart every time.

### Cache / DB compliance
None. Dev DX only. Production build stays esbuild.

---

## 1. Executive summary (rescoped)

**Do not** replace production `build.mjs` / `dist/index.mjs` with tsx.

**Do** add a `dev:watch` (or replace `dev`) script using **tsx watch** on `src/index.ts`. `tsx` is already in the workspace **pnpm catalog** (`tsx: ^4.21.0`) — add it as an api-server `devDependency` via `catalog:`. Update [build-and-run](../../../.claude/skills/build-and-run.md) which currently documents **NO hot-reload** and Replit-only paths.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| No hot-reload today | build-and-run skill L11; `dev` = build + start | Friction |
| Current `dev` script | api-server package.json L7 | `build && kill-port && start` |
| Frontend already HMR | Vite | Backend is the gap |
| Prod path must stay | esbuild + pino plugin | tsx = development only |
| PORT required | index.ts L12–15 | Watch still needs env |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Add `tsx` devDependency (`catalog:`) to api-server |
| W2 | Add `dev:watch` script; keep `build` / `start` / optionally keep old `dev` as `dev:rebuild` |
| W3 | Smoke: edit a route → save → next request reflects change without manual `build.mjs` |
| W4 | Update `.claude/skills/build-and-run.md` (and note in CURSOR if needed) |

### Out of scope
| Item | Reason |
|---|---|
| Changing Vite / frontend HMR | Already works |
| Removing esbuild prod | Forbidden |
| Docker/compose redesign | Separate |
| Fixing pnpm esbuild platform overrides for Darwin | Pre-existing workspace issue — don’t expand scope unless watch blocked on Mac |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| `dev` = full rebuild | `"dev": "export NODE_ENV=development && pnpm run build && node ./kill-port.mjs … && pnpm run start"` |
| `start` | `node --enable-source-maps ./dist/index.mjs` |
| No tsx in api-server deps | package.json devDependencies — esbuild only |
| tsx in catalog | `pnpm-workspace.yaml` catalog `tsx: ^4.21.0` |
| index requires PORT | throws if missing |
| index side effects on listen | runSeed + stale fundamentals/technicals — OK for local watch; expect vendor/DB |
| SESSION_SECRET / DB | app.ts needs them at import — same as today |
| Skill docs | build-and-run: “NO — must rebuild”; Replit `/home/runner/workspace` paths |
| kill-port.mjs | Used by current `dev` — keep for crash leftovers |

### 4.2 Files to modify (authoritative)

| Priority | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/package.json` | Add tsx + scripts per §4.5 |
| **P0** | `.claude/skills/build-and-run.md` | Document `dev:watch`; mark rebuild path as prod/fallback; fix “NO hot-reload” |
| **P2** | `CURSOR.md` or session note | Optional one-liner for Cursor agents |
| — | `build.mjs` | **Do not remove** |
| — | `index.ts` / `app.ts` | No change unless path-alias issue forces tiny fix |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `build.mjs` | Prod bundler + pino plugin |
| `kill-port.mjs` | Reuse if watch leaves zombies |
| `tsconfig.json` | Paths for `@workspace/*` — verify tsx resolves |
| pnpm-workspace catalog | Use `catalog:` for tsx version |

### 4.4 Recommended approach

**Option A (recommended): tsx watch**
```json
"dev:watch": "tsx watch --clear-screen=false src/index.ts",
"dev:rebuild": "export NODE_ENV=development && pnpm run build && node ./kill-port.mjs 2>/dev/null; true && pnpm run start",
"dev": "pnpm run dev:watch"
```
Or keep `dev` as rebuild for Replit muscle memory and advertise `dev:watch` — **prefer making `dev` = watch** once smoke passes (skill update must match).

**Env (same as today):**
```bash
export NODE_ENV=development
export PORT=8080
export SESSION_SECRET=…   # required
# DATABASE_URL / FRONTEND_URL as local setup already requires
```

**Option B:** esbuild `--watch` + node `--watch` on dist — still slower; only if tsx fails on native addons (grep showed no `.node` deps in api-server package.json).

### 4.5 Acceptance criteria

- [ ] `pnpm --filter @workspace/api-server dev:watch` (or new `dev`) starts and serves `/api/healthz`
- [ ] Edit `routes/health.ts` response or log → save → reflected within ~3s without running `build.mjs`
- [ ] `pnpm --filter @workspace/api-server build && start` still works (prod path)
- [ ] build-and-run skill no longer says hot-reload impossible; documents watch command (Cursor-friendly paths, not only Replit)
- [ ] tsx is `catalog:`-aligned; not a random floating major
- [ ] No change to production Dockerfile/start if any

### 4.6 Suggested commit message

`feat(api-server): add tsx watch dev server`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| Local Postgres + env | Same as current `dev` |
| None blocking from enh/3–4 | Independent DX |

### 4.8 Algorithm / smoke

```
1. pnpm --filter @workspace/api-server add -D tsx@catalog:
2. Add scripts; run with PORT=8080 SESSION_SECRET=test …
3. curl localhost:8080/api/healthz → {"status":"ok"}
4. Change health handler string temporarily → save → curl again
5. Revert; run production build once to confirm untouched
6. Update build-and-run.md table: api-server restarts on change? Yes (tsx watch)
```

---

## 5. Data note
Watch mode still talks to real local DB/session — not a test harness.

## 6. Impact & Risk Analysis

### 1. Blast radius
- package.json scripts + skill doc
- Rollback: remove watch script; restore old `dev`

### 2. Bug introductions
- Path alias `@workspace/db` fails under tsx — verify; may need `tsx --tsconfig`
- Agents still follow old skill “always rebuild” — **must** update skill
- Prod accidentally uses tsx — keep `start` on dist only
- Watch + seed storms on every restart — existing behavior; document
- Catch: prod build after watch session still green

### 3. Performance
- Target: edit→serve &lt;3s vs 10–30s rebuild

### 4. Workflow
- Before: build every change  
- After: watch by default  
- Replit users: skill should show both watch and rebuild

### 5. Drift
- Paired: package.json `dev` ↔ build-and-run.md
- Owner: same PR

### 6. Scalability
- Fine for single local server; not a cluster story

**Do not:** remove esbuild; use tsx in production start.  

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Need:** tsx watch + skill update.  
**Better:** catalog already has tsx; biggest risk is stale build-and-run skill + env (PORT/SESSION_SECRET) same as today.
