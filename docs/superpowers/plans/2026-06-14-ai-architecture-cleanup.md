# AI Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate broken/dead hooks, implement real prompt compression via Haiku API, and establish a single reliable source of truth for response style — across Claude Code, Kiro, and Cursor.

**Architecture:** Claude Code hooks are the only execution channel for behavioral rules. Instructions must live in CLAUDE.md (permanent load) or `settings.local.json` hooks (runtime injection). Kiro reads `.kiro/steering/` automatically. Cursor reads `.cursorrules` or `AGENTS.md`. The `.agents/` folder is the shared, read-only context store for all agents. Nothing else is automatically loaded by any IDE.

**Tech Stack:** Node.js hooks, Anthropic SDK (Haiku for compression), Claude Code `settings.local.json`, CLAUDE.md

---

## Architecture Map (what each file does after this plan)

| File | Owner | Purpose |
|---|---|---|
| `CLAUDE.md` | Claude Code | Permanent behavioral rules — always loaded |
| `.claude/settings.local.json` | Claude Code | Hooks wiring + permissions |
| `.claude/hooks/prompt-preprocessor.js` | Claude Code | UserPromptSubmit → Haiku compression → inject COMPRESSED_INTENT |
| `.claude/scripts/rehydrate.js` | Claude Code | Session state banner on every prompt (lean version) |
| `.claude/scripts/session-wrap.js` | Claude Code | Stop hook — writes state.json + session log only |
| `.agents/context/` | All agents | Shared read-only project/workflow/state context |
| `.agents/memory/` | All agents | Shared technical lessons |
| `.kiro/steering/` | Kiro only | Kiro behavioral rules (do not touch) |
| `.cursorrules` | Cursor only | Cursor behavioral rules (future) |

---

## Task 1: Remove context-monitor.js (dead hook)

**Files:**
- Modify: `.claude/settings.local.json` — remove PostToolUse block
- Modify: `.claude/hooks/context-monitor.js` — replace with no-op stub

The `PostToolUse` hook spawns a Node.js process after EVERY tool call. It reads `CONTEXT_TOKENS_USED` env var that Claude Code never sets. `pct` is always 0. The warning never fires. Pure overhead.

- [ ] **Step 1: Remove PostToolUse hook from settings.local.json**

In `.claude/settings.local.json`, delete the entire `"PostToolUse"` key and its value:
```json
"PostToolUse": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node /home/runner/workspace/.claude/hooks/context-monitor.js"
      }
    ]
  }
]
```

- [ ] **Step 2: Replace context-monitor.js with a no-op stub**

Replace the content of `.claude/hooks/context-monitor.js` with:
```js
#!/usr/bin/env node
// Retired — CONTEXT_TOKENS_USED env var is not set by Claude Code hooks.
// Removing from PostToolUse hook in settings.local.json.
process.exit(0);
```

- [ ] **Step 3: Verify settings.local.json is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8')); console.log('valid')"
```
Expected: `valid`

- [ ] **Step 4: Commit**

```bash
git add .claude/settings.local.json .claude/hooks/context-monitor.js
git commit -m "fix: remove broken context-monitor PostToolUse hook — CONTEXT_TOKENS_USED env var never set"
```

---

## Task 2: Remove redundant codegraph sync from rehydrate.js

**Files:**
- Modify: `.claude/scripts/rehydrate.js` — remove `codegraph sync` call, keep status display

Codegraph has its own file watcher that updates the index within ~1 second of any file change. Running `codegraph sync` on every user prompt is redundant and adds latency.

- [ ] **Step 1: Remove the sync call, keep status**

In `.claude/scripts/rehydrate.js`, find the codegraph block and change it from:
```js
execSync('codegraph sync', { cwd:ROOT, stdio:'ignore' });
const status = execSync('codegraph status 2>/dev/null', { cwd:ROOT }).toString();
```
To (remove just the sync line):
```js
const status = execSync('codegraph status 2>/dev/null', { cwd:ROOT }).toString();
```

The status display (file count, node count, etc.) remains — it's useful session-start info.

- [ ] **Step 2: Verify rehydrate still runs cleanly**

```bash
node .claude/scripts/rehydrate.js
```
Expected: The "TRADEDASH SESSION RESTORED" banner appears, codegraph status shows without hanging on sync.

- [ ] **Step 3: Commit**

```bash
git add .claude/scripts/rehydrate.js
git commit -m "fix: remove redundant codegraph sync from rehydrate — file watcher handles updates"
```

---

## Task 3: Remove Kiro state file sync from session-wrap.js

**Files:**
- Modify: `.claude/scripts/session-wrap.js` — remove line that syncs `.kiro/steering/03-state.md`

`session-wrap.js` is a Claude Code script. It should not be writing to `.kiro/steering/03-state.md` — that file belongs to Kiro's steering system and should be managed by Kiro. Claude Code writing into Kiro's config is a cross-contamination.

- [ ] **Step 1: Remove the Kiro state sync line**

In `.claude/scripts/session-wrap.js`, find and remove this line (near the bottom):
```js
syncStateFile(path.join(ROOT, '.kiro/steering/03-state.md'), next, now.slice(0, 10));
```

Keep the `.agents/context/state.md` sync — that's the shared context channel.

- [ ] **Step 2: Verify session-wrap still runs**

```bash
node .claude/scripts/session-wrap.js --note 'test'
```
Expected: `✅ State saved at YYYY-MM-DD HH:MM` with valid JSON output. `.kiro/steering/03-state.md` should NOT be modified.

- [ ] **Step 3: Commit**

```bash
git add .claude/scripts/session-wrap.js
git commit -m "fix: stop Claude session-wrap from writing into Kiro steering files"
```

---

## Task 4: Rewrite prompt-preprocessor.js for real prompt compression

**Files:**
- Rewrite: `.claude/hooks/prompt-preprocessor.js`
- Modify: `.claude/settings.local.json` — move preprocessor from `PreToolUse` to `UserPromptSubmit`

**What it does:** On every user message, calls `claude-haiku-4-5-20251001` to compress the prompt into one sentence, then injects `COMPRESSED_INTENT: <sentence>` as `additionalContext`. Claude Code then has both the original prompt and the compressed intent — Claude is instructed to execute based on the compressed intent.

Skips compression for prompts under 25 words (short enough already) and falls through gracefully if the API key is unavailable.

- [ ] **Step 1: Rewrite prompt-preprocessor.js**

Replace the full content of `.claude/hooks/prompt-preprocessor.js` with:

```js
#!/usr/bin/env node
// UserPromptSubmit hook — compresses verbose prompts via Haiku before Claude processes them.
// Output: hookSpecificOutput.additionalContext = "COMPRESSED_INTENT: <one sentence>"
// Falls through silently if API key missing or prompt is short.

