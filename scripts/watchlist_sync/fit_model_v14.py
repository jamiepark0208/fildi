"""Fit Model v1.4: parameter-driven (watchlist_sync.model_params), scored for the champion AND every challenger, in shadow.

THE live fit model (merged 2026-10-05: fit-1.3 is only its input builder, fit_model.compute()). Every tunable number comes from
params.py / model_params, so learn.py can adjust it. Scores the champion and every challenger on the same point-in-time inputs
(+ LSEG IV history for IV rank). Writes fit_score_history (model_version = params version) for each, and fit_scores (the
champion's verdicts) for consumers like LSEG coverage.

Design (user review 2026-10-05):
  1. Missing data by cause: not applicable → excluded · pipeline gap (no LSEG row) → 'incomplete', no green/yellow/trade folder ·
     unavailable → peer median fill, with confidence = observed weight share. Never "missing = clean".
  2. STREET = scaled reward/penalty on OWN: adj = k · sign(z)·min(1, (|z|/2)^1.5) · conf, z = (STREET − 50)/25;
     conf = analysts × agreement × timing. Rewards can't lift a name across the credit / base-OWN floors.
  3. Red = severity-weighted risk ≥ red_risk ("not safe to be assigned"); weak-but-not-dangerous → watch-only.
  4. PREMIUM = w_iv_rv · IV/RV + w_iv_rank · 1-year IV rank + w_iv_level · IV level (Step 4: IV/RV is the edge, raw IV level isn't).

Usage: .venv/bin/python fit_model_v14.py [--write]
"""
from __future__ import annotations

import argparse
import json
import math
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from statistics import median

from build_plan import connect, rows
import fit_model as F13
import params as PM

OUT = Path(__file__).with_name("out") / "step2"


def wavg0(parts):
    """Weighted mean ignoring missing values and zero weights (a weight the learning loop set to 0 means 'not used')."""
    return F13.wavg([(w, v) for w, v in parts if w > 0])


def severity(i: dict, S: dict) -> list[tuple[float, str]]:
    out = []
    cr, arm, fund, ps, sf, pt = i.get("credit"), i.get("arm"), i.get("fund"), i.get("ps"), i.get("short_float"), i.get("pt_up")
    if cr is not None:
        if cr <= 5:
            out.append((S["credit_distress"], f"distress-level balance sheet (StarMine credit {cr}/100)"))
        elif cr <= 15:
            out.append((S["credit_fragile"], f"fragile balance sheet (StarMine credit {cr}/100)"))
    if arm is not None:
        if arm <= 5:
            out.append((S["arm_very"], f"analysts cutting very hard (revisions {arm}/100)"))
        elif arm <= 15:
            out.append((S["arm_hard"], f"analysts cutting hard (revisions {arm}/100)"))
    if fund is not None:
        if fund <= 25:
            out.append((S["fund_very"], f"very weak fundamentals vs peers (fund {fund:.0f})"))
        elif fund <= 35:
            out.append((S["fund_weak"], f"weak fundamentals vs peers (fund {fund:.0f})"))
    if i.get("fk") == 1:
        out.append((S["falling_knife"], "falling-knife chart"))
    if sf is not None:
        if sf >= 35:
            out.append((S["short_heavy"], f"{sf:.0f}% of float short"))
        elif sf >= 25:
            out.append((S["short_high"], f"{sf:.0f}% of float short"))
    er = i.get("next_er")
    days = (date.fromisoformat(str(er)[:10]) - date.today()).days if er else None
    if ps is not None and days is not None and 0 <= days <= 30:
        if ps <= -10:
            out.append((S["miss_big"], f"StarMine predicts a {ps:.1f}% miss on {str(er)[:10]}"))
        elif ps <= -2:
            out.append((S["miss"], f"StarMine predicts a {ps:.1f}% miss on {str(er)[:10]}"))
    if pt is not None and pt > 300:
        out.append((S["pt_implausible"], "analyst targets implausible (stale coverage)"))
    return [(w, r) for w, r in out if w > 0]


def street_adj(i: dict, street: float | None, P: dict) -> tuple[float, dict]:
    if street is None:
        return 0.0, {"why": "no STREET data"}
    z = (street - 50) / 25
    n = i.get("n_est")
    coverage = min(1.0, (n or 0) / P["analyst_saturation"]) if n is not None else 0.5
    signs = [x for x in ((i["arm"] - 50) if i.get("arm") is not None else None, i.get("drift"), i.get("ps")) if x is not None]
    er = i.get("next_er")
    days = (date.fromisoformat(str(er)[:10]) - date.today()).days if er else None
    timing = 1.0 if i.get("ps") is None or (days is not None and 0 <= days <= 30) else P["timing_far"]
    nz = [s for s in signs if s != 0]
    agree = (max(sum(s > 0 for s in nz), sum(s < 0 for s in nz)) / len(nz)) if nz else 0.5
    conf = coverage * (0.5 + 0.5 * agree) * timing
    shape = math.copysign(min(1.0, (abs(z) / 2) ** 1.5), z)
    adj = P["k"] * shape * conf
    return adj, {"z": round(z, 2), "coverage": round(coverage, 2), "agree": round(agree, 2), "timing": timing, "conf": round(conf, 2), "adj": round(adj, 1)}


