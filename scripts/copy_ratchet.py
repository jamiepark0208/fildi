#!/usr/bin/env python3
"""Copy ratchet (Jamie 11-15): shared quant logic has ONE home; copies may only go down.

Why: 16 RSI copies with 3 formulas, 27 Black-Scholes copies with 5 argument orders, 12 bar loaders
(the one without an RTH filter traded 04:00 prints for 8 days), a 30m writer appending into bars_5m.
Rules in docs did not stop any of it; this does.

  python3 scripts/copy_ratchet.py            # check: exit 1 if any count rose (blocks push via agent-ship-check)
  python3 scripts/copy_ratchet.py --list X   # show every site for rule X
  python3 scripts/copy_ratchet.py --update   # lower the baseline after removing copies (never raises it)

Homes: Python → scripts/watchlist_sync/quantcore/ (ta, bs, bars, causal). TS → lib/indicators/src/.
Adding a genuinely new home? Put it in quantcore, not a new file. Raising a baseline needs
--allow-raise "<reason>" and the reason is written to the json for review.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "scripts" / "copy-ratchet.json"
PY_DIRS = [ROOT / "scripts"]
TS_DIRS = [ROOT / "artifacts" / "api-server" / "src", ROOT / "artifacts" / "stock-compare" / "src"]
SKIP = ("quantcore/", "/tests/", "_test.py", "test_", "/node_modules/", "/dist/", "copy_ratchet.py", ".venv/",
        "/out/", "__pycache__")

RULES: dict[str, tuple[str, str]] = {
    # name: (glob kind, regex). Each match outside the home counts once.
    "py_rsi_def": ("py", r"^\s*def _?(rsi|rsi_mat|rsi_series|wilder_rsi)\("),
    "py_ema_atr_sma_rma_def": ("py", r"^\s*def _?(ema|atr|sma|rma|wilder)\("),
    "py_hand_wilder_ewm": ("py", r"\.ewm\(\s*alpha\s*=\s*1\s*/"),
    "py_bs_def": ("py", r"^\s*def _?(bs_put|bs_call|bs_call_py|bs_price|bs_delta|bs_put_delta|put_delta|call_delta|black_scholes)\("),
    "py_ncdf_def": ("py", r"^\s*def _?(ncdf|norm_cdf|_phi|phi|N)\("),
    "py_iv_solver_def": ("py", r"^\s*def _?(implied_vol|iv_from_price|put_iv|solve_iv)\("),
    "py_iv_unit_guess": ("py", r"iv\s*/\s*100(\.0)?\s+if\s+\w*iv\w*\s*>"),
    "py_raw_intraday_sql": ("py", r"(FROM|INTO|from|into|JOIN|join)\s+(optlab\.bars_5m|optlab\.bars_30m|watchlist_sync\.intraday_bars_5m)\b"),
    "py_days_over_252": ("py", r"\bdte\w*\s*/\s*252"),
    "ts_rsi_def": ("ts", r"function\s+(rsi|computeRsi|calcRsi|wilderRsi)\b|const\s+(rsi|computeRsi|calcRsi)\s*=\s*\("),
}


def files(kind: str):
    dirs = PY_DIRS if kind == "py" else TS_DIRS
    pat = "*.py" if kind == "py" else "*.ts"
    for d in dirs:
        if not d.exists():
            continue
        for p in d.rglob(pat):
            sp = str(p)
            if any(s in sp for s in SKIP) or p.is_symlink():
                continue
            yield p


def scan() -> dict[str, list[str]]:
    hits: dict[str, list[str]] = {k: [] for k in RULES}
    cache: dict[str, dict[Path, list[str]]] = {"py": {}, "ts": {}}
    for kind in ("py", "ts"):
        for p in files(kind):
            try:
                cache[kind][p] = p.read_text(errors="ignore").splitlines()
            except OSError:
                continue
    for name, (kind, rx) in RULES.items():
        r = re.compile(rx)
        for p, lines in cache[kind].items():
            for i, ln in enumerate(lines, 1):
                if r.search(ln):
                    hits[name].append(f"{p.relative_to(ROOT)}:{i}")
    return hits


def main(argv: list[str]) -> int:
    hits = scan()
    counts = {k: len(v) for k, v in hits.items()}
    if "--list" in argv:
        k = argv[argv.index("--list") + 1]
        print("\n".join(hits.get(k, [])))
        return 0
    base = json.loads(BASE.read_text()) if BASE.exists() else {"counts": {}, "raises": []}
    if "--update" in argv or not BASE.exists():
        old = base.get("counts", {})
        reason = argv[argv.index("--allow-raise") + 1] if "--allow-raise" in argv else None
        new = {}
        for k, v in counts.items():
            if k in old and v > old[k] and not reason:
                print(f"copy_ratchet: {k} rose {old[k]} → {v}; refusing to raise without --allow-raise \"<reason>\"")
                return 1
            new[k] = v
        if reason:
            base.setdefault("raises", []).append(reason)
        base["counts"] = new
        BASE.write_text(json.dumps(base, indent=1, sort_keys=True) + "\n")
        print("copy_ratchet: baseline written", new)
        return 0
    rose = {k: (base["counts"].get(k, 0), v) for k, v in counts.items() if v > base["counts"].get(k, 0)}
    fell = {k: (base["counts"].get(k, 0), v) for k, v in counts.items() if v < base["counts"].get(k, 0)}
    if rose:
        print("copy_ratchet: NEW COPIES of shared logic — use scripts/watchlist_sync/quantcore (ta / bs / bars) instead:")
        for k, (a, b) in rose.items():
            print(f"  {k}: {a} → {b}   (python3 scripts/copy_ratchet.py --list {k})")
        return 1
    if fell:
        print("copy_ratchet: copies removed —", ", ".join(f"{k} {a}→{b}" for k, (a, b) in fell.items()),
              "→ run --update to lock it in")
    else:
        print("copy_ratchet: ok", sum(counts.values()), "legacy sites (may only fall)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
