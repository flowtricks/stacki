// Goal: Design mode's messages and its render route's body cross a postMessage and an HTTP body, so each end
// parses them; known-good shapes pass, and every malformed field, out-of-bound size, forged path and prototype key
// is refused. The branded ids accept their grammar only.
//
// Method: the compiled contract (dist/shared) over hand-written inputs, one assertion per refusal reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESIGN_MODE_LIMITS,
  DESIGN_MODE_REPLY_TYPE,
  DESIGN_MODE_REQUEST_TYPE,
  designModeReplyMessage,
  designModeRequestMessage,
  isDesignComponentPath,
  parseDesignModeReply,
  parseDesignModeRequest,
  parseDesignRenderBody,
  type DesignModeRequest,
} from '../../../shared/designMode/designModeContract.ts';
import { toDesignElementId, toFrameId } from '../../../shared/designMode/designIds.ts';

const NONCE = '0b1c2d3e-aaaa-bbbb';
// JSON's own null and a prototype key, as a body parsed from text holds them.
const JSON_NULL: unknown = JSON.parse('null');
const PROTO_PROPS: unknown = JSON.parse('{"__proto__": 1}');
const BODY = {
  component: 'src/components/Button.astro',
  props: { emphasis: 'secondary', on: true, size: 2, list: [1, 'a'] },
  slots: { default: '<b>Go</b>' },
};

test('component paths: a project .astro file under src, outside src/pages, with no dot segments', () => {
  assert.equal(isDesignComponentPath('src/components/Button.astro'), true);
  assert.equal(isDesignComponentPath('src/layouts/Base Layout.astro'), true);
  for (const bad of ['src/pages/index.astro', 'src/../etc/x.astro', '/src/x.astro', 'src/x.ts', 'node_modules/a/x.astro', 'src//x.astro', 3, undefined]) {
    assert.equal(isDesignComponentPath(bad), false, String(bad));
  }
  assert.equal(isDesignComponentPath('src/' + 'a'.repeat(DESIGN_MODE_LIMITS.componentPathCharsMax) + '.astro'), false);
});

test('a render body parses with JSON props and slot HTML, and each malformed part is refused', () => {
  assert.deepEqual(parseDesignRenderBody(BODY), BODY);
  assert.deepEqual(parseDesignRenderBody({ ...BODY, props: { empty: JSON_NULL } })?.props, { empty: JSON_NULL }, "JSON's null is a value a prop holds");
  assert.equal(parseDesignRenderBody({ ...BODY, component: 'src/pages/a.astro' }), undefined);
  assert.equal(parseDesignRenderBody({ ...BODY, props: [] }), undefined);
  assert.equal(parseDesignRenderBody({ ...BODY, props: { 'bad name': 1 } }), undefined);
  assert.equal(parseDesignRenderBody({ ...BODY, props: PROTO_PROPS }), undefined);
  assert.equal(parseDesignRenderBody({ ...BODY, props: { n: Number.POSITIVE_INFINITY } }), undefined);
  assert.equal(parseDesignRenderBody({ ...BODY, props: { f: () => 1 } }), undefined);
  assert.equal(parseDesignRenderBody({ ...BODY, props: { long: 'x'.repeat(DESIGN_MODE_LIMITS.propValueCharsMax) } }), undefined);
  let deep: unknown = 1;
  for (let depth = 0; depth < 12; depth += 1) {
    deep = [deep];
  }
  assert.equal(parseDesignRenderBody({ ...BODY, props: { deep } }), undefined, 'nesting past the depth bound');
  assert.equal(parseDesignRenderBody({ ...BODY, slots: { default: 3 } }), undefined);
  assert.equal(parseDesignRenderBody({ ...BODY, slots: { default: 'x'.repeat(DESIGN_MODE_LIMITS.slotCharsMax + 1) } }), undefined);
  assert.equal(parseDesignRenderBody(undefined), undefined);
});

test('requests round-trip through their message, and others are not requests', () => {
  const requests: readonly DesignModeRequest[] = [
    { op: 'snapshot', nonce: NONCE },
    { op: 'render', nonce: NONCE, body: BODY },
    { op: 'preview', nonce: NONCE, component: 'src/components/Card.astro' },
  ];
  for (const request of requests) {
    assert.deepEqual(parseDesignModeRequest(designModeRequestMessage(request)), request);
  }
  assert.equal(parseDesignModeRequest({ type: 'avb:query', op: 'snapshot', nonce: NONCE }), undefined);
  assert.equal(parseDesignModeRequest({ type: DESIGN_MODE_REQUEST_TYPE, op: 'snapshot', nonce: 'short' }), undefined);
  assert.equal(parseDesignModeRequest({ type: DESIGN_MODE_REQUEST_TYPE, op: 'write', nonce: NONCE }), undefined, 'no other operation exists');
  assert.equal(parseDesignModeRequest({ type: DESIGN_MODE_REQUEST_TYPE, op: 'preview', nonce: NONCE, component: 'src/pages/x.astro' }), undefined);
  assert.throws(() => designModeRequestMessage({ op: 'snapshot', nonce: 'bad nonce!' }), /a nonce of the request grammar/);
});

test('replies parse: a snapshot, HTML and a failure; forged ones are ignored', () => {
  const snapshot = { html: '<html></html>', url: 'http://127.0.0.1:4321/', title: 'Home', viewportWidthPx: 1440, viewportHeightPx: 900 };
  assert.deepEqual(parseDesignModeReply(designModeReplyMessage({ nonce: NONCE, ok: true, kind: 'snapshot', snapshot })), {
    nonce: NONCE,
    ok: true,
    kind: 'snapshot',
    snapshot,
  });
  assert.deepEqual(parseDesignModeReply({ type: DESIGN_MODE_REPLY_TYPE, nonce: NONCE, ok: true, kind: 'html', html: '<b>' }), {
    nonce: NONCE,
    ok: true,
    kind: 'html',
    html: '<b>',
  });
  assert.deepEqual(parseDesignModeReply({ type: DESIGN_MODE_REPLY_TYPE, nonce: NONCE, ok: false, failure: 'too-large', detail: '9' }), {
    nonce: NONCE,
    ok: false,
    failure: 'too-large',
    detail: '9',
  });
  assert.equal(parseDesignModeReply({ type: DESIGN_MODE_REPLY_TYPE, nonce: NONCE, ok: false, failure: 'exploded', detail: '' }), undefined);
  assert.equal(
    parseDesignModeReply({ type: DESIGN_MODE_REPLY_TYPE, nonce: NONCE, ok: true, kind: 'snapshot', snapshot: { ...snapshot, url: 'javascript:alert(1)' } }),
    undefined,
  );
  assert.equal(
    parseDesignModeReply({ type: DESIGN_MODE_REPLY_TYPE, nonce: NONCE, ok: true, kind: 'snapshot', snapshot: { ...snapshot, viewportWidthPx: -1 } }),
    undefined,
  );
  assert.equal(parseDesignModeReply({ type: DESIGN_MODE_REPLY_TYPE, nonce: NONCE, ok: 'yes' }), undefined);
  assert.equal(parseDesignModeReply({ type: 'other', nonce: NONCE, ok: true, kind: 'html', html: '' }), undefined);
});

test('frame and element ids accept their grammar only', () => {
  assert.equal(toFrameId('f1a'), 'f1a');
  assert.equal(toDesignElementId('e0'), 'e0');
  assert.equal(toDesignElementId('n12'), 'n12');
  assert.throws(() => toFrameId('x1'), /toFrameId/);
  assert.throws(() => toDesignElementId('e"]'), /toDesignElementId/);
});
