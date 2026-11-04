#!/usr/bin/env node
// UserPromptSubmit hook (W07, 11-03 audit): long sessions average ~200k context tokens/request, re-sent every turn.
// Reads the transcript's last usage; above 150k it tells Claude to close the current task (state.md) at the next boundary.
import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";

const LIMIT = 150_000;
let input = "";
try { input = readFileSync(0, "utf8"); } catch { process.exit(0); }
let path;
try { path = JSON.parse(input).transcript_path; } catch { process.exit(0); }
if (!path) process.exit(0);
try {
  const size = statSync(path).size;
  const n = Math.min(size, 400_000);            // tail only — transcripts get large
  const buf = Buffer.alloc(n);
  const fd = openSync(path, "r");
  readSync(fd, buf, 0, n, size - n);
  closeSync(fd);
  const lines = buf.toString("utf8").split("\n").reverse();
  for (const l of lines) {
    if (!l.includes('"usage"')) continue;
    let u;
    try { u = JSON.parse(l)?.message?.usage; } catch { continue; }
    if (!u) continue;
    const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (ctx > LIMIT) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
        additionalContext: `Context ${Math.round(ctx / 1000)}k tokens (> 150k; every turn re-sends it). Finish the current task, write decisions + next step to state.md, then tell Jamie in one line that /clear (or /compact) saves cost before the next task.` } }));
    }
    break;
  }
} catch { /* never block a prompt */ }
process.exit(0);
