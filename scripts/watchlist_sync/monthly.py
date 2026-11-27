"""Monthly re-test (PLAN_next_session.md §8 E6): re-run the scorecard lab and the gate checks on the newest history, write one summary.

Runs only when the last summary is ≥ 28 days old (or --force), so it can sit in daily.py's publish stage at no cost on other days.
Local compute only (~2–3 min), no vendor calls, no tokens. Report only: nothing here changes a live parameter; a drift worth acting on
goes to the user / ASKS like any other methodology change.

Steps: lab replay (live technical engines, monthly dates) → lab outcomes → lab fundamentals → lab report → gate 1 (regime / confidence)
→ gate 1b (lookup / tail caps) → gate 1c (win rates; rebuilds watchlist_sync.win_rates) → fair value validation
(research/fair_value/validate_snapshots.py: live snapshots vs later returns, stability, coverage). Summary: out/runs/monthly_YYYYMMDD.md with
each step's headline and the win-rate cells that moved > 2 pts since the previous table.

Usage: .venv/bin/python monthly.py [--force]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from build_plan import connect, rows

HERE = Path(__file__).resolve().parent
API = HERE.parents[1] / "artifacts" / "api-server"
RUNS = HERE / "out" / "runs"
PY = sys.executable
MAX_AGE_DAYS = 28
LSEG = HERE.parents[1] / "research" / "lseg"
STEPS = [
    # Jamie 10-27: every US-listed name ≥ $10B (+ AI build-out theme) in the app universe; nightly jobs fill the new rows
    ("universe coverage review", [str(LSEG / ".venv" / "bin" / "python"), "universe_review.py", "--apply"], LSEG),
    ("lab replay (technicals)", ["pnpm", "exec", "tsx", "src/scripts/lab-replay-technicals.ts"], API),
    ("lab outcomes", [PY, "analysis/lab_outcomes.py"], HERE),
    ("lab fundamentals", [PY, "analysis/lab_fund_features.py"], HERE),
    ("lab report", [PY, "analysis/lab.py", "report"], HERE),
    ("gate 1 (regime / confidence)", [PY, "analysis/proto.py", "--rebuild"], HERE),
    ("gate 1b (lookup / tail caps)", [PY, "analysis/proto_b.py"], HERE),
    ("gate 1c (win rates)", [PY, "analysis/proto_c.py", "--final", "--fresh"], HERE),
    ("fair value validation", [PY, str(HERE.parents[1] / "research" / "fair_value" / "validate_snapshots.py")], HERE),
]


def last_summary_age() -> float | None:
    done = sorted(RUNS.glob("monthly_*.md"))
    return (time.time() - done[-1].stat().st_mtime) / 86400 if done else None


def win_rate_moves(conn) -> list[str]:
    t = rows(conn, "SELECT version, cells FROM watchlist_sync.win_rates ORDER BY created_at DESC LIMIT 2")
    if len(t) < 2:
        return ["(first win-rate table: nothing to compare)"]
    new, old = t[0]["cells"], t[1]["cells"]
    out = [f"{k}: {100 * old[k]['rate']:.1f}% → {100 * new[k]['rate']:.1f}%" for k in new
           if k in old and abs(new[k]["rate"] - old[k]["rate"]) > 0.02]
    return out or [f"no cell moved > 2 pts ({t[1]['version']} → {t[0]['version']})"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    age = last_summary_age()
    if age is not None and age < MAX_AGE_DAYS and not a.force:
        print(f"monthly re-test ran {age:.0f} days ago: skip (every {MAX_AGE_DAYS} days)")
        return
    RUNS.mkdir(parents=True, exist_ok=True)
    connect().close()   # loads DATABASE_URL from the repo env files into os.environ, which the TS replay step inherits
    L = [f"# Monthly re-test {datetime.now():%Y-%m-%d %H:%M}", "", "| step | ok | seconds | headline |", "|---|---|---|---|"]
    ok_all = True
    for name, cmd, cwd in STEPS:
        t0 = time.time()
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
        tail = [x for x in (r.stdout.strip().splitlines() or r.stderr.strip().splitlines()) if x.strip() and not x.startswith((" ", "("))]
        head = (tail[-1] if tail else "")[:160].replace("|", "/")
        L.append(f"| {name} | {'✓' if r.returncode == 0 else '✗'} | {time.time() - t0:.0f} | {head} |")
        print(f"{'✓' if r.returncode == 0 else '✗'} {name:<30} {head}")
        if r.returncode != 0:
            ok_all = False
            break
    if ok_all:
        g = json.loads((HERE / "out" / "proto" / "gate1.json").read_text())
        L += ["", f"Gate 1 now: put confidence skill {g['put_skill']:+.3f} (stop if ≤ 0), call {g['call_skill']:+.3f}.",
              "Gate 1c verdict: " + json.dumps(json.loads((HERE / "out" / "proto" / "winrates.json").read_text())["verdict"]), "",
              "Win-rate cells that moved > 2 pts:"]
        with connect() as conn:
            L += [f"- {x}" for x in win_rate_moves(conn)]
        L += ["", "Full reports: out/lab/report.md, out/proto/gate1.md, gate1b.md, gate1c.md. Anything worth acting on → ASKS + user approval."]
    # 11-27: a failed run must not reset the 28-day clock (11-05 universe-review crash froze lab_outcomes at 10-05 for
    # 7 weeks → engine backtest and Jamie's IRA comparison lost Oct). Failed runs are kept but don't match the glob.
    out = RUNS / f"{'' if ok_all else 'failed_'}monthly_{datetime.now():%Y%m%d}.md"
    out.write_text("\n".join(L) + "\n")
    print(f"→ {out}")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
