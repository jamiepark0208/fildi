"""A331 Backtest Lab — API runner (reuses pattern_lab + s151_phase4_excess; no per-request pickle).

    cd scripts/watchlist_sync && .venv/bin/python analysis/backtest_lab.py catalog
    .venv/bin/python analysis/backtest_lab.py build-store [--tickers A,B]
    .venv/bin/python analysis/backtest_lab.py run --json '{...}'
    .venv/bin/python analysis/backtest_lab.py inspect --ticker AAPL --date 2023-01-04
    .venv/bin/python analysis/backtest_lab.py self-test
"""
from __future__ import annotations

import argparse
import hashlib
import math
import importlib.util
import json
import pickle
import sys
import time
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import pattern_lab as PL  # noqa: E402
from build_plan import connect  # noqa: E402

_spec = importlib.util.spec_from_file_location("s151_p4", HERE / "s151_phase4_trades.py")
P4 = importlib.util.module_from_spec(_spec)
assert _spec.loader
_spec.loader.exec_module(P4)

_excess = importlib.util.spec_from_file_location("s151_ex", HERE / "s151_phase4_excess.py")
EX = importlib.util.module_from_spec(_excess)
assert _excess.loader
_excess.loader.exec_module(EX)

CACHE_ROOT = Path.home() / ".fildi" / "cache" / "backtest_lab"
FEATURE_DIR = CACHE_ROOT / "features"
TRADE_DIR = CACHE_ROOT / "trades"
BASELINE_PATH = CACHE_ROOT / "baseline_monthly.parquet"
META_PATH = CACHE_ROOT / "store_meta.json"

def _grid_keys() -> set[tuple[str, float, str, str]]:
    """Allowed (instrument, delta, entry, exit) — DTE comes from signal horizon in the cache."""
    keys: set[tuple[str, float, str, str]] = set()
    for _side, insts in P4.INSTRUMENTS.items():
        for inst, _opt, direction, deltas in insts:
            for delta in deltas:
                if direction == "short" and delta not in (0.08, 0.12, 0.20):
                    continue
                if direction == "long" and delta not in (0.30, 0.50):
                    continue
                for entry in P4.ENTRIES:
                    for exit_m in P4.EXITS:
                        keys.add((inst, delta, entry, exit_m))
    return keys


TRADE_GRID = _grid_keys()

FEAT_CATALOG = [
    {"id": "rsi14", "label": "RSI-14", "study": "S147"},
    {"id": "rsi2", "label": "RSI-2", "study": "S151"},
    {"id": "z5_close", "label": "5-day z vs close", "study": "S151"},
    {"id": "stoch14", "label": "Stochastic-14", "study": "S147"},
    {"id": "bb_pctb", "label": "Bollinger %b", "study": "S147"},
    {"id": "up_climax", "label": "Up-volume climax", "study": "S151"},
    {"id": "down_climax", "label": "Down-volume climax", "study": "S151"},
    {"id": "vol_z20", "label": "Volume z-20", "study": "S147"},
    {"id": "iv_rv", "label": "IV ÷ RV", "study": "S147"},
    {"id": "iv_rank252", "label": "IV rank 252d", "study": "S147"},
    {"id": "atr_pct", "label": "ATR % of price", "study": "S147"},
    {"id": "spy_rsi14", "label": "SPY RSI-14", "study": "S151"},
    {"id": "spy_dist_ma50", "label": "SPY distance MA50", "study": "S147"},
    {"id": "ret_15", "label": "15d return vs SPY", "study": "S147"},
    {"id": "ret_30", "label": "30d return vs SPY", "study": "S147"},
]

PRESETS = {
    "put_climax_spy_oversold": {
        "title": "S151 sell put — up climax + SPY RSI bottom Q",
        "study": "S151",
        "signal_id": "pair:month:low:spy_rsi14+up_climax",
        "horizon": "month",
        "instrument": "sell_put",
        "delta": 0.08,
        "entry": "next_open",
        "exit": "half_dte",
    },
    "put_climax_low_ivrv": {
        "title": "S151 sell put — up climax + IV÷RV bottom Q",
        "study": "S151",
        "signal_id": "pair:month:low:iv_rv+up_climax",
        "horizon": "month",
        "instrument": "sell_put",
        "delta": 0.08,
        "entry": "next_open",
        "exit": "stop50",
    },
}

