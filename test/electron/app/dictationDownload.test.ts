// Goal: the dictation model's downloader writes only the pinned bytes, only from allowed hosts, and
// never leaves a half file where a whole one is expected. A clean download verifies every hash and
// writes the marker that makes the folder count as installed; a wrong hash, a body longer than the
// manifest and a redirect to another host are refused; a dropped connection keeps its part file and
// the next download resumes it with a Range request; a server that ignores the range starts over; a
// cancel is reported as one; removing the model removes its folder. The scheme that serves the model
// to the worker answers only the manifest's files of an installed model.
// Methodology: a local HTTP server on 127.0.0.1 serves a fake two-file manifest (tiny buffers whose
// SHA-256 the test computes), with routes that misbehave on purpose; the downloader runs against it
// with a loopback allow-list and a real temporary folder. No model is downloaded, nothing leaves the machine.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadModel, PART_SUFFIX, VERIFIED_FILE, type DownloadDeps } from '#dist/electron/app/dictationDownload.js';
import { modelBaseURL, serveModelRequest } from '#dist/electron/app/dictationProtocol.js';
import { modelDirectory, readInstall, removeModel, removeStrayFiles } from '#dist/electron/app/dictationStore.js';
import type { WhisperModel } from '#dist/shared/properties/voice/whisperModels.js';

const configBytes = Buffer.from('{"model":"fake"}\n');
const weightBytes = Buffer.alloc(64 * 1024, 7);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const fakeModel: WhisperModel = {
  id: 'small',
  repository: 'test/fake',
  revision: 'a'.repeat(40),
  license: 'MIT',
  encoder: 'q8',
  decoder: 'q8',
  devices: ['wasm'],
  files: [
    { path: 'config.json', sizeBytes: configBytes.length, sha256: sha(configBytes) },
    { path: 'onnx/weights.onnx', sizeBytes: weightBytes.length, sha256: sha(weightBytes) },
  ],
};

interface Behaviour {
  /** What the server does for the weights file. */
  weights: 'ok' | 'wrongBytes' | 'tooLong' | 'dropHalf' | 'ignoreRange' | 'redirectAway' | 'redirectHome' | 'notFound';
  readonly ranges: string[];
}

