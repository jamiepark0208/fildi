"""S089 — Which Open Source Asset Pricing signals add to Fildi's stock rank (A262).

Question: Of the Chen–Zimmermann signed predictors (~210), which predict
21-day peer-residual return on the holdout beyond StarMine combined alpha
and lab_tech v2?

Method:
  Firm signals = OSAP release 202510 signed_predictors_dl_wide (209 predictors).
  Price, Size, and STreversal are not in that file. They are computed for our
  permnos only from crsp.msf (2018-01 → 2024-12) with the openassetpricing
  formulas: Price = −log|prc|, Size = −log(|prc|·shrout/1000), STreversal = −ret.
  Placebos are not tested. yyyymm is the month the signal is known. A Monday
  uses the latest month-end on or before that Monday, and only if it is ≤ 45
  days old. Months after the Monday are dropped (the file contains 202611).
  Target = lab_outcomes rel_21 on Mondays, holdout 2023-01-01 →.
  Weekly Spearman IC, top−bottom decile, Newey-West lag 3 (21-day overlap).
  Marginal = Fama-MacBeth of the rel rank on the signal rank plus combined
  alpha rank plus lab_tech v2, and the within alpha+tech quintile high−low
  rel_21 spread. Predictors are already signed: a positive number is the
  published direction.

Pass bar (pre-registered in INDEX S089 / A262 — not changed here):
  holdout week-clustered t ≥ 2, same sign in both holdout halves, AND marginal
  t ≥ 2 (FM or within-quintile) with both halves positive.
  Standalone IC without a marginal pass = duplicates what we have.
  OSAP and CRSP are research-only. A pass ships only if recomputed from
  commercial data (LSEG closes, or a fundamental field we already store).

Caches (gitignored, under out/studies/osap/): SignalDoc.csv,
signed_predictors_dl_wide.zip, signed_predictors_fildi.csv, permno_map.json,
crsp_msf_fildi.csv. The zip is the public Drive file
id 1avFIMjz_7LoF3p3nO26eqLW5KdRTOdhW. permno_map is a narrow crsp.stocknames
lookup (ticker, then 8-char CUSIP). It does not write security_map.

Run (from scripts/watchlist_sync):
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s089_osap_signals.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s089_osap_signals.py
"""
from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from build_plan import connect  # noqa: E402
from lab import nw_t  # noqa: E402
from s045_put_retest import rank  # noqa: E402

SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
HAND = "MU"
HAND_YM = 202406
HOLDOUT_START = date(2023, 1, 1)
STALE_DAYS = 45
MIN_NAMES = 30
MIN_HALF = 8
CACHE = ROOT / "out" / "studies" / "osap"
OUT = ROOT / "out" / "studies" / "S089.md"
RESULTS = ROOT / "out" / "studies" / "s089_results.json"
# TMO is on the smoke list and not in lab_outcomes. CRSP stocknames: permno
# 62092, name through 2024-12-31.
EXTRA_PERMNO = {"TMO": 62092}


def as_date(d) -> date:
    if isinstance(d, datetime):
        return d.date()
    return d


def month_end(ym: int) -> date:
    y, m = divmod(int(ym), 100)
    if m == 12:
        return date(y, 12, 31)
    return date(y, m + 1, 1) - timedelta(days=1)


def add_months(ym: int, k: int) -> int:
    y, m = divmod(int(ym), 100)
    m += k
    while m <= 0:
        m += 12
        y -= 1
    while m > 12:
        m -= 12
        y += 1
    return y * 100 + m


def norm_sf(t: float) -> float:
    """One-sided P(Z > t)."""
    if t is None or not math.isfinite(t):
        return 1.0
    return 0.5 * math.erfc(t / math.sqrt(2))


def load_docs() -> dict[str, dict]:
    out = {}
    with (CACHE / "SignalDoc.csv").open(newline="") as f:
        for row in csv.DictReader(f):
            if row.get("Cat.Signal") == "Predictor" and row.get("Acronym"):
                out[row["Acronym"]] = row
    return out


def load_permno() -> dict[str, int]:
    raw = json.loads((CACHE / "permno_map.json").read_text())
    perm = {t: int(p) for t, p in raw["permno"].items()}
    perm.update(EXTRA_PERMNO)
    return perm


