// Actual-source diagnostics, not production edits or an economic backtest.
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = fs.readFileSync(root + 'artifacts/stock-compare/src/components/options-structures/structure-desk.ts', 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const box = {exports:{}};
vm.runInNewContext(compiled, box);
const {blendScores, pctRanks} = box.exports;
const checks = [];
function check(name, expected, actual) { checks.push({name, expected, actual, pass:JSON.stringify(expected)===JSON.stringify(actual)}); }
check('higher return ranks higher (control)', [0,1], Array.from(pctRanks([0.1,0.2])));
check('null is not a high score (control)', [0,1], Array.from(pctRanks([null,0.2])));
check('milder loss receives tail reward', [0.15,0], Array.from(blendScores([{worst5:-0.05},{worst5:-1}])));
check('equal inputs receive equal ranks', [0.5,0.5], Array.from(pctRanks([0.2,0.2])));
const stored=JSON.parse(fs.readFileSync(new URL('./2026-11-24-structures-evidence.json',import.meta.url)));
const rows=stored.checks.backtests;
const before=blendScores(rows.map(r=>r.summary));
// Isolate the sign correction; intentionally retain current tie behavior.
const after=blendScores(rows.map(r=>({...r.summary,worst5:-r.summary.worst5})));
const order=x=>x.map((score,i)=>({structure:rows[i].structure,score})).sort((a,b)=>b.score-a.score);
const output={scope:'Two controls and two desired contracts against current source; sign-only historical counterfactual is not a recommended new ranking.',checks,before:order(before),tail_sign_only:order(after)};
fs.writeFileSync(new URL('./2026-11-24-structures-fixtures.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({checks,before:order(before).slice(0,5),tail_sign_only:order(after).slice(0,5)}));
process.exitCode=checks.every(c=>c.pass)?0:1;
