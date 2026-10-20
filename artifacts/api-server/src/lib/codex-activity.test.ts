import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexActivity } from './codex-activity.js';
const now=Date.parse('2026-10-20T05:00:00Z');
const header=JSON.stringify({type:'session_meta',payload:{id:'PRIVATE-ID',cwd:'/project',source:'vscode',base_instructions:'SECRET'}});
const record=(type:string,payload:object,offset=0)=>JSON.stringify({timestamp:new Date(now+offset).toISOString(),type,payload});
test('real lifecycle and tool records map to metadata without content',()=>{
 const tail=[record('event_msg',{type:'task_started'},-3000),record('response_item',{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'rg PRIVATE /secret'})},-2000),record('event_msg',{type:'item_completed',item:{text:'SECRET'}},-1000),record('event_msg',{type:'task_complete',last_agent_message:'SECRET'})].join('\n');
 const e=parseCodexActivity(header,tail,'/project',now);
 assert.deepEqual(e.map(x=>x.event),['prompt','tool','activity','stop']);assert.equal(e[1].kind,'reading');
 assert.doesNotMatch(JSON.stringify(e),/PRIVATE|SECRET|\/secret|\/project/);
 assert.equal(new Set(e.map(x=>x.session)).size,1);
});
test('unrelated projects, guardian sessions and malformed metadata are excluded',()=>{
 const tail=record('event_msg',{type:'task_started'});
 assert.deepEqual(parseCodexActivity(header,tail,'/other',now),[]);
 const meta=JSON.parse(header);meta.payload.source={subagent:{other:'guardian'}};
 assert.deepEqual(parseCodexActivity(JSON.stringify(meta),tail,'/project',now),[]);
 assert.deepEqual(parseCodexActivity('broken',tail,'/project',now),[]);
});
test('partial records, future events and old events cannot create activity',()=>{
 const tail=['broken',record('event_msg',{type:'task_started'},1),record('event_msg',{type:'task_started'},-86400001),record('event_msg',{type:'turn_aborted'})].join('\n');
 assert.deepEqual(parseCodexActivity(header,tail,'/project',now).map(x=>x.event),['stop']);
});

test('fresh native permission waits remain authoritative; older hook-only events survive', async()=>{
 const {mergeCodexActivity}=await import('./codex-activity.js');
 const e=(event:string,offset:number)=>({agent:'codex',session:'s',event,t:new Date(now+offset).toISOString()});
 assert.deepEqual(mergeCodexActivity([e('waiting',-1000)],[e('activity',0)],now).map(x=>x.event),['waiting']);
 assert.deepEqual(mergeCodexActivity([e('fail',-180000),e('tool',-180001)],[e('activity',0)],now).map(x=>x.event),['tool','fail','activity']);
});

test('reader discovers old resumed chats and isolates source roots', async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {codexActivity}=await import('./codex-activity.js');
 const root=mkdtempSync(join(tmpdir(),'codex-activity-'));
 try {
  const dir=join(root,'2025','01','01');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'old.jsonl'),header+'\n'+record('event_msg',{type:'task_started'})+'\n');
  assert.equal(codexActivity('/project',now,root).length,1);
  assert.equal(codexActivity('/project',now,join(root,'empty')).length,0);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('newer desktop completion is never hidden by native or helper freshness', async()=>{
 const {mergeCodexActivity}=await import('./codex-activity.js');
 const tool={agent:'codex',session:'s',event:'tool',t:new Date(now-1000).toISOString()};
 const stop={...tool,event:'stop',t:new Date(now).toISOString()};
 assert.equal(mergeCodexActivity([tool],[stop],now).at(-1)?.event,'stop');
 const sub: typeof tool & {sub?: string}={...tool,event:'sub-stop',sub:'child'};
 assert.equal(mergeCodexActivity([sub],[{...stop,event:'tool'}],now).at(-1)?.event,'tool');
});
test('desktop command failures retain only failure metadata',()=>{
 const e=parseCodexActivity(header,record('event_msg',{type:'item_completed',item:{type:'CommandExecution',exit_code:1,aggregated_output:'SECRET'}}),'/project',now);
 assert.equal(e[0].event,'fail');assert.doesNotMatch(JSON.stringify(e),/SECRET/);
});
