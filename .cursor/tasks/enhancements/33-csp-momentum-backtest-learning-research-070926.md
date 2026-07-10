# csp-momentum-backtest-learning-research

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | research → data / scoring / jobs |
| **Effort** | M (research); build phases spawn after |
| **Created** | 2026-07-09 |
| **Source** | user — momentum drivers (news vs technical), strike regret, historical learning |
| **Research parent** | [feature-purpose-research](1-feature-purpose-research-070926.md); floors via [ai/1](../ai/1-agentic-workflow-research-070926.md) **R4**, **R8** |
| **Related** | [ai/14](../ai/14-product-ai-trader-account-research-070926.md) (consumes drivers + regret into memory), [enh/30](30-liquidity-money-flow-research-070926.md) (31/32 liquidity stubs — **do not reuse seq**), [enh/12](12-stock-breakdown-sections-improvements-070926.md) (catalysts SSOT / L-05), [enh/6](6-analyst-data-persistence-070926.md), [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md) |
| **Type** | RESEARCH (locks taxonomy + band regret + replay store before 34/35) |
| **Impl research** | 2026-07-09 (this file) — **no app code** |

### Purpose
Teach the stack (and FILDI AI) to **label why a name is moving**, learn from CSP outcomes via **band-constrained strike regret**, and improve rules through **historical replay** — without claiming a single “correct” strike or fine-tuning an LLM.

### Cache / DB compliance
Prefer `prices_historical`, `ticker_technicals`, `yahoo_short_ratio` (already on Yahoo fundamentals path), server `buildCatalysts`. New: option **decision snapshots** + optional `ticker_news_headlines`. **No** Redis. **No** full OPRA history buy without budget. **No** silent mutation of `computeOptionScore` weights (R4).

---

## 1. Executive summary

**Honest limits:**

- News/fundamental momentum ≠ scraping the open web as the model — use **vendor news + keyword/catalyst density** on top of [`lib/catalysts.ts`](../../artifacts/api-server/src/lib/catalysts.ts).  
- Technical / squeeze momentum = existing tech components + RS + **short interest already partially stored** (`yahoo_short_ratio`).  
- “Should have sold a riskier strike” has **no unique truth** — use **band regret** only (same delta/OTM/liquidity band as the scorer).  
- Learning = **rule replay + features into ai/14 memory**, not weight fine-tunes.

**Seq note:** Liquidity follow-ons remain **31 plumbing / 32 rotation** ([enh/30](30-liquidity-money-flow-research-070926.md)). This research is **33**; builds spawn **34** (data enrichment) and **35** (replay + band regret).

---

## 2. Momentum driver taxonomy

### 2.1 Labels (attach to AI ideas + optional scanner chips)

| `momentum_driver` | Meaning |
|---|---|
| `fundamental_catalyst` | Earnings proximity, analyst up/down, event-keyword news density high |
| `technical_momentum` | Tech score / RS / volume / BB-squeeze / short-interest stress without catalyst density |
| `mixed` | Both sides above thresholds |
| `income_only` | CSP income/IV attractive; neither driver strong |

**Algorithm owner:** deterministic rules first; LLM only explains the label (R4).

### 2.2 Signal → data map

| Driver | Signals to use | In repo today? | Gap |
|---|---|---|---|
| Fundamental / news | `buildCatalysts` lines; expand `EVENT_KEYWORDS` (product launch, buyback, guidance, etc.); earnings ≤14d; analyst up/init | Yes — catalysts + breakdown news | Universe-wide news persist; rate limits |
| Technical | Tech total + components; `vsSpy`; volume spike; BB squeeze (already in technical-rankings vol state) | Yes — `ticker_technicals` / scorecard | — |
| Short squeeze proxy | `yahoo_short_ratio` (Yahoo backfill / nightly enrichment) | **Partial** — column exists on fundamentals Yahoo fields | Confirm freshness; days-to-cover if available |
| Options microstructure | IV rank, skew, strike IV vs realized | Yes — option scorer / technicals | Unusual options volume — research if Yahoo exposes enough |
| Macro / liquidity | Regime; Net Liq / sector leadership | Regime yes; Net Liq after enh/30–31 | Soft input to AI select |

### 2.3 Catalyst / news data sources (pick in research execution)

| Source | Use | Limit |
|---|---|---|
| Yahoo search/news (brief already) | Per-ticker headlines | Rate — batch AI candidates only |
| Finnhub news (key exists in SDM budgets) | Optional company news | Budget row required |
| Polygon news | Optional | Budget |
| Google RSS | Bank-news only today — **not** universe scrape | Don’t expand blindly |
| Persist | `ticker_news_headlines (ticker, published_at, title, source)` | Dedupe by title hash; TTL retention 90d |

**Density score (sketch):** count event-keyword headlines in 7d + analyst actions in 30d + earnings flag → threshold → `fundamental_catalyst`.

### 2.4 Proxy honesty

| Label | Proves | Does not prove |
|---|---|---|
| `fundamental_catalyst` | Event/news/analyst activity near name | Causal “news caused the move” |
| `technical_momentum` | Price/indicator leadership | Institutional flow dollars |
| Short ratio high | Crowded short positioning (lagged) | Imminent squeeze |
| Band regret | Income left vs safer band peers | Globally optimal strike |

---

## 3. Strike regret (locked metric)

### 3.1 Definition — **band regret**

For a decision at time \(t\) (AI publish or human CSP with snapshot):

1. **Band** = puts that:
   - Pass `liquidityGate`
   - Lie in regime delta sweet-band **or** within configured OTM% band used by scorer (`DELTA_SWEET_*` / OTM gates)
