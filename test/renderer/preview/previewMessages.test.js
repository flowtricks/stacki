// Goal: project iframes cannot place unbounded or malformed measurements into
// renderer state. Methodology: parse every message variant, then corrupt
// numeric, nested, discriminant, and collection fields at the boundary.
const test = require('node:test');
const assert = require('node:assert/strict');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');
const { parsePreviewMessage, parseShortcutMessage, describePreviewReload, PREVIEW_RELOAD_REASONS } = require('../../helpers/rendererModule')(
  'src/features/preview/previewMessages.ts',
);

const box = { x: -1.5, y: 2, w: 30, h: 40 };
const TOKEN = 'a'.repeat(64);
const spacing = {
  padding: { top: 2, right: 3, bottom: 4, left: 5 },
  margin: { top: 1 },
  gaps: [{ ...box, axis: 'row' }],
  units: { em: 20, rem: 16, vw: 12.8, vh: 7.2 },
};

test('preview message parser preserves every supported message variant', () => {
  const messages = [
    {
      type: 'avb:rects',
      rects: { 0: [box] },
      classes: { 0: [['card']] },
      spacing: { 0: [spacing] },
    },
    { type: 'avb:node-classes', classes: { 0: ['card'] } },
    { type: 'avb:rendered-nodes', paths: ['0'] },
    { type: 'avb:node-states', hidden: ['0'], inert: [], before: ['0.1'], after: [] },
    { type: 'avb:modifiers', shiftKey: true, altKey: false },
    { type: 'avb:hover-node', path: undefined, occurrence: 0 },
    { type: 'avb:click-node', path: '0', occurrence: 1, outside: false },
    { type: 'avb:open-node', path: '0', occurrence: 2 },
    { type: 'avb:canvas-ready' },
    { type: 'avb:query-result', id: 1, found: false },
    {
      type: 'avb:render',
      token: TOKEN,
      stamps: [{ file: 'src/pages/index.astro', checksum: TOKEN }],
    },
  ];
  assert.deepEqual(
    messages.map((message) => parsePreviewMessage(message)?.kind),
    ['rects', 'node-classes', 'rendered-nodes', 'node-states', 'modifiers', 'hover-node', 'click-node', 'open-node', 'canvas-ready', 'query-result', 'render'],
  );
  assert.deepEqual(parsePreviewMessage(messages[0]).spacing['0'], [spacing]);
});

test('located events carry the rendering token they landed on (step 7)', () => {
  const click = { type: 'avb:click-node', path: '0', occurrence: 0, outside: false };
  assert.equal(parsePreviewMessage({ ...click, token: TOKEN }).token, TOKEN);
  // Before the frame has digested its rendering, events carry none — absent to
  // the gate, which refuses them.
  assert.equal(parsePreviewMessage({ ...click, token: undefined }).token, undefined);
  assert.equal(parsePreviewMessage(click).token, undefined);
  assert.equal(
    parsePreviewMessage({
      type: 'avb:hover-node',
      path: undefined,
      occurrence: 0,
      token: TOKEN,
    }).token,
    TOKEN,
  );
  // The protocol spells absence `undefined`, like the rest of the app; the
  // retired `null` spelling is a malformed message, not an absent value.
  assert.equal(parsePreviewMessage({ ...click, token: PLATFORM_NULL }), undefined);
  assert.equal(parsePreviewMessage({ type: 'avb:hover-node', path: PLATFORM_NULL, occurrence: 0 }), undefined);
  assert.equal(
    parsePreviewMessage({
      type: 'avb:rects',
      rects: { 0: PLATFORM_NULL },
      classes: {},
      spacing: {},
    }),
    undefined,
  );
  assert.equal(parsePreviewMessage({ type: 'avb:open-node', path: '1', occurrence: 2, token: TOKEN }).token, TOKEN);
});

test('a reload names its reason; only the caps are announced to the user (step 7)', () => {
  for (const reason of PREVIEW_RELOAD_REASONS) {
    assert.deepEqual(parsePreviewMessage({ type: 'avb:preview-reload', reason }), {
      kind: 'preview-reload',
      reason,
    });
  }
  assert.equal(parsePreviewMessage({ type: 'avb:preview-reload', reason: 'bored' }), undefined);
  assert.equal(parsePreviewMessage({ type: 'avb:preview-reload' }), undefined);
  const announced = PREVIEW_RELOAD_REASONS.filter((reason) => describePreviewReload(reason));
  assert.deepEqual(announced, ['markers-over-cap', 'diff-over-cap']);
});

test('preview message parser ignores unknown and malformed project messages', () => {
  for (const value of [
    PLATFORM_NULL,
    { type: 'other' },
    { type: 'avb:rects', rects: { 0: [{ ...box, w: -1 }] }, classes: {}, spacing: {} },
    { type: 'avb:rects', rects: { 0: [{ ...box, x: Number.NaN }] }, classes: {}, spacing: {} },
    {
      type: 'avb:rects',
      rects: {},
      classes: {},
      spacing: { 0: [{ gaps: [{ ...box, axis: 'diagonal' }] }] },
    },
    { type: 'avb:rects', rects: {}, classes: {}, spacing: { 0: [{ units: { rem: -16 } }] } },
    { type: 'avb:rects', rects: {}, classes: {}, spacing: { 0: [{ units: { rem: '16' } }] } },
    { type: 'avb:rects', rects: {}, classes: {}, spacing: { 0: [{ units: [16] }] } },
    { type: 'avb:click-node', path: '0', occurrence: -1, outside: false },
    { type: 'avb:modifiers', shiftKey: 'yes', altKey: false },
    { type: 'avb:rendered-nodes', paths: Array(100_001).fill('0') },
    { type: 'avb:click-node', path: '0', occurrence: 0, outside: false, token: 'not-a-digest' },
    { type: 'avb:render', token: 'x', stamps: [] },
    { type: 'avb:render', token: TOKEN, stamps: [{ file: '../escape.astro', checksum: TOKEN }] },
    {
      type: 'avb:render',
      token: TOKEN,
      stamps: [
        { file: 'b.astro', checksum: TOKEN },
        { file: 'a.astro', checksum: TOKEN },
      ],
    },
  ]) {
    assert.equal(parsePreviewMessage(value), undefined);
  }
});

