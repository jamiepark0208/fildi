"""S082 — what preceded real lows and highs? (A245; feeds A244)

Pre-registered in research/studies/INDEX.md (row S082) BEFORE this script was run.

Label (no look-ahead in features; confirmation uses the forward path only for the *label*):
  swing low  = close is the lowest within ±20 sessions AND within the next 20 sessions the stock rises
               ≥ 1.5 × (20-d σ of daily log returns · √20) from that close
  swing high = mirror (highest within ±20 AND falls ≥ 1.5× that move)
Panel: lseg_research.daily_history, ~265 names, 2018-10→.
Features at t (known that day): dd_52w, z5, z20, rsi14, rsi2, mfi14, dist_ma50, dist_ma200, vol_spike60,
gap_count5, iv30, iv_rank_1y, iv_rv, iv_chg5, spy_below_200, breadth_ma50, earnings_pm5.
Compare extrema vs look-alikes (same dd_52w × ret20 quintile bucket, not an extremum).
Fit HistGradientBoosting on 2018-10→2023-12; holdout 2024-01→.
Pass = holdout AUC ≥ 0.60 vs look-alikes AND top-decile signal's fwd-20d return beats look-alike decile, month-block t ≥ 2.
Holm over univariate feature tests. Stop: FAIL → no frozen entry rule for A244.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s082_swing_extrema.py [--smoke] [--tickers=AAPL,NVDA]
"""
from __future__ import annotations

import math
import statistics
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S082.md"
START = date(2018, 10, 1)
FIT_END = date(2023, 12, 31)
HOLDOUT = date(2024, 1, 1)
WIN, CONFIRM = 20, 20
BOUNCE_K = 1.5
FUNDS = {"SPY", "QQQ", "IWM", "SMH", "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"}
FEATS = ["dd_52w", "z5", "z20", "rsi14", "rsi2", "mfi14", "dist_ma50", "dist_ma200", "vol_spike60",
         "gap_count5", "iv30", "iv_rank_1y", "iv_rv", "iv_chg5", "spy_below_200", "breadth_ma50", "earnings_pm5"]
rng = np.random.default_rng(82)


def rsi(c, n):
    from quantcore.ta import rsi as _rsi  # one home (Jamie 11-15)
    return _rsi(c, n)


def mfi(h, l, c, v, n=14):
    out = np.full(len(c), np.nan)
    tp = (h + l + c) / 3.0
    rmf = tp * np.where(np.isnan(v), 0.0, v)
    for i in range(n, len(c)):
        pos = neg = 0.0
        for j in range(i - n + 1, i + 1):
            if tp[j] > tp[j - 1]:
                pos += rmf[j]
            elif tp[j] < tp[j - 1]:
                neg += rmf[j]
        out[i] = 100.0 if neg == 0 else 100 - 100 / (1 + pos / neg)
    return out


def iv_rank(series, look=252):
    a = np.asarray(series, float)
    out = np.full(len(a), np.nan)
    for i in range(look, len(a)):
        w = a[i - look + 1:i + 1]
        w = w[~np.isnan(w)]
        if len(w) >= 120 and not np.isnan(a[i]):
            out[i] = (w < a[i]).mean()
    return out


def load(conn, only=None):
    q = ("SELECT ticker, date, open_proxy, high, low, close, volume, iv30 "
         "FROM (SELECT ticker, date, close AS open_proxy, high::float, low::float, close::float, "
         "volume::float, COALESCE(iv30_put, iv30_call)::float AS iv30 "
         "FROM lseg_research.daily_history WHERE close > 0 AND date >= %s) x ORDER BY ticker, date")
    # open not in table — use prior close as open proxy for gaps
    rows = conn.execute(
        "SELECT ticker, date, high::float, low::float, close::float, volume::float, "
        "COALESCE(iv30_put, iv30_call)::float FROM lseg_research.daily_history "
        "WHERE close > 0 AND date >= %s ORDER BY ticker, date",
        (date(2017, 1, 1),),
    ).fetchall()
    px = defaultdict(list)
    for t, d, h, l, c, v, iv in rows:
        if only and t not in only:
            continue
        px[t].append((d, h or c, l or c, c, v if v else np.nan, iv if iv else np.nan))
    earn = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves").fetchall():
        earn[t].append(d)
    for t in earn:
        earn[t].sort()
    return px, earn


