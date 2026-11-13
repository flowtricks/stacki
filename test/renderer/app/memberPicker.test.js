// Goal: a role card's members show their GitHub picture (an initial until it loads), the
// username field suggests GitHub users after a pause in typing, and the keyboard drives the
// list: ArrowDown and ArrowUp move, Enter picks the highlighted user or adds the typed text,
// Escape closes, a click picks. While a newer search is pending the list stays mounted and
// narrows the last answer at once; the answer then lands in place without remounting rows,
// a late answer for older text is ignored, and the highlight follows its login while the
// row stays listed. A failed search is one quiet row and Add still works. The
// apps section offers the project's installed apps in the app's dropdown, or says none are
// installed.
// Method: bundle the real RoleCard (with MemberPicker, RoleAppPicker and their bridges)
// through esbuild, mount it in jsdom with a fake `window.avb` that records every search and
// answers from a table (or from promises the test settles by hand, to order replies), and
// drive it with key events and clicks on real timers. Element identity across renders shows
// that the list and its rows were kept rather than remounted.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/member-picker.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: "export { RoleCard } from './src/app/settings/RoleCard';\nexport { MEMBER_UNAVAILABLE_TEXT } from './src/app/settings/MemberPicker';",
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
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
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const searches = [];
let answer = () => ({ users: [], github: 'searched' });
let installedApps = [];
window.avb = {
  githubSearchUsers: async (input) => {
    searches.push(input);
    return answer(input.query);
  },
  listApps: async () => ({ ok: true, value: installedApps }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const card = require(output);

const suggestion = (login, name) => ({ login, ...(name ? { name } : {}), avatarURL: 'https://avatars.githubusercontent.com/u/1?s=40', source: 'search' });
const settle = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

let root;
let role;
const added = [];
const allowed = [];
async function mount(members = ['flowtricks'], access = []) {
  added.length = 0;
  allowed.length = 0;
  role = { id: 'writer', name: 'Writer', members, access, appPermissions: {}, pinnedApps: [] };
  const actions = {
    rename: () => undefined,
    remove: () => undefined,
    addMember: (login) => {
      added.push(login);
      return true;
    },
    removeMember: () => undefined,
    toggle: () => undefined,
    setAppAccess: (appId, change) => {
      allowed.push(`${change} ${appId}`);
    },
    setAppPermissions: () => undefined,
    setPinnedApp: () => undefined,
    orderPinnedApps: () => undefined,
    duplicate: () => undefined,
  };
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(card.RoleCard, { role, editable: true, actions, projectPath: '/project' })));
  await settle(10);
}
async function unmount() {
  await act(async () => root.unmount());
}
const input = () => document.querySelector('input[aria-label="Add a GitHub username to Writer"]');
const options = () => [...document.querySelectorAll('[role="option"]')];
const logins = () => [...document.querySelectorAll('[role="option"] .app-role-suggestion-login')].map((login) => login.textContent);
const statusText = () => document.querySelector('.app-role-suggestion-status')?.textContent;
const highlighted = () => options().findIndex((option) => option.getAttribute('aria-selected') === 'true');
async function type(value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input(), value);
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function key(name) {
  await act(async () => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    const allowedDefault = input().dispatchEvent(event);
    // The jsdom window does not submit a form on Enter; do what a browser does when the key is not taken.
    if (name === 'Enter' && allowedDefault) {
      input().form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    }
  });
}

test('member chips show a picture over an initial, and keep their remove button', async () => {
  await mount(['flowtricks', 'not a login']);
  const chips = [...document.querySelectorAll('.app-role-chip')];
  assert.equal(chips.length, 2);
  const avatar = chips[0].querySelector('.history-avatar');
  assert.equal(avatar.textContent.trim(), 'F', 'the initial is drawn under the picture');
  assert.equal(avatar.querySelector('img').getAttribute('src'), 'https://github.com/flowtricks.png?size=40');
  assert.ok(chips[0].querySelector('button[aria-label="Remove flowtricks"]'));
  assert.equal(chips[1].querySelector('img') ?? undefined, undefined, 'a name that is not a login has no picture, only its initial');
  await unmount();
});

test('suggestions wait for a pause and send only the typed query', async () => {
  searches.length = 0;
  answer = () => ({ users: [suggestion('octocat', 'The Octocat'), suggestion('octodog')], github: 'searched' });
  await mount();
  await type('o');
  await type('oc');
  await type('octo');
  await settle(100);
  assert.equal(searches.length, 0, 'nothing is sent while typing continues');
  await settle(250);
  assert.deepEqual(searches, [{ projectPath: '/project', query: 'octo' }]);
  assert.deepEqual(
    options().map((option) => option.textContent),
    ['OoctocatThe Octocat', 'Ooctodog'],
  );
  assert.equal(input().getAttribute('aria-expanded'), 'true');
  await type('-bad');
  await settle(300);
  assert.equal(searches.length, 1, 'text that cannot start a login is never sent');
  assert.equal(options().length, 0);
  await unmount();
});

