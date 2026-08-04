# REPLIT.md — Working Alongside Claude Code on TradeDash

> Read this once at the start of any session where you're reviewing code, operating the
> production server, coding, or troubleshooting bugs/security issues on this repo. It exists
> so you (Replit's agent) and Claude Code operate on the same facts instead of drifting —
> most of the pain in a two-agent setup comes from stale assumptions, not bad reasoning.

## 1. The one thing to get right before touching the backend

**The managed Replit workflow runs `start.sh` → `node dist/index.mjs`. It does NOT hot-reload.**

Confirmed live (re-verify anytime with the commands below):
```
pgrep -af start.sh        # expect exactly 2: api-server/start.sh, stock-compare/start.sh
pgrep -af dist/index.mjs  # expect exactly 1
```

`artifacts/api-server/start.sh` builds once via `node build.mjs`, then loops
`PORT=8080 node --enable-source-maps dist/index.mjs` in a crash-restart loop. Editing
`api-server/src/**` does **nothing** to the running server until you rebuild and restart —
see §2.

**Do not treat a `tsx watch` process as evidence the managed workflow hot-reloads.** You may
occasionally see one in `ps aux` (PID varies) — that's `pnpm run dev:watch`, a manual
convenience for a bare terminal session *outside* `.replit`'s supervisors (documented in
`.claude/skills/build-and-run.md`). It is not part of the managed workflow and may be a stray
leftover from a prior session. If you see one, don't assume it means edits are live; verify
against `pgrep -af start.sh` instead.

Frontend (`stock-compare`, Vite on port 8081) is the opposite — it genuinely hot-reloads.
Only the API server needs the manual rebuild cycle.

## 2. Backend rebuild + restart procedure

Full reference: `.claude/skills/build-and-run.md` (read it before any `api-server/src/**`
change — it also covers 502 diagnosis and log locations).

```bash
cd artifacts/api-server && node build.mjs                              # Step 1: build
pkill -f "node --enable-source-maps dist/index.mjs"                    # Step 2: kill the CHILD only
sleep 3
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/daily-brief   # Step 3: expect 200/401
```