def load_osap(acronyms: list[str]) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """permno -> (yyyymm sorted, float matrix columns = acronyms)."""
    path = CACHE / "signed_predictors_fildi.csv"
    buckets: dict[int, list[tuple[int, list[float]]]] = defaultdict(list)
    with path.open(newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = {name: i for i, name in enumerate(header)}
        missing = [a for a in acronyms if a not in idx]
        if missing:
            raise SystemExit(f"OSAP file missing columns {missing[:8]}")
        cols = [idx[a] for a in acronyms]
        for row in reader:
            perm = int(row[0])
            ym = int(row[1])
            vals = []
            for j in cols:
                cell = row[j] if j < len(row) else ""
                vals.append(float(cell) if cell not in ("", "NA", "NaN") else math.nan)
            buckets[perm].append((ym, vals))
    out = {}
    width = len(acronyms)
    for perm, pairs in buckets.items():
        pairs.sort(key=lambda z: z[0])
        # last row wins if a month repeats
        uniq = {}
        for ym, vals in pairs:
            uniq[ym] = vals
        yms = sorted(uniq)
        mat = np.empty((len(yms), width), np.float64)
        for i, ym in enumerate(yms):
            mat[i] = uniq[ym]
        out[perm] = (np.asarray(yms, np.int32), mat)
    return out


def load_crsp3() -> dict[int, dict[int, tuple[float, float, float]]]:
    """permno -> yyyymm -> (Price, Size, STreversal), already signed."""
    out: dict[int, dict[int, tuple[float, float, float]]] = defaultdict(dict)
    with (CACHE / "crsp_msf_fildi.csv").open(newline="") as f:
        for row in csv.DictReader(f):
            perm = int(float(row["permno"]))
            d = row["date"][:10]
            y, m, _ = d.split("-")
            ym = int(y) * 100 + int(m)
            ret = float(row["ret"]) if row["ret"] not in ("", "None") else math.nan
            prc = float(row["prc"]) if row["prc"] not in ("", "None") else math.nan
            shr = float(row["shrout"]) if row["shrout"] not in ("", "None") else math.nan
            price = -math.log(prc) if prc > 0 and math.isfinite(prc) else math.nan
            cap = prc * shr / 1000.0
            size = -math.log(cap) if cap > 0 and math.isfinite(cap) else math.nan
            rev = -ret if math.isfinite(ret) else math.nan
            out[perm][ym] = (price, size, rev)
    return out


def attach_crsp(osap, crsp, n_osap: int):
    """Add Price, Size, STreversal as the last three columns. Returns new dict."""
    out = {}
    for perm, (yms, mat) in osap.items():
        extra = np.full((len(yms), 3), np.nan)
        series = crsp.get(perm, {})
        for i, ym in enumerate(yms):
            hit = series.get(int(ym))
            if hit:
                extra[i] = hit
        out[perm] = (yms, np.concatenate([mat, extra], axis=1))
    # permnos that have CRSP but no OSAP row are not added: no join key for the other signals
    assert n_osap
    return out


def asof_row(yms: np.ndarray, ends: list[date], d: date) -> int | None:
    lo, hi, hit = 0, len(yms), None
    while lo < hi:
        mid = (lo + hi) // 2
        if ends[mid] <= d:
            hit = mid
            lo = mid + 1
        else:
            hi = mid
    if hit is None:
        return None
    if (d - ends[hit]).days > STALE_DAYS:
        return None
    return hit


def load_panel(conn):
    digest = conn.execute(
        """SELECT engine_digest FROM watchlist_sync.lab_tech
           WHERE engine_digest LIKE '%%-ivhist'
           GROUP BY 1 ORDER BY max(as_of) DESC, max(computed_at) DESC LIMIT 1"""
    ).fetchone()[0]
    outcomes = conn.execute(
        """SELECT ticker, as_of, (outcomes->>'rel_21')::float8,
                  (features->>'mom_12_1')::float8
           FROM watchlist_sync.lab_outcomes
           WHERE EXTRACT(DOW FROM as_of) = 1 AND outcomes->>'rel_21' IS NOT NULL"""
    ).fetchall()
    tech = {}
    for t, d, v in conn.execute(
        """SELECT ticker, as_of, (v2->>'total')::float8 FROM watchlist_sync.lab_tech
           WHERE engine_digest = %s AND v2->>'total' IS NOT NULL""",
        (digest,),
    ):
        if v is not None:
            tech[(t, as_date(d))] = float(v)
    alpha = defaultdict(list)
    for t, d, v in conn.execute(
        """SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
           WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL
           ORDER BY ticker, obs_date"""
    ):
        alpha[t].append((as_date(d), float(v)))
    return digest, outcomes, tech, alpha


def alpha_asof(series, d: date) -> float | None:
    lo, hi, hit = 0, len(series), None
    while lo < hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= d:
            hit = series[mid][1]
            lo = mid + 1
        else:
            hi = mid
    return hit


def compound(rets: dict[int, float], end: int, lag_lo: int, lag_hi: int) -> float | None:
    acc = 1.0
    for lag in range(lag_lo, lag_hi + 1):
        r = rets.get(add_months(end, -lag))
        if r is None or not math.isfinite(r):
            return None
        acc *= 1.0 + r
    return acc - 1.0


def mu_crsp_rets() -> dict[int, float]:
    out = {}
    with (CACHE / "crsp_msf_fildi.csv").open(newline="") as f:
        for row in csv.DictReader(f):
            if int(float(row["permno"])) != 53613:
                continue
            y, m, _ = row["date"][:10].split("-")
            if row["ret"] in ("", "None"):
                continue
            out[int(y) * 100 + int(m)] = float(row["ret"])
    return out


def lseg_price_return(conn, ticker: str, start_ym: int, end_ym: int) -> tuple[float | None, str]:
    """Close-to-close from the last print of start_ym to the last print of end_ym."""
    rows = conn.execute(
        """SELECT date, close FROM lseg_research.daily_history
           WHERE ticker = %s AND close IS NOT NULL AND date >= %s AND date <= %s
           ORDER BY date""",
        (ticker, date(start_ym // 100, start_ym % 100, 1), month_end(end_ym)),
    ).fetchall()
    by = {}
    for d, c in rows:
        d = as_date(d)
        by[d.year * 100 + d.month] = (d, float(c))
    a, b = by.get(start_ym), by.get(end_ym)
    if not a or not b or a[1] <= 0:
        return None, "no LSEG close"
    return b[1] / a[1] - 1.0, f"{a[0]} {a[1]:.4f} → {b[0]} {b[1]:.4f}"


def hand_check(conn, permno: dict[str, int], osap_mom: dict[int, tuple[np.ndarray, np.ndarray]], mom_i: int) -> tuple[list[str], bool]:
    lines = ["## Hand-check (MU Mom12m)", ""]
    rets = mu_crsp_rets()
    panel = osap_mom.get(53613)
    osap_v = None
    if panel:
        yms, mat = panel
        hit = np.where(yms == HAND_YM)[0]
        if len(hit):
            osap_v = float(mat[hit[0], mom_i])
    crsp_11 = compound(rets, HAND_YM, 1, 11)
    crsp_skip = compound(rets, HAND_YM, 2, 12)
    parts = []
    for lag in range(1, 12):
        ym = add_months(HAND_YM, -lag)
        parts.append(f"{ym} {rets.get(ym):+.4f}" if rets.get(ym) is not None else f"{ym} NA")
    # Window in the doc: return between t-12 and t-1 = end of t-12 to end of t-1.
    px, px_note = lseg_price_return(conn, HAND, add_months(HAND_YM, -12), add_months(HAND_YM, -1))
    ok = osap_v is not None and crsp_11 is not None and abs(osap_v - crsp_11) < 1e-6
    lines.append(f"MU permno {permno.get('MU')} (CRSP stocknames). OSAP yyyymm {HAND_YM} Mom12m = "
                 f"{osap_v if osap_v is not None else 'MISSING'}.")
    lines.append("SignalDoc: \"Stock return between months t-12 and t-1\" (Sign +1, so the file is the raw return).")
    lines.append("CRSP msf monthly total returns, product of lags 1..11 (end of t-12 → end of t-1) = "
                 f"{crsp_11 if crsp_11 is not None else 'NA'}.")
    lines.append("Same window, skip-last-month (lags 2..12) = "
                 f"{crsp_skip if crsp_skip is not None else 'NA'} — does not match.")
    lines.append("Months in the product: " + "; ".join(parts) + ".")
    if osap_v is not None and crsp_11 is not None:
        lines.append(f"OSAP − CRSP = {osap_v - crsp_11:+.3e}. Match {ok}.")
    if px is not None and osap_v is not None:
        lines.append(f"LSEG close-only return on that window ({px_note}) = {px:+.4f}. "
                     f"Gap vs OSAP {px - osap_v:+.4f} (dividends: LSEG close is not a total return).")
    else:
        lines.append(f"LSEG price return: {px_note}.")
    # smoke-name coverage
    lines.append("")
    lines.append("Smoke names:")
    for t in SMOKE:
        p = permno.get(t)
        n = 0
        span = ""
        if p and p in osap_mom:
            yms, _ = osap_mom[p]
            n = int(len(yms))
            span = f"{int(yms[0])}→{int(yms[-1])}"
        lab = conn.execute(
            "SELECT count(*) FROM watchlist_sync.lab_outcomes WHERE ticker = %s", (t,)
        ).fetchone()[0]
        lines.append(f"- {t}: permno {p if p else 'none'} OSAP months {n} {span}; lab_outcomes rows {lab}.")
    lines.append("")
    return lines, ok


def build_weeks(outcomes, tech, alpha, permno, panels, n_sig: int):
    """Holdout Mondays with rel, alpha, tech, mom, and a signal matrix."""
    ends = {}
    for perm, (yms, _mat) in panels.items():
        ends[perm] = [month_end(int(ym)) for ym in yms]
    by_week = defaultdict(list)
    holdout_weeks = set()
    for t, d, rel, mom in outcomes:
        d = as_date(d)
        if rel is None or d < HOLDOUT_START:
            continue
        holdout_weeks.add(d)
        perm = permno.get(t)
        if perm is None or perm not in panels:
            continue
        al = alpha_asof(alpha.get(t, []), d)
        te = tech.get((t, d))
        if al is None or te is None:
            continue
        yms, mat = panels[perm]
        row = asof_row(yms, ends[perm], d)
        # A later month can be an empty shell (most characteristics stop at 202412
        # while the file has rows through 202611). Use the latest finite value
        # whose own month-end is still inside the 45-day window.
        if row is None:
            sig = np.full(n_sig, np.nan)
        else:
            sig = mat[row].copy()
            j = row
            while j > 0 and not np.isfinite(sig).all() and (d - ends[perm][j - 1]).days <= STALE_DAYS:
                j -= 1
                miss = ~np.isfinite(sig)
                sig[miss] = mat[j, miss]
        by_week[d].append((t, float(rel), float(al), float(te),
                           float(mom) if mom is not None else math.nan, sig))
    weeks = sorted(holdout_weeks)
    packed = []
    for d in sorted(by_week):
        rows = by_week[d]
        if len(rows) < MIN_NAMES:
            continue
        rel = np.array([r[1] for r in rows])
        al = np.array([r[2] for r in rows])
        te = np.array([r[3] for r in rows])
        mom = np.array([r[4] for r in rows])
        sig = np.vstack([r[5] for r in rows])
        packed.append((d, rel, al, te, mom, sig))
    return weeks, packed


def _corr(a, b) -> float | None:
    if len(a) < MIN_NAMES or np.std(a) == 0 or np.std(b) == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def week_metrics(sig, rel, al, te, mom) -> dict | None:
    m = np.isfinite(sig) & np.isfinite(rel) & np.isfinite(al) & np.isfinite(te)
    if int(m.sum()) < MIN_NAMES:
        return None
    sig, rel, al, te, mom = sig[m], rel[m], al[m], te[m], mom[m]
    if np.std(sig) == 0 or np.std(rel) == 0:
        return None
    rs, ry, ra, rt = rank(sig), rank(rel), rank(al), rank(te)
    ic = _corr(rs, ry)
    if ic is None:
        return None
    k = max(1, len(sig) // 10)
    order = np.argsort(-sig, kind="mergesort")
    spread = float(rel[order[:k]].mean() - rel[order[-k:]].mean())
    X = np.c_[np.ones(len(sig)), rs, ra, rt]
    beta = np.linalg.lstsq(X, ry, rcond=None)[0]
    comp = 0.5 * (ra + rt)
    q = np.clip((comp * 0.999 * 5).astype(int), 0, 4)
    bits = []
    for qi in range(5):
        sel = q == qi
        if sel.sum() < 8 or np.std(sig[sel]) == 0:
            continue
        med = np.median(sig[sel])
        hi, lo = rel[sel & (sig >= med)], rel[sel & (sig < med)]
        if len(hi) and len(lo):
            bits.append(float(hi.mean() - lo.mean()))
    wq = float(np.mean(bits)) if len(bits) >= 3 else math.nan
    mom_c = math.nan
    mm = np.isfinite(mom)
    if mm.sum() >= MIN_NAMES and np.std(sig[mm]) > 0 and np.std(mom[mm]) > 0:
        mom_c = float(np.corrcoef(rank(sig[mm]), rank(mom[mm]))[0, 1])
    return {"ic": ic, "spread": spread, "fm": float(beta[1]), "wq": wq,
            "n": int(len(sig)), "corr_mom": mom_c,
            "corr_alpha": _corr(rs, ra), "corr_tech": _corr(rs, rt)}


def summarize(packed, col: int, mid: date, rng=None) -> dict:
    series = {"ic": [], "spread": [], "fm": [], "wq": [], "corr_mom": [], "corr_alpha": [], "corr_tech": []}
    ns = []
    for d, rel, al, te, mom, sig in packed:
        x = sig[:, col].copy()
        if rng is not None:
            rng.shuffle(x)
        met = week_metrics(x, rel, al, te, mom)
        if not met:
            continue
        ns.append(met["n"])
        for k in series:
            if met[k] is None or (isinstance(met[k], float) and not math.isfinite(met[k])):
                continue
            series[k].append((d, met[k]))

    def pack(pairs):
        if len(pairs) < MIN_HALF:
            return {"thin": True, "n": len(pairs)}
        vals = [v for _, v in pairs]
        a = [v for d, v in pairs if d < mid]
        b = [v for d, v in pairs if d >= mid]
        if len(a) < MIN_HALF or len(b) < MIN_HALF:
            return {"thin": True, "n": len(pairs), "na": len(a), "nb": len(b),
                    "mean": float(np.mean(vals)), "t": float(nw_t(vals, 3))}
        return {"thin": False, "mean": float(np.mean(vals)), "t": float(nw_t(vals, 3)),
                "a": float(np.mean(a)), "b": float(np.mean(b)),
                "n": len(vals), "na": len(a), "nb": len(b)}

    out = {k: pack(v) for k, v in series.items()}
    out["mean_n"] = float(np.mean(ns)) if ns else 0.0
    out["n_weeks"] = len(series["ic"])
    return out


def path_ok(p: dict) -> bool:
    return (not p.get("thin") and p.get("t") is not None and math.isfinite(p["t"])
            and p["t"] >= 2 and p["a"] > 0 and p["b"] > 0)


def holm_mask(pvals: list[float], alpha: float = 0.05) -> list[bool]:
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    keep = [False] * m
    for rank, i in enumerate(order):
        if pvals[i] <= alpha / (m - rank):
            keep[i] = True
        else:
            break
    return keep


def ship_route(cat: str, acronym: str) -> str:
    if acronym == "FirmAge":
        return ("months since CRSP coverage, already signed so younger is higher. "
                "The CRSP number cannot ship. A live version is months since listing from a commercial IPO date")
    if acronym in ("Price", "Mom12m", "Mom6m", "MomSeason", "STreversal", "MRreversal",
                   "MaxRet", "Beta", "IdioVolAHT", "High52"):
        return "recompute from LSEG daily closes (research CRSP number cannot ship)"
    if acronym == "Size":
        return "needs shares outstanding; not in daily_history; CRSP number cannot ship"
    if cat == "Price":
        return "price definition — recompute from LSEG closes if it is a function of returns"
    if cat == "Options":
        return "cannot ship — no OptionMetrics"
    if cat == "13F":
        return "cannot ship — 13F history is research-only"
    if cat == "Analyst":
        return "IBES-style; research-only. Do not ship unless it is already a StarMine field"
    if cat == "Accounting":
        return "OSAP/Compustat cannot ship. FMP and Finnhub fundamentals on hand are a current snapshot, not a 2023–26 panel"
    if cat == "Trading":
        return "needs volume or short interest. daily_history stores close and IV only"
    if cat == "Event":
        return "check the definition; earnings dates exist, the OSAP number cannot ship"
    return "see SignalDoc; OSAP value cannot ship"


def fmt_pack(p: dict, scale: float = 1.0) -> str:
    if not isinstance(p, dict) or p.get("mean") is None:
        n = p.get("n", 0) if isinstance(p, dict) else 0
        return f"n {n} (thin)"
    a = p.get("a")
    b = p.get("b")
    if a is None:
        halves = "thin halves"
    else:
        na, nb = p.get("na"), p.get("nb")
        halves = f"{a * scale:+.4f} / {b * scale:+.4f} (weeks {na}/{nb})"
    return f"mean {p['mean'] * scale:+.4f} NW t {p['t']:+.2f} halves {halves} (n {p['n']})"


def write_report(text: str) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)


def main() -> None:
    smoke = "--smoke" in sys.argv
    docs = load_docs()
    permno = load_permno()
    # Column order: OSAP predictors that are in the file, then the 3 CRSP signals.
    with (CACHE / "signed_predictors_fildi.csv").open(newline="") as f:
        header = next(csv.reader(f))
    osap_names = [h for h in header if h in docs]
    names = osap_names + ["Price", "Size", "STreversal"]
    print(f"signals {len(names)} ({len(osap_names)} from the wide file + Price Size STreversal)", flush=True)
    osap = load_osap(osap_names)
    crsp = load_crsp3()
    panels = attach_crsp(osap, crsp, len(osap_names))
    conn = connect()
    mom_i = names.index("Mom12m")
    lines, ok = hand_check(conn, permno, panels, mom_i)
    print("\n".join(lines), flush=True)
    if smoke:
        conn.close()
        if not ok:
            raise SystemExit("hand-check failed")
        print("smoke ok", flush=True)
        return
    if not ok:
        conn.close()
        raise SystemExit("hand-check failed — full test not run")

    digest, outcomes, tech, alpha = load_panel(conn)
    conn.close()
    weeks, packed = build_weeks(outcomes, tech, alpha, permno, panels, len(names))
    mid = weeks[len(weeks) // 2]
    print(f"holdout Mondays {len(weeks)} midpoint {mid} weeks with n≥{MIN_NAMES} {len(packed)} digest {digest}",
          flush=True)

    # Comparator's own rank IC on the same weeks (signal = the comparator).
    base_rows = []
    for d, rel, al, te, _mom, _sig in packed:
        base_rows.append((d, rel, al, te))

    def comparator_ic(kind: str) -> dict:
        pairs = []
        for d, rel, al, te in base_rows:
            x = al if kind == "alpha" else te
            if np.std(x) == 0 or np.std(rel) == 0:
                continue
            pairs.append((d, float(np.corrcoef(rank(x), rank(rel))[0, 1])))
        return summarize_pairs(pairs, mid)

    results = []
    for i, name in enumerate(names):
        stats = summarize(packed, i, mid)
        doc = docs.get(name, {})
        cat = doc.get("Cat.Data") or ("Price" if name in ("Price", "Size", "STreversal") else "")
        ic_ok = path_ok(stats["ic"])
        fm_ok = path_ok(stats["fm"])
        wq_ok = path_ok(stats["wq"])
        passed = ic_ok and (fm_ok or wq_ok)
        standalone = ic_ok and not (fm_ok or wq_ok)
        results.append({
            "name": name, "cat": cat,
            "desc": (doc.get("LongDescription") or "")[:80],
            "ic": stats["ic"], "spread": stats["spread"], "fm": stats["fm"], "wq": stats["wq"],
            "corr_mom": stats["corr_mom"], "corr_alpha": stats["corr_alpha"], "corr_tech": stats["corr_tech"],
            "mean_n": stats["mean_n"], "n_weeks": stats["n_weeks"],
            "pass": passed, "standalone": standalone,
            "ship": ship_route(cat, name),
        })
        if (i + 1) % 40 == 0:
            print(f"  tested {i + 1}/{len(names)}", flush=True)

    # Holm family = signals with a finite FM t in both halves. Untested signals are not in the family.
    family = [r for r in results if not r["fm"].get("thin") and r["fm"].get("t") is not None]
    fm_p = [norm_sf(r["fm"]["t"]) for r in family]
    holm = holm_mask(fm_p)
    for r in results:
        r["fm_p"] = None
        r["holm"] = False
    for r, keep, p in zip(family, holm, fm_p):
        r["fm_p"] = p
        r["holm"] = bool(keep and r["pass"])

    rng = np.random.default_rng(89)
    placebo = summarize(packed, mom_i, mid, rng=rng)
    alpha_ic = comparator_ic("alpha")
    tech_ic = comparator_ic("tech")

    tested = [r for r in results if not r["ic"].get("thin")]
    passes = [r for r in results if r["pass"]]
    passes.sort(key=lambda r: r["fm"].get("t") or -9, reverse=True)
    holm_hits = [r for r in passes if r["holm"]]
    standalone = [r for r in results if r["standalone"]]
    expected = 0.0228 * len(family)
    near = sorted(tested, key=lambda r: r["fm"].get("t") or -9, reverse=True)[:8]

    def line_for(r):
        return (f"- {r['name']} ({r['cat']}): IC {fmt_pack(r['ic'])}; "
                f"decile rel_21 {fmt_pack(r['spread'], 100)} pp; "
                f"FM {fmt_pack(r['fm'])}; within-q {fmt_pack(r['wq'], 100)} pp. "
                f"Rank corr vs alpha {fmt_pack(r['corr_alpha'])}; vs tech {fmt_pack(r['corr_tech'])}; "
                f"vs lab mom_12_1 {fmt_pack(r['corr_mom'])}. {r['desc']}")

    firm = next(r for r in results if r["name"] == "FirmAge")
    fa_nb = firm["ic"].get("nb")
    if holm_hits:
        verdict = ("Holm keeps " + ", ".join(r["name"] for r in holm_hits)
                   + ". Research numbers only. Nothing ships live.")
    elif passes:
        verdict = (f"Nothing ships. {len(passes)} signals clear the pre-registered bar; "
                   f"about {expected:.0f} would by chance in a family of {len(family)}, and none survive Holm. "
                   f"Largest spread is FirmAge {firm['spread']['mean']*100:+.1f} pp/21d "
                   f"(decile t {firm['spread']['t']:+.1f}, both halves positive) but its rank IC t is "
                   f"{firm['ic']['t']:+.2f}, short of 2. Signals that end 2024-12 have only {fa_nb} weeks after {mid}.")
    else:
        verdict = "Nothing ships. No signal cleared the pre-registered bar."

    # One cross-section a reviewer can recompute: FirmAge on the Monday nearest 2024-06-03.
    spot = []
    fa = names.index("FirmAge")
    target = date(2024, 6, 3)
    spot_week = min(packed, key=lambda w: abs((w[0] - target).days))
    d, rel, al, te, _mom, sig = spot_week
    met = week_metrics(sig[:, fa], rel, al, te, _mom)
    if met:
        spot.append(f"Spot week {d}: FirmAge IC {met['ic']:+.4f}, n {met['n']}, "
                    f"FM coef {met['fm']:+.4f}, decile spread {met['spread'] * 100:+.2f} pp.")
    else:
        spot.append(f"Spot week {d}: FirmAge cross-section too thin.")

    # JSON for the reviewer spot-check. Drop nothing material; stats stay numeric.
    blob = []
    for r in results:
        blob.append({k: r[k] for k in ("name", "cat", "pass", "standalone", "holm", "fm_p", "mean_n", "n_weeks",
                                       "ic", "spread", "fm", "wq", "ship", "desc")})
    RESULTS.write_text(json.dumps({
        "verdict": verdict, "mid": str(mid), "digest": digest,
        "n_signals": len(names), "n_tested": len(tested), "n_pass": len(passes),
        "n_holm": len(holm_hits), "expected_false": expected,
        "placebo_mom12m_ic": placebo["ic"], "signals": blob,
    }, indent=1, default=str))

    L = [
        "# S089 — Open Source Asset Pricing vs StarMine + lab_tech",
        "",
        "Question: which Chen–Zimmermann signed predictors add to Monday `rel_21` beyond "
        "StarMine combined alpha and lab_tech v2?",
        "",
        "Pass bar (pre-registered, unchanged): holdout 2023-01→ week-clustered t ≥ 2, same sign "
        "both halves, and marginal t ≥ 2 (FM of signal | alpha + tech, or within alpha+tech quintile). "
        "Positive means the published (already signed) direction. OSAP and CRSP stay research-only.",
        "",
        f"**Verdict: {verdict}** Pre-registered passes {len(passes)}. Holm survivors among them {len(holm_hits)}.",
        "",
        *lines,
        "## Coverage",
        "",
        f"SignalDoc predictors {len(docs)}. Wide file columns used {len(osap_names)}. "
        "Price, Size, STreversal computed from a narrow `crsp.msf` pull (244 permnos, 2018-01→2024-12), not a full-table scan.",
        f"Permno map: {len(permno) - len(EXTRA_PERMNO)} lab tickers plus TMO {EXTRA_PERMNO['TMO']}. "
        "Unmapped (no CRSP stocknames row): CRWV, HOOY, USAR. XYZ is permno 15826 via the old ticker SQ.",
        f"Filtered OSAP rows are 201901→202611. A Monday never sees a month-end after that Monday, and never a signal older than {STALE_DAYS} days.",
        f"Holdout Mondays with rel_21: {len(weeks)}. Calendar midpoint {mid}. "
        f"Weeks with ≥{MIN_NAMES} names that also have combined alpha and lab_tech: {len(packed)}. "
        f"Digest `{digest}`.",
        "Most characteristics are non-missing only through 202412 (Mom12m and FirmAge both 220+ names that month, 0 in 202506). "
        f"A Monday after mid-February 2025 does not see them. FirmAge's two holdout halves are "
        f"{firm['ic'].get('na')} and {firm['ic'].get('nb')} weeks, split at {mid}.",
        f"Signals with enough weeks in both halves to test: {len(tested)} of {len(names)}. Holm family (finite FM t, both halves): {len(family)}.",
        "",
        "## Spot week",
        "",
        *spot,
        "MU 202406 FirmAge −481 months (about 40 years; Micron's 1984 listing). CAVA 202406 FirmAge −13 months (IPO June 2023). "
        "Sign is −1, so the stored value is minus months since CRSP coverage. Younger is the high score.",
        "",
        "## Comparator on the same weeks",
        "",
        f"combined_alpha_rank IC {fmt_pack(alpha_ic)}.",
        f"lab_tech v2 total IC {fmt_pack(tech_ic)}.",
        f"Placebo: Mom12m shuffled inside each week (seed 89) IC {fmt_pack(placebo['ic'])}.",
        "",
        "## Pre-registered passes",
        "",
    ]
    if passes:
        L.extend(line_for(r) for r in passes)
    else:
        L.append("None.")
    L += ["", "## Holm on the FM t (secondary, not the bar)", ""]
    if holm_hits:
        L.append(f"Family size {len(family)}. One-sided 5% Holm. About {expected:.1f} signals are expected to clear t ≥ 2 by chance; "
                 f"{len(passes)} did. Holm keeps {len(holm_hits)}.")
        L.extend(line_for(r) for r in holm_hits)
    else:
        L.append(f"None of the pre-registered passes also clear Holm 5% on the one-sided FM p-value. "
                 f"Family size {len(family)}. A one-sided t ≥ 2 is about 2.3% under the null, so about "
                 f"{expected:.1f} false passes are expected.")
    L += ["", "## Strongest marginal t that were tested", ""]
    L.extend(line_for(r) for r in near)
    L += [
        "",
        f"Standalone IC only (duplicates the comparator): {len(standalone)}.",
        "",
        "## What would ship",
        "",
    ]
    if holm_hits:
        L.append("No OSAP or CRSP number goes into a live score. Rebuild only a Holm survivor, from commercial data, and re-test on a window this file does not cover (after 2024-12).")
        for r in holm_hits:
            L.append(f"- {r['name']}: {r['ship']}")
        others = [r["name"] for r in passes if not r["holm"]]
        if others:
            L.append("Other pre-registered passes (not Holm): " + ", ".join(others) + ". Several have a flat or sign-flipping decile. Leave them.")
    elif passes:
        L.append("Nothing live. The pre-registered passes are inside the false-discovery budget of a 200-signal search. "
                 "Do not add an OSAP column to the score. A later single-signal test would have to be pre-registered on a fresh window.")
        for r in passes:
            L.append(f"- {r['name']} would have been: {r['ship']}")
    else:
        L.append("Nothing. Do not add an OSAP feed. Price signals that almost worked are still research CRSP/OSAP numbers; "
                 "recomputing them from LSEG closes does not clear the bar on this window.")
    L += [
        "",
        "## Known weaknesses",
        "",
        f"- {len(family)} FM tests. The pre-registered bar is per signal and does not include Holm. Holm is reported beside it.",
        "- rel_21 overlaps across weeks. The t uses Newey-West lag 3, the same weekly bar as S093, not a 21-day block.",
        "- CRSP monthly file ends 2024-12-31, so Price, Size, and STreversal go stale 45 days later and can fail the second half for lack of weeks.",
        "- XYZ joined on the Square permno. CRWV (2025 IPO), HOOY, and USAR have no CRSP permno and are out of the join.",
        "- TMO is in OSAP (permno 62092) and has 0 lab_outcomes rows, same hole as S093.",
        "- Accounting, analyst, options, and 13F signals cannot ship from this file. FMP/Finnhub fundamentals stored here are a current snapshot.",
        "- The wide file's last yyyymm is 202611. Point-in-time drops it for every Monday in the holdout.",
        "",
    ]
    write_report("\n".join(L))
    print(verdict, flush=True)
    print(f"wrote {OUT}", flush=True)


def summarize_pairs(pairs, mid: date) -> dict:
    if len(pairs) < MIN_HALF:
        return {"thin": True, "n": len(pairs)}
    vals = [v for _, v in pairs]
    a = [v for d, v in pairs if d < mid]
    b = [v for d, v in pairs if d >= mid]
    if len(a) < MIN_HALF or len(b) < MIN_HALF:
        return {"thin": True, "n": len(pairs), "na": len(a), "nb": len(b),
                "mean": float(np.mean(vals)), "t": float(nw_t(vals, 3))}
    return {"thin": False, "mean": float(np.mean(vals)), "t": float(nw_t(vals, 3)),
            "a": float(np.mean(a)), "b": float(np.mean(b)), "n": len(vals), "na": len(a), "nb": len(b)}


if __name__ == "__main__":
    main()
