#!/usr/bin/env python3
"""Dead-path check for agent instruction docs (11-03 token audit).

Agents trust paths written in CLAUDE.md / AGENTS.md / adapters / skills / context files; a path
that no longer exists sends them grepping (tokens) or inventing (hallucination).
Usage: python3 scripts/doc_paths_check.py [--all]   (--all also scans research/common/*.md)
Exit 1 when any dead path is found.
"""
import re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ["CLAUDE.md", "AGENTS.md", "CURSOR.md", "CODEX.md", "MUSE.md", "GROK.md",
        ".agents/AGENTS.md", ".agents/context/*.md", ".claude/skills/*.md", ".cursor/rules/*.mdc",
        ".agents/skills/*/SKILL.md", ".cursor/skills/*/SKILL.md", "research/studies/PLAYBOOK.md"]
PAT = re.compile(r"(?:`|\]\()((?:\.{0,2}/)?(?:\.?[A-Za-z0-9_-]+/)+[A-Za-z0-9_.*<>{}-]+\.(?:mdc|md|py|tsx|ts|mjs|json|js|sh|sql))(?![A-Za-z])")


def main() -> int:
    globs = DOCS + (["research/common/*.md"] if "--all" in sys.argv else [])
    tracked = set(subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True).stdout.split())
    dead = 0
    for g in globs:
        for doc in sorted(ROOT.glob(g)):
            for m in PAT.finditer(doc.read_text(errors="ignore")):
                p = m.group(1)
                if any(c in p for c in "*<>{}") or p.startswith(("~", "/")):
                    continue
                cands = [(doc.parent / p).resolve(), (ROOT / p.removeprefix("./")).resolve()]
                if any(c.exists() for c in cands):
                    continue
                rel = p.removeprefix("./")
                if sum(t.endswith("/" + rel) for t in tracked) == 1:
                    continue  # unambiguous shorthand (e.g. analysis/lab.py)
                name = Path(p).name
                hint = next((t for t in tracked if t.endswith("/" + name) or t == name), "")
                print(f"{doc.relative_to(ROOT)}: {p}  → {'moved? ' + hint if hint else 'gone'}")
                dead += 1
    print(f"dead paths: {dead}")
    return 1 if dead else 0


if __name__ == "__main__":
    sys.exit(main())
