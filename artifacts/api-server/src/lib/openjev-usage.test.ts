import test from 'node:test';import assert from 'node:assert/strict';
import {openjevUsage} from './openjev-usage.js';
const now=Date.parse('2026-10-20T05:00:00Z');const at=new Date(now).toISOString();
test('wrapper activity and measured requests remain separate',()=>{
 const text=[{at,id:'x',agent:'codex',state_chars:100},{at,kind:'model_request',input_tokens:20,output_tokens:0,elapsed_ms:100},{at,outcome_for:'x',right:true},{at,kind:'model_request',input_tokens:null,output_tokens:null}].map(x=>JSON.stringify(x)).join('\n');
 const u=openjevUsage(text,now);assert.equal(u.asks,1);assert.equal(u.modelRequests,2);assert.equal(u.measuredRequests,1);assert.equal(u.inputTokens,20);
});
test('missing file is unknown; invalid dates and values do not inflate usage',()=>{
 assert.equal(openjevUsage(null,now).available,false);
 const u=openjevUsage(JSON.stringify({at:'bad',id:'x',state_chars:999}),now);assert.equal(u.asks,0);
 assert.equal(openjevUsage(JSON.stringify({at,kind:'model_request',input_tokens:-1,output_tokens:0}),now).measuredRequests,0);
});
