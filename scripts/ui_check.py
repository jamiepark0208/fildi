#!/usr/bin/env python3
"""Headless UI check for the local app (Vite :8081): log in from .agent-login, open pages, screenshot,
report console errors + HTTP >= 400. Run with any python: re-execs into ~/.fildi/pw-venv (built on first use).

  ui_check.py /watchlist?ticker=HOOD /live /rankings --out <dir> [--wait 8000] [--width 1500]
"""
import argparse, os, subprocess, sys

# Durable venv (Jamie 11-16: no per-session reinstall). Any python works: re-exec into ~/.fildi/pw-venv, building it once.
PW_VENV = os.path.expanduser("~/.fildi/pw-venv")
try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError:
    py = os.path.join(PW_VENV, "bin", "python")
    if os.path.realpath(sys.prefix) == os.path.realpath(PW_VENV):  # venv python symlinks to the system one; compare prefix
        sys.exit("playwright missing inside ~/.fildi/pw-venv — rm -rf it and re-run")
    if not os.path.exists(py):
        print("ui_check: building ~/.fildi/pw-venv (one time)…", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", PW_VENV], check=True)
        subprocess.run([py, "-m", "pip", "-q", "install", "playwright"], check=True)
        subprocess.run([py, "-m", "playwright", "install", "chromium"], check=True)
    os.execv(py, [py, os.path.abspath(__file__), *sys.argv[1:]])

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
    ap.add_argument("--click", action="append", default=[], help="button/tab text to click after load (repeatable)")
    ap.add_argument("--el", help="CSS selector: screenshot just this element (scrolled into view)")
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
            pg.on("response", lambda resp: bad.append(resp) if resp.status >= 400 else None)
            pg.goto(BASE + path)
            pg.wait_for_timeout(a.wait)
            for txt in a.click:
                pg.get_by_text(txt, exact=True).first.click()
                pg.wait_for_timeout(2500)
            name = path.strip("/").replace("/", "_").replace("?", "_").replace("=", "-").replace("&", "_") or "home"
            shot = os.path.join(a.out, f"{name}.png")
            if a.el:
                pg.locator(a.el).first.screenshot(path=shot)
            else:
                pg.screenshot(path=shot, full_page=False)
            print(f"{path}: {len(errs)} console errors · {len(bad)} HTTP>=400 · {shot}")
            for e in errs[:6]:
                print("   err", e[:200])
            for x in bad[:6]:
                try:
                    body = x.text()[:200].replace("\n", " ")
                except Exception:
                    body = ""
                rq = x.request
                print("   http", f"{x.status} {rq.method} {x.url}"[:160], "·", body)
                if rq.method != "GET" and rq.post_data:
                    print("     body sent:", rq.post_data[:300])
            pg.close()
        b.close()


if __name__ == "__main__":
    main()
