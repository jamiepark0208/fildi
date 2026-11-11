# What a trade opportunity is, and how to find one: literature review + Fildi gap audit (Claude 2026-11-10)

**Goal moved: no.** This is research only. No scoreboard number changed. Engine vs Jamie is still −2.48 pts of strike (n 9, 2 weeks, not significant).
**Why it exists:** Jamie 11-10: "the logic behind fildi's operations and features is so much lower quality than i thought". He asked for the literature on how trade ideas are generated, a definition of a trade opportunity and its goals, and a fit to his style.
**Builds on, doesn't replace:** Codex's intraday opportunity definition (`intraday-entry-research-plan-2026-11-10.md` § Opportunity definition) and `intraday-entry-literature-2026-11-10.md` (intraday papers). This file covers the whole pipeline above the entry minute.
**Evidence grade:** I read abstracts, journal pages and secondary summaries (CXO, Alpha Architect, Quantpedia), not full texts. Treat every effect size as a *hypothesis prior*. Verify it from the paper before it sets an acceptance bar.

---

## 1. Definition

**A trade opportunity** = an executable action (instrument + strike/DTE + size + entry rule + exit rule), available now, where all four hold:
1. **Net edge:** expected P&L at a real fill, per $ of buying power per day, beats the same-risk alternative. That alternative is T-bills plus the same delta in SPY or the stock, held for the same time.
2. **Known tail:** P(loss > X), CVaR 5 % and the stress-case loss are stated, and the size keeps the *book* inside Jamie's loss limit.
3. **A named reason someone pays you:** a risk premium (you carry a risk others pay to shed), demand pressure (someone overpays for a payoff shape), or an inefficiency (a slow reaction). "Score is high" or "IV is high" is not a reason (Sinclair 2020: separate premia from inefficiencies; Moontower: edge = worth 50c, pay 48c).
4. **The reason is switched on today:** the regime/state where the literature or our out-of-sample test found it is the current state.

