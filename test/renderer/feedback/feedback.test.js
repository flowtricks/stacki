// Goal: the Feedback panel trusts only parsed replies, hands the agent the open
// items in order, and pins a note only where its node is on the canvas.
// Methodology: parse a good reply and one missing `done`; render the handoff
// for a mix of open and done items; then run the pin rule against the three
// cases that decide it (same page, drilled into a component, another page).
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');

const bridge = loadRenderer('src/features/feedback/feedbackBridge.ts');
const { feedbackPins } = loadRenderer('src/features/feedback/feedbackState.ts');

const item = (id, keys, trail, done = false) => ({
  id,
  keys,
  label: 'h1',
  note: `Note ${id}`,
  done,
  trail,
});

test('replies parse completely or not at all', () => {
  const good = item('a', ['src/pages/index.astro#0'], ['src/pages/index.astro:1-3']);
  assert.deepEqual(bridge.parseFeedbackReply({ items: [good] }), [good]);
  const { done: _done, ...missingDone } = good;
  assert.throws(() => bridge.parseFeedbackReply({ items: [missingDone] }), /Expected boolean/);
  assert.throws(() => bridge.parseFeedbackReply({ items: [{ ...good, trail: [1] }] }), /string/);
});

test('the handoff numbers open items only and joins a trail with ›', () => {
  const text = bridge.renderHandoff([
    item('a', [], ['src/pages/index.astro:12-18']),
    item('b', [], ['src/pages/index.astro:30'], true),
    item('c', [], ['src/pages/index.astro:31-33', 'src/components/Hero.astro:9-14']),
    item('d', [], []),
  ]);
  const lines = text.split('\n');
  assert.match(lines[0], /^Address the open items in \.stacki\/feedback\.json \(3 open\)\./);
  assert.deepEqual(lines.slice(2), [
    '1. src/pages/index.astro:12-18 (h1): Note a',
    '2. src/pages/index.astro:31-33 › src/components/Hero.astro:9-14 (h1): Note c',
    '3. (no source location) (h1): Note d',
  ]);
});

test('a note pins only at its own level of the editing stack', () => {
  const page = 'src/pages/index.astro';
  const host = `${page}#0.4`;
  const items = [
    item('onPage', [`${page}#0.2.1`], []),
    item('inHero', [host, 'src/components/Hero.astro#1.0'], []),
    item('otherPage', ['src/pages/about.astro#0'], []),
    item('pageNote', [`${page}#`], []),
    item('done', [`${page}#0`], [], true),
  ];
  assert.deepEqual(feedbackPins(items, { selectionKeys: [`${page}#0`], editedRel: undefined }), [
    { id: 'onPage', path: '0.2.1', index: 1, note: 'Note onPage' },
  ]);
  const drilled = {
    selectionKeys: [host, 'src/components/Hero.astro#'],
    editedRel: 'src/components/Hero.astro',
  };
  assert.deepEqual(feedbackPins(items, drilled), [
    { id: 'inHero', path: 'src/components/Hero.astro|1.0', index: 2, note: 'Note inHero' },
  ]);
  assert.deepEqual(feedbackPins(items, { selectionKeys: [], editedRel: undefined }), []);
});