const readline = require('readline');
const https = require('https');

const rl = readline.createInterface({ input: process.stdin });
let raw = '';
rl.on('line', l => raw += l + '\n');
rl.on('close', async () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  const prompt = (input?.prompt || '').trim();
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;

  // Skip compression for short prompts — no benefit
  if (wordCount < 25) { process.exit(0); }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { process.exit(0); }

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: `You are a prompt compressor. Compress the following developer prompt to ONE clear, actionable sentence. Preserve all technical details, file names, and specific requirements. Output ONLY the compressed sentence — no preamble, no explanation.\n\nPROMPT:\n${prompt}`
    }]
  });

  const compressed = await new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.content?.[0]?.text?.trim() || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });

  if (!compressed) { process.exit(0); }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `COMPRESSED_INTENT: ${compressed}\n\n(Execute based on COMPRESSED_INTENT. Original prompt is background context.)`
    }
  }));
  process.exit(0);
});
```

- [ ] **Step 2: Update settings.local.json — move preprocessor to UserPromptSubmit, remove from PreToolUse**

In `settings.local.json`:

a) Find and delete the entire `"PreToolUse"` block:
```json
"PreToolUse": [
  {
    "matcher": "Task|TodoWrite",
    "hooks": [
      {
        "type": "command",
        "command": "node /home/runner/workspace/.claude/hooks/prompt-preprocessor.js"
      }
    ]
  }
]
```

b) In the `"UserPromptSubmit"` block, add the preprocessor as a third hook entry (after rehydrate and after the echo):
```json
{
  "type": "command",
  "command": "node /home/runner/workspace/.claude/hooks/prompt-preprocessor.js"
}
```

The full UserPromptSubmit hooks array should be:
```json
"hooks": [
  {
    "type": "command",
    "command": "node /home/runner/workspace/.claude/scripts/rehydrate.js"
  },
  {
    "type": "command",
    "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"RESPONSE STYLE: Be concise. Never echo back code you just wrote or commands you just ran — the user can see tool output directly. State what you did in plain English (1-2 sentences max per action). No multi-line code blocks in prose responses unless the user explicitly asked to see code. No repeating file paths or command flags verbatim. Summaries: one sentence only.\"}}'"
  },
  {
    "type": "command",
    "command": "node /home/runner/workspace/.claude/hooks/prompt-preprocessor.js"
  }
]
```

- [ ] **Step 3: Verify settings.local.json is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8')); console.log('valid')"
```
Expected: `valid`

- [ ] **Step 4: Test the preprocessor with a long prompt**

```bash
echo '{"prompt":"I want you to look at the options comparison table feature and figure out why the strike price slider is not updating the data correctly when I move it from one end to the other, specifically the put options are not refreshing"}' | node .claude/hooks/prompt-preprocessor.js
```
Expected: JSON output with `hookSpecificOutput.additionalContext` containing `COMPRESSED_INTENT: Fix strike price slider not refreshing put options data when moved.` (or similar one-sentence compression).

