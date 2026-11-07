"""London Strategic Edge download API — metering, vendor_raw, rate limits (A357).

Base: https://download.londonstrategicedge.com/v3
Auth: header X-API-Key from LSE_KEY in .env.local (never query param).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))
from build_plan_parts.db import connect as _connect  # noqa: E402

BASE = "https://download.londonstrategicedge.com/v3"
DEADLINE_S = 20.0
RATE_PER_MIN = 55


def connect():
    return _connect()


class _Bucket:
    def __init__(self, rate_per_min: float) -> None:
        self._gap = 60.0 / rate_per_min
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            if now < self._next:
                time.sleep(self._next - now)
            self._next = time.monotonic() + self._gap


_BUCKET = _Bucket(RATE_PER_MIN)


def _load_key() -> str:
    k = os.environ.get("LSE_KEY")
    if not k:
        for p in (ROOT / ".env.local", ROOT / ".env"):
            if not p.is_file():
                continue
            for line in p.read_text().splitlines():
                if line.startswith("LSE_KEY="):
                    k = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
            if k:
                break
    if not k:
        raise SystemExit("LSE_KEY missing in environment or .env.local")
    return k


def occ_symbol(ticker: str, expiry: date, strike: float, side: str = "put") -> str:
    """OCC: root padded to 6, YYMMDD, P/C, strike ×1000 zero-padded to 8."""
    root = ticker.upper().strip()[:6].ljust(6)
    y, m, d = expiry.year, expiry.month, expiry.day
    cp = "P" if side.lower() == "put" else "C"
    strike8 = str(int(round(strike * 1000))).zfill(8)
    return f"{root}{y % 100:02d}{m:02d}{d:02d}{cp}{strike8}"


def meter(conn, n: int = 1) -> None:
    if n <= 0:
        return
    conn.execute(
        """INSERT INTO api_usage (source, date, calls_made, updated_at)
           VALUES ('lse', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
           ON CONFLICT (source, date) DO UPDATE SET
             calls_made = api_usage.calls_made + excluded.calls_made,
             updated_at = now()""",
        (n,),
    )
    conn.commit()


def _save_vendor_json(conn, endpoint: str, key: str, payload: dict) -> None:
    blob = json.dumps(payload)
    conn.execute(
        """INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
           VALUES ('lse', %s, %s, %s, %s::jsonb, %s)
           ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET
             payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
        (endpoint, key, date.today(), blob, hashlib.sha1(blob.encode()).hexdigest()),
    )
    conn.commit()


