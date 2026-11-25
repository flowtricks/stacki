// Goal: a role's hidden-component rules resolve the way the Roles tab and every insert surface expect: everything
// is visible by default, a folder hides what is under it, the most specific rule wins (a component beats its
// folder, a deeper folder beats a shallower one), a show rule re-enables one component inside a hidden folder,
// rules for paths that no longer exist are reported as missing and ignored, a move or rename carries the rules,
// edits keep the fewest rules, and stored data that is malformed or past a bound is refused by the parser.
// Method: parse rules the way the file stores them, resolve known paths on each side of every rule, pin the
// error text for each known-bad shape and each bound just past its limit, and round-trip through roles.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPONENT_ACCESS_LIMITS,
  ComponentRulesBoundError,
  componentRuleFile,
  componentVisibility,
  componentVisible,
  missingComponentRules,
  moveComponentRules,
  parseComponentPath,
  parseComponentRules,
  resolveComponent,
  componentAccessIndex,
  setComponentState,
  visibleComponents,
} from '#dist/shared/properties/componentAccess.js';
import { parseProjectRoles, roleViewOf, serializeProjectRoles, can, parseProjectRolesSource } from '#dist/shared/properties/projectRoles.js';

const admin = { id: 'admin', members: ['owner'] };
const rules = parseComponentRules([
  { kind: 'folder', path: 'src/components/interactive/' },
  { kind: 'component', path: 'src/components/interactive/Tabs.astro', effect: 'show' },
  { kind: 'folder', path: 'src/components/interactive/legacy' },
  { kind: 'component', path: 'src/components/Hero.astro' },
]);

test('with no rules every component is visible, so a new one needs no migration', () => {
  assert.equal(componentVisible([], 'src/components/New.astro'), true);
  assert.equal(componentVisibility([])(undefined), true);
});

test('a folder hides what is under it, nested folders included, and nothing outside it', () => {
  assert.equal(componentVisible(rules, 'src/components/interactive/Modal.astro'), false);
  assert.equal(componentVisible(rules, 'src/components/interactive/deep/er/Modal.astro'), false);
  assert.equal(componentVisible(rules, 'src/components/Card.astro'), true);
  assert.equal(componentVisible(rules, 'src/components/interactive-extras/Card.astro'), true, 'a folder name is a whole segment, not a prefix');
});

test('the most specific rule wins: component over folder, deeper folder over shallower', () => {
  assert.equal(componentVisible(rules, 'src/components/interactive/Tabs.astro'), true, 'a show rule re-enables one component');
  assert.equal(componentVisible(rules, 'src/components/Hero.astro'), false, 'a component rule hides one component');
  const reshown = parseComponentRules([
    { kind: 'folder', path: 'src/components/a' },
    { kind: 'folder', path: 'src/components/a/b', effect: 'show' },
    { kind: 'folder', path: 'src/components/a/b/c' },
  ]);
  assert.equal(componentVisible(reshown, 'src/components/a/X.astro'), false);
  assert.equal(componentVisible(reshown, 'src/components/a/b/X.astro'), true);
  assert.equal(componentVisible(reshown, 'src/components/a/b/c/X.astro'), false);
  const decided = resolveComponent(componentAccessIndex(reshown), 'src/components/a/b/X.astro');
  assert.deepEqual(decided.decision, { kind: 'folder', folder: 'src/components/a/b', effect: 'show' });
});

test('a package component has no project file and stays available; filtering keeps order', () => {
  assert.equal(componentRuleFile({ name: 'Button', origin: { kind: 'package' } }), undefined);
  assert.equal(componentRuleFile({ name: 'Card', folder: 'ui' }), 'src/components/ui/Card.astro');
  assert.equal(componentRuleFile({ name: 'Base', isLayout: true }), 'src/layouts/Base.astro');
  assert.equal(componentRuleFile({ name: 'Card', file: 'src\\components\\Card.astro' }), 'src/components/Card.astro');
  const items = ['src/components/interactive/Modal.astro', 'src/components/Card.astro', undefined, 'src/components/Hero.astro'];
  assert.deepEqual(
    visibleComponents(rules, items, (item) => item),
    ['src/components/Card.astro', undefined],
  );
});

test('rules for paths that no longer exist are reported missing and ignored', () => {
  const files = ['src/components/interactive/Modal.astro', 'src/components/Card.astro'];
  assert.deepEqual(
    missingComponentRules(rules, files).map((rule) => rule.path),
    ['src/components/interactive/Tabs.astro', 'src/components/interactive/legacy', 'src/components/Hero.astro'],
  );
  assert.equal(componentVisible(rules, 'src/components/Hero.astro'), false, 'a restored component picks its rule up again');
});

test('moving or renaming rewrites the rules on the component or beneath the folder', () => {
  const moved = moveComponentRules(rules, { kind: 'folder', path: 'src/components/interactive' }, 'src/components/widgets');
  assert.equal(componentVisible(moved, 'src/components/widgets/Modal.astro'), false);
  assert.equal(componentVisible(moved, 'src/components/widgets/Tabs.astro'), true);
  assert.equal(componentVisible(moved, 'src/components/widgets/legacy/Old.astro'), false);
  assert.equal(componentVisible(moved, 'src/components/interactive/Modal.astro'), true, 'the old path is a plain path again');
  const renamed = moveComponentRules(rules, { kind: 'component', path: 'src/components/Hero.astro' }, 'src/components/Banner.astro');
  assert.equal(componentVisible(renamed, 'src/components/Banner.astro'), false);
  assert.equal(renamed.length, rules.length);
  assert.throws(() => moveComponentRules(rules, { kind: 'folder', path: 'src/components/interactive' }, '../escape'), /not a project path/);
});

