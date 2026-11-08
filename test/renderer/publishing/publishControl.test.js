// Goal: publishing actions disable independently, explain why, and recover after new edits.
// Method: render the real split button with destination states and exercise its DOM controls.
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

function fixture(context, config = DEFAULT_PUBLISH_CONFIG) {
  const output = repoPath('node_modules/.stacki-test/publish-control.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/publishing/PublishControl.tsx')],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
    loader: { '.css': 'empty' },
  });
  delete require.cache[output];
  const { PublishControl } = require(output);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const writes = [];
  window.avb = {
    publishedSiteURL: async () => 'https://example.com',
    discoverPublishing: async () => ({ kind: 'ready', accounts: [], projects: [] }),
    publishingRepositories: async () => ({
      ok: true,
      value: {
        connected: '',
        revision: 'a'.repeat(64),
        repositories: [],
        mode: 'editable',
        notice: '',
      },
    }),
    writeProjectMetadata: async ({ write }) => {
      config = JSON.parse(write.source);
      writes.push(config);
      return { ok: true, value: { source: write.source } };
    },
    projectMetadata: async () => ({
      ok: true,
      value: {
        source: JSON.stringify(config),
      },
    }),
  };
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const published = [];
  let settingsClosed = 0;
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const show = (availability, projectPath = '/project') =>
    act(async () =>
      root.render(
        React.createElement(PublishControl, {
          projectPath,
          busy: false,
          availability,
          publish: (target) => published.push(target),
          settingsClosed: () => settingsClosed++,
        }),
      ),
    );
  return {
    show,
    published,
    writes,
    closed: () => settingsClosed,
    configure: (next) => {
      config = next;
    },
  };
}

const split = () => document.querySelector('.stacki-publish-split');
const main = () => document.querySelector('.stacki-publish-main button');
const arrow = () => document.querySelector('[aria-label="More publish options"]');
const options = () => [...document.querySelectorAll('.stacki-publish-menu button')];

test('Hosting shows pending changes and opens the live site independently', async (context) => {
  const { show, published } = fixture(context, {
    ...DEFAULT_PUBLISH_CONFIG,
    hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'site' },
  });
  await show({ github: 'current', hosting: 'pending' });
  await act(async () => arrow().click());
  assert.match(options()[1].textContent, /Changes to deploy/);
  const link = document.querySelector('[aria-label="Open published site"]');
  assert.equal(link.href, 'https://example.com/');
  assert.equal(link.target, '_blank');
  assert.equal(link.parentElement, options()[1].parentElement);
  assert.equal(link.closest('button') === null, true);
  link.addEventListener('click', (event) => event.preventDefault());
  await act(async () => link.click());
  assert.deepEqual(published, []);
  await show({ github: 'current', hosting: 'current' });
  assert.equal(options()[1].disabled, true);
  assert.match(options()[1].textContent, /Up to date/);
  assert.equal(document.querySelector('[aria-label="Open published site"]'), link);
  await show({ github: 'unknown', hosting: 'unknown' });
  assert.match(options()[1].textContent, /Deployment status unavailable/);
  assert.equal(document.querySelector('[aria-label="Open published site"]'), link);
  await show({ github: 'current', hosting: 'pending' });
  await act(async () => options()[1].click());
  assert.deepEqual(published, ['hosting']);
});

test('Unknown URLs and late discoveries cannot show a stale site', async (context) => {
  const { show } = fixture(context);
  let resolve;
  window.avb.publishedSiteURL = () =>
    new Promise((done) => {
      resolve = done;
    });
  await show({ github: 'current', hosting: 'pending' });
  await act(async () => arrow().click());
  assert.equal(document.querySelector('[aria-label="Open published site"]') === null, true);
  window.avb.publishedSiteURL = async () => undefined;
  await show({ github: 'current', hosting: 'pending' }, '/another-project');
  await act(async () => resolve('https://old.example.com'));
  assert.equal(document.querySelector('[aria-label="Open published site"]') === null, true);
  assert.equal(options()[1].disabled, false);
});

