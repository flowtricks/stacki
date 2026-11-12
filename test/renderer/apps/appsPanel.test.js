// Goal: the Apps panel is never blank. It always shows its heading, with a +
// menu of every way to add an app (Load App From GitHub, Build an app, which
// opens the AI chat on the build prompt without sending it; Build an app alone for a non-admin; no Upload app file); it shows skeleton rows while
// loading, an empty state that points at + when nothing is installed, and the
// error ("Restart Stacki to use Apps.") when the main process predates Apps.
// Installed apps list with their tiles; search ("Search installed apps")
// filters them; Open launches one; a role without an app's grant does not see
// it, and a non-admin gets no install actions. The rail opens the panel on E
// alone, and ⌘E stays the insert palette's. The Marketplace tab shows only to a
// role with `marketplace:view`, marks installed apps, and offers Install only
// with `marketplace:install`. When the index cannot be read (a 404, no network,
// a bad reply) the tab shows a calm "isn't available" state with Retry, the
// reason only in its small print; an index with no apps invites a submission
// through stacki.build's form. The tab opens with the community-apps
// disclaimer, and Install asks first. Each row's ⋯ menu holds Details, Share to
// GitHub… (an uploaded app that no repository holds yet, `apps:share`), Submit to marketplace
// (`marketplace:publish`: a GitHub app's opens the in-app Publish to
// marketplace popup at its own repository, an uploaded one's leads through
// Share first) and Remove app, which asks first as Uninstall app does. An app's details open in a popup from a row
// click or ⋯ → Details, show a meta line (version, author, repository), one-line
// facts and commands with the long text behind hints, never an "Unknown"
// author, ask before Uninstall app, and close on Escape. A waiting update
// reads "Update available · v…" on its row and puts a dot on the rail's Apps button; each app's Update automatically switch starts off
// and only an admin flips it. Update installs and says so; an app whose auto-update is on but whose
// new version asks for more reads "Update needs your OK" with what it adds; an uploaded or folder app
// never offers Update. Each row says where its app lives ("Local", "GitHub ·
// Private", "Marketplace"), as does its details' About with a link to GitHub, and
// a row draws no avatar when the app names no author. One app the editor cannot
// read (an auth provider naming a setting its manifest does not declare) is a
// broken row with its reason, and every other app still lists.
// Method: the real panel and rail mounted in JSDOM with a stubbed `window.avb`,
// driven by events, reading the DOM after each step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MouseEvent = dom.window.MouseEvent;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;
// The menu's popup times its motion with animation frames.
dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
// JSDOM has no modal dialogs; the popups only need showModal and close to toggle `open`.
dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function close() {
  this.open = false;
};
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

function bundle(entry, name) {
  const directory = repoPath('node_modules/.stacki-test/apps-panel');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, `${name}.cjs`);
  esbuild.buildSync({
    entryPoints: [repoPath(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return require(outfile);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
// The panel and the confirmation host from one bundle, so the panel's confirmDialog reaches this host.
const panelModule = bundle('test/helpers/appsPanelEntry.ts', 'panel');
const AppsPanel = panelModule.default;
const { ConfirmHost, registerAgentTaskHandler } = panelModule;
const LeftRail = bundle('src/app/LeftRail.tsx', 'rail').default;
const roles = bundle('shared/properties/projectRoles.ts', 'roles');

const summary = (id, name, description) => ({
  manifest: {
    manifestVersion: 1,
    id,
    name,
    version: '1.0.0',
    description,
    entry: 'index.html',
    capabilities: ['selection'],
    window: { mode: 'popup', widthPx: 300, heightPx: 300 },
    settings: [],
    secretsAllowlist: [],
  },
  lock: {
    id,
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00.000Z',
    source: { kind: 'file', fileName: `${id}.zip` },
  },
});

async function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(React.Fragment, {}, element, React.createElement(ConfirmHost))));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { container, root };
}

const panel = (role = roles.ADMIN_VIEW) => React.createElement(AppsPanel, { projectPath: '/p', role, notify: () => {} });

test('loading shows skeleton rows under the heading', async () => {
  window.avb = { listApps: () => new Promise(() => {}) };
  const { container, root } = await mount(panel());
  assert.equal(container.querySelector('h2').textContent, 'Apps');
  assert.equal(container.querySelectorAll('.apps-skeleton').length, 3);
  await act(async () => root.unmount());
});

test('an older main process shows the restart message, never a blank panel', async () => {
  window.avb = {
    listApps: async () => {
      throw new Error("Error invoking remote method 'apps:list': Error: No handler registered for 'apps:list'");
    },
  };
  const { container, root } = await mount(panel());
  assert.equal(container.querySelector('h2').textContent, 'Apps');
  assert.equal(container.querySelector('[role=alert]').textContent, 'Restart Stacki to use Apps.');
  await act(async () => root.unmount());
  window.avb = {};
  const missing = await mount(panel());
  assert.equal(missing.container.querySelector('[role=alert]').textContent, 'Restart Stacki to use Apps.');
  await act(async () => missing.root.unmount());
});

test('no apps: the empty state points at the + menu, with no button of its own', async () => {
  window.avb = { listApps: async () => ({ ok: true, value: [] }) };
  const { container, root } = await mount(panel());
  const empty = container.querySelector('.apps-empty');
  assert.ok(empty.querySelector('.apps-empty-icon'), 'the icon tile stays');
  assert.match(empty.textContent, /Add tools to Stacki with apps\./);
  assert.equal(empty.querySelector('.apps-note').textContent, 'Use + to add an app.');
  assert.equal(empty.querySelector('button') ?? undefined, undefined, 'adding an app is the header’s + alone');
  assert.equal(container.querySelector('.welcome-split-button') ?? undefined, undefined);
  await act(async () => root.unmount());
  const viewer = await mount(panel({ id: 'client', name: 'Client', isAdmin: false, features: new Set(['panel:apps']) }));
  assert.match(viewer.container.querySelector('.apps-empty .apps-note').textContent, /ask an admin/);
  assert.equal(viewer.container.querySelector('.apps-empty button') ?? undefined, undefined);
  await act(async () => viewer.root.unmount());
});

test('the header + lists every way to add an app, installed or not; a non-admin gets the prompt alone', async () => {
  const headerMenu = async (container) => {
    const plus = container.querySelector('.apps-header [aria-label="Add an app"]');
    assert.ok(plus, 'the header has a + button');
    await act(async () => plus.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // The menu portals to <body>, past whatever clips the panel.
    const labels = [...document.querySelectorAll('[role=menuitem]')].map((item) => item.textContent);
    await act(async () => plus.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    return labels;
  };
  // Submitting to the marketplace is in each app's own menu, not here.
  const every = ['Build an app', 'Load App From GitHub'];
  window.avb = { listApps: async () => ({ ok: true, value: [] }) };
  const empty = await mount(panel());
  assert.deepEqual(await headerMenu(empty.container), every);
  await act(async () => empty.root.unmount());
  window.avb = { listApps: async () => ({ ok: true, value: [summary('heat-map', 'Heat map', 'Clicks on the canvas')] }) };
  const installed = await mount(panel());
  assert.deepEqual(await headerMenu(installed.container), every);
  assert.equal(installed.container.querySelector('.welcome-split-button') ?? undefined, undefined, 'the body has no split button');
  await act(async () => installed.root.unmount());
  const viewer = await mount(panel({ id: 'client', name: 'Client', isAdmin: false, features: new Set(['panel:apps']) }));
  assert.deepEqual(await headerMenu(viewer.container), ['Build an app']);
  await act(async () => viewer.root.unmount());
  const publisher = await mount(
    panel({ id: 'publisher', name: 'Publisher', isAdmin: false, features: new Set(['panel:apps', 'marketplace:view', 'marketplace:publish']) }),
  );
  assert.deepEqual(
    await headerMenu(publisher.container),
    ['Build an app'],
    "a publisher without install rights gets Build an app alone; Submit is in each app's own menu",
  );
  await act(async () => publisher.root.unmount());
});

test('Build an app hands the prompt to the AI chat as an unsent draft, and copies it with a notice when no chat takes it', async () => {
  window.avb = { listApps: async () => ({ ok: true, value: [] }) };
  const notices = [];
  const choose = async (container, label) => {
    const plus = container.querySelector('.apps-header [aria-label="Add an app"]');
    await act(async () => plus.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const item = [...document.querySelectorAll('[role=menuitem]')].find((entry) => entry.textContent === label);
    assert.ok(item, label);
    await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // A menu runs its item after its closing motion.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  };
  const host = await mount(
    React.createElement(AppsPanel, { projectPath: '/p', role: roles.ADMIN_VIEW, notify: (message, kind) => notices.push({ message, kind }) }),
  );
  // A chat takes it: the task is a draft, and the panel adds no notice to what the chat already shows.
  const tasks = [];
  const unregister = registerAgentTaskHandler('ai-panel', 20, async (task) => {
    tasks.push(task);
    return { tag: 'sent', where: 'Claude in the AI panel' };
  });
  await choose(host.container, 'Build an app');
  unregister();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].delivery, 'draft', 'the person sends it, Stacki never does');
  assert.match(tasks[0].prompt, /stacki-app\.json/, 'the build prompt');
  assert.deepEqual(notices, []);
  // Nothing takes it: it lands on the clipboard and the notice says so.
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (text) => copied.push(text) }, configurable: true });
  await choose(host.container, 'Build an app');
  assert.equal(copied.length, 1);
  assert.equal(copied[0], tasks[0].prompt);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'success', 'the copy worked; the message says why it was a copy');
  assert.match(notices[0].message, /AI chat isn’t available here/);
  await act(async () => host.root.unmount());
});

