# Path to best-realistic Stock DB quality

> Goal: maximize **honest filled/total** coverage and **mediated multi-source gold**,
> without fighting nightly enrichment or burning rate limits.
> Not 100% fill — “best realistically possible.”

Canonical for Cursor agents. Prefer this over re-auditing from scratch.

---

## 1. Definition of done (“best realistic”)

| Metric | Target | Non-goal |
|---|---|---|
| Needs Review | **≤ 250** and trending down | Zero NR |
| PEG / Fwd PEG filled | **Stable ~40–45%** | 100% (growth gate is correct) |
| P/E filled | **≥ 85%** (~475+) of universe | Fill loss-makers with fake PE |
| Core quality (rev, NI, EPS, margins, ROE) | **≥ 97%** | |
| Op margin / P/B / ROA / currentRatio | **≥ 95%** filled; NR on these **≪ 40 each** | |
| EBITDA / FCF / ROIC | **≥ 90%** | |
| Tech rows | **≥ 540/558**; missing = delisted/dotted only | Force indicators on dead tickers |
| Provenance honesty | Gold null ⇒ **no** stale `winning_source` | |
| Nightly | Ad-hoc work **never** holds `enrichmentRunning` during schedule window | |
| FactSet | ≤ **40–80/day** for referee after catch-up (leave headroom) | Exhaust 500 every day |

When the table above holds for **7 consecutive days**, unlock: unify scorers + sector-scoring UI cutover.

---

## 2. Operating rules (rate limits + nightly)

### Budget owners
| Source | Daily cap (config) | Who may spend |
|---|---|---|
| yahoo / edgar / polygon | high | Nightly first; ad-hoc only stale/null cohort |
| finnhub | 60 | Nightly cohort; **do not** double-fetch same day |
| fmp | 220 (9 calls/ticker) | Nightly scarce cohort only |
| alpha_vantage | 25 | Nightly scarce only |
| factset | 500 | **Referee only** after free merge; default drain `--max=40` |

### Non-interference contract
1. **Shared mutex** — all enrich goes through `enrichmentRunning` / `enrichAndMergeTickers({ respectMutex: true })`.
2. **Ad-hoc FactSet drain** = `runFactsetReferee` + `runMergeTrusted` only — **no** free-source re-fetch (zero yahoo/fmp burn).
3. **Ad-hoc free enrich** only via `maintain --enrich-if-due` or enrich with `sources` subset for tickers with null primitives — never full 558 outside nightly.
4. **UTC schedule window** (nightly ~02:00 UTC Sun/Thu): agents must not start multi-hour enrich; FactSet drain ≤40 is OK.
5. **Cohort rotation** (`COHORT_MODULUS=14`) stays the scarce-source fairness mechanism — do not bypass for “fix everything today.”

### Token-efficient agent protocol
1. Read **this file** — do **not** re-explore the whole pipeline. Historical snapshots (2026-09-28) live under `.cursor/plans/archive/` if you need old NR numbers.
2. One phase per session unless user says otherwise.
3. Scoreboard = SQL filled/total (same as UI), not null monologues.
4. After user corrections → `session-lesson-cursor.js add` (see L-2026-09-28-01).
5. No scoring unify until §1 green for 7 days.

---

## 3. Two levers (keep separate)

### A. Coverage (fill nulls)
Prefer **derive from gold primitives** (0 API calls) → **free bronze null-fill** (budgeted) → **FactSet null fill** (scarce).

| Field class | Realistic ceiling | Lever |
|---|---|---|
| PEG / Fwd PEG | ~40–45% | Own formula; leave null when growth gate fails |
| P/E | ~85–90% | price/EPS; null if EPS≤0 |
| Margins / ROE / D/E / ROIC | high 90s | Derive when legs exist |
| EBITDA / FCF / debt / shares | high 80s–90s | Free enrich + FactSet overview |
| Growth rates | already high fill; noisy | Mediate/SKIP — not “more fetch” |

### B. Mediation (source disagreements)
Prefer **definition SKIP** → **normalize units at populate** → **FactSet referee on material NR** → **manual override** (last resort).

| Pattern | Action | API cost |
|---|---|---|
| Incompatible defs (PEG, beta, D/E, growth period, totalDebt leases) | `DIVERGENCE_SKIP` + own derive where possible | 0 |
| Unit/scale bugs (Finnhub DY) | Fix once in `populate-source-fundamentals` | 0 ongoing |
| Material free-source fight FactSet can see | `drain-needs-review --max=40` | 1 FactSet/ticker |
| Residual after referee | manual_overrides | 0 |

---

## 4. Phased roadmap

### Phase 0 — Honesty + scoreboard (0 API) — **do first**
**Why:** Wrong provenance wastes every future review.

