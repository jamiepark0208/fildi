#!/usr/bin/env python3
"""Context-rot guard (A381 Part C, Jamie 11-08: "we keep adding new docs, never clean up").

Checks the agent-context markdown (not code, not asks, not generated logs):
  1. orphans  — a context/skill doc that no entry file (AGENTS/CLAUDE/CURSOR/... or INDEX.md) links to,
                directly or one hop away. Unreachable docs are never read on purpose, only stumbled on.
  2. restated — a known rule phrase written out in > MAX_HOMES rule files (should live once + links).
  3. budget   — total chars of always/likely-loaded context.
Advisory by default (exit 0); --strict exits 1 on any finding. Archive: .agents/archive/<date>/ (excluded).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ["AGENTS.md", "CLAUDE.md", "CURSOR.md", "CODEX.md", "MUSE.md", "GROK.md", ".agents/AGENTS.md",
         ".agents/context/INDEX.md", ".agents/context/state.md", ".cursor/context/cursor-state.md"]
SCAN = [".agents/context", ".agents/skills", ".claude/skills", ".cursor/rules", ".agents/rules"]
SKIP = ("/archive", "/sessions", "/ai-workflow-reviews/", "/plans/")
# Rule docs where a rule should live exactly once. Skills may link to a rule, not restate it.
RULE_FILES = [  # .agents/rules.md excluded: one-line UI mirror of AGENTS.md by design
              ".agents/context/jamie-rules.md", ".agents/context/agentic-floors.md",
              ".agents/AGENT_OPS.md", ".cursor/rules/lessons-learned.mdc",
              "research/studies/PLAYBOOK.md", "research/studies/REVIEW.md", ".agents/dispatch/_study-contract.md",
              ".agents/skills/fildi-quant-research/SKILL.md"]
PHRASES = {"T-bill comparator": r"(comparator|same.risk).*t-?bill", "23 % fill": r"23\s?%", "placebo": r"placebo",
           "one home per logic": r"one home per", "train/test split": r"train\s?/\s?test"}
MAX_HOMES = 2  # one home + one pointer is fine
BUDGET_CHARS = 70_000  # ratchet: 11-08 77k → 69k after state.md trim (entry files + INDEX + state). Lower it after each trim, never raise.


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def main() -> int:
    strict = "--strict" in sys.argv
    entry_txt = {e: _read(ROOT / e) for e in ENTRY if (ROOT / e).exists()}
    docs = sorted(p for d in SCAN if (ROOT / d).exists() for p in (ROOT / d).rglob("*")
                  if p.suffix in (".md", ".mdc") and not any(s in str(p) for s in SKIP))
    rel = {p: str(p.relative_to(ROOT)) for p in docs}

    def linked(r: str, texts) -> bool:
        name = Path(r).name
        stem_dir = str(Path(r).parent) + "/"  # a link to the skill folder counts for its SKILL.md
        return any(r in t or (name != "SKILL.md" and name in t) or (name == "SKILL.md" and stem_dir.rstrip("/") in t)
                   for t in texts)

    hop1 = {r for p, r in rel.items() if r in entry_txt or linked(r, entry_txt.values())}
    hop1_txt = [_read(ROOT / r) for r in hop1]
    orphans = [r for r in rel.values() if r not in hop1 and r not in entry_txt and not linked(r, hop1_txt)
               and not r.endswith(("README.md", "INDEX.md"))]

    restated = []
    rule_txt = {f: _read(ROOT / f).lower() for f in RULE_FILES if (ROOT / f).exists()}
    for label, pat in PHRASES.items():
        # a line that links the contract is a pointer, not a restatement
        homes = [f for f, t in rule_txt.items()
                 if any(re.search(pat, ln) and "study-contract" not in ln and "study contract" not in ln
                        for ln in t.splitlines())]
        if len(homes) > MAX_HOMES:
            restated.append((label, homes))

    budget = sum(len(t) for t in entry_txt.values())
    print(f"context_lint: {len(docs)} docs scanned · {len(orphans)} orphan · {len(restated)} restated rule · "
          f"entry+INDEX {budget/1000:.0f}k chars (budget {BUDGET_CHARS/1000:.0f}k)")
    for r in orphans[:15]:
        print(f"  orphan   {r}  → link from INDEX.md or move to .agents/archive/")
    for label, homes in restated:
        print(f"  restated '{label}' in {len(homes)} rule files: {', '.join(Path(h).name for h in homes)} → keep one home, link the rest")
    if budget > BUDGET_CHARS:
        print(f"  budget   entry files {budget/1000:.0f}k > {BUDGET_CHARS/1000:.0f}k → trim state.md / move detail out of adapters")
    bad = bool(orphans or restated or budget > BUDGET_CHARS)
    return 1 if (strict and bad) else 0


if __name__ == "__main__":
    sys.exit(main())
