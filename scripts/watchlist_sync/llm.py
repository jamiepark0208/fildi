"""One Claude wrapper for the Python pipelines (E8, 10-30) — the twin of artifacts/api-server/src/lib/haiku.ts.

Model ids, prices and the per-model 'thinking off' request come from ONE file, artifacts/api-server/src/lib/llm-models.json
(also read by ai-pricing.ts / haiku.ts), so a model change is one edit for both stacks. Official SDK (retries 408/409/429/5xx,
timeout); every call is buffered with its real model and flushed to ai_usage_log (Settings › API Monitor › AI spend).

    import llm
    text = llm.ask("…", tier="haiku", ticker="AAPL", surface="transcripts", max_tokens=400)
    llm.flush(conn)        # once per run
"""
from __future__ import annotations

import json
import os
from pathlib import Path

REGISTRY = json.loads((Path(__file__).resolve().parents[2] / "artifacts/api-server/src/lib/llm-models.json").read_text())
TIERS: dict[str, str] = REGISTRY["tiers"]
_client = None
USAGE: list[tuple[str, str, str, int, int]] = []   # (surface, ticker, model, in, out)


def model_id(tier_or_model: str) -> str:
    return TIERS.get(tier_or_model, tier_or_model)


def _anthropic():
    global _client
    if _client is None:
        import anthropic
        if not os.environ.get("ANTHROPIC_API_KEY"):
            from dotenv import load_dotenv   # .env.local, same files build_plan.connect() loads
            root = Path(__file__).resolve().parents[2]
            for p in (root / ".env.local", root / ".env"):
                if p.is_file():
                    load_dotenv(p, override=False)
        _client = anthropic.Anthropic(timeout=120, max_retries=2)
    return _client


def ask(prompt: str, tier: str = "haiku", *, max_tokens: int = 400, effort: str | None = "low", think: bool = False,
        ticker: str = "_", surface: str = "pipeline") -> str:
    """One user turn → text. think=False sends the model's own 'thinking off' (Haiku 5.5 disabled, Sonnet 5.5 between_tools,
    both need effort ≤ high); models that can't turn it off just run at the given effort."""
    m = model_id(tier)
    spec = REGISTRY["models"].get(m, {})
    kw: dict = {}
    if not think and spec.get("thinking_off"):
        kw["thinking"] = spec["thinking_off"]
    if effort and m != "claude-haiku-4-5":
        kw["output_config"] = {"effort": effort}
    r = _anthropic().messages.create(model=m, max_tokens=max_tokens, messages=[{"role": "user", "content": prompt}], **kw)
    USAGE.append((surface, ticker, m, r.usage.input_tokens or 0, r.usage.output_tokens or 0))
    if r.stop_reason == "refusal":
        return ""
    return "".join(b.text for b in r.content if b.type == "text").strip()


def flush(conn) -> int:
    """Buffered calls → ai_usage_log with the model that actually ran (10-30: Sonnet notes were logged as Haiku)."""
    n = len(USAGE)
    for surface, ticker, m, i, o in USAGE:
        conn.execute("""INSERT INTO ai_usage_log (user_id, ticker, surface_type, cached, input_tokens, output_tokens, model)
                        VALUES (NULL, %s, %s, false, %s, %s, %s)""", (ticker, surface, i, o, m))
    USAGE.clear()
    return n


def cost_usd(model: str, i: int, o: int) -> float:
    p = REGISTRY["models"].get(model_id(model)) or REGISTRY["models"][REGISTRY["legacy_model"]]
    return (i * p["input"] + o * p["output"]) / 1e6
