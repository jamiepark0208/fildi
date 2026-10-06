"""Deterministic Robinhood quote fetch for L2 verification: a plain MCP client, no AI model involved.

Robinhood's agent MCP server (https://agent.robinhood.com/mcp/trading) uses standard MCP OAuth: dynamic client registration,
PKCE, refresh tokens. `login` runs that once in your browser; after that `fetch` refreshes tokens silently and pulls exactly the
contracts a plan needs, then hands them to verify_plan (ingest + evaluate).

Safety:
  · READ_ONLY allowlist: this client can only call the three lookup tools below. Order / alert / watchlist tools are refused
    in code, whatever the server offers.
  · Tokens live in the macOS Keychain (service KEYCHAIN_SERVICE), never in the repo or a plain file.

Usage: .venv/bin/python rh_client.py login | status | fetch [--plan N] [--all] | logout
"""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from build_plan import connect, rows

URL = "https://agent.robinhood.com/mcp/trading"
KEYCHAIN_SERVICE = "fildi-watchlist-sync-robinhood-mcp"
REDIRECT_PORT = 8765
REDIRECT_URI = f"http://127.0.0.1:{REDIRECT_PORT}/callback"
READ_ONLY = frozenset({"get_option_instruments", "get_option_quotes", "get_equity_quotes"})
CONCURRENCY = 4


# ── token storage (macOS Keychain) ──────────────────────────────────────────────────────────────────────────────────
def _kc_get(account: str) -> str | None:
    r = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def _kc_set(account: str, value: str) -> None:
    subprocess.run(["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value], check=True, capture_output=True)


def _kc_del(account: str) -> None:
    subprocess.run(["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], capture_output=True)


def _provider(interactive: bool):
    from mcp.client.auth import OAuthClientProvider, TokenStorage
    from mcp.shared.auth import AuthorizationCodeResult, OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

    class KeychainStorage(TokenStorage):
        async def get_tokens(self):
            v = _kc_get("tokens")
            return OAuthToken.model_validate_json(v) if v else None

        async def set_tokens(self, tokens):
            _kc_set("tokens", tokens.model_dump_json())

        async def get_client_info(self):
            v = _kc_get("client")
            return OAuthClientInformationFull.model_validate_json(v) if v else None

        async def set_client_info(self, client_info):
            _kc_set("client", client_info.model_dump_json())

    got: dict = {}

    async def redirect(url: str) -> None:
        if not interactive:
            raise RuntimeError("Robinhood login needed: run `rh_client.py login` once (opens your browser)")
        print(f"opening Robinhood login in your browser (if it doesn't open, visit):\n{url}")
        webbrowser.open(url)

    async def callback():
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                q = parse_qs(urlparse(self.path).query)
                got.update({k: v[0] for k, v in q.items()})
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"Robinhood connected to the Fildi watchlist pipeline. You can close this tab.")

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", REDIRECT_PORT), H)
        t = threading.Thread(target=srv.handle_request, daemon=True)
        t.start()
        while t.is_alive():
            await asyncio.sleep(0.2)
        srv.server_close()
        if "code" not in got:
            raise RuntimeError(f"login failed: {got.get('error', 'no code returned')}")
        return AuthorizationCodeResult(code=got["code"], state=got.get("state"), iss=got.get("iss"))

    meta = OAuthClientMetadata(client_name="Fildi watchlist sync (read-only quotes)", redirect_uris=[REDIRECT_URI],
                               grant_types=["authorization_code", "refresh_token"], response_types=["code"],
                               token_endpoint_auth_method="none", scope="internal")
    return OAuthClientProvider(server_url=URL, client_metadata=meta, storage=KeychainStorage(),
                               redirect_handler=redirect, callback_handler=callback)


# ── MCP session ─────────────────────────────────────────────────────────────────────────────────────────────────────
class ReadOnlyRobinhood:
    def __init__(self, session):
        self.s = session

    async def call(self, tool: str, args: dict) -> dict:
        if tool not in READ_ONLY:
            raise PermissionError(f"{tool} is not in this client's read-only allowlist")
        res = await self.s.call_tool(tool, args)
        if getattr(res, "isError", False) or getattr(res, "is_error", False):
            raise RuntimeError(f"{tool} failed: {res.content[0].text if res.content else res}")
        sc = getattr(res, "structuredContent", None) or getattr(res, "structured_content", None)
        if sc:
            return sc
        return json.loads(res.content[0].text)


async def _with_session(interactive: bool, fn):
    from mcp import ClientSession
    from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

    http = create_mcp_http_client(auth=_provider(interactive))
    async with streamable_http_client(URL, http_client=http) as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await fn(ReadOnlyRobinhood(session))


# ── commands ────────────────────────────────────────────────────────────────────────────────────────────────────────
async def _fetch(rh: ReadOnlyRobinhood, req: dict) -> dict:
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(o):
        async with sem:
            r = await rh.call("get_option_instruments", {k: o[k] for k in ("chain_symbol", "expiration_dates", "strike_price", "type")})
            return (r.get("data", r).get("instruments") or [])

    ins = [i for lst in await asyncio.gather(*(one(o) for o in req["options"])) for i in lst]
    ids = [i["id"] for i in ins]
    oq, eq = [], []
    for k in range(0, len(ids), 20):
        r = await rh.call("get_option_quotes", {"instrument_ids": ids[k:k + 20]})
        oq += r.get("data", r).get("results") or []
    syms = req["equities"]
    for k in range(0, len(syms), 20):
        r = await rh.call("get_equity_quotes", {"symbols": syms[k:k + 20]})
        eq += r.get("data", r).get("results") or []
    return {"instruments": {"data": {"instruments": ins}}, "option_quotes": {"data": {"results": oq}}, "equity_quotes": {"data": {"results": eq}}}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["login", "status", "fetch", "logout"])
    ap.add_argument("--plan", type=int)
    ap.add_argument("--all", action="store_true", help="fetch: quote every L1 survivor (skip the cheap pre-check)")
    a = ap.parse_args()
    if a.cmd == "logout":
        _kc_del("tokens"), _kc_del("client")
        print("removed Robinhood tokens from the Keychain")
        return
    if a.cmd == "status":
        print("logged in (tokens in Keychain)" if _kc_get("tokens") else "not logged in: run `rh_client.py login`")
        sys.exit(0 if _kc_get("tokens") else 2)
    if a.cmd == "login":
        async def ping(rh):
            return await rh.call("get_equity_quotes", {"symbols": ["SPY"]})
        r = asyncio.run(_with_session(True, ping))
        q = (r.get("data", r).get("results") or [{}])[0].get("quote", {})
        print(f"logged in. test quote SPY {q.get('last_trade_price')} @ {q.get('venue_last_trade_time')}")
        return
    import verify_plan as V
    with connect() as conn:
        pid = a.plan or V.latest_plan(conn)
        req = V.requests_for(conn, pid, a.all)
    print(f"plan #{pid}: fetching {len(req['options'])} contracts + {len(req['equities'])} stock quotes (skipped before quotes: {len(req['skipped_before_quotes'])})")
    payloads = asyncio.run(_with_session(False, lambda rh: _fetch(rh, req)))
    with connect() as conn:
        for kind, payload in payloads.items():
            conn.execute("INSERT INTO watchlist_sync.rh_raw (plan_id, kind, payload) VALUES (%s, %s, %s)", (pid, kind, json.dumps(payload)))
        conn.commit()
        V.cmd_evaluate(conn, pid)


if __name__ == "__main__":
    main()
