"""Company profiles for peer-group checks (10-27 universe audit): LSEG business summary + TRBC industry / activity.

Feeds scripts/watchlist_sync/peer_verify.py (OpenJev + co-movement + TRBC vote). One get_data call per 100 names, cached
in research/openjev/controls/profiles_lseg.json (only names not cached are fetched).

    LSEG_PRIORITY=1 .venv/bin/python peer_profiles.py                 # universe names without a reviewed mapping
    LSEG_PRIORITY=1 .venv/bin/python peer_profiles.py --tickers A,B
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _session import clean, connect_local, load_ric_map, lseg_session
from universe_review import TRBC_GROUP

OUT = Path(__file__).resolve().parents[1] / "openjev" / "controls" / "profiles_lseg.json"
FIELDS = ["TR.CommonName", "TR.TRBCIndustryGroup", "TR.TRBCActivity", "TR.HeadquartersCountry", "TR.BusinessSummary"]


def unreviewed(conn) -> list[str]:
    """Active universe names whose peer group is not from the seed taxonomy or a manual override."""
    return [r[0] for r in conn.execute("""
        SELECT r.ticker FROM ticker_registry r
        LEFT JOIN peer_group_members m ON m.ticker = r.ticker AND m.group_id = r.primary_peer_group_id AND m.removed_at IS NULL
        WHERE r.is_active AND r.fetch_fundamentals AND COALESCE(m.source, 'none') NOT IN ('taxonomy', 'manual')
          AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE o.ticker = r.ticker)
        ORDER BY 1""")]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tickers")
    a = p.parse_args()
    cache = json.loads(OUT.read_text()) if OUT.exists() else {}
    with connect_local() as conn:
        tickers = a.tickers.upper().split(",") if a.tickers else unreviewed(conn)
    todo = [t for t in tickers if t not in cache]
    ric = load_ric_map(todo)
    rics = {ric[t]: t for t in todo if t in ric}
    print(f"{len(tickers)} names, {len(todo)} to fetch ({len(rics)} with a RIC)")
    with lseg_session() as ld:
        keys = list(rics)
        for i in range(0, len(keys), 100):
            df = ld.get_data(keys[i:i + 100], FIELDS)
            for _, r in df.iterrows():
                t = rics.get(r["Instrument"])
                if not t:
                    continue
                ind = clean(r.get("TRBC Industry Group Name"))
                cache[t] = {"companyName": clean(r.get("Company Common Name")), "industry": ind,
                            "activity": clean(r.get("TRBC Activity Name")), "country": clean(r.get("Country of Headquarters")),
                            "description": clean(r.get("Business Description")), "trbc_group": TRBC_GROUP.get(ind or "")}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(cache))
    got = [t for t in tickers if (cache.get(t) or {}).get("description")]
    print(f"cached {len(cache)}; {len(got)}/{len(tickers)} requested names have a description → {OUT}")


if __name__ == "__main__":
    main()
