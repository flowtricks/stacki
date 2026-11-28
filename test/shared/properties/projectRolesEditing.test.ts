// Goal: a role's editing options (`editorOff` in .stacki/roles.json) only ever take
// away. A file without them reads and writes exactly as before and grants what it
// granted; each option withholds every permission that reaches the same thing
// another way; dragging, text and images all off is read only; and a list this
// version cannot read switches everything off instead of being dropped.
// Method: parse real files through the shared parser, ask `can()` for every
// feature before and after, and walk the invalid shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR_PARTS, effectiveEditorOff, parseEditorOff, readOnlyEditor, limitsEditing } from '#dist/shared/properties/projectRoles.js';
import {
  ACCESS_FEATURES,
  ADMIN_VIEW,
  DEFAULT_PROJECT_ROLES,
  can,
  parseProjectRoles,
  parseProjectRolesSource,
  roleViewOf,
  serializeProjectRoles,
  type AccessFeature,
  type RoleView,
} from '#dist/shared/properties/projectRoles.js';

const EVERY_GRANT = ACCESS_FEATURES.filter((feature) => feature !== 'settings:roles' && feature !== 'cli:roles');

function file(editorOff?: unknown, access: readonly string[] = EVERY_GRANT) {
  return {
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'], ...(editorOff === undefined ? {} : { editorOff }) },
      { id: 'editor', name: 'Editor', members: ['sam'], access, ...(editorOff === undefined ? {} : { editorOff }) },
    ],
  };
}

const view = (editorOff?: unknown, access?: readonly string[]): RoleView => roleViewOf(parseProjectRoles(file(editorOff, access)), 'editor');
const allowed = (role: RoleView): readonly AccessFeature[] => ACCESS_FEATURES.filter((feature) => can(role, feature));

test('a file without editing options reads, grants and writes exactly as before', () => {
  const roles = parseProjectRoles(file());
  const editor = roleViewOf(roles, 'editor');
  assert.equal(editor.editorOff.size, 0);
  assert.deepEqual(allowed(editor), EVERY_GRANT);
  assert.doesNotMatch(serializeProjectRoles(roles), /editorOff/);
  assert.doesNotMatch(serializeProjectRoles(DEFAULT_PROJECT_ROLES), /editorOff/);
  assert.equal(ADMIN_VIEW.editorOff.size, 0);
});

test('editing options are stored in one order, kept through a save, and ignored on admin', () => {
  const roles = parseProjectRoles(file(['text', 'sidePanel', 'text']));
  assert.deepEqual(roles.roles.find((role) => role.id === 'editor')?.editorOff, ['sidePanel', 'text']);
  assert.deepEqual(roles.roles.find((role) => role.id === 'admin')?.editorOff, [], 'admin is never limited');
  assert.deepEqual(allowed(roleViewOf(roles, 'admin')), ACCESS_FEATURES);
  const saved = serializeProjectRoles(roles);
  assert.deepEqual(parseProjectRolesSource(saved), roles);
  // A 1.4.21 reader ignores a key it does not know, so the file stays readable by it.
  assert.match(saved, /^\{\n {2}"version": 1,/);
});

test('a list this version cannot read switches everything off', () => {
  for (const bad of ['text', {}, true, 7, JSON.parse('null'), ['text', 'a-part-from-later'], [1], Array.from({ length: 40 }, () => 'text')]) {
    assert.deepEqual(parseEditorOff(bad), EDITOR_PARTS, JSON.stringify(bad));
  }
  assert.deepEqual(parseEditorOff(undefined), []);
  assert.deepEqual(parseEditorOff([]), []);
  const unknown = view(['hologram']);
  assert.equal(readOnlyEditor(unknown.editorOff), true);
  assert.equal(can(unknown, 'publish'), false);
});

test('no option ever grants a feature the role did not have', () => {
  const bare = ['panel:pages', 'cli:read'];
  const before = new Set(allowed(view(undefined, bare)));
  for (const part of EDITOR_PARTS) {
    assert.ok(
      allowed(view([part], bare)).every((feature) => before.has(feature)),
      part,
    );
    const full = new Set(allowed(view()));
    assert.ok(
      allowed(view([part])).every((feature) => full.has(feature)),
      part,
    );
  }
});

const gone = (role: RoleView, features: readonly AccessFeature[]) => features.filter((feature) => can(role, feature));
const UNCHECKABLE: readonly AccessFeature[] = [
  'code:edit',
  'panel:code',
  'panel:ai',
  'panel:history',
  'panel:properties',
  'component:edit',
  'component:create',
  'page:create',
];

test('without the right panel nothing else reaches styles or settings', () => {
  const role = view(['sidePanel']);
  assert.deepEqual(gone(role, ['panel:style', 'panel:settings', 'panel:selectors', 'panel:variables', 'settings:breakpoints', ...UNCHECKABLE]), []);
  for (const feature of ['panel:navigator', 'panel:cms', 'panel:assets', 'publish', 'page:delete'] as const) {
    assert.equal(can(role, feature), true, feature);
  }
});

test('the navigator and the canvas bar are views: hiding them limits nothing else', () => {
  const noNavigator = view(['navigator']);
  assert.deepEqual(
    allowed(noNavigator),
    EVERY_GRANT.filter((feature) => feature !== 'panel:navigator'),
  );
  assert.equal(limitsEditing(noNavigator.editorOff), false);
  const noBar = view(['canvasBar']);
  assert.deepEqual(allowed(noBar), EVERY_GRANT);
  assert.equal(limitsEditing(noBar.editorOff), false);
  // Add elements came with the Navigator grant, and hiding the Navigator does not take it away.
  assert.equal(can(view(['navigator'], ['panel:navigator']), 'panel:elements'), true);
});

test('each page option takes the other ways to change the same thing', () => {
  assert.deepEqual(gone(view(['text']), ['panel:cms', ...UNCHECKABLE]), []);
  assert.equal(can(view(['text']), 'panel:assets'), true);
  assert.deepEqual(gone(view(['images']), ['panel:cms', 'panel:assets', ...UNCHECKABLE]), []);
  assert.deepEqual(gone(view(['elements']), ['panel:elements', 'panel:components', ...UNCHECKABLE]), []);
  assert.deepEqual(gone(view(['drag']), UNCHECKABLE), []);
  assert.equal(can(view(['drag']), 'panel:cms'), true);
});

test('dragging, text and images off is read only, and adding elements goes with them', () => {
  const reader = view(['drag', 'text', 'images']);
  assert.equal(reader.editorOff.has('elements'), true);
  assert.equal(readOnlyEditor(reader.editorOff), true);
  assert.deepEqual(
    gone(reader, ['panel:elements', 'panel:cms', 'panel:assets', 'publish', 'page:delete', 'page:rename', 'cli:config', 'marketplace:install', ...UNCHECKABLE]),
    [],
  );
  assert.equal(can(reader, 'panel:pages'), true, 'a reader still moves between pages');
  // Two of the three is not read only, and brings nothing with it.
  assert.deepEqual([...effectiveEditorOff(['drag', 'text'])], ['drag', 'text']);
  // A role that could never change pictures is read only once dragging and text are off too.
  const noPanels = view(['drag', 'text'], ['panel:pages', 'publish']);
  assert.equal(readOnlyEditor(noPanels.editorOff), true);
  assert.equal(can(noPanels, 'publish'), false);
});