def _save_vendor_csv(conn, endpoint: str, key: str, csv_text: str) -> None:
    if len(csv_text.encode("utf-8")) > 200_000:
        return
    payload = json.dumps({"csv": csv_text})
    conn.execute(
        """INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
           VALUES ('lse', %s, %s, %s, %s::jsonb, %s)
           ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET
             payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
        (endpoint, key, date.today(), payload, hashlib.sha1(payload.encode()).hexdigest()),
    )
    conn.commit()


def _request(conn, url: str, *, endpoint: str, vkey: str) -> tuple[int, bytes, dict[str, str]]:
    key = _load_key()
    headers = {"X-API-Key": key, "Accept": "*/*"}
    _BUCKET.wait()
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=DEADLINE_S) as resp:
            body = resp.read()
            meter(conn, 1)
            return resp.status, body, dict(resp.headers)
    except urllib.error.HTTPError as e:
        meter(conn, 1)
        hdrs = dict(e.headers.items()) if e.headers else {}
        if e.code == 429:
            wait = float(hdrs.get("Retry-After", "2"))
            time.sleep(max(0, wait))
            _BUCKET.wait()
            req2 = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req2, timeout=DEADLINE_S) as resp:
                body = resp.read()
                meter(conn, 1)
                return resp.status, body, dict(resp.headers)
        return e.code, e.read(), hdrs


def _vendor_json_cached(conn, endpoint: str, key: str) -> dict[str, Any] | None:
    row = conn.execute(
        """SELECT payload FROM vendor_raw
           WHERE source = 'lse' AND endpoint = %s AND key = %s
           ORDER BY fetched_on DESC LIMIT 1""",
        (endpoint, key),
    ).fetchone()
    if not row:
        return None
    pl = row[0]
    if isinstance(pl, dict):
        return pl
    if isinstance(pl, str):
        return json.loads(pl)
    return dict(pl) if pl else None


def get_json(conn, path: str, *, cache_key: str | None = None) -> dict[str, Any]:
    ep = path.split("?")[0]
    key = cache_key or path
    cached = _vendor_json_cached(conn, ep, key)
    if cached is not None:
        return {"http_status": 200, **cached}
    url = f"{BASE}/{path.lstrip('/')}"
    status, body, _ = _request(conn, url, endpoint=ep, vkey=key)
    try:
        data = json.loads(body.decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        data = {"status": status, "raw": body[:200].decode("utf-8", errors="replace")}
    if status == 200:
        _save_vendor_json(conn, path.split("?")[0], key, data)
    return {"http_status": status, **data}


def list_put_strikes(conn, ticker: str, expiry: date) -> list[float]:
    """Listed put strikes for (underlying, expiry) via /v3/pairs (cached in vendor_raw)."""
    q = urllib.parse.urlencode(
        {
            "market": "us_options",
            "underlying": ticker,
            "expiry": expiry.isoformat(),
            "option_type": "put",
            "limit": "10000",
        }
    )
    cache_key = f"pairs|{ticker.upper()}|{expiry.isoformat()}|put"
    data = get_json(conn, f"pairs?{q}", cache_key=cache_key)
    if data.get("http_status") != 200:
        return []
    strikes: list[float] = []
    for p in data.get("pairs") or []:
        if str(p.get("expiry", ""))[:10] != expiry.isoformat():
            continue
        sk = p.get("strike_price", p.get("strike"))
        if sk is None:
            continue
        try:
            strikes.append(float(sk))
        except (TypeError, ValueError):
            continue
    return sorted(set(strikes))


def nearest_listed_strike(model_strike: float, listed: list[float]) -> float | None:
    """Listed strike with smallest |strike − model| (A359; no downward bias)."""
    if model_strike <= 0 or not listed:
        return None
    return min(listed, key=lambda s: abs(s - model_strike))


def snap_put_strike(model_strike: float, listed: list[float], *, max_gap_frac: float = 0.05) -> float | None:
    """Nearest listed strike at or below model_strike; None if gap > max_gap_frac."""
    if model_strike <= 0 or not listed:
        return None
    at_or_below = [s for s in listed if s <= model_strike + 1e-6]
    if not at_or_below:
        return None
    snapped = max(at_or_below)
    if (model_strike - snapped) / model_strike > max_gap_frac:
        return None
    return snapped


def export_stock_csv(
    conn,
    ticker: str,
    *,
    date_from: date,
    date_to: date,
    timeframe: str = "1m",
) -> tuple[int, str]:
    """GET /v3/export for us_stocks. Returns (http_status, csv_text or error body)."""
    q = urllib.parse.urlencode(
        {
            "market": "us_stocks",
            "symbol": ticker.upper(),
            "timeframe": timeframe,
            "from": date_from.isoformat(),
            "to": date_to.isoformat(),
            "format": "csv",
        }
    )
    path = f"export?{q}"
    vkey = f"stock|{ticker.upper()}|{timeframe}|{date_from}|{date_to}"
    status, body, _ = _request(conn, f"{BASE}/{path}", endpoint="export", vkey=vkey)
    text = body.decode("utf-8", errors="replace")
    if status == 200 and '"time"' in text.lstrip()[:80].lower():
        _save_vendor_csv(conn, "export", vkey, text)
    return status, text


def parse_stock_minute_rows(csv_text: str) -> list[dict[str, Any]]:
    """Parse LSE stock export CSV into minute rows (ts, o, h, l, c, v)."""
    lines = [ln for ln in csv_text.strip().splitlines() if ln.strip()]
    if len(lines) < 2:
        return []
    header = [h.strip().strip('"') for h in lines[0].split(",")]
    idx = {h: i for i, h in enumerate(header)}

    def parse_ts(parts: list[str]) -> str | None:
        for key in ("time", "timestamp", "datetime"):
            if key not in idx:
                continue
            v = parts[idx[key]].strip().strip('"')
            return v if v else None
        if "date" in idx:
            return parts[idx["date"]].strip().strip('"')
        return None

    out: list[dict[str, Any]] = []
    for ln in lines[1:]:
        parts = [p.strip().strip('"') for p in re.split(r',(?=(?:[^"]*"[^"]*")*[^"]*$)', ln)]
        if len(parts) < len(header):
            continue
        ts = parse_ts(parts)
        if not ts:
            continue

        def num(name: str) -> float | None:
            if name not in idx:
                return None
            try:
                v = float(parts[idx[name]])
                return v if math.isfinite(v) else None
            except ValueError:
                return None

        vol = idx.get("volume")
        volume = int(float(parts[vol])) if vol is not None and parts[vol] else None
        out.append(
            {
                "ts": ts,
                "open": num("open"),
                "high": num("high"),
                "low": num("low"),
                "close": num("close"),
                "volume": volume,
            }
        )
    return out


def export_options_csv(
    conn,
    occ: str,
    *,
    date_from: date,
    date_to: date,
    timeframe: str = "1d",
) -> tuple[int, str]:
    """GET /v3/export for us_options. Returns (http_status, csv_text or error body)."""
    q = urllib.parse.urlencode(
        {
            "market": "us_options",
            "symbol": occ,
            "timeframe": timeframe,
            "from": date_from.isoformat(),
            "to": date_to.isoformat(),
            "format": "csv",
        }
    )
    path = f"export?{q}"
    vkey = f"{occ}|{date_from}|{date_to}"
    status, body, _ = _request(conn, f"{BASE}/{path}", endpoint="export", vkey=vkey)
    text = body.decode("utf-8", errors="replace")
    if status == 200 and '"time"' in text.lstrip()[:40].lower():
        _save_vendor_csv(conn, "export", vkey, text)
    return status, text


def parse_export_rows(csv_text: str) -> list[dict[str, Any]]:
    """Parse LSE options export CSV into daily OHLCV rows (one row per calendar date)."""
    lines = [ln for ln in csv_text.strip().splitlines() if ln.strip()]
    if len(lines) < 2:
        return []
    header = [h.strip().strip('"') for h in lines[0].split(",")]
    idx = {h: i for i, h in enumerate(header)}
    out: list[dict[str, Any]] = []
    for ln in lines[1:]:
        parts = [p.strip().strip('"') for p in re.split(r',(?=(?:[^"]*"[^"]*")*[^"]*$)', ln)]
        if len(parts) < len(header):
            continue
        d = parts[idx.get("date", -1)] if "date" in idx else parts[-1]
        try:
            day = date.fromisoformat(d[:10])
        except ValueError:
            continue
        def num(name: str) -> float | None:
            if name not in idx:
                return None
            try:
                v = float(parts[idx[name]])
                return v if math.isfinite(v) else None
            except ValueError:
                return None
        vol = idx.get("volume")
        volume = int(float(parts[vol])) if vol is not None and parts[vol] else None
        out.append(
            {
                "date": day,
                "open": num("open"),
                "high": num("high"),
                "low": num("low"),
                "close": num("close"),
                "volume": volume,
            }
        )
    return out


if __name__ == "__main__":
    with connect() as conn:
        u = get_json(conn, "usage")
        print(json.dumps({k: u[k] for k in u if k != "key"}, indent=2)[:800])
