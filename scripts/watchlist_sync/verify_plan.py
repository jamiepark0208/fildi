"""L2: verify plan items against LIVE Robinhood data before anything is recommended or written.

Flow (inside a Claude session that has the Robinhood MCP; read-only tools only):
  1. requests  --plan N              → JSON of contracts + symbols to look up
  2. for each contract: get_option_instruments(chain_symbol, expiration_dates, strike_price, type)
       pipe each raw response:        ingest instruments --plan N < response.json
     get_option_quotes(ids ≤20/call)  ingest option_quotes --plan N < response.json
     get_equity_quotes(symbols)       ingest equity_quotes --plan N < response.json
  3. evaluate --plan N               → per-item verify_status + checks; plan → 'verified'

Every raw response is stored in watchlist_sync.rh_raw (audit trail). Usage: .venv/bin/python verify_plan.py <cmd> --plan N
No Robinhood quotes (scheduled daily run) or --schwab (intraday.py re-check): evaluate builds the same quote shapes from Schwab
live quotes (schwab_as_raw) and runs the same checks; each item's live.source records which broker priced it.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

import rules as R
from build_plan import chk, connect, rows


def latest_plan(conn) -> int:
    return conn.execute("SELECT MAX(id) FROM watchlist_sync.plans").fetchone()[0]


def cmd_requests(conn, pid: int, every: bool = False) -> None:
    print(json.dumps(requests_for(conn, pid, every), indent=2))


def requests_for(conn, pid: int, every: bool = False) -> dict:
    items = rows(conn, """SELECT id, list_key, ticker, kind, option_type, strike::float8, expiry::text FROM watchlist_sync.plan_items
                          WHERE plan_id = %s AND l1_pass ORDER BY list_key, rank""", (pid,))
    skipped = []
    if not every:  # cheap checks first: only ideas that can survive the verdict cross-check + portfolio need live quotes
        from publish_model_list import precheck
        keep, skipped = precheck(conn, pid)
        items = [i for i in items if i["kind"] != "option" or i["id"] in keep]
    out = {
        "plan_id": pid,
        "skipped_before_quotes": skipped,
        "options": [
            {"item_id": i["id"], "chain_symbol": i["ticker"], "expiration_dates": i["expiry"],
             "strike_price": f"{i['strike']:.4f}", "type": i["option_type"]}
            for i in items if i["kind"] == "option"
        ],
        "equities": sorted({i["ticker"] for i in items}),
    }
    return out


def cmd_ingest(conn, pid: int, kind: str) -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw)
    conn.execute("INSERT INTO watchlist_sync.rh_raw (plan_id, kind, payload) VALUES (%s, %s, %s)", (pid, kind, json.dumps(payload)))
    conn.commit()
    data = payload.get("data", payload)
    n = len(data.get("instruments") or data.get("results") or [])
    print(f"OK {kind}: {n} record(s) stored for plan #{pid}")


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def load_raw(conn, pid: int):
    instruments, oquotes, equotes = {}, {}, {}
    for r in rows(conn, "SELECT kind, payload FROM watchlist_sync.rh_raw WHERE plan_id = %s ORDER BY id", (pid,)):
        data = r["payload"].get("data", r["payload"])
        if r["kind"] == "instruments":
            for ins in data.get("instruments", []):
                key = (ins["chain_symbol"], ins["expiration_date"], round(float(ins["strike_price"]), 4), ins["type"])
                instruments[key] = ins
        elif r["kind"] == "option_quotes":
            for res in data.get("results", []):
                q = res.get("quote") or {}
                if q.get("instrument_id"):
                    oquotes[q["instrument_id"]] = q
        elif r["kind"] == "equity_quotes":
            for res in data.get("results", []):
                q = res.get("quote") or {}
                if q.get("symbol"):
                    equotes[q["symbol"]] = {**q, "_close": res.get("close")}
    return instruments, oquotes, equotes


def live_spot(eq: dict) -> tuple[float | None, str | None]:
    cands = [(eq.get("venue_last_trade_time"), _f(eq.get("last_trade_price"))),
             (eq.get("venue_last_non_reg_trade_time"), _f(eq.get("last_non_reg_trade_price")))]
    cands = [c for c in cands if c[0] and c[1]]
    if not cands:
        return None, None
    ts, px = max(cands)
    return px, ts


def parse_ts(s: str) -> datetime:
    s = s.replace("Z", "+00:00")
    if "." in s:  # Robinhood sends nanoseconds; Python handles ≤6 fractional digits
        head, rest = s.split(".", 1)
        frac, tz = rest[:6], rest[len(rest.rstrip("+-:0123456789")) :] if False else rest[rest.find("+") if "+" in rest else len(rest):]
        s = f"{head}.{frac.split('+')[0]}{tz}"
    return datetime.fromisoformat(s)


API = "http://127.0.0.1:8080/api/schwab/option-quotes"


def schwab_quotes(items: list[dict]) -> dict[tuple, dict]:
    """Live Schwab quotes for the plan's contracts, fetched at verify time (one API-server call). {} if unavailable."""
    import urllib.request
    opts = [it for it in items if it["kind"] == "option"]
    if not opts:
        return {}
    body = {"contracts": [{"ticker": it["ticker"], "expiry": str(it["expiry"]), "strike": float(it["strike"]),
                           "type": it["option_type"]} for it in opts]}
    try:
        req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except Exception as e:  # server down / Schwab re-auth needed: fall back to the plan's stored premium
        print(f"  (Schwab re-price unavailable: {e}; using Fildi plan premium)")
        return {}
    out = {}
    for it in opts:
        occ = data["symbols"].get(f"{it['ticker']}|{it['expiry']}|{float(it['strike']):g}|{it['option_type']}")
        if occ and data["quotes"].get(occ):
            out[(it["ticker"], str(it["expiry"]), float(it["strike"]), it["option_type"])] = data["quotes"][occ]
    return out


