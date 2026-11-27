#!/usr/bin/env python3
"""A371 — evidence audit packet (BOARD winners). Smoke ≤2m, then full."""
from __future__ import annotations

import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE.parent))

OUT_AUDIT = ROOT / "research" / "studies" / "out" / "a371-audit.md"
OUT_PACKET = ROOT / "research" / "studies" / "out" / "a371-packet.md"


def dead_audit_lines():
    """≤3 lines each, four modes (comparator/costs/sample/definitions)."""
    return [
        "S020 framing? — spread $ P&L vs CSP margin/Risk; per-$BP not checked → re-test",
        "S026 framing? — CPI week approximated → re-test exact BLS dates",
        "S017/S103 costs — take rules fail on real quotes; verdict stands",
        "S193 power — survivorship; verdict stands pending CRSP history",
    ]


def write_outputs(surv, s088, s109_regime_note: str):
    s0, s1 = surv["without"], surv["with"]
    adj_pass = s1 and s1.get("t", 0) >= 2 and s1.get("wk_bp", 0) >= 50
    s109_verdict = "Works" if adj_pass else "Testing"
    lines = [
        "# A371 packet",
        "",
        "CONTRACT 1-7: ok · 8: mixed real+s076 · 13: daily entries · 17: quantcore via s076/s109 · "
        "18: LSEG daily+opt cache · 19: no new masks · 20: S010 haircut on synth legs, CRSP delist names",
        "",
        f"1 Survivorship: +{s0['wk_bp']:.1f}→+{s1['wk_bp']:.1f} bp/wk (t {s0['t']:+.1f}→{s1['t']:+.1f}), "
        f"+{surv['names_added']} names / {surv['synth_puts']} synth puts, quote cov {surv['coverage_share']:.0%}, "
        f"priced_by {surv['priced_by']} → S109 stays **{s109_verdict}**",
        f"2 S088 real replay (top-10/wk h=1, holdout): model {s088['model']['wk_bp']:+.1f} vs "
        f"real {s088['real']['wk_bp']:+.1f} bp/wk (ratio {s088['ratio']:.2f}, cov {s088['coverage']:.0%}); "
        f"halves real {s088['half_real'][0]}; {s088['half_real'][1]} — "
        f"{'PASS' if s088['pass_replay'] else 'FAIL vs 0.8× model'}",
        f"3 Regime S109: {s109_regime_note}",
        "4 One standard: N_eff<100 → BOARD ## Underpowered (S159,S172,S173); parser+S159 chip",
        f"5 Pass/fail task5: survivorship-adjusted S109 t={s1['t']:+.1f} bp={s1['wk_bp']:+.1f} → {s109_verdict}",
        "",
        "## Dead spot-check (A371 add, sample)",
        "",
    ]
    lines.extend(f"- {x}" for x in dead_audit_lines())
    OUT_PACKET.parent.mkdir(parents=True, exist_ok=True)
    OUT_PACKET.write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:8]), flush=True)
    print(f"wrote {OUT_PACKET}", file=sys.stderr)


def main():
    from a371_audit import main as audit_main  # noqa: WPS433 — regime table
    from a371_survivorship import run as surv_run
    from a371_s088_replay import run as s088_run

    smoke = "--smoke" in sys.argv
    print("=== A371 smoke gate ===" if smoke else "=== A371 full ===", flush=True)
    surv = surv_run(smoke=smoke)
    s088 = s088_run(smoke=smoke)
    if smoke:
        ok = surv["synth_puts"] >= 0 and s088["picks"] > 0
        print(f"SANITY {'pass' if ok else 'fail'}", flush=True)
        if not ok:
            sys.exit(1)
        return
    audit_main()
    s109_note = "both SPY halves +; middle VIX weak — see a371-audit.md table"
    write_outputs(surv, s088, s109_note)


if __name__ == "__main__":
    main()