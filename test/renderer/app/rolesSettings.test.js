// Goal: Settings → Roles saves every change at once, like every other tab: an
// admin adds a role, its members and access, renames roles (Client included,
// by name only), and each accepted change writes a valid `.stacki/roles.json`
// with a brief "Saved"; a change that would leave no admin, lock the saver out
// or reuse a name is refused before any write, never shows, and says why beside
// its control; a failed write puts the controls back and offers Retry; the
// group "All" switches set a whole group; a non-admin sees it read-only; and
// "View as" changes the active role without writing anything; and "Pinned to
// sidebar" pins and unpins a role's apps (admin's too) from a multi-select menu
// that stays open, saving each choice at once and offering only apps the role may use.
// Method: bundle the real RolesSettings with the real role store and edit model
// through esbuild, mount it in jsdom with a fake bridge that records metadata
// writes (and can fail the next one), drive it with clicks, typing and form
// submits, and read each write back with the shared parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/roles-settings.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { RolesSettings } from './src/app/settings/RolesSettings';",
      "export { roleNameFor, renameRole } from './src/app/settings/rolesEdits';",
      "export * from './src/lib/currentRole';",
      "export { subscribeErrorToasts } from './src/ui/errorNotices';",
      "export { ConfirmHost } from './src/ui/ConfirmDialog';",
      "export { deleteRoleSummary } from './src/app/settings/RolesSettings';",
      "export { parseProjectRolesSource, roleViewOf, DEFAULT_PROJECT_ROLES, ADMIN_VIEW } from './shared/properties/projectRoles';",
    ].join('\n'),
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
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let stored;
const writes = [];
let login = 'owner';
let failNext = false;
window.avb = {
  projectMetadata: async () => ({ ok: true, value: stored === undefined ? {} : { source: stored } }),
  writeProjectMetadata: async (input) => {
    if (failNext) {
      failNext = false;
      return { ok: false, error: { code: 'io', message: 'Disk full' } };
    }
    writes.push(input.write);
    stored = input.write.source;
    return { ok: true, value: { source: stored } };
  },
  rolesIdentity: async () => ({ login }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const roles = require(output);
const toasts = [];
roles.subscribeErrorToasts(
  (notice) => toasts.push(notice.message),
  () => undefined,
);

let root;
async function mount() {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(roles.RolesSettings, { projectPath: '/project' })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
async function choose(label, name) {
  await click(document.querySelector(`button[aria-label="${label}"]`));
  const option = [...document.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === name);
  assert.ok(option, `${label} offers ${name}`);
  await click(option);
}
async function unmount() {
  await act(async () => root.unmount());
}
const card = (name) => document.querySelector(`section[aria-label="${name} role"]`);
const button = (scope, label) =>
  [...scope.querySelectorAll('button')].find((item) => item.textContent.trim() === label || item.getAttribute('aria-label') === label);
async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function submit(form) {
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
}
async function click(element) {
  await act(async () => element.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const saved = () => roles.parseProjectRolesSource(stored);
const notice = (scope) => scope.querySelector('.app-settings-notice')?.textContent ?? '';
const permission = (name, label) => card(name).querySelector(`[role="switch"][aria-label="${label}"]`);
async function rename(name, value, key = 'Enter') {
  await click(card(name).querySelector(`button[aria-label="Rename ${name}"]`));
  const input = card(name).querySelector('input[aria-label="Role name"]');
  assert.equal(document.activeElement, input, 'clicking the name focuses its field');
  await type(input, value);
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

test('each change saves at once: the first creates the file, and each writes a valid one', async () => {
  stored = undefined;
  writes.length = 0;
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  assert.equal(writes.length, 0, 'opening the tab writes nothing');
  assert.equal(document.querySelectorAll('button.primary').length, 0, 'there is no Save button');
  const admin = card('Admin');
  assert.match(admin.textContent, /Full access/);
  assert.equal(admin.querySelectorAll('[role="switch"]').length, 0, 'admin access is not editable');
  assert.ok(admin.querySelector('button[aria-label="Rename Admin"]') === null, 'Admin is always Admin');
  assert.match(admin.textContent, /owner/, 'a new file names the signed-in person as admin');

  await type(document.querySelector('input[aria-label="New role name"]'), 'Writer');
  await submit(document.querySelector('.app-roles-new'));
  assert.equal(writes.length, 1, 'adding a role saves');
  assert.equal(writes[0].base, undefined, 'the first save creates the file');
  assert.equal(document.querySelector('.app-settings-saved').dataset.state, 'saved', 'a brief "Saved" follows');
  assert.match(document.querySelector('.app-settings-saved').textContent, /Saved/);

  const writer = card('Writer');
  await type(writer.querySelector('input[aria-label="Add a GitHub username to Writer"]'), 'Sam');
  await submit(writer.querySelector('.app-role-add'));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].base, writes[0].source, 'each save is over the text the last one wrote');
  assert.ok(permission('Writer', 'CMS').closest('.app-role-toggle').querySelector('.app-role-toggle-icon svg'), 'each permission has its icon');
  await click(permission('Writer', 'CMS'));
  assert.equal(permission('Writer', 'CMS').getAttribute('aria-checked'), 'true');
  assert.equal(writes.length, 3, 'a switch saves on its own');
  const file = saved();
  assert.deepEqual(file.roles[0].members, ['owner']);
  const savedWriter = file.roles.find((role) => role.id === 'writer');
  assert.deepEqual(savedWriter.members, ['Sam']);
  assert.deepEqual(savedWriter.access, ['panel:cms']);
  await unmount();
});

test("a group's All switch sets the whole group, and reads on only when all are on", async () => {
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', access: [] },
    ],
  });
  writes.length = 0;
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  const all = card('Client').querySelector('[role="switch"][aria-label="All Pages"]');
  assert.equal(all.getAttribute('aria-checked'), 'false');
  await click(all);
  assert.deepEqual(saved().roles[1].access, ['page:create', 'page:delete', 'page:rename', 'page:layout']);
  assert.equal(card('Client').querySelector('[role="switch"][aria-label="All Pages"]').getAttribute('aria-checked'), 'true');
  await click(permission('Client', 'Delete pages'));
  assert.equal(card('Client').querySelector('[role="switch"][aria-label="All Pages"]').getAttribute('aria-checked'), 'false', 'a mixed group reads as off');
  await click(card('Client').querySelector('[role="switch"][aria-label="All Pages"]'));
  assert.equal(saved().roles[1].access.length, 4, 'switching a mixed group on grants all of it');
  await click(card('Client').querySelector('[role="switch"][aria-label="All Pages"]'));
  assert.deepEqual(saved().roles[1].access, [], 'and off withdraws all of it');
  await unmount();
});

test('roles are renamed in place, Client included, and a bad name is refused beside it', async () => {
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'writer', name: 'Writer', access: [] },
    ],
  });
  writes.length = 0;
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  await rename('Client', 'Customer');
  assert.ok(card('Customer'), 'the card shows the new name');
  const client = saved().roles.find((role) => role.id === 'client');
  assert.equal(client.name, 'Customer', 'Client keeps its id and takes the new name');
  assert.equal(saved().defaultRole, 'admin');

  const before = writes.length;
  await rename('Customer', 'writer');
  assert.equal(writes.length, before, 'a taken name, in any case, is not saved');
  assert.match(notice(card('Customer')), /There is already a role named Writer/);
  assert.ok(card('Customer').querySelector('button[aria-label="Rename Customer"]'), 'the name is back to the saved one');
  await rename('Customer', '   ');
  assert.match(notice(card('Customer')), /A role needs a name/);
  await rename('Customer', 'Ignored', 'Escape');
  assert.equal(writes.length, before, 'Escape cancels without saving');
  assert.ok(card('Customer'));
  await unmount();

  // The edit model's own checks.
  const parsed = roles.parseProjectRolesSource(stored);
  assert.equal(roles.roleNameFor(parsed, 'client', '  Agency  '), 'Agency');
  assert.equal(roles.roleNameFor(parsed, 'client', 'customer'), 'customer', 'a role may change the case of its own name');
  assert.throws(() => roles.roleNameFor(parsed, undefined, 'x'.repeat(61)), /at most 60 characters/);
  assert.throws(() => roles.roleNameFor(parsed, undefined, 'ADMIN'), /There is already a role named Admin/);
  assert.throws(() => roles.renameRole(parsed, 'admin', 'Boss'), /Assertion failed: Admin keeps its name/);
});