**The goal function (Jamie's):** maximise net $ return per $ of collateral over time, versus T-bills and versus his own picks. Constraints: no wipe-out in a crash (Oct–Nov 2026 lesson), Jamie decides only trades, and outputs are probabilities, not if-then rules (11-10). His style is the default expression, not the only one: sell deep-OTM puts on names he'd own, near intraday lows after the open window, close early on mean reversion. Buy calls at panic bottoms. Crash = where to look (10-28 opportunity mindset).

**Every short put is two bets. Fildi scores them as one.**
Short put P&L ≈ **(a) short-vol P&L** (delta-hedged: premium vs the realised path) **+ (b) delta × stock return** (you are long the stock).
The literature says these two pull in *opposite* directions on the names Jamie likes (§ 3, rows 2–4). That conflict is the single biggest logic gap I found (§ 4, gap G1).

---

## 2. How a professional gets from "market" to "trade" (the pipeline)

| Step | What it answers | Literature / practice | Fildi today | Grade |
|---|---|---|---|---|
| 1 Regime | Which world are we in (trend × vol level × vol term × breadth)? | Persistent regime models beat raw thresholds: statistical jump models add a switching penalty → fewer false flips. Over 1990–2023, net of costs and delays, they cut volatility and max drawdown and raised Sharpe versus HMM and buy-and-hold (Shu, Yu & Mulvey 2024). Hamilton Markov switching is the classic. | Coarse `market_state` buckets, VIX÷VIX3M, SPY 3m return. Labels move with lagging windows. Jamie had to hand-label Oct = bear. | weak |
| 2 Edge menu per regime | Which edges are switched on in this state? | Liquidity provision pays most when VIX is high (Nagel 2012). Momentum crashes in panic rebounds (Daniel & Moskowitz 2016). VIX slope predicts variance-asset returns (Johnson 2017). | `strategy_rules.json` cells exist. Most cells were tested one at a time with one sign across regimes (contract rule 12 is new, 11-10). | partial |
| 3 Candidate screen | Which names and contracts carry the edge? | IV − RV (Goyal & Saretto 2009); idio vol / skewness (Cao & Han 2013; Boyer & Vorkink 2014); term slope (Vasquez 2017); smirk (Xing, Zhang & Zhao 2010); order imbalance (Muravyev 2016). | Only IV/RV + IV rank are in the score. Skew, term and flow are marked "untestable (no history)" in FACTOR_MAP, but LSE OPRA has trades since 10/2025. | partial |
| 4 Payoff model | What is E[P&L], P(kept), tail for this contract? | Price against a *conditional* return distribution (own history in this state + earnings jump), not Black-Scholes. | `ev_rv_cap` = bid minus Black-Scholes at 21-day RV. No skew, no jump, no drift, no state conditioning. `hist_bp` comes from a band table (market state × stock state × Δ band), not from the contract. | **weak — core gap** |
| 5 Direction overlay | Is the stock's own expected return bad (lottery, news drift, steep smirk)? | MAX stocks lose > 1 %/mo (Bali, Cakici & Whitelaw 2011). Steep smirk → −10.9 %/yr (Xing et al. 2010). Bad-news drops drift for months while no-news drops revert (Chan 2003). | Trend + revisions in the fit score. News is "awareness, not a gate". No MAX, no smirk, no news/no-news split. | partial |
| 6 Structure | Naked put, spread, risk reversal, calls? | Same view, cheapest expression. Sell where demand overpays, buy where cheap. | StructureBuilder exists. S020/S164/S165 found CSP beats spreads at the same BP on tested entries. | ok |
| 7 Entry / exit timing | Which minute? When to close? | Effective spreads < 40 % of quoted for traders who time orders (Muravyev & Pearson 2020). Option buyers lose overnight and gain intraday, so sellers want the overnight (Muravyev & Ni 2020). tastylive 45 DTE / exit at 21 DTE (their strangle study; vendor research). | Intraday plan in progress (Codex). S017/S103: stops and fixed profit-takes lost on real quotes. | in progress |
| 8 Size | How much? | Fundamental law: IR ≈ IC × √breadth, with IC typically 0.02–0.10 (Grinold & Kahn). Fractional Kelly on E/Var. Meta-labeling: a 2nd model sizes the 1st model's bets (López de Prado 2018 ch. 3, 10). | Correlation groups (`move_groups`) shown. No size output. S183 meta-label AUC 0.50 ("put losses are market-wide"), so breadth is small. | weak |
| 9 Grade + learn | Did it work, and why? | Out-of-sample + multiple-testing haircut: t > 3 for a new factor (Harvey, Liu & Zhu 2016). | `rec_scoreboard.py`, grade_ledger, BOARD. About 186 studies run. Most "works" rows sit at t 2–5 with no count of trials. | partial |

**Reading of the table:** Fildi is strongest at steps 6 and 9 (structure tools, grading). It is weakest at the steps that *define* an opportunity: 1 regime, 4 payoff model, 5 direction overlay, 8 size. Studies were run as isolated if-then filters on step 3. That is why 186 studies produced mostly "dead" rows: each filter was tested alone, without the payoff model that would say what it is worth.

---

## 3. Edge catalogue: what the research says pays a premium seller, and in which state

| # | Edge (why someone pays) | Source (claim · sample · effect · after costs) | State where it's on | For Jamie | Fildi |
|---|---|---|---|---|---|
| 1 | **Single-stock VRP is small; index VRP is large** | Driessen, Maenhout & Vilkov (JF 2009): index options are expensive because they hedge correlation risk. Single-stock options carry no significant VRP on average. Not exploitable after frictions. Bakshi & Kapadia (RFS 2003): negative VRP in index options. | Always (index) | Explains BOARD's "average sold option ≈ break-even". On single names, the edge **must** come from conditional selection (rows 2–9), never from "selling options pays". Index puts (S172) carry the unconditional premium. | consistent |
| 2 | **IV high vs realised (overreaction)** | Goyal & Saretto (JFE 2009): sort on RV(12 m) − ATM IV. Long-short straddles / delta-hedged options earn significant monthly returns, robust across conditions. Caveat: part disappears with real-time IV. | Robust across states | Already the main put input (IV/RV t 4+, S003/S004). Keep it. | live |
| 3 | **Options on high idio-vol / lottery names are *richer*** | Cao & Han (JFE 2013): delta-hedged option returns fall monotonically with idio vol, because dealers charge for arbitrage costs (≈ 40 % explained by limits-to-arbitrage). Boyer & Vorkink (JF 2014): high ex-ante skewness → much lower option returns (10–50 %/wk portfolio spreads). Spreads widen with skewness, so fills at the bid eat part of it. | Strongest in small, illiquid, retail-heavy names | **Contradicts trader-context rule 3 ("lower idio vol").** The *option* is richest on the spec names Jamie trades (RGTI, IREN, ONDS). | penalised |
| 4 | **…but those same stocks drift down** | Bali, Cakici & Whitelaw (JFE 2011): top-MAX decile underperforms by > 1 %/mo. Weaker when the MAX day is an earnings reaction. Xing et al. (JFQA 2010): steepest smirk → −10.9 %/yr risk-adjusted, persists ≥ 6 mo, predicts bad earnings. | Low institutional ownership | This is why assigned high-vol names "keep falling" (trader-context) and why the wheel lost $7.7k on OPEN stock. **Rows 3 + 4 together:** sell the rich option, don't keep the bad delta. | MAX/smirk not used |
| 5 | **No-news drops revert; news drops drift** | Chan (JFE 2003): headline database. Bad-news stocks drift down up to 12 mo. Extreme moves without news reverse. Mostly small, illiquid stocks. | Small/illiquid names | Jamie's dip edge (S011: ITM 17 % vs 26.5 %) should be **stronger on no-news dips**. Fildi treats news as awareness only (S025: gap drops recover no worse; that test did not split news vs no-news). | untested split |
| 6 | **Liquidity provision pays most in turmoil** | Nagel (RFS 2012): reversal-strategy returns and Sharpe rise sharply with VIX (2007–09). Even industry reversal works when VIX is high. | VIX high | Supports "crash = opportunity". It is a *portfolio* reversal result, not an unhedged short put (Codex caveat). Pair with S054/S172 panic + un-invert timing. | partial (S054, S172) |
| 7 | **Panic rebounds crush momentum** | Daniel & Moskowitz (JFE 2016): after market declines with high vol, past losers' beta > 3 and they rebound hard. Dynamic weighting doubles Sharpe. | Panic state | Biggest rebounds hit the *beaten-down* names, so selling calls on them in a panic loses (week 10-28: calls on beaten-down names got run over). Puts on high-beta names at the un-invert = S173. | partial |
| 8 | **Steep IV term slope → options cheap; inverted → rich** | Vasquez (JFQA 2017): steeper slope → higher straddle returns (sell when inverted). Johnson (JFQA 2017): low VIX slope → high variance-asset returns, gross of costs. | Per name / market | Per-name front-vs-back IV is not in the put score. VIX÷VIX3M is used at market level only. | market only |
| 9 | **Order imbalance is the strongest single predictor** | Muravyev (JF 2016): of 50+ predictors of option returns, customer order imbalance (dealer inventory pressure) predicts best. Inventory effect is 5× prior estimates. | Any | When customers are net *buyers* of puts on a name (fear/hedging), the put is rich → sell. LSE OPRA trades since 10/2025 (paid, mostly unused) can sign trades. This is gap-table row #2 (flow) with a research reason. | none |
| 10 | **Earnings: IV is too *low* in the run-up, then retail overpays** | Gao, Xing & Zhang (JFQA 2018): ATM straddles bought 3 d before the announcement earn +3.34 % to the date. Pre-EA uncertainty is under-priced, strongest in small/high-vol names. de Silva, Smith & So (RoF 2025): retail buys before high-expected-vol announcements and loses 10–14 %. Spreads ≈ 20 % of the price. | Earnings window | Two opposite effects in one week. Being short vol **3–5 d before** the print is the wrong side (IV climbs). The crush **after** is where retail loses. Fildi blocks all earnings-crossing puts, yet about 45 % of missed trades are earnings (eod_audit). | blocked |
| 11 | **Option momentum** | Heston, Jones, Khorram, Li & Mo (JF 2023): straddles with high past 6–36 mo returns keep outperforming, no reversal, costs unrelated. | Any | Names whose options have *lost* money for sellers lately (realised > implied) tend to keep doing so → a skip / size-down input for put sales. | none |
| 12 | **Timing the order** | Muravyev & Pearson (RFS 2020): traders who time their orders pay < 40 % of the quoted spread. Muravyev & Ni (JFE 2020): delta-hedged options lose ≈ −1 %/night and gain +0.3 % intraday (index; similar in equity options). Gross only. | Every trade | Sell late in the session, not at 10:00, unless the intraday-low rule says otherwise. Fill at a timed limit, not bid + 23 %. Both feed Codex's intraday plan. | in progress |
| 13 | **Buying protection is a poor hedge** | Israelov (JAI 2019): protective puts have a lower Sharpe than simply holding less equity at the same return. The VRP is the cost. | Always | Cuts both ways. Selling puts earns that cost, but a put-sale book ≈ long equity in a crash (CAIA; Ge). Size the book as if it were stock. | partial (PM Alerts VaR) |

Practitioner sources agree with the academic ones on one point: premium "income" is a risk premium with a liability attached, not a coupon (Eifert / QVR; Moontower on Israelov & Ndong; Risk.net 2024 "vol selling is a broken trade" debate). The income-floor gate (`MIN_WEEKLY_INCOME_PCT`) chases a coupon. trader-context already says "~1 %/week is not an edge", yet the floor remains a hard gate in `put_recs.py`.

---

## 4. Fildi logic gaps, ranked by likely $ impact on Jamie's put book

**G1 (P1) — The two bets aren't separated.** Selection penalises idio vol (wheel P&L), which throws away the richest options (rows 3, 10) to avoid the stock drift (row 4). Better: rank on the *option* edge (rows 2, 3, 8, 9, 11), then cut the *delta* risk separately. Ways to cut it: smaller Δ, a pair with a same-factor short call (Jamie's ONDS/MP calls vs IREN/OKLO puts hedged in week 11-04), or a MAX/smirk/news-drift skip.
*Test, no new data needed:* decompose every S088 / put_recs trade into delta-hedged P&L + delta × stock return. Then sort both parts by idio-vol tercile within each regime cell. Expected sign: hedged part rising with idio vol, stock part falling. If both hold, the fix is a structure/hedge rule, not a name penalty.

