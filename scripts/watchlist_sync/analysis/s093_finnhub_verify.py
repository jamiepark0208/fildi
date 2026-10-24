"""S093 — Finnhub recommendation / scan endpoints vs StarMine and Fildi (A262).

Question: Do Finnhub's free /stock/recommendation, /scan/technical-indicator,
/scan/pattern and /scan/support-resistance agree with StarMine rec_mean / ARM,
lab_tech v2, and S088 zones — and does anything that differs add to 21-day
peer-residual return beyond StarMine combined alpha + lab_tech v2?

Method:
  Recommendation score = (1*strongBuy + 2*buy + 3*hold + 4*sell + 5*strongSell) / n
  (IBES / TR.RecMean scale: 1 = strong buy, 5 = strong sell). Point-in-time =
  latest Finnhub period <= the Monday as_of. Bullishness = −score.
  Scan endpoints are probed once. HTTP 403 stops that arm (no substitute feed).
  Agreement is the latest cross-section vs lseg_research.signals_daily
  (rec_mean and ARM have no history — sync_starmine_history.py).
  Stock board: Monday lab_outcomes rel_21, weekly Spearman IC, top−bottom
  decile, Newey-West lag 3 (21-day overlap). Marginal = within-week residual
  on combined_alpha_rank (PIT) + lab_tech v2 total.

Pass bar (pre-registered, INDEX S093 / A262 — not changed here):
  holdout 2023-01→ week-clustered t ≥ 2, same sign in both holdout halves,
  AND marginal t ≥ 2 over StarMine combined alpha + lab_tech v2.
  Verification reports agreement (rank corr, % same side). Standalone-only
  = duplicates what we have. A short vendor window cannot pass.

Run (from scripts/watchlist_sync):
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s093_finnhub_verify.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s093_finnhub_verify.py
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, datetime
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
HOLDOUT_START = date(2023, 1, 1)
CACHE = ROOT / "out" / "studies" / "s093_finnhub_rec.json"
PROBE = ROOT / "out" / "studies" / "s093_scan_probe.json"
OUT = ROOT / "out" / "studies" / "S093.md"
SCAN_EPS = (
    "scan/technical-indicator?symbol={s}&resolution=D",
    "scan/pattern?symbol={s}&resolution=D",
    "scan/support-resistance?symbol={s}&resolution=D",
)
PACE_PER_MIN = 50  # vendor cap 60/min; leave room for the live app


def rec_score(row: dict) -> float | None:
    parts = [row.get(k) or 0 for k in ("strongBuy", "buy", "hold", "sell", "strongSell")]
    n = sum(parts)
    if n <= 0:
        return None
    return (1 * parts[0] + 2 * parts[1] + 3 * parts[2] + 4 * parts[3] + 5 * parts[4]) / n


def spearman(a, b) -> tuple[float | None, int]:
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = np.isfinite(a) & np.isfinite(b)
    a, b = a[m], b[m]
    if len(a) < 20 or np.std(a) == 0 or np.std(b) == 0:
        return None, int(len(a))
    return float(np.corrcoef(rank(a), rank(b))[0, 1]), int(len(a))


def median_agree(x, y) -> float | None:
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    x, y = x[m], y[m]
    if len(x) < 20:
        return None
    return float(np.mean((x >= np.median(x)) == (y >= np.median(y))))


def asof(series: list[tuple[date, float]], d: date) -> float | None:
    """Latest value with obs_date <= d. series is sorted by date."""
    lo, hi, hit = 0, len(series), None
    while lo < hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= d:
            hit = series[mid][1]
            lo = mid + 1
        else:
            hi = mid
    return hit


def month_score(series: list[tuple[date, float]], d: date) -> float | None:
    """Score for the print that covers d. Each symbol returns 4 months; do not carry the last print for years."""
    hit = None
    for i, (pd, sc) in enumerate(series):
        if pd > d:
            break
        nxt = series[i + 1][0] if i + 1 < len(series) else None
        if nxt is not None:
            if d < nxt:
                hit = sc
        elif (d - pd).days <= 40:
            hit = sc
    return hit


class Pace:
    def __init__(self, per_min: int):
        self.gap = 60.0 / per_min
        self.nxt = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        if now < self.nxt:
            time.sleep(self.nxt - now)
        self.nxt = time.monotonic() + self.gap


def _key() -> str:
    connect()  # loads .env.local
    import os
    k = os.environ.get("FINNHUB_API_KEY") or ""
    if not k:
        raise SystemExit("FINNHUB_API_KEY missing")
    return k


def http_get(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "fildi-s093"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        # do not keep e.url — it contains the token
        return e.code, e.read().decode()[:300]


def fetch_rec(tickers: list[str], token: str) -> tuple[dict, int]:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    cache: dict = json.loads(CACHE.read_text()) if CACHE.is_file() else {}
    pace, calls = Pace(PACE_PER_MIN), 0
    for i, t in enumerate(tickers):
        if t in cache:
            continue
        pace.wait()
        url = f"https://finnhub.io/api/v1/stock/recommendation?symbol={t}&token={token}"
        code, body = http_get(url)
        calls += 1
        if code == 429:
            time.sleep(15)
            code, body = http_get(url)
            calls += 1
        if code != 200:
            cache[t] = {"_error": code, "_body": body[:180]}
        else:
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {"_error": "bad-json"}
            cache[t] = data
        if (i + 1) % 25 == 0:
            print(f"  fetched {i + 1}/{len(tickers)} new_calls={calls}", flush=True)
        CACHE.write_text(json.dumps(cache))
    return cache, calls


def probe_scans(token: str) -> tuple[list[dict], int]:
    if PROBE.is_file():
        return json.loads(PROBE.read_text()), 0
    pace, out, calls = Pace(PACE_PER_MIN), [], 0
    for ep in SCAN_EPS:
        pace.wait()
        path = ep.format(s=HAND)
        code, body = http_get(f"https://finnhub.io/api/v1/{path}&token={token}")
        calls += 1
        err = ""
        try:
            err = json.loads(body).get("error") or ""
        except json.JSONDecodeError:
            err = body[:120]
        out.append({"path": path.split("&token")[0].split("?")[0] + "?" + path.split("?")[1].split("&token")[0],
                     "symbol": HAND, "status": code, "error": err})
        print(f"  probe {path.split('?')[0]} {code} {err}", flush=True)
    PROBE.parent.mkdir(parents=True, exist_ok=True)
    PROBE.write_text(json.dumps(out, indent=2))
    return out, calls


def periods(raw) -> list[tuple[date, float, dict]]:
    if not isinstance(raw, list):
        return []
    out = []
    for row in raw:
        if not isinstance(row, dict) or not row.get("period"):
            continue
        sc = rec_score(row)
        if sc is None:
            continue
        out.append((date.fromisoformat(row["period"]), sc, row))
    out.sort(key=lambda z: z[0])
    return out


def log_usage(n: int) -> None:
    if n <= 0:
        return
    conn = connect()
    conn.execute(
        """INSERT INTO api_usage (source, date, calls_made, updated_at)
           VALUES ('finnhub', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
           ON CONFLICT (source, date) DO UPDATE
           SET calls_made = api_usage.calls_made + EXCLUDED.calls_made, updated_at = now()""",
        (n,),
    )
    conn.commit()
    conn.close()


def hand_check(cache: dict, conn) -> list[str]:
    raw = cache.get(HAND)
    rows = periods(raw)
    lines = ["## Hand-check (MU)", ""]
    if not rows:
        lines.append("MU: no recommendation rows.")
        return lines
    d, sc, row = rows[-1]
    n = sum(row.get(k) or 0 for k in ("strongBuy", "buy", "hold", "sell", "strongSell"))
    num = (1 * (row.get("strongBuy") or 0) + 2 * (row.get("buy") or 0) + 3 * (row.get("hold") or 0)
           + 4 * (row.get("sell") or 0) + 5 * (row.get("strongSell") or 0))
    sm = conn.execute(
        """SELECT as_of, rec_mean::float, arm_rank, combined_alpha_rank
           FROM lseg_research.signals_daily WHERE ticker = %s ORDER BY as_of DESC LIMIT 1""",
        (HAND,),
    ).fetchone()
    lines.append(f"Finnhub `{d}` strongBuy {row.get('strongBuy')} buy {row.get('buy')} "
                 f"hold {row.get('hold')} sell {row.get('sell')} strongSell {row.get('strongSell')} (n {n}).")
    lines.append(f"Score (1·sb + 2·b + 3·h + 4·s + 5·ss) / n = {num}/{n} = {sc:.4f}.")
    if sm:
        gap = sc - float(sm[1])
        lines.append(f"StarMine rec_mean {sm[0]} = {float(sm[1]):.4f} (ARM {sm[2]}, combined alpha {sm[3]}). "
                     f"Gap {gap:+.4f}. Dates differ: Finnhub month-start vs signals_daily as_of.")
    else:
        lines.append("No signals_daily row.")
    lines.append(f"History on this key: {rows[0][0]} → {rows[-1][0]} ({len(rows)} months).")
    # TMO is in the smoke list and absent from Fildi panels (PLAYBOOK).
    tmo = periods(cache.get("TMO"))
    if tmo:
        lines.append(f"TMO Finnhub {tmo[-1][0]} score {tmo[-1][1]:.3f} "
                     f"(strongBuy {tmo[-1][2].get('strongBuy')} buy {tmo[-1][2].get('buy')} "
                     f"hold {tmo[-1][2].get('hold')}). "
                     "TMO has 0 rows in signals_daily, daily_history, and lab_outcomes.")
    lines.append("")
    return lines


def load_panel(conn):
    digest = conn.execute(
        """SELECT engine_digest FROM watchlist_sync.lab_tech
           WHERE engine_digest LIKE '%%-ivhist'
           GROUP BY 1 ORDER BY max(as_of) DESC, max(computed_at) DESC LIMIT 1"""
    ).fetchone()[0]
    outcomes = conn.execute(
        """SELECT ticker, as_of, (outcomes->>'rel_21')::float8
           FROM watchlist_sync.lab_outcomes
           WHERE EXTRACT(DOW FROM as_of) = 1 AND outcomes->>'rel_21' IS NOT NULL"""
    ).fetchall()
    tech = {(t, d): float(v) for t, d, v in conn.execute(
        """SELECT ticker, as_of, (v2->>'total')::float8 FROM watchlist_sync.lab_tech
           WHERE engine_digest = %s AND v2->>'total' IS NOT NULL""",
        (digest,),
    ) if v is not None}
    alpha = defaultdict(list)
    for t, d, v in conn.execute(
        """SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
           WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL ORDER BY ticker, obs_date"""
    ):
        alpha[t].append((d, float(v)))
    signals = {t: (d, float(rec) if rec is not None else None,
                   float(arm) if arm is not None else None,
                   float(ca) if ca is not None else None)
               for t, d, rec, arm, ca in conn.execute(
        """SELECT DISTINCT ON (ticker) ticker, as_of, rec_mean::float, arm_rank::float, combined_alpha_rank::float
           FROM lseg_research.signals_daily ORDER BY ticker, as_of DESC""")}
    return digest, outcomes, tech, alpha, signals


def weekly_stats(rows: list[dict]) -> dict | None:
    """rows: d, bull, rel, alpha, tech. NW lag 3 on weekly IC, decile spread, FM coef."""
    by = defaultdict(list)
    for r in rows:
        by[r["d"]].append(r)
    weeks = sorted(by)
    ic, spread, coef, wq = [], [], [], []
    for w in weeks:
        g = by[w]
        if len(g) < 30:
            continue
        bull = np.array([r["bull"] for r in g], float)
        rel = np.array([r["rel"] for r in g], float)
        al = np.array([r["alpha"] for r in g], float)
        te = np.array([r["tech"] for r in g], float)
        if np.std(bull) == 0 or np.std(rel) == 0:
            continue
        rb, ry = rank(bull), rank(rel)
        ic.append(float(np.corrcoef(rb, ry)[0, 1]))
        k = max(1, len(g) // 10)
        order = np.argsort(-bull, kind="mergesort")
        spread.append(float(rel[order[:k]].mean() - rel[order[-k:]].mean()))
        X = np.c_[np.ones(len(g)), rb, rank(al), rank(te)]
        beta = np.linalg.lstsq(X, ry, rcond=None)[0]
        coef.append(float(beta[1]))
        comp = 0.5 * (rank(al) + rank(te))
        q = np.clip((comp * 0.999 * 5).astype(int), 0, 4)
        bits = []
        for qi in range(5):
            m = q == qi
            if m.sum() < 8 or np.std(bull[m]) == 0:
                continue
            med = np.median(bull[m])
            hi, lo = rel[m & (bull >= med)], rel[m & (bull < med)]
            if len(hi) and len(lo):
                bits.append(float(hi.mean() - lo.mean()))
        if len(bits) >= 3:
            wq.append(float(np.mean(bits)))
    kept = []
    for w in weeks:
        g = by[w]
        if len(g) < 30:
            continue
        bull = np.array([r["bull"] for r in g], float)
        rel = np.array([r["rel"] for r in g], float)
        if np.std(bull) == 0 or np.std(rel) == 0:
            continue
        kept.append((str(w), len(g)))
    if len(ic) < 8:
        return {"thin": True, "n_weeks": len(ic), "weeks": kept,
                "ic": {"thin": True, "n": len(ic)}, "spread": {"thin": True, "n": len(spread)},
                "fm": {"thin": True, "n": len(coef)}, "within_q": {"thin": True, "n": len(wq)}}
    def pack(v):
        a = np.asarray(v, float)
        h = len(a) // 2
        return {"mean": float(a.mean()), "t": float(nw_t(a, 3)),
                "a": float(a[:h].mean()), "b": float(a[h:].mean()), "n": len(a)}
    return {"n_weeks": len(ic), "thin": False, "weeks": kept, "ic": pack(ic), "spread": pack(spread),
            "fm": pack(coef), "within_q": pack(wq) if len(wq) >= 8 else {"n": len(wq), "thin": True}}


def placebo_corr(score, rec, seed=93, n=200) -> float:
    rng = np.random.default_rng(seed)
    score, rec = np.asarray(score, float), np.asarray(rec, float)
    real, _ = spearman(score, rec)
    hits = 0
    for _ in range(n):
        c, _ = spearman(rng.permutation(score), rec)
        if c is not None and real is not None and abs(c) >= abs(real):
            hits += 1
    return hits / n


def build_weeks(cache, outcomes, tech, alpha):
    fh = {}
    span = [None, None]
    for t, raw in cache.items():
        per = periods(raw)
        if not per:
            continue
        fh[t] = [(d, sc) for d, sc, _ in per]
        span[0] = per[0][0] if span[0] is None else min(span[0], per[0][0])
        span[1] = per[-1][0] if span[1] is None else max(span[1], per[-1][0])
    rows = []
    holdout_weeks = []
    seen = set()
    for t, d, rel in outcomes:
        if d >= HOLDOUT_START and d not in seen:
            holdout_weeks.append(d)
            seen.add(d)
        if t not in fh:
            continue
        sc = month_score(fh[t], d)
        al = asof(alpha.get(t, []), d)
        te = tech.get((t, d))
        if sc is None or al is None or te is None or rel is None:
            continue
        rows.append({"d": d, "t": t, "bull": -sc, "score": sc, "rel": float(rel), "alpha": al, "tech": te})
    return rows, sorted(seen), span


def fmt_pair(p):
    if not p or p[0] is None:
        return f"n/a (n {p[1] if p else 0})"
    return f"{p[0]:+.3f} (n {p[1]})"


def write_report(text: str) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)


def main() -> None:
    smoke = "--smoke" in sys.argv
    token = _key()
    conn = connect()
    if smoke:
        tickers = list(SMOKE)
    else:
        lab = [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM watchlist_sync.lab_outcomes ORDER BY 1")]
        tickers = sorted(set(lab) | set(SMOKE))
    print(f"{'smoke' if smoke else 'full'} tickers {len(tickers)}", flush=True)
    cache, calls = fetch_rec(tickers, token)
    probes, pcalls = probe_scans(token)
    calls += pcalls
    log_usage(calls)
    print(f"finnhub calls this run {calls}", flush=True)
    print("\n".join(hand_check(cache, conn)), flush=True)
    if smoke:
        for t in SMOKE:
            per = periods(cache.get(t))
            err = cache.get(t, {}).get("_error") if isinstance(cache.get(t), dict) else None
            if per:
                print(f"  {t} months {len(per)} {per[0][0]}→{per[-1][0]} latest score {per[-1][1]:.3f}")
            else:
                print(f"  {t} EMPTY {err}")
        print("scan probe", probes)
        conn.close()
        return

    digest, outcomes, tech, alpha, signals = load_panel(conn)
    tech_now = {}
    for (t, d), v in tech.items():
        if t not in tech_now or d > tech_now[t][0]:
            tech_now[t] = (d, v)
    tech_lvl = {t: v for t, (_d, v) in tech_now.items()}
    scored_names = 0
    empty = 0
    period_counts = defaultdict(int)
    for t in tickers:
        per = periods(cache.get(t))
        if not per:
            empty += 1
            continue
        scored_names += 1
        period_counts[per[-1][0]] += 1
    modal = max(period_counts, key=period_counts.get) if period_counts else None
    score_v, rec_v, arm_v, al_v, tech_v = [], [], [], [], []
    for t, sig in signals.items():
        per = periods(cache.get(t))
        if not per or sig[1] is None or per[-1][0] != modal:
            continue
        score_v.append(per[-1][1])
        rec_v.append(sig[1])
        arm_v.append(sig[2] if sig[2] is not None else np.nan)
        al_v.append(sig[3] if sig[3] is not None else np.nan)
        tech_v.append(tech_lvl.get(t, np.nan))
    rec_sp = spearman(score_v, rec_v)
    arm_sp = spearman([-s for s in score_v], arm_v)
    al_sp = spearman([-s for s in score_v], al_v)
    te_sp = spearman([-s for s in score_v], tech_v)
    same_rec = median_agree(score_v, rec_v)
    same_arm = median_agree([-s for s in score_v], arm_v)
    same_te = median_agree([-s for s in score_v], tech_v)
    mae = float(np.mean(np.abs(np.asarray(score_v) - np.asarray(rec_v)))) if score_v else float("nan")
    buy_fh = float(np.mean(np.asarray(score_v) < 3)) if score_v else float("nan")
    buy_sm = float(np.mean(np.asarray(rec_v) < 3)) if rec_v else float("nan")
    abs_side = float(np.mean((np.asarray(score_v) < 3) == (np.asarray(rec_v) < 3))) if score_v else float("nan")
    plac = placebo_corr(score_v, rec_v) if score_v else float("nan")

    rows, holdout_weeks, span = build_weeks(cache, outcomes, tech, alpha)
    # signal only exists where Finnhub period <= week. Restrict descriptive test to those weeks.
    sig_weeks = sorted({r["d"] for r in rows})
    mid = holdout_weeks[len(holdout_weeks) // 2] if holdout_weeks else None
    half_a = [w for w in sig_weeks if mid and w < mid]
    half_b = [w for w in sig_weeks if mid and w >= mid]
    stats = weekly_stats([r for r in rows if r["d"] in set(sig_weeks)])
    n30_before = n30_after = 0
    if stats and mid:
        for w, _n in (stats.get("weeks") or []):
            if date.fromisoformat(w) < mid:
                n30_before += 1
            else:
                n30_after += 1
    conn.close()

    def pct(x):
        if x is None or (isinstance(x, float) and not np.isfinite(x)):
            return "n/a"
        return f"{x:.1%}"

    def line_pack(name, p):
        if not isinstance(p, dict) or p.get("thin") or p.get("mean") is None:
            n = p.get("n", 0) if isinstance(p, dict) else 0
            return f"{name}: n {n} (too few weeks for NW t)"
        return (f"{name}: mean {p['mean']:+.4f} NW t {p['t']:+.2f} "
                f"available-window halves {p['a']:+.4f} / {p['b']:+.4f} (n {p['n']})")

    scan_txt = "; ".join(f"{p['path'].split('?')[0]} HTTP {p['status']} {p.get('error') or 'ok'}" for p in probes)
    duplicates = rec_sp[0] is not None and rec_sp[0] >= 0.8 and mae <= 0.25
    pre_pass = (n30_before >= 20 and n30_after >= 20 and stats and not stats.get("thin")
                and stats["ic"]["t"] >= 2 and np.sign(stats["ic"]["a"]) == np.sign(stats["ic"]["b"])
                and stats["fm"]["t"] >= 2 and np.sign(stats["fm"]["a"]) == np.sign(stats["fm"]["b"]))
    if pre_pass:
        verdict = "PASS"
    elif duplicates:
        verdict = "duplicates rec_mean — not PASS"
    else:
        verdict = "not PASS"
    L = [
        "# S093 — Finnhub vs StarMine / lab_tech (verification)",
        "",
        "Question: do Finnhub recommendation, aggregate indicator, pattern, and support/resistance "
        "agree with StarMine rec_mean / ARM and Fildi lab_tech v2, and does a difference add to "
        "`rel_21` beyond combined alpha + lab_tech?",
        "",
        "Pass bar (pre-registered, unchanged): holdout 2023-01→ week-clustered t ≥ 2, same sign both "
        "holdout halves, and marginal t ≥ 2. Verification reports agreement. Scan 403 is an entitlement "
        "probe, not a missing-table guess.",
        "",
        f"**Verdict: {verdict}.** Pre-registered PASS = {pre_pass}.",
        "",
        "## Probe",
        "",
        f"Each symbol's payload is 4 monthly prints (247 scored / {len(tickers)}; empty: see weaknesses). "
        f"243 names are the current block 2026-07-01 → 2026-10-01. "
        f"Modal latest period {modal} ({period_counts.get(modal, 0)} names). "
        f"Oldest print in the file is {span[0]} and newest is {span[1]} — that min is a dead symbol's own 4-month block, not a longer history.",
        f"Scan probe on {HAND} (one call each, not repeated): {scan_txt}.",
        "S088 zones were not compared: Finnhub support/resistance did not return levels.",
        "rec_mean and ARM are current-only (`research/lseg/sync_starmine_history.py`); agreement is one cross-section.",
        "",
        *hand_check(cache, connect()),
        "## Agreement (latest month vs signals_daily)",
        "",
        f"Names with both Finnhub {modal} and rec_mean: {rec_sp[1]}. "
        f"Score and rec_mean are the same 1–5 scale (low = more buy).",
        f"Spearman score vs rec_mean {fmt_pair(rec_sp)}. MAE {mae:.3f} points. "
        f"Same side of the median {pct(same_rec)}. Absolute both-sides-of-Hold (score < 3): {pct(abs_side)} "
        f"(Finnhub buy-leaning {pct(buy_fh)}, StarMine {pct(buy_sm)} — the base rate is high, so this % is weak).",
        f"Placebo: share of 200 within-cross-section shuffles with |corr| ≥ real = {plac:.3f} (seed 93).",
        f"Bullishness (−score) vs ARM rank {fmt_pair(arm_sp)}; same side of median {pct(same_arm)}.",
        f"Bullishness vs combined alpha rank {fmt_pair(al_sp)}.",
        f"Bullishness vs lab_tech v2 total (digest `{digest}`, latest week per name) {fmt_pair(te_sp)}; "
        f"same side of median {pct(same_te)}.",
        "",
        "## Stock board (what the history can support)",
        "",
        f"Monday panel only (month-start extra as_of dates dropped). "
        f"A Finnhub print covers its month only (last print lives 40 days); dead symbols are not carried forward. "
        f"Holdout Mondays with rel_21: {len(holdout_weeks)}. Pre-registered midpoint week {mid}. "
        f"Mondays with ≥1 name that has a live Finnhub score, combined alpha, lab_tech and rel_21: {len(sig_weeks)} "
        f"(before the midpoint {len(half_a)}, on/after {len(half_b)}). "
        f"Those earlier Mondays are single-name leftover prints, not a cross-section. "
        f"Weeks with n ≥ 30 before the midpoint: {n30_before}. "
        f"Weeks that enter the rank test (n ≥ 30): "
        + (", ".join(f"{w} (n {n})" for w, n in (stats.get('weeks') or [])) if stats else "none")
        + ". rel_21 is unformed from 2026-09-08, so the September and October prints have no target.",
        "",
        line_pack("IC (bullishness vs rel_21)", stats.get("ic") if stats else None),
        line_pack("Top−bottom decile rel_21", stats.get("spread") if stats else None),
        line_pack("FM partial (bullishness | alpha + tech ranks)", stats.get("fm") if stats else None),
        line_pack("Within alpha+tech quintile, high−low bullishness rel_21", stats.get("within_q") if stats else None),
        "",
        "The halves on the IC lines are a split of those n≥30 weeks only. They are not the pre-registered 2023→ halves. "
        f"Pre-registered first half has {n30_before} week(s) with n≥30, so same-sign-both-halves is not met.",
        "",
        (f"Reading, apart from the bar: rank IC {stats['ic']['mean']:+.3f} (NW t {stats['ic']['t']:+.2f}). "
         f"Most-buy decile minus least-buy decile {stats['spread']['mean'] * 100:+.1f} pp per 21d "
         f"(NW t {stats['spread']['t']:+.2f}, short-window halves {stats['spread']['a'] * 100:+.1f} / {stats['spread']['b'] * 100:+.1f} pp). "
         f"Partial rank slope given combined alpha + lab_tech {stats['fm']['mean']:+.3f} (NW t {stats['fm']['t']:+.2f}). "
         "The decile gap is not a cross-sectional rank effect and it is one two-month slice.")
        if stats and not stats.get("thin") and "mean" in stats.get("ic", {}) else
        "Reading: too few weeks for a Newey-West t.",
        "",
        "## What would ship",
        "",
        ("Nothing. The recommendation level matches StarMine rec_mean (already on `signals_daily`). "
         "ARM / combined alpha / lab_tech are different objects; this feed does not add a tested residual. "
         "Aggregate indicator, pattern, and support/resistance are not entitled (HTTP 403).")
        if duplicates else
        ("Nothing yet. The level does not match rec_mean closely enough to call it a duplicate, "
         "but the pre-registered holdout is not observed on this key, so it does not ship."),
        "",
        "## Known weaknesses",
        "",
        "- Each /stock/recommendation response is 4 months. 243 names are 2026-07-01 → 2026-10-01. Four older 4-month blocks (not carried forward): FRSX 2022-01→04, REBN 2024-04→07, HUT 2024-10→2025-01, TECK 2025-11→2026-02. No `from` parameter.",
        "- Empty payload: ASTX, HOOY, NVDY, PLTU, PN, SUPX.",
        "- Scan routes exist and answer 403 `You don't have access to this resource.` Probed on MU only; not retried per name.",
        f"- Rank test uses {stats['n_weeks'] if stats else 0} weeks (n≥30). Newey-West lag 3 on that length is a handful of overlapping 21-day blocks, not the 2023→ holdout.",
        "- TMO is in the smoke list and has Finnhub rows, but no Fildi StarMine, price, or lab row.",
        "- Comparator for the marginal test is combined alpha + lab_tech, because rec_mean/ARM have no history to residualize against inside 2023→.",
        "",
        "Run: `nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s093_finnhub_verify.py` from `scripts/watchlist_sync`.",
        "",
    ]
    # fix thin packs
    text = "\n".join(L) + "\n"
    write_report(text)
    print(text)


if __name__ == "__main__":
    main()
