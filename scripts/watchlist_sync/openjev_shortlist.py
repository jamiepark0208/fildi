"""A261 — morning news shortlist. OpenJev answers typed choices only (no prose).

One model load inside openjev_local.tick (FORECAST_BATCH is off, A251): label new Finnhub
headlines first, then score desk mail since the last 16:00 ET close plus those headlines,
and write watchlist_sync.openjev_shortlist. A later tick with nothing new does not load.

    .venv/bin/python openjev_shortlist.py --smoke     # 20 off-topic + 20 company emails
    .venv/bin/python openjev_shortlist.py --morning   # one shortlist run
"""
from __future__ import annotations

import datetime as dt
import json
import statistics
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
PT = ZoneInfo("America/Los_Angeles")
RELEVANT_MIN = 0.5
MATERIAL_MIN = 0.5       # one item this material, or a score at/above SCORE_MIN (review 11953ce9)
SCORE_MIN = 0.05
TOP_N = 15
PEER_N = 3
CAP_PER_SOURCE = 3
ITEM_POST_CAP = 20          # one post = rel+dir+cat+mat; keeps the morning run under 5 min
HEADLINE_LOOKBACK_DAYS = 7
FORECASTER = "openjev:shortlist"
BASELINE = "universe:random"
QTYPE = "abn_1s_5d"
BASE_RATE = 0.3173          # P(|Z| > 1) if the residual is normal — random-universe baseline
OUT_DIR = HERE / "out" / "shortlist"

CATS = {
    "earnings": "quarterly results or an earnings report",
    "guidance": "guidance, outlook, or a forecast change",
    "analyst": "analyst rating or price target",
    "M&A": "merger, acquisition, or a big contract",
    "product": "product launch or a business update",
    "legal": "lawsuit, regulator, or investigation",
    "macro": "macro, sector, or a broad market move",
    "other": "anything else",
}

DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.openjev_shortlist (
  made_on date NOT NULL,
  ticker text NOT NULL,
  role text NOT NULL,
  of_ticker text,
  score double precision NOT NULL,
  dir text,
  cats jsonb NOT NULL DEFAULT '[]'::jsonb,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (made_on, ticker)
);
"""


def connect():
    from build_plan import connect as c
    return c()


def ensure_table(conn) -> None:
    conn.execute(DDL)
    conn.commit()


def email_question() -> dict:
    return {"rel": {"type": "noul", "instructions":
                    "Is this a market or company news item (earnings, a listed stock, a sector, or macro)? "
                    "Answer low for a welcome note, a subscription confirmation, 'you've subscribed', a promotion, "
                    "or a personal-finance lifestyle checklist — even if the product name mentions tech, stocks, or investing."}}


def item_questions(name: str) -> dict:
    """Same shape as openjev_news.questions (noul / score / choice). Categories are the A261 set."""
    s = f"{name}'s stock price in the short term"
    return {
        "rel": {"type": "noul", "instructions": f"Is this mainly about {name} itself (not a market roundup or a list of many stocks)?"},
        "dir": {"type": "score", "instructions": f"How is this news for {s}?", "criteria": ["bad", "neutral", "good"]},
        "cat": {"type": "choice", "instructions": "What kind of news is this?", "criteria": CATS},
        "mat": {"type": "noul", "instructions": f"Is this news big enough to move {name}'s stock much more than on a normal day?"},
    }


def p_noul(a) -> float:
    if isinstance(a, dict) and a.get("noul") is not None:
        return float(a["noul"])
    return 0.0


def dir_label(a) -> str:
    if not isinstance(a, dict):
        return "neutral"
    if "score" in a:
        v = float(a["score"]) * 2 - 1
    elif "expected" in a:
        v = float(a["expected"]) * 2 - 1
    else:
        return "neutral"
    if v > 0.25:
        return "good"
    if v < -0.25:
        return "bad"
    return "neutral"


def dir_num(label: str) -> int:
    return {"good": 1, "bad": -1}.get(label, 0)


def cat_of(a) -> str:
    if isinstance(a, dict) and a.get("choice") in CATS:
        return str(a["choice"])
    return "other"


def shortlist_prob(score: float) -> float:
    lift = min(1.0, max(0.0, score) / 3.0)
    return round(min(0.90, max(0.05, BASE_RATE + 0.40 * lift)), 4)


def accumulate(scored: list[dict], cap: int = CAP_PER_SOURCE) -> dict[str, dict]:
    """Sum rel × material, at most `cap` items per source. Drops item-level rel < 0.5."""
    by: dict[str, list[dict]] = {}
    for it in scored:
        if it["rel"] < RELEVANT_MIN:
            continue
        by.setdefault(it["ticker"], []).append(it)
    out = {}
    for t, items in by.items():
        kept: list[dict] = []
        for source in ("email", "headline"):
            group = [i for i in items if i["source"] == source]
            group.sort(key=lambda i: i["rel"] * i["mat"], reverse=True)
            kept.extend(group[:cap])
        if not kept:
            continue
        score = sum(i["rel"] * i["mat"] for i in kept)
        if score < SCORE_MIN and not any(i["mat"] >= MATERIAL_MIN for i in kept):
            continue
        w = score or 1.0
        dnum = sum((i["rel"] * i["mat"]) * dir_num(i["dir"]) for i in kept) / w
        label = "good" if dnum > 0.25 else "bad" if dnum < -0.25 else "neutral"
        cats = []
        for i in kept:
            if i["cat"] not in cats:
                cats.append(i["cat"])
        out[t] = {
            "score": round(score, 4),
            "dir": label,
            "cats": cats[:4],
            "items": [{"source": i["source"], "id": i["id"], "title": i["title"][:180],
                       "mat": round(i["mat"], 4)} for i in kept],
        }
    return out


def top_tickers(agg: dict[str, dict], n: int = TOP_N) -> list[str]:
    return sorted(agg, key=lambda t: agg[t]["score"], reverse=True)[:n]


def mail_since(now: dt.datetime | None = None) -> dt.datetime:
    """16:00 ET on the last trading day that has already closed.

    Monday morning therefore includes Friday evening and the weekend (review 11953ce9).
    """
    import rules
    now = now or dt.datetime.now(rules.ET)
    closed = rules.last_close_date(now)
    return dt.datetime.combine(closed, dt.time(16, 0), tzinfo=rules.ET)


def daily_return_corr(a: list[tuple], b: list[tuple], min_days: int = 60) -> float | None:
    """Pearson correlation of aligned daily simple returns. None when the overlap is short."""
    def rets(rows: list[tuple]) -> dict:
        out, prev = {}, None
        for d, c in rows:
            if c is None or c <= 0:
                prev = None
                continue
            if prev is not None:
                out[d] = c / prev - 1.0
            prev = c
        return out

    ra, rb = rets(a), rets(b)
    keys = sorted(set(ra) & set(rb))
    if len(keys) > 252:
        keys = keys[-252:]
    if len(keys) < min_days:
        return None
    xs = [ra[k] for k in keys]
    ys = [rb[k] for k in keys]
    if statistics.pstdev(xs) == 0 or statistics.pstdev(ys) == 0:
        return None
    return statistics.correlation(xs, ys)


def rank_peers(scored: list[tuple[str, float]], already: set[str], n: int = PEER_N) -> list[tuple[str, float]]:
    """Highest 1-year return correlation first. Alphabetical only breaks a tie."""
    out: list[tuple[str, float]] = []
    for t, c in sorted(scored, key=lambda x: (-x[1], x[0])):
        u = t.upper()
        if u in already or any(p == u for p, _ in out):
            continue
        out.append((u, round(float(c), 2)))
        if len(out) >= n:
            break
    return out


def pick_peers(candidates: list[str], already: set[str], n: int = PEER_N) -> list[str]:
    out = []
    for t in candidates:
        u = t.upper()
        if u in already or u in out:
            continue
        out.append(u)
        if len(out) >= n:
            break
    return out


def reason_line(role: str, cats: list, dir_label_: str, n_items: int, of_ticker: str | None) -> str:
    if role == "peer":
        return f"news shortlist: peer of {of_ticker}"
    if role == "event":
        cat = cats[0] if cats else "8-K"
        return f"8-K hard event: {cat}"
    cat = cats[0] if cats else "other"
    return f"news shortlist: {cat} {dir_label_} ({n_items} items)"


def abn_exceeds_1s(stock_px: list[float], spy_px: list[float], horizon: int = 5, lookback: int = 60) -> bool | None:
    """|sum of daily beta-residuals over `horizon`| > 1σ, σ = trailing daily residual sd × √horizon.

    Closes are oldest → newest and aligned. The last `horizon` sessions are the question; the
    `lookback` sessions before that fit beta. None when the window is short or the market has no variance.
    """
    if len(stock_px) != len(spy_px) or len(stock_px) < lookback + horizon + 1:
        return None
    rs = [stock_px[i] / stock_px[i - 1] - 1 for i in range(1, len(stock_px))]
    rm = [spy_px[i] / spy_px[i - 1] - 1 for i in range(1, len(spy_px))]
    hist_s, hist_m = rs[-(lookback + horizon):-horizon], rm[-(lookback + horizon):-horizon]
    if len(hist_s) < lookback:
        return None
    n = len(hist_s)
    mean_m = sum(hist_m) / n
    mean_s = sum(hist_s) / n
    var_m = sum((x - mean_m) ** 2 for x in hist_m)
    if var_m == 0:
        return None
    beta = sum((hist_m[i] - mean_m) * (hist_s[i] - mean_s) for i in range(n)) / var_m
    a = mean_s - beta * mean_m
    resid = [hist_s[i] - a - beta * hist_m[i] for i in range(n)]
    sd = statistics.pstdev(resid)
    fwd = sum(rs[-horizon + i] - a - beta * rm[-horizon + i] for i in range(horizon))
    if not sd:
        return abs(fwd) > 1e-12
    return abs(fwd) > sd * (horizon ** 0.5)


def _answers(state: str, questions: dict) -> dict:
    import openjev_local as oj
    r = oj._post("/v1/systemone", {"model": oj.MODEL, "state": state[:8000], "questions": questions})
    return r.get("answers") or {}


def _universe(conn) -> set[str]:
    return {r[0] for r in conn.execute("SELECT UPPER(ticker) FROM fmp_fundamentals WHERE ticker IS NOT NULL").fetchall()}


def _names(conn, tickers: list[str]) -> dict[str, str]:
    names = {t: t for t in tickers}
    if not tickers:
        return names
    try:
        for t, name in conn.execute(
            "SELECT UPPER(ticker), NULLIF(name, '') FROM ticker_registry WHERE UPPER(ticker) = ANY(%s)",
            (tickers,),
        ).fetchall():
            if name:
                names[t] = name
    except Exception:
        conn.rollback()
    return names


def _write_relevant(conn, email_id: int, p: float) -> None:
    """Score only. Does not flip includeInBrief — that flag is the commentaries display."""
    conn.execute(
        """UPDATE desk_commentaries
           SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('openjev_relevant', %s)
           WHERE id = %s""",
        (round(p, 4), email_id),
    )


def _email_state(subject: str, synopsis: str | None, body: str | None) -> str:
    parts = [f"Subject: {subject or ''}"]
    if synopsis:
        parts.append(f"Synopsis: {synopsis[:600]}")
    if body:
        parts.append(f"Excerpt: {body[:800]}")
    return "\n".join(parts)


def score_email(post, subject, synopsis, body) -> float:
    ans = post(_email_state(subject, synopsis, body), email_question())
    return p_noul(ans.get("rel"))


def score_item(post, name: str, title: str, blurb: str | None) -> dict | None:
    state = f"Company: {name}.\nItem: {title}"
    if blurb:
        state += f"\nDetail: {blurb[:600]}"
    try:
        ans = post(state, item_questions(name))
    except Exception:
        return None
    return {"rel": p_noul(ans.get("rel")), "dir": dir_label(ans.get("dir")),
            "cat": cat_of(ans.get("cat")), "mat": p_noul(ans.get("mat"))}


def smoke_sets(conn) -> tuple[list, list]:
    """20 most recent off-topic (high noise or personal-finance) and 20 company emails.

    A ticker symbol in the subject is rare here (7 case-sensitive hits in the whole table), so the
    company set is emails that name a universe ticker in tickers_mentioned and are earnings / research /
    sector / overnight — the mail the question calls 'about specific listed companies or markets'.
    """
    off = conn.execute(
        """SELECT id, subject, synopsis, left(body_plain, 800), noise_score, category
           FROM desk_commentaries
           WHERE noise_score >= 70
              OR subject ~* 'checklist|personal finance|financial wellness|you''ve subscribed|welcome to'
           ORDER BY received_at DESC LIMIT 20"""
    ).fetchall()
    company = conn.execute(
        """SELECT id, subject, synopsis, left(body_plain, 800), noise_score, category
           FROM desk_commentaries d
           WHERE noise_score < 70
             AND category IN ('earnings', 'research_note', 'sector', 'overnight')
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(d.tickers_mentioned) t
               JOIN fmp_fundamentals f ON UPPER(f.ticker) = UPPER(t)
               WHERE length(t) >= 4)
           ORDER BY received_at DESC LIMIT 20"""
    ).fetchall()
    return off, company


def smoke(conn, post=None) -> dict:
    post = post or _answers
    off, company = smoke_sets(conn)
    rows = []

    def one(kind, rec):
        eid, subject, synopsis, body, noise, cat = rec
        p = score_email(post, subject or "", synopsis, body)
        _write_relevant(conn, eid, p)
        ok = p < RELEVANT_MIN if kind == "off" else p >= RELEVANT_MIN
        line = {"kind": kind, "id": eid, "p": round(p, 3), "pass": ok, "noise": noise, "category": cat,
                "subject": (subject or "")[:90]}
        rows.append(line)
        flag = "pass" if ok else "FAIL"
        print(f"{kind:4} {flag:4} p={p:.2f} noise={noise} {cat} | {line['subject']}", flush=True)

    print(f"--- off-topic {len(off)} ---", flush=True)
    for rec in off:
        one("off", rec)
    print(f"--- company {len(company)} ---", flush=True)
    for rec in company:
        one("co", rec)
    conn.commit()
    def rate(kind):
        xs = [r for r in rows if r["kind"] == kind]
        n = len(xs)
        k = sum(1 for r in xs if r["pass"])
        return {"n": n, "pass": k, "fail": n - k, "rate": (k / n if n else None)}
    summary = {"off": rate("off"), "co": rate("co")}
    print(f"off {summary['off']['pass']}/{summary['off']['n']}  company {summary['co']['pass']}/{summary['co']['n']}", flush=True)
    return {"rows": rows, **summary}


def _tickers_in(raw, universe: set[str]) -> list[str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    out = []
    for t in raw or []:
        u = str(t).upper()
        if len(u) >= 3 and u in universe and u not in out:
            out.append(u)
        if len(out) >= 5:          # a 40-name overnight list is a roundup, not 40 company items
            break
    return out


def _load_emails(conn, since: dt.datetime):
    return conn.execute(
        """SELECT id, subject, synopsis, left(body_plain, 800), tickers_mentioned,
                  (meta->>'openjev_relevant')::float
           FROM desk_commentaries
           WHERE received_at > %s
           ORDER BY received_at DESC LIMIT 80""",
        (since,),
    ).fetchall()


def _load_headlines(conn, universe: set[str]) -> list[dict]:
    try:
        rows = conn.execute(
            """SELECT id, UPPER(ticker), headline
               FROM watchlist_sync.openjev_headline_labels
               WHERE ts > now() - %s::interval AND rel >= %s
               ORDER BY rel DESC, ts DESC LIMIT 40""",
            (f"{HEADLINE_LOOKBACK_DAYS} days", RELEVANT_MIN),
        ).fetchall()
    except Exception:
        conn.rollback()
        return []
    per: dict[str, int] = {}
    out = []
    for hid, t, title in rows:
        if t not in universe or per.get(t, 0) >= CAP_PER_SOURCE:
            continue
        per[t] = per.get(t, 0) + 1
        out.append({"source": "headline", "id": hid, "ticker": t, "title": title, "blurb": None})
        if len(per) > 12 and len(out) >= ITEM_POST_CAP:
            break
    return out


def _year_closes(conn, tickers: list[str]) -> dict[str, list[tuple]]:
    if not tickers:
        return {}
    rows = conn.execute(
        """SELECT UPPER(ticker), date, close::float8
           FROM prices_historical
           WHERE UPPER(ticker) = ANY(%s)
             AND date >= CURRENT_DATE - 400
             AND close IS NOT NULL
           ORDER BY 1, 2""",
        (tickers,),
    ).fetchall()
    out: dict[str, list[tuple]] = {}
    for t, d, c in rows:
        out.setdefault(t, []).append((d, c))
    return out


def _related_candidates(conn, ticker: str) -> list[str]:
    """Polygon related tickers. Correlation still ranks them. Missing table → []."""
    try:
        conn.execute("SAVEPOINT rel_tickers")
        rows = conn.execute(
            "SELECT UPPER(related) FROM related_tickers WHERE UPPER(ticker) = %s ORDER BY ord NULLS LAST",
            (ticker,),
        ).fetchall()
        conn.execute("RELEASE SAVEPOINT rel_tickers")
        return [r[0] for r in rows if r[0]]
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT rel_tickers")
        return []


def peers_for(conn, ticker: str, already: set[str]) -> list[tuple[str, float]]:
    """Up to 3 names, ranked by 1-year daily-return correlation. Related tickers are extra candidates."""
    gid = conn.execute("SELECT group_id FROM peer_group_overrides WHERE UPPER(ticker) = %s", (ticker,)).fetchone()
    if not gid:
        gid = conn.execute(
            """SELECT group_id FROM peer_group_members
               WHERE UPPER(ticker) = %s AND removed_at IS NULL LIMIT 1""",
            (ticker,),
        ).fetchone()
    members: list[str] = []
    if gid:
        rows = conn.execute(
            """SELECT UPPER(m.ticker) FROM peer_group_members m
               JOIN fmp_fundamentals f ON UPPER(f.ticker) = UPPER(m.ticker)
               WHERE m.group_id = %s AND m.removed_at IS NULL""",
            (gid[0],),
        ).fetchall()
        members = [r[0] for r in rows if r[0] != ticker and r[0] not in already]
    for rel in _related_candidates(conn, ticker):
        if rel != ticker and rel not in already and rel not in members:
            members.append(rel)
    if not members:
        return []
    closes = _year_closes(conn, [ticker, *members])
    base = closes.get(ticker) or []
    scored = []
    for m in members:
        corr = daily_return_corr(base, closes.get(m) or [])
        if corr is None:
            continue
        scored.append((m, corr))
    return rank_peers(scored, already | {ticker})


def render_md(day, rows: list[dict]) -> str:
    peers: dict[str, list[str]] = {}
    for r in rows:
        if r["role"] == "peer" and r.get("of_ticker"):
            c = r.get("corr")
            bit = f"{r['ticker']} {c:.2f}" if isinstance(c, (int, float)) else r["ticker"]
            peers.setdefault(r["of_ticker"], []).append(bit)
    lines = [f"# News shortlist {day}"]
    news = [r for r in rows if r["role"] == "news"]
    events = [r for r in rows if r["role"] == "event"]
    if not news:
        lines.append("(none)")
    for r in news:
        cat = (r["cats"] or ["other"])[0]
        ps = " ".join(peers.get(r["ticker"], [])) or "—"
        top = max(r["items"], key=lambda i: i.get("mat") or 0) if r["items"] else None
        mat = f"{top['mat']:.2f}" if top and top.get("mat") is not None else "—"
        title = (top["title"] if top else "")[:70]
        lines.append(f"{r['ticker']} {cat} {r['dir']} {r['score']:.2f} mat {mat} peers {ps} · {title}")
    for r in events:
        lines.append(f"{r['ticker']} 8-K {(r['cats'] or ['event'])[0]}")
    return "\n".join(lines[:30]) + "\n"


def write_rows(conn, day, rows: list[dict]) -> None:
    ensure_table(conn)
    conn.execute("DELETE FROM watchlist_sync.openjev_shortlist WHERE made_on = %s", (day,))
    for r in rows:
        conn.execute(
            """INSERT INTO watchlist_sync.openjev_shortlist
               (made_on, ticker, role, of_ticker, score, dir, cats, items)
               VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)""",
            (day, r["ticker"], r["role"], r.get("of_ticker"), r["score"], r["dir"],
             json.dumps(r["cats"]), json.dumps(r["items"])),
        )
    conn.commit()


def log_grades(conn, day, rows: list[dict]) -> int:
    import forecast_ledger as fl
    import openjev_local as oj
    conn.execute(fl.DDL)
    now = dt.datetime.now(PT)
    resolves = oj.add_trading_days(day, 5)
    q = "Will the absolute 5-day beta-residual return exceed 1 standard deviation?"
    n = 0
    for r in rows:
        if r["role"] != "news":
            continue
        qid = f"shortlist:{day}:{r['ticker']}"
        meta = json.dumps({"from": day.isoformat(), "horizon": 5, "score": r["score"]})
        conn.execute(fl.UPSERT, (qid, q, QTYPE, r["ticker"], FORECASTER, shortlist_prob(r["score"]),
                                 now, day, resolves, meta))
        conn.execute(fl.UPSERT, (qid, q, QTYPE, r["ticker"], BASELINE, BASE_RATE, now, day, resolves, meta))
        n += 1
    conn.commit()
    return n


def reason_map(conn) -> dict[str, str]:
    """Latest shortlist → the one reasons line build_plan appends. Empty if the table is missing.

    Savepoint so a missing table does not roll back the plan insert that already happened.
    """
    try:
        conn.execute("SAVEPOINT news_shortlist")
        rows = conn.execute(
            """SELECT ticker, role, of_ticker, dir, cats, items
               FROM watchlist_sync.openjev_shortlist
               WHERE made_on = (SELECT MAX(made_on) FROM watchlist_sync.openjev_shortlist)"""
        ).fetchall()
        conn.execute("RELEASE SAVEPOINT news_shortlist")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT news_shortlist")
        return {}
    out = {}
    for t, role, of_t, d, cats, items in rows:
        cats = cats or []
        items = items or []
        out[t] = reason_line(role, cats, d or "neutral", len(items), of_t)
    return out


def needs_model(conn, today) -> bool:
    """No load when today's list exists and every email since the last close already has a score."""
    ensure_table(conn)
    unscored = conn.execute(
        """SELECT COUNT(*) FROM desk_commentaries
           WHERE received_at > %s
             AND (meta->>'openjev_relevant') IS NULL""",
        (mail_since(),),
    ).fetchone()[0]
    if unscored:
        return True
    if conn.execute(
        "SELECT 1 FROM watchlist_sync.openjev_shortlist WHERE made_on = %s", (today,)
    ).fetchone():
        return False
    # An empty morning (no names) still writes the md, so the next tick does not reload.
    return not (OUT_DIR / f"{today.isoformat()}.md").exists()


