// Goal: a page that "loaded" but cannot be shown is told apart from one that can, and the reason is specific.
// The original bug: the dev server answered 200, started streaming, then a component threw. The canvas went black
// with nothing to say why. classifyPreviewResponse names that case (a cut-off or empty body), a 5xx, the dev
// server's own error screen, a dropped connection and a dead server, and extractThrownError pulls the thrown text
// out of the dev server's log so the notice can show it.
// Method: generated HTML bodies for every verdict, the boundary between a healthy page and each failure (a page
// whose body is only scripts, a non-HTML answer, a body capped by the reader), the log extractor on a generated
// Astro-style log, and the wire parser on good and corrupted values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PREVIEW_HEALTH_LIMITS,
  classifyPreviewResponse,
  extractThrownError,
  parsePreviewHealth,
  type PreviewResponseSample,
} from '#dist/shared/ipc/previewHealth.js';

const GOOD_PAGE =
  '<!doctype html><html lang="en"><head><title>Home</title><script type="module" src="/@vite/client"></script></head><body><h1>Hello</h1></body></html>';

// Named fields only: each test overrides the few it is about.
type SampleOverrides = { readonly [Field in keyof PreviewResponseSample]?: PreviewResponseSample[Field] };

function sample(overrides: SampleOverrides): PreviewResponseSample {
  return { reached: true, status: 200, contentType: 'text/html; charset=utf-8', body: GOOD_PAGE, reading: 'complete', ...overrides };
}

test('a complete page is ok', () => {
  const health = classifyPreviewResponse(sample({}));
  assert.equal(health.kind, 'ok');
  assert.equal(health.thrown, undefined);
});

test('a server that did not answer is unreachable', () => {
  assert.equal(classifyPreviewResponse(sample({ reached: false, status: 0, body: '' })).kind, 'unreachable');
});

test('a 5xx is a server error, and a 4xx page is not an error of the dev server', () => {
  assert.equal(classifyPreviewResponse(sample({ status: 500, body: '<html><body>boom</body></html>' })).kind, 'server-error');
  assert.equal(classifyPreviewResponse(sample({ status: 503 })).kind, 'server-error');
  assert.equal(classifyPreviewResponse(sample({ status: 404 })).kind, 'ok');
});

test('the dev server error screen is recognised on a 500 and on a 200, and its message is extracted', () => {
  const message = 'ReferenceError: title is not defined';
  const overlay = `<!doctype html><html><body><script type="module">import { ErrorOverlay } from '/@vite/client'; document.body.appendChild(new ErrorOverlay({"message":${JSON.stringify(message)},"stack":"at x"}))</script><vite-error-overlay></vite-error-overlay></body></html>`;
  const onFiveHundred = classifyPreviewResponse(sample({ status: 500, body: overlay }));
  assert.equal(onFiveHundred.kind, 'error-overlay');
  assert.equal(onFiveHundred.thrown, message);
  const onTwoHundred = classifyPreviewResponse(sample({ status: 200, body: overlay }));
  assert.equal(onTwoHundred.kind, 'error-overlay');
  assert.equal(onTwoHundred.thrown, message);
});

test('a 200 with no body is an empty page', () => {
  assert.equal(classifyPreviewResponse(sample({ body: '' })).kind, 'empty-page');
  assert.equal(classifyPreviewResponse(sample({ body: '   \n ' })).kind, 'empty-page');
});

test('a document whose body holds nothing but scripts, styles and comments is an empty page', () => {
  const body = '<!doctype html><html><head></head><body><script>1</script><style>a{}</style><!-- gone --> \n</body></html>';
  assert.equal(classifyPreviewResponse(sample({ body })).kind, 'empty-page');
  const withText = '<!doctype html><html><body><script>1</script>hi</body></html>';
  assert.equal(classifyPreviewResponse(sample({ body: withText })).kind, 'ok');
  const withElement = '<!doctype html><html><body><script>1</script><div></div></body></html>';
  assert.equal(classifyPreviewResponse(sample({ body: withElement })).kind, 'ok');
});

test('a page that ends before its closing html tag is truncated, even though the status said 200', () => {
  const cut = GOOD_PAGE.slice(0, GOOD_PAGE.indexOf('</h1>'));
  const health = classifyPreviewResponse(sample({ body: cut }));
  assert.equal(health.kind, 'truncated');
  assert.equal(health.status, 200);
});

