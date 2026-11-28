"""S212 report: out/rr/s212_ranked.json → out/rr/report.html (shareable; no account data). One page, one section per name (#TICKER)."""
from __future__ import annotations

import html
import json
import math
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "out" / "rr"
D = json.loads((OUT / "s212_ranked.json").read_text())
DD = json.loads((OUT / "s212_dd.json").read_text()) if (OUT / "s212_dd.json").exists() else {"names": {}, "smh": None}
RR = {o["ticker"]: o for o in json.loads((OUT / "s212_rr.json").read_text())["names"]}
S1 = json.loads((OUT / "s212_stage1.json").read_text())
TOP = D["ranked"][:20]
REST = D["ranked"][20:]
E = lambda x: html.escape(str(x))  # noqa: E731


def pct(x, d=0, sign=False):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return "n/a"
    return f"{x * 100:+.{d}f}%" if sign else f"{x * 100:.{d}f}%"


def num(x, d=2):
    return "n/a" if x is None else f"{x:,.{d}f}"


def payoff(S, Kp, Kc, net, p_lo=None, p_hi=None):
    """Inline SVG: P&L per 1-lot (100 sh) at expiry vs underlying price."""
    lo, hi = min(Kp * 0.6, S * 0.5), max(Kc * 1.35, S * 1.6)
    xs = np.linspace(lo, hi, 240)
    pl = (np.maximum(xs - Kc, 0) - np.maximum(Kp - xs, 0) + net) * 100
    W, H, L, R, T, B = 640, 300, 64, 16, 18, 44
    ymin, ymax = float(pl.min()), float(pl.max())
    pad = (ymax - ymin) * 0.08 or 1
    ymin, ymax = ymin - pad, ymax + pad
    X = lambda v: L + (v - lo) / (hi - lo) * (W - L - R)  # noqa: E731
    Y = lambda v: T + (ymax - v) / (ymax - ymin) * (H - T - B)  # noqa: E731
    pts = " ".join(f"{X(a):.1f},{Y(b):.1f}" for a, b in zip(xs, pl))
    gain = " ".join(f"{X(a):.1f},{Y(max(b, 0)):.1f}" for a, b in zip(xs, pl))
    loss = " ".join(f"{X(a):.1f},{Y(min(b, 0)):.1f}" for a, b in zip(xs, pl))
    z = Y(0)
    ticks_x = np.linspace(lo, hi, 7)
    ticks_y = np.linspace(ymin + pad, ymax - pad, 5)
    be_lo = Kp + net if net < 0 else Kp - net   # below Kp loss grows; with a debit the lower breakeven sits above Kp only if net<0 → handled below
    s = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Payoff at expiry" class="pay">']
    for ty in ticks_y:
        s.append(f'<line x1="{L}" x2="{W - R}" y1="{Y(ty):.1f}" y2="{Y(ty):.1f}" class="grid"/>'
                 f'<text x="{L - 6}" y="{Y(ty) + 4:.1f}" text-anchor="end" class="ax">{ty:+,.0f}</text>')
    for tx in ticks_x:
        s.append(f'<text x="{X(tx):.1f}" y="{H - B + 16}" text-anchor="middle" class="ax">{tx:,.0f}</text>')
    s.append(f'<polygon points="{X(lo):.1f},{z:.1f} {gain} {X(hi):.1f},{z:.1f}" class="gain"/>')
    s.append(f'<polygon points="{X(lo):.1f},{z:.1f} {loss} {X(hi):.1f},{z:.1f}" class="loss"/>')
    s.append(f'<line x1="{L}" x2="{W - R}" y1="{z:.1f}" y2="{z:.1f}" class="zero"/>')
    s.append(f'<polyline points="{pts}" class="line"/>')
    for v, lab, cls in ((Kp, f"short put {Kp:g}", "kp"), (S, f"spot {S:,.2f}", "sp"), (Kc, f"long call {Kc:g}", "kc")):
        s.append(f'<line x1="{X(v):.1f}" x2="{X(v):.1f}" y1="{T}" y2="{H - B}" class="{cls}"/>'
                 f'<text x="{X(v) + 4:.1f}" y="{T + 12}" class="lab {cls}t">{E(lab)}</text>')
    s.append(f'<text x="{(L + W - R) / 2:.0f}" y="{H - 6}" text-anchor="middle" class="ax">price at expiry ($)</text>')
    s.append(f'<text x="14" y="{(T + H - B) / 2:.0f}" transform="rotate(-90 14 {(T + H - B) / 2:.0f})" text-anchor="middle" class="ax">P&amp;L per 1 lot ($)</text>')
    s.append("</svg>")
    del be_lo
    return "".join(s)