test('a change that would leave no admin or lock you out is refused before any write', async () => {
  writes.length = 0;
  stored = JSON.stringify({ version: 1, roles: [{ id: 'admin', name: 'Admin', members: ['owner', 'other'] }] });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  const client = card('Client');
  await type(client.querySelector('input[aria-label="Add a GitHub username to Client"]'), 'OWNER');
  await submit(client.querySelector('.app-role-add'));
  assert.equal(writes.length, 0, 'nothing is written');
  assert.match(notice(card('Client')), /remove your admin access/, 'the reason shows beside the change');
  assert.doesNotMatch(card('Client').querySelector('.app-role-members ul').textContent, /OWNER/, 'the refused change never shows');

  await click(card('Admin').querySelector('button[aria-label="Remove other"]'));
  assert.equal(writes.length, 1, 'removing another admin saves');
  await click(card('Admin').querySelector('button[aria-label="Remove owner"]'));
  assert.equal(writes.length, 1, 'the last admin cannot be removed');
  assert.match(notice(card('Admin')), /At least one person must be an admin/);
  assert.match(card('Admin').textContent, /owner/);
  await unmount();
});

test('a failed save puts the control back and offers Retry', async () => {
  writes.length = 0;
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', access: [] },
    ],
  });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  failNext = true;
  await click(permission('Client', 'CMS'));
  assert.equal(writes.length, 0);
  assert.equal(permission('Client', 'CMS').getAttribute('aria-checked'), 'false', 'the switch returns to the saved value');
  assert.match(notice(card('Client')), /Not saved: Disk full/);
  await click(button(card('Client'), 'Retry'));
  assert.equal(writes.length, 1, 'Retry saves the change');
  assert.deepEqual(saved().roles[1].access, ['panel:cms']);
  assert.equal(permission('Client', 'CMS').getAttribute('aria-checked'), 'true');
  assert.equal(notice(card('Client')), '', 'and the notice goes');
  await unmount();
});

