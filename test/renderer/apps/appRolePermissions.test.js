// Goal: an app hears its own permissions (docs/apps.md, "Permissions") exactly as
// the roles file resolves them for the current role: `role.get` carries them,
// `role.can` answers one (and fails for an id the manifest never declared), the
// values differ per role (admin all, a role without the app refused, defaults and
// explicit values otherwise), and an admin changing one in the roles file reaches
// a listening frame as `role.change` with that app's own values only.
// Method: one esbuild bundle of the apps runtime, the dispatcher, the role store
// and the roles contract (so they share module state) run against JSDOM. Two
// app frames are JSDOM iframes whose posts are recorded; requests are dispatched
// as message events from them. Roles are parsed from a real roles file, and a
// changed file is applied through `setActualRole`, as useProjectRoles does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<iframe id="pins"></iframe><iframe id="other"></iframe>', {
  url: 'http://localhost',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;

const directory = repoPath('node_modules/.stacki-test/app-role-permissions');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'bundle.cjs');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { configureAppsRuntime, attachAppFrame, emitRoleChange, resetAppsRuntime } from './src/features/apps/appsRuntime';",
      "export { currentRole, onRoleChange, setActualRole } from './src/lib/currentRole';",
      "export { ADMIN_VIEW, parseProjectRoles, roleViewOf } from './shared/properties/projectRoles';",
      "export { parseAppManifest } from './shared/properties/apps';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const apps = require(outfile);

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const summary = (manifest) => ({
  manifest: apps.parseAppManifest({ manifestVersion: 1, version: '1.0.0', entry: 'index.html', ...manifest }),
  lock: {
    id: manifest.id,
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00.000Z',
    source: { kind: 'local' },
    update: undefined,
    autoUpdate: false,
  },
});
const PINS = summary({
  id: 'feedback-pins',
  name: 'Feedback pins',
  permissions: [
    { id: 'resolve-threads', label: 'Resolve threads', default: true },
    { id: 'delete-any-comment', label: 'Delete any comment', default: false },
  ],
});
const OTHER = summary({ id: 'other', name: 'Other', permissions: [{ id: 'export', label: 'Export', default: true }] });
const rolesFile = (writer) =>
  apps.parseProjectRoles({
    version: 1,
    roles: [
      { id: 'admin', name: 'Admin', members: ['owner'] },
      { id: 'client', name: 'Client', access: ['panel:apps', 'app:other'] },
      { id: 'writer', name: 'Writer', access: ['panel:apps', 'app:*'], ...writer },
    ],
  });

// A frame: what it posts back is recorded; `ask` sends one request from it and waits for its answer.
function frame(id, app) {
  const element = dom.window.document.getElementById(id);
  const heard = [];
  element.contentWindow.postMessage = (message) => heard.push(message);
  const detach = apps.attachAppFrame(element.contentWindow, app);
  let next = 1;
  const ask = async (method, params) => {
    const requestId = next++;
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', { data: { stacki: 'app', v: 1, id: requestId, method, params }, source: element.contentWindow }),
    );
    await settle();
    return heard.find((message) => message.id === requestId);
  };
  return { heard, ask, detach };
}

test('role.get and role.can answer this app’s permissions for each role', async () => {
  apps.resetAppsRuntime();
  let role = apps.ADMIN_VIEW;
  apps.configureAppsRuntime({}, () => role);
  const pins = frame('pins', PINS);
  const roles = rolesFile({ appPermissions: { 'feedback-pins': { 'delete-any-comment': true }, other: { export: false } } });

  const asAdmin = await pins.ask('role.get');
  assert.deepEqual(asAdmin.value, { id: 'admin', name: 'Admin', isAdmin: true, permissions: { 'resolve-threads': true, 'delete-any-comment': true } });

  role = apps.roleViewOf(roles, 'writer');
  const asWriter = await pins.ask('role.get');
  assert.deepEqual(asWriter.value.permissions, { 'resolve-threads': true, 'delete-any-comment': true }, 'a default, then an explicit value');
  assert.equal((await pins.ask('role.can', { permission: 'resolve-threads' })).value, true);
  assert.equal((await pins.ask('role.can', { permission: 'delete-any-comment' })).value, true);

  role = apps.roleViewOf(rolesFile({ appPermissions: { 'feedback-pins': { 'resolve-threads': false } } }), 'writer');
  assert.equal((await pins.ask('role.can', { permission: 'resolve-threads' })).value, false, 'an explicit off wins over the default');
  assert.equal((await pins.ask('role.can', { permission: 'delete-any-comment' })).value, false, 'the default is off');

  const undeclared = await pins.ask('role.can', { permission: 'export' });
  assert.equal(undeclared.ok, false, 'another app’s permission is not this app’s');
  assert.match(undeclared.error.message, /declares no permission "export"/);
  assert.equal((await pins.ask('role.can', { permission: 'Not An Id' })).error.code, 'bad-params');

  // Client may not use this app: it is refused everything, its permissions included.
  role = apps.roleViewOf(roles, 'client');
  assert.equal((await pins.ask('role.get')).error.code, 'role-denied');
  assert.equal((await pins.ask('role.can', { permission: 'resolve-threads' })).error.code, 'role-denied');
  pins.detach();
  apps.resetAppsRuntime();
});

test('an admin changing a permission reaches each listening app as role.change with its own values', async () => {
  apps.resetAppsRuntime();
  apps.setActualRole(apps.roleViewOf(rolesFile({}), 'writer'));
  apps.configureAppsRuntime({}, () => apps.currentRole());
  const pins = frame('pins', PINS);
  const other = frame('other', OTHER);
  await pins.ask('events.subscribe', { events: ['role.change'] });
  await other.ask('events.subscribe', { events: ['role.change'] });
  // The host emits when the role store says the role changed (AppsHost.tsx); the store compares app permissions too.
  const stop = apps.onRoleChange(() => apps.emitRoleChange());

  apps.setActualRole(apps.roleViewOf(rolesFile({ appPermissions: { 'feedback-pins': { 'delete-any-comment': true } } }), 'writer'));
  const events = (target) => target.heard.filter((message) => message.event === 'role.change').map((message) => message.data);
  assert.deepEqual(events(pins), [{ id: 'writer', name: 'Writer', isAdmin: false, permissions: { 'resolve-threads': true, 'delete-any-comment': true } }]);
  assert.deepEqual(events(other), [{ id: 'writer', name: 'Writer', isAdmin: false, permissions: { export: true } }], 'each app hears only its own');

  // The same values again change nothing, so no event.
  apps.setActualRole(apps.roleViewOf(rolesFile({ appPermissions: { 'feedback-pins': { 'delete-any-comment': true } } }), 'writer'));
  assert.equal(events(pins).length, 1);
  stop();
  pins.detach();
  other.detach();
  apps.setActualRole(apps.ADMIN_VIEW);
  apps.resetAppsRuntime();
});
