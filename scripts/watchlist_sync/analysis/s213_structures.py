#!/usr/bin/env python3
"""S213 — which STRUCTURE is the best use of $10k cash on the tech/semis-drawdown thesis (Jamie 11-27). DB only.

Line 1 caveats: universe = today's names (survivorship, S010 haircut NOT applied — absolute dip-buy returns are
overstated; the structure RANKING is a paired comparison on the same trades, so it is less affected). Option legs are
MODEL-PRICED (priced_by = rv60 × m with a skew slope and spread table, all calibrated on today's real Schwab chains,
`calib`); LSEG daily_history IV columns are empty, real option quotes start 10/2025. Entries at the daily close of the
first session of each month (rule 13 deviation: 6–24-month holds, the entry minute is noise next to the horizon).

Pre-registered (before the first run):
  thesis cell = name ≥ 25 % below its 252-session high at entry; control = every liquid name.
  regime     = SPY close vs SPY 200-session SMA at entry (bull / bear).
  sizing     = same starting exposure: $10k of stock-equivalent delta, idle cash in 3-month T-bills; collateral for short
               puts must come out of the $10k (cash account) — the RR's collateral above $10k is printed, not hidden.
  expected   = bear × thesis: shares / LEAPS / call spreads ≥ wheel, RR best mean but worst p5 (undefined loss);
               bull × thesis: wheel / buy-write ≥ shares on p5 and drawdown, ≤ shares on median.
  n rule     = n_indep = distinct entry months; < 30 in a cell → printed as "can't answer at this n" (scenario only).

    .venv/bin/python analysis/s213_structures.py calib     # today's chains → out/s213/calib.json
    .venv/bin/python analysis/s213_structures.py replay    # → out/s213/replay.json
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from quantcore.bs import bs_call, bs_put, call_delta, put_delta, strike_for_delta, years_from_sessions  # noqa: E402
from quantcore.ta import sma  # noqa: E402

OUT = HERE.parent / "out" / "s213"
CHAINS = HERE.parent / "out" / "rr" / "chains"
CASH = 10_000.0
HORIZONS = (35, 126, 252, 504)      # sessions ≈ 7 weeks (S212 card expiry) / 6 / 12 / 24 months
DD_THESIS = -0.25                   # global: Jamie's thesis cell ("in a drawdown"), pre-registered
MIN_PX, MIN_DV = 10.0, 25e6         # global: option-liquid proxy (price ≥ $10, 20d avg $ volume ≥ $25M)
ETFS = ("SPY", "QQQ", "SMH", "SOXX")
STRUCTS = ("shares", "dca8", "leaps_dm", "leaps_all", "call_spread", "risk_rev", "rr_deep", "ps_funded_call", "csp_wheel", "buy_write")


# ───────────────────────── calibration on today's real chains ─────────────────────────
def load_px(conn, tickers=None):
    sql = "SELECT ticker, date, close::float8, volume::float8 FROM {t} WHERE close > 0" + (" AND ticker = ANY(%s)" if tickers else "")
    m = defaultdict(dict)
    for src in ("lseg_research.daily_history", "prices_historical"):          # newest source wins
        for t, d, c, v in conn.execute(sql.format(t=src), (list(tickers),) if tickers else ()):
            m[t][d] = (c, v or 0.0)
    out = {}
    for t, dm in m.items():
        ds = sorted(dm)
        out[t] = (np.array(ds), np.array([dm[d][0] for d in ds]), np.array([dm[d][1] for d in ds]))
    return out


def rv(c, n=60):
    lr = np.diff(np.log(c))
    out = np.full(len(c), np.nan)
    if len(lr) >= n:
        w = np.lib.stride_tricks.sliding_window_view(lr, n)
        out[n:] = w.std(axis=1, ddof=1) * np.sqrt(252)
    return out


def calib():
    """m = ATM IV / rv60; skew slope b (iv/iv_atm − 1 = b·ln(S/K)) per side; spread/mid by |Δ| and tenor bucket."""
    files = sorted(CHAINS.glob("*.json")) + sorted((OUT / "leaps").glob("*.json"))
    with connect() as conn:
        px = load_px(conn, {f.stem for f in files})
    ratios, slopes, spreads = [], {"put": [], "call": []}, defaultdict(list)
    for f in files:
        d = json.loads(f.read_text())
        t, S = f.stem, d.get("spot")
        if not S or t not in px:
            continue
        r60 = rv(px[t][1])[-1]
        byexp = defaultdict(list)
        for o in d["rows"]:
            if o.get("iv") and o.get("bid") and o.get("ask") and o["ask"] > o["bid"] > 0 and o.get("delta") is not None:
                byexp[o["expiry"]].append(o)
        for e, rows in byexp.items():
            dte = (date.fromisoformat(e) - date.today()).days
            if dte < 20:
                continue
            ivf = lambda o: o["iv"] / 100 if o["iv"] > 5 else o["iv"]  # noqa: E731
            atm = sorted(rows, key=lambda o: abs(o["strike"] - S))[:4]
            iv_atm = float(np.median([ivf(o) for o in atm]))
            if dte <= 90 and np.isfinite(r60) and r60 > 0:
                ratios.append(iv_atm / r60)
            for o in rows:
                mny = np.log(S / o["strike"])
                ad = abs(o["delta"])
                tenor = "leaps" if dte >= 300 else "short"
                bucket = "deep" if ad >= 0.6 else "atm" if ad >= 0.35 else "otm" if ad >= 0.15 else "wing"
                mid = (o["bid"] + o["ask"]) / 2
                if mid >= 0.05 and (o.get("oi") or 0) >= 50:
                    spreads[f"{tenor}:{bucket}"].append((o["ask"] - o["bid"]) / mid)
                if 0.03 < abs(mny) < 0.35 and ((o["side"] == "put" and mny > 0) or (o["side"] == "call" and mny < 0)):
                    slopes[o["side"]].append((ivf(o) / iv_atm - 1) / mny)
    c = {"m": float(np.median(ratios)), "n_ratio": len(ratios),
         "b_put": float(np.median(slopes["put"])), "b_call": float(np.median(slopes["call"])),
         "spread": {k: float(np.median(v)) for k, v in sorted(spreads.items())}, "n_spread": {k: len(v) for k, v in sorted(spreads.items())},
         "files": len(files), "asof": date.today().isoformat()}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "calib.json").write_text(json.dumps(c, indent=1))
    print(json.dumps(c, indent=1))


# ───────────────────────── pricing with the calibrated surface ─────────────────────────
class Surface:
    def __init__(self, c):
        self.m, self.bp, self.bc, self.sp = c["m"], c["b_put"], c["b_call"], c["spread"]
        self.mt = c.get("m_by_ticker", {})

    def iv(self, S, K, iv_atm, side):
        mny = np.log(S / K)
        b = np.where(mny > 0, self.bp, self.bc) if side == "put" else np.where(mny < 0, self.bc, self.bp)
        return np.clip(iv_atm * (1 + b * mny), 0.08, 3.0)

    def strike(self, S, delta, iv_atm, T, side, r):
        K = strike_for_delta(spot=S, delta=delta, iv=iv_atm, years=T, side=side, r=r)
        for _ in range(2):
            K = strike_for_delta(spot=S, delta=delta, iv=self.iv(S, K, iv_atm, side), years=T, side=side, r=r)
        return K

    def mid(self, S, K, iv_atm, T, side, r):
        f = bs_call if side == "call" else bs_put
        return f(spot=S, strike=K, iv=self.iv(S, K, iv_atm, side), years=T, r=r)

    def delta(self, S, K, iv_atm, T, side, r):
        f = call_delta if side == "call" else put_delta
        return f(spot=S, strike=K, iv=self.iv(S, K, iv_atm, side), years=T, r=r)

    def spread(self, S, K, iv_atm, T, side, r):
        ad = np.abs(self.delta(S, K, iv_atm, T, side, r))
        ten = np.where(T >= 300 / 365, "leaps", "short")
        bk = np.where(ad >= 0.6, "deep", np.where(ad >= 0.35, "atm", np.where(ad >= 0.15, "otm", "wing")))
        return np.array([self.sp.get(f"{a}:{b}", self.sp.get(f"short:{b}", 0.1)) for a, b in zip(np.broadcast_to(ten, ad.shape).ravel(), bk.ravel())]).reshape(ad.shape)

    def fill(self, S, K, iv_atm, T, side, r, buy: bool):
        """Contract rule 1: buy at ask − 23 % of spread = mid + 0.27·spread; sell at bid + 23 % = mid − 0.27·spread."""
        m = self.mid(S, K, iv_atm, T, side, r)
        dead = np.asarray(T) <= 0
        cost = np.where(dead, 0.0, 0.27 * self.spread(S, K, iv_atm, np.maximum(T, 1e-6), side, r) * m)
        return np.where(buy, m + cost, np.maximum(m - cost, 0.0))


# ───────────────────────── replay ─────────────────────────
def tbill(conn):
    rows = conn.execute("SELECT date, value::float8 FROM watchlist_sync.macro_daily WHERE series = 'tbill3m' ORDER BY date").fetchall()
    ds = np.array([d for d, _ in rows])
    v = np.array([x for _, x in rows])
    v = v / 100                                   # FRED DTB3 is always percent (median 0.3 in the ZIRP years)
    return lambda d: float(v[max(0, np.searchsorted(ds, d, side="right") - 1)]) if len(ds) else 0.04


def structure_paths(sf, S, iv, H, r):
    """S, iv: arrays (n_trades, H+1) of daily close and ATM IV over the hold; r: (n,) T-bill at entry.
    Returns {struct: (value path at monthly marks incl. day H, extra)} for $10k."""
    n = S.shape[0]
    S0, iv0 = S[:, 0], iv[:, 0]
    marks = list(range(0, H, 21)) + [H]
    grow = lambda k: np.exp(r * k / 252)  # noqa: E731  cash at T-bill
    out = {}

    # shares (5 bp each way)
    sh = CASH * (1 - 5e-4) / S0
    out["shares"] = (np.stack([sh * S[:, k] * (1 - 5e-4 * (k == H)) for k in marks], 1), {})
    # DCA: 8 weekly buys of $1,250; unbought cash at T-bill
    held, cash = np.zeros(n), np.full(n, CASH)
    vals = []
    for k in range(H + 1):
        if k % 5 == 0 and k <= 35:
            buy = CASH / 8
            held += buy * (1 - 5e-4) / S[:, k]
            cash -= buy
        cash *= np.exp(r / 252) if k else 1
        if k in marks:
            vals.append(held * S[:, k] * (1 - 5e-4 * (k == H)) + cash)
    out["dca8"] = (np.stack(vals, 1), {})

    def terminal(legs, sizing):
        """legs = [(side, strike, T0_sessions, qty_sign)]; qty_sign +1 long, −1 short; sizing 'dm' (delta-matched) or 'all'."""
        T0 = {i: years_from_sessions(L[2]) for i, L in enumerate(legs)}
        px0 = [sf.fill(S0, L[1], iv0, T0[i], L[0], r, buy=L[3] > 0) for i, L in enumerate(legs)]
        debit = sum(L[3] * p for L, p in zip(legs, px0))
        if sizing == "dm":
            dl = sum(L[3] * sf.delta(S0, L[1], iv0, T0[i], L[0], r) for i, L in enumerate(legs))
            q = CASH / (np.maximum(dl, 0.05) * S0)
            q = np.where(debit > 0, np.minimum(q, CASH / np.maximum(debit, 1e-6)), q)   # cash account: debit ≤ $10k
        else:
            q = CASH / np.maximum(debit, 1e-6)
        cash0 = CASH - q * debit
        vals = []
        for k in marks:
            v = cash0 * grow(k)
            for i, L in enumerate(legs):
                T = np.maximum(T0[i] - k / 252, 0.0)
                p = sf.fill(S[:, k], L[1], iv[:, k], T, L[0], r, buy=L[3] < 0) if k == H else sf.mid(S[:, k], L[1], iv[:, k], np.maximum(T, 0), L[0], r)
                v = v + q * L[3] * p
            vals.append(v)
        return np.stack(vals, 1), q

    T_le = H + 63
    K80 = sf.strike(S0, 0.80, iv0, years_from_sessions(T_le), "call", r)
    v, q = terminal([("call", K80, T_le, 1)], "dm")
    out["leaps_dm"] = (v, {"capital_in_options": q * sf.fill(S0, K80, iv0, years_from_sessions(T_le), "call", r, True) / CASH})
    v, q = terminal([("call", K80, T_le, 1)], "all")
    out["leaps_all"] = (v, {"start_delta_x": q * 0.8 * S0 / CASH})
    TH = years_from_sessions(H)
    v, q = terminal([("call", S0, H, 1), ("call", S0 * 1.30, H, -1)], "dm")
    out["call_spread"] = (v, {})
    Kp25 = sf.strike(S0, -0.25, iv0, TH, "put", r)
    Kc50 = sf.strike(S0, 0.50, iv0, TH, "call", r)
    Kp10 = sf.strike(S0, -0.10, iv0, TH, "put", r)
    v, q = terminal([("put", Kp25, H, -1), ("call", Kc50, H, 1)], "dm")
    out["risk_rev"] = (v, {"collateral_x": q * Kp25 / CASH, "assigned": S[:, H] < Kp25})
    # S212 card shape: sell a deep 0.12Δ put, buy a ~0.18Δ call, same expiry (~$0 net), held to expiry
    Kp12 = sf.strike(S0, -0.12, iv0, TH, "put", r)
    Kc18 = sf.strike(S0, 0.18, iv0, TH, "call", r)
    v, q = terminal([("put", Kp12, H, -1), ("call", Kc18, H, 1)], "dm")
    out["rr_deep"] = (v, {"collateral_x": q * Kp12 / CASH, "assigned": S[:, H] < Kp12})
    v, q = terminal([("put", Kp25, H, -1), ("put", Kp10, H, 1), ("call", Kc50, H, 1)], "dm")
    out["ps_funded_call"] = (v, {"collateral_x": q * (Kp25 - Kp10) / CASH, "assigned": S[:, H] < Kp25})

    # wheel: 21-session 0.30Δ puts on cash (cash-secured) / calls on shares; buy_write starts in shares. Cycle by cycle,
    # settled at expiry (assigned put → shares at K; called-away call → cash at K), marked at each cycle end.
    for name, start_sh in (("csp_wheel", False), ("buy_write", True)):
        sh = np.full(n, CASH * (1 - 5e-4)) / S0 if start_sh else np.zeros(n)
        cash = np.zeros(n) if start_sh else np.full(n, CASH)
        vals, n_assign = [cash + sh * S0], np.zeros(n)
        for k in range(0, H, 21):
            e = min(k + 21, H)
            T = years_from_sessions(e - k)
            Sk, ivk, Se = S[:, k], iv[:, k], S[:, e]
            in_sh = sh > 0
            Kp = sf.strike(Sk, -0.30, ivk, T, "put", r)
            Kc = sf.strike(Sk, 0.30, ivk, T, "call", r)
            qp = np.where(in_sh, 0.0, cash / Kp)
            cash = cash + np.where(in_sh, sh * sf.fill(Sk, Kc, ivk, T, "call", r, False), qp * sf.fill(Sk, Kp, ivk, T, "put", r, False))
            cash = cash * np.exp(r * (e - k) / 252)          # premium + collateral at T-bill over the cycle
            put_hit = (~in_sh) & (Se < Kp)
            call_hit = in_sh & (Se > Kc)
            n_assign += put_hit
            cash = cash - np.where(put_hit, qp * Kp, 0.0) + np.where(call_hit, sh * Kc, 0.0)
            sh = np.where(put_hit, qp, np.where(call_hit, 0.0, sh))
            vals.append(cash + sh * Se * (1 - 5e-4 * (e == H)))
        out[name] = (np.stack(vals, 1), {"assign_cycles": n_assign})
    return out


# ───────────────────────── LEAPS quotes (Schwab via local API) ─────────────────────────
def fetch_leaps(names, frm="2027-11-01", to="2028-01-31", max_age_h=6):
    import time
    import urllib.request
    from datetime import datetime
    d0 = OUT / "leaps"
    d0.mkdir(parents=True, exist_ok=True)
    got = 0
    for t in names:
        f = d0 / f"{t}.json"
        if f.exists() and time.time() - f.stat().st_mtime < max_age_h * 3600:
            got += 1
            continue
        req = urllib.request.Request("http://127.0.0.1:8080/api/schwab/chain-ladder",
                                     data=json.dumps({"ticker": t, "fromDate": frm, "toDate": to, "strikeCount": 80}).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            d = json.load(urllib.request.urlopen(req, timeout=60))     # deadline per vendor call (rule 8c)
            if d.get("rows"):
                d["fetched_at"] = datetime.now().isoformat(timespec="seconds")
                f.write_text(json.dumps(d))
                got += 1
        except Exception as e:  # noqa: BLE001
            print(f"  {t}: {e}")
        time.sleep(0.5)
    print(f"leaps: {got}/{len(names)}")


# ───────────────────────── replay driver ─────────────────────────
def q(a, p):
    return float(np.nanpercentile(a, p)) if len(a) else None


def mdd(v):
    peak = np.maximum.accumulate(v, axis=1)
    return (v / peak - 1).min(axis=1)


def month_ci(ret, months):
    """Mean over entry-month baskets (equal weight inside a month) + 95 % CI with months as the independent unit."""
    by = defaultdict(list)
    for x, m in zip(ret, months):
        by[m].append(x)
    b = np.array([np.mean(v) for v in by.values()])
    if len(b) < 2:
        return None, None, len(b)
    se = b.std(ddof=1) / np.sqrt(len(b))
    return float(b.mean()), (float(b.mean() - 1.96 * se), float(b.mean() + 1.96 * se)), len(b)


def replay(shift=0, episodes=None):
    """episodes: {label: "YYYY-MM"} → cells keyed by episode label instead of regime (crash + rebound replays)."""
    sf = Surface(json.loads((OUT / "calib.json").read_text()))
    with connect() as conn:
        px = load_px(conn)
        tb = tbill(conn)
    spy_d, spy_c, _ = px["SPY"]
    spy_sma = sma(spy_c, 200)
    bull = {d: bool(c > s) for d, c, s in zip(spy_d, spy_c, spy_sma) if np.isfinite(s)}
    rows = defaultdict(list)          # (cell, H) → list of trade dicts
    for t, (ds, c, v) in px.items():
        if len(c) < 320:
            continue
        r60 = rv(c)
        hi = np.maximum.accumulate(np.r_[c[:1], c])[1:]  # placeholder, replaced by rolling 252 max below
        hi = np.array([c[max(0, i - 251):i + 1].max() for i in range(len(c))])
        dv = np.convolve(c * v, np.ones(20) / 20, mode="full")[:len(c)]
        first = np.r_[True, np.array([a.month != b.month for a, b in zip(ds[1:], ds[:-1])])]
        for i in np.where(first)[0]:
            i0 = i + shift
            if i0 < 252 or i0 >= len(c) or not np.isfinite(r60[i0]) or ds[i0] not in bull:
                continue
            if t not in ETFS and (c[i0] < MIN_PX or dv[i0] < MIN_DV):
                continue
            dd = c[i0] / hi[i0] - 1
            regime = "bull" if bull[ds[i0]] else "bear"
            if episodes is not None:
                lab = next((k for k, m in episodes.items() if ds[i0].strftime("%Y-%m") == m), None)
                if lab is None:
                    continue
                regime = lab
            for H in HORIZONS:
                if i0 + H >= len(c):
                    continue
                cells = ["etf:" + t] if t in ETFS else ["all"] + (["thesis"] if dd <= DD_THESIS else [])
                for cell in cells:
                    rows[(cell, regime, H)].append((t, ds[i0], i0))
    res = {}
    for (cell, regime, H), trades in sorted(rows.items()):
        S = np.stack([px[t][1][i:i + H + 1] for t, _, i in trades])
        RV = np.stack([rv(px[t][1])[i:i + H + 1] for t, _, i in trades])
        RV = np.where(np.isfinite(RV), RV, np.nanmedian(RV))
        mt = np.array([sf.mt.get(t, sf.m) for t, _, _ in trades])[:, None]
        iv = np.clip(RV * mt, 0.10, 2.5)
        r = np.array([tb(d) for _, d, _ in trades])
        months = [d.strftime("%Y-%m") for _, d, _ in trades]
        paths = structure_paths(sf, S, iv, H, r)
        tbill_ret = np.exp(r * H / 252) - 1
        sh_ret = paths["shares"][0][:, -1] / CASH - 1
        cellres = {"n": len(trades), "n_indep": len(set(months)), "tbill": float(np.mean(tbill_ret)), "structs": {}}
        for k, (vals, extra) in paths.items():
            ret = vals[:, -1] / CASH - 1
            m, ci, nm = month_ci(ret, months)
            dm, dci, _ = month_ci(ret - sh_ret, months)
            e = {"median": q(ret, 50), "mean": float(np.mean(ret)), "p5": q(ret, 5), "p95": q(ret, 95), "p_loss": float(np.mean(ret < 0)),
                 "p_lose_half": float(np.mean(ret < -0.5)), "mdd_med": q(mdd(vals), 50), "mdd_p5": q(mdd(vals), 5),
                 "basket_mean": m, "basket_ci": ci, "vs_shares": dm, "vs_shares_ci": dci}
            for kk, x in extra.items():
                x = np.asarray(x, dtype=float)
                e[kk] = float(np.mean(x)) if kk in ("assigned",) else q(x, 50)
            cellres["structs"][k] = e
        res[f"{cell}|{regime}|{H}"] = cellres
        print(f"{cell:10s} {regime:4s} H{H:3d} n {len(trades):5d} months {cellres['n_indep']:3d}  " +
              "  ".join(f"{k[:8]} {cellres['structs'][k]['median']*100:+5.0f}/{cellres['structs'][k]['p5']*100:+5.0f}" for k in STRUCTS))
    tag = ("" if not shift else f"_shift{shift}") + ("_episodes" if episodes else "")
    (OUT / f"replay{tag}.json").write_text(json.dumps({"asof": date.today().isoformat(), "shift": shift, "cells": res}, indent=1, default=str))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "replay"
    if cmd == "calib":
        calib()
    elif cmd == "leaps":
        fetch_leaps(sys.argv[2].split(","))
    elif cmd == "episodes":
        # first month-start with SMH ≥ 20 % below its 252-session high in each sell-off (causal: known at the entry close)
        replay(0, {"2020 Covid crash": "2020-04", "2022 bear, first -20%": "2022-05", "2022 bear, near low": "2022-10", "2025 tariff crash": "2025-03"})
    elif cmd == "replay":
        replay(int(sys.argv[2]) if len(sys.argv) > 2 else 0)
