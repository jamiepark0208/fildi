"""FILDI rebalance folder (user YES 2026-10-06, research/studies S012): concentration + margin, display only.

The IRA is the wheel strategy; FILDI is a mixed account (stocks, option-income ETFs, crypto, prediction markets) carrying a margin
loan. This folder shows, per FILDI holding, its share of the account's net value vs the cap, and one account line with leverage,
crypto share and the speculative bucket. Nothing is traded; the sizing suggestions are the trim needed to get back under the caps.
Caps live in params "rebalance" (max_name_pct, max_spec_pct). New puts in a margin account are already blocked in portfolio.allocate.
"""
from __future__ import annotations


def items(snap: dict, fit: dict, P: dict) -> list[dict]:
    """[{ticker, status, verdict, why}] for each rebalance account; first item per account is the account line."""
    RB = P["rebalance"]
    out: list[dict] = []
    for a in snap["accounts"]:
        if a["nickname"] not in RB["accounts"]:
            continue
        net = a.get("total_value") or 0
        if net <= 0:
            continue
        held = [p for p in snap["positions"] if p["account"] == a["account"] and (p["qty"] or 0) > 0 and p["last"]]
        mv = {p["ticker"]: p["qty"] * p["last"] for p in held}
        # speculative = single stocks the model doesn't rate green (ETFs/funds are purple "context" and excluded)
        spec = {t: v for t, v in mv.items() if ((fit.get(t) or {}).get("verdict") or "") not in ("green", "purple")}
        margin, crypto = a.get("margin_used") or 0, a.get("crypto_value") or 0
        gross = sum(mv.values()) + crypto
        lines = [f"net value ${net:,.0f} · holdings ${gross:,.0f} = {gross / net:.2f}× leverage"
                 + (f" · margin loan ${margin:,.0f}: no new put ideas here until it is paid down" if margin > 0 else "")]
        if crypto:
            lines.append(f"crypto ${crypto:,.0f} = {crypto / net:.0%} of net (not scored by the model)")
        spec_pct = sum(spec.values()) / gross if gross else 0
        lines.append(f"{'⚠ ' if spec_pct > RB['max_spec_pct'] else '✓ '}speculative (not-green single stocks) ${sum(spec.values()):,.0f} = "
                     f"{spec_pct:.0%} of holdings (cap {RB['max_spec_pct']:.0%}): " + ", ".join(sorted(spec, key=lambda t: -spec[t])))
        over = {t: v - RB["max_name_pct"] * net for t, v in mv.items() if v > RB["max_name_pct"] * net}
        trims = sorted(over.items(), key=lambda kv: -kv[1])
        if trims:
            lines.append("trims to reach the per-name cap: " + ", ".join(f"{t} ${v:,.0f}" for t, v in trims)
                         + f" (total ${sum(over.values()):,.0f}{' vs margin ' + f'${margin:,.0f}' if margin else ''})")
        out.append({"ticker": a["nickname"], "status": "review" if margin > 0 or trims or spec_pct > RB["max_spec_pct"] else "ok",
                    "verdict": "", "score": round(gross / net, 2), "why": lines})
        for t, v in sorted(mv.items(), key=lambda kv: -kv[1]):
            f = fit.get(t) or {}
            w = v / net
            cap = RB["max_name_pct"] * net
            why = [f"{'⚠' if v > cap else '✓'} ${v:,.0f} = {w:.0%} of {a['nickname']} net (cap {RB['max_name_pct']:.0%})"
                   + (f": trim ~${v - cap:,.0f}" if v > cap else "")]
            if f.get("verdict") == "red":
                why.append("model verdict red (Avoid): first in line to fund the margin paydown")
            out.append({"ticker": t, "status": "review" if v > cap or f.get("verdict") == "red" else "ok",
                        "verdict": f.get("verdict") or "", "score": round(100 * w, 1), "why": why, "f": f})
    return out
