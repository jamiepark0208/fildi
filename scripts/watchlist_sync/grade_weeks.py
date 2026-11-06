"""Week-clustered stats for live grades (A327). Expiry ISO week is the independent sample, not each trade."""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from statistics import mean

MIN_LIVE_WEEKS = 6


def iso_week(d: date) -> tuple[int, int]:
    return d.isocalendar()[:2]


def month_block(d: date) -> tuple[int, int]:
    """Calendar month bucket for backtest clustering (A327 replay)."""
    return d.year, d.month


def expiry_week_from_detail(detail: dict | None, fallback: date | None = None) -> tuple[int, int] | None:
    if not detail:
        return iso_week(fallback) if fallback else None
    exp = detail.get("expiry")
    if exp is None:
        return iso_week(fallback) if fallback else None
    if isinstance(exp, str):
        return iso_week(date.fromisoformat(exp))
    return iso_week(exp)


def week_cluster_metrics(
    trades: list[dict],
    *,
    ret_key: str = "ret",
    week_key: str = "week",
    breach_key: str | None = "breach",
) -> dict:
    """Aggregate trade-level rows that carry an ISO week. Returns n_trades, n_weeks, means, breach, worst 5%."""
    if not trades:
        return {"n_trades": 0, "n_weeks": 0, "mean_ret": None, "week_mean_ret": None, "breach_rate": None, "worst_5pct": None}
    by_week: dict[tuple[int, int], list[float]] = defaultdict(list)
    rets = []
    breaches = []
    for t in trades:
        r = t.get(ret_key)
        if r is None:
            continue
        rets.append(r)
        wk = t.get(week_key)
        if wk is not None:
            by_week[wk].append(r)
        if breach_key and breach_key in t:
            breaches.append(bool(t[breach_key]))
    week_means = [mean(v) for v in by_week.values()] if by_week else []
    worst = None
    if len(week_means) >= 20:
        s = sorted(week_means)
        worst = s[max(0, len(s) // 20 - 1)]
    elif week_means:
        worst = min(week_means)
    return {
        "n_trades": len(rets),
        "n_weeks": len(by_week),
        "mean_ret": mean(rets) if rets else None,
        "week_mean_ret": mean(week_means) if week_means else None,
        "breach_rate": mean(breaches) if breaches else None,
        "worst_5pct": worst,
    }


def format_n(n_trades: int, n_weeks: int) -> str:
    return f"{n_trades} trades · {n_weeks} weeks"


def month_cluster_metrics(
    trades: list[dict],
    *,
    ret_key: str = "ret",
    month_key: str = "month",
    breach_key: str | None = "breach",
) -> dict:
    """Same as week_cluster_metrics but keyed by calendar month (backtest priors)."""
    patched = []
    for t in trades:
        row = dict(t)
        if month_key not in row and row.get("d") is not None:
            row[month_key] = month_block(row["d"])
        patched.append(row)
    return week_cluster_metrics(patched, ret_key=ret_key, week_key=month_key, breach_key=breach_key)


def failed_l1_gates(l1_checks: list | None) -> list[str]:
    return [c["check"] for c in (l1_checks or []) if not c.get("pass") and c.get("severity") == "block"]
