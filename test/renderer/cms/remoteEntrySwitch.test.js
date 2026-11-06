// Goal: moving between entries in the CMS view never reports a problem that is not the selected
// entry's own. Nothing red shows while an entry's read is outstanding, the form never empties, a
// late answer for an earlier selection changes nothing, and a real problem still shows once the
// entry has loaded and while typing.
// Method: the whole view is mounted against reads the test answers by hand. A Profiler snapshots
// the DOM in every commit, because the bug lived for one commit that a check after `act` never
// sees: the assertions read every frame, not just the last. The load state's rules are then
// pinned directly, on the pure `entryLoadOf`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');

const output = repoPath('node_modules/.stacki-test/remote-entry-switch.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/cms/RemoteCmsView.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html>', { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window;
for (const name of ['document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'localStorage']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { RemoteCmsView } = require(output);
const { entryLoadOf, entryShown } = loadRenderer('src/features/cms/entryLoad.ts');

const ASTRO_CONTENT = { kind: 'astro', id: '00000000-0000-4000-8000-00000a57c0de', label: 'Content' };
const SANITY = { kind: 'sanity', id: '11111111-1111-4111-8111-111111111111', label: 'Sanity' };
const SLUGS = ['twenty-five', 'forty-five', 'fifty-two'];

// The view's caches outlive a mount, as they do in the app, so each test reads its own collection.
let run = 0;
const collection = () => `stats${run}`;
test.beforeEach(() => {
  run += 1;
});

const textField = (name, value) => ({ name, title: name, description: '', required: true, rules: [], type: { kind: 'string', options: [] }, value });

function entry(slug, overrides = {}) {
  return {
    id: `${collection()}.${slug}`,
    type: collection(),
    status: 'published',
    assets: [],
    file: `src/content/${collection()}/${slug}.md`,
    fields: [textField('heading', `Heading of ${slug}`), textField('description', `About ${slug}`)],
    slug: { folder: '', value: slug, taken: SLUGS.filter((other) => other !== slug), rename: { kind: 'editable' } },
    ...overrides,
  };
}

const summary = (document) => ({ id: document.id, title: document.id, status: 'published', updatedAt: '2026-01-01T00:00:00.000Z' });

// Reads wait in `reads` until a test answers them; every commit's visible state lands in `frames`.
function fixture(documents, connection = ASTRO_CONTENT) {
  const reads = [];
  const writes = [];
  const frames = [];
  const answerWrite = (write) => ({ ok: true, value: documents.find((document) => document.id === write.id) });
  window.avb = {
    contentRemoteRead: (payload) => new Promise((resolve) => reads.push({ request: payload.request, resolve })),
    contentRemoteEdit: async (payload) => {
      writes.push(payload.request.write);
      return answerWrite(payload.request.write);
    },
    remoteDocument: (payload) => new Promise((resolve) => reads.push({ request: { operation: 'document', id: payload.id }, resolve })),
    remoteDocuments: () => new Promise((resolve) => reads.push({ request: { operation: 'documents' }, resolve })),
    writeRemoteDocument: async (payload) => {
      writes.push(payload.write);
      return answerWrite(payload.write);
    },
    onCmsChanged: () => () => undefined,
    onAssetsChanged: () => () => undefined,
    listAssets: async () => ({ entries: [] }),
  };
  const snapshot = () => {
    const form = document.querySelector('.remote-cms-fields');
    frames.push({
      problems: [...document.querySelectorAll('.remote-cms-problem.is-error, .remote-cms-problem.is-warning')].map((label) => label.textContent),
      invalid: document.querySelectorAll('[aria-invalid="true"], .is-invalid').length,
      values: [...document.querySelectorAll('.remote-cms-fields input, .remote-cms-fields textarea')].map((input) => input.value),
      form: form !== null,
      held: form?.hasAttribute('inert') === true,
    });
  };
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const open = (target) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'view', onRender: snapshot },
          React.createElement(RemoteCmsView, {
            projectPath: '/project',
            hidden: false,
            onSelect: () => undefined,
            selection: { connection, collection: collection(), item: { id: target.id, title: target.id } },
          }),
        ),
      ),
    );
  const answer = async (id, value) => {
    const position = reads.findIndex((read) => read.request.operation === 'document' && read.request.id === id);
    assert.notEqual(position, -1, `a read of ${id} is outstanding`);
    const [read] = reads.splice(position, 1);
    await act(async () => read.resolve({ ok: true, value: value ?? documents.find((document) => document.id === id) }));
  };
  const answerList = async () => {
    const position = reads.findIndex((read) => read.request.operation === 'documents');
    assert.notEqual(position, -1, 'a read of the list is outstanding');
    const [read] = reads.splice(position, 1);
    await act(async () => read.resolve({ ok: true, value: { orderable: false, documents: documents.map(summary) } }));
  };
  const close = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { reads, writes, frames, open, answer, answerList, close };
}

