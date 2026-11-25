// Goal: a Git checkpoint upload stores in R2 exactly when the container sent a whole,
// declared, in-limit body whose SHA-256 is the key; every other upload is refused with
// a precise status and leaves no object behind (issue #80: R2 needs a known length).
// Method: run the real Worker in workerd (workerRuntime.ts) with a local R2 bucket.
// Well-formed uploads go through Miniflare's fetch. The Worker's own validation (a missing,
// malformed, empty or oversized Content-Length, a body longer than declared) is checked by
// handing its fetch handler a Request built inside workerd (runtime.direct): over HTTP, the
// Worker answers such a request before reading its body, and the runtime may then reset the
// connection while the client is still sending, so the client sees ECONNRESET instead of the
// status, nondeterministically. Only a body cut short, which needs real framing, goes over a
// raw socket, where a reset or the 400 both count as refused. After every refusal the bucket
// is read back to prove nothing partial was kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { startWorkerRuntime, WORKER_TEST, type WorkerRuntime, WORKER_RUNTIME_LIMITS } from './workerRuntime';

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

/** A PUT handed straight to the Worker's fetch handler, with exactly these headers. */
async function directPut(
  runtime: WorkerRuntime,
  digest: string,
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
  options: { readonly streamed?: boolean } = {},
) {
  const response = await runtime.direct({
    url: 'https://studio.test' + bundlePath(digest),
    method: 'PUT',
    headers: { 'x-studio-token': WORKER_TEST.containerToken, ...headers },
    body: Buffer.from(body).toString('base64'),
    ...(options.streamed === undefined ? {} : { streamed: options.streamed }),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Writes `head` then `body` over a raw socket and half-closes. The status, or `reset` when the
 * runtime closed the connection without an answer: both are refusals.
 */
async function rawRequest(runtime: WorkerRuntime, head: string, body: Uint8Array): Promise<{ readonly status: number | 'reset'; readonly text: string }> {
  const origin = await runtime.origin();
  const socket = connect({ host: origin.hostname, port: Number(origin.port) });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finished = new Promise<string | 'reset'>((resolve, reject) => {
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
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
        resolve('reset');
      } else {
        reject(error);
      }
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
  if (response === 'reset' || response.length === 0) {
    return { status: 'reset', text: '' };
  }
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

test(
  'Git checkpoint uploads reach R2 only whole, declared, in limit and matching their digest',
  { timeout: WORKER_RUNTIME_LIMITS.testFileMs },
  async (context) => {
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
      const answer = await directPut(runtime, digest, body, {}, { streamed: true });
      assert.equal(answer.status, 411);
      assert.match(answer.text, /Content-Length/);
      assert.equal(await stored(runtime, digest), false);
    });

    await context.test('a malformed Content-Length is refused as missing', async () => {
      const body = new TextEncoder().encode('1234');
      const digest = digestOf(body);
      // Leading and trailing spaces are not here: Fetch trims header values, so " 4" is 4.
      for (const header of ['+4', '4.0', '0x4', '4e0', '4, 4', '-4', '']) {
        const answer = await directPut(runtime, digest, body, { 'content-length': header }, { streamed: true });
        assert.equal(answer.status, 411, `Content-Length ${JSON.stringify(header)}`);
      }
      assert.equal(await stored(runtime, digest), false);
    });

    await context.test('a declared length above 96 MiB is refused with 413 without reading the body', async () => {
      const body = new TextEncoder().encode('tiny');
      const digest = digestOf(body);
      for (const header of [String(96 * 1024 ** 2 + 1), '9007199254740993', '9'.repeat(16)]) {
        const answer = await directPut(runtime, digest, body, { 'content-length': header }, { streamed: true });
        assert.equal(answer.status, 413, header);
        assert.match(answer.text, /96 MiB/);
      }
      assert.equal(await stored(runtime, digest), false);
    });

    await context.test('an empty checkpoint is refused', async () => {
      const digest = digestOf(new Uint8Array(0));
      const answer = await directPut(runtime, digest, new Uint8Array(0), { 'content-length': '0' }, { streamed: true });
      assert.equal(answer.status, 400);
      assert.equal(await stored(runtime, digest), false);
    });

    await context.test('a body longer than its Content-Length is refused and stores nothing', async () => {
      const whole = new Uint8Array(4096).fill(7);
      const declared = whole.subarray(0, 1000);
      for (const digest of [digestOf(whole), digestOf(declared)]) {
        const answer = await directPut(runtime, digest, whole, { 'content-length': String(declared.length) }, { streamed: true });
        assert.notEqual(answer.status, 204, answer.text);
        assert.ok(answer.status >= 400);
        assert.equal(await stored(runtime, digest), false);
      }
    });

    await context.test('a body shorter than its Content-Length is refused and stores nothing', async () => {
      const whole = new Uint8Array(4096).fill(42);
      const digest = digestOf(whole);
      const answer = await rawRequest(runtime, rawHead(digest, String(whole.length)), whole.subarray(0, 1000));
      if (answer.status !== 'reset') {
        assert.equal(answer.status, 400, answer.text);
        assert.match(answer.text, /Content-Length/);
      }
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
    assert.deepEqual(
      runtime.unexpectedLogs([/^Git checkpoint upload ended early/, /^Git checkpoint storage failed/, /disconnected/i]),
      [],
      'The runtime logged no unexpected warning or error',
    );
  },
);
