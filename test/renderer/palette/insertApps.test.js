// Goal: the insert palette lists installed apps. They rank into All results after the insert kinds and
// have their own Apps tab; Enter or a click on an app closes the palette and opens the app; an app the
// role has no grant for is absent, and a role without the Apps panel has no Apps tab; an Apps tab with
// no app is a section with a title, a note and action rows (connect, copy the prompt, upload, open the panel) that the
// keys move through and Enter runs; a remembered Apps tab that is not on offer opens All results.
// A search on the Apps tab also lists marketplace apps under one "Marketplace" heading after the installed
// ones, for a role with `marketplace:view` only; choosing one opens it, never installs it.
// Methodology: bundle the real palette together with the renderer's role store into one module, so the
// test sets the role the palette reads. Mount it in jsdom with a stub apps source whose open and browse
// actions record calls, then drive it with the same key and click events a person would. The pure role
// filter and row text (paletteApps.ts) are checked on their own, including invalid and edge input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');

function bundle() {
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'insert-apps.cjs');
  buildSync({
    stdin: {
      contents: [
        "export { default as InsertSearch } from './src/features/palette/InsertSearch';",
        "export { setActualRole } from './src/lib/currentRole';",
        "export { ADMIN_VIEW } from './shared/properties/projectRoles';",
        "export { visiblePaletteApps, paletteAppItems, paletteAppByline, paletteAppsActions, canSeePaletteApps } from './src/features/palette/paletteApps';",
      ].join('\n'),
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  });
  delete require.cache[output];
  return require(output);
}

const palette = bundle();

function app(id, name, description, opened) {
  return { id, name, description, author: undefined, iconURL: undefined, initial: name[0], color: '#6366f1', open: () => opened.push(id) };
}

function clientRole(features) {
  return { id: 'client', name: 'Client', isAdmin: false, features: new Set(features), appPermissions: {}, pinnedApps: [] };
}

async function mount({ apps, storedTab }) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  if (storedTab !== undefined) {
    localStorage.setItem('stacki.insertPalette.tab', storedTab);
  }
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const calls = { inserted: [], closed: 0 };
  await React.act(async () => {
    root.render(
      React.createElement(palette.InsertSearch, {
        components: [{ name: 'Heatwave', folder: 'Sections', path: '/components/Sections/Heatwave.astro' }],
        apps,
        onInsert: (item) => calls.inserted.push(item),
        onClose: () => {
          calls.closed += 1;
        },
      }),
    );
  });
  const act = (run) => React.act(async () => run());
  return {
    container,
    calls,
    tabs: () => [...container.querySelectorAll('.insert-tab')].map((tab) => tab.textContent),
    labels: () => [...container.querySelectorAll('.insert-item-label')].map((row) => row.textContent),
    pickTab: (label) => act(() => Simulate.click([...container.querySelectorAll('.insert-tab')].find((tab) => tab.textContent === label))),
    query: (value) => act(() => Simulate.change(container.querySelector('input'), { target: { value } })),
    key: (key) => act(() => Simulate.keyDown(container.querySelector('input'), { key })),
    click: (element) => act(() => Simulate.click(element)),
    async unmount() {
      await React.act(async () => root.unmount());
      dom.window.close();
      delete global.localStorage;
    },
  };
}

test('apps appear in All results after the insert kinds, and on their own Apps tab', async () => {
  palette.setActualRole(palette.ADMIN_VIEW);
  const opened = [];
  const apps = { list: { kind: 'ready', apps: [app('heatmap', 'Heatmap', 'Click maps for pages', opened), app('seo', 'SEO Audit', '', opened)] }, browse() {} };
  const view = await mount({ apps });
  try {
    await view.pickTab('All results');
    assert.deepEqual(view.tabs(), ['All results', 'Components', 'Elements', 'Other', 'Apps'], 'Apps is the last tab');
    await view.query('heat');
    assert.deepEqual(view.labels(), ['Heatwave', 'Heatmap'], 'an app ranks after a component the same word matches');
    await view.query('click maps');
    assert.deepEqual(view.labels(), ['Heatmap'], 'the description is searched');
    await view.query('seo');
    assert.deepEqual(view.labels(), ['SEO Audit'], 'the id is searched');
    await view.pickTab('Apps');
    await view.query('');
    assert.deepEqual(view.labels(), ['Heatmap', 'SEO Audit'], 'the Apps tab lists only apps, in the host order');
    assert.equal(view.container.querySelectorAll('.insert-app-detail').length, 0, 'rows show the name only, not the description');
    assert.equal(view.container.querySelectorAll('.insert-app .insert-app-tile').length, 2, 'every app row has an icon tile');
    assert.equal(localStorage.getItem('stacki.insertPalette.tab'), 'apps', 'the Apps tab is remembered');
  } finally {
    await view.unmount();
  }
});

