"""Step 6: the learning loop. Evidence → challenger parameter version → shadow → (approved) promotion.

  propose   measure evidence, derive a challenger from the champion's params (bounded steps), write a before/after report
  status    champion, challengers, and how each is doing on live grades
  promote   make a challenger the champion (needs --approve, or learning.auto_promote within bounds)
  retire    drop a challenger

Evidence sources:
  rh        A24: the trader's real Robinhood short puts (analysis/trade_mistakes.py, S015 grain): premium-kept P&L vs
            entry IV/RV. Confirmation only — never fits a weight; a backtest-driven IV/RV move is held when the real book
            contradicts it (n ≥ 300, opposite sign, week-cluster p < 0.10).
  backtest  analysis/backtest_puts.py on lseg_research.daily_history (17k+ reconstructed puts since 2020), IV held fixed
  live      watchlist_sync.grades (from 2026-10-09 expiries on). Grades in the 'data' bucket are NEVER used: a data bug is
            fixed in the data lane, it doesn't teach the model anything.

Rules (each change cites the evidence that triggered it):
  premium weights   target ∝ max(0, premium-kept IC | IV) of IV/RV, IV rank, IV level when |t| ≥ min_t; else unchanged
  street.k          scaled by the strength of StarMine alpha's own-target IC | IV (t / 3, clamped 0.5–1.5), within 2–12 points
  severity.*        a flag whose tail-loss difference is ≤ 0 (t ≤ −1) or whose risk-adjusted return is better (t ≥ 2) is
                    down-weighted 25%; one that raises tail losses (t ≥ 2) is up-weighted 25% (bounds 0.05–1.0)
  thresholds        live grades only (≥ min_live_grades per folder): a folder whose picks underperform peers is tightened by 1 point
Every move is capped at learning.max_rel_step (25%) of the old value per cycle, so the model can't lurch.

Usage: .venv/bin/python learn.py propose | status | promote VERSION --approve | retire VERSION
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from build_plan import connect, rows
import params as PM

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))
sys.path.insert(0, str(HERE))
from grade_weeks import MIN_LIVE_WEEKS, expiry_week_from_detail, format_n, iso_week  # noqa: E402
from rule_posterior import (  # noqa: E402
    RuleState,
    load_learning_rules,
    observe_live,
    prior_from_promise,
    prior_from_trades,
    prob_better_than,
    promotion_allowed,
    should_demote,
)
OUT = HERE / "out" / "step6"
LEARN_DIGEST = Path.home() / ".fildi" / "learn-digest.txt"
PROMOTION_PRIOR_END = date(2020, 12, 31)
RULE_FOLDER_MAP = {
    "rich_puts": "rich_puts",
    "band_engine": "engine_puts",
    "put_edge_q5": "model_list",
}
_S059_PROMOTION_CACHE: list[dict] | None = None


def append_learn_digest(msg: str) -> str:
    """One line per propose run (A327 §7); agent_start reads the last line."""
    line = f"{date.today()} · {msg}"
    LEARN_DIGEST.parent.mkdir(parents=True, exist_ok=True)
    with LEARN_DIGEST.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    return line


def backtest_evidence(as_of: date | None = None) -> dict:
    import backtest_puts as B
    from statistics import median
    with connect() as conn:
        H, peer, er, sm = B.load(conn)
    trades = B.build_trades(H, peer, er, sm, 0.85, 0.20)
    if as_of is not None:
        trades = [t for t in trades if t["entry"] < as_of]
    by_m = defaultdict(list)
    for t in trades:
        by_m[t["entry"]].append(t)
    for ts in by_m.values():  # 3-month return vs sector peers (the 'own' target)
        g = defaultdict(list)
        for x in ts:
            if x["peer"] and x["fwd63"] is not None:
                g[x["peer"]].append(x["fwd63"])
        for x in ts:
            v = g.get(x["peer"]) or []
            x["fwd63_rel"] = (x["fwd63"] - median(v)) if len(v) >= 4 and x["fwd63"] is not None else None
    kept = B.evaluate(trades, ["iv_rv", "iv_rank_1y", "iv30"], "kept")
    own = B.evaluate(trades, ["combined_alpha_rank", "pred_surprise_pct_fq1"], "fwd63_rel")
    flags = {f: B.evaluate_binary(trades, f) for f in ("fk_proxy", "earnings_in_window")}
    pick = lambda r: {k: r[k] for k in ("ic", "t", "pic", "pt", "months", "n")} if r else None
    return {"source": "backtest", "trades": len(trades), "kept": {k: pick(v) for k, v in kept.items()},
            "own": {k: pick(v) for k, v in own.items()}, "flags": flags}


def rh_evidence(conn) -> dict:
    """A24: IC of entry IV/RV vs premium-kept P&L (÷ strike) on the trader's real puts, week-clustered."""
    import trade_mistakes as TM
    try:
        trades = TM.build_trades(*TM.load(conn))
    except Exception as e:  # noqa: BLE001 — evidence is optional; a broken export must not stop the cycle
        return {"source": "rh", "error": str(e)[:200]}
    pairs = [(t["ivrv"], t["pnl"], t) for t in trades if t.get("ivrv") is not None]
    if len(pairs) < 30:
        return {"source": "rh", "n": len(pairs)}
    ic, p = TM.cluster_boot(pairs, lambda it: TM.week(it[2]["d0"]), lambda its: TM.ic([(x, y) for x, y, _ in its]))
    return {"source": "rh", "n": len(pairs), "ivrv_kept_ic": ic, "p": p}