- [ ] **Step 5: Test fallthrough for short prompt**

```bash
echo '{"prompt":"what is the font size"}' | node .claude/hooks/prompt-preprocessor.js
```
Expected: No output, exit 0 (short prompt skipped).

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/prompt-preprocessor.js .claude/settings.local.json
git commit -m "feat: prompt-preprocessor now compresses verbose prompts via Haiku on UserPromptSubmit"
```

---

## Task 5: Add response style rules permanently to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — add RESPONSE STYLE section

The echo hook in `settings.local.json` works but is a fragile secondary defense. CLAUDE.md is the permanent, always-loaded instruction set. Adding response style here makes it session-persistent (survives compaction, doesn't depend on hook order).

- [ ] **Step 1: Add RESPONSE STYLE section to CLAUDE.md**

Append this section to the bottom of `CLAUDE.md`:

```markdown
## RESPONSE STYLE (all sessions)
- Never echo back code you just wrote or commands you just ran — tool output is already visible
- No multi-line code blocks in prose unless the user explicitly asks to see the code
- No repeating file paths, command flags, or shell output verbatim in text responses
- 1-2 plain English sentences per action taken
- Summaries: one sentence, no headers or bullet lists unless multiple distinct results
- When COMPRESSED_INTENT is injected by the preprocessor hook, execute based on it
```

- [ ] **Step 2: Verify CLAUDE.md is readable**

```bash
node -e "const s=require('fs').readFileSync('CLAUDE.md','utf8'); console.log('lines:', s.split('\n').length, '| has style:', s.includes('RESPONSE STYLE'))"
```
Expected: `lines: <N> | has style: true`

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add permanent RESPONSE STYLE rules to CLAUDE.md"
```

---

## Task 6: Remove hardcoded API keys from permissions allow list

**Files:**
- Modify: `.claude/settings.local.json` — remove specific Bash entries with embedded API keys

Lines 34–35 of `settings.local.json` contain full Anthropic API keys embedded in Bash permission patterns. These were auto-added when one-time commands were approved. They should not persist.

- [ ] **Step 1: Identify and remove key-bearing entries**

In `.claude/settings.local.json`, under `permissions.allow`, remove any entries matching this pattern (two entries with `ANTHROPIC_API_KEY=sk-ant-...`):
```
"Bash(ANTHROPIC_API_KEY=\"sk-ant-api03-...\" PORT=8080 node ...)"
```

Also remove the one-off specific command entries that no longer apply:
```
"Bash(python3 -c \"import json,sys; d=json.load\\(sys.stdin\\)...\")"
"Bash(python3 /tmp/fix_options.py)"
"Bash(sed -i '243s/...' options.ts)"
"Bash(sed -i \"245s/...\" options.ts)"
"Bash(cp /home/runner/workspace/.claude/state.json /tmp/state-backup.json)"
"Bash(cp /tmp/bad-state.json /home/runner/workspace/.claude/state.json)"
"Bash(unzip -p ...)"
"Bash(unzip -l ...)"
```

Keep all the generic `Bash(node *)`, `Bash(npm *)`, `Bash(git *)`, etc. entries — those are intentional.

- [ ] **Step 2: Verify settings.local.json is still valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8')); console.log('valid')"
```
Expected: `valid`

- [ ] **Step 3: Verify no API keys remain in the file**

```bash
grep -c "sk-ant" .claude/settings.local.json
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add .claude/settings.local.json
git commit -m "security: remove hardcoded API keys from permissions allow list"
```

---

## Self-Review

**Spec coverage check:**
- [x] Remove broken context-monitor → Task 1
- [x] Remove redundant codegraph sync → Task 2
- [x] Stop writing to Kiro files from Claude scripts → Task 3
- [x] Implement real prompt compression on UserPromptSubmit → Task 4
- [x] Consolidate response style to permanent location → Task 5
- [x] Remove hardcoded API keys → Task 6
- [x] Codegraph awareness documented in CLAUDE.md (existing, no change needed)
- [x] `.agents/`, `.kiro/`, `.claude/` separation preserved — no cross-contamination

**Placeholder scan:** No TBDs, all code complete, all commands have expected output.

**Dependencies:** Task 4 (prompt preprocessor) requires `ANTHROPIC_API_KEY` to be set in Replit Secrets and accessible as an environment variable. The hook falls through gracefully if missing, but compression won't work. Verify with `printenv ANTHROPIC_API_KEY` before running Task 4 tests.

**What this does NOT change:**
- `.kiro/steering/` files — correct as-is for Kiro IDE
- `.agents/context/` and `.agents/memory/` — shared context, no changes needed
- Codegraph MCP integration — working correctly
- Session wrap core logic — only removes one line

---

*Plan saved: `docs/superpowers/plans/2026-06-14-ai-architecture-cleanup.md`*
