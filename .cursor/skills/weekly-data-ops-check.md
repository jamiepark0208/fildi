# Weekly Stock DB data-ops check

Token-efficient weekly (or on-demand) agent job. **Do not** re-explore the pipeline.

## Prefer Maintain spine
Mac Maintain (Sunday 7 AM PT) already runs `weekly-data-ops-check.mjs --digest-only` after the full enrich pass.
If `/tmp/fildi-logs/weekly-data-ops-last.json` is from today (or Maintain actions include `ops_digest_exit_0`), **summarize the value log only** — do not re-drain.

Default non-digest runs **skip FactSet drain + peer-health** when `maintain-full-last.json` shows those succeeded in the last 7 days (`maintain_covered_skip_drain_peer`). Use `--force` only when you intentionally want a second drain.

## READ ONLY THESE (in order)
1. `.agents/context/stock-db-best-realistic.md` — targets + non-interference rules
2. `.agents/context/data-ops-value-log.md` or `.cursor/context/data-ops-value-log.md` — last value proofs (tail)
3. Run output of the check script below (if not already run by Maintain)

## Run (required if digest missing)
```bash
# Prefer (no API spend):
node scripts/weekly-data-ops-check.mjs --digest-only

# Full weekly (only if Maintain did not cover drain/peer this week):
node scripts/weekly-data-ops-check.mjs --max=40

# Force drain even when Maintain covered:
node scripts/weekly-data-ops-check.mjs --max=40 --force
```

What the script does (you do not re-implement):
1. Audit scoreboard **before**
2. Unless `--digest-only` / Maintain-covered: `merge-trusted` → optional FactSet `drain-needs-review` → `peer-health-check`
3. Audit **after**
4. Append quantified benefit to `.cursor/context/data-ops-value-log.md` + `/tmp/fildi-logs/weekly-data-ops-last.json`

## Your job after the script
Reply to the user in this exact shape (keep short):

```
Weekly data-ops: IMPROVED | NO MATERIAL CHANGE
- Needs Review: A → B (Δ)
- P/E filled: …  PEG filled: …
- FactSet spent: N  remaining: M
- Peers: mapped X/Y · newly classified N · still unmapped N · keyword mismatches N
- Actions: …
Proof: .cursor/context/data-ops-value-log.md
Off-target vs best-realistic §1: <only if any metric misses target>
Peer review (if keyword mismatches > 0): list tickers from /tmp/fildi-logs/peer-health-last.json → flags.keywordMismatch — Reassign in Settings if wrong
```

If script exits non-zero: show the error tail; do not invent fixes across 10 files — fix the one failing step.

## Hard limits
- Never full-universe free enrich in this job
- Never exhaust FactSet (script already guards remaining ≥ max+20)
- Never start scorer unify from this skill
- Quote coverage as **filled/total** (lesson L-2026-09-28-01)
- Peer keyword mismatches are **flags only** — do not bulk-rewrite primaries; use Peer Group Reassign for confirmed errors

## Ops alerts
Settings → Scheduled Tasks → Ops health surfaces research WRDS/LSEG stale + missing Sunday digest. Maintain hard-fails also fire a macOS notification.
