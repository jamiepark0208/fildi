// Offline review probe: execute the current exported reader with fake DB results.
// No app boot, database access, vendor calls, or copied production logic.
// Run from repo root: node research/common/reviews/2026-11-03-put-reader-probe.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const path = 'artifacts/api-server/src/lib/option-score-snapshots.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'readLatestOptionRankings');
if (!node) throw new Error('reader function not found');
const code = ts.transpileModule(node.getText(ast), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const engine = { asOf: '2026-11-03', rows: [{ ticker: 'TEST', rank: 1, pass: true,
  computedAt: '2026-11-03T16:00:00Z', p: { as_of: '2026-11-03', strike: 100,
    expiry: '2026-11-06', spot: 110, bid: 1, option_score: 55, gates: [] } }] };
const oldPick = { ticker: 'TEST', side: 'put', asOf: '2026-11-02', strike: 105,
  expiry: '2026-11-06', spot: 110, premium: 2, optionScore: 70,
  computedAt: '2026-11-02T16:00:00Z' };
async function probe(label, dated, raw, eng, expected) {
  let queries = 0, engineReads = 0;
  const db = { select() {
    const result = queries++ === 0 ? dated : raw;
    let chain;
    chain = new Proxy({}, { get(_t, key) {
      if (key === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
      return () => chain;
    } });
    return chain;
  } };
  const context = { exports: {}, db, optionScoreSnapshots: {}, sql: () => '',
    eq: () => null, and: () => null, desc: () => null,
    num: v => v == null ? null : Number(v), isRelaxedComponentScores: () => false,
    readPutRecs: async () => { engineReads++; return eng; }, attachFocus: async () => {} };
  vm.runInNewContext(code, context);
  const result = await context.exports.readLatestOptionRankings('put');
  const actual = result.rows.map(r => ({ strike: r.strike, engine: Boolean(r.engine) }));
  return { label, expected, actual, engineReads, pass: JSON.stringify(actual) === JSON.stringify(expected) };
}
(async () => {
  const dated = [{ asOf: '2026-11-02', n: 20 }];
  const results = [
    await probe('Healthy engine works without legacy snapshots', [], [], engine, [{ strike: 100, engine: true }]),
    await probe('Missing engine never silently substitutes another picker', dated, [oldPick], { asOf: null, rows: [] }, []),
    await probe('Healthy engine overrides a conflicting legacy snapshot', dated, [oldPick], engine, [{ strike: 100, engine: true }]),
  ];
  console.log(JSON.stringify({ source: path, sha256: crypto.createHash('sha256').update(source).digest('hex'), results }, null, 2));
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
})();
