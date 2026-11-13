"""PM alerts (Claude, portfolio-manager role, user 2026-10-14) → Live › Portfolio Alerts tab. Script only, no AI.

How it decides (probabilistic core, deterministic thresholds the user owns):
  1. Odds per short put = the market's own: each put's implied vol (Schwab quotes; RH snapshot only if Schwab is down) gives P(ITM at
     expiry). Checked on the trader's 926 puts (S015 trades, 2026-02→10): predicted 18% ITM vs 21% realized, ratio 1.14 with week-cluster
     90% CI 0.73–1.55 → no detectable bias, so no fudge factor.
  2. Puts don't breach independently (S015 Q4: per-expiry ITM share SD 0.236 vs 0.098 if independent). Prefer empirical
     Cholesky on 60d shrunk corr of underlyings (A117); fall back to one-factor RHO = 0.6 (S015-calibrated) if matrix thin.
  3. Monte Carlo (20k paths) to the nearest expiry per account: which puts assign, longs move too (60-day realized vol), then
     margin requirement (pm_book's estimated maintenance ratio) vs equity → P(margin call), P(assignment > cash), assignment cash p90.
  4. Bullets only when a threshold is crossed (THRESH; defaults, user-tunable). Each bullet keeps a stable key; "new" / "worse" /
     "better" is relative to the previous run, so an unchanged risk reads as one quiet line instead of a fresh alarm.
  The crash-week budget (25% red / 20% amber, user 2026-10-14) is a scenario, not a probability: stated as "if", never as odds.

Schedule: LaunchAgent com.fildi.pm-alerts (every 15 min); this script runs every call in market hours (06:30–13:15 PT weekdays) and at
most every 2 h otherwise. Output: table watchlist_sync.pm_alerts (one row per run) → GET /api/pm/alerts; the full book → watchlist_sync.pm_book_latest
(one row) → GET /api/pm/book (Portfolio › Book card). Last run → /tmp/fildi-logs/pm-alerts-last.json (Settings › Scheduled Tasks).

    .venv/bin/python pm_alerts.py           # scheduled run (skips when not due)
    .venv/bin/python pm_alerts.py --now     # run now and print the bullets
    .venv/bin/python pm_alerts.py --what-if ACCOUNT TICKER STRIKE EXPIRY QTY IV SPOT [PREMIUM]
         # A136 candidate mode: Δ P(margin/cash) + Δ crash budget if this put is added (JSON on stdout)
"""
from __future__ import annotations

import copy
import json
import math
import random
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from build_plan import connect, rows