test('Current actions disable with explanations; settings stay available', async (context) => {
  const { show, published } = fixture(context);
  await show({ github: 'current', hosting: 'current' });
  assert.equal(main().disabled, true);
  assert.equal(main().parentElement.title, 'All changes are up to date');
  assert.equal(arrow().disabled, false);
  // Finished work rests as a neutral split control, not a dimmed blue call to action.
  assert.equal(split().dataset.state, 'current');
  assert.equal(main().classList.contains('primary'), false);
  assert.equal(arrow().classList.contains('primary'), false);
  await act(async () => arrow().click());
  const [github, hosting, settings] = options();
  assert.equal(github.disabled, true);
  assert.equal(hosting.disabled, true);
  assert.equal(settings.disabled, false);
  assert.equal(github.parentElement.title, 'All changes are up to date');
  assert.equal(hosting.parentElement.title, 'All changes are up to date');
  assert.equal(document.querySelector('.stacki-publish-current') === null, true);
  await act(async () => {
    main().click();
    github.click();
    hosting.click();
  });
  assert.deepEqual(published, []);
  await show({ github: 'pending', hosting: 'pending' });
  assert.equal(main().disabled, false);
  assert.equal(split().dataset.state, 'ready');
  assert.equal(main().classList.contains('primary'), true);
  assert.equal(arrow().classList.contains('primary'), true);
  assert.equal(main().parentElement.title, '');
  assert.equal(options()[0].disabled, false);
  assert.equal(options()[1].disabled, false);
  await act(async () => main().click());
  assert.deepEqual(published, ['all']);
});

for (const defaultTarget of ['github', 'hosting']) {
  test(`The main Publish button honors the saved ${defaultTarget} preference`, async (context) => {
    const { show, published, configure } = fixture(context, {
      ...DEFAULT_PUBLISH_CONFIG,
      defaultTarget,
      hosting: { provider: 'vercel', organizationId: 'team', projectId: 'site' },
    });
    await show({ github: 'pending', hosting: 'pending' });
    await act(async () => main().click());
    assert.deepEqual(published, [defaultTarget]);
    await act(async () => arrow().click());
    const other = defaultTarget === 'github' ? 1 : 0;
    await act(async () => options()[other].click());
    assert.deepEqual(published, [defaultTarget, defaultTarget === 'github' ? 'hosting' : 'github']);
    // A setting edited by the other host is reread before the main action executes.
    configure({ ...DEFAULT_PUBLISH_CONFIG, defaultTarget: 'github' });
    await act(async () => main().click());
    assert.equal(published.at(-1), 'github');
  });

  test(`The saved ${defaultTarget} preference controls the disabled state`, async (context) => {
    const { show } = fixture(context, { ...DEFAULT_PUBLISH_CONFIG, defaultTarget });
    await show({
      github: defaultTarget === 'github' ? 'current' : 'pending',
      hosting: defaultTarget === 'hosting' ? 'current' : 'pending',
    });
    assert.equal(main().disabled, true);
    await act(async () => arrow().click());
    assert.equal(options()[defaultTarget === 'github' ? 1 : 0].disabled, false);
  });
}

test('Push and deployment disable independently', async (context) => {
  const { show } = fixture(context);
  await show({ github: 'current', hosting: 'pending' });
  await act(async () => arrow().click());
  assert.equal(main().disabled, false);
  assert.equal(options()[0].disabled, true);
  assert.equal(options()[1].disabled, false);
  await show({ github: 'pending', hosting: 'current' });
  assert.equal(main().disabled, false);
  assert.equal(options()[0].disabled, false);
  assert.equal(options()[1].disabled, true);
  await show({ github: 'unknown', hosting: 'unknown' });
  assert.match(options()[1].textContent, /Deployment status unavailable/);
  assert.equal(document.querySelector('.publish-checking') === null, true);
  assert.equal(main().disabled, false);
  assert.equal(split().dataset.state, 'ready', 'A recheck after an edit never shows as finished');
  assert.equal(options()[0].disabled, false);
  assert.equal(options()[1].disabled, false);
  await show({ github: 'current', hosting: 'unconfigured' });
  assert.equal(main().disabled, true);
  assert.equal(options()[1].disabled, false);
  assert.equal(options()[2].disabled, false);
});

