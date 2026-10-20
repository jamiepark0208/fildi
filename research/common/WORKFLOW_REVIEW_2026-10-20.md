# Workflow review — 2026-10-20 (Muse, at Jamie's request)

Jamie's complaint, verbatim in substance: "I have so many agents, but I keep running around writing prompts for each agent. There's been a lot of development lately, and it's difficult to understand what needs further enhancement."

## 1. How work actually flows today (verified from repo, 2026-10-20)
- Queue: ASKS.md = 176 rows. 100 done, 25 closed-other, 12 parked, 19 open, 9 planned, ~11 partial/other. Route asymmetry: **Muse → Cursor = 91 rows** — Muse originates, Cursor builds; Claude → Cursor 32; Grok originates ~13; **Codex is already filing and building** (A207, A208, A212, routes "Jamie → Codex", "Codex → Claude") with no agreed lane.
- Machinery that exists: AGENT_OPS.md (outcome ledger, skeptic scoreboard, task claims, budget routing), per-agent adapters, agent-git-sync, heartbeats (Stage orbs), AgentsTab Inbox with phase colors, repo watch (4h, Muse), Monday dev loop, A166 feature-synthesis doc, A210 workflow learning loop (Claude, filed today, to all agents).
- The loop works when left alone: A194 (1m bars) went Muse plan → Cursor build in ~a day; studies S064/S049/S066 landed without Jamie touching anything.

## 2. Why Jamie still runs around (the leak points)
1. **ASKS rows don't wake anyone.** Each agent polls on its own cadence; Jamie pastes prompts into each chat to accelerate. The paste IS the routing — the repo is the record, not the trigger. This is the core defect.
2. **No aging alarm.** An open row can sit untouched for days and nobody notices except Jamie. (A194 sat a day; A197 sits open now.) Nothing in the system nags — except the human.
3. **Status is fragmented.** Truth is split across the ASKS index, per-file Reviews, Cursor's queue-state file, and the AgentsTab. Jamie cannot see "what needs enhancement" in one place — hence this review having to be commissioned.
4. **Claims discipline is voluntary.** The A179–A182 double-allocation (Oct 19) happened because two agents allocated IDs from a lagging index in the same window. The claims mechanism (AGENT_OPS §3) exists but isn't a filing prerequisite.
5. **Codex has no lane.** It files, builds, and gets review asks (A212) under no agreed scope. Every undefined lane is a future collision.

## 3. Enhancement inventory (by Jamie's categories)
### Features — theme: built > validated
- Validation debt is the backlog: A136 risk-gate backtest (protocol now written), S043 VaR/Kupiec (blocked on daily VaR logging — fix noted in A161), S034 GEX (unparked today, data ready), P10v2 eval (needs Mac run), S037/A143 headline labels.
- A199 (capacity plan) ranks the ~28 open/planned rows against the Dec 11 Cursor cliff. Until it lands, "what's next" is vibes.
### Technologies
- Landed: Schwab 1m bars (A194). Dead: WRDS OptionMetrics (no entitlement). Testing: TradingView MCP (A202). Unbuilt pilots: TimesFM (A138), vol-mispricing E[RV] (A137). Local inference (OpenJev/Ollama pattern) is proven and underused — it's the privacy tier for book-adjacent work.
### Workflows
- Review-push rule + Grok non-quant pilot: working. Outcome ledger: seeded, first real audit due November (Muse owns) — that's when "which agent earns its tokens" stops being opinion.
- A210 (Claude's workflow learning loop) is the right vehicle for fixes 2.2–2.4 below; adopt it instead of inventing parallel process.
### Processes
- Schwab 7-day re-auth: the login itself cannot be automated (Schwab ToS, MFA/bot detection) — the watchdog script is the ceiling and it IS installed on the Mac (com.fildi.schwab-auth-watch.plist, verified 2026-10-20): it watches the 7-day clock and auto-launches the auth window in the signed-in Chrome profile; Jamie only completes the login. (This corrects the first draft of this review, which wrongly said 'not installed.') Token-file check (Muse, via device) remains the backup safety net.
- CI trailer guard trips on md-only pushes (A197 open) — the guard should be fixed, not worked around forever.
- Pre-push working-tree check exists as a lesson, not a mechanism.
### Scheduled tasks (Muse's side)
- 10 goal jobs: 2 briefs, repo watch, dev loop, event prep, weekend dive, AI radar, Schwab reminder, automation audit — all firing.
- **db-quality-audit is permanently blocked** (fildi DB is Mac-local; the job can never succeed from Muse's VM). It produces a blocked report every Monday forever. Kill it or re-scope it to a Mac-side check.
### UI components
- AgentsTab: phases/colors fixed Oct 18; it shows state but not AGING (a row sitting 3 days looks the same as one filed an hour ago).
- Recent ships: Book card VaR line, panic-puts panel (A189), House view card (A190). Desk workflow UX (Cursor's A179) still open.

## 4. The fix (proposal — vehicle: A210 + these additions)
1. **One front door.** Jamie talks to Muse. Every other agent gets its work from the repo. If Jamie has to paste a prompt into another agent's chat, that is logged as a workflow bug (A210's registry), not accepted as normal.
2. **Muse becomes the nag.** Muse's repo watch gains an aging pass: any open row untouched >48h gets a Muse note in its file ("aging: no owner action in 48h") and rows >5 days surface in the Monday dev loop. Jamie never chases again.
3. **One state page.** Extend A166's feature-synthesis into a generated STATE page: queue by owner/status/age, ships this week, validation debt list, blocked items with blockers. Generated, not hand-written — hand-written state docs rot.
4. **Claims before IDs.** Filing protocol (check dir + index + recent commits, claim first) goes into every agent's adapter, not just Muse's practice.
5. **Codex gets a default lane until Jamie rules:** second builder under the same claims/queue discipline; no originating [quant] work. (Jamie's call to change.)
6. **Kill db-quality-audit** or re-scope it Mac-side (Jamie's call — it's his schedule).

## 5. What Muse did with this review
- This doc filed in repo. Aging-nag (4.2) Muse can start inside the existing repo-watch job scope — no new machinery, no Jamie action.
- Nothing above routes through Jamie except the two flagged calls (Codex lane confirmation, DB audit kill).
