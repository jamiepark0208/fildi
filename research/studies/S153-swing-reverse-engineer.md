# S153 — intraday top swings vs indicator events (A335)

Universe: 61 tickers with Yahoo 5m (~60d). Labels: zig-zag legs ≥ 1.5 ATR(14), top 3 per ticker-day (7506 swings over 42 session-days). Catch window: [start−3, start+2] on 5m bars, same side. Half split at 2026-10-07.

**Random vol-matched base precision** (preMove ±0.25): **9.4%**

## Recall / precision by indicator × kind

| indicator | kind | recall | precision | vs base | n events |
|---|---:|---:|---:|---:|---:|
| ut | Sell | 31.8% | 19.9% | 2.12× | 16964 |
| ut | Buy | 31.2% | 19.9% | 2.13× | 16878 |
| ichimoku | TK cross | 17.9% | 10.6% | 1.13× | 13517 |
| st | Flip | 16.6% | 20.6% | 2.20× | 7599 |
| mso | CHoCH | 14.0% | 19.1% | 2.03× | 6796 |
| squeeze | Release | 13.9% | 12.9% | 1.38× | 9581 |
| mso | BoS | 10.3% | 13.5% | 1.44× | 6661 |
| mso | Div | 4.9% | 9.8% | 1.05× | 3785 |
| lsh | Sweep | 1.6% | 36.7% | 3.91× | 368 |

## Context filters (precision lift ≥1.5× base, n≥50 both halves)

| filter | H1 prec (n) | H2 prec (n) | lift H1/H2 | pass |
|---|---:|---:|---:|:---:|
| open_9:30-10:30_ET | 33.8% (10704) | 34.3% (10821) | 3.61/3.66 | Y |
| 5m+15m_same_side | 30.7% (4599) | 28.2% (4249) | 3.27/3.01 | Y |
| SPY+QQQ_same_side_10m | 19.1% (22591) | 18.6% (23893) | 2.04/1.99 | Y |
| squeeze_on | 16.5% (21313) | 14.9% (17813) | 1.76/1.59 | Y |
| mid_10:30-14:00_ET | 11.8% (18618) | 10.7% (16762) | 1.26/1.14 | n |

## Example session-days (largest swings; UT catch noted)

### 2026-11-04
- Session-wide **UT sell ~07:20 PT** (10:20 ET) caught multiple top swings (HUT, ASTS, IREN, RKLB, INTC, …; aligns 11-04 Live read)
- Largest labeled legs that day include hotlist names in the catch window (see `out/s153_results.json`)

### 2026-11-03
- IOND buy 22.6ATR @ 2026-11-03 06:30 PT catch=UT
- NOW buy 9.3ATR @ 2026-11-03 06:30 PT catch=UT
- HUT buy 8.4ATR @ 2026-11-03 06:30 PT catch=UT

### 2026-10-07
- GOSS sell 17.5ATR @ 2026-10-07 11:10 PT catch=other
- DRAM buy 10.8ATR @ 2026-10-07 06:30 PT catch=UT
- RKLB buy 8.6ATR @ 2026-10-07 10:55 PT catch=UT

### 2026-09-14
- CABA buy 14.9ATR @ 2026-09-14 06:35 PT catch=UT
- AEP sell 9.7ATR @ 2026-09-14 06:30 PT catch=other
- VIST buy 8.6ATR @ 2026-09-14 06:30 PT catch=UT


## Verdict

Highest recall among n≥100 events: **ut / Sell** recall 31.8%, precision 19.9% (2.12× base).
Filters passing preregistered bar: **open_9:30-10:30_ET, 5m+15m_same_side, SPY+QQQ_same_side_10m, squeeze_on**.
Recall answers “did the indicator see the big swing”; precision answers “was this signal one of those swings”. Neither replaces round-trip grading (A334).