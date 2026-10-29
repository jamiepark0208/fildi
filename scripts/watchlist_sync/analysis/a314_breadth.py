"""A314 family 2 — intraday breadth & internals on the S139 every-bar harness (Jamie 10-28).

Methods (each graded on its own claim vs placebo bars, same day + minute window):
  breadth_thrust   ≥10pp rise in % above open over 30m → lower rest-of-day drop risk (Zweig thrust, adapted)
  spy_breadth_div  SPY ≥0.2% from open while breadth falls ≥5pp → higher drop risk (McClellan divergence)
  vwap_roc_fall    ≥8pp 30m drop in % above own VWAP → higher drop risk (NYSE ADD proxy)
  up_vol_ratio_low aggregate up-volume / total volume <48% → higher drop risk (TICK/up-volume literature)

Pass (intraday): same-sign day-clustered effect H1 & H2, |t|≥2 on P(drop ≥½ ATR) event−placebo.
Power: MDE ≈ (1.96+0.84)·σ/√n_days on the daily mean gap (report pp at 80% power).
If any method passes → put_benchmark overlay (prior session had event → skip week).
Run: cd scripts/watchlist_sync && nice -n 15 .venv/bin/python analysis/a314_breadth.py
"""
from __future__ import annotations

import os
import pickle
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from s126_intraday_regime import load  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A314-breadth-packet.md"
CACHE = Path.home() / ".fildi/cache/a314_uvr.pkl"


def load_uvr(conn) -> pd.DataFrame:
    if CACHE.is_file():
        return pickle.loads(CACHE.read_bytes())
    q = """
    with u as (select ticker from optlab.bars_5m group by ticker having count(*)>5000 limit 180)
    select (ts at time zone 'America/New_York')::date as d,
           (extract(hour from ts at time zone 'America/New_York')*60
            + extract(minute from ts at time zone 'America/New_York')-570)::int as m,
           sum(v) filter (where c>o)::float/nullif(sum(v),0) as uvr
    from optlab.bars_5m b join u using (ticker)
    where extract(hour from ts at time zone 'America/New_York')*60
          + extract(minute from ts at time zone 'America/New_York') between 570 and 955
    group by 1,2 having count(distinct ticker)>=80
    """
    uvr = pd.read_sql(q, conn).set_index(["d", "m"])
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(pickle.dumps(uvr))
    return uvr


def mde_pp(std: float, n: int) -> float:
    if n < 5 or std <= 0:
        return float("nan")
    return 100 * (1.96 + 0.84) * std / np.sqrt(n)


def grade_event(R: pd.DataFrame, col: str, expect: int) -> dict:
    out = {"h1_t": np.nan, "h2_t": np.nan, "h1_eff": np.nan, "h2_eff": np.nan, "mde": np.nan, "n_days": 0}
    diffs = []
    for h in ("H1", "H2"):
        y = R[R.half == h]
        e = y[y[col]]
        if len(e) < 30:
            continue
        pl = []
        for _, ge in e.groupby(["tk", "d"]):
            pool = y[(y.tk == ge.tk.iloc[0]) & (y.d == ge.d.iloc[0]) & ~y[col]]
            if len(pool):
                pl.append(pool.sample(min(len(ge), len(pool)), random_state=1))
        p = pd.concat(pl) if pl else e.iloc[:0]
        ed = e.groupby("d").dropx.mean()
        pd_ = p.groupby("d").dropx.mean()
        jj = ed.index.intersection(pd_.index)
        diff = ed[jj] - pd_[jj]
        if len(diff) > 2 and diff.std() > 0:
            t = diff.mean() / (diff.std() / np.sqrt(len(diff)))
            out[f"{h.lower()}_t"] = float(t)
            out[f"{h.lower()}_eff"] = 100 * float(diff.mean())
            diffs.append(diff)
    if diffs:
        all_d = pd.concat(diffs)
        out["n_days"] = len(all_d)
        out["mde"] = mde_pp(float(all_d.std()), len(all_d))
    t1, t2 = out["h1_t"], out["h2_t"]
    e1, e2 = out["h1_eff"], out["h2_eff"]
    same = e1 == e1 and e2 == e2 and np.sign(e1) == np.sign(e2) and e1 != 0
    sign_ok = same and np.sign(e1) == expect
    out["pass"] = sign_ok and abs(t1) >= 2 and abs(t2) >= 2
    return out


