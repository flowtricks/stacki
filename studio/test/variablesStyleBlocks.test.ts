// Goal: Studio sees and edits `<style>` variables exactly as Desktop does. A page's
// block is read through the route and the bake's scan, an edit commits to that file's
// shared document and changes only the value, and a value that would leave the block
// is refused before any room is written.
// Method: the engine runs against an in-memory snapshot as the route runs it, then the
// real route is driven over HTTP against a temporary project, so the version check and
// the room commit are the production ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRooms } from '../src/features/collaboration/rooms';
import { scanProjectVariables, variableRoutes } from '../src/features/variables/variableServer';
import { applyVariableOperation } from '../src/features/variables/variableOperations';
import { VARIABLE_ROOT, withVariableWorkspace } from '../src/features/variables/variableWorkspace';
import { readVariables } from '../vendor/stacki/electron/project/cssVarModel';
import { parseCSSVariables } from '../vendor/stacki/src/ipc/variablesBridge';
import { record } from '../src/shared/validation';

const page = 'src/pages/index.astro';
const source = `---
const title = '<style>:root { --from-string: 1 }</style>';
---
<html><head><title>{title}</title>
<style is:global>
:root {
  /* colors */
  --brand: #2b5cf6;
  --other: 1rem;
}
</style>
</head><body>{title && <style>:root { --from-expression: 1 }</style>}</body></html>
`;
const valueStart = source.indexOf('#2b5cf6');
const edit = { projectPath: 'studio', file: page, valueStart, valueEnd: valueStart + 7, expect: '#2b5cf6' };

test('The Studio reader lists a page block, with its scope, across the wire', () => {
  withVariableWorkspace(new Map([[page, source]]), () => {
    const parsed = parseCSSVariables(JSON.parse(JSON.stringify(readVariables(VARIABLE_ROOT))));
    assert.ok(parsed.ok);
    assert.deepEqual(Object.keys(parsed.value.values), ['--brand', '--other']);
    const file = parsed.value.files[0];
    assert.equal(file?.rel, page);
    assert.deepEqual(file.groups[0]?.scope, { reach: 'page', written: 'global' });
  });
});

test('The Studio engine writes a value into the block, and refuses to leave it', () => {
  const files = new Map([[page, source]]);
  withVariableWorkspace(files, () => {
    assert.deepEqual(applyVariableOperation('setCssVariable', { ...edit, value: '#000000' }), { ok: true });
    assert.equal(files.get(page), source.replace('#2b5cf6', '#000000'));
    const refused = applyVariableOperation('setCssVariable', { ...edit, expect: '#000000', value: 'red</style><p>' });
    assert.equal(refused.ok, false);
    assert.equal(files.get(page), source.replace('#2b5cf6', '#000000'));
    assert.ok(
      applyVariableOperation('addCssVariables', {
        projectPath: 'studio',
        adds: [{ file: page, selector: ':root', name: '--new', value: '1', after: '--other' }],
      }).ok,
    );
    assert.match(files.get(page) ?? '', /--other: 1rem;\n {2}--new: 1;\n}/);
  });
});

test('The route and the bake scan read a page block, and an edit reaches its document', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-style-variables-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, page), source);
  const rooms = createRooms(root);
  const route = variableRoutes(root, rooms);
  const server = createServer((request, response) => {
    void route(request, response, '/studio/api/variables', async () => {
      let body = '';
      for await (const bytes of request) {
        body += String(bytes);
      }
      return body;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/studio/api/variables`;
  try {
    const baked = await scanProjectVariables(root);
    assert.equal(baked.values['--brand'], '#2b5cf6');
    const before = record(await (await fetch(url)).json());
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ operation: 'setCssVariable', payload: { ...edit, value: '#ffffff' }, versions: before['versions'] }),
    });
    assert.deepEqual(await response.json(), { ok: true });
    const after = record(await (await fetch(url)).json());
    assert.equal(record(after['values'])['--brand'], '#ffffff');
    assert.equal(await rooms.read(page), source.replace('#2b5cf6', '#ffffff'));
  } finally {
    server.close();
    server.closeAllConnections();
    rooms.sockets.close();
    const room = await rooms.get(page);
    await room.durable.flush();
    room.document.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