def iv_ranks(conn, tickers) -> dict[str, float]:
    """1-year percentile of today's 30d ATM put IV within its own history (lseg_research.daily_history)."""
    hist = defaultdict(list)
    for r in rows(conn, """SELECT ticker, iv30_put::float8 v FROM lseg_research.daily_history
                           WHERE ticker = ANY(%s) AND date > CURRENT_DATE - 365 AND iv30_put > 0 ORDER BY ticker, date""", (list(tickers),)):
        hist[r["ticker"]].append(r["v"])
    out = {}
    for t, v in hist.items():
        if len(v) >= 120:
            s = sorted(v[:-1])
            out[t] = bisect_right(s, v[-1]) / len(s)
    return out


def score_all(S: list[dict], P: dict, ivr: dict) -> list[dict]:
    O, T, ST, SV = P["own"], P["thresholds"], P["street"], P["severity"]
    peer_vals, uni_vals = defaultdict(list), defaultdict(list)
    for s in S:
        i = s["inputs"]
        for k in ("fund", "credit", "cam", "arm", "drift", "ps"):
            if i.get(k) is not None and not (k == "credit" and i.get("peer") in F13.LEVERED_FINANCIALS):
                peer_vals[(i.get("peer") or "", k)].append(float(i[k]))
                uni_vals[k].append(float(i[k]))

    def prior(peer, k):
        v = peer_vals.get((peer or "", k), [])
        return (median(v), "peer median") if len(v) >= 5 else (median(uni_vals[k]), "universe median")

    out = []
    for s in S:
        i, t = dict(s["inputs"]), s["ticker"]
        if s["role"] == "etf":
            out.append({**s, "v14": "purple", "status": "ok", "why14": ["ETF / market context"], "own14": s["own"], "prem14": None,
                        "conf": None, "risk": 0, "risks": [], "detail": {}, "filled": {}, "eff": None})
            continue
        levered = i.get("peer") in F13.LEVERED_FINANCIALS
        synced = i.get("iv_fetched_at") is not None
        filled, notes = {}, []
        for k in ("credit", "cam", "arm", "drift", "ps"):
            if k == "credit" and levered:
                continue
            if i.get(k) is None and synced:
                filled[k], src = prior(i.get("peer"), k)
                notes.append(f"{k} unavailable → {src} {filled[k]:.0f}")
        ii = {**i, **filled}
        own = F13.wavg([(O["w_fund"], ii.get("fund")), (O["w_credit"], None if levered else ii.get("credit")), (O["w_cam"], ii.get("cam"))])
        tot = O["w_fund"] + O["w_cam"] + (0 if levered else O["w_credit"])
        obs = sum(w for w, k in ((O["w_fund"], "fund"), (O["w_credit"], "credit"), (O["w_cam"], "cam"))
                  if i.get(k) is not None and not (k == "credit" and levered))
        conf = obs / tot if tot else 0
        street = F13.wavg([(0.5, ii.get("arm")), (0.25, F13.lin(ii.get("drift"), -5, 5)), (0.25, F13.lin(ii.get("ps"), -5, 5))])
        adj, sd = street_adj(i, street, ST)
        iv, rv = i.get("iv"), i.get("rv")
        Pw = P["premium"]
        prem = wavg0([(Pw["w_iv_rv"], F13.lin(iv / rv, 0.8, 1.5) if iv and rv else None),
                         (Pw["w_iv_rank"], 100 * ivr[t] if t in ivr else None),
                         (Pw["w_iv_level"], F13.lin(iv, 25, 90) if iv else None)]) if iv else None
        risks = severity(i, SV)
        risk = sum(w for w, _ in risks)
        eff = None if own is None else max(0.0, min(100.0, own + adj))
        floor_ok = (levered or (ii.get("credit") or 0) >= ST["floor_credit"]) and (own or 0) >= ST["floor_own"]
        eff_tags = eff if (adj <= 0 or floor_ok) else own
        credit_ok = levered or (ii.get("credit") or 0) >= T["green_credit"]
        why = notes[:]
        if risk >= T["red_risk"]:
            v = "red"
            why.append(f"risk {risk:.1f} ≥ {T['red_risk']}: " + "; ".join(r for _, r in risks))
        elif not synced:
            v = ""
            why.append("incomplete: no LSEG data synced (pipeline gap), so it can't be tagged green/yellow")
        elif eff_tags is not None and eff_tags >= T["green_own"] and credit_ok:
            v = "green"
        elif prem is not None and prem >= T["yellow_premium"] and (eff_tags or 0) >= T["yellow_own"] and (s["fit"] or 0) >= T["yellow_fit"] and not risks:
            v = "yellow"
        else:
            v = ""
        if abs(adj) >= 0.5:
            why.append(f"STREET {street:.0f} → {adj:+.1f} on OWN (conf {sd['conf']})" + ("" if adj <= 0 or floor_ok else " — not applied for tags: below hard floor"))
        out.append({**s, "v14": v, "status": "ok" if synced else "incomplete", "why14": why, "own14": own, "prem14": prem, "eff": eff,
                    "conf": round(conf, 2), "risk": round(risk, 2), "risks": [r for _, r in risks], "detail": sd, "filled": filled})
    return out


