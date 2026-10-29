// Goal: discovery preserves choices and publish toggles always select at least one destination.
// Method: mount real settings with deferred IPC, exercise controls, and inspect saved metadata.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const { DEFAULT_PUBLISH_CONFIG } = require('#dist/shared/properties/publishConfig.js');
const React = require('react');
const { act } = React;

function fixture(context, source) {
  const output = repoPath('node_modules/.stacki-test/publish-settings.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/publishing/PublishSettings.tsx')],
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
  const { PublishSettings } = require(output);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const discovery = [];
  const writes = [];
  window.avb = {
    projectMetadata: async () => ({ ok: true, value: { source } }),
    discoverPublishing: (input) => new Promise((resolve) => discovery.push({ ...input, resolve })),
    publishingRepositories: async () => ({
      ok: true,
      value: {
        connected: 'owner/site',
        revision: 'a'.repeat(64),
        repositories: ['owner/site'],
        mode: 'editable',
        notice: '',
      },
    }),
    writeProjectMetadata: async ({ write }) => {
      assert.equal(write.kind, 'publish');
      writes.push(JSON.parse(write.source));
      return { ok: true, value: { source: write.source } };
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
      root.render(React.createElement(PublishSettings, { projectPath: '/project', close() {} })),
    );
  return { discovery, writes, show, root };
}

const linked = {
  kind: 'ready',
  accounts: [],
  projects: [
    {
      name: 'website',
      hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'website' },
    },
  ],
};

test('GitHub loads during hosting discovery and keeps its account', async (context) => {
  const { discovery, writes, show } = fixture(context, undefined);
  await show();
  assert.deepEqual(discovery.map((call) => call.request.provider).sort(), ['github', 'linked']);
  assert.ok(document.querySelector('[aria-label="Hosting provider"]'));
  assert.equal(document.querySelector('.modal-footer .primary').disabled, true);
  assert.equal(document.querySelector('.modal-footer button').disabled, false);
  await act(async () =>
    discovery
      .find((call) => call.request.provider === 'github')
      .resolve({
        kind: 'ready',
        accounts: [{ id: 'owner', name: 'owner' }],
        projects: [],
      }),
  );
  assert.match(
    document.querySelector('[aria-label="GitHub repository"]').textContent,
    /owner\/site/,
  );
  await act(async () =>
    discovery.find((call) => call.request.provider === 'linked').resolve(linked),
  );
  const hosting = document.querySelector('[aria-label="Hosting project"]');
  assert.match(hosting.textContent, /website/);
  assert.equal(hosting.closest('[data-loading]').dataset.loading, 'false');
  await act(async () => document.querySelector('.modal-footer .primary').click());
  assert.equal(writes[0].githubAccount, 'owner');
  assert.equal(writes[0].hosting.project, 'website');
});

test('an explicit None selection wins over late hosting discovery', async (context) => {
  const { discovery, writes, show } = fixture(context, undefined);
  await show();
  await act(async () => document.querySelector('[aria-label="Hosting provider"]').click());
  const none = [...document.querySelectorAll('.dd-option')].find((option) =>
    option.textContent.includes('None'),
  );
  assert.ok(none);
  await act(async () => {
    none.click();
    discovery.find((call) => call.request.provider === 'linked').resolve(linked);
  });
  await act(async () => document.querySelector('.modal-footer .primary').click());
  assert.equal(writes[0].hosting.provider, 'none');
});

test('saved account and hosting remain visible while lists refresh', async (context) => {
  const source = JSON.stringify({
    ...DEFAULT_PUBLISH_CONFIG,
    githubAccount: 'owner',
    hosting: linked.projects[0].hosting,
  });
  const { discovery, show } = fixture(context, source);
  await show();
  assert.deepEqual(discovery.map((call) => call.request.provider).sort(), ['cloudflare', 'github']);
  for (const label of ['GitHub account', 'Hosting project']) {
    const field = document.querySelector(`[aria-label="${label}"]`);
    assert.equal(field.closest('[data-loading]').dataset.loading, 'false');
    assert.equal(field.closest('[aria-busy]').getAttribute('aria-busy'), 'true');
  }
  assert.match(document.querySelector('[aria-label="Hosting project"]').textContent, /website/);
  assert.equal(document.querySelector('.modal-footer .primary').disabled, false);
});