def hard_event_rows(conn, today: dt.date, already: set[str]) -> list[dict]:
    """Non-earnings 8-Ks from the last 7 days. Missing table → []. Not a score."""
    try:
        conn.execute("SAVEPOINT hard_8k")
        rows = conn.execute(
            """SELECT DISTINCT ON (ticker) ticker, category, filed::text
               FROM corporate_events
               WHERE filed >= %s
                 AND COALESCE(category, '') !~* 'earnings|quarterly_results'
                 AND COALESCE(primary_category, '') !~* 'earnings|quarterly_results'
               ORDER BY ticker, filed DESC""",
            (today - dt.timedelta(days=7),),
        ).fetchall()
        conn.execute("RELEASE SAVEPOINT hard_8k")
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT hard_8k")
        return []
    out = []
    for t, cat, filed in rows:
        if t in already or len(out) >= 8:
            continue
        out.append({
            "ticker": t, "role": "event", "of_ticker": None, "score": 1.0, "dir": "neutral",
            "cats": [cat or "8-K"], "items": [{"title": f"8-K {cat or ''} {filed}", "mat": 1}],
        })
    return out


def morning(conn, post=None, today: dt.date | None = None) -> dict:
    """Score mail since the last close + headlines already labeled. Caller owns the model."""
    post = post or _answers
    today = today or dt.datetime.now(PT).date()
    universe = _universe(conn)
    scored: list[dict] = []
    emails = _load_emails(conn, mail_since())
    relevant = 0
    for eid, subject, synopsis, body, mentioned, prev in emails:
        p = float(prev) if prev is not None else score_email(post, subject or "", synopsis, body)
        if prev is None:
            _write_relevant(conn, eid, p)
        if p < RELEVANT_MIN:
            continue
        relevant += 1
        for t in _tickers_in(mentioned, universe):
            scored.append({"source": "email", "id": eid, "ticker": t, "title": (subject or "")[:180],
                           "blurb": synopsis, "_ask": True})
    conn.commit()
    headlines = _load_headlines(conn, universe)
    todo = [s for s in scored if s.get("_ask")] + headlines
    # one company per post budget: keep the first ITEM_POST_CAP (emails first, then strongest headlines)
    todo = todo[:ITEM_POST_CAP]
    names = _names(conn, list({i["ticker"] for i in todo}))
    asked = 0
    built = []
    for it in todo:
        lab = score_item(post, names.get(it["ticker"], it["ticker"]), it["title"], it.get("blurb"))
        asked += 1
        if not lab:
            continue
        built.append({**it, **lab})
        print(f"  {it['ticker']:6} {it['source']:8} rel={lab['rel']:.2f} mat={lab['mat']:.2f} {lab['dir']:7} {lab['cat']}", flush=True)
    agg = accumulate(built)
    tops = top_tickers(agg)
    rows = []
    already = set(tops)
    for t in tops:
        a = agg[t]
        rows.append({"ticker": t, "role": "news", "of_ticker": None, "score": a["score"], "dir": a["dir"],
                     "cats": a["cats"], "items": a["items"]})
    for t in list(tops):
        for p, corr in peers_for(conn, t, already):
            rows.append({"ticker": p, "role": "peer", "of_ticker": t, "score": 0.0, "dir": agg[t]["dir"],
                         "cats": agg[t]["cats"], "items": [], "corr": corr})
            already.add(p)
            print(f"  peer {p:6} of {t} corr={corr:.2f}", flush=True)
    rows.extend(hard_event_rows(conn, today, already))
    write_rows(conn, today, rows)
    grades = log_grades(conn, today, rows)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    md = render_md(today, rows)
    (OUT_DIR / f"{today.isoformat()}.md").write_text(md)
    return {"made_on": today.isoformat(), "emails": len(emails), "relevant_emails": relevant,
            "item_posts": asked, "news": len(tops), "rows": len(rows), "grades": grades, "md": str(OUT_DIR / f"{today.isoformat()}.md")}


