STUDY CONTRACT (any [quant] / study / backtest / grid run — the packet is INCOMPLETE without every line; Claude rejects INCOMPLETE packets unread):
1. FILL: verdicts use a realistic fill only — stock legs at cross (bid/ask), option legs at bid + 23 % of spread (sell) / ask − 23 % (buy) until the stock's own measured spread is available (rule 9). Mid is printed as context, never as the verdict.
2. COMPARATOR: same capital and same risk (per $ of buying power, worst week, max drawdown) + the T-bill rate for the period. Random/base pools never share the signal's ticker-month (B25).
3. POWER: print n events (independent, de-overlapped). n < 30 or CI crosses 0 → verdict UNDERPOWERED, never WORKS or FAIL.
4. LEAK: one-bar-delayed entry and shuffled-signal placebo on every reported cell; print shift_bp and placebo_p.
5. HALVES: result in both time halves (and SPY > / < 200d when relevant). Sign flips → no WORKS.
6. INPUTS: no approximated dates/levels when the real ones exist (exact CPI/FOMC/earnings dates); say the source of each input.
7. SAME JOB: measure exactly what the acceptance line names (same names, cells, horizon); if you measured something smaller, say so on line 1.
Packet line 1: `CONTRACT 1-7: ok|missing <n>`.
8. PRICING: option legs priced from real quotes. Missing quote → fetch it (sources: .agents/skills/fildi-quant-research/options.md § 2), then the stock's own surface; model only as last resort, tagged `priced_by`, share printed, gap queued for fetch. Never a verdict on unlabeled model prices (S076→S167 incident 11-08).
9. STOCK-SPECIFIC: every threshold applied across stocks (Δ, IV/RV gate, stop, TP, fill, skew, earnings move, colour bands) is the stock's own percentile/measure, shrunk to its sector × vol-tier cluster when data is thin. Read it from the shared context tables, never recompute or hardcode; a global literal needs `# global: <reason>`.
10. DESIGN: each trade row stores an entry snapshot (state, term, skew pct, IV/RV pct, own-move quantiles, levels) + daily path; exits (TP × stop × time) chosen on train; every compared structure gets the same tuning effort.
11. NEGATIVE VERDICT (Jamie 11-08, enforced by scripts/verdict-check.sh on push): before NO-LIFT/FAIL the packet has `## Winner pass` — define the winning trades, compare pre-entry features of winners vs losers (train only), name the next entry/exit rule to test. Verdict line reads `RULE NO-LIFT: <entry> × <exit> × <structure>` — it rejects the rule, never the instrument. Print n_indep (distinct entry dates / episodes); < 30 → UNDERPOWERED.
