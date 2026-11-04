// Run the production Ideas parser without starting the API or opening a browser.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
const sourcePath='artifacts/api-server/src/routes/agents.ts', source=fs.readFileSync(sourcePath,'utf8');
const ast=ts.createSourceFile(sourcePath,source,ts.ScriptTarget.Latest,true);
const names=['ideaAssignee','ideaBlurb','ideaReviews','ideaPhase','normalizeTouchDate','ideaTouch','asks'];
const snippets=names.map(name=>{
 const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
 if(!n)throw Error(name+' missing'); return n.getText(ast);
});
const code=ts.transpileModule(snippets.join('\n')+'\nexports.read=asks;',{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
function parse(fixture=false){
 const ctx={exports:{},ROOT:process.cwd(),resolve:path.resolve,
  who:s=>({codex:'codex',muse:'muse',claude:'claude',cursor:'cursor',jamie:'jamie',user:'jamie',grok:'grok',grokbot:'grok'})[s.trim().toLowerCase()]??null,
  readFileSync:fixture ? p=>p.endsWith('ASKS.md')?'| [A999](asks/A999.md) | 2026-11-03 | Cursor → Claude | Fixture | revise |':'':fs.readFileSync};
 vm.runInNewContext(code,ctx); return ctx.exports.read();
}
const current=parse();
const fixture=parse(true);
const owner=fixture.ideas[0]?.assignee;
console.log(JSON.stringify({source:sourcePath,sha256:require('node:crypto').createHash('sha256').update(source).digest('hex'),
 current:current.ideas.filter(i=>['A205','A236','A251','A277','A318','A329','A234'].includes(i.id)).map(i=>({id:i.id,phase:i.phase,assignee:i.assignee,reviewVisible:i.reviews.includes('Codex'),reviewCharacters:i.reviews.length})),
 reviseFixture:{owner,queue:fixture.queue,expectedOwnerQueue:1,pass:fixture.queue[owner]===1}},null,2));
process.exitCode=fixture.queue[owner]===1?0:1;
