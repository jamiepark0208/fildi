#!/usr/bin/env python3
"""W3 / loops B+E — StarMine PredSurprise vs realized SUE + CRSP post-earn return.

Offline calibration only. Does not write fund_score. Window ≤ CRSP max date.

Usage:
  cd research/wrds && .venv/bin/python calibrate_starmine.py
  .venv/bin/python calibrate_starmine.py --json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from db import connect_local, ensure_schema, log_pull, upsert_sync_state
from universe import add_universe_args, resolve_universe

DATASET = "calibrate_starmine"


def _f(v):
    if v is None:
        return None
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def corr(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 5:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx < 1e-12 or dy < 1e-12:
        return None
    return num / (dx * dy)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    add_universe_args(p)
    p.add_argument("--json", action="store_true")
    p.add_argument("--horizon", type=int, default=5, help="CRSP trading days after anndats")
    args = p.parse_args()
    tickers = resolve_universe(args)

    pairs_pred_sue: list[tuple[float, float]] = []
    pairs_pred_ret: list[tuple[float, float]] = []
    pairs_cam_ret: list[tuple[float, float]] = []
    detail = []

    with connect_local() as conn:
        ensure_schema(conn)
        crsp_max = conn.execute("SELECT MAX(date) FROM wrds_research.crsp_dsf").fetchone()[0]
        if not crsp_max:
            print("no CRSP cache — run sync_crsp.py")
            return 2

        for t in tickers:
            oftic_row = conn.execute(
                "SELECT COALESCE(ibes_oftic, ticker), crsp_permno FROM research_common.security_map WHERE ticker = %s",
                (t,),
            ).fetchone()
            oftic = (oftic_row[0] if oftic_row else t) or t
            permno = oftic_row[1] if oftic_row else None

            # Latest StarMine hist row before each surprise announcement
            surps = conn.execute(
                """
                SELECT anndats, suescore FROM wrds_research.ibes_surpsum
                WHERE UPPER(oftic) = %s AND anndats IS NOT NULL AND anndats <= %s
                ORDER BY anndats DESC
                LIMIT 12
                """,
                (str(oftic).upper(), crsp_max),
            ).fetchall()

            for anndats, sue in surps:
                sue = _f(sue)
                # starmine_history is long: (metric, obs_date, value)
                pred_row = conn.execute(
                    """
                    SELECT obs_date, value FROM lseg_research.starmine_history
                    WHERE ticker = %s AND metric = 'pred_surprise_pct_fq1' AND obs_date <= %s
                    ORDER BY obs_date DESC LIMIT 1
                    """,
                    (t, anndats),
                ).fetchone()
                cam_row = conn.execute(
                    """
                    SELECT obs_date, value FROM lseg_research.starmine_history
                    WHERE ticker = %s AND metric = 'combined_alpha_rank' AND obs_date <= %s
                    ORDER BY obs_date DESC LIMIT 1
                    """,
                    (t, anndats),
                ).fetchone()
                if not pred_row and not cam_row:
                    continue
                as_of = pred_row[0] if pred_row else (cam_row[0] if cam_row else None)
                pred = _f(pred_row[1]) if pred_row else None
                cam = _f(cam_row[1]) if cam_row else None
                arm = cam  # history has Combined Alpha; ARM is signals_daily-only
                # CRSP cumulative return anndats → +horizon
                ret = None
                if permno and anndats:
                    end = anndats + timedelta(days=args.horizon + 10)  # calendar pad
                    rets = conn.execute(
                        """
                        SELECT date, ret FROM wrds_research.crsp_dsf
                        WHERE permno = %s AND date > %s AND date <= %s AND ret IS NOT NULL
                        ORDER BY date
                        LIMIT %s
                        """,
                        (permno, anndats, end, args.horizon),
                    ).fetchall()
                    if rets:
                        acc = 1.0
                        for _, r in rets:
                            rf = _f(r)
                            if rf is None:
                                continue
                            acc *= 1.0 + rf
                        ret = acc - 1.0

                if pred is not None and sue is not None:
                    pairs_pred_sue.append((pred, sue))
                if pred is not None and ret is not None:
                    pairs_pred_ret.append((pred, ret))
                if cam is not None and ret is not None:
                    pairs_cam_ret.append((cam, ret))

                detail.append({
                    "ticker": t,
                    "anndats": str(anndats)[:10],
                    "starmine_as_of": str(as_of)[:10] if as_of else None,
                    "pred_surprise_pct": pred,
                    "sue": sue,
                    "ret_h": round(ret, 4) if ret is not None else None,
                    "combined_alpha": cam,
                })

        summary = {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "crsp_max": str(crsp_max)[:10],
            "horizon_days": args.horizon,
            "n_events": len(detail),
            "corr_pred_vs_sue": corr([a for a, _ in pairs_pred_sue], [b for _, b in pairs_pred_sue]),
            "corr_pred_vs_ret": corr([a for a, _ in pairs_pred_ret], [b for _, b in pairs_pred_ret]),
            "corr_cam_vs_ret": corr([a for a, _ in pairs_cam_ret], [b for _, b in pairs_cam_ret]),
            "n_pred_sue": len(pairs_pred_sue),
            "n_pred_ret": len(pairs_pred_ret),
            "hint": (
                "corr_pred_vs_sue > 0 → PredSurprise deserves trust; "
                "graduate to soft ER haircut only after reviewing sample size. "
                "CRSP lag caps the event window — do not overfit small n."
            ),
            "events": detail[:200],
        }
        upsert_sync_state(
            conn,
            dataset=DATASET,
            watermark=str(crsp_max)[:10],
            rows=len(detail),
            tickers=tickers,
            notes=f"corr_pred_sue={summary['corr_pred_vs_sue']}",
        )
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=len(detail))
        conn.commit()

    out_path = Path(__file__).resolve().parents[1] / "common" / "out" / "calibrate_starmine.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(
            f"events={summary['n_events']} corr_pred_sue={summary['corr_pred_vs_sue']} "
            f"corr_pred_ret={summary['corr_pred_vs_ret']} corr_cam_ret={summary['corr_cam_vs_ret']}"
        )
        print(f"→ {out_path}")
        print(summary["hint"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