def build(px, earn):
    """Return list of day-rows with features + labels. Labels need +20 sessions of future → truncated."""
    # SPY + breadth first
    spy = px.get("SPY")
    if not spy:
        raise SystemExit("SPY missing from daily_history")
    spy_d = [r[0] for r in spy]
    spy_c = np.array([r[3] for r in spy], float)
    spy_ma200 = {spy_d[i]: spy_c[i] < spy_c[i - 199:i + 1].mean()
                 for i in range(199, len(spy_d))}

    # breadth: % of non-fund names with close > MA50 on each date
    above = defaultdict(lambda: [0, 0])
    for t, rows in px.items():
        if t in FUNDS:
            continue
        c = np.array([r[3] for r in rows], float)
        for i in range(50, len(rows)):
            d = rows[i][0]
            above[d][1] += 1
            if c[i] > c[i - 49:i + 1].mean():
                above[d][0] += 1
    breadth = {d: (a / n if n else np.nan) for d, (a, n) in above.items()}

    out = []
    for t, rows in px.items():
        if t in FUNDS or len(rows) < 300:
            continue
        dates = [r[0] for r in rows]
        h = np.array([r[1] for r in rows], float)
        l = np.array([r[2] for r in rows], float)
        c = np.array([r[3] for r in rows], float)
        v = np.array([r[4] for r in rows], float)
        iv = np.array([r[5] for r in rows], float)
        n = len(c)
        lr = np.diff(np.log(c))
        r5 = np.full(n, np.nan)
        r20 = np.full(n, np.nan)
        z5 = np.full(n, np.nan)
        z20 = np.full(n, np.nan)
        rv20 = np.full(n, np.nan)
        for i in range(60, n):
            r5[i] = c[i] / c[i - 5] - 1
            r20[i] = c[i] / c[i - 20] - 1
            sd = lr[i - 60:i].std(ddof=1)
            if sd > 0:
                z5[i] = math.log(c[i] / c[i - 5]) / (sd * math.sqrt(5))
                z20[i] = math.log(c[i] / c[i - 20]) / (sd * math.sqrt(20))
            rv20[i] = lr[i - 20:i].std(ddof=1) * math.sqrt(252) if i >= 20 else np.nan
        rsi14 = rsi(c, 14)
        rsi2 = rsi(c, 2)
        mfi14 = mfi(h, l, c, v, 14)
        ivr = iv_rank(iv)
        # labels need i in [WIN, n - CONFIRM)
        is_low = np.zeros(n, bool)
        is_high = np.zeros(n, bool)
        for i in range(max(252, WIN), n - CONFIRM):
            if dates[i] < START:
                continue
            wlo = c[i - WIN:i + WIN + 1].min()
            whi = c[i - WIN:i + WIN + 1].max()
            sd20 = lr[i - 20:i].std(ddof=1) if i >= 20 else np.nan
            move = BOUNCE_K * sd20 * math.sqrt(20) if sd20 == sd20 and sd20 > 0 else np.nan
            if move != move:
                continue
            if c[i] <= wlo + 1e-12:
                # bounce: max close in next CONFIRM / c[i] - 1 >= move (log≈linear for small)
                thr = c[i] * math.exp(move)  # move is in log space from σ of log returns
                if c[i + 1:i + CONFIRM + 1].max() >= thr:
                    is_low[i] = True
            if c[i] >= whi - 1e-12:
                thr = c[i] * math.exp(-move)
                if c[i + 1:i + CONFIRM + 1].min() <= thr:
                    is_high[i] = True

        er = earn.get(t, [])
        for i in range(max(252, WIN), n - CONFIRM):
            if dates[i] < START:
                continue
            dd = c[i] / c[i - 251:i + 1].max() - 1
            ma50 = c[i - 49:i + 1].mean()
            ma200 = c[i - 199:i + 1].mean() if i >= 199 else np.nan
            vol60 = np.nanmean(v[i - 59:i + 1])
            vol5 = np.nanmean(v[i - 4:i + 1])
            gaps = 0
            for j in range(i - 4, i + 1):
                if j > 0 and not np.isnan(h[j]) and abs(c[j] / c[j - 1] - 1) >= 0.03:
                    gaps += 1
            iv0 = iv[i]
            if iv0 == iv0 and iv0 > 3:  # LSEG sometimes stores percent
                iv0 = iv0 / 100.0
            iv5 = iv[i - 5] if i >= 5 else np.nan
            if iv5 == iv5 and iv5 > 3:
                iv5 = iv5 / 100.0
            e_pm5 = 0.0
            for ed in er:
                if abs((ed - dates[i]).days) <= 5:
                    e_pm5 = 1.0
                    break
            fwd20 = c[i + 20] / c[i] - 1
            row = {
                "t": t, "d": dates[i], "side": ("low" if is_low[i] else "high" if is_high[i] else "none"),
                "y_low": int(is_low[i]), "y_high": int(is_high[i]), "fwd20": fwd20,
                "dd_52w": dd, "z5": z5[i], "z20": z20[i], "rsi14": rsi14[i], "rsi2": rsi2[i], "mfi14": mfi14[i],
                "dist_ma50": c[i] / ma50 - 1, "dist_ma200": (c[i] / ma200 - 1) if ma200 == ma200 else np.nan,
                "vol_spike60": (vol5 / vol60) if vol60 and vol60 == vol60 and vol60 > 0 else np.nan,
                "gap_count5": float(gaps), "iv30": iv0, "iv_rank_1y": ivr[i],
                "iv_rv": (iv0 / rv20[i]) if rv20[i] and rv20[i] > 0 and iv0 == iv0 else np.nan,
                "iv_chg5": (iv0 - iv5) if iv0 == iv0 and iv5 == iv5 else np.nan,
                "spy_below_200": float(1.0 if spy_ma200.get(dates[i]) else 0.0),
                "breadth_ma50": breadth.get(dates[i], np.nan),
                "earnings_pm5": e_pm5,
                "ret20": r20[i],
            }
            out.append(row)
    return out


