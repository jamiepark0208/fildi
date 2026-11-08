"""Re-run A192 Part D (S166) and attach entry features + ex-post outcome for win/loss teardown.
Run from scripts/watchlist_sync with .venv/bin/python.  Output: scratchpad d_trades.parquet"""
import math
import sys
from datetime import date
from multiprocessing import Pool, cpu_count
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, "analysis")
sys.path.insert(0, ".")
import structure_vec_engine as E  # noqa: E402

OUT = Path(__file__).resolve().parent / "d_trades.parquet"
SPY = {}


def feats(args):
    t, rows, rep, tb, cfgs, end = args
    trades, _ = E.run_ticker_d(args)
    if not trades:
        return []
    idx = {r[0]: i for i, r in enumerate(rows)}
    C = np.array([r[1] for r in rows], dtype=float)
    lr = np.diff(np.log(C), prepend=np.nan)
    out = []
    for tr in trades:
        i = idx[tr["d"]]
        d, S, ivp, ivc = rows[i]
        dte = tr["cfg"]["dte"]
        j = E.expiry_index(rows, i, dte)
        bull = tr["sid"] == "bull_call_debit"
        iv = ivc if bull else ivp
        rv20 = float(np.nanstd(lr[i - 19:i + 1]) * math.sqrt(252))
        rv60 = float(np.nanstd(lr[i - 59:i + 1]) * math.sqrt(252))
        sma50 = C[i - 49:i + 1].mean()
        sma200 = C[i - 199:i + 1].mean()
        hi20, lo20 = C[i - 19:i + 1].max(), C[i - 19:i + 1].min()
        T = (rows[j][0] - d).days / 365.0 if j is not None else dte / 365
        ST = rows[j][1] if j is not None else np.nan
        legs = tr["legs"]
        Kl, Ks = legs[0][1], legs[1][1]
        width = abs(Ks - Kl)
        payoff = (min(max(ST - Kl, 0), width) if bull else min(max(Kl - ST, 0), width)) if j is not None else np.nan
        out.append({
            "t": t, "d": d, "sid": tr["sid"], "dte": dte, "entry": tr["cfg"]["entry"],
            "exit_k": tr.get("exit_k"), "days": tr["days"], "pnl": tr["pnl"], "debit": tr["debit"],
            "width": width, "xpd": tr["xpd"], "stock_xpd": tr["stock_xpd"], "exc": tr["exc"],
            "ret_on_debit": tr["pnl"] / tr["debit"],
            "debit_frac": tr["debit"] / width if width else np.nan,
            "ivr": E.iv_rank_at(rows, i), "iv": iv, "ivp": ivp, "ivc": ivc, "pc_spread": ivp - ivc,
            "iv_rv20": iv / rv20 if rv20 else np.nan, "iv_rv60": iv / rv60 if rv60 else np.nan,
            "trend_gap": sma50 / sma200 - 1, "pb": (hi20 - S) / hi20 if bull else (S - lo20) / lo20,
            "mom60": S / C[i - 60] - 1 if i >= 60 else np.nan,
            # ex-post (diagnostic only, never an entry rule)
            "move_sig": math.log(ST / S) / (iv * math.sqrt(T)) if j is not None and T > 0 else np.nan,
            "S": S, "ST": ST, "delta0": tr.get("delta0"), "T_days": T * 365, "Kl": Kl, "Ks": Ks,
            "hold_exp_ret": (payoff - tr["debit"]) / tr["debit"] if j is not None else np.nan,
        })
    return out


def main():
    conn = E.connect()
    tk = E.pick_tickers(conn, 5000)
    bars, rep, tb = E.load(conn, set(tk) | {"SPY"})
    spy = bars.get("SPY", [])
    sc = np.array([r[1] for r in spy])
    for k in range(200, len(spy)):
        SPY[spy[k][0]] = bool(sc[k] > sc[k - 199:k + 1].mean())
    work = [(t, bars[t], rep, tb, E.d_cfgs(), date(2025, 12, 31)) for t in tk if bars.get(t) and len(bars[t]) >= 250]
    rows = []
    with Pool(min(8, cpu_count() - 1), initializer=E._pool_init) as p:
        for ch in p.map(feats, work, chunksize=4):
            rows.extend(ch)
    df = pd.DataFrame(rows)
    df["spy_up"] = df.d.map(SPY)
    df.to_parquet(OUT)
    print("trades", len(df), "->", OUT)


if __name__ == "__main__":
    main()