def live_evidence(conn) -> dict:
    if not rows(conn, "SELECT to_regclass('watchlist_sync.grades') IS NOT NULL ok")[0]["ok"]:
        return {"graded": 0}
    g = rows(
        conn,
        """SELECT g.folder_key, g.horizon, g.outcome, g.bucket, g.vs_peers, g.ret, g.detail, r.created_at::date run_date
           FROM watchlist_sync.grades g JOIN watchlist_sync.model_runs r ON r.id = g.run_id WHERE g.bucket <> 'data'""",
    )
    by = defaultdict(list)
    weeks_by = defaultdict(set)
    for r in g:
        by[(r["folder_key"], r["horizon"])].append(r)
        # expiry rows cluster by expiry week; 5/10/21d verdict rows by pick week (A327 review: own/income never had expiry rows)
        wk = expiry_week_from_detail(r["detail"]) if r["horizon"] == "expiry" else iso_week(r["run_date"])
        if wk:
            weeks_by[(r["folder_key"], r["horizon"])].add(wk)
    folders = {}
    for k, v in by.items():
        fk, hz = k
        nw = len(weeks_by.get(k, ()))
        folders[f"{fk}:{hz}"] = {
            "n": len(v),
            "n_weeks": nw,
            "n_label": format_n(len(v), nw),
            "good": sum(x["outcome"] == "good" for x in v) / len(v),
            "buckets": dict(sorted({b: sum(x["bucket"] == b for x in v) for b in {x["bucket"] for x in v}}.items())),
        }
    return {
        "graded": len(g),
        "excluded_data_errors": rows(conn, "SELECT count(*) n FROM watchlist_sync.grades WHERE bucket = 'data'")[0]["n"],
        "folders": folders,
    }


def bounded(old: float, target: float, rel: float, lo: float, hi: float) -> float:
    step = max(abs(old) * rel, 0.02)
    return round(max(lo, min(hi, max(old - step, min(old + step, target)))), 4)