HERE = Path(__file__).resolve().parent
LAST_RUN = Path("/tmp/fildi-logs/pm-alerts-last.json")  # Settings › Scheduled Tasks reads this
OUT = HERE / "out" / "pm"
PT = ZoneInfo("America/Los_Angeles")
RHO = 0.6          # calibrated to S015 expiry clustering (see docstring)
PATHS = 20_000
THRESH = {          # defaults pending user tuning
    "margin_amber": 0.10, "margin_red": 0.30,   # P(margin call at next expiry)
    "cash_amber": 0.10, "cash_red": 0.30,       # P(assignment cash > cash), cash accounts
    "assign_listed": 0.50,                      # list a put in the expiry bullet when P(assign) ≥ this and ≤ 2 trading days left
}
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.pm_alerts (
  id serial PRIMARY KEY, generated_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS watchlist_sync.pm_book_latest (
  id int PRIMARY KEY CHECK (id = 1), generated_at timestamptz NOT NULL, book jsonb NOT NULL)"""
f = lambda v: f"${v:,.0f}"  # noqa: E731
LEVEL = {"green": 0, "amber": 1, "red": 2}


def write_last(ok: bool, detail: str, now: datetime) -> None:
    try:
        LAST_RUN.parent.mkdir(parents=True, exist_ok=True)
        LAST_RUN.write_text(json.dumps({"ts": now.isoformat(timespec="seconds"), "ok": ok, "detail": detail}))
    except OSError:
        pass


CREDIT_CSV = HERE / "out" / "opt" / "s028_inputs" / "BAA10Y.csv"  # same FRED series + cache S028 used


def credit_wide() -> dict | None:
    """S028 display signal: Baa−10y spread above its trailing 252-observation 80th percentile. FRED CSV refreshed at most
    once a day (1 small download); on any failure the last cached file is used, else None (no line shown)."""
    import time
    import urllib.request
    try:
        if not CREDIT_CSV.exists() or time.time() - CREDIT_CSV.stat().st_mtime > 20 * 3600:
            CREDIT_CSV.parent.mkdir(parents=True, exist_ok=True)
            data = urllib.request.urlopen("https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAA10Y", timeout=20).read()
            if b"BAA10Y" in data[:200]:
                CREDIT_CSV.write_bytes(data)
    except Exception:
        pass
    try:
        vals = []
        for line in CREDIT_CSV.read_text().splitlines()[1:]:
            d, _, v = line.partition(",")
            try:
                vals.append((d, float(v)))
            except ValueError:
                continue
        if len(vals) < 253:
            return None
        last_d, last = vals[-1]
        window = sorted(v for _, v in vals[-253:-1])
        p80 = window[int(0.8 * (len(window) - 1))]
        return {"on": last > p80, "spread": last, "p80": p80, "as_of": last_d}
    except Exception:
        return None


GEX_CSV = HERE / "out" / "opt" / "s034_inputs" / "DIX.csv"  # SqueezeMetrics SPX GEX/DIX (free, daily, 2011→)
GEX_URL = "https://squeezemetrics.com/monitor/static/DIX.csv"


def parse_gex_csv(text: str, keep: int = 260) -> list[tuple[str, float]]:
    """Pure: DIX.csv text (date,price,dix,gex) → last `keep` (date, gex $) rows, bad lines skipped."""
    lines = text.splitlines()
    if not lines or "gex" not in lines[0].lower():
        return []
    cols = [c.strip().lower() for c in lines[0].split(",")]
    di, gi = cols.index("date"), cols.index("gex")
    out = []
    for line in lines[1:]:
        f = line.split(",")
        try:
            out.append((f[di].strip(), float(f[gi])))
        except (ValueError, IndexError):
            continue
    return out[-keep:]


def gex_context(rows: list[tuple[str, float]], today: str) -> dict | None:
    """Pure: A134 display signal — latest SPX dealer gamma, sign, 1-y percentile, flip date, staleness (> 4 calendar days)."""
    if len(rows) < 20:
        return None
    as_of, last = rows[-1]
    neg = last < 0
    since = as_of
    for d, g in reversed(rows):
        if (g < 0) != neg:
            break
        since = d
    vals = [g for _, g in rows]
    pct = round(100 * sum(v <= last for v in vals) / len(vals))
    stale = (datetime.fromisoformat(today) - datetime.fromisoformat(as_of)).days > 4
    return {"negative": neg, "gex_bn": round(last / 1e9, 2), "pct_1y": pct, "since": since, "as_of": as_of, "stale": stale}


def dealer_gamma(now: datetime) -> dict | None:
    """A134 phase 1 (display only; S034 pending). CSV refreshed at most every 6 h (1 download); on failure the cached
    file is used, else None (no line shown)."""
    import time
    import urllib.request
    try:
        if not GEX_CSV.exists() or time.time() - GEX_CSV.stat().st_mtime > 6 * 3600:
            GEX_CSV.parent.mkdir(parents=True, exist_ok=True)
            req = urllib.request.Request(GEX_URL, headers={"User-Agent": "Mozilla/5.0 (Macintosh) fildi-pm-alerts"})
            data = urllib.request.urlopen(req, timeout=20).read()
            if b"gex" in data[:100]:
                GEX_CSV.write_bytes(data)
    except Exception as e:
        print(f"dealer_gamma: fetch failed ({e}); using cache", file=sys.stderr)
    try:
        return gex_context(parse_gex_csv(GEX_CSV.read_text()), now.date().isoformat())
    except Exception as e:
        print(f"dealer_gamma: unavailable ({e})", file=sys.stderr)
        return None


def market_hours(now: datetime) -> bool:
    return now.weekday() < 5 and (6, 30) <= (now.hour, now.minute) <= (13, 15)


def due(conn, now: datetime) -> bool:
    if market_hours(now):
        return True
    last = conn.execute("SELECT max(generated_at) FROM watchlist_sync.pm_alerts").fetchone()[0]
    return last is None or (now - last).total_seconds() >= 2 * 3600


def realized_vol(conn, tickers: list[str]) -> dict[str, float]:
    out = {}
    for t in tickers:
        px = [r["c"] for r in rows(conn, "SELECT close::float8 AS c FROM prices_historical WHERE ticker = %s ORDER BY date DESC LIMIT 61", (t,))]
        rets = [math.log(a / b) for a, b in zip(px, px[1:]) if a and b]
        out[t] = (sum(r * r for r in rets) / len(rets)) ** 0.5 * math.sqrt(252) if len(rets) > 20 else 0.6
    return out


def shrunk_corr(conn, tickers: list[str]):
    """A117: 60d log-return corr, shrunk 30% to I. Returns (names, C ndarray) or None."""
    try:
        import numpy as np
    except ImportError:
        return None
    names = sorted({t.upper() for t in tickers if t})
    if len(names) < 2:
        return None
    series = {}
    for t in names:
        px = rows(conn, "SELECT date::text AS d, close::float8 AS c FROM prices_historical WHERE ticker = %s ORDER BY date DESC LIMIT 61", (t,))
        if len(px) < 40:
            continue
        series[t] = {r["d"]: r["c"] for r in px if r["c"]}
    names = [t for t in names if t in series]
    if len(names) < 2:
        return None
    dates = sorted(set.intersection(*(set(series[t]) for t in names)))[-60:]
    if len(dates) < 30:
        return None
    mat = []
    for t in names:
        closes = [series[t][d] for d in dates]
        rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i] and closes[i - 1]]
        if len(rets) < 25:
            return None
        mat.append(rets)
    X = np.array(mat, dtype=float)  # n_names × T
    C = np.corrcoef(X)
    if not np.isfinite(C).all():
        return None
    n = C.shape[0]
    C = 0.7 * C + 0.3 * np.eye(n)
    return names, C


def effective_bets(conn, tickers: list[str]) -> dict | None:
    """A117: PCA 'effective bets' — n puts ≈ k independent bets from 60d return corr.
    effective_n = (Σ λ)² / Σ λ². Display only; ms cost noted in payload."""
    import time
    t0 = time.perf_counter()
    got = shrunk_corr(conn, tickers)
    if not got:
        return None
    try:
        import numpy as np
    except ImportError:
        return None
    names, C = got
    ev = np.linalg.eigvalsh(C)
    ev = np.clip(ev, 1e-9, None)
    eff = float((ev.sum() ** 2) / (ev * ev).sum())
    ms = (time.perf_counter() - t0) * 1000
    return {"n_puts": len(names), "effective": round(eff, 1), "ms": round(ms, 1)}


def _cholesky_L(conn, tickers: list[str]):
    """Lower-triangular L for shrunk corr (C = L Lᵀ), or None. Cost is O(n³) once per account."""
    got = shrunk_corr(conn, tickers)
    if not got:
        return None
    try:
        import numpy as np
    except ImportError:
        return None
    names, C = got
    # Claude review A117: 60d calm-period corr (~0.24 mean on a typical book) understates crash co-movement; S015's breach
    # clustering needs ρ ≈ 0.6. Stress floor per pair: max(empirical, RHO) keeps real clusters above 0.6, none below.
    C = np.maximum(C, RHO)
    np.fill_diagonal(C, 1.0)
    # clip eigenvalues so Cholesky always succeeds after shrink
    ev, V = np.linalg.eigh(C)
    ev = np.clip(ev, 1e-6, None)
    C = (V * ev) @ V.T
    # symmetrize numerical noise
    C = 0.5 * (C + C.T)
    try:
        L = np.linalg.cholesky(C)
    except np.linalg.LinAlgError:
        return None
    return names, L.tolist()


def _one_factor_draws(names: list[str], rng: random.Random) -> list[dict[str, float]]:
    draws = []
    for _ in range(PATHS):
        m = rng.gauss(0, 1)
        draws.append({n: math.sqrt(RHO) * m + math.sqrt(1 - RHO) * rng.gauss(0, 1) for n in names})
    return draws


def _cholesky_draws(names: list[str], L: list[list[float]], rng: random.Random) -> list[dict[str, float]]:
    n = len(names)
    draws = []
    for _ in range(PATHS):
        eps = [rng.gauss(0, 1) for _ in range(n)]
        z = {}
        for i, name in enumerate(names):
            s = 0.0
            row = L[i]
            for j in range(i + 1):
                s += row[j] * eps[j]
            z[name] = s
        draws.append(z)
    return draws


def _ticker_betas(conn, tickers: list[str]) -> dict[str, float]:
    """60d OLS beta vs SPY (display/scenario); default 1.0 when thin."""
    out = {t: 1.0 for t in tickers}
    if not conn or not tickers:
        return out
    spy = rows(conn, "SELECT date::text AS d, close::float8 AS c FROM prices_historical WHERE ticker = 'SPY' ORDER BY date DESC LIMIT 61")
    if len(spy) < 40:
        return out
    spy_m = {r["d"]: r["c"] for r in spy if r["c"]}
    for t in tickers:
        px = rows(conn, "SELECT date::text AS d, close::float8 AS c FROM prices_historical WHERE ticker = %s ORDER BY date DESC LIMIT 61", (t,))
        if len(px) < 40:
            continue
        tm = {r["d"]: r["c"] for r in px if r["c"]}
        dates = sorted(set(spy_m) & set(tm))[-60:]
        if len(dates) < 30:
            continue
        xs, ys = [], []
        for i in range(1, len(dates)):
            d0, d1 = dates[i - 1], dates[i]
            if spy_m[d0] and spy_m[d1] and tm[d0] and tm[d1]:
                xs.append(math.log(spy_m[d1] / spy_m[d0]))
                ys.append(math.log(tm[d1] / tm[d0]))
        if len(xs) < 25:
            continue
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
        var = sum((a - mx) ** 2 for a in xs)
        if var > 1e-12:
            out[t] = max(0.2, min(2.5, cov / var))
    return out


def _bs_put(S: float, K: float, t: float, v: float, r: float = 0.04) -> float:
    if S <= 0 or K <= 0 or t <= 0 or v <= 0:
        return max(K - S, 0.0)
    d1 = (math.log(S / K) + (r + 0.5 * v * v) * t) / (v * math.sqrt(t))
    d2 = d1 - v * math.sqrt(t)
    n = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))  # noqa: E731
    return K * math.exp(-r * t) * n(-d2) - S * n(-d1)


def _scenario_loss(b: dict, puts: list[dict], longs: list[dict], rets: dict[str, float]) -> float:
    """P&L loss (+) when each name moves by rets[ticker] (fraction). Short puts → intrinsic Δ; IV held."""
    loss = 0.0
    for x in longs:
        loss += -(x["mv"] or 0) * rets.get(x["t"], 0.0)
    for p in puts:
        if not p.get("spot") or not p.get("qty"):
            continue
        st = p["spot"] * (1 + rets.get(p["ticker"], 0.0))
        # Claude review A161: instant move → reprice (BS, IV held, time left), not intrinsic — OTM puts lose value too.
        t = max((date.fromisoformat(str(p["expiry"])[:10]) - date.today()).days, 1) / 365 if p.get("expiry") else 7 / 365
        iv = p.get("iv") or 0.6
        loss += (_bs_put(st, p["strike"], t, iv) - _bs_put(p["spot"], p["strike"], t, iv)) * 100 * p["qty"]
    return max(0.0, loss)


def _market_down10(b: dict, puts: list[dict], longs: list[dict], betas: dict[str, float]) -> dict:
    """A161: −10% SPY scenario — each name × (1 − β·0.10); IV held = understates."""
    rets = {t: -0.10 * betas.get(t, 1.0) for t in {p["ticker"] for p in puts} | {x["t"] for x in longs}}
    loss = _scenario_loss(b, puts, longs, rets)
    eq = float(b.get("equity") or 0)
    return {
        "loss": round(loss, 0),
        "pct": round(loss / eq, 4) if eq else None,
        "label": "−10% SPY · β-scaled · IV held (understates vol spike)",
    }


def _hist_var(conn, b: dict, puts: list[dict], longs: list[dict], days: int = 504) -> dict | None:
    """A161: historical 1-day book loss from aligned ticker returns (~2y)."""
    if not conn:
        return None
    names = sorted({p["ticker"] for p in puts} | {x["t"] for x in longs})
    if len(names) < 1:
        return None
    series = {}
    for t in names:
        px = rows(conn, "SELECT date::text AS d, close::float8 AS c FROM prices_historical WHERE ticker = %s ORDER BY date DESC LIMIT %s",
                  (t, days + 1))
        if len(px) < 60:
            return None
        series[t] = {r["d"]: r["c"] for r in px if r["c"]}
    dates = sorted(set.intersection(*(set(series[t]) for t in names)))
    if len(dates) < 60:
        return None
    losses = []
    for i in range(1, len(dates)):
        d0, d1 = dates[i - 1], dates[i]
        rets = {}
        ok = True
        for t in names:
            a, c = series[t].get(d0), series[t].get(d1)
            if not a or not c:
                ok = False
                break
            rets[t] = c / a - 1
        if not ok:
            continue
        losses.append(_scenario_loss(b, puts, longs, rets))
    if len(losses) < 60:
        return None
    losses.sort()
    n = len(losses)
    return {
        "var95": round(losses[int(0.95 * (n - 1))], 0),
        "var99": round(losses[int(0.99 * (n - 1))], 0),
        "n_days": n,
        "method": "historical_1d",
    }


def simulate(book: dict, acct: str, longs: list[dict], vols: dict[str, float], rng: random.Random,
             conn=None, extra_names: frozenset[str] = frozenset()) -> dict | None:
    import time
    b = book["accounts"][acct]
    puts = [p for p in book["positions"]
            if p["account"] == acct and p.get("iv") and p.get("status") != "unknown" and p.get("spot")]
    if not puts:
        return None
    near = min(p["expiry"] for p in puts)
    days = min(p["days_left"] for p in puts if p["expiry"] == near)
    t = max(days, 0.5) / 252
    # A205 u4: extra_names lets base and with-candidate runs draw over the same name set (common draws).
    names = sorted({p["ticker"] for p in puts} | {x["t"] for x in longs} | set(extra_names))
    ratio, margin = b.get("maint_ratio_est"), "maint_ratio_est" in b
    expiring = [p for p in puts if p["expiry"] == near]
    # A260: MC is front-expiry only — surface notional by every expiry so the label is honest.
    notional_by_expiry: dict[str, float] = {}
    for p in puts:
        k = str(p["expiry"])
        notional_by_expiry[k] = notional_by_expiry.get(k, 0.0) + float(
            p.get("assign_cash") or (p["strike"] * 100 * p["qty"]))
    # A117: empirical Cholesky when history is thick enough; else S015 one-factor
    corr_mode = "one_factor"
    t0 = time.perf_counter()
    chol = _cholesky_L(conn, names) if conn is not None and len(names) >= 2 else None
    if chol and set(chol[0]) >= set(names):
        c_names, L = chol
        draws = [{n: z[n] for n in names} for z in _cholesky_draws(c_names, L, rng)]
        corr_mode = "cholesky"
    else:
        draws = _one_factor_draws(names, rng)
    corr_ms = (time.perf_counter() - t0) * 1000

    def run(closed: frozenset[int], track_loss: bool = False) -> dict:
        calls = short = 0
        assign_cash = []
        losses = []
        n_assigned = [0] * len(expiring)
        eq0 = float(b["equity"] or 0)
        for z in draws:
            eq, req_long, cash_need = eq0, 0.0, 0.0
            for x in longs:
                s = vols.get(x["t"], 0.6)
                r = math.exp(-0.5 * s * s * t + s * math.sqrt(t) * z[x["t"]])
                eq += (x["mv"] or 0) * (r - 1)
                req_long += (x["mv"] or 0) * r
            for i, p in enumerate(expiring):
                if i in closed:
                    continue
                s = p["iv"]
                st = p["spot"] * math.exp(-0.5 * s * s * t + s * math.sqrt(t) * z[p["ticker"]])
                mark = p["close_cost"] / (100 * p["qty"]) if p["qty"] else 0
                eq += (mark - max(p["strike"] - st, 0)) * 100 * p["qty"]
                if st < p["strike"]:
                    n_assigned[i] += 1
                    cash_need += p["assign_cash"]
                    req_long += st * 100 * p["qty"]
            assign_cash.append(cash_need)
            if track_loss:
                losses.append(max(0.0, eq0 - eq))
            if margin and eq < ratio * req_long:
                calls += 1
            if not margin and cash_need > max(b["cash"], 0) + 1:
                short += 1
        assign_cash.sort()
        out = {"p_call": calls / PATHS if margin else None, "p_short": short / PATHS if not margin else None,
               "assign_p90": assign_cash[int(0.9 * PATHS)], "p_assign": [n / PATHS for n in n_assigned]}
        if track_loss and losses:
            losses.sort()
            out["var95"] = round(losses[int(0.95 * (PATHS - 1))], 0)
            out["var99"] = round(losses[int(0.99 * (PATHS - 1))], 0)
        return out

    base = run(frozenset(), track_loss=True)
    key = "p_call" if margin else "p_short"
    amber = THRESH["margin_amber"] if margin else THRESH["cash_amber"]
    # cheapest closes (per $ of close cost) that bring the risk under the amber line — information, not advice
    closed, cost, cur = set(), 0.0, base
    while cur[key] is not None and cur[key] >= amber and len(closed) < len(expiring):
        best = None
        for i, p in enumerate(expiring):
            if i in closed:
                continue
            r = run(frozenset(closed | {i}))
            gain = (cur[key] - r[key]) / max(p["close_cost"], 1)
            if best is None or gain > best[0]:
                best = (gain, i, r)
        closed.add(best[1]); cost += expiring[best[1]]["close_cost"]; cur = best[2]

    # A161 VaR block (same engine — no second risk model)
    betas = _ticker_betas(conn, names)
    m10 = _market_down10(b, puts, longs, betas)
    hist = _hist_var(conn, b, puts, longs) if conn is not None else None
    var95, var99 = base.get("var95"), base.get("var99")
    disagree = None
    if hist and var95 and hist["var95"] > 0:
        ratio_d = abs(hist["var95"] - var95) / max(var95, 1)
        if ratio_d > 0.30:
            disagree = {"hist_var95": hist["var95"], "mc_var95": var95, "rel": round(ratio_d, 2)}
    eq = float(b.get("equity") or 0)
    var = {
        "var95": var95, "var99": var99,
        "var95_pct": round(var95 / eq, 4) if var95 is not None and eq else None,
        "var99_pct": round(var99 / eq, 4) if var99 is not None and eq else None,
        "method": f"mc_{corr_mode}",
        "horizon": f"{days}d_to_{near}",
        "market_m10": m10,
        "hist": hist if disagree else None,  # only surface hist when it disagrees >30%
        "disagree": disagree,
        "calibrated": False,  # Kupiec study pending — show as provisional
        "note": "provisional — Kupiec 4–7% breach gate pending (A161)",
    }

    return {"expiry": near, "days_left": days, "margin": margin, "risk": base[key], "assign_p90": base["assign_p90"],
            "corr": corr_mode, "corr_ms": round(corr_ms, 1), "var": var,
            "front_expiry_only": True,  # A260: MC paths cover nearest expiry only
            "notional_by_expiry": dict(sorted(notional_by_expiry.items())),
            "puts": [{**p, "p_assign": pa} for p, pa in zip(expiring, base["p_assign"])],
            "fix": {"close": [f"{expiring[i]['ticker']} {expiring[i]['strike']:g}P" for i in sorted(closed)], "cost": cost,
                    "risk_after": cur[key], "front_expiry_only": True} if closed else None}


def _crash_drop(book: dict, acct: str) -> float | None:
    """Same 30% crash-week scenario as pm_book (fraction of equity lost)."""
    b = book["accounts"].get(acct) or {}
    eq = b.get("equity") or 0
    if not eq:
        return None
    crash = -0.30
    ps = [p for p in book.get("positions") or [] if p.get("account") == acct and p.get("spot") and p.get("strike")]
    put_loss = sum(
        max(p["strike"] - p["spot"] * (1 + crash), 0) * 100 * p["qty"] - (p.get("close_cost") or 0)
        for p in ps
    )
    # longs haircut ~30% of MV already baked into pm_book crash_equity; approximate via equity − put_loss
    crash_eq = max(eq - put_loss - 0.30 * sum(
        (x.get("mv") or 0) for x in []  # longs handled in book["accounts"][acct]["crash_drop_pct"] when present
    ), 0)
    # Prefer book-computed crash when no candidate; with candidate recompute from puts only + scale
    base_drop = b.get("crash_drop_pct")
    if base_drop is None:
        return 1 - crash_eq / eq if eq else None
    # Scale: add incremental put loss vs equity
    # When positions include a candidate, put_loss grows → bump drop
    base_ps = [p for p in book.get("positions") or [] if p.get("account") == acct and not p.get("_candidate")]
    base_loss = sum(
        max(p["strike"] - p["spot"] * (1 + crash), 0) * 100 * p["qty"] - (p.get("close_cost") or 0)
        for p in base_ps if p.get("spot") and p.get("strike")
    )
    new_loss = sum(
        max(p["strike"] - p["spot"] * (1 + crash), 0) * 100 * p["qty"] - (p.get("close_cost") or 0)
        for p in ps if p.get("spot") and p.get("strike")
    )
    return min(1.0, (base_drop or 0) + max(0.0, (new_loss - base_loss) / eq))


def what_if_add_put(
    book: dict,
    acct: str,
    ticker: str,
    strike: float,
    expiry: str,
    qty: int,
    iv: float,
    spot: float,
    premium: float | None = None,
    earnings_days_out: int | None = None,
) -> dict:
    """A136 — candidate mode. Returns base vs with-candidate risk + badge (green/amber/red)."""
    acct_ids = {"IRA": "772445425", "FILDI": "5QU47796"}
    if acct not in book.get("accounts", {}):
        return {"error": f"unknown account {acct}"}
    days = max((date.fromisoformat(expiry) - date.today()).days, 0)
    prem = premium if premium is not None else 0.0
    cand = {
        "account": acct, "ticker": ticker.upper(), "strike": float(strike), "expiry": expiry,
        "qty": int(qty), "iv": float(iv), "spot": float(spot),
        "close_cost": float(prem) * 100 * int(qty),
        "assign_cash": float(strike) * 100 * int(qty),
        "days_left": days, "status": "ok", "itm": float(spot) < float(strike),
        "_candidate": True,
    }
    snap = book["snapshot_id"]
    with connect() as conn:
        allongs = rows(conn, """SELECT account, UPPER(symbol) AS t, SUM(market_value)::float8 AS mv FROM portfolio_positions
                                WHERE snapshot_id = %s GROUP BY 1, 2""", (snap,))
        longs = [x for x in allongs if x["account"] == acct_ids.get(acct)]
        vols = realized_vol(conn, sorted({x["t"] for x in longs} | {cand["ticker"]}))
        seed = int(snap) if snap else 0
        extra = frozenset({cand["ticker"]})
        # A205 u4: fresh rng with one seed per run → identical draws, so Δ is the trade, not sampling noise.
        base_sim = simulate(book, acct, longs, vols, random.Random(seed), conn=conn, extra_names=extra)
        book2 = copy.deepcopy(book)
        book2["positions"] = list(book2.get("positions") or []) + [cand]
        with_sim = simulate(book2, acct, longs, vols, random.Random(seed), conn=conn, extra_names=extra)

    rules = book.get("rules") or {"crash_budget": 0.25, "crash_warn": 0.20}
    crash_base = book["accounts"][acct].get("crash_drop_pct")
    crash_with = _crash_drop(book2, acct)

    def band(risk: float | None, margin: bool) -> str | None:
        if risk is None:
            return None  # A205 u4: missing risk is unknown, never green
        lo = THRESH["margin_amber"] if margin else THRESH["cash_amber"]
        hi = THRESH["margin_red"] if margin else THRESH["cash_red"]
        if risk >= hi:
            return "red"
        if risk >= lo:
            return "amber"
        return "green"

    margin = bool((with_sim or base_sim or {}).get("margin")) if (with_sim or base_sim) else True
    risk_base = base_sim["risk"] if base_sim else None
    risk_with = with_sim["risk"] if with_sim else None
    base_exp = str(base_sim["expiry"]) if base_sim else None
    with_exp = str(with_sim["expiry"]) if with_sim else None
    cand_in_mc = with_exp == str(expiry)
    same_horizon = base_exp is not None and base_exp == with_exp
    # A205 u4: MC covers the nearest expiry only → list what each run left out.
    excluded_with = {k: round(v) for k, v in ((with_sim or {}).get("notional_by_expiry") or {}).items() if k != with_exp}
    coverage = {
        "method": "mc_front_expiry_only" if with_sim else None,
        "paths": PATHS,
        "common_draws": True,
        "base_expiry": base_exp,
        "with_expiry": with_exp,
        "candidate_in_mc": cand_in_mc,
        "excluded_notional": excluded_with,
        "crash_covers_candidate": crash_with is not None,
        "snapshot_id": snap,
        "book_generated_at": book.get("generated_at"),
    }
    mc_band = band(risk_with, margin) if cand_in_mc else None
    badge = mc_band
    if crash_with is not None and crash_with > rules.get("crash_budget", 0.25):
        badge = "red"
    elif crash_with is not None and crash_with > rules.get("crash_warn", 0.20) and badge in (None, "green"):
        badge = "amber"
    elif badge is None and crash_with is not None:
        badge = "partial"  # crash-week counts the trade; the MC did not → not a whole-trade clearance

    er_flag = earnings_days_out is not None and 0 <= earnings_days_out <= days
    reasons = []
    risk_delta = None
    if risk_base is not None and risk_with is not None and same_horizon:
        risk_delta = risk_with - risk_base
        reasons.append(f"P(risk) {risk_base:.0%} → {risk_with:.0%} (Δ {risk_delta:+.0%}) to {with_exp}")
    elif risk_base is None and risk_with is not None:
        reasons.append(f"P(risk) with trade {risk_with:.0%}; no base run (no open puts with IV) — Δ not computed")
    elif risk_base is not None and risk_with is not None:
        reasons.append(f"MC horizon moved {base_exp} → {with_exp}; Δ not comparable")
    if not cand_in_mc:
        reasons.append(f"MC covers {with_exp or 'nothing'} only; {expiry} put counted in crash-week only")
    if crash_base is not None and crash_with is not None:
        reasons.append(f"crash-week drop {crash_base:.0%} → {crash_with:.0%}")
    elif crash_with is not None:
        reasons.append(f"crash-week drop with trade {crash_with:.0%} (no base)")
    if risk_with is None and crash_with is None:
        badge = "unknown"
        reasons.append("no simulation and no crash scenario — risk unknown, not zero")
    if er_flag:
        reasons.append(f"earnings in {earnings_days_out}d inside DTE ({days}d)")
        if badge in ("green", "partial"):
            badge = "amber"

    return {
        "account": acct,
        "candidate": {k: cand[k] for k in ("ticker", "strike", "expiry", "qty", "iv", "spot")},
        "badge": badge or "unknown",
        "risk_base": risk_base,
        "risk_with": risk_with,
        "risk_delta": risk_delta,
        "crash_base": crash_base,
        "crash_with": crash_with,
        "earnings_in_dte": er_flag,
        "coverage": coverage,
        "reasons": reasons,
        "note": "Advisory only — Jamie overrides freely (A136).",
    }


def bullets(book: dict, sims: dict) -> list[dict]:
    out = []
    for acct, b in book["accounts"].items():
        s = sims.get(acct)
        if s:
            r, kind = s["risk"], "margin call" if s["margin"] else "assignment > cash"
            lo, hi = (THRESH["margin_amber"], THRESH["margin_red"]) if s["margin"] else (THRESH["cash_amber"], THRESH["cash_red"])
            if r >= lo:
                # A260: label MC as front-expiry only; append later-expiry notional when the book spans weeks.
                txt = (f"{acct}: {r:.0%} chance of a {kind} at front expiry {s['expiry'][5:]} only "
                       f"(bad-case assignment {f(s['assign_p90'])}).")
                later = {k: v for k, v in (s.get("notional_by_expiry") or {}).items() if k != str(s["expiry"])}
                if later:
                    bits = ", ".join(f"{k[5:]} {f(v)}" for k, v in sorted(later.items()))
                    txt += f" Later-expiry assign notional (not in MC): {bits}."
                if s["fix"]:
                    txt += (f" Closing {', '.join(s['fix']['close'])} ({f(s['fix']['cost'])}) → "
                            f"{s['fix']['risk_after']:.0%} (front expiry only).")
                out.append({"key": f"{acct}:{'margin' if s['margin'] else 'cash'}", "level": "red" if r >= hi else "amber", "text": txt, "value": r})
            likely = [p for p in s["puts"] if p["p_assign"] >= THRESH["assign_listed"]]
            if likely and s["days_left"] <= 2:
                top = sorted(likely, key=lambda p: -p["p_assign"])
                names = ", ".join(f"{p['ticker']} {p['strike']:g}P {p['p_assign']:.0%}" for p in top[:5]) + (f" +{len(top) - 5} more" if len(top) > 5 else "")
                out.append({"key": f"{acct}:expiry", "level": "amber", "value": len(likely),
                            "text": f"{acct}: likely assigned {s['expiry'][5:]}: {names}; cash needed if all {f(sum(p['assign_cash'] for p in likely))}."})
        if b.get("unknown_puts"):
            out.append({"key": f"{acct}:unknown", "level": "amber", "value": b["unknown_puts"],
                        "text": f"{acct}: {b['unknown_puts']} put(s) have no price, so they are left out of the odds above (risk understated)."})
        drop, rules = b.get("crash_drop_pct") or 0, book["rules"]
        if drop > rules["crash_warn"]:
            out.append({"key": f"{acct}:crash", "level": "red" if drop > rules["crash_budget"] else "amber", "value": drop,
                        "text": f"{acct}: if every name fell 30% in a week, equity −{drop:.0%} (budget {rules['crash_budget']:.0%}). "
                                f"New puts here add to it."})
    return sorted(out, key=lambda x: (-LEVEL[x["level"]], x["key"]))


def peer_drift_alert(conn) -> list[dict]:
    """A200: one deduped Portfolio Alert from peers_review flags (GICS / OpenJev ≥0.8). Detect-only.

    Mute when >30% of assignments flag (threshold too loose). Approve via Settings › Stock DB › Peer groups
    (writes peer_group_overrides) — never auto-moves.
    """
    import openjev_controls as ojc
    flags, n_assign = ojc.peer_drift_flags(conn)
    if not flags:
        return []
    if n_assign > 0 and len(flags) / n_assign > 0.30:
        # Keep file; suppress noisy alert (Claude plan eval).
        (HERE / "out" / "peer_drift_muted.json").write_text(json.dumps({
            "asOf": date.today().isoformat(), "nFlags": len(flags), "nAssignments": n_assign, "muted": True,
        }) + "\n")
        return []
    # Cap bullet length — top 8 by ticker, rest as +N.
    show = flags[:8]
    bits = [f"{f['ticker']} now {f['now']}→{f['suggest']} ({f['detail']})" for f in show]
    extra = f" +{len(flags) - 8} more" if len(flags) > 8 else ""
    return [{"key": "peer:drift", "level": "amber", "value": len(flags),
             "text": (f"Peer-group drift ({len(flags)} name(s)): {'; '.join(bits)}{extra}. "
                      f"Detect-only — approve or dismiss in Settings › Stock DB › Peer groups "
                      f"(override writes peer_group_overrides; nothing moves alone).")}]


def holdings_on_avoid(conn, allongs: list[dict]) -> list[dict]:
    """A174 (S044): stock holdings that the latest published Model List puts in Avoid. Display only — the trade is Jamie's call."""
    held = sorted({x["t"] for x in allongs if (x.get("mv") or 0) > 0})
    if not held:
        return []
    latest = rows(conn, """SELECT i.ticker FROM watchlist_sync.model_items i
                           WHERE i.run_id = (SELECT MAX(id) FROM watchlist_sync.model_runs) AND i.folder_key = 'avoid'
                             AND UPPER(i.ticker) = ANY(%s)""", (held,))
    names = sorted({r["ticker"].upper() for r in latest})
    if not names:
        return []
    out = []
    for t in names:
        # first day of the current Avoid streak (runs in the last 60 days), and the move since then vs SPY
        first = rows(conn, """SELECT MIN(r.created_at)::date AS d FROM watchlist_sync.model_runs r
                              JOIN watchlist_sync.model_items i ON i.run_id = r.id
                              WHERE UPPER(i.ticker) = %s AND i.folder_key = 'avoid' AND r.created_at > now() - interval '60 days'""", (t,))[0]["d"]
        px = rows(conn, """SELECT ticker, (array_agg(close ORDER BY date) FILTER (WHERE date >= %s))[1]::float8 AS p0,
                                  (array_agg(close ORDER BY date DESC))[1]::float8 AS p1
                           FROM prices_historical WHERE ticker IN (%s, 'SPY') AND date >= %s GROUP BY 1""", (first, t, first))
        p = {r["ticker"]: r for r in px}
        rel = None
        if t in p and "SPY" in p and p[t]["p0"] and p["SPY"]["p0"]:
            rel = (p[t]["p1"] / p[t]["p0"] - 1) - (p["SPY"]["p1"] / p["SPY"]["p0"] - 1)
        out.append(f"{t} (since {str(first)[5:]}{f', {rel:+.0%} vs SPY' if rel is not None else ''})")
    return [{"key": "avoid:holdings", "level": "amber", "value": len(names),
             "text": f"You hold {len(names)} name(s) the Model List rates Avoid: {', '.join(out)}. Your call — Avoid names lagged "
                     f"SPY by ~9 pp in week 1 (S044, one week, mostly high-vol names)."}]


def main() -> None:
    now = datetime.now(PT)
    conn = connect()
    for stmt in DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    conn.commit()
    if "--now" not in sys.argv and not due(conn, now):
        return
    # always try Schwab (after hours = closing quotes; RH snapshot IVs disagree with Schwab's); pm_book falls back
    r = subprocess.run([sys.executable, str(HERE / "pm_book.py"), "--live"], cwd=HERE, capture_output=True, text=True)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "pm_book failed")[:280]
        payload = {
            "generated": now.isoformat(timespec="seconds"), "priced_at": now.isoformat(timespec="seconds"),
            "prices": "failed", "snapshot_at": None,
            "bullets": [{"key": "book_failed", "level": "amber", "text": f"Book check failed: {err}", "value": 0, "change": "new"}],
            "cleared": [], "model": {}, "accounts": {},
        }
        conn.execute("INSERT INTO watchlist_sync.pm_alerts (payload) VALUES (%s)", (json.dumps(payload, default=str),))
        conn.commit()
        if "--now" in sys.argv:
            print(f"[amber] Book check failed: {err}")
        write_last(False, f"pm_book failed: {err[:120]}", now)
        return
    book = json.loads((OUT / "book-latest.json").read_text())
    acct_ids = {"IRA": "772445425", "FILDI": "5QU47796"}
    snap = book["snapshot_id"]
    allongs = rows(conn, """SELECT account, UPPER(symbol) AS t, SUM(market_value)::float8 AS mv FROM portfolio_positions
                            WHERE snapshot_id = %s GROUP BY 1, 2""", (snap,))
    vols = realized_vol(conn, sorted({x["t"] for x in allongs}))
    rng = random.Random(snap)
    sims = {a: simulate(book, a, [x for x in allongs if x["account"] == acct_ids.get(a)], vols, rng, conn=conn)
            for a in book["accounts"]}
    prev = conn.execute("SELECT payload FROM watchlist_sync.pm_alerts ORDER BY id DESC LIMIT 1").fetchone()
    prev = {x["key"]: x for x in (prev[0]["bullets"] if prev else [])}
    bl = bullets(book, sims)
    try:
        bl += holdings_on_avoid(conn, allongs)
    except Exception as e:  # display-only context must never break the risk alerts
        print(f"holdings_on_avoid skipped ({e})", file=sys.stderr)
    try:
        bl += peer_drift_alert(conn)
    except Exception as e:
        print(f"peer_drift_alert skipped ({e})", file=sys.stderr)
    for x in bl:
        p = prev.get(x["key"])
        x["change"] = "new" if not p else "worse" if (LEVEL[x["level"]], x["value"]) > (LEVEL[p["level"]], p["value"] * 1.1) else \
                      "better" if (LEVEL[x["level"]], x["value"]) < (LEVEL[p["level"]], p["value"] * 0.9) else None
    corr_modes = [s["corr"] for s in sims.values() if s and s.get("corr")]
    corr_mode = "cholesky" if corr_modes and all(m == "cholesky" for m in corr_modes) else (
        "mixed" if "cholesky" in corr_modes else "one_factor")
    corr_ms = max((s.get("corr_ms") or 0) for s in sims.values() if s) if any(sims.values()) else 0
    payload = {"generated": now.isoformat(timespec="seconds"), "priced_at": book.get("live_priced_at") or book["snapshot_at"],
               "prices": "live Schwab" if book.get("live_priced_at") else "Robinhood snapshot", "snapshot_at": book["snapshot_at"],
               "bullets": bl, "cleared": [k for k in prev if k not in {x["key"] for x in bl}],
               "model": {"rho": RHO, "corr": corr_mode, "corr_ms": round(corr_ms, 1),
                         "paths": PATHS, "thresholds": THRESH, "rules": book["rules"]},
               "accounts": {a: {"status": b["status"], **({"risk": sims[a]["risk"], "expiry": sims[a]["expiry"]} if sims.get(a) else {})}
                            for a, b in book["accounts"].items()},
               "credit": credit_wide(),  # S028 market context (display only)
               "gamma": dealer_gamma(now),  # A134 SPX dealer gamma (display only; S034 pending)
               # A117: PCA effective bets across short-put underlyings (display only)
               "bets": effective_bets(conn, sorted({p["ticker"] for s in sims.values() if s for p in s["puts"]})),
               # per-put odds, kept so analysis/scoreboard.py can grade them at expiry (live calibration of S016)
               "predictions": [{"account": a, "ticker": p["ticker"], "strike": p["strike"], "expiry": str(s["expiry"]),
                                "p_assign": round(p["p_assign"], 4)} for a, s in sims.items() if s for p in s["puts"]]}
    # A161: attach VaR onto book accounts before persist (Book card reads pm_book_latest)
    for a, s in sims.items():
        if s and s.get("var") and a in book.get("accounts", {}):
            book["accounts"][a]["var"] = s["var"]
    book["var_as_of"] = now.isoformat(timespec="seconds")
    (OUT / "book-latest.json").write_text(json.dumps(book, default=str))
    conn.execute("INSERT INTO watchlist_sync.pm_alerts (payload) VALUES (%s)", (json.dumps(payload, default=str),))
    conn.execute("""INSERT INTO watchlist_sync.pm_book_latest (id, generated_at, book) VALUES (1, now(), %s)
                    ON CONFLICT (id) DO UPDATE SET generated_at = now(), book = excluded.book""", (json.dumps(book, default=str),))
    conn.commit()
    try:  # A129 forecast ledger: log today's questions + resolve past ones (never breaks this run)
        from forecast_ledger import run_after_pm_alerts
        run_after_pm_alerts(conn)
    except Exception as e:
        print(f"forecast_ledger hook skipped ({e})", file=sys.stderr)
    write_last(True, f"{len(bl)} bullet(s) · {payload['prices']}", now)
    if "--now" in sys.argv:
        for x in bl:
            print(f"[{x['level']}{' · ' + x['change'] if x['change'] else ''}] {x['text']}")


