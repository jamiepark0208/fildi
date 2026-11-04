// Offline failure injection into actual scheduler functions. Run from repo root.
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const crypto = require('node:crypto');
const paths = ['artifacts/api-server/src/lib/scheduler/state-guards.ts','artifacts/api-server/src/lib/scheduler/jobs-loop.ts'];
const sources = paths.map(p=>fs.readFileSync(p,'utf8'));
function fn(i,name) {
  const ast=ts.createSourceFile(paths[i],sources[i],ts.ScriptTarget.Latest,true);
  const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  if(!n) throw new Error('missing '+name);
  return n.getText(ast);
}
const code=ts.transpileModule(fn(0,'runEventBulletsJob')+'\n'+fn(1,'runMorningPrecomputeIfDue'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
async function check(mode) {
  let failedAttempts=0,stamps=0,errors=0;
  const ctx={exports:{}, eventBulletsRunning:mode==='busy', lastEventBulletsRun:null,
    logger:{info(){},error(){errors++;}}, runEventBulletCheck:async()=>{if(mode==='fail')throw Error('fixture');},
    setConfigDate:async()=>{stamps++;}, noteFailedAttempt:async()=>{failedAttempts++;},
    loadDate:async()=>null, etDateKey:()=> '2026-11-03',
    LAST_EVENT_BULLETS_RUN_KEY:'events',LAST_EARNINGS_BACKFILL_RUN_KEY:'earnings',LAST_FMP_ANALYST_FEED_RUN_KEY:'analysts',
    runEarningsBackfillJob:async()=>{},runFmpAnalystFeedJob:async()=>{},
  };
  vm.runInNewContext(code,ctx);
  let reported=[],rejected=false;
  try{reported=await ctx.exports.runMorningPrecomputeIfDue();}catch{rejected=true;}
  const pass=mode==='ok' ? !rejected&&reported.includes('events')&&stamps===1 : rejected||!reported.includes('events');
  return {mode,reported,rejected,stamps,failedAttempts,errors,pass};
}
(async()=>{
 const results=await Promise.all(['fail','busy','ok'].map(check));
 console.log(JSON.stringify({sources:paths.map((path,i)=>({path,sha256:crypto.createHash('sha256').update(sources[i]).digest('hex')})),results},null,2));
 process.exitCode=results.every(r=>r.pass)?0:1;
})();
