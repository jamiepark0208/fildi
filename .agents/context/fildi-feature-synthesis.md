# Fildi unique features + how to synthesize them
> Living map for Jamie. Update when a distinctive capability ships. Not a backlog — a reading guide.
> Companion: `scripts/watchlist_sync/FACTOR_MAP.md` (one home per *score factor*). This file = product surfaces + vendors + models.

## How to read the stack (decision order)

When a name or the book looks interesting, walk **layers top → bottom**. Lower layers never override a higher layer’s kill rule; they explain or size.

| Order | Layer | Question it answers | Where you look | Scores? |
|---|---|---|---|---|
| 1 | **Book risk** | Can I survive assignment / a bad week / joint breaches? | Live › Portfolio Alerts · Portfolio › Book card | No — $ and odds only |
| 2 | **Model List / strategy** | Should I sell premium *here* (put or call path)? | Watchlist Model List · Options Rankings | Yes — strategy weights |
| 3 | **Contract / options** | Is *this* strike priced? | Scanner · strike detail · IV/RV | Yes — option score |
| 4 | **Stock quality** | Is the underlying fund/tech OK as collateral? | Fund + Tech leaderboards · Breakdown | Yes — fund-1.x / tech-1.0.0 |
| 5 | **Street / research soft** | What does the street path say (revisions, conflicts)? | Breakdown › Street · Desk news · LSEG/WRDS panels | Soft only — never mutates fund_score |
| 6 | **Fair value / assumptions** | Am I selling into cheap or expensive? | Breakdown FV · Assumptions ledger | Display — gaps don’t time returns |
| 7 | **Macro / regime** | Is the market dial hostile to premium selling? | Macro tab · regime · credit/GEX lines | Context flags |
| 8 | **Agent / local AI** | Cheap typed hints, overnight labels, train loop | OpenJev · Desk OJ labels · Ideas | $0 local — not a market forecast |

**Synthesis rule:** If layer 1 is red, stop. If 2 says no, don’t override with 4–6 looking “cheap.” Use 5–8 to *explain* disagreements, not to average scores into a mega-score.

---

## Unique / distinctive capabilities (what competitors rarely combine)

### Book & portfolio (put-seller native)
| Feature | What it is | Status |
|---|---|---|
| **PM Alerts MC** | 20k-path book sim to next expiry; P(margin)/P(cash short); cheapest close set | Live |
| **Cholesky / one-factor corr** | Joint moves from 60d shrunk corr (fallback ρ=0.6 S015); stress floor vs calm corr | Live (A117) |
| **Effective bets (PCA)** | “N puts ≈ k independent bets” | Live display |
| **Early-assign flag** | Deep ITM + DTE heuristic on open puts | Live display |
| **Crash-week budget** | −30% all-names scenario vs 20/25% equity budget | Live |
| **Expiry what-if desk** | Checkbox closes → headroom; no broker writes | Live (A76) |
| **Portfolio VaR line** | MC 95/99% loss + −10% β-scaled scenario on Book card (provisional until Kupiec) | Live provisional (A161) |
| **Assignment-aware track** | Day-10 exit grading (not hindsight max) | Planned (A92) |

### Scoring & selection
| Feature | What it is | Status |
|---|---|---|
| **One tech engine** | 6-comp champion (tech-1.0.0); relativePressure/analystUpside display-only | Live (A155) |
| **Fund peer taxonomy** | Custom groups (thematic: quantum/crypto/China) + vendor cross-check path | Live; banks/waste merged A160 |
| **blendThree** | Own group + sector + universe by group size | Live |
| **Model List** | Strategy home: tags, PREMIUM, covered-call guard — not a second fund score | Live |
| **Option stock+strike scorer** | Income/buffer/IV/DTE + stock quality stack | Live |
| **Easy-win scanner pieces** | Reversals / vol mispricing partial; laggard gated on S023 | Partial (A101) |

### Fair value & valuation lab
| Feature | What it is | Status |
|---|---|---|
| **Multi-model FV** | Peer P/E, Graham, OJ, FCF DCF, EV/EBITDA, excess returns, P/FFO, StarMine blend | Live fv-1.x |
| **Cyclical trough gate** | Max confidence medium; hides absurd upside | Live (A113) |
| **Assumption ledger** | Judgement → adjusted FV trail | Live |
| **Value-trap flag** | Cheap + weak 12-1 momentum | Live |
| **FV disagreement lab** | Chart vs street divergence | Planned (A86) |

### Street / vendor research (soft UI)
| Feature | What it is | Status |
|---|---|---|
| **WRDS IBES** | Breadth, SUE, fwd growth → fund optional metrics + Street panel | Live batch; supervised sync |
| **LSEG / StarMine** | ARM, alpha, PT, EPS drift — soft + some fund inputs | Live; research ops health |
| **Street synthesis** | Yahoo + WRDS + LSEG conflicts (PT gap, buy vs cuts) | Live |
| **Desk commentaries** | Labeled email → Daily News JSON | Live |
| **OpenJev desk labels** | Overnight local-model headline tags | Accepted; await 05:30 fill (A143) |
| **Analyst revision breadth timeline** | Sector upgrade/downgrade | Planned (A95) |

