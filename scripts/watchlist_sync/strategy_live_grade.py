"""A380: every BOARD "Works" rule graded on its live record vs its backtest claim; weekly row + drift flag.

One line per rule per ISO week (cumulative since the rule's first live pick):
  claim    the BOARD number, in the same unit the live number is graded in (bp/wk or % per trade)
  live     mean over independent clusters (one cluster = one expiry week); contracts in one week share one market draw,
           so n = clusters, not contracts (11-27: all 33 graded panic puts expired 11-20 = one draw, not 33)
  ci       95 % t-interval over cluster means (needs ≥ 2 clusters)
  flag     no data      0 graded (never green, Codex 11-09)
           underpowered < 30 clusters
           drift        ≥ 30 clusters and ci_hi < 0.5 × claim
           on track     otherwise
Fill basis is named per row: engine picks are graded at the price the ledger stored (bid / realistic L2 fill / mid);
Jamie's IRA fills are his real RH fills. Expiry-hold P&L everywhere (the unit the studies used), not the 10-day
assignment all-in that model_recs.pnl_pct holds.

Usage: .venv/bin/python strategy_live_grade.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import date, timedelta
from statistics import mean, stdev

from build_plan import connect, rows

MIN_CLUSTERS = 30
DRIFT_FRAC = 0.5
T975 = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 15: 2.13, 20: 2.09, 30: 2.04}


def t975(df: int) -> float:
    for k in sorted(T975):
        if df <= k:
            return T975[k]
    return 1.96


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def per_week_bp(ret_frac: float, days: float) -> float:
    """Return on collateral → bp per week held; a trade shorter than a week still ties up that week (one pick/week)."""
    return ret_frac * 1e4 / (max(days, 7.0) / 7.0)


# ── sources: each returns list of (dedupe_key, cluster_week, value) ─────────────────────────────

def src_model_puts(c):
    """S088: Model List put recs (model_recs), expiry hold at the stored premium (bid)."""
    out = {}
    for r in rows(c, """SELECT ticker, expiry, strike::float8 k, dte::float8 dte, premium::float8 prem,
                               settle_close::float8 sc, component_scores->'_settlement'->'hold'->>'pnlPct' hold
                        FROM model_recs WHERE side = 'put' AND status IN ('WIN','LOSS','ASSIGNED') AND settle_close IS NOT NULL"""):
        if r["hold"] is not None:
            ret = float(r["hold"]) / 100.0
        else:
            ret = (r["prem"] - max(r["k"] - r["sc"], 0.0)) / r["k"]
        out[(r["ticker"], r["expiry"], r["k"])] = (monday(r["expiry"]), per_week_bp(ret, r["dte"] or 7))
    return [(k, w, v) for k, (w, v) in out.items()]


def src_engine_puts(c):
    """Put engine PASS picks (put_recs_daily → Today), sold at bid + 23 % of the spread (RH median fill), held to expiry."""
    out = {}
    for r in rows(c, """SELECT DISTINCT ON (d.ticker, d.payload->>'expiry', d.payload->>'strike')
                               d.ticker, d.as_of, (d.payload->>'expiry')::date e, (d.payload->>'strike')::float8 k,
                               (d.payload->>'bid')::float8 bid, (d.payload->>'ask')::float8 ask, (d.payload->>'spot')::float8 s, h.close::float8 sc
                        FROM watchlist_sync.put_recs_daily d
                        JOIN prices_historical h ON h.ticker = d.ticker AND h.date = (d.payload->>'expiry')::date
                        WHERE d.pass AND d.payload->>'bid' IS NOT NULL AND d.payload->>'ask' IS NOT NULL
                        ORDER BY d.ticker, d.payload->>'expiry', d.payload->>'strike', d.as_of"""):
        if not r["s"] or abs(r["sc"] / r["s"] - 1) > 0.35:   # split / bad print
            continue
        ret = (r["bid"] + 0.23 * (r["ask"] - r["bid"]) - max(r["k"] - r["sc"], 0.0)) / r["k"]
        out[(r["ticker"], r["e"], r["k"])] = (monday(r["e"]), per_week_bp(ret, (r["e"] - r["as_of"]).days))
    return [(k, w, v) for k, (w, v) in out.items()]


BT_DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.strategy_backtest_weeks (
  rule_id text NOT NULL, week date NOT NULL, bp double precision, computed_at timestamptz DEFAULT now(), PRIMARY KEY (rule_id, week))"""


