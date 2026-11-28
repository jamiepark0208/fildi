"""S212 — risk-reversal screen (Jamie 11-27): semis/tech/financials drawdown thesis → sell deep-OTM put, buy deep-OTM call,
≈ zero cost, same expiry. Stage 1 = stored data (fund score, revisions, technicals, IV). Stage 2 = live Schwab chain per name
(after the close: last bid/ask), every leg validated, structures built at realistic RH fills. Output: out/rr/s212_*.json.

Pre-registered (written before any chain was pulled, 11-27):
  * stage-1 score = 0.35 fund_total peer pct + 0.15 EPS-revision pct (S100: revisions carry calls) + 0.20 drawdown/oversold pct
    + 0.15 IV richness (IV rank, IV/RV: S003 — IV÷RV is the put edge) + 0.15 StarMine combined alpha pct. Gates: fund_total ≥ its peer
    median, price ≥ $15, ≥ 10 % off 52-w high, option OI present.
  * structure = same expiry, put |Δ| 0.08–0.20 sold, call bought at the highest Δ the put credit pays for (net ≥ −0.3 % of spot).
  * expected signs: skew (put IV − call IV at equal |Δ|) > 0 for most names (S178: calls have no wing, puts +6–20 %); the RR's
    risk-neutral EV ≈ −spread cost (no free lunch) — any edge has to come from the stock view, not the options.
  * historical odds = this name's own h-day returns on days it sat ≥ 20 % below its 52-w high (2018→, LSEG/Schwab closes);
    n reported; < 30 non-overlapping windows → shown as 'thin'.

    .venv/bin/python analysis/s212_rr_screen.py stage1        # → out/rr/s212_stage1.json
    .venv/bin/python analysis/s212_rr_screen.py chains [--n 70]
    .venv/bin/python analysis/s212_rr_screen.py build          # → out/rr/s212_rr.json
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from quantcore.ta import rsi as rsi_vec  # noqa: E402

OUT = HERE.parent / "out" / "rr"
GROUPS = ("technology.", "financials.", "fintech.")
EXPIRIES = ("2027-01-15", "2027-02-19", "2027-03-19")
FILL = 0.23          # RH realistic fill: bid + 23 % of spread when selling, ask − 23 % when buying (state.md open facts)
ETFS = ("SMH", "SOXX", "QQQ", "XLF", "IGV", "XLK")


def q(conn, sql, *a):
    return conn.execute(sql, a).fetchall()


def pct_rank(vals: dict, higher_better=True) -> dict:
    ks = [k for k, v in vals.items() if v is not None and np.isfinite(v)]
    if not ks:
        return {}
    xs = np.array([vals[k] for k in ks])
    order = xs.argsort().argsort() / max(len(xs) - 1, 1)
    return {k: (o if higher_better else 1 - o) for k, o in zip(ks, order)}


# ---------------------------------------------------------------- stage 1
def stage1():
    with connect() as conn:
        asof = q(conn, "SELECT MAX(as_of) FROM fund_score_snapshots")[0][0]
        F = {r[0]: dict(zip(("ticker", "total", "value", "growth", "quality", "safety", "conf", "peer", "top"), r)) for r in q(conn, """
            SELECT ticker, fund_total::float, fund_value::float, fund_growth::float, fund_quality::float, fund_safety::float, confidence,
                   peer_group_id, top_metrics FROM fund_score_snapshots WHERE as_of = %s""", asof)}
        F = {t: f for t, f in F.items() if f["peer"] and f["peer"].startswith(GROUPS)}
        names = sorted(F)
        pg = dict(q(conn, "SELECT id, name FROM peer_groups"))
        reg = {r[0]: r[1] for r in q(conn, "SELECT ticker, name FROM ticker_registry WHERE ticker = ANY(%s)", names)}
        sig = {r[0]: r for r in q(conn, """SELECT DISTINCT ON (ticker) ticker, as_of, eps_drift_30d_pct, combined_alpha_rank, arm_rank,
                 pt_upside_pct, rec_mean, pred_surprise_pct_fq1, short_pct, pt_num_est, price_mo_rank, valmo_rank
                 FROM lseg_research.signals_daily WHERE ticker = ANY(%s) ORDER BY ticker, as_of DESC""", names)}
        px = defaultdict(list)
        for t, d, c in q(conn, """SELECT ticker, date, close::float FROM prices_historical WHERE ticker = ANY(%s)
                                  AND date > CURRENT_DATE - 400 AND close > 0 ORDER BY ticker, date""", names + list(ETFS)):
            px[t].append((d, c))
        ivr = dict(q(conn, """SELECT DISTINCT ON (ticker) ticker, pctile::float FROM watchlist_sync.iv_rank_daily
                              WHERE ticker = ANY(%s) ORDER BY ticker, date DESC""", names))
        iv30 = dict(q(conn, """SELECT DISTINCT ON (ticker) ticker, iv30_put::float FROM lseg_research.daily_history
                               WHERE ticker = ANY(%s) AND iv30_put IS NOT NULL ORDER BY ticker, date DESC""", names))
        er = dict(q(conn, """SELECT ticker, MIN(report_date) FROM earnings_calendar WHERE ticker = ANY(%s)
                             AND report_date >= CURRENT_DATE GROUP BY 1""", names))
        oi = dict(q(conn, """SELECT ticker, SUM(open_interest) FROM option_chain_history WHERE ticker = ANY(%s)
                             AND as_of = (SELECT MAX(as_of) FROM option_chain_history) GROUP BY 1""", names))
        fit = {r[0]: r for r in q(conn, "SELECT ticker, fit, own, street, color, verdict FROM watchlist_sync.fit_scores WHERE ticker = ANY(%s)", names)}
        tf = {r[0]: r for r in q(conn, """SELECT ticker, forward_pe::float, revenue_growth_yoy::float, operating_margin::float, roic::float,
                 fcf_yield::float, debt_to_equity::float, dividend_yield::float, analyst_target_price::float, beta::float
                 FROM ticker_fundamentals WHERE ticker = ANY(%s)""", names)}
    smh = dict(px["SMH"])
    peer_tot = defaultdict(list)
    for f in F.values():
        if f["total"] is not None:
            peer_tot[f["peer"]].append(f["total"])
    rows = []
    for t in names:
        s = px.get(t) or []
        if len(s) < 210:
            continue
        ds = [d for d, _ in s]
        cl = np.array([c for _, c in s])
        last = cl[-1]
        hi = cl[-252:].max()
        lr = np.diff(np.log(cl))
        rv20 = lr[-20:].std() * math.sqrt(252)
        rv60 = lr[-60:].std() * math.sqrt(252)
        r = rsi_vec(cl[-150:], 14)[-1]
        sma50, sma200 = cl[-50:].mean(), cl[-200:].mean()
        common = [(d, c) for d, c in s[-253:] if d in smh]
        beta = None
        if len(common) > 120:
            a = np.diff(np.log([c for _, c in common]))
            b = np.diff(np.log([smh[d] for d, _ in common]))
            beta = float(np.cov(a, b)[0, 1] / b.var())
        f = F[t]
        peers = sorted(peer_tot[f["peer"]])
        ppct = (sum(x <= f["total"] for x in peers) / len(peers)) if f["total"] is not None and peers else None
        sg = sig.get(t)
        rows.append({
            "ticker": t, "name": reg.get(t), "peer": f["peer"], "peer_name": pg.get(f["peer"]), "fund_total": f["total"],
            "fund_peer_pct": ppct, "fund_quality": f["quality"], "fund_growth": f["growth"], "fund_value": f["value"],
            "fund_safety": f["safety"], "fund_conf": f["conf"], "fund_top": (f["top"] or [])[:6],
            "close": float(last), "close_date": str(ds[-1]), "hi52": float(hi), "dd52": float(last / hi - 1),
            "ret5": float(last / cl[-6] - 1), "ret20": float(last / cl[-21] - 1), "ret60": float(last / cl[-61] - 1),
            "rsi14": float(r) if np.isfinite(r) else None, "vs_sma50": float(last / sma50 - 1), "vs_sma200": float(last / sma200 - 1),
            "rv20": float(rv20), "rv60": float(rv60), "beta_smh": beta, "iv30": iv30.get(t), "iv_rank": ivr.get(t),
            "iv_rv": (iv30[t] / 100 / rv60) if iv30.get(t) and rv60 else None,
            "next_er": str(er[t]) if er.get(t) else None, "opt_oi": int(oi.get(t) or 0),
            "eps_drift30": sg[2] if sg else None, "alpha_rank": sg[3] if sg else None, "arm_rank": sg[4] if sg else None,
            "pt_upside": sg[5] if sg else None, "rec_mean": sg[6] if sg else None, "pred_surprise": sg[7] if sg else None,
            "short_pct": sg[8] if sg else None, "pt_n": sg[9] if sg else None, "sig_asof": str(sg[1]) if sg else None,
            "fit": fit[t][1] if t in fit else None, "fit_color": fit[t][4] if t in fit else None, "fit_verdict": fit[t][5] if t in fit else None,
            "fwd_pe": tf[t][1] if t in tf else None, "rev_g": tf[t][2] if t in tf else None, "op_mgn": tf[t][3] if t in tf else None,
            "roic": tf[t][4] if t in tf else None, "fcf_yield": tf[t][5] if t in tf else None, "de": tf[t][6] if t in tf else None,
            "div_y": tf[t][7] if t in tf else None, "target": tf[t][8] if t in tf else None,
        })
    by = {r["ticker"]: r for r in rows}
    comp = {
        "fund": pct_rank({t: r["fund_peer_pct"] for t, r in by.items()}),
        "rev": pct_rank({t: r["eps_drift30"] for t, r in by.items()}),
        "dd": pct_rank({t: -r["dd52"] for t, r in by.items()}),
        "rsi": pct_rank({t: r["rsi14"] for t, r in by.items()}, higher_better=False),
        "ivr": pct_rank({t: r["iv_rank"] for t, r in by.items()}),
        "ivrv": pct_rank({t: r["iv_rv"] for t, r in by.items()}),
        "alpha": pct_rank({t: r["alpha_rank"] for t, r in by.items()}),
    }
    for t, r in by.items():
        g = lambda k: comp[k].get(t, 0.5)  # noqa: E731 — missing = neutral, flagged in 'missing'
        r["missing"] = [k for k in comp if t not in comp[k]]
        r["s1_parts"] = {"fund": g("fund"), "rev": g("rev"), "oversold": 0.5 * g("dd") + 0.5 * g("rsi"),
                         "iv_rich": 0.5 * g("ivr") + 0.5 * g("ivrv"), "alpha": g("alpha")}
        p = r["s1_parts"]
        r["s1"] = 0.35 * p["fund"] + 0.15 * p["rev"] + 0.20 * p["oversold"] + 0.15 * p["iv_rich"] + 0.15 * p["alpha"]
        med = np.median([x for x in peer_tot[r["peer"]]]) if peer_tot[r["peer"]] else None
        r["gate"] = [why for ok, why in (
            (r["fund_total"] is not None and med is not None and r["fund_total"] >= med, "fund below peer median"),
            (r["close"] >= 15, "price < $15"), (r["dd52"] <= -0.10, "< 10 % off 52-w high")) if not ok]
    etf = {}
    for e in ETFS:
        s = px.get(e) or []
        if s:
            cl = np.array([c for _, c in s])
            etf[e] = {"close": float(cl[-1]), "date": str(s[-1][0]), "dd52": float(cl[-1] / cl[-252:].max() - 1),
                      "ret20": float(cl[-1] / cl[-21] - 1), "rsi14": float(rsi_vec(cl[-150:], 14)[-1])}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "s212_stage1.json").write_text(json.dumps({"asof": str(asof), "rows": rows, "etf": etf}, default=str, indent=0))
    ok = sorted((r for r in rows if not r["gate"]), key=lambda r: -r["s1"])
    print(f"universe {len(rows)} · pass gates {len(ok)} · fund as_of {asof}")
    from collections import Counter
    print("gate fails:", Counter(g for r in rows for g in r["gate"]).most_common())
    for r in ok[:25]:
        print(f"{r['ticker']:<6} {r['peer_name'][:22]:<22} s1 {r['s1']:.2f} fund {r['fund_total']:.0f} dd {r['dd52']:+.0%} rsi {r['rsi14'] or 0:.0f} "
              f"ivr {r['iv_rank'] if r['iv_rank'] is not None else float('nan'):.2f} er {r['next_er']}")


# ---------------------------------------------------------------- stage 2: chains
def chains(n: int):
    S1 = json.loads((OUT / "s212_stage1.json").read_text())
    ok = sorted((r for r in S1["rows"] if not r["gate"]), key=lambda r: -r["s1"])[:n]
    names = [r["ticker"] for r in ok] + list(ETFS)
    cdir = OUT / "chains"
    cdir.mkdir(parents=True, exist_ok=True)
    got = 0
    for t in names:
        f = cdir / f"{t}.json"
        if f.exists() and (time.time() - f.stat().st_mtime) < 6 * 3600:
            got += 1
            continue
        req = urllib.request.Request("http://127.0.0.1:8080/api/schwab/chain-ladder",
                                     data=json.dumps({"ticker": t, "fromDate": EXPIRIES[0], "toDate": EXPIRIES[-1], "strikeCount": 200}).encode(),
                                     headers={"Content-Type": "application/json"})
        for attempt in range(2):
            try:
                d = json.load(urllib.request.urlopen(req, timeout=90))
                if d.get("rows"):
                    d["fetched_at"] = datetime.now().isoformat(timespec="seconds")
                    f.write_text(json.dumps(d))
                    got += 1
                    break
            except Exception as e:  # noqa: BLE001
                print(f"  {t}: {e}")
                time.sleep(3)
    print(f"chains: {got}/{len(names)}")


def lse_trades():
    """Second source for every leg (11-27 #10): London Strategic Edge chain = IV at each contract's last OPRA trade
    (trades, no quotes). Used to confirm a mid when the after-close Schwab spread is too wide to trust on its own."""
    sys.path.insert(0, str(HERE.parent.parent))
    import lse_client as L
    ldir = OUT / "lse"
    ldir.mkdir(parents=True, exist_ok=True)
    conn = L.connect()
    got = 0
    for f in sorted((OUT / "chains").glob("*.json")):
        t = f.stem
        out = {}
        for e in EXPIRIES:
            d = L.get_json(conn, f"options/chain?underlying={t}&expiry={e}&limit=1000", cache_key=f"rr:{t}:{e}:{date.today()}")
            for r in (d.get("rows") if isinstance(d.get("rows"), list) else []):
                if r.get("iv") and r.get("last_trade_at"):
                    out[f"{e}|{r['contract_type']}|{float(r['strike'])}"] = {
                        "iv": r["iv"], "last": r.get("last_price"), "at": str(r["last_trade_at"])[:16],
                        "und": r.get("greeks_underlying_price")}
        (ldir / f"{t}.json").write_text(json.dumps({"fetched": datetime.now().isoformat(timespec="seconds"), "legs": out}))
        got += bool(out)
    print(f"lse: {got} names with traded legs")


# ---------------------------------------------------------------- pricing helpers
from quantcore.bs import bs_call, bs_put, norm_cdf as ncdf  # noqa: E402 — one home (copy ratchet)


def bs(S, K, T, r, qd, s, side):
    if T <= 0 or s <= 0:
        return max(0.0, (K - S) if side == "put" else (S - K))
    f = bs_call if side == "call" else bs_put
    return float(f(spot=S, strike=K, iv=s, years=T, r=r, q=qd))


def implied(price, S, K, T, r, qd, side):
    lo, hi = 0.01, 5.0
    intrinsic = max(0.0, (K - S) if side == "put" else (S - K))
    if price <= intrinsic + 1e-6:
        return None
    for _ in range(80):
        m = (lo + hi) / 2
        if bs(S, K, T, r, qd, m, side) > price:
            hi = m
        else:
            lo = m
    return (lo + hi) / 2


def leg_checks(o, S, T, r, qd):
    """Return (ok, flags, my_iv). Flags are data-quality issues; ok = fillable + priced sensibly."""
    fl = []
    b, a = o.get("bid") or 0, o.get("ask") or 0
    if b <= 0:
        fl.append("no bid")
    if a <= b:
        fl.append("ask ≤ bid")
    mid = (a + b) / 2 if a > 0 else 0
    sp = (a - b) / mid if mid > 0 else 9
    if sp > 0.35:
        fl.append(f"spread {sp:.0%} of mid")
    if (o.get("oi") or 0) < 100:
        fl.append(f"OI {o.get('oi') or 0}")
    my = implied(mid, S, o["strike"], T, r, qd, o["side"]) if mid > 0 else None
    sv = o.get("iv")
    if sv is not None and sv > 3:   # Schwab sometimes returns percent
        sv = sv / 100
    if my is None:
        fl.append("mid below intrinsic")
    elif sv and abs(my - sv) > 0.05:
        fl.append(f"IV mismatch {my:.0%} vs Schwab {sv:.0%}")
    hard = {"no bid", "ask ≤ bid", "mid below intrinsic"}
    ok = not any(x in hard or x.startswith("spread") for x in fl)
    return ok, fl, my, sp


# ---------------------------------------------------------------- stage 3: build structures
def hist_windows(conn, t, h, off_hi=0.20):
    """Own h-day forward log returns on days the name sat ≥ off_hi below its trailing 252-d high (2018→). Non-overlapping count too."""
    rs = q(conn, """SELECT date, close::float FROM lseg_research.daily_history WHERE ticker = %s AND close > 0 ORDER BY date""", t)
    if len(rs) < 400:
        rs = q(conn, "SELECT date, close::float FROM prices_historical WHERE ticker = %s AND close > 0 ORDER BY date", t)
    cl = np.array([c for _, c in rs])
    if len(cl) < 300:
        return None
    hi = np.maximum.accumulate(cl)  # running high
    roll = np.array([cl[max(0, i - 251):i + 1].max() for i in range(len(cl))])
    dd = cl / roll - 1
    idx = [i for i in range(252, len(cl) - h) if dd[i] <= -off_hi]
    allidx = list(range(252, len(cl) - h))
    f = lambda ix: np.log(cl[np.array(ix) + h] / cl[np.array(ix)]) if ix else np.array([])  # noqa: E731
    nonover = 0
    last = -10 ** 9
    for i in idx:
        if i - last >= h:
            nonover += 1
            last = i
    del hi
    return {"cond": f(idx), "all": f(allidx), "n_cond": len(idx), "n_cond_indep": nonover, "n_all_indep": len(allidx) // h}


def build():
    S1 = json.loads((OUT / "s212_stage1.json").read_text())
    by = {r["ticker"]: r for r in S1["rows"]}
    with connect() as conn:
        rf = q(conn, "SELECT value FROM watchlist_sync.macro_daily WHERE series = 'tbill3m' ORDER BY date DESC LIMIT 1")[0][0] / 100
        rr_hist = defaultdict(list)
        for t, d, v in q(conn, """SELECT ticker, as_of, rr25 FROM watchlist_sync.rr_skew_daily WHERE rr25 IS NOT NULL AND dte BETWEEN 20 AND 60
                                  ORDER BY ticker, as_of"""):
            rr_hist[t].append(v)
        today = date.today()
        lse = {f.stem: json.loads(f.read_text())["legs"] for f in (OUT / "lse").glob("*.json")} if (OUT / "lse").exists() else {}
        res = []
        for f in sorted((OUT / "chains").glob("*.json")):
            t = f.stem
            d = json.loads(f.read_text())
            S = d["spot"]
            info = by.get(t, {"ticker": t, "close": S, "div_y": None, "etf": True})
            qd = (info.get("div_y") or 0) or 0
            qd = qd / 100 if qd > 0.5 else qd
            spot_chk = abs(S / info["close"] - 1) if info.get("close") else None
            out = {"ticker": t, "spot": S, "spot_vs_close": spot_chk, "fetched_at": d.get("fetched_at"), "etf": t in ETFS, "expiries": {}}
            byexp = defaultdict(list)
            for o in d["rows"]:
                byexp[o["expiry"]].append(o)
            for e in EXPIRIES:
                legs = byexp.get(e) or []
                if not legs:
                    continue
                T = (date.fromisoformat(e) - today).days / 365
                checked = []
                for o in legs:
                    ok, fl, my, sp = leg_checks(o, S, T, rf, qd)
                    o = {**o, "ok": ok, "flags": fl, "my_iv": my, "spread_pct": sp, "mid": ((o.get("bid") or 0) + (o.get("ask") or 0)) / 2}
                    checked.append(o)
                lse_confirm(checked, lse.get(t) or {}, e, S)
                puts = sorted((o for o in checked if o["side"] == "put" and o["strike"] < S), key=lambda o: o["strike"])
                calls = sorted((o for o in checked if o["side"] == "call" and o["strike"] > S), key=lambda o: o["strike"])
                # monotonic / no-arbitrage check over the OTM ladder (mids)
                okp = [o for o in puts if o["ok"]]
                okc = [o for o in calls if o["ok"]]
                arb = sum(1 for a, b in zip(okp, okp[1:]) if a["mid"] > b["mid"] + 0.02) + \
                      sum(1 for a, b in zip(okc, okc[1:]) if b["mid"] > a["mid"] + 0.02)
                # ATM IV + equal-|Δ| skew (interpolate my_iv by |Δ|)
                def iv_at(side_legs, target):
                    pts = sorted(((abs(o["delta"]), o["my_iv"]) for o in side_legs if o["ok"] and o["my_iv"] and o.get("delta") is not None), key=lambda x: x[0])
                    if len(pts) < 2 or not (pts[0][0] <= target <= pts[-1][0]):
                        return None
                    xs, ys = zip(*pts)
                    return float(np.interp(target, xs, ys))
                atm = [o for o in checked if o["ok"] and o["my_iv"] and abs(o["strike"] / S - 1) < 0.03]
                atm_iv = float(np.median([o["my_iv"] for o in atm])) if atm else None
                skew = {k: (iv_at(puts, k), iv_at(calls, k)) for k in (0.10, 0.15, 0.25)}
                # structures
                cands = []
                for p in puts:
                    if not p["ok"] or p.get("delta") is None or not (0.08 <= abs(p["delta"]) <= 0.20):
                        continue
                    credit = p["mid"] - (0.5 - FILL) * eff_spread(p)
                    best = None
                    for c in calls:
                        if not c["ok"] or c.get("delta") is None:
                            continue
                        debit = c["mid"] + (0.5 - FILL) * eff_spread(c)
                        net = credit - debit
                        # pair on MID (after-close spreads are wider than in session); the fill-adjusted net is reported beside it
                        if (p["mid"] - c["mid"]) >= -0.003 * S and (best is None or c["delta"] > best[0]["delta"]):
                            best = (c, debit, net)
                    if best:
                        c, debit, net = best
                        cands.append({"put": p, "call": c, "credit": credit, "debit": debit, "net": net,
                                      "mid_net": p["mid"] - c["mid"], "cost_vs_mid": (p["mid"] - c["mid"]) - net,
                                      "put_otm": 1 - p["strike"] / S, "call_otm": c["strike"] / S - 1,
                                      "delta_ratio": c["delta"] / abs(p["delta"]), "net_delta": c["delta"] - p["delta"]})
                for side_legs, key in ((puts, "put"), (calls, "call")):
                    pts = [(math.log(o["strike"] / S), o["my_iv"]) for o in side_legs if o["ok"] and o["my_iv"] and (o.get("oi") or 0) >= 50]
                    if len(pts) >= 6:
                        cf = np.polyfit([p_[0] for p_ in pts], [p_[1] for p_ in pts], 2)
                        for st in cands:
                            st[f"{key}_fit"] = float(np.polyval(cf, math.log(st[key]["strike"] / S)))
                out["expiries"][e] = {"T": T, "atm_iv": atm_iv, "skew": skew, "arb_violations": arb, "n_legs": len(legs),
                                      "n_ok": sum(o["ok"] for o in checked), "structures": cands}
            # pick the main structure: target put |Δ| ≈ 0.12–0.16, best call Δ ratio, prefer Feb (84 DTE) unless earnings pile in
            res.append(out)
        # historical odds for each name's main structures
        for o in res:
            t = o["ticker"]
            hist = {}
            for e, x in o["expiries"].items():
                h = max(5, round(x["T"] * 252))
                if h not in hist:
                    hist[h] = hist_windows(conn, t, h)
                hw = hist[h]
                for s in x["structures"]:
                    Kp, Kc, S = s["put"]["strike"], s["call"]["strike"], o["spot"]
                    sig_p = (s["put"]["my_iv"] or 0) * math.sqrt(x["T"])
                    s["p_put_rn"] = ncdf(math.log(Kp / S) / sig_p) if sig_p else None   # ≈ P(S_T < Kp), zero drift
                    sig_c = (s["call"]["my_iv"] or 0) * math.sqrt(x["T"])
                    s["p_call_rn"] = 1 - ncdf(math.log(Kc / S) / sig_c) if sig_c else None
                    if hw is not None:
                        for key in ("cond", "all"):
                            lr = hw[key]
                            if len(lr) == 0:
                                continue
                            ST = S * np.exp(lr)
                            pay = np.maximum(ST - Kc, 0) - np.maximum(Kp - ST, 0) + s["net"]
                            s[f"hist_{key}"] = {"p_put_itm": float((ST < Kp).mean()), "p_call_itm": float((ST > Kc).mean()),
                                                "ev": float(pay.mean()), "ev_pct_spot": float(pay.mean() / S),
                                                "p5_pct_spot": float(np.percentile(pay, 5) / S), "n": int(len(lr))}
                        s["hist_n_indep"] = hw["n_cond_indep"]
                        s["hist_n_all_indep"] = hw["n_all_indep"]
            own = rr_hist.get(t) or []
            o["rr25_hist_n"] = len(own)
            o["rr25_last"] = own[-1] if own else None
            o["rr25_pct_own"] = (sum(v <= own[-1] for v in own) / len(own)) if len(own) >= 10 else None
    (OUT / "s212_rr.json").write_text(json.dumps({"asof": str(date.today()), "rf": rf, "names": res}, default=str))
    print(f"built {len(res)} names → {OUT / 's212_rr.json'}")


SPREAD_OK = 0.35     # leg_checks hard limit on an after-close quote
SPREAD_LSE = 0.80    # wider quotes pass only when the LSE trade smile confirms the mid
SPREAD_FILL = 0.30   # in-session spread assumed for those legs' fills (rank gate for clean legs)
SHAPE_TOL = 0.05     # |(leg IV − ATM IV) Friday − (same moneyness IV − ATM IV) at the last trades| in vol pts
LEVEL_TOL = 0.12     # ATM IV may move this much between the trades and the Friday quote


def eff_spread(o):
    """Dollar spread used for the fill: the quote's own, or SPREAD_FILL of mid for an LSE-confirmed wide quote."""
    sp = (o.get("ask") or 0) - (o.get("bid") or 0)
    return min(sp, SPREAD_FILL * o["mid"]) if o.get("verified_by") == "lse" else sp


def lse_confirm(checked, legs_lse, e, S):
    """Second source on every leg: interpolate LSE traded IV at the leg's log-moneyness (spot at those trades), then
    compare smile SHAPE (leg − ATM) so a market-wide IV move between Wednesday's trades and Friday's quote does not
    count as a mismatch. A leg whose only fault is a wide after-close spread (≤ SPREAD_LSE) passes when shape agrees."""
    for side in ("put", "call"):
        pts = sorted((math.log(float(k.split("|")[2]) / v["und"]), float(v["iv"])) for k, v in legs_lse.items()
                     if k.startswith(f"{e}|{side}|") and v.get("und") and v.get("at", "") >= "2026-11-20" and 0.05 < v["iv"] < 3)
        if len(pts) < 5:
            continue
        xs, ys = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
        cf = np.polyfit(xs, ys, 2)     # smooth: single trades are noisy
        lse_atm = float(np.polyval(cf, 0.0))
        mine = [o for o in checked if o["side"] == side and o["ok"] and o["my_iv"] and abs(o["strike"] / S - 1) < 0.05]
        fri_atm = float(np.median([o["my_iv"] for o in mine])) if mine else None
        for o in checked:
            if o["side"] != side or not o["my_iv"]:
                continue
            x = math.log(o["strike"] / S)
            if not (xs.min() <= x <= xs.max()):
                continue
            o["lse_iv"] = float(np.polyval(cf, x))
            o["lse_n"] = len(pts)
            if fri_atm is None:
                continue
            o["lse_shape_diff"] = (o["my_iv"] - fri_atm) - (o["lse_iv"] - lse_atm)
            agree = abs(o["lse_shape_diff"]) <= SHAPE_TOL and abs(fri_atm - lse_atm) <= LEVEL_TOL
            soft = [f for f in o["flags"] if f.startswith("spread")]
            hard = [f for f in o["flags"] if f in ("no bid", "ask ≤ bid", "mid below intrinsic")]
            wide = (not o["ok"] and soft) or (o["ok"] and o["spread_pct"] > SPREAD_FILL)
            if wide and not hard and agree and o["spread_pct"] <= SPREAD_LSE:
                o["ok"] = True
                o["verified_by"] = "lse"
                o["flags"] = o["flags"] + [f"mid confirmed by {len(pts)} LSE trades (smile shape within {abs(o['lse_shape_diff']):.0%}); fill at {SPREAD_FILL:.0%} in-session spread — check live"]
            elif o["ok"] and not agree:
                o["flags"] = o["flags"] + [f"LSE trade smile disagrees by {o['lse_shape_diff']:+.0%}"]



def smile_ok(x, s, tol=0.04):
    """Leg IV within tol of a quadratic smile fitted (by log-moneyness) to the other clean legs of that side and expiry."""
    return all(abs(leg["my_iv"] - fit) <= tol for leg, fit in ((s["put"], s.get("put_fit")), (s["call"], s.get("call_fit"))) if fit)


def rank():
    """Main structure per name + final score (pre-registered 11-27, before the ranked list was seen):
    expiry = 2027-01-15 (before late-Jan earnings for most) · put |Δ| 0.10–0.16 · both legs OI ≥ 100 and spread ≤ 20 % of mid ·
    max call Δ per put Δ at net ≥ −0.3 % of spot. final = 0.5 · stage-1 + 0.5 · options, options = mean pct of
    [skew pts @0.15Δ, Δ ratio, −call IV ÷ RV60, hist EV % spot (own ≥ 20 %-off-high days), −fill cost % spot]; earnings before
    expiry −0.10. Excluded: Schwab spot ≠ stored close by > 2 %, or a price inversion between the two chosen strikes."""
    S1 = json.loads((OUT / "s212_stage1.json").read_text())
    by = {r["ticker"]: r for r in S1["rows"]}
    R = json.loads((OUT / "s212_rr.json").read_text())
    E = EXPIRIES[0]
    rows, excluded = [], []
    for o in R["names"]:
        t = o["ticker"]
        x = o["expiries"].get(E)
        if not x:
            excluded.append((t, "no Jan-15 chain"))
            continue
        good = [s for s in x["structures"] if 0.10 <= abs(s["put"]["delta"]) <= 0.16
                and min(s["put"]["oi"] or 0, s["call"]["oi"] or 0) >= 100
                and all(l["spread_pct"] <= SPREAD_FILL or l.get("verified_by") == "lse" for l in (s["put"], s["call"]))
                and smile_ok(x, s)]
        if not good:
            excluded.append((t, "no liquid 0.10–0.16Δ put with a liquid call"))
            continue
        s = max(good, key=lambda s: (round(s["delta_ratio"], 2), -abs(abs(s["put"]["delta"]) - 0.13)))
        if o["spot_vs_close"] is not None and o["spot_vs_close"] > 0.02:
            excluded.append((t, f"spot {o['spot']} vs stored close off {o['spot_vs_close']:.1%}"))
            continue
        info = by.get(t, {})
        skp, skc = x["skew"].get("0.15") or x["skew"].get(0.15) or (None, None)
        er = info.get("next_er")
        rows.append({"ticker": t, "etf": o["etf"], "spot": o["spot"], "spot_check": o["spot_vs_close"], "expiry": E, "T": x["T"], "atm_iv": x["atm_iv"],
                     "skew15": (skp - skc) if skp and skc else None, "skew": x["skew"], "s": s, "alts": sorted(
                         [a for a in x["structures"] if a is not s], key=lambda a: abs(a["put"]["delta"]))[:6],
                     "other_exp": {e: (sorted(y["structures"], key=lambda a: abs(abs(a["put"]["delta"]) - 0.13))[:1] or [None])[0]
                                   for e, y in o["expiries"].items() if e != E},
                     "call_iv_rv": (s["call"]["my_iv"] / info["rv60"]) if info.get("rv60") else None,
                     "put_iv_rv": (s["put"]["my_iv"] / info["rv60"]) if info.get("rv60") else None,
                     "er_in": bool(er and er <= E), "next_er": er, "rr25_pct_own": o["rr25_pct_own"], "arb": x["arb_violations"],
                     "fill_cost_pct": s["cost_vs_mid"] / o["spot"], "hist_ev": (s.get("hist_cond") or {}).get("ev_pct_spot"),
                     "s1": info.get("s1"), "info": info})
    names = [r for r in rows if not r["etf"]]
    comp = {"skew": pct_rank({r["ticker"]: r["skew15"] for r in names}),
            "ratio": pct_rank({r["ticker"]: r["s"]["delta_ratio"] for r in names}),
            "callcheap": pct_rank({r["ticker"]: r["call_iv_rv"] for r in names}, higher_better=False),
            "hist": pct_rank({r["ticker"]: r["hist_ev"] for r in names}),
            "cost": pct_rank({r["ticker"]: r["fill_cost_pct"] for r in names}, higher_better=False)}
    for r in names:
        r["opt_parts"] = {k: comp[k].get(r["ticker"], 0.5) for k in comp}
        r["opt"] = float(np.mean(list(r["opt_parts"].values())))
        r["final"] = 0.5 * (r["s1"] or 0) + 0.5 * r["opt"] - (0.10 if r["er_in"] else 0)
    names.sort(key=lambda r: -r["final"])
    for i, r in enumerate(names, 1):
        r["rank"] = i
    out = {"asof": R["asof"], "rf": R["rf"], "ranked": names, "etfs": [r for r in rows if r["etf"]], "excluded": excluded,
           "etf_state": S1["etf"]}
    (OUT / "s212_ranked.json").write_text(json.dumps(out, default=str))
    print(f"ranked {len(names)} · excluded {len(excluded)}")
    for t, why in excluded:
        print(f"  excl {t}: {why}")
    for r in names[:30]:
        s = r["s"]
        print(f"{r['rank']:>2} {r['ticker']:<5} final {r['final']:.2f} s1 {r['s1']:.2f} opt {r['opt']:.2f} | P {s['put']['strike']} ({s['put_otm']:.0%} OTM Δ{s['put']['delta']:.2f}) "
              f"C {s['call']['strike']} (+{s['call_otm']:.0%} Δ{s['call']['delta']:.2f}) net {s['net']:+.2f} ratio {s['delta_ratio']:.2f} skew {r['skew15'] or 0:.3f} "
              f"cIV/RV {r['call_iv_rv'] or 0:.2f} hist {r['hist_ev'] or 0:+.3f} er {r['next_er']}{' IN' if r['er_in'] else ''}")
    for r in out["etfs"]:
        s = r["s"]
        print(f"ETF {r['ticker']:<5} P {s['put']['strike']} ({s['put_otm']:.0%}) C {s['call']['strike']} (+{s['call_otm']:.0%}) ratio {s['delta_ratio']:.2f} skew {r['skew15'] or 0:.3f} net {s['net']:+.2f}")


def publish():
    """Today › Risk reversals › Deep OTM $0 (11-27 #10): today's ranked list → watchlist_sync.rr_s212_daily (one row per
    name, rank 0 = ETFs). The UI reads this table; the rules stay here (one home)."""
    R = json.loads((OUT / "s212_ranked.json").read_text())
    DD = json.loads((OUT / "s212_dd.json").read_text()) if (OUT / "s212_dd.json").exists() else {"names": {}, "smh": None}
    def row(r, rank):
        s, i, d = r["s"], r.get("info") or {}, DD["names"].get(r["ticker"]) or {}
        leg = lambda o: {k: o.get(k) for k in ("strike", "bid", "ask", "mid", "delta", "oi", "my_iv", "lse_iv", "spread_pct", "verified_by", "flags")}
        worst = min((x["pnl"] for x in d.get("stress", []) if x.get("pnl") is not None), default=None)
        return {"rank": rank, "ticker": r["ticker"], "spot": r["spot"], "expiry": r["expiry"], "put": leg(s["put"]), "call": leg(s["call"]),
                "mid_net": s["mid_net"], "fill_net": s["net"], "put_otm": s["put_otm"], "call_otm": s["call_otm"], "delta_ratio": s["delta_ratio"],
                "skew15": r.get("skew15"), "er_in": r.get("er_in"), "next_er": r.get("next_er"), "final": r.get("final"),
                "fund": i.get("fund_total"), "dd52": i.get("dd52"), "rsi14": i.get("rsi14"), "peer": i.get("peer_name"),
                "worst_crash_pnl": worst, "er_breach": d.get("er_breach"), "er_n": len(d.get("earnings") or [])}
    rows = [row(r, r["rank"]) for r in R["ranked"][:20]] + [row(r, 0) for r in R["etfs"]]
    with connect() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.rr_s212_daily (as_of date, ticker text, rank int, payload jsonb,
                        computed_at timestamptz DEFAULT now(), PRIMARY KEY (as_of, ticker))""")
        conn.execute("DELETE FROM watchlist_sync.rr_s212_daily WHERE as_of = %s", (R["asof"],))
        for x in rows:
            conn.execute("INSERT INTO watchlist_sync.rr_s212_daily (as_of, ticker, rank, payload) VALUES (%s, %s, %s, %s::jsonb)",
                         (R["asof"], x["ticker"], x["rank"], json.dumps(x, default=str)))
        conn.commit()
    print(f"published {len(rows)} rows for {R['asof']}")


def run_all():
    """Daily (publish stage, LSE thread, in session): stage1 → chains → LSE trades → build → rank → DD → table."""
    stage1(); chains(106); lse_trades(); build(); rank()
    import s212_dd
    s212_dd.main()
    publish()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stage1"
    if cmd == "stage1":
        stage1()
    elif cmd == "chains":
        chains(int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 70)
    elif cmd == "lse":
        lse_trades()
    elif cmd == "build":
        build()
    elif cmd == "rank":
        rank()
    elif cmd == "publish":
        publish()
    elif cmd == "all":
        run_all()
