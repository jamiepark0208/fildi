"""A314 family 1 — Change-point / event intraday methods (BOCPD, CUSUM vol/range, Hawkes jumps, BNS-RV).

Harness: copy of s139_event_regime bar panel (SPY+QQQ 5m, 30–330 min). Each method graded on its own claim vs
minute-matched placebo (same tk, day, minute). H1/H2 day-clustered t; MDE at observed n days.
Pass (intraday): same-sign effect both halves, |t|≥2 on claim. Passers → put_benchmark overlay (prior-session SPY flag).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from s139_event_regime import bocpd, cusum, load  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "A314-changepoint-packet.md"
OUT_FULL = Path(__file__).resolve().parents[1] / "out" / "opt" / "S142.md"
HAZARDS = [1 / 20, 1 / 40, 1 / 60, 1 / 80, 1 / 120]


def hawkes_events(r: np.ndarray, mu=0.05, alpha=0.4, beta=0.15, thr=0.35) -> np.ndarray:
    """Simple exponential Hawkes on |r|>2 jumps; event when intensity exceeds thr."""
    lam = mu
    ev = np.zeros(len(r), bool)
    for i, v in enumerate(r):
        if abs(v) > 2:
            lam += alpha
        if lam >= thr:
            ev[i] = True
        lam = mu + (lam - mu) * np.exp(-beta)
    return ev


def bns_jump(r: np.ndarray, win=12, k=3.0) -> np.ndarray:
    """Barndorff-Nielsen–Shephard: flag when RV − bipower > k × rolling std of the diff."""
    x = r * r
    rv = pd.Series(x).rolling(win, min_periods=win).sum().values
    bp = (np.pi / 2) * pd.Series(np.abs(r) * np.abs(np.r_[0, r[:-1]])).rolling(win, min_periods=win).sum().values
    diff = rv - bp
    sd = pd.Series(diff).rolling(40, min_periods=20).std().values
    return np.where(np.isfinite(diff) & np.isfinite(sd) & (sd > 0), diff > k * sd, False)


def build_panel() -> pd.DataFrame:
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
            r = np.log(g.c).diff().fillna(np.log(g.c.iloc[0] / g.o.iloc[0])).values / (atr / np.sqrt(78))
            rng = ((g.h - g.l) / g.o.iloc[0] / atr).values
            lv = np.log(g.v.replace(0, np.nan).ffill()).diff().fillna(0).values
            lv = (lv - lv.mean()) / (lv.std() + 1e-9)
            cp_ret = {h: bocpd(r, hazard=h) for h in HAZARDS}
            cp_rng = bocpd(rng, hazard=1 / 40)
            cs_r = cusum(r)
            cs_vol = cusum(lv, k=0.5, h=4.0)
            cs_rng = cusum(rng - np.median(rng), k=0.2, h=2.5)
            hk = hawkes_events(r)
            bj = bns_jump(r)
            close = g.c.iloc[-1]
            for i in range(5, len(g) - 1):
                m = int(g.m.iloc[i]) + 5
                if m < 30 or m > 330:
                    continue
                p = g.c.iloc[i]
                rest = g.iloc[i + 1 :]
                rows.append(
                    dict(
                        tk=tk,
                        d=g.d.iloc[0],
                        m=m,
                        dropx=(min(rest.l.min() / p - 1, 0) / atr) <= -0.5,
                        rest_rng=(rest.h.max() - rest.l.min()) / p / atr,
                        **{f"bocpd_h{int(1/h)}": cp_ret[h][i] > 0.5 for h in HAZARDS},
                        bocpd_range=cp_rng[i] > 0.35,
                        cusum_ret=cs_r[i] != 0,
                        cusum_vol=cs_vol[i] != 0,
                        cusum_rng=cs_rng[i] != 0,
                        hawkes=bool(hk[i]),
                        bns_jump=bool(bj[i]),
                    )
                )
    R = pd.DataFrame(rows)
    dates = sorted(R.d.unique())
    split = dates[len(dates) // 2]
    R["half"] = np.where(R.d < split, "H1", "H2")
    R["_split"] = split
    return R


def day_t(e: pd.DataFrame, p: pd.DataFrame, col: str) -> tuple[float, int]:
    ed = e.groupby("d")[col].mean()
    pd_ = p.groupby("d")[col].mean()
    jj = ed.index.intersection(pd_.index)
    diff = ed[jj] - pd_[jj]
    if len(diff) < 3 or diff.std() == 0:
        return float("nan"), len(diff)
    t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff)))
    return float(t), len(diff)


def minute_placebo(R: pd.DataFrame, ev: str, rng: np.random.Generator) -> pd.DataFrame:
    e = R[R[ev]]
    pl = []
    for _, row in e.iterrows():
        pool = R[(R.tk == row.tk) & (R.d == row.d) & (R.m == row.m) & ~R[ev]]
        if len(pool) == 0:
            pool = R[(R.tk == row.tk) & (R.d == row.d) & (R.m.between(row.m - 5, row.m + 5)) & ~R[ev]]
        if len(pool):
            rs = hash((row.tk, str(row.d), int(row.m), ev)) % (2**32 - 1)
            pl.append(pool.sample(1, random_state=rs))
    return pd.concat(pl, ignore_index=True) if pl else e.iloc[:0]


def mde_pp(n: int, sd: float) -> float:
    if n < 5 or sd <= 0 or not math.isfinite(sd):
        return float("nan")
    z = 1.96 + 0.84
    return 100 * z * sd / math.sqrt(n)


def eval_method(R: pd.DataFrame, ev: str, outcome: str, claim: str, source: str, rng) -> dict:
    e_all = R[R[ev]]
    p_all = minute_placebo(R, ev, rng)
    if len(e_all) < 30:
        n_d = e_all.d.nunique()
        return dict(
            name=ev,
            claim=claim,
            source=source,
            verdict=f"FAIL (sparse n={len(e_all)} events, {n_d} days)",
            pass_bar=False,
            eff={"H1": float("nan"), "H2": float("nan")},
            ts={"H1": float("nan"), "H2": float("nan")},
            mde=mde_pp(max(n_d, 1), 0.15),
            outcome=outcome,
        )
    eff = {}
    ts = {}
    ns = {}
    for h in ("H1", "H2"):
        e = e_all[e_all.half == h]
        p = p_all[p_all.half == h] if len(p_all) else e.iloc[:0]
        if len(e) < 15 or len(p) < 15:
            eff[h] = float("nan")
            ts[h] = float("nan")
            ns[h] = 0
            continue
        eff[h] = 100 * (e[outcome].mean() - p[outcome].mean())
        t, n = day_t(e, p, outcome)
        ts[h] = t
        ns[h] = n
    e1, e2 = eff["H1"], eff["H2"]
    t1, t2 = ts["H1"], ts["H2"]
    same = np.sign(e1) == np.sign(e2) and math.isfinite(e1) and math.isfinite(e2) and e1 != 0
    pass_bar = same and abs(t1) >= 2 and abs(t2) >= 2
    ed = e_all.groupby("d")[outcome].mean()
    pd_ = p_all.groupby("d")[outcome].mean()
    jj = ed.index.intersection(pd_.index)
    sd = (ed[jj] - pd_[jj]).std(ddof=1) if len(jj) > 2 else float("nan")
    mde = mde_pp(len(jj), sd if math.isfinite(sd) else float("nan"))
    verdict = "PASS intraday" if pass_bar else "FAIL"
    return dict(
        name=ev,
        claim=claim,
        source=source,
        outcome=outcome,
        eff=eff,
        ts=ts,
        ns=ns,
        mde=mde,
        n_ev=len(e_all),
        pass_bar=pass_bar,
        verdict=verdict,
    )


def put_overlay(R: pd.DataFrame, ev: str) -> str:
    """Prior RTH session: any SPY event → skip week overlay on put benchmark."""
    import pickle

    import band_engine as BE
    from put_benchmark import asof, engine_rule, market_inputs, shifted, verdict

    spy_days = (
        R[(R.tk == "SPY") & R[ev]]
        .groupby("d")
        .size()
        .rename("n")
        .reset_index()
    )
    flags = {row.d: True for row in spy_days.itertuples()}
    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    from build_plan import connect

    with connect() as c:
        BE.add_sector(c, rows)
        BE.add_breadth(c, rows)
    mk = market_inputs(None)
    tr = [r for r in rows if r["d"] < BE.SPLIT]
    table = BE.fit(tr)
    live = engine_rule(table)
    weeks = sorted({r["d"] for r in rows if r["d"] >= BE.SPLIT})
    te = [r for r in rows if r["d"] >= BE.SPLIT]
    tr_weeks = sorted({r["d"] for r in tr})

    def prior_flag(row):
        from datetime import timedelta

        pd_ = row["d"] - timedelta(days=1)
        while pd_.weekday() >= 5:
            pd_ -= timedelta(days=1)
        return flags.get(pd_, False)

    def rule(row):
        if prior_flag(row):
            return None
        return live(row)

    def book(picks, wks):
        return BE.summary([r for r in picks if r["d"] >= BE.SPLIT], wks)

    base = book(BE.pick_rows(te, live), weeks)
    var = book(BE.pick_rows(te, rule), weeks)
    base_tr = BE.summary(BE.pick_rows(tr, live), tr_weeks)
    st_tr = BE.summary(BE.pick_rows(tr, rule), tr_weeks)
    diff = np.array([var["series"][w] - base["series"][w] for w in weeks])
    t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) if diff.std() > 0 else 0.0
    dbp, dw5 = var["book_bp"] - base["book_bp"], var["book_w5"] - base["book_w5"]
    v = verdict(dbp, t, dw5)
    pbp, pw5 = st_tr["book_bp"] - base_tr["book_bp"], st_tr["book_w5"] - base_tr["book_w5"]
    if v == "BETTER" and (pbp < -1 or pw5 <= -10):
        v = "BETTER (holdout only)"
    return f"skip if prior SPY {ev}: Δ{dbp:+.1f}bp t{t:+.1f} → **{v}**"


METHODS = [
    ("bocpd_h40", "dropx", "changepoint ↑ tail risk (P drop ≥ ½ ATR)", "Adams & MacKay 2007 BOCPD h=1/40"),
    ("bocpd_h60", "dropx", "changepoint ↑ tail risk", "BOCPD h=1/60"),
    ("bocpd_range", "dropx", "range CP ↑ tail risk", "BOCPD Student-t on bar range"),
    ("cusum_vol", "rest_rng", "volume CUSUM ↑ rest-of-day range", "Page 1954 CUSUM on log-vol"),
    ("cusum_rng", "rest_rng", "range CUSUM ↑ rest-of-day range", "CUSUM on ATR-scaled range"),
    ("hawkes", "rest_rng", "jump cluster ↑ rest-of-day range", "Hawkes exp kernel on |r|>2"),
    ("bns_jump", "rest_rng", "RV−bipower jump ↑ rest-of-day range", "Barndorff-Nielsen & Shephard 2004"),
    ("cusum_ret", "dropx", "return CUSUM ↑ tail risk", "Page 1954 (S139 baseline)"),
]


def main() -> int:
    from build_plan import connect

    connect().close()
    rng = np.random.default_rng(314)
    print("A314 family1: build panel…", flush=True)
    R = build_panel()
    split = R["_split"].iloc[0]
    results = [eval_method(R, ev, out, claim, src, rng) for ev, out, claim, src in METHODS]
    overlays = []
    for r in results:
        if r.get("pass_bar"):
            overlays.append(put_overlay(R, r["name"]))

    L = [
        f"# A314 family 1 — changepoint packet (S142)",
        f"SPY+QQQ {R.d.nunique()} sessions · minute-matched placebo · H1 < {split} ≤ H2",
        "",
    ]
    for r in results:
        if "eff" not in r:
            L.append(f"- **{r['name']}** · {r.get('claim', '?')} · **{r['verdict']}** · {r.get('source', '')}")
            continue
        e1, e2 = r["eff"]["H1"], r["eff"]["H2"]
        t1, t2 = r["ts"]["H1"], r["ts"]["H2"]
        unit = "pp" if r["outcome"] == "dropx" else "×ATR pp"
        mde = r["mde"]
        mde_s = f"{mde:.1f}{unit}" if math.isfinite(mde) else "n/a"
        ef = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        tf = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        L.append(
            f"- **{r['name']}** · {r['claim']} · effect H1/H2 {ef(e1)}/{ef(e2)} · t {tf(t1)}/{tf(t2)} · "
            f"MDE≈{mde_s} · **{r['verdict']}** · {r['source']}"
        )
    for o in overlays:
        L.append(f"- put overlay: {o}")
    if not overlays:
        L.append("- put overlay: none (no intraday PASS)")

    packet = "\n".join(L[:25]) + "\n"
    OUT.write_text(packet)
    OUT_FULL.write_text(packet + "\n---\n" + "\n".join(L) + "\n")
    print(packet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