def leg_row(name, o, px):
    fl = ", ".join(o["flags"]) or "clean"
    return (f"<tr><td>{name}</td><td>{o['strike']:g}</td><td>{num(o['bid'])}</td><td>{num(o['ask'])}</td><td>{num(o['mid'])}</td>"
            f"<td>{num(px)}</td><td>{pct(o['my_iv'], 1)}</td><td>{pct(o['iv'] if (o['iv'] or 0) < 3 else o['iv'] / 100, 1)}</td>"
            f"<td>{pct(o.get('lse_iv'), 1)}</td><td>{o['delta']:+.3f}</td><td>{o['oi']:,}</td><td>{pct(o['spread_pct'])}</td><td>{E(fl)}</td></tr>")


def section(r):
    t, s, i, S = r["ticker"], r["s"], r["info"], r["spot"]
    p, c = s["put"], s["call"]
    Kp, Kc, net, mnet = p["strike"], c["strike"], s["net"], s["mid_net"]
    reg_t = (max(0.20 * S - max(S - Kp, 0), 0.10 * Kp) + s["credit"]) * 100
    be_low = Kp + min(net, 0) * -1 if net < 0 else Kp - net
    be_high = Kc - net if net < 0 else None
    hc, ha = s.get("hist_cond") or {}, s.get("hist_all") or {}
    nind = s.get("hist_n_indep")
    thin = nind is not None and nind < 30
    scen = []
    for m in (-0.40, -0.30, -0.20, -0.10, 0, 0.10, 0.20, 0.30, 0.50):
        ST = S * (1 + m)
        scen.append((m, ST, (max(ST - Kc, 0) - max(Kp - ST, 0) + net) * 100))
    sk = r["skew"]
    skr = "".join(f"<tr><td>{k}Δ</td><td>{pct(a, 1)}</td><td>{pct(b, 1)}</td><td>{'n/a' if not (a and b) else f'{(a - b) * 100:+.1f}'}</td></tr>"
                  for k, (a, b) in sk.items())
    alts = "".join(f"<tr><td>{a['put']['strike']:g} ({a['put']['delta']:+.2f})</td><td>{a['call']['strike']:g} ({a['call']['delta']:+.2f})</td>"
                   f"<td>{a['mid_net']:+.2f}</td><td>{a['net']:+.2f}</td><td>{a['delta_ratio']:.2f}</td></tr>" for a in r["alts"][:5])
    oth = "".join(f"<tr><td>{e}</td><td>{a['put']['strike']:g} ({a['put']['delta']:+.2f})</td><td>{a['call']['strike']:g} ({a['call']['delta']:+.2f})</td>"
                  f"<td>{a['mid_net']:+.2f}</td><td>{a['delta_ratio']:.2f}</td></tr>" for e, a in r["other_exp"].items() if a)
    top = "".join(f"<li>{E(m['key'])} <span class=mut>peer pct {m.get('peerPct')}</span></li>" for m in (i.get("fund_top") or [])[:6])
    risks = []
    if r["er_in"]:
        risks.append(f"Earnings on {i.get('next_er')} fall before expiry: the short put carries the gap.")
    if (i.get("dd52") or 0) < -0.5:
        risks.append(f"Down {pct(-i['dd52'])} from the 52-week high. A name this far down can keep falling.")
    if r["put_iv_rv"] and r["put_iv_rv"] < 1:
        risks.append(f"Put IV is {r['put_iv_rv']:.2f}× 60-day realized vol. You are selling downside for less than the stock has been moving.")
    if (i.get("rsi14") or 50) > 30:
        risks.append(f"RSI {i.get('rsi14'):.0f}: not oversold yet (below 30 is oversold).")
    if thin:
        risks.append(f"History is thin: {nind} independent windows of this name ≥ 20 % off its high since 2018.")
    if (i.get("eps_drift30") or 0) < 0:
        risks.append(f"EPS estimates fell {abs(i['eps_drift30']):.1f} % in 30 days.")
    if (i.get("beta_smh") or 0) > 1.3:
        risks.append(f"Beta {i['beta_smh']:.2f} to SMH: moves bigger than the semis index.")
    return f"""
<section id="{t}" class="name">
  <header class="nh"><h2>{r['rank']}. {E(t)} <span class=mut>{E(i.get('name') or '')} · {E(i.get('peer_name') or '')}</span></h2>
  <p class=trade>Sell <b>{r['expiry']} {Kp:g} put</b> · buy <b>{r['expiry']} {Kc:g} call</b> · net <b>{'credit' if mnet >= 0 else 'debit'} ${abs(mnet):.2f}</b> at mid
  (${abs(net):.2f} {'credit' if net >= 0 else 'debit'} at a realistic fill) · spot ${S:,.2f}</p></header>
  <div class=grid2>
   <div>{payoff(S, Kp, Kc, net)}</div>
   <div><table class=kv>
    <tr><th>Put strike</th><td>{pct(s['put_otm'])} below spot</td></tr>
    <tr><th>Call strike</th><td>{pct(s['call_otm'])} above spot</td></tr>
    <tr><th>Call Δ per put Δ</th><td>{s['delta_ratio']:.2f}× (above 1 means more upside than downside exposure for $0)</td></tr>
    <tr><th>Loss starts below</th><td>${be_low:,.2f}{f' · gain starts above ${be_high:,.2f}' if be_high else ''}</td></tr>
    <tr><th>If assigned</th><td>buy 100 sh at ${Kp:g} = ${Kp * 100:,.0f}</td></tr>
    <tr><th>Margin (Reg-T est.)</th><td>${reg_t:,.0f} per lot</td></tr>
    <tr><th>P(put finishes ITM)</th><td>{pct(s.get('p_put_rn'))} market-implied · {pct(hc.get('p_put_itm'))} own history</td></tr>
    <tr><th>P(call finishes ITM)</th><td>{pct(s.get('p_call_rn'))} market-implied · {pct(hc.get('p_call_itm'))} own history</td></tr>
    <tr><th>Avg P&amp;L, own history</th><td>{pct(hc.get('ev_pct_spot'), 1, True)} of spot (days ≥ 20 % off high, n {nind}{' THIN' if thin else ''}) · {pct(ha.get('ev_pct_spot'), 1, True)} all days</td></tr>
    <tr><th>Bad case (5th pct)</th><td>{pct(hc.get('p5_pct_spot'), 1, True)} of spot</td></tr>
   </table></div>
  </div>
  <h3>Legs (Schwab quotes at the 11-27 close, cross-checked against real trades)</h3>
  <div class=tw><table class=legs><thead><tr><th>Leg</th><th>Strike</th><th>Bid</th><th>Ask</th><th>Mid</th><th>Fill est.</th><th>IV (ours)</th><th>IV (Schwab)</th><th>IV (LSE trades)</th><th>Δ</th><th>OI</th><th>Spread</th><th>Checks</th></tr></thead>
  <tbody>{leg_row('Sell put', p, s['credit'])}{leg_row('Buy call', c, s['debit'])}</tbody></table></div>
  <p class=note>Checks per leg: bid &gt; 0, ask &gt; bid, spread ≤ 30 % of mid, open interest ≥ 100, our IV (solved from mid, r = {D['rf']:.2%}) within
  5 pts of Schwab's, smile shape within 5 pts of the IV at real OPRA trades (London Strategic Edge, last trades 25 Nov, same moneyness, read as leg IV minus ATM IV so a market-wide IV move between the two days does not count), IV within 4 pts of a smile fitted to that expiry's other clean strikes, no price inversion between strikes. Spot ${S:,.2f} vs our stored close: {pct(r.get('spot_check') or 0, 2)} apart.</p>
  <div class=grid3>
   <div><h3>Payoff at expiry, 1 lot</h3><table class=sc><thead><tr><th>Move</th><th>Price</th><th>P&amp;L</th></tr></thead><tbody>
   {''.join(f"<tr><td>{m:+.0%}</td><td>{st:,.2f}</td><td class={'pos' if v >= 0 else 'neg'}>{v:+,.0f}</td></tr>" for m, st, v in scen)}</tbody></table></div>
   <div><h3>Skew, {r['expiry']}</h3><table class=sc><thead><tr><th>|Δ|</th><th>Put IV</th><th>Call IV</th><th>Gap (pts)</th></tr></thead><tbody>{skr}</tbody></table>
   <p class=note>ATM IV {pct(r['atm_iv'], 1)} · 60-day realized {pct(i.get('rv60'), 1)} · 20-day realized {pct(i.get('rv20'), 1)}.
   Put IV ÷ realized {num(r['put_iv_rv'])} · call IV ÷ realized {num(r['call_iv_rv'])}.</p></div>
   <div><h3>Other strikes, same expiry</h3><table class=sc><thead><tr><th>Put (Δ)</th><th>Call (Δ)</th><th>Mid net</th><th>Fill net</th><th>Δ ratio</th></tr></thead><tbody>{alts}</tbody></table>
   <h3>Other expiries</h3><table class=sc><thead><tr><th>Expiry</th><th>Put</th><th>Call</th><th>Mid net</th><th>Δ ratio</th></tr></thead><tbody>{oth}</tbody></table></div>
  </div>
  <div class=grid3>
   <div><h3>Fundamentals</h3><table class=kv>
    <tr><th>Fund score</th><td>{num(i.get('fund_total'), 0)} / 100 · {pct(i.get('fund_peer_pct'))} of peers below it</td></tr>
    <tr><th>Quality · growth · value · safety</th><td>{num(i.get('fund_quality'), 0)} · {num(i.get('fund_growth'), 0)} · {num(i.get('fund_value'), 0)} · {num(i.get('fund_safety'), 0)}</td></tr>
    <tr><th>Forward P/E</th><td>{num(i.get('fwd_pe'), 1)}</td></tr><tr><th>Revenue growth</th><td>{pct(i.get('rev_g'))}</td></tr>
    <tr><th>Operating margin</th><td>{pct(i.get('op_mgn'))}</td></tr><tr><th>FCF yield</th><td>{pct(i.get('fcf_yield'), 1)}</td></tr>
    <tr><th>EPS estimate change, 30 d</th><td>{num(i.get('eps_drift30'), 1)} %</td></tr>
    <tr><th>Street target upside</th><td>{num(i.get('pt_upside'), 0)} % ({i.get('pt_n') or 'n/a'} analysts)</td></tr>
    <tr><th>StarMine alpha rank</th><td>{num(i.get('alpha_rank'), 0)} / 100</td></tr></table>
    <p class=note>Biggest score drivers:</p><ul class=drv>{top}</ul></div>
   <div><h3>Technicals</h3><table class=kv>
    <tr><th>Off 52-week high</th><td>{pct(i.get('dd52'), 0, True)} (high ${num(i.get('hi52'))})</td></tr>
    <tr><th>RSI 14</th><td>{num(i.get('rsi14'), 0)}</td></tr>
    <tr><th>vs 50-day avg</th><td>{pct(i.get('vs_sma50'), 1, True)}</td></tr><tr><th>vs 200-day avg</th><td>{pct(i.get('vs_sma200'), 1, True)}</td></tr>
    <tr><th>Return 5 d · 20 d · 60 d</th><td>{pct(i.get('ret5'), 0, True)} · {pct(i.get('ret20'), 0, True)} · {pct(i.get('ret60'), 0, True)}</td></tr>
    <tr><th>Beta to SMH, 1 y</th><td>{num(i.get('beta_smh'))}</td></tr>
    <tr><th>IV rank, 1 y</th><td>{pct(i.get('iv_rank'))}</td></tr><tr><th>Next earnings</th><td>{E(i.get('next_er') or 'n/a')}</td></tr></table></div>
   <div><h3>Risks</h3><ul class=risk>{''.join(f'<li>{E(x)}</li>' for x in risks) or '<li>No flags beyond the market regime.</li>'}</ul>
   <h3>Score</h3><table class=kv>
    <tr><th>Final</th><td>{r['final']:.2f}</td></tr><tr><th>Stock side</th><td>{r['s1']:.2f}</td></tr><tr><th>Options side</th><td>{r['opt']:.2f}</td></tr>
    {''.join(f"<tr><th>{k}</th><td>{v:.2f}</td></tr>" for k, v in (i.get('s1_parts') or {}).items())}
    {''.join(f"<tr><th>{k}</th><td>{v:.2f}</td></tr>" for k, v in r['opt_parts'].items())}</table></div>
  </div>
  {dd_block(r)}
</section>"""