const values = (frame) => frame.values.join(' / ');
const type = (element, text) =>
  act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

// A collection of three whose first entry has loaded, which is where a person starts switching.
async function opened(connection) {
  const documents = SLUGS.map((slug) => entry(slug));
  const view = fixture(documents, connection);
  await view.open(documents[0]);
  await view.answerList();
  await view.answer(documents[0].id);
  return { ...view, documents };
}

function assertNothingReported(frames) {
  for (const frame of frames) {
    assert.deepEqual(frame.problems, [], `no problem shows: ${values(frame)}`);
    assert.equal(frame.invalid, 0, `no field is marked invalid: ${values(frame)}`);
  }
}

test('fast switching over delayed reads reports nothing and never empties the form', async () => {
  const view = await opened();
  const [first, second, third] = view.documents;
  await view.open(second);
  await view.open(third);
  await view.open(first);
  await view.open(third);
  await view.answer(second.id);
  await view.answer(third.id);
  assertNothingReported(view.frames);
  const started = view.frames.findIndex((frame) => frame.form);
  for (const frame of view.frames.slice(started)) {
    assert.equal(frame.form, true, 'the form stays up through every switch');
    assert.ok(
      frame.values.every((value) => value !== ''),
      `no required field is shown empty: ${values(frame)}`,
    );
  }
  assert.equal(view.frames.at(-1).held, false, 'the selected entry is live once it has loaded');
  assert.match(values(view.frames.at(-1)), /fifty-two/);
  await view.close();
});

test('going back to an entry already read reports nothing about the slug left behind', async () => {
  const view = await opened();
  const [first, second] = view.documents;
  await view.open(second);
  await view.answer(second.id);
  // The second visit shows the kept entry at once, whose taken slugs hold the entry just left.
  await view.open(first);
  await view.answer(first.id);
  assertNothingReported(view.frames);
  await view.close();
});

test('the last entry is held out of reach until the selected one answers', async () => {
  const view = await opened();
  const [, second] = view.documents;
  await view.open(second);
  const held = view.frames.at(-1);
  assert.equal(held.held, true);
  assert.match(values(held), /twenty-five/, 'the previous entry stays on screen');
  await view.answer(second.id);
  assert.equal(view.frames.at(-1).held, false);
  assert.match(values(view.frames.at(-1)), /forty-five/);
  await view.close();
});

test('a late answer for an earlier selection is ignored', async () => {
  const view = await opened();
  const [, second, third] = view.documents;
  await view.open(second);
  await view.open(third);
  await view.answer(third.id);
  const settled = view.frames.length;
  await view.answer(second.id);
  for (const frame of view.frames.slice(settled)) {
    assert.doesNotMatch(values(frame), /forty-five/, 'the stale entry never shows');
  }
  assert.match(document.querySelector('.remote-cms-fields input').value, /fifty-two/);
  assert.equal(document.querySelector('.remote-cms-fields').hasAttribute('inert'), false);
  await view.close();
});

test('an answer naming another entry does not stand in for the one selected', async () => {
  const view = await opened();
  const [first, second] = view.documents;
  await view.open(second);
  await view.answer(second.id, first);
  assert.equal(view.frames.at(-1).held, true, 'the wrong document never becomes this entry');
  assertNothingReported(view.frames);
  await view.close();
});

test('a value that really is missing says so once its entry has loaded, and not before', async () => {
  const blank = entry('forty-five', { fields: [textField('heading', undefined), textField('description', 'About forty-five')] });
  const documents = [entry('twenty-five'), blank];
  const view = fixture(documents);
  await view.open(documents[0]);
  await view.answerList();
  await view.answer(documents[0].id);
  await view.open(blank);
  assertNothingReported(view.frames);
  await view.answer(blank.id);
  assert.deepEqual(view.frames.at(-1).problems, ['heading is required']);
  await view.close();
});