test('edits keep the fewest rules: a folder sets all of it, a component matching its folder keeps no rule', () => {
  const hiddenFolder = setComponentState([], { kind: 'folder', path: 'src/components/ui' }, 'hidden');
  assert.deepEqual(hiddenFolder, [{ kind: 'folder', path: 'src/components/ui', effect: 'hide' }]);
  const reshown = setComponentState(hiddenFolder, { kind: 'component', path: 'src/components/ui/Card.astro' }, 'visible');
  assert.equal(componentVisible(reshown, 'src/components/ui/Card.astro'), true);
  assert.equal(componentVisible(reshown, 'src/components/ui/Other.astro'), false);
  const folderAgain = setComponentState(reshown, { kind: 'folder', path: 'src/components/ui' }, 'hidden');
  assert.deepEqual(folderAgain, hiddenFolder, 'hiding the folder drops the override beneath it');
  assert.deepEqual(setComponentState(hiddenFolder, { kind: 'folder', path: 'src/components/ui' }, 'visible'), [], 'showing it again leaves no rule');
  const full = Array.from({ length: COMPONENT_ACCESS_LIMITS.rulesMax }, (_, index) => ({
    kind: 'component' as const,
    path: `src/components/C${index}.astro`,
    effect: 'hide' as const,
  }));
  assert.throws(() => setComponentState(full, { kind: 'component', path: 'src/components/One.astro' }, 'hidden'), ComponentRulesBoundError);
});

test('the parser refuses malformed rules and rules past a bound, and reads a repeat once', () => {
  assert.throws(() => parseComponentRules('x'), /must be a list/);
  assert.throws(() => parseComponentRules([{ kind: 'file', path: 'a.astro' }]), /"component" or a "folder"/);
  assert.throws(() => parseComponentRules([{ kind: 'folder', path: 'a', effect: 'maybe' }]), /hides or shows/);
  assert.throws(() => parseComponentRules([{ kind: 'folder', path: '' }]), /1 to 512 characters/);
  assert.throws(() => parseComponentRules([{ kind: 'folder', path: 'a/../b' }]), /not a project path/);
  assert.throws(() => parseComponentRules([{ kind: 'folder', path: 'a//b' }]), /not a project path/);
  assert.throws(() => parseComponentRules([{ kind: 'folder', path: 'x'.repeat(513) }]), /1 to 512 characters/);
  assert.throws(() => parseComponentRules([{ kind: 'folder', path: Array.from({ length: 34 }, () => 'a').join('/') }]), /folders deep/);
  assert.throws(() => parseComponentRules([{ kind: 'folder' }]), /expected|string|text/i);
  const over = Array.from({ length: COMPONENT_ACCESS_LIMITS.rulesMax + 1 }, (_, index) => ({ kind: 'component', path: `c${index}.astro` }));
  assert.throws(() => parseComponentRules(over), /at most 1024 component rules/);
  assert.equal(parseComponentRules(over.slice(0, COMPONENT_ACCESS_LIMITS.rulesMax)).length, COMPONENT_ACCESS_LIMITS.rulesMax, 'the bound itself parses');
  assert.deepEqual(
    parseComponentRules([
      { kind: 'folder', path: 'a' },
      { kind: 'folder', path: '/a/', effect: 'show' },
    ]),
    [{ kind: 'folder', path: 'a', effect: 'show' }],
  );
  assert.equal(parseComponentPath('a\\b\\'), 'a/b');
});

test('roles.json holds the rules for every role, admin included, and round-trips them', () => {
  const stored = parseProjectRoles({
    version: 1,
    roles: [
      { ...admin, componentRules: [{ kind: 'folder', path: 'src/components/secret' }] },
      { id: 'client', componentRules: [{ kind: 'component', path: 'src/components/A.astro', effect: 'show' }] },
    ],
  });
  assert.equal(stored.roles[0]?.componentRules.length, 1, 'admin keeps its rules');
  const view = roleViewOf(stored, 'admin');
  assert.equal(view.isAdmin, true);
  assert.equal(componentVisible(view.componentRules, 'src/components/secret/Key.astro'), false);
  assert.equal(can(view, 'settings:roles'), true, 'restricting admin never touches settings access');
  assert.equal(can(view, 'component:create'), true);
  const text = serializeProjectRoles(stored);
  assert.match(text, /"effect": "show"/);
  assert.doesNotMatch(text.split('"client"')[0] ?? '', /"effect"/, 'hide is the default and is not written');
  assert.deepEqual(parseProjectRolesSource(text), stored);
  assert.doesNotMatch(serializeProjectRoles(parseProjectRoles({ version: 1, roles: [admin] })), /componentRules/, 'a file without rules is written as before');
  assert.throws(() => parseProjectRoles({ version: 1, roles: [{ ...admin, componentRules: [{ kind: 'x', path: 'a' }] }] }), /"component" or a "folder"/);
});