2. **Chosen** = published strike (or `pickBestStrike` recommendation)
3. **Regret_income** = \(\max_{\text{band}}(\text{weeklyIncome}) - \text{weeklyIncome}(\text{chosen})\) (floor at 0)
4. **Touch rate** = fraction of richer-than-chosen band strikes whose strike was **breached** by spot low before expiry (from `prices_historical`)
5. Store: `{ regret_income, n_band, n_richer, n_richer_touched, chosen_delta, regime }`

### 3.2 Forbidden

- Optimizing solely for max premium  
- Claiming “the” correct strike among all OTM puts  
- Using regret to auto-widen delta without human review of rule changes  

### 3.3 Learning use

- Feature on loss/win reviews → ai/14 memory `kind=band_regret`  
- Walk-forward: does lowering income weight when `n_richer_touched` historically high improve expectancy? — **rule experiment**, not LLM weight update  

---

## 4. Historical backtest / replay store

### 4.1 Minimal store (enhance-first)

| Need | Approach | Evidence |
|---|---|---|
| Price path | `prices_historical` (OHLCV) | [schema](../../lib/db/src/schema/index.ts) L120–128 |
| Daily indicators | `indicator_cache` / `ticker_technicals` | Seed after close |
| Chain at decision | **Snapshot** best-N band strikes at publish (AI) + optional nightly watchlist sample | Full historical options = expensive — defer OPRA |
| Labels | Win/loss, MAE (max adverse excursion vs strike), band regret | Computed offline |
| Eval | Walk-forward weeks: rule set vN vs vN+1 | Held-out; document metrics (win rate, avg premium, MAE) |

### 4.2 Replay job sketch (enh/35)

```
for each snapshot decision:
  path = prices_historical[ticker][t .. expiry]
  outcome = win if low > strike else loss (CSP simplified)
  mae = max(0, strike - min(low)) / spot_t
  regret = band_regret(snapshot, path)
  emit row → analytics table or memory features
```

CSP simplification (research must document): ignore early close / roll; assignment ≈ breach; good enough for **relative** rule compare.

### 4.3 What “continuous learning” means here

| Mechanism | Yes | No |
|---|---|---|
| Tag + feature memory → next AI select | Yes (ai/14) | |
| Walk-forward rule tweaks with human approve | Yes | Silent prod weight edits |
| More/better news + short-interest freshness | Yes (34) | Scrape social |
| Fine-tune LLM on trades | | **No** |

---

## 5. Phased build split

| Phase | Stub | Scope | Effort |
|---|---|---|---|
| **34** | `34-catalyst-momentum-data-enrichment-…` | Expand keywords; optional headline persist; `momentum_driver` helper; short-ratio freshness check; FE uses server catalysts only (L-05) | M |
| **35** | `35-csp-replay-band-regret-…` | Decision snapshot schema; replay job on `prices_historical`; band regret metrics; export into ai/14 memory | L |

**Depends on:** ai/14 contracts for memory shape; enh/12 catalyst dedupe preferred before expanding FE.

---

## 6. Out of scope

| Item | Reason |
|---|---|
| Social / StockTwits scrape | Noise; ToS |
| EPFR ETF dollar flows | Paid; see enh/30 |
| Full OPRA history purchase | Budget gate |
| Silent `computeOptionScore` weight mutation | R4/R8 |
| Redis / job-queue platform | P3 eng/28 — use existing seed/cron patterns until approved |
| Literal “optimal strike” UI | False confidence |

---

## 7. Existing code baseline

| Asset | Path |
|---|---|
| `buildCatalysts` / keywords | `artifacts/api-server/src/lib/catalysts.ts` |
| FE duplicate (delete) | `catalysts-section.tsx` — enh/12 |
| `computeOptionScore` / `pickBestStrike` | `artifacts/stock-compare/src/lib/option-scorer.ts` |
| BB squeeze in tech | `technical-rankings.ts` volatilityState |
| `yahoo_short_ratio` | schema ~L749; backfill-yahoo / nightly-enrichment |
| `prices_historical` | schema L120 |
| Bank Google RSS | `routes/macro.ts` bank-news — do not copy for universe |

---

## 8. Research execution checklist

- [ ] Confirm short-ratio field population rate across universe  
- [ ] Choose news vendor + daily call budget for AI candidate set only  
- [ ] Lock numeric thresholds for driver labels (draft → calibrate on sample week)  
- [ ] Lock band definition to scorer constants (import from `option-scorer-constants`)  
- [ ] Document CSP replay simplifications (breach = loss)  
- [ ] Spawn 34/35 task files when checklist done  
- [ ] No app code in this research task  

---

## 9. Success criteria

- Driver taxonomy + honesty table  
- Band regret formula locked; global optimum forbidden  
- Replay store = prices_historical + decision snapshots  
- Stubs **34** / **35** named; seq **31/32** left for liquidity  
- Wire path to ai/14 memory explicit  

---

## 10. Impact & Risk (for later builds)

### Blast radius
- New snapshot table; catalyst keyword changes; optional news table; offline job  

### Bug risks
- Lookahead in replay (using future IV) — snapshot only at \(t\)  
- Keyword false positives → wrong `fundamental_catalyst`  
- Regret UI read as “you should have sold closer” without touch-rate context  

### Rollback
- Disable job; stop attaching driver tags  

---

## Review (2026-07-09)

**Verdict:** APPROVE — ready as research SSOT for momentum + CSP learning  
**Key:** Deterministic drivers; band regret not optimal strike; replay on prices_historical + snapshots; feeds ai/14.
