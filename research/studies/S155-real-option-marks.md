# S155 — indicator signals priced with real option prints (Claude, 2026-11-04)

**Question:** after a 5m signal (UT, ST, Ichimoku, LSH, Squeeze, MSO), does an ATM option trade (long/short straddle, long call/put with the signal, long call/put against it) beat entering on a nearby bar, using REAL option prices?

**Data:** Polygon minute trade prints, ATM call + put (strike nearest the 9:35 spot, nearest expiry >= 2 DTE), 150 sampled ticker-days (deterministic, round-robin across tickers), 69 priced (rest: no 5m bars / no listed contracts / thin prints). 81,692 trades. Raw responses in vendor_raw (source polygon) + research/cache/polygon_options/s155.

**Method:** entry/exit = first print after the time (<= 10 min). Holds 30m / 60m / close (15:50). Comparator = same contracts, same side, entries 5–30 min AFTER the signal (paired per ticker-day). P&L gross of spread (break-even spread = lift). Pass = lift > 0, Holm p < 0.05, both calendar halves > 0, >= 30 ticker-days.

**Result: 0 / 60 cells pass. No option edge from signal timing.**
- Base (any bar, gross): ATM straddle 30m −0.1 %, 60m −0.3 %, to close −1.5 % of premium; long call/put −0.3 to −0.7 %. Spreads come on top.
- Largest cell: ST long straddle 30m lift −1.2 % (t −2.7, Holm 0.40).
- Stock check (same events): move in signal direction vs later bars ≈ 0 (best UT 60m +0.12 %, t 1.8).

**Mistakes caught on the way (keep for future studies):**
1. Baseline from bars ±30 min around the signal includes the pre-signal move that made the signal fire → fake "fade wins +5–8 %, t 7". Baseline must start AFTER the signal.
2. The first run's "close" holds compared late-day signals against all-day entries (different hold lengths).
3. Trade prints after a jump sit at the ask for chasers and at the bid for faders → bias of up to half a spread; use quotes when available.

**So what:** no rule to adopt. Timing intraday option entries off these 6 indicators adds nothing on real prices; S152/S154 earlier "passes" were pricing artefacts (A334 audit). Revisit trigger: Polygon/LSEG intraday quotes (NBBO) or ≥ 200 priced ticker-days.

Re-run: `research/studies/scripts/s155_real_option_marks.py --days 150` · cells (fair baseline): `out/S155/cells_after_baseline.json`
