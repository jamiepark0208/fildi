import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsage } from './codex-usage.js';
const now = Date.parse('2026-10-20T05:00:00Z');
const event = (overrides = {}) => JSON.stringify({type:'event_msg', timestamp:new Date(now).toISOString(), payload:{type:'token_count', rate_limits:{limit_id:'codex', primary:{used_percent:72,window_minutes:300,resets_at:now/1000+3600}, secondary:{used_percent:16,window_minutes:10080,resets_at:now/1000+86400}}}, ...overrides});
test('reads account windows, excludes transcript content and partial lines', () => {
 const result = parseCodexUsage('broken\n'+JSON.stringify({type:'message',text:'PRIVATE'})+'\n'+event(),now);
 assert.equal(result?.windows[0].used,72); assert.equal(result?.stale,false);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});
test('expired or old observations cannot masquerade as available balance', () => {
 assert.equal(parseCodexUsage(event(),now+16*60_000)?.stale,true);
 assert.equal(parseCodexUsage(event({timestamp:new Date(now-60_000).toISOString()}),now)?.stale,false);
 assert.equal(parseCodexUsage(event(),now-1),null);
 const expired=JSON.parse(event()); expired.payload.rate_limits.primary.resets_at=now/1000-1;
 assert.equal(parseCodexUsage(JSON.stringify(expired),now)?.stale,true);
});
test('missing and unrelated limits remain unknown', () => {
 assert.equal(parseCodexUsage('',now),null);
 const other=JSON.parse(event());other.payload.rate_limits.limit_id='other';
 assert.equal(parseCodexUsage(JSON.stringify(other),now),null);
});
