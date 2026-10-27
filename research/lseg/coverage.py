"""Build the LSEG coverage universe from the user's own behaviour → lseg_research.coverage.

Tiers (priority order):
  1 held       latest Robinhood snapshot: stocks + option underlyings
  2 traded     filled orders, last 180d, recency-weighted (half-life ~31d)
  3 watchlist  app watchlist (want_to_own / monitoring)
  4 lookalike  NOT held/traded/watched, nearest to the user's traded names on
               ATM put IV, realized vol, beta, log market cap (+ same peer group bonus)
  5 book       shared research/common book (mega-cap context + WRDS loop A)
  7 benchmark  SPY/QQQ/IWM + SPDR sectors + SMH: market and sector baselines for backtests (market-adjusted returns)
  6 options    every name in the latest saved option chain (the put engine's universe; 10-27 RDDT fix)
  6 model      every non-ETF name the watchlist-sync fit model scores (Model List), so no scored name runs on
               missing LSEG inputs (2026-10-05: 29 of 30 "missing credit" names were simply never synced)

Reads only local app tables (no vendor calls). Sync scripts read this table as their default universe.

Usage: .venv/bin/python coverage.py [--max 150] [--lookalikes 40] [--dry-run]
"""
from __future__ import annotations

import argparse
import math
from collections import defaultdict

from _session import connect_local, portfolio_tickers
from common.universe import load_book
from db import ensure_schema, log_pull, upsert_sync_state

