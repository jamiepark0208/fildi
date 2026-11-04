"""Build a watchlist plan from Fildi's data with L1 (Fildi-data) checks → watchlist_sync.plans / plan_items.

Phase 1 lists: sell_puts, sell_calls (covered only), trim_risk. Nothing is written to Robinhood here.
Every candidate is stored with all its checks (pass or fail), so rejected ideas are explainable too.

Usage: .venv/bin/python build_plan.py [--show-rejected]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

import psycopg
from dotenv import load_dotenv

import rules as R

from build_plan_parts.build_run import build
from build_plan_parts.checks import option_checks, trim_checks
from build_plan_parts.context import (
    PANIC_MAX_PER_GROUP,
    PANIC_STRATEGY,
    carry_forward_puts,
    engine_pool_puts,
    load_context,
    panic_recs,
    prior_published_puts,
    put_context,
    put_far_reason,
    reprice_from_chains,
    restrike_puts,
)
from build_plan_parts.db import ROOT, chk, connect, ensure_schema, rows

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--show-rejected", action="store_true")
    build(ap.parse_args().show_rejected)