test('a non-admin sees roles read-only', async () => {
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', members: ['acme'] },
    ],
  });
  login = 'acme';
  roles.setActualRole(roles.roleViewOf(roles.parseProjectRolesSource(stored), 'client'));
  await mount();
  assert.match(document.body.textContent, /Only admins can change roles/);
  assert.ok(document.querySelector('input[aria-label="New role name"]') === null, 'no new-role field');
  assert.ok(document.querySelector('.app-role-name-button') === null, 'no rename');
  for (const toggle of document.querySelectorAll('[role="switch"]')) {
    assert.equal(toggle.disabled, true);
  }
  assert.ok(document.querySelector('[aria-label="View as"]') === null, 'only an admin can view as another role');
  await unmount();
  login = 'owner';
});

test('"View as" previews a role without writing, and ends with Admin', async () => {
  writes.length = 0;
  stored = JSON.stringify({ version: 1, roles: [{ id: 'admin', members: ['owner'] }] });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  await choose('View as', 'Client');
  assert.equal(roles.currentRole().id, 'client');
  assert.equal(roles.actualRole().isAdmin, true, 'the resolved role is unchanged');
  assert.match(document.body.textContent, /Only admins can change roles/, 'the preview shows the client’s read-only tab');
  await choose('View as', 'Admin');
  assert.equal(roles.currentRole().isAdmin, true);
  assert.equal(writes.length, 0, '"View as" never writes the file');
  roles.setViewAs(roles.roleViewOf(roles.DEFAULT_PROJECT_ROLES, 'client'));
  roles.setActualRole(roles.roleViewOf(roles.DEFAULT_PROJECT_ROLES, 'client'));
  assert.equal(roles.viewingAs(), undefined, 'a non-admin cannot keep a preview');
  assert.throws(() => roles.setViewAs(roles.ADMIN_VIEW), /Only an admin can view as another role/);
  roles.setActualRole(roles.ADMIN_VIEW);
  await unmount();
});

