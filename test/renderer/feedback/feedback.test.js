// Goal: the Feedback panel trusts only parsed replies, hands the agent the open
// items in order under the file's absolute path, and pins a note only on the
// page it was left on. Methodology: parse a good reply and one missing `done`;
// render the handoff for a mix of open and done items; then run the pin rule
// over notes on this page (inside a component too), another page, an agent's
// own note without a canvas place, and a done one.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');

const bridge = loadRenderer('src/features/feedback/feedbackBridge.ts');
const { feedbackPins } = loadRenderer('src/features/feedback/feedbackState.ts');

const item = (id, keys, trail, extra = {}) => ({
  id,
  keys,
  label: 'h1',
  note: `Note ${id}`,
  done: false,
  trail,
  ...extra,
});

test('replies parse completely or not at all', () => {
  const good = item('a', ['src/pages/index.astro#0'], ['src/pages/index.astro:1-3'], {
    marker: { path: '0', occurrence: 0 },
  });
  assert.deepEqual(bridge.parseFeedbackReply({ items: [good] }), [good]);
  const { done: _done, ...missingDone } = good;
  assert.throws(() => bridge.parseFeedbackReply({ items: [missingDone] }), /Expected boolean/);
  assert.throws(() => bridge.parseFeedbackReply({ items: [{ ...good, trail: [1] }] }), /string/);
  const badMarker = { ...good, marker: { path: '0', occurrence: -1 } };
  assert.throws(() => bridge.parseFeedbackReply({ items: [badMarker] }), /nonnegative/);
});

test('the handoff names the file absolutely and numbers open items only', () => {
  const text = bridge.renderHandoff(
    [
      item('a', [], ['src/pages/index.astro:12-18']),
      item('b', [], ['src/pages/index.astro:30'], { done: true }),
      item('c', [], ['src/pages/index.astro:31-33', 'src/components/Hero.astro:9-14']),
      item('d', [], []),
    ],
    '/sites/my-site',
  );
  const lines = text.split('\n');
  assert.match(lines[0], /^Address the open items in \/sites\/my-site\/\.stacki\/feedback\.json/);
  assert.match(lines[0], /\(3 open\)\. Trails are relative to \/sites\/my-site\./);
  assert.deepEqual(lines.slice(2), [
    '1. src/pages/index.astro:12-18 (h1): Note a',
    '2. src/pages/index.astro:31-33 › src/components/Hero.astro:9-14 (h1): Note c',
    '3. (no source location) (h1): Note d',
  ]);
});

test('a note pins on the page it was left on, at its copy of the element', () => {
  const page = 'src/pages/index.astro';
  const hero = 'src/components/Hero.astro';
  const items = [
    item('onPage', [`${page}#0.2.1`], [], { marker: { path: '0.2.1', occurrence: 0 } }),
    item('inHero', [`${page}#0.4`, `${hero}#1.0`], [], {
      marker: { path: `${hero}|1.0`, occurrence: 2 },
    }),
    item('otherPage', ['src/pages/about.astro#0'], [], { marker: { path: '0', occurrence: 0 } }),
    item('agent', [], []),
    item('done', [`${page}#0`], [], { done: true, marker: { path: '0', occurrence: 0 } }),
  ];
  assert.deepEqual(feedbackPins(items, page), [
    { id: 'onPage', path: '0.2.1', occurrence: 0, index: 1, note: 'Note onPage' },
    { id: 'inHero', path: `${hero}|1.0`, occurrence: 2, index: 2, note: 'Note inHero' },
  ]);
  assert.deepEqual(feedbackPins(items, 'src/pages/blog.astro'), []);
});