TRADED_DAYS = 180
HALF_LIFE_DAYS = 31
TRADED_MAX = 40
ANCHORS = 20
FEATURES = ("iv", "rv", "beta", "logcap")
WEIGHTS = {"iv": 1.5, "rv": 1.0, "beta": 1.0, "logcap": 1.0}
PEER_BONUS = 0.35
BENCHMARKS = ["SPY", "QQQ", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC", "SMH"]
PER_ANCHOR = 4  # spread lookalikes across the user's styles (HOOD alone pulled 13 of 40)


def traded(conn) -> dict[str, float]:
    rows = conn.execute(
        f"""
        SELECT UPPER(symbol), SUM(EXP(-LN(2) * EXTRACT(EPOCH FROM now() - created_at) / 86400.0 / {HALF_LIFE_DAYS}))
        FROM portfolio_orders
        WHERE state = 'filled' AND created_at > now() - interval '{TRADED_DAYS} days'
        GROUP BY 1 ORDER BY 2 DESC
        """
    ).fetchall()
    return {t: float(s) for t, s in rows if t and t.replace(".", "").isalpha()}


def watchlist(conn) -> list[str]:
    rows = conn.execute(
        "SELECT UPPER(ticker), MIN(tier) FROM watchlist GROUP BY 1 ORDER BY 2, 1"
    ).fetchall()
    return [t for t, _ in rows]


def model_universe(conn) -> list[str]:
    """Names scored by scripts/watchlist_sync/fit_model.py (empty before its first run)."""
    if not conn.execute("SELECT to_regclass('watchlist_sync.fit_scores') IS NOT NULL").fetchone()[0]:
        return []
    return [r[0] for r in conn.execute(
        "SELECT ticker FROM watchlist_sync.fit_scores WHERE COALESCE(role, '') <> 'etf' AND color <> 'purple' ORDER BY ticker")]


def option_universe(conn) -> list[str]:
    """Every name the put engine prices (latest option_chain_history day). 10-27: RDDT + 62 others had chains but no LSEG
    history → no put-edge → blocked as "unknown" on every surface."""
    if not conn.execute("SELECT to_regclass('public.option_chain_history') IS NOT NULL").fetchone()[0]:
        return []
    return [r[0] for r in conn.execute("""SELECT DISTINCT UPPER(ticker) FROM option_chain_history
                                          WHERE as_of = (SELECT MAX(as_of) FROM option_chain_history) ORDER BY 1""")]


def features(conn) -> dict[str, dict]:
    rows = conn.execute(
        """
        SELECT t.ticker, t.atm_put_iv, t.realized_vol_20d, f.beta, f.shares_outstanding * t.ma20,
               r.primary_peer_group_id, pg.name, COALESCE(r.is_active, true)
        FROM ticker_technicals t
        LEFT JOIN ticker_fundamentals f USING (ticker)
        LEFT JOIN ticker_registry r USING (ticker)
        LEFT JOIN peer_groups pg ON pg.id = r.primary_peer_group_id
        WHERE t.technicals_last_fetched > now() - interval '14 days'
        """
    ).fetchall()
    out = {}
    for tk, iv, rv, beta, cap, peer, peer_name, active in rows:
        if not active or iv is None or cap is None or cap <= 0 or beta is None:
            continue
        out[tk.upper()] = {
            "iv": float(iv),
            "rv": min(float(rv), 200.0) if rv is not None else float(iv),  # clip broken RV (GOSS 1518)
            "beta": float(beta),
            "logcap": math.log10(float(cap)),
            "peer": peer,
            "peer_name": peer_name,
        }
    return out


def lookalikes(feats: dict[str, dict], anchors: dict[str, float], exclude: set[str], k: int):
    """Score every candidate by its best similarity to a recency-weighted anchor."""
    anchors = {a: w for a, w in anchors.items() if a in feats}
    if not anchors:
        return []
    stats = {}
    for f in FEATURES:
        vals = [v[f] for v in feats.values()]
        mu = sum(vals) / len(vals)
        sd = math.sqrt(sum((x - mu) ** 2 for x in vals) / len(vals)) or 1.0
        stats[f] = (mu, sd)
    z = {t: {f: (v[f] - stats[f][0]) / stats[f][1] for f in FEATURES} for t, v in feats.items()}
    # Premium-seller floor: no candidates with IV below the 20th pct of what the user actually trades.
    anchor_ivs = sorted(feats[a]["iv"] for a in anchors)
    iv_floor = anchor_ivs[int(0.2 * (len(anchor_ivs) - 1))]
    wmax = max(anchors.values())

    scored = []
    for t, zt in z.items():
        if t in exclude or feats[t]["iv"] < iv_floor:
            continue
        best = None
        for a, w in anchors.items():
            d = math.sqrt(sum(WEIGHTS[f] * (zt[f] - z[a][f]) ** 2 for f in FEATURES))
            sim = math.exp(-d)
            same_peer = feats[t]["peer"] is not None and feats[t]["peer"] == feats[a]["peer"]
            if same_peer:
                sim += PEER_BONUS
            s = sim * (w / wmax) ** 0.25  # anchors you trade more pull harder, but not exclusively
            if best is None or s > best[0]:
                best = (s, a, same_peer)
        s, a, same_peer = best
        ft = feats[t]
        why = f"like {a}" + (f" ({ft['peer_name']})" if same_peer and ft["peer_name"] else "")
        why += f" · IV {ft['iv']:.0f}% · beta {ft['beta']:.1f} · ${10 ** ft['logcap'] / 1e9:.1f}B"
        scored.append((t, round(s, 4), why, a))
    scored.sort(key=lambda x: -x[1])
    picked, per = [], defaultdict(int)
    for t, s, why, a in scored:
        if per[a] < PER_ANCHOR:
            picked.append((t, s, why))
            per[a] += 1
        if len(picked) == k:
            break
    return picked, iv_floor


def build(max_total: int, n_look: int):
    with connect_local() as conn:
        ensure_schema(conn)
        held = portfolio_tickers()
        tr = traded(conn)
        wl = watchlist(conn)
        feats = features(conn)
        model = model_universe(conn)
        opts = option_universe(conn)
    book = load_book()

    rows: dict[str, tuple[int, str, float, str]] = {}

    def add(t, tier, label, score, why):
        if t not in rows:
            rows[t] = (tier, label, score, why)

    for t in held:
        add(t, 1, "held", 1.0, "in your portfolio now")
    for t, s in list(tr.items())[:TRADED_MAX]:
        add(t, 2, "traded", round(s, 3), f"traded recently (recency score {s:.1f})")
    for t in wl:
        add(t, 3, "watchlist", 0.5, "on your watchlist")
    anchors = dict(list(tr.items())[:ANCHORS])
    looks, iv_floor = lookalikes(feats, anchors, set(rows) | set(book), n_look)
    for t, s, why in looks:
        add(t, 4, "lookalike", s, why)
    for t in book:
        add(t, 5, "book", 0.1, "shared research book (mega-cap context)")
    for t in model:
        add(t, 6, "model", 0.05, "scored by the watchlist-sync fit model")
    for t in opts:
        add(t, 6, "options", 0.04, "priced by the put engine (option chain)")
    for t in BENCHMARKS:
        add(t, 7, "benchmark", 0.01, "market / sector baseline for backtests")

    ordered = sorted(rows.items(), key=lambda kv: (kv[1][0], -kv[1][2]))[:max_total]
    return ordered, iv_floor


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--max", type=int, default=600)   # 10-27: 300 cut chain names (~6.6k datapoints/day at 600 — ~2 % of the month)
    p.add_argument("--lookalikes", type=int, default=40)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    ordered, iv_floor = build(args.max, args.lookalikes)

    by_tier = defaultdict(list)
    for t, (tier, label, _, why) in ordered:
        by_tier[label].append(t if label != "lookalike" else f"{t}[{why}]")
    for label in ("held", "traded", "watchlist", "lookalike", "book", "model", "options", "benchmark"):
        print(f"{label:9s} {len(by_tier[label]):3d}  {', '.join(by_tier[label])}")
    print(f"total {len(ordered)} · lookalike IV floor {iv_floor:.0f}%")
    if args.dry_run:
        return

    with connect_local() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM lseg_research.coverage")
            cur.executemany(
                "INSERT INTO lseg_research.coverage (ticker, tier, label, score, reason) VALUES (%s, %s, %s, %s, %s)",
                [(t, tier, label, score, why) for t, (tier, label, score, why) in ordered],
            )
        tickers = [t for t, _ in ordered]
        upsert_sync_state(conn, dataset="coverage", watermark="local", rows=len(ordered), tickers=tickers,
                          notes=", ".join(f"{k} {len(v)}" for k, v in by_tier.items()))
        log_pull(conn, dataset="coverage", status="ok", tickers=tickers, rows=len(ordered))
        conn.commit()
    print("written → lseg_research.coverage")


if __name__ == "__main__":
    main()
