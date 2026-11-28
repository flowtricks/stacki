// Goal: Publish settings let a person add, name, aim and remove any number of destinations up to the limit, keeping each
// one's id; every host asks only for what the earlier choice makes possible; and nothing unsafe or unfinished is saved.
// Method: mount the real settings and the app's confirm host with deferred discovery, drive the controls, and inspect
// the toasts, the saved files and the deploy link requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const { DEFAULT_PUBLISH_CONFIG } = require('#dist/shared/properties/publishConfig.js');
const { parseDestinationsSource } = require('#dist/shared/properties/publishDestinations.js');
const React = require('react');
const { act } = React;

const NETLIFY = { ...DEFAULT_PUBLISH_CONFIG, hosting: { provider: 'netlify', siteId: 'live-site' } };
const WORKERS = { ...DEFAULT_PUBLISH_CONFIG, hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'website' } };

function fixture(context, publish, destinations) {
  const output = repoPath('node_modules/.stacki-test/publish-destination-settings.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: {
      contents:
        "export { PublishSettings } from './src/features/publishing/PublishSettings';\n" +
        "export { ConfirmHost } from './src/ui/ConfirmDialog';\n" +
        "export { subscribeErrorToasts } from './src/ui/errorNotices';\n",
      resolveDir: ROOT,
      loader: 'ts',
    },
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  delete require.cache[output];
  const { PublishSettings, ConfirmHost, subscribeErrorToasts } = require(output);
  const toasts = [];
  const unsubscribe = subscribeErrorToasts(
    (notice) => toasts.push(notice.message),
    () => {},
  );
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const discovery = [];
  const writes = { publish: [], publishDestinations: [] };
  const links = [];
  const sources = {
    publish: JSON.stringify(publish),
    publishDestinations: destinations === undefined ? undefined : JSON.stringify(destinations),
  };
  window.avb = {
    projectMetadata: async (input) => ({ ok: true, value: { source: sources[input.kind] } }),
    discoverPublishing: (input) => new Promise((resolve) => discovery.push({ ...input, resolve })),
    publishingRepositories: async () => ({ ok: false, error: 'not asked' }),
    publishingCustomHost: async ({ request }) => {
      if (request.action !== 'read') {
        links.push(request);
      }
      const unsaved = { kind: 'none' };
      return {
        kind: 'ready',
        scripts: ['build', 'build:staging', 'deploy:qa'],
        environments: [],
        links: { production: unsaved, destinations: {}, unsaved },
      };
    },
    setUpPublishWorker: async () => assert.fail('a destination’s Worker must not set the site up as production'),
    writeProjectMetadata: async ({ write }) => {
      writes[write.kind].push(write.source);
      return { ok: true, value: { source: write.source } };
    },
  };
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    unsubscribe();
    dom.window.close();
  });
  const show = () =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          undefined,
          React.createElement(PublishSettings, { projectPath: '/project', close() {} }),
          React.createElement(ConfirmHost),
        ),
      ),
    );
  const saved = () => parseDestinationsSource(writes.publishDestinations.at(-1)).destinations;
  return { show, discovery, writes, links, toasts, saved };
}

const cards = () => [...document.querySelectorAll('.publish-destination')];
const names = () => cards().map((card) => card.querySelector('.publish-destination-name').textContent);
const button = (text, within = document) => [...within.querySelectorAll('button')].find((entry) => entry.textContent === text);
const click = (element) => act(async () => element.click());
const within = (card, label) => card.querySelector(`[aria-label="${label}"]`) ?? undefined;
const save = () => click(document.querySelector('.modal-footer .primary'));

async function type(input, value) {
  const { Simulate } = require('react-dom/test-utils');
  await act(async () => {
    Simulate.change(input, { target: { value } });
  });
}

async function choose(card, label, option) {
  await click(within(card, label));
  const found = [...document.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === option);
  assert.ok(found, `${option} is offered by ${label}`);
  await click(found);
}

const add = () => click(button('Add destination'));

function destination(id, label, target) {
  return { id, label, target, buildScript: 'build', beforePublish: [], afterPublish: [] };
}

test('with none added there is one button, and saving writes no destinations file', async (context) => {
  const view = fixture(context, NETLIFY);
  await view.show();
  assert.equal(cards().length, 0);
  assert.ok(button('Add destination'));
  await save();
  assert.equal(view.writes.publish.length, 1);
  assert.deepEqual(view.writes.publishDestinations, []);
});

