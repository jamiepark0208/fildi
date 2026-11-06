"""Daily S151 turning-point scores (A330 stage 1) — one producer for week-low + month-high odds.

Uses pattern_lab.s151_panel / FEATS_S151 / HistGradientBoosting params from s151_model_horizon.
Scores latest session; writes watchlist_sync.turning_point_scores. Display only — no picks.
"""
from __future__ import annotations

import json
import pickle
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE / "analysis")]
from build_plan import connect  # noqa: E402
import pattern_lab as PL  # noqa: E402

MODEL_VERSION = "s151-v1"
MODEL_DIR = Path.home() / ".fildi" / "models" / "turning_points"
TARGETS = (("week", "low"), ("month", "high"))
REFIT_DAYS = 30
DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.turning_point_scores (
  ticker text NOT NULL,
  as_of date NOT NULL,
  horizon text NOT NULL,
  side text NOT NULL,
  prob double precision NOT NULL,
  decile smallint NOT NULL,
  base double precision NOT NULL,
  model_version text NOT NULL,
  details jsonb,
  computed_at timestamptz DEFAULT now(),
  PRIMARY KEY (ticker, as_of, horizon, side));
"""


def _model_path(horizon: str, side: str) -> Path:
    return MODEL_DIR / f"{MODEL_VERSION}_{horizon}_{side}.pkl"


def _sklearn_kw() -> dict:
    return dict(
        max_iter=250,
        learning_rate=0.05,
        max_leaf_nodes=31,
        min_samples_leaf=800,
        l2_regularization=1.0,
        random_state=0,
    )


def _fit_slice(d: pd.DataFrame) -> pd.Series:
    return d.date <= PL.S151_P3_VAL_END


def _train_model(p: pd.DataFrame, label: str) -> tuple[object, list[str], float]:
    from sklearn.ensemble import HistGradientBoostingClassifier

    d = p[p[label].notna()].copy()
    train = _fit_slice(d)
    feats = [f for f in PL.FEATS_S151 if d.loc[train, f].nunique() > 1]
    X = d[feats].astype(float)
    y = d[label].astype(int)
    m = HistGradientBoostingClassifier(**_sklearn_kw()).fit(X[train], y[train])
    base = float(y[train].mean())
    medians = {f: float(X.loc[train, f].median()) for f in feats}
    return m, feats, base, medians


def load_or_fit_models(p: pd.DataFrame, force: bool = False) -> dict:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    for horizon, side in TARGETS:
        lab = f"good_{side}_{horizon}"
        path = _model_path(horizon, side)
        stale = (
            force
            or not path.exists()
            or datetime.now(timezone.utc) - datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            > timedelta(days=REFIT_DAYS)
        )
        if stale:
            m, feats, base, medians = _train_model(p, lab)
            blob = {"model": m, "feats": feats, "base": base, "medians": medians, "label": lab, "version": MODEL_VERSION}
            path.write_bytes(pickle.dumps(blob))
        else:
            blob = pickle.loads(path.read_bytes())
        out[(horizon, side)] = blob
    return out


def holdout_month_high_lift(p: pd.DataFrame, models: dict) -> float:
    """Same fit cut as s151_model_horizon holdout block for month-high."""
    blob = models[("month", "high")]
    lab = blob["label"]
    d = p[p[lab].notna()].copy()
    hold = d.date >= PL.S151_P3_HOLD_START
    if hold.sum() < 500:
        return float("nan")
    feats = blob["feats"]
    ph = blob["model"].predict_proba(d.loc[hold, feats].astype(float))[:, 1]
    y = d.loc[hold, lab].astype(int)
    qh = pd.qcut(ph, 10, labels=False, duplicates="drop")
    top = qh == qh.max()
    if top.sum() < 5 or y.mean() <= 0:
        return float("nan")
    return float(y[top].mean() / y.mean())


def score_day(p: pd.DataFrame, models: dict, as_of: date) -> pd.DataFrame:
    ts = pd.Timestamp(as_of)
    day = p[p.date == ts].copy()
    if day.empty:
        return pd.DataFrame()
    rows = []
    for horizon, side in TARGETS:
        blob = models[(horizon, side)]
        lab = blob["label"]
        feats = blob["feats"]
        sub = day.copy()
        X = sub[feats].astype(float)
        for f in feats:
            med = blob.get("medians", {}).get(f)
            if med is not None:
                X[f] = X[f].fillna(med)
        sub = sub.loc[X.notna().all(axis=1)]
        if sub.empty:
            continue
        X = X.loc[sub.index]
        probs = blob["model"].predict_proba(X)[:, 1]
        sub = sub.assign(prob=probs)
        try:
            sub["decile"] = pd.qcut(sub.prob, 10, labels=False, duplicates="drop") + 1
        except ValueError:
            sub["decile"] = 1
        for r in sub.itertuples():
            det = {}
            if horizon == "week" and side == "low" and hasattr(r, "z5_close"):
                det["z5_close"] = bool(getattr(r, "z5_close") == 1 or getattr(r, "z5_close") is True)
            rows.append(
                {
                    "ticker": r.ticker,
                    "as_of": as_of,
                    "horizon": horizon,
                    "side": side,
                    "prob": float(r.prob),
                    "decile": int(r.decile),
                    "base": float(blob["base"]),
                    "model_version": MODEL_VERSION,
                    "details": det or None,
                }
            )
    return pd.DataFrame(rows)


def panel_universe(conn) -> int:
    n, = conn.execute("SELECT COUNT(*) FROM fmp_fundamentals").fetchone()
    return int(n)


def main() -> None:
    asof = next((date.fromisoformat(a.split("=")[1]) for a in sys.argv if a.startswith("--asof=")), None)
    force = "--refit" in sys.argv
    check_only = "--holdout-check" in sys.argv

    p = PL.s151_panel(None, rebuild=False)
    if p.empty:
        print("turning_points: empty panel")
        sys.exit(1)
    asof = asof or p.date.max().date()
    models = load_or_fit_models(p, force=force)
    lift = holdout_month_high_lift(p, models)
    if check_only:
        print(f"holdout month-high top-decile lift: {lift:.3f}")
        sys.exit(0 if lift >= 1.5 else 2)

    if lift < 1.5:
        print(f"STOP: holdout month-high top-decile lift {lift:.3f} < 1.5 (S151 bar 1.77×)")
        sys.exit(2)

    scored = score_day(p, models, asof)
    with connect() as conn:
        conn.execute(DDL)
        fmp = conn.execute("SELECT ticker FROM fmp_fundamentals").fetchall()
        fmp_set = {t for (t,) in fmp}
        panel_tickers = set(p.ticker.unique())
        if scored.empty:
            print(f"turning_points: no rows for {asof}")
            sys.exit(1)
        with conn.cursor() as cur:
            recs = scored.to_dict("records")
            cur.executemany(
                """INSERT INTO watchlist_sync.turning_point_scores
                   (ticker, as_of, horizon, side, prob, decile, base, model_version, details)
                   VALUES (%(ticker)s, %(as_of)s, %(horizon)s, %(side)s, %(prob)s, %(decile)s, %(base)s, %(model_version)s, %(details)s)
                   ON CONFLICT (ticker, as_of, horizon, side) DO UPDATE SET
                     prob = EXCLUDED.prob, decile = EXCLUDED.decile, base = EXCLUDED.base,
                     model_version = EXCLUDED.model_version, details = EXCLUDED.details, computed_at = now()""",
                [
                    {
                        **r,
                        "details": json.dumps(r["details"]) if r.get("details") else None,
                    }
                    for r in recs
                ],
            )
        conn.commit()
        n_rows = len(scored)
        n_names = scored.ticker.nunique()
        missing = sorted(fmp_set - panel_tickers)
        miss_note = f"{len(missing)} fmp names not in S151 panel (short history / SPY-only filter)"
        print(
            f"turning_points {asof}: {n_rows} rows · {n_names} tickers · "
            f"fmp={len(fmp_set)} · holdout_lift={lift:.2f} · {miss_note}"
        )


if __name__ == "__main__":
    main()
