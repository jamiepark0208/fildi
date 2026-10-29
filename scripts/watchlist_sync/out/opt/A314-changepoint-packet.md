# A314 family 1 — changepoint packet (S142)
SPY+QQQ 479 sessions · minute-matched placebo · H1 < 2025-11-10 ≤ H2

- **bocpd_h40** · changepoint ↑ tail risk (P drop ≥ ½ ATR) · effect H1/H2 -11.1/+0.0 · t -2.0/+0.1 · MDE≈10.8pp · **FAIL** · Adams & MacKay 2007 BOCPD h=1/40
- **bocpd_h60** · changepoint ↑ tail risk · effect H1/H2 -11.5/-5.6 · t -1.7/-0.1 · MDE≈13.6pp · **FAIL** · BOCPD h=1/60
- **bocpd_range** · range CP ↑ tail risk · effect H1/H2 +nan/+nan · t +nan/+nan · MDE≈14.0pp · **FAIL (sparse n=16 events, 9 days)** · BOCPD Student-t on bar range
- **cusum_vol** · volume CUSUM ↑ rest-of-day range · effect H1/H2 -5.8/-5.8 · t -1.1/-1.8 · MDE≈8.1×ATR pp · **FAIL** · Page 1954 CUSUM on log-vol
- **cusum_rng** · range CUSUM ↑ rest-of-day range · effect H1/H2 +nan/+nan · t +nan/+nan · MDE≈n/a · **FAIL (sparse n=3 events, 2 days)** · CUSUM on ATR-scaled range
- **hawkes** · jump cluster ↑ rest-of-day range · effect H1/H2 +16.4/+9.5 · t -0.9/-1.6 · MDE≈4.6×ATR pp · **FAIL** · Hawkes exp kernel on |r|>2
- **bns_jump** · RV−bipower jump ↑ rest-of-day range · effect H1/H2 -5.1/-1.4 · t -1.4/-1.7 · MDE≈2.8×ATR pp · **FAIL** · Barndorff-Nielsen & Shephard 2004
- **cusum_ret** · return CUSUM ↑ tail risk · effect H1/H2 +4.1/-10.0 · t -0.7/-1.8 · MDE≈15.2pp · **FAIL** · Page 1954 (S139 baseline)
- put overlay: none (no intraday PASS)
