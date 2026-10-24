"""tastytrade API client (S096, A262): read-only market metrics + backtests.

Auth = OAuth personal grant: TASTYTRADE_CLIENT_SECRET + TASTYTRADE_REFRESH_TOKEN in .env.local → 15-min access token.
Every response is kept whole in vendor_raw (source 'tastytrade', rule 4c).

  python3 scripts/watchlist_sync/tastytrade.py auth
  python3 scripts/watchlist_sync/tastytrade.py metrics AAPL,MSFT
  python3 scripts/watchlist_sync/tastytrade.py universe      # daily.py: every name the app shows (~6 calls, seconds)
  python3 scripts/watchlist_sync/tastytrade.py dates
  python3 scripts/watchlist_sync/tastytrade.py backtest spec.json
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from build_plan import ROOT, connect
from dotenv import load_dotenv

BASE = "https://api.tastyworks.com"
BT = "https://backtester.vast.tastyworks.com"  # backtester has its own host
UA = "fildi-research/1.0"
_token: dict = {}
_calls = [0]   # metered into api_usage (source 'tastytrade') by meter()


def _env() -> None:
    for p in (ROOT / ".env.local", ROOT / ".env"):
        if p.is_file():
            load_dotenv(p, override=False)


def _http(method: str, path: str, body: dict | None = None, auth: bool = True, base: str = BASE) -> dict:
    headers = {"User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {token()}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    for attempt in range(4):
        _calls[0] += 1
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(2 ** (attempt + 1))
                continue
            raise RuntimeError(f"{method} {path} → {e.code}: {e.read()[:300]!r}") from None
    raise RuntimeError("unreachable")


def token() -> str:
    if _token.get("exp", 0) > time.time() + 60:
        return _token["access"]
    _env()
    body = {"grant_type": "refresh_token",
            "refresh_token": os.environ["TASTYTRADE_REFRESH_TOKEN"],
            "client_secret": os.environ["TASTYTRADE_CLIENT_SECRET"]}
    if os.environ.get("TASTYTRADE_CLIENT_ID"):
        body["client_id"] = os.environ["TASTYTRADE_CLIENT_ID"]
    r = _http("POST", "/oauth/token", body, auth=False)
    _token.update(access=r["access_token"], exp=time.time() + int(r.get("expires_in", 900)))
    return _token["access"]


def remember(endpoint: str, rows: list[tuple[str, object]]) -> None:
    """Same row shape as api-server lib/vendor-raw.ts (one row per source/endpoint/key/day); one connection per batch."""
    with connect() as conn:
        for key, payload in rows:
            sha = hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()
            conn.execute(
                """INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                   VALUES ('tastytrade', %s, %s, %s, %s::jsonb, %s)
                   ON CONFLICT (source, endpoint, key, fetched_on)
                   DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
                (endpoint, key, date.today(), json.dumps(payload), sha))


DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.tasty_metrics_daily (
  ticker text, date date, iv_index real, iv_index_5d_change real, iv_rank real, iv_percentile real,
  liquidity_value real, liquidity_rank real, liquidity_rating smallint, iv_updated_at timestamptz,
  PRIMARY KEY (ticker, date))"""
_F = lambda it, k: float(it[k]) if it.get(k) not in (None, "") else None   # noqa: E731


def store_typed(items: list[dict]) -> int:
    """Permanent typed history (vendor_raw is pruned at 400 days; S096's forward test needs every day kept).
    Ticker in Fildi form (BRK/B → BRK.B); date = the ET day fetched."""
    with connect() as conn:
        conn.execute(DDL)
        for it in items:
            conn.execute(
                """INSERT INTO watchlist_sync.tasty_metrics_daily VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (ticker, date) DO UPDATE SET iv_index = excluded.iv_index, iv_index_5d_change = excluded.iv_index_5d_change,
                   iv_rank = excluded.iv_rank, iv_percentile = excluded.iv_percentile, liquidity_value = excluded.liquidity_value,
                   liquidity_rank = excluded.liquidity_rank, liquidity_rating = excluded.liquidity_rating, iv_updated_at = excluded.iv_updated_at""",
                (it["symbol"].replace("/", "."), date.today(), _F(it, "implied-volatility-index"),
                 _F(it, "implied-volatility-index-5-day-change"), _F(it, "implied-volatility-index-rank"),
                 _F(it, "implied-volatility-percentile"), _F(it, "liquidity-value"), _F(it, "liquidity-rank"),
                 it.get("liquidity-rating"), it.get("implied-volatility-updated-at")))
    return len(items)


def meter() -> None:
    if not _calls[0]:
        return
    with connect() as conn:
        conn.execute("""INSERT INTO api_usage (source, date, calls_made, updated_at)
                        VALUES ('tastytrade', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
                        ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + excluded.calls_made,
                        updated_at = now()""", (_calls[0],))
    _calls[0] = 0


def metrics(symbols: list[str]) -> list[dict]:
    """GET /market-metrics, ≤ 100 symbols per call; one vendor_raw row per symbol."""
    out = []
    for i in range(0, len(symbols), 100):
        chunk = symbols[i:i + 100]
        r = _http("GET", "/market-metrics?symbols=" + urllib.parse.quote(",".join(chunk), safe=","))
        items = (r.get("data") or {}).get("items") or []
        remember("/market-metrics", [(it.get("symbol", "?"), it) for it in items])
        store_typed([it for it in items if it.get("symbol")])
        out += items
    return out


def available_dates() -> list[dict]:
    r = _http("GET", "/available-dates", base=BT)
    remember("/available-dates", [("all", r)])
    return r if isinstance(r, list) else (r.get("data") or {}).get("items") or r


def backtest(spec: dict, poll: float = 5.0, max_wait: float = 900) -> dict:
    """POST /backtests then poll until completed; stored keyed by a hash of the spec, and a stored spec is never re-run."""
    key = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    with connect() as conn:
        hit = conn.execute("""SELECT payload->'result' FROM vendor_raw WHERE source = 'tastytrade' AND endpoint = '/backtests'
                              AND key = %s AND payload->'result'->>'status' = 'completed' LIMIT 1""", (key,)).fetchone()
    if hit:
        return hit[0]
    r = _http("POST", "/backtests", spec, base=BT)
    t0 = time.time()
    while r.get("status") != "completed" and time.time() - t0 < max_wait:
        time.sleep(poll)
        r = _http("GET", f"/backtests/{r['id']}", base=BT)
    remember("/backtests", [(key, {"spec": spec, "result": r})])
    return r


APP_NAMES = """SELECT ticker FROM fmp_fundamentals UNION SELECT ticker FROM ticker_technicals"""   # Model List universe + every Breakdown name


def verify(conn) -> tuple[bool, str]:
    """Daily cross-check: today's tastytrade IV percentile vs the Model List's LSEG 1-year IV percentile (fit_model_v14.iv_ranks).
    10-24 baseline: Spearman 0.84 on 130 names, median gap 0.05. Fails (exit 1 → daily.py flags the step) below 0.6 or < 90 % coverage."""
    from statistics import correlation, median

    import fit_model_v14 as V
    tt = dict(conn.execute("""SELECT ticker, iv_percentile FROM watchlist_sync.tasty_metrics_daily
                              WHERE date = current_date AND iv_percentile IS NOT NULL""").fetchall())
    n_uni = conn.execute(f"SELECT count(*) FROM ({APP_NAMES}) u").fetchone()[0]
    ls = V.iv_ranks(conn, set(tt))
    pairs = [(ls[k], v) for k, v in tt.items() if k in ls]

    def rank(x):
        o = sorted(range(len(x)), key=x.__getitem__)
        r = [0] * len(x)
        for j, i in enumerate(o):
            r[i] = j
        return r
    rho = correlation(rank([a for a, _ in pairs]), rank([b for _, b in pairs])) if len(pairs) > 20 else float("nan")
    gap = median(abs(a - b) for a, b in pairs) if pairs else float("nan")
    ok = len(tt) >= 0.9 * n_uni and rho >= 0.6
    return ok, (f"tastytrade: IV pctile {len(tt)}/{n_uni} names · vs LSEG {len(pairs)} names Spearman {rho:.2f}, "
                f"median gap {gap:.2f} · tasty-only {len(tt) - len(pairs)} names" + ("" if ok else " ✗ CHECK"))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "auth"
    if cmd == "auth":
        token()
        print("auth ok, token expires", time.strftime("%H:%M", time.localtime(_token["exp"])))
    elif cmd == "metrics":
        print(json.dumps(metrics(sys.argv[2].upper().split(",")), indent=1)[:4000])
    elif cmd == "universe":
        with connect() as conn:
            syms = [r[0] for r in conn.execute(APP_NAMES + " ORDER BY 1")]
        items = metrics([t.replace(".", "/") for t in syms])
        meter()
        with connect() as conn:
            ok, line = verify(conn)
        print(f"tastytrade metrics: {len(items)}/{len(syms)} names stored · {line}")
        sys.exit(0 if ok else 1)
    elif cmd == "dates":
        print(json.dumps(available_dates())[:3000])
    elif cmd == "backtest":
        print(json.dumps((backtest(json.load(open(sys.argv[2]))).get("results") or {}).get("statistics"), indent=1))
    meter()
