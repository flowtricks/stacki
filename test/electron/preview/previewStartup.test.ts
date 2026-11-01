// Goal: first-open readiness requires HTTP, and only failed preview navigations
// trigger recovery. Exercise real sockets and the native event adapter with a fake host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { portAnswers, previewPort, serverResponds } from '#dist/electron/preview/devServerChecks.js';
import { listenForPreviewFailures } from '#dist/electron/preview/previewFailure.js';

class Contents extends EventEmitter {
  readonly messages: unknown[] = [];
  send(channel: string, payload: unknown): void {
    this.messages.push({ channel, payload });
  }
}

test('a listening port is not ready until HTTP responds', async () => {
  let respond = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (respond) {
      response.writeHead(500);
      response.end('An Astro compile error is visible, not a blank connection failure.');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address);
  assert.notEqual(typeof address, 'string');
  if (typeof address === 'string') {
    throw new Error('Expected TCP server');
  }
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(await portAnswers(address.port), true);
    assert.equal(await serverResponds(url), false);
    respond = true;
    assert.equal(await serverResponds(url), true);
    assert.deepEqual(requests, ['/@vite/client', '/@vite/client']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  assert.equal(await serverResponds(url), false);
});

test('preview ports are stable per project and leave room for bounded conflict retries', () => {
  const project = '/projects/documentation';
  assert.equal(previewPort(project), previewPort(project));
  assert.notEqual(previewPort(project), previewPort('/projects/storefront'));
  assert.ok(previewPort(project) >= 45000);
  assert.ok(previewPort(project) < 55000);
  assert.throws(() => previewPort(''), /Preview port requires a project path/);
});

test('only a failed active preview is reported; deliberate navigation is ignored', () => {
  const contents = new Contents();
  let current: string | undefined = 'http://127.0.0.1:4321';
  listenForPreviewFailures(contents, () => current);
  const fail = (code: number, url: string, scope: 'main' | 'frame'): void => {
    contents.emit('did-fail-load', {}, code, 'failed', url, scope === 'main', 1, 2);
  };
  fail(-102, current + '/#avb-design', 'frame');
  assert.deepEqual(contents.messages, [{ channel: 'dev:preview-failed', payload: current + '/' }]);
  fail(-3, current + '/', 'frame');
  fail(-102, current + '/', 'main');
  fail(-102, 'http://127.0.0.1:4322/', 'frame');
  fail(-102, 'https://example.com/', 'frame');
  fail(-102, 'invalid', 'frame');
  current = undefined;
  fail(-102, 'http://127.0.0.1:4321/', 'frame');
  assert.equal(contents.messages.length, 1);
});