test('a connection dropped after the headers is a dropped page, with whatever arrived', () => {
  const health = classifyPreviewResponse(sample({ reading: 'dropped', body: '<!doctype html><html><head><title>x</title>' }));
  assert.equal(health.kind, 'dropped');
  assert.equal(classifyPreviewResponse(sample({ reading: 'dropped', body: '' })).kind, 'dropped');
});

test('a body the reader stopped at its cap is not judged truncated: the end was never seen', () => {
  const capped = GOOD_PAGE.slice(0, GOOD_PAGE.indexOf('</body>'));
  assert.equal(classifyPreviewResponse(sample({ body: capped, reading: 'capped' })).kind, 'ok');
});

test('an answer that is not HTML is judged by status alone', () => {
  assert.equal(classifyPreviewResponse(sample({ contentType: 'application/json', body: '{"a":1' })).kind, 'ok');
  assert.equal(classifyPreviewResponse(sample({ contentType: 'application/json', status: 500, body: '{}' })).kind, 'server-error');
  assert.equal(classifyPreviewResponse(sample({ contentType: undefined, body: GOOD_PAGE })).kind, 'ok');
});

test('a fragment that is not a document is not called truncated', () => {
  assert.equal(classifyPreviewResponse(sample({ body: '<div>partial component</div>' })).kind, 'ok');
});

test('the dropped page and empty page keep the thrown text the caller supplies from the log', () => {
  const log = '12:00:01 [ERROR] Cannot read properties of undefined (reading "title")\n    at Page.astro:4:10';
  assert.match(extractThrownError(log) ?? '', /Cannot read properties of undefined/);
});

test('extractThrownError takes the last error with its frames, ignores colour codes, and is bounded', () => {
  const log = [
    '12:00:00 [watch] src/pages/index.astro',
    '12:00:01 \u001b[31m[ERROR]\u001b[39m First failure',
    '12:00:05 \u001b[31m[ERROR]\u001b[39m ReferenceError: items is not defined',
    '    at eval (/site/src/pages/index.astro:12:3)',
    '    at renderPage (node_modules/astro/dist/core/render.js:10:1)',
    '12:00:06 [200] / 12ms',
  ].join('\n');
  const thrown = extractThrownError(log);
  assert.ok(thrown !== undefined);
  assert.match(thrown, /ReferenceError: items is not defined/);
  assert.match(thrown, /index\.astro:12:3/);
  assert.doesNotMatch(thrown, /First failure/);
  assert.doesNotMatch(thrown, /\u001b/);
  assert.doesNotMatch(thrown, /\[200\]/);
  assert.equal(extractThrownError('12:00:00 [200] / 3ms\n12:00:01 [watch] x'), undefined);
  assert.equal(extractThrownError(''), undefined);
  const huge = `[ERROR] ${'x'.repeat(50_000)}`;
  assert.ok((extractThrownError(huge) ?? '').length <= PREVIEW_HEALTH_LIMITS.thrownCharsMax);
});

test('a bare error name line with no timestamp is found too', () => {
  const thrown = extractThrownError('TypeError: x is not a function\n    at a (b.js:1:1)');
  assert.match(thrown ?? '', /TypeError: x is not a function/);
});

test('parsePreviewHealth accepts every verdict and refuses corrupted values', () => {
  const kinds = ['ok', 'server-error', 'empty-page', 'truncated', 'dropped', 'error-overlay', 'unreachable'] as const;
  for (const kind of kinds) {
    const parsed = parsePreviewHealth({ kind, status: 200, thrown: undefined, logTail: '' });
    assert.equal(parsed.kind, kind);
  }
  assert.equal(parsePreviewHealth({ kind: 'ok', status: 200, thrown: 'x', logTail: 'y' }).thrown, 'x');
  assert.throws(() => parsePreviewHealth(undefined));
  assert.throws(() => parsePreviewHealth({ kind: 'weird', status: 200, thrown: undefined, logTail: '' }));
  assert.throws(() => parsePreviewHealth({ kind: 'ok', status: 1.5, thrown: undefined, logTail: '' }));
  assert.throws(() => parsePreviewHealth({ kind: 'ok', status: 200, thrown: 5, logTail: '' }));
  assert.throws(() => parsePreviewHealth({ kind: 'ok', status: 200, thrown: undefined, logTail: 'x'.repeat(PREVIEW_HEALTH_LIMITS.logTailCharsMax + 1) }));
  assert.throws(() => parsePreviewHealth({ kind: 'ok', status: 200, thrown: 'x'.repeat(PREVIEW_HEALTH_LIMITS.thrownCharsMax + 1), logTail: '' }));
});
