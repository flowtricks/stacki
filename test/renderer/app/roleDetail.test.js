// Goal: a role's card is a compact list of summary rows, and each row opens a detail view with a back button, a
// search and the list: Members (list, remove, the add form), Sidebar apps, Components (Show all / Hide all) and
// Permissions (grouped by area, a count in the header, a group switch that reads mixed when some are on). The
// model's counts, grouping and search are exact; going back and forth keeps each part's search text; Escape and the
// back button return to the cards; every change still saves through the same write as before.
// Method: bundle the real roles screen and the pure model through esbuild, mount the screen in jsdom over a fake
// metadata bridge that records writes (never a real project), drive it with clicks, typing and Escape, and read each
// write back with the shared parser. The model is also called directly with translators that return English.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture');

const output = repoPath('node_modules/.stacki-test/role-detail.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { RolesSettings } from './src/app/settings/RolesSettings';",
      "export * from './src/lib/currentRole';",
      "export * from './src/app/settings/roleDetailModel';",
      "export { setAllComponentVisibility } from './src/app/settings/rolesEdits';",
      "export { authProviderOf } from './src/app/settings/authProvider';",
      "export { parseProjectRolesSource, roleViewOf, ADMIN_VIEW } from './shared/properties/projectRoles';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.scrollIntoView = () => undefined;

let stored;
const writes = [];
window.avb = {
  projectMetadata: async () => ({ ok: true, value: stored === undefined ? {} : { source: stored } }),
  writeProjectMetadata: async (input) => {
    writes.push(input.write);
    stored = input.write.source;
    return { ok: true, value: { source: stored } };
  },
  rolesIdentity: async () => ({ login: 'owner' }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const roles = require(output);

const FILES = ['src/components/Card.astro', 'src/components/interactive/Modal.astro', 'src/components/ui/Button.astro'];
// One task boundary inside act, so the bridge's resolved reads and the effects they trigger land.
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
let root;
async function mount() {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(roles.RolesSettings, { projectPath: '/project', componentFiles: FILES })));
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
}
async function click(element) {
  assert.ok(element, 'the control exists');
  await act(async () => element.click());
  await settle();
}
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
const saved = () => roles.parseProjectRolesSource(stored);
const roleOf = (id) => saved().roles.find((role) => role.id === id);
const detail = () => document.querySelector('section.app-role-detail') ?? undefined;
const row = (name, label) => document.querySelector(`button[aria-label="Open ${label} for ${name}"]`);
const fresh = (extra = {}) => {
  writes.length = 0;
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner', 'sam'] },
      { id: 'client', ...extra },
    ],
  });
  roles.setActualRole(roles.ADMIN_VIEW);
};
const search = () => detail().querySelector('.app-role-search input');
const labels = (selector) => [...detail().querySelectorAll(selector)].map((element) => element.textContent);

// Model.

const translateDescribed = (described) => described.message;

test('groupState reads off, on or mixed, and refuses counts that cannot be', () => {
  assert.equal(roles.groupState(0, 4), 'off');
  assert.equal(roles.groupState(4, 4), 'on');
  assert.equal(roles.groupState(1, 4), 'mixed');
  assert.equal(roles.groupState(3, 4), 'mixed');
  assert.throws(() => roles.groupState(5, 4), /no more on than it lists/);
  assert.throws(() => roles.groupState(-1, 4), /no negative count/);
});

test('matchesQuery needs every word, ignores case, and an empty query matches all', () => {
  assert.equal(roles.matchesQuery('Delete pages', ''), true);
  assert.equal(roles.matchesQuery('Delete pages', '  '), true);
  assert.equal(roles.matchesQuery('Delete pages', 'PAGES delete'), true);
  assert.equal(roles.matchesQuery('Delete pages', 'delete cms'), false);
});

