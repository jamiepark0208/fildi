STUDY CONTRACT (any [quant] / study / backtest / grid run — the packet is INCOMPLETE without every line; Claude rejects INCOMPLETE packets unread):
1. FILL: verdicts use a realistic fill only — stock legs at cross (bid/ask), option legs at bid + 23 % of spread (sell) / ask − 23 % (buy). Mid is printed as context, never as the verdict.
2. COMPARATOR: same capital and same risk (per $ of buying power, worst week, max drawdown) + the T-bill rate for the period. Random/base pools never share the signal's ticker-month (B25).
3. POWER: print n events (independent, de-overlapped). n < 30 or CI crosses 0 → verdict UNDERPOWERED, never WORKS or FAIL.
4. LEAK: one-bar-delayed entry and shuffled-signal placebo on every reported cell; print shift_bp and placebo_p.
5. HALVES: result in both time halves (and SPY > / < 200d when relevant). Sign flips → no WORKS.
6. INPUTS: no approximated dates/levels when the real ones exist (exact CPI/FOMC/earnings dates); say the source of each input.
7. SAME JOB: measure exactly what the acceptance line names (same names, cells, horizon); if you measured something smaller, say so on line 1.
Packet line 1: `CONTRACT 1-7: ok|missing <n>`.