def refresh_backtest(c, force=False) -> None:
    """Engine weekly backtest series (A352 book, top third by live score, net of fill cost) — the S207/S208 unit.
    ~1 min to rebuild; refreshed when older than 7 days."""
    c.execute(BT_DDL)
    age = rows(c, "SELECT max(computed_at) > now() - interval '7 days' AS fresh FROM watchlist_sync.strategy_backtest_weeks WHERE rule_id = 'ENGINE'")
    if age and age[0]["fresh"] and not force:
        return
    import sys
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent / "analysis"))
    import a352_score_rank as A
    by = {}
    for e in A.rebuild_book(c):
        by.setdefault(monday(e["d"]), []).append(e)
    c.execute("DELETE FROM watchlist_sync.strategy_backtest_weeks WHERE rule_id = 'ENGINE'")
    for w, g in sorted(by.items()):
        if len(g) < 20:
            continue
        top = sorted(g, key=lambda e: (-e["score"], e["t"]))[: max(1, len(g) // 3)]
        bp = 1e4 * sum(e["pnl"] for e in top) / sum(max(e["dte"], 1) / 7 for e in top)
        c.execute("INSERT INTO watchlist_sync.strategy_backtest_weeks (rule_id, week, bp) VALUES ('ENGINE', %s, %s)", (w, bp))
    c.commit()


def history_pct(c, rule_bt: str, live: float, k: int):
    """Share of the backtest's k-week stretches that were as bad as or worse than the live k-week mean."""
    s = [r["bp"] for r in rows(c, "SELECT bp FROM watchlist_sync.strategy_backtest_weeks WHERE rule_id = %s ORDER BY week", (rule_bt,))]
    if len(s) < k + 20 or k < 1:
        return None, None
    roll = [mean(s[i:i + k]) for i in range(len(s) - k + 1)]
    return sum(x <= live for x in roll) / len(roll), mean(s)


def src_model_calls(c):
    """S046: Model List covered-call recs (options-1.2.0+ call lane), expiry hold on spot."""
    out = {}
    for r in rows(c, """SELECT ticker, expiry, strike::float8 k, spot::float8 s, dte::float8 dte, premium::float8 prem,
                               settle_close::float8 sc, component_scores->'_settlement'->'hold'->>'pnlPct' hold
                        FROM model_recs WHERE side = 'call' AND status IN ('WIN','LOSS','ASSIGNED') AND settle_close IS NOT NULL"""):
        ret = float(r["hold"]) / 100.0 if r["hold"] is not None else (r["prem"] - max(r["sc"] - r["k"], 0.0)) / r["s"]
        out[(r["ticker"], r["expiry"], r["k"])] = (monday(r["expiry"]), per_week_bp(ret, r["dte"] or 7))
    return [(k, w, v) for k, (w, v) in out.items()]


def src_rich_puts(c):
    """S109: rich-put lane (Model List folder rich_puts, shadow), graded at expiry at the realistic L2 fill; one row per contract."""
    out = {}
    for r in rows(c, """SELECT ticker, ret, detail FROM watchlist_sync.grades
                        WHERE folder_key = 'rich_puts' AND horizon = 'expiry' AND ret IS NOT NULL ORDER BY graded_at"""):
        d = r["detail"] if isinstance(r["detail"], dict) else json.loads(r["detail"] or "{}")
        rich = d.get("rich") or {}
        exp, k = rich.get("expiry"), rich.get("strike")
        if not exp or k is None:
            continue
        e = date.fromisoformat(exp)
        out[(r["ticker"], e, float(k))] = (monday(e), per_week_bp(float(r["ret"]), float(d.get("days") or rich.get("days") or 7)))
    return [(k, w, v) for k, (w, v) in out.items()]


def src_panic_puts(c):
    """S054: panic-puts-hiv live signals (strategy_signals), sold at entry mid (paper), % of strike per trade."""
    return [((r["ticker"], r["expiry"], r["strike"]), monday(r["expiry"]), float(r["ret"]) * 100.0)
            for r in rows(c, """SELECT ticker, expiry, strike, ret FROM watchlist_sync.strategy_signals
                                WHERE strategy_id = 'panic-puts-hiv' AND status = 'graded' AND ret IS NOT NULL""")]


def src_ira_puts(c):
    """Jamie's real IRA fills: ira-puts strategy_trades (RH IRA), bp/wk per trade, clustered by ENTRY week so the row
    lines up with the same-weeks comparators (ira_same_weeks)."""
    return [((r["id"],), monday(r["d"]), per_week_bp(float(r["ret_pct"]), float(r["dte_at_entry"] or 7)))
            for r in rows(c, """SELECT id, entry_ts::date d, ret_pct, dte_at_entry FROM watchlist_sync.strategy_trades
                                WHERE strategy_id = 'ira-puts' AND ret_pct IS NOT NULL""")]


def src_long_calls(c):
    """S100: long-call paper ledger forward record (long_option_board, 'Revisions + 60-day strength')."""
    r = rows(c, "SELECT payload FROM watchlist_sync.long_option_board ORDER BY as_of DESC LIMIT 1")
    if not r:
        return [], "no long_option_board row"
    p = r[0]["payload"] if isinstance(r[0]["payload"], dict) else json.loads(r[0]["payload"])
    for s in p.get("strategies") or []:
        if "S100" in (s.get("name") or ""):
            f = s.get("forward") or {}
            return [], f"paper ledger: {f.get('n', 0)} graded, {f.get('open', 0)} open (per-trade rows not exposed yet)"
    return [], "S100 strategy missing from long_option_board"


RULES = [
    # rule_id, label, claim, unit, source fn, fill basis
    ("ENGINE", "Put engine picks (Today)", None, "bp/wk", src_engine_puts, "bid + 23 % of spread · expiry"),
    ("MODEL-PUTS", "Model tab option-score puts (legacy, not a Works rule)", None, "bp/wk", src_model_puts, "stored bid · expiry hold"),
    ("S088-IRA", "Your IRA puts (real fills) vs the same weeks", None, "bp/wk", src_ira_puts, "RH real fills · expiry"),
    ("S109", "Rich-put lane (shadow)", 101.0, "bp/wk", src_rich_puts, "L2 realistic fill · expiry"),
    ("S054", "Panic puts, IV30 > 48.7", 4.05, "%/trade", src_panic_puts, "entry mid (paper) · expiry"),
    ("S046", "Covered calls, call-lane tech", 42.9, "bp/wk", src_model_calls, "stored bid · expiry hold"),
    ("S100", "Buy calls: revisions + 60d strength", 69.6, "%/trade", src_long_calls, "ask (paper ledger)"),
    ("S101", "Sharp-drop regime → higher put Δ", None, "", None, "regime overlay, no own ledger"),
]


def grade_rule(obs, claim):
    by = {}
    for _, w, v in obs:
        by.setdefault(w, []).append(v)
    means = [mean(v) for _, v in sorted(by.items())]
    k, n = len(means), len(obs)
    if k == 0:
        return dict(n_trades=0, n_clusters=0, live=None, ci_lo=None, ci_hi=None, flag="no data", span="")
    live = mean(means)
    lo = hi = None
    if k >= 2:
        h = t975(k - 1) * stdev(means) / math.sqrt(k)
        lo, hi = live - h, live + h
    if k < MIN_CLUSTERS:
        flag = "underpowered"
    elif claim is not None and hi is not None and hi < DRIFT_FRAC * claim:
        flag = "drift"
    else:
        flag = "on track"
    span = f"wk {min(by):%m-%d}→{max(by):%m-%d}"
    return dict(n_trades=n, n_clusters=k, live=live, ci_lo=lo, ci_hi=hi, flag=flag, span=span)


def ira_equity_note(c) -> str:
    """Acceptance (a): the BOARD IRA number = ira-puts equity curve vs SPY over the same days."""
    r = rows(c, """SELECT min(d) d0, max(d) d1, (array_agg(equity ORDER BY d DESC))[1] eq,
                          (array_agg(spy_equity ORDER BY d DESC))[1] spy
                   FROM watchlist_sync.strategy_equity WHERE strategy_id = 'ira-puts'""")
    if not r or r[0]["eq"] is None:
        return ""
    x = r[0]
    return f"equity {x['eq'] - 1:+.1%} vs SPY {x['spy'] - 1:+.1%} ({x['d0']:%m-%d}→{x['d1']:%m-%d}); fills stop {x['d1']:%m-%d}"


def _week_means(pairs):
    by = {}
    for w, v in pairs:
        by.setdefault(w, []).append(v)
    return {w: mean(v) for w, v in by.items()}


def _paired(jam: dict, other: dict):
    """Jamie − comparator over the entry weeks both have: (n weeks, mean diff, ci lo, ci hi, comparator mean)."""
    ws = sorted(set(jam) & set(other))
    if not ws:
        return None
    d = [jam[w] - other[w] for w in ws]
    m = mean(d)
    h = t975(len(d) - 1) * stdev(d) / math.sqrt(len(d)) if len(d) >= 2 else None
    return dict(n=len(ws), diff=m, lo=None if h is None else m - h, hi=None if h is None else m + h,
                other=mean(other[w] for w in ws), you=mean(jam[w] for w in ws))


def ira_same_weeks(c):
    """Jamie 11-27: his IRA puts graded against what else the same weeks paid, not a frozen backtest number.
    Keyed by entry week (Monday). Comparators: engine (backtest A352 book until it ends, then the live Today picks at
    bid + 23 % of spread), SPY/QQQ 1σ weekly puts (index-1sigma-puts, model-priced), SPY held the week, 3-month T-bill."""
    jam = _week_means((monday(r["d0"]), per_week_bp(float(r["ret_pct"]), float(r["dte_at_entry"] or 7)))
                      for r in rows(c, """SELECT entry_ts::date d0, ret_pct, dte_at_entry FROM watchlist_sync.strategy_trades
                                          WHERE strategy_id = 'ira-puts' AND ret_pct IS NOT NULL"""))
    eng = {r["week"]: r["bp"] for r in rows(c, "SELECT week, bp FROM watchlist_sync.strategy_backtest_weeks WHERE rule_id = 'ENGINE'")}
    live = _week_means((monday(r["as_of"]), per_week_bp(
        (r["bid"] + 0.23 * (r["ask"] - r["bid"]) - max(r["k"] - r["sc"], 0.0)) / r["k"], (r["e"] - r["as_of"]).days))
        for r in rows(c, """SELECT DISTINCT ON (d.ticker, d.payload->>'expiry', d.payload->>'strike')
                                   d.as_of, (d.payload->>'expiry')::date e, (d.payload->>'strike')::float8 k,
                                   (d.payload->>'bid')::float8 bid, (d.payload->>'ask')::float8 ask, (d.payload->>'spot')::float8 s,
                                   h.close::float8 sc
                            FROM watchlist_sync.put_recs_daily d
                            JOIN prices_historical h ON h.ticker = d.ticker AND h.date = (d.payload->>'expiry')::date
                            WHERE d.pass AND d.payload->>'bid' IS NOT NULL AND d.payload->>'ask' IS NOT NULL
                            ORDER BY d.ticker, d.payload->>'expiry', d.payload->>'strike', d.as_of""")
        if r["s"] and abs(r["sc"] / r["s"] - 1) <= 0.35)
    for w, v in live.items():
        eng.setdefault(w, v)
    sig = _week_means((monday(r["d0"]), per_week_bp(float(r["ret_pct"]), float(r["dte_at_entry"] or 7)))
                      for r in rows(c, """SELECT entry_ts::date d0, ret_pct, dte_at_entry FROM watchlist_sync.strategy_trades
                                          WHERE strategy_id = 'index-1sigma-puts' AND ret_pct IS NOT NULL"""))
    px = [(r["date"], float(r["close"])) for r in rows(c, "SELECT date, close FROM prices_historical WHERE ticker = 'SPY' AND date >= '2025-12-01' ORDER BY date")]
    spy = {}
    for w in jam:
        before = [p for d, p in px if d < w]
        after = [p for d, p in px if d < w + timedelta(days=7)]
        if before and after and after[-1] != before[-1]:
            spy[w] = (after[-1] / before[-1] - 1) * 1e4
    tb = {}
    for w in jam:
        r = rows(c, """SELECT value FROM watchlist_sync.macro_daily WHERE series = 'tbill3m' AND date <= %s
                       ORDER BY date DESC LIMIT 1""", (w,))
        if r:
            tb[w] = float(r[0]["value"]) / 100 / 52 * 1e4
    return {k: _paired(jam, v) for k, v in (("engine", eng), ("1σ index puts", sig), ("SPY", spy), ("T-bill", tb))}


def ira_note(cmp) -> tuple[str, str, float | None]:
    """(flag, note, engine same-weeks mean) for the Journal row."""
    e = cmp.get("engine")
    if e is None:
        return "no engine weeks", "", None
    parts = []
    for k, v in cmp.items():
        if v is None:
            continue
        ci = "" if v["lo"] is None else f" [{v['lo']:+.0f}, {v['hi']:+.0f}]"
        parts.append(f"{k} {v['other']:+.0f} (you {v['you']:+.0f}, diff {v['diff']:+.0f}{ci}, {v['n']} wk)")
    if e["lo"] is not None and e["lo"] > 0:
        flag = "ahead of engine"
    elif e["hi"] is not None and e["hi"] < 0:
        flag = "behind engine"
    else:
        flag = "level with engine"
    return flag, "same weeks, bp/wk: " + "; ".join(parts), e["other"]


def run(c, refresh=True):
    out = []
    for rid, label, claim, unit, fn, fill in RULES:
        note = ""
        obs = []
        if fn is not None:
            got = fn(c)
            if isinstance(got, tuple):
                obs, note = got
            else:
                obs = got
        else:
            note = fill
        if rid == "S088-IRA":
            note = ira_equity_note(c)
        hist = None
        if rid == "ENGINE" and refresh:
            refresh_backtest(c)
        g = grade_rule(obs, claim)
        if rid in ("ENGINE", "MODEL-PUTS") and g["live"] is not None:
            # Jamie 11-27: never 'too few weeks' — place the live stretch inside the backtest's own same-length stretches
            hist, bt_mean = history_pct(c, "ENGINE", g["live"], g["n_clusters"])
            if hist is not None:
                claim = bt_mean
                g["flag"] = ("worse than history" if hist < 0.025 else "bad patch, in range" if hist < 0.25
                             else "on track")
                note = (f"worse than {1 - hist:.0%} of {g['n_clusters']}-week stretches 2021→ (backtest {bt_mean:+.0f} bp/wk); "
                        f"S210: no entry/exit lever avoids crash weeks; 2+ flag gate +10.5 bp/wk")
        elif rid == "S088-IRA":
            # 11-27 Jamie: '+77 was some backtest, not me' — target = what the engine earned in the weeks he traded
            flag, cmp_note, claim = ira_note(ira_same_weeks(c))
            g["flag"] = flag
            note = " · ".join(x for x in (cmp_note, note) if x)
        elif g["flag"] == "underpowered" and claim is None:
            g["flag"] = "no claim"
        elif g["flag"] == "underpowered":
            g["flag"] = "below claim" if (claim is not None and g["live"] is not None and g["live"] < claim) else "at/above claim"
        span = g.pop("span")
        note = " · ".join(x for x in (span, note) if x)
        out.append(dict(rule_id=rid, label=label, claim=claim, unit=unit, fill=fill, note=note, hist_pct=hist, **g))
    return out


DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.strategy_live_grade (
  rule_id text NOT NULL, week date NOT NULL, label text, claim double precision, unit text, fill text,
  n_trades int, n_clusters int, live double precision, ci_lo double precision, ci_hi double precision,
  flag text, note text, computed_at timestamptz DEFAULT now(), PRIMARY KEY (rule_id, week))"""
DDL2 = "ALTER TABLE watchlist_sync.strategy_live_grade ADD COLUMN IF NOT EXISTS hist_pct double precision"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    c = connect()
    res = run(c, refresh=not a.dry_run)
    wk = monday(date.today())
    for r in res:
        live = "—" if r["live"] is None else f"{r['live']:+.1f}"
        ci = "" if r["ci_lo"] is None else f" [{r['ci_lo']:+.1f}, {r['ci_hi']:+.1f}]"
        claim = "—" if r["claim"] is None else f"{r['claim']:+.1f}"
        print(f"{r['rule_id']:<9} {r['flag']:<12} live {live}{ci} vs claim {claim} {r['unit']} · "
              f"{r['n_clusters']} wk / {r['n_trades']} trades · {r['fill']}{(' · ' + r['note']) if r['note'] else ''}")
    if a.dry_run:
        return
    c.execute(DDL)
    c.execute(DDL2)
    for r in res:
        c.execute("""INSERT INTO watchlist_sync.strategy_live_grade
                     (rule_id, week, label, claim, unit, fill, n_trades, n_clusters, live, ci_lo, ci_hi, flag, note, hist_pct)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                     ON CONFLICT (rule_id, week) DO UPDATE SET label=EXCLUDED.label, claim=EXCLUDED.claim, unit=EXCLUDED.unit,
                       fill=EXCLUDED.fill, n_trades=EXCLUDED.n_trades, n_clusters=EXCLUDED.n_clusters, live=EXCLUDED.live,
                       ci_lo=EXCLUDED.ci_lo, ci_hi=EXCLUDED.ci_hi, flag=EXCLUDED.flag, note=EXCLUDED.note, hist_pct=EXCLUDED.hist_pct, computed_at=now()""",
                  (r["rule_id"], wk, r["label"], r["claim"], r["unit"], r["fill"], r["n_trades"], r["n_clusters"],
                   r["live"], r["ci_lo"], r["ci_hi"], r["flag"], r["note"], r["hist_pct"]))
    c.commit()


if __name__ == "__main__":
    main()
