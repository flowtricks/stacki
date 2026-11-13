// Exercise the real variable edit, snapshot undo, and refresh coordinators with
// controlled IPC replies. Invalid contracts must reject, disk failures must remain
// visible, and deferred reads must coalesce without publishing after disposal.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');
const { variableEdit, friendlyError } = load('src/ipc/variableEditBridge.ts');
const { createVariableHistory } = load('src/features/variables/variableHistory.ts');
const { createVariableRefresh } = load('src/features/variables/variableRefresh.ts');
const base = { projectPath: '/project', file: 'a.css' };
const range = { ...base, start: 0, end: 10, expect: 'Colors' };
const calls = {
  readStyleFile: '/project/a.css',
  writeStyleFile: { filePath: '/project/a.css', css: '' },
  setCssVariable: { ...base, valueStart: 0, valueEnd: 3, value: 'red' },
  moveCssVariables: { projectPath: '/project', moves: [] },
  addCssVariables: { projectPath: '/project', adds: [] },
  renameCssVariables: { projectPath: '/project', renames: [{ from: '--a', to: '--b' }] },
  setCssSectionTitle: { ...range, title: 'New colors' },
  addCssSection: { ...base, selector: ':root', title: 'Colors' },
  removeCssSection: range,
  moveCssHeading: { ...range, selector: ':root' },
};
const restart = 'Stacki needs to be restarted before this can be used.';
const snapshot = { files: [], values: {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('all variable edit contracts accept valid replies and reject malformed replies', async () => {
  for (const [name, payload] of Object.entries(calls)) {
    let received;
    const response = name === 'readStyleFile' ? { css: '' } : { ok: true };
    global.window = {
      avb: {
        [name]: async (value) => {
          received = value;
          return response;
        },
      },
    };
    assert.deepEqual(await variableEdit(name, payload), name === 'readStyleFile' ? { ok: true, css: '' } : response);
    assert.deepEqual(received, payload);
    for (const invalid of [PLATFORM_NULL, {}, { ok: 1 }, { css: 42 }]) {
      window.avb[name] = async () => invalid;
      await assert.rejects(variableEdit(name, payload), /Expected/);
    }
    window.avb[name] = async () => {
      throw new Error('disk unavailable');
    };
    assert.deepEqual(await variableEdit(name, payload), { ok: false, error: 'disk unavailable' });
    delete window.avb[name];
    assert.deepEqual(await variableEdit(name, payload), { ok: false, error: restart, errorRef: { key: 'variables.error.restart' } });
  }
});

test('edit payloads are parsed before IPC and bounded replies stay bounded', async () => {
  let invoked = 0;
  global.window = {
    avb: Object.fromEntries(
      Object.keys(calls).map((name) => [
        name,
        async () => {
          invoked++;
          return { ok: true };
        },
      ]),
    ),
  };
  for (const name of Object.keys(calls)) {
    await assert.rejects(variableEdit(name, PLATFORM_NULL), /Expected/);
  }
  await assert.rejects(
    variableEdit('setCssVariable', {
      ...calls.setCssVariable,
      valueStart: -1,
    }),
    /nonnegative/,
  );
  await assert.rejects(variableEdit('readStyleFile', 'x'.repeat(32769)), /Path exceeds limit/);
  await assert.rejects(
    variableEdit('renameCssVariables', {
      projectPath: '/project',
      renames: Array(100001).fill({ from: '--a', to: '--b' }),
    }),
    /Array exceeds limit/,
  );
  assert.equal(invoked, 0);
  window.avb.writeStyleFile = async () => ({ ok: false, error: 'stale range' });
  assert.deepEqual(await variableEdit('writeStyleFile', calls.writeStyleFile), {
    ok: false,
    error: 'stale range',
  });
  window.avb.readStyleFile = async () => ({ css: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) });
  await assert.rejects(variableEdit('readStyleFile', calls.readStyleFile), /String exceeds limit/);
  assert.equal(friendlyError(new Error("Error invoking remote method 'css:edit': Error: disk full")), 'disk full');
  assert.equal(friendlyError({ message: 'No handler registered for css:edit' }), restart);
});

function historyFixture() {
  const files = new Map([
    ['/project/a.css', 'a'],
    ['/project/b.css', 'b'],
  ]);
  const records = [];
  const errors = [];
  const reads = [];
  let refreshes = 0;
  global.window = {
    avb: {
      readStyleFile: async (file) => {
        reads.push(file);
        return { css: files.get(file) };
      },
      writeStyleFile: async ({ filePath, css }) => {
        files.set(filePath, css);
        return { ok: true };
      },
    },
  };
  const history = createVariableHistory({
    projectPath: '/project',
    report: (error) => errors.push(error),
    record: (command) => records.push(command),
    refresh: async () => {
      refreshes++;
    },
  });
  return { files, records, errors, reads, history, refreshes: () => refreshes };
}

test('history deduplicates every touched file and restores both directions', async () => {
  const state = historyFixture();
  assert.equal(
    await state.history(['a.css', 'b.css', 'a.css'], 'variables.undo.move', 'move', async () => {
      state.files.set('/project/a.css', 'new a');
      state.files.set('/project/b.css', 'new b');
      return true;
    }),
    true,
  );
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.reads, ['/project/a.css', '/project/b.css', '/project/a.css', '/project/b.css']);
  const command = state.records[0];
  assert.equal(command.label, 'the move');
  assert.deepEqual(command.labelRef, { key: 'variables.undo.move' });
  assert.equal(command.coalesceKey, 'move');
  await command.undo();
  assert.deepEqual([...state.files.values()], ['a', 'b']);
  await command.redo();
  assert.deepEqual([...state.files.values()], ['new a', 'new b']);
  assert.equal(state.refreshes(), 2);
  assert.deepEqual(state.errors, []);
  window.avb.writeStyleFile = async () => ({ ok: false, error: 'read only' });
  await command.undo();
  assert.deepEqual(state.errors, ['read only']);
  assert.equal(state.refreshes(), 3);
});

