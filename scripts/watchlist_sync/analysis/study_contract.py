"""A369 fix2b — shared study contract harness (CONTRACT 1-7)."""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
WATCH = HERE.parent
REPO = WATCH.parent.parent

sys.path.insert(0, str(HERE))

from cost_staging import FILL_SHARE, tradable_net  # noqa: E402
from study_leak import leak_from_trade_frames, timing_verdict  # noqa: E402

STOCK_CROSS_PER_SIDE = 0.0005  # 5 bp/side — stock legs cross the spread
DTB3 = WATCH / "out" / "opt" / "dtb3.csv"
S160_REF_JSON = REPO / "research" / "studies" / "out" / "S160" / "result_h5_g25.json"

__all__ = [
    "FILL_SHARE",
    "STOCK_CROSS_PER_SIDE",
    "tradable_net",
    "apply_put_collateral_friction",
    "option_leg_fill",
    "stock_cross_round_trip",
    "comparator",
    "power_gate",
    "leak_cell",
    "time_halves",
    "spy_regime_halves",
    "cell_contract_missing",
    "packet",
    "attach_leak_to_rows",
    "s160_h5_matches_reference",
    "load_dtb3_daily",
]


def stock_cross_round_trip() -> float:
    return 2.0 * STOCK_CROSS_PER_SIDE


def option_leg_fill(mid: float, spread: float, qty: int) -> float:
    """Sell (qty<0): bid + FILL_SHARE×(ask−bid); buy: ask − FILL_SHARE×spread width."""
    if not np.isfinite(mid) or not np.isfinite(spread) or spread <= 0:
        return mid
    half = spread / 2.0
    if qty < 0:
        return mid - half + FILL_SHARE * spread
    return mid + half - FILL_SHARE * spread


def apply_put_collateral_friction(
    gross_coll: float,
    *,
    round_trip_frac: float,
    collateral_prem_frac: float,
) -> tuple[float, float, float, float, float, float]:
    """Option short-put: mid/cross context + tradable net_fill (bid±23 % spread RT)."""
    prem = collateral_prem_frac
    rt = round_trip_frac
    friction_cross = rt * prem
    friction_mid = 0.5 * rt * prem
    fill_rt = (1.0 - 2.0 * FILL_SHARE) * rt * prem
    net_fill = gross_coll - fill_rt
    return (
        gross_coll - friction_mid,
        gross_coll - friction_cross,
        net_fill,
        friction_mid,
        friction_cross,
        fill_rt,
    )


def load_dtb3_daily() -> dict[date, float]:
    """FRED DTB3 annualized % → daily fraction."""
    out: dict[date, float] = {}
    if not DTB3.is_file():
        return out
    for line in DTB3.read_text().splitlines()[1:]:
        d, v = line.split(",", 1)
        v = v.strip()
        if v in ("", "."):
            continue
        out[date.fromisoformat(d)] = float(v) / 100.0 / 365.0
    return out


def _parse_dates(dates: pd.DatetimeIndex | list[date] | list[str]) -> pd.DatetimeIndex:
    if isinstance(dates, pd.DatetimeIndex):
        return dates
    return pd.to_datetime(dates)


def comparator(
    pnl: np.ndarray | list[float],
    buying_power: np.ndarray | list[float] | float,
    dates: pd.DatetimeIndex | list[date] | list[str],
) -> dict[str, float]:
    """Per-$ buying power, worst ISO week, max drawdown, T-bill return over the same window."""
    pnl_a = np.asarray(pnl, dtype=float)
    dts = _parse_dates(dates)
    if isinstance(buying_power, (int, float)):
        bp_a = np.full(pnl_a.shape, float(buying_power))
    else:
        bp_a = np.asarray(buying_power, dtype=float)
    m = np.isfinite(pnl_a) & np.isfinite(bp_a) & (bp_a > 0)
    if not m.any():
        return {
            "per_dollar_bp": float("nan"),
            "worst_week_bp": float("nan"),
            "max_dd": float("nan"),
            "tbill_period": float("nan"),
        }
    xpd = pnl_a[m] / bp_a[m]
    per_dollar_bp = float(np.nansum(pnl_a[m]) / np.nansum(bp_a[m]) * 1e4)
    dsub = dts[: len(pnl_a)][m] if len(dts) >= len(pnl_a) else dts[m[: len(dts)]]
    if len(dsub) != xpd.size:
        dsub = pd.to_datetime(np.arange(xpd.size), unit="D", origin="2010-01-01")
    weeks = dsub.isocalendar().week.astype(int)
    years = dsub.year
    wk_key = years.astype(str) + "-" + weeks.astype(str)
    wk_sums: dict[str, float] = {}
    for wk, val in zip(wk_key, xpd):
        wk_sums[wk] = wk_sums.get(wk, 0.0) + float(val)
    worst_week_bp = float(min(wk_sums.values()) * 1e4) if wk_sums else float("nan")
    cum = np.cumsum(xpd)
    peak = np.maximum.accumulate(cum)
    dd = cum - peak
    max_dd = float(dd.min()) if dd.size else float("nan")
    rf = load_dtb3_daily()
    if rf and len(dsub):
        d0, d1 = pd.Timestamp(dsub.min()).date(), pd.Timestamp(dsub.max()).date()
        tb = 0.0
        for d, r in rf.items():
            if d0 <= d <= d1:
                tb += r
        tbill_period = tb
    else:
        tbill_period = float("nan")
    return {
        "per_dollar_bp": per_dollar_bp,
        "worst_week_bp": worst_week_bp,
        "max_dd": max_dd,
        "tbill_period": tbill_period,
    }


