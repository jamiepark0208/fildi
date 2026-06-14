---
name: replit-setup
description: One-time setup. Run this the very first Claude Code session.
---
## Step 1 — Install ECC plugin (type these inside Claude Code, not bash)
  /plugin marketplace add https://github.com/affaan-m/everything-claude-code
  /plugin install ecc@ecc

## Step 2 — Install markitdown
  pip install markitdown --break-system-packages

## Step 3 — Wire hooks
  cp .claude/hooks/hooks.json ~/.claude/hooks.json

## Step 4 — Verify
  node .claude/scripts/rehydrate.js

## Step 6 — Add Replit Secrets (in Replit sidebar → lock icon)
  DATABASE_URL  = (from Replit PostgreSQL add-on)
  REDIS_URL     = (from Upstash — https://upstash.com, free tier)
