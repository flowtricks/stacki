// Goal: the registry of `.stacki/components.json` accepts the recipes the app writes (props, text, nested children) and refuses
// shapes the parser would reject or silently drop.
// Method: a realistic recipe file in the shape componentRenamePlan writes passes the registry and the app parser; known-bad
// documents (unknown key, wrong type, bad path, out-of-bounds list, missing required) are refused by the registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPONENTS_FILE } from '#dist/shared/properties/cli/files/componentsFile.js';
import { refusalOfSource } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const registryRefusal = (document: unknown): string | undefined => checkValue({ kind: 'object', fields: COMPONENTS_FILE.fields }, document, 'components');

const good = {
  version: 1,
  components: {
    'src/components/Card.astro': {
      props: { variant: 'outline', columns: 3, featured: true },
      children: [
        { element: 'h3', text: 'Title' },
        { component: 'src/components/Button.astro', props: { label: 'Go' }, inherit: false },
        { element: 'div', children: [{ element: 'p', children: [{ literal: 'Deep text' }] }] },
      ],
    },
    'src/components/Note.astro': { text: 'Hello' },
    'src/components/Img.astro': {
      assets: { src: { file: 'src/assets/art.svg' }, mobile: { file: 'src/assets/art.svg', url: true } },
      literals: { options: '["a"]', shots: { source: '[a]', imports: { a: 'src/assets/art.svg' } } },
    },
  },
};

test('a recipe file written the way the app writes it passes the registry and the app parser', () => {
  assert.equal(registryRefusal(good), undefined);
  assert.equal(refusalOfSource(COMPONENTS_FILE, JSON.stringify(good, undefined, 2)), undefined);
});

test('the empty document passes both', () => {
  assert.equal(registryRefusal(COMPONENTS_FILE.empty), undefined);
  assert.equal(refusalOfSource(COMPONENTS_FILE, JSON.stringify(COMPONENTS_FILE.empty)), undefined);
});

test('known-bad documents are refused by the registry', () => {
  const recipe = (body: unknown): unknown => ({ version: 1, components: { 'src/components/Card.astro': body } });
  const bad: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['an unknown top-level key', { ...good, recipes: {} }, /unknown key/],
    ['an unknown recipe key', recipe({ prop: {} }), /unknown key/],
    ['an unknown child key', recipe({ children: [{ element: 'p', kind: 'x' }] }), /unknown key/],
    ['a wrong version', { version: 2, components: {} }, /expected 1/],
    ['a missing components map', { version: 1 }, /components: required/],
    ['a path that is not a component', { version: 1, components: { 'README.md': {} } }, /is not a component file path/],
    ['text of the wrong type', recipe({ text: 5 }), /expected text/],
    ['children of the wrong type', recipe({ children: 'x' }), /expected a list/],
    ['an inherit other than false', recipe({ children: [{ component: 'src/components/A.astro', inherit: true }] }), /expected false/],
    ['an invalid element name', recipe({ children: [{ element: 'Div' }] }), /does not match/],
    ['an invalid prop name', recipe({ props: { '1bad': 'x' } }), /is not a prop name/],
    ['an asset with no file', recipe({ assets: { src: {} } }), /file: required/],
    ['an asset outside src', recipe({ assets: { src: { file: 'public/a.png' } } }), /does not match/],
    ['too many children', recipe({ children: Array.from({ length: 33 }, () => ({ literal: 'x' })) }), /at most/],
  ];
  for (const [what, document, reason] of bad) {
    const refusal = registryRefusal(document);
    assert.ok(refusal !== undefined && reason.test(refusal), `${what}: ${String(refusal)}`);
  }
});
