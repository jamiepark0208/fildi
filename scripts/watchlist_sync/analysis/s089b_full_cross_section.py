"""S089b — OSAP + JKP on the full US common cross-section, then Fildi confirm (A262).

Question: which Chen–Zimmermann predictors and which of the 153 Jensen–Kelly–Pedersen
characteristics predict the next month's stock-specific return on all US common
stocks (2005–2024), after Holm 5%, and which of those survivors still add to
Monday rel_21 on the Fildi book from 2023 on?

Discovery (pre-registered in A262 Claude review wave 1 — not changed here):
  Universe = JKP contrib_global_factor.global_factor, USA, common = 1,
  primary_sec = 1, crsp_shrcd in (10, 11), crsp_exchcd in (1, 2, 3),
  one row per permno-month. Signal months 200501–202411.
  Target = next-month beta residual: ret_{t+1} − beta_t × VW_{t+1}.
  beta_t is the 36-month OLS of ret on the lagged-me value-weighted market,
  ending at t, needing ≥ 24 months. |beta| > 5 is dropped.
  Returns are JKP ret (their CRSP series, delisting fix included). No second
  CRSP scan. No OptionMetrics.
  OSAP = signed predictors in signed_predictors_dl_wide (Predictor rows only).
  JKP = the 153 names in bkelly-lab/ReplicationCrisis portfolios.R, multiplied
  by Factor Details.xlsx direction so a high value is the published long side.
  Monthly Spearman IC, top−bottom decile, univariate FM slope of the residual
  rank on the signal rank. Newey–West lag 3. Family = signals with ≥ 24 months
  in each half (split at the midpoint signal month). Holm 5% one-sided on the
  FM t. Overlap is reported, not dropped.
  Price ≥ $5 is a robustness check, not the bar.
  ret_exc_lead1m is a sanity check for momentum only. It is not a second search.

Confirm (INDEX bar, unchanged):
  Holm survivors only, on watchlist_sync.lab_outcomes rel_21, Mondays,
  holdout 2023-01 →, same as-of rule as S089 (≤ 45 days). PASS = week-clustered
  t ≥ 2, same sign both halves, and marginal t ≥ 2 (FM given combined alpha +
  lab_tech v2, or within that quintile). A discovery hit that fails here does
  not ship. OSAP, JKP, and the CRSP history inside JKP are research-only.

Caches (gitignored, under out/studies/s089b/): jkp_us.npz, osap_us.npz.
OSAP zip and the Fildi extract stay in out/studies/osap/ (S089).

Run (from scripts/watchlist_sync):
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s089b_full_cross_section.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s089b_full_cross_section.py
"""
from __future__ import annotations

import csv
import json
import math
import os
import subprocess
import sys
import zipfile
from pathlib import Path

for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_k, "4")

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from lab import nw_t  # noqa: E402
from s045_put_retest import rank as rank_ref  # noqa: E402
from s089_osap_signals import (  # noqa: E402
    CACHE as OSAP_CACHE,
    build_weeks,
    load_docs,
    load_panel,
    load_permno,
    path_ok,
    summarize,
)

SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
HAND_PERM = 53613
HAND_YM = 202406
HAND_MOM = 0.991887502239402
DISC_LO, DISC_HI = 200501, 202411
PULL_LO, PULL_HI = 200201, 202512
MIN_NAMES = 200
MIN_HALF = 24
BETA_WIN = 36
BETA_MIN = 24
BETA_CAP = 5.0
STALE_OK = 1e-4
CACHE = ROOT / "out" / "studies" / "s089b"
OUT = ROOT / "out" / "studies" / "S089b.md"
JKP_NPZ = CACHE / "jkp_us.npz"
OSAP_NPZ = CACHE / "osap_us.npz"
WRDS_PY = REPO / "research" / "wrds" / ".venv" / "bin" / "python"
WRDS_CWD = REPO / "research" / "wrds"

# Published direction: +1 means the raw characteristic is already the long side.
# Source: ReplicationCrisis/GlobalFactors/Factor%20Details.xlsx column `direction`,
# names = the 153 in portfolios.R `chars`.
SIGNS: dict[str, int] = {}
NAMES: dict[str, str] = {}


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


def month_span(a: int, b: int) -> list[int]:
    out = []
    ym = a
    while ym <= b:
        out.append(ym)
        ym = add_months(ym, 1)
    return out


def rank01(x: np.ndarray) -> np.ndarray:
    """Average ranks scaled 0..1. Same as s045 rank()."""
    x = np.asarray(x, float)
    n = len(x)
    order = np.argsort(x, kind="mergesort")
    ranks = np.empty(n, np.float64)
    ranks[order] = np.arange(n)
    xs = x[order]
    if n > 1:
        change = np.flatnonzero(np.diff(xs)) + 1
        starts = np.r_[0, change]
        ends = np.r_[change, n]
        for s, e in zip(starts, ends):
            if e > s + 1:
                ranks[order[s:e]] = 0.5 * (s + e - 1)
    return ranks / max(1, n - 1)


def assert_rank() -> None:
    x = np.array([1.0, 2.0, 2.0, 5.0, 5.0, 9.0])
    if not np.allclose(rank01(x), rank_ref(x)):
        raise SystemExit("rank01 disagrees with the S045 rank helper")


def norm_sf(t: float) -> float:
    if t is None or not math.isfinite(t):
        return 1.0
    return 0.5 * math.erfc(t / math.sqrt(2))


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


def iid_t(v: np.ndarray) -> float:
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    if len(v) < 8:
        return float("nan")
    sd = float(v.std(ddof=1))
    if sd == 0:
        return float("nan")
    return float(v.mean() / (sd / math.sqrt(len(v))))


