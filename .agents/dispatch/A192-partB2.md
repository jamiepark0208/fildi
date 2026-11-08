A192 Part B2 (Refs: A192): family B payoff shapes on the CSP's own entries. Spec: research/studies/PLAN-option-structures.md § 8 family B + § 9.3 row B; review notes at the end of research/common/asks/A192.md ("Claude review 197b5fcb").
Engine: scripts/watchlist_sync/analysis/structure_vec_engine.py (extend; keep gates 1–5 + pooled rank + de-overlap + same-day IV).
Entries: reuse the live CSP rules as-is (S088 strikes, S087 timing in scripts/watchlist_sync/analysis/s087_collateral_timing.py, S059 factors). Do not re-search entries; the shape is the only variable.
Shapes: CSP (control) · put vertical (wing 5/10 % or Δ 0.10) · jade lizard · put front-ratio · put BWB. Exits: CSP live rules, TP 50 %, 21 DTE. Grade = pooled $/BP/day vs the same entries' CSP at the same BP, month-block t, worst 5 %, train 2021–23 / test 2024→, at the −2.7 vol pt edge too.
Also fix review note (a): cap floor ≥ 5 % of wing width (or drop), and print median exc.
Smoke gate: gates 1–5 pass; on AAPL/MSFT/JPM the CSP control reproduces the naive-CSP pooled sign; hand-check 1 jade lizard (legs, credit, BP, day-10 mark).
Then run 30 names. Write out/opt/S165.md + an INDEX row. Packet ≤ 8 lines appended to A192.md. Commit Refs: A192, Agent: cursor.
