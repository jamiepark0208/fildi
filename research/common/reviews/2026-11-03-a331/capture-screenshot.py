#!/usr/bin/env python3
"""A331 P2 acceptance — Backtest Lab answer + firing today (headless Playwright)."""
from __future__ import annotations

import json
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
OUT = REPO / "research/common/reviews/2026-11-03-a331"
STATE = Path.home() / ".fildi/playwright-state.json"


def stub_routes(page, base: str) -> None:
    summary = {
        "preset": "put_climax_spy_oversold",
        "vsAnyDay": {
            "breachSig": 0.009,
            "breachBase": 0.111,
            "excessMean": 0.006,
            "n": 113,
            "nMonths": 33,
            "meanBase": 0.001,
        },
        "verdict": "PASS",
        "pnlUnit": "per_$collateral",
        "firingToday": ["AAPL", "MSFT", "NVDA"],
        "pricing": {"badge": "model-priced", "note": "Historical runs use Black-Scholes at IV (V1)."},
    }
    run_id = "00000000-0000-4000-8000-000000000001"

    page.route(
        "**/api/auth/me",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {"id": 1, "email": "e2e@local.dev", "username": "e2e", "role": "admin", "avatarUrl": None}
            ),
        ),
    )
    page.route(
        "**/api/backtest/run",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"runId": run_id, "paramHash": "stub", "cached": True}),
        ),
    )
    page.route(
        f"**/api/backtest/runs/{run_id}",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"id": run_id, "summary": summary, "holdout_unlocked": False}),
        ),
    )
    page.route(
        "**/api/backtest/runs/*/trades",
        lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"trades": []})),
    )
    page.route(
        "**/api/backtest/catalog",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "presets": {
                        "put_climax_spy_oversold": {
                            "title": "S151 sell put — up climax + SPY RSI bottom Q",
                            "delta": 0.08,
                            "instrument": "sell_put",
                            "entry": "next_open",
                        }
                    }
                }
            ),
        ),
    )


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed (research/crawl/.venv)", file=sys.stderr)
        return 2

    OUT.mkdir(parents=True, exist_ok=True)
    base = "http://localhost:8081"
    out = OUT / "backtest-lab-1440.png"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_kwargs: dict = {"viewport": {"width": 1440, "height": 900}}
        if STATE.is_file():
            ctx_kwargs["storage_state"] = str(STATE)
        ctx = browser.new_context(**ctx_kwargs)
        page = ctx.new_page()
        if not STATE.is_file():
            stub_routes(page, base)
        page.goto(f"{base}/backtest", wait_until="domcontentloaded")
        page.wait_for_selector('[data-testid="backtest-answer-line"]', timeout=120_000)
        page.wait_for_selector('[data-testid="backtest-firing-today"]', timeout=30_000)
        page.wait_for_timeout(800)
        page.locator('[data-testid="backtest-lab"]').screenshot(path=str(out))
        print(out.relative_to(REPO))
        ctx.close()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