// App permissions: each installed app that declares `permissions` is its own group under Apps,
// with its name, an "All" switch and one switch per permission; they save at once, and stay
// disabled with a hint while the role may not use the app.
test('installed apps’ permissions show as their own groups, save at once, and wait for the app grant', async () => {
  writes.length = 0;
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', access: ['panel:apps'] },
      { id: 'writer', name: 'Writer', access: ['panel:apps', 'app:feedback-pins'], appPermissions: { 'uninstalled-app': { anything: true } } },
    ],
  });
  const manifest = {
    manifestVersion: 1,
    id: 'feedback-pins',
    name: 'Feedback pins',
    version: '1.0.0',
    entry: 'index.html',
    permissions: [
      { id: 'resolve-threads', label: 'Resolve threads', description: 'Mark a thread resolved.', default: true },
      { id: 'delete-any-comment', label: 'Delete any comment', default: false },
    ],
  };
  const lock = {
    id: 'feedback-pins',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00.000Z',
    source: { kind: 'local' },
    autoUpdate: false,
  };
  const plain = { ...manifest, id: 'plain', name: 'Plain', permissions: undefined };
  window.avb.listApps = async () => ({
    ok: true,
    value: [
      { manifest, lock },
      { manifest: plain, lock: { ...lock, id: 'plain' } },
    ],
  });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  const group = (name) => card(name).querySelector('[role="group"][aria-label="Feedback pins permissions"]');
  assert.ok(group('Writer'), 'the app has its own group');
  const plainGroup = card('Writer').querySelector('[aria-label="Plain permissions"]');
  assert.ok(plainGroup, 'an app that declares no permissions still has its section, for its access switch');
  assert.equal(plainGroup.querySelectorAll('[role="switch"]').length, 1, 'just the access switch');
  assert.match(group('Writer').textContent, /Mark a thread resolved\./, 'the description shows');
  const groups = [...card('Writer').querySelectorAll('.app-role-group')];
  const appsIndex = groups.findIndex((item) => item.querySelector('h4')?.textContent === 'Apps');
  assert.equal(groups[appsIndex + 1], group('Writer'), 'it sits right under the Apps group');
  assert.equal(permission('Writer', 'Resolve threads').getAttribute('aria-checked'), 'true', 'the default shows');
  assert.equal(permission('Writer', 'Delete any comment').getAttribute('aria-checked'), 'false');
  assert.equal(permission('Writer', 'All Feedback pins permissions').getAttribute('aria-checked'), 'false', 'mixed reads as off');

  await click(permission('Writer', 'Delete any comment'));
  const writer = () => saved().roles.find((role) => role.id === 'writer');
  assert.deepEqual(
    writer().appPermissions,
    { 'uninstalled-app': { anything: true }, 'feedback-pins': { 'delete-any-comment': true } },
    'saved at once; stray ids kept',
  );
  assert.equal(permission('Writer', 'All Feedback pins permissions').getAttribute('aria-checked'), 'true');
  await click(permission('Writer', 'All Feedback pins permissions'));
  assert.deepEqual(writer().appPermissions['feedback-pins'], { 'delete-any-comment': false, 'resolve-threads': false }, 'All turns every one off');

  // Client has the Apps panel but not this app: its switches read off and muted, with no sentence.
  const access = (name) => permission(name, `${name} can use Feedback pins`);
  assert.equal(access('Client').getAttribute('aria-checked'), 'false');
  assert.ok(group('Client').classList.contains('is-off'));
  assert.equal(permission('Client', 'Resolve threads').getAttribute('aria-checked'), 'false', 'a switch with no effect never reads on');
  assert.equal(permission('Client', 'All Feedback pins permissions').getAttribute('aria-checked'), 'false');
  assert.doesNotMatch(card('Client').textContent, /cannot use this app/);

  // Turning a permission on grants the app too, in one save.
  const before = writes.length;
  await click(permission('Client', 'Delete any comment'));
  assert.equal(writes.length, before + 1, 'one save');
  const client = () => saved().roles.find((role) => role.id === 'client');
  assert.ok(client().access.includes('app:feedback-pins'), 'the app is granted with its permission');
  assert.equal(client().appPermissions['feedback-pins']['delete-any-comment'], true);
  assert.equal(access('Client').getAttribute('aria-checked'), 'true');
  assert.equal(permission('Client', 'Resolve threads').getAttribute('aria-checked'), 'true', 'the default applies now');

  // Turning the app off keeps its values, shown off; turning it back on restores them.
  await click(access('Client'));
  assert.ok(!client().access.includes('app:feedback-pins'));
  assert.equal(client().appPermissions['feedback-pins']['delete-any-comment'], true, 'the saved value stays');
  assert.equal(permission('Client', 'Delete any comment').getAttribute('aria-checked'), 'false', 'shown off while it has no effect');
  await click(access('Client'));
  assert.equal(permission('Client', 'Delete any comment').getAttribute('aria-checked'), 'true', 'restored');

  delete window.avb.listApps;
  await unmount();
});

