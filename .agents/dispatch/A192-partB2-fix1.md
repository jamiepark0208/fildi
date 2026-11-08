A192 Part B2 fix1 (Refs: A192). Fix items 1–4 of "Claude review a03e0d33" at the end of research/common/asks/A192.md.
File: scripts/watchlist_sync/analysis/structure_vec_engine.py (csp_bp, B2 trade loop in run_ticker_b2 ~line 790–850, summarize_b2, S165 report lines ~1130–1170).
Smoke gate: on AAPL/MSFT/JPM, CSP control pooled $/BP/day within 2× of B1 naive CSP (≈ +1.6 bp/day), and assert it in code. Print the front-ratio entry credit distribution + 5 worst trades.
Then re-run 30 names (--b2 --smoke-n 30). Rewrite out/opt/S165.md, fix the INDEX S165 row, set any BOARD S165 row back to testing unless the pre-registered bar is met. Packet ≤ 8 lines appended to A192.md. Commit Refs: A192, Agent: cursor.
