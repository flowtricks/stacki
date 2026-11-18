// Goal: the pure rules behind duplicating and deleting components hold: a copy gets the first free name in the
// project's own naming style, deleting a component removes its recipe key and every nested reference to it (and
// nothing else), role rules for a deleted component or folder are dropped, and a target is read only when it is a
// project-relative component or folder path.
// Method: call each function over generated values, including the negative space (taken names, climbing paths,
// unknown kinds, an unrelated recipe that must come back untouched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComponentDefaults } from '#dist/shared/properties/componentDefaults.js';
import {
  COMPONENT_OP_LIMITS,
  copyName,
  dropDefaultsFor,
  dropRulesFor,
  parseComponentOpError,
  parseComponentOpTarget,
  targetOwns,
  parseComponentUses,
} from '#dist/shared/properties/componentOps.js';

test('a copy takes the first free name, in the style of the original', () => {
  assert.equal(
    copyName('Button', () => false),
    'ButtonCopy',
  );
  assert.equal(
    copyName('Button', (name) => name === 'ButtonCopy'),
    'ButtonCopy2',
  );
  assert.equal(
    copyName('Button', (name) => ['ButtonCopy', 'ButtonCopy2'].includes(name)),
    'ButtonCopy3',
  );
  assert.equal(
    copyName('hero-card', () => false),
    'hero-card-copy',
  );
  assert.equal(
    copyName('hero-card', (name) => name === 'hero-card-copy'),
    'hero-card-copy-2',
  );
  assert.equal(
    copyName('hero_card', () => false),
    'hero_card_copy',
  );
});

test('a copy gives up, loudly, when every attempt is taken', () => {
  let asked = 0;
  assert.equal(
    copyName('Button', () => {
      asked += 1;
      return true;
    }),
    undefined,
  );
  assert.equal(asked, COMPONENT_OP_LIMITS.copyNameAttemptsMax);
  assert.throws(() => copyName('', () => false), /Assertion failed: A copy starts from a name/);
  assert.throws(() => copyName('a/b', () => false), /one path segment/);
});

const config = {
  version: 1,
  components: {
    'src/components/Card.astro': {
      children: [
        { component: 'src/components/Button.astro', props: { label: 'Go' } },
        { literal: 'x' },
        { element: 'p', children: [{ component: 'src/components/Button.astro' }] },
      ],
    },
    'src/components/Button.astro': { props: { label: 'Hi' } },
    'src/components/Other.astro': { text: 'untouched' },
  },
} as const;

test('deleting a component drops its recipe and every nested reference, and nothing else', () => {
  const target = { kind: 'component', path: 'src/components/Button.astro' } as const;
  const next = dropDefaultsFor(parseComponentDefaults(config), (file) => targetOwns(target, file));
  assert.deepEqual(Object.keys(next.components), ['src/components/Card.astro', 'src/components/Other.astro']);
  assert.deepEqual(next.components['src/components/Card.astro'], { children: [{ literal: 'x' }, { element: 'p', children: [] }] });
  assert.deepEqual(next.components['src/components/Other.astro'], { text: 'untouched' });
});

test('deleting a folder drops every recipe and reference under it', () => {
  const target = { kind: 'folder', path: 'src/components' } as const;
  const next = dropDefaultsFor(parseComponentDefaults(config), (file) => targetOwns(target, file));
  assert.deepEqual(next.components, {});
  assert.equal(targetOwns({ kind: 'folder', path: 'src/components/ui' }, 'src/components/uikit/A.astro'), false);
});

test('role rules for the deleted component or folder go; others stay', () => {
  const rules = [
    { kind: 'component', path: 'src/components/ui/Tabs.astro', effect: 'hide' },
    { kind: 'folder', path: 'src/components/ui', effect: 'hide' },
    { kind: 'component', path: 'src/components/Card.astro', effect: 'hide' },
    { kind: 'folder', path: 'src/components/uikit', effect: 'show' },
  ] as const;
  assert.deepEqual(
    dropRulesFor(rules, { kind: 'component', path: 'src/components/ui/Tabs.astro' }).map((rule) => rule.path),
    ['src/components/ui', 'src/components/Card.astro', 'src/components/uikit'],
  );
  assert.deepEqual(
    dropRulesFor(rules, { kind: 'folder', path: 'src/components/ui' }).map((rule) => rule.path),
    ['src/components/Card.astro', 'src/components/uikit'],
  );
});

test('a target is a component or folder with a clean project path; anything else is refused', () => {
  assert.deepEqual(parseComponentOpTarget({ kind: 'component', path: 'src/components/A.astro' }), { kind: 'component', path: 'src/components/A.astro' });
  assert.deepEqual(parseComponentOpTarget({ kind: 'folder', path: 'src/components/ui' }), { kind: 'folder', path: 'src/components/ui' });
  for (const bad of [
    { kind: 'page', path: 'src/components/A.astro' },
    { kind: 'component', path: '../x.astro' },
    { kind: 'component', path: 'src/../x.astro' },
    { kind: 'folder', path: '' },
    'text',
    undefined,
  ]) {
    assert.throws(() => parseComponentOpTarget(bad));
  }
  assert.deepEqual(parseComponentOpError({ code: 'in-use', message: 'x' }), { code: 'in-use', message: 'x' });
  assert.throws(() => parseComponentOpError({ code: 'nope', message: 'x' }));
});

test('a deletion mode is read at the boundary and never defaulted', () => {
  assert.equal(parseComponentUses('refuse'), 'refuse');
  assert.equal(parseComponentUses('remove'), 'remove');
  for (const bad of ['', 'delete', undefined, true]) {
    assert.throws(() => parseComponentUses(bad), /A deletion mode is "refuse" or "remove"/);
  }
});
