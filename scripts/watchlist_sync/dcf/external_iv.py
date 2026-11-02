"""Outside intrinsic-value estimates next to Fildi fair value (A283; Jamie 10-27: "display them next to our estimate").
One home: watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail).
  starmine   LSEG StarMine intrinsic value = LSEG close ÷ price_to_intrinsic (signals_daily, already fetched daily; no call)
  fmp_dcf    FMP /stable/discounted-cash-flow (unlevered) + levered-discounted-cash-flow. Large caps only on our plan
             (TTD/IONQ return "Premium"); budget 220/day shared → at most --max calls a run, watchlist first, refreshed
             when older than 7 days; a Premium refusal is stored and retried after 30 days.
Raw FMP responses go to vendor_raw; calls are metered in api_usage (source fmp).
Usage: .venv/bin/python dcf/external_iv.py [--max 60] [TICKERS...]"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vendor_gate  # noqa: E402  (A303 shared cross-process budget)
from build_plan import connect, rows  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.external_intrinsic (
  ticker text NOT NULL, as_of date NOT NULL, source text NOT NULL, value double precision, price double precision,
  detail jsonb, PRIMARY KEY (ticker, as_of, source))"""
FMP = "https://financialmodelingprep.com/stable"


def _meter(conn, n: int) -> None:
    if n > 0:
        conn.execute("""INSERT INTO api_usage (source, date, calls_made) VALUES ('fmp', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s)
                        ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + EXCLUDED.calls_made, updated_at = now()""", (n,))


def starmine(conn) -> int:
    n = conn.execute("""INSERT INTO watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail)
        SELECT DISTINCT ON (ticker) ticker, as_of, 'starmine', price_close / price_to_intrinsic, price_close,
               jsonb_build_object('price_to_intrinsic', price_to_intrinsic)
        FROM lseg_research.signals_daily WHERE price_to_intrinsic > 0 AND price_close > 0 AND as_of >= CURRENT_DATE - 10
        ORDER BY ticker, as_of DESC
        ON CONFLICT (ticker, as_of, source) DO UPDATE SET value = EXCLUDED.value, price = EXCLUDED.price, detail = EXCLUDED.detail""").rowcount
    return n


def _key() -> str | None:
    if not os.environ.get("FMP_API_KEY"):  # daily.py runs without the API server's env → read the repo .env.local
        env = Path(__file__).resolve().parents[3] / ".env.local"
        for line in env.read_text().splitlines() if env.exists() else []:
            if line.startswith("FMP_API_KEY="):
                os.environ["FMP_API_KEY"] = line.split("=", 1)[1].strip().strip('"')
    return os.environ.get("FMP_API_KEY")


def _fmp(conn, path: str, t: str, extra: str = "", whole: bool = False) -> tuple[dict | list | None, str | None]:
    key = _key()
    try:
        vendor_gate.wait("FMP")
        raw = urllib.request.urlopen(f"{FMP}/{path}?symbol={t}{extra}&apikey={key}", timeout=30).read().decode()
    except urllib.error.HTTPError as e:  # 402 = symbol not on our plan (small/mid caps)
        raw = f"Premium HTTP {e.code}" if e.code in (401, 402, 403) else f"HTTP {e.code}"
        if not raw.startswith("Premium"):
            return None, raw
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha) VALUES ('fmp', %s, %s, %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
                 (path, t, date.today(), json.dumps({"text": raw[:20000]}), hashlib.sha256(raw.encode()).hexdigest()))
    if raw.lstrip().startswith("Premium") or "not available under your current subscription" in raw:
        return None, "premium"
    try:
        d = json.loads(raw)
    except ValueError:
        return None, "bad_json"
    if not (isinstance(d, list) and d):
        return None, "empty"
    return (d if whole else d[0]), None


