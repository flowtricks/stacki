// Goal: the Feedback panel trusts only parsed replies, hands the agent the open
// items in order under the file's absolute path, and pins a note only on the
// page it was left on. Methodology: parse a good reply and one missing `done`;
// render the handoff for a mix of open and done items; then run the pin rule
// over notes on this page (inside a component too), another page, an agent's
// own note without a canvas place, and a done one. Revealing a note from the
// list is checked in two halves: the plan (stay, open its page, or nothing)
// over the same kinds of note, and the canvas's wait for the pin to be measured
// on a fresh page before it scrolls, never on the previous page's rects.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');

const bridge = loadRenderer('src/features/feedback/feedbackBridge.ts');
const { feedbackPins, feedbackRevealPlan } = loadRenderer('src/features/feedback/feedbackState.ts');
const { revealTarget } = loadRenderer('src/features/preview/feedbackReveal.ts');

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

test('revealing a note stays on its page or opens it first', () => {
  // Real key order: content a page slots into its layout lists the layout first,
  // so the page is found among the keys, never assumed to be the first.
  const layout = 'src/layouts/BaseLayout.astro#1.1.2.0';
  const section = 'src/components/wrapper/Section.astro#0.0.0.1.0.0.0';
  const heading = 'src/components/typography/Heading.astro#0.0.0';
  const marker = { path: 'src/components/typography/Heading.astro|0.0.0', occurrence: 0 };
  const onHome = item('home', [layout, section, 'src/pages/index.astro#0.0.0.1', heading], [], {
    marker,
  });
  const onMissing = item('404', [layout, section, 'src/pages/404.astro#0.0.0.0', heading], [], {
    marker,
  });
  const pageRels = ['src/pages/index.astro', 'src/pages/404.astro'];
  const at = (pageRel) => ({ pageRel, pageRels });
  assert.deepEqual(feedbackRevealPlan(onHome, at('src/pages/index.astro')), { kind: 'here' });
  assert.deepEqual(feedbackRevealPlan(onMissing, at('src/pages/index.astro')), {
    kind: 'open-page',
    page: 'src/pages/404.astro',
  });
  // With no page open yet, a placed note still has its page to open.
  assert.deepEqual(feedbackRevealPlan(onHome, at(undefined)), {
    kind: 'open-page',
    page: 'src/pages/index.astro',
  });
  // Its page was deleted: the layout and components are not pages to open.
  assert.deepEqual(
    feedbackRevealPlan(onMissing, {
      pageRel: 'src/pages/index.astro',
      pageRels: pageRels.slice(0, 1),
    }),
    { kind: 'no-page' },
  );
  // Nothing to show: no item, a done one, or an agent's note without a place.
  assert.deepEqual(feedbackRevealPlan(undefined, at('src/pages/index.astro')), { kind: 'none' });
  assert.deepEqual(feedbackRevealPlan({ ...onHome, done: true }, at('src/pages/index.astro')), {
    kind: 'none',
  });
  assert.deepEqual(feedbackRevealPlan(item('agent', [], []), at('src/pages/index.astro')), {
    kind: 'none',
  });
  assert.throws(
    () => feedbackRevealPlan({ ...onHome, keys: ['nohash'] }, at('src/pages/index.astro')),
    /names its file/,
  );
});

test('the canvas scrolls to a pin only once its page has measured it', () => {
  const pin = { id: 'a', path: '0.2', occurrence: 1, index: 1, note: 'Note a' };
  const box = { x: 0, y: 900, w: 10, h: 10 };
  const measured = { 0.2: [box, box] };
  const ask = (overrides) =>
    revealTarget({ revealId: 'a', pins: [pin], rects: measured, ...overrides });
  assert.equal(ask({ stale: undefined }), pin);
  // Its page is still opening: no pin yet.
  assert.equal(ask({ pins: [], stale: undefined }), undefined);
  // The previous page's rects, even with a path of the same name, do not count.
  assert.equal(ask({ stale: measured }), undefined);
  // The fresh page has not measured the pin yet.
  assert.equal(ask({ rects: {}, stale: measured }), undefined);
  assert.equal(ask({ rects: { 0.2: [] }, stale: undefined }), undefined);
  assert.equal(ask({ rects: { ...measured }, stale: measured }), pin);
});