test('a held entry keeps quiet about its own problems, which return with it', async () => {
  const blank = entry('twenty-five', { fields: [textField('heading', undefined), textField('description', 'About twenty-five')] });
  const documents = [blank, entry('forty-five')];
  const view = fixture(documents);
  await view.open(blank);
  await view.answerList();
  await view.answer(blank.id);
  assert.deepEqual(view.frames.at(-1).problems, ['heading is required']);
  const shown = view.frames.length;
  await view.open(documents[1]);
  await view.answer(documents[1].id);
  assertNothingReported(view.frames.slice(shown));
  // Its own kept document shows at once, so its own problem may too.
  await view.open(blank);
  assert.deepEqual(view.frames.at(-1).problems, ['heading is required']);
  await view.answer(blank.id);
  assert.deepEqual(view.frames.at(-1).problems, ['heading is required']);
  await view.close();
});

test('a problem still shows while typing', async () => {
  const view = await opened();
  const slug = document.querySelector('.entry-slug-field input');
  await type(slug, 'forty-five');
  assert.deepEqual(view.frames.at(-1).problems, ['Another item already uses this slug']);
  await type(slug, 'twenty-six');
  assert.deepEqual(view.frames.at(-1).problems, []);
  const heading = document.querySelectorAll('.remote-cms-field-save input, .remote-cms-field-save textarea')[0];
  await type(heading, '');
  assert.deepEqual(view.frames.at(-1).problems, ['heading is required']);
  await view.close();
});

test('an edit left pending by a switch is saved to the entry it was typed in', async () => {
  const view = await opened();
  const [first, second] = view.documents;
  const description = document.querySelectorAll('.remote-cms-field-save input, .remote-cms-field-save textarea')[1];
  await type(description, 'Rewritten');
  await view.open(second);
  await view.answer(second.id);
  assert.deepEqual(view.writes, [{ id: first.id, field: 'description', value: 'Rewritten' }]);
  await view.close();
});

test('a slug following one document is not written to the next', async () => {
  const slugField = (current) => ({ ...textField('slug', { _type: 'slug', current }), required: false, type: { kind: 'slug', options: [] } });
  const sanity = (name) => ({
    ...entry(name, { fields: [textField('title', name), slugField(name)] }),
    slug: undefined,
    file: undefined,
  });
  const documents = [sanity('first'), sanity('second')];
  const view = fixture(documents, SANITY);
  await view.open(documents[0]);
  await view.answerList();
  await view.answer(documents[0].id);
  await type(document.querySelector('.remote-cms-field-save input'), 'Renamed');
  await view.open(documents[1]);
  await view.answer(documents[1].id);
  // Closing saves whatever was still waiting for its pause, so a wrong write is seen here too.
  await view.close();
  assert.equal(
    view.writes.some((write) => write.id === documents[1].id),
    false,
    'opening a document never writes to it',
  );
});

test('a load is ready only with the document of its own id', () => {
  const first = entry('twenty-five');
  const second = entry('forty-five');
  const ready = entryLoadOf(first.id, { ok: true, value: first }, undefined);
  assert.deepEqual(ready, { kind: 'ready', id: first.id, document: first });
  assert.deepEqual(entryLoadOf(second.id, undefined, undefined), { kind: 'loading', id: second.id, held: undefined });
  assert.deepEqual(entryLoadOf(second.id, undefined, ready), { kind: 'loading', id: second.id, held: first });
  assert.deepEqual(entryLoadOf(second.id, { ok: true, value: first }, ready), { kind: 'loading', id: second.id, held: first });
});

test('a load keeps its held document through further switches, and drops it on failure', () => {
  const first = entry('twenty-five');
  const second = entry('forty-five');
  const third = entry('fifty-two');
  const switched = entryLoadOf(second.id, undefined, entryLoadOf(first.id, { ok: true, value: first }, undefined));
  assert.equal(entryShown(entryLoadOf(third.id, undefined, switched)), first);
  const failed = entryLoadOf(third.id, { ok: false, message: 'Offline' }, switched);
  assert.deepEqual(failed, { kind: 'failed', id: third.id, message: 'Offline' });
  assert.equal(entryShown(failed), undefined);
  assert.equal(entryShown(undefined), undefined);
  assert.throws(() => entryLoadOf('', undefined, undefined), /An entry is loaded by its id/);
});