test('Publish destination toggles save every supported combination', async (context) => {
  const { show, writes } = fixture(context, JSON.stringify(DEFAULT_PUBLISH_CONFIG));
  await show();
  const [github, hosting] = document.querySelectorAll('.publish-target-switch');
  assert.equal(github.checked, true);
  assert.equal(hosting.checked, true);
  assert.equal(github.disabled, false);
  assert.equal(hosting.disabled, false);
  await act(async () => github.click());
  assert.equal(github.checked, false);
  assert.equal(hosting.checked, true);
  assert.equal(hosting.disabled, true);
  await act(async () => hosting.click());
  assert.equal(hosting.checked, true, 'The final enabled destination cannot be disabled');
  await act(async () => github.click());
  assert.equal(github.checked, true);
  assert.equal(hosting.disabled, false);
  await act(async () => hosting.click());
  assert.equal(hosting.checked, false);
  assert.equal(github.disabled, true);
  await act(async () => document.querySelector('.modal-footer .primary').click());
  assert.equal(writes[0].defaultTarget, 'github');
});

for (const defaultTarget of ['all', 'github', 'hosting']) {
  test(`Publish toggles restore the saved ${defaultTarget} choice`, async (context) => {
    const source = JSON.stringify({ ...DEFAULT_PUBLISH_CONFIG, defaultTarget });
    const { show, writes } = fixture(context, source);
    await show();
    const [github, hosting] = document.querySelectorAll('.publish-target-switch');
    assert.equal(github.checked, defaultTarget !== 'hosting');
    assert.equal(hosting.checked, defaultTarget !== 'github');
    await act(async () => document.querySelector('.modal-footer .primary').click());
    assert.equal(writes[0].defaultTarget, defaultTarget);
  });
}

test('Add account opens browser sign-in and refreshes the account picker', async (context) => {
  const { discovery, show } = fixture(context, undefined);
  const actions = [];
  const opened = [];
  window.avb.publishingAccount = async ({ request }) => {
    actions.push(request.action);
    return request.action === 'start'
      ? { kind: 'waiting', code: 'ABCD-1234' }
      : request.action === 'status'
        ? { kind: 'complete' }
        : { kind: 'cancelled' };
  };
  window.avb.openExternal = async (url) => {
    opened.push(url);
    return { ok: true };
  };
  await show();
  await act(async () =>
    discovery
      .find((call) => call.request.provider === 'github')
      .resolve({
        kind: 'ready',
        accounts: [{ id: 'owner', name: 'owner' }],
        projects: [],
      }),
  );
  const add = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Add account',
  );
  assert.ok(add);
  await act(async () => add.click());
  assert.equal(document.querySelector('.publish-account-code').value, 'ABCD-1234');
  await act(async () => document.querySelector('.publish-add-account .primary').click());
  assert.deepEqual(opened, ['https://github.com/login/device']);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  const requests = discovery.filter((call) => call.request.provider === 'github');
  assert.equal(requests.length, 2);
  assert.equal(document.querySelector('.publish-add-account') ?? undefined, undefined);
  await act(async () =>
    requests[1].resolve({
      kind: 'ready',
      accounts: [
        { id: 'owner', name: 'owner' },
        { id: 'new', name: 'new' },
      ],
      projects: [],
    }),
  );
  await act(async () => document.querySelector('[aria-label="GitHub account"]').click());
  assert.ok(
    [...document.querySelectorAll('.dd-option-label')].some(
      (option) => option.textContent === 'new',
    ),
  );
  assert.deepEqual(actions, ['start', 'status', 'cancel']);
});

