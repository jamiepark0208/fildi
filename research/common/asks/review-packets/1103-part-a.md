# Quant commit review packet — 2026-11-03 part A
Range: `b5f33ac7..HEAD` on `cursor/mac-dev`. Read-only; independence from Muse reviews.

## A318 — Stock DB gold source pick (commits other than 3c3bc7a9 / cc3ba69b)
**SHAs:** 1feb2c84, 045491e9, 1e7c64c8, 42b9361e (Claude-passed 3c3bc7a9 / cc3ba69b excluded here).
**Verdict proposal:** pass (42b9361e); superseded pass (045491e9, 1e7c64c8); prep OK (1feb2c84).

1. **Segment 0 ruler + zero non-ruler FactSet gold** — claim: matches plan pass bar. Evidence: `045491e9` factset-referee / merge-trusted ruler table; status packet 388→85 FactSet gold, 0 non-ruler FactSet gold; Claude review 045491e9 pass on file.
2. **1e7c64c8 eval stop rule** — claim: was below 27/30 until seg fix. Evidence: `A318.md` Claude eval 15/21; superseded by 3c3bc7a9 (21/21 judged, not re-litigated here). No separate revert needed.
3. **42b9361e NI to common in SEC gold** — claim: fixes minority-inflated SEC netIncome/netMargin without look-ahead. Evidence: `sec_gold_fields.py:72–81` reuses `_roa_ni_numerator`; query TKO netIncome **229.6 M**, ROA **1.45%** vs ProfitLoss path **661 M** (`financials.FLOWS` still largest-tag for DCF-only paths — commit message + `inputs()` uses NOPAT/minority bridge, not this NI). Scored-book audit in commit: 62 changed, 11 empty→1 (CMI).
4. **Scope** — claim: 42b9361e touches only SEC populate + A318 row; no silent fund weight change. Evidence: diff 1 file; fund_score moves only after merge refresh.

**pass, checked:** segment-0 acceptance on SHA 045491e9; 1e7c64c8 superseded; 42b9361e TKO/KKR SEC NI + ROA spot-check; no as-of leakage in SEC TTM (filed date = period in existing `ttm_flow`).

---

## A283 — Fair value v2 (fv-2.0.0 three chips, headline within 2×)
**SHAs:** f4763cb5 (+ earlier A283-tagged DCF commits in range: eaa19cd5, faa00e0e, 376aebde, 17df475c).
**Verdict proposal:** pass.

1. **Headline rule** — claim: midpoint only when street mid / cash mid ≤ 2. Evidence: `fair-value-v2.ts:13,61–68`, `MAX_FAMILY_RATIO = 2`; fixture PLTR null headline, MSFT midpoint in `fair-value-v2.test.ts:10–24`.
2. **No cross-family blend in rank/list** — claim: display-only v2 route. Evidence: f4763cb5 stat — badge + `/v2`; comment L8 “never gates, sizes or ranks”.
3. **Units / leakage** — claim: SKHY-like points quarantined; DB-only API. Evidence: `ok()` filter L41–45; status note 55-name table matches chip counts (headline 9, split>2× 24).
4. **Eval** — claim: Jamie 11-02 sign-off recorded; lab numbers in `A283.md` not re-run (display promotion). Engine growth fixes in range are lab-tagged, not Model List weights.

**pass, checked:** 2× logic in code + tests file; scope display-only; no vendor call in v2 builder.

---

## A286 — DCF segment SOTP from XBRL
**SHAs:** none with `Refs: A286` in range (only d0765701 review prose). Parser shipped pre-range (`b5f33ac7` pass).
**Verdict proposal:** pass (no new valuation diff in range).

**pass, checked:** git log `b5f33ac7..HEAD --grep A286` → no engine/NOPAT SOTP commit; prior acceptance (S118 sums) unchanged.

---