def power_gate(n_deoverlapped: int, ci: tuple[float, float] | list[float]) -> str:
    lo, hi = float(ci[0]), float(ci[1])
    if n_deoverlapped < 30:
        return "UNDERPOWERED"
    if np.isfinite(lo) and np.isfinite(hi) and lo <= 0 <= hi:
        return "UNDERPOWERED"
    return "OK"


def leak_cell(
    cond: pd.DataFrame,
    base: pd.DataFrame,
    rng: np.random.Generator,
    *,
    n_placebo: int = 200,
) -> dict[str, Any]:
    leak = leak_from_trade_frames(cond, base, rng, n_placebo=n_placebo)
    if not leak.get("verdict"):
        leak["verdict"] = timing_verdict(float(leak.get("placebo_p", float("nan"))), bool(leak.get("leak_flag")))
    return leak


def attach_leak_to_rows(
    rows: list[dict[str, Any]],
    cdf: pd.DataFrame,
    bdf: pd.DataFrame,
    *,
    seed: int = 369,
) -> None:
    rng = np.random.default_rng(seed)
    for r in rows:
        if r.get("role") != "cond":
            continue
        thr, exit_name, win = r["rsi_lt"], r["exit"], r["window"]
        cond = cdf[(cdf["rsi_thr"] == thr) & (cdf["exit"] == exit_name)]
        base = bdf[bdf["exit"] == exit_name]
        if win == "opra":
            cond = cond[cond.get("in_opra_window", False)]
            base = base[base.get("in_opra_window", False)]
        leak = leak_cell(cond, base, rng)
        r.update(leak)


def time_halves(
    dates: pd.DatetimeIndex | list,
    values: np.ndarray | list[float],
) -> tuple[dict[str, float], dict[str, float]]:
    dts = _parse_dates(dates)
    v = np.asarray(values, dtype=float)
    n = min(len(dts), len(v))
    if n < 4:
        nan = {"mean_bp": float("nan"), "n": 0}
        return nan, nan
    mid = n // 2
    order = np.argsort(dts[:n].values)
    v_ord = v[:n][order]
    h1, h2 = v_ord[:mid], v_ord[mid:]
    def pack(xs):
        xs = xs[np.isfinite(xs)]
        return {"mean_bp": float(np.mean(xs) * 1e4) if xs.size else float("nan"), "n": int(xs.size)}
    return pack(h1), pack(h2)


def spy_regime_halves(
    dates: pd.DatetimeIndex | list,
    values: np.ndarray | list[float],
    spy_close: np.ndarray,
    *,
    sma_len: int = 200,
) -> tuple[dict[str, float], dict[str, float]]:
    dts = _parse_dates(dates)
    v = np.asarray(values, dtype=float)
    if len(spy_close) < sma_len + 1:
        nan = {"mean_bp": float("nan"), "n": 0}
        return nan, nan
    sma = pd.Series(spy_close).rolling(sma_len).mean().to_numpy()
    # align by index position on dates (caller must align spy to same index as values)
    n = min(len(dts), len(v), len(sma))
    up_mask = spy_close[:n] > sma[:n]
    v_sub, up = v[:n], up_mask[:n]
    def pack(mask):
        xs = v_sub[mask & np.isfinite(v_sub)]
        return {"mean_bp": float(np.mean(xs) * 1e4) if xs.size else float("nan"), "n": int(xs.size)}
    return pack(up), pack(~up)


def _mid_only_verdict(cell: dict[str, Any]) -> bool:
    v = str(cell.get("verdict", "")).upper()
    if "MID_ONLY" in v or "WORKS" in v and cell.get("mid_only"):
        return True
    gross = float(cell.get("gross", cell.get("mean_pnl_coll_gross", float("nan"))))
    net_mid = float(cell.get("net_mid", cell.get("mean_pnl_coll_frac", float("nan"))))
    net_fill = float(cell.get("net_fill", cell.get("mean_pnl_coll_fill", float("nan"))))
    if np.isfinite(gross) and gross > 0 and np.isfinite(net_mid) and net_mid > 0:
        if not (np.isfinite(net_fill) and net_fill > 0):
            if v in ("WORKS", "SURVIVES", "PASS"):
                return True
    return bool(cell.get("mid_only_not_tradable"))