test('forwarded shortcuts parse each variant and ignore every other or malformed message', () => {
  const shortcut = (fields) => parseShortcutMessage({ type: 'avb:shortcut', ...fields });
  assert.deepEqual(shortcut({ name: 'insert' }), { name: 'insert' });
  assert.deepEqual(shortcut({ name: 'arrow', key: 'ArrowUp' }), { name: 'arrow', key: 'ArrowUp' });
  assert.deepEqual(parseShortcutMessage({ type: 'avb:shortcut', name: 'key', key: 'd', meta: true }), { name: 'key', key: 'd', meta: true });
  // Anything but a literal true is no modifier: a page cannot smuggle one in.
  assert.deepEqual(parseShortcutMessage({ type: 'avb:shortcut', name: 'key', key: 'Delete', meta: 'yes' }), { name: 'key', key: 'Delete', meta: false });
  for (const input of [
    undefined,
    PLATFORM_NULL,
    'avb:shortcut',
    { type: 'avb:rects' },
    { type: 'avb:shortcut' },
    { type: 'avb:shortcut', name: 'reload' },
    { type: 'avb:shortcut', name: 'arrow' },
    { type: 'avb:shortcut', name: 'arrow', key: 40 },
    { type: 'avb:shortcut', name: 'key', key: 'k'.repeat(33), meta: false },
  ]) {
    assert.equal(parseShortcutMessage(input), undefined);
  }
});

test('guide measurements parse, absent values stay absent, and bounds hold', () => {
  const guide = {
    type: 'avb:guide',
    viewportWidth: 1440,
    rootFontSize: 16,
    margin: 48,
    gutter: 32,
    widthMax: undefined,
    variables: { '--pad': 40, '--missing': undefined },
    counts: { '--cols': 10, '--pad': undefined },
  };
  assert.deepEqual(parsePreviewMessage(guide), {
    kind: 'guide',
    metrics: {
      viewportWidthPx: 1440,
      rootFontPx: 16,
      marginPx: 48,
      gutterPx: 32,
      widthMaxPx: undefined,
      variablesPx: { '--pad': 40, '--missing': undefined },
      variableCounts: { '--cols': 10, '--pad': undefined },
    },
  });
  const five = { '--pad': 4, '--gap': 6, '--max': 8, '--cols': 25, '--site-columns': 12 };
  const measured = parsePreviewMessage({ ...guide, variables: five, counts: five });
  assert.deepEqual(measured.metrics.variablesPx, five);
  assert.deepEqual(measured.metrics.variableCounts, five);
  // Counts arrive as the page read them: the range is the model's to apply.
  for (const count of [0, 49, 140, 999]) {
    const counts = { '--cols': count };
    assert.equal(parsePreviewMessage({ ...guide, counts }).metrics.variableCounts['--cols'], count);
  }
  for (const bad of [
    { margin: -1 },
    { gutter: Number.NaN },
    { widthMax: 100_001 },
    { viewportWidth: '1440' },
    { rootFontSize: 0 },
    { rootFontSize: 1_001 },
    { margin: PLATFORM_NULL },
    { variables: undefined },
    { variables: { '--pad': -1 } },
    { variables: { 'pad;color:red': 4 } },
    { variables: { '--a': 1, '--b': 2, '--c': 3, '--d': 4, '--e': 5, '--f': 6 } },
    { counts: undefined },
    { counts: { '--cols': 2.5 } },
    { counts: { 'cols;color:red': 4 } },
    { counts: { '--a': 1, '--b': 2, '--c': 3, '--d': 4, '--e': 5, '--f': 6 } },
  ]) {
    assert.equal(parsePreviewMessage({ ...guide, ...bad }), undefined, JSON.stringify(bad));
  }
});

test('context menu coordinates are bounded and preserve the located target', () => {
  const message = {
    type: 'avb:context-node',
    path: '0.1',
    occurrence: 2,
    token: TOKEN,
    outside: false,
    left: 12.5,
    top: 400,
  };
  assert.deepEqual(parsePreviewMessage(message), {
    kind: 'context-node',
    path: '0.1',
    occurrence: 2,
    token: TOKEN,
    outside: false,
    left: 12.5,
    top: 400,
  });
  for (const bad of [undefined, PLATFORM_NULL, '20', -1, Infinity, NaN, 100_001]) {
    assert.equal(parsePreviewMessage({ ...message, left: bad }), undefined);
    assert.equal(parsePreviewMessage({ ...message, top: bad }), undefined);
  }
  for (const bad of [{ occurrence: -1 }, { outside: undefined }, { token: 'invalid' }]) {
    assert.equal(parsePreviewMessage({ ...message, ...bad }), undefined);
  }
});