test('each row’s ⋯ menu: Details, Share to GitHub…, Submit to marketplace and Remove app, as the role and source allow', async () => {
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const github = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0' };
  const fromGitHub = summary('heat-map', 'Heat map', 'Clicks on the canvas');
  const apps = [
    { ...fromGitHub, lock: { ...fromGitHub.lock, source: github, autoUpdate: false } },
    summary('translate', 'Translate', 'Copy in more languages'),
    (() => {
      const listed = summary('alt-text', 'Alt text check', 'Images without alt text');
      return { ...listed, lock: { ...listed.lock, source: { kind: 'marketplace', id: 'alt-text', version: '1.0.0' }, autoUpdate: false } };
    })(),
    (() => {
      const added = summary('pins', 'Feedback pins', 'Pin comments to elements');
      return { ...added, lock: { ...added.lock, source: { kind: 'local' }, autoUpdate: false } };
    })(),
  ];
  const statuses = [];
  window.avb = {
    listApps: async () => ({ ok: true, value: apps }),
    discoverPublishing: async () => ({ kind: 'ready', accounts: [{ id: 'octocat', name: 'octocat' }], projects: [] }),
    listAppRepositories: () => new Promise(() => {}),
    appRepositoryStatus: (input) => {
      statuses.push(input.repository);
      return new Promise(() => {});
    },
  };
  const menuOf = async (container, name) => {
    const more = container.querySelector(`.apps-row [aria-label="${name} options"]`);
    await click(more);
    const items = [...document.querySelectorAll('[role=menuitem]')];
    return { labels: items.map((item) => item.textContent), items, close: () => click(more) };
  };
  const renderSignIn = () => React.createElement('div', {}, 'sign in');
  const { container, root } = await mount(React.createElement(AppsPanel, { projectPath: '/p', role: roles.ADMIN_VIEW, notify: () => {}, renderSignIn }));
  const githubMenu = await menuOf(container, 'Heat map');
  assert.deepEqual(githubMenu.labels, ['Details', 'Submit to marketplace', 'Remove app'], 'a GitHub app is not shared again');
  await click(githubMenu.items[1]);
  await settle();
  const popup = document.querySelector('[aria-label="Publish to marketplace"]');
  assert.ok(popup, 'Submit to marketplace opens the in-app popup');
  assert.deepEqual(statuses, [{ owner: 'octocat', repository: 'heat-map', account: 'octocat' }], 'it starts at the app’s own repository');
  await act(async () => root.unmount());

  const second = await mount(React.createElement(AppsPanel, { projectPath: '/p', role: roles.ADMIN_VIEW, notify: () => {}, renderSignIn }));
  const uploadedMenu = await menuOf(second.container, 'Translate');
  assert.deepEqual(uploadedMenu.labels, ['Details', 'Share to GitHub…', 'Submit to marketplace', 'Remove app']);
  // The marketplace lists GitHub repositories: until the app is shared, Submit is greyed.
  assert.equal(uploadedMenu.items[2].disabled, true, 'an uploaded app shares to GitHub before it can be submitted');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  // An app added to the project folder has no release yet either: it shares first, and Submit stays greyed until then.
  const localMenu = await menuOf(second.container, 'Feedback pins');
  assert.deepEqual(localMenu.labels, ['Details', 'Share to GitHub…', 'Submit to marketplace', 'Remove app']);
  assert.equal(localMenu.items[2].disabled, true, 'a folder app shares to GitHub before it can be submitted');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  const listedMenu = await menuOf(second.container, 'Alt text check');
  assert.deepEqual(listedMenu.labels, ['Details', 'Remove app'], 'a marketplace app is already listed');
  await listedMenu.close();
  await act(async () => second.root.unmount());

  const sharer = { id: 'helper', name: 'Helper', isAdmin: false, features: new Set(['panel:apps', 'apps:share', 'app:*']) };
  const helper = await mount(panel(sharer));
  const helperMenu = await menuOf(helper.container, 'Translate');
  assert.deepEqual(helperMenu.labels, ['Details', 'Share to GitHub…'], 'apps:share without marketplace:publish or admin');
  await helperMenu.close();
  await act(async () => helper.root.unmount());

  const publisher = { id: 'publisher', name: 'Publisher', isAdmin: false, features: new Set(['panel:apps', 'marketplace:publish', 'app:*']) };
  const lone = await mount(panel(publisher));
  const loneMenu = await menuOf(lone.container, 'Translate');
  assert.deepEqual(loneMenu.labels, ['Details'], 'without apps:share an uploaded app has no way to the marketplace, so Submit hides');
  await loneMenu.close();
  await act(async () => lone.root.unmount());

  const client = roles.roleViewOf(roles.DEFAULT_PROJECT_ROLES, 'client');
  const viewer = await mount(panel({ ...client, features: new Set([...client.features, 'panel:apps', 'app:*']) }));
  const viewerMenu = await menuOf(viewer.container, 'Translate');
  assert.deepEqual(viewerMenu.labels, ['Details'], 'Client can neither share nor submit');
  await viewerMenu.close();
  await act(async () => viewer.root.unmount());
});

