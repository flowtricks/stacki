// Goal: identical custom audit matches are each counted, as `stacki audits test`
// counts them, while ignores saved before this keep hiding what they hid. Matches
// that read the same (a declaration inside and outside a media query, two TODOs in
// one element) shared an id and showed as one.
// Method: the real custom audit run and ignore reader, bundled with esbuild. The negative space: the first match
// keeps its old id, and ignoring a later one hides that one alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath, ROOT } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/audit-repeats.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { runCustomAudits } from './src/features/audits/customAuditRun';",
      "export { uniqueFindings } from './shared/page/auditFindings';",
      "export { ignoreReasons } from './shared/properties/auditIgnoreList';",
      "export { parseAuditIgnoresSource, withIgnore, withCheckSetting } from './shared/properties/auditIgnores';",
      "export { scanCustomFiles, CUSTOM_MATCH_LIMITS } from './shared/page/auditCustom';",
      "export { compileCustomAudit, parseCustomAudit } from './shared/properties/customAudits';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const app = require(output);

const auditOf = (id, scope, match) => app.parseCustomAudit({ id, name: id, icon: 'text', category: 'tokens', scope, match, enabled: true }, 'audit');
const alignment = auditOf('alignment', 'declaration', { property: '^text-align$' });
const CSS = '.a { text-align: left; }\n@media (min-width: 40em) {\n  .a { text-align: left; }\n}\n.a { text-align: left; }\n';
const sheet = { kind: 'stylesheet', file: 'src/styles/site.css', text: CSS };
const run = (audits, sources) => app.runCustomAudits(audits, sources, () => 0);

test('identical matches are each listed, and counted as the command line counts them', () => {
  const found = app.uniqueFindings(run([alignment], [sheet]).findings);
  const compiled = app.compileCustomAudit(alignment);
  const counted = app.scanCustomFiles([{ file: sheet.file, source: CSS }], compiled.value, { samplesMax: 0, startedMs: 0 }, () => 0).count;
  assert.equal(found.length, counted);
  assert.equal(new Set(found.map((finding) => finding.id)).size, 3);
  const base = 'custom:alignment|src/styles/site.css|-|.a { text-align: left }';
  assert.equal(found[0].id, base, 'the first keeps the id ignores were saved with');
});

test('a saved ignore still hides every identical match; ignoring a later one hides that one', () => {
  const found = run([alignment], [sheet]).findings;
  const file = app.parseAuditIgnoresSource(undefined);
  const old = app.ignoreReasons(found, app.withIgnore(file, { id: found[0].id, reason: 'Known' }));
  assert.deepEqual(
    [...old.keys()],
    found.map((finding) => finding.id),
  );
  assert.equal(old.get(found[2].id).reason, 'Known');
  const later = app.ignoreReasons(found, app.withIgnore(file, { id: found[1].id, reason: undefined }));
  assert.deepEqual([...later.keys()], [found[1].id]);
});
