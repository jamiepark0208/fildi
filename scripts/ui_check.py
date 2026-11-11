#!/usr/bin/env python3
"""Headless UI check for the local app (Vite :8081): log in from .agent-login, open pages, screenshot,
report console errors + HTTP >= 400. Needs a venv with `pip install playwright && playwright install chromium`.

  ui_check.py /watchlist?ticker=HOOD /live /rankings --out <dir> [--wait 8000] [--width 1500]
"""
import argparse, os, sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://localhost:8081"


def creds() -> dict:
    out = {}
    for ln in open(os.path.join(ROOT, ".agent-login")):   # gitignored; never print values
        if "=" in ln:
            k, v = ln.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--wait", type=int, default=8000)
    ap.add_argument("--width", type=int, default=1500)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": a.width, "height": 1000})
        c = creds()
        r = ctx.request.post(f"{BASE}/api/auth/login", data={"email": c["email"], "password": c["password"]})
        if r.status != 200:
            print(f"login failed {r.status}"); sys.exit(2)
        for path in a.paths:
            pg = ctx.new_page()
            errs, bad = [], []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
            pg.on("response", lambda resp: bad.append(f"{resp.status} {resp.url}") if resp.status >= 400 else None)
            pg.goto(BASE + path)
            pg.wait_for_timeout(a.wait)
            name = path.strip("/").replace("/", "_").replace("?", "_").replace("=", "-").replace("&", "_") or "home"
            shot = os.path.join(a.out, f"{name}.png")
            pg.screenshot(path=shot, full_page=False)
            print(f"{path}: {len(errs)} console errors · {len(bad)} HTTP>=400 · {shot}")
            for e in errs[:6]:
                print("   err", e[:200])
            for x in bad[:6]:
                print("   http", x[:160])
            pg.close()
        b.close()


if __name__ == "__main__":
    main()
