// Goal: a refused internal request has its body read before the 403, so the connection closes with no
// request bytes left unread (Windows resets such a connection, and the caller saw "fetch failed" instead
// of the refusal); a body larger than the bound, or one without a declared length, is cancelled instead
// of read without a limit. internal() calls discardBody on its refusal (internalRoutes.ts); the real
// refusal over a socket is cloudflareStartup.test.ts.
// Method: call discardBody with real Request objects in Node and read bodyUsed after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discardBody, REFUSED_BODY_BYTES_MAX } from '../src/cloudflare/requestBody';

const report = JSON.stringify({ stage: 'drafts', sinceStartMs: 1200 });

test('a body within the bound is read to the end', async () => {
  const request = new Request('https://studio.test/studio/internal/startup', {
    method: 'POST',
    body: report,
    headers: { 'content-length': String(report.length) },
  });
  await discardBody(request);
  assert.equal(request.bodyUsed, true);
  await discardBody(new Request('https://studio.test/x'));
});

test('a body over the bound is cancelled, not read', async () => {
  // Node's Request recomputes content-length from the body, so the over-the-bound request is a plain
  // stand-in with the same three members discardBody reads.
  let read = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    cancel: () => {
      cancelled = true;
    },
  });
  await discardBody({
    body,
    headers: new Headers({ 'content-length': String(REFUSED_BODY_BYTES_MAX + 1) }),
    arrayBuffer: () => {
      read = true;
      return Promise.resolve(new ArrayBuffer(0));
    },
  });
  assert.equal(read, false, 'not read');
  assert.equal(cancelled, true, 'cancelled');
});

test('the internal routes refuse through discardBody', async () => {
  const source = await readFile(new URL('../src/cloudflare/internalRoutes.ts', import.meta.url), 'utf8');
  assert.match(source, /await discardBody\(request\);\s*return new Response\('Forbidden', \{ status: 403 \}\);/);
});
