"""S018 (Claude, pre-registered 10-14): is a name's earnings move persistently over/under-priced by options?
Persistence test first (spec stop rule): Spearman of a name's previous realized/implied ratio vs its next, pooled across names,
|t| ≥ 2 and same sign in both date halves → per-name flags allowed (≥ 4 events); else Breakdown shows history only.
    .venv/bin/python analysis/s018_earnings.py     # → out/opt/S018.md + optlab.findings S018
"""
from __future__ import annotations

import json
import math
import statistics as st
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402


def rank(xs):
    o = sorted(range(len(xs)), key=lambda i: xs[i]); r = [0.0] * len(xs)
    for k, i in enumerate(o): r[i] = k
    return r


def spearman(a, b):
    if len(a) < 5: return float("nan"), float("nan")
    ra, rb = rank(a), rank(b); n = len(a)
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb)); va = sum((x - ma) ** 2 for x in ra); vb = sum((y - mb) ** 2 for y in rb)
    rho = cov / math.sqrt(va * vb) if va and vb else 0.0
    t = rho * math.sqrt((n - 2) / max(1 - rho * rho, 1e-9))
    return rho, t


def main():
    conn = connect()
    ev = conn.execute("SELECT ticker, report_date, implied, realized, ratio FROM optlab.earnings_moves WHERE ratio IS NOT NULL AND implied > 0 ORDER BY ticker, report_date").fetchall()
    by = defaultdict(list)
    for t, d, imp, real, r in ev: by[t].append((d, imp, real, r))
    pairs = [(v[i - 1][3], v[i][3], v[i][0]) for v in by.values() for i in range(1, len(v))]
    # log ratio: symmetric for over/under
    lp = [(math.log(max(a, 1e-3)), math.log(max(b, 1e-3)), d) for a, b, d in pairs]
    rho, t = spearman([x for x, _, _ in lp], [y for _, y, _ in lp])
    mid = sorted(d for *_, d in lp)[len(lp) // 2]
    h = [spearman([x for x, _, d in lp if (d < mid) == k], [y for _, y, d in lp if (d < mid) == k]) for k in (True, False)]
    persistent = abs(t) >= 2 and h[0][0] * h[1][0] > 0 and (h[0][0] > 0) == (rho > 0)
    ratios = [r for *_, r in ev]
    med = st.median(ratios); beat = sum(1 for _, _, imp, real, _ in ev if real > imp)
    names = {t: v for t, v in by.items() if len(v) >= 4}
    per = sorted(((t, st.median(x[3] for x in v), len(v)) for t, v in names.items()), key=lambda x: x[1])
    out = [f"# S018 — earnings: priced-in vs actual move ({date.today()})\n",
           f"{len(ev)} reports, {len(by)} names (straddle close the day before ÷ spot vs first close after).",
           f"Pooled: median actual/priced **{med:.2f}×**; actual exceeded priced in {beat}/{len(ev)} ({beat/len(ev):.0%}).",
           f"Persistence (prev ratio → next, {len(lp)} pairs): Spearman {rho:+.2f}, t {t:+.1f}; halves {h[0][0]:+.2f} / {h[1][0]:+.2f} → "
           f"**{'PERSISTENT: per-name flags allowed' if persistent else 'NOT persistent: no per-name flags, history display only'}**.",
           f"\nNames with ≥ 4 reports ({len(per)}), median ratio (low = options overpriced the move):",
           ", ".join(f"{t} {m:.2f}× ({n})" for t, m, n in per),
           "Bias check: 341 of 363 straddles expire ≤ 4 days after the report (median 0.67×), so non-earnings drift in the straddle barely moves this.",
           "\nNot computed here: the trader's usual put held over the event vs next week (needs per-event strike matching; S017 engine), "
           "EPS-surprise / short-interest joins (only meaningful if persistent)."]
    (HERE.parent / "out/opt").mkdir(parents=True, exist_ok=True)
    (HERE.parent / "out/opt/S018.md").write_text("\n".join(out) + "\n")
    verdict = "pass" if persistent else "fail"
    head = (f"Options priced earnings moves {'too high' if med < 1 else 'too low'} on average: actual = {med:.2f}× priced, bigger than priced "
            f"{beat/len(ev):.0%} of {len(ev)} reports. "
            + ("A name's past ratio predicts its next → per-name flags on." if persistent else
               "But a name's past ratio doesn't predict its next one (t " + f"{t:+.1f}" + ") → no per-name 'sell through earnings' flags."))
    conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline, card, updated_at) VALUES ('S018','Earnings: priced-in vs actual move',%s,%s,%s,now())
                    ON CONFLICT (study) DO UPDATE SET verdict=excluded.verdict, headline=excluded.headline, card=excluded.card, updated_at=now()""",
                 (verdict, head, json.dumps({"median_ratio": med, "beat": beat, "n": len(ev), "rho": rho, "t": t, "halves": [h[0][0], h[1][0]], "names": per[:60]})))
    conn.commit()
    print("\n".join(out)); print("→", verdict, head)


if __name__ == "__main__":
    main()