test('permissionGroups counts and states the whole group, and a search keeps matching rows only', () => {
  const role = {
    id: 'client',
    name: 'Client',
    members: [],
    access: ['page:create', 'page:delete', 'app:*'],
    appPermissions: {},
    pinnedApps: [],
    componentRules: [],
    editorOff: [],
  };
  const all = roles.permissionGroups(role, '', 'Every app', translateDescribed);
  const pages = all.find((group) => group.key === 'Pages');
  assert.equal(pages.on, 2);
  assert.equal(pages.total, pages.rows.length);
  assert.equal(pages.state, 'mixed');
  const apps = all.find((group) => group.key === 'Apps');
  assert.equal(apps.rows.at(-1).label, 'Every app', 'Every app is listed in the Apps group');
  assert.equal(apps.rows.at(-1).checked, true);
  assert.equal(apps.total, apps.rows.length - 1, 'but it is not one of the group switch’s counted switches');
  assert.ok(!apps.features.includes('app:*'));

  const narrowed = roles.permissionGroups(role, 'delete', 'Every app', translateDescribed);
  const narrowedPages = narrowed.find((group) => group.key === 'Pages');
  assert.deepEqual(
    narrowedPages.rows.map((entry) => entry.label),
    ['Delete pages'],
  );
  assert.equal(narrowedPages.total, pages.total, 'a search never changes a group’s total');
  assert.equal(narrowedPages.state, 'mixed', 'nor its state');
  assert.ok(
    narrowed.every((group) => group.rows.length > 0),
    'a group with no match is left out',
  );
  const byGroupName = roles.permissionGroups(role, 'pages', 'Every app', translateDescribed).find((group) => group.key === 'Pages');
  assert.equal(byGroupName.rows.length, pages.rows.length, 'a group whose name matches keeps all of its rows');
  assert.deepEqual(roles.permissionGroups(role, 'zzzz', 'Every app', translateDescribed), []);
  assert.deepEqual(
    roles.permissionGroups(role, 'every', 'Every app', translateDescribed).map((group) => group.key),
    ['Apps'],
    'Every app is found by its own name',
  );
});

test('permissionCounts counts every listed switch and Every app', () => {
  const none = { id: 'x', name: 'X', members: [], access: [], appPermissions: {}, pinnedApps: [], componentRules: [], editorOff: [] };
  const counts = roles.permissionCounts(none);
  // Eight canvas controls are on by default; "Change images" waits for a right panel tab.
  assert.equal(counts.granted, 8);
  assert.equal(roles.permissionCounts({ ...none, access: ['app:*', 'panel:cms'] }).granted, 10);
  assert.equal(roles.permissionCounts({ ...none, access: ['app:*'] }).total, counts.total);
});

test('setAllComponentVisibility hides each top folder with the fewest rules, and shows all by dropping them', () => {
  const base = roles.parseProjectRolesSource(JSON.stringify({ version: 1, roles: [{ id: 'admin', members: ['owner'] }, { id: 'client' }] }));
  const hidden = roles.setAllComponentVisibility(base, 'client', 'hidden', ['src/a/B.astro', 'src/c/D.astro', 'Top.astro']);
  assert.deepEqual(hidden.roles[1].componentRules, [
    { kind: 'folder', path: 'src', effect: 'hide' },
    { kind: 'component', path: 'Top.astro', effect: 'hide' },
  ]);
  assert.deepEqual(roles.setAllComponentVisibility(hidden, 'client', 'visible', []).roles[1].componentRules, []);
});

// Cards and views.

