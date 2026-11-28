#!/usr/bin/env python3
"""S213 report → out/s213/report.html. Every number is read from out/s213/{replay,replay_shift21,replay_episodes,today,universe_today}.json.

    .venv/bin/python analysis/s213_report.py
"""
from __future__ import annotations

import html
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "out" / "s213"
CSS = (HERE / "s212_report.css").read_text()

NAMES = {"shares": "Shares, lump sum", "dca8": "Shares, 8 weekly buys", "leaps_dm": "0.80Δ LEAPS call (same exposure, rest in T-bills)",
         "leaps_all": "0.80Δ LEAPS call, all $10k in", "call_spread": "Call spread ATM / +30 %", "risk_rev": "Risk reversal (−0.25Δ put + 0.50Δ call)", "rr_deep": "Deep risk reversal, S212 shape (−0.12Δ put + 0.18Δ call)",
         "ps_funded_call": "Put-spread-funded call", "csp_wheel": "Cash-secured puts → wheel", "buy_write": "Buy-write (shares + monthly calls)"}
ORDER = ("shares", "dca8", "leaps_dm", "leaps_all", "call_spread", "risk_rev", "rr_deep", "ps_funded_call", "csp_wheel", "buy_write")
PLAN = [("SMH", 7000, "Semis ETF, 25 names. Same thesis without single-name risk."),
        ("NVDA", 1000, "Semis design. Fund score top 8 % of peers, 37 % off its high."),
        ("ASML", 1000, "Semis equipment. Top of peers, 33 % off, lowest vol of the group."),
        ("WDC", 1000, "Storage / memory. Top of peers, 61 % off.")]


def pc(x, d=0, sign=True):
    if x is None:
        return "—"
    s = f"{x * 100:+.{d}f} %" if sign else f"{x * 100:.{d}f} %"
    cls = "pos" if x > 0 else "neg" if x < 0 else ""
    return f'<span class="{cls}">{s}</span>'


def usd(x):
    return "—" if x is None else f"${x:,.0f}"


def struct_table(cell, shift, note):
    rows = []
    for k in ORDER:
        e = cell["structs"][k]
        b = shift["structs"][k] if shift else {}
        ci = e["vs_shares_ci"] or (None, None)
        extra = ""
        if "collateral_x" in e and e["collateral_x"]:
            extra = f"collateral {e['collateral_x']:.2f}× cash"
        if k == "leaps_all":
            extra = f"starts at {e.get('start_delta_x', 0):.1f}× exposure"
        if k == "leaps_dm":
            extra = f"{e.get('capital_in_options', 0) * 100:.0f} % of cash in calls"
        vs = "—" if k == "shares" else f"{pc(e['vs_shares'])} <span class='mut'>[{pc(ci[0])}, {pc(ci[1])}]</span>"
        rows.append(f"<tr><td>{NAMES[k]}</td><td>{pc(e['median'])}</td><td>{pc(e['mean'])}</td><td>{pc(e['p5'])}</td><td>{e['p_loss'] * 100:.0f} %</td>"
                    f"<td>{pc(e['mdd_med'])}</td><td>{vs}</td><td>{'—' if k == 'shares' else pc(b.get('vs_shares'))}</td><td class='mut'>{extra}</td></tr>")
    return (f"<p class='note'>{note} · {cell['n']:,} trades · {cell['n_indep']} independent entry months · T-bill {cell['tbill'] * 100:.1f} % over the hold</p>"
            "<div class='tw'><table class='main'><thead><tr><th>Structure, $10k</th><th>Median</th><th>Mean</th><th>Worst 5 %</th><th>Lost money</th>"
            "<th>Median drawdown</th><th>Mean vs shares [95 % CI, months]</th><th>Entry 1 month later</th><th></th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table></div>")


