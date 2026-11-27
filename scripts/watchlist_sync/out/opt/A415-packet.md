CONTRACT 1-7: ok · see S415.md line 1

# A415 packet — Merton jump-diffusion for the short-put book

**For your trades:** Do not rank puts by trailing jump-count λ̂ or skip Q5 names on high λ̂ — Phase 0 skip hurts (−2.5 bp/wk, t −1.85). Far-OTM weekly band (Z=2.6) underperforms ~0.18Δ on the same weeks (−9.1 bp/wk, t −2.31). GBM/S079 ranker stands; no jump factor.

**In Fildi:** Study only — no shadow score shipped (Merton fit not run; Claude Phase 0 stop). S075 smile stays static skew table.

**Moves (pre-reg):** put-engine pick bp/wk vs live put edge — Phase 0 (b) −2.5 bp/wk vs Q5 alone.

Full numbers: `scripts/watchlist_sync/out/opt/S415.md` · script `analysis/s415_merton_jump.py`.

**Verdict:** RULE NO-LIFT: λ̂ count rank × hold weekly put × structure short put — Phase 0 stop; Merton UC2/UC3 closed.