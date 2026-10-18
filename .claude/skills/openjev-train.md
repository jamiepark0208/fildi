# OpenJev — test + train (not quit)

Load when: a pattern missed, you're adding labels, running `oj eval`/`teach`/`ready`, or debating retiring a use case.

## Rule (Jamie 10-18)
Miss rate = **training signal**. Do not switch to keywords / retire a pattern because the first eval lost. Path: measure → teach misses → `eval --build` → re-verify. Retire only if rebuild still fails after hard examples + better state (prompt/inputs), documented as X with reason.

## Loop
1. **Use** — `oj.py files|run|studies|dupes|skill|ready|ask`
2. **Check** — if you verified anyway: `oj.py outcome <usage_id> yes|no`
3. **Teach on no** — feed the miss (do not just demote):
   - Files: `oj.py teach P10 --usage UID --missed path1 path2` / `--false junk.ts`
   - Ideas: `oj.py teach P27 --ask A96 --label reviewed`
   - Generic: `echo STATE | oj.py teach P14 --label yes --note "why"`
4. **Rebuild** — `oj.py eval <id> --build` (merges `.agents/openjev/corrections/<id>.jsonl`)
5. **Second key** — another agent: `oj.py verify <id>`
6. **Audit** — `oj.py audit` (demote → teach+rebuild, not abandon)

## Ideas readiness (P27)
`oj.py ready A##` → index phase vs OpenJev choice. Disagree → fix status word or teach the label.

## What "train" means here
| Lever | When | How |
|---|---|---|
| Hard examples | Every miss | `oj.py teach` → corrections jsonl → eval --build |
| Better state | Wrong inputs | Fix what you show it (P22 zones text, not chart pixels) |
| Learned head | Multi-signal | `oj.py analyze` (P21-style weights from outcomes) |
| Calibration | Overconfident % | S039 path — calibrate before showing P |
| Fine-tune small model | ≥ ~1k labels/task | README §7 — light always-on tier; Claude owns |

## Do not
- Quit to keyword-only permanently without a `*v2` train attempt
- Hand-type registry metrics
- Gate A/B work on tier C
- Send holdings / keys into OpenJev

Owner: Claude (registry PM). Any agent teaches. Cursor owns Muse→Cursor Ideas checks via P27.