### Market data rails
| Feature | What it is | Status |
|---|---|---|
| **Schwab options/quotes** | Primary live chains; RPM + refresh | Live P0 |
| **Robinhood MCP read-only** | L2 verify / plan quotes; Keychain tokens | Live |
| **Polygon** | Cheap extras (ex-div, breadth…); 1m path for profile | Partial (A96 shipped; A126 profile open) |
| **Yahoo fallback** | Quotes/fundamentals when Schwab stale | Live |
| **Finnhub economic calendar** | Macro events display T1–T3 | Live (A49) |
| **Dealer GEX (SqueezeMetrics)** | SPX gamma context line | Live display (S034 pending) |

### Statistical / quant models in the product
| Model | Role | Wired into scores? |
|---|---|---|
| Black-Scholes / Greeks | Contract pricing + P(ITM) | Odds / marks |
| Monte Carlo book paths | Margin/cash/VaR | Book risk only |
| Cholesky / one-factor | Correlated shocks | Book MC |
| PCA effective bets | Concentration display | No |
| HMM (A56) | Regime candidate | Study / bake-off |
| Kalman (A115 arm) | Regime candidate | Study pending |
| OLS / IC lab | Factor studies | Research only |
| TimesFM / E[RV] | Vol mispricing study | S033 / A137 |
| Binomial early exercise | Assign flag heuristic | Display |

### Agent / ops / reel-sourced
| Feature | What it is | Status |
|---|---|---|
| **OpenJev** | Local typed answers, teach loop, Ideas readiness, $0 | Live; train skill |
| **Forecast ledger** | Logged questions after PM alerts (Pythia path) | Live hook (A129/A124) |
| **ASKS multi-agent bus** | Muse→Cursor builds; Claude plan/quant review; Grok skeptic | Live |
| **Ops Nucleus** | Scheduled Tasks L0/L1 + workers | Live |
| **Reel inbox / Video Lab** | Forwarded Instagram → ASKS + hooks | Planned P3 (A125) |
| **Order-flow charts** | Volume + 1D VWAP; Polygon profile next | Phase 0 live (A126) |
| **ICT detectors** | Overlays only until S036 | Planned (A139) |
| **Conviction ledger** | Thesis + kill rules for held names | Planned (A94) |
| **Figure tracker (personal Dub)** | Macro tab scoreable prints | Planned (A85) |

---

## Overlap map (same fact, different homes — don’t average)

| You see… | Trust for decisions | Treat as |
|---|---|---|
| Tech total vs Fund total | Separate layers; Model List combines with strategy weights | Not substitutes |
| Tech “Volatility State” vs Options IV/RV | Options PRICING is the factor home for VRP edge | Tech = context |
| Analyst upside (tech display) vs Street PT vs FV | Levels don’t predict (S009); revisions/path matter | Display / soft |
| Crash −30% vs MC VaR vs −10% scenario | Different questions (stress budget vs probabilistic loss vs market beta move) | Show all; don’t merge |
| OpenJev label vs Street synthesis | OJ = cheap triage; Street = multi-vendor conflicts | OJ never sizes trades |
| Peer group fund score vs “vendor peers” | Our taxonomy owns scoring; vendor list = audit (A148) | Monthly review |

---

## Daily synthesis checklist (put seller)

1. **Book card / Alerts** — any red? assignment / crash / corr mode noted?
2. **Model List** — names the strategy actually wants today.
3. **Scanner / rankings** — contracts on those names (or new candidates).
4. **Breakdown** — fund + tech + Street conflicts + FV trap flag on the shortlist.
5. **Macro** — regime / credit / GEX hostile?
6. **Desk / OJ** — overnight narrative; only escalate if it conflicts with 1–4.

---

## What not to build (synthesis anti-patterns)

- A single “AI mega-score” that blends fund + tech + street + FV + OJ.
- Second book-risk engine beside `pm_alerts` (A161 rule).
- Wiring soft research (LSEG/WRDS panels) into fund_score without a study + Jamie OK.
- New factors without a row in `FACTOR_MAP.md`.

---

## Maintenance

- **Multi-agent:** [A166](../../research/common/asks/A166.md) — Muse (product/reels), Claude (quant/studies), Grok (skeptic). Append reviews there; edit this file when you find a miss.
- After shipping a distinctive surface: add one row to the tables above + one line under Overlap if it collides (same commit when possible).
- Factor-level homes stay in `FACTOR_MAP.md`.
- Studies that kill or promote a layer: `research/studies/INDEX.md`.
