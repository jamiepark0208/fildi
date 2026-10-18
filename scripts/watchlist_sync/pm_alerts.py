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


def simulate(book: dict, acct: str, longs: list[dict], vols: dict[str, float], rng: random.Random,
             conn=None) -> dict | None:
    import time
    b = book["accounts"][acct]
    puts = [p for p in book["positions"]
            if p["account"] == acct and p.get("iv") and p.get("status") != "unknown" and p.get("spot")]
    if not puts:
        return None
    near = min(p["expiry"] for p in puts)
    days = min(p["days_left"] for p in puts if p["expiry"] == near)
    t = max(days, 0.5) / 252
    names = sorted({p["ticker"] for p in puts} | {x["t"] for x in longs})
    ratio, margin = b.get("maint_ratio_est"), "maint_ratio_est" in b
    expiring = [p for p in puts if p["expiry"] == near]
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

    def run(closed: frozenset[int]) -> dict:
        calls = short = 0
        assign_cash = []
        n_assigned = [0] * len(expiring)
        for z in draws:
            eq, req_long, cash_need = b["equity"], 0.0, 0.0
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
            if margin and eq < ratio * req_long:
                calls += 1
            if not margin and cash_need > max(b["cash"], 0) + 1:
                short += 1
        assign_cash.sort()
        return {"p_call": calls / PATHS if margin else None, "p_short": short / PATHS if not margin else None,
                "assign_p90": assign_cash[int(0.9 * PATHS)], "p_assign": [n / PATHS for n in n_assigned]}

    base = run(frozenset())
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
    return {"expiry": near, "days_left": days, "margin": margin, "risk": base[key], "assign_p90": base["assign_p90"],
            "corr": corr_mode, "corr_ms": round(corr_ms, 1),
            "puts": [{**p, "p_assign": pa} for p, pa in zip(expiring, base["p_assign"])],
            "fix": {"close": [f"{expiring[i]['ticker']} {expiring[i]['strike']:g}P" for i in sorted(closed)], "cost": cost,
                    "risk_after": cur[key]} if closed else None}


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
        rng = random.Random(int(snap) if snap else 0)
        base_sim = simulate(book, acct, longs, vols, rng, conn=conn)
        book2 = copy.deepcopy(book)
        book2["positions"] = list(book2.get("positions") or []) + [cand]
        with_sim = simulate(book2, acct, longs, vols, rng, conn=conn)

    rules = book.get("rules") or {"crash_budget": 0.25, "crash_warn": 0.20}
    crash_base = book["accounts"][acct].get("crash_drop_pct")
    crash_with = _crash_drop(book2, acct)

    def band(risk: float | None, margin: bool) -> str:
        if risk is None:
            return "green"
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
    badge = band(risk_with, margin)
    if crash_with is not None and crash_with > rules.get("crash_budget", 0.25):
        badge = "red"
    elif crash_with is not None and crash_with > rules.get("crash_warn", 0.20) and badge == "green":
        badge = "amber"

    er_flag = earnings_days_out is not None and 0 <= earnings_days_out <= days
    reasons = []
    if risk_base is not None and risk_with is not None:
        reasons.append(f"P(risk) {risk_base:.0%} → {risk_with:.0%} (Δ {(risk_with - risk_base):+.0%})")
    if crash_base is not None and crash_with is not None:
        reasons.append(f"crash-week drop {crash_base:.0%} → {crash_with:.0%}")
    if er_flag:
        reasons.append(f"earnings in {earnings_days_out}d inside DTE ({days}d)")
        if badge == "green":
            badge = "amber"

    return {
        "account": acct,
        "candidate": {k: cand[k] for k in ("ticker", "strike", "expiry", "qty", "iv", "spot")},
        "badge": badge,
        "risk_base": risk_base,
        "risk_with": risk_with,
        "risk_delta": (risk_with - risk_base) if risk_base is not None and risk_with is not None else None,
        "crash_base": crash_base,
        "crash_with": crash_with,
        "earnings_in_dte": er_flag,
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
                txt = f"{acct}: {r:.0%} chance of a {kind} at {s['expiry'][5:]} expiry (bad-case assignment {f(s['assign_p90'])})."
                if s["fix"]:
                    txt += f" Closing {', '.join(s['fix']['close'])} ({f(s['fix']['cost'])}) → {s['fix']['risk_after']:.0%}."
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