AAPL_INSPECT_FIXTURE = {
    "ticker": "AAPL",
    "date": "2023-01-04",
    "horizon": "week",
    "low_t": 125.08,
    "close_t": 126.36,
    "atr": 4.397899498970527,
    "fwd_min_low": 124.76,
    "fwd_max_high": 133.51,
    "tol_floor": 123.98052512525737,
    "rally_bar": 130.75789949897052,
    "label": 1,
}


def _finite(x):
    """11-11: NaN/inf → None — a bare NaN (hold_mean_sig on an empty hold set) is invalid JSON and 500'd /backtest/run."""
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    if isinstance(x, dict):
        return {k: _finite(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_finite(v) for v in x]
    return x


def _json_out(obj: dict) -> None:
    print(json.dumps(_finite(obj), default=str, allow_nan=False))


def catalog() -> dict:
    return {
        "features": FEAT_CATALOG,
        "presets": PRESETS,
        "dataRanges": {
            "dailyHistory": {"names": 953, "from": "2016-09"},
            "bars5m": {"names": 245, "from": "2024-10"},
            "optionChainHistory": {"from": "2026-10-08", "names": 756},
        },
        "tradeGrid": {
            "sellDeltas": [0.08, 0.12, 0.20],
            "longDeltas": [0.30, 0.50],
            "entries": list(P4.ENTRIES),
            "exits": list(P4.EXITS),
        },
        "pnlUnits": {
            "sell_put": "per_$collateral",
            "sell_call": "per_$collateral",
            "long_call": "per_$debit",
            "long_put": "per_$debit",
        },
        "survivorshipNote": "static_universe",
    }


def _write_features(panel: pd.DataFrame) -> None:
    FEATURE_DIR.mkdir(parents=True, exist_ok=True)
    cols = ["ticker", "date"] + [c for c in panel.columns if c not in ("ticker", "date")]
    panel = panel[cols].copy()
    panel["date"] = pd.to_datetime(panel["date"])
    for yr, chunk in panel.groupby(panel["date"].dt.year):
        path = FEATURE_DIR / f"year={yr}.parquet"
        chunk.to_parquet(path, index=False)
    META_PATH.write_text(json.dumps({"featuresBuiltAt": datetime.utcnow().isoformat() + "Z", "rows": len(panel)}))


def _load_features(tickers: list[str] | None, start: date | None, end: date | None) -> pd.DataFrame:
    if not FEATURE_DIR.exists():
        return pd.DataFrame()
    paths = sorted(FEATURE_DIR.glob("year=*.parquet"))
    if not paths:
        return pd.DataFrame()
    parts = [pd.read_parquet(p) for p in paths]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    if tickers:
        tset = {t.upper() for t in tickers}
        df = df[df.ticker.isin(tset)]
    if start:
        df = df[df.date >= pd.Timestamp(start)]
    if end:
        df = df[df.date <= pd.Timestamp(end)]
    return df


def _trade_key(inst: str, delta: float, dte: int, entry: str, exit_m: str) -> str:
    return f"{inst}_{delta}_{dte}_{entry}_{exit_m}.parquet"


def _export_trades_from_pickle() -> bool:
    pkl = EX.CACHE_PKL
    if not pkl.exists():
        return False
    base_cache = pickle.loads(pkl.read_bytes())
    TRADE_DIR.mkdir(parents=True, exist_ok=True)
    for (inst, delta, dte, entry), exits in base_cache.items():
        for exit_m, rows in exits.items():
            if (inst, delta, entry, exit_m) not in TRADE_GRID:
                continue
            if not rows:
                continue
            df = pd.DataFrame(rows)
            df["d"] = pd.to_datetime(df["d"])
            df.to_parquet(TRADE_DIR / _trade_key(inst, delta, dte, entry, exit_m), index=False)
    _write_baseline_monthly(base_cache)
    return True


def _write_baseline_monthly(base_cache: dict) -> None:
    rows_out = []
    for (inst, delta, dte, entry), exits in base_cache.items():
        for exit_m, pool in exits.items():
            by: dict[tuple[int, int], list] = defaultdict(list)
            br_by: dict[tuple[int, int], list] = defaultdict(list)
            for x in pool:
                if x["d"] < P4.TRADE_START:
                    continue
                ym = (x["d"].year, x["d"].month)
                by[ym].append(x["pnl"])
                if x.get("breach") == x.get("breach"):
                    br_by[ym].append(float(x["breach"]))
            for ym, pnls in by.items():
                if len(pnls) < 5:
                    continue
                br = br_by.get(ym, [])
                rows_out.append(
                    {
                        "instrument": inst,
                        "delta": delta,
                        "dte": dte,
                        "entry": entry,
                        "exit": exit_m,
                        "year": ym[0],
                        "month": ym[1],
                        "n": len(pnls),
                        "mean_pnl": float(np.mean(pnls)),
                        "breach_rate": float(np.mean(br)) if len(br) >= 5 else np.nan,
                        "worst5": P4.worst5(pnls),
                    }
                )
    if rows_out:
        pd.DataFrame(rows_out).to_parquet(BASELINE_PATH, index=False)


def _load_trade_pool(inst: str, delta: float, dte: int, entry: str, exit_m: str) -> list[dict]:
    path = TRADE_DIR / _trade_key(inst, delta, dte, entry, exit_m)
    if not path.exists():
        matches = sorted(TRADE_DIR.glob(f"{inst}_{delta}_*_{entry}_{exit_m}.parquet"))
        path = matches[0] if matches else None
    if path is None or not path.exists():
        return []
    df = pd.read_parquet(path)
    out = []
    for _, r in df.iterrows():
        d = r["d"]
        if hasattr(d, "date"):
            d = d.date()
        row = r.to_dict()
        row["d"] = d
        out.append(row)
    return out


def build_store(tickers: list[str] | None) -> dict:
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    panel = PL.s151_panel(tickers, rebuild=False)
    _write_features(panel)
    exported = _export_trades_from_pickle()
    return {"ok": True, "featureRows": len(panel), "tradesFromPickle": exported}


def _preset_mask(panel: pd.DataFrame, preset: dict, edges: dict) -> pd.Series:
    sig = {
        "id": preset["signal_id"],
        "horizon": preset["horizon"],
        "side": "low" if "low" in preset["signal_id"] else "high",
        "kind": "pair",
        "feats": preset["signal_id"].split(":")[-1].split("+"),
        "tier": "useful",
    }
    return P4.signal_mask(panel, sig, edges, {})


def preset_fires(panel: pd.DataFrame, preset_id: str, asof: date) -> pd.DataFrame:
    """Names firing a catalog preset on asof (S151 pair rules — import, don't re-derive)."""
    if preset_id not in PRESETS:
        raise ValueError(preset_id)
    preset = PRESETS[preset_id]
    edges = P4.fit_edges(panel)
    mask = _preset_mask(panel, preset, edges)
    day = pd.Timestamp(asof)
    return panel[mask & (panel.date == day)].copy()


def _pricing_meta(conn) -> dict:
    try:
        r = conn.execute(
            "SELECT MIN(as_of)::text, COUNT(DISTINCT ticker)::int FROM option_chain_history"
        ).fetchone()
        chain_from, chain_n = r if r else (None, 0)
    except Exception:
        chain_from, chain_n = None, 0
    return {
        "mode": "model",
        "badge": "model-priced",
        "realQuoteCoveragePct": 0.0,
        "optionChainHistoryFrom": chain_from,
        "optionChainHistoryNames": chain_n,
        "note": "Historical runs use Black-Scholes at IV; real quotes only where optlab.bars matches (P1).",
    }


def run_job(params: dict) -> dict:
    preset_id = params.get("preset") or params.get("presetId")
    if preset_id not in PRESETS:
        raise ValueError(f"unknown preset {preset_id}")
    preset = PRESETS[preset_id]
    tickers = params.get("tickers")
    start = date.fromisoformat(params["start"]) if params.get("start") else P4.TRADE_START
    end = date.fromisoformat(params["end"]) if params.get("end") else EX.CHECK_END

    panel = _load_features(tickers, None, None)
    if panel.empty:
        panel = PL.s151_panel(tickers, rebuild=False)
    panel["date"] = pd.to_datetime(panel["date"])

    edges = P4.fit_edges(panel)
    mask = _preset_mask(panel, preset, edges)
    sub = panel[mask & (panel.date >= pd.Timestamp(start)) & (panel.date <= pd.Timestamp(end))]
    sig_set = {(r.ticker, r.date.date()) for r in sub.itertuples()}

    inst = preset["instrument"]
    delta = preset["delta"]
    entry = preset["entry"]
    exit_m = preset["exit"]
    side = "low" if inst == "sell_put" else "high"
    dte = P4.dte_for({"horizon": preset["horizon"], "side": side}, "short" if inst.startswith("sell") else "long")

    pool = _load_trade_pool(inst, delta, dte, entry, exit_m)
    if not pool:
        raise RuntimeError("trade store missing — run build-store after s151_p4_base_cache.pkl exists")

    conn = connect()
    sector_map = EX.load_sectors(conn)
    sig_tr = [x for x in pool if (x["ticker"], x["d"]) in sig_set and start <= x["d"] <= end]
    base_tr = [x for x in pool if start <= x["d"] <= end]
    m = EX.metrics_for(sig_tr, base_tr, sector_map, start, end, None)
    verdict = EX.grade_excess(m, inst, "useful")

    trades = [
        {
            "ticker": x["ticker"],
            "date": x["d"].isoformat(),
            "pnl": x["pnl"],
            "breach": x.get("breach"),
            "K": x.get("K"),
            "S": x.get("S"),
        }
        for x in sorted(sig_tr, key=lambda z: (z["d"], z["ticker"]))
    ]

    latest = panel.date.max()
    fire_rows = panel[mask & (panel.date == latest)]
    firing_today = sorted(fire_rows.ticker.unique().tolist())

    summary = {
        "preset": preset_id,
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "vsAnyDay": {
            "breachSig": m.get("breach_sig"),
            "breachBase": m.get("breach_base_u"),
            "meanSig": m.get("mean_sig"),
            "meanBase": m.get("mean_base_u"),
            "excessMean": m.get("excess_mean_u"),
            "n": m.get("n"),
            "nMonths": len({(x["d"].year, x["d"].month) for x in sig_tr}),
        },
        "verdict": verdict,
        "pnlUnit": catalog()["pnlUnits"].get(inst, "per_trade"),
        "survivorshipNote": "static_universe",
        "firingToday": firing_today,
        "pricing": _pricing_meta(conn),
        "answerLine": (
            f"vs any day: breach {100 * (m.get('breach_sig') or 0):.1f} % vs "
            f"{100 * (m.get('breach_base_u') or 0):.1f} % · "
            f"+{100 * (m.get('excess_mean_u') or 0):.2f} %/trade · n {m.get('n')} · {verdict}"
        ),
    }
    return {"summary": summary, "trades": trades, "metrics": m}


def inspect(ticker: str, day: str, preset_id: str = "put_climax_spy_oversold") -> dict:
    preset = PRESETS[preset_id]
    panel = _load_features([ticker], None, None)
    if panel.empty:
        panel = PL.s151_panel([ticker], rebuild=False)
    panel["date"] = pd.to_datetime(panel["date"])
    edges = P4.fit_edges(panel)
    mask = _preset_mask(panel, preset, edges)
    dt = pd.Timestamp(day)
    row = panel[(panel.ticker == ticker.upper()) & (panel.date == dt)]
    if row.empty:
        raise ValueError("no bar")
    r = row.iloc[0]
    feats = {}
    quint = {}
    for f in PL.FEATS_S151:
        if f not in row.columns:
            continue
        v = r[f]
        feats[f] = None if pd.isna(v) else float(v)
        e = edges.get(f)
        if e is not None and len(e) >= 4 and f not in PL.BINARY:
            b = int(np.clip(np.searchsorted(e, v, side="right") - 1, 0, len(e) - 2))
            quint[f] = b
        elif f in PL.BINARY:
            quint[f] = int(v) if v == v else None

    sig_feats = preset["signal_id"].split(":")[-1].split("+")
    conditions = {f: bool(quint.get(f) == 0 or (f in PL.BINARY and feats.get(f) == 1)) for f in sig_feats}
    fired = bool(mask.loc[row.index[0]])

    hz = "week"
    g = panel[panel.ticker == ticker.upper()].sort_values("date").reset_index(drop=True)
    gi = g.index[g["date"] == dt]
    label_box = {}
    if len(gi) and hz in PL.S151_HORIZONS:
        idx = int(gi[0])
        gr = g.iloc[idx]
        a = float(gr.atr) if "atr" in gr.index and gr.atr == gr.atr else np.nan
        h = PL.S151_HORIZONS[hz]
        sl = g.iloc[idx : idx + h + 1]
        if len(sl) > h and a == a:
            fwd_min = float(sl.iloc[1:]["l"].min())
            fwd_max = float(sl.iloc[1:]["h"].max())
            label_box = {
                "horizon": hz,
                "lowT": float(gr.l),
                "closeT": float(gr.c),
                "atr": a,
                "fwdMinLow": fwd_min,
                "fwdMaxHigh": fwd_max,
                "tolFloor": float(gr.c - PL.S151_CLOSE_TOL * a),
                "rallyBar": float(gr.c + PL.S151_K_ATR * a),
                "goodLowWeek": int(gr.get(f"good_low_{hz}", 0) or 0),
                "handCheckRef": AAPL_INSPECT_FIXTURE if ticker.upper() == "AAPL" and day == "2023-01-04" else None,
            }

    return {
        "ticker": ticker.upper(),
        "date": day,
        "asOf": "bar_close",
        "features": feats,
        "quintiles": quint,
        "conditions": conditions,
        "signalFired": fired,
        "labelOutcomeNext": label_box,
    }


def self_test() -> dict:
    if not _export_trades_from_pickle():
        build_store(None)
    else:
        panel = PL.s151_panel(None, rebuild=False)
        _write_features(panel)
    full = run_job({"preset": "put_climax_spy_oversold", "start": "2023-01-01", "end": "2024-12-31"})
    vs = full["summary"]["vsAnyDay"]
    insp = inspect("AAPL", "2023-01-04")
    ok_n = abs(vs["n"] - 113) <= 2
    ok_br = abs((vs["breachSig"] or 0) - 0.00885) < 0.002 and abs((vs["breachBase"] or 0) - 0.111) < 0.015
    ok_aapl = abs(insp.get("labelOutcomeNext", {}).get("fwdMinLow", 0) - AAPL_INSPECT_FIXTURE["fwd_min_low"]) < 0.05
    bench_tickers = P4.SMOKE5 + ["JPM", "XOM", "UNH", "WMT", "LLY", "AVGO", "ORCL", "AMD", "CRM", "COST",
                                 "HD", "MCD", "PEP", "KO", "DIS", "NFLX", "TMO", "ABT", "DHR", "VZ",
                                 "CMCSA", "INTC", "QCOM", "TXN", "HON", "UPS", "LOW", "SBUX", "GS", "MS",
                                 "BLK", "SCHW", "AXP", "CAT", "DE", "RTX", "LMT", "BA", "GE", "IBM",
                                 "NOW", "INTU", "ADBE", "PANW", "MU", "LRCX", "KLAC", "SNPS", "CDNS", "ADI"][:50]
    t0 = time.perf_counter()
    run_job({"preset": "put_climax_spy_oversold", "tickers": bench_tickers, "start": "2020-01-01", "end": "2024-12-31"})
    cold_s = time.perf_counter() - t0
    t1 = time.perf_counter()
    run_job({"preset": "put_climax_spy_oversold", "tickers": bench_tickers, "start": "2020-01-01", "end": "2024-12-31"})
    cached_s = time.perf_counter() - t1
    return {
        "ok": bool(ok_n and ok_br and ok_aapl),
        "vsAnyDay": vs,
        "inspectOk": ok_aapl,
        "perf50x5y": {"coldSec": round(cold_s, 2), "cachedSec": round(cached_s, 2)},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("catalog")
    p_build = sub.add_parser("build-store")
    p_build.add_argument("--tickers", type=str, default="")
    p_run = sub.add_parser("run")
    p_run.add_argument("--json", type=str, required=True)
    p_insp = sub.add_parser("inspect")
    p_insp.add_argument("--ticker", required=True)
    p_insp.add_argument("--date", required=True)
    p_insp.add_argument("--preset", default="put_climax_spy_oversold")
    sub.add_parser("self-test")
    args = ap.parse_args()

    if args.cmd == "catalog":
        _json_out(catalog())
    elif args.cmd == "build-store":
        tickers = [t.strip() for t in args.tickers.split(",") if t.strip()] or None
        _json_out(build_store(tickers))
    elif args.cmd == "run":
        _json_out(run_job(json.loads(args.json)))
    elif args.cmd == "inspect":
        _json_out(inspect(args.ticker, args.date, args.preset))
    elif args.cmd == "self-test":
        _json_out(self_test())


if __name__ == "__main__":
    main()
