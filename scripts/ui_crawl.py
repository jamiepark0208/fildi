#!/usr/bin/env python3
"""Click-through crawler for the local app (Vite :8081). ui_check.py only sees page-load errors; this clicks
every safe button / tab / expandable row (≤ 3 per label at level 1, 1 at level 2) and logs console errors,
page errors and /api HTTP >= 400 against the click that caused them. Destructive labels are skipped (SKIP).

  ui_crawl.py                      # default top tabs
  ui_crawl.py /rankings /macro --max-clicks 200

Runs pages SEQUENTIALLY on purpose: parallel crawls trip the API rate limiter (429) and report noise.
Exit 1 when any non-noise error is found (429s are listed but not counted).
"""
import argparse, os, re, sys

PW_VENV = os.path.expanduser("~/.fildi/pw-venv")
try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError:  # same durable venv as ui_check.py (built there on first use)
    py = os.path.join(PW_VENV, "bin", "python")
    if not os.path.exists(py) or os.path.realpath(sys.prefix) == os.path.realpath(PW_VENV):
        sys.exit("playwright venv missing — run scripts/ui_check.py once to build ~/.fildi/pw-venv")
    os.execv(py, [py, os.path.abspath(__file__), *sys.argv[1:]])

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ui_check import BASE, creds  # noqa: E402

DEFAULT_PATHS = ["/", "/today", "/watchlist", "/rankings", "/portfolio", "/live", "/macro", "/settings"]
SKIP = re.compile(r"delete|remove|sign ?out|log ?out|import|upload|save|place|send|submit|clear|reset|dismiss|approve|"
                  r"decline|run |refresh|restart|purge|apply|retry|×|✕|add to|logout|cancel order|exercise|fetch now|"
                  r"rebuild|drain|backfill|force", re.I)
SEL = ("button:visible, [role=tab]:visible, tr:visible:has(svg.lucide-chevron-down), [class*=cursor-pointer]:visible, "
       "summary:visible, [aria-expanded]:visible")
NOISE = re.compile(r"HTTP 429")


def crawl(ctx, path: str, max_clicks: int) -> tuple[int, list]:
    pg = ctx.new_page()
    cur, errs = {"label": "load"}, []
    pg.on("console", lambda m: m.type == "error" and errs.append((path, cur["label"], "console", m.text[:220])))
    pg.on("pageerror", lambda e: errs.append((path, cur["label"], "PAGEERROR", str(e)[:220])))
    pg.on("response", lambda r: r.status >= 400 and "/api/" in r.url
          and errs.append((path, cur["label"], f"HTTP {r.status}", r.url.replace(BASE, "")[:160])))
    pg.goto(BASE + path)
    pg.wait_for_timeout(5000)
    seen, clicks, home = {}, 0, BASE + path.split("?")[0]
    for level in range(2):
        for i in range(min(pg.locator(SEL).count(), 200)):
            if clicks >= max_clicks:
                break
            try:
                e = pg.locator(SEL).nth(i)
                t = (e.inner_text(timeout=400) or e.get_attribute("aria-label") or "").strip().replace("\n", " ")[:40]
            except Exception:
                continue
            if not t or SKIP.search(t) or seen.get(t, 0) >= (3 if level == 0 else 1):
                continue
            seen[t] = seen.get(t, 0) + 1
            cur["label"] = f"{t}#{seen[t]}"
            try:
                e.click(timeout=1500)
                clicks += 1
                pg.wait_for_timeout(1300)
                if not pg.url.startswith(home):  # a click navigated away → come back
                    pg.goto(BASE + path)
                    pg.wait_for_timeout(3000)
            except Exception:
                pass
    pg.close()
    return clicks, errs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*", default=DEFAULT_PATHS)
    ap.add_argument("--max-clicks", type=int, default=140)
    a = ap.parse_args()
    out = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1500, "height": 1000})
        c = creds()
        r = ctx.request.post(f"{BASE}/api/auth/login", data={"email": c["email"], "password": c["password"]})
        if r.status != 200:
            sys.exit(f"login failed {r.status}")
        for path in a.paths:
            clicks, errs = crawl(ctx, path, a.max_clicks)
            print(f"{path}: {clicks} clicks, {len(errs)} errors", flush=True)
            out += errs
        b.close()
    grouped: dict = {}
    for pth, lab, kind, msg in out:  # one line per distinct error, with the clicks that caused it
        grouped.setdefault((pth, kind, re.sub(r"\d+", "#", msg)[:120]), []).append(lab)
    real = 0
    for (pth, kind, msg), labs in grouped.items():
        noise = bool(NOISE.search(kind))
        real += not noise
        print(f"{'(noise) ' if noise else ''}{pth} | {kind} | {msg} | after: {', '.join(dict.fromkeys(labs))[:120]}")
    print(f"{real} distinct errors ({len(grouped) - real} noise)")
    sys.exit(1 if real else 0)


if __name__ == "__main__":
    main()
