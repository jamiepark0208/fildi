#!/usr/bin/env python3
"""Revisit checker (Jamie 11-07): parked / declined ASKS rows and BOARD dead rows must not sit forever.

Each parked or declined ask file carries one machine line:
    **Revisit-when:** ask A364 verified ; date 2026-11-11 ; study S159 ; manual
Conditions are OR'd:
    ask A### <word>   met when that row's status (ASKS.md or ASKS-archive.md) starts with <word> (done/verified/...)
    date YYYY-MM-DD   met on/after that day
    study S###        met when the S### row in research/studies/INDEX.md changed after the trigger line was written
    manual            never auto (Jamie or an agent reopens by hand)
Met → parked row goes back to `planned`; declined row comes back from the archive as `re-review` (owner re-judges).
BOARD.md Dead rows carry a Re-check cell (date or `cost`); a date on/before today is listed as a re-screen due.

    python3 scripts/asks_revisit.py            # report only
    python3 scripts/asks_revisit.py --apply    # flip statuses + note the ask file (agent_start runs this)
"""
import datetime as dt, os, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
R = ROOT / "research/common"
TODAY = dt.date.today()
ROW = re.compile(r"^\| \[(A\d+)\]\(asks/A\d+\.md\) \|")


def w(p: Path, txt: str) -> None:
    fd, t = tempfile.mkstemp(dir=p.parent); os.write(fd, txt.encode()); os.close(fd); os.replace(t, p)


def git_day(*args: str) -> str:
    return subprocess.run(["git", "log", "-1", "--format=%cs", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def main() -> None:
    apply = "--apply" in sys.argv
    idx = (R / "ASKS.md").read_text().split("\n")
    arch = (R / "ASKS-archive.md").read_text().split("\n")
    status = {}
    for ln in arch + idx:  # index wins over archive
        m = ROW.match(ln)
        if m: status[m.group(1)] = ln.split("|")[5].strip()
    met, missing = [], []
    for aid, st in status.items():
        kind = "parked" if st.startswith("parked") else "declined" if st.startswith("declined") else None
        if not kind: continue
        f = R / "asks" / f"{aid}.md"
        txt = f.read_text() if f.exists() else ""
        m = None
        for m in re.finditer(r"\*\*Revisit-when:\*\*\s*(.+)", txt): pass
        if not m:
            if kind == "parked": missing.append(aid)
            continue
        since = git_day("-S", m.group(0), "--", str(f.relative_to(ROOT))) or "2000-01-01"
        hit = None
        for c in [c.strip() for c in m.group(1).split(";")]:
            p = c.split()
            if not p: continue
            if p[0] == "ask" and len(p) >= 3 and status.get(p[1], "").startswith(p[2]): hit = c
            elif p[0] == "date" and len(p) >= 2 and p[1] <= TODAY.isoformat(): hit = c
            elif p[0] == "study" and len(p) >= 2:
                d = git_day(f"-G^\\| {p[1]} \\|", "--", "research/studies/INDEX.md")
                if d and d > since: hit = f"{c} changed {d}"
            if hit: break
        if hit: met.append((aid, kind, hit))
    # BOARD dead rows: | Idea | Why | Study | Kind | Re-check |
    due = []
    board = (ROOT / "research/studies/BOARD.md").read_text().split("\n")
    sec = ""
    for ln in board:
        if ln.startswith("## "): sec = ln
        if sec.startswith("## Dead") and ln.startswith("| ") and not ln.startswith("| Idea") and not ln.startswith("|---"):
            cells = [c.strip() for c in ln.strip("|").split("|")]
            if len(cells) >= 5 and re.match(r"\d{4}-\d{2}-\d{2}$", cells[4]) and cells[4] <= TODAY.isoformat():
                due.append(f"{cells[2]} ({cells[0][:40]})")
    idx_ids = {ROW.match(ln).group(1) for ln in idx if ROW.match(ln)}
    arch_dupes = {ROW.match(ln).group(1) for ln in arch if ROW.match(ln) and ROW.match(ln).group(1) in idx_ids}
    if apply and (met or arch_dupes):
        note = f"Revisit met {TODAY}"
        moved = {a for a, k, _ in met if k == "declined"}
        out, back = [], []
        for ln in idx:
            m = ROW.match(ln)
            if m and any(m.group(1) == a and k == "parked" for a, k, _ in met):
                c = ln.split("|"); hit = next(h for a, _, h in met if a == m.group(1))
                c[5] = f" planned ({note}: {hit}) "; ln = "|".join(c)
            out.append(ln)
        out_ids = {ROW.match(x).group(1) for x in out if ROW.match(x)}
        keep = []
        for ln in arch:
            m = ROW.match(ln)
            if m:
                aid = m.group(1)
                if aid in out_ids:
                    # Stuck duplicate (already in ASKS.md): drop stale archive copy so CI check-asks-index stays green.
                    continue
                if aid in moved:
                    c = ln.split("|"); hit = next(h for a, _, h in met if a == aid)
                    c[5] = f" re-review ({note}: {hit}) "; back.append("|".join(c)); continue
            keep.append(ln)
        if back:
            last = max(i for i, x in enumerate(out) if ROW.match(x))
            out[last + 1:last + 1] = back
        out_status = {ROW.match(x).group(1): x.split("|")[5].strip() for x in out if ROW.match(x)}
        w(R / "ASKS.md", "\n".join(out)); w(R / "ASKS-archive.md", "\n".join(keep))
        for a in {a for a, _, _ in met} | arch_dupes:
            f = R / "asks" / f"{a}.md"
            if not f.exists(): continue
            txt = f.read_text()
            if a in out_status:
                txt = re.sub(r"(\*\*Status:\*\*\s*)([^\n]+)", lambda m_st: m_st.group(1) + out_status[a], txt, count=1)
            hit_tup = next(((k, h) for aid, k, h in met if aid == a), None)
            if hit_tup:
                k, h = hit_tup
                txt = txt.rstrip("\n") + f"\n\n**{note}:** `{h}` → {'planned' if k == 'parked' else 're-review (owner re-judges; decline again only with a new reason)'}.\n"
            w(f, txt)
    print(f"revisit: {len(met)} met" + (" — " + ", ".join(f"{a} {k}→{'planned' if k == 'parked' else 're-review'} ({h})" for a, k, h in met) if met else "")
          + (" (applied)" if apply and met else "")
          + f" · parked w/o trigger: {', '.join(missing) or '—'}"
          + f" · dead re-screen due: {', '.join(due) or '—'}")


if __name__ == "__main__":
    main()