const pinApp = (id, name) => ({
  manifest: { manifestVersion: 1, id, name, version: '1.0.0', entry: 'index.html' },
  lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-11-10T00:00:00.000Z', source: { kind: 'local' }, autoUpdate: false },
});
const pinRows = (name) => [...card(name).querySelectorAll('.app-role-pin-list > li')];
const pinNames = (name) => pinRows(name).map((row) => row.querySelector('.app-role-pin-name').textContent);
const pinsOf = (id) => saved().roles.find((role) => role.id === id).pinnedApps;
async function pinKey(row, key) {
  await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
async function pointer(target, type, clientY) {
  await act(async () => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY })));
}

test('every role pins several apps of its own, in its own order, from "Add app", and View as shows them', async () => {
  writes.length = 0;
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', access: ['panel:apps', 'app:seo', 'app:crm'] },
      { id: 'writer', name: 'Writer', access: ['panel:apps', 'app:seo'], pinnedApps: ['gone'] },
    ],
  });
  window.avb.listApps = async () => ({ ok: true, value: [pinApp('seo', 'SEO'), pinApp('crm', 'CRM'), pinApp('secret', 'Secret')] });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  for (const name of ['Admin', 'Client', 'Writer']) {
    const pins = card(name).querySelector('.app-role-pins');
    assert.ok(pins, `${name} has its own pinned list`);
    assert.equal(pins.closest('.app-role-permissions') ?? undefined, undefined, `${name}'s pins sit outside the collapsed permissions`);
  }
  // A stale pin shows muted with its reason, and can be removed.
  assert.deepEqual(pinNames('Writer'), ['gone']);
  assert.match(pinRows('Writer')[0].textContent, /Not installed/);
  assert.ok(pinRows('Writer')[0].classList.contains('is-ignored'));

  // Admin pins three apps one after another; each saves at once and goes last.
  await choose('Pin an app to the sidebar for Admin', 'SEO');
  await choose('Pin an app to the sidebar for Admin', 'CRM');
  await choose('Pin an app to the sidebar for Admin', 'Secret');
  assert.deepEqual(pinsOf('admin'), ['seo', 'crm', 'secret']);
  assert.deepEqual(pinNames('Admin'), ['SEO', 'CRM', 'Secret']);
  assert.equal(writes.length, 3, 'each pin saves on its own');

  // Client may use SEO and CRM only, and pins them in the other order.
  await click(card('Client').querySelector('button[aria-label="Pin an app to the sidebar for Client"]'));
  const offered = [...document.querySelectorAll('.dd-option')].map((option) => option.textContent);
  assert.deepEqual(offered, ['SEO', 'CRM', 'SecretAlso gives Client access'], 'every unpinned app; one without access says pinning grants it');
  await click([...document.querySelectorAll('.dd-option')].find((option) => option.textContent.includes('CRM')));
  await choose('Pin an app to the sidebar for Client', 'SEO');
  assert.deepEqual(pinsOf('client'), ['crm', 'seo']);
  assert.deepEqual(pinsOf('admin'), ['seo', 'crm', 'secret'], 'roles keep their own pins and orders');

  // Remove, and the stale one too.
  await click(card('Writer').querySelector('button[aria-label="Unpin gone"]'));
  assert.deepEqual(pinsOf('writer'), []);
  await click(card('Admin').querySelector('button[aria-label="Unpin CRM"]'));
  assert.deepEqual(pinsOf('admin'), ['seo', 'secret']);

  // View as Client puts Client's pins, in Client's order, on the active role.
  await choose('View as', 'Client');
  assert.deepEqual(roles.currentRole().pinnedApps, ['crm', 'seo']);
  roles.setViewAs(undefined);
  delete window.avb.listApps;
  await unmount();
});

