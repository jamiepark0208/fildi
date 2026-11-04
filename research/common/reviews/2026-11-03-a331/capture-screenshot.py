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
FIXTURE = OUT / "backtest-run-fixture.json"
STATE = Path.home() / ".fildi/playwright-state.json"


def load_runner_fixture() -> tuple[dict, list]:
    if not FIXTURE.is_file():
        raise SystemExit(
            f"missing {FIXTURE.relative_to(REPO)} — run: "
            'cd scripts/watchlist_sync && .venv/bin/python analysis/backtest_lab.py run '
            '\'--json\' \'{"preset":"put_climax_spy_oversold","start":"2023-01-01","end":"2024-12-31"}\' '
            f"> {FIXTURE.relative_to(REPO)}"
        )
    raw = json.loads(FIXTURE.read_text())
    summary = raw["summary"]
    trades = raw.get("trades") or []
    return summary, trades


def stub_routes(page, base: str) -> None:
    summary, trades = load_runner_fixture()
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
            body=json.dumps({"runId": run_id, "paramHash": "fixture", "cached": True}),
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
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"trades": trades})
        ),
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