def latest_inputs(conn) -> list[dict]:
    """Fresh point-in-time inputs for the whole universe (one SQL pass via fit_model.compute)."""
    return F13.compute(conn)


def write_fit_scores(conn, out: list[dict], version: str) -> None:
    """Champion verdicts → watchlist_sync.fit_scores (latest per ticker), the table LSEG coverage and fallbacks read."""
    hexc = {"green": "#22c55e", "yellow": "#eab308", "red": "#ef4444", "purple": "#a855f7", "": ""}
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO watchlist_sync.fit_scores (ticker, color, current_color, own, street, premium, fit, edge, flags, why, peer,
              rh_lists, verdict, role, model_version, computed_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
            ON CONFLICT (ticker) DO UPDATE SET color=EXCLUDED.color, current_color=EXCLUDED.current_color, own=EXCLUDED.own, street=EXCLUDED.street,
              premium=EXCLUDED.premium, fit=EXCLUDED.fit, edge=EXCLUDED.edge, flags=EXCLUDED.flags, why=EXCLUDED.why, peer=EXCLUDED.peer,
              rh_lists=EXCLUDED.rh_lists, verdict=EXCLUDED.verdict, role=EXCLUDED.role, model_version=EXCLUDED.model_version, computed_at=now()""",
            [(o["ticker"], "blue" if o["role"] == "held" else o["v14"], o.get("current_color"), o["eff"] if o["eff"] is not None else o["own14"],
              o["street"], o["prem14"], o["fit"], o["edge"], json.dumps(o["risks"]), json.dumps(o["why14"]), o.get("peer"), o.get("rh_lists") or [],
              o["v14"], o["role"], version) for o in out])


def report(base: list[dict], scored: dict[str, list[dict]]) -> str:
    st = [o for o in base if o["role"] != "etf"]
    L = [f"# fit model versions ({date.today()})", "", f"Same point-in-time inputs ({st[0]['computed_at']:%Y-%m-%d %H:%M}), {len(st)} non-ETF names; fit-1.3 shown as a fixed baseline.", "",
         "| verdict | fit-1.3 | " + " | ".join(scored) + " |", "|---|---|" + "---|" * len(scored)]
    c13 = Counter(o["verdict"] or "none" for o in st)
    cs = {v: Counter(o["v14"] or "none" for o in out if o["role"] != "etf") for v, out in scored.items()}
    for k in ("green", "yellow", "red", "none"):
        L.append(f"| {k} | {c13[k]} | " + " | ".join(str(cs[v][k]) for v in scored) + " |")
    for v, out in scored.items():
        tr = defaultdict(list)
        for o in out:
            if o["role"] != "etf" and (o["verdict"] or "") != o["v14"]:
                tr[(o["verdict"] or "none", o["v14"] or "none")].append(o["ticker"])
        L += ["", f"## {v}: transitions vs fit-1.3", "", "| from → to | n | tickers |", "|---|---|---|"]
        for (x, y), ts in sorted(tr.items(), key=lambda kv: -len(kv[1])):
            L.append(f"| {x} → {y} | {len(ts)} | {' '.join(sorted(ts))} |")
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    with connect() as conn:
        PM.ensure(conn)
        S = latest_inputs(conn)
        ivr = iv_ranks(conn, {s["ticker"] for s in S})
        versions = [PM.champion(conn)] + PM.challengers(conn)
        scored = {v: score_all(S, P, ivr) for v, P in versions}
        OUT.mkdir(parents=True, exist_ok=True)
        text = report(S, scored)
        (OUT / "fit_v14_shadow.md").write_text(text)
        print(text[:1500])
        if a.write:
            write_fit_scores(conn, scored[versions[0][0]], versions[0][0])
            with conn.cursor() as cur:
                for v, out in scored.items():
                    cur.executemany("""INSERT INTO watchlist_sync.fit_score_history (model_version, ticker, verdict, role, own, street, premium, fit, edge, flags, why, inputs)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        [(v, o["ticker"], o["v14"], o["role"], o["own14"], o["street"], o["prem14"], o["fit"], o["edge"], json.dumps(o["risks"]),
                          json.dumps(o["why14"]), json.dumps({**o["inputs"], "_v14": {"status": o["status"], "conf": o["conf"], "risk": o["risk"],
                          "eff": o["eff"], "street": o["detail"], "filled": o["filled"], "iv_rank": ivr.get(o["ticker"])}}, default=str)) for o in out])
            conn.commit()
            print(f"wrote shadow rows for {', '.join(scored)}")


if __name__ == "__main__":
    main()
