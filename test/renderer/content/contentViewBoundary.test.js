// Goal: ContentView consumes only bounded, parsed entry and rename data.
// Methodology: exercise each parser with a complete wire reply, corrupt nested
// fields and bounds, then script preload calls to separate I/O from contract bugs.
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../../helpers/rendererModule')('src/features/content/contentViewBridge.ts');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');

const collection = {
  name: 'posts',
  editable: true,
  schema: { type: 'object', properties: { title: { type: 'string' } } },
  loader: { kind: 'glob', base: 'src/content/posts', pattern: '**/*.md' },
};
const entry = {
  id: 'hello',
  file: 'src/content/posts/hello.md',
  format: 'frontmatter',
  locator: [],
  data: { title: 'Hello' },
  title: 'Hello',
  body: 'Body',
  hasBody: true,
};
const entries = {
  entries: [entry],
  readOnly: false,
  collection,
};
const plan = {
  entry: { id: 'hello', file: entry.file },
  collection: 'posts',
  from: 'hello',
  to: 'welcome',
  move: { kind: 'file', from: entry.file, to: 'src/content/posts/welcome.md' },
  pointers: [
    {
      collection: 'pages',
      entryId: 'home',
      entryTitle: 'Home',
      file: 'src/content/pages/home.json',
      path: ['featured', 0],
      entry: { file: 'src/content/pages/home.json', locator: [] },
    },
  ],
  imageEdits: [{ path: ['image'], from: './cover.png', value: '../hello/cover.png' }],
};

test('content entry, validation, and rename parsers preserve valid replies', () => {
  assert.deepEqual(bridge.parseContentEntries(entries), entries);
  assert.deepEqual(
    bridge.parseContentValidation({
      issues: [{ path: ['title'], message: 'Required', code: 'x' }],
    }),
    { issues: [{ path: ['title'], message: 'Required', code: 'x' }] },
  );
  assert.deepEqual(bridge.parseContentRenamePlan(plan), plan);
});

test('content parsers reject malformed nested data and collection bounds', () => {
  for (const value of [
    jsonNull,
    { ...entries, entries: jsonNull },
    // Absence is `undefined` (AGENTS.md §6): main never sends a null note.
    { ...entries, parserNote: jsonNull },
    { ...entries, entries: [{ ...entry, locator: [-1] }] },
    { ...entries, entries: [{ ...entry, data: Number.NaN }] },
    { ...entries, collection: { ...collection, name: 1 } },
    { ...entries, entries: Array(100_001).fill(entry) },
  ]) {
    assert.throws(() => bridge.parseContentEntries(value));
  }
  for (const value of [
    { ...plan, move: { kind: 'mystery' } },
    { ...plan, pointers: [{ ...plan.pointers[0], path: [-1] }] },
    { ...plan, imageEdits: [{ path: [], from: Number.POSITIVE_INFINITY, value: 'x' }] },
  ]) {
    assert.throws(() => bridge.parseContentRenamePlan(value));
  }
});

test('content operations validate payloads and keep transport failures as values', async () => {
  const calls = [];
  global.window = {
    avb: {
      contentEntries: async (payload) => {
        calls.push(['entries', payload]);
        return entries;
      },
      contentTargets: async (payload) => {
        calls.push(['targets', payload]);
        return { targets: [{ id: 'hello', title: 'Hello' }] };
      },
      validateContentEntry: async (payload) => {
        calls.push(['validate', payload]);
        return { issues: [] };
      },
      writeContentEntry: async (payload) => {
        calls.push(['write', payload]);
        return { ok: true, changed: true };
      },
      contentRenamePlan: async (payload) => {
        calls.push(['plan', payload]);
        return plan;
      },
      renameContentEntry: async (payload) => {
        calls.push(['rename', payload]);
        return { renamed: true, pointers: 1, files: [entry.file] };
      },
    },
  };
  assert.equal((await bridge.readContentEntries('/project', 'posts')).ok, true);
  assert.equal((await bridge.readContentTargets('/project', 'posts')).ok, true);
  assert.equal((await bridge.validateContentEntry('/project', 'posts', entry.data)).ok, true);
  assert.equal((await bridge.writeContentEntry('/project', { file: entry.file, locator: [] }, [{ path: ['title'], value: 'Welcome' }], undefined)).ok, true);
  assert.equal((await bridge.planContentRename('/project', 'posts', 'hello', 'welcome')).ok, true);
  assert.equal((await bridge.renameContentEntry('/project', 'posts', 'hello', 'welcome')).ok, true);
  assert.equal(calls.length, 6);

  global.window.avb.contentEntries = async () => {
    throw new Error('disk offline');
  };
  assert.deepEqual(await bridge.readContentEntries('/project', 'posts'), {
    ok: false,
    error: 'disk offline',
  });
  global.window.avb.contentEntries = async () => ({ ...entries, readOnly: 'no' });
  await assert.rejects(() => bridge.readContentEntries('/project', 'posts'));
});