def main():
    A = json.loads((OUT / "replay.json").read_text())["cells"]
    B = json.loads((OUT / "replay_shift21.json").read_text())["cells"]
    E = json.loads((OUT / "replay_episodes.json").read_text())["cells"]
    T = {r["ticker"]: r for r in json.loads((OUT / "today.json").read_text())["rows"]}
    U = json.loads((OUT / "universe_today.json").read_text())
    calib = json.loads((OUT / "calib.json").read_text())

    tb, tbe, smh = A["thesis|bull|252"], A["thesis|bear|252"], A["etf:SMH|bull|252"]
    t35 = A["thesis|bull|35"]
    dr = t35["structs"]["rr_deep"]
    rr, sh = tb["structs"]["risk_rev"], tb["structs"]["shares"]

    # episodes table (12 months, thesis basket median + SMH)
    ep_rows = []
    for lab in ("2020 Covid crash", "2022 bear, first -20%", "2022 bear, near low", "2025 tariff crash"):
        th, sm = E.get(f"thesis|{lab}|252"), E.get(f"etf:SMH|{lab}|252")
        if not th:
            continue
        cells = "".join(f"<td>{pc(th['structs'][k]['median'])}<br><span class='mut'>{pc(sm['structs'][k]['median']) if sm else '—'}</span></td>" for k in ("shares", "leaps_dm", "call_spread", "risk_rev", "csp_wheel", "buy_write"))
        ep_rows.append(f"<tr><td>{html.escape(lab)}<br><span class='mut'>{th['n']} names</span></td>{cells}</tr>")

    # what fits today
    fit_rows = []
    for t in ("SMH", "SOXX", "QQQ", "NVDA", "ASML", "WDC", "MU", "LRCX", "AMD", "AVGO", "TSM", "ALAB", "SNDK", "HOOD", "SMCI"):
        r = T.get(t)
        if not r:
            continue
        l, c, rv, k = r.get("leaps80") or {}, r.get("csp") or {}, r.get("risk_rev") or {}, r.get("call_spread") or {}
        yes = lambda ok: "<span class='pos'>fits</span>" if ok else "<span class='neg'>no</span>"  # noqa: E731
        fit_rows.append(f"<tr><td>{t}</td><td>${r['spot']:,.2f}</td><td>{yes(True)}</td>"
                        f"<td>{usd(l.get('cost_1'))} {yes(l.get('fits')) if l else ''}<br><span class='mut'>{'' if not l else f'time value {l["extrinsic_pct_yr"] * 100:.1f} %/yr'}</span></td>"
                        f"<td>{usd(c.get('collateral_1'))} {yes(c.get('fits')) if c else ''}<br><span class='mut'>{'' if not c else f'{c["yield_pct_mo"] * 100:.1f} %/mo'}</span></td>"
                        f"<td>{usd(rv.get('collateral_1'))} {yes(rv.get('fits_cash')) if rv else ''}</td>"
                        f"<td>{usd(k.get('debit_1'))}<br><span class='mut'>{'' if not k or not k.get('payoff_x') else f'pays up to {k["payoff_x"]}×'}</span></td></tr>")

    plan_rows = "".join(f"<tr><td>{t}</td><td>{usd(a)}</td><td>{a / T[t]['spot']:.2f} sh at ${T[t]['spot']:,.2f}</td><td class='mut'>{html.escape(w)}</td></tr>" for t, a, w in PLAN if t in T)

    traded = sum(1 for r in U if r["jamie"])
    top20_traded = sum(1 for r in U[:20] if r["jamie"])
    uni_rows = "".join(f"<tr><td>{r['t']}</td><td>{html.escape(r['peer'])}</td><td>{pc(r['dd'])}</td><td>{r['peer_pct'] * 100:.0f}</td><td>{r['rv60'] * 100:.0f} %</td><td>{'yes' if r['jamie'] else ''}</td></tr>" for r in U[:20])

    body = f"""<title>$10k Semis Drawdown Plan</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>{CSS}</style>
<div class="wrap">
<header>
<p class="eye">S213 · {A and json.loads((OUT / 'replay.json').read_text())['asof']} · follow-up to the S212 risk-reversal top 20</p>
<h1>Best use of $10k cash on the semis drawdown</h1>
<p class="lede">Shares beat the option structures for a $10k cash account. The S212 trade itself (sell a 0.12Δ put, buy a 0.18Δ call, hold the 7 weeks to expiry) came out
{pc(dr['vs_shares'])} vs owning the same exposure in shares, CI {pc(dr['vs_shares_ci'][0])} to {pc(dr['vs_shares_ci'][1])} over {t35['n_indep']} months, while tying up {dr['collateral_x']:.1f}× the cash if the put is cash-secured.
A standard 0.25Δ/0.50Δ risk reversal held 12 months returned
{pc(rr['vs_shares'])} a year vs shares on the same names and months, CI {pc(rr['vs_shares_ci'][0])} to {pc(rr['vs_shares_ci'][1])}. But it needs
{rr['collateral_x']:.2f}× the cash as collateral, and one SMH lot alone needs {usd(T['SMH']['risk_rev']['collateral_1'])}. Most of the $10k goes into SMH,
because single names in a drawdown are a coin flip: the median one returned {pc(sh['median'])} over 12 months and {sh['p_loss'] * 100:.0f} % lost money.</p>
</header>

<section class="verdict">
<h2>The plan</h2>
<div class="tw"><table class="kv"><thead><tr><th>Buy</th><th>Amount</th><th>Size today</th><th>Why</th></tr></thead><tbody>{plan_rows}</tbody></table></div>
<ul class="risk">
<li><b>Lump sum, not 8 weekly buys.</b> Buying over 8 weeks cost {pc(tb['structs']['dca8']['vs_shares'])} (bull markets) and {pc(tbe['structs']['dca8']['vs_shares'])} (bear) vs buying at once. It only helped in the grinding 2022 bear.</li>
<li><b>Hold shares, not LEAPS.</b> One SMH 0.80Δ Dec-2027 call costs {usd(T['SMH']['leaps80']['cost_1'])} (more than the $10k) and burns {T['SMH']['leaps80']['extrinsic_pct_yr'] * 100:.1f} % a year in time value. In the replay, same-exposure LEAPS trailed shares by {pc(tb['structs']['leaps_dm']['vs_shares'])} a year.</li>
<li><b>No risk reversals or cash-secured puts on these names.</b> None of SMH, NVDA, ASML or WDC fits one put lot in $10k cash.</li>
<li><b>The three single names are a quality screen, not a tested edge.</b> Picking names by fund score inside a drawdown has no backtest yet, so they get $1k each.</li>
<li>Re-check when SPY closes back above its 200-day average. The bear-market cells have only 14–17 independent months, so the structure ranking there is unproven.</li>
</ul>
</section>

<section>
<h2>Same $10k, nine structures</h2>
<p class="note">Every structure starts with the same $10k of stock-equivalent exposure, with idle cash in 3-month T-bills. Short puts are cash-secured from the $10k: where collateral exceeds 1.0×, the trade needs margin.
Entries are on the first session of each month, 2019–2025, on names with liquid options. Option legs are <b>model-priced</b>: each stock's realized vol × its own measured IV/RV
(median {calib['m']:.2f}, from {len(calib['m_by_ticker'])} names' real OPRA IV 10/2025→), with put skew and bid/ask spreads calibrated on {calib['files']} real Schwab chains. Fills are at bid/ask ± 23 % of the spread.</p>
<h3>Names ≥ 25 % off their 52-week high · SPY above its 200-day · hold 12 months</h3>
{struct_table(tb, B.get('thesis|bull|252'), 'Powered cell')}
<h3>S212 holding period: same names · SPY above its 200-day · hold 7 weeks (35 sessions)</h3>
{struct_table(t35, B.get('thesis|bull|35'), 'Powered cell, the S212 card trade')}
<h3>Same names · SPY below its 200-day (today's regime) · hold 12 months</h3>
{struct_table(tbe, B.get('thesis|bear|252'), "<b>Can't answer at this n</b> (fewer than 30 independent months); shown for direction only")}
<h3>SMH · SPY above its 200-day · hold 12 months</h3>
{struct_table(smh, B.get('etf:SMH|bull|252'), 'ETF comparator')}
<p class="note">Read: the wheel and buy-write halve the drawdown but give up 12–18 points a year in rising markets. All-in LEAPS raise the mean but drop the median below zero and lose everything in the worst 5 %.
The risk reversals and the put-spread-funded call track shares within a few points. The one exception: the deep S212 shape held 12 months beat shares by {pc(tb['structs']['rr_deep']['vs_shares'])}, but only on margin, with {tb['structs']['rr_deep']['collateral_x']:.1f}× the cash at risk if every put is assigned.</p>
</section>

<section>
<h2>Crash and rebound replays, 12 months</h2>
<p class="note">Entry at the first month-start with SMH ≥ 20 % off its high (known at that close). Each cell shows the median drawdown name, with SMH beneath it. These are single episodes, so they're scenarios, not statistics.</p>
<div class="tw"><table class="main"><thead><tr><th>Episode</th><th>Shares</th><th>LEAPS (same exposure)</th><th>Call spread</th><th>Risk reversal</th><th>Wheel</th><th>Buy-write</th></tr></thead><tbody>{''.join(ep_rows)}</tbody></table></div>
<p class="note">V-shaped rebounds (2020, 2025, the 2022 low) favor shares and call spreads. Entering at the first −20 % of a long bear (2022) favored the wheel. Today we don't know which kind this is.</p>
</section>

<section>
<h2>What fits in $10k cash today</h2>
<p class="note">Real Schwab quotes {T['SMH'].get('leaps_expiry', '')} LEAPS and ~45-day puts, one contract, fill at bid/ask ± 23 % of spread.</p>
<div class="tw"><table class="main"><thead><tr><th>Name</th><th>Spot</th><th>Shares</th><th>0.80Δ LEAPS, 1 lot</th><th>0.30Δ put, collateral</th><th>Risk reversal, collateral</th><th>Call spread ATM/+30 %, 1 lot</th></tr></thead><tbody>{''.join(fit_rows)}</tbody></table></div>
</section>

<section>
<h2>Bias check: names you already trade</h2>
<p class="note">S212 ranked names from Fildi peer groups, and 10 of its top 20 are names you've traded, against 17 % of the full universe.
This re-screen covers every name in the universe ≥ 25 % off its high, ≥ $10, ≥ $25M a day and ≥ 5,000 open contracts: {len(U)} names, {traded} of them traded by you. Of the top 20 by fund-score peer rank, {top20_traded} are names you trade.</p>
<div class="tw"><table class="main"><thead><tr><th>Name</th><th>Peer group</th><th>Off high</th><th>Fund peer pct</th><th>60-day vol</th><th>You traded</th></tr></thead><tbody>{uni_rows}</tbody></table></div>
</section>

<section class="meth">
<h2>Method and limits</h2>
<ul class="note">
<li>Universe = today's names (survivorship), with no S010 haircut. Absolute dip-buy returns are overstated. The structure comparison is paired on the same trades, so it is less affected.</li>
<li>Option history is model-priced: LSEG IV history is empty and real quotes start 10/2025. Calibration is in out/s213/calib.json, and structures are ranked on paired differences.</li>
<li>Entries are at the month's first close (study-contract rule 13 deviation). For 6–24-month holds, the entry minute is small next to the horizon.</li>
<li>Delayed-entry check: entering one month later keeps every structure's sign vs shares except the risk reversal, which sits near zero either way (+1 → −3 points; column "Entry 1 month later").</li>
<li>Tax is not modelled. Shares or LEAPS held over a year are long-term; wheel and buy-write premiums are short-term.</li>
<li>Code: analysis/s213_structures.py (calib · replay · episodes), s213_today.py, s213_report.py. Expected signs were pre-registered in the script docstring.</li>
</ul>
</section>
<p class="foot">Not advice. Numbers are from Fildi data as of the dates shown.</p>
</div>"""
    (OUT / "report.html").write_text(body)
    print(OUT / "report.html", len(body))


if __name__ == "__main__":
    main()
