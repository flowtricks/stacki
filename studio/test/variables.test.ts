import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRooms } from '../src/features/collaboration/rooms';
import { variableRoutes } from '../src/features/variables/variableServer';
import { applyVariableOperation } from '../src/features/variables/variableOperations';
import { VARIABLE_ROOT, withVariableWorkspace } from '../src/features/variables/variableWorkspace';
import { readVariables } from '../vendor/stacki/electron/project/cssVarModel';
import { parseCSSVariables } from '../vendor/stacki/src/features/variables/variablesBridge';
import { record } from '../src/shared/validation';

const file = 'src/styles/tokens.css';
const source = ':root {\r\n  /* Colors 🌱 */\r\n  --brand: #123456;\r\n  --space: 1rem;\r\n}\r\n';
const payload = { projectPath: 'studio', file };

test('Stacki models survive JSON, sparse modes, comments and exact value edits', () => {
  const files = new Map([[file, source + '.dark { --brand: black; --space: 2rem; --extra: 0; }']]);
  withVariableWorkspace(files, () => {
    const model = readVariables(VARIABLE_ROOT);
    const parsed = parseCSSVariables(JSON.parse(JSON.stringify(model)));
    assert.ok(parsed.ok);
    const start = source.indexOf('#123456');
    const result = applyVariableOperation('setCssVariable', {
      ...payload,
      valueStart: start,
      valueEnd: start + 7,
      expect: '#123456',
      value: '#abcdef',
    });
    assert.ok(result.ok);
    assert.equal(files.get(file), (source + '.dark { --brand: black; --space: 2rem; --extra: 0; }').replace('#123456', '#abcdef'));
    assert.equal(parsed.value.values['--extra'], '0');
  });
});

test('variable operations add, reorder, rename references and edit headings in source', () => {
  const page = 'src/pages/index.astro';
  const files = new Map([
    [file, source],
    [page, '<div style="color: var(--brand)">🌱</div>'],
  ]);
  withVariableWorkspace(files, () => {
    assert.ok(
      applyVariableOperation('addCssVariables', {
        projectPath: 'studio',
        adds: [{ file, selector: ':root', name: '--accent', value: 'red', after: '--brand' }],
      }).ok,
    );
    assert.ok(
      applyVariableOperation('moveCssVariables', {
        projectPath: 'studio',
        moves: [{ file, selector: ':root', name: '--accent', target: '--brand' }],
      }).ok,
    );
    assert.ok((files.get(file)?.indexOf('--accent') ?? 1) < (files.get(file)?.indexOf('--brand') ?? 0));
    assert.ok(
      applyVariableOperation('renameCssVariables', {
        projectPath: 'studio',
        renames: [{ from: '--brand', to: '--primary' }],
      }).ok,
    );
    assert.equal(files.get(page), '<div style="color: var(--primary)">🌱</div>');
    const start = files.get(file)?.indexOf('Colors 🌱') ?? -1;
    assert.ok(
      applyVariableOperation('setCssSectionTitle', {
        ...payload,
        start,
        end: start + 'Colors 🌱'.length,
        expect: 'Colors 🌱',
        title: 'Palette',
      }).ok,
    );
    assert.ok(files.get(file)?.includes('/* Palette */'));
    assert.ok(
      applyVariableOperation('removeCssSection', {
        ...payload,
        start,
        end: start + 7,
        expect: 'Palette',
      }).ok,
    );
    assert.ok(!files.get(file)?.includes('Palette'));
    assert.ok(files.get(file)?.includes('--primary: #123456'));
  });
});

test('variable engine refuses stale ranges, collisions and paths outside the snapshot', () => {
  const files = new Map([[file, source]]);
  withVariableWorkspace(files, () => {
    assert.equal(
      applyVariableOperation('setCssVariable', {
        ...payload,
        valueStart: 0,
        valueEnd: 4,
        expect: 'nope',
        value: 'bad',
      }).ok,
      false,
    );
    assert.equal(
      applyVariableOperation('renameCssVariables', {
        projectPath: 'studio',
        renames: [{ from: '--brand', to: '--space' }],
      }).ok,
      false,
    );
    assert.throws(() =>
      applyVariableOperation('setCssVariable', {
        ...payload,
        file: '../../etc/passwd',
        valueStart: 0,
        valueEnd: 0,
        value: 'bad',
      }),
    );
    assert.equal(files.get(file), source);
  });
});

test('variable API commits to shared drafts and rejects an entire stale multi-file edit', async () => {
  const fixture = await variableFixture();
  try {
    const first = await fixture.get();
    const start = source.indexOf('#123456');
    assert.ok(
      record(
        await fixture.post({
          operation: 'setCssVariable',
          versions: first['versions'],
          payload: {
            ...payload,
            valueStart: start,
            valueEnd: start + 7,
            expect: '#123456',
            value: 'red',
          },
        }),
      )['ok'],
    );
    const changed = source.replace('#123456', 'red');
    assert.equal(await fixture.rooms.read(file), changed);
    assert.equal(await readFile(path.join(fixture.root, file), 'utf8'), changed);
    const stale = record(
      await fixture.post({
        operation: 'addCssVariables',
        versions: first['versions'],
        payload: {
          projectPath: 'studio',
          adds: [
            { file: 'src/styles/other.css', selector: ':root', name: '--new', value: '1' },
            { file, selector: ':root', name: '--new', value: '1' },
          ],
        },
      }),
    );
    assert.equal(stale['ok'], false);
    assert.equal(await fixture.rooms.read('src/styles/other.css'), source);
    assert.equal(await fixture.rooms.read(file), changed);
  } finally {
    await fixture.close();
  }
});

async function variableFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-vars-'));
  await mkdir(path.join(root, 'src/styles'), { recursive: true });
  await writeFile(path.join(root, file), source);
  await writeFile(path.join(root, 'src/styles/other.css'), source);
  const rooms = createRooms(root);
  const route = variableRoutes(root, rooms);
  const server = createServer((req, res) => {
    void route(req, res, '/studio/api/variables', async () => {
      let body = '';
      for await (const bytes of req) {
        body += String(bytes);
      }
      return body;
    }).catch((error: unknown) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/studio/api/variables`;
  return {
    root,
    rooms,
    get: async () => record(await (await fetch(url)).json()),
    post: async (body: unknown): Promise<unknown> => (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).json(),
    close: async () => {
      server.close();
      server.closeAllConnections();
      rooms.sockets.close();
      for (const name of [file, 'src/styles/other.css']) {
        const room = await rooms.get(name);
        await room.durable.flush();
        room.document.destroy();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('variable undo checks exact source and preserves later collaborator edits', async () => {
  const fixture = await variableFixture();
  try {
    const changed = source.replace('#123456', 'red');
    const remote = changed.replace('1rem', '2rem');
    await fixture.rooms.coordinator.run(async () => (await fixture.rooms.get(file)).setSource(remote));
    const latest = await fixture.get();
    const refused = record(
      await fixture.post({
        operation: 'restoreCssVariables',
        versions: latest['versions'],
        payload: { expected: { [file]: changed }, texts: { [file]: source } },
      }),
    );
    assert.equal(refused['ok'], false, 'Even a fresh scan cannot authorize stale undo');
    assert.equal(await fixture.rooms.read(file), remote);
    const accepted = record(
      await fixture.post({
        operation: 'restoreCssVariables',
        versions: {},
        payload: { expected: { [file]: remote }, texts: { [file]: source } },
      }),
    );
    assert.equal(accepted['ok'], true);
    assert.equal(await fixture.rooms.read(file), source);
  } finally {
    await fixture.close();
  }
});
