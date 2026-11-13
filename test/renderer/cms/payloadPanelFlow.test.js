// Goal: the whole path a person takes with Payload content works end to end in the renderer: the list of a
// collection loads through the panel's own bridge parsers, an item opens with its fields, typing a value
// saves it as a DRAFT (the live document is untouched, the item then reads "changed"), a collection without
// drafts says its edits are live and offers no Publish, and a server failure shows its reason where the
// person is looking instead of an empty panel.
// Method: the real RemoteCmsView in jsdom; its preload bridge (window.avb) answers from the real Payload
// provider (electron/content/payloadService.ts) talking to the fake Payload (test/helpers/fakePayload.js, replies
// recorded from a real Payload 3.93). Replies cross JSON like IPC does, and the renderer's own bridge parses them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { fakePayload, API_KEY } = require('../../helpers/fakePayload.js');
const { payloadRemoteService } = require('#dist/electron/content/payloadService.js');
const { PayloadError, clearPayloadSessions } = require('#dist/electron/content/payloadClient.js');
const { clearPayloadSchemas } = require('#dist/electron/content/payloadSchema.js');

const output = repoPath('node_modules/.stacki-test/payload-panel-flow.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/cms/RemoteCmsView.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
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

const CONNECTION = { kind: 'payload', id: '22222222-2222-4222-8222-222222222222', label: 'Payload' };
const through = (value) => JSON.parse(JSON.stringify(value));
const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
let counter = 0;

// Waits, within a bound, for the panel's async bridge answers to render. A fixed pause was too short when the
// whole suite runs in parallel and the machine is loaded.
async function settleUntil(found, limitMs = 5000) {
  const stepMs = 25;
  for (let waited = 0; waited < limitMs && !found(); waited += stepMs) {
    await settle(stepMs);
  }
}

// A preload bridge whose every answer is the real provider's, as the main process would send it.
function bridgeTo(service) {
  const answer = async (run) => {
    try {
      return { ok: true, value: through(await run()) };
    } catch (error) {
      return error instanceof PayloadError ? { ok: false, message: error.message, messageRef: error.messageRef } : { ok: false, message: String(error) };
    }
  };
  return {
    remoteCollections: () => answer(() => service.collections()),
    remoteDocuments: (input) => answer(() => service.documents(input.collection, input.columns ?? [])),
    remoteDocument: (input) => answer(() => service.document(input.id)),
    remoteTemplate: (input) => answer(() => service.template(input.collection)),
    writeRemoteDocument: (input) => answer(() => service.write(input.write)),
    actOnRemoteDocument: (input) => answer(() => service.act(input.id, input.action)),
    remoteHistory: (input) => answer(() => service.history(input.id)),
    remoteReferenceOptions: (input) => answer(() => service.references(input.types)),
    onCmsChanged: () => () => undefined,
    onAssetsChanged: () => () => undefined,
    listAssets: async () => ({ entries: [] }),
  };
}

async function withPanel(options, run) {
  clearPayloadSessions();
  clearPayloadSchemas();
  counter += 1;
  const fake = await fakePayload(options);
  const service = payloadRemoteService({ baseUrl: fake.base, collection: 'users', auth: { kind: 'apiKey', key: API_KEY } }, { named: [] });
  window.avb = bridgeTo(service);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const open = (collection, id, title) =>
    act(async () =>
      root.render(
        React.createElement(RemoteCmsView, {
          projectPath: `/project-${counter}`,
          hidden: false,
          onSelect: () => undefined,
          selection: { connection: CONNECTION, collection, item: id === undefined ? undefined : { id, title } },
        }),
      ),
    );
  try {
    await run({ fake, open });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await fake.close();
  }
}
const type = (element, text) =>
  act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

test('a collection lists, an item opens, and typing a value saves a draft the live document never sees', async () => {
  await withPanel({ postCount: 4 }, async ({ fake, open }) => {
    await open('posts', 'posts.2', 'Post 2');
    await settleUntil(() => document.querySelector('.remote-cms-fields') !== null);
    const form = document.querySelector('.remote-cms-fields');
    assert.ok(form, 'the item’s fields are shown');
    const labels = [...form.querySelectorAll('label, .remote-cms-label, .remote-cms-field-title')].map((node) => node.textContent);
    assert.ok(labels.join(' ').includes('Views'), `the fields read from Payload are listed: ${labels.slice(0, 8)}`);
    const views = [...form.querySelectorAll('input[type="number"], input')].find((input) => input.value === '2');
    assert.ok(views, 'the number field shows the stored value');
    await type(views, '123');
    await settleUntil(() => fake.calls.some((call) => call.method === 'PATCH'));
    await settleUntil(() => /Edited just now/.test(document.body.textContent));
    const patches = fake.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1, 'one save for one edit');
    assert.equal(patches[0].query.draft, 'true');
    assert.deepEqual(patches[0].body, { views: 123 });
    assert.equal(fake.posts.get(2).views, 2, 'the live document is untouched');
    assert.match(document.body.textContent, /Edited just now/, 'the item now reads as edited');
    assert.ok(
      [...document.querySelectorAll('button')].some((button) => /^publish$/i.test(button.textContent.trim())),
      'and can be published',
    );
  });
});

test('a collection without drafts says its edits are live and offers no Publish', async () => {
  await withPanel({}, async ({ open }) => {
    await open('pages', 'pages.1', 'Home');
    await settleUntil(() => document.querySelector('.remote-cms-live-notice') !== null);
    assert.match(document.querySelector('.remote-cms-live-notice').textContent, /keeps no drafts: edits are saved live/);
    assert.ok(![...document.querySelectorAll('button')].some((button) => /^publish$/i.test(button.textContent.trim())), 'no Publish button');
  });
});

test('a server that is down shows its reason instead of an empty panel', async () => {
  await withPanel({}, async ({ fake, open }) => {
    await fake.close();
    await open('posts', 'posts.1', 'Post 1');
    await settleUntil(() => /Nothing is answering/.test(document.body.textContent));
    assert.match(document.body.textContent, /Nothing is answering at http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(!document.querySelector('.remote-cms-fields input'), 'no half-filled form');
  });
});