PEER_LABEL = {"fwd_pe": ("Forward P/E", 1, False), "rev_g": ("Revenue growth", None, True), "op_mgn": ("Operating margin", None, True),
              "fcf_yield": ("FCF yield", None, True), "roic": ("ROIC", None, True)}


def dd_block(r):
    """Deeper due diligence (11-27 #10): earnings reactions vs the put cushion, stress replays, peers, vs SMH."""
    t, d = r["ticker"], DD["names"].get(r["ticker"])
    if not d:
        return ""
    cush = d["cushion"]
    er = "".join(f"<tr><td>{E(x['date'])}</td><td class={'pos' if x['move'] >= 0 else 'neg'}>{x['move']:+.1%}</td>"
                 f"<td>{'through the put' if x['move'] <= -cush else ''}</td></tr>" for x in d["earnings"])
    er_note = (f"Median move {pct(d['er_abs_med'])} either way; worst {pct(d['er_big_down'], 0, True)}. "
               f"{d['er_breach']} of {len(d['earnings'])} reports fell more than the put's {pct(cush)} cushion in one day."
               + (" <b>Earnings land before expiry on this trade.</b>" if r["er_in"] else " Next report is after expiry."))
    st = "".join(f"<tr><td>{E(x['window'])}</td>" + ("<td colspan=3 class=mut>no history (listed later)</td></tr>" if x.get("ret") is None else
                 f"<td class=neg>{x['ret']:+.0%}</td><td>{x['price']:,.2f}</td><td class={'pos' if x['pnl'] >= 0 else 'neg'}>{x['pnl']:+,.0f}</td></tr>")
                 for x in d["stress"])
    pr = []
    for k, (lab, dec, is_pct) in PEER_LABEL.items():
        v = d["peers"].get(k) or {}
        me, med = v.get("me"), v.get("median")
        f = (lambda z: pct(z, 0)) if is_pct else (lambda z: num(z, 1))
        better = None if me is None or med is None else ((me < med) if k == "fwd_pe" else (me > med))
        pr.append(f"<tr><th>{lab}</th><td>{f(me) if me is not None else 'n/a'}</td><td>{f(med) if med is not None else 'n/a'}</td>"
                  f"<td>{'' if better is None else ('better' if better else 'worse')}</td></tr>")
    sm = DD.get("smh")
    vs = ""
    if sm:
        s = r["s"]
        vs = (f"<p class=note><b>Vs the same trade on SMH:</b> Δ ratio {s['delta_ratio']:.2f} vs {sm['delta_ratio']:.2f} · skew "
              f"{(r['skew15'] or 0) * 100:.1f} vs {(sm['skew15'] or 0) * 100:.1f} pts · put cushion {pct(s['put_otm'])} vs {pct(sm['put_otm'])}. "
              + ("This name buys more upside per unit of downside than SMH." if s["delta_ratio"] > sm["delta_ratio"] + 0.05 else
                 "SMH gives about the same or better ratio without single-company risk; this name needs a company-specific reason.")
              + "</p>")
    return f"""<div class=grid3>
   <div><h3>Earnings reactions, last {len(d['earnings'])}</h3><table class=sc><thead><tr><th>Report</th><th>1-day move</th><th></th></tr></thead><tbody>{er}</tbody></table>
   <p class=note>{er_note} Move = the larger of the report day and the next session (the calendar does not say before or after the open).</p></div>
   <div><h3>Stress replay: this trade in past crashes</h3><table class=sc><thead><tr><th>Window</th><th>Worst {d['h']}-session drop</th><th>Price</th><th>P&amp;L / lot</th></tr></thead><tbody>{st}</tbody></table>
   <p class=note>The stock's own worst {d['h']}-session fall inside each window, applied to today's ${r['spot']:,.2f}, valued at expiry. Real paths can be worse before expiry (marks, margin calls).</p></div>
   <div><h3>Against its peers ({E((r['info'].get('peer_name') or '')[:30])}, n {d['peer_n']})</h3><table class=sc><thead><tr><th></th><th>{E(t)}</th><th>Peer median</th><th></th></tr></thead><tbody>{''.join(pr)}</tbody></table>
   {vs}</div>
  </div>"""