def quintile_edges(vals):
    v = np.array([x for x in vals if x == x], float)
    if len(v) < 50:
        return None
    return np.quantile(v, [0.2, 0.4, 0.6, 0.8])


def bucket(v, edges):
    if edges is None or v != v:
        return -1
    return int(np.searchsorted(edges, v, side="right"))


def lookalikes(rows, side):
    """For each extremum, sample non-extrema in the same dd×ret20 bucket (fit window defines edges)."""
    ykey = "y_low" if side == "low" else "y_high"
    fit = [r for r in rows if r["d"] <= FIT_END]
    e_dd = quintile_edges([r["dd_52w"] for r in fit])
    e_r = quintile_edges([r["ret20"] for r in fit])
    by = defaultdict(list)
    for r in rows:
        by[(bucket(r["dd_52w"], e_dd), bucket(r["ret20"], e_r))].append(r)
    pos, neg = [], []
    for r in rows:
        if r[ykey]:
            pos.append(r)
            b = (bucket(r["dd_52w"], e_dd), bucket(r["ret20"], e_r))
            cands = [x for x in by[b] if not x[ykey]]
            if cands:
                neg.append(cands[rng.integers(0, len(cands))])
    return pos, neg


def Xy(rows, feats=FEATS):
    X = np.array([[r[f] for f in feats] for r in rows], float)
    # median-impute
    for j in range(X.shape[1]):
        col = X[:, j]
        m = np.nanmedian(col)
        col[np.isnan(col)] = m if m == m else 0.0
        X[:, j] = col
    return X


def month_block_t(a_rows, b_rows, key="fwd20"):
    """t of mean(a)−mean(b) via month-block bootstrap on the pooled date months of a."""
    by_a, by_b = defaultdict(list), defaultdict(list)
    for r in a_rows:
        by_a[(r["d"].year, r["d"].month)].append(r[key])
    for r in b_rows:
        by_b[(r["d"].year, r["d"].month)].append(r[key])
    ks = sorted(set(by_a) | set(by_b))
    if len(ks) < 6:
        return float("nan")
    def diff(ksel):
        aa = [v for k in ksel for v in by_a.get(k, [])]
        bb = [v for k in ksel for v in by_b.get(k, [])]
        if not aa or not bb:
            return np.nan
        return statistics.mean(aa) - statistics.mean(bb)
    obs = diff(ks)
    bs = []
    for _ in range(400):
        pick = [ks[i] for i in rng.integers(0, len(ks), size=len(ks))]
        bs.append(diff(pick))
    bs = [x for x in bs if x == x]
    if len(bs) < 50:
        return float("nan")
    sd = statistics.pstdev(bs)
    return obs / sd if sd else float("nan")