test('the first is labelled Staging, the next Staging 2, and each starts apart from the others', async (context) => {
  const view = fixture(context, NETLIFY);
  await view.show();
  await add();
  assert.deepEqual(names(), ['Staging']);
  assert.equal(within(cards()[0], 'Label').value, 'Staging', 'the label is in plain view');
  assert.equal(cards()[0].querySelector('details').open, false);
  assert.equal(cards()[0].querySelector('button.publish-destination-toggle') === null, true, 'one destination does not fold');
  await add();
  assert.deepEqual(names(), ['Staging', 'Staging 2']);
  await save();
  const saved = view.saved();
  assert.deepEqual(
    saved.map((entry) => [entry.label, entry.target]),
    [
      ['Staging', { kind: 'netlify', alias: 'staging' }],
      ['Staging 2', { kind: 'netlify', alias: 'staging-2' }],
    ],
  );
  assert.notEqual(saved[0].id, saved[1].id);
  assert.deepEqual(view.toasts, []);
});

test('several destinations fold to a header naming each and its host', async (context) => {
  const view = fixture(context, NETLIFY, {
    version: 1,
    destinations: [destination('d-a', 'QA', { kind: 'netlify', alias: 'qa' }), destination('d-b', 'Client', { kind: 'github-branch', branch: 'client' })],
  });
  await view.show();
  assert.deepEqual(
    cards().map((card) => card.querySelector('.publish-destination-toggle').textContent),
    ['QANetlify', 'ClientCustom'],
  );
  assert.ok(within(cards()[0], 'Label') === undefined);
  await click(cards()[0].querySelector('button.publish-destination-toggle'));
  assert.equal(within(cards()[0], 'Label').value, 'QA');
  assert.ok(within(cards()[1], 'Label') === undefined);
});

test('renaming keeps the id, the target and the place in the list', async (context) => {
  const before = destination('d-a', 'QA', { kind: 'netlify', alias: 'qa' });
  const view = fixture(context, NETLIFY, { version: 1, destinations: [before] });
  await view.show();
  await type(within(cards()[0], 'Label'), '  Client sign-off ');
  await save();
  assert.deepEqual(view.saved(), [{ ...before, label: 'Client sign-off' }]);
});

for (const [name, label, toast] of [
  ['blank', '   ', 'Give every destination a label.'],
  ['a duplicate', ' qa ', 'Two destinations are labeled qa. Give each its own label.'],
  ['production’s', 'Production', 'Production and GitHub are already taken. Choose another label.'],
  ['a link', 'https://example.com', 'A label has up to 60 characters and no slashes.'],
]) {
  test(`a label that is ${name} is named in a toast, marked and never saved`, async (context) => {
    const view = fixture(context, NETLIFY, {
      version: 1,
      destinations: [destination('d-a', 'QA', { kind: 'netlify', alias: 'qa' }), destination('d-b', 'Client', { kind: 'netlify', alias: 'client' })],
    });
    await view.show();
    await click(cards()[1].querySelector('button.publish-destination-toggle'));
    await type(within(cards()[1], 'Label'), label);
    // Folded again, so Save has to open it to show what is wrong.
    await click(cards()[1].querySelector('button.publish-destination-toggle'));
    await save();
    assert.deepEqual(view.toasts, [toast]);
    assert.equal(within(cards()[1], 'Label').getAttribute('aria-invalid'), 'true');
    assert.deepEqual([view.writes.publish, view.writes.publishDestinations], [[], []]);
    assert.ok(document.querySelector('.publish-settings [role="alert"]') === null, 'no inline paragraph');
  });
}

test('ten is the most: the button then explains itself in a tooltip', async (context) => {
  const view = fixture(context, NETLIFY);
  await view.show();
  for (let count = 0; count < 10; count++) {
    await add();
  }
  assert.equal(cards().length, 10);
  assert.equal(button('Add destination').disabled, true);
  assert.equal(button('Add destination').parentElement.title, 'A project can have up to 10 destinations.');
  await save();
  assert.equal(view.saved().length, 10);
  assert.deepEqual(view.toasts, []);
});