def fmp(conn, tickers: list[str], max_calls: int) -> int:
    calls = done = 0
    for t in tickers:
        last = rows(conn, """SELECT as_of, detail FROM watchlist_sync.external_intrinsic WHERE ticker = %s AND source = 'fmp_dcf'
                             ORDER BY as_of DESC LIMIT 1""", (t,))
        if last:
            age = (date.today() - last[0]["as_of"]).days
            if age < 7 or ((last[0]["detail"] or {}).get("unavailable") and age < 30):
                continue
        if calls + 2 > max_calls:
            break
        u, err = _fmp(conn, "discounted-cash-flow", t)
        calls += 1
        lev = None
        if u:
            lv, _ = _fmp(conn, "levered-discounted-cash-flow", t)
            calls += 1
            lev = (lv or {}).get("dcf")
        conn.execute("""INSERT INTO watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail) VALUES (%s, %s, 'fmp_dcf', %s, %s, %s)
                        ON CONFLICT (ticker, as_of, source) DO UPDATE SET value = EXCLUDED.value, price = EXCLUDED.price, detail = EXCLUDED.detail""",
                     (t, date.today(), (u or {}).get("dcf"), (u or {}).get("Stock Price"),
                      json.dumps({"levered_dcf": lev, "fmp_date": (u or {}).get("date")} if u else {"unavailable": err})))
        conn.commit()
        done += 1
    _meter(conn, calls)
    conn.commit()
    print(f"fmp_dcf: {done} tickers, {calls} calls")
    return calls


def _k(rf: float, beta: float | None) -> float:
    # same cost of equity as lib/fair-value.ts costOfEquity (ERP 0.05, beta clamp 0.5–2, k clamp 7–14 %)
    return min(max(rf + min(max(beta if beta is not None else 1.0, 0.5), 2.0) * 0.05, 0.07), 0.14)