test('pins reorder by keyboard (Alt+↑/↓ on a row) and by dragging, saving the new order at once', async () => {
  writes.length = 0;
  stored = JSON.stringify({ version: 1, roles: [{ id: 'admin', members: ['owner'], pinnedApps: ['seo', 'crm', 'secret'] }] });
  window.avb.listApps = async () => ({ ok: true, value: [pinApp('seo', 'SEO'), pinApp('crm', 'CRM'), pinApp('secret', 'Secret')] });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  assert.deepEqual(pinNames('Admin'), ['SEO', 'CRM', 'Secret']);
  await pinKey(pinRows('Admin')[2], 'ArrowUp');
  assert.deepEqual(pinsOf('admin'), ['seo', 'secret', 'crm'], 'Alt+↑ moves a row up one place');
  await pinKey(pinRows('Admin')[0], 'ArrowDown');
  assert.deepEqual(pinsOf('admin'), ['secret', 'seo', 'crm'], 'Alt+↓ moves a row down one place');
  const before = writes.length;
  await pinKey(pinRows('Admin')[0], 'ArrowUp');
  assert.equal(writes.length, before, 'the first row cannot move up, and nothing is written');
  await act(async () => pinRows('Admin')[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  assert.equal(writes.length, before, 'an arrow without Alt moves nothing');

  // The jsdom window lays nothing out: give each row a 28px box with a 2px gap, so the pointer's half of a row picks the gap.
  const laidOut = () =>
    pinRows('Admin').forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 30, bottom: index * 30 + 28, height: 28, left: 0, right: 200, width: 200 });
    });
  const lines = () =>
    [...card('Admin').querySelectorAll('.app-role-pin-gap')].map((gap) => ({
      row: pinRows('Admin').indexOf(gap.closest('li')),
      side: gap.classList.contains('is-before') ? 'before' : 'after',
      line: gap.querySelectorAll('.drop-indicator').length,
    }));
  laidOut();
  await pointer(pinRows('Admin')[0].querySelector('.app-role-pin-grip'), 'pointerdown', 10);
  assert.deepEqual(lines(), [], 'a press alone draws no line');
  await pointer(window, 'pointermove', 40);
  assert.deepEqual(lines(), [{ row: 1, side: 'before', line: 1 }], 'over the upper half of the second row: the gap above it');
  assert.ok(pinRows('Admin')[0].classList.contains('is-dragging'), 'the dragged row fades');
  await pointer(window, 'pointermove', 50);
  assert.deepEqual(lines(), [{ row: 2, side: 'before', line: 1 }], 'over its lower half: the gap below it');
  await pointer(window, 'pointermove', 2);
  assert.deepEqual(lines(), [{ row: 0, side: 'before', line: 1 }], 'before the first row');
  await pointer(window, 'pointermove', 200);
  assert.deepEqual(lines(), [{ row: 2, side: 'after', line: 1 }], 'after the last row');
  for (const row of pinRows('Admin')) {
    assert.equal(row.style.borderColor, '', 'no row is recoloured');
    assert.ok(!row.classList.contains('drop-before'));
    assert.ok(!row.classList.contains('drop-after'));
  }
  await pointer(window, 'pointerup', 200);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.deepEqual(pinsOf('admin'), ['seo', 'crm', 'secret'], 'a dragged row lands where the line was');
  assert.deepEqual(pinNames('Admin'), ['SEO', 'CRM', 'Secret']);
  assert.deepEqual(lines(), [], 'the line goes with the drag');
  laidOut();
  await pointer(pinRows('Admin')[2], 'pointerdown', 70);
  await pointer(window, 'pointermove', 2);
  await pointer(window, 'pointerup', 2);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.deepEqual(pinsOf('admin'), ['secret', 'seo', 'crm']);
  delete window.avb.listApps;
  await unmount();
});

