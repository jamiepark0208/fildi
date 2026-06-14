---
name: writing-plans
description: Use when planning any multi-step feature. Produces bite-sized task breakdown with exact files, code, commands, and commit points.
---

## Overview

Write comprehensive implementation plans. Document which files to touch, code, how to test, expected output. Bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

**Save plans to:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`

## Before Writing Tasks

Map out files to create/modify and their single responsibility. Files that change together live together. Prefer focused files over large ones.

## Task Granularity (2-5 min each)
- Write failing test → run to confirm failure → implement minimal fix → run to confirm pass → commit

## Plan Header (every plan must start with this)
```
# [Feature] Implementation Plan
**Goal:** one sentence
**Architecture:** 2-3 sentences
**Tech Stack:** key libs
---
```

## Task Structure
```
### Task N: Name
**Files:** Create/Modify/Test: exact/path/file.ts

- [ ] Write failing test (show actual test code)
- [ ] Run: exact command — Expected: FAIL with "..."
- [ ] Implement (show actual code)
- [ ] Run: exact command — Expected: PASS
- [ ] git commit -m "feat: ..."
```

## Rules
- No placeholders — every step has actual code and commands
- No "TBD", "handle edge cases", "similar to Task N"
- Types/method names must be consistent across all tasks
- After writing: check spec coverage, scan for placeholders, verify type consistency
