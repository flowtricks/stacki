// Goal: the create-repository dialog lets the person choose a personal account or an organization,
// shows skeletons while organizations load, offers the fix for a missing scope, and sends the chosen owner.
// Method: mount the real PublishRepositories with a scripted window.avb.publishingRepositories (no network),
// open the dialog, pick an owner in the custom Dropdown, create, and inspect the recorded request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

const REVISION = 'a'.repeat(64);
function listed(extra) {
  return {
    ok: true,
    value: { connected: '', revision: REVISION, repositories: [], mode: 'editable', organizations: [], organizationAccess: 'available', notice: '', ...extra },
  };
}

function fixture(context, onList) {
  const output = repoPath('node_modules/.stacki-test/publish-new-repository-owner.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/publishing/PublishRepositories.tsx')],
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
  const { PublishRepositories } = require(output);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  const changes = [];
  window.avb = {
    publishingRepositories: (input) => {
      requests.push(input.request);
      if (input.request.action === 'list') {
        return onList();
      }
      return Promise.resolve(listed({ repositories: [`${input.request.owner}/${input.request.name}`] }));
    },
  };
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const show = () =>
    act(async () =>
      root.render(
        React.createElement(PublishRepositories, {
          projectPath: '/project/site',
          account: 'me',
          selection: undefined,
          change: (selection) => changes.push(selection),
          busy() {},
        }),
      ),
    );
  return { requests, changes, show };
}
const open = () => act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add repo').click());

test('the owner picker lists the account and its organizations and creates under the chosen one', async (context) => {
  const { requests, changes, show } = fixture(context, async () => listed({ organizations: ['acme-co', 'beta-labs'] }));
  await show();
  await open();
  const picker = document.querySelector('[aria-label="Repository owner"]');
  assert.ok(picker);
  assert.match(picker.textContent, /me \(you\)/);
  await act(async () => picker.click());
  const options = [...document.querySelectorAll('.dd-option')].map((option) => option.textContent);
  assert.deepEqual(
    options.map((text) => text.trim()),
    ['me (you)', 'acme-co', 'beta-labs'],
  );
  await act(async () => [...document.querySelectorAll('.dd-option')].find((option) => option.textContent.includes('acme-co')).click());
  await act(async () => [...document.querySelectorAll('.modal-footer button')].find((button) => button.textContent === 'Create repo').click());
  const create = requests.find((request) => request.action === 'create');
  assert.equal(create.account, 'me');
  assert.equal(create.owner, 'acme-co');
  assert.equal(create.name, 'site');
  assert.equal(changes.at(-1).repository, 'acme-co/site');
  assert.equal(changes.at(-1).account, 'me');
});

test('creating without touching the picker defaults to the personal account', async (context) => {
  const { requests, changes, show } = fixture(context, async () => listed({ organizations: ['acme-co'] }));
  await show();
  await open();
  await act(async () => [...document.querySelectorAll('.modal-footer button')].find((button) => button.textContent === 'Create repo').click());
  assert.equal(requests.find((request) => request.action === 'create').owner, 'me');
  assert.equal(changes.at(-1).repository, 'me/site');
});

test('a skeleton stands in for the owner picker while organizations load, and never the word Loading', async (context) => {
  let finish;
  const { show } = fixture(context, () => new Promise((resolve) => (finish = resolve)));
  await show();
  await open();
  const dialog = document.querySelector('.publish-new-repository');
  assert.ok(dialog.querySelector('.ui-skeleton'));
  assert.equal(dialog.querySelector('[aria-label="Repository owner"]') === null, true);
  assert.doesNotMatch(dialog.textContent, /loading/i);
  await act(async () => finish(listed({ organizations: ['acme-co'] })));
  assert.equal(dialog.querySelector('.ui-skeleton') === null, true);
  assert.ok(dialog.querySelector('[aria-label="Repository owner"]'));
});

test('a missing organization scope shows the command that fixes it instead of hiding organizations', async (context) => {
  const { show } = fixture(context, async () => listed({ organizationAccess: 'needsScope' }));
  await show();
  await open();
  const dialog = document.querySelector('.publish-new-repository');
  assert.match(dialog.textContent, /gh auth refresh --hostname github\.com --scopes read:org/);
  assert.match(dialog.textContent, /organizations are hidden/i);
});
