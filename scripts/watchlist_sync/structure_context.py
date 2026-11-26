"""A192 V3 (Claude 11-24): one shared scenario context per idea; every candidate structure valued on the SAME paths.

Contract (Codex D2, research/common/reviews/2026-11-09-opportunity-quality-review.md § November 24 follow-up):
  * one immutable context per (ticker, decision day): identity = idea_id, decision_at, holding_horizon_at, role,
    technical_state_version, input_digest, scenario_id, policy_version, quote_snapshot_id. No favoured structure in it.
  * scenario_id hashes the paths, weights, time grid and future-IV policy, not just spot.
  * every candidate: spec_hash + exit_policy_id, valued at the SAME horizon on the SAME paths/weights.
  * lenses: cash budget · finite-loss budget · matched downside (same 5 % tail loss), plus unused cash, 100 shares, no trade.
    Lenses disagree → show the alternatives, never one "best".
  * missing history → context_unavailable (never 0 / neutral / negative EV).

Scenario policy hist2y_demeaned-1: every overlapping 21-trading-day path of the stock's own last ~2 y closes, de-meaned
(no directional view: mean terminal price = spot). V4 swaps in signal-conditioned episode sets under a new policy id.
Exit policy hold_h_settle-1: legs expiring before the horizon settle at intrinsic on the path's expiry day and sit in cash
(no roll, no interest); legs alive at the horizon are marked Black-Scholes at their ENTRY IV (sticky strike, declared:
not a forecast of future IV). Early assignment, dividends, deliverable adjustments: not modelled (capability_limits).
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, timedelta

import numpy as np

POLICY_VERSION = "ctx-1.0"
SCENARIO_POLICY = "hist2y_demeaned-1"
EXIT_POLICY = "hold_h_settle-1"
IV_POLICY = "entry_iv_sticky_strike"
H_CAL = 30                      # decision horizon, calendar days
H_TD = round(H_CAL * 5 / 7)     # 21 trading days (same calendar→trading map as structures.evaluate)
MIN_PATHS = 120                 # < ~6 months of windows → context_unavailable
TAIL_Q = 0.05                   # matched downside: mean of the worst 5 % of paths (CVaR5)
TAIL_BUDGET = 1000.0            # $ lost on that tail, the same for every candidate
RF = 0.045                      # T-bill for the unused-cash arm (legs.ts default)
UNLIMITED = {"short_strangle", "short_straddle"}   # naked short call side
LIMITS = ["no early assignment / exercise", "no dividends", "no deliverable adjustments", "terminal + expiry-day marks only (no stops/TP)",
          "future IV = entry IV (sticky strike)", "overlapping windows: effective n ≈ paths / 21"]


LENS_NOTES = {  # X4 (Codex 11-24): what each lens is, so no one reads it as 'beats T-bills at matched risk'
    "cash": "EV ÷ cash the trade ties up, over 30 d; legs settled earlier sit in cash with no interest; not a same-budget comparison",
    "finite_loss": "EV ÷ exact worst terminal loss of the whole position (stock legs included); unlimited-loss trades excluded",
    "same_budget": "Every row gets the same $ (100 shares' cash): whole contracts only, leftover cash earns the 4.5 % T-bill for 30 d. The fair 'beats cash?' test",
    "matched_downside": "EV at the size where the worst-5 % mean loss = $1,000; fractional contracts (theoretical); cash has no tail so never ranks here"}


def _h(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _ndtr(x):
    from structures import ndtr
    return ndtr(x)


def _bs(S, leg, t_left):
    k, iv = leg["strike"], max(leg["iv"] or 0.3, 0.05)
    if t_left <= 1e-6:
        return np.maximum(S - k, 0) if leg["side"] == "call" else np.maximum(k - S, 0)
    sd = iv * math.sqrt(t_left)
    d1 = (np.log(S / k) + 0.5 * sd * sd) / sd
    c = S * _ndtr(d1) - k * _ndtr(d1 - sd)
    return c if leg["side"] == "call" else c - S + k


def paths(logc: np.ndarray, h: int = H_TD) -> np.ndarray | None:
    """(n, h+1) log-return paths from every h-day window, drift removed linearly so the mean terminal PRICE = spot (no view).
    De-meaning log returns (structures.empirical) leaves +σ²/2 of dollar drift: 100 shares 'won' 43/263 ideas on 11-24."""
    logc = np.asarray(logc, float)
    if logc.ndim != 1 or len(logc) < h + MIN_PATHS or not np.all(np.isfinite(logc)):
        return None
    idx = np.arange(len(logc) - h)[:, None] + np.arange(h + 1)[None, :]
    p = logc[idx] - logc[idx[:, :1]]
    mu = math.log(float(np.exp(p[:, -1]).mean())) / h
    return p - mu * np.arange(h + 1)[None, :]


def build(ticker: str, as_of: date, spot: float, logc, inputs: dict | None = None, quote_snapshot_id: str | None = None) -> dict:
    """The one context for this idea. `_paths` (price paths, n × H+1) stays in memory, never in the JSON."""
    hz = as_of + timedelta(days=H_CAL)
    ident = {"idea_id": f"{ticker}:{as_of}", "ticker": ticker, "decision_at": str(as_of), "holding_horizon_at": str(hz),
             "role": "structure_choice", "policy_version": POLICY_VERSION, "scenario_policy": SCENARIO_POLICY,
             "exit_policy_id": EXIT_POLICY, "iv_policy": IV_POLICY, "quote_snapshot_id": quote_snapshot_id,
             "technical_state_version": (inputs or {}).get("version") or "strategy_engine.load_inputs",
             "input_digest": _h({k: v for k, v in (inputs or {}).items() if k != "put_rec"}), "capability_limits": LIMITS}
    if not (isinstance(spot, (int, float)) and math.isfinite(spot) and spot > 0):
        return ident | {"status": "context_unavailable", "reason": "spot missing/invalid"}
    lp = paths(logc) if logc is not None else None
    if lp is None:
        n = 0 if logc is None else max(len(logc) - H_TD, 0)
        return ident | {"status": "context_unavailable", "reason": f"history too short ({n} windows < {MIN_PATHS})"}
    n = len(lp)
    w = np.full(n, 1.0 / n)
    ident["scenario_id"] = _h({"p": SCENARIO_POLICY, "h": H_TD, "grid": "td", "iv": IV_POLICY,
                              "lp": hashlib.sha256(np.round(lp, 8).tobytes()).hexdigest(), "w": "uniform"})
    term = lp[:, -1]
    return ident | {"status": "ok", "spot": round(float(spot), 4), "n_paths": n, "n_eff": round(n / H_TD, 1), "horizon_td": H_TD,
                    "dist": {"p05": round(float(np.exp(np.percentile(term, 5)) - 1), 4), "p50": round(float(np.exp(np.median(term)) - 1), 4),
                             "p95": round(float(np.exp(np.percentile(term, 95)) - 1), 4)},
                    "_paths": float(spot) * np.exp(lp), "_w": w}


def spec_hash(c: dict) -> str:
    return _h({"s": c["structure"], "stock": bool(c.get("stock")) or c["structure"] == "covered_call",
               "legs": sorted((lg["side"], round(float(lg["strike"]), 4), str(lg["expiry"]), lg["qty"]) for lg in c["legs"])})


def pnl(c: dict, ctx: dict) -> np.ndarray:
    """$ per share at the horizon on every context path (credit already net of fills)."""
    P, S0 = ctx["_paths"], ctx["spot"]
    d0, hz = date.fromisoformat(ctx["decision_at"]), date.fromisoformat(ctx["holding_horizon_at"])
    v = np.full(len(P), -sum(lg["qty"] * lg["px"] for lg in c["legs"]), float)
    for lg in c["legs"]:
        e = lg["expiry"] if isinstance(lg["expiry"], date) else date.fromisoformat(str(lg["expiry"])[:10])
        if e <= hz:     # settle at intrinsic on the expiry day, then cash
            k = min(max(round((e - d0).days * 5 / 7), 0), H_TD)
            v += lg["qty"] * _bs(P[:, k], lg, 0.0)
        else:           # alive at the horizon: mark at entry IV
            v += lg["qty"] * _bs(P[:, -1], lg, (e - hz).days / 365)
    if c.get("stock") or c["structure"] == "covered_call":   # overlays carry the 100 shares (legacy evaluate dropped them for covered calls)
        v += P[:, -1] - S0
    return v


def exact_max_loss(c: dict) -> float | None:
    """X3 (Codex 11-24): worst terminal loss $/share of the WHOLE position (option legs + 100 shares for overlays) at the
    common expiry: piecewise-linear payoff → exact at S=0 and every strike knot; negative slope past the top strike →
    unlimited (None). Multi-expiry (calendar) → None (needs a term/IV path). Credit = entry fills (px)."""
    legs = c["legs"]
    if len({str(lg["expiry"])[:10] for lg in legs}) != 1:
        return None
    stock = bool(c.get("stock")) or c["structure"] == "covered_call"
    s0, cr = float(c["spot"]), -sum(lg["qty"] * lg["px"] for lg in legs)

    def pay(S):
        v = cr + sum(lg["qty"] * (max(S - lg["strike"], 0) if lg["side"] == "call" else max(lg["strike"] - S, 0)) for lg in legs)
        return v + (S - s0 if stock else 0.0)
    slope = sum(lg["qty"] for lg in legs if lg["side"] == "call") + (1 if stock else 0)
    if slope < 0:
        return None
    worst = min(pay(S) for S in [0.0] + [float(lg["strike"]) for lg in legs])
    return max(-worst, 0.0)


def eligibility(c: dict, status: str) -> tuple[bool, str]:
    """X2: a candidate may be called 'best' only if it passed the declared comparison policy: modelled (status ok) AND
    regime/policy fit (structures.py fit gate). Failed ones stay visible as hypothetical leaders, never as best."""
    if status != "ok":
        return False, "payoff only (model limitation)"
    if c.get("fit") is not True:
        return False, "fails fit gate: " + (c.get("fit_why") or "no fit verdict")
    return True, "passes fit gate"


def lenses(x: np.ndarray, w: np.ndarray, cash: float, max_loss: float | None, unlimited: bool, budget: float | None = None) -> dict:
    """Per-share pnl x → the three budgets. cash = $/share the trade ties up; max_loss = finite worst case or None."""
    ev = float(w @ x)
    k = max(1, int(round(TAIL_Q * len(x))))
    tail = float(np.sort(x)[:k].mean())
    out = {"ev": round(ev, 4), "p_win": round(float(w @ (x > 0)), 3), "cvar5": round(tail, 4),
           "cash": {"per_share": round(cash, 4), "ret": round(ev / cash, 4) if cash > 0 else None}}
    if unlimited or max_loss is None or not math.isfinite(max_loss) or max_loss <= 0:
        out["finite_loss"] = {"ret": None, "why": "unlimited loss" if unlimited else "no finite max loss"}
    else:
        out["finite_loss"] = {"max_loss": round(max_loss, 4), "ret": round(ev / max_loss, 4)}
    if budget:   # X4: same $ budget for every row; whole contracts only; leftover cash earns the T-bill over the horizon
        n = math.floor(budget / (cash * 100) + 1e-9) if cash > 0 else 0
        idle = budget - n * cash * 100
        if cash > 0 and n == 0:
            out["same_budget"] = {"ret": None, "why": "1 contract > budget"}
        else:
            tot = n * 100 * ev + idle * RF * H_CAL / 365
            out["same_budget"] = {"budget": round(budget, 0), "contracts": n, "idle_usd": round(idle, 0), "pnl_usd": round(tot, 2),
                                  "worst5_usd": round(n * 100 * tail + idle * RF * H_CAL / 365, 2), "ret": round(tot / budget, 4)}
    if tail >= 0:
        out["matched_downside"] = {"ret": None, "why": "no tail loss on these paths"}
    else:
        units = TAIL_BUDGET / (-tail * 100)            # contracts (100 sh) so the worst-5 % mean loss = TAIL_BUDGET
        out["matched_downside"] = {"units": round(units, 3), "ev_usd": round(units * 100 * ev, 2),
                                   "cash_usd": round(units * 100 * cash, 0), "ret": round(ev / -tail, 4)}
    return out


def compare(ctx: dict, cands: list[dict]) -> dict:
    """Value every candidate + the three baselines on the context paths. Mutates each candidate: spec_hash, scenario_id, lenses."""
    if ctx.get("status") != "ok":
        for c in cands:
            c["spec_hash"], c["context"] = spec_hash(c), {"status": ctx.get("status"), "reason": ctx.get("reason")}
        return {k: v for k, v in ctx.items() if not k.startswith("_")} | {"candidates": [], "best": {}, "lenses_agree": None}
    P, w, S0 = ctx["_paths"], ctx["_w"], ctx["spot"]
    yrs = H_CAL / 365
    B = round(S0 * 100, 2)   # X4: common budget = 100 shares' cash
    rows = [{"id": "no_trade", "kind": "baseline", "lenses": lenses(np.zeros(len(P)), w, 0.0, None, False)},
            {"id": "cash", "kind": "baseline", "note": f"T-bill {RF:.1%} on the shares' cash",
             "lenses": lenses(np.full(len(P), S0 * RF * yrs), w, S0, None, False, B)},
            {"id": "stock", "kind": "baseline", "note": "100 shares", "lenses": lenses(P[:, -1] - S0, w, S0, S0, False, B)}]
    for c in cands:
        c["spec_hash"] = spec_hash(c)
        try:
            x = pnl(c, ctx)
        except Exception as e:  # noqa: BLE001 — one bad candidate never sinks the idea
            c["context"] = {"status": "model_limitation", "reason": f"{type(e).__name__}: {e}"}
            continue
        sid = c["structure"]
        cash = float(c.get("capital") or 0)
        lim = sid == "calendar"   # back-leg value needs a term/IV path → payoff illustration only
        ml = exact_max_loss(c)
        L = lenses(x, w, cash, ml, sid in UNLIMITED or (ml is None and not lim), B)
        st = "model_limitation" if lim else "ok"
        ok, why = eligibility(c, st)
        c["context"] = {"scenario_id": ctx["scenario_id"], "exit_policy_id": EXIT_POLICY, "status": st, "eligible": ok, **L}
        rows.append({"id": sid, "kind": "structure", "spec_hash": c["spec_hash"], "expiry": str(c["expiry"]), "tier": c.get("tier"),
                     "fit": c.get("fit"), "status": st, "eligible": ok, "eligibility_why": why, "lenses": L,
                     "legs": [{k: lg[k] for k in ("side", "strike", "qty", "px")} | {"expiry": str(lg["expiry"])} for lg in c["legs"]]})
    def winners(pool):
        out = {}
        for lens in ("same_budget", "cash", "finite_loss", "matched_downside"):
            xs = [r for r in pool if (r["lenses"].get(lens) or {}).get("ret") is not None]
            if xs:
                b = max(xs, key=lambda r: r["lenses"][lens]["ret"])
                out[lens] = b["id"] if b["lenses"][lens]["ret"] > 0 else "no_trade"
        return out
    base = [r for r in rows if r["kind"] == "baseline" and r["id"] != "no_trade"]
    best = winners(base + [r for r in rows if r.get("eligible")])                       # X2: eligible only
    any_lead = winners(base + [r for r in rows if r.get("status") == "ok" and r["kind"] == "structure"])
    hypo = {k: v for k, v in any_lead.items() if v != best.get(k)}                      # failed-gate leaders, labelled
    agree = len(set(best.values())) == 1 if best else None
    return {k: v for k, v in ctx.items() if not k.startswith("_")} | {
        "candidates": rows, "best": best, "best_basis": "eligible only (status ok + fit gate)", "hypothetical_leaders": hypo,
        "lens_notes": LENS_NOTES, "lenses_agree": agree,
        "read": ("no eligible trade beats cash / no trade"
                 if best and set(best.values()) <= {"cash", "no_trade"} else
                 f"all lenses → {next(iter(best.values()))}" if agree else
                 "lenses disagree → alternatives: " + ", ".join(f"{k} {v}" for k, v in best.items())) if best else "nothing rankable"}