## A288 — DCF bridge ITM convertibles as shares
**SHAs:** ac1fba59 (in range; fixes prior Claude revise on f5b7f9ed).
**Verdict proposal:** pass.

1. **BABA +36% shares** — claim: fixed. Evidence: `engine.py:407–410` zero rsu+opt ≥30% sh0; query BABA flags include `dilution rsu/opt zeroed (≥30% shares — likely unit mismatch)`, shares **1858M** (not +667M bump).
2. **Convert double count** — claim: fixed. Evidence: `engine.py:397–405` restores debt when `used_gap` + convert_sh; ONDS path in packet.
3. **Reclass never runs** — claim: partially fixed via 10-Q overrides. Evidence: NET ITM reclass **+14.7M sh, −$3.27B debt** live query; A288-packet ≥3 ITM names; SMCI still kept-as-debt (OTM) — acceptable per spec “names without converts unchanged”.
4. **Tests** — `dcf/convert_reclass_test.py` → ok.

**pass, checked:** BABA/NET/AAPL engine spot-check; guards 1–3 in ac1fba59; unit test green.

---

## A250 — Model List puts ~0.09Δ vs 0.15
**SHA:** fa4c1d1e (doc confirm); live rule in `rules.py` from earlier ship.
**Verdict proposal:** pass.

**pass, checked:** `PUT_TARGET_ABS_DELTA = 0.09` (`rules.py:19`); fa4c1d1e does not restore 0.15 target; `PUT_NAME_INCOME_ABS_DELTA = 0.15` eligibility only (Grok caveat pre-existing, not introduced in range).

---

## A277 — One recommendation engine per structure
**SHA:** 6e74911c (S101c study); related untagged 46756ddf / e3d26df5 (put_recs unification, in range).
**Verdict proposal:** pass (study + producer fixes); **revise** on full row acceptance (§3 checklist still open).

1. **S101c** — claim: FAIL bar met honestly. Evidence: `S101c.md` / commit message — no call_recs; aligns stop rule.
2. **46756ddf** — claim: fixes strike/score divergence at producer (`put_recs.py` contract-scored pins) — quant-ops, no new delta target.
3. **Gap** — claim: TS `pickBestStrike` still in scanner paths (`options-scanner.tsx:512`, `option-score-snapshots.ts:462`) — A277 §2 not finished; not a regression in 6e74911c.

**pass, checked:** S133 not applicable; S101c FAIL documented; rules.py delta unchanged.

---

## A244 — Long calls/puts strategy
**SHA:** 2d37154e (S133).
**Verdict proposal:** pass (study correctly FAIL; row stays parked).

**pass, checked:** `S133.md` verdict FAIL all arms; no `build_plan` buy_calls keys added in range; stop rule honored.

---

## Untagged commits (scoring / fundamentals / model list paths)
| SHA | one-line verdict |
|---|---|
| 42b9361e | **pass** — SEC NI to common for gold populate (A318-tagged; see above). |
| 46756ddf | **pass** — put_recs contract-scoring after write; fixes display inconsistency, same band engine. |
| e3d26df5 | **pass** — widen to income floor vs drop names; ladder shows engine pick (no new scoring formula). |
| b27e178c | **pass** — band state uses fresher spot + daily VIX; point-in-time for state, not future data. |
| 0b9f22af | **pass (ops)** — Model List resume/freshness bookkeeping; no strike rule change. |
| 7b0dbd01 / e9c2c998 | **pass (ops)** — maintain/daily timing; no score math. |
| 798cff92 | **pass (ops)** — A303 vendor circuit; not a silent fund/ML weight change. |
| 7ec3ee84 / fd6c1836 / d0fd5a38 | **pass** — awareness chips only; no gates (per commit messages). |

---

**Summary:** A318 (other) pass · A283 pass · A286 pass (no new diff) · A288 pass · A250 pass · A277 pass study/producer, row acceptance revise · A244 pass (FAIL study) · untagged listed above pass except noted ops-only.
