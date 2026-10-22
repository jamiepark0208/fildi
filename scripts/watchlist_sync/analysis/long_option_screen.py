# Long call/put candidates 10-22: ATM option at today's IV (+5 % fill) vs payoff over the stock's own 30-session moves since 2021.
import subprocess, csv, io, statistics as st
from math import log, sqrt, exp, erf
from collections import defaultdict
N = lambda x: 0.5 * (1 + erf(x / sqrt(2)))
def bs(S, v, T, call):
    d1 = v * sqrt(T) / 2; d2 = -d1
    return S * (N(d1) - N(d2)) if call else S * (N(-d2) - N(-d1))
q = "copy (select ticker,date,close,iv30_call,iv30_put from lseg_research.daily_history where date>='2021-01-01' and close>0 order by ticker,date) to stdout csv"
out = subprocess.run(["psql", "-d", "tradedash", "-Atc", q], capture_output=True, text=True).stdout
data = defaultdict(list)
for t, d, c, ivc, ivp in csv.reader(io.StringIO(out)):
    data[t].append((d, float(c), float(ivc) if ivc else None, float(ivp) if ivp else None))
H, FILL, T = 30, 1.05, 30 / 252
R = []
for t, g in data.items():
    if len(g) < 500 or g[-1][0] < "2026-10-20": continue
    d, S, ivc, ivp = g[-1]
    if not ivc or not ivp: continue
    ivc, ivp = ivc / 100, ivp / 100
    cl = [x[1] for x in g]
    mv = [log(cl[i + H] / cl[i]) for i in range(len(cl) - H)]
    mu = st.mean(mv) / 2                                   # keep half the drift: don't bank the whole bull tape
    ST = [S * exp(m - mu) for m in mv]
    cp, pp = bs(S, ivc, T, True) * FILL, bs(S, ivp, T, False) * FILL
    cpay = [max(x - S, 0) for x in ST]; ppay = [max(S - x, 0) for x in ST]
    rets = [log(cl[i] / cl[i - 1]) for i in range(len(cl) - 20, len(cl))]
    rv20 = st.pstdev(rets) * sqrt(252)
    ret20 = S / cl[-21] - 1; dd = S / max(cl[-252:]) - 1
    # same-stock analogs: past days with a 20-d return within ±5 pp of today's → what happened next 30 sessions
    an = [log(cl[i + H] / cl[i]) for i in range(20, len(cl) - H) if abs(cl[i] / cl[i - 20] - 1 - ret20) < 0.05]
    half = len(ST) // 2
    def ev(xs, call, px, trim=False):
        pay = sorted(max(x - S, 0) if call else max(S - x, 0) for x in xs)
        if trim: pay = pay[: int(len(pay) * 0.95)]          # drop the top 5 % of outcomes: is the edge only the lottery tail?
        return st.mean(pay) / px - 1
    rob = dict(c1=ev(ST[:half], True, cp), c2=ev(ST[half:], True, cp), ct=ev(ST, True, cp, True),
               p1=ev(ST[:half], False, pp), p2=ev(ST[half:], False, pp), pt=ev(ST, False, pp, True))
    R.append(dict(**rob, t=t, S=S, ivc=ivc, ivp=ivp, rv=rv20, dd=dd, r20=ret20, cev=st.mean(cpay) / cp - 1, cwin=sum(p > cp for p in cpay) / len(cpay),
                  pev=st.mean(ppay) / pp - 1, pwin=sum(p > pp for p in ppay) / len(ppay), an=len(an),
                  up=sum(a > 0 for a in an) / len(an) if an else float("nan"), med=st.median(an) if an else float("nan")))
p = lambda x: f"{100 * x:5.0f}"
hdr = "tick    spot  IV   RV20 dd52 ret20 | EV%  win% | 21-23 24-26 trim | analogs n  up%  med%"
def show(rows, side):
    print(hdr)
    for r in rows:
        iv, ev, w, a, b, c = (r["ivc"], r["cev"], r["cwin"], r["c1"], r["c2"], r["ct"]) if side == "c" else (r["ivp"], r["pev"], r["pwin"], r["p1"], r["p2"], r["pt"])
        print(f"{r['t']:6} {r['S']:7.2f}{p(iv)}{p(r['rv'])}{p(r['dd'])}{p(r['r20'])} |{p(ev)}{p(w)} |{p(a)} {p(b)}{p(c)} | {r['an']:8}{p(r['up'])}{p(r['med'])}")
print(len(R), "names. EV = avg payoff over own history ÷ cost − 1 (drift halved); win = share of histories beating the cost")
robust = lambda r, k: min(r[k + "1"], r[k + "2"], r[k + "t"])   # conviction = worst of (each era, tail-trimmed)
print("\nLONG CALLS — ranked by worst-case EV (both eras + tail-trimmed must be positive)"); show(sorted(R, key=lambda r: -robust(r, "c"))[:12], "c")
print("\nLONG PUTS — same ranking"); show(sorted(R, key=lambda r: -robust(r, "p"))[:8], "p")
print("\nRKLB / CRWV (calls)"); show([r for r in R if r["t"] in ("RKLB", "CRWV")], "c")
print("median call EV", p(st.median(r["cev"] for r in R)), " median put EV", p(st.median(r["pev"] for r in R)))