def excl_reasons():
    """Why each excluded name is out, read from its raw January chain (same thresholds as the screen)."""
    out = {"no 0.10–0.16Δ January put listed": [], "open interest under 100 at those strikes": [],
           "after-close quotes too wide and not confirmed by trades": [], "no call the put's premium pays for (or call leg failed)": [],
           "other": []}
    exp = D["ranked"][0]["expiry"]
    for t, why_ in D["excluded"]:
        f = OUT / "chains" / f"{t}.json"
        if not why_.startswith("no liquid") or not f.exists():
            out["other"].append(t)
            continue
        legs = [o for o in json.loads(f.read_text())["rows"] if str(o["expiry"]).startswith(exp)]
        P = [o for o in legs if o["side"] == "put" and o.get("delta") is not None and 0.10 <= abs(o["delta"]) <= 0.16]
        if not P:
            out["no 0.10–0.16Δ January put listed"].append(t)
        elif max((o.get("oi") or 0) for o in P) < 100:
            out["open interest under 100 at those strikes"].append(t)
        elif all(((o["ask"] - o["bid"]) / ((o["ask"] + o["bid"]) / 2) if o.get("bid") and o.get("ask") else 9) > 0.35 for o in P if (o.get("oi") or 0) >= 100):
            out["after-close quotes too wide and not confirmed by trades"].append(t)
        else:
            out["no call the put's premium pays for (or call leg failed)"].append(t)
    return {k: v for k, v in out.items() if v}


