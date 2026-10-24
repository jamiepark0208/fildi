"""tastytrade API client (S096, A262): read-only market metrics + backtests.

Auth = OAuth personal grant: TASTYTRADE_CLIENT_SECRET + TASTYTRADE_REFRESH_TOKEN in .env.local → 15-min access token.
Every response is kept whole in vendor_raw (source 'tastytrade', rule 4c).

  python3 scripts/watchlist_sync/tastytrade.py auth
  python3 scripts/watchlist_sync/tastytrade.py metrics AAPL,MSFT
  python3 scripts/watchlist_sync/tastytrade.py universe      # daily.py: every fmp_fundamentals name (~3 s)
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


def remember(endpoint: str, key: str, payload) -> None:
    """Same row shape as api-server lib/vendor-raw.ts (one row per source/endpoint/key/day)."""
    sha = hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()
    with connect() as conn:
        conn.execute(
            """INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
               VALUES ('tastytrade', %s, %s, %s, %s::jsonb, %s)
               ON CONFLICT (source, endpoint, key, fetched_on)
               DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
            (endpoint, key, date.today(), json.dumps(payload), sha))


def metrics(symbols: list[str]) -> list[dict]:
    """GET /market-metrics, ≤ 100 symbols per call; one vendor_raw row per symbol."""
    out = []
    for i in range(0, len(symbols), 100):
        chunk = symbols[i:i + 100]
        r = _http("GET", "/market-metrics?symbols=" + urllib.parse.quote(",".join(chunk), safe=","))
        items = (r.get("data") or {}).get("items") or []
        for it in items:
            remember("/market-metrics", it.get("symbol", "?"), it)
        out += items
    return out


def available_dates() -> list[dict]:
    r = _http("GET", "/available-dates", base=BT)
    remember("/available-dates", "all", r)
    return r if isinstance(r, list) else (r.get("data") or {}).get("items") or r


def backtest(spec: dict, poll: float = 5.0, max_wait: float = 900) -> dict:
    """POST /backtests then poll until completed; stores the finished object keyed by a hash of the spec."""
    r = _http("POST", "/backtests", spec, base=BT)
    t0 = time.time()
    while r.get("status") != "completed" and time.time() - t0 < max_wait:
        time.sleep(poll)
        r = _http("GET", f"/backtests/{r['id']}", base=BT)
    key = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    remember("/backtests", key, {"spec": spec, "result": r})
    return r


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "auth"
    if cmd == "auth":
        token()
        print("auth ok, token expires", time.strftime("%H:%M", time.localtime(_token["exp"])))
    elif cmd == "metrics":
        print(json.dumps(metrics(sys.argv[2].upper().split(",")), indent=1)[:4000])
    elif cmd == "universe":
        with connect() as conn:
            syms = [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM fmp_fundamentals ORDER BY 1")]
        items = metrics([t.replace(".", "/") for t in syms])
        print(f"tastytrade metrics: {len(items)}/{len(syms)} names stored")
    elif cmd == "dates":
        print(json.dumps(available_dates())[:3000])
    elif cmd == "backtest":
        print(json.dumps(backtest(json.load(open(sys.argv[2]))), indent=1)[:6000])