test('The repository link survives rechecks without keeping stale counts', async (context) => {
  const { show } = fixture(context);
  const repositoryUrl = 'https://github.com/example/website';
  const link = () => document.querySelector('[aria-label="Open GitHub repository"]');
  await show({
    github: 'pending',
    hosting: 'current',
    githubPush: { commits: 2, repositoryUrl },
  });
  await act(async () => arrow().click());
  const original = link();
  for (const github of ['unknown', 'pending']) {
    await show({ github, hosting: 'unknown' });
    assert.equal(link(), original, 'Rechecking must preserve the entire clickable segment');
    assert.equal(link().href, repositoryUrl);
    assert.match(options()[0].textContent, /Commit count unavailable/);
  }
  await act(async () => arrow().click());
  await act(async () => arrow().click());
  assert.equal(link().href, repositoryUrl, 'Reopening during a check retains the repository');
  await show({ github: 'unknown', hosting: 'unknown' }, '/another-project');
  assert.equal(link() === null, true, 'A different project must not inherit the previous remote');
  await show({
    github: 'current',
    hosting: 'current',
    githubPush: { commits: 0, repositoryUrl },
  });
  assert.equal(link().href, repositoryUrl);
  const replacementUrl = 'https://github.com/example/replacement';
  await show({
    github: 'pending',
    hosting: 'current',
    githubPush: { commits: 1, repositoryUrl: replacementUrl },
  });
  assert.equal(link().href, replacementUrl, 'A new remote replaces the remembered repository');
});

test('GitHub-only push does not require a publish settings file', async (context) => {
  const { show, published, configure } = fixture(context);
  configure(undefined);
  await show({ github: 'pending', hosting: 'unconfigured' });
  await act(async () => arrow().click());
  await act(async () => options()[0].click());
  assert.deepEqual(published, ['github']);
  assert.equal(document.querySelector('.publish-settings') === null, true);
});

test('GitHub push shows commit counts and keeps its repository link separate', async (context) => {
  const { show, published } = fixture(context);
  const repositoryUrl = 'https://github.com/example/website';
  await show({
    github: 'pending',
    hosting: 'current',
    githubPush: { commits: 1, repositoryUrl },
  });
  await act(async () => arrow().click());
  assert.match(options()[0].textContent, /1 commit to push/);
  await show({
    github: 'pending',
    hosting: 'current',
    githubPush: { commits: 3, repositoryUrl },
  });
  assert.match(options()[0].textContent, /3 commits to push/);
  const link = document.querySelector('[aria-label="Open GitHub repository"]');
  assert.equal(link.href, repositoryUrl);
  assert.equal(link.target, '_blank');
  assert.equal(link.parentElement, options()[0].parentElement);
  assert.equal(link.closest('button') === null, true, 'Links must not be nested in buttons');
  link.addEventListener('click', (event) => event.preventDefault());
  await act(async () => link.click());
  assert.deepEqual(published, [], 'Opening the repository never starts a push');
  await show({
    github: 'current',
    hosting: 'current',
    githubPush: { commits: 0, repositoryUrl },
  });
  assert.equal(options()[0].disabled, true);
  assert.match(options()[0].textContent, /No changes to push/);
  assert.equal(document.querySelector('[aria-label="Open GitHub repository"]').href, repositoryUrl);
  await show({ github: 'unknown', hosting: 'unknown' });
  assert.match(options()[0].textContent, /Commit count unavailable/);
  assert.equal(document.querySelector('[aria-label="Open GitHub repository"]').href, repositoryUrl);
  await show({
    github: 'pending',
    hosting: 'current',
    githubPush: { commits: 2, repositoryUrl },
  });
  await act(async () => options()[0].click());
  assert.deepEqual(published, ['github']);
});

const workerHosting = { provider: 'cloudflare-workers', accountId: 'account', project: 'website' };