1. Merge: when derived PEG/FwdPEG is null, **DELETE** `field_provenance` for that (ticker, field); never leave yahoo winner.
2. Fix merge log so changedFields reflects post-derive values (noise → false PEG regressions).
3. `scripts/data-ops-audit.mjs` (or small SQL view) prints **filled/total** per Stock DB column + NR by field + FactSet remaining.
4. Fixture test file (3 cases): ZTS PEG derived; AAPL DY scale; AFRM NR settles with FactSet present.

**Done when:** 0 stale yahoo PEG provenance on null gold; audit script one command; fixtures green.

### Phase 1 — Coverage from derives (0 API)
1. Keep/expand fillIfMissing: opMargin, ROE, netMargin, D/E, PE, P/B, ROIC (already started).
2. Add gold primitives if missing from sources but cheap: store `forwardEps`, `bookValuePerShare` on gold or ensure silver always has them for derive.
3. Universe hygiene: mark delisted/dotted (`STOR`, `SKX`, `BF.B` Yahoo quirk, etc.) `fetch_fundamentals=false` **or** map to Yahoo symbol — removes fake tech/fund gaps.

**Done when:** opMargin/ROE/D/E nulls near floor; tech missing ≤ delisted set; PEG filled only via formula (no vendor gold).

### Phase 2 — Mediation without burn (0–low API)
1. Document field assumption table in Stock DB UI tooltip or provenance route (TTM vs FY, lease debt, DY decimal).
2. SKIP list finalized (growth, totalDebt, beta, PEG family) — NR only for **actionable** fights.
3. Raise/tune ABS floors only with fixture proof (no silent “make NR look good”).
4. Optional: `period_basis` column later — **defer** until NR ≤250 without it.

**Done when:** NR ≤250 with leaders = P/B, shares, currentRatio-type (FactSet-addressable), not definition noise.

### Phase 3 — Budgeted catch-up (uses API, nightly-safe)
Run **outside** nightly mutex conflict; prefer afternoon local / after nightly completes.

| Day budget recipe | Action |
|---|---|
| FactSet 40 | `drain-needs-review --max=40` (top NR tickers) |
| FactSet 0 if rem &lt; 80 | Skip — protect overnight |
| Free null cohort | `enrichAndMergeTickers(nullPrimitiveTickers, { sources: ['yahoo','finnhub'] })` capped ≤30 |
| FMP/AV | **Nightly only** |

Wire into `maintain.mjs`:
- `--drain-nr[=40]` → FactSet+merge if `factset` remaining ≥ max+20
- `--enrich-if-due` already exists — keep as free catch-up

**Done when:** NR ≤250; PE/EBITDA/FCF at §1 targets; FactSet daily usage steady-state ≤80.

### Phase 4 — Continuous loop (the “ML” analogue)
1. Nightly end: write `enrichment_runs` coverage before/after (already partially there) + NR snapshot.
2. Weekly: one agent session reads audit output only (token-cheap), runs Phase 3 recipe if off-target.
3. Lessons on every user correction.
4. **Then** unify client/server scorers + sector-scoring Phases 0–2.

---

## 5. What not to do

- Full-universe ad-hoc enrich “to be sure”
- FactSet as preferred gold writer for every field
- Vendor PEG voting back into gold
- Unifying scorers before §1 holds
- Expanding FactSet reports before overview referee is saturated
- Re-auditing the pipeline from scratch each chat

---

## 6. Agent session templates (copy-paste)

**Session A — Phase 0 honesty**
> Read `.agents/context/stock-db-best-realistic.md` Phase 0. Fix provenance clear-on-null + audit filled/total. No API fetches. Fixtures for ZTS/AAPL/AFRM.

**Session B — Phase 1 derives + universe**
> Read same plan Phase 1. Expand derives if gaps remain; quarantine delisted. No FactSet unless user asks.

**Session C — Phase 3 drain**
> Check `data_sources.factset` remaining. If ≥60: `drain-needs-review --max=40`. Report filled/total + NR delta. Stop.

---

## 7. Field assumption cheat-sheet (mediation)

| Field | Cross-stock OK? | Notes |
|---|---|---|
| pegRatio / forwardPeg | Only derived | Vendor PEG skipped; growth gate may null |
| epsGrowth / revenueGrowthYoY | Noisy | TTM vs FY — SKIP NR |
| totalDebt / debtToEquity | Partial | Lease (ASC 842) defs differ — SKIP NR; D/E derived |
| dividendYield | Yes if decimal | Finnhub: `v>0.2 → ÷100` at populate |
| operatingMargin / netMargin / ROE | Yes if derived or FactSet-settled | Prefer derive from legs |
| peRatio | Yes if EPS>0 | Null for losses is correct |
| beta | No | Different lookbacks — SKIP NR |

## 8. Weekly agent
Skill: `.cursor/skills/weekly-data-ops-check.md`  
Script: `node scripts/weekly-data-ops-check.mjs`  
Value log: `.agents/context/data-ops-value-log.md`

## 9. Baseline note
See value log for live numbers after Phase 0–4 execution.