test('Duplicate copies a role after itself, without members, as "<Name> copy", and opens its name', async () => {
  writes.length = 0;
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'], pinnedApps: ['seo'] },
      { id: 'writer', name: 'Writer', members: ['sam'], access: ['panel:cms', 'panel:apps', 'app:seo'], pinnedApps: ['seo', 'crm'] },
      { id: 'editor', name: 'Editor', access: ['panel:pages'] },
    ],
  });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  await click(card('Writer').querySelector('button[aria-label="Duplicate Writer"]'));
  let file = saved();
  assert.deepEqual(
    file.roles.map((role) => role.name),
    ['Admin', 'Client', 'Writer', 'Writer copy', 'Editor'],
    'the copy sits right after its source',
  );
  const copy = file.roles[3];
  assert.deepEqual(copy.members, [], 'members never copy: a person is in one role');
  assert.deepEqual(copy.access, ['panel:cms', 'panel:apps', 'app:seo']);
  assert.deepEqual(copy.pinnedApps, ['seo', 'crm'], 'pins copy in order');
  assert.equal(document.activeElement, card('Writer copy').querySelector('input[aria-label="Role name"]'), 'the copy opens its name to rename');
  await act(async () => document.activeElement.blur());

  await click(card('Writer').querySelector('button[aria-label="Duplicate Writer"]'));
  file = saved();
  assert.equal(file.roles[3].name, 'Writer copy 2', 'a taken copy name counts on');

  await click(card('Admin').querySelector('button[aria-label="Duplicate Admin"]'));
  file = saved();
  const adminCopy = file.roles.find((role) => role.name === 'Admin copy');
  assert.notEqual(adminCopy.id, 'admin');
  assert.deepEqual(adminCopy.members, []);
  assert.ok(adminCopy.access.includes('app:*'), 'a copy of admin may use every app');
  assert.ok(adminCopy.access.includes('code:edit'));
  assert.ok(!adminCopy.access.includes('settings:roles'), 'but still cannot edit roles');
  assert.deepEqual(adminCopy.pinnedApps, ['seo']);
  assert.equal(file.roles[2].name, 'Admin copy', 'built-in roles lead the file, so the admin copy is the first custom role');
  assert.equal(card('Admin copy').previousElementSibling, card('Client'), 'and shows there before any reload');
  await unmount();
});