for (const target of ['hosting', 'all']) {
  test(`Detected hosting publishes ${target} directly without settings`, async (context) => {
    const view = fixture(context);
    view.configure(undefined);
    window.avb.discoverPublishing = async ({ request }) => ({
      kind: 'ready',
      accounts: [],
      projects: request.provider === 'linked' ? [{ name: 'website', hosting: workerHosting }] : [],
    });
    await view.show({ github: 'current', hosting: 'unconfigured' });
    await act(async () => arrow().click());
    assert.match(options()[1].textContent, /Changes to deploy/);
    assert.equal(options()[1].querySelector('svg').dataset.provider, 'cloudflare-workers');
    assert.equal(main().disabled, false);
    assert.equal(document.querySelector('.stacki-publish-current') === null, true);
    await act(async () => (target === 'hosting' ? options()[1] : main()).click());
    assert.deepEqual(view.published, [target]);
    assert.deepEqual(view.writes, [{ ...DEFAULT_PUBLISH_CONFIG, hosting: workerHosting }]);
    assert.equal(document.querySelector('.publish-settings') === null, true);
    assert.equal(view.closed(), 0, 'Publishing never opens or closes settings');
    await view.show({ github: 'current', hosting: 'current' });
    assert.equal(main().disabled, true, 'Completed publishing uses the newly saved configuration');
  });
}

