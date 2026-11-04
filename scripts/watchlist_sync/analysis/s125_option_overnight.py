"""S125 / A188 #1 — puts rich overnight / cheap intraday (Muravyev & Ni 2020).

Pre-registered (asks/A276 Claude plan 2026-10-26):
  Data: optlab.bars daily option o/c on ~1σ puts, 7–45 DTE (S059-style band), drop zero-volume.
  Split put-seller return into intraday (open→close) and overnight (prior close→open),
  delta-hedged with the underlying's same-window return (BS put Δ from spot/IV/strike/DTE).
  Works = overnight − intraday seller return > 0, stock-day clustered t ≥ 2, same sign 2024 and 2025→.
  Also report: sell-at-close vs sell-at-open premium retention (close entry keeps more?);
  % bars with v=0 dropped. Bid+23% haircut unavailable on daily bars → flagged.

Smoke: 5 names × ≥5 days hand-checked first (--smoke).

    cd scripts/watchlist_sync && nice -n 15 .venv/bin/python analysis/s125_option_overnight.py [--smoke] [--backfill N]
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S125.md"
PACKET = HERE.parent / "out" / "opt" / "A276-S125-packet.md"
SIG_LO, SIG_HI = 0.7, 1.3  # ~1σ band
DTE_LO, DTE_HI = 7, 45
BACKFILL_DEFAULT = 80


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def put_delta(S: float, K: float, iv: float, dte: int) -> float:
    """Black–Scholes put delta (no rates). iv in percent."""
    if S <= 0 or K <= 0 or iv <= 0 or dte <= 0:
        return -0.16
    sig = iv / 100.0
    T = dte / 252.0
    d1 = (math.log(S / K) + 0.5 * sig * sig * T) / (sig * math.sqrt(T))
    return norm_cdf(d1) - 1.0  # put Δ


def candidates(conn, limit_occ: int = 200) -> list[str]:
    """OCCs that hit the ~1σ put band on ≥ 5 volume days."""
    rows = conn.execute(
        """
        WITH px AS (
          SELECT ticker, date, close::float AS spot, iv30_put::float AS iv
          FROM lseg_research.daily_history
          WHERE date >= '2024-10-01' AND iv30_put > 0 AND close > 0
        ),
        hit AS (
          SELECT k.occ,
                 ABS(LN(k.strike / px.spot) / NULLIF(px.iv/100 * SQRT(GREATEST((k.expiry-b.date)::int,1)/252.0),0)) AS sig
          FROM optlab.bars b
          JOIN optlab.contracts k ON k.occ = b.occ AND k.type = 'put'
          JOIN px ON px.ticker = k.underlying AND px.date = b.date
          WHERE (k.expiry - b.date) BETWEEN %s AND %s AND b.v > 0 AND b.c > 0 AND k.strike < px.spot
        )
        SELECT occ, COUNT(*) AS n
        FROM hit
        WHERE sig BETWEEN %s AND %s
        GROUP BY occ
        HAVING COUNT(*) >= 5
        ORDER BY n DESC
        LIMIT %s
        """,
        (DTE_LO, DTE_HI, SIG_LO, SIG_HI, limit_occ),
    ).fetchall()
    return [r[0] for r in rows]


def backfill_opens(conn, occs: list[str], cap: int) -> int:
    """Re-pull Polygon daily aggs to fill bars.o (1 call / OCC)."""
    import option_history as OH

    conn.execute("ALTER TABLE optlab.bars ADD COLUMN IF NOT EXISTS o real")
    conn.commit()
    need = []
    for occ in occs:
        n_null = conn.execute(
            "SELECT COUNT(*) FROM optlab.bars WHERE occ = %s AND o IS NULL AND v > 0", (occ,)
        ).fetchone()[0]
        if n_null > 0:
            need.append(occ)
        if len(need) >= cap:
            break
    print(f"backfill opens: {len(need)} OCCs (cap {cap})", flush=True)
    filled = 0
    for i, occ in enumerate(need):
        exp = conn.execute("SELECT expiry FROM optlab.contracts WHERE occ = %s", (occ,)).fetchone()
        if not exp:
            continue
        # force re-fetch: clear fetched marker so fetch_bars runs
        conn.execute("DELETE FROM optlab.bars_fetched WHERE occ = %s", (occ,))
        conn.commit()
        try:
            OH.fetch_bars(conn, occ, exp[0])
            filled += 1
        except Exception as e:
            print(f"  skip {occ}: {e}", flush=True)
            conn.rollback()
        if (i + 1) % 10 == 0:
            print(f"  …{i+1}/{len(need)}", flush=True)
    OH.flush_usage(conn)
    return filled


def load_pairs(conn) -> list[dict]:
    """Consecutive volume days with o,c on ~1σ puts + underlying o/c."""
    rows = conn.execute(
        """
        WITH px AS (
          SELECT ticker, date, open::float AS so, close::float AS sc, iv30_put::float AS iv
          FROM lseg_research.daily_history
          WHERE date >= '2024-10-01' AND iv30_put > 0 AND close > 0 AND open > 0
        ),
        day AS (
          SELECT k.underlying AS t, k.occ, k.strike, k.expiry, b.date,
                 b.o::float AS oo, b.c::float AS oc, b.v::float AS vol,
                 px.so, px.sc, px.iv,
                 (k.expiry - b.date)::int AS dte,
                 ABS(LN(k.strike / px.sc) / NULLIF(px.iv/100 * SQRT(GREATEST((k.expiry-b.date)::int,1)/252.0),0)) AS sig
          FROM optlab.bars b
          JOIN optlab.contracts k ON k.occ = b.occ AND k.type = 'put'
          JOIN px ON px.ticker = k.underlying AND px.date = b.date
          WHERE (k.expiry - b.date) BETWEEN %s AND %s
            AND b.v > 0 AND b.o > 0 AND b.c > 0 AND k.strike < px.sc
            AND ABS(LN(k.strike / px.sc) / NULLIF(px.iv/100 * SQRT(GREATEST((k.expiry-b.date)::int,1)/252.0),0))
                BETWEEN %s AND %s
        )
        SELECT * FROM day ORDER BY occ, date
        """,
        (DTE_LO, DTE_HI, SIG_LO, SIG_HI),
    ).fetchall()
    # group by occ → consecutive pairs
    by = defaultdict(list)
    cols = ["t", "occ", "strike", "expiry", "date", "oo", "oc", "vol", "so", "sc", "iv", "dte", "sig"]
    for r in rows:
        by[r[1]].append(dict(zip(cols, r)))
    # Consecutive TRADING days only (Claude 11-03): the per-day σ/volume filter drops days, so ≤ 5 calendar days let
    # 06-18 → 06-23 pair across the whole 06-22 session (LRCX) and count it as "overnight".
    tds = sorted({r[0] for r in conn.execute(
        "SELECT DISTINCT date FROM lseg_research.daily_history WHERE ticker = 'SPY' AND date >= '2024-10-01'").fetchall()})
    nxt = {d: tds[i + 1] for i, d in enumerate(tds[:-1])}
    out = []
    for occ, xs in by.items():
        xs.sort(key=lambda x: x["date"])
        for i in range(1, len(xs)):
            a, b = xs[i - 1], xs[i]
            if nxt.get(a["date"]) != b["date"]:  # next trading day only
                continue
            # overnight: prior close → today open; intraday: today open → close
            # short put Δ-hedged seller pnl (per $ of option prior close)
            dlt = put_delta(b["so"], b["strike"], b["iv"], b["dte"])  # ≈ put Δ at open
            # seller overnight: -(open - prev_close)/prev_close  + hedge on stock overnight
            # long-put DH: (oo-ac)/ac - dlt*(so - a.sc)/a.sc ; seller = negative of that
            if a["oc"] <= 0 or a["sc"] <= 0:
                continue
            # Hedge in $ (Claude 11-03): Δ × stock $ move, then ÷ option price. Δ × stock % return under-hedged ~S/P times
            # (LRCX 270P: 0.9 % hedge vs ~100 %) → the first run measured gap direction, not the overnight premium.
            seller_on = -((b["oo"] - a["oc"]) - dlt * (b["so"] - a["sc"])) / a["oc"]
            seller_in = -((b["oc"] - b["oo"]) - dlt * (b["sc"] - b["so"])) / b["oo"]

            # premium retention proxies (seller keeps more when price falls less): enter at close vs open
            # next-day mid change from entry
            out.append(
                dict(
                    t=b["t"],
                    occ=occ,
                    d=b["date"],
                    seller_on=seller_on,
                    seller_in=seller_in,
                    diff=seller_on - seller_in,
                    sig=b["sig"],
                    dte=b["dte"],
                    oo=b["oo"],
                    oc=b["oc"],
                    prev_c=a["oc"],
                    dlt=dlt,
                )
            )
    return out


def clustered_t(rows: list[dict], key="diff") -> float:
    """Stock-day cluster: average per (ticker, date), then t on those means."""
    buckets = defaultdict(list)
    for r in rows:
        buckets[(r["t"], r["d"])].append(r[key])
    xs = np.array([np.mean(v) for v in buckets.values()], dtype=float)
    if len(xs) < 3:
        return float("nan")
    return float(xs.mean() / (xs.std(ddof=1) / math.sqrt(len(xs))))


def main() -> None:
    conn = connect()
    cap = BACKFILL_DEFAULT
    for a in sys.argv:
        if a.startswith("--backfill"):
            # --backfill or --backfill=40
            if "=" in a:
                cap = int(a.split("=")[1])
            elif "--backfill" in sys.argv:
                i = sys.argv.index("--backfill")
                if i + 1 < len(sys.argv) and sys.argv[i + 1].isdigit():
                    cap = int(sys.argv[i + 1])
    occs = candidates(conn)
    print(f"candidate OCCs in ~1σ band: {len(occs)}", flush=True)
    if cap > 0:
        backfill_opens(conn, occs, cap)

    # zero-volume share on band (before drop)
    zv = conn.execute(
        """
        SELECT AVG((b.v = 0 OR b.v IS NULL)::int::float), COUNT(*)
        FROM optlab.bars b
        JOIN optlab.contracts k ON k.occ = b.occ AND k.type = 'put'
        WHERE (k.expiry - b.date) BETWEEN %s AND %s
        """,
        (DTE_LO, DTE_HI),
    ).fetchone()

    pairs = load_pairs(conn)
    print(f"pairs with o/c: {len(pairs)}", flush=True)
    if "--smoke" in sys.argv:
        by_t = defaultdict(list)
        for r in pairs:
            by_t[r["t"]].append(r)
        names = list(by_t)[:5]
        for t in names:
            for r in by_t[t][:5]:
                print(
                    f"{t} {r['d']} on {r['seller_on']:+.3%} in {r['seller_in']:+.3%} "
                    f"diff {r['diff']:+.3%} Δ={r['dlt']:.2f} o={r['oo']:.2f} c={r['oc']:.2f}"
                )
        return

    if len(pairs) < 30:
        L = [
            "# S125 — option overnight vs intraday (Muravyev & Ni; A188 #1 / A276)",
            "",
            f"**NOT ENOUGH** — only {len(pairs)} pairs after open backfill (cap {cap}). "
            f"Re-run with `--backfill 200` (Polygon 5/min ≈ {200*12.5/60:.0f} min).",
            f"Zero-vol share on 7–45 DTE puts: {zv[0]:.1%} of {zv[1]:,} bars (dropped).",
            "",
            "Bid+23% fill haircut unavailable on daily bars — flagged per plan.",
        ]
        OUT.write_text("\n".join(L) + "\n")
        PACKET.write_text(
            "\n".join(
                [
                    "# A276 packet — S125 (A188 #1 Muravyev overnight)",
                    f"- script: analysis/s125_option_overnight.py --backfill {cap}",
                    f"- n_pairs={len(pairs)} — NOT ENOUGH for bar (need stock-day clustered t)",
                    f"- zero-vol share {zv[0]:.1%} of {zv[1]:,} (dropped)",
                    "- gap: optlab.bars historically stored h/c/v only; o backfill in progress",
                    f"- out: out/opt/S125.md",
                ]
            )
            + "\n"
        )
        print("\n".join(L))
        return

    y2024 = [r for r in pairs if r["d"].year == 2024]
    y2025p = [r for r in pairs if r["d"].year >= 2025]
    def mean(xs, k):
        return float(np.mean([r[k] for r in xs])) if xs else float("nan")

    m_on, m_in, m_diff = mean(pairs, "seller_on"), mean(pairs, "seller_in"), mean(pairs, "diff")
    t_all = clustered_t(pairs, "diff")
    t24 = clustered_t(y2024, "diff")
    t25 = clustered_t(y2025p, "diff")
    same = (m_diff > 0 and mean(y2024, "diff") > 0 and mean(y2025p, "diff") > 0) or (
        m_diff < 0 and mean(y2024, "diff") < 0 and mean(y2025p, "diff") < 0
    )
    ok = m_diff > 0 and t_all >= 2 and same and mean(y2024, "diff") > 0 and mean(y2025p, "diff") > 0
    # sell-at-close vs open: mean next overnight move of option from entry
    # proxy already in seller_on from close entry; from open entry ≈ seller_in path — compare |premium decay|
    close_better = m_on > m_in  # overnight edge after close sale

    verdict = "PASS" if ok else "FAIL"
    L = [
        "# S125 — option overnight vs intraday (Muravyev & Ni; A188 #1 / A276)",
        "",
        f"~1σ puts ({SIG_LO}–{SIG_HI}σ), {DTE_LO}–{DTE_HI} DTE, volume>0, delta-hedged short-put seller returns.",
        f"n_pairs={len(pairs)} · stock-days={len({(r['t'],r['d']) for r in pairs})} · "
        f"names={len({r['t'] for r in pairs})}. Zero-vol share on DTE band: {zv[0]:.1%} of {zv[1]:,} (dropped).",
        "Bid+23% haircut unavailable on daily bars — flagged.",
        "",
        "| slice | n | seller overnight | seller intraday | overnight−intraday | cluster-t |",
        "|---|---|---|---|---|---|",
        f"| all | {len(pairs)} | {m_on:+.3%} | {m_in:+.3%} | {m_diff:+.3%} | {t_all:+.2f} |",
        f"| 2024 | {len(y2024)} | {mean(y2024,'seller_on'):+.3%} | {mean(y2024,'seller_in'):+.3%} | "
        f"{mean(y2024,'diff'):+.3%} | {t24:+.2f} |",
        f"| 2025→ | {len(y2025p)} | {mean(y2025p,'seller_on'):+.3%} | {mean(y2025p,'seller_in'):+.3%} | "
        f"{mean(y2025p,'diff'):+.3%} | {t25:+.2f} |",
        "",
        f"Close vs open timing (seller overnight mean > intraday?): {'yes' if close_better else 'no'}.",
        "",
        f"**Verdict: {verdict}** — overnight−intraday {m_diff:+.3%}, cluster-t {t_all:+.2f}, "
        f"same-sign years={same}.",
        "",
        "## Hand-check",
    ]
    hc = next((r for r in pairs if r["t"] in ("SOFI", "CDNS", "LRCX", "MP")), pairs[0])
    L.append(
        f"- {hc['t']} {hc['d']} {hc['occ']}: prev_c={hc['prev_c']:.2f} o={hc['oo']:.2f} c={hc['oc']:.2f} "
        f"Δ={hc['dlt']:.2f} seller_on {hc['seller_on']:+.3%} seller_in {hc['seller_in']:+.3%} "
        f"diff {hc['diff']:+.3%}"
    )
    OUT.write_text("\n".join(L) + "\n")
    pk = [
        "# A276 packet — S125 (A188 #1 Muravyev overnight)",
        f"- script: `analysis/s125_option_overnight.py --backfill {cap}`",
        f"- n_pairs={len(pairs)} stock-days={len({(r['t'],r['d']) for r in pairs})} names={len({r['t'] for r in pairs})}",
        f"- seller overnight {m_on:+.3%} · intraday {m_in:+.3%} · diff {m_diff:+.3%} · cluster-t {t_all:+.2f}",
        f"- 2024 diff {mean(y2024,'diff'):+.3%} (t {t24:+.2f}) · 2025→ {mean(y2025p,'diff'):+.3%} (t {t25:+.2f})",
        f"- zero-vol dropped: {zv[0]:.1%} of {zv[1]:,} · bid+23% haircut N/A on daily bars",
        f"- bar: overnight−intraday>0, cluster-t≥2, same sign 2024 and 2025→",
        f"- hand-check: {hc['t']} {hc['d']} on {hc['seller_on']:+.3%} in {hc['seller_in']:+.3%} diff {hc['diff']:+.3%}",
        f"- out: `out/opt/S125.md`",
        f"- cursor_verdict_hint (Claude owns wording): {verdict}",
    ]
    PACKET.write_text("\n".join(pk) + "\n")
    print("\n".join(L[2:]))
    print("wrote", OUT, PACKET)


if __name__ == "__main__":
    for p in (Path(__file__).resolve().parents[3] / ".env.local",):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p)
    main()
