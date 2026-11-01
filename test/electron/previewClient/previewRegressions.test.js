// Goal: the canvas morph (electron/previewClient/morphClient.ts) patches large pages within a
// linear budget and never lets identity collide — a missing id, a comment
// standing in for text, or a script whose source contains separators.
// Method: the morph's own functions are cut out of the built client and run
// against jsdom documents built for each case, with the same bounds main
// prepends in the app.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { transpileSource } = require('../../helpers/sourceText.js');
const loadMorphModules = require('../../helpers/morphModules.js');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
const document = dom.window.document;
global.document = document;
// The client's modules, bundled for jsdom; main prepends the patcher's bounds
// from shared/core/limits.ts (step 7).
const { LIMITS } = require('#dist/shared/core/limits.js');
const morph = loadMorphModules(LIMITS);
// The diff alone, with a counting Int32Array, from its own module's source.
const source = transpileSource('electron/previewClient/morphPatch.ts');

const tree = (html) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};

test('large unchanged sibling lists and appends stay within a linear allocation budget', () => {
  let allocated = 0;
  const diff = new Function(
    'Int32Array',
    `${source.slice(source.indexOf('function diffChildren('), source.indexOf('// Raised when the live document'))}\nreturn diffChildren;`,
  )(function BudgetedArray(size) {
    allocated += size;
    assert.ok(allocated < 100_000, 'unchanged siblings allocated a quadratic matrix');
    return new Int32Array(size);
  });
  const keys = Array.from({ length: 10_000 }, (_, i) => `e:DIV#${i}`);
  const appended = diff(keys, [...keys, 'e:DIV#new']);
  assert.equal(appended.length, keys.length + 1);
  assert.ok(appended.slice(0, -1).every(([kind, i, j], at) => kind === 0 && i === at && j === at));
  assert.deepEqual(appended.at(-1), [1, -1, keys.length]);
  assert.deepEqual(diff([...keys, 'e:DIV#old'], keys).at(-1), [-1, keys.length, -1]);
});

test('child matching retains deletion-first ties and indices after a shared prefix', () => {
  assert.deepEqual(morph.diffChildren(['head', 'a', 'b'], ['head', 'b', 'a']), [
    [0, 0, 0],
    [-1, 1, -1],
    [0, 2, 1],
    [1, -1, 2],
  ]);
  assert.deepEqual(morph.diffChildren(['a', 'b'], ['b', 'b']), [
    [-1, 0, -1],
    [0, 1, 0],
    [1, -1, 1],
  ]);
  assert.deepEqual(morph.diffChildren([], ['a']), [[1, -1, 0]]);
  assert.deepEqual(morph.diffChildren(['a'], []), [[-1, 0, -1]]);
});

test('a missing explicit id cannot redirect an edit onto an unrelated live element', () => {
  const before = tree('<p id="wanted">before</p>');
  const after = tree('<p id="wanted">after</p>');
  const live = tree('<p id="other">before</p>');
  const original = live.innerHTML;
  assert.equal(morph.findLive(live.firstChild, before.firstChild), undefined);
  assert.throws(() => morph.patchChildren(live, before, after), /cannot line up/);
  assert.equal(live.innerHTML, original);
});

test('a comment cannot stand in for missing text', () => {
  assert.equal(morph.findLive(tree('<!--before-->').firstChild, tree('before').firstChild), undefined);
});

test('script identity cannot collide with separators inside source text', () => {
  const before = tree('<script>one\n@@\n |  | two</script>');
  const after = tree('<script>one</script><script>two</script>');
  assert.equal(morph.addedScripts(before, after), undefined);
});

test('instrumentation remains only in the Stacki design frame', () => {
  assert.equal(morph.previewHost('#avb-design'), 'stacki');
  assert.equal(morph.previewHost(''), 'browser');
  assert.equal(morph.previewHost('#features'), 'browser');

  const page = new JSDOM(
    '<!doctype html><!--avb-d:stamp--><!--avb-s:0-->' +
      '<html data-avb-p="src/layouts/Base.astro|0" data-avb-d="avb-d:stamp">' +
      '<head data-avb-p="0.0"></head>' +
      '<body><!--avb-s:0.1--><main data-avb-p="0.1">Site</main><!--avb-e:0.1--></body>' +
      '</html><!--avb-e:0-->',
  );
  morph.stripPreviewInstrumentation(page.window.document);
  assert.doesNotMatch(page.serialize(), /avb-[sed]:|data-avb-[pd]/);
  assert.equal(page.window.document.querySelector('main')?.textContent, 'Site');
});

test('scripts retain ordering, multiplicity, and loading attributes', () => {
  const first = '<script type="module" src="/first.js"></script>';
  const second = '<script type="module" src="/second.js"></script>';
  assert.equal(morph.addedScripts(tree(first + second), tree(second + first)), undefined);
  assert.equal(morph.addedScripts(tree(first + first), tree(first)), undefined);
  assert.equal(morph.addedScripts(tree(first), tree(first + first)), undefined);
  assert.equal(morph.addedScripts(tree(first), tree(first.replace('type="module"', 'type="module" integrity="new"'))), undefined);
  assert.deepEqual(morph.addedScripts(tree(first), tree('<script src="/first.js" type="module"></script>')), []);

  const script =
    '<script type="module" src="/with | separator.js" integrity="sha256-value" ' +
    'crossorigin="anonymous" nonce="nonce-value" referrerpolicy="no-referrer"></script>';
  const added = morph.addedScripts(tree(first), tree(first + script));
  assert.equal(added.length, 1);
  assert.equal(added[0].src, '/with | separator.js');
  morph.runScripts(added);
  const loaded = document.head.querySelector('script');
  const wanted = tree(script).firstChild;
  for (const attr of wanted.attributes) {
    assert.equal(loaded.getAttribute(attr.name), attr.value);
  }
  morph.runScripts(added);
  assert.equal(document.head.querySelectorAll('script').length, 1);
});