test('Publishing waits for the detected configuration to finish saving', async (context) => {
  const view = fixture(context);
  view.configure(undefined);
  window.avb.discoverPublishing = async () => ({
    kind: 'ready',
    accounts: [],
    projects: [{ name: 'website', hosting: workerHosting }],
  });
  let finish;
  let saved;
  window.avb.writeProjectMetadata = ({ write }) => {
    saved = write.source;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  await view.show({ github: 'pending', hosting: 'unconfigured' });
  await act(async () => arrow().click());
  await act(async () => options()[1].click());
  assert.deepEqual(view.published, []);
  assert.equal(document.querySelector('.publish-settings') === null, true);
  assert.deepEqual(JSON.parse(saved).hosting, workerHosting);
  await act(async () => finish({ ok: true, value: { source: saved } }));
  assert.deepEqual(view.published, ['hosting']);
});

for (const projects of [
  [],
  [{ name: 'website', hosting: { ...workerHosting, accountId: '' } }],
  [
    { name: 'first', hosting: workerHosting },
    { name: 'second', hosting: workerHosting },
  ],
]) {
  test(`Unresolved hosting (${JSON.stringify(projects)}) still needs settings`, async (context) => {
    const view = fixture(context);
    view.configure(undefined);
    window.avb.discoverPublishing = async ({ request }) => ({
      kind: 'ready',
      accounts: [],
      projects: request.provider === 'linked' ? projects : [],
    });
    await view.show({ github: 'pending', hosting: 'unconfigured' });
    await act(async () => arrow().click());
    await act(async () => options()[1].click());
    assert.deepEqual(view.published, []);
    assert.deepEqual(view.writes, []);
    assert.ok(document.querySelector('.publish-settings'));
  });
}

test('Failed automatic saves never start publishing', async (context) => {
  const view = fixture(context);
  view.configure(undefined);
  window.avb.discoverPublishing = async () => ({
    kind: 'ready',
    accounts: [],
    projects: [{ name: 'website', hosting: workerHosting }],
  });
  window.avb.writeProjectMetadata = async () => {
    throw new Error('Settings changed elsewhere');
  };
  await view.show({ github: 'pending', hosting: 'unconfigured' });
  await act(async () => arrow().click());
  await act(async () => options()[1].click());
  assert.deepEqual(view.published, []);
  assert.ok(document.querySelector('.publish-settings'));
});

test('Saved hosting takes precedence over stale status', async (context) => {
  const view = fixture(context, { ...DEFAULT_PUBLISH_CONFIG, hosting: workerHosting });
  await view.show({ github: 'current', hosting: 'unconfigured' });
  await act(async () => arrow().click());
  assert.match(options()[1].textContent, /Deployment status unavailable/);
  assert.equal(options()[1].querySelector('svg').dataset.provider, 'cloudflare-workers');
  assert.equal(main().disabled, false);
  await act(async () => options()[1].click());
  assert.deepEqual(view.published, ['hosting']);
});

test('An explicit GitHub-only choice does not rediscover hosting', async (context) => {
  const view = fixture(context);
  let discoveries = 0;
  window.avb.discoverPublishing = async () => {
    discoveries++;
    return { kind: 'ready', accounts: [], projects: [{ name: 'website', hosting: workerHosting }] };
  };
  await view.show({ github: 'current', hosting: 'unconfigured' });
  await act(async () => arrow().click());
  assert.match(options()[1].textContent, /Choose a hosting provider/);
  assert.equal(main().disabled, true);
  assert.equal(discoveries, 0);
});

test('Late hosting discovery cannot leak across project switches', async (context) => {
  const view = fixture(context);
  view.configure(undefined);
  let resolve;
  window.avb.discoverPublishing = () =>
    new Promise((done) => {
      resolve = done;
    });
  await view.show({ github: 'current', hosting: 'unconfigured' });
  await act(async () => arrow().click());
  assert.match(options()[1].textContent, /Deployment status unavailable/);
  view.configure(DEFAULT_PUBLISH_CONFIG);
  await view.show({ github: 'current', hosting: 'unconfigured' }, '/another-project');
  await act(async () =>
    resolve({
      kind: 'ready',
      accounts: [],
      projects: [{ name: 'website', hosting: workerHosting }],
    }),
  );
  assert.match(options()[1].textContent, /Choose a hosting provider/);
  assert.equal(options()[1].querySelector('[data-provider]') === null, true);
  assert.equal(main().disabled, true);
});

test('Linked hosting preserves a confirmed live deployment', async (context) => {
  const view = fixture(context);
  view.configure(undefined);
  window.avb.discoverPublishing = async () => ({
    kind: 'ready',
    accounts: [],
    projects: [{ name: 'website', hosting: workerHosting }],
  });
  await view.show({ github: 'current', hosting: 'current' });
  assert.equal(main().disabled, true);
  await act(async () => arrow().click());
  assert.match(options()[1].textContent, /Up to date/);
});

test('discovered URLs persist and survive closing the menu while offline', async (context) => {
  const view = fixture(context, { ...DEFAULT_PUBLISH_CONFIG, hosting: workerHosting });
  await view.show({ github: 'current', hosting: 'pending' });
  await act(async () => arrow().click());
  assert.deepEqual(view.writes.at(-1).publishedSite, {
    hosting: workerHosting,
    source: 'discovered',
    url: 'https://example.com',
  });
  await act(async () => arrow().click());
  window.avb.publishedSiteURL = async () => {
    throw new Error('Offline');
  };
  await act(async () => arrow().click());
  assert.equal(document.querySelector('[aria-label="Open published site"]').href, 'https://example.com/');
  assert.equal(view.writes.length, 1);
});

test('manual URLs override discovery', async (context) => {
  const view = fixture(context, {
    ...DEFAULT_PUBLISH_CONFIG,
    hosting: workerHosting,
    publishedSite: { hosting: workerHosting, source: 'manual', url: 'https://custom.example.com' },
  });
  let requests = 0;
  window.avb.publishedSiteURL = async () => {
    requests++;
    return 'https://wrong.example.com';
  };
  await view.show({ github: 'current', hosting: 'pending' });
  await act(async () => arrow().click());
  assert.equal(document.querySelector('[aria-label="Open published site"]').href, 'https://custom.example.com/');
  assert.equal(requests, 0);
  assert.deepEqual(view.writes, []);
});

test('a saved URL from another destination stays hidden', async (context) => {
  const view = fixture(context, {
    ...DEFAULT_PUBLISH_CONFIG,
    hosting: { ...workerHosting, project: 'other' },
    publishedSite: { hosting: workerHosting, source: 'discovered', url: 'https://old.example.com' },
  });
  window.avb.publishedSiteURL = async () => undefined;
  await view.show({ github: 'current', hosting: 'pending' });
  await act(async () => arrow().click());
  assert.equal(document.querySelector('[aria-label="Open published site"]') === null, true);
  assert.deepEqual(view.writes, []);
});

test('late discovery cannot overwrite a changed destination', async (context) => {
  const view = fixture(context, { ...DEFAULT_PUBLISH_CONFIG, hosting: workerHosting });
  let resolve;
  window.avb.publishedSiteURL = () =>
    new Promise((done) => {
      resolve = done;
    });
  await view.show({ github: 'current', hosting: 'pending' });
  await act(async () => arrow().click());
  view.configure({ ...DEFAULT_PUBLISH_CONFIG, hosting: { ...workerHosting, project: 'other' } });
  await act(async () => resolve('https://old.example.com'));
  assert.deepEqual(view.writes, []);
  assert.equal(document.querySelector('[aria-label="Open published site"]') === null, true);
});