test('Enter and a click on an app close the palette and open the app, never insert it', async () => {
  palette.setActualRole(palette.ADMIN_VIEW);
  const opened = [];
  const apps = { list: { kind: 'ready', apps: [app('heatmap', 'Heatmap', '', opened), app('seo', 'SEO Audit', '', opened)] }, browse() {} };
  const view = await mount({ apps });
  try {
    await view.pickTab('Apps');
    await view.key('ArrowDown');
    await view.key('Enter');
    assert.deepEqual(opened, ['seo'], 'Enter opens the highlighted app');
    assert.equal(view.calls.closed, 1, 'the palette closes');
    assert.deepEqual(view.calls.inserted, [], 'an app is never inserted');
    await view.click(view.container.querySelectorAll('.insert-app')[0]);
    assert.deepEqual(opened, ['seo', 'heatmap'], 'a click opens the clicked app');
    assert.equal(view.calls.closed, 2);
  } finally {
    await view.unmount();
  }
});

test('an app the role has no grant for is absent, and a role without the Apps panel has no Apps tab', async () => {
  const opened = [];
  const apps = { list: { kind: 'ready', apps: [app('heatmap', 'Heatmap', '', opened), app('seo', 'SEO Audit', '', opened)] }, browse() {} };
  palette.setActualRole(clientRole(['panel:apps', 'app:seo']));
  const granted = await mount({ apps });
  try {
    await granted.pickTab('Apps');
    assert.deepEqual(granted.labels(), ['SEO Audit']);
    await granted.pickTab('All results');
    await granted.query('heatmap');
    assert.deepEqual(granted.labels(), [], 'a hidden app is not in All results either');
  } finally {
    await granted.unmount();
  }
  palette.setActualRole(clientRole(['app:seo']));
  const noPanel = await mount({ apps, storedTab: 'apps' });
  try {
    assert.deepEqual(noPanel.tabs(), ['All results', 'Components', 'Elements', 'Other'], 'no Apps panel, no Apps tab');
    assert.equal(noPanel.container.querySelector('.insert-tab.on').textContent, 'All results', 'a remembered Apps tab opens All results');
    await noPanel.query('seo');
    assert.deepEqual(noPanel.labels(), []);
  } finally {
    await noPanel.unmount();
    palette.setActualRole(palette.ADMIN_VIEW);
  }
});