test('Delete asks first, Cancel keeps the role, and a deleted default or View as role falls back to Admin', async () => {
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  writes.length = 0;
  stored = JSON.stringify({
    version: 1,
    defaultRole: 'writer',
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'writer', name: 'Writer', members: ['sam', 'kim'], access: ['panel:cms'] },
      { id: 'editor', name: 'Editor', access: ['panel:pages'] },
    ],
  });
  roles.setActualRole(roles.ADMIN_VIEW);
  const hostContainer = document.createElement('div');
  document.body.append(hostContainer);
  const hostRoot = createRoot(hostContainer);
  await act(async () => hostRoot.render(React.createElement(roles.ConfirmHost)));
  await mount();
  assert.equal(card('Admin').querySelector('button[aria-label="Delete Admin"]') ?? undefined, undefined, 'Admin has no Delete');
  assert.equal(card('Client').querySelector('button[aria-label="Delete Client"]') ?? undefined, undefined, 'the parser always restores Client');
  const dialog = () => document.querySelector('[role="alertdialog"]') ?? document.querySelector('.confirm-dialog');
  const dialogButton = (label) => [...dialog().querySelectorAll('button')].find((item) => item.textContent === label);

  // Ask to delete Writer, then cancel: nothing changes.
  await click(card('Writer').querySelector('button[aria-label="Delete Writer"]'));
  assert.match(dialog().textContent, /Delete Writer\?/);
  assert.match(dialog().textContent, /Its 2 members \(sam, kim\) become people in no role\./);
  assert.match(dialog().textContent, /role for people in no role, so that becomes Admin/);
  assert.equal(document.activeElement, dialogButton('Cancel'), 'a destructive question starts on Cancel');
  await click(dialogButton('Cancel'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal(writes.length, 0, 'Cancel writes nothing');
  assert.ok(card('Writer'), 'the role stays');

  // Confirm: the role and its members go, the default and the view fall back to Admin.
  await click(card('Writer').querySelector('button[aria-label="Delete Writer"]'));
  await click(dialogButton('Delete role'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal(writes.length, 1, 'deleting saves at once');
  const file = saved();
  assert.deepEqual(
    file.roles.map((role) => role.id),
    ['admin', 'client', 'editor'],
  );
  assert.equal(file.defaultRole, 'admin', 'the deleted default falls back to Admin');
  assert.ok(!file.roles.some((role) => role.members.includes('sam')), 'its members leave with it');
  assert.equal(card('Writer') ?? undefined, undefined);
  assert.equal(
    roles.deleteRoleSummary(
      { id: 'editor', name: 'Editor', members: [], access: [], appPermissions: {}, pinnedApps: [] },
      { defaultRole: 'admin', viewing: undefined },
    ),
    'It has no members.',
  );
  // "View as" another role makes this tab read-only, so a viewed role is never deleted from it;
  // the confirmation and the fallback still cover it, should that ever change.
  assert.match(
    roles.deleteRoleSummary(
      { id: 'editor', name: 'Editor', members: ['ana'], access: [], appPermissions: {}, pinnedApps: [] },
      { defaultRole: 'editor', viewing: 'editor' },
    ),
    /^Its member \(ana\) becomes a person in no role\. It is the role for people in no role, so that becomes Admin\. You are viewing as it, so the view goes back to Admin\.$/,
  );
  await unmount();
  await act(async () => hostRoot.unmount());
});

test('"Add app" pins an app the role cannot use in one step, granting it (and the Apps panel) with a note', async () => {
  writes.length = 0;
  stored = JSON.stringify({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', access: ['panel:pages'] },
    ],
  });
  window.avb.listApps = async () => ({ ok: true, value: [pinApp('seo', 'SEO'), pinApp('crm', 'CRM')] });
  roles.setActualRole(roles.ADMIN_VIEW);
  await mount();
  await click(card('Client').querySelector('button[aria-label="Pin an app to the sidebar for Client"]'));
  const options = [...document.querySelectorAll('.dd-option')];
  assert.deepEqual(
    options.map((option) => option.textContent),
    ['SEOAlso gives Client access', 'CRMAlso gives Client access'],
    'every unpinned app is offered, none disabled',
  );
  assert.ok(options.every((option) => option.getAttribute('aria-disabled') !== 'true'));
  await click(options[1]);
  assert.equal(writes.length, 1, 'pinning and granting is one save');
  const client = saved().roles.find((role) => role.id === 'client');
  assert.deepEqual(client.pinnedApps, ['crm']);
  assert.ok(client.access.includes('app:crm'), 'the app is granted');
  assert.ok(client.access.includes('panel:apps'), 'with the Apps panel it needs');
  assert.ok(!client.access.includes('app:seo'), 'and nothing else');
  assert.ok(!pinRows('Client')[0].classList.contains('is-ignored'), 'the new pin is live on the rail');
  delete window.avb.listApps;
  await unmount();
});