test('a folder app the marketplace lists has no Share to GitHub and no Submit at all; its details say it is listed', async () => {
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const local = (id, name, manifestSource) => {
    const added = summary(id, name, 'Pin comments to elements');
    return {
      manifest: { ...added.manifest, source: manifestSource },
      lock: { ...added.lock, source: { kind: 'local' }, autoUpdate: false },
    };
  };
  const apps = [
    local('feedback-pins', 'Feedback pins', undefined),
    local('notes', 'Notes', { kind: 'github', owner: 'octocat', repository: 'notes', asset: 'notes.zip' }),
    local('scratch', 'Scratch', undefined),
  ];
  const index = {
    version: 1,
    apps: [
      {
        id: 'feedback-pins',
        name: 'Feedback pins',
        description: 'Pin comments to elements',
        author: 'flowtricks',
        icon: 'https://stacki.build/api/marketplace/icons/feedback-pins.png',
        categories: [],
        source: { owner: 'flowtricks', repository: 'feedback-pins', asset: 'feedback-pins.zip' },
        versions: [{ version: '1.8.1', tag: 'v1.8.1', sha256: 'b'.repeat(64) }],
      },
    ],
  };
  const statuses = [];
  window.avb = {
    listApps: async () => ({ ok: true, value: apps }),
    appMarketplace: async () => ({ ok: true, value: index }),
    discoverPublishing: async () => ({ kind: 'ready', accounts: [{ id: 'octocat', name: 'octocat' }], projects: [] }),
    listAppRepositories: () => new Promise(() => {}),
    appRepositoryStatus: (input) => {
      statuses.push({ owner: input.repository.owner, repository: input.repository.repository });
      return new Promise(() => {});
    },
  };
  const menuOf = async (container, name) => {
    const more = container.querySelector(`.apps-row [aria-label="${name} options"]`);
    await click(more);
    const items = [...document.querySelectorAll('[role=menuitem]')];
    return { labels: items.map((item) => item.textContent), items, close: () => click(more) };
  };
  const renderSignIn = () => React.createElement('div', {}, 'sign in');
  const { container, root } = await mount(
    React.createElement(AppsPanel, { projectPath: '/shared-check', role: roles.ADMIN_VIEW, notify: () => {}, renderSignIn }),
  );
  await settle();
  const scratch = await menuOf(container, 'Scratch');
  assert.deepEqual(scratch.labels, ['Details', 'Share to GitHub…', 'Submit to marketplace', 'Remove app'], 'an app on no repository is shared first');
  assert.equal(scratch.items[2].disabled, true);
  await scratch.close();
  await settle();
  const notes = await menuOf(container, 'Notes');
  assert.deepEqual(
    notes.labels,
    ['Details', 'Submit to marketplace', 'Remove app'],
    'a manifest that names its repository is shared already; not listed yet, so a first submission',
  );
  // The first listing still needs a submission: it opens the checklist on the repository the manifest names.
  assert.equal(notes.items[1].disabled, false);
  await click(notes.items[1]);
  await settle();
  assert.ok(document.querySelector('[aria-label="Publish to marketplace"]'), 'the publish checklist opens');
  assert.deepEqual(statuses, [{ owner: 'octocat', repository: 'notes' }], 'on the repository the manifest names');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  const pins = await menuOf(container, 'Feedback pins');
  assert.deepEqual(
    pins.labels,
    ['Details', 'Remove app'],
    'a listed app has nothing to submit (the marketplace follows its releases) and is never shared again',
  );
  await pins.close();
  await act(async () => root.unmount());

  // A publisher who may not share has no Submit for a listed app either.
  const publisher = {
    id: 'publisher',
    name: 'Publisher',
    isAdmin: false,
    features: new Set(['panel:apps', 'marketplace:view', 'marketplace:publish', 'app:*']),
  };
  const lone = await mount(React.createElement(AppsPanel, { projectPath: '/shared-check', role: publisher, notify: () => {}, renderSignIn }));
  await settle();
  const loneMenu = await menuOf(lone.container, 'Feedback pins');
  assert.deepEqual(loneMenu.labels, ['Details']);
  // Its details name the listed repository, as a GitHub app's do, and say it is listed with its latest version.
  await click(loneMenu.items[0]);
  await settle();
  const surface = document.querySelector('[aria-label="Feedback pins details"] .popup-surface');
  assert.ok(surface, 'the details open');
  assert.equal(surface.querySelector('a.apps-details-repository').getAttribute('href'), 'https://github.com/flowtricks/feedback-pins');
  const listedRow = [...surface.querySelectorAll('.apps-details-item')].find((row) => /Listed in the marketplace/.test(row.textContent));
  assert.ok(listedRow, 'a quiet Listed in the marketplace row');
  assert.match(listedRow.textContent, /v1\.8\.1/, 'with the listed latest version');
  assert.equal(listedRow.querySelector('a').getAttribute('href'), 'https://github.com/flowtricks/feedback-pins', 'and a link to the repository');
  assert.doesNotMatch(surface.textContent, /Submit/, 'no submit anywhere in the details');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  await act(async () => lone.root.unmount());
});