test('a card is a header and flat summary rows with counts; no switches and no add form on it', async () => {
  fresh({ access: ['panel:cms'], pinnedApps: [] });
  await mount();
  const client = document.querySelector('section[aria-label="Client role"]');
  const rows = [...client.querySelectorAll('.app-role-row')].map((entry) => entry.textContent);
  assert.match(rows[0], /^Members0$/);
  assert.match(rows[1], /^Sidebar apps0$/);
  assert.match(rows[2], /^Components3 of 3$/);
  // The CMS grant, plus the canvas controls it leaves on: all but "Change images", which needs a right panel tab.
  assert.match(rows[3], /^Permissions9 of \d+$/);
  assert.equal(rows.length, 4, 'one Permissions row: canvas controls are inside it');
  assert.equal(client.querySelectorAll('[role="switch"], input').length, 0, 'the card holds no controls but its rows and menu');
  assert.equal(document.querySelector('section[aria-label="Admin role"]').querySelectorAll('.app-role-row').length, 3, 'admin has no Permissions row');
  await unmount();
});

test('a row opens its view with a back button; Back and Escape return, and nothing is written', async () => {
  fresh();
  await mount();
  await click(row('Client', 'Permissions'));
  assert.ok(detail(), 'the view replaces the cards');
  assert.equal(document.querySelector('section[aria-label="Client role"]') ?? undefined, undefined);
  assert.equal(detail().querySelector('h3').textContent, 'Permissions');
  assert.equal(detail().querySelector('.app-role-detail-role').textContent, 'Client');
  assert.ok(detail().querySelector('.app-role-back'));
  await click(detail().querySelector('.app-role-back'));
  assert.equal(detail(), undefined, 'Back returns to the cards');
  await click(row('Client', 'Members'));
  await act(async () => search().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(detail(), undefined, 'Escape returns to the cards');
  assert.equal(writes.length, 0, 'looking writes nothing');
  await unmount();
});

test('permissions are grouped, searchable, and the group switch reads mixed, on and off', async () => {
  fresh({ access: ['page:create'] });
  await mount();
  await click(row('Client', 'Permissions'));
  // page:create is one switch, and a page edit permission gives Add elements by default, so it reads on too (canElements).
  // Those two, and the eight canvas controls on without a right panel tab.
  assert.match(detail().querySelector('.app-role-detail-count').textContent, /^On 10 of \d+$/);
  const headings = labels('.app-role-group h4');
  assert.deepEqual(headings.slice(0, 4), ['Right panel', 'Left panel', 'Canvas controls', 'Pages'], 'the panels and the canvas lead');
  assert.equal(new Set(labels('.app-role-toggle-label')).size, labels('.app-role-toggle-label').length, 'nothing is listed twice');
  const all = () => detail().querySelector('[role="switch"][aria-label="All Pages"]');
  assert.equal(all().getAttribute('aria-checked'), 'mixed', 'one of several on is mixed');
  assert.match(detail().querySelector('.app-role-group-count').textContent, /^\d+ of \d+$/);
  await click(all());
  assert.deepEqual(
    roleOf('client').access.filter((feature) => feature.startsWith('page:')),
    ['page:create', 'page:delete', 'page:rename', 'page:layout'],
    'mixed switches the whole group on',
  );
  assert.equal(all().getAttribute('aria-checked'), 'true');
  await click(all());
  assert.deepEqual(roleOf('client').access, [], 'on switches it off');
  assert.equal(all().getAttribute('aria-checked'), 'false');

  await type(search(), 'delete pages');
  assert.deepEqual(labels('.app-role-toggle-label'), ['Delete pages'], 'the search filters instantly');
  await type(search(), 'duplicate');
  assert.deepEqual(labels('.app-role-group h4'), ['Canvas controls'], 'canvas controls are searched too');
  await type(search(), 'delete pages');
  assert.deepEqual(labels('.app-role-group h4'), ['Pages']);
  await type(search(), 'zzzz');
  assert.match(detail().textContent, /Nothing matches “zzzz”/);
  await unmount();
});

test('each part keeps its search text when going back and forth', async () => {
  fresh();
  await mount();
  await click(row('Client', 'Permissions'));
  await type(search(), 'cms');
  await click(detail().querySelector('.app-role-back'));
  await click(row('Client', 'Members'));
  assert.equal(search().value, '', 'another part starts empty');
  await type(search(), 'sam');
  await click(detail().querySelector('.app-role-back'));
  await click(row('Client', 'Permissions'));
  assert.equal(search().value, 'cms', 'the permissions search is still there');
  assert.ok(labels('.app-role-toggle-label').includes('CMS'), 'the filtered list is still shown');
  await unmount();
});

test('members: the list filters, remove saves, and the add form for the active provider adds', async () => {
  stored = JSON.stringify({ version: 1, roles: [{ id: 'admin', members: ['owner', 'sam', 'sara'] }, { id: 'client' }] });
  writes.length = 0;
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  await click(row('Admin', 'Members'));
  assert.deepEqual(labels('.app-role-person-name'), ['owner', 'sam', 'sara']);
  await type(search(), 'sa');
  assert.deepEqual(labels('.app-role-person-name'), ['sam', 'sara']);
  await click(detail().querySelector('button[aria-label="Remove sam"]'));
  assert.deepEqual(roleOf('admin').members, ['owner', 'sara']);
  assert.ok(detail().querySelector('input[aria-label="Add a GitHub username to Admin"]'), 'the add form sits in the view');
  await type(search(), 'nobody');
  assert.match(detail().textContent, /Nothing matches/);
  await unmount();
});

test('components: Show all and Hide all change every rule at once, and the header counts what shows', async () => {
  fresh();
  await mount();
  await click(row('Client', 'Components'));
  assert.equal(detail().querySelector('.app-role-detail-count').textContent, '3 of 3 visible');
  const action = (name) => [...detail().querySelectorAll('.app-role-detail-actions button')].find((button) => button.textContent === name);
  await click(action('Hide all'));
  assert.deepEqual(roleOf('client').componentRules, [{ kind: 'folder', path: 'src', effect: 'hide' }]);
  assert.equal(detail().querySelector('.app-role-detail-count').textContent, '0 of 3 visible');
  await click(action('Show all'));
  assert.deepEqual(roleOf('client').componentRules, []);
  assert.equal(writes.length, 2, 'one write each');
  await unmount();
});

test('Desktop keeps every control enabled even if the active role were a client’s', async () => {
  fresh();
  roles.setActualRole(roles.roleViewOf(roles.parseProjectRolesSource(stored), 'client'));
  await mount();
  await click(row('Client', 'Permissions'));
  const switches = [...detail().querySelectorAll('[role="switch"]')];
  assert.ok(switches.length > 0);
  assert.ok(
    switches.every((entry) => !entry.disabled),
    'Desktop previews roles and never restricts the editor',
  );
  await unmount();
  roles.setActualRole(roles.ADMIN_VIEW);
});

// The sign-in method decides the Members view's add form.

const wrangler = (provider) => `{ "vars": { // comment\n "AUTH_PROVIDER": "${provider}" } }`;
async function withWrangler(text, run) {
  window.avb.readSourceText = async () => {
    if (text === undefined) {
      throw new Error('no such file');
    }
    return { text };
  };
  try {
    await run();
  } finally {
    delete window.avb.readSourceText;
  }
}

test('authProviderOf reads AUTH_PROVIDER, and anything else is github', () => {
  assert.equal(roles.authProviderOf(wrangler('passkey')), 'passkey');
  assert.equal(roles.authProviderOf(wrangler('google')), 'google');
  assert.equal(roles.authProviderOf('{}'), 'github');
  assert.equal(roles.authProviderOf(wrangler('Not A Provider')), 'github');
  assert.equal(roles.authProviderOf('x'.repeat(300000)), 'github');
});

test('a passkey project hides the GitHub field and says invites are created in Studio', async () => {
  fresh();
  await withWrangler(wrangler('passkey'), async () => {
    await mount();
    await click(row('Client', 'Members'));
    assert.equal(detail().querySelector('input[aria-label="Add a GitHub username to Client"]') ?? undefined, undefined);
    assert.match(detail().textContent, /Passkey invites are created in Studio/);
    await unmount();
  });
});

test('a google project adds a member by email as google:<email>, and refuses a bad address inline', async () => {
  fresh();
  await withWrangler(wrangler('google'), async () => {
    await mount();
    await click(row('Client', 'Members'));
    const field = detail().querySelector('input[aria-label="Add an email address to Client"]');
    assert.ok(field, 'the email field replaces the GitHub one');
    await type(field, 'not an email');
    globalThis.stackiCapturedToasts = [];
    await act(async () => field.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(toastMessages(), /Enter an email address/, 'the refusal is one toast');
    assert.doesNotMatch(detail().textContent, /Enter an email address/, 'and no paragraph is added under the field');
    assert.equal(field.getAttribute('aria-invalid'), 'true', 'the field takes the error look');
    assert.equal(writes.length, 0);
    await type(field, 'Ana@Example.com');
    assert.equal(field.getAttribute('aria-invalid') ?? undefined, undefined, 'editing clears the error look');
    await act(async () => field.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    assert.deepEqual(roleOf('client').members, ['google:ana@example.com']);
    await unmount();
  });
});

test('a project without Studio keeps the GitHub field', async () => {
  fresh();
  await withWrangler(undefined, async () => {
    await mount();
    await click(row('Client', 'Members'));
    assert.ok(detail().querySelector('input[aria-label="Add a GitHub username to Client"]'));
    await unmount();
  });
});

// The Right panel and Canvas controls sections.

const canvasSwitch = (part) => detail().querySelector(`.app-role-canvas-toggle[data-part="${part}"] [role="switch"]`);
const permissionSwitch = (label) => detail().querySelector(`[role="switch"][aria-label="${label}"]`);
const checkedOf = (label) => permissionSwitch(label).getAttribute('aria-checked');
const savedClient = () => JSON.parse(writes.at(-1).source).roles.find((role) => role.id === 'client');
const CANVAS = ['text', 'drag', 'images', 'insert', 'delete', 'duplicate', 'copy', 'paste', 'canvasBar'];
const BOTH_TABS = ['panel:navigator', 'panel:style', 'panel:settings', 'publish', 'code:edit'];

test('the Right panel switch hides the whole panel, keeps its tabs for later, and locks the other ways to reach styles', async () => {
  fresh({ access: BOTH_TABS });
  await mount();
  await click(row('Client', 'Permissions'));
  assert.equal(checkedOf('All Right panel'), 'true');
  await click(permissionSwitch('All Right panel'));
  assert.deepEqual(savedClient().editorOff, ['sidePanel']);
  assert.deepEqual(savedClient().access, BOTH_TABS, 'the permissions are untouched');
  for (const label of ['All Right panel', 'Style panel', 'Settings panel']) {
    assert.equal(checkedOf(label), 'false', label);
    assert.equal(permissionSwitch(label).disabled, false, `${label} can be switched back on`);
  }
  assert.equal(checkedOf('Edit code'), 'false');
  assert.equal(permissionSwitch('Edit code').disabled, true);
  assert.match(permissionSwitch('Edit code').closest('.app-role-toggle').getAttribute('title'), /right panel/);
  await click(permissionSwitch('All Right panel'));
  assert.equal(savedClient().editorOff, undefined, 'with nothing off the file is written as before');
  assert.deepEqual(savedClient().access, BOTH_TABS);
  assert.equal(checkedOf('Edit code'), 'true');
  await unmount();
});

test('switching off the last tab is switching the panel off, with the same protection, and one tab brings back only itself', async () => {
  fresh({ access: BOTH_TABS });
  await mount();
  await click(row('Client', 'Permissions'));
  await click(permissionSwitch('Style panel'));
  assert.equal(savedClient().editorOff, undefined, 'one tab off is only that tab');
  assert.deepEqual(savedClient().access, ['panel:navigator', 'panel:settings', 'publish', 'code:edit']);
  assert.equal(checkedOf('All Right panel'), 'true', 'the panel still shows, so its switch is on');
  assert.equal(checkedOf('Edit code'), 'true');
  await click(permissionSwitch('Settings panel'));
  assert.deepEqual(savedClient().editorOff, ['sidePanel']);
  assert.deepEqual(savedClient().access, ['panel:navigator', 'panel:settings', 'publish', 'code:edit']);
  assert.equal(permissionSwitch('Edit code').disabled, true);
  await click(permissionSwitch('Style panel'));
  assert.equal(savedClient().editorOff, undefined);
  assert.deepEqual(
    savedClient().access.filter((feature) => /panel:(style|settings)/.test(feature)),
    ['panel:style'],
  );
  assert.equal(checkedOf('Settings panel'), 'false');
  await unmount();
});

test('a role with neither tab reads off, and the panel switch gives it both', async () => {
  fresh({ access: ['panel:cms'] });
  await mount();
  await click(row('Client', 'Permissions'));
  assert.equal(checkedOf('All Right panel'), 'false');
  assert.equal(canvasSwitch('images').disabled, true);
  assert.match(
    canvasSwitch('images').closest('.app-role-toggle').querySelector('.app-role-toggle-label').getAttribute('title'),
    /Style panel or Settings panel/,
  );
  await click(permissionSwitch('All Right panel'));
  assert.deepEqual(savedClient().access, ['panel:cms', 'panel:style', 'panel:settings']);
  assert.equal(canvasSwitch('images').disabled, false);
  await unmount();
});

test('each canvas control is its own row; text, dragging and images off make the role read only', async () => {
  fresh({ access: BOTH_TABS });
  await mount();
  await click(row('Client', 'Permissions'));
  for (const part of CANVAS) {
    assert.equal(canvasSwitch(part).getAttribute('aria-checked'), 'true', part);
    assert.equal(canvasSwitch(part).disabled, false, part);
  }
  for (const part of ['delete', 'duplicate', 'paste', 'copy']) {
    await click(canvasSwitch(part));
  }
  assert.deepEqual(savedClient().editorOff, ['delete', 'duplicate', 'copy', 'paste']);
  assert.equal(canvasSwitch('insert').getAttribute('aria-checked'), 'true', 'each row stands alone');
  for (const part of ['drag', 'text', 'images']) {
    await click(canvasSwitch(part));
  }
  for (const part of ['insert', 'delete', 'duplicate', 'paste']) {
    assert.equal(canvasSwitch(part).getAttribute('aria-checked'), 'false', part);
  }
  assert.equal(canvasSwitch('insert').disabled, true, 'changing elements goes with read only');
  assert.equal(detail().querySelector('.app-role-detail-count').textContent, 'Read only');
  await click(detail().querySelector('.app-role-back'));
  assert.match(row('Client', 'Permissions').textContent, /^PermissionsRead only$/);
  await click(row('Client', 'Permissions'));
  // The whole section back on gives everything back.
  await click(permissionSwitch('All Canvas controls'));
  assert.equal(savedClient().editorOff, undefined);
  await click(permissionSwitch('All Canvas controls'));
  assert.deepEqual(savedClient().editorOff, CANVAS);
  await unmount();
});

test('a group switch never grants what a switched-off option locks', async () => {
  fresh({ access: ['panel:style'], editorOff: ['sidePanel'] });
  await mount();
  await click(row('Client', 'Permissions'));
  await click(permissionSwitch('All Left panel'));
  const access = savedClient().access;
  assert.ok(access.includes('panel:pages'));
  for (const locked of ['panel:code', 'panel:ai', 'panel:history', 'panel:variables', 'panel:selectors']) {
    assert.ok(!access.includes(locked), locked);
  }
  await unmount();
});