def cell_contract_missing(cell: dict[str, Any]) -> set[int]:
    missing: set[int] = set()
    if "net_fill" not in cell and "mean_pnl_coll_fill" not in cell and "pnl_coll_frac_fill" not in cell:
        missing.add(1)
    for k in ("per_dollar_bp", "worst_week_bp", "max_dd", "tbill_period"):
        if k not in cell and k not in (cell.get("comparator") or {}):
            missing.add(2)
    if "power" not in cell and "n_deoverlapped" not in cell:
        missing.add(3)
    for k in ("shift_bp", "placebo_p", "shift_coverage"):
        if k not in cell:
            missing.add(4)
    if "half1_mean_bp" not in cell and "halves" not in cell:
        missing.add(5)
    if not cell.get("input_sources") and not cell.get("inputs_ok"):
        missing.add(6)
    if cell.get("job_mismatch"):
        missing.add(7)
    return missing


def packet(cells: list[dict[str, Any]], *, job: str = "", require_all: bool = True) -> int:
    """Print CONTRACT line 1; exit 2 if missing or mid-only verdict."""
    missing_all: set[int] = set()
    mid_only = False
    for c in cells:
        miss = cell_contract_missing(c)
        if require_all:
            missing_all |= miss
        if _mid_only_verdict(c):
            mid_only = True
    if job:
        print(f"JOB: {job}")
    if missing_all:
        print(f"CONTRACT 1-7: missing {','.join(str(x) for x in sorted(missing_all))}")
    elif mid_only:
        print("CONTRACT 1-7: missing mid-only verdict")
    else:
        print("CONTRACT 1-7: ok")
    if missing_all or mid_only:
        return 2
    return 0


def s160_h5_matches_reference(res: dict, ref_path: Path | None = None) -> tuple[bool, str]:
    ref_path = ref_path or S160_REF_JSON
    if not ref_path.is_file():
        return False, f"missing ref {ref_path}"
    ref = json.loads(ref_path.read_text())
    ptest = res.get("pooled_test") or {}
    ptest_ref = ref.get("pooled_test") or {}
    pt = ptest.get(25) or ptest.get("25") or {}
    ref_pt = ptest_ref.get(25) or ptest_ref.get("25") or {}
    g_pp, g_n = pt.get("mean_pp"), pt.get("n")
    rg, rn = ref_pt.get("mean_pp"), ref_pt.get("n")
    ok_g = (
        g_pp is not None and rg is not None
        and abs(float(g_pp) - float(rg)) <= 0.05
        and int(g_n) == int(rn)
    )
    sg = float((res.get("S_minus_G_pp") or [float("nan")])[0])
    rsg = float((ref.get("S_minus_G_pp") or [float("nan")])[0])
    ok_s = abs(sg - rsg) <= 0.05
    return ok_g and ok_s, f"G25={g_pp}pp n={g_n} (ref {rg}/{rn}) S-G={sg:.3f} (ref {rsg:.3f})"


def _toy_mid_only_cell() -> dict[str, Any]:
    return {
        "gross": 0.01,
        "net_mid": 0.008,
        "net_fill": -0.001,
        "verdict": "WORKS",
        "per_dollar_bp": 1.0,
        "worst_week_bp": -2.0,
        "max_dd": -0.05,
        "tbill_period": 0.001,
        "n_deoverlapped": 50,
        "power": "OK",
        "shift_bp": 5.0,
        "placebo_p": 0.05,
        "shift_coverage": 0.9,
        "half1_mean_bp": 1.0,
        "half2_mean_bp": 1.0,
        "inputs_ok": True,
    }


def _toy_complete_cell() -> dict[str, Any]:
    return {
        "gross": 0.01,
        "net_mid": 0.008,
        "net_fill": 0.006,
        "verdict": "UNDERPOWERED",
        "per_dollar_bp": 1.0,
        "worst_week_bp": -2.0,
        "max_dd": -0.05,
        "tbill_period": 0.001,
        "n_deoverlapped": 50,
        "power": "OK",
        "shift_bp": 5.0,
        "placebo_p": 0.05,
        "shift_coverage": 0.9,
        "half1_mean_bp": 1.0,
        "half2_mean_bp": 1.0,
        "inputs_ok": True,
        "job_name": "toy",
    }


def smoke_packet() -> int:
    rc_bad = packet([_toy_mid_only_cell()], job="toy-mid-only")
    if rc_bad != 2:
        print(f"SANITY packet mid-only expected exit 2 got {rc_bad}")
        return 1
    rc_ok = packet([_toy_complete_cell()], job="toy-complete")
    if rc_ok != 0:
        print(f"SANITY packet complete expected exit 0 got {rc_ok}")
        return 1
    print("SANITY packet smoke ok")
    return 0


if __name__ == "__main__":
    mode = (sys.argv[1] if len(sys.argv) > 1 else "smoke").lower()
    if mode == "smoke":
        raise SystemExit(smoke_packet())
    if mode == "packet-mid":
        raise SystemExit(packet([_toy_mid_only_cell()]))
    if mode == "packet-ok":
        raise SystemExit(packet([_toy_complete_cell()]))
    print("usage: study_contract.py [smoke|packet-mid|packet-ok]")
    raise SystemExit(1)
