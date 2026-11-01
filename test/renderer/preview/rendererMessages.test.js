// Exercise iframe replies through real parsers and the pending-query lifecycle.
// Fake postMessage avoids a browser; real promises expose cancellation and limits.
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');
const { parseCanvasReply } = loadRenderer('src/editor/canvasReply.ts');
const canvas = loadRenderer('src/editor/canvasQuery.ts');

const valid = {
  id: 1,
  found: true,
  ready: true,
  // An element without an id: the frame sends `id: undefined`, and the parser
  // leaves an absent field out of what it returns.
  identity: { tag: 'div', classes: ['card'], attributes: { class: 'card' } },
  matched: { '.card': true, '[': undefined },
  computed: { 'var(--color)': 'rgb(0, 0, 0)' },
  computedProps: { display: 'block' },
  authoredProps: { 'font-size': 'var(--heading-size)' },
  inheritedSources: { 'font-size': { label: '.heading', path: '0' } },
};
assert.equal(parseCanvasReply(valid).ok, true);
assert.equal(parseCanvasReply({ ...valid, identity: { ...valid.identity, id: undefined } }).ok, true);
for (const input of [
  PLATFORM_NULL,
  [],
  {},
  { ...valid, id: -1 },
  { ...valid, id: 1.5 },
  { ...valid, id: Number.MAX_SAFE_INTEGER + 1 },
  { ...valid, found: 'yes' },
  { ...valid, ready: 1 },
  // The protocol spells absence `undefined`; the retired `null` is malformed.
  { ...valid, identity: PLATFORM_NULL },
  { ...valid, identity: { ...valid.identity, id: PLATFORM_NULL } },
  { ...valid, matched: { '.card': PLATFORM_NULL } },
  { ...valid, computed: { color: PLATFORM_NULL } },
  { ...valid, identity: { tag: 123 } },
  { ...valid, identity: { ...valid.identity, classes: [1] } },
  { ...valid, matched: { '.card': 'yes' } },
  { ...valid, computed: { color: 123 } },
  { ...valid, computedProps: { color: false } },
  { ...valid, inheritedSources: { color: { label: 123 } } },
  { ...valid, inheritedSources: { color: { label: '.parent', path: 42 } } },
  {
    ...valid,
    inheritedSources: { color: { label: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) } },
  },
  { ...valid, inheritedSources: PLATFORM_NULL },
  { ...valid, authoredProps: { 'font-size': 16 } },
  { ...valid, authoredProps: { color: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) } },
  { ...valid, identity: { ...valid.identity, classes: Array(100001).fill('a') } },
  { ...valid, identity: { ...valid.identity, tag: 'a'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) } },
]) {
  assert.equal(parseCanvasReply(input).ok, false);
}

async function main() {
  const sent = [];
  canvas.setCanvasFrame({ postMessage: (message) => sent.push(message) });
  const result = canvas.queryCanvas('0', ['.card']);
  const id = sent[0].id;
  canvas.receiveCanvasReply({ id, found: false, ready: false });
  canvas.noteCanvasReady();
  assert.equal(sent.length, 2);
  canvas.receiveCanvasReply({ ...valid, id, matched: { '.card': 'invalid' } });
  canvas.receiveCanvasReply({ ...valid, id });
  assert.deepEqual(await result, {
    identity: valid.identity,
    matched: valid.matched,
    computed: valid.computed,
    computedProps: valid.computedProps,
    authoredProps: valid.authoredProps,
    inheritedSources: valid.inheritedSources,
  });

  const cancelled = canvas.queryCanvas('1');
  canvas.setCanvasFrame(undefined);
  assert.equal(await cancelled, undefined);
  assert.equal(canvas.hasCanvas(), false);
  assert.equal(await canvas.queryCanvas('2'), undefined);
  canvas.setCanvasFrame({
    postMessage() {
      throw new Error('detached');
    },
  });
  assert.equal(await canvas.queryCanvas('3'), undefined);
  assert.equal(canvas.tellCanvas({ type: 'test' }), false);

  canvas.setCanvasFrame({ postMessage() {} });
  const waiting = Array.from({ length: canvas.CANVAS_LIMITS.pendingMax }, () => canvas.queryCanvas('0'));
  assert.equal(await canvas.queryCanvas('overflow'), undefined);
  canvas.setCanvasFrame(undefined);
  assert.equal(
    (await Promise.all(waiting)).every((value) => value === undefined),
    true,
  );

  const { createPreviewWatch } = loadRenderer('src/features/preview/previewRecovery.ts');
  for (const duration of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(
      () =>
        createPreviewWatch({
          probe: async () => ({ ok: true }),
          onRecover() {},
          retryMs: duration,
        }),
      /Preview interval/,
    );
  }
  console.log('renderer-messages: parser rejection, held replies, cancellation and bounds passed');
}
main().catch((error) => {
  canvas.setCanvasFrame(undefined);
  console.error(error);
  process.exitCode = 1;
});