def _cmd_what_if(argv: list[str]) -> None:
    # --what-if ACCOUNT TICKER STRIKE EXPIRY QTY IV SPOT [PREMIUM]
    if len(argv) < 8:
        print(json.dumps({"error": "usage: --what-if ACCOUNT TICKER STRIKE EXPIRY QTY IV SPOT [PREMIUM]"}))
        sys.exit(2)
    _, acct, ticker, strike, expiry, qty, iv, spot, *rest = argv
    premium = float(rest[0]) if rest else None
    book_path = OUT / "book-latest.json"
    if not book_path.exists():
        print(json.dumps({"error": "no book-latest.json — run pm_alerts --now first"}))
        sys.exit(1)
    book = json.loads(book_path.read_text())
    # earnings days from technicals if present
    er = None
    try:
        with connect() as conn:
            r = conn.execute(
                "SELECT earnings_days_out FROM ticker_technicals WHERE UPPER(ticker) = %s",
                (ticker.upper(),),
            ).fetchone()
            er = int(r[0]) if r and r[0] is not None else None
    except Exception:
        er = None
    out = what_if_add_put(
        book, acct, ticker, float(strike), expiry, int(qty), float(iv), float(spot),
        premium=premium, earnings_days_out=er,
    )
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    try:
        if "--what-if" in sys.argv:
            i = sys.argv.index("--what-if")
            _cmd_what_if(sys.argv[i:])
        else:
            main()
    except Exception as e:  # startup/DB failure → Settings › Scheduled Tasks shows "failed", not a stale "ok" (A112)
        if "--what-if" in sys.argv:
            print(json.dumps({"error": f"{type(e).__name__}: {str(e)[:200]}"}))
            sys.exit(1)
        write_last(False, f"crashed: {type(e).__name__}: {str(e)[:120]}", datetime.now(PT))
        raise
