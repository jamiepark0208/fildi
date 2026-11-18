# Enhancing the working signals — literature pass + test queue (Jamie 11-17)

Jamie 11-17: "for the patterns that work, research if others found ways to enhance these signals with other factors, better
thresholds, or other use cases… keep building on top of them."

## What the literature says (claim · sample · effect · survives costs?)
| Paper | Claim | Fits which Fildi signal |
|---|---|---|
| Fassas & Hourvouliades 2019, JRFM 12(3):113 — VIX futures as a market-timing indicator | Backwardation slope (front > back) has a significant contrarian coefficient on S&P returns; the *size* of the slope matters, not only the sign | S172 un-invert: we use a binary flip. Test the depth of the inversion (peak VIX÷VIX3M during the run) as a size/confidence scaler |
| Tosi & Ziegler 2017 (via CXO) | Short puts do best when moving from a high-vol to a low-vol state; selling deeper OTM when VIX is high improves the strategy | Un-invert IS the high → low vol transition → combine with panic puts; depth by VIX level (our S101 says nearer Δ in sharp drops — conflict to settle) |
| Bondarenko (via CXO) · IPS / QVR practitioner reports | Index puts overpriced; the premium shrank after 2009 (~⅓ of the old size) and needs reserve capital | Our IV÷RV edge: check its size by year; size positions with a crash reserve |
| Wysocki 2025, arXiv 2508.16598 — Kelly, VIX and hybrid sizing for put writing | Sizing by VIX regime beats fixed size on the same put-write | New use case: size, not selection — put size by VIX÷VIX3M / VIX level |
| Antila 2025 (Vaasa) — conditional put-write on IV vs RV | Conditioning put-writes on the implied − realized spread improves the risk-adjusted return | = our IV÷RV gate (S003/S004); nothing new beyond confirmation |
| Chan, Jegadeesh & Lakonishok 1996 JF / 1999 FAJ | Price momentum and earnings-revision momentum each predict returns after controlling for the other; the combination beats either | = S100 (revisions + 60 d return); ~41 % of the momentum premium lands near earnings → test calls timed into the print |
| tastytrade (practitioner) | Selling blue-chip puts after a 5 % correction has a high win rate | Close to the panic put; a lower-bar "correction put" for large caps |

## Test queue (ranked by expected value to Jamie's trades; each is pre-registered before running)
1. **Panic put × un-invert combo** — do panic puts that fire within 10 sessions after a VIX÷VIX3M un-invert beat panic puts on other days? (Tosi–Ziegler mechanism.) Regime cell = un-invert window vs not; n check first (panic fires × 38 un-inverts).
2. **Inversion depth as a confidence scaler** for S172 — SPY next-21-day move vs the peak ratio of the inverted run (≥ 1.05 vs 1.00–1.05). 38 episodes → likely "can't answer at this n" per bucket; use as a size tilt only if the slope is monotone.
3. **VIX-regime put sizing** (Wysocki) — the same Model List puts, sized ½ / 1 / 1.5× by VIX÷VIX3M state; compare return per $ of max drawdown.
4. **Strike depth by VIX level** — settle S101 (nearer Δ in sharp drops) vs Tosi–Ziegler (deeper when VIX high) on real LSEG quotes.
5. **Revisions + momentum calls timed into earnings** — S100 picks entered 5–10 days before the print vs at a random date.
6. **Is the IV÷RV edge shrinking?** — per-year S003 edge 2010 → 2026; if it fell, lower the size, not the signal.

**Results:** #1 + #3 = S197 → can't answer at this n (6 un-invert episodes, 9 stressed runs in 2022/25/26 option trades); puts sold while VIX is still inverted did best (+2.79 % vs +1.34 calm), against the "wait for un-invert" story. Needs 2008–2021 option trades before either becomes a rank/size boost. Next: #4 strike depth by VIX level.

**#4 = S202 (11-18):** no tilt — high-VIX deep − near +0.22 %/wk, t 0.6 (sign rises with VIX as Tosi–Ziegler says, not significant). Lean: at VIX ≥ 22 deep strikes earn the same at half the swing (P 0.10, losses 6.6 vs 14 %). S101's 'nearer after drops' not seen on real quotes. Next: #5 revisions + momentum calls timed into earnings.

## Shipped alongside (11-17)
- Today page (`/today`): run status, every signal firing with its backtest number, the ranked Today list, all put ideas.
- Put ideas: odds floor ~90 → 80 % (|Δ| ≤ 0.20), soft gates → cautions: 12 → 106 ideas shown (6 best, 100 options).
- S172b model-free check: 34 un-inverts since 2010, SPY +2.98 % next 21 d vs +1.10 % any day, up 79 % vs 68 %, t 2.4; both halves.

Sources: mdpi.com/1911-8074/12/3/113 · macrosynergy.com/?p=41000 · cxoadvisory.com/equity-options/is-40-per-month-shorting-index-puts-a-fair-return ·
arxiv.org/html/2508.16598v1 · osuva.uwasa.fi/bitstream/10024/19822/2/Uwasa_2025_Antila_Niko.pdf · ideas.repec.org/a/bla/jfinan/v51y1996i5p1681-1713.html ·
ideas.repec.org/a/taf/ufajxx/v55y1999i6p80-90.html · financial-planning.com (IPS Strategic Capital short-vol report)