test('an Apps tab with no app is a section: a tile, a title, a note, and action rows the keys move through', async () => {
  palette.setActualRole(palette.ADMIN_VIEW);
  const ran = [];
  const apps = {
    list: { kind: 'ready', apps: [] },
    browse: () => ran.push('browse'),
    upload: () => ran.push('upload'),
    connect: () => ran.push('connect'),
    copyPrompt: () => ran.push('copyPrompt'),
  };
  const view = await mount({ apps, storedTab: 'apps' });
  const actions = () => [...view.container.querySelectorAll('.insert-apps-action')];
  const highlighted = () => actions().findIndex((row) => row.classList.contains('highlight'));
  try {
    const section = view.container.querySelector('.insert-results > .insert-apps-empty');
    assert.ok(section, 'the empty state sits in the results area');
    assert.ok(section.querySelector('.insert-apps-empty-tile svg'), 'an Apps icon tile');
    assert.equal(section.querySelector('.insert-apps-empty-title').textContent, 'No apps yet');
    assert.match(section.querySelector('.insert-apps-empty-note').textContent, /Apps add tools/);
    assert.deepEqual(
      actions().map((row) => row.textContent),
      ['Load App From GitHub', '“Build an app” prompt', 'Upload app file', 'Open Apps panel'],
      'connecting first, the panel last',
    );
    assert.ok(
      actions().every((row) => row.classList.contains('insert-item')),
      'the rows are result rows',
    );
    assert.equal(highlighted(), 0, 'the first row is highlighted');
    await view.key('Enter');
    assert.deepEqual(ran, ['connect'], 'Enter runs the highlighted row');
    assert.equal(view.calls.closed, 1, 'and closes the palette');
    await view.key('ArrowDown');
    assert.equal(highlighted(), 1);
    await view.key('Enter');
    assert.deepEqual(ran, ['connect', 'copyPrompt']);
    await view.key('ArrowDown');
    await view.key('Enter');
    assert.deepEqual(ran, ['connect', 'copyPrompt', 'upload']);
    await view.key('ArrowDown');
    await view.key('ArrowDown');
    assert.equal(highlighted(), 3, 'the last row is the end of the list');
    await view.key('Enter');
    assert.deepEqual(ran, ['connect', 'copyPrompt', 'upload', 'browse']);
    await view.key('ArrowUp');
    assert.equal(highlighted(), 2);
    await view.click(actions()[0]);
    assert.deepEqual(ran, ['connect', 'copyPrompt', 'upload', 'browse', 'connect'], 'a click runs its row');
    await view.query('anything');
    assert.equal(actions().length, 4, 'a search cannot hide the way to install one');
  } finally {
    await view.unmount();
  }
});

test('without install actions from the host the rows open the Apps panel, and a non-admin is only offered the panel', async () => {
  const ran = [];
  const apps = { list: { kind: 'ready', apps: [] }, browse: () => ran.push('browse') };
  palette.setActualRole(palette.ADMIN_VIEW);
  const admin = await mount({ apps, storedTab: 'apps' });
  try {
    await admin.key('Enter');
    assert.deepEqual(ran, ['browse'], 'connecting falls back to the panel, where the person finishes it');
  } finally {
    await admin.unmount();
  }
  palette.setActualRole(clientRole(['panel:apps']));
  const client = await mount({ apps, storedTab: 'apps' });
  try {
    assert.deepEqual(
      [...client.container.querySelectorAll('.insert-apps-action')].map((row) => row.textContent),
      ['“Build an app” prompt', 'Open Apps panel'],
      'installing is an admin’s; anyone may build one',
    );
  } finally {
    await client.unmount();
    palette.setActualRole(palette.ADMIN_VIEW);
  }
});

test('the Apps tab says when apps are loading or failed, and All results is unaffected', async () => {
  palette.setActualRole(palette.ADMIN_VIEW);
  const loading = await mount({ apps: { list: { kind: 'loading' }, browse() {} }, storedTab: 'apps' });
  try {
    assert.equal(loading.container.querySelector('.props-empty').textContent, 'Loading apps…');
    await loading.key('Enter');
    assert.equal(loading.calls.closed, 0, 'Enter does nothing while there is nothing to open');
  } finally {
    await loading.unmount();
  }
  const failed = await mount({ apps: { list: { kind: 'failed', message: 'Restart Stacki to use Apps.' }, browse() {} }, storedTab: 'apps' });
  try {
    assert.equal(failed.container.querySelector('.props-empty').textContent, 'Restart Stacki to use Apps.');
    await failed.pickTab('All results');
    await failed.query('heatwave');
    assert.deepEqual(failed.labels(), ['Heatwave']);
  } finally {
    await failed.unmount();
  }
});