test('removing asks first, and Save then forgets the removed destination’s deploy link', async (context) => {
  const view = fixture(context, DEFAULT_PUBLISH_CONFIG, {
    version: 1,
    destinations: [destination('d-a', 'QA', { kind: 'link', branch: 'qa' }), destination('d-b', 'Client', { kind: 'github-branch', branch: 'client' })],
  });
  await view.show();
  await click(document.querySelector('[aria-label="Remove QA"]'));
  const confirm = () => document.querySelector('.confirm-dialog');
  assert.match(confirm().textContent, /Remove QA\?.*deploy link are deleted when you save.*stays online/s);
  await click(button('Cancel', confirm()));
  assert.deepEqual(names(), ['QA', 'Client']);
  await click(document.querySelector('[aria-label="Remove QA"]'));
  await click(button('Remove destination', confirm()));
  assert.deepEqual(names(), ['Client']);
  assert.deepEqual(view.links, [], 'nothing is forgotten before Save');
  await save();
  assert.deepEqual(view.links, [{ action: 'removeLink', destination: 'd-a' }]);
  assert.deepEqual(
    view.saved().map((entry) => entry.id),
    ['d-b'],
  );
});

test('each link destination keeps its own typed link, and one link for two is refused before anything is written', async (context) => {
  const entries = [destination('d-a', 'QA', { kind: 'link', branch: 'qa' }), destination('d-b', 'Client', { kind: 'link', branch: 'client' })];
  const view = fixture(context, DEFAULT_PUBLISH_CONFIG, { version: 1, destinations: entries });
  await view.show();
  for (const card of cards()) {
    await click(card.querySelector('button.publish-destination-toggle'));
  }
  const field = (index) => cards()[index].querySelector('input[type="password"]');
  await type(field(0), 'https://host.example/one');
  await type(field(1), 'https://host.example/one');
  await save();
  assert.deepEqual(view.toasts, ['Two destinations cannot share a deploy link. Give each its own.']);
  assert.deepEqual([view.writes.publish, view.links], [[], []]);
  await type(field(1), 'https://host.example/two');
  await save();
  assert.deepEqual(view.links, [
    { action: 'saveLink', destination: 'd-a', link: 'https://host.example/one' },
    { action: 'saveLink', destination: 'd-b', link: 'https://host.example/two' },
  ]);
  assert.ok(!view.writes.publishDestinations.join('').includes('host.example'), 'a link is never written to the project');
});

test('two destinations aimed at one place are refused with both named', async (context) => {
  const view = fixture(context, NETLIFY, {
    version: 1,
    destinations: [destination('d-a', 'QA', { kind: 'netlify', alias: 'qa' }), destination('d-b', 'Client', { kind: 'netlify', alias: 'client' })],
  });
  await view.show();
  await click(cards()[1].querySelector('button.publish-destination-toggle'));
  await type(within(cards()[1], 'Alias'), 'qa');
  await save();
  assert.deepEqual(view.toasts, ['QA and Client would publish to the same place. Give one of them a different target.']);
  assert.deepEqual(view.writes.publish, []);
});

test('a label or a branch cleared while typing leaves the form working, and Save says what is missing', async (context) => {
  const view = fixture(context, DEFAULT_PUBLISH_CONFIG, {
    version: 1,
    destinations: [destination('d-a', 'QA', { kind: 'github-branch', branch: 'qa' })],
  });
  await view.show();
  await type(within(cards()[0], 'Branch'), '');
  await type(within(cards()[0], 'Label'), '');
  await save();
  assert.deepEqual(view.toasts, ['Give every destination a label.']);
  await type(within(cards()[0], 'Label'), 'QA');
  await save();
  assert.equal(view.toasts.at(-1), 'QA: enter a branch');
  assert.deepEqual(view.writes.publish, []);
});

test('changing production’s host moves a destination that borrowed the old one to the new form', async (context) => {
  const view = fixture(context, NETLIFY, { version: 1, destinations: [destination('d-a', 'QA', { kind: 'netlify', alias: 'qa' })] });
  await view.show();
  await click(document.querySelector('[aria-label="Hosting provider"]'));
  await click([...document.querySelectorAll('.dd-option')].find((entry) => entry.textContent.includes('None')));
  await save();
  // The project has a script named for this destination, so that is what it now suggests.
  assert.deepEqual(view.saved()[0].target, { kind: 'script', script: 'deploy:qa' });
  assert.deepEqual(view.toasts, []);
});

const inventory = {
  kind: 'ready',
  accounts: [
    { id: 'account', name: 'Personal' },
    { id: 'other', name: 'Other' },
  ],
  projects: [{ name: 'website', hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'website' } }],
};

const answer = (view, provider, reply) =>
  act(async () => {
    for (const call of view.discovery.filter((entry) => entry.request.provider === provider)) {
      call.resolve(reply);
    }
  });