test('an app’s details open in a popup from ⋯ → Details only, show each section, ask before Uninstall, and close on Escape', async () => {
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const github = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0' };
  const base = summary('heat-map', 'Heat map', 'Clicks on the canvas');
  const app = {
    manifest: {
      ...base.manifest,
      settings: [{ id: 'api-key', label: 'API key', kind: 'secret', required: true }],
      commands: [{ id: 'toggle', title: 'Toggle heat map', shortcut: undefined, panel: undefined }],
    },
    lock: { ...base.lock, source: github, autoUpdate: false, update: { version: '1.1.0', tag: 'v1.1.0', sha256: 'e'.repeat(64), additions: [] } },
  };
  const removed = [];
  window.avb = {
    listApps: async () => ({ ok: true, value: [app] }),
    readAppSettings: async () => ({ ok: true, value: {} }),
    uninstallApp: async (input) => {
      removed.push(input.id);
      return { ok: true, value: [] };
    },
  };
  panelModule.configureAppCommands('/p', [app], () => roles.ADMIN_VIEW);
  const { container, root } = await mount(panel());
  const dialog = () => document.querySelector('[aria-label="Heat map details"]');
  assert.equal(dialog() ?? undefined, undefined, 'closed until asked');
  await click(container.querySelector('.apps-row-select'));
  assert.equal(dialog() ?? undefined, undefined, 'a row click opens the app, not the popup');
  const openMore = container.querySelector('.apps-row [aria-label="Heat map options"]');
  await click(openMore);
  await click([...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details'));
  await settle();
  assert.ok(dialog(), '⋯ → Details opens the popup');
  assert.equal(container.querySelector('.apps-row .apps-details') ?? undefined, undefined, 'nothing expands in the list');
  const surface = dialog().querySelector('.popup-surface');
  // Other features add sections through the slots (AppDetails.tsx); these are this popup's own headings, in order.
  // About has no heading, only a name, and Uninstall is a quiet row at the foot.
  const own = ['App settings', 'Commands', 'Updates'];
  const headings = [...surface.querySelectorAll('.apps-details-section h4')].map((heading) => heading.textContent);
  assert.deepEqual(
    headings.filter((heading) => own.includes(heading)),
    own,
    headings.join(', '),
  );
  assert.ok(surface.querySelector('section[aria-label="About"]'), 'About is a named section without a heading');
  assert.equal(surface.querySelector('.apps-details-name').textContent, 'Heat map');
  assert.equal(surface.querySelector('.apps-details-version').textContent, 'v1.0.0');
  assert.equal(surface.querySelector('.apps-details-version').getAttribute('title'), 'Version 1.0.0');
  assert.ok(surface.querySelector('.apps-details-header .apps-open.primary'), 'the header has Open');
  assert.ok(surface.querySelector('.apps-details-header [aria-label="Heat map options"]'), 'the header has its ⋯ menu');
  assert.equal(surface.querySelector('.modal-footer') ?? undefined, undefined, 'no footer');
  // The facts are one-line rows: label left, value right; the long explanation is a hint.
  const facts = [...surface.querySelectorAll('section[aria-label="About"] .apps-details-item')];
  assert.deepEqual(
    facts.map((fact) => fact.querySelector('.apps-details-item-text').textContent),
    ['Installed from', 'Stored in', 'Network'],
  );
  assert.equal(facts[0].querySelector('.apps-details-item-value').textContent, 'GitHub · v1.0.0');
  assert.equal(facts[2].querySelector('.apps-details-item-value').textContent, 'Works offline');
  assert.ok(facts[1].querySelector('button[aria-label="About Stored in"]'), 'Stored in explains itself behind a hint');
  // A command is one line: its title, and the shortcut recorder on the right; no subline.
  const commandRow = [...surface.querySelectorAll('.apps-details-item')].find((row) => row.textContent.includes('Toggle heat map'));
  const recorder = commandRow.querySelector('.apps-details-item-value [aria-label="Shortcut for Toggle heat map"]');
  assert.ok(recorder, 'the shortcut recorder is the row’s value');
  assert.equal(recorder.textContent, 'None');
  assert.equal(commandRow.querySelector('.apps-details-item-text').getAttribute('title'), 'Toggle heat map', 'a cut-short title shows whole on hover');
  assert.ok(surface.querySelector('.apps-details-row-control input[type=password]'), 'the secret setting is a row control');
  assert.ok(surface.querySelector('.apps-details-item-value [role=switch]'), 'auto-update is a row control');
  assert.match(surface.textContent, /Update available · v1\.1\.0/);
  assert.ok(
    [...surface.querySelectorAll('section[aria-label="Danger zone"] button')].some((button) => button.textContent === 'Uninstall app'),
    'the foot offers Uninstall app',
  );
  // A GitHub app's author is its repository's owner, shown with the picture (an initial here) in the header's meta line.
  assert.equal(surface.querySelector('.apps-details-meta .apps-details-author').textContent, 'Ooctocat');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  assert.equal(dialog() ?? undefined, undefined, 'Escape closes it');

  const more = container.querySelector('.apps-row [aria-label="Heat map options"]');
  await click(more);
  const details = [...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details');
  await click(details);
  await settle();
  assert.ok(dialog(), '⋯ → Details opens it again');
  // Uninstall app asks first; Cancel keeps the app, Uninstall removes it and closes the popup.
  const uninstall = () => [...dialog().querySelectorAll('button')].find((button) => button.textContent === 'Uninstall app');
  const confirmButton = (label) => [...document.querySelectorAll('.confirm-dialog button')].find((button) => button.textContent === label);
  await click(uninstall());
  await settle();
  assert.match(document.querySelector('.confirm-dialog').textContent, /Uninstall Heat map\?/);
  assert.equal(document.activeElement, confirmButton('Cancel'), 'Cancel has focus, so Return cannot remove the app');
  await click(confirmButton('Cancel'));
  await settle();
  assert.deepEqual(removed, [], 'cancelled, nothing removed');
  assert.ok(dialog(), 'the details stay open');
  await click(uninstall());
  await settle();
  await click(confirmButton('Uninstall'));
  // Two exit motions: the confirmation's, then the details popup's, before the app is removed.
  await settle();
  await settle();
  assert.deepEqual(removed, ['heat-map']);
  assert.equal(dialog() ?? undefined, undefined, 'the popup closes with its app');
  await act(async () => root.unmount());
  panelModule.configureAppCommands('/p', [], () => roles.ADMIN_VIEW);
});

test('Remove app asks first, from the row’s ⋯ menu and the details header’s alike', async () => {
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const removed = [];
  window.avb = {
    listApps: async () => ({ ok: true, value: [summary('heat-map', 'Heat map', 'Clicks on the canvas')] }),
    uninstallApp: async (input) => {
      removed.push(input.id);
      return { ok: true, value: [] };
    },
  };
  const { container, root } = await mount(panel());
  const pick = async (label) => click([...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === label));
  const confirmButton = (label) => [...document.querySelectorAll('.confirm-dialog button')].find((button) => button.textContent === label);
  const details = () => document.querySelector('[aria-label="Heat map details"]');

  // The row's menu: the same question as Uninstall app, Cancel focused; Cancel keeps the app.
  await click(container.querySelector('.apps-row [aria-label="Heat map options"]'));
  await pick('Remove app');
  await settle();
  assert.match(document.querySelector('.confirm-dialog').textContent, /Uninstall Heat map\?/);
  assert.match(document.querySelector('.confirm-dialog').textContent, /Removes the app and its files from this project for everyone\./);
  assert.equal(document.activeElement, confirmButton('Cancel'), 'Cancel has focus');
  await click(confirmButton('Cancel'));
  await settle();
  assert.deepEqual(removed, [], 'cancelled, nothing removed');

  // The details header's menu: confirmed, the app goes and the popup closes with it.
  await click(container.querySelector('.apps-row [aria-label="Heat map options"]'));
  await pick('Details');
  await settle();
  await click(details().querySelector('.apps-details-header [aria-label="Heat map options"]'));
  await pick('Remove app');
  await settle();
  await click(confirmButton('Uninstall'));
  // Two exit motions: the confirmation's, then the details popup's.
  await settle();
  await settle();
  assert.deepEqual(removed, ['heat-map']);
  assert.equal(details() ?? undefined, undefined, 'the popup closes with its app');
  await act(async () => root.unmount());
});

test('an app with no author shows none, never "Unknown"; a non-admin sees no Uninstall', async () => {
  // An uploaded app that names no author: nothing to show, so no row at all.
  window.avb = { listApps: async () => ({ ok: true, value: [summary('heat-map', 'Heat map', 'Clicks on the canvas')] }) };
  const viewer = await mount(panel({ id: 'editor', name: 'Editor', isAdmin: false, features: new Set(['panel:apps', 'app:*']) }));
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await click(viewer.container.querySelector('.apps-row [aria-label="Heat map options"]'));
  await click([...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const surface = document.querySelector('[aria-label="Heat map details"] .popup-surface');
  assert.doesNotMatch(surface.textContent, /Unknown/);
  const labels = [...surface.querySelectorAll('.apps-details-item-text')].map((label) => label.textContent);
  assert.ok(labels.includes('Installed from'), labels.join(', '));
  assert.equal(surface.querySelector('.apps-details-meta .apps-details-author') ?? undefined, undefined, 'no author in the meta line');
  assert.equal(surface.querySelector('.apps-details-meta .apps-details-repository') ?? undefined, undefined, 'no repository to link');
  const installed = [...surface.querySelectorAll('.apps-details-item')].find((row) => row.textContent.startsWith('Installed from'));
  assert.equal(installed.querySelector('.apps-details-item-value').textContent, 'Uploaded file');
  assert.equal(installed.querySelector('.apps-details-item-value [title]').getAttribute('title'), 'Uploaded file · heat-map.zip', 'the file name on hover');
  // The long explanation is in the document, as the hint's description, not on show.
  assert.match(surface.textContent, /Uploaded as heat-map\.zip; only in this project's \.stacki\/apps folder\./);
  assert.ok(surface.querySelector('section[aria-label="About"]'));
  const headings = [...surface.querySelectorAll('.apps-details-section h4')].map((heading) => heading.textContent);
  assert.equal(headings.includes('Updates'), false, 'an uploaded app has nowhere to update from');
  assert.equal(headings.includes('External services'), false, 'an offline app lists no services; its Network fact says so');
  assert.equal(surface.querySelector('section[aria-label="Danger zone"]') ?? undefined, undefined, 'only an admin uninstalls');
  await act(async () => viewer.root.unmount());
});

test('installed apps list, filter, launch, and follow the role', async () => {
  window.avb = {
    listApps: async () => ({
      ok: true,
      value: [summary('heat-map', 'Heat map', 'Clicks on the canvas'), summary('translate', 'Translate', 'Copy in more languages')],
    }),
  };
  const { container, root } = await mount(panel());
  const names = () => [...container.querySelectorAll('.apps-row-title')].map((name) => name.textContent);
  assert.deepEqual(names(), ['Heat map', 'Translate']);
  assert.equal(container.querySelectorAll('.apps-tile.lettered').length, 2, 'apps without an icon get a lettered tile');
  const search = container.querySelector('input[type=search]');
  assert.equal(search.getAttribute('placeholder'), 'Search installed apps');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(search, 'languages');
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(names(), ['Translate']);
  await act(async () => container.querySelector('.apps-open').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  // A floating app opens over the canvas, so the list stays in the panel.
  assert.deepEqual(names(), ['Translate']);
  await act(async () => root.unmount());

  const limited = { id: 'editor', name: 'Editor', isAdmin: false, features: new Set(['panel:apps', 'app:heat-map']) };
  const second = await mount(panel(limited));
  assert.deepEqual(
    [...second.container.querySelectorAll('.apps-row-title')].map((name) => name.textContent),
    ['Heat map'],
  );
  await act(async () => second.root.unmount());
});

test('one app the editor cannot read is a broken row; the other apps list as usual', async () => {
  const bad = summary('hubspot', 'HubSpot', 'Forms on the canvas');
  const unreadable = {
    ...bad,
    // A custom provider whose client id names a setting the manifest does not declare: the reported HubSpot error.
    manifest: {
      ...bad.manifest,
      auth: [{ id: 'hubspot', label: 'HubSpot', authorizeURL: 'https://a.example/auth', tokenURL: 'https://a.example/token', pkce: true, scopes: [] }],
    },
  };
  window.avb = {
    listApps: async () => ({
      ok: true,
      value: [summary('heat-map', 'Heat map', 'Clicks on the canvas'), unreadable, summary('translate', 'Translate', 'Copy in more languages')],
    }),
    appFolders: async () => ({ ok: true, value: [] }),
  };
  const { container, root } = await mount(panel());
  assert.equal(container.querySelector('[role=alert]') ?? undefined, undefined, 'the list never fails as a whole');
  const good = [...container.querySelectorAll('.apps-row:not(.apps-row-broken) .apps-row-title')].map((name) => name.textContent);
  assert.deepEqual(good, ['Heat map', 'Translate']);
  const broken = [...container.querySelectorAll('.apps-row-broken')];
  assert.equal(broken.length, 1);
  assert.equal(broken[0].querySelector('.apps-row-title').textContent, 'hubspot');
  assert.match(broken[0].querySelector('.apps-row-description').textContent, /Auth provider hubspot: clientIdSetting names a text or secret setting/);
  await act(async () => root.unmount());

  // The host already lists the folder as broken: one row, the host's, never two.
  window.avb = {
    ...window.avb,
    appFolders: async () => ({ ok: true, value: [{ folder: 'hubspot', message: 'stacki-app.json is not JSON' }] }),
  };
  const again = await mount(panel());
  const rows = [...again.container.querySelectorAll('.apps-row-broken .apps-row-description')].map((row) => row.textContent);
  assert.deepEqual(rows, ['stacki-app.json is not JSON']);
  assert.equal(again.container.querySelectorAll('.apps-row:not(.apps-row-broken)').length, 2);
  await act(async () => again.root.unmount());
});

test('the rail shows Apps and opens it on E, never on ⌘E', async () => {
  const selected = [];
  const { container, root } = await mount(React.createElement(LeftRail, { onSelect: (tab) => selected.push(tab) }));
  assert.ok(container.querySelector('[aria-label="Apps (E)"]'));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true, bubbles: true })));
  assert.deepEqual(selected, ['apps']);
  await act(async () => root.unmount());
});

const marketplaceIndex = {
  version: 1,
  apps: [
    {
      id: 'heat-map',
      name: 'Heat map',
      description: 'Clicks on the canvas',
      author: 'octocat',
      icon: 'https://stacki.build/api/marketplace/icons/heat-map.png',
      categories: ['analytics'],
      source: { owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' },
      versions: [{ version: '1.0.0', tag: 'v1.0.0', sha256: 'b'.repeat(64) }],
    },
    {
      id: 'alt-text',
      name: 'Alt text check',
      description: 'Images without alt text',
      author: 'hubot',
      icon: 'https://stacki.build/api/marketplace/icons/alt-text.svg',
      categories: [],
      source: { owner: 'hubot', repository: 'alt-text', asset: 'alt-text.zip' },
      versions: [
        { version: '0.2.0', tag: 'v0.2.0', sha256: 'c'.repeat(64) },
        { version: '0.3.0', tag: 'v0.3.0', sha256: 'd'.repeat(64) },
      ],
    },
  ],
};

test('the Marketplace tab lists approved apps, marks installed ones, and installs only with marketplace:install', async () => {
  const installs = [];
  window.avb = {
    listApps: async () => ({ ok: true, value: [summary('heat-map', 'Heat map', 'Clicks on the canvas')] }),
    appMarketplace: async () => ({ ok: true, value: marketplaceIndex }),
    installMarketplaceApp: async (input) => {
      installs.push(input);
      return { ok: true, value: summary('alt-text', 'Alt text check', 'Images without alt text') };
    },
  };
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const admin = await mount(panel());
  const tab = [...admin.container.querySelectorAll('[role=tab]')].find((element) => element.textContent === 'Marketplace');
  assert.ok(tab, 'an admin has the Marketplace tab');
  await click(tab);
  await settle();
  const rows = [...admin.container.querySelectorAll('.apps-market-row')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('.apps-row-title').textContent),
    ['Heat map', 'Alt text check'],
  );
  assert.equal(rows[0].querySelector('.apps-badge').textContent, 'Installed');
  assert.equal(rows[0].querySelector('button.apps-button') ?? undefined, undefined, 'an installed app offers no Install');
  assert.match(rows[1].textContent, /by hubot/);
  assert.equal(rows[1].querySelector('.apps-market-description') ?? undefined, undefined, 'the description stays folded until the ⋯ opens it');
  const detailsButton = rows[1].querySelector('button[aria-label="Alt text check details"]');
  assert.ok(detailsButton, 'a row has a ⋯ details button');
  await click(detailsButton);
  await settle();
  const popup = document.querySelector('.apps-details-popup');
  assert.ok(popup, 'the ⋯ opens the details popup');
  assert.match(popup.textContent, /Alt text check/);
  assert.match(popup.textContent, /Images without alt text/, 'the description is in the popup');
  assert.equal(popup.querySelector('a.apps-details-link').getAttribute('href'), 'https://github.com/hubot/alt-text', 'the repository link');
  assert.ok(popup.querySelector('button.apps-button'), 'the popup offers Install to a role that may install');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  // The popup leaves with a motion, so it is gone only after that has run. The boolean keeps a failure readable:
  // a DOM node in a failed deepEqual message is inspected whole and can exhaust memory.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal(document.querySelector('.apps-details-popup') === null, true, 'Escape closes it');
  assert.match(admin.container.querySelector('.apps-market-disclaimer').textContent, /Community apps, MIT licensed\. Stacki doesn’t review them/);
  await click(rows[1].querySelector('button.apps-button'));
  const confirmation = document.querySelector('.confirm-dialog');
  assert.ok(confirmation, 'Install asks first');
  assert.match(confirmation.textContent, /Stacki doesn’t review them; install apps you trust/);
  assert.deepEqual(installs, [], 'nothing installs before the confirmation');
  await click([...confirmation.querySelectorAll('button')].find((button) => button.textContent === 'Install'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.deepEqual(installs, [{ projectPath: '/p', id: 'alt-text', version: '0.3.0' }]);
  await act(async () => admin.root.unmount());

  const viewOnly = { id: 'editor', name: 'Editor', isAdmin: false, features: new Set(['panel:apps', 'marketplace:view']) };
  const browsing = await mount(panel(viewOnly));
  await click([...browsing.container.querySelectorAll('[role=tab]')].find((element) => element.textContent === 'Marketplace'));
  await settle();
  assert.equal(browsing.container.querySelectorAll('.apps-market-row').length, 2);
  assert.equal(browsing.container.querySelector('.apps-market-row button.apps-button') ?? undefined, undefined, 'seeing is not installing');
  await act(async () => browsing.root.unmount());

  const client = roles.roleViewOf(roles.DEFAULT_PROJECT_ROLES, 'client');
  const hidden = await mount(panel({ ...client, features: new Set([...client.features, 'panel:apps']) }));
  assert.equal(hidden.container.querySelector('[role=tab]') ?? undefined, undefined, 'Client has no Marketplace tab');
  await act(async () => hidden.root.unmount());
});

test('an unreadable marketplace is a calm state with Retry; an empty one invites a submission', async () => {
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const openMarketplace = async (container) => {
    await click([...container.querySelectorAll('[role=tab]')].find((element) => element.textContent === 'Marketplace'));
    await settle();
  };
  const replies = [
    { ok: false, message: 'The marketplace index answered HTTP 404.' },
    { ok: false, message: 'fetch failed' },
    // A reply that is not a valid index is refused by the renderer's own parser.
    { ok: true, value: { version: 2, apps: [] } },
  ];
  // Each read of the panel here is a project of its own: the list the panel kept for '/p' from earlier tests would
  // start the places lookup, which reads the index too, and take the failing first answer meant for the tab.
  let projects = 0;
  const freshPanel = () => {
    projects += 1;
    return React.createElement(AppsPanel, { projectPath: `/unreadable-${projects}`, role: roles.ADMIN_VIEW, notify: () => {} });
  };
  for (const reply of replies) {
    const asked = [];
    window.avb = {
      listApps: async () => ({ ok: true, value: [] }),
      appMarketplace: async (input) => {
        asked.push(input);
        return asked.length === 1 ? reply : { ok: true, value: marketplaceIndex };
      },
    };
    const { container, root } = await mount(freshPanel());
    await openMarketplace(container);
    const state = container.querySelector('[aria-label="Marketplace unavailable"]');
    assert.ok(state, `an unavailable state for ${JSON.stringify(reply)}`);
    assert.equal(state.getAttribute('role'), 'status', 'calm, not an alert');
    assert.equal(container.querySelector('[role=alert]') ?? undefined, undefined);
    assert.equal(state.querySelector('.apps-market-state-title').textContent, 'Marketplace isn’t available right now');
    assert.doesNotMatch(state.querySelector('.apps-market-state-title').textContent, /404|answered/);
    assert.doesNotMatch(state.querySelector('.apps-market-state-text').textContent, /404|answered|fetch/);
    const detail = state.querySelector('.apps-market-state-detail').textContent;
    assert.ok(detail.length > 0, 'the reason stays in the small print');
    if (!reply.ok) {
      assert.equal(detail, reply.message);
    }
    const retry = [...state.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    assert.ok(retry, 'a Retry button');
    await click(retry);
    await settle();
    assert.equal(asked.length, 2, 'Retry reads the index again');
    assert.equal(asked[1].refresh, true, 'and skips the cached copy');
    assert.equal(container.querySelectorAll('.apps-market-row').length, 2, 'a good second read lists the apps');
    await act(async () => root.unmount());
  }

  window.avb = {
    listApps: async () => ({ ok: true, value: [] }),
    appMarketplace: async () => ({ ok: true, value: { version: 1, apps: [] } }),
  };
  const { container, root } = await mount(freshPanel());
  await openMarketplace(container);
  const empty = container.querySelector('[aria-label="Marketplace empty"]');
  assert.ok(empty, 'an empty index has its own state');
  assert.equal(empty.querySelector('.apps-market-state-title').textContent, 'No apps in the marketplace yet');
  const link = empty.querySelector('a');
  assert.equal(link.textContent, 'Submit an app');
  assert.equal(link.getAttribute('href'), 'https://stacki.build/marketplace/submit');
  assert.equal(link.getAttribute('target'), '_blank', 'Desktop opens a new window in the system browser');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  await act(async () => root.unmount());
});

test('a waiting update reads on its row and dots the rail; auto-update starts off and only an admin switches it', async () => {
  const github = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0' };
  const base = summary('heat-map', 'Heat map', 'Clicks on the canvas');
  const waiting = {
    ...base,
    lock: { ...base.lock, source: github, autoUpdate: false, update: { version: '1.1.0', tag: 'v1.1.0', sha256: 'e'.repeat(64), additions: [] } },
  };
  const switches = [];
  window.avb = {
    listApps: async () => ({ ok: true, value: [waiting] }),
    setAppAutoUpdate: async (input) => {
      switches.push(input);
      return { ok: true, value: [waiting] };
    },
  };
  const { container, root } = await mount(panel());
  assert.equal(container.querySelector('.apps-row-update').textContent, 'Update available · v1.1.0');
  const openDetails = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await openDetails(container.querySelector('.apps-row [aria-label="Heat map options"]'));
  await openDetails([...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  // The details open in a popup, which portals to <body>.
  const toggle = document.querySelector('[role=switch]');
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'auto-update is off by default');
  await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.deepEqual(switches, [{ projectPath: '/p', id: 'heat-map', autoUpdate: true }]);
  await act(async () => root.unmount());

  const viewer = await mount(panel({ id: 'editor', name: 'Editor', isAdmin: false, features: new Set(['panel:apps', 'app:*']) }));
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await click(viewer.container.querySelector('.apps-row [aria-label="Heat map options"]'));
  await click([...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal(document.querySelector('[role=switch]').disabled, true, 'only an admin switches auto-update');
  await act(async () => viewer.root.unmount());

  // The rail's dot follows the installed list and the update checks, for admins only.
  const updates = bundle('src/features/apps/appUpdates.tsx', 'updates');
  updates.noteInstalledApps([waiting]);
  const dot = await mount(React.createElement(updates.AppsRailBadge, { admin: true }));
  assert.ok(dot.container.querySelector('.apps-rail-badge'), 'an admin sees that an update waits');
  await act(async () => updates.noteUpdateOutcomes([{ kind: 'updated', id: 'heat-map', version: '1.1.0' }]));
  assert.equal(dot.container.querySelector('.apps-rail-badge') ?? undefined, undefined, 'an installed update no longer waits');
  await act(async () => dot.root.unmount());
  updates.noteInstalledApps([waiting]);
  const nonAdmin = await mount(React.createElement(updates.AppsRailBadge, { admin: false }));
  assert.equal(nonAdmin.container.querySelector('.apps-rail-badge') ?? undefined, undefined, 'only an admin can act on it');
  await act(async () => nonAdmin.root.unmount());
});

test('Update installs from the row and the details and says so; a failure is shown; the version it adds is named', async () => {
  const github = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0' };
  const base = summary('heat-map', 'Heat map', 'Clicks on the canvas');
  const waiting = {
    ...base,
    lock: {
      ...base.lock,
      source: github,
      autoUpdate: false,
      update: { version: '1.1.0', tag: 'v1.1.0', sha256: 'e'.repeat(64), additions: ['reaches api.example.com'] },
    },
  };
  const applied = [];
  let outcome = { ok: true, value: { ...waiting, manifest: { ...waiting.manifest, version: '1.1.0' } } };
  window.avb = {
    listApps: async () => ({ ok: true, value: [waiting] }),
    applyAppUpdate: async (input) => {
      applied.push(input);
      return outcome;
    },
  };
  const messages = [];
  const notify = (message, kind) => messages.push([kind, message]);
  const { container, root } = await mount(React.createElement(AppsPanel, { projectPath: '/p', role: roles.ADMIN_VIEW, notify }));
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  // The row: the accent line, and the Refresh-icon button.
  assert.equal(container.querySelector('.apps-row-update').textContent, 'Update available · v1.1.0');
  assert.equal(container.querySelector('.apps-row-update').getAttribute('data-needs-ok'), 'false');
  const rowButton = container.querySelector('.apps-row [aria-label="Update Heat map"]');
  assert.ok(rowButton, 'the row has an Update button');
  assert.equal(rowButton.getAttribute('title'), 'Update to 1.1.0');
  await click(rowButton);
  await settle();
  assert.deepEqual(applied, [{ projectPath: '/p', id: 'heat-map' }]);
  assert.deepEqual(messages.at(-1), ['success', 'Heat map updated to 1.1.0.']);
  // The failure message is shown as it came.
  outcome = { ok: false, message: 'The download no longer matches the SHA-256 that was checked.' };
  await click(rowButton);
  await settle();
  assert.deepEqual(messages.at(-1), ['error', 'The download no longer matches the SHA-256 that was checked.']);
  // The details: the same state, what the version adds, and an Update button.
  await click(container.querySelector('.apps-row [aria-label="Heat map options"]'));
  await click([...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details'));
  await settle();
  const updates = document.querySelector('[aria-label="Heat map updates"]');
  assert.ok(updates, 'the details have an Updates list');
  assert.match(updates.textContent, /Update available · v1\.1\.0/);
  assert.match(updates.textContent, /Update automatically/);
  const detailsButton = [...updates.querySelectorAll('button')].find((button) => button.textContent === 'Update');
  assert.ok(detailsButton, 'the details have an Update button');
  assert.ok(detailsButton.querySelector('svg'), 'with the Refresh icon');
  assert.equal(updates.querySelector('[role=switch]').getAttribute('aria-label'), 'Update Heat map automatically');
  await act(async () => root.unmount());
});

test('auto-update on: a version that asks for more reads "Update needs your OK" and still has Update; an own app never offers Update', async () => {
  const marketplace = { kind: 'marketplace', id: 'heat-map', version: '1.0.0' };
  const base = summary('heat-map', 'Heat map', 'Clicks on the canvas');
  const held = {
    ...base,
    lock: {
      ...base.lock,
      source: marketplace,
      autoUpdate: true,
      update: { version: '1.1.0', tag: 'v1.1.0', sha256: 'e'.repeat(64), additions: ['reaches api.example.com'] },
    },
  };
  const quiet = summary('quiet-app', 'Quiet app', 'Nothing new');
  const quietWaiting = {
    ...quiet,
    lock: {
      ...quiet.lock,
      source: { kind: 'marketplace', id: 'quiet-app', version: '1.0.0' },
      autoUpdate: false,
      update: { version: '1.1.0', tag: 'v1.1.0', sha256: 'f'.repeat(64), additions: [] },
    },
  };
  // An uploaded app and one added to the project folder are the person's own: even a stray `update` offers nothing.
  const upload = summary('own-upload', 'Own upload', 'Mine');
  const uploadStray = {
    ...upload,
    lock: { ...upload.lock, autoUpdate: false, update: { version: '9.0.0', tag: 'v9', sha256: 'c'.repeat(64), additions: [] } },
  };
  const folder = summary('own-folder', 'Own folder', 'Mine');
  const folderOwn = { ...folder, lock: { ...folder.lock, source: { kind: 'local' }, autoUpdate: false, update: undefined } };
  window.avb = { listApps: async () => ({ ok: true, value: [held, quietWaiting, uploadStray, folderOwn] }) };
  const { container, root } = await mount(panel());
  const row = (name) => [...container.querySelectorAll('.apps-row')].find((item) => item.querySelector('.apps-row-title')?.textContent === name);
  const heldLine = row('Heat map').querySelector('.apps-row-update');
  assert.equal(heldLine.textContent, 'Update needs your OK · v1.1.0');
  assert.equal(heldLine.getAttribute('data-needs-ok'), 'true');
  assert.ok(row('Heat map').querySelector('[aria-label="Update Heat map"]'), 'a person can still choose Update');
  assert.equal(row('Quiet app').querySelector('.apps-row-update').textContent, 'Update available · v1.1.0');
  for (const name of ['Own upload', 'Own folder']) {
    assert.equal(row(name).querySelector('.apps-row-update') ?? undefined, undefined, `${name} offers no update`);
    assert.equal(row(name).querySelector('[aria-label^="Update "]') ?? undefined, undefined, `${name} has no Update button`);
  }
  // The held app's details say it needs the OK, and its switch is on (what it adds is the hint, covered in appUpdates).
  const click = (element) => act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await click(row('Heat map').querySelector('[aria-label="Heat map options"]'));
  await click([...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const updates = document.querySelector('[aria-label="Heat map updates"]');
  assert.match(updates.textContent, /Update needs your OK · v1\.1\.0/);
  assert.equal(updates.querySelector('[role=switch]').getAttribute('aria-checked'), 'true');
  await act(async () => root.unmount());
});

test('rows say where each app lives, and draw no avatar without an author', async () => {
  const github = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0', account: 'octocat' };
  const fromGitHub = summary('heat-map', 'Heat map', 'Clicks on the canvas');
  const listed = summary('alt-text', 'Alt text check', 'Images without alt text');
  const authored = summary('helper', 'Helper', 'Named author');
  const apps = [
    { ...fromGitHub, lock: { ...fromGitHub.lock, source: github, autoUpdate: false } },
    { ...listed, lock: { ...listed.lock, source: { kind: 'marketplace', id: 'alt-text', version: '0.3.0' }, autoUpdate: false } },
    summary('translate', 'Translate', 'Copy in more languages'),
    // The wire carries the manifest's own `author.github`, which the panel parses again.
    { ...authored, manifest: { ...authored.manifest, author: { github: 'hubot' } } },
  ];
  const asked = [];
  window.avb = {
    listApps: async () => ({ ok: true, value: apps }),
    appMarketplace: async () => ({ ok: true, value: marketplaceIndex }),
    appRepositoryVisibility: async (input) => {
      asked.push(input.id);
      if (input.id === 'heat-map') {
        return { ok: true, value: { place: { owner: 'octocat', repository: 'heat-map', visibility: 'private' } } };
      }
      // A lookup that failed in main: no visibility, never an error.
      return { ok: true, value: { place: { owner: 'hubot', repository: 'alt-text' } } };
    },
  };
  const renderAvatar = (login, name) => React.createElement('span', { className: 'test-avatar' }, login ?? name.slice(0, 2));
  // A project of its own: the panel opens on the list it last read for a project
  // (installedAppsCache.ts), and the earlier tests read other apps under '/p'.
  const { container, root } = await mount(React.createElement(AppsPanel, { projectPath: '/places', role: roles.ADMIN_VIEW, notify: () => {}, renderAvatar }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const rowOf = (name) => [...container.querySelectorAll('.apps-row')].find((row) => row.querySelector('.apps-row-title').textContent === name);
  const pills = (name) => [...rowOf(name).querySelectorAll('.apps-place-pill')].map((pill) => pill.textContent);
  // One origin pill per row: Marketplace when installed from it or listed in it, else GitHub, else Local.
  assert.deepEqual(pills('Heat map'), ['Marketplace'], 'a GitHub app the marketplace lists says Marketplace alone');
  assert.deepEqual(pills('Alt text check'), ['Marketplace'], 'an app installed from the marketplace says Marketplace alone');
  assert.deepEqual(pills('Translate'), ['Local']);
  assert.deepEqual(asked.sort(), ['alt-text', 'heat-map'], 'only apps on GitHub are looked up');
  // An author from the manifest, or the repository's owner for a GitHub app; an uploaded app without one has none.
  assert.equal(rowOf('Translate').querySelector('.apps-row-avatar') ?? undefined, undefined, 'no author, no avatar');
  assert.equal(rowOf('Translate').querySelector('.apps-initial') ?? undefined, undefined, 'no made-up initials');
  assert.equal(rowOf('Helper').querySelector('.apps-row-avatar .test-avatar').textContent, 'hubot');
  assert.equal(rowOf('Heat map').querySelector('.apps-row-avatar .test-avatar').textContent, 'octocat');

  // The details' About says the same, with the repository on GitHub.
  await act(async () =>
    rowOf('Heat map')
      .querySelector('[aria-label="Heat map options"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await act(async () =>
    [...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent === 'Details').dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const about = document.querySelector('.apps-details-popup');
  // The pills' explanations are the Stored in hint's sentence.
  assert.match(about.textContent, /Installed fromGitHub · v1\.0\.0/, 'the details still say where the app was installed from');
  assert.match(about.textContent, /Listed in the Stacki marketplace\./);
  assert.deepEqual(
    [...about.querySelectorAll('.apps-place-pill')].map((pill) => pill.textContent),
    ['Marketplace'],
  );
  const link = about.querySelector('a.apps-details-repository');
  assert.equal(link.textContent, 'octocat/heat-map', 'the repository link names it, beside the author');
  assert.ok(link.closest('.apps-details-meta'), 'in the header’s meta line');
  assert.equal(link.getAttribute('href'), 'https://github.com/octocat/heat-map');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  await act(async () => root.unmount());
});