test('the role filter and row text', () => {
  const opened = [];
  const apps = [app('heatmap', 'Heatmap', 'Click maps', opened), app('seo', 'SEO Audit', '', opened)];
  assert.deepEqual(
    palette.visiblePaletteApps(apps, palette.ADMIN_VIEW).map((entry) => entry.id),
    ['heatmap', 'seo'],
  );
  assert.deepEqual(
    palette.visiblePaletteApps(apps, clientRole(['panel:apps', 'app:*'])).map((entry) => entry.id),
    ['heatmap', 'seo'],
    'app:* grants every app',
  );
  assert.deepEqual(palette.visiblePaletteApps(apps, clientRole(['app:*'])), [], 'no app without the Apps panel');
  assert.equal(palette.canSeePaletteApps(clientRole([])), false);
  const tooMany = Array.from({ length: 51 }, (_, index) => app(`app-${index}`, `App ${index}`, '', opened));
  assert.throws(() => palette.visiblePaletteApps(tooMany, palette.ADMIN_VIEW), /installed apps are bounded/);
  assert.throws(() => palette.canSeePaletteApps({ id: '', name: '', isAdmin: false, features: new Set() }), /a role has an id/);
  const [heatmap, seo] = palette.paletteAppItems(apps);
  assert.equal(heatmap.label, 'Heatmap');
  assert.equal(heatmap.sub, 'heatmap Click maps');
  assert.equal(seo.sub, 'seo', 'an app without a description is searched by its id');
  const octocat = { login: 'octocat', avatarURL: 'https://github.com/octocat.png?size=40' };
  assert.equal(palette.paletteAppByline({ ...apps[0], author: octocat }), 'by octocat');
  assert.equal(palette.paletteAppByline({ ...apps[0], author: { ...octocat, avatarURL: undefined } }), 'by octocat', 'a byline needs no picture');
  assert.equal(palette.paletteAppByline(apps[1]), undefined, 'an app that names no author has no byline');
  assert.throws(() => palette.paletteAppByline({ ...apps[1], name: '' }), /an app has a name/);
  assert.throws(() => palette.paletteAppByline({ ...apps[0], author: { ...octocat, login: '' } }), /an author has a login/);
  const browse = () => {};
  const keys = (role) => palette.paletteAppsActions({ list: { kind: 'ready', apps: [] }, browse }, role).map((action) => action.key);
  assert.deepEqual(keys(palette.ADMIN_VIEW), ['connect', 'copyPrompt', 'upload', 'browse']);
  assert.deepEqual(keys(clientRole(['panel:apps'])), ['copyPrompt', 'browse']);
  assert.throws(() => keys(clientRole([])), /only a role with the Apps panel/);
});

test('an Apps-tab search lists marketplace apps under Marketplace, after installed ones, only for marketplace:view', async () => {
  const opened = [];
  const apps = {
    list: { kind: 'ready', apps: [app('heatmap', 'Heatmap', 'Click maps for pages', opened)] },
    marketplace: [app('heat-audit', 'Heat audit', 'Contrast heat over pages', opened)],
    browse() {},
  };
  palette.setActualRole(palette.ADMIN_VIEW);
  const view = await mount({ apps });
  try {
    await view.pickTab('Apps');
    assert.deepEqual(view.labels(), ['Heatmap'], 'without a search the tab lists installed apps only');
    await view.query('heat');
    assert.deepEqual(view.labels(), ['Heatmap', 'Heat audit'], 'marketplace results follow the installed ones');
    const headings = [...view.container.querySelectorAll('.insert-section-heading')].map((heading) => heading.textContent);
    assert.deepEqual(headings, ['Marketplace']);
    await view.key('ArrowDown');
    await view.key('Enter');
    assert.deepEqual(opened, ['heat-audit'], 'Enter shows the marketplace app');
    assert.deepEqual(view.calls.inserted, [], 'it is never inserted');
    await view.pickTab('All results');
    assert.ok(!view.labels().includes('Heat audit'), 'All results keeps to the project');
  } finally {
    await view.unmount();
  }
  palette.setActualRole(clientRole(['panel:apps', 'app:*']));
  const hidden = await mount({ apps });
  try {
    await hidden.pickTab('Apps');
    await hidden.query('heat');
    assert.deepEqual(hidden.labels(), ['Heatmap'], 'a role without marketplace:view sees no marketplace results');
  } finally {
    await hidden.unmount();
  }
});
