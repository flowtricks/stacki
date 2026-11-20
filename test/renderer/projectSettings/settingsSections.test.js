// Goal: the Settings panel's model decides what the screen shows, so it is held without a screen. The root lists
// a view only when the role may open it (admin: all three; `panel:projectSettings` alone: Secrets and MCP;
// `panel:instructions` alone: Instructions; neither: no Settings button); the folded Instructions sections are
// remembered per project, parsed like any stored input (a bad entry is no choice at all); a request to open
// Settings names a view or an Instructions section, is taken once, and an old session's retired `instructions`
// panel id reopens Settings with the Instructions view.
// Method: bundle the real modules with esbuild and call them over in-memory storage and real parsed roles.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/settings-sections.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/lib/settingsSections';",
      "export { settingsViewsOf, canSettingsPanel, canRailTab } from './src/lib/roleAccess';",
      "export { seededLeftTabOf } from './src/app/model/seededLeftTab';",
      "export { ADMIN_VIEW, roleViewOf, parseProjectRoles } from './shared/properties/projectRoles';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const model = require(output);

const storage = () => {
  const items = new Map();
  return { getItem: (key) => items.get(key), setItem: (key, value) => void items.set(key, value) };
};

const roles = model.parseProjectRoles({
  version: 1,
  defaultRole: 'client',
  roles: [
    { id: 'admin', name: 'Admin', members: ['owner'] },
    { id: 'client', name: 'Client', members: ['acme'] },
    { id: 'ops', name: 'Ops', members: ['kim'], access: ['panel:projectSettings'] },
    { id: 'docs', name: 'Docs', members: ['sam'], access: ['panel:instructions'] },
  ],
});

test('the root lists the views a role may open, and the rail button follows', () => {
  assert.deepEqual(model.settingsViewsOf(model.ADMIN_VIEW), ['secrets', 'mcp', 'instructions']);
  assert.deepEqual(model.settingsViewsOf(model.roleViewOf(roles, 'ops')), ['secrets', 'mcp']);
  assert.deepEqual(model.settingsViewsOf(model.roleViewOf(roles, 'docs')), ['instructions']);
  assert.deepEqual(model.settingsViewsOf(model.roleViewOf(roles, 'client')), []);
  assert.equal(model.canRailTab(model.roleViewOf(roles, 'docs'), 'projectSettings'), true);
  assert.equal(model.canRailTab(model.roleViewOf(roles, 'client'), 'projectSettings'), false);
});

test('folded sections parse like stored input: known ids once each, nothing else', () => {
  assert.deepEqual(model.parseFoldedSections(['rules', 'docs']), ['rules', 'docs']);
  assert.deepEqual(model.parseFoldedSections([]), []);
  for (const bad of [undefined, 'rules', {}, [1], ['secrets'], ['rules', 'rules'], ['skills', 'rules', 'docs', 'docs'], [{}]]) {
    assert.equal(model.parseFoldedSections(bad), undefined, JSON.stringify(bad));
  }
});

test('folded sections are remembered per project and a corrupt store reads as none', () => {
  const store = storage();
  assert.equal(model.loadFoldedSections('/a', store).size, 0);
  model.saveFoldedSections('/a', new Set(['docs', 'skills']), store);
  model.saveFoldedSections('/b', new Set(['rules']), store);
  assert.deepEqual([...model.loadFoldedSections('/a', store)].sort(), ['docs', 'skills']);
  assert.deepEqual([...model.loadFoldedSections('/b', store)], ['rules']);
  store.setItem(model.SETTINGS_FOLDED_KEY, '{not json');
  assert.equal(model.loadFoldedSections('/a', store).size, 0);
});

test('a request names a view or one Instructions section; it is taken once', () => {
  assert.deepEqual(model.viewOfTarget('secrets'), { view: 'secrets', open: [], scrollTo: undefined });
  assert.deepEqual(model.viewOfTarget('instructions'), { view: 'instructions', open: ['skills', 'rules', 'docs'], scrollTo: 'skills' });
  assert.deepEqual(model.viewOfTarget('docs'), { view: 'instructions', open: ['docs'], scrollTo: 'docs' });
  assert.equal(model.takeSettingsRequest(), undefined);
  const before = model.settingsRequestSerial();
  model.requestSettingsSection('mcp');
  assert.equal(model.settingsRequestSerial(), before + 1);
  assert.equal(model.takeSettingsRequest(), 'mcp');
  assert.equal(model.takeSettingsRequest(), undefined, 'taken once');
});

test('a session that left the retired Instructions panel open reopens Settings at the Instructions view', () => {
  assert.deepEqual(model.seededLeftTabOf('instructions'), { tab: 'projectSettings', showInstructions: true });
  assert.deepEqual(model.seededLeftTabOf('projectSettings'), { tab: 'projectSettings', showInstructions: false });
  assert.deepEqual(model.seededLeftTabOf('pages'), { tab: 'pages', showInstructions: false });
  for (const unknown of [undefined, '', 'ai', 'toString', '__proto__', 'audits']) {
    assert.deepEqual(model.seededLeftTabOf(unknown), { tab: 'navigator', showInstructions: false }, String(unknown));
  }
});
