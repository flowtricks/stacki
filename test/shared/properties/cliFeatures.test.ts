// Goal: the command line's access features are ordinary role features: they parse in a roles file, `cli:roles` is
// refused as a grant exactly like `settings:roles`, admin always passes, `cli:read` is the one default every role
// holds, and files written before the CLI existed still read the same.
// Method: parse known-good and known-bad roles files and pin the results; ask `cliFeatureAllowed` on both sides of
// every rule; and hold every locale to a label for the group and each grantable CLI feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_ACCESS_FEATURES, cliFeatureAllowed } from '#dist/shared/properties/cli/stackiFeatures.js';
import {
  ACCESS_FEATURES,
  ACCESS_GROUPS,
  ADMIN_VIEW,
  CLIENT_DEFAULT_ACCESS,
  DEFAULT_PROJECT_ROLES,
  parseProjectRoles,
  parseProjectRolesSource,
  roleViewOf,
  serializeProjectRoles,
} from '#dist/shared/properties/projectRoles.js';
import { messages as english } from '#dist/shared/properties/i18n/messages/en/roles.js';
import { messages as french } from '#dist/shared/properties/i18n/messages/fr/roles.js';
import { messages as german } from '#dist/shared/properties/i18n/messages/de/roles.js';
import { messages as portuguese } from '#dist/shared/properties/i18n/messages/ptBR/roles.js';
import { messages as spanish } from '#dist/shared/properties/i18n/messages/es/roles.js';

const admin = { id: 'admin', name: 'Admin', members: ['Owner'] };
const file = (roles: readonly unknown[]) => ({ version: 1, roles });
const WRITE_FEATURES = CLI_ACCESS_FEATURES.filter((feature) => feature !== 'cli:read' && feature !== 'cli:roles');

test('every CLI feature is a role feature, and every grantable one has a toggle under Command line', () => {
  for (const feature of CLI_ACCESS_FEATURES) {
    assert.ok(ACCESS_FEATURES.includes(feature), feature);
  }
  const group = ACCESS_GROUPS.find((item) => item.label === 'Command line');
  assert.ok(group !== undefined, 'the group exists');
  assert.deepEqual(
    group.features.map((item) => item.feature),
    CLI_ACCESS_FEATURES.filter((feature) => feature !== 'cli:roles'),
  );
});

test('CLI grants parse in a roles file and round-trip', () => {
  const roles = parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', members: ['sam'], access: ['cli:read', ...WRITE_FEATURES] }]));
  const writer = roles.roles[2];
  assert.deepEqual(writer?.access, ['cli:read', ...WRITE_FEATURES]);
  assert.deepEqual(parseProjectRolesSource(serializeProjectRoles(roles)).roles[2]?.access, writer?.access);
});

test('cli:roles is refused as a grant, as settings:roles is, and no role view holds it', () => {
  assert.throws(() => parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', access: ['cli:roles'] }])), /Only admin can edit roles/);
  assert.throws(() => parseProjectRoles(file([admin, { id: 'client', access: ['settings:roles'] }])), /Only admin can edit roles/);
  assert.throws(() => parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', access: ['cli:nope'] }])), /Unknown access feature/);
  const view = { ...roleViewOf(DEFAULT_PROJECT_ROLES, 'client'), features: new Set(['cli:roles'] as const) };
  assert.equal(cliFeatureAllowed(view, 'cli:roles'), false, 'even a hand-built view cannot pass');
});

test('admin always passes; a role passes exactly what it holds', () => {
  for (const feature of CLI_ACCESS_FEATURES) {
    assert.equal(cliFeatureAllowed(ADMIN_VIEW, feature), true, feature);
  }
  const roles = parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', access: ['cli:read', 'cli:guides'] }]));
  const writer = roleViewOf(roles, 'writer');
  assert.deepEqual(
    CLI_ACCESS_FEATURES.filter((feature) => cliFeatureAllowed(writer, feature)),
    ['cli:read', 'cli:guides'],
  );
});

test('cli:read is the default for client; write features are admin only', () => {
  assert.ok(CLIENT_DEFAULT_ACCESS.includes('cli:read'));
  for (const feature of WRITE_FEATURES) {
    assert.ok(!CLIENT_DEFAULT_ACCESS.includes(feature), feature);
  }
  const client = roleViewOf(parseProjectRoles(file([admin])), 'client');
  assert.equal(cliFeatureAllowed(client, 'cli:read'), true);
  assert.equal(cliFeatureAllowed(client, 'cli:config'), false);
  // A new custom role starts with it too: addRole is held in test/renderer/app/rolesSettings.test.js.
});

test('files written before the CLI existed still parse, and stored access is not changed by reading', () => {
  const roles = parseProjectRoles(file([admin, { id: 'client', access: ['panel:pages'] }, { id: 'old', name: 'Old', access: [] }]));
  assert.deepEqual(roles.roles[1]?.access, ['panel:pages']);
  assert.deepEqual(roles.roles[2]?.access, []);
  assert.equal(cliFeatureAllowed(roleViewOf(roles, 'old'), 'cli:read'), false);
});

test('every locale labels the group and each grantable CLI feature', () => {
  const keys = ACCESS_GROUPS.find((item) => item.label === 'Command line')?.features.map((item) => item.labelRef.key) ?? [];
  assert.equal(keys.length, CLI_ACCESS_FEATURES.length - 1);
  for (const catalog of [english, french, german, portuguese, spanish]) {
    const record: Readonly<Record<string, string>> = catalog;
    for (const key of ['roles.group.cli', ...keys]) {
      assert.ok((record[key] ?? '').length > 0, key);
    }
  }
});