def _is_weight(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _redistribute_premium(champ: dict, key: str, new_val: float) -> dict:
    """Shift one weight without re-targeting backtest IC shares (avoids w_iv_rv snapping toward ~0.55 each cycle).

    Only numeric weights move. Flags such as contract_iv_pre_earnings stay as stored.
    """
    out = dict(champ)
    old = float(champ[key])
    delta = float(new_val) - old
    out[key] = float(new_val)
    others = [k for k in out if k != key and _is_weight(champ.get(k))]
    rest = sum(float(champ[k]) for k in others)
    if rest > 0 and abs(delta) >= 1e-9:
        for k in others:
            out[k] = round(float(champ[k]) - delta * (float(champ[k]) / rest), 4)
    weights = [k for k in out if _is_weight(out[k])]
    s = sum(float(out[k]) for k in weights)
    if s > 0 and abs(s - 1.0) > 1e-6:
        for k in weights:
            out[k] = round(float(out[k]) / s, 4)
    return out


def propose_params(P: dict, ev: dict, live: dict) -> tuple[dict, list[dict]]:
    L = P["learning"]
    new, why = copy.deepcopy(P), []
    # premium weights from premium-kept IC with IV held fixed (IV level's own IC is the unconditional one)
    comp = {"w_iv_rv": ev["kept"].get("iv_rv"), "w_iv_rank": ev["kept"].get("iv_rank_1y"), "w_iv_level": ev["kept"].get("iv30")}
    sig = {}
    for k, r in comp.items():
        if not r or r["months"] < L["min_months"]:
            continue
        ic, t = (r["ic"], r["t"]) if k == "w_iv_level" else (r["pic"], r["pt"])
        if ic is None:
            continue
        sig[k] = max(0.0, ic) if abs(t) >= L["min_t"] or ic <= 0 else None
    if sig and all(v is not None for v in sig.values()) and sum(sig.values()) > 0:
        tot = sum(sig.values())
        prem = dict(P["premium"])
        for k, v in sig.items():
            old = P["premium"][k]
            cur_share = old / sum(P["premium"].values()) if sum(P["premium"].values()) else 0
            target_share = v / tot
            nv = bounded(old, old + (target_share - cur_share), L["max_rel_step"], 0.0, 1.0)
            rh = ev.get("rh") or {}
            if (k == "w_iv_rv" and abs(nv - old) >= 0.01 and rh.get("n", 0) >= 300 and rh.get("p") is not None
                    and rh["p"] < 0.10 and (rh["ivrv_kept_ic"] > 0) != (nv > old)):
                rh["held"] = f"premium.{k} {old} → {nv} held: real RH puts disagree (IV/RV kept IC {rh['ivrv_kept_ic']:+.3f}, p {rh['p']:.2f}, n {rh['n']})"
                continue
            if abs(nv - old) >= 0.01:
                prem = _redistribute_premium(prem, k, nv)
                why.append({"param": f"premium.{k}", "old": old, "new": prem[k], "why": f"premium-kept IC {comp[k]['pic'] if k != 'w_iv_level' else comp[k]['ic']:+.3f} → nudge share {target_share:.2f} (was {cur_share:.2f})"})
        new["premium"] = prem
    # STREET size from StarMine alpha's 'own' evidence
    cam = ev["own"].get("combined_alpha_rank")
    if cam and cam["months"] >= L["min_months"] and cam["pt"] is not None:
        # absolute target, anchored to the seed: the same evidence always points to the same k (no compounding across cycles)
        scale = max(0.5, min(1.5, cam["pt"] / 3)) if cam["pic"] > 0 else 0.5
        old = P["street"]["k"]
        nv = bounded(old, PM.SEED["street"]["k"] * scale, L["max_rel_step"], 2.0, 12.0)
        if abs(nv - old) >= 0.1:
            new["street"]["k"] = nv
            why.append({"param": "street.k", "old": old, "new": nv, "why": f"StarMine alpha own-target IC | IV {cam['pic']:+.3f} (t {cam['pt']:+.1f}) → scale {scale:.2f}"})
    # flag severities
    fk = ev["flags"].get("fk_proxy")
    if fk and fk["months"] >= L["min_months"]:
        old, ref = P["severity"]["falling_knife"], PM.SEED["severity"]["falling_knife"]  # targets anchored to the seed
        if fk["t_tail"] >= L["min_t"]:
            nv = bounded(old, min(1.0, ref * 1.5), L["max_rel_step"], 0.05, 1.0)
            reason = f"flag raises tail losses (+{100 * fk['d_tail']:.1f} pts, t {fk['t_tail']:+.1f})"
        elif fk["t_tail"] <= -1 or fk["t_ret"] >= L["min_t"]:
            nv = bounded(old, ref * 0.75, L["max_rel_step"], 0.05, 1.0)
            reason = f"flag doesn't hurt put outcomes (tail {100 * fk['d_tail']:+.1f} pts t {fk['t_tail']:+.1f}; risk-adj return t {fk['t_ret']:+.1f})"
        else:
            nv, reason = old, ""
        if abs(nv - old) >= 0.01:
            new["severity"]["falling_knife"] = nv
            why.append({"param": "severity.falling_knife", "old": old, "new": nv, "why": reason})
    # thresholds from live grades (inactive until enough non-data grades exist)
    min_weeks = L.get("min_live_weeks", MIN_LIVE_WEEKS)
    for key, thr, sign in (("own:21d", "green_own", +1), ("income:21d", "yellow_premium", +1)):
        f = live.get("folders", {}).get(key)
        nw = (f or {}).get("n_weeks", 0)
        if f and f["n"] >= L["min_live_grades"] and nw >= min_weeks and f["good"] < 0.5:
            old = P["thresholds"][thr]
            new["thresholds"][thr] = old + sign
            why.append({"param": f"thresholds.{thr}", "old": old, "new": old + sign,
                        "why": f"live {key}: only {f['good']:.0%} of {f['n_label']} beat peers"})
    return new, why


def _rule_live_trades(conn, folder_prefix: str) -> list[dict]:
    g = rows(
        conn,
        """SELECT g.ret, g.detail, r.created_at::date run_date
           FROM watchlist_sync.grades g JOIN watchlist_sync.model_runs r ON r.id = g.run_id
           WHERE g.bucket <> 'data' AND g.folder_key LIKE %s AND g.horizon = 'expiry'""",
        (folder_prefix + "%",),
    )
    out = []
    for r in g:
        wk = expiry_week_from_detail(r["detail"], r["run_date"])
        if not wk:
            continue
        detail = r["detail"] if isinstance(r["detail"], dict) else {}
        out.append({"ret": float(r["ret"]), "week": wk, "breach": bool(detail.get("breach"))})
    return out


def apply_rule_posteriors(P: dict, conn) -> tuple[dict, list[str]]:
    """Demote rules to shadow when live posterior crosses floor (≥ MIN_LIVE_WEEKS)."""
    rules = load_learning_rules()
    learning = P.setdefault("learning", {})
    shadow = set(learning.get("rules_shadow") or [])
    notes: list[str] = []
    for rid, spec in rules.items():
        if rid.startswith("_") or spec.get("status") == "shadow":
            continue
        fk = RULE_FOLDER_MAP.get(rid, rid)
        live = _rule_live_trades(conn, fk)
        if not live:
            continue
        prior = prior_from_promise(spec["promise"])
        prior = observe_live(prior, live)
        prior.n_live_weeks = len({t["week"] for t in live})
        if should_demote(prior, spec["floor"]):
            if rid not in shadow:
                notes.append(f"demote {rid}: P(below floor)≥{0.9:.0%} over {prior.n_live_weeks} live weeks")
            shadow.add(rid)
    learning["rules_shadow"] = sorted(shadow)
    return P, notes


def apply_shadow_rule_proposals(P: dict, conn) -> tuple[dict, list[str]]:
    """S151 shadow challengers: propose active only when P(better than champion lane) ≥ 0.9 (≥ 6 live weeks)."""
    rules = load_learning_rules()
    learning = P.setdefault("learning", {})
    active = set(learning.get("rules_active") or [])
    log: list[str] = list(learning.get("shadow_proposals") or [])
    notes: list[str] = []
    for rid, spec in rules.items():
        if rid.startswith("_") or spec.get("status") != "shadow":
            continue
        if rid in active:
            continue
        live_s = _rule_live_trades(conn, f"shadow:{rid}")
        n_wks = len({t["week"] for t in live_s})
        if n_wks < MIN_LIVE_WEEKS:
            continue
        champ_lane = spec.get("champion_lane", "put_edge_q5")
        champ_spec = rules.get(champ_lane) or {}
        fk = RULE_FOLDER_MAP.get(champ_lane, champ_lane)
        live_c = _rule_live_trades(conn, fk)
        post_s = observe_live(prior_from_promise(spec["promise"]), live_s)
        post_s.n_live_weeks = n_wks
        post_c = observe_live(prior_from_promise(champ_spec.get("promise", spec["promise"])), live_c)
        post_c.n_live_weeks = len({t["week"] for t in live_c})
        p = prob_better_than(post_s, post_c)
        if promotion_allowed(p):
            msg = f"propose shadow→active {rid} P={p:.2f} vs {champ_lane} ({n_wks}w)"
            if msg not in log:
                log.append(msg)
            notes.append(msg)
    learning["shadow_proposals"] = log[-30:]
    return P, notes


def shadow_promotion_decision(
    live_shadow: list[dict],
    live_champ: list[dict],
    shadow_promise: dict,
    champ_promise: dict,
) -> tuple[bool, float]:
    """Test hook: P(shadow better than champion lane) with week-clustered live rows."""
    n_wks = len({t["week"] for t in live_shadow})
    if n_wks < MIN_LIVE_WEEKS:
        return False, 0.5
    post_s = observe_live(prior_from_promise(shadow_promise), live_shadow)
    post_s.n_live_weeks = n_wks
    post_c = observe_live(prior_from_promise(champ_promise), live_champ)
    post_c.n_live_weeks = len({t["week"] for t in live_champ})
    p = prob_better_than(post_s, post_c)
    return promotion_allowed(p), p


def _promotion_backtest_trades(as_of: date | None = None) -> list[dict]:
    import backtest_puts as B
    from statistics import median

    with connect() as conn:
        H, peer, er, sm = B.load(conn)
    trades = B.build_trades(H, peer, er, sm, 0.85, 0.20)
    if as_of is not None:
        trades = [t for t in trades if t["entry"] < as_of]
    by_m = defaultdict(list)
    for t in trades:
        by_m[t["entry"]].append(t)
    for ts in by_m.values():
        g = defaultdict(list)
        for x in ts:
            if x["peer"] and x["fwd63"] is not None:
                g[x["peer"]].append(x["fwd63"])
        for x in ts:
            v = g.get(x["peer"]) or []
            x["fwd63_rel"] = (x["fwd63"] - median(v)) if len(v) >= 4 and x["fwd63"] is not None else None
    out = []
    for t in trades:
        out.append(
            {
                **t,
                "d": t["entry"],
                "week": iso_week(t["entry"]),
                "breach": bool(t.get("assigned")),
            }
        )
    return out


def _street_own_pass(t: dict, P: dict, thr: float = 0.55) -> bool:
    cam = t.get("combined_alpha_rank")
    if cam is None:
        return False
    scale = P["street"]["k"] / max(PM.SEED["street"]["k"], 1e-6)
    return float(cam) * scale >= thr


def _paired_weekly_z(means_a: dict, means_b: dict, min_weeks: int = MIN_LIVE_WEEKS) -> tuple[bool, float]:
    d = [means_b[w] - means_a[w] for w in means_a.keys() & means_b.keys()]
    if len(d) < min_weeks:
        return False, 0.5
    m = sum(d) / len(d)
    sd = (sum((x - m) ** 2 for x in d) / (len(d) - 1)) ** 0.5
    if sd == 0:
        return (m > 0 and promotion_allowed(1.0)), (1.0 if m > 0 else 0.5 if m == 0 else 0.0)
    from scipy.stats import norm

    prob = float(norm.cdf(m / (sd / len(d) ** 0.5)))
    return promotion_allowed(prob), prob


def street_k_posterior_ok(
    CP: dict,
    NP: dict,
    ev: dict,
    as_of: date | None = None,
    pool: list[dict] | None = None,
) -> tuple[bool, float]:
    del ev
    trades = pool if pool is not None else _promotion_backtest_trades(as_of)
    flip = [t for t in trades if _street_own_pass(t, CP) != _street_own_pass(t, NP) and t.get("fwd63_rel") is not None]

    def means(P):
        g = defaultdict(list)
        for t in flip:
            if t.get("fwd63_rel") is None:
                continue
            g[t["week"]].append(float(t["fwd63_rel"]) if _street_own_pass(t, P) else 0.0)
        return {w: sum(v) / len(v) for w, v in g.items()}

    return _paired_weekly_z(means(CP), means(NP))


def falling_knife_posterior_ok(CP: dict, NP: dict, ev: dict, as_of: date | None = None) -> tuple[bool, float]:
    del ev
    trades = _promotion_backtest_trades(as_of)
    flagged = [t for t in trades if t.get("fk_proxy")]

    def breach_means(P):
        g = defaultdict(list)
        wt = max(0.05, min(1.0, P["severity"]["falling_knife"]))
        for t in flagged:
            g[t["week"]].append((1.0 if t["breach"] else 0.0) * wt)
        return {w: sum(v) / len(v) for w, v in g.items()}

    a, b = breach_means(CP), breach_means(NP)
    inv_a = {w: -v for w, v in a.items()}
    inv_b = {w: -v for w, v in b.items()}
    return _paired_weekly_z(inv_a, inv_b)


def _posterior_family(param: str) -> str:
    if param.startswith("premium."):
        return "premium"
    if param == "street.k":
        return "street.k"
    if param == "severity.falling_knife":
        return "falling_knife"
    if param.startswith("thresholds."):
        return "thresholds"
    return "unknown"


def challenger_posterior_for_moves(
    CP: dict,
    NP: dict,
    confirmed: list[dict],
    ev: dict,
    conn=None,
    as_of: date | None = None,
) -> tuple[bool, float | None, str]:
    """Score each param family and AND them (A342).

    premium / street.k / falling_knife keep their backtest posteriors.
    thresholds.* have no backtest posterior: the live-grade gate in propose_params
    (n / weeks / good<0.5) plus the two-cycle confirmation that built `confirmed`
    is the gate, returned as P=None.
    An unknown family blocks with ``no posterior branch for <param>`` — never a fake P=0.50.
    """
    families: dict[str, list[dict]] = {}
    order: list[str] = []
    for w in confirmed:
        fam = _posterior_family(w["param"])
        if fam not in families:
            order.append(fam)
            families[fam] = []
        families[fam].append(w)

    ok = True
    fail_p: float | None = None
    pass_p: float | None = None
    notes: list[str] = []

    def _take(fok: bool, p: float) -> None:
        nonlocal ok, fail_p, pass_p
        if not fok:
            ok = False
            if fail_p is None:
                fail_p = p
        elif pass_p is None:
            pass_p = p

    for fam in order:
        if fam == "premium":
            _take(*challenger_posterior_ok(CP, NP, ev, conn=conn, as_of=as_of))
        elif fam == "street.k":
            _take(*street_k_posterior_ok(CP, NP, ev, as_of=as_of))
        elif fam == "falling_knife":
            _take(*falling_knife_posterior_ok(CP, NP, ev, as_of=as_of))
        elif fam == "thresholds":
            notes.append("thresholds: live-grade gate (no backtest posterior)")
        else:
            ok = False
            for w in families[fam]:
                notes.append(f"no posterior branch for {w['param']}")

    p_out = fail_p if fail_p is not None else (pass_p if ok else None)
    return ok, p_out, "; ".join(notes)


def format_posterior_block(confirmed: list[dict], p: float | None, reason: str) -> str:
    """Digest fragment for a blocked challenger. No numeric P when there is no posterior."""
    moves = ", ".join(f"{w['param']} {w['old']}→{w['new']}" for w in confirmed)
    if p is None:
        return f"{moves} blocked: {reason or 'no posterior branch'}"
    extra = f" ({reason})" if reason else ""
    return f"{moves} blocked: P={p:.2f}{extra}"


def premium_score(t: dict, Pw: dict) -> float | None:
    """Same PREMIUM blend as fit_model_v14.score_all (wavg0 + lin)."""
    import fit_model as F13

    parts: list[tuple[float, float | None]] = []
    if Pw.get("w_iv_rv", 0) > 0 and t.get("iv_rv") is not None:
        parts.append((Pw["w_iv_rv"], F13.lin(float(t["iv_rv"]), 0.8, 1.5)))
    if Pw.get("w_iv_rank", 0) > 0 and t.get("iv_rank_1y") is not None:
        parts.append((Pw["w_iv_rank"], 100 * float(t["iv_rank_1y"])))
    iv_pct = t.get("iv_pct")
    if Pw.get("w_iv_level", 0) > 0 and iv_pct is not None:
        parts.append((Pw["w_iv_level"], F13.lin(float(iv_pct), 25, 90)))
    wv = [(w, v) for w, v in parts if v is not None and w > 0]
    return F13.wavg(wv) if wv else None


def _top_quintile_trades(trades: list[dict], Pw: dict) -> list[dict]:
    by_w: dict[tuple[int, int], list[tuple[float, dict]]] = defaultdict(list)
    for t in trades:
        sc = premium_score(t, Pw)
        if sc is None:
            continue
        by_w[t["week"]].append((sc, t))
    out: list[dict] = []
    for pairs in by_w.values():
        if len(pairs) < 5:
            continue
        pairs.sort(key=lambda x: -x[0])
        q = max(1, len(pairs) // 5)
        out.extend(x[1] for x in pairs[:q])
    return out


def _iv_history(conn) -> dict[str, list[tuple[date, float]]]:
    H: dict[str, list[tuple[date, float]]] = defaultdict(list)
    for r in rows(
        conn,
        """SELECT ticker, date, iv30_put::float8 v FROM lseg_research.daily_history
           WHERE iv30_put > 0 ORDER BY ticker, date""",
    ):
        H[r["ticker"]].append((r["date"], float(r["v"])))
    return H


def _iv_rank_1y(H: dict[str, list[tuple[date, float]]], ticker: str, d: date) -> float | None:
    from backtest_puts import pct_rank  # noqa: E402

    series = H.get(ticker) or []
    if not series:
        return None
    i = bisect_right([x[0] for x in series], d) - 1
    if i < 0:
        return None
    hist = [v for dd, v in series[max(0, i - 252) : i]]
    return pct_rank(series[i][1], hist)


def build_s059_promotion_trades(conn, end: date) -> list[dict]:
    """S059 sim puts enriched for premium scoring; entry dates < end."""
    import s059_option_factors as S59  # noqa: E402

    H = _iv_history(conn)
    out: list[dict] = []
    for e in S59.aligned_events(conn):
        d = e["d"]
        if d >= end:
            continue
        tkr = e.get("t") or e.get("ticker")
        iv_dec = e.get("iv30")
        out.append(
            {
                "d": d,
                "t": tkr,
                "ret": float(e["pnl"]),
                "breach": bool(e["breach"]),
                "week": iso_week(d),
                "month": (d.year, d.month),
                "iv_rv": e.get("iv_rv"),
                "iv_pct": float(iv_dec) * 100 if iv_dec is not None else None,
                "iv_rank_1y": _iv_rank_1y(H, tkr, d) if tkr else None,
            }
        )
    return out


def warm_s059_promotion_cache(conn, end: date) -> list[dict]:
    global _S059_PROMOTION_CACHE
    _S059_PROMOTION_CACHE = build_s059_promotion_trades(conn, end)
    return _S059_PROMOTION_CACHE


def weight_posterior_state(
    trades: list[dict],
    Pw: dict,
    *,
    prior_end: date,
    as_of: date,
) -> RuleState:
    pool = [t for t in trades if t["d"] < as_of]
    prior_picks = _top_quintile_trades([t for t in pool if t["d"] < prior_end], Pw)
    live_picks = _top_quintile_trades([t for t in pool if prior_end <= t["d"]], Pw)
    prior = prior_from_trades(prior_picks, use_month_blocks=True)
    post = observe_live(prior, live_picks)
    post.n_live_weeks = len({t["week"] for t in live_picks})
    return post


def challenger_posterior_from_pool(
    trades: list[dict],
    CP: dict,
    NP: dict,
    as_of: date,
    *,
    prior_end: date = PROMOTION_PRIOR_END,
) -> tuple[bool, float]:
    # Paired by week (Claude review b5ff8552): both weight sets pick from the same weekly pool, so their
    # top quintiles overlap heavily; comparing two independent posteriors double-counts shared variance
    # and P(better) almost never reaches 0.9. Test the mean weekly difference instead.
    pool = [t for t in trades if t["d"] < as_of]
    return paired_weekly_prob(pool, CP["premium"], NP["premium"])


def paired_weekly_prob(pool: list[dict], champ_w: dict, chal_w: dict, min_weeks: int = MIN_LIVE_WEEKS) -> tuple[bool, float]:
    def wk_means(Pw):
        g = defaultdict(list)
        for t in _top_quintile_trades(pool, Pw):
            if t.get("ret") is not None:
                g[t["week"]].append(float(t["ret"]))
        return {w: sum(v) / len(v) for w, v in g.items()}

    return _paired_weekly_z(wk_means(champ_w), wk_means(chal_w), min_weeks)


def challenger_posterior_ok(
    CP: dict,
    NP: dict,
    ev: dict,
    conn=None,
    as_of: date | None = None,
    s059_pool: list[dict] | None = None,
) -> tuple[bool, float]:
    """Champion vs challenger premium weights on the same S059 trades (top quintile / week, A327 §3)."""
    del ev  # IC still drives propose_params; posterior uses trade picks only
    as_of = as_of or date.today()
    if s059_pool is not None:
        pool = [t for t in s059_pool if t["d"] < as_of]
    elif conn is not None:
        pool = build_s059_promotion_trades(conn, as_of)
    else:
        with connect() as c:
            pool = build_s059_promotion_trades(c, as_of)
    return challenger_posterior_from_pool(pool, CP, NP, as_of)


def build_confirmed_challenger(P: dict, confirmed: list[dict]) -> tuple[dict, list[dict]]:
    """Challenger = champion plus confirmed moves only (A343).

    Premium keys replay `_redistribute_premium` in why order so the weights still sum to 1.
    Rationale `new` is rewritten from those final weights (a later move can change an earlier key).
    """
    out = copy.deepcopy(P)
    prem_moves = [w for w in confirmed if str(w.get("param", "")).startswith("premium.")]
    if prem_moves:
        prem = dict(out["premium"])
        for w in prem_moves:
            k = w["param"].split(".", 1)[1]
            prem = _redistribute_premium(prem, k, float(w["new"]))
        out["premium"] = prem
    for w in confirmed:
        param, new = w["param"], w["new"]
        if str(param).startswith("premium."):
            continue
        if str(param).startswith("thresholds."):
            out["thresholds"][param.split(".", 1)[1]] = new
        elif param == "street.k":
            out["street"]["k"] = new
        elif str(param).startswith("severity."):
            out["severity"][param.split(".", 1)[1]] = new
    rationale: list[dict] = []
    for w in confirmed:
        nw = dict(w)
        if str(w.get("param", "")).startswith("premium."):
            k = w["param"].split(".", 1)[1]
            nw["new"] = out["premium"][k]
        rationale.append(nw)
    return out, rationale


def apply_rationale(P: dict, rationale: list[dict]) -> dict:
    params, _rewritten = build_confirmed_challenger(P, rationale)
    return params


def param_direction(w: dict) -> str:
    return "up" if w["new"] > w["old"] else "down"


def promotion_allowed_this_week(P: dict) -> bool:
    raw = (P.get("learning") or {}).get("last_promotion_date")
    if not raw:
        return True
    last = date.fromisoformat(raw) if isinstance(raw, str) else raw
    return (date.today() - last).days >= 7


def next_version(conn, champ: str) -> str:
    base = champ.rsplit(".", 1)[0]
    n = [int(r["version"].rsplit(".", 1)[1]) for r in rows(conn, "SELECT version FROM watchlist_sync.model_params WHERE version LIKE %s", (base + ".%",))]
    return f"{base}.{max(n) + 1}"


def before_after(conn, champ_params: dict, chal_params: dict) -> str:
    import fit_model as F13
    import fit_model_v14 as V
    S = V.latest_inputs(conn)  # fresh point-in-time inputs (fit-1.3 no longer writes history rows)
    import iv_rank as IR
    ivr = IR.pctiles(conn, {s["ticker"] for s in S})   # same resolver as the live fit
    a = {o["ticker"]: o for o in V.score_all(S, champ_params, ivr)}
    b = {o["ticker"]: o for o in V.score_all(S, chal_params, ivr)}
    moves = defaultdict(list)
    for t in a:
        if a[t]["role"] != "etf" and a[t]["v14"] != b[t]["v14"]:
            moves[(a[t]["v14"] or "none", b[t]["v14"] or "none")].append(t)
    L = ["| from → to | n | tickers |", "|---|---|---|"]
    L += [f"| {x} → {y} | {len(ts)} | {' '.join(sorted(ts))} |" for (x, y), ts in sorted(moves.items(), key=lambda kv: -len(kv[1]))]
    n = sum(len(v) for v in moves.values())
    return f"**{n} verdict changes** on the latest inputs ({len(a)} names):\n\n" + ("\n".join(L) if n else "(none)"), n, len(a)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["propose", "status", "promote", "retire"])
    ap.add_argument("version", nargs="?")
    ap.add_argument("--approve", action="store_true")
    ap.add_argument("--force", action="store_true", help="propose: run even if nothing new arrived since the last cycle")
    a = ap.parse_args()
    with connect() as conn:
        PM.ensure(conn)
        cv, CP = PM.champion(conn)
        if a.cmd == "status":
            for r in rows(conn, "SELECT version, status, parent, created_at, promoted_at, approved_by, rationale FROM watchlist_sync.model_params ORDER BY created_at"):
                print(f"{r['version']:<12} {r['status']:<10} parent {r['parent'] or '—':<12} created {r['created_at']:%Y-%m-%d %H:%M}"
                      f"{'  promoted ' + format(r['promoted_at'], '%Y-%m-%d') + ' by ' + r['approved_by'] if r['promoted_at'] else ''}")
                for w in r["rationale"] or []:
                    print(f"    {w.get('param', '')} {w.get('old', '')} → {w.get('new', '')}  {w.get('why', '')}")
            print("live evidence:", json.dumps(live_evidence(conn))[:400])
            return
        if a.cmd == "retire":
            conn.execute("UPDATE watchlist_sync.model_params SET status = 'retired' WHERE version = %s AND status = 'challenger'", (a.version,))
            conn.commit()
            print(f"retired {a.version}")
            return
        if a.cmd == "promote":
            r = rows(conn, "SELECT params, rationale FROM watchlist_sync.model_params WHERE version = %s AND status = 'challenger'", (a.version,))
            if not r:
                sys.exit(f"{a.version} is not a challenger")
            auto = CP["learning"]["auto_promote"]
            if not a.approve and not auto:
                sys.exit("promotion needs the user's approval: rerun with --approve (or enable learning.auto_promote for bounded changes)")
            conn.execute("UPDATE watchlist_sync.model_params SET status = 'retired' WHERE status = 'champion'")
            pr = rows(conn, "SELECT params FROM watchlist_sync.model_params WHERE version = %s", (a.version,))[0]["params"]
            pr = copy.deepcopy(PM.merged(pr))
            pr.setdefault("learning", {})["last_promotion_date"] = date.today().isoformat()
            conn.execute(
                "UPDATE watchlist_sync.model_params SET status = 'champion', params = %s, promoted_at = now(), approved_by = %s WHERE version = %s",
                (json.dumps(pr), "user" if a.approve else "auto (bounded)", a.version),
            )
            conn.commit()
            print(f"promoted {a.version} (was {cv})")
            return
        # propose: only when there's new evidence (≥ 7 days since the last cycle, or new live grades); else exit fast
        state_f = OUT / "state.json"
        live = live_evidence(conn)
        st = json.loads(state_f.read_text()) if state_f.exists() else {}
        fresh = (date.today() - date.fromisoformat(st["last_cycle"])).days < 7 if st.get("last_cycle") else False
        if fresh and live.get("graded", 0) == st.get("graded") and not a.force:
            print(f"skip: last cycle {st['last_cycle']}, no new live grades ({live.get('graded', 0)}); use --force")
            return
        OUT.mkdir(parents=True, exist_ok=True)
        ev = backtest_evidence()
        ev["rh"] = rh_evidence(conn)
        NP, why = propose_params(CP, ev, live)
        CP, demote_notes = apply_rule_posteriors(CP, conn)
        CP, shadow_notes = apply_shadow_rule_proposals(CP, conn)
        if demote_notes or shadow_notes:
            conn.execute(
                "UPDATE watchlist_sync.model_params SET params = %s WHERE status = 'champion'",
                (json.dumps(CP),),
            )
            conn.commit()
        digest_bits: list[str] = list(demote_notes) + list(shadow_notes)
        prev_dirs = st.get("pending_dirs") or {}
        new_dirs = {w["param"]: param_direction(w) for w in why}
        confirmed = [w for w in why if prev_dirs.get(w["param"]) == param_direction(w)]
        st["pending_dirs"] = new_dirs
        state_f.write_text(json.dumps({"last_cycle": date.today().isoformat(), "graded": live.get("graded", 0), "pending_dirs": new_dirs}))
        if not why:
            msg = "no change" if not digest_bits else "; ".join(digest_bits)
            print(f"no change proposed: champion {cv} is consistent with the evidence")
            append_learn_digest(msg)
            (OUT / f"cycle_{date.today()}.md").write_text(f"# Learning cycle {date.today()}\n\nNo change: champion {cv} is consistent with the evidence.\n\n```json\n{json.dumps(ev, indent=1, default=str)[:4000]}\n```\n")
            return
        if not confirmed:
            msg = f"held first-cycle ({len(why)} moves)" + (f"; {'; '.join(digest_bits)}" if digest_bits else "")
            print(f"no challenger: {len(why)} proposed move(s) need a 2nd consecutive cycle in the same direction")
            append_learn_digest(msg)
            (OUT / f"cycle_{date.today()}.md").write_text(
                f"# Learning cycle {date.today()}\n\nHeld: first-cycle moves (need repeat next cycle): {why}\n"
            )
            return
        NP, confirmed = build_confirmed_challenger(CP, confirmed)
        ok_post, p_better, post_reason = challenger_posterior_for_moves(CP, NP, confirmed, ev, conn=conn)
        if not ok_post:
            msg = format_posterior_block(confirmed, p_better, post_reason)
            if digest_bits:
                msg = f"{msg}; {'; '.join(digest_bits)}"
            if p_better is None:
                print(f"no challenger: {post_reason or 'no posterior branch'}")
            else:
                print(f"no challenger: P(better than champion)={p_better:.2f} < 0.90 posterior bar")
            append_learn_digest(msg)
            return
        if post_reason:
            digest_bits.append(post_reason)
        ba, n_changed, n_names = before_after(conn, CP, NP)
        share = n_changed / max(n_names, 1)
        min_share = CP["learning"].get("min_challenger_verdict_share", 0.05)
        if share < min_share:
            msg = f"blocked verdict share {share:.0%}" + (f"; {'; '.join(digest_bits)}" if digest_bits else "")
            print(f"no challenger: verdict share {share:.1%} < {min_share:.0%} minimum ({n_changed}/{n_names} names)")
            append_learn_digest(msg)
            return
        why = confirmed
        for r in rows(conn, "SELECT version, params FROM watchlist_sync.model_params WHERE status = 'challenger'"):
            if PM.merged(r["params"]) == NP:
                print(f"no new challenger: the evidence still points to open challenger {r['version']}")
                append_learn_digest(f"existing challenger {r['version']}" + (f"; {'; '.join(digest_bits)}" if digest_bits else ""))
                return
        ver = next_version(conn, cv)
        conn.execute("""INSERT INTO watchlist_sync.model_params (version, status, parent, params, rationale, evidence)
                        VALUES (%s, 'challenger', %s, %s, %s, %s)""", (ver, cv, json.dumps(NP), json.dumps(why), json.dumps({"backtest": ev, "live": live}, default=str)))
        conn.commit()
        rep = [f"# Learning cycle {date.today()}: challenger {ver} (parent {cv})", "", "## Proposed changes", "", "| param | old | new | why |", "|---|---|---|---|"]
        rep += [f"| {w['param']} | {w['old']} | {w['new']} | {w['why']} |" for w in why]
        rep += ["", "## Before vs after (scenario on today's inputs)", "", ba, "",
                f"Live evidence: {live.get('graded', 0)} non-data grades (data-error grades excluded: {live.get('excluded_data_errors', 0)}).", "",
                f"Next: {ver} is scored in shadow beside {cv} every day (fit_model_v14). Promote with `learn.py promote {ver} --approve`, or retire it."]
        # Approval policy (user, 2026-10-05): Claude promotes routine changes itself: every param within max_rel_step (enforced by
        # bounded()) AND ≤ auto_max_verdict_share of names change verdict. Bigger moves, and anything reaching Robinhood, go to the user.
        if CP["learning"]["auto_promote"] and share <= CP["learning"]["auto_max_verdict_share"] and promotion_allowed_this_week(CP):
            conn.execute("UPDATE watchlist_sync.model_params SET status = 'retired' WHERE status = 'champion'")
            promoted = copy.deepcopy(NP)
            promoted.setdefault("learning", {})["last_promotion_date"] = date.today().isoformat()
            conn.execute(
                "UPDATE watchlist_sync.model_params SET status = 'champion', params = %s, promoted_at = now(), approved_by = 'auto (bounded)' WHERE version = %s",
                (json.dumps(promoted), ver),
            )
            conn.commit()
            rep.append(f"\n**Auto-promoted** (bounded: {n_changed}/{n_names} = {share:.0%} verdicts changed ≤ {CP['learning']['auto_max_verdict_share']:.0%}).")
            append_learn_digest(f"auto-promoted {ver}; {'; '.join(digest_bits)}" if digest_bits else f"auto-promoted {ver}")
        elif CP["learning"]["auto_promote"] and not promotion_allowed_this_week(CP):
            rep.append("\n**Held as challenger:** max 1 promotion per week (last promotion within 7 days).")
            append_learn_digest(f"proposed {ver} held (1/wk); {'; '.join(digest_bits)}" if digest_bits else f"proposed {ver} held (1/wk)")
        elif CP["learning"]["auto_promote"]:
            rep.append(f"\n**Needs the user:** {share:.0%} of verdicts would change (> {CP['learning']['auto_max_verdict_share']:.0%}). Held as challenger.")
            append_learn_digest(f"proposed {ver} needs user; {'; '.join(digest_bits)}" if digest_bits else f"proposed {ver} needs user")
        else:
            append_learn_digest(f"proposed {ver}; {'; '.join(digest_bits)}" if digest_bits else f"proposed challenger {ver}")
        (OUT / f"proposal_{ver}.md").write_text("\n".join(rep) + "\n")
        print("\n".join(rep))


if __name__ == "__main__":
    main()
