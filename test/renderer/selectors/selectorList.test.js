// Goal: the style selectors panel shows the entries a filter and search ask
// for, counts each verdict once, offers only `unused` entries for clean-up,
// and the delete prompt reads exactly the class and id names a deleted subtree
// wrote down.
// Method: run the panel's pure model and the delete prompt's name reader
// through the renderer bundler, over a hand-built report and node trees that
// include the negative space: expression attributes, blank class lists and an
// oversized subtree.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

const { selectorCounts, selectorGroups, unusedEntries, exactPatterns, unknownReasons, initialFilter } = loadRenderer('src/features/selectors/selectorList.ts');
const { namesInSubtree, DELETE_CLEANUP_LIMITS } = loadRenderer('src/features/selectors/deleteCleanup.ts');

const entry = (id, rel, selector, verdict) => ({ id, rel, line: 1, selector, scope: 'global', verdict });
const report = {
  entries: [
    entry('a|0|0|0', 'src/a.css', '.hero', { kind: 'used' }),
    entry('a|0|9|0', 'src/a.css', '.ghost', { kind: 'unused', names: ['ghost'] }),
    entry('b|0|0|0', 'src/b.astro', '.is-open', { kind: 'kept', names: ['is-open'] }),
    entry('b|0|5|0', 'src/b.astro', '.btn-large', { kind: 'unknown', names: ['btn-large'], reason: 'pieces' }),
    entry('b|0|9|0', 'src/b.astro', 'h1', { kind: 'untracked' }),
    entry('a|1|0|0', 'src/a.css', '.ghost', { kind: 'unused', names: ['ghost'] }),
    entry('b|0|20|0', 'src/b.astro', '.w--current', {
      kind: 'unknown',
      names: ['w--current'],
      reason: 'x.astro loads a script',
      scripts: [{ url: 'https://cdn.example.com/lib/x.js', rel: 'src/x.astro', trust: 'https://cdn.example.com/lib/' }],
    }),
  ],
  notes: [],
  files: [],
};

test('lists each selector once per file, skips ones a clean-up never touches, and filters', () => {
  assert.deepEqual(selectorCounts(report), { all: 5, unused: 1, unknown: 2, kept: 1 }, 'h1 is not listed; the second .ghost rule is the same row');
  assert.equal(initialFilter(report), 'unused');
  assert.deepEqual(
    selectorGroups(report, 'all', '').map((group) => [group.rel, group.entries.length]),
    [
      ['src/a.css', 2],
      ['src/b.astro', 3],
    ],
  );
  assert.deepEqual(
    selectorGroups(report, 'unused', '').flatMap((group) => group.entries.map((item) => item.selector)),
    ['.ghost'],
  );
  assert.deepEqual(
    selectorGroups(report, 'all', '  OPEN ').flatMap((group) => group.entries.map((item) => item.selector)),
    ['.is-open'],
  );
  assert.deepEqual(selectorGroups(report, 'kept', 'hero'), []);
});

test('"can\u2019t tell" is grouped by reason, largest first', () => {
  const reasons = unknownReasons(report, '');
  assert.deepEqual(
    reasons.map((group) => [group.reason, group.entries.length]),
    [
      ['pieces', 1],
      ['x.astro loads a script', 1],
    ],
  );
});

test('a clean-up removes every rule of an unused selector, and only exact keep patterns unlock', () => {
  assert.deepEqual(
    unusedEntries(report).map((item) => item.id),
    ['a|0|9|0', 'a|1|0|0'],
  );
  const keepList = { version: 1, keep: ['is-*', 'hero-badge'] };
  assert.deepEqual(exactPatterns(keepList, ['hero-badge']), ['hero-badge']);
  assert.deepEqual(exactPatterns(keepList, ['is-open']), [], 'a wildcard is edited in the file, not unlocked per name');
});

test('the delete prompt reads written class and id names, never expressions', () => {
  const tree = {
    props: { class: { type: 'string', value: ' card  card--wide ' }, id: { type: 'string', value: 'main' } },
    children: [
      { props: { class: { type: 'expr', value: 'computed' } }, children: [] },
      { props: { className: { type: 'string', value: 'badge' } } },
      { props: { class: { type: 'string', value: '' } } },
    ],
  };
  assert.deepEqual([...namesInSubtree(tree)].sort(), ['badge', 'card', 'card--wide', 'main']);
});

test('an oversized subtree offers nothing rather than a partial list', () => {
  let node = { props: { class: { type: 'string', value: 'leaf' } } };
  for (let depth = 0; depth < DELETE_CLEANUP_LIMITS.nodesMax + 1; depth += 1) {
    node = { children: [node] };
  }
  assert.deepEqual(namesInSubtree(node), []);
});