def build_rows(br: pd.DataFrame, uvr: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for tk in ("SPY", "QQQ"):
        df = load(tk)
        days = [g.reset_index(drop=True) for _, g in df.groupby("d") if len(g) >= 70]
        closes = np.array([g.c.iloc[-1] for g in days])
        highs = np.array([g.h.max() for g in days])
        lows = np.array([g.l.min() for g in days])
        for k in range(21, len(days)):
            g = days[k]
            pcs = closes[k - 21 : k]
            tr = np.maximum(
                highs[k - 20 : k] - lows[k - 20 : k],
                np.maximum(abs(highs[k - 20 : k] - pcs[:-1]), abs(lows[k - 20 : k] - pcs[:-1])),
            ) / pcs[:-1]
            atr = tr.mean()
            o = g.o.iloc[0]
            for i in range(5, len(g) - 1):
                m = int(g.m.iloc[i]) + 5
                if m < 30 or m > 330:
                    continue
                key = (g.d.iloc[0], m - 5)
                if key not in br.index:
                    continue
                bnow = br.loc[key]
                b30 = br.loc[(g.d.iloc[0], m - 35)] if (g.d.iloc[0], m - 35) in br.index else bnow
                p = g.c.iloc[i]
                rest = g.iloc[i + 1 :]
                spy_ret = p / o - 1
                bc = float(bnow.up_open - b30.up_open)
                vc = float(bnow.above_vwap - b30.above_vwap)
                u = float(uvr.loc[key].uvr) if key in uvr.index else np.nan
                rows.append(
                    dict(
                        tk=tk,
                        d=g.d.iloc[0],
                        m=m,
                        dropx=(min(rest.l.min() / p - 1, 0) / atr) <= -0.5,
                        rest_rng=(rest.h.max() - rest.l.min()) / p / atr,
                        breadth_thrust=bc >= 0.10,
                        spy_breadth_div=spy_ret >= 0.002 and bc <= -0.05,
                        vwap_roc_fall=vc <= -0.08,
                        up_vol_ratio_low=u < 0.48 if u == u else False,
                        bc=bc,
                        vc=vc,
                        uvr=u,
                    )
                )
    R = pd.DataFrame(rows)
    dates = sorted(R.d.unique())
    split = dates[len(dates) // 2]
    R["half"] = np.where(R.d < split, "H1", "H2")
    return R


def prior_session(d: date) -> date | None:
    return d - timedelta(days=3) if d.weekday() == 0 else d - timedelta(days=1)


def put_overlay(cols: list[str], day_flags: dict[tuple[str, date], set[str]]) -> list[str]:
    if not cols:
        return []
    import band_engine as BE  # noqa: E402
    from put_benchmark import engine_rule, verdict  # noqa: E402

    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        BE.add_sector(c, rows)
    tr = [r for r in rows if r["d"] < BE.SPLIT]
    table = BE.fit(tr)
    live = engine_rule(table)
    weeks = sorted({r["d"] for r in rows if r["d"] >= BE.SPLIT})
    te = [r for r in rows if r["d"] >= BE.SPLIT]
    tr_weeks = sorted({r["d"] for r in tr})
    base = BE.summary(BE.pick_rows(te, live), weeks)
    base_tr = BE.summary(BE.pick_rows(tr, live), tr_weeks)

    lines = []
    for col in cols:
        fired = {d for (_, d), evs in day_flags.items() if col in evs}

        def rule(row, _f=fired):
            b = live(row)
            ps = prior_session(row["d"])
            if ps and ps in _f:
                return None
            return b

        s = BE.summary(BE.pick_rows(te, rule), weeks)
        st = BE.summary(BE.pick_rows(tr, rule), tr_weeks)
        diff = np.array([s["series"][w] - base["series"][w] for w in weeks])
        t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) if diff.std() > 0 else 0.0
        dbp, dw5 = s["book_bp"] - base["book_bp"], s["book_w5"] - base["book_w5"]
        v = verdict(dbp, t, dw5)
        pbp, pw5 = st["book_bp"] - base_tr["book_bp"], st["book_w5"] - base_tr["book_w5"]
        if v == "BETTER" and (pbp < -1 or pw5 <= -10):
            v = "BETTER (holdout only)"
        lines.append(
            f"- **put skip prior `{col}`** · book {s['book_bp']:+.1f} bp · Δ {dbp:+.1f} · t {t:+.1f} · pre-2023 Δ {pbp:+.1f} · **{v}**"
        )
    return lines


def main() -> int:
    for p in (HERE.parents[2] / ".env.local", HERE.parents[2] / ".env"):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p, override=False)
            break
    with connect() as c:
        br = pd.read_sql("select ts, d, n, up_open, above_vwap, mean_ret from optlab.breadth_5m", c)
        uvr = load_uvr(c)
    br["ts"] = pd.to_datetime(br.ts, utc=True).dt.tz_convert("America/New_York")
    br["m"] = br.ts.dt.hour * 60 + br.ts.dt.minute - 570
    br = br.set_index(["d", "m"]).sort_index()
    R = build_rows(br, uvr)

    METHODS = [
        ("breadth_thrust", "≥10pp 30m rise % above open → lower drop risk", "Zweig thrust / McClellan (intraday)", -1),
        ("spy_breadth_div", "SPY up, breadth down → higher drop risk", "McClellan divergence vs index", +1),
        ("vwap_roc_fall", "≥8pp 30m drop % above VWAP → higher drop risk", "NYSE ADD / % above VWAP ROC", +1),
        ("up_vol_ratio_low", "Up-volume ratio <48% → higher drop risk", "Up-volume ratio / TICK", +1),
    ]
    day_flags: dict[tuple[str, date], set[str]] = {}
    for tk in ("SPY", "QQQ"):
        sub = R[R.tk == tk]
        for d, g in sub.groupby("d"):
            evs = {col for col, _, _, _ in METHODS if g[col].any()}
            if evs:
                day_flags[(tk, d)] = evs

    L = ["# A314 family 2 — breadth & internals intraday", ""]
    passed = []
    for col, claim, src, expect in METHODS:
        g = grade_event(R, col, expect)
        eff = f"{g['h1_eff']:+.1f}/{g['h2_eff']:+.1f}pp" if g["h1_eff"] == g["h1_eff"] else "n/a"
        t_s = f"{g['h1_t']:+.1f}/{g['h2_t']:+.1f}"
        v = "PASS intraday" if g.get("pass") else "FAIL"
        if g.get("pass"):
            passed.append((col, claim))
        mde = g["mde"]
        L.append(
            f"- **{col}** · {claim} · effect {eff} · t {t_s} · MDE≈{mde:.1f}pp @ n={g['n_days']} · **{v}** · {src}"
        )
    if passed:
        L += ["", "## Put benchmark (prior session event → skip entry week)", ""]
        L.extend(put_overlay([c for c, _ in passed], day_flags))
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