test('every host is offered, and an own Cloudflare asks for the project only once there is an account', async (context) => {
  const view = fixture(context, NETLIFY);
  await view.show();
  await add();
  const card = () => cards()[0];
  await click(within(card(), 'Hosting'));
  assert.deepEqual(
    [...document.querySelectorAll('.dd-option-label')].map((entry) => entry.textContent),
    ['Same as production', 'Cloudflare', 'Vercel', 'Netlify', 'Custom'],
  );
  await click(within(card(), 'Hosting'));
  await choose(card(), 'Hosting', 'Cloudflare');
  await answer(view, 'cloudflare', inventory);
  assert.ok(within(card(), 'Cloudflare account'));
  assert.ok(within(card(), 'Hosting project') === undefined);
  await save();
  assert.deepEqual(view.toasts, ['Staging: choose a Cloudflare account']);
  assert.equal(within(card(), 'Cloudflare account').getAttribute('aria-invalid'), 'true');
  assert.equal(document.querySelector('[aria-label="Hosting provider"]').hasAttribute('aria-invalid'), false);
  await choose(card(), 'Cloudflare account', 'Personal');
  await click(within(card(), 'Hosting project'));
  assert.equal(document.querySelector('.dd-option-label').textContent, 'Add Worker', 'each list starts with its Add row');
});

test('an own host that is signed out shows only the sign-in button, no lists', async (context) => {
  const view = fixture(context, DEFAULT_PUBLISH_CONFIG);
  await view.show();
  await add();
  await choose(cards()[0], 'Hosting', 'Cloudflare');
  await answer(view, 'cloudflare', { kind: 'failed', reason: 'signed-out', message: 'Signed out.' });
  assert.ok(within(cards()[0], 'Cloudflare account') === undefined);
  assert.ok(within(cards()[0], 'Hosting project') === undefined);
  assert.ok(button('Sign in to Cloudflare', cards()[0]));
});

test('naming a new Worker for a destination only names it, and saves with the rest', async (context) => {
  const view = fixture(context, NETLIFY);
  await view.show();
  await add();
  await choose(cards()[0], 'Hosting', 'Cloudflare');
  await answer(view, 'cloudflare', inventory);
  await choose(cards()[0], 'Cloudflare account', 'Personal');
  await click(button('Add Worker', cards()[0]));
  await type(document.querySelector('.publish-new-worker input'), 'review-site');
  await click(document.querySelector('.publish-new-worker .primary'));
  assert.deepEqual(view.writes.publish, [], 'nothing is saved before Save');
  await save();
  assert.deepEqual(view.saved()[0].target, {
    kind: 'host',
    hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'review-site' },
  });
});

test('choosing production’s own project as an own host is refused', async (context) => {
  const view = fixture(context, WORKERS);
  await view.show();
  await add();
  await choose(cards()[0], 'Hosting', 'Cloudflare');
  await answer(view, 'cloudflare', inventory);
  await choose(cards()[0], 'Cloudflare account', 'Personal');
  await choose(cards()[0], 'Hosting project', 'website');
  await save();
  assert.deepEqual(view.toasts, ['Staging uses production’s project. Choose another project, or Same as production.']);
  assert.deepEqual(view.writes.publish, []);
});

test('the separate Worker is chosen from the account, never offering production’s', async (context) => {
  const view = fixture(context, WORKERS, {
    version: 1,
    destinations: [destination('d-a', 'QA', { kind: 'cloudflare-worker', project: 'website-qa' })],
  });
  await view.show();
  await answer(view, 'cloudflare', inventory);
  await click(within(cards()[0], 'Worker'));
  const offered = [...document.querySelectorAll('.dd-option-label')].map((entry) => entry.textContent);
  assert.equal(offered[0], 'Add Worker');
  assert.ok(!offered.includes('website'));
});

test('a file from the preview build opens as one Staging destination and keeps its id when saved', async (context) => {
  const preview = { id: 'staging', target: { kind: 'netlify', alias: 'staging' }, buildScript: 'build:staging', beforePublish: [], afterPublish: [] };
  const view = fixture(context, NETLIFY, { version: 1, destinations: [preview] });
  await view.show();
  assert.deepEqual(names(), ['Staging']);
  await save();
  assert.deepEqual(view.saved(), [{ ...preview, label: 'Staging' }]);
});

test('an unreadable destinations file leaves production editable and is never overwritten', async (context) => {
  const view = fixture(context, NETLIFY, { version: 9 });
  await view.show();
  assert.ok(button('Add destination') === undefined);
  await save();
  assert.equal(view.writes.publish.length, 1);
  assert.deepEqual(view.writes.publishDestinations, []);
});
