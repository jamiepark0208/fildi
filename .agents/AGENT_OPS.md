# AGENT_OPS.md — multi-agent operations (Muse-owned, 2026-10-17)

How we measure agent work, grade the skeptic, avoid collisions, and route by budget.
All agents read this. Changes proposed via ASKS Reviews, not silent edits.

## 1. Outcome ledger — agent ROI (Muse owns this)

The Agents tab shows *activity*. This shows *achievement*. Every verified ASKS row gets an
outcome review 2–4 weeks post-ship, run by Muse as a monthly audit (first: Nov 2026 dev loop).

Ledger: `research/common/OUTCOMES.md`, one row per shipped row:

| Row | Shipped | Agents (git trailers) | Need (one line) | Verdict | Measured how | Tokens | Reviewed |
|-----|---------|----------------------|-----------------|---------|--------------|--------|----------|

- **Verdict:** `worked` / `partial` / `failed` / `unknown`. `unknown` is honest, not failure — it means unmeasured.
- **Measured how:** a number when possible (Brier delta, before/after metric), "judgment call" when not. No invented numbers.
- A row with no measurable outcome 4 weeks after shipping gets flagged in the audit — either measure it or admit it was activity, not achievement.

## 2. Skeptic scoreboard — grading the skeptic

Skeptic ≠ right. Every Grok `challenge` verdict and every Claude decline gets a later grade:

| Date | Skeptic | Target (row/commit) | Claim (one line) | Right? | Evidence | Graded |
|------|---------|---------------------|------------------|--------|----------|--------|

- **Right?** `yes` / `no` / `partial`, judged when the target ships or the decline's revisit trigger fires.
- A skeptic with a low hit rate gets tuned down (fewer reviews), not removed — Jamie decides.
- This is the falsification mechanism the skeptic role was missing.

## 3. Task claims — anti-collision mechanism

A pure "say you're claiming it" convention rots. This is file-based but has **expiry**, which makes it a mechanism:

- Claim = `.agents/claims/<slug>.json`: `{"agent": "...", "task": "...", "claimed_at": "...", "heartbeat_at": "..."}`
- **Before starting a task:** check the dir. Live claim (`heartbeat_at` within 2h) → hands off, pick something else.
- **While working:** refresh `heartbeat_at` hourly (or per commit).
- **Expiry:** no heartbeat for 2h → claim is dead, anyone may take over. No permission needed.
- **Done:** delete the claim file on ship.
- Honest limit: this works only if every agent checks before starting. New agents get this file on onboarding. It prevents *starting* the same task twice; `agent-git-sync.sh` still handles merge mechanics.

## 4. Budget routing table (formal)

Cheapest agent that can do the job correctly. Judgment → Claude; bulk → Kiro/Cursor; verification → Muse; inference → Mac.

| Agent | Cost | Scarce? | Do | Don't |
|-------|------|---------|----|-------|
| Muse | $0 (weekly free) | No | ideate, verify, repo watch, outcome audits, coordination | bulk builds |
| Claude Pro | $20/mo, 5h rolling window | **YES — scarcest** | quant review, judgment calls, scores | bulk work, long test loops |
| Cursor | student free, expires Dec 11 | Time-boxed | builds until expiry | — |
| Kiro | free 50/mo or student 1000/mo | Credits | spec-driven budget builds | — |
| Grok Bot | **draws Cursor plan** | Shared with Cursor | reviews only (≤5 findings, tight) | builds, long loops |
| Mac local (MLX) | $0 tokens, Mac time/heat | No | inference, backtests, batch jobs | — |

Notes:
- Grok reviews are **not free** — they burn Cursor credits. Keep them tight; that's what the ≤5-findings cap is for.
- Muse pre-verification exists to protect Claude's window — route accordingly.
- Revisit after Dec 11 (Cursor expiry): Kiro or Claude Code absorbs the build lane.