def one_signal(x: np.ndarray, y: np.ndarray) -> tuple[float, float, float, float, float, int]:
    """IC, FM slope, decile spread, high mean, low mean, n."""
    rx, ry = rank01(x), rank01(y)
    rx_c = rx - rx.mean()
    ry_c = ry - ry.mean()
    vx = float(rx_c @ rx_c)
    vy = float(ry_c @ ry_c)
    ic = float(rx_c @ ry_c / math.sqrt(vx * vy)) if vx > 0 and vy > 0 else float("nan")
    fm = float(rx_c @ ry_c / vx) if vx > 0 else float("nan")
    k = max(1, len(x) // 10)
    order = np.argsort(-x, kind="mergesort")
    hi = float(y[order[:k]].mean())
    lo = float(y[order[-k:]].mean())
    return ic, fm, hi - lo, hi, lo, int(len(x))


def pack_series(yms: np.ndarray, vals: np.ndarray, mid: int) -> dict:
    m = np.isfinite(vals)
    use_ym = yms[m]
    use_v = vals[m]
    if len(use_v) < MIN_HALF:
        return {"thin": True, "n": int(len(use_v))}
    a = use_v[use_ym < mid]
    b = use_v[use_ym >= mid]
    out = {
        "thin": False,
        "mean": float(use_v.mean()),
        "t": float(nw_t(use_v, 3)),
        "iid": iid_t(use_v),
        "n": int(len(use_v)),
        "na": int(len(a)),
        "nb": int(len(b)),
    }
    if len(a):
        out["a"] = float(a.mean())
    if len(b):
        out["b"] = float(b.mean())
    out["halves"] = len(a) >= MIN_HALF and len(b) >= MIN_HALF
    return out


def group_indices(ym: np.ndarray) -> dict[int, np.ndarray]:
    order = np.argsort(ym, kind="mergesort")
    ys = ym[order]
    cut = np.flatnonzero(np.diff(ys)) + 1
    starts = np.r_[0, cut]
    ends = np.r_[cut, len(ys)]
    return {int(ys[s]): order[s:e] for s, e in zip(starts, ends)}


def dedupe_last(perm: np.ndarray, ym: np.ndarray, *cols: np.ndarray) -> tuple[np.ndarray, ...]:
    n = len(perm)
    idx = np.arange(n)
    order = np.lexsort((-idx, ym, perm))
    ps, ys = perm[order], ym[order]
    first = np.empty(n, bool)
    first[0] = True
    first[1:] = (ps[1:] != ps[:-1]) | (ys[1:] != ys[:-1])
    keep = order[first]
    return (perm[keep], ym[keep], *(c[keep] for c in cols))


def wrds_busy() -> str:
    out = subprocess.run(["ps", "aux"], capture_output=True, text=True, check=False).stdout
    hits = []
    for line in out.splitlines():
        if "wrds" in line.lower() and "python" in line.lower() and "s089b" not in line:
            hits.append(line)
    return hits[0][:180] if hits else ""


def pull_jkp() -> None:
    busy = wrds_busy()
    if busy:
        raise SystemExit(f"WRDS already in use — not starting a second job: {busy}")
    CACHE.mkdir(parents=True, exist_ok=True)
    names = list(SIGNS)
    code = r"""
import os, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, ".")
from _auth import connect
dest = Path(os.environ["S089B_OUT"])
names = os.environ["S089B_CHARS"].split(",")
sel = ", ".join(names)
char_sql = ", ".join(f"{n}::float8 AS c_{n}" for n in names)
sql = f'''
SELECT permno::int AS permno,
       to_char(eom, 'YYYYMM') AS ym,
       ret::float8 AS ret,
       ret_exc::float8 AS ret_exc,
       ret_exc_lead1m::float8 AS lead,
       prc::float8 AS prc,
       market_equity::float8 AS me,
       {char_sql}
FROM contrib_global_factor.global_factor
WHERE excntry = 'USA'
  AND common = 1
  AND primary_sec = 1
  AND crsp_shrcd IN (10, 11)
  AND crsp_exchcd IN (1, 2, 3)
  AND eom >= DATE '2002-01-01'
  AND eom < DATE '2026-01-01'
'''
print("query start", len(names), "chars", flush=True)
db = connect()
try:
    df = db.raw_sql(sql)
finally:
    db.close()
print("pulled", len(df), "cols", df.shape[1], flush=True)
ym = df["ym"].map(lambda x: int(str(x)[:6])).to_numpy(np.int32)
perm = df["permno"].to_numpy(np.int32)
def fcol(name):
    return df[name].to_numpy(np.float64)
ret = fcol("ret")
ret_exc = fcol("ret_exc")
lead = fcol("lead")
prc = fcol("prc")
me = fcol("me")
chars = np.column_stack([fcol("c_" + n) for n in names]).astype(np.float32)
del df
# keep the largest market-equity row when a permno-month repeats
n = len(perm)
idx = np.arange(n)
# nan me sorts last so a finite me wins
me_key = np.where(np.isfinite(me), -me, 0.0)
order = np.lexsort((idx, me_key, ym, perm))
ps, ys = perm[order], ym[order]
first = np.empty(n, bool)
first[0] = True
first[1:] = (ps[1:] != ps[:-1]) | (ys[1:] != ys[:-1])
keep = order[first]
print("kept", int(keep.size), "dropped", int(n - keep.size), flush=True)
np.savez(
    dest, permno=perm[keep], ym=ym[keep], ret=ret[keep].astype(np.float32),
    ret_exc=ret_exc[keep].astype(np.float32), lead=lead[keep].astype(np.float32),
    prc=prc[keep].astype(np.float32), me=me[keep].astype(np.float32),
    chars=chars[keep], names=np.array(names),
)
print("saved", dest, flush=True)
"""
    env = os.environ.copy()
    env["S089B_OUT"] = str(JKP_NPZ)
    env["S089B_CHARS"] = ",".join(names)
    env["OMP_NUM_THREADS"] = "4"
    subprocess.run([str(WRDS_PY), "-c", code], cwd=str(WRDS_CWD), env=env, check=True)


def load_jkp() -> dict:
    z = np.load(JKP_NPZ, allow_pickle=False)
    names = [str(x) for x in z["names"].tolist()]
    if names != list(SIGNS):
        raise SystemExit("JKP cache columns do not match SIGNS — delete jkp_us.npz")
    signs = np.array([SIGNS[n] for n in names], np.float32)
    chars = z["chars"].astype(np.float32) * signs
    return {
        "perm": z["permno"].astype(np.int32),
        "ym": z["ym"].astype(np.int32),
        "ret": z["ret"].astype(np.float64),
        "ret_exc": z["ret_exc"].astype(np.float64),
        "lead": z["lead"].astype(np.float64),
        "prc": z["prc"].astype(np.float64),
        "me": z["me"].astype(np.float64),
        "chars": chars,
        "names": names,
    }


def beta_residual(jkp: dict) -> dict:
    months = month_span(PULL_LO, PULL_HI)
    tindex = {ym: i for i, ym in enumerate(months)}
    permnos = np.unique(jkp["perm"])
    pindex = {int(p): i for i, p in enumerate(permnos)}
    p, t = len(permnos), len(months)
    ret_mat = np.full((p, t), np.nan, np.float64)
    me_mat = np.full((p, t), np.nan, np.float64)
    pi = np.fromiter((pindex[int(v)] for v in jkp["perm"]), np.int32, count=len(jkp["perm"]))
    ti = np.fromiter((tindex[int(v)] for v in jkp["ym"]), np.int32, count=len(jkp["ym"]))
    # last write wins; pull already deduped
    ret_mat[pi, ti] = jkp["ret"]
    me_mat[pi, ti] = jkp["me"]
    lag = np.full_like(me_mat, np.nan)
    lag[:, 1:] = me_mat[:, :-1]
    w = np.where(np.isfinite(lag) & (lag > 0) & np.isfinite(ret_mat), lag, 0.0)
    denom = w.sum(0)
    # numerator is sum(lagged me × ret), not the unweighted sum of returns
    num = np.where(w > 0, w * ret_mat, 0.0).sum(0)
    vw = np.full(t, np.nan)
    ok = denom > 0
    vw[ok] = num[ok] / denom[ok]
    beta = np.full((p, t), np.nan, np.float64)
    n_capped = 0
    for i in range(BETA_WIN - 1, t - 1):
        window = slice(i - BETA_WIN + 1, i + 1)
        m = vw[window]
        okm = np.isfinite(m)
        if int(okm.sum()) < BETA_MIN:
            continue
        r = ret_mat[:, window][:, okm]
        m = m[okm]
        both = np.isfinite(r)
        cnt = both.sum(1)
        good = cnt >= BETA_MIN
        r0 = np.where(both, r, 0.0)
        m_row = m[None, :]
        m0 = np.where(both, m_row, 0.0)
        mean_r = np.zeros(p)
        mean_m = np.zeros(p)
        mean_r[good] = r0.sum(1)[good] / cnt[good]
        mean_m[good] = m0.sum(1)[good] / cnt[good]
        rc = np.where(both, r - mean_r[:, None], 0.0)
        mc = np.where(both, m_row - mean_m[:, None], 0.0)
        var = (mc * mc).sum(1)
        cov = (rc * mc).sum(1)
        use = good & (var > 1e-12)
        b = np.full(p, np.nan)
        b[use] = cov[use] / var[use]
        bad = use & (np.abs(b) > BETA_CAP)
        n_capped += int(bad.sum())
        b[bad] = np.nan
        beta[:, i] = b
    resid = np.full((p, t), np.nan, np.float64)
    resid[:, BETA_WIN - 1:-1] = ret_mat[:, BETA_WIN:] - beta[:, BETA_WIN - 1:-1] * vw[BETA_WIN:]
    return {
        "months": months,
        "tindex": tindex,
        "pindex": pindex,
        "permnos": permnos,
        "pi": pi,
        "vw": vw,
        "beta": beta,
        "resid": resid,
        "ret_mat": ret_mat,
        "n_capped": n_capped,
    }


def osap_names() -> list[str]:
    docs = load_docs()
    with zipfile.ZipFile(OSAP_CACHE / "signed_predictors_dl_wide.zip") as z:
        with z.open("signed_predictors_dl_wide.csv") as raw:
            header = raw.readline().decode("utf-8").strip().split(",")
    return [h for h in header if h in docs]


def stream_osap(names: list[str], keep_perm: np.ndarray) -> dict:
    usecols = ["permno", "yyyymm", *names]
    chunks_p, chunks_y, chunks_x = [], [], []
    mom_i = names.index("Mom12m")
    mom_hit = None
    n_in = 0
    with zipfile.ZipFile(OSAP_CACHE / "signed_predictors_dl_wide.zip") as z:
        with z.open("signed_predictors_dl_wide.csv") as raw:
            reader = pd.read_csv(
                raw, usecols=usecols, chunksize=200_000,
                na_values=["NA", "NaN", ""], keep_default_na=True,
                dtype={c: "float32" for c in names}, low_memory=False,
            )
            for i, chunk in enumerate(reader, 1):
                n_in += len(chunk)
                ym = chunk["yyyymm"].to_numpy()
                perm = chunk["permno"].to_numpy()
                m = (ym >= DISC_LO) & (ym <= DISC_HI) & np.isin(perm, keep_perm)
                if not m.any():
                    if i % 20 == 0:
                        print(f"  osap chunks {i} rows seen {n_in}", flush=True)
                    continue
                sub = chunk.loc[m]
                chunks_p.append(sub["permno"].to_numpy(np.int32))
                chunks_y.append(sub["yyyymm"].to_numpy(np.int32))
                chunks_x.append(sub[names].to_numpy(np.float32))
                if mom_hit is None:
                    hit = sub[(sub["permno"] == HAND_PERM) & (sub["yyyymm"] == HAND_YM)]
                    if len(hit):
                        mom_hit = float(hit["Mom12m"].iloc[0])
                if i % 20 == 0:
                    print(f"  osap chunks {i} kept {sum(len(c) for c in chunks_p)}", flush=True)
    if not chunks_p:
        raise SystemExit("OSAP stream kept 0 rows")
    perm = np.concatenate(chunks_p)
    ym = np.concatenate(chunks_y)
    xs = np.concatenate(chunks_x, axis=0)
    before = len(perm)
    perm, ym, xs = dedupe_last(perm, ym, xs)
    print(f"osap rows {before} -> {len(perm)} mom12m float32 {mom_hit}", flush=True)
    np.savez(OSAP_NPZ, permno=perm, ym=ym, chars=xs, names=np.array(names), mom_hit=np.array([mom_hit if mom_hit is not None else np.nan]))
    return {"perm": perm, "ym": ym, "chars": xs, "names": names, "mom_hit": mom_hit}


def load_osap() -> dict:
    z = np.load(OSAP_NPZ, allow_pickle=False)
    mom = z["mom_hit"]
    return {
        "perm": z["permno"].astype(np.int32),
        "ym": z["ym"].astype(np.int32),
        "chars": z["chars"].astype(np.float32),
        "names": [str(x) for x in z["names"].tolist()],
        "mom_hit": None if not np.isfinite(mom[0]) else float(mom[0]),
    }


def mu_mom_csv() -> float | None:
    path = OSAP_CACHE / "signed_predictors_fildi.csv"
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if int(float(row["permno"])) == HAND_PERM and int(row["yyyymm"]) == HAND_YM:
                return float(row["Mom12m"])
    return None


def eval_chars(yms_disc: list[int], mid: int, groups: dict, pi: np.ndarray, panel: dict,
               chars: np.ndarray, extra: np.ndarray | None, min_names: int) -> dict:
    """extra is an aligned per-row vector (lead excess, or raw price) or None."""
    k = chars.shape[1]
    n_m = len(yms_disc)
    ic = np.full((n_m, k), np.nan)
    fm = np.full((n_m, k), np.nan)
    sp = np.full((n_m, k), np.nan)
    nn = np.zeros((n_m, k), np.int32)
    spot = {}
    for t, ym in enumerate(yms_disc):
        ix = groups.get(ym)
        if ix is None:
            continue
        y = panel["resid"][pi[ix], panel["tindex"][ym]]
        x = chars[ix]
        for j in range(k):
            m = np.isfinite(x[:, j]) & np.isfinite(y)
            if int(m.sum()) < min_names:
                continue
            a, b, spr, hi, lo, n = one_signal(np.asarray(x[m, j], float), y[m])
            ic[t, j], fm[t, j], sp[t, j], nn[t, j] = a, b, spr, n
            if ym == HAND_YM and j not in spot:
                pass
            if ym == HAND_YM:
                spot[j] = {"ic": a, "fm": b, "spread": spr, "hi": hi, "lo": lo, "n": n}
        if t and t % 40 == 0:
            print(f"  months {t}/{n_m}", flush=True)
    return {"ic": ic, "fm": fm, "sp": sp, "nn": nn, "spot": spot, "yms": np.array(yms_disc, np.int32)}


def eval_masked(block: dict, mask_ok: np.ndarray, yms_disc, mid, groups, pi, panel, chars, min_names: int) -> np.ndarray:
    """FM t under an extra per-row mask (price >= 5). Returns t per column. Reuses nothing from block."""
    k = chars.shape[1]
    fm = np.full((len(yms_disc), k), np.nan)
    for t, ym in enumerate(yms_disc):
        ix = groups.get(ym)
        if ix is None:
            continue
        y = panel["resid"][pi[ix], panel["tindex"][ym]]
        x = chars[ix]
        ok = mask_ok[ix]
        for j in range(k):
            m = ok & np.isfinite(x[:, j]) & np.isfinite(y)
            if int(m.sum()) < min_names:
                continue
            _ic, slope, _sp, _hi, _lo, _n = one_signal(np.asarray(x[m, j], float), y[m])
            fm[t, j] = slope
    ts = np.full(k, np.nan)
    yms = np.array(yms_disc, np.int32)
    for j in range(k):
        ts[j] = pack_series(yms, fm[:, j], mid).get("t", float("nan"))
    return ts


def sanity_lead(jkp, groups, pi, panel, col: int, yms_disc, mid) -> dict:
    """IC of one signed characteristic vs ret_exc_lead1m, not the adoption target."""
    ic = []
    yms = []
    for ym in yms_disc:
        ix = groups.get(ym)
        if ix is None:
            continue
        x = jkp["chars"][ix, col]
        y = jkp["lead"][ix]
        m = np.isfinite(x) & np.isfinite(y)
        if int(m.sum()) < MIN_NAMES:
            continue
        a, _b, _s, _h, _l, _n = one_signal(np.asarray(x[m], float), y[m])
        ic.append(a)
        yms.append(ym)
    return pack_series(np.array(yms, np.int32), np.array(ic, float), mid)


def placebo_ic(jkp, groups, pi, panel, col: int, yms_disc, mid, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    ic, yms = [], []
    for ym in yms_disc:
        ix = groups.get(ym)
        if ix is None:
            continue
        x = np.asarray(jkp["chars"][ix, col], float).copy()
        y = panel["resid"][pi[ix], panel["tindex"][ym]]
        m = np.isfinite(x) & np.isfinite(y)
        if int(m.sum()) < MIN_NAMES:
            continue
        shuffled = x[m].copy()
        rng.shuffle(shuffled)
        a, _b, _s, _h, _l, _n = one_signal(shuffled, y[m])
        ic.append(a)
        yms.append(ym)
    return pack_series(np.array(yms), np.array(ic, float), mid)


def fmt(p: dict, scale: float = 1.0) -> str:
    if not isinstance(p, dict) or p.get("mean") is None:
        n = p.get("n", 0) if isinstance(p, dict) else 0
        return f"n {n} (thin)"
    halves = "thin halves"
    if p.get("a") is not None and p.get("b") is not None:
        halves = f"{p['a'] * scale:+.4f} / {p['b'] * scale:+.4f} (months {p['na']}/{p['nb']})"
    t = p.get("t")
    t_s = f"{t:+.2f}" if t is not None and math.isfinite(t) else "na"
    return f"mean {p['mean'] * scale:+.4f} NW t {t_s} halves {halves} (n {p['n']})"


def overlap_pairs(osap, jkp, o_groups, j_groups, months: list[int]) -> list[tuple[float, str, str]]:
    """Mean within-month Spearman of signed JKP vs signed OSAP, June of each year."""
    o_names, j_names = osap["names"], jkp["names"]
    acc = np.zeros((len(o_names), len(j_names)), np.float64)
    cnt = np.zeros_like(acc)
    used = 0
    for ym in months:
        oi, ji = o_groups.get(ym), j_groups.get(ym)
        if oi is None or ji is None:
            continue
        # inner join on permno
        op, jp = osap["perm"][oi], jkp["perm"][ji]
        # map jkp perm -> row in this month's j slice
        jmap = {int(p): k for k, p in enumerate(jp)}
        take_o, take_j = [], []
        for k, p in enumerate(op):
            hit = jmap.get(int(p))
            if hit is not None:
                take_o.append(k)
                take_j.append(hit)
        if len(take_o) < MIN_NAMES:
            continue
        A = np.asarray(osap["chars"][oi][take_o], float)
        B = np.asarray(jkp["chars"][ji][take_j], float)
        # rank columns
        for j in range(A.shape[1]):
            m = np.isfinite(A[:, j])
            if m.sum() >= 50:
                A[m, j] = rank01(A[m, j])
                A[~m, j] = np.nan
        for j in range(B.shape[1]):
            m = np.isfinite(B[:, j])
            if m.sum() >= 50:
                B[m, j] = rank01(B[m, j])
                B[~m, j] = np.nan
        for j in range(B.shape[1]):
            b = B[:, j]
            m = np.isfinite(b)
            if int(m.sum()) < MIN_NAMES:
                continue
            a = A[m]
            bb = b[m]
            finite = np.isfinite(a)
            n = finite.sum(0).astype(float)
            aa = np.where(finite, a, 0.0)
            sum_a = aa.sum(0)
            sum_b = (bb[:, None] * finite).sum(0)
            good = n >= MIN_NAMES
            mean_a = np.zeros(A.shape[1])
            mean_b = np.zeros(A.shape[1])
            mean_a[good] = sum_a[good] / n[good]
            mean_b[good] = sum_b[good] / n[good]
            ac = np.where(finite, a - mean_a, 0.0)
            bc = np.where(finite, bb[:, None] - mean_b, 0.0)
            cov = (ac * bc).sum(0)
            sa = np.sqrt((ac * ac).sum(0))
            sb = np.sqrt((bc * bc).sum(0))
            ok = good & (sa > 0) & (sb > 0)
            corr = np.full(A.shape[1], np.nan)
            corr[ok] = cov[ok] / (sa[ok] * sb[ok])
            finite_c = np.isfinite(corr)
            acc[finite_c, j] += corr[finite_c]
            cnt[finite_c, j] += 1
        used += 1
        print(f"  overlap {ym} n {len(take_o)}", flush=True)
    with np.errstate(invalid="ignore"):
        mean = acc / np.maximum(cnt, 1)
    mean[cnt == 0] = np.nan
    pairs = []
    for i, on in enumerate(o_names):
        j = int(np.nanargmax(np.abs(mean[i]))) if np.isfinite(mean[i]).any() else None
        if j is None:
            continue
        c = float(mean[i, j])
        if abs(c) >= 0.80:
            pairs.append((c, on, j_names[j]))
    pairs.sort(key=lambda z: -abs(z[0]))
    return pairs, used


def ship_line(source: str, name: str, cat: str) -> str:
    priceish = name in {
        "Mom12m", "Mom6m", "MomSeason", "STreversal", "MRreversal", "MaxRet", "Beta",
        "IdioVolAHT", "High52", "ResidualMomentum", "FirmAge", "Price", "Size",
    } or name.startswith(("ret_", "seas_", "resff", "rmax", "rvol", "ivol_", "beta", "iskew", "rskew", "coskew")) or name in {
        "prc", "market_equity", "age", "bidaskhl_21d", "dolvol_126d", "dolvol_var_126d",
        "turnover_126d", "turnover_var_126d", "zero_trades_21d", "zero_trades_126d",
        "zero_trades_252d", "ami_126d", "corr_1260d", "prc_highprc_252d",
    }
    if source == "OSAP" and cat == "Price" or priceish:
        return "research series cannot ship; a live version is recomputed from LSEG closes (or an IPO date for age)"
    return ("research series cannot ship. Finnhub metric=all and FMP ratios (inventory #8–9) "
            "are a current snapshot, not a 2005–2024 panel")


def fildi_panels(survivors: list[dict], osap, jkp, permno: dict[str, int]) -> dict:
    want = {int(p) for p in permno.values()}
    labels = [s["label"] for s in survivors]
    # ym -> list later stacked per perm
    bag: dict[int, dict[int, np.ndarray]] = {p: {} for p in want}

    def slot(perm: int, ym: int) -> np.ndarray:
        row = bag[perm].get(ym)
        if row is None:
            row = np.full(len(survivors), np.nan, np.float64)
            bag[perm][ym] = row
        return row

    o_index = {n: i for i, n in enumerate(osap["names"])}
    j_index = {n: i for i, n in enumerate(jkp["names"])}
    for s_i, s in enumerate(survivors):
        if s["source"] == "OSAP":
            col = o_index[s["name"]]
            m = np.isin(osap["perm"], list(want))
            for p, ym, val in zip(osap["perm"][m], osap["ym"][m], osap["chars"][m, col]):
                if int(p) in bag and np.isfinite(val):
                    slot(int(p), int(ym))[s_i] = float(val)
        else:
            col = j_index[s["name"]]
            m = np.isin(jkp["perm"], list(want))
            # chars already signed; include months after the discovery window (2025)
            for p, ym, val in zip(jkp["perm"][m], jkp["ym"][m], jkp["chars"][m, col]):
                if int(p) in bag and np.isfinite(val):
                    slot(int(p), int(ym))[s_i] = float(val)
    panels = {}
    for p, by in bag.items():
        if not by:
            continue
        yms = sorted(by)
        mat = np.vstack([by[ym] for ym in yms])
        panels[p] = (np.asarray(yms, np.int32), mat)
    return panels


def hand_mu_csv_lines() -> tuple[list[str], bool]:
    mom = mu_mom_csv()
    ok = mom is not None and abs(mom - HAND_MOM) < 1e-6
    lines = [
        f"MU permno {HAND_PERM} OSAP yyyymm {HAND_YM} Mom12m from the S089 Fildi extract = "
        f"{mom if mom is not None else 'MISSING'}.",
        f"S089 CRSP product of lags 1–11 = {HAND_MOM}. Gap {None if mom is None else mom - HAND_MOM:+.3e}. Match {ok}.",
    ]
    return lines, ok


def smoke() -> None:
    assert_rank()
    lines, ok = hand_mu_csv_lines()
    permno = load_permno()
    from build_plan import connect
    conn = connect()
    print("Smoke names:")
    wanted = []
    for t in SMOKE:
        p = permno.get(t)
        lab = conn.execute("SELECT count(*) FROM watchlist_sync.lab_outcomes WHERE ticker = %s", (t,)).fetchone()[0]
        print(f"- {t}: permno {p if p else 'none'}; lab_outcomes rows {lab}")
        if p:
            wanted.append(int(p))
    conn.close()
    if wrds_busy():
        raise SystemExit("WRDS already in use — smoke not started")
    code = r"""
import os, sys
sys.path.insert(0, ".")
from _auth import connect
perms = os.environ["S089B_PERMS"]
sql = f'''
SELECT permno::int AS permno, to_char(eom, 'YYYYMM') AS ym,
       ret::float8 AS ret, ret_exc::float8 AS ret_exc, ret_exc_lead1m::float8 AS lead,
       ret_12_1::float8 AS ret_12_1, at_gr1::float8 AS at_gr1,
       prc::float8 AS prc, market_equity::float8 AS me,
       crsp_shrcd::int AS shrcd, crsp_exchcd::int AS exchcd,
       common::int AS common, primary_sec::int AS primary_sec
FROM contrib_global_factor.global_factor
WHERE excntry = 'USA' AND permno IN ({perms})
  AND eom >= DATE '2023-01-01' AND eom < DATE '2025-02-01'
ORDER BY permno, eom
'''
db = connect()
try:
    df = db.raw_sql(sql)
finally:
    db.close()
df.to_csv(os.environ["S089B_SMOKE_CSV"], index=False)
print("smoke rows", len(df), flush=True)
"""
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / "smoke_rows.csv"
    env = os.environ.copy()
    env["S089B_PERMS"] = ",".join(str(p) for p in wanted)
    env["S089B_SMOKE_CSV"] = str(dest)
    subprocess.run([str(WRDS_PY), "-c", code], cwd=str(WRDS_CWD), env=env, check=True)
    rows = list(csv.DictReader(dest.open()))
    by = {}
    for r in rows:
        by.setdefault(int(r["permno"]), []).append(r)
    print("\n".join(lines))
    mu = {int(r["ym"]): r for r in by.get(HAND_PERM, [])}
    june, july = mu.get(HAND_YM), mu.get(202407)
    lead_ok = False
    if june and july and june["lead"] not in ("", "nan") and july["ret_exc"] not in ("", "nan"):
        gap = float(june["lead"]) - float(july["ret_exc"])
        lead_ok = abs(gap) < STALE_OK
        print(f"MU 202406 ret_12_1 = {float(june['ret_12_1']):.12f}. OSAP Mom12m − JKP = {HAND_MOM - float(june['ret_12_1']):+.6f}.")
        print(f"MU 202406 ret_exc_lead1m = {float(june['lead']):.8f}. 202407 ret_exc = {float(july['ret_exc']):.8f}. Gap {gap:+.3e}. Match {lead_ok}.")
        print(f"MU 202406 at_gr1 raw = {june['at_gr1']} signed (× {SIGNS['at_gr1']}) = {float(june['at_gr1']) * SIGNS['at_gr1'] if june['at_gr1'] not in ('', 'nan') else 'NA'}.")
        print(f"MU 202406 prc = {june['prc']} market_equity = {june['me']} shrcd {june['shrcd']} exch {june['exchcd']} common {june['common']} primary {june['primary_sec']}.")
    else:
        print("MU June/July 2024 rows missing from the narrow pull.")
    mom_gap_ok = True
    if june and june["ret_12_1"] not in ("", "nan"):
        mom_gap_ok = abs(HAND_MOM - float(june["ret_12_1"])) < 0.02
    for t in SMOKE:
        p = permno.get(t)
        rs = by.get(int(p), []) if p else []
        if not rs:
            print(f"- {t}: JKP rows 0")
            continue
        yms = [int(r["ym"]) for r in rs]
        keep = [r for r in rs if r["shrcd"] in ("10", "11") and r["exchcd"] in ("1", "2", "3") and r["common"] == "1" and r["primary_sec"] == "1"]
        print(f"- {t}: JKP months {len(rs)} {yms[0]}→{yms[-1]}; pass US-common filter {len(keep)}.")
    if not (ok and lead_ok and mom_gap_ok):
        raise SystemExit("hand-check failed")
    print("smoke ok")


def describe(block, names, source, docs, mid) -> list[dict]:
    yms = block["yms"]
    out = []
    for j, name in enumerate(names):
        ic = pack_series(yms, block["ic"][:, j], mid)
        fm = pack_series(yms, block["fm"][:, j], mid)
        sp = pack_series(yms, block["sp"][:, j], mid)
        cat = ""
        desc = NAMES.get(name, "")
        if source == "OSAP":
            doc = docs.get(name, {})
            cat = doc.get("Cat.Data") or ""
            desc = (doc.get("LongDescription") or "")[:80]
        out.append({
            "source": source, "name": name, "label": f"{source}:{name}",
            "cat": cat, "desc": desc, "ic": ic, "fm": fm, "sp": sp,
            "spot": block["spot"].get(j),
            "ship": ship_line(source, name, cat),
        })
    return out


def validate_signs() -> None:
    if len(SIGNS) != 153:
        raise SystemExit(f"expected 153 JKP signs, got {len(SIGNS)}")
    if SIGNS.get("at_gr1") != -1 or SIGNS.get("ret_12_1") != 1 or SIGNS.get("ret_1_0") != -1:
        raise SystemExit("JKP signs failed the momentum / asset-growth check")


def main() -> None:
    validate_signs()
    if "--smoke" in sys.argv:
        smoke()
        return
    assert_rank()
    if not JKP_NPZ.exists():
        print("pulling JKP (one WRDS query)", flush=True)
        pull_jkp()
    jkp = load_jkp()
    print(f"jkp rows {len(jkp['perm'])} names {len(jkp['names'])}", flush=True)
    if not (500_000 <= len(jkp["perm"]) <= 3_000_000):
        raise SystemExit(f"unexpected JKP row count {len(jkp['perm'])}")
    print("beta residual", flush=True)
    panel = beta_residual(jkp)
    lines, ok = hand_mu_csv_lines()
    # lead identity and beta arithmetic on the full pull
    j_groups = group_indices(jkp["ym"])
    ix = j_groups.get(HAND_YM)
    mu_rows = ix[jkp["perm"][ix] == HAND_PERM] if ix is not None else np.array([], np.int32)
    july = j_groups.get(202407)
    mu_july = july[jkp["perm"][july] == HAND_PERM] if july is not None else np.array([], np.int32)
    lead_ok = False
    beta_ok = False
    if len(mu_rows) == 1 and len(mu_july) == 1:
        r = int(mu_rows[0])
        lead = float(jkp["lead"][r])
        nxt = float(jkp["ret_exc"][int(mu_july[0])])
        gap = lead - nxt
        lead_ok = abs(gap) < STALE_OK
        ti = panel["tindex"][HAND_YM]
        pi = panel["pindex"][HAND_PERM]
        b = float(panel["beta"][pi, ti])
        vw = float(panel["vw"][panel["tindex"][202407]])
        ret_n = float(panel["ret_mat"][pi, panel["tindex"][202407]])
        resid = float(panel["resid"][pi, ti])
        recon = ret_n - b * vw
        beta_ok = math.isfinite(resid) and abs(resid - recon) < 1e-8
        raw_mom = float(jkp["chars"][r, jkp["names"].index("ret_12_1")] / SIGNS["ret_12_1"])
        lines.append(f"MU 202406 JKP ret_12_1 raw = {raw_mom:.12f}. OSAP − JKP = {HAND_MOM - raw_mom:+.6f}.")
        lines.append(f"MU 202406 ret_exc_lead1m = {lead:.8f}. 202407 ret_exc = {nxt:.8f}. Gap {gap:+.3e}. Match {lead_ok}.")
        lines.append(f"MU beta through 202406 = {b:.6f}. VW 202407 = {vw:.8f}. MU ret 202407 = {ret_n:.8f}.")
        lines.append(f"Residual = ret − beta×VW = {recon:.8f}. Stored {resid:.8f}. Match {beta_ok}.")
        n_res = int(np.isfinite(panel["resid"][:, ti]).sum())
        lines.append(f"Names with a finite residual in 202406: {n_res}. Beta |b|>{BETA_CAP:g} dropped (stock-months) {panel['n_capped']}.")
        if n_res < 1000 or not (0.2 <= b <= 4):
            beta_ok = False
            lines.append(f"Beta residual coverage or MU beta {b:.3f} is not a usable market residual.")
    else:
        lines.append("MU 202406/202407 missing from the JKP pull.")
    print("\n".join(lines), flush=True)
    if not (ok and lead_ok and beta_ok):
        raise SystemExit("hand-check failed — full test not run")

    names = osap_names()
    if OSAP_NPZ.exists():
        osap = load_osap()
        if osap["names"] != names:
            print("OSAP cache columns differ — re-streaming", flush=True)
            osap = stream_osap(names, np.unique(jkp["perm"]))
    else:
        print(f"streaming OSAP ({len(names)} predictors)", flush=True)
        osap = stream_osap(names, np.unique(jkp["perm"]))
    if osap["mom_hit"] is None or abs(osap["mom_hit"] - HAND_MOM) > 1e-4:
        raise SystemExit(f"wide-file Mom12m {osap['mom_hit']} is not the CRSP product")
    mom_i = osap["names"].index("Mom12m")
    # float32 of the known value
    ix = group_indices(osap["ym"]).get(HAND_YM)
    hit = ix[osap["perm"][ix] == HAND_PERM]
    streamed = float(osap["chars"][int(hit[0]), mom_i]) if len(hit) else float("nan")
    if not math.isfinite(streamed) or abs(streamed - HAND_MOM) > 1e-4:
        raise SystemExit(f"streamed Mom12m {streamed} disagrees with {HAND_MOM}")

    disc = [ym for ym in panel["months"] if DISC_LO <= ym <= DISC_HI]
    mid = disc[len(disc) // 2]
    print(f"discovery months {len(disc)} {disc[0]}→{disc[-1]} midpoint {mid}", flush=True)
    o_groups = group_indices(osap["ym"])
    print("OSAP cross-section", flush=True)
    o_pi = np.fromiter((panel["pindex"].get(int(p), -1) for p in osap["perm"]), np.int32, count=len(osap["perm"]))
    if np.any(o_pi < 0):
        raise SystemExit("OSAP permno missing from the JKP panel")
    o_block = eval_chars(disc, mid, o_groups, o_pi, panel, osap["chars"], None, MIN_NAMES)
    print("JKP cross-section", flush=True)
    j_pi = np.fromiter((panel["pindex"][int(p)] for p in jkp["perm"]), np.int32, count=len(jkp["perm"]))
    j_block = eval_chars(disc, mid, j_groups, j_pi, panel, jkp["chars"], None, MIN_NAMES)

    docs = load_docs()
    rows = describe(o_block, osap["names"], "OSAP", docs, mid) + describe(j_block, jkp["names"], "JKP", docs, mid)
    family = [r for r in rows if r["fm"].get("halves") and r["fm"].get("t") is not None and math.isfinite(r["fm"]["t"])]
    pvals = [norm_sf(r["fm"]["t"]) for r in family]
    keep = holm_mask(pvals)
    for r, k, p in zip(family, keep, pvals):
        r["holm"] = bool(k)
        r["p"] = p
    for r in rows:
        r.setdefault("holm", False)
    hits = [r for r in family if r["holm"]]
    hits.sort(key=lambda r: -(r["fm"]["t"] or -9))

    # price >= 5 FM t for the whole family is expensive; compute for hits + momentum names only
    # plus a full pass would double the runtime. Robustness on every family member with |t|>=2
    # and on ret_12_1 / Mom12m, using one extra pass over those columns only.
    focus = []
    for r in rows:
        if r["holm"] or (r["fm"].get("t") or -9) >= 2 or r["name"] in ("ret_12_1", "Mom12m", "FirmAge", "age"):
            focus.append(r)
    print(f"price>=5 robustness on {len(focus)} signals", flush=True)
    price_t = {}
    # rebuild per source once, masked
    prc_ok = np.isfinite(jkp["prc"]) & (np.abs(jkp["prc"]) >= 5)
    if any(r["source"] == "JKP" for r in focus):
        cols = [jkp["names"].index(r["name"]) for r in focus if r["source"] == "JKP"]
        # eval only those columns by slicing chars
        sub = jkp["chars"][:, cols]
        ts = eval_masked(j_block, prc_ok, disc, mid, j_groups, j_pi, panel, sub, MIN_NAMES)
        for r, t in zip([r for r in focus if r["source"] == "JKP"], ts):
            price_t[r["label"]] = float(t)
    if any(r["source"] == "OSAP" for r in focus):
        # OSAP has no price column on the row. Join JKP price onto OSAP rows.
        j_price = {}
        for p, ym, pr in zip(jkp["perm"], jkp["ym"], jkp["prc"]):
            if DISC_LO <= int(ym) <= DISC_HI:
                j_price[(int(p), int(ym))] = pr
        op = np.array([j_price.get((int(p), int(ym)), np.nan) for p, ym in zip(osap["perm"], osap["ym"])])
        op_ok = np.isfinite(op) & (np.abs(op) >= 5)
        cols = [osap["names"].index(r["name"]) for r in focus if r["source"] == "OSAP"]
        ts = eval_masked(o_block, op_ok, disc, mid, o_groups, o_pi, panel, osap["chars"][:, cols], MIN_NAMES)
        for r, t in zip([r for r in focus if r["source"] == "OSAP"], ts):
            price_t[r["label"]] = float(t)

    ret_i = jkp["names"].index("ret_12_1")
    lead_mom = sanity_lead(jkp, j_groups, j_pi, panel, ret_i, disc, mid)
    plac = placebo_ic(jkp, j_groups, j_pi, panel, ret_i, disc, mid, 89)
    mom_pack = next(r for r in rows if r["label"] == "OSAP:Mom12m")
    ret_pack = next(r for r in rows if r["label"] == "JKP:ret_12_1")

    print("overlap (each June)", flush=True)
    jun = [ym for ym in disc if ym % 100 == 6]
    pairs, n_ov = overlap_pairs(osap, jkp, o_groups, j_groups, jun)

    # Fildi confirm
    confirm = []
    digest = None
    fildi_mid = None
    if hits:
        print(f"Fildi confirm on {len(hits)} Holm survivors", flush=True)
        permno = load_permno()
        panels = fildi_panels(hits, osap, jkp, permno)
        from build_plan import connect
        conn = connect()
        digest, outcomes, tech, alpha = load_panel(conn)
        conn.close()
        weeks, packed = build_weeks(outcomes, tech, alpha, permno, panels, len(hits))
        fildi_mid = weeks[len(weeks) // 2]
        for i, h in enumerate(hits):
            stats = summarize(packed, i, fildi_mid)
            passed = path_ok(stats["ic"]) and (path_ok(stats["fm"]) or path_ok(stats["wq"]))
            confirm.append({"hit": h, "stats": stats, "pass": passed, "weeks": len(packed)})
    else:
        permno = load_permno()

    # smoke coverage from the pull
    cov_lines = []
    for t in SMOKE:
        p = permno.get(t) if "permno" in dir() else load_permno().get(t)
        if p is None or int(p) not in set(jkp["perm"].tolist()):
            # set lookup of 1e6 is ok once
            cov_lines.append(f"- {t}: permno {p if p else 'none'}; JKP rows in the US-common pull 0.")
            continue
        m = jkp["perm"] == int(p)
        yms = np.sort(jkp["ym"][m])
        cov_lines.append(f"- {t}: permno {int(p)}; JKP months {int(m.sum())} {int(yms[0])}→{int(yms[-1])}.")

    n_family = len(family)
    n_hits = len(hits)
    both = [c for c in confirm if c["pass"]]
    if both:
        verdict = ("PASS on " + ", ".join(c["hit"]["label"] for c in both)
                   + ". Research numbers only — nothing ships until a commercial rebuild.")
    elif hits:
        verdict = (f"Nothing ships. Holm keeps {n_hits} of {n_family}. "
                   "None also clear the Fildi 2023 holdout (t ≥ 2, both halves, marginal over alpha + lab_tech).")
    else:
        verdict = f"Nothing ships. Holm keeps 0 of {n_family}."

    # strongest
    ranked = sorted(family, key=lambda r: r["fm"].get("t") or -9, reverse=True)
    wrong = sorted(family, key=lambda r: r["fm"].get("t") or 9)[:3]

    def line_for(r):
        pt = price_t.get(r["label"])
        pt_s = f"{pt:+.2f}" if pt is not None and math.isfinite(pt) else "n/a"
        sp = r["spot"]
        spot_s = ""
        if sp:
            spot_s = (f" Spot 202406 n {sp['n']} IC {sp['ic']:+.4f} decile {sp['spread']*100:+.2f} pp "
                      f"(high {sp['hi']*100:+.2f} / low {sp['lo']*100:+.2f}).")
        return (f"- {r['label']} ({r['cat'] or 'JKP'}): IC {fmt(r['ic'])}; "
                f"decile {fmt(r['sp'], 100)} pp/month; FM {fmt(r['fm'])}. "
                f"Price≥$5 FM t {pt_s}.{spot_s} {r['desc']}")

    # mean names
    def mean_n(block):
        v = block["nn"][block["nn"] > 0]
        return float(v.mean()) if len(v) else 0.0

    text = []
    text.append("# S089b — Full CRSP/OSAP + JKP cross-section, then Fildi confirm")
    text.append("")
    text.append("Question: which OSAP predictors and which of the 153 JKP characteristics forecast the next month's beta residual on all US common stocks (2005–2024) after Holm 5%, and which of those survivors still forecast Fildi Monday rel_21 from 2023 on, beyond StarMine combined alpha and lab_tech v2?")
    text.append("")
    text.append("Pass bar (pre-registered, unchanged): discovery Holm 5% one-sided on the FM t (family = signals with ≥ 24 months in each half). Confirm = holdout 2023-01→ week-clustered t ≥ 2, same sign both halves, and marginal t ≥ 2. Positive means the published direction (OSAP file already signed; JKP raw × Factor Details direction). OSAP, JKP, and CRSP-inside-JKP stay research-only.")
    text.append("")
    text.append(f"**Verdict: {verdict}**")
    text.append("")
    text.append("## Hand-check (MU, 202406)")
    text.append("")
    text.extend(lines)
    text.append("")
    text.append("Smoke names (US-common pull):")
    text.extend(cov_lines)
    text.append("")
    text.append("## Coverage")
    text.append("")
    text.append(f"JKP rows {len(jkp['perm'])} after the US-common filter (common, primary, shrcd 10/11, exchcd 1/2/3), {PULL_LO}→{PULL_HI}. One WRDS query. OSAP predictors {len(osap['names'])}. JKP characteristics {len(jkp['names'])}.")
    text.append(f"Discovery signal months {len(disc)} ({disc[0]}→{disc[-1]}). Midpoint {mid}. Mean names per tested signal-month: OSAP {mean_n(o_block):.0f}, JKP {mean_n(j_block):.0f}.")
    text.append(f"Family (finite FM t, both halves ≥ {MIN_HALF} months): {n_family}. Holm 5% survivors: {n_hits}.")
    text.append(f"Beta window {BETA_WIN} months, minimum {BETA_MIN}, |beta|>{BETA_CAP:g} dropped on {panel['n_capped']} stock-months.")
    text.append("")
    text.append("## Does the harness see momentum?")
    text.append("")
    text.append(f"JKP ret_12_1 (signed +1) on the beta residual: IC {fmt(ret_pack['ic'])}; FM {fmt(ret_pack['fm'])}. iid t of the FM series {ret_pack['fm'].get('iid', float('nan')):+.2f}.")
    text.append(f"Same signal vs ret_exc_lead1m (sanity, not the bar): IC {fmt(lead_mom)}.")
    text.append(f"OSAP Mom12m on the beta residual: IC {fmt(mom_pack['ic'])}; FM {fmt(mom_pack['fm'])}.")
    text.append(f"Placebo: ret_12_1 shuffled inside each month (seed 89) IC {fmt(plac)}.")
    spot = ret_pack["spot"]
    if spot:
        text.append(f"Spot 202406 ret_12_1: n {spot['n']}, IC {spot['ic']:+.4f}, FM {spot['fm']:+.4f}, decile {spot['spread']*100:+.2f} pp (high {spot['hi']*100:+.2f} / low {spot['lo']*100:+.2f}).")
    text.append("")
    text.append("## Holm survivors")
    text.append("")
    if not hits:
        text.append("None.")
    else:
        text.extend(line_for(r) for r in hits)
    text.append("")
    text.append("## Fildi confirm (2023-01→ rel_21)")
    text.append("")
    if not confirm:
        text.append("No Holm survivor to confirm.")
    else:
        text.append(f"Digest `{digest}`. Holdout midpoint {fildi_mid}. Weeks with ≥30 names, alpha, and lab_tech: {confirm[0]['weeks']}.")
        for c in confirm:
            st = c["stats"]
            text.append(
                f"- {c['hit']['label']}: {'PASS' if c['pass'] else 'not a pass'}. "
                f"IC {fmt_fildi(st['ic'])}; decile {fmt_fildi(st['spread'], 100)} pp/21d; "
                f"FM {fmt_fildi(st['fm'])}; within-q {fmt_fildi(st['wq'], 100)} pp."
            )
    text.append("")
    text.append("## Strongest discovery FM t (not a second bar)")
    text.append("")
    text.extend(line_for(r) for r in ranked[:8])
    text.append("")
    text.append("Strongest published-direction failures (negative FM t): " + ", ".join(
        f"{r['label']} {r['fm']['t']:+.2f}" for r in wrong) + ".")
    text.append("")
    text.append(f"## Overlap (mean Spearman, {n_ov} Junes, |corr| ≥ 0.80)")
    text.append("")
    if not pairs:
        text.append("No pair at |corr| ≥ 0.80.")
    else:
        for c, a, b in pairs[:15]:
            text.append(f"- OSAP {a} vs JKP {b}: {c:+.3f}")
        text.append(f"Pairs at |corr| ≥ 0.80: {len(pairs)}. Both stay in the Holm family (overlap is flagged, not dropped).")
    text.append("")
    text.append("## What would ship")
    text.append("")
    if not both:
        text.append("Nothing. Do not add an OSAP or JKP column. A later single signal needs its own pre-registered window and a commercial rebuild (LSEG closes, or a stored history of inventory #8–9 fields — the snapshot we have is not that history).")
    else:
        for c in both:
            text.append(f"- {c['hit']['label']}: {c['hit']['ship']}")
    text.append("")
    text.append("## Known weaknesses")
    text.append("")
    text.append(f"- Holm family {n_family}. FWER at 5%. The Fildi t ≥ 2 bar is applied only to Holm survivors, so it is not a second search over all 360 signals.")
    text.append("- The discovery target is a 36-month beta residual, not the peer residual Fildi calls rel_21. Peer groups do not exist for the whole CRSP book. The confirm step is the rel_21 test.")
    text.append("- Newey–West lag 3 on non-overlapping months is conservative versus an iid t. The iid t is printed for ret_12_1 only.")
    text.append("- No price filter in the bar. Price ≥ $5 is reported beside the signals that were close. Microcaps can dominate a full-market sort.")
    text.append("- JKP direction comes from the 2022 factor-details file. The WRDS table is the later library (through 2025); the 153 names are the paper list, not every column on the table.")
    text.append("- OSAP characteristics are thin after 2024-12, so an OSAP survivor's Fildi second half can be short. JKP months in the pull run through 2025 and are used only on the confirm as-of, not in discovery.")
    text.append("- Dual-class names are one row (primary_sec = 1). CRWV has no CRSP permno in this window.")
    text.append("")
    OUT.write_text("\n".join(text) + "\n")
    print(f"wrote {OUT}", flush=True)
    print("VERDICT", verdict, flush=True)


def fmt_fildi(p: dict, scale: float = 1.0) -> str:
    if not isinstance(p, dict) or p.get("mean") is None:
        return "thin"
    a, b = p.get("a"), p.get("b")
    if a is None:
        halves = "thin halves"
    else:
        halves = f"{a * scale:+.4f} / {b * scale:+.4f} (weeks {p.get('na')}/{p.get('nb')})"
    t = p.get("t")
    t_s = f"{t:+.2f}" if isinstance(t, float) and math.isfinite(t) else "na"
    return f"mean {p['mean'] * scale:+.4f} NW t {t_s} halves {halves}"


# --- signs ---
SIGNS = {'age': -1, 'aliq_at': -1, 'aliq_mat': -1, 'ami_126d': 1, 'at_be': -1, 'at_gr1': -1, 'at_me': 1, 'at_turnover': 1, 'be_gr1a': -1, 'be_me': 1, 'beta_60m': -1, 'beta_dimson_21d': -1, 'betabab_1260d': -1, 'betadown_252d': -1, 'bev_mev': 1, 'bidaskhl_21d': 1, 'capex_abn': -1, 'capx_gr1': -1, 'capx_gr2': -1, 'capx_gr3': -1, 'cash_at': 1, 'chcsho_12m': -1, 'coa_gr1a': -1, 'col_gr1a': -1, 'cop_at': 1, 'cop_atl1': 1, 'corr_1260d': -1, 'coskew_21d': -1, 'cowc_gr1a': -1, 'dbnetis_at': -1, 'debt_gr3': -1, 'debt_me': 1, 'dgp_dsale': 1, 'div12m_me': 1, 'dolvol_126d': -1, 'dolvol_var_126d': -1, 'dsale_dinv': 1, 'dsale_drec': -1, 'dsale_dsga': 1, 'earnings_variability': -1, 'ebit_bev': 1, 'ebit_sale': 1, 'ebitda_mev': 1, 'emp_gr1': -1, 'eq_dur': -1, 'eqnetis_at': -1, 'eqnpo_12m': 1, 'eqnpo_me': 1, 'eqpo_me': 1, 'f_score': 1, 'fcf_me': 1, 'fnl_gr1a': -1, 'gp_at': 1, 'gp_atl1': 1, 'ival_me': 1, 'inv_gr1': -1, 'inv_gr1a': -1, 'iskew_capm_21d': -1, 'iskew_ff3_21d': -1, 'iskew_hxz4_21d': -1, 'ivol_capm_21d': -1, 'ivol_capm_252d': -1, 'ivol_ff3_21d': -1, 'ivol_hxz4_21d': -1, 'kz_index': 1, 'lnoa_gr1a': -1, 'lti_gr1a': -1, 'market_equity': -1, 'mispricing_mgmt': 1, 'mispricing_perf': 1, 'ncoa_gr1a': -1, 'ncol_gr1a': -1, 'netdebt_me': -1, 'netis_at': -1, 'nfna_gr1a': 1, 'ni_ar1': 1, 'ni_be': 1, 'ni_inc8q': 1, 'ni_ivol': 1, 'ni_me': 1, 'niq_at': 1, 'niq_at_chg1': 1, 'niq_be': 1, 'niq_be_chg1': 1, 'niq_su': 1, 'nncoa_gr1a': -1, 'noa_at': -1, 'noa_gr1a': -1, 'o_score': -1, 'oaccruals_at': -1, 'oaccruals_ni': -1, 'ocf_at': 1, 'ocf_at_chg1': 1, 'ocf_me': 1, 'ocfq_saleq_std': -1, 'op_at': 1, 'op_atl1': 1, 'ope_be': 1, 'ope_bel1': 1, 'opex_at': 1, 'pi_nix': 1, 'ppeinv_gr1a': -1, 'prc': -1, 'prc_highprc_252d': 1, 'qmj': 1, 'qmj_growth': 1, 'qmj_prof': 1, 'qmj_safety': 1, 'rd_me': 1, 'rd_sale': 1, 'rd5_at': 1, 'resff3_12_1': 1, 'resff3_6_1': 1, 'ret_1_0': -1, 'ret_12_1': 1, 'ret_12_7': 1, 'ret_3_1': 1, 'ret_6_1': 1, 'ret_60_12': -1, 'ret_9_1': 1, 'rmax1_21d': -1, 'rmax5_21d': -1, 'rmax5_rvol_21d': -1, 'rskew_21d': -1, 'rvol_21d': -1, 'sale_bev': 1, 'sale_emp_gr1': 1, 'sale_gr1': -1, 'sale_gr3': -1, 'sale_me': 1, 'saleq_gr1': -1, 'saleq_su': 1, 'seas_1_1an': 1, 'seas_1_1na': 1, 'seas_11_15an': 1, 'seas_11_15na': -1, 'seas_16_20an': 1, 'seas_16_20na': -1, 'seas_2_5an': 1, 'seas_2_5na': -1, 'seas_6_10an': 1, 'seas_6_10na': -1, 'sti_gr1a': 1, 'taccruals_at': -1, 'taccruals_ni': -1, 'tangibility': 1, 'tax_gr1a': 1, 'turnover_126d': -1, 'turnover_var_126d': -1, 'z_score': 1, 'zero_trades_126d': 1, 'zero_trades_21d': 1, 'zero_trades_252d': 1}
NAMES = {'niq_su': 'Standardized earnings surprise', 'ret_6_1': 'Price momentum t-6 to t-1', 'ret_12_1': 'Price momentum t-12 to t-1', 'saleq_su': 'Standardized Revenue surprise', 'tax_gr1a': 'Tax expense surprise', 'ni_inc8q': 'Number of consecutive quarters with earnings increases', 'prc_highprc_252d': 'Current price to high price over last year', 'resff3_6_1': 'Residual momentum t-6 to t-1', 'resff3_12_1': 'Residual momentum t-12 to t-1', 'be_me': 'Book-to-market equity', 'debt_me': 'Debt-to-market', 'at_me': 'Assets-to-market', 'ret_60_12': 'Long-term reversal', 'ni_me': 'Earnings-to-price', 'fcf_me': 'Free cash flow-to-price', 'div12m_me': 'Dividend yield', 'eqpo_me': 'Payout yield', 'eqnpo_me': 'Net payout yield', 'sale_gr3': 'Sales Growth (3 years)', 'sale_gr1': 'Sales Growth (1 year)', 'ebitda_mev': 'Ebitda-to-market enterprise value', 'sale_me': 'Sales-to-market', 'ocf_me': 'Operating cash flow-to-market', 'ival_me': 'Intrinsic value-to-market', 'bev_mev': 'Book-to-market enterprise value', 'netdebt_me': 'Net debt-to-price', 'eq_dur': 'Equity duration', 'capex_abn': 'Abnormal corporate investment', 'at_gr1': 'Asset Growth', 'ppeinv_gr1a': 'Change PPE and Inventory', 'noa_at': 'Net operating assets', 'noa_gr1a': 'Change in net operating assets', 'lnoa_gr1a': 'Change in long-term net operating assets', 'capx_gr1': 'CAPEX growth (1 year)', 'capx_gr2': 'CAPEX growth (2 years)', 'capx_gr3': 'CAPEX growth (3 years)', 'chcsho_12m': 'Net stock issues', 'eqnpo_12m': 'Equity net payout', 'debt_gr3': 'Growth in book debt (3 years)', 'inv_gr1': 'Inventory growth', 'inv_gr1a': 'Inventory change', 'oaccruals_at': 'Operating accruals', 'taccruals_at': 'Total accruals', 'cowc_gr1a': 'Change in current operating working capital', 'coa_gr1a': 'Change in current operating assets', 'col_gr1a': 'Change in current operating liabilities', 'nncoa_gr1a': 'Change in net noncurrent operating assets', 'ncoa_gr1a': 'Change in noncurrent operating assets', 'ncol_gr1a': 'Change in noncurrent operating liabilities', 'nfna_gr1a': 'Change in net financial assets', 'sti_gr1a': 'Change in short-term investments', 'lti_gr1a': 'Change in long-term investments', 'fnl_gr1a': 'Change in financial liabilities', 'be_gr1a': 'Change in common equity', 'oaccruals_ni': 'Percent operating accruals', 'taccruals_ni': 'Percent total accruals', 'netis_at': 'Net total issuance', 'eqnetis_at': 'Net equity issuance', 'dbnetis_at': 'Net debt issuance', 'niq_be': 'Quarterly return on equity', 'niq_be_chg1': 'Change in quarterly return on equity', 'niq_at': 'Quarterly return on assets', 'niq_at_chg1': 'Change in quarterly return on assets', 'ebit_bev': 'Return on net operating assets', 'ebit_sale': 'Profit margin', 'sale_bev': 'Asset turnover', 'at_turnover': 'Capital turnover', 'gp_at': 'Gross profits-to-assets', 'gp_atl1': 'Gross profits-to-lagged assets', 'ope_be': 'Operating profits-to-book equity', 'ope_bel1': 'Operating profits-to-lagged book equity', 'op_at': 'Operating profits-to-book assets', 'op_atl1': 'Operating profits-to-lagged book assets', 'cop_at': 'Cash-based operating profits-to-book assets', 'cop_atl1': 'Cash-based operating profits-to-lagged book assets', 'f_score': 'Pitroski F-score', 'o_score': 'Ohlson O-score', 'z_score': 'Altman Z-score', 'pi_nix': 'Taxable income-to-book income', 'at_be': 'Book leverage', 'saleq_gr1': 'Sales growth (1 quarter)', 'rd_me': 'R&D-to-market', 'rd_sale': 'R&D-to-sales', 'opex_at': 'Operating leverage', 'emp_gr1': 'Hiring rate', 'rd5_at': 'R&D capital-to-book assets', 'age': 'Firm age', 'dsale_dinv': 'Change sales minus change Inventory', 'dsale_drec': 'Change sales minus change receivables', 'dgp_dsale': 'Change gross margin minus change sales', 'dsale_dsga': 'Change sales minus change SG&A', 'sale_emp_gr1': 'Labor force efficiency', 'tangibility': 'Asset tangibility', 'kz_index': 'Kaplan-Zingales index', 'ocfq_saleq_std': 'Cash flow volatility', 'cash_at': 'Cash-to-assets', 'ni_ar1': 'Earnings persistence', 'ni_ivol': 'Earnings volatility', 'earnings_variability': 'Earnings variability', 'aliq_at': 'Liquidity of book assets', 'aliq_mat': 'Liquidity of market assets', 'seas_1_1an': 'Year 1-lagged return, annual', 'seas_1_1na': 'Year 1-lagged return, nonannual', 'seas_2_5an': 'Years 2-5 lagged returns, annual', 'seas_2_5na': 'Years 2-5 lagged returns, nonannual', 'seas_6_10an': 'Years 6-10 lagged returns, annual', 'seas_6_10na': 'Years 6-10 lagged returns, nonannual', 'seas_11_15an': 'Years 11-15 lagged returns, annual', 'seas_11_15na': 'Years 11-15 lagged returns, nonannual', 'seas_16_20an': 'Years 16-20 lagged returns, annual', 'seas_16_20na': 'Years 16-20 lagged returns, nonannual', 'market_equity': 'Market Equity', 'ivol_ff3_21d': 'Idiosyncratic volatility from the Fama-French 3-factor model', 'ivol_capm_252d': 'Idiosyncratic volatility from the CAPM (252 days)', 'ivol_capm_21d': 'Idiosyncratic volatility from the CAPM (21 days)', 'ivol_hxz4_21d': 'Idiosyncratic volatility from the q-factor model', 'rvol_21d': 'Return volatility', 'beta_60m': 'Market Beta', 'betabab_1260d': 'Frazzini-Pedersen market beta', 'beta_dimson_21d': 'Dimson beta', 'turnover_126d': 'Share turnover', 'turnover_var_126d': 'Coefficient of variation for share turnover', 'dolvol_126d': 'Dollar trading volume', 'dolvol_var_126d': 'Coefficient of variation for dollar trading volume', 'prc': 'Price per share', 'ami_126d': 'Amihud Measure', 'zero_trades_21d': 'Number of zero trades with turnover as tiebreaker (1 month)', 'zero_trades_126d': 'Number of zero trades with turnover as tiebreaker (6 months)', 'zero_trades_252d': 'Number of zero trades with turnover as tiebreaker (12 months)', 'rmax1_21d': 'Maximum daily return', 'rskew_21d': 'Total skewness', 'iskew_capm_21d': 'Idiosyncratic skewness from the CAPM', 'iskew_ff3_21d': 'Idiosyncratic skewness from the Fama-French 3-factor model', 'iskew_hxz4_21d': 'Idiosyncratic skewness from the q-factor model', 'coskew_21d': 'Coskewness', 'ret_1_0': 'Short-term reversal', 'betadown_252d': 'Downside beta', 'bidaskhl_21d': 'The high-low bid-ask spread', 'ret_3_1': 'Price momentum t-3 to t-1', 'ret_9_1': 'Price momentum t-9 to t-1', 'ret_12_7': 'Price momentum t-12 to t-7', 'corr_1260d': 'Market correlation', 'rmax5_21d': 'Highest 5 days of return', 'rmax5_rvol_21d': 'Highest 5 days of return scaled by volatility', 'ni_be': 'Return on equity', 'ocf_at': 'Operating cash flow to assets', 'ocf_at_chg1': 'Change in operating cash flow to assets', 'mispricing_perf': 'Mispricing factor: Performance', 'mispricing_mgmt': 'Mispricing factor: Management', 'qmj': 'Quality minus Junk: Composite', 'qmj_prof': 'Quality minus Junk: Profitability', 'qmj_growth': 'Quality minus Junk: Growth', 'qmj_safety': 'Quality minus Junk: Safety'}


if __name__ == "__main__":
    main()
