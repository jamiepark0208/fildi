#!/usr/bin/env python3
"""A315 acceptance screenshots — watchlist breakdown Outside values box."""
from __future__ import annotations

import sys
from pathlib import Path

def repo_root() -> Path:
    p = Path(__file__).resolve().parent
    for _ in range(8):
        if (p / ".local-admin-credentials").is_file():
            return p
        p = p.parent
    raise SystemExit("could not find repo root")


REPO = repo_root()
OUT = REPO / "research/common/reviews/2026-10-29-a315"
CREDS = REPO / ".local-admin-credentials"


def load_creds() -> tuple[str, str]:
    email = password = ""
    for line in CREDS.read_text().splitlines():
        if line.startswith("email="):
            email = line.split("=", 1)[1].strip()
        elif line.startswith("password="):
            password = line.split("=", 1)[1].strip()
    if not email or not password:
        raise SystemExit("missing .local-admin-credentials")
    return email, password


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed in this python", file=sys.stderr)
        return 2

    OUT.mkdir(parents=True, exist_ok=True)
    base = "http://localhost:8081"
    tickers = ["PLTR", "MSFT"]
    widths = [1440, 390]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for ticker in tickers:
            for w in widths:
                ctx = browser.new_context(viewport={"width": w, "height": 900})
                page = ctx.new_page()

                def stub_me(route):
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body='{"id":1,"email":"e2e@local.dev","username":"e2e","role":"admin","avatarUrl":null}',
                    )

                page.route("**/api/auth/me", stub_me)
                page.goto(f"{base}/watchlist?ticker={ticker}", wait_until="networkidle")
                page.wait_for_selector('[data-testid="outside-values-box"]', timeout=90_000)
                page.wait_for_timeout(2000)
                out = OUT / f"{ticker.lower()}-breakdown-{w}.png"
                box = page.locator('[data-testid="outside-values-box"]')
                box.screenshot(path=str(out))
                print(out.relative_to(REPO))
                ctx.close()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
