"""On-demand research fetcher (A123 v4, Jamie 10-16): web page → clean markdown, local only.

Default: cache to $TMPDIR/fildi-fetch/ and print path + stats (not the text).
--save: keep it in research/sources/<domain>/<slug>.md (only pages worth keeping — cited by a study / ASKS row).
--deep N: same-domain BFS, up to N extra pages, 1 req/s. No LLM extraction, no API keys.

    scripts/fetch-page.sh <url> [<url> ...] [--deep N] [--save] [--max-chars N] [--print]
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.content_filter_strategy import PruningContentFilterLXML
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "research" / "sources"
CACHE = Path(os.environ.get("TMPDIR", "/tmp")) / "fildi-fetch"
TIMEOUT_MS = 30_000
SKIP_EXT = (".zip", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js", ".json", ".xml", ".gz", ".mp4")


def slug(url: str) -> str:
    p = urlparse(url)
    s = re.sub(r"[^A-Za-z0-9]+", "-", (p.path + ("-" + p.query if p.query else "")).strip("/")).strip("-")
    return (s or "index")[:120]


def run_config() -> CrawlerRunConfig:
    md = DefaultMarkdownGenerator(content_filter=PruningContentFilterLXML(threshold=0.45, threshold_type="dynamic"))
    return CrawlerRunConfig(cache_mode=CacheMode.BYPASS, markdown_generator=md, page_timeout=TIMEOUT_MS,
                            excluded_tags=["nav", "footer", "header", "aside", "form"], remove_overlay_elements=True, verbose=False)


def best_markdown(res) -> str:
    m = res.markdown
    fit = getattr(m, "fit_markdown", None) or ""
    raw = getattr(m, "raw_markdown", None) or (m if isinstance(m, str) else "")
    # fit_markdown drops boilerplate; fall back to raw when pruning ate the page (tables, filings)
    return fit if len(fit) >= 0.2 * len(raw) and fit.strip() else raw


def same_domain_links(res, base: str) -> list[str]:
    host = urlparse(base).netloc
    out = []
    for link in (res.links or {}).get("internal", []):
        href = link.get("href") if isinstance(link, dict) else link
        if not href:
            continue
        u = urldefrag(urljoin(base, href))[0]
        if urlparse(u).path.lower().endswith(SKIP_EXT):
            continue
        if urlparse(u).netloc == host and u.startswith(("http://", "https://")):
            out.append(u)
    return out


def write(url: str, title: str, text: str, save: bool) -> Path:
    d = (SOURCES if save else CACHE) / urlparse(url).netloc
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{slug(url)}.md"
    head = f"<!-- url: {url}\nfetched_at: {datetime.now(timezone.utc).isoformat(timespec='seconds')}\ntitle: {title} -->\n\n"
    p.write_text(head + text)
    return p


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--deep", type=int, default=0)
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--max-chars", type=int, default=0, help="print up to N chars of the text (0 = stats only)")
    args = ap.parse_args()

    failed = 0
    async with AsyncWebCrawler(config=BrowserConfig(headless=True, verbose=False)) as crawler:
        for start in args.urls:
            queue, seen, fetched = deque([start]), {start}, 0
            while queue and fetched <= args.deep:
                url = queue.popleft()
                if fetched:
                    await asyncio.sleep(1.0)  # polite on deep crawls
                res = await crawler.arun(url=url, config=run_config())
                fetched += 1
                if not res.success:
                    failed += 1
                    print(f"FAIL {url}: {(res.error_message or '')[:160]}")
                    continue
                text = best_markdown(res)
                title = (res.metadata or {}).get("title") or ""
                p = write(url, title, text, args.save)
                print(f"{'saved' if args.save else 'cached'} {p}  chars={len(text)} words={len(text.split())}  {title[:70]}")
                if args.max_chars:
                    print(text[: args.max_chars])
                if args.deep:
                    for u in same_domain_links(res, url):
                        if u not in seen:
                            seen.add(u)
                            queue.append(u)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
