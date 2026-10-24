# A241 parity findings (analyze → fix → retest)

Standing loop (Jamie 10-24): daily recon will go yellow/red once VM jobs diverge from Mac timing — that is expected. Each non-green day: diagnose → implement fix → re-run `node scripts/parity/vm_vs_mac.mjs` → only then count toward the 10-day pass.

| date | status | issue | fix / next |
|---|---|---|---|
| 2026-10-24 | GREEN | P2 dump baseline — exact OHLCV match 5 days; band clean | P3 jobs not live yet; next recon after VM schedule writes |