**Never kill `start.sh` itself, and never kill anything with `ppid 24`** (Replit's own
platform supervisor — it launches processes outside the two `.replit` workflow tasks that
look redundant but may not be). Killing the wrong thing has taken down the entire workflow
before (both supervisors, not just the target) — see the incident writeup in
`.claude/skills/build-and-run.md` under "NEVER kill a process whose parent is PID 24" for
exactly what went wrong and why "looks like a safe stray" was the wrong call. If
`pgrep -af start.sh` ever shows fewer than 2 processes, you cannot recover it yourself —
report it and ask for a Stop/Run from Replit's UI, don't hand-construct a replacement process
(it won't have the injected secrets).

## 3. Persistent context — where the facts live

| File | What it is | Freshness |
|---|---|---|
| `CLAUDE.md` | Project conventions, hot-file index, response style | Stable — read once, re-check if it feels stale |
| `.claude/state.json` | Session handoff: phase, working/blocked/next as **short tags** | Rewritten every session — always current, but only as good as the last wrap |
| `.claude/skills/*.md` | Task-specific playbooks (build-and-run, systematic-debugging, api-design-patterns, db-patterns, caching-patterns, etc.) | Durable — load the one relevant to your task before starting |
| `.agents/memory/` | Durable cross-session lessons (port conflicts, route ordering, library gotchas) | Durable — separate from Claude's own memory, keep your own additions here too if you want them to persist for you specifically |
| `.agents/sessions/claude-*.md` | Full session log, one file per day, untruncated | Historical — use for "what happened on date X," not current state |
| `.agents/AGENTS.md` | Agent roster and handoff protocol (which agent owns what) | Stable |
| `git log` | Ground truth for what actually shipped | Always current |

Read order at session start: `CLAUDE.md` → `.claude/state.json` → the one skill file for
your task category → `git log --oneline -5` to confirm state.json isn't stale relative to
what's actually committed.

## 4. Codegraph — use it before opening any file

Codegraph is installed and indexed (383 files, 5,691 nodes as of this writing) and available
via shell:

```bash
codegraph status                       # confirm index freshness
codegraph context "<task description>" # symbols + callers/callees before touching anything
codegraph impact <symbol>              # what breaks if you change this
```

This is not optional polish — reading whole files speculatively instead of getting targeted
entry points first is the specific failure mode that has caused analysis errors in this repo.
Treat "I don't know where X lives" as a `codegraph context` call, not a `grep -r` fishing
expedition or a full-file read.

## 5. File-reading discipline

Full rule set: `.claude/skills/file-reading-strategy.md`. The short version:

1. **Never read a `.ts`/`.tsx`/`.js` file in full.** `codegraph` or `grep` first, always.
2. If `grep` returns nothing, trust that — don't open the file "just to check."
3. Only read with a line number in hand, using a tight `offset`/`limit` window (~20-30 lines)
   centered on it.
4. Uncertainty is not a reason to read speculatively — if codegraph and grep both come up
   empty, ask rather than opening files hoping to stumble onto the answer.

Also never read: `node_modules/**`, `dist/**`, compiled `.mjs`, `pnpm-lock.yaml`,
`package-lock.json`, `lib/*/dist/**`, `*.map`, `.cache/**`, `artifacts/*.json` (live data
caches — use the API instead).

## 6. What you have that Claude Code doesn't (use these — they're genuinely better here)

- **Workflows/Restart** — controlled restart with timeout, cleaner than Claude's manual
  `pkill` + `sleep` + curl-poll loop.
- **Screenshot / live browser access** — Claude currently has no visual verification path
  (Playwright is disabled by user preference; verification is manual via Replit preview).
  This is a real gap on Claude's side — if you're touching UI, you can close the loop Claude
  can't.
- **A broad-sweep explore subagent** — better than a single `codegraph_context` call for
  open-ended "how does this whole area work" questions spanning many files.
- **Your own memory store** — keep it separate from `.agents/memory/`; don't try to merge
  them, they're independent per-agent stores that happen to describe the same codebase.

## 7. What's genuinely not replicable, and the workaround

Claude Code's `UserPromptSubmit` hook (`.claude/scripts/rehydrate.js`) auto-injects
`state.json` + `git log` + `codegraph status` into context on **every single prompt**,
without being asked. There's no equivalent plugin hook available to you, so the workaround is
discipline, not architecture: run this at the start of every session, not just when you
remember to —

```bash
node .claude/scripts/rehydrate.js
codegraph sync && codegraph status
```

then read `.claude/state.json` and skim `.agents/memory/MEMORY.md`. Treat *not having done
this yet in the current session* as a reason to be more conservative before restarting
processes or touching shared state — Claude doesn't need that caution because the hook
guarantees it never starts blind; you do, until the manual step is habitual.

The permission allowlist in `.claude/settings.local.json` (Claude Code's explicit bash
command whitelist) also has no equivalent for you — you run with broader access in this
environment, which is expected and fine, just worth being aware the two agents operate under
different constraint models on the same repo.

## 8. Review / security / production-troubleshooting specifics

- **Bug investigation**: follow `.claude/skills/systematic-debugging.md` — root cause before
  any fix, no exceptions. Its Iron Law: no fix proposals until Phase 1 (reproduce + trace) is
  complete.
- **Security-sensitive surfaces** (per `CLAUDE.md`'s key files list): rate limiting
  (`middleware/rateLimiter.ts`), error handling (`middleware/errorHandler.ts`), input
  validation (`middleware/validate.ts`), auth validators (`lib/validators/auth.ts`), admin
  endpoints (`routes/admin-cache.ts`, `routes/auth.ts`, `routes/fundamentals-provenance.ts`).
- **Never read `/proc/<pid>/environ` or probe individual secret env var presence** — both leak
  secret information into the conversation transcript. Use the health endpoint to confirm
  secrets are loaded instead of inspecting them directly.
- **API route conventions**: route files omit the `/api` prefix (added once at mount time in
  `src/index.ts`); specific routes must be declared before wildcard routes on the same base
  path (e.g. `/options/position-quote` before `/options/:ticker`) or the wildcard will shadow
  them.
- Full endpoint catalog: `.agents/context/api-endpoints.md`.

## 9. A note on `replit.md`

There's a separate, still-unpopulated `replit.md` (lowercase) at repo root — a generic
scaffold template, not this document. Don't conflate the two; this file is the
Claude-Code-workflow-parity doc, that one is a different (currently empty) project-overview
template.
