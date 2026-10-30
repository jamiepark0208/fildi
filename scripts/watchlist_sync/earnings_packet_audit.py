"""Whole-population check for earnings_packet.py (10-30: the ARE ×1000 rescale, ODFL/CMG +1.5 M % y/y, ETSY 11,705 % tax and
14 year-to-date cash flows shown as the quarter all passed a 6-name smoke test and were only caught by re-parsing every report).

Re-parses every stored 8-K (vendor_raw, no vendor calls) with the CURRENT parser and tests invariants that a unit, column or
table mistake breaks. Run after ANY parser change and before saying the notes are correct; exit 1 when a hard check fails.

  implied_shares   |net income| / |EPS| vs fmp_shares_outstanding — a ×1000 unit slip shows as 1000× shares        (0.5–2×)
  revenue_vs_fh    8-K revenue vs Finnhub's reported revenue                                                         (±20 %)
  oi_le_revenue    operating income ≤ revenue
  cash_vs_rev      |operating cash flow|, capex ≤ 2× quarterly revenue (6× when year-to-date)
  yoy_ratio        current / year-ago within 0.2–5× for revenue (a wrong prior column)
  eps_vs_fh        GAAP EPS vs Finnhub actual within 50× (GAAP vs adjusted can differ a lot; 50× = a share-count row)

    .venv/bin/python earnings_packet_audit.py            # table of failures + counts
"""
from __future__ import annotations

import sys

import earnings_packet as ep
from build_plan import connect, rows


def audit(conn) -> tuple[int, int, list[str]]:
    pks = rows(conn, """SELECT p.ticker, p.report_date, p.packet, f.fmp_shares_outstanding::float8 sh
                        FROM watchlist_sync.earnings_packets p LEFT JOIN fmp_fundamentals f ON f.ticker = p.ticker
                        WHERE p.status = 'ok'""")
    fails, n, match, has_fh, eps_n = [], 0, 0, 0, 0
    for r in pks:
        pk, t = r["packet"], r["ticker"]
        acc = pk["source_url"].rsplit("/", 2)[-2]
        raw = rows(conn, """SELECT payload->>'html' h FROM vendor_raw WHERE source = 'edgar' AND endpoint = '8k_ex99_1' AND key = %s
                            ORDER BY fetched_on DESC LIMIT 1""", (f"{t}:{acc}",))
        if not raw:
            continue
        n += 1
        fhr = (pk.get("street") or {}).get("finnhub_revenueActual")
        rel = ep.parse_release(raw[0]["h"].encode(), fhr)
        ep.sanity_vs_street(rel, fhr, r["sh"])
        L = rel["lines"]
        g = lambda k, w="cur": (L.get(k) or {}).get(w)  # noqa: E731
        rev, oi, ni, eps, cfo, cx = g("revenue"), g("operating_income"), g("net_income"), g("eps_diluted"), g("cfo"), g("capex")
        fh_rev, fh_eps = (pk.get("street") or {}).get("finnhub_revenueActual"), (pk.get("street") or {}).get("finnhub_epsActual")
        bad = []
        if fh_rev:
            has_fh += 1
            match += bool(rev and abs(rev * 1e6 / fh_rev - 1) < 0.02)
        eps_n += eps is not None
        if ni and eps and r["sh"] and abs(eps) > 0.05:
            ratio = abs(ni) * 1e6 / abs(eps) / r["sh"]
            if not 0.5 <= ratio <= 2:
                bad.append(f"implied_shares {ratio:.2g}×")
        if rev and fh_rev and abs(rev * 1e6 / fh_rev - 1) > 0.2:
            bad.append(f"revenue_vs_fh {rev * 1e6 / fh_rev:.2g}×")
        if rev and oi and oi > rev * 1.001:
            bad.append("oi_gt_revenue")
        if rev:
            lim = rev * (6 if (L.get("cfo") or {}).get("ytd") else 2)
            for k, v in (("cfo", cfo), ("capex", cx)):
                if v is not None and abs(v) > lim:
                    bad.append(f"{k}_vs_rev {abs(v) / rev:.2g}×")
            pr = g("revenue", "prior")
            if pr and not 0.2 <= rev / pr <= 5:
                bad.append(f"yoy_ratio {rev / pr:.2g}×")
        if eps and fh_eps and abs(fh_eps) > 0.05 and not 0.02 <= abs(eps / fh_eps) <= 50:   # GAAP vs adjusted can differ 5×; 50× = unit
            bad.append(f"eps_vs_fh {eps}/{fh_eps}")
        if bad:
            fails.append(f"{t} {r['report_date']}: " + ", ".join(bad))
    fails.append(f"coverage: revenue matches Finnhub (±2 %) {match}/{has_fh} · EPS parsed {eps_n}/{n}")
    return n, len(fails) - 1, fails


if __name__ == "__main__":
    with connect() as c:
        n, k, fails = audit(c)
    print("\n".join(fails))
    print(f"earnings packet audit: {k} of {n} reports fail an invariant")
    sys.exit(1 if k else 0)