def main():
    rows = "".join(
        f"<tr><td>{r['rank']}</td><td><a href='#{r['ticker']}'>{E(r['ticker'])}</a></td><td>{E((r['info'].get('peer_name') or '')[:26])}</td>"
        f"<td>{r['spot']:,.2f}</td><td>{r['s']['put']['strike']:g} <span class=mut>({pct(r['s']['put_otm'])})</span></td>"
        f"<td>{r['s']['call']['strike']:g} <span class=mut>(+{pct(r['s']['call_otm'])})</span></td><td>{r['s']['mid_net']:+.2f}</td>"
        f"<td>{r['s']['delta_ratio']:.2f}</td><td>{'n/a' if r['skew15'] is None or r['skew15'] == 0 else f'{r[chr(115) + chr(107) + chr(101) + chr(119) + chr(49) + chr(53)] * 100:.1f}'}</td>"
        f"<td>{pct(r['info'].get('dd52'), 0, True)}</td><td>{num(r['info'].get('rsi14'), 0)}</td><td>{num(r['info'].get('fund_total'), 0)}</td>"
        f"<td>{num(r['info'].get('eps_drift30'), 1)}</td><td>{'⚠ ' + E(r['next_er']) if r['er_in'] else E(r['next_er'] or '')}</td><td>{r['final']:.2f}</td></tr>"
        for r in TOP)
    rest = "".join(f"<tr><td>{r['rank']}</td><td>{E(r['ticker'])}</td><td>{r['final']:.2f}</td><td>{E(why(r))}</td></tr>" for r in REST)
    etf = "".join(f"<tr><td>{E(r['ticker'])}</td><td>{r['spot']:,.2f}</td><td>{r['s']['put']['strike']:g} ({pct(r['s']['put_otm'])})</td>"
                  f"<td>{r['s']['call']['strike']:g} (+{pct(r['s']['call_otm'])})</td><td>{r['s']['mid_net']:+.2f}</td><td>{r['s']['delta_ratio']:.2f}</td>"
                  f"<td>{'n/a' if not r['skew15'] else f'{r[chr(115) + chr(107) + chr(101) + chr(119) + chr(49) + chr(53)] * 100:.1f}'}</td>"
                  f"<td>{pct(D['etf_state'].get(r['ticker'], {}).get('dd52'), 0, True)}</td></tr>" for r in D["etfs"])
    excl = len(D["excluded"])
    fin_all = [r for r in S1["rows"] if "financ" in (r.get("peer") or "").lower()]
    fin_gated = [r["ticker"] for r in fin_all if any("peer median" in g for g in (r.get("gate") or []))]
    sm = DD.get("smh") or {}
    n_lse = sum(1 for r in TOP for k in ("put", "call") if r["s"][k].get("verified_by") == "lse")
    piv = np.median([r["put_iv_rv"] for r in TOP if r["put_iv_rv"]])
    civ = np.median([r["call_iv_rv"] for r in TOP if r["call_iv_rv"]])
    sk = np.median([r["skew15"] for r in TOP if r["skew15"]])
    dr = np.median([r["s"]["delta_ratio"] for r in TOP])
    up = sum((r["info"].get("eps_drift30") or 0) > 0 for r in TOP)
    over = sum((r["info"].get("rsi14") or 99) < 30 for r in TOP)
    css = (OUT.parent.parent / "analysis" / "s212_report.css").read_text()
    page = f"""<title>Semis Risk Reversals</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;600&family=Fraunces:opsz,wght@9..144,600&display=swap">
<style>{css}</style>
<main class=wrap>
<header class=hero><p class=eye>Risk reversal screen · quotes at the 27 Nov 2026 close · expiry 15 Jan 2027 (49 days)</p>
<h1>Selling the semis fear to pay for the rebound</h1>
<p class=lede>Sell a deep out-of-the-money put, use the premium to buy a deep out-of-the-money call, same expiry, about zero cost. You get paid if the stock
rebounds past the call and lose if it falls through the put. 305 tech, semiconductor and financial names were screened; {excl} failed on liquidity or quote quality; 20 are below.</p></header>

<section class=verdict><h2>What the data says about the thesis</h2>
<table class=kv><tbody>
<tr><th>Fundamentals still good</th><td><b>Yes.</b> All 20 have a fund score above their peer-group median ({sum((r['info'].get('fund_peer_pct') or 0) >= 0.8 for r in TOP)} are in their peer group's top 20 %). EPS estimates rose over 30 days for {up} of 20.</td></tr>
<tr><th>Technicals oversold</th><td><b>Not yet.</b> Prices sit {-max(r['info']['dd52'] for r in TOP)*100:.0f}–{-min(r['info']['dd52'] for r in TOP)*100:.0f} % below their 52-week highs, but RSI is {min(r['info']['rsi14'] for r in TOP):.0f}–{max(r['info']['rsi14'] for r in TOP):.0f} and {over} of 20 are below 30. The selling has not washed out.</td></tr>
<tr><th>Puts rich, calls cheap</th><td><b>Calls cheap: yes. Puts rich: only next to the calls.</b> At equal delta the put carries {sk * 100:.0f} vol points more than the call (median), so $0 buys a call with {dr:.2f}× the put's delta.
But put IV is {piv:.2f}× 60-day realized vol and 20-day realized is running 1.4× the 60-day: puts are not overpriced against how much these stocks are moving. Calls are cheap ({civ:.2f}× realized).</td></tr>
<tr><th>Market regime</th><td><b>Stress, not yet a bottom signal.</b> VIX 26.8 is above 3-month VIX 26.3 (inverted curve). High-yield spreads widened 3.14 → 3.77 % in 30 days. SMH is −34 % from its June high and has swung ±10–15 % in single days (20 → 23 Nov).
In our tests, panic risk reversals lost money in the early weeks of a panic (S178: the 4 losers of 15). The better-timed entry comes when VIX drops back below VIX3M (S172).</td></tr>
<tr><th>Past semis drawdowns of 30 %</th><td>2011, 2020, 2025: SOXX/SMH were up 15–48 % 63 trading days later. 2022: −13 % within 63 days and −13 % after six months. Four episodes: a guide, not proof. 2022 is the case the short puts must survive.</td></tr>
<tr><th>Single names vs SMH</th><td><b>SMH wins on option pricing.</b> The same $0 trade on SMH buys {num(sm.get('delta_ratio'))}× call delta per put delta; {sum(r['s']['delta_ratio'] > (sm.get('delta_ratio') or 9) + 0.05 for r in TOP)} of the 20 names beat that. Pick a single name only for a company-specific reason (fundamentals, estimate revisions, a catalyst), and size it smaller than an SMH position.</td></tr>
<tr><th>Is there a free lunch?</th><td><b>No.</b> At market prices the expected value is the fill cost (a few cents to $2 per share). The edge has to come from your view that these names recover, not from the options. The skew lets you express that view with more upside delta than downside delta.</td></tr>
</tbody></table></section>

<section><h2>Top 20</h2><p class=note>Net is per share at mid (×100 per lot); negative = small debit. Δ ratio = call delta ÷ put delta. Skew = put IV − call IV at 0.15Δ, in vol points. ⚠ = earnings before expiry.</p>
<div class=tw><table class=main><thead><tr><th>#</th><th>Ticker</th><th>Group</th><th>Spot</th><th>Sell put</th><th>Buy call</th><th>Net</th><th>Δ ratio</th><th>Skew</th><th>Off high</th><th>RSI</th><th>Fund</th><th>EPS rev 30d %</th><th>Earnings</th><th>Score</th></tr></thead>
<tbody>{rows}</tbody></table></div></section>

<section class=grid2><div><h2>Benchmarks: the same trade on ETFs</h2><div class=tw><table class=sc><thead><tr><th>ETF</th><th>Spot</th><th>Put</th><th>Call</th><th>Net</th><th>Δ ratio</th><th>Skew</th><th>Off high</th></tr></thead><tbody>{etf}</tbody></table></div>
<p class=note>SMH gives a {num(sm.get('delta_ratio'))}× delta ratio with {(sm.get('skew15') or 0) * 100:.0f} pts of skew; the median top-20 name gives {dr:.2f}× with {sk * 100:.0f} pts, and {sum(r['s']['delta_ratio'] > (sm.get('delta_ratio') or 9) + 0.05 for r in TOP)} of 20 beat SMH's ratio. A single name has to beat SMH on conviction as well as on option pricing.</p></div>
<div><h2>Ranked 21+ (close but out)</h2><div class=tw><table class=sc><thead><tr><th>#</th><th>Ticker</th><th>Score</th><th>Why lower</th></tr></thead><tbody>{rest}</tbody></table></div>
<p class=note>{excl} more names had no tradeable 0.10–0.16Δ January put with a liquid call. Why, by count:</p>
<ul class=meth>{''.join(f"<li><b>{len(v)}</b> {E(k)}: {E(', '.join(v[:14]))}{' …' if len(v) > 14 else ''}</li>" for k, v in excl_reasons().items())}</ul>
<p class=note>Financials: {len(fin_gated)} of {len(fin_all)} names in our financial peer groups were cut before the options step because their fund score is below their peer median ({E(', '.join(fin_gated[:10]))} …). That is a fundamentals call, not a data gap.</p></div></section>

<section><h2>How this was built</h2><ul class=meth>
<li><b>Universe:</b> 305 names in our technology, semiconductor, fintech and financial peer groups. Gates: fund score at or above the peer-group median, price ≥ $15, at least 10 % below the 52-week high.</li>
<li><b>Stock score (50 %):</b> fund score vs peers 35 %, 30-day EPS estimate change 15 %, drawdown + RSI 20 %, IV rank + IV÷RV 15 %, StarMine alpha 15 %.</li>
<li><b>Options score (50 %):</b> skew at 0.15Δ, delta ratio at zero cost, call IV ÷ realized (cheaper is better), the structure's average P&amp;L over this name's own history on days it sat ≥ 20 % below its high, and fill cost. Earnings before expiry −0.10.</li>
<li><b>Structure:</b> expiry 15 Jan 2027, before most late-January earnings. Short put |Δ| 0.10–0.16. Long call = the highest delta the put's mid pays for (net ≥ −0.3 % of spot). Fill estimate = sell at bid + 23 % of the spread, buy at ask − 23 %.</li>
<li><b>Data:</b> Schwab option chains pulled after the 27 Nov half-day close (last bid/ask). After-hours spreads run wider than in-session, so legs pair on mid. Every leg is cross-checked against real OPRA trades (London Strategic Edge, last trades 25 Nov): a leg whose after-close spread was too wide passes only if its mid sits on the traded smile, and its fill is then estimated at a 30 % in-session spread ({n_lse} of the 40 legs below). Prices checked against Polygon; LSEG history (2018→) for stress replays agrees with our price table within 2 % on every overlapping day. Weights and rules were written down before the ranked list was seen. Verify quotes live at Monday's open before trading.</li>
<li><b>Not advice.</b> A short put can lose many times the premium; you may be assigned 100 shares per lot at the put strike.</li></ul></section>
{''.join(section(r) for r in TOP)}
<footer class=foot>Fildi research S212 · built 27 Nov 2026 · tables from Schwab, LSEG, Polygon, our fund scores.</footer>
</main>"""
    (OUT / "report.html").write_text(page)
    print("wrote", OUT / "report.html", len(page) // 1024, "KB")


def why(r):
    parts = []
    if r["er_in"]:
        parts.append(f"earnings {r['next_er']} before expiry")
    o = r["opt_parts"]
    weak = [k for k, v in o.items() if v < 0.3]
    if weak:
        parts.append("weak " + ", ".join(weak))
    if (r["s1"] or 0) < 0.55:
        parts.append("weaker stock score")
    return "; ".join(parts) or "lower combined score"


if __name__ == "__main__":
    main()