test('cancelling Add account stops its pending sign-in', async (context) => {
  const { show } = fixture(context, undefined);
  const actions = [];
  window.avb.publishingAccount = async ({ request }) => {
    actions.push(request.action);
    return { kind: request.action === 'cancel' ? 'cancelled' : 'starting' };
  };
  await show();
  const add = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Add account',
  );
  await act(async () => add.click());
  await act(async () =>
    document.querySelector('.publish-add-account .modal-footer button').click(),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal(document.querySelector('.publish-add-account') ?? undefined, undefined);
  assert.deepEqual(actions, ['start', 'cancel']);
});

const cloudflareInventory = {
  kind: 'ready',
  accounts: [
    { id: 'account', name: 'Personal' },
    { id: 'team', name: 'Team' },
  ],
  projects: [
    ...linked.projects,
    {
      name: 'team-site',
      hosting: {
        provider: 'cloudflare-workers',
        accountId: 'team',
        project: 'team-site',
      },
    },
  ],
};

async function choose(label, name) {
  await act(async () => document.querySelector(`[aria-label="${label}"]`).click());
  const option = [...document.querySelectorAll('.dd-option')].find(
    (entry) => entry.querySelector('.dd-option-label')?.textContent === name,
  );
  assert.ok(option, `Expected ${name} in ${label}`);
  await act(async () => option.click());
}

function cloudflareSettings() {
  return JSON.stringify({ ...DEFAULT_PUBLISH_CONFIG, hosting: linked.projects[0].hosting });
}

async function loadCloudflare(discovery) {
  await act(async () =>
    discovery.find((call) => call.request.provider === 'cloudflare').resolve(cloudflareInventory),
  );
}

test('Switching Cloudflare accounts clears and filters projects', async (context) => {
  const { discovery, writes, show } = fixture(context, cloudflareSettings());
  await show();
  await loadCloudflare(discovery);
  assert.match(document.querySelector('[aria-label="Cloudflare account"]').textContent, /Personal/);
  await choose('Cloudflare account', 'Team');
  assert.doesNotMatch(
    document.querySelector('[aria-label="Hosting project"]').textContent,
    /website/,
  );
  await act(async () => document.querySelector('[aria-label="Hosting project"]').click());
  assert.equal(
    [...document.querySelectorAll('.dd-option-label')].some(
      (entry) => entry.textContent === 'website',
    ),
    false,
  );
  const team = [...document.querySelectorAll('.dd-option')].find(
    (entry) => entry.querySelector('.dd-option-label')?.textContent === 'team-site',
  );
  await act(async () => team.click());
  await act(async () => document.querySelector('.modal-footer .primary').click());
  assert.deepEqual(writes[0].hosting, cloudflareInventory.projects[1].hosting);
});

test('Add Worker validates and stages its destination until Save', async (context) => {
  const { discovery, writes, show } = fixture(context, cloudflareSettings());
  await show();
  await loadCloudflare(discovery);
  const add = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent === 'Add Worker',
  );
  await act(async () => add.click());
  const input = document.querySelector('.publish-new-worker input');
  const submit = document.querySelector('.publish-new-worker .primary');
  assert.equal(submit.disabled, true);
  const { Simulate } = require('react-dom/test-utils');
  for (const [name, disabled] of [
    ['website', true],
    ['BAD NAME', true],
    ['-bad', true],
    ['new-site', false],
  ]) {
    await act(async () => {
      Simulate.change(input, { target: { value: name } });
    });
    assert.equal(submit.disabled, disabled, name);
  }
  await act(async () => submit.click());
  assert.equal(writes.length, 0);
  assert.match(document.querySelector('[aria-label="Hosting project"]').textContent, /new-site/);
  await act(async () => document.querySelector('.modal-footer .primary').click());
  assert.deepEqual(writes[0].hosting, {
    provider: 'cloudflare-workers',
    accountId: 'account',
    project: 'new-site',
  });
});

