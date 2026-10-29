# A314 family 3 — vol-of-vol & VIX term (daily S130 harness)

Split H1/H2 at 2018-01-01 on 2009-09→ sample; incremental = logit 5d breach ~ vix≥25 + term invert + rv_accel + arm (S126 N/A — no intraday VIX).

- **vix_1d_spike** · CBOE VIX daily · ΔVIX top decile → higher 5d put breach · n≈83 · effect H1/H2 -4.0/+1.8pp breach · t -1.2/+0.4 · incr -1.2/+0.3 vs vol baseline · MDE≈6.4pp · **FAIL**
- **vix9d_over_vix** · CBOE VIX9D/VIX · VIX9D/VIX > 1.02 → near-term stress, higher breach · n≈147 · effect H1/H2 +7.5/+6.2pp breach · t +1.5/+1.6 · incr +1.9/+1.6 vs vol baseline · MDE≈7.1pp · **FAIL**
- **term_inverted** · CBOE term (S130) · VIX/VIX3M > 1 → panic curve, higher breach · n≈60 · effect H1/H2 +3.2/-0.4pp breach · t +0.5/-0.1 · incr n/a/n/a vs vol baseline · MDE≈7.1pp · **FAIL**
- **term_slope_5d** · CBOE term slope · 5d rise in VIX/VIX3M top decile → higher breach · n≈94 · effect H1/H2 -1.4/-1.9pp breach · t -0.4/-0.5 · incr -0.5/-0.6 vs vol baseline · MDE≈7.1pp · **FAIL**
- **vvix_spike** · CBOE VVIX · VVIX spike (90th or +10%/d) → higher breach · n≈103 · effect H1/H2 -2.4/-4.3pp breach · t -0.7/-1.1 · incr -1.2/-1.3 vs vol baseline · MDE≈5.3pp · **FAIL**
- **rv_accel** · SPY realized vol · RV5/RV20 5d jump top decile → higher breach · n≈84 · effect H1/H2 -4.4/-9.3pp breach · t -1.5/-3.4 · incr -0.8/-1.9 vs vol baseline · MDE≈3.8pp · **FAIL**
- **intraday VIX bars** · n/a · no stored intraday VIX series · **skip intraday**
- put overlay: none (no daily PASS)
