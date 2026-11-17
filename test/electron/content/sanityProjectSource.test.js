// Goal: the Sanity project id a site writes in its own config files is found without running them,
// and nothing that only looks like one is.
// Method: config source texts in the shapes sites use (a nested object, a spread constant, a Studio's
// sanity.cli), then the negative space: comments, ids built at run time, malformed ids, other keys;
// and a temporary site folder with the id only in an embedded Studio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configProjectIds, siteConfigProjectIds } = require('#dist/electron/content/sanityProjectSource.js');

test('an id written as a string literal is found, at any depth, in order and once', () => {
  assert.deepEqual(configProjectIds(`const sanityProject = {\n  projectId: "ecka10i7",\n  dataset: env.PUBLIC_SANITY_DATASET || "production",\n};`), [
    'ecka10i7',
  ]);
  assert.deepEqual(configProjectIds(`export default defineCliConfig({ api: { projectId: 'abc123', dataset: 'production' } })`), ['abc123']);
  assert.deepEqual(configProjectIds('integrations: [sanity({ projectId: `abc123` })]'), ['abc123']);
  assert.deepEqual(configProjectIds(`a({ projectId: 'one111' }); b({ projectId: 'two222' }); c({ projectId: 'one111' })`), ['one111', 'two222']);
});

test('comments, run-time ids, malformed ids and other keys are not ids', () => {
  assert.deepEqual(configProjectIds(`// projectId: 'old111'\n/* projectId: 'old222' */\nconst x = { projectId: 'new333' }`), ['new333']);
  assert.deepEqual(configProjectIds(`const x = { projectId: process.env.SANITY_PROJECT_ID }`), []);
  assert.deepEqual(configProjectIds('const x = { projectId: `${prefix}abc` }'), []);
  assert.deepEqual(configProjectIds(`const x = { projectId: 'Has Spaces' }`), []);
  assert.deepEqual(configProjectIds(`const x = { projectId: '' }`), []);
  assert.deepEqual(configProjectIds(`const x = { projectId: '${'a'.repeat(33)}' }`), []);
  assert.deepEqual(configProjectIds(`const x = { myProjectId: 'abc123', label: "projectId: 'abc123'" }`), []);
  assert.deepEqual(configProjectIds(''), []);
});

test('one file gives at most eight ids', () => {
  const many = Array.from({ length: 20 }, (_, index) => `{ projectId: 'p${index}' }`).join('\n');
  assert.equal(configProjectIds(many).length, 8);
});

test('a site folder: root config first, then an embedded Studio; missing files are skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-sanity-config-'));
  try {
    assert.deepEqual(siteConfigProjectIds(root), []);
    fs.mkdirSync(path.join(root, 'studio'));
    fs.writeFileSync(path.join(root, 'studio', 'sanity.cli.ts'), `export default defineCliConfig({ api: { projectId: 'studio11' } })`);
    assert.deepEqual(siteConfigProjectIds(root), ['studio11']);
    fs.writeFileSync(path.join(root, 'astro.config.mjs'), `const sanityProject = { projectId: "root2222" };`);
    fs.writeFileSync(path.join(root, 'studio', 'sanity.config.ts'), `export default defineConfig({ projectId: 'root2222' })`);
    assert.deepEqual(siteConfigProjectIds(root), ['root2222', 'studio11']);
    fs.writeFileSync(path.join(root, 'astro.config.ts'), `// ${'x'.repeat(256 * 1024)}\nconst a = { projectId: 'toolong1' }`);
    assert.deepEqual(siteConfigProjectIds(root), ['root2222', 'studio11'], 'a file over the size limit is not read');
    assert.throws(() => siteConfigProjectIds('relative/site'), /absolute path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