test('Cloudflare sign-in opens authorization and refreshes accounts', async (context) => {
  const { discovery, show } = fixture(context, cloudflareSettings());
  const url = 'https://dash.cloudflare.com/oauth2/auth?state=nonce';
  const actions = [];
  const opened = [];
  window.avb.publishingAccount = async ({ request }) => {
    actions.push(request);
    return request.action === 'start'
      ? { kind: 'browser', url }
      : request.action === 'status'
        ? { kind: 'complete' }
        : { kind: 'cancelled' };
  };
  window.avb.openExternal = async (target) => {
    opened.push(target);
    return { ok: true };
  };
  await show();
  await loadCloudflare(discovery);
  const field = document
    .querySelector('[aria-label="Cloudflare account"]')
    .closest('.publish-field');
  const add = [...field.querySelectorAll('button')].find(
    (entry) => entry.textContent === 'Add account',
  );
  await act(async () => add.click());
  await act(async () => document.querySelector('.publish-add-account .primary').click());
  assert.deepEqual(opened, [url]);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
  assert.equal(discovery.filter((call) => call.request.provider === 'cloudflare').length, 2);
  assert.ok(actions.every((request) => request.provider === 'cloudflare'));
  assert.deepEqual(
    actions.map((request) => request.action),
    ['start', 'status', 'cancel'],
  );
});

test('Cloudflare shows account names through loading and failed refreshes', async (context) => {
  const accountId = '3ce2a94f4915358f35e4ec80d6f0cd77';
  const hosting = { ...linked.projects[0].hosting, accountId };
  const source = JSON.stringify({ ...DEFAULT_PUBLISH_CONFIG, hosting });
  const { discovery, writes, show } = fixture(context, source);
  const account = () => document.querySelector('[aria-label="Cloudflare account"]');
  const refresh = () => document.querySelector('[aria-label="Refresh cloudflare account"]');
  await show();
  assert.match(account().textContent, /Loading account name/);
  assert.doesNotMatch(account().textContent, new RegExp(accountId));
  await act(async () =>
    discovery
      .find((call) => call.request.provider === 'cloudflare')
      .resolve({
        kind: 'ready',
        accounts: [{ id: accountId, name: 'Church International' }],
        projects: [{ name: 'website', hosting }],
      }),
  );
  assert.equal(account().textContent, 'Church International');
  await act(async () => refresh().click());
  assert.equal(account().textContent, 'Church International');
  await act(async () => discovery.at(-1).resolve({ kind: 'failed', message: 'Offline' }));
  assert.equal(account().textContent, 'Church International');
  await act(async () => account().click());
  assert.equal(document.querySelector('.dd-option-label').textContent, 'Church International');
  await act(async () => document.querySelector('.dd-option').click());
  await act(async () => document.querySelector('.modal-footer .primary').click());
  assert.equal(writes[0].hosting.accountId, accountId, 'Names never replace deployment IDs');
});

test('An unavailable Cloudflare name does not masquerade as an ID', async (context) => {
  const { discovery, writes, show } = fixture(context, cloudflareSettings());
  await show();
  await act(async () =>
    discovery
      .find((call) => call.request.provider === 'cloudflare')
      .resolve({
        kind: 'failed',
        message: 'Offline',
      }),
  );
  const account = document.querySelector('[aria-label="Cloudflare account"]');
  assert.equal(account.textContent, 'Account name unavailable');
  await act(async () => document.querySelector('.modal-footer .primary').click());
  assert.deepEqual(writes[0].hosting, linked.projects[0].hosting);
});

test('Hosting projects omit unresolved account IDs from dropdown headings', async (context) => {
  const accountId = '3ce2a94f4915358f35e4ec80d6f0cd77';
  const hosting = { ...linked.projects[0].hosting, accountId };
  const { discovery, show } = fixture(
    context,
    JSON.stringify({ ...DEFAULT_PUBLISH_CONFIG, hosting }),
  );
  await show();
  await act(async () =>
    discovery
      .find((call) => call.request.provider === 'cloudflare')
      .resolve({
        kind: 'ready',
        accounts: [],
        projects: [{ name: 'website', hosting }],
      }),
  );
  await act(async () => document.querySelector('[aria-label="Hosting project"]').click());
  const dropdown = document.querySelector('.publish-dropdown');
  assert.match(dropdown.textContent, /website/);
  assert.doesNotMatch(dropdown.textContent, new RegExp(accountId));
});