def univ_t(pos, neg, feat):
    a = [r[feat] for r in pos if r[feat] == r[feat]]
    b = [r[feat] for r in neg if r[feat] == r[feat]]
    if len(a) < 30 or len(b) < 30:
        return float("nan"), float("nan")
    ma, mb = statistics.mean(a), statistics.mean(b)
    va, vb = statistics.variance(a), statistics.variance(b)
    se = math.sqrt(va / len(a) + vb / len(b))
    t = (ma - mb) / se if se else float("nan")
    # two-sided normal approx p
    p = math.erfc(abs(t) / math.sqrt(2)) if t == t else 1.0
    return t, p


def holm(ps):
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i][1])
    out = [1.0] * m
    prev = 0.0
    for rank, i in enumerate(order):
        adj = min(1.0, ps[i][1] * (m - rank))
        adj = max(adj, prev)
        out[i] = adj
        prev = adj
    return out


def main():
    args = sys.argv[1:]
    only = next((set(a.split("=", 1)[1].split(",")) for a in args if a.startswith("--tickers=")), None)
    smoke = "--smoke" in args
    if only:
        only |= {"SPY"}
    conn = connect()
    px, earn = load(conn, only)
    print(f"loaded {len(px)} names", flush=True)
    rows = build(px, earn)
    print(f"{len(rows):,} day-rows", flush=True)

    if smoke:
        lows = [r for r in rows if r["y_low"]][:5]
        highs = [r for r in rows if r["y_high"]][:3]
        for r in lows + highs:
            print(f"{r['t']} {r['d']} {r['side']} dd={r['dd_52w']:+.1%} z5={r['z5']:.2f} "
                  f"rsi14={r['rsi14']:.0f} fwd20={r['fwd20']:+.1%} iv_rv={r['iv_rv']}")
        # hand-check: local min property
        for r in lows[:3]:
            series = px[r["t"]]
            dates = [x[0] for x in series]
            i = dates.index(r["d"])
            c = [x[3] for x in series]
            w = c[i - WIN:i + WIN + 1]
            assert c[i] <= min(w) + 1e-9, (r, c[i], min(w))
            print(f"  hand-check {r['t']} {r['d']}: local min in ±{WIN} ok, fwd20 {r['fwd20']:+.1%}")
        return

    L = [f"# S082 — what preceded real lows and highs (A245, {date.today()})", "",
         f"{len(rows):,} name-days, {len({r['t'] for r in rows})} names, {START}→. "
         f"Swing = ±{WIN}d local extreme + {BOUNCE_K}×σ√{CONFIRM} confirmation in {CONFIRM}d. "
         f"Fit ≤{FIT_END}, holdout {HOLDOUT}→. Pre-registered INDEX S082 before run.", ""]

    verdicts = {}
    for side in ("low", "high"):
        pos, neg = lookalikes(rows, side)
        fit_pos = [r for r in pos if r["d"] <= FIT_END]
        fit_neg = [r for r in neg if r["d"] <= FIT_END]
        ho_pos = [r for r in pos if r["d"] >= HOLDOUT]
        ho_neg = [r for r in neg if r["d"] >= HOLDOUT]
        L += [f"## Swing {side}s vs look-alikes", "",
              f"Fit: {len(fit_pos):,} extrema / {len(fit_neg):,} look-alikes. "
              f"Holdout: {len(ho_pos):,} / {len(ho_neg):,}.", ""]

        # univariate + Holm (fit only)
        tests = []
        for f in FEATS:
            t, p = univ_t(fit_pos, fit_neg, f)
            tests.append((f, t, p))
        adj = holm([(f, p) for f, t, p in tests])
        L += ["| feature | mean extrema | mean look-alike | t | Holm p |", "|---|---|---|---|---|"]
        for (f, t, p), hp in zip(tests, adj):
            ma = statistics.mean([r[f] for r in fit_pos if r[f] == r[f]]) if fit_pos else float("nan")
            mb = statistics.mean([r[f] for r in fit_neg if r[f] == r[f]]) if fit_neg else float("nan")
            L.append(f"| {f} | {ma:.3g} | {mb:.3g} | {t:.2f} | {hp:.3g} |")
        L.append("")

        # classifier
        train = fit_pos + fit_neg
        test = ho_pos + ho_neg
        y_tr = np.array([1] * len(fit_pos) + [0] * len(fit_neg))
        y_te = np.array([1] * len(ho_pos) + [0] * len(ho_neg))
        auc = float("nan")
        t_ret = float("nan")
        top_mean = float("nan")
        alike_mean = float("nan")
        if len(fit_pos) >= 50 and len(ho_pos) >= 30 and len(set(y_te)) == 2:
            clf = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, max_iter=120,
                                                 random_state=82)
            clf.fit(Xy(train), y_tr)
            proba = clf.predict_proba(Xy(test))[:, 1]
            auc = roc_auc_score(y_te, proba)
            # attach scores; top decile among *all holdout look-alike-universe*? Spec: top-decile signal's
            # forward 20-d vs look-alike decile — score the holdout panel of (pos+neg), take top decile of score,
            # compare fwd20 to the look-alike-only top? "top-decile signal's forward 20-d stock return beats
            # the look-alike decile" → top decile of model score vs mean fwd20 of look-alikes in holdout.
            scored = list(zip(test, proba))
            scored.sort(key=lambda z: z[1], reverse=True)
            k = max(1, len(scored) // 10)
            top = [r for r, _ in scored[:k]]
            top_mean = statistics.mean([r["fwd20"] for r in top])
            alike_mean = statistics.mean([r["fwd20"] for r in ho_neg]) if ho_neg else float("nan")
            # month-block t: top vs all look-alikes
            t_ret = month_block_t(top, ho_neg)
            L += [f"**Holdout AUC (vs look-alikes): {auc:.3f}**", "",
                  f"Top-decile score n={len(top)} fwd20 mean {top_mean:+.2%} vs look-alike mean {alike_mean:+.2%} "
                  f"(month-block t {t_ret:.2f}). "
                  f"{'Lows want top > alike.' if side == 'low' else 'Highs want top < alike (more negative).'}", ""]
        else:
            L += ["Classifier skipped (insufficient n).", ""]

        # lows: top-decile should bounce more; highs: top-decile should fall more
        if side == "low":
            ret_ok = (top_mean == top_mean and alike_mean == alike_mean and top_mean > alike_mean
                      and t_ret == t_ret and t_ret >= 2)
        else:
            ret_ok = (top_mean == top_mean and alike_mean == alike_mean and top_mean < alike_mean
                      and t_ret == t_ret and t_ret <= -2)
        ok = bool(auc == auc and auc >= 0.60 and ret_ok)
        verdicts[side] = (ok, auc, t_ret, top_mean, alike_mean, len(ho_pos))
        L += [f"**Swing {side} verdict: {'PASS' if ok else 'FAIL'}**", ""]

    # today flags: deepest dd names that look like lows by frozen model if any side passed
    L += ["## Today's deep-drawdown names (descriptive; no product unless PASS)", ""]
    last = max(r["d"] for r in rows)
    today = [r for r in rows if r["d"] == last]
    deep = sorted(today, key=lambda r: r["dd_52w"])[:15]
    L += ["| ticker | dd_52w | z5 | rsi14 | iv_rv | spy_below_200 |", "|---|---|---|---|---|---|"]
    for r in deep:
        L.append(f"| {r['t']} | {r['dd_52w']:+.1%} | {r['z5']:.2f} | {r['rsi14']:.0f} | "
                 f"{r['iv_rv'] if r['iv_rv']==r['iv_rv'] else float('nan'):.2f} | {int(r['spy_below_200'])} |")
    for name in ("RKLB", "CRWV"):
        hit = [r for r in today if r["t"] == name]
        if hit:
            r = hit[0]
            L += ["", f"**{name} today:** dd {r['dd_52w']:+.1%} z5 {r['z5']:.2f} rsi14 {r['rsi14']:.0f} "
                  f"(in panel: yes)."]
        else:
            L += ["", f"**{name} today:** not in LSEG panel (or no bar on {last})."]

    if all(ok for ok, *_ in verdicts.values()):
        overall = "PASS — both sides clear holdout bar; freeze rule for A244 entry overlay (Claude ships product)"
    elif any(ok for ok, *_ in verdicts.values()):
        side = next(s for s, (ok, *_) in verdicts.items() if ok)
        overall = f"PARTIAL — only swing {side}s clear; freeze that side only for A244"
    else:
        overall = "FAIL — no frozen entry rule for A244 (stop rule)"
    L += ["", f"**Ship decision: {overall}**", "",
          "Priors: S025 (2σ drops), S051 (laggard winners), S079 (downside AUC ~0.52) — beat those or don't ship.", ""]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print(f"→ {OUT}")
    print(overall)
    for side, (ok, auc, t_ret, top_mean, alike_mean, n) in verdicts.items():
        print(f"  {side}: ok={ok} AUC={auc:.3f} t={t_ret:.2f} top={top_mean:+.2%} alike={alike_mean:+.2%} n_ho={n}")


if __name__ == "__main__":
    main()
