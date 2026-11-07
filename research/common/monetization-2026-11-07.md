# Monetization notes — 2026-11-07 (Claude)

Not legal advice. Each "status" below is from public terms/search on 2026-11-07; confirm in writing with the vendor before shipping.

## 1. Data rights — what a paid app can use

**Rule that decides it:** copyright isn't the question (prices are facts). The question is the **contract** you accepted to get the data (API terms, ToS, academic license). It binds any commercial use, including inside a score. Scores are "derived data": allowed only where the license allows derived/display use.

| Source | We use it for | Paid app? | Why / fix |
|---|---|---|---|
| SEC EDGAR | statements, filings, insiders | ✅ green | US gov, public domain; ≤ 10 req/s |
| Treasury Fiscal Data, NY Fed GSCPI | macro, TGA | ✅ green | gov / public, attribute |
| FRED (gov series: CPI, payrolls, DGS10, DTB3, SOFR, NFCI) | macro, T-bill | ✅ green | public; check each series' notes |
| FRED **ICE BofA OAS** (HY/IG spreads → S028 drop warning) | credit-spread warning | ❌ red | ICE-owned; "reproduction prohibited without written permission"; FRED cut to 3 yrs from 04/2026 |
| Caldara–Iacoviello GPR | geo risk | 🟡 likely ok | academic public file; attribute, ask authors |
| Kalshi public API | FOMC/CPI odds | 🟡 check | public market data; read API terms |
| Anthropic API | AI explain | ✅ green | commercial use allowed |
| Yahoo (yahoo-finance2) | quotes, chains, fundamentals fallback | ❌ red | ToS: no commercial use without written consent; unofficial endpoint can break any day |
| Schwab Trader API — Individual | quotes, chains, daily bars (primary!) | ❌ red | individual tier = own accounts; nonprofessional data = personal, non-business. Commercial tier exists → apply + exchange fees |
| tastytrade (personal OAuth) | IV rank, market metrics | ❌ red | personal grant; ask about partner API |
| Polygon/Massive free/individual | aggs, option bars, short interest | ❌ red | individual = non-professional; Business plan (custom price) for display |
| FMP personal | statements, grades, targets | ❌ red | ToS bars commercial use; display needs Data Display & Licensing Agreement (Enterprise) |
| Finnhub free, Alpha Vantage free | metrics, earnings, transcripts | ❌ red (likely) | free tiers personal; paid commercial plans exist — check |
| FactSet proxy account | bank/financial highlights | ❌ red | enterprise seat; no redistribution |
| LSEG Workspace | StarMine, holders, option mids | ❌ red | desktop user license |
| WRDS (CRSP, IBES, 13F) | studies | ❌ red | academic, non-commercial; inventory already says research only. Academic licenses often bar commercial *research* too — check |
| London Strategic Edge (LSE_KEY) | 1m bars, OPRA trades | ❓ unknown | read their terms; OPRA-derived data normally carries OPRA fees for display |
| CNN fear & greed | sentiment | ❌ red | scraped site JSON, no license (already 418-blocked) |

**Today:** the live app's core path (Schwab → Yahoo prices/chains, FMP/Yahoo fundamentals) is all red for a paid product.

**Cheapest green stack to price (quotes needed):**
- Prices + chains + greeks: Tradier (brokerage account holders get realtime; ORATS greeks) or ORATS API (~$99/mo listed) or Massive Business — ask each for **display rights to paying subscribers** + OPRA non-pro fees.
- Fundamentals: EDGAR (free, we already parse companyfacts) + one paid display license (FMP Enterprise / Finnhub / Intrinio quote).
- Macro: FRED gov series + Treasury; replace ICE OAS with a licensed or self-built spread (e.g., HY ETF yield vs Treasury).
- EOD/delayed is far cheaper than realtime; a weekly put list needs EOD only.

**The legit "grey area" we can use:**
1. Research with academic/personal data, ship with licensed data. A rule like "IV/RV > x" found on WRDS is our method, not their data — the live score is recomputed from licensed inputs. (Confirm WRDS terms allow it.)
2. Users' own broker data via their own login (SnapTrade/Plaid or user-supplied API keys) — their account, their data rights.
3. Public-domain gov data is fully free to resell, derived or raw.
4. Free weekly publication with EOD picks needs far less data licensing than a live screener.

**Not a plan:** burying personal-tier data inside scores and selling it. Still a breach; the keys are in Jamie's name; one cut-off (Yahoo, Schwab) kills the product overnight.

## 2. Pain points — Reddit not read yet

Reddit blocks automated fetches and search engines don't return r/thetagang / r/Optionswheel threads. Getting the real list needs one of:
- Jamie creates a free Reddit API "script" app (reddit.com/prefs/apps) → Claude pulls top ~1,000 posts + comments per sub via the official API → OpenJev tags pain points → counts.
- Jamie pastes 10–20 threads.

Indirect evidence (vendor market, 11-07 search): ≥ 6 wheel trackers sell assignment-adjusted cost basis + roll tracking (OptionWheelTracker, Option Wheel Logic, OptionIncome, PremiumGuardHQ, QuantWheel, OptionsVault ≤ $6/mo) → real pain, but already cheap and crowded. Spread/condor screeners exist (Barchart, SlashTraders, FinanceDashboard) ranking by return on capital / IV rank / delta; few combine expected move + earnings + liquidity + real-fill evidence.

## 3. Beyond puts — any structure

Why the app is put-first: built around Jamie's own trading, and the measured edge is selling rich premium (IV/RV, S003/S004; S088/S109/S054). Buying side showed no edge in A370 smoke; stock-entry signals ≤ 0 net at cross (A359 21n).

Now the app has two structures: short-put ladder and long call/put board (`options-structures/`). No covered calls, verticals, condors, strangles, calendars, collars or plain stock.

Proposed design (structure-agnostic, same inputs):
1. **Legs model:** any mix of stock ± and option legs; P&L, max loss, breakevens, POP, buying power.
2. **One probability engine:** our distribution (IV, RV forecast, skew, earnings move) prices every structure the same way.
3. **Ask the view, not the structure:** bull / bear / neutral / vol up / vol down × horizon × max loss → rank all structures by expected value at **real fill** per $ buying power, with worst-case tail.
4. **Evidence chip per structure:** BOARD verdict (works / dead / untested) so users see which have tested edge.
5. Fits A277 (one engine per structure) — extend it from "sell puts first" to legs.
