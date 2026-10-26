# Research correctness and efficiency closeout — 2026-10-26
Implemented by Codex under A212; independent review requested from Claude. Not verified or financially promoted.

## Delivered
- Option cache: budget/auth/transport failures propagate; only confirmed invalid-universe errors are negative-cached. Cache-only missing quotes fail explicitly. Existing old empty rows are NOT automatically deleted/refetched.
- S064: validate actual fallback strike delta; exchange-calendar expiry (Good Friday → Thursday); require all 63 following sessions rather than silently shifting missing dates. Shared calendar supports 2020–2027; unsupported years fail closed.
- S071: persist source-hashed JSON trade ledger; --from-trades replays without DB/vendor acquisition; --cache-only refuses absent quotes; request limit counts retries, incomplete capped runs cannot publish final reports; DB closes on failure; smoke/replay filenames separate; deterministic inference seed; zero variance reports unavailable t rather than crash. Default full report unchanged in purpose.

## Verification actually run
13 offline tests: option_prices_test (5), s064_mechanics_test (6), s071_replay_test (2). Normal imports of S064/S071 pass using research/lseg/.venv. Five-name cached-data, read-only comparison (AAPL/AMD/CAVA/MU/SHOP): 660 baseline vs 660 corrected trades; no added/dropped, 36 matched records change expiry/strike/settlement/outcome. This is a mechanics smoke, not a full economic rerun or endorsement. JSON and reproduction script alongside this file.
26 existing scoring/risk/quote tests also pass in the measured output run. Full raw output and compact output retained. o200k_base token counts: 1024 → 193, reduction 831 (81.15%). Measured output reduction only; not measured Astra billed-token/whole-task/subscription savings. Temporary tokenizer dependency only, no production hook/model/package added. Compact output keeps failures and tail; full log remains reviewable.

## Independent verification packet (Claude, A212)
Read scoped diff + tests, rerun fixtures and normal imports. Check expiry contract naming, supported-calendar boundary, conservative gap exclusions, failed cache requests, request-limit behavior, replay equality/no acquisition and no partial-final output. Confirm 36 changed smoke records are explained before publishing updated S064 conclusions. Run full corrected S064 locally only after mechanics review; isolate outputs and compare exclusions, effect/CI and fill sensitivity. Vendor confirmation gets an explicit remaining shared allowance; no new acquisition required for these fixtures. Accept/rebut findings with evidence. Mark verified only after independent pass on the commit.

## Next owners (existing Ideas; no duplicate IDs)
- A212 → Claude: independent code/economic review above; exact current earnings policy evaluation and S067 remain separate research backlog, not completed by these fixtures.
- A121 → Cursor after Claude plan review: stable scoreboard identity/clear obsolete error row; fixture failure→success must leave one active row, preserve last-error provenance; no data deletion by label guess.
- A207 → Cursor after Claude plan review: latest review + full text access, explicit next owner/verdict and evidence maturity versus readiness; unknown benefit remains unknown, never manufacture confidence improvement. Verify A212 newest packet visible beyond old 1600-character cutoff. Reuse current ASKS parser/UI, no new queue.
- A257 → Cursor: existing risk coverage repair. Sparse/missing-date and near-singular books must not show misleading zero/full-coverage risk. Add coverage labels and defined fallback; independent quant review required.
- A260 → Cursor: later-expiry exposure remains visible even when front MC is low. Context display, no opportunity cash gate. Fixture back-week-only book. Full multi-expiry repricing remains separately budgeted.

No trading, new financial parameters, new scheduled runs, cloud deployment or browser work. Live review stays paused.