**G2 (P1) — No payoff model; ranking is a weighted score.** `SE.rank_key` + band tables + Black-Scholes-at-RV `ev_rv_cap`. No contract gets P(kept), E[P&L]/$BP/day and CVaR from a distribution that knows its state (regime, own-vol percentile, earnings jump, skew). Without that, every new factor is a yes/no filter. Hence 186 isolated tests and mostly "dead". This is the "probabilistic, not if-then" rule (11-10) made concrete.
*Build:* one `opportunity_ev` per candidate contract. Bootstrap the stock's own forward-return paths from past days in the same state cell, shrunk to its sector × vol-tier cluster (contract rule 9). Add the earnings jump from its own history. Price the contract's payoff on those paths at a real fill. Output P(kept), E, CVaR5 and a fractional-Kelly size. The factors from § 3 enter as state variables, not as gates.

**G3 (P1) — Earnings is a blanket block, though the literature points to a specific window.** Rows 10 + 45 % of missed trades. *Test:* sell-put windows of −5…−1 d before the print vs the day of the print (hold through the crush) vs +1 d after, using per-name implied move vs own realised-move history. Pre-registered sign: −5…−3 d < 0, print day > 0 when implied > own historical move. n is ample (≈ 940 names × 4 prints/yr).

**G4 (P2) — Regime labels are coarse and lag.** Replace with a jump-model regime (Shu et al.), fit on SPY returns + VIX level + VIX÷VIX3M + breadth. One label feeds every engine, and studies use it for cells (contract rule 12). *Pass:* a label that would have called Oct 2026 "bear" by the first week of October with no hindsight, and one that flips rarely.

