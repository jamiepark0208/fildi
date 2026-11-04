const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const requireRepo = require('node:module').createRequire(process.cwd() + '/package.json');
const ts = requireRepo('typescript');
const paths = ['artifacts/api-server/src/scripts/merge-trusted.ts', 'artifacts/api-server/src/lib/derived-metrics.ts'];
const [merge, derived] = paths.map(p => fs.readFileSync(p, 'utf8'));
const ast = ts.createSourceFile(paths[0], merge, ts.ScriptTarget.Latest, true);
let force, repair;
function walk(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'forceDerived') force = node.initializer.getText(ast);
  if (ts.isBlock(node) && node.statements[0]?.getText(ast).startsWith('let evGold:')) repair = node.getText(ast);
  ts.forEachChild(node, walk);
}
walk(ast);
if (!force || !repair) throw new Error('Production blocks not found');
const transpile = s => ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helpers = { exports: {} };
vm.runInNewContext(transpile(derived), helpers);
function probe(stage, currency, override = false) {
  const context = { ...helpers.exports, financialCurrency: currency, skipEvDerive: false,
    update: { evEbitda: 2059, sharesOutstanding: 1e9, totalDebt: 50e9, cashAndEquivalents: 10e9, ebitda: 20e9 },
    price: 100, ticker: 'TEST', existing: { evEbitda: 2059 }, sourceUsage: {}, changedFields: [],
    provenanceBatch: [{ field: 'evEbitda', result: { source: override ? 'override' : 'yahoo', value: 2059, isOverride: override } }],
    vendorRatioAlternates: () => [], overrideIndex: new Map(override ? [['TEST:evEbitda', {}]] : []),
    isChanged: (a,b) => ({ changed: a !== b }),
  };
  vm.runInNewContext(transpile(stage === 'force' ? `const forceDerived = ${force}; forceDerived('evEbitda', 7);` : repair), context);
  const actual = context.provenanceBatch[0].result;
  const shouldDerive = currency === 'USD' && !override;
  return { stage, currency, override, expectedDerived: shouldDerive, actual, pass: (actual.source === 'derived') === shouldDerive };
}
const results = [probe('force','CNY'), probe('repair','CNY'), probe('repair',null), probe('force','USD'), probe('repair','USD'), probe('repair','USD',true)];
console.log(JSON.stringify({ sources: paths.map((path,i)=>({path,sha256:crypto.createHash('sha256').update([merge,derived][i]).digest('hex')})), results },null,2));
process.exitCode = results.every(r=>r.pass) ? 0 : 1;
