"""A369 cost-aware staging — re-screen cheaper structures when gross>0 but net≤0."""
from __future__ import annotations

from typing import Any, Callable


def staging_chain(
    stages: list[tuple[str, Callable[[], dict[str, float]]]],
) -> list[dict[str, Any]]:
    """Run stages in order; stop at first net_mid>0 after gross>0, or exhaust."""
    chain: list[dict[str, Any]] = []
    for name, fn in stages:
        stats = fn()
        row = {"stage": name, **stats}
        chain.append(row)
        gross = stats.get("gross", float("nan"))
        net_mid = stats.get("net_mid", float("nan"))
        net_cross = stats.get("net_cross", float("nan"))
        if gross > 0 and net_mid > 0:
            row["verdict"] = "survives_net_mid"
            break
        if gross > 0 and net_cross > 0 and not (net_mid > 0):
            row["verdict"] = "survives_net_cross_only"
            break
        if gross <= 0 or (not (net_mid > 0) and not (net_cross > 0)):
            row["verdict"] = "continue" if name != stages[-1][0] else "killed_all_net_le_zero"
    return chain


def format_staging_chain(chain: list[dict[str, Any]]) -> str:
    lines = ["stage | gross | net_mid | net_cross | verdict"]
    for r in chain:
        lines.append(
            f"{r['stage']} | {r.get('gross', float('nan')):.4%} | "
            f"{r.get('net_mid', float('nan')):.4%} | {r.get('net_cross', float('nan')):.4%} | {r.get('verdict', '')}"
        )
    return "\n".join(lines)