**G5 (P2) — Option-side predictors with data we already pay for are unused:** order imbalance (row 9), per-name term slope (row 8), smirk (rows 4, 8), option momentum (row 11). OPRA since 10/2025 is about 13 months, enough for a cross-sectional test at weekly frequency (940 names × ~56 weeks). Too short for regime cells, so report it as such.

**G6 (P2) — No-news vs news dips (row 5).** Split S011 / dip puts by `news_flags` (8-K or ≥ 3σ gap) vs none. Pre-registered sign: no-news dips kept more often.

**G7 (P3) — Research discipline.** About 186 studies means a t ≥ 3 bar for any new "works" row (Harvey et al.). Log the trial count per question, and quote the deflated Sharpe for the BOARD "works" rows.

---

## 5. Reading list (primers → textbooks → papers → people)

**Primers (start here)**
- Colin Bennett, *Trading Volatility* (free PDF): skew, term structure, dispersion, VRP. The best single primer for steps 3–4.
- Moontower (Kris Abdelmessih, ex-SIG) Substack: "Primer 1", "Options trading as a widget factory", "Adverse selection in the options market". Edge as unit economics and who is on the other side.
- CFA Institute refresher, *Analysis of Active Portfolio Management*: fundamental law, IC, breadth, transfer coefficient.

