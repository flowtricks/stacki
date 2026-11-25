import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { propose } from '../src/features/ai/agent';
import { record } from '../src/shared/validation';

// A deliberately failing local provider verifies the real HTTP boundary without
// claiming a successful AI integration or incurring model charges.
async function provider(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-transport-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Current source</h1>');
  return root;
}
test('selected model, image content, and history reach the real provider request', async () => {
  const root = await project();
  let captured: unknown;
  const server = await provider((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      captured = JSON.parse(body);
      response.writeHead(503).end();
    });
  });
  try {
    const image = { id: 'image', name: 'ref.png', url: 'data:image/png;base64,AAAA' };
    await assert.rejects(
      propose(
        root,
        'src/pages/index.astro',
        'Use this reference',
        {
          endpoint: server.endpoint,
          apiKey: '',
          model: 'selected-vision-model',
        },
        { images: [image], history: [{ role: 'assistant', content: 'Earlier discussion' }] },
      ),
      /503/,
    );
    const body = record(captured);
    assert.equal(body['model'], 'selected-vision-model');
    const messages = body['messages'];
    assert.ok(Array.isArray(messages));
    assert.deepEqual(messages[1], { role: 'assistant', content: 'Earlier discussion' });
    const content = record(messages[2])['content'];
    assert.ok(Array.isArray(content));
    assert.deepEqual(content[1], { type: 'image_url', image_url: { url: image.url } });
    assert.match(JSON.stringify(content[0]), /Current source/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('stopping one request aborts its provider fetch while another request can continue', async () => {
  const root = await project();
  const controller = new AbortController();
  let calls = 0;
  const server = await provider((_request, response) => {
    if (++calls === 1) {
      controller.abort();
    } else {
      response.writeHead(503).end();
    }
  });
  const options = { endpoint: server.endpoint, apiKey: '', model: 'local' };
  try {
    await assert.rejects(propose(root, 'src/pages/index.astro', 'First chat', options, undefined, controller.signal), { name: 'AbortError' });
    await assert.rejects(propose(root, 'src/pages/index.astro', 'Second chat', options), /503/);
    assert.equal(calls, 2);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