def models(conn) -> int:
    """Jamie 10-29 'more options': free models fv-1.2.0 does not vote with, stored beside the outside values (display only).
      fildi_rim    residual income (Frankel–Lee 1998): B0 + Σ(ROE_t − k)·B_{t−1}/(1+k)^t, FY1–FY3, year-3 RI held flat
                   (k-perpetuity); clean surplus with today's payout. Non-financials too (fv only runs it on banks/insurers).
      fildi_epv    earnings power value (Greenwald): EBIT·(1 − tax) / WACC + cash − debt, no growth → a floor.
      graham_number classic √(22.5 · trailing EPS · book/share); only when both are positive."""
    mkt = rows(conn, "SELECT market FROM fair_value_snapshots WHERE market IS NOT NULL ORDER BY as_of DESC LIMIT 1")
    rf = float(((mkt[0]["market"] or {}) if mkt else {}).get("riskFree") or 0.045)
    data = rows(conn, """
        WITH i AS (SELECT DISTINCT ON (ticker) ticker, inputs FROM fair_value_inputs ORDER BY ticker, first_seen DESC),
             s AS (SELECT DISTINCT ON (ticker) ticker, price FROM fair_value_snapshots ORDER BY ticker, as_of DESC),
             c AS (SELECT ticker, array_agg(eps_avg ORDER BY fiscal_end) eps FROM (
                     SELECT DISTINCT ON (ticker, fiscal_end) ticker, fiscal_end, eps_avg FROM watchlist_sync.consensus_annual
                     WHERE fiscal_end > CURRENT_DATE AND eps_avg IS NOT NULL ORDER BY ticker, fiscal_end, (source = 'lseg') DESC) x
                   GROUP BY ticker)
        SELECT i.ticker, i.inputs, s.price, c.eps, f.ebit, f.effective_tax_rate tax, f.dividend_yield dy, f.interest_expense ie
        FROM i JOIN s USING (ticker) LEFT JOIN c USING (ticker) LEFT JOIN ticker_fundamentals f ON f.ticker = i.ticker
        WHERE s.price > 0""")
    n = 0
    for r in data:
        t, x, price = r["ticker"], r["inputs"] or {}, float(r["price"])
        r = {kk: (float(vv) if hasattr(vv, "as_integer_ratio") and not isinstance(vv, (int, float)) else vv) for kk, vv in r.items()}
        r["eps"] = [float(e) if e is not None else None for e in (r["eps"] or [])]
        sh, eq = x.get("shares"), x.get("equity")
        if not (sh and sh > 0):
            continue
        k = _k(rf, x.get("beta"))
        out: dict[str, tuple[float, dict]] = {}
        path = [e for e in (r["eps"] or [])[:3] if e is not None]
        if len(path) < 2:
            path = [e for e in (x.get("forwardEps"), x.get("eps2")) if e is not None]
        if len(path) == 2:
            path.append(path[1] * (1 + min(max(x.get("ltg") or 0.0, 0.0), 0.30)))
        if eq and eq > 0 and len(path) == 3 and x.get("mode") != "reit":
            b = eq / sh
            payout = min(max(((r["dy"] or 0) * price) / x["trailingEps"], 0.0), 1.0) if (x.get("trailingEps") or 0) > 0 else 0.0
            v, bt, ri = b, b, 0.0
            for yr, e in enumerate(path, 1):
                ri = e - k * bt
                v += ri / (1 + k) ** yr
                bt += e * (1 - payout)
            v += ri / (k * (1 + k) ** 3)
            out["fildi_rim"] = (v, {"k": round(k, 4), "book_ps": round(b, 2), "eps_path": [round(e, 2) for e in path],
                                    "payout": round(payout, 3), "family": "cash-flow"})
        ebit = float(r["ebit"]) if r["ebit"] is not None else None
        # 11-02: EBIT above the whole market cap = financials in another currency (SKHY: won EBIT on US shares → $43,931).
        if ebit and ebit > price * sh:
            ebit = None
        if ebit and ebit > 0 and x.get("mode") == "standard":
            tax = min(max(float(r["tax"]) if r["tax"] is not None else 0.21, 0.0), 0.35)
            tax = tax if tax >= 0.05 else 0.21  # 1–4 % effective rates (loss carryforwards) are not a steady state
            debt, cash = x.get("totalDebt") or 0.0, x.get("cash") or 0.0
            e_cap = price * sh
            kd = (rf + 0.015) * (1 - tax)
            wacc = (e_cap * k + debt * kd) / (e_cap + debt) if e_cap + debt > 0 else k
            v = (ebit * (1 - tax) / wacc + cash - debt) / sh
            out["fildi_epv"] = (v, {"wacc": round(wacc, 4), "ebit": ebit, "tax": round(tax, 3), "family": "floor"})
        te = x.get("trailingEps")
        if te and te > 0 and eq and eq > 0:
            out["graham_number"] = ((22.5 * te * eq / sh) ** 0.5, {"trailing_eps": te, "book_ps": round(eq / sh, 2), "family": "floor"})
        for src, (v, d) in out.items():
            conn.execute("""INSERT INTO watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail)
                            VALUES (%s, CURRENT_DATE, %s, %s, %s, %s)
                            ON CONFLICT (ticker, as_of, source) DO UPDATE SET value = EXCLUDED.value, price = EXCLUDED.price, detail = EXCLUDED.detail""",
                         (t, src, round(v, 2), price, json.dumps(d)))
            n += 1
    conn.commit()
    print(f"models: {n} rows (rim/epv/graham) over {len(data)} names, rf {rf:.4f}")
    return n


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    max_calls = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 60
    if "--max" in sys.argv:
        args = [a for a in args if a != str(max_calls)]
    with connect() as conn:
        conn.execute(DDL)
        print("starmine rows:", starmine(conn))
        conn.commit()
        models(conn)
        if "--models-only" in sys.argv:
            return
        if "--probe-calls" in sys.argv:  # meter the hand probes made while building this (10-27: 5 calls)
            _meter(conn, int(args.pop(0))); conn.commit()
        tickers = [a.upper() for a in args] or [r["t"] for r in rows(conn, """
            SELECT t FROM (SELECT DISTINCT UPPER(ticker) t, 0 pri FROM watchlist
                           UNION SELECT f.ticker, 1 FROM ticker_fundamentals f JOIN fair_value_snapshots s ON s.ticker = f.ticker
                           AND s.as_of = (SELECT max(as_of) FROM fair_value_snapshots) WHERE s.price * f.shares_outstanding > 1e11) x
            GROUP BY t ORDER BY MIN(pri), t""")]
        fmp(conn, tickers, max_calls)


if __name__ == "__main__":
    main()