**Textbooks**
- Euan Sinclair, *Positional Option Trading* (Wiley 2020): ch. 4 variance premium, ch. 5 finding positive-EV trades, sizing, meta-risk. Closest match to Jamie's style. Also *Volatility Trading* (2nd ed.).
- Sheldon Natenberg, *Option Volatility & Pricing*: the mechanics.
- Antti Ilmanen, *Expected Returns* (2011): every premium, when it pays, when it crashes. Ch. on volatility selling.
- Grinold & Kahn, *Active Portfolio Management*: turning forecasts into sizes.
- Marcos López de Prado, *Advances in Financial Machine Learning*: triple-barrier labels (ch. 3), meta-labeling, bet sizing (ch. 10), backtest overfitting.
- Larry Harris, *Trading and Exchanges*: who trades and why. The "who's on the other side" question.

**Papers** (all cited in § 3): Goyal & Saretto 2009 · Cao & Han 2013 · Boyer & Vorkink 2014 · Bali, Cakici & Whitelaw 2011 · Xing, Zhang & Zhao 2010 · Vasquez 2017 · Johnson 2017 · Muravyev 2016 · Muravyev & Pearson 2020 · Muravyev & Ni 2020 · Gao, Xing & Zhang 2018 · de Silva, Smith & So 2025 · Heston et al. 2023 · Chan 2003 · Nagel 2012 · Daniel & Moskowitz 2016 · Driessen, Maenhout & Vilkov 2009 · Bakshi & Kapadia 2003 · Israelov 2019 · Shu, Yu & Mulvey 2024 · Harvey, Liu & Zhu 2016. Intraday set: `intraday-entry-literature-2026-11-10.md`.

**Podcasts / video / social** (practitioner, lower evidence grade)
- *Alpha Exchange* (Dean Curnutt): Roni Israelov (put protection, VRP), Benn Eifert (QVR), Kris Abdelmessih.
- *Flirting with Models* (Corey Hoffstein): Benn Eifert. *Odd Lots*: Eifert on vol selling. *ReSolve Riffs*: Eifert & Maidel, Abdelmessih.
- tastylive *Market Measures* / *Best Practices*: 45 DTE entry, 21 DTE / 50 % management (their own strangle studies, vendor research; S017/S103 found fixed profit-takes lose on our real quotes).
- Risk.net 2024, "The options experts who think vol selling is a broken trade".

---

## 6. Next step (one, not a list)
Run **G1's decomposition** on the put trades we already have. It is cheap and needs no new data. It also decides whether the idio-vol penalty in the fit score is right or backwards, which changes the names Jamie is shown every day. Then build G2 (`opportunity_ev`) with G1's answer as its first state variable. Ideas cap is 19/15, so G1 goes into an existing put-selection row (A370 indicators-as-put-filters or the put_benchmark gate), not a new row.