test('snapshot failures prevent unrecorded writes and false success', async () => {
  const state = historyFixture();
  let edits = 0;
  window.avb.readStyleFile = async () => {
    throw new Error('cannot read');
  };
  assert.equal(
    await state.history('a.css', 'edit', undefined, async () => {
      edits++;
    }),
    false,
  );
  assert.equal(edits, 0);
  assert.deepEqual(state.errors, ['cannot read']);
  window.avb.readStyleFile = async () => ({ css: 'before' });
  assert.equal(
    await state.history('a.css', 'edit', undefined, async () => {
      window.avb.readStyleFile = async () => {
        throw new Error('cannot reread');
      };
    }),
    false,
  );
  assert.deepEqual(state.errors, ['cannot read', 'cannot reread']);
  assert.equal(state.records.length, 0);
  await assert.rejects(
    state.history(
      Array.from({ length: 10001 }, (_, i) => `${i}.css`),
      'edit',
      undefined,
      async () => {},
    ),
    /Variable undo: file limit exceeded/,
  );
});

test('unchanged and rejected edits do not add undo commands', async () => {
  const state = historyFixture();
  assert.equal(await state.history('a.css', 'edit', undefined, async () => true), true);
  assert.equal(await state.history('a.css', 'edit', undefined, async () => false), false);
  assert.equal(state.records.length, 0);
  assert.equal(state.reads.length, 3, 'rejected edit does not take an after snapshot');
});

test('refresh bursts share one request and one ' + 'follow-up; disposal suppresses late results', async () => {
  const reads = [];
  const published = [];
  global.window = { avb: { cssVariables: () => new Promise((resolve) => reads.push(resolve)) } };
  const reader = createVariableRefresh('/project', (value) => published.push(value));
  const first = reader.refresh();
  await tick();
  // A burst during a read shares the one read after it: two reads in all.
  const pending = reader.refresh();
  for (let index = 0; index < 50; index++) {
    assert.equal(reader.refresh(), pending);
  }
  assert.equal(reads.length, 1);
  reads[0](snapshot);
  await first;
  await tick();
  assert.equal(reads.length, 2);
  reads[1](snapshot);
  await pending;
  assert.equal(published.length, 2);
  const last = reader.refresh();
  await tick();
  reader.dispose();
  reads[2](snapshot);
  await last;
  await reader.refresh();
  assert.equal(reads.length, 3);
  assert.equal(published.length, 2);
});

test('publication cannot resurrect a disposed refresh coordinator', async () => {
  let reads = 0;
  global.window = {
    avb: {
      cssVariables: async () => {
        reads++;
        return snapshot;
      },
    },
  };
  const reader = createVariableRefresh('/project', () => reader.dispose());
  await reader.refresh();
  await reader.refresh();
  assert.equal(reads, 1);
});

test('refresh surfaces operating failures and rejects malformed data', async () => {
  const published = [];
  global.window = {
    avb: {
      cssVariables: async () => {
        throw new Error('disk unavailable');
      },
    },
  };
  const reader = createVariableRefresh('/project', (value) => published.push(value));
  await reader.refresh();
  assert.deepEqual(published, [{ ok: false, error: 'disk unavailable' }]);
  window.avb.cssVariables = async () => PLATFORM_NULL;
  await assert.rejects(reader.refresh(), /Expected object/);
  reader.dispose();
});

test('a refused edit carries the producer’s message reference, and a malformed reference is dropped', async () => {
  const reply = (response) => {
    global.window = { avb: { setCssVariable: async () => response } };
    return variableEdit('setCssVariable', calls.setCssVariable);
  };
  const good = { key: 'variables.error.notDeclared', params: { name: '--a' } };
  assert.deepEqual(await reply({ ok: false, error: '--a is no longer declared there.', errorRef: good }), {
    ok: false,
    error: '--a is no longer declared there.',
    errorRef: good,
  });
  for (const bad of [42, { key: 'not a key' }, { key: 'variables.error.notDeclared', params: { name: { nested: true } } }, [], 'null']) {
    assert.deepEqual(await reply({ ok: false, error: 'plain', errorRef: bad }), { ok: false, error: 'plain' });
  }
});
