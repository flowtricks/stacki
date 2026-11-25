// Goal: identical custom audit matches are each counted, as `stacki audits test`
// counts them, while ignores saved before this keep hiding what they hid; a page
// past the matcher's size bound is skipped instead of crashing the run; and two
// quick settings saves both land. Matches that read the same (a declaration
// inside and outside a media query, two TODOs in one element) shared an id and
// showed as one. Method: the real custom audit run, ignore reader and settings
// bridge, bundled with esbuild; the bridge writes to an in-memory file that
// refuses a stale base, as the app's does. The negative space: the first match
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
      "export { readAuditIgnores, changeAuditIgnores } from './src/features/audits/auditsBridge';",
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
const todo = auditOf('todo', 'markup', { pattern: 'TODO' });
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

test('a page past the size bound is skipped, and the rest of the run goes on', () => {
  const huge = {
    kind: 'astro',
    file: 'src/pages/huge.astro',
    fileKind: 'page',
    source: `TODO ${'x'.repeat(app.CUSTOM_MATCH_LIMITS.textCharsMax)}`,
    nodes: [],
  };
  const small = { kind: 'astro', file: 'src/pages/small.astro', fileKind: 'page', source: '<p>TODO</p>', nodes: [] };
  const outcome = run([todo, alignment], [huge, small, sheet]);
  assert.equal(outcome.findings.filter((finding) => finding.file === small.file).length, 1);
  assert.equal(outcome.findings.filter((finding) => finding.file === huge.file).length, 0);
  assert.equal(outcome.findings.filter((finding) => finding.file === sheet.file).length, 3);
  assert.deepEqual(
    outcome.stopped.map((entry) => entry.id),
    ['todo'],
    'the audit says it read only part',
  );
});

test('two settings saves made at once both land, and a change made elsewhere is still not overwritten', async () => {
  let source;
  globalThis.window = {
    avb: {
      projectMetadata: async () => ({ ok: true, value: source === undefined ? {} : { source } }),
      writeProjectMetadata: async ({ write }) => {
        if (write.base !== source) {
          return { ok: false, error: { code: 'conflict', message: 'Changed in another editor.' } };
        }
        source = write.source;
        return { ok: true, value: { source } };
      },
    },
  };
  const read = await app.readAuditIgnores('/project');
  const off = { enabled: false, priority: undefined };
  const saves = ['img-alt', 'html-lang'].map((check) => app.changeAuditIgnores('/project', read.value, (file) => app.withCheckSetting(file, check, off)));
  const [first, second] = await Promise.all(saves);
  assert.ok(first.ok, first.error);
  assert.ok(second.ok, second.error);
  assert.deepEqual(Object.keys(app.parseAuditIgnoresSource(source).checks).sort(), ['html-lang', 'img-alt']);
  // Someone else's write: a save over what was read before it is refused.
  const stale = second.value;
  source = source.replace('"version": 2', '"version":  2');
  const refused = await app.changeAuditIgnores('/project', stale, (file) => file);
  assert.equal(refused.ok, false);
  delete globalThis.window;
});