## Sources
- [Goyal & Saretto 2009, JFE](https://econpapers.repec.org/RePEc:eee:jfinec:v:94:y:2009:i:2:p:310-326)
- [Cao & Han 2013, JFE](https://econpapers.repec.org/RePEc:eee:jfinec:v:108:y:2013:i:1:p:231-249) · [OptionMetrics summary](https://optionmetrics.com/research/j-cao-and-b-han-cross-section-of-option-returns-and-idiosyncratic-stock-volatility/)
- [Boyer & Vorkink 2014, JF](https://ideas.repec.org/a/bla/jfinan/v69y2014i4p1485-1527.html) · [CXO summary](https://www.cxoadvisory.com/equity-options/sell-lottery-tickets-for-their-fun-and-your-profit)
- [Bali, Cakici & Whitelaw 2011, JFE](https://econpapers.repec.org/RePEc:eee:jfinec:v:99:y:2011:i:2:p:427-446) · [NBER WP](https://www.nber.org/papers/w14804.pdf)
- [Xing, Zhang & Zhao 2010, JFQA](https://econpapers.repec.org/RePEc:cup:jfinqa:v:45:y:2010:i:03:p:641-662_00)
- [Vasquez 2017, JFQA](https://econpapers.repec.org/RePEc:cup:jfinqa:v:52:y:2017:i:06:p:2727-2754_00) · [Alpha Architect](https://alphaarchitect.com/2014/01/equity-term-structure-and-option-returns/)
- [Johnson 2017, JFQA](https://ideas.repec.org/a/cup/jfinqa/v52y2017i06p2461-2490_00.html) · [CXO](https://www.cxoadvisory.com/volatility-effects/vix-term-structure-slope-and-variance-asset-future-returns/)
- [Muravyev 2016, JF](https://zendy.io/title/10.1111/jofi.12380)
- [Muravyev & Pearson 2020, RFS](https://ideas.repec.org/a/oup/rfinst/v33y2020i11p4973-5014..html) · [CXO](https://www.cxoadvisory.com/equity-options/timing-option-trades-to-suppress-trading-frictions/)
- [Muravyev & Ni 2020, JFE](https://econpapers.repec.org/RePEc:eee:jfinec:v:136:y:2020:i:1:p:219-238) · [CXO](https://www.cxoadvisory.com/equity-options/intraday-versus-overnight-option-returns/)
- [Gao, Xing & Zhang 2018, JFQA](https://ideas.repec.org/a/cup/jfinqa/v53y2018i06p2587-2617_00.html)
- [de Silva, Smith & So 2025, RoF (Stanford GSB)](https://www.gsb.stanford.edu/faculty-research/publications/losing-optional-retail-option-trading-expected-announcement) · [Quantpedia](https://quantpedia.com/how-retail-losses-money-in-option-trading/)
- [Heston et al. 2023, JF "Option Momentum"](https://alphaarchitect.com/option-momentum/)
- [Chan 2003, JFE](https://econpapers.repec.org/RePEc:eee:jfinec:v:70:y:2003:i:2:p:223-260)
- [Nagel 2012, "Evaporating Liquidity"](https://www.nber.org/papers/w17653.pdf)
- [Daniel & Moskowitz 2016, "Momentum Crashes"](https://www.nber.org/papers/w20439)
- [Driessen, Maenhout & Vilkov 2009, JF](https://ideas.repec.org/a/bla/jfinan/v64y2009i3p1377-1406.html) · [CXO](https://www.cxoadvisory.com/?p=2110)
- [Bakshi & Kapadia 2003, RFS](https://ideas.repec.org/a/oup/rfinst/v16y2003i2p527-566.html)
- [Israelov 2019, "Pathetic Protection"](https://alphaarchitect.com/pathetic-protection/)
- [Shu, Yu & Mulvey 2024, jump-model regimes](https://arxiv.org/abs/2402.05272)
- [Harvey, Liu & Zhu 2016, RFS](https://www.nber.org/papers/w20592)
- [López de Prado meta-labeling / triple barrier (Hudson & Thames)](https://hudsonthames.org/does-meta-labeling-add-to-signal-efficacy/)
- [Fundamental law (CFA Institute)](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2025/analysis-active-portfolio-management)
- [Sinclair, Positional Option Trading (Moontower notes)](https://notion.moontowermeta.com/positional-option-trading-by-sinclair)
- [Moontower primer](https://moontower.substack.com/p/primer-1-introduction) · [Adverse selection](https://moontower.substack.com/p/adverse-selection-in-the-options)
- [tastylive 45/21 DTE study](https://www.tastylive.com/shows/best-practices/episodes/trade-entry-and-exit-07-08-2019)
- [Risk.net: vol selling a broken trade?](https://www.risk.net/investing/7962573/the-options-experts-who-think-vol-selling-is-a-broken-trade) · [Moontower: derivative income](https://moontowermeta.com/derivative-income-bumhunting/)
- [Gao, Han, Li & Zhou 2018, intraday momentum](https://econpapers.repec.org/RePEc:eee:jfinec:v:129:y:2018:i:2:p:394-414)
