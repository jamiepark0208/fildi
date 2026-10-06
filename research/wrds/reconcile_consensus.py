#!/usr/bin/env python3
"""Loop A — LSEG current FY1 EPS mean vs latest WRDS ibes_statsum meanest.

Mismatch → ticker-mapping / period-alignment bug (not a score write).
Match key: ticker + fy1_period_end ≈ fpedats (not ticker alone).

Usage:
  cd research/wrds && .venv/bin/python reconcile_consensus.py
  .venv/bin/python reconcile_consensus.py --json
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from db import connect_local, ensure_schema, log_pull, upsert_sync_state
from universe import add_universe_args, resolve_universe

DATASET = "reconcile_consensus"
# Relative mean gap above this → flag
TOL = 0.05  # 5%


def _f(v):
    if v is None:
        return None
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    add_universe_args(p)
    p.add_argument("--json", action="store_true")
    p.add_argument("--tol", type=float, default=TOL)
    args = p.parse_args()
    tickers = resolve_universe(args)

    out_rows = []
    with connect_local() as conn:
        ensure_schema(conn)
        for t in tickers:
            sig = conn.execute(
                """
                SELECT eps_mean_fy1, fy1_period_end, eps_num_est_fy1, as_of
                FROM lseg_research.signals_daily WHERE ticker = %s
                """,
                (t,),
            ).fetchone()
            if not sig:
                out_rows.append({"ticker": t, "status": "no_lseg", "gap": None})
                continue
            lseg_mean, fy1_end, lseg_n, as_of = sig
            lseg_mean = _f(lseg_mean)
            oftic_row = conn.execute(
                "SELECT COALESCE(ibes_oftic, ticker) FROM research_common.security_map WHERE ticker = %s",
                (t,),
            ).fetchone()
            oftic = (oftic_row[0] if oftic_row else t) or t

            wrds = None
            if fy1_end:
                wrds = conn.execute(
                    """
                    SELECT meanest, numest, fpedats, statpers
                    FROM wrds_research.ibes_statsum
                    WHERE UPPER(oftic) = %s
                      AND (fpi = '1' OR fiscalp = 'Y')
                      AND fpedats = %s::date
                    ORDER BY statpers DESC
                    LIMIT 1
                    """,
                    (str(oftic).upper(), fy1_end),
                ).fetchone()
            if not wrds:
                wrds = conn.execute(
                    """
                    SELECT meanest, numest, fpedats, statpers
                    FROM wrds_research.ibes_statsum
                    WHERE UPPER(oftic) = %s
                      AND (fpi = '1' OR fiscalp = 'Y')
                    ORDER BY statpers DESC
                    LIMIT 1
                    """,
                    (str(oftic).upper(),),
                ).fetchone()

            if not wrds or lseg_mean is None:
                out_rows.append({
                    "ticker": t, "status": "no_wrds" if not wrds else "no_lseg_mean",
                    "oftic": oftic, "lseg_mean": lseg_mean, "fy1_period_end": str(fy1_end) if fy1_end else None,
                    "gap": None,
                })
                continue

            w_mean, w_n, fpedats, statpers = wrds
            w_mean = _f(w_mean)
            gap = None
            status = "ok"
            if w_mean is not None and abs(w_mean) > 1e-9:
                gap = (lseg_mean - w_mean) / abs(w_mean)
                if abs(gap) > args.tol:
                    status = "mismatch"
            elif w_mean is None:
                status = "no_wrds_mean"

            period_ok = True
            if fy1_end and fpedats and str(fy1_end)[:10] != str(fpedats)[:10]:
                period_ok = False
                if status == "ok":
                    status = "period_drift"

            out_rows.append({
                "ticker": t,
                "oftic": oftic,
                "status": status,
                "lseg_mean": lseg_mean,
                "wrds_mean": w_mean,
                "gap": round(gap, 4) if gap is not None else None,
                "fy1_period_end": str(fy1_end)[:10] if fy1_end else None,
                "wrds_fpedats": str(fpedats)[:10] if fpedats else None,
                "period_aligned": period_ok,
                "lseg_n": lseg_n,
                "wrds_n": w_n,
                "wrds_statpers": str(statpers)[:10] if statpers else None,
                "lseg_as_of": str(as_of)[:10] if as_of else None,
            })

        bad = [r for r in out_rows if r["status"] in ("mismatch", "period_drift")]
        upsert_sync_state(
            conn,
            dataset=DATASET,
            watermark=date.today().isoformat(),
            rows=len(out_rows),
            tickers=tickers,
            notes=f"mismatches={len(bad)} tol={args.tol}",
        )
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=len(out_rows))
        conn.commit()

    report = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "tol": args.tol,
        "n": len(out_rows),
        "mismatches": [r for r in out_rows if r["status"] in ("mismatch", "period_drift")],
        "rows": out_rows,
    }
    out_path = Path(__file__).resolve().parents[1] / "common" / "out" / "reconcile_consensus.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"reconciled {len(out_rows)} · mismatches={len(report['mismatches'])} → {out_path}")
        for r in report["mismatches"][:30]:
            print(f"  {r['status']:14s} {r['ticker']:6s} gap={r.get('gap')} lseg={r.get('lseg_mean')} wrds={r.get('wrds_mean')}")
        if not report["mismatches"]:
            print("  all compared names within tolerance (or missing one side)")
    return 0 if not report["mismatches"] else 2


if __name__ == "__main__":
    sys.exit(main())
