A192 Part B1 fix1 (Refs: A192). Fix items 1–4 of "Claude review f77dae65" at the end of research/common/asks/A192.md.
File: scripts/watchlist_sync/analysis/structure_vec_engine.py (exit_day, run_ticker, summarize, main Stage 1 report, price_paths_scalar IV lookup).
Smoke gate (before the 30-name re-run): on AAPL/MSFT/JPM Mon entries 2021–23, (a) no time21 cell with dte ≤ 21 is emitted, (b) print pooled vs mean-xpd for call_spread 30d 0.30Δ tp25 (pooled ≈ +0.0001 before item 4), (c) gates 1–5 still pass.
Then re-run Stage 1 on the same 30 names: per family, pooled $/BP/day + mean exc/trade + month-block t; best train cell by pooled → test 2024→ de-overlapped (n, pooled, t); stop rule per review item 3. Update out/opt/S164.md and its INDEX row.
Packet ≤ 8 lines appended to A192.md. Commit Refs: A192, Agent: cursor.
