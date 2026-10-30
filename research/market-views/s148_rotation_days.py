"""S148 (10-29): what follows a day like 2026-10-29 — cap-weighted S&P down while equal-weight up (megacap earnings selloff,
broad rotation)? And Nov–Dec seasonality after a strong year. Yahoo daily closes (chart API, no key). Reproducible: run it.
    python3 research/market-views/s148_rotation_days.py > research/market-views/out/s148.md
"""
import json, urllib.request, statistics as st
from datetime import datetime, timezone

def closes(sym, start="1990-01-01"):
    p1 = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp())
    u = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2=9999999999&interval=1d"
    r = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))["chart"]["result"][0]
    out = {}
    for ts, c in zip(r["timestamp"], r["indicators"]["adjclose"][0]["adjclose"]):
        if c: out[datetime.fromtimestamp(ts, timezone.utc).date()] = c
    return out

spx, rsp, qqq = closes("^GSPC", "1950-01-01"), closes("RSP", "2003-05-01"), closes("QQQ", "1999-03-10")
days = sorted(set(spx) & set(rsp))
def fwd(series, d_list, i, h):
    return series[d_list[i + h]] / series[d_list[i]] - 1 if i + h < len(d_list) else None
def maxdd(series, d_list, i, h):
    p0, lo = series[d_list[i]], 1e18
    for k in range(1, min(h, len(d_list) - 1 - i) + 1):
        lo = min(lo, series[d_list[k + i]])
    return lo / p0 - 1

def table(name, idx, dl, series, H=(10, 21, 42, 63)):
    print(f"\n### {name} — n = {len(idx)} days" + (f" (episodes ≥ 10 sessions apart: {episodes(idx)})" if idx else ""))
    print("| horizon | median | mean | % up | P(max DD ≥ 5 %) | base median | base % up | base P(DD ≥ 5 %) |\n|---|---|---|---|---|---|---|---|")
    for h in H:
        r = [x for x in (fwd(series, dl, i, h) for i in idx) if x is not None]
        dd = [x for x in (maxdd(series, dl, i, h) for i in idx if i + h < len(dl)) ]
        b = [fwd(series, dl, i, h) for i in range(len(dl) - h)]
        bd = [maxdd(series, dl, i, h) for i in range(0, len(dl) - h, 3)]
        if not r: continue
        print(f"| {h}d | {100*st.median(r):+.1f} % | {100*st.mean(r):+.1f} % | {100*sum(x>0 for x in r)/len(r):.0f} % | "
              f"{100*sum(x<=-.05 for x in dd)/max(len(dd),1):.0f} % | {100*st.median(b):+.1f} % | {100*sum(x>0 for x in b)/len(b):.0f} % | "
              f"{100*sum(x<=-.05 for x in bd)/len(bd):.0f} % |")

def episodes(idx):
    n, last = 0, -99
    for i in idx:
        if i - last >= 10: n += 1
        last = i
    return n

print("# S148 — rotation days and year-end seasonality (data: Yahoo ^GSPC, RSP, QQQ adj. closes; as of", max(days), ")")
r1 = lambda s, d0, d1: s[d1] / s[d0] - 1
idx = [i for i in range(1, len(days)) if r1(spx, days[i-1], days[i]) <= -0.002 and r1(rsp, days[i-1], days[i]) >= 0.008]
print("\nDay rule A: S&P 500 ≤ −0.2 % AND equal-weight RSP ≥ +0.8 % (10-29-2026: −0.30 % / +1.20 %). Dates (last 15):",
      ", ".join(str(days[i]) for i in idx[-15:]))
table("Rule A → S&P 500 forward", idx, days, spx)
table("Rule A → RSP forward", idx, days, rsp)
dq = sorted(set(qqq) & set(rsp))
idq = [i for i in range(1, len(dq)) if r1(qqq, dq[i-1], dq[i]) <= -0.01 and r1(rsp, dq[i-1], dq[i]) >= 0.005]
print("\nDay rule B: QQQ ≤ −1 % AND RSP ≥ +0.5 % (10-29: −1.42 % / +1.20 %). Dates (last 15):", ", ".join(str(dq[i]) for i in idq[-15:]))
table("Rule B → QQQ forward", idq, dq, qqq)
table("Rule B → RSP forward", idq, dq, rsp)

# Seasonality: Oct 29 → Dec 31, S&P 500, by year
sd = sorted(spx)
def near(d):  # last trading day ≤ d
    return max(x for x in sd if x <= d)
from datetime import date
rows = []
for y in range(1951, 2026):
    a, e, j = near(date(y, 10, 29)), near(date(y, 12, 31)), near(date(y - 1, 12, 31))
    ia, ie = sd.index(a), sd.index(e)
    dd = min(spx[sd[k]] for k in range(ia, ie + 1)) / spx[a] - 1
    rows.append((y, spx[a] / spx[j] - 1, spx[e] / spx[a] - 1, dd))
def summ(lbl, rs):
    if not rs: return
    print(f"| {lbl} | {len(rs)} | {100*st.median([r[2] for r in rs]):+.1f} % | {100*sum(r[2]>0 for r in rs)/len(rs):.0f} % | "
          f"{100*sum(r[3]<=-.05 for r in rs)/len(rs):.0f} % | {100*min(r[2] for r in rs):+.1f} % ({min(rs,key=lambda r:r[2])[0]}) |")
print("\n### S&P 500, Oct 29 → Dec 31 (1951–2025)\n| years | n | median | % up | P(dip ≥ 5 % inside window) | worst |\n|---|---|---|---|---|---|")
summ("all", rows)
summ("YTD to Oct 29 ≥ +15 %", [r for r in rows if r[1] >= .15])
summ("midterm years (y % 4 == 2)", [r for r in rows if r[0] % 4 == 2])
summ("YTD ≥ +15 % and 1990→", [r for r in rows if r[1] >= .15 and r[0] >= 1990])
ytd = spx[max(sd)] / spx[near(date(2026 - 1, 12, 31))] - 1
print(f"\n2026 YTD to {max(sd)}: {100*ytd:+.1f} %. Years with YTD ≥ +15 % at Oct 29:",
      ", ".join(f"{r[0]} ({100*r[1]:+.0f} % → {100*r[2]:+.1f} %)" for r in rows if r[1] >= .15))
