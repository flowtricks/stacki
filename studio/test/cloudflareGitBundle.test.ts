// Goal: a Git checkpoint upload stores in R2 exactly when the container sent a whole,
// declared, in-limit body whose SHA-256 is the key; every other upload is refused with
// a precise status and leaves no object behind (issue #80: R2 needs a known length).
// Method: run the real Worker in workerd (workerRuntime.ts) with a local R2 bucket.
// Well-formed uploads go through Miniflare's fetch; malformed framing (a bad or huge
// Content-Length, a body cut short) is written byte for byte over a raw socket, since
// no fetch client will send it. After each refusal the bucket is read back to prove
// nothing partial was kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { startWorkerRuntime, WORKER_TEST, type WorkerRuntime } from './workerRuntime';

const RAW_RESPONSE_TIMEOUT_MS = 30_000;
const RAW_RESPONSE_BYTES_MAX = 64 * 1024;

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bundlePath(digest: string): string {
  return '/studio/internal/git-bundle?digest=' + digest;
}

async function stored(runtime: WorkerRuntime, digest: string): Promise<boolean> {
  const bucket = await runtime.drafts();
  return (await bucket.head('git-bundles/' + digest)) !== null;
}

/** Writes `head` then `body` over a raw socket, half-closes, and returns the status line's code and the body. */
async function rawRequest(runtime: WorkerRuntime, head: string, body: Uint8Array): Promise<{ readonly status: number; readonly text: string }> {
  const origin = await runtime.origin();
  const socket = connect({ host: origin.hostname, port: Number(origin.port) });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finished = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('The Worker did not answer the raw request in time'));
    }, RAW_RESPONSE_TIMEOUT_MS);
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > RAW_RESPONSE_BYTES_MAX) {
        socket.destroy();
        reject(new Error('The raw response exceeded its limit'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
  });
  socket.write(head);
  socket.write(body);
  socket.end();
  const response = await finished;
  const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
  assert.ok(match?.[1], 'The Worker answered with an HTTP status line: ' + response.slice(0, 200));
  const separator = response.indexOf('\r\n\r\n');
  return { status: Number(match[1]), text: separator < 0 ? '' : response.slice(separator + 4) };
}

function rawHead(digest: string, contentLength: string): string {
  return (
    `PUT ${bundlePath(digest)} HTTP/1.1\r\n` +
    'Host: studio.test\r\n' +
    `x-studio-token: ${WORKER_TEST.containerToken}\r\n` +
    `Content-Length: ${contentLength}\r\n` +
    'Connection: close\r\n\r\n'
  );
}

test('Git checkpoint uploads reach R2 only whole, declared, in limit and matching their digest', async (context) => {
  const runtime = await startWorkerRuntime();
  context.after(() => runtime.dispose());

  await context.test('a declared body streams into R2 under its digest', async () => {
    const body = new Uint8Array(256 * 1024).map((_, index) => index % 251);
    const digest = digestOf(body);
    const response = await runtime.fetch('https://studio.test' + bundlePath(digest), {
      method: 'PUT',
      headers: { 'x-studio-token': WORKER_TEST.containerToken },
      body,
    });
    assert.equal(response.status, 204, await response.text());
    const bucket = await runtime.drafts();
    const object = await bucket.get('git-bundles/' + digest);
    assert.ok(object, 'The checkpoint is stored');
    assert.equal(digestOf(new Uint8Array(await object.arrayBuffer())), digest);
    const read = await runtime.fetch('https://studio.test' + bundlePath(digest), { headers: { 'x-studio-token': WORKER_TEST.containerToken } });
    assert.equal(read.status, 200);
    assert.equal(digestOf(new Uint8Array(await read.arrayBuffer())), digest);
  });

  await context.test('a body without Content-Length is refused with 411 before R2 sees it', async () => {
    const body = new TextEncoder().encode('streamed without a length');
    const digest = digestOf(body);
    // An async iterable has no length, so the client sends it chunked.
    const stream = (async function* () {
      yield body;
    })();
    const response = await runtime.fetch('https://studio.test' + bundlePath(digest), {
      method: 'PUT',
      headers: { 'x-studio-token': WORKER_TEST.containerToken },
      body: stream,
      duplex: 'half',
    });
    assert.equal(response.status, 411);
    assert.match(await response.text(), /Content-Length/);
    assert.equal(await stored(runtime, digest), false);
  });

  // The HTTP layer itself may refuse some of these before the Worker runs; either way nothing is stored.
  await context.test('a malformed Content-Length is refused', async () => {
    const body = new TextEncoder().encode('1234');
    const digest = digestOf(body);
    for (const header of ['+4', '4.0', '0x4', '4e0']) {
      const answer = await rawRequest(runtime, rawHead(digest, header), body);
      assert.ok(answer.status >= 400, `Content-Length "${header}" answered ${answer.status}`);
    }
    assert.equal(await stored(runtime, digest), false);
  });

  await context.test('a declared length above 96 MiB is refused with 413 without reading the body', async () => {
    const body = new TextEncoder().encode('tiny');
    const digest = digestOf(body);
    const answer = await rawRequest(runtime, rawHead(digest, String(96 * 1024 ** 2 + 1)), body);
    assert.equal(answer.status, 413);
    assert.match(answer.text, /96 MiB/);
    assert.equal(await stored(runtime, digest), false);
  });

  await context.test('an empty checkpoint is refused', async () => {
    const digest = digestOf(new Uint8Array(0));
    const answer = await rawRequest(runtime, rawHead(digest, '0'), new Uint8Array(0));
    assert.equal(answer.status, 400);
    assert.equal(await stored(runtime, digest), false);
  });

  await context.test('a body shorter than its Content-Length is refused and stores nothing', async () => {
    const whole = new Uint8Array(4096).fill(42);
    const digest = digestOf(whole);
    const answer = await rawRequest(runtime, rawHead(digest, String(whole.length)), whole.subarray(0, 1000));
    assert.equal(answer.status, 400, answer.text);
    assert.match(answer.text, /Content-Length/);
    assert.equal(await stored(runtime, digest), false);
  });

  await context.test('a body whose SHA-256 is not its key is refused precisely and stores nothing', async () => {
    const body = new TextEncoder().encode('these bytes are not the named checkpoint');
    const digest = digestOf(new TextEncoder().encode('another checkpoint'));
    const response = await runtime.fetch('https://studio.test' + bundlePath(digest), {
      method: 'PUT',
      headers: { 'x-studio-token': WORKER_TEST.containerToken },
      body,
    });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /^Git checkpoint storage failed: /);
    assert.equal(await stored(runtime, digest), false);
  });

  await context.test('uploads without the container token never reach storage', async () => {
    const body = new TextEncoder().encode('unauthenticated');
    const digest = digestOf(body);
    const response = await runtime.fetch('https://studio.test' + bundlePath(digest), { method: 'PUT', body });
    assert.equal(response.status, 403);
    assert.equal(await stored(runtime, digest), false);
  });
});
