A357 step 4 — replace the ~6 h full backfill with a sampled one (Claude 11-06; fix1 6f0c942b reviewed pass). Full run is NOT running (pid 65822 + watcher died); do not restart it.

Edit scripts/watchlist_sync/analysis/a357_lse_option_backfill.py and analysis/a357_regrade.py:
1. New `--sample` mode: per entry day d (same groups as a357_regrade._tercile_book, groups ≥ 20, d ≥ WEEK_FLOOR), pick the top tercile by A352.rebuild_book score AND the seeded random tercile (same rng seed as _tercile_book). Tag each event `book` = champion|random|both. Select events BEFORE snapping so /v3/pairs is called only for sampled (ticker, expiry). Process days newest first.
2. Persist the selection (table or json under logs/) so the regrade uses the same picks; a357_regrade.py must grade from the stored tags, not re-rank the sampled subset, and must run on partial data (drop MIN_BACKFILL_OCC gate → report coverage + n days instead).
3. Expect ~3–4k contracts (~2 h at 60 calls/min). Print the sample size + estimated calls before fetching.
4. Test: selection matches _tercile_book picks on a fixture day; add to lse_client_test.py or a new test. Use scripts/watchlist_sync/.venv/bin/python.
5. Start `--sample` with nohup (log logs/a357-lse-backfill.log); run a357_regrade.py once after the first ~25 % of days land and write the interim result to research/studies/a357-real-price-regrade.md (mark INTERIM). Leave the process running when you exit.
Commit Refs: A357 / Agent: cursor; sync with scripts/agent-git-sync.sh. Packet ≤ 20 lines under ## Reviews in research/common/asks/A357.md (sample n, calls, interim champion−random at 0/5/10 % haircuts, coverage).