async function serve(behaviour: Behaviour): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/';
    if (url === '/config.json') {
      response.writeHead(200, { 'Content-Length': configBytes.length });
      response.end(configBytes);
      return;
    }
    if (url === '/home/weights') {
      sendWeights(request, response, behaviour, 'ok');
      return;
    }
    if (url === '/onnx/weights.onnx') {
      sendWeights(request, response, behaviour, behaviour.weights);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null, 'the server listens on a port');
  const port = address.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sendWeights(request: IncomingMessage, response: ServerResponse, behaviour: Behaviour, mode: Behaviour['weights']): void {
  const range = request.headers.range;
  if (range !== undefined) {
    behaviour.ranges.push(range);
  }
  switch (mode) {
    case 'redirectAway':
      response.writeHead(302, { Location: 'http://evil.example/weights.onnx' });
      response.end();
      return;
    case 'redirectHome':
      response.writeHead(302, { Location: '/home/weights' });
      response.end();
      return;
    case 'notFound':
      response.writeHead(404);
      response.end();
      return;
    case 'wrongBytes':
      response.writeHead(200, { 'Content-Length': weightBytes.length });
      response.end(Buffer.alloc(weightBytes.length, 9));
      return;
    case 'tooLong':
      response.writeHead(200);
      response.end(Buffer.concat([weightBytes, Buffer.alloc(10, 1)]));
      return;
    case 'dropHalf':
      response.writeHead(200, { 'Content-Length': weightBytes.length });
      response.write(weightBytes.subarray(0, weightBytes.length / 2), () => setTimeout(() => response.destroy(), 100));
      return;
    case 'ignoreRange':
      response.writeHead(200, { 'Content-Length': weightBytes.length });
      response.end(weightBytes);
      return;
    case 'ok': {
      const match = /^bytes=(\d+)-$/.exec(range ?? '');
      if (match !== null) {
        const start = Number(match[1]);
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${weightBytes.length - 1}/${weightBytes.length}`,
          'Content-Length': weightBytes.length - start,
        });
        response.end(weightBytes.subarray(start));
        return;
      }
      response.writeHead(200, { 'Content-Length': weightBytes.length });
      response.end(weightBytes);
      return;
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(String(exhaustive));
    }
  }
}

function deps(origin: string, progress: number[] = []): DownloadDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    isAllowedURL: (url) => url.protocol === 'http:' && url.hostname === '127.0.0.1',
    urlOf: (file) => `${origin}/${file.path}`,
    onProgress: (received) => progress.push(received),
    setTimer: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
}

async function setup(context: { readonly after: (fn: () => Promise<void>) => void }, weights: Behaviour['weights']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-dictation-'));
  const behaviour: Behaviour = { weights, ranges: [] };
  const server = await serve(behaviour);
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory: modelDirectory(root, fakeModel), behaviour, server };
}

const signal = (): AbortSignal => new AbortController().signal;

test('a clean download verifies every file, writes the marker last and counts as installed', async (context) => {
  const { root, directory, server } = await setup(context, 'ok');
  const progress: number[] = [];
  const outcome = await downloadModel(fakeModel, directory, signal(), deps(server.origin, progress));
  assert.deepEqual(outcome, { kind: 'installed', sizeBytes: configBytes.length + weightBytes.length });
  assert.deepEqual(await readFile(path.join(directory, 'onnx', 'weights.onnx')), weightBytes);
  assert.equal(progress.at(-1), configBytes.length + weightBytes.length, 'progress ends at the total');
  assert.ok(
    progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? 0)),
    'progress never goes back',
  );
  assert.deepEqual(await readInstall(root, fakeModel), { kind: 'installed', sizeBytes: configBytes.length + weightBytes.length });
  const marker: unknown = JSON.parse(await readFile(path.join(directory, VERIFIED_FILE), 'utf8'));
  assert.deepEqual(marker, { id: 'small', revision: fakeModel.revision, files: fakeModel.files.map(({ path: file, sha256 }) => ({ path: file, sha256 })) });
});

test('a second download of an installed model fetches nothing again', async (context) => {
  const { directory, server, behaviour } = await setup(context, 'ok');
  await downloadModel(fakeModel, directory, signal(), deps(server.origin));
  behaviour.weights = 'notFound';
  assert.equal((await downloadModel(fakeModel, directory, signal(), deps(server.origin))).kind, 'installed', 'the verified file is reused');
});

test('a file whose bytes do not match the pinned hash is thrown away and refused', async (context) => {
  const { root, directory, server } = await setup(context, 'wrongBytes');
  assert.deepEqual(await downloadModel(fakeModel, directory, signal(), deps(server.origin)), { kind: 'failed', failure: 'hashMismatch' });
  await assert.rejects(stat(path.join(directory, 'onnx', 'weights.onnx' + PART_SUFFIX)), /ENOENT/);
  await assert.rejects(stat(path.join(directory, 'onnx', 'weights.onnx')), /ENOENT/);
  assert.notEqual((await readInstall(root, fakeModel)).kind, 'installed');
});

test('a body longer than the manifest size is cut off and refused', async (context) => {
  const { directory, server } = await setup(context, 'tooLong');
  assert.deepEqual(await downloadModel(fakeModel, directory, signal(), deps(server.origin)), { kind: 'failed', failure: 'tooLarge' });
  await assert.rejects(stat(path.join(directory, 'onnx', 'weights.onnx' + PART_SUFFIX)), /ENOENT/);
});

test('a redirect to a host outside the allow-list is refused; one to the same host is followed', async (context) => {
  const away = await setup(context, 'redirectAway');
  assert.deepEqual(await downloadModel(fakeModel, away.directory, signal(), deps(away.server.origin)), { kind: 'failed', failure: 'hostRefused' });
  const home = await setup(context, 'redirectHome');
  assert.equal((await downloadModel(fakeModel, home.directory, signal(), deps(home.server.origin))).kind, 'installed');
});

test('a first address outside the allow-list is refused before any request', async (context) => {
  const { directory, server } = await setup(context, 'ok');
  const refusing = { ...deps(server.origin), isAllowedURL: () => false };
  assert.deepEqual(await downloadModel(fakeModel, directory, signal(), refusing), { kind: 'failed', failure: 'hostRefused' });
});

test('a dropped connection keeps the part; the next download resumes it with a Range request', async (context) => {
  const { root, directory, server, behaviour } = await setup(context, 'dropHalf');
  const first = await downloadModel(fakeModel, directory, signal(), deps(server.origin));
  assert.equal(first.kind, 'failed');
  const part = await stat(path.join(directory, 'onnx', 'weights.onnx' + PART_SUFFIX));
  assert.equal(part.size, weightBytes.length / 2, 'half the file is kept');
  assert.deepEqual(await readInstall(root, fakeModel), {
    kind: 'partial',
    receivedBytes: configBytes.length + weightBytes.length / 2,
    totalBytes: configBytes.length + weightBytes.length,
  });
  behaviour.weights = 'ok';
  assert.equal((await downloadModel(fakeModel, directory, signal(), deps(server.origin))).kind, 'installed');
  assert.deepEqual(behaviour.ranges, [`bytes=${weightBytes.length / 2}-`]);
  assert.deepEqual(await readFile(path.join(directory, 'onnx', 'weights.onnx')), weightBytes, 'the resumed file is whole and verified');
});

test('a server that ignores the range sends the whole file, and the download starts that file over', async (context) => {
  const { directory, server } = await setup(context, 'ignoreRange');
  await mkdir(path.join(directory, 'onnx'), { recursive: true });
  await writeFile(path.join(directory, 'onnx', 'weights.onnx' + PART_SUFFIX), weightBytes.subarray(0, 1000));
  assert.equal((await downloadModel(fakeModel, directory, signal(), deps(server.origin))).kind, 'installed');
  assert.deepEqual(await readFile(path.join(directory, 'onnx', 'weights.onnx')), weightBytes);
});

test('a cancel is reported as a cancel', async (context) => {
  const { directory, server } = await setup(context, 'ok');
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await downloadModel(fakeModel, directory, abort.signal, deps(server.origin)), { kind: 'failed', failure: 'cancelled' });
});

test('an HTTP error is a status failure, not a crash', async (context) => {
  const { directory, server } = await setup(context, 'notFound');
  assert.deepEqual(await downloadModel(fakeModel, directory, signal(), deps(server.origin)), { kind: 'failed', failure: 'httpStatus' });
});

test('a corrupt marker or a changed file makes the folder not installed', async (context) => {
  const { root, directory, server } = await setup(context, 'ok');
  await downloadModel(fakeModel, directory, signal(), deps(server.origin));
  await writeFile(path.join(directory, VERIFIED_FILE), '{"id":"tiny","revision":"b"}');
  assert.notEqual((await readInstall(root, fakeModel)).kind, 'installed');
  await writeFile(path.join(directory, VERIFIED_FILE), 'not json');
  assert.notEqual((await readInstall(root, fakeModel)).kind, 'installed');
});

test('removing the model removes its folder', async (context) => {
  const { root, directory, server } = await setup(context, 'ok');
  await downloadModel(fakeModel, directory, signal(), deps(server.origin));
  await removeModel(root, 'small');
  await assert.rejects(stat(path.join(root, 'small')), /ENOENT/);
  assert.deepEqual(await readInstall(root, fakeModel), { kind: 'notInstalled' });
});

test('the model scheme serves nothing that is not an installed manifest file', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-dictation-scheme-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { WHISPER_MODELS } = await import('#dist/shared/properties/voice/whisperModels.js');
  const real = WHISPER_MODELS.small;
  const base = modelBaseURL(real);
  assert.equal(base, `stacki-model://whisper/small/${real.revision}/`);
  for (const address of [
    `${base}config.json`, // Not installed yet.
    `${base}../../../etc/passwd`,
    `${base}secret.txt`,
    `stacki-model://whisper/small/${'b'.repeat(40)}/config.json`,
    'stacki-model://whisper/large/x/config.json',
    'stacki-model://other/tiny/config.json',
  ]) {
    assert.equal((await serveModelRequest(address, 'GET', root)).status, 404, address);
  }
  assert.equal((await serveModelRequest(`${base}config.json`, 'POST', root)).status, 405);
});

test('a file the manifest no longer names is removed after an install; the pinned files and the marker stay', async (context) => {
  const { root, directory, server } = await setup(context, 'ok');
  await downloadModel(fakeModel, directory, signal(), deps(server.origin));
  await writeFile(path.join(directory, 'onnx', 'encoder_model_quantized.onnx'), 'old encoder');
  assert.deepEqual(await removeStrayFiles(root, fakeModel), [path.join('onnx', 'encoder_model_quantized.onnx')]);
  await assert.rejects(stat(path.join(directory, 'onnx', 'encoder_model_quantized.onnx')), /ENOENT/);
  assert.deepEqual(await readInstall(root, fakeModel), { kind: 'installed', sizeBytes: configBytes.length + weightBytes.length });
});