test('ArrowDown and ArrowUp move, Enter picks the highlighted user', async () => {
  answer = () => ({ users: [suggestion('octocat'), suggestion('octodog'), suggestion('octopus')], github: 'searched' });
  await mount();
  await type('octo');
  await settle(300);
  assert.equal(highlighted(), -1, 'no row is highlighted until the keyboard moves');
  await key('ArrowDown');
  assert.equal(highlighted(), 0);
  await key('ArrowDown');
  await key('ArrowDown');
  await key('ArrowDown');
  assert.equal(highlighted(), 2, 'the highlight stops at the last row');
  assert.equal(input().getAttribute('aria-activedescendant'), options()[2].id);
  await key('ArrowUp');
  assert.equal(highlighted(), 1);
  await key('Enter');
  assert.deepEqual(added, ['octodog']);
  assert.equal(input().value, '');
  assert.equal(options().length, 0, 'picking closes the list');
  await unmount();
});

test('Enter with no highlighted row adds the typed text; Escape closes; a click picks', async () => {
  answer = () => ({ users: [suggestion('octocat')], github: 'searched' });
  await mount();
  await type('octo');
  await settle(300);
  await key('Escape');
  assert.equal(options().length, 0);
  await key('Enter');
  assert.deepEqual(added, ['octo'], 'the typed text is added as it is');
  await type('octo');
  await settle(300);
  await key('ArrowDown');
  await key('ArrowUp');
  assert.equal(highlighted(), -1, 'ArrowUp from the first row returns to the typed text');
  await act(async () => options()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(added, ['octo', 'octocat']);
  await unmount();
});

test('existing members are not suggested, and a failed search is one quiet row', async () => {
  answer = () => ({ users: [suggestion('flowtricks'), suggestion('flowbot')], github: 'unavailable' });
  await mount();
  await type('flow');
  await settle(300);
  assert.deepEqual(
    options().map((option) => option.textContent),
    ['Fflowbot'],
  );
  assert.equal(document.querySelector('.app-role-suggestion-status').textContent, card.MEMBER_UNAVAILABLE_TEXT);
  answer = () => {
    throw new Error('offline');
  };
  await type('flowx');
  await settle(300);
  assert.equal(options().length, 0);
  assert.equal(document.querySelector('.app-role-suggestion-status').textContent, card.MEMBER_UNAVAILABLE_TEXT);
  await act(async () => input().form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(added, ['flowx'], 'Add works without GitHub');
  await unmount();
});

test('the list stays mounted while a search is pending and narrows the last answer at once', async () => {
  searches.length = 0;
  answer = (query) =>
    query === 'octo'
      ? { users: [suggestion('octocat'), suggestion('octodog'), suggestion('octopus')], github: 'searched' }
      : { users: [suggestion('octocat'), suggestion('octocatalog')], github: 'searched' };
  await mount();
  await type('octo');
  await settle(300);
  const list = document.querySelector('[role="listbox"]');
  const octocat = options()[0];
  assert.deepEqual(logins(), ['octocat', 'octodog', 'octopus']);
  await type('octoc');
  assert.equal(document.querySelector('[role="listbox"]'), list, 'the list is not unmounted by a keystroke');
  assert.equal(input().getAttribute('aria-expanded'), 'true');
  assert.equal(list.getAttribute('aria-busy'), 'true', 'the new search is pending');
  assert.deepEqual(logins(), ['octocat'], 'the last answer narrows before any request');
  assert.equal(searches.length, 1);
  await settle(300);
  assert.deepEqual(searches.at(-1), { projectPath: '/project', query: 'octoc' });
  assert.equal(document.querySelector('[role="listbox"]'), list);
  assert.deepEqual(logins(), ['octocat', 'octocatalog'], 'the answer merges in');
  assert.equal(options()[0], octocat, 'a row that stays is not remounted, so its picture does not reload');
  assert.equal(list.getAttribute('aria-busy'), 'false');
  await unmount();
});

test('with nothing left to show the list says No matches while pending, then closes', async () => {
  answer = (query) => ({ users: query === 'octo' ? [suggestion('octocat')] : [], github: 'searched' });
  await mount();
  await type('octo');
  await settle(300);
  await type('octoz');
  assert.equal(options().length, 0);
  assert.equal(statusText(), 'No matches', 'a pending search keeps the list open with a quiet row');
  await settle(300);
  assert.equal(document.querySelector('[role="listbox"]') ?? undefined, undefined, 'no matches at all closes the list');
  assert.equal(input().getAttribute('aria-expanded'), 'false');
  await unmount();
});

test('a late answer for older text is ignored, and kept for backspacing', async () => {
  searches.length = 0;
  const pending = new Map();
  answer = (query) => new Promise((resolve) => pending.set(query, resolve));
  await mount();
  await type('octo');
  await settle(300);
  await type('octop');
  await settle(300);
  assert.deepEqual(
    searches.map((search) => search.query),
    ['octo', 'octop'],
  );
  await act(async () => pending.get('octop')({ users: [suggestion('octopus')], github: 'searched' }));
  await act(async () => pending.get('octo')({ users: [suggestion('octocat'), suggestion('octodog')], github: 'searched' }));
  await settle(10);
  assert.deepEqual(logins(), ['octopus'], 'the older answer did not overwrite the newer one');
  await type('octo');
  assert.deepEqual(logins(), ['octocat', 'octodog'], 'backspacing shows the remembered answer at once');
  await settle(300);
  assert.equal(searches.length, 2, 'a remembered answer sends no request');
  await unmount();
});

test('the highlight stays on its user while typing, and goes when the row leaves', async () => {
  answer = (query) => ({
    users: [suggestion('octocat'), suggestion('octodog'), suggestion('octopus')].filter((user) => user.login.startsWith(query)),
    github: 'searched',
  });
  await mount();
  await type('octo');
  await settle(300);
  await key('ArrowDown');
  await key('ArrowDown');
  assert.equal(highlighted(), 1);
  await type('octod');
  assert.deepEqual(logins(), ['octodog']);
  assert.equal(highlighted(), 0, 'the highlighted user is still highlighted after narrowing');
  await settle(300);
  assert.equal(highlighted(), 0, 'and after the answer lands');
  assert.equal(input().getAttribute('aria-activedescendant'), options()[0].id);
  await type('octo');
  assert.equal(highlighted(), 1, 'widening keeps it on the same user');
  await type('octop');
  assert.equal(highlighted(), -1, 'the row left, so the highlight went with it');
  await type('octo');
  assert.equal(highlighted(), -1, 'and does not come back by surprise');
  await unmount();
});

test('each installed app has its own access switch, with its icon; Every app fixes them on', async () => {
  installedApps = [];
  await mount();
  assert.equal(document.querySelector('.app-role-app-group') ?? undefined, undefined, 'no apps, no sections');
  assert.equal(document.querySelector('[aria-label="Allow an app for Writer"]') ?? undefined, undefined, 'the old picker is gone');
  await unmount();

  const app = (id, name) => ({
    manifest: {
      manifestVersion: 1,
      id,
      name,
      version: '1.0.0',
      description: 'An app.',
      icon: id === 'seo' ? 'icon.svg' : undefined,
      entry: 'index.html',
      capabilities: [],
      window: { mode: 'panel', widthPx: undefined, heightPx: undefined },
      source: undefined,
      authorGitHub: undefined,
      permissions: [],
    },
    lock: {
      id,
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      installedAt: '2026-11-01T00:00:00.000Z',
      source: { kind: 'file', fileName: `${id}.zip` },
      granted: [],
      pending: undefined,
    },
  });
  const access = (name) => document.querySelector(`[role="switch"][aria-label="Writer can use ${name}"]`);
  installedApps = [app('seo', 'SEO checker'), app('heatmap', 'Heatmap')];
  await mount(['flowtricks'], ['panel:apps', 'app:seo']);
  assert.equal(access('SEO checker').getAttribute('aria-checked'), 'true', 'an allowed app reads on');
  assert.equal(access('Heatmap').getAttribute('aria-checked'), 'false', 'a new app is off for a role without Every app');
  assert.equal(document.querySelector('select') ?? undefined, undefined, 'never a native select');
  const group = (name) => document.querySelector(`[role="group"][aria-label="${name} permissions"]`);
  assert.equal(group('SEO checker').querySelector('img').getAttribute('src'), 'stacki-app://seo/icon.svg');
  assert.ok(group('Heatmap').querySelector('svg'), 'an app with no icon shows the placeholder');
  assert.ok(group('Heatmap').classList.contains('is-off'), 'an app the role cannot use reads muted');
  assert.doesNotMatch(document.body.textContent, /cannot use this app/, 'the switch says it; no sentence does');
  await act(async () => access('Heatmap').click());
  await act(async () => access('SEO checker').click());
  assert.deepEqual(allowed, ['grant heatmap', 'withdraw seo']);
  await unmount();

  await mount(['flowtricks'], ['panel:apps', 'app:*']);
  for (const name of ['SEO checker', 'Heatmap']) {
    assert.equal(access(name).getAttribute('aria-checked'), 'true', `Every app covers ${name}, installed now or later`);
    assert.equal(access(name).disabled, true, 'and fixes it until Every app goes off');
  }
  assert.equal(document.querySelector('[role="switch"][aria-label="Every app"]').getAttribute('aria-checked'), 'true');
  await unmount();
});

test('headings carry the roles icon, and permissions start collapsed and remember being opened', async () => {
  installedApps = [];
  await mount(['flowtricks'], ['panel:pages', 'publish', 'app:*']);
  assert.ok(document.querySelector('.app-role-heading .app-role-heading-icon svg'), 'the heading starts with the people icon');
  const toggle = document.querySelector('.app-role-permissions-toggle');
  assert.match(toggle.textContent, /^PermissionsOn 3 of \d+$/);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  const body = document.getElementById(toggle.getAttribute('aria-controls'));
  assert.equal(body.hasAttribute('inert'), true, 'a collapsed grid takes no focus');
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hasAttribute('inert'), false);
  await unmount();
  await mount(['flowtricks'], ['panel:pages']);
  assert.equal(document.querySelector('.app-role-permissions-toggle').getAttribute('aria-expanded'), 'true', 'the role stays open for the session');
  await unmount();
});
