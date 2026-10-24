"""S091b — put skew and call−put IV on real strike ladders (A262). Do not change the bar.

Question: on Schwab full ladders (optlab.skew_survey), do 25Δ put IV minus ATM call IV
and the matched-strike call−put IV spread rank weekly put pnl and 21-day residual
stock returns beyond what Fildi already scores?

S091 could not test these. LSEG iv30_put equals iv30_call on every surface row, the
option cache has no matched call-put strikes, and the Xing-Zhang-Zhao smirk had 72
name-days. This study uses the stored ladders only. It does not call Schwab.

Definitions frozen before the full-sample stats (S091 bands, delta instead of a
moneyness guess):
  Expiry: calendar DTE in [20, 60], closest to 30. The weekly (~8 DTE) is out.
  Quote: bid > 0, ask >= bid, mid > 0, (ask−bid)/mid <= 1, vendor IV in (0.05, 2).
  25Δ put: put with delta closest to −0.25, and within 0.05. Else missing.
  ATM call: call with delta closest to +0.50, and within 0.05. Else missing.
  d25 = (put IV − call IV) × 100, vol points. |d25| > 40 is dropped.
  cp = open-interest-weighted mean of (call IV − put IV) × 100 on matched
  expiry+strike with |K/S−1| <= 0.10. Equal weight when every OI is 0. |cp| > 40 dropped.
  Signal date for a Monday = last ladder day in [Monday−6, Monday]. Mondays are the
  calendar weeks the ladders touch, including the next Monday when the panel has
  not been built yet. Outcomes stay null until rel_21 and the 5-session put exist.
  Amendment, before any outcome (coverage query: vendor call IV equals put IV on
  16,424/16,593 matched strikes): cp_mid uses Black-Scholes IV from the mid on those
  same strikes (zero rates, T = calendar DTE/365, same as S075). d25_mid is the
  same inversion on the 25Δ put and the ATM call. Neither price measure faces the
  bar this run. They are in the forward ledger so a later window grades one formula.

Boards and PASS (pre-registered, unchanged): holdout 2023-01 →, week-clustered
|t| >= 2, same sign in both halves (split = median lab Monday), and marginal |t| >= 2
versus put_edge (puts) or StarMine combined alpha + lab_tech v2 (stocks).

  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s091b_ladder_skew.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s091b_ladder_skew.py
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))
# The LSEG venv runs this file with --probe-only. It does not have the lab stack.
if "--probe-only" not in sys.argv:
    import numpy as np
    from build_plan import connect  # noqa: E402
    from s045_put_retest import bs_put  # noqa: E402

HOLDOUT = date(2023, 1, 1)
LAG_DAYS = 6
SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
HAND = "MU"
DTE_LO, DTE_HI, DTE_TARGET = 20, 60, 30
DELTA_PUT, DELTA_CALL, DELTA_BAND = -0.25, 0.50, 0.05
MONEY = 0.10
MAX_ABS = 40.0
OUT = ROOT / "out" / "studies" / "S091b.md"
LEDGER = ROOT / "out" / "studies" / "S091b_forward.jsonl"
PROBE_CAP = 5


def _f(x):
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def quote_ok(bid, ask, iv) -> bool:
    if bid is None or ask is None or iv is None:
        return False
    if bid <= 0 or ask < bid or not (0.05 < iv < 2.0):
        return False
    mid = (bid + ask) / 2
    return mid > 0 and (ask - bid) / mid <= 1


def vol_pts(iv: float) -> float:
    return iv * 100.0 if iv < 3 else iv


def bs_price(S, K, vol, t, side: str) -> float:
    put = bs_put(S, K, vol, t)
    return put + (S - K) if side == "call" else put


def implied_vol(mid, S, K, t, side: str):
    if mid is None or S <= 0 or K <= 0 or t <= 1 / 365 or mid <= 0:
        return None
    intrinsic = max(0.0, (S - K) if side == "call" else (K - S))
    if mid < intrinsic - 0.01:
        return None
    lo, hi = 1e-4, 3.0
    if bs_price(S, K, hi, t, side) < mid:
        return None
    for _ in range(50):
        mid_v = 0.5 * (lo + hi)
        if bs_price(S, K, mid_v, t, side) > mid:
            hi = mid_v
        else:
            lo = mid_v
    return 0.5 * (lo + hi)


def load_quotes(conn, tickers: tuple[str, ...] | None):
    sql = """SELECT as_of, ticker, expiry, side, strike::float8, spot::float8,
                    bid::float8, ask::float8, iv::float8, delta::float8, COALESCE(oi, 0)
             FROM optlab.skew_survey"""
    args: tuple = ()
    if tickers:
        sql += " WHERE ticker = ANY(%s)"
        args = (list(tickers),)
    rows = []
    for as_of, ticker, expiry, side, strike, spot, bid, ask, iv, delta, oi in conn.execute(sql, args):
        side_n = "call" if str(side).lower().startswith("c") else "put"
        rows.append({
            "as_of": as_of, "ticker": ticker, "expiry": expiry, "side": side_n,
            "strike": strike, "spot": spot, "bid": _f(bid), "ask": _f(ask),
            "iv": _f(iv), "delta": _f(delta), "oi": int(oi or 0),
        })
    return rows


def pick_expiry(quotes, as_of: date):
    best = None
    for expiry in {q["expiry"] for q in quotes}:
        dte = (expiry - as_of).days
        if not (DTE_LO <= dte <= DTE_HI):
            continue
        rank = (abs(dte - DTE_TARGET), expiry)
        if best is None or rank < best[0]:
            best = (rank, expiry, dte)
    if best is None:
        return None, None
    return best[1], best[2]


def pick_leg(quotes, side: str, target: float):
    best = None
    for q in quotes:
        if q["side"] != side or q["delta"] is None:
            continue
        if not quote_ok(q["bid"], q["ask"], q["iv"]):
            continue
        dist = abs(q["delta"] - target)
        if dist > DELTA_BAND:
            continue
        key = (dist, -q["oi"], q["strike"])
        if best is None or key < best[0]:
            best = (key, q)
    return None if best is None else best[1]


def _wavg(num: float, den: float, equal: list[float]):
    if den > 0:
        return num / den
    if equal:
        return float(np.mean(equal))
    return None


def matched_spread(quotes, spot: float, t_years: float):
    """Vendor and mid-price call−put IV, vol points. identical = vendor IVs within 0.05 vol pt."""
    by_k = defaultdict(dict)
    for q in quotes:
        if not quote_ok(q["bid"], q["ask"], q["iv"]):
            continue
        if spot <= 0 or abs(q["strike"] / spot - 1) > MONEY:
            continue
        by_k[q["strike"]][q["side"]] = q
    num = den = 0.0
    equal: list[float] = []
    mnum = mden = 0.0
    mequal: list[float] = []
    identical = pairs = 0
    for legs in by_k.values():
        if "call" not in legs or "put" not in legs:
            continue
        c, p = legs["call"], legs["put"]
        gap = vol_pts(c["iv"]) - vol_pts(p["iv"])
        w = float(c["oi"] + p["oi"])
        pairs += 1
        if abs(vol_pts(c["iv"]) - vol_pts(p["iv"])) < 0.05:
            identical += 1
        if w <= 0:
            equal.append(gap)
        else:
            num += w * gap
            den += w
        civ, piv = mid_iv(c, t_years), mid_iv(p, t_years)
        if civ is None or piv is None:
            continue
        mgap = (civ - piv) * 100.0
        if w <= 0:
            mequal.append(mgap)
        else:
            mnum += w * mgap
            mden += w
    return _wavg(num, den, equal), _wavg(mnum, mden, mequal), pairs, identical


def mid_iv(q, t_years: float):
    mid = (q["bid"] + q["ask"]) / 2
    return implied_vol(mid, q["spot"], q["strike"], t_years, q["side"])


def signals_for(quotes):
    """One record per (ticker, as_of)."""
    grouped = defaultdict(list)
    for q in quotes:
        grouped[(q["ticker"], q["as_of"])].append(q)
    out = []
    for (ticker, as_of), qs in sorted(grouped.items()):
        expiry, dte = pick_expiry(qs, as_of)
        if expiry is None:
            out.append({"ticker": ticker, "as_of": as_of, "missing": "no expiry in 20–60 DTE"})
            continue
        band = [q for q in qs if q["expiry"] == expiry]
        spot = next((q["spot"] for q in band if q["spot"] and q["spot"] > 0), None)
        put = pick_leg(band, "put", DELTA_PUT)
        call = pick_leg(band, "call", DELTA_CALL)
        t_years = dte / 365
        cp, cp_mid, pairs, identical = matched_spread(band, spot or 0, t_years)
        rec = {
            "ticker": ticker, "as_of": as_of, "expiry": expiry, "dte": dte, "spot": spot,
            "pairs": pairs, "identical": identical,
        }
        if put and call:
            d25 = vol_pts(put["iv"]) - vol_pts(call["iv"])
            rec["d25"] = d25 if abs(d25) <= MAX_ABS else None
            rec["put"] = {k: put[k] for k in ("strike", "bid", "ask", "iv", "delta", "oi")}
            rec["call"] = {k: call[k] for k in ("strike", "bid", "ask", "iv", "delta", "oi")}
            twin = next((q for q in band if q["side"] == "put" and q["strike"] == call["strike"]
                         and quote_ok(q["bid"], q["ask"], q["iv"])), None)
            if twin is not None:
                rec["twin_put_iv"] = twin["iv"]
            piv, civ = mid_iv(put, t_years), mid_iv(call, t_years)
            if piv is not None and civ is not None:
                d25_mid = (piv - civ) * 100
                rec["d25_mid"] = d25_mid if abs(d25_mid) <= MAX_ABS else None
                rec["put_mid_iv"] = piv
                rec["call_mid_iv"] = civ
        if cp is not None and abs(cp) <= MAX_ABS:
            rec["cp"] = cp
        if cp_mid is not None and abs(cp_mid) <= MAX_ABS:
            rec["cp_mid"] = cp_mid
        out.append(rec)
    return out


def ladder_mondays(recs) -> list[date]:
    """Monday of the first ladder day through the Monday on or after the last."""
    days = [r["as_of"] for r in recs]
    if not days:
        return []
    first, last = min(days), max(days)
    start = first - timedelta(days=first.weekday())
    end = last + timedelta(days=(7 - last.weekday()) % 7)
    out = []
    d = start
    while d <= end:
        out.append(d)
        d += timedelta(days=7)
    return out


def attach_mondays(recs, mondays: list[date]):
    by_t = defaultdict(list)
    for r in recs:
        if all(r.get(k) is None for k in ("d25", "cp", "d25_mid", "cp_mid")):
            continue
        by_t[r["ticker"]].append(r)
    for t in by_t:
        by_t[t].sort(key=lambda r: r["as_of"])
    attached = []
    for monday in mondays:
        lo = monday - timedelta(days=LAG_DAYS)
        for ticker, series in by_t.items():
            use = [r for r in series if lo <= r["as_of"] <= monday]
            if not use:
                continue
            src = use[-1]
            attached.append({**src, "monday": monday})
    return attached


def summarize_vals(xs: list[float]) -> str:
    if not xs:
        return "n 0"
    a = np.array(xs, float)
    return (f"n {len(a)}, median {float(np.median(a)):+.2f}, "
            f"p10 {float(np.percentile(a, 10)):+.2f}, p90 {float(np.percentile(a, 90)):+.2f}")


def hand_lines(recs) -> list[str]:
    lines = ["## Hand-check", ""]
    by = {(r["ticker"], r["as_of"]): r for r in recs}
    for t in SMOKE:
        got = [r for r in recs if r["ticker"] == t]
        if not got:
            lines.append(f"- {t}: not in optlab.skew_survey.")
            continue
        days = sorted({r["as_of"] for r in got})
        n_d25 = sum(1 for r in got if r.get("d25") is not None)
        n_cp = sum(1 for r in got if r.get("cp") is not None)
        lines.append(f"- {t}: ladder days {len(days)} ({days[0]} → {days[-1]}), d25 {n_d25}, cp {n_cp}.")
    hand = [r for r in recs if r["ticker"] == HAND and r.get("put") and r.get("call")]
    if not hand:
        lines.append(f"Hand-check failed: {HAND} has no 25Δ/ATM pair.")
        return lines
    r = hand[-1]
    p, c = r["put"], r["call"]
    d25 = vol_pts(p["iv"]) - vol_pts(c["iv"])
    lines += [
        "",
        f"Row: **{HAND} {r['as_of']}** expiry {r['expiry']} ({r['dte']} DTE), spot {r['spot']}.",
        f"25Δ put: K {p['strike']} Δ {p['delta']} IV {p['iv']} bid {p['bid']} / ask {p['ask']} OI {p['oi']}.",
        f"ATM call: K {c['strike']} Δ {c['delta']} IV {c['iv']} bid {c['bid']} / ask {c['ask']} OI {c['oi']}.",
        f"d25 = ({p['iv']} − {c['iv']}) × 100 = {d25:.4f} vol pts. Stored {r.get('d25')}.",
        f"Same strike as the ATM call, put vendor IV {r.get('twin_put_iv')} vs call IV {c['iv']}.",
        f"cp (vendor, OI-weighted, |K/S−1|≤0.10) = {r.get('cp')} on {r.get('pairs')} strikes, "
        f"{r.get('identical')} with vendor call IV = put IV.",
        f"Mid IV put {r.get('put_mid_iv')} call {r.get('call_mid_iv')}; d25_mid = {r.get('d25_mid')}; "
        f"cp_mid = {r.get('cp_mid')}.",
    ]
    return lines


def ledger_rows(attached) -> list[dict]:
    rows = []
    for r in attached:
        put, call = r.get("put") or {}, r.get("call") or {}
        rows.append({
            "monday": r["monday"].isoformat(),
            "signal_day": r["as_of"].isoformat(),
            "ticker": r["ticker"],
            "expiry": r["expiry"].isoformat() if r.get("expiry") else None,
            "dte": r.get("dte"),
            "spot": r.get("spot"),
            "d25": r.get("d25"),
            "cp": r.get("cp"),
            "d25_mid": r.get("d25_mid"),
            "cp_mid": r.get("cp_mid"),
            "put_k": put.get("strike"), "put_delta": put.get("delta"), "put_iv": put.get("iv"),
            "call_k": call.get("strike"), "call_delta": call.get("delta"), "call_iv": call.get("iv"),
            "rel_21": None,
            "put_pnl": None,
        })
    return rows


def write_ledger(rows: list[dict]):
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    tmp = LEDGER.with_suffix(".jsonl.tmp")
    tmp.write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
    tmp.replace(LEDGER)


def lab_mondays(conn) -> tuple[list[date], date | None, dict]:
    mondays = [d for (d,) in conn.execute(
        "SELECT DISTINCT as_of FROM watchlist_sync.lab_outcomes ORDER BY 1")]
    hold = [d for d in mondays if d >= HOLDOUT]
    split = hold[len(hold) // 2] if hold else None
    formed = {}
    for d, n, rel in conn.execute(
            """SELECT as_of, count(*),
                      count(*) FILTER (WHERE (outcomes->>'rel_21') IS NOT NULL)
               FROM watchlist_sync.lab_outcomes GROUP BY 1"""):
        formed[d] = (n, rel)
    return mondays, split, formed


def coverage_block(quotes, recs, mondays, formed, attached) -> list[str]:
    days = sorted({q["as_of"] for q in quotes})
    names = {q["ticker"] for q in quotes}
    ivs = [q["iv"] for q in quotes if q.get("iv") is not None]
    d25 = [r["d25"] for r in recs if r.get("d25") is not None]
    cp = [r["cp"] for r in recs if r.get("cp") is not None]
    d25m = [r["d25_mid"] for r in recs if r.get("d25_mid") is not None]
    cpm = [r["cp_mid"] for r in recs if r.get("cp_mid") is not None]
    ident_pairs = sum(r.get("identical") or 0 for r in recs)
    pairs = sum(r.get("pairs") or 0 for r in recs)
    usable_mondays = sorted({r["monday"] for r in attached})
    overlap_formed = []
    for m in usable_mondays:
        n, rel = formed.get(m, (0, 0))
        overlap_formed.append(f"{m} lab names {n} rel_21 formed {rel}")
    latest = days[-1] if days else None
    cross = [r["d25"] for r in recs if r.get("d25") is not None and r["as_of"] == latest]
    return [
        f"skew_survey days {len(days)}" + (f" ({days[0]} → {days[-1]})" if days else "") +
        f", quotes {len(quotes):,}, names {len(names)}.",
        f"Vendor IV is a decimal ({summarize_vals(ivs)}). d25 and cp are vol points.",
        f"Name-days with d25: {len(d25)}. {summarize_vals(d25)} vol pts.",
        f"Name-days with vendor cp: {len(cp)}. {summarize_vals(cp)} vol pts.",
        f"Matched strikes inside 10% of spot: {pairs:,}. Vendor call IV equals put IV "
        f"(gap < 0.05 vol pt) on {ident_pairs:,}.",
        f"Mid-IV d25 (not scored): {summarize_vals(d25m)}.",
        f"Mid-IV cp (not scored): {summarize_vals(cpm)}.",
        f"Latest ladder day {latest}: d25 {summarize_vals(cross)}.",
        f"Signal Mondays: {len(usable_mondays)}"
        + (f" ({', '.join(str(m) for m in usable_mondays)})" if usable_mondays else "") + ".",
        "Panel on those Mondays: " + ("; ".join(overlap_formed) if overlap_formed else "none."),
        f"Last lab Monday is {mondays[-1] if mondays else '—'}. "
        f"A 5-session put and rel_21 are both unformed on every signal Monday.",
    ]


def formed_weeks(attached, formed) -> list[date]:
    weeks = []
    for m in sorted({r["monday"] for r in attached}):
        _n, rel = formed.get(m, (0, 0))
        if rel >= 12:
            weeks.append(m)
    return weeks


def verdict_of(attached, formed) -> str:
    weeks = formed_weeks(attached, formed)
    if len(weeks) >= 20:
        raise SystemExit(
            f"{len(weeks)} formed weeks — rank test is not in this script; do not quote a t-stat")
    return "no test (coverage)"


def render(cov, hand, split, verdict, probe_note) -> str:
    L = [
        "# S091b — put skew and call−put IV on Schwab ladders",
        "",
        "Holdout 2023-01-01 →. The pre-registered bar is unchanged: week-clustered t ≥ 2, "
        "same sign in both halves, and marginal t ≥ 2 versus put_edge (puts) or "
        "StarMine combined alpha + lab_tech v2 (stocks).",
        f"Holdout split (median lab Monday, same clock as S091): {split}.",
        "",
        "## Verdict",
        "",
        f"**{verdict}.** Nothing ships. No signal Monday has a formed rel_21 or a finished "
        "5-session put, so the t-stat is not computed. This is not a fail.",
        "What would ship: nothing. The vendor call−put spread is not Cremers-Weinbaum: "
        "Schwab stores one IV on the call and the put at the same strike. d25 (25Δ put IV minus "
        "ATM call IV) does vary, because those are different strikes. cp_mid and d25_mid are in "
        "the ledger and do not face the bar.",
        "Next: leave put_edge alone. Re-run when skew_survey covers ≥ 20 Mondays whose rel_21 "
        "and the S045 put pnl are formed. Do not backfill a 25Δ history unless the probe "
        "section names a field that returned numbers.",
        "",
        "## Coverage",
        "",
    ]
    L += [f"- {x}" for x in cov]
    L += ["", *hand, ""]
    L += [
        "## Forward ledger",
        "",
        f"Open rows (outcome null) in `{LEDGER.name}`. One row per name × signal Monday. "
        "Signal day is the last ladder in [Monday−6, Monday]. rel_21 and put pnl stay empty.",
        "",
        "## LSEG probe (≤ 5 calls)",
        "",
        probe_note,
        "",
        "## Weaknesses",
        "",
        "- Ladders are the top-OI survey (~120 names). TMO is not in it. CAVA is one day.",
        "- 25Δ is Schwab's delta, within 0.05. It is not the 0.93-moneyness strike S091 used.",
        "- Vendor IV jumps between adjacent strikes. d25 uses that IV. The ATM call can be the low-OI strike whose delta is closest to 0.50.",
        "- cp_mid assumes zero rates and European exercise. A 4% rate over 29 days is about $3 of parity, so the level is not a pure vol spread. Labelled amendment, not scored.",
        "- No Holm and no placebo: there is no formed week to shuffle.",
    ]
    return "\n".join(L) + "\n"


def run_local(smoke: bool) -> tuple[str, str]:
    tickers = SMOKE if smoke else None
    with connect() as conn:
        quotes = load_quotes(conn, tickers)
        mondays, split, formed = lab_mondays(conn)
    recs = signals_for(quotes)
    attached = attach_mondays(recs, ladder_mondays(recs))
    # Lab Mondays end before the first ladder. The holdout clock is still reported.
    hand = hand_lines(recs)
    cov = coverage_block(quotes, recs, mondays, formed, attached)
    verdict = verdict_of(attached, formed)
    for line in hand + [""] + cov:
        print(line)
    print(f"verdict {verdict} split {split} attached {len(attached)}")
    if smoke:
        return verdict, "smoke — probe not run"
    rows = ledger_rows(attached)
    write_ledger(rows)
    print(f"ledger rows {len(rows)}", flush=True)
    return verdict, split, recs, attached, cov, hand


def probe_note_from_file(path: Path) -> str:
    if not path.exists():
        return "Probe did not write a result."
    return path.read_text().strip()


def main():
    smoke = "--smoke" in sys.argv
    if smoke:
        run_local(True)
        print("smoke done — full run not started")
        return
    verdict, split, _recs, _attached, cov, hand = run_local(False)
    note_path = ROOT / "out" / "studies" / "S091b_probe.txt"
    lseg_py = REPO / "research" / "lseg" / ".venv" / "bin" / "python"
    if "--no-probe" not in sys.argv:
        print("LSEG probe…", flush=True)
        proc = subprocess.run(
            [str(lseg_py), str(Path(__file__).resolve()), "--probe-only"],
            cwd=str(REPO / "research" / "lseg"),
            capture_output=True, text=True, timeout=240,
        )
        text = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        note_path.write_text(text.strip() + "\n")
        print(text)
    probe = probe_note_from_file(note_path) if note_path.exists() else "Probe skipped."
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(cov, hand, split, verdict, probe))
    print(f"wrote {OUT}", flush=True)


# --- LSEG probe (research/lseg/.venv). Five calls max. Not the official session:
# the monthly datapoint guard is already past 80% (S092). A field probe is a handful
# of points; a history backfill is not this study.


# Call 1 is the field sync_daily_history already stores. Calls 2–4 are 25Δ name guesses.
# Call 5 is a one-month check only if a 25Δ field returns numbers.
PROBE_FIELDS = [
    ["30D_A_IM_P"],
    ["30D_25D_IM_P", "30D_25D_IM_C", "30D_10D_IM_P"],
    ["30D_25_IM_P", "30D_25_IM_C", "30D_10_IM_P"],
    ["1M_25D_IM_P", "1M_25D_IM_C", "30D_50D_IM_P"],
]


def _frame_brief(df, fields: list[str]) -> str:
    if df is None or getattr(df, "empty", True):
        return "empty frame"
    cols = [str(c) for c in df.columns]
    bits = [f"rows {len(df)}, columns {cols}"]
    for f in fields:
        hit = [c for c in df.columns if f in (c if isinstance(c, str) else str(c))]
        if not hit and getattr(df.columns, "nlevels", 1) > 1:
            hit = [c for c in df.columns if f in c]
        if not hit:
            bits.append(f"{f}: column absent")
            continue
        s = df[hit[0]]
        vals = []
        for v in s:
            try:
                if v is None or (isinstance(v, float) and math.isnan(v)):
                    continue
                vals.append(float(v))
            except (TypeError, ValueError):
                continue
        if not vals:
            bits.append(f"{f}: all null")
        else:
            bits.append(f"{f}: n {len(vals)} first {vals[0]:.4f} last {vals[-1]:.4f}")
    return "; ".join(bits)


def probe_only():
    """At most PROBE_CAP get_history calls on MUATMIV.U, then one 2023 month if a 25Δ field hits."""
    sys.path.insert(0, str(REPO / "research" / "lseg"))
    from _session import (  # noqa: E402
        LSEG_BUDGET_FRACTION,
        LSEG_DAILY_REQUESTS,
        LSEG_MONTHLY_DATAPOINTS,
        MeteredLD,
        _datapoints_this_month,
        _record_datapoints,
        _record_usage,
        _usage_today,
        connect_local,
        load_env,
    )
    import lseg.data as ld  # noqa: E402

    load_env()
    key = os.environ.get("LSEG_APP_KEY")
    if not key:
        print("blocked: LSEG_APP_KEY missing")
        return
    with connect_local() as conn:
        used = _usage_today(conn)
        month = _datapoints_this_month(conn)
        conn.commit()
    daily_stop = int(LSEG_DAILY_REQUESTS * LSEG_BUDGET_FRACTION)
    month_stop = int(LSEG_MONTHLY_DATAPOINTS * LSEG_BUDGET_FRACTION)
    print(
        f"budget before probe: requests today {used}/{daily_stop}, "
        f"month datapoints {month:,} (80% stop {month_stop:,})"
    )
    if used >= daily_stop:
        print(f"blocked: daily research stop {used}/{daily_stop}")
        return
    if month >= month_stop:
        print(
            "month is past the 80% research stop. This probe stays at "
            f"{PROBE_CAP} calls and does not backfill a history."
        )
    room = min(PROBE_CAP, daily_stop - used)
    try:
        ld.open_session(name="desktop.workspace", app_key=key)
    except Exception as e:
        print(f"blocked: session did not open ({str(e)[:180]})")
        return
    if str(ld.session.get_default().open_state).split(".")[-1] != "Opened":
        ld.close_session()
        print("blocked: session did not open. Log in to Workspace.")
        return
    metered = MeteredLD(ld, room, None)
    lines = []
    found = None
    try:
        for fields in PROBE_FIELDS:
            if metered.requests >= room:
                break
            try:
                df = metered.get_history(
                    "MUATMIV.U", fields=fields, interval="daily",
                    start="2026-10-01", end="2026-10-23")
                brief = _frame_brief(df, fields)
                err = None
            except Exception as e:
                df = None
                brief = ""
                err = str(e)[:300]
            line = f"call {metered.requests}: MUATMIV.U {fields} → " + (f"ERROR {err}" if err else brief)
            print(line, flush=True)
            lines.append(line)
            if err:
                if fields == ["30D_A_IM_P"]:
                    lines.append("known ATM field failed — stop, do not spend the remaining calls")
                    break
                continue
            for f in fields:
                if "25" in f and f"{f}: n " in brief:
                    found = f
            if found:
                break
        if found and metered.requests < room:
            try:
                df = metered.get_history(
                    "MUATMIV.U", fields=[found, "30D_A_IM_P"], interval="daily",
                    start="2023-01-03", end="2023-01-31")
                brief = _frame_brief(df, [found, "30D_A_IM_P"])
                line = f"call {metered.requests}: 2023-01 {found} → {brief}"
            except Exception as e:
                line = f"call {metered.requests}: 2023-01 {found} → ERROR {str(e)[:300]}"
            print(line, flush=True)
            lines.append(line)
        elif not found:
            lines.append("No 25Δ field returned numbers. Remaining call budget not used on a backfill.")
    finally:
        ld.close_session()
        try:
            with connect_local() as conn:
                _record_usage(conn, metered.requests)
                _record_datapoints(conn, metered)
                conn.commit()
        except Exception as e:
            print(f"warn: could not record LSEG usage ({e})")
        print(f"lseg usage: {metered.requests} requests (cap {room})")
    if found:
        print(f"field that returned numbers: {found}")
    else:
        print("field that returned numbers: none")


if __name__ == "__main__":
    if "--probe-only" in sys.argv:
        probe_only()
    else:
        main()
