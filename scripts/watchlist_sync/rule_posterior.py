"""A327 stage 2: backtest priors + live weekly posteriors for strategy rules and weight promotion."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, pstdev
from typing import Any

from scipy.stats import beta as beta_dist
from scipy.stats import norm

from grade_weeks import MIN_LIVE_WEEKS, iso_week, month_block, month_cluster_metrics, week_cluster_metrics

EFFECTIVE_N = 20
PROMOTE_P = 0.9
DEMOTE_P = 0.9

HERE = Path(__file__).resolve().parent
RULES_PATH = HERE / "strategy_rules.json"


@dataclass
class BreachPost:
    alpha: float
    beta: float

    def mean(self) -> float:
        return self.beta / (self.alpha + self.beta)


@dataclass
class PnlPost:
    mu: float
    tau: float
    obs_var: float

    def sigma(self) -> float:
        return math.sqrt(1 / max(self.tau, 1e-12))


@dataclass
class RuleState:
    breach: BreachPost
    pnl: PnlPost
    n_live_weeks: int = 0


def load_learning_rules(path: Path | None = None) -> dict[str, dict]:
    doc = json.loads((path or RULES_PATH).read_text())
    return doc.get("learning_rules") or {}


def _week_rows(trades: list[dict]) -> list[dict]:
    by: dict[tuple[int, int], list[dict]] = {}
    for t in trades:
        wk = t.get("week") or iso_week(t["d"]) if t.get("d") else None
        if wk is None:
            continue
        by.setdefault(wk, []).append(t)
    out = []
    for wk, rs in by.items():
        br = [bool(x.get("breach")) for x in rs if "breach" in x]
        rets = [float(x["ret"]) for x in rs if x.get("ret") is not None]
        out.append(
            {
                "week": wk,
                "breach": mean(br) >= 0.5 if br else False,
                "mean_ret": mean(rets) if rets else None,
            }
        )
    return out


def prior_from_promise(promise: dict[str, Any]) -> RuleState:
    br = float(promise.get("breach_max") or 0.15) * 0.85
    mu = float(promise.get("pnl_wk_bp") or 0) / 1e4
    a = max(0.5, EFFECTIVE_N * (1.0 - br))
    b = max(0.5, EFFECTIVE_N * br)
    return RuleState(BreachPost(a, b), PnlPost(mu, EFFECTIVE_N / 1e-6, 1e-6), 0)


def prior_from_trades(trades: list[dict], *, use_month_blocks: bool = False) -> RuleState:
    """Backtest prior capped at EFFECTIVE_N independent weeks (month blocks for replay/backtest)."""
    if use_month_blocks:
        m = month_cluster_metrics(trades, ret_key="ret", month_key="month", breach_key="breach")
        n_blocks = m["n_weeks"]
        br = m["breach_rate"] or 0.0
        mu = m["week_mean_ret"] or 0.0
        by_m: dict[tuple[int, int], list[float]] = {}
        for t in trades:
            mb = t.get("month")
            if mb is None or t.get("ret") is None:
                continue
            by_m.setdefault(mb, []).append(float(t["ret"]))
        wk_means = [mean(v) for v in by_m.values()]
        obs_var = pstdev(wk_means) ** 2 if len(wk_means) > 1 else 1e-8
    else:
        m = week_cluster_metrics(trades, ret_key="ret", week_key="week", breach_key="breach")
        n_blocks = m["n_weeks"]
        br = m["breach_rate"] or 0.0
        mu = m["week_mean_ret"] or 0.0
        by_w: dict[tuple[int, int], list[float]] = {}
        for t in trades:
            wk = t.get("week")
            if wk is None or t.get("ret") is None:
                continue
            by_w.setdefault(wk, []).append(float(t["ret"]))
        wk_means = [mean(v) for v in by_w.values()]
        obs_var = pstdev(wk_means) ** 2 if len(wk_means) > 1 else 1e-8
    n_eff = min(max(n_blocks, 1), EFFECTIVE_N)
    a = max(0.5, n_eff * (1.0 - br))
    b = max(0.5, n_eff * br)
    tau = n_eff / max(obs_var, 1e-10)
    return RuleState(BreachPost(a, b), PnlPost(mu, tau, obs_var), 0)


def observe_live(state: RuleState, live_trades: list[dict]) -> RuleState:
    weeks = _week_rows(live_trades)
    a, b = state.breach.alpha, state.breach.beta
    mu, tau, obs_var = state.pnl.mu, state.pnl.tau, state.pnl.obs_var
    n_obs = 0
    x_sum = 0.0
    for w in weeks:
        if w["breach"]:
            b += 1.0
        else:
            a += 1.0
        if w["mean_ret"] is not None:
            n_obs += 1
            x_sum += w["mean_ret"]
    if n_obs:
        xbar = x_sum / n_obs
        tau = tau + n_obs / max(obs_var, 1e-10)
        mu = (state.pnl.mu * state.pnl.tau + (n_obs / max(obs_var, 1e-10)) * xbar) / tau
    return RuleState(BreachPost(a, b), PnlPost(mu, tau, obs_var), state.n_live_weeks + len(weeks))


def prob_breach_above(post: BreachPost, ceiling: float) -> float:
    if ceiling is None:
        return 0.0
    # post.alpha = non-breach weeks, post.beta = breach weeks → p ~ Beta(breach, non-breach)
    return float(1.0 - beta_dist.cdf(ceiling, post.beta, post.alpha))


def prob_pnl_below_bp(post: PnlPost, floor_bp: float | None) -> float:
    if floor_bp is None:
        return 0.0
    floor = floor_bp / 1e4
    return float(norm.cdf(floor, loc=post.mu, scale=post.sigma()))


def prob_below_floor(state: RuleState, floor: dict[str, Any]) -> float:
    return max(prob_breach_above(state.breach, floor.get("breach_max")), prob_pnl_below_bp(state.pnl, floor.get("pnl_wk_bp")))


def should_demote(state: RuleState, floor: dict[str, Any]) -> bool:
    return state.n_live_weeks >= MIN_LIVE_WEEKS and prob_below_floor(state, floor) >= DEMOTE_P


def decide(prior: RuleState, live_trades: list[dict], floor: dict[str, Any]) -> tuple[bool, str, RuleState]:
    """Generic demotion decision: prior + live window (non-overlapping) vs floor."""
    post = observe_live(prior, live_trades)
    post.n_live_weeks = len({t.get("week") or iso_week(t["d"]) for t in live_trades if t.get("d")})
    if should_demote(post, floor):
        return True, "posterior_floor", post
    return False, "", post


def prob_better_than(challenger: RuleState, champion: RuleState) -> float:
    var = challenger.pnl.sigma() ** 2 + champion.pnl.sigma() ** 2
    if var <= 0:
        return 1.0 if challenger.pnl.mu > champion.pnl.mu else 0.0
    z = (challenger.pnl.mu - champion.pnl.mu) / math.sqrt(var)
    return float(norm.cdf(z))


def promotion_allowed(prob: float) -> bool:
    return prob >= PROMOTE_P


def hand_beta_posterior_mean(alpha: float, beta: float) -> float:
    return beta / (alpha + beta)


__all__ = [
    "DEMOTE_P",
    "EFFECTIVE_N",
    "PROMOTE_P",
    "RuleState",
    "hand_beta_posterior_mean",
    "load_learning_rules",
    "observe_live",
    "prior_from_promise",
    "prior_from_trades",
    "decide",
    "prob_below_floor",
    "prob_better_than",
    "prob_breach_above",
    "promotion_allowed",
    "should_demote",
]
