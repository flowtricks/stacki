import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readStyleResource } from '../src/features/settings/styleReads';

test('concurrent style scans share HTTP reads without caching later edits or failures', async () => {
  let reads = 0;
  let source = '.heading { color: red; }';
  let status = 200;
  const server = createServer((_request, response) => {
    reads++;
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { source } : { error: 'Restarting' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/styles`;
  try {
    const results = await Promise.all([readStyleResource(url), readStyleResource(url), readStyleResource(url)]);
    assert.equal(reads, 1);
    assert.deepEqual(results, [{ source }, { source }, { source }]);
    source = '.heading { color: blue; }';
    assert.deepEqual(await readStyleResource(url), { source });
    assert.equal(reads, 2);
    status = 503;
    await assert.rejects(readStyleResource(url), /Restarting/);
    status = 200;
    assert.deepEqual(await readStyleResource(url), { source });
    assert.equal(reads, 4);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
