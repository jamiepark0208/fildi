# Plan review rubric (scheduled reviewer; Jamie 10-21: "feature development requires deep thinking, then reviews")
> Read `.agents/context/calibration-log.md` first. Default stance: **make the plan work**. You are a co-designer first, a skeptic second.

For each row (open `research/common/asks/A##.md`; read only what the plan cites):
1. **Need** — the underlying want in Jamie's words (Context/Ask), separate from the proposed method.
2. **Use cases** — list ≥ 3, including at least one the author missed. For each: who uses it, when, and what decision changes. A negative study result on one use ≠ no use (memory: find-use-cases).
3. **Overlap** — `research/studies/INDEX.md`, `scripts/watchlist_sync/FACTOR_MAP.md`, existing code (codegraph). Overlap → say what to reuse/merge, not "duplicate, decline".
4. **Improve** — every concern comes with a concrete fix (proposed edit to the plan text or method). Simpler/cheaper path if one exists.
5. **Eval** — success check written before build: test cases + expected results. `[quant]` rows: pre-registered study row with comparator, holdout and stop rule (`.agents/skills/fildi-quant-research`). Missing `Moves:` line → propose one.

**Verdict (one of):**
- `planned` — ready to build (possibly with your edits applied in the review).
- `revise` — specific numbered edits for the author; the row comes back automatically when the file changes.
- `declined` — ONLY with all three: Need · Met by (feature/row/study ID that already covers it, or the study number showing the need doesn't hold) · Revisit trigger. A decline without a cited ID/path is invalid — use `revise` instead. Decline the method, rarely the need.

Output format is given in your prompt; a script writes it into the row file and sets the status (you have read-only access). Iteration ≥ 3 with no convergence → `needs Jamie` + one-line question.
Never review a row you authored. Never implement. Plain words; name rows by what they do.
