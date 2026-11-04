// Offline route failure injection. Does not import/start the API or call a vendor.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto');
const path='artifacts/api-server/src/routes/live.ts',source=fs.readFileSync(path,'utf8');
const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
let handler;
function walk(n){
 if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='get'
   &&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text==='/live/state')handler=n.arguments[1].getText(ast);
 ts.forEachChild(n,walk);
}
walk(ast);if(!handler)throw Error('route missing');
const code=ts.transpileModule('exports.handler='+handler,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
(async()=>{
 const unhandled=[],nextErrors=[];let response=false;
 const listener=e=>unhandled.push(e.message);
 process.on('unhandledRejection',listener);
 try{
  const ctx={exports:{},liveHotlist:{getLastRefreshedAt:()=>null,refresh:()=>Promise.reject(Error('fixture DB unavailable'))},snapshot:async()=>({})};
  vm.runInNewContext(code,ctx);
  await ctx.exports.handler({}, {json(){response=true;}}, e=>nextErrors.push(e.message));
  await new Promise(resolve=>setImmediate(resolve));
 }finally{process.removeListener('unhandledRejection',listener);}
 const result={source:path,sha256:crypto.createHash('sha256').update(source).digest('hex'),response,nextErrors,unhandled,pass:unhandled.length===0};
 console.log(JSON.stringify(result,null,2));process.exitCode=result.pass?0:1;
})();
