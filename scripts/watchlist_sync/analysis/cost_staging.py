"""A369 cost-aware staging — re-screen cheaper structures when gross>0 but net≤0."""
from __future__ import annotations

from typing import Any, Callable

FILL_SHARE = 0.23  # bid + 23 % of spread (put_edge / state.md)


def tradable_net(stats: dict[str, float], *, leg: str) -> float:
    """Realistic net: option/stock legs priced at cross (bid+23 % spread ≈ full friction vs mid)."""
    cross = float(stats.get("net_cross", float("nan")))
    if cross == cross:
        return cross
    return float(stats.get("net_mid", float("nan")))


def staging_chain(
    stages: list[tuple[str, str, Callable[[], dict[str, float]]]],
) -> list[dict[str, Any]]:
    """Run stages in order; stop at first tradable net>0 after gross>0, or exhaust."""
    chain: list[dict[str, Any]] = []
    for name, leg, fn in stages:
        stats = fn()
        net_t = tradable_net(stats, leg=leg)
        row = {"stage": name, "leg": leg, "net_tradable": net_t, **stats}
        chain.append(row)
        gross = stats.get("gross", float("nan"))
        net_mid = stats.get("net_mid", float("nan"))
        if gross > 0 and net_t > 0:
            row["verdict"] = "survives_tradable"
            break
        if gross > 0 and net_mid > 0 and not (net_t > 0):
            row["verdict"] = "mid_only_not_tradable"
        elif gross <= 0 or not (net_t > 0):
            row["verdict"] = "continue" if name != stages[-1][0] else "killed_all_net_le_zero"
    return chain


def format_staging_chain(chain: list[dict[str, Any]]) -> str:
    lines = ["stage | gross | net_mid | net_cross | net_tradable | verdict"]
    for r in chain:
        lines.append(
            f"{r['stage']} | {r.get('gross', float('nan')):.4%} | "
            f"{r.get('net_mid', float('nan')):.4%} | {r.get('net_cross', float('nan')):.4%} | "
            f"{r.get('net_tradable', float('nan')):.4%} | {r.get('verdict', '')}"
        )
    return "\n".join(lines)