EQ_API = "http://127.0.0.1:8080/api/schwab/equity-prices"


def schwab_as_raw(items: list[dict], sq: dict[tuple, dict]):
    """No Robinhood quotes for this plan (scheduled run outside the export session): build the same instruments / option /
    equity quote shapes from Schwab so evaluate_option runs its checks unchanged. Realistic fill = bid + ¼ spread, the
    convention Robinhood's high_fill_rate_sell_price follows (median 23% of the spread, rules.LIMIT_SPREAD_FRACTION).
    A contract Schwab quotes is treated as listed + tradable; the tradability check stays Robinhood-only."""
    import urllib.request
    instruments, oquotes, equotes = {}, {}, {}
    for it in items:
        if it["kind"] != "option":
            continue
        key = (it["ticker"], str(it["expiry"]), float(it["strike"]), it["option_type"])
        q = sq.get(key)
        if not q:
            continue
        occ = f"schwab:{it['ticker']}|{it['expiry']}|{float(it['strike']):g}|{it['option_type']}"
        instruments[(it["ticker"], str(it["expiry"]), round(float(it["strike"]), 4), it["option_type"])] = {
            "id": occ, "state": "active", "tradability": "tradable"}
        bid, ask = _f(q.get("bid")), _f(q.get("ask"))
        fill = round(bid + R.LIMIT_SPREAD_FRACTION * (ask - bid), 2) if bid and ask and ask >= bid else bid
        oquotes[occ] = {"bid_price": bid, "ask_price": ask, "mark_price": q.get("mark"), "high_fill_rate_sell_price": fill,
                        "open_interest": q.get("openInterest"), "volume": q.get("volume"), "delta": q.get("delta"),
                        "implied_volatility": q.get("iv"), "updated_at": q.get("quoteTime")}
        if q.get("underlying") and q.get("quoteTime"):
            equotes[it["ticker"]] = {"state": "active", "last_trade_price": q["underlying"], "venue_last_trade_time": q["quoteTime"]}
    stocks = sorted({it["ticker"] for it in items if it["kind"] != "option"} - set(equotes))
    if stocks:
        try:
            req = urllib.request.Request(EQ_API, data=json.dumps({"tickers": stocks}).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                prices = json.load(r)["prices"]
            now = datetime.now(timezone.utc).isoformat()
            for t, p in prices.items():
                if p.get("price"):
                    equotes[t] = {"state": "active", "last_trade_price": p["price"], "venue_last_trade_time": now}
        except Exception as e:
            print(f"  (live stock prices unavailable: {e})")
    return instruments, oquotes, equotes


def store_schwab_raw(conn, pid: int, instruments: dict, oquotes: dict, equotes: dict) -> None:
    """Write Schwab-built shapes into rh_raw so health strip / audit see the same trail as RH ingest."""
    if instruments:
        payload = {"data": {"instruments": [
            {"id": ins["id"], "chain_symbol": t, "expiration_date": exp, "strike_price": str(strike),
             "type": otype, "state": ins.get("state"), "tradability": ins.get("tradability")}
            for (t, exp, strike, otype), ins in instruments.items()
        ]}}
        conn.execute(
            "INSERT INTO watchlist_sync.rh_raw (plan_id, kind, payload) VALUES (%s, %s, %s)",
            (pid, "instruments", json.dumps(payload)),
        )
    if oquotes:
        payload = {"data": {"results": [{"quote": {**q, "instrument_id": iid}} for iid, q in oquotes.items()]}}
        conn.execute(
            "INSERT INTO watchlist_sync.rh_raw (plan_id, kind, payload) VALUES (%s, %s, %s)",
            (pid, "option_quotes", json.dumps(payload)),
        )
    if equotes:
        payload = {"data": {"results": [
            {"quote": {**q, "symbol": sym}} for sym, q in equotes.items()
        ]}}
        conn.execute(
            "INSERT INTO watchlist_sync.rh_raw (plan_id, kind, payload) VALUES (%s, %s, %s)",
            (pid, "equity_quotes", json.dumps(payload)),
        )


def evaluate_option(it: dict, instruments, oquotes, equotes, now: datetime) -> tuple[str, list[dict], dict]:
    c: list[dict] = []
    src = it.get("_src", "Robinhood")
    key = (it["ticker"], str(it["expiry"]), round(float(it["strike"]), 4), it["option_type"])
    ins = instruments.get(key)
    c.append(chk("contract_tradable", bool(ins) and ins.get("state") == "active" and ins.get("tradability") == "tradable",
                 f"{ins.get('state')}/{ins.get('tradability')}" if ins else f"contract not found on {src}"))
    if not ins:
        return "fail", c, {}
    q = oquotes.get(ins["id"])
    if not q:
        c.append(chk("quote_present", False, f"no {src} quote"))
        return "fail", c, {"instrument_id": ins["id"]}

    bid, ask, mark = _f(q.get("bid_price")), _f(q.get("ask_price")), _f(q.get("mark_price"))
    fill = _f(q.get("high_fill_rate_sell_price")) or bid
    oi, vol = q.get("open_interest") or 0, q.get("volume") or 0
    delta, iv = _f(q.get("delta")), _f(q.get("implied_volatility"))
    upd = parse_ts(q["updated_at"]) if q.get("updated_at") else None
    # Provisional = the quote itself was taken outside the session (classify by quote time, not by when this runs: quotes fetched
    # at 14:44 ET and evaluated after the close were wrongly marked after-hours on 2026-10-05).
    after_hours = upd is None or not R.market_open(upd)
    evaluating_closed = not R.market_open(now)

    # Freshness: live session → minutes old; closed → must be from the latest close.
    if upd is None:
        c.append(chk("quote_fresh", False, "no timestamp"))
    elif evaluating_closed:
        ok = upd.astimezone(R.ET).date() == R.last_close_date(now)
        c.append(chk("quote_fresh", ok, f"market closed; quote from {upd.astimezone(R.ET):%a %m-%d %H:%M} ET"
                                         + ("" if after_hours else " (in session)")))
    else:
        age = (now - upd).total_seconds() / 60
        c.append(chk("quote_fresh", age <= R.QUOTE_MAX_AGE_MIN_OPEN, f"{age:.0f} min old"))

    c.append(chk("bid_positive", (bid or 0) > 0, f"bid {bid}"))
    spread = 100 * (ask - bid) / mark if bid and ask and mark else None
    width = (ask - bid) if bid and ask else None
    limit = round(bid + R.LIMIT_SPREAD_FRACTION * width, 2) if width else None
    detail = (f"spread ${width:.2f} = {spread:.0f}% of mark (bid {bid} / ask {ask}); suggested limit ${limit:.2f}, mid ${mark:.2f} needs patience"
              if spread is not None else "no spread")
    no_market = spread is None or (spread > R.MAX_SPREAD_PCT and width > R.MAX_SPREAD_ABS + 1e-9)
    if spread is not None and after_hours:  # spreads widen at the close; re-check at the open
        c.append(chk("spread_ok", not no_market and spread <= R.WARN_SPREAD_PCT, detail + " (after-hours quote)", "warn"))
    else:
        c.append(chk("spread_ok", not no_market, detail))
        if not no_market and spread > R.WARN_SPREAD_PCT and width > R.MAX_SPREAD_ABS + 1e-9:
            c.append(chk("spread_wide", False, detail, "warn"))
    model = float(it["model_premium"])
    sq = it.get("_schwab") or {}
    sb, sa = _f(sq.get("bid")), _f(sq.get("ask"))
    # Re-priced at verify time from Schwab at the same convention as the Robinhood fill (bid + ¼ spread), so the gap measures
    # broker disagreement, not a stale overnight plan price. Falls back to the plan premium when Schwab is unavailable.
    ref, ref_src = ((sb + R.LIMIT_SPREAD_FRACTION * (sa - sb), "Schwab live") if sb and sa and sa >= sb
                    else (model, "Fildi plan"))
    ratio = fill / ref if fill and ref else 0
    # Step 8 (gap #12): judge the trade at the price you'd actually get, not by how far Fildi's Yahoo premium was off.
    # Block only if the realistic weekly yield is too low; the Fildi gap stays as a warning (data-quality signal, ASKS A8).
    days = max((it["expiry"] - now.astimezone(R.ET).date()).days, 1)
    weekly = 100 * (fill or 0) / float(it["strike"]) * 7 / days
    floor = it.get("_floor", R.MIN_WEEKLY_INCOME_PCT)  # champion param thresholds.min_weekly_realistic (set in cmd_evaluate)
    c.append(chk("realistic_yield", weekly >= floor,
                 f"{weekly:.2f}%/week at the realistic fill ${fill or 0:.2f} ({days}d), floor {floor}%"))
    c.append(chk("fildi_premium_gap", ratio >= R.MIN_REALISTIC_TO_MODEL,
                 f"realistic fill ${fill or 0:.2f} vs {ref_src} ${ref:.2f} ({100 * (ratio - 1):+.0f}%); plan premium ${model:.2f}", "warn"))
    c.append(chk("liquidity", oi >= R.MIN_OPEN_INTEREST or vol >= R.MIN_VOLUME_IF_LOW_OI, f"OI {oi}, volume {vol}"))

    eq = equotes.get(it["ticker"]) or {}
    spot, spot_ts = live_spot(eq)
    strike = float(it["strike"])
    if spot:
        drift = 100 * (spot / float(it["model_spot"]) - 1)
        c.append(chk("live_spot_drift", abs(drift) <= R.MAX_LIVE_SPOT_DRIFT_PCT, f"live ${spot:.2f} vs Fildi ${float(it['model_spot']):.2f} ({drift:+.1f}%)", "warn"))
        otm = 100 * ((spot - strike) / spot if it["option_type"] == "put" else (strike - spot) / spot)
        c.append(chk("still_otm", otm >= R.MIN_OTM_PCT_LIVE, f"{otm:.1f}% OTM at live price"))
    else:
        c.append(chk("still_otm", False, "no live stock price"))
    lo, hi = R.PUT_DELTA if it["option_type"] == "put" else R.CALL_DELTA
    c.append(chk("live_delta_band", delta is not None and lo <= delta <= hi, f"{src} delta {delta}"))
    if iv and it["model_iv"]:
        dis = abs(iv / float(it["model_iv"]) - 1)
        c.append(chk("iv_agrees", dis <= R.MAX_IV_DISAGREEMENT, f"{src} IV {iv:.2f} vs Fildi {float(it['model_iv']):.2f}", "warn"))

    blocked = any(not x["pass"] and x["severity"] == "block" for x in c)
    status = "fail" if blocked else ("pass_after_hours" if after_hours else "pass")
    income = 100 * (fill or 0) / strike
    live = {"instrument_id": ins["id"], "bid": bid, "ask": ask, "mark": mark, "realistic_fill": fill, "oi": oi, "volume": vol,
            "delta": delta, "iv": iv, "spot": spot, "suggested_limit": limit, "schwab": sq or None, "spot_ts": spot_ts, "quote_ts": q.get("updated_at"),
            "realistic_income_pct": round(income, 3), "realistic_weekly_pct": round(weekly, 3)}
    return status, c, live


def cmd_evaluate(conn, pid: int, force_schwab: bool = False) -> None:
    instruments, oquotes, equotes = ({}, {}, {}) if force_schwab else load_raw(conn, pid)
    now = datetime.now(timezone.utc)
    items = rows(conn, "SELECT * FROM watchlist_sync.plan_items WHERE plan_id = %s AND l1_pass ORDER BY list_key, rank", (pid,))
    import params as PM
    floor = PM.champion(conn)[1]["thresholds"]["min_weekly_realistic"]
    counts: dict[str, int] = {}
    sq = schwab_quotes(items)
    source = "robinhood"
    option_items = [it for it in items if it["kind"] == "option"]
    if not oquotes:   # no Robinhood quotes (or --schwab: intraday re-check, where morning RH quotes are stale)
        # Empty sq is normal when L1 survivors are stock-only (no option contracts to quote).
        # Only treat as Schwab-down when we needed option quotes and got none.
        if option_items and not sq:
            print(f"plan #{pid}: no Robinhood quotes and Schwab is unavailable → not verified (re-run when the API server / Schwab is up)")
            sys.exit(3)
        instruments, oquotes, equotes = schwab_as_raw(items, sq)
        source = "schwab"
        # Persist so Model List health `quotes_at` is not null (stock-only plans use equity_quotes).
        store_schwab_raw(conn, pid, instruments, oquotes, equotes)
        print(
            f"plan #{pid}: no Robinhood quotes → verifying on Schwab "
            f"({len(oquotes)} option contracts, {len(equotes)} equities)"
        )
    for it in items:
        if it["kind"] == "option":
            key = (it["ticker"], str(it["expiry"]), float(it["strike"]), it["option_type"])
            status, checks, live = evaluate_option({**it, "_floor": floor, "_schwab": sq.get(key), "_src": source.capitalize()}, instruments, oquotes, equotes, now)
        else:
            eq = equotes.get(it["ticker"])
            ok = bool(eq) and eq.get("state") == "active"
            checks = [chk("symbol_active", ok, f"state {eq.get('state') if eq else 'not found'}")]
            spot, ts = live_spot(eq or {})
            status, live = ("pass" if ok else "fail"), {"spot": spot, "spot_ts": ts}
        live["source"] = source
        counts[status] = counts.get(status, 0) + 1
        conn.execute("UPDATE watchlist_sync.plan_items SET verify_status = %s, verify_checks = %s, live = %s WHERE id = %s",
                     (status, json.dumps(checks), json.dumps(live), it["id"]))
    conn.execute("UPDATE watchlist_sync.plans SET status = 'verified', verified_at = now() WHERE id = %s", (pid,))
    conn.commit()
    print(f"plan #{pid} verified: {counts}")
    for it in rows(conn, """SELECT list_key, ticker, option_type, strike::float8, expiry, verify_status, verify_checks, live
                            FROM watchlist_sync.plan_items WHERE plan_id = %s AND l1_pass ORDER BY list_key, rank""", (pid,)):
        bad = [f"{x['check']}: {x['detail']}" for x in it["verify_checks"] if not x["pass"]]
        tag = "✓" if it["verify_status"].startswith("pass") else "✗"
        what = f"{it['option_type']} ${it['strike']:g} {it['expiry']}" if it["option_type"] else "stock"
        inc = f" · {it['live'].get('realistic_weekly_pct')}%/wk real" if it["live"].get("realistic_weekly_pct") is not None else ""
        print(f"  {tag} {it['list_key']:10s} {it['ticker']:6s} {what:24s}{inc}  {'; '.join(bad)[:170]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["requests", "ingest", "evaluate"])
    ap.add_argument("kind", nargs="?", choices=["instruments", "option_quotes", "equity_quotes"])
    ap.add_argument("--plan", type=int)
    ap.add_argument("--all", action="store_true", help="requests: quote every L1 survivor (skip the cheap pre-check)")
    ap.add_argument("--schwab", action="store_true", help="evaluate on Schwab live quotes even if Robinhood quotes exist (intraday.py)")
    a = ap.parse_args()
    with connect() as conn:
        pid = a.plan or latest_plan(conn)
        if a.cmd == "requests":
            cmd_requests(conn, pid, a.all)
        elif a.cmd == "ingest":
            if not a.kind:
                sys.exit("ingest needs a kind")
            cmd_ingest(conn, pid, a.kind)
        else:
            cmd_evaluate(conn, pid, a.schwab)


if __name__ == "__main__":
    main()