def tick_news(conn, now: dt.datetime | None = None) -> dict:
    """LaunchAgent path: load the model only when there is new mail or no list yet. Unload on the way out."""
    now = now or dt.datetime.now(PT)
    today = now.date()
    if not needs_model(conn, today):
        return {"idle": "nothing new"}
    import openjev_local as oj
    import oj_server
    with oj.Server() as srv:
        # Labels first so this morning's headlines are in the table the shortlist reads (review 11953ce9).
        import openjev_desk_headlines as odh
        headlines = odh.run(limit=6, max_new=12, reuse=True)
        out = morning(conn, today=today)
        out["desk_headlines"] = headlines
        try:
            oj._own_touch[0] = oj_server.STAMP.stat().st_mtime
        except OSError:
            pass
        out["load_s"] = srv.load_s
        out["shared"] = srv.shared
    return out


def main() -> None:
    import argparse
    import json as _json
    import openjev_local as oj
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--morning", action="store_true")
    a = ap.parse_args()
    conn = connect()
    try:
        if a.smoke:
            with oj.Server() as srv:
                out = smoke(conn)
                out["load_s"] = srv.load_s
                out["shared"] = srv.shared
            print(_json.dumps({k: out[k] for k in ("off", "co", "load_s", "shared")}, indent=1))
        if a.morning:
            print(_json.dumps(tick_news(conn), indent=1, default=str))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
