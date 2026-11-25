// Goal: the roles file's `appPermissions` (shared/properties/projectRoles.ts)
// parse only into bounded, well-formed values; a file without them reads and
// writes exactly as before; and `appPermissionsFor` resolves each declared
// permission by its rules: admin has every one, a role that may not use the app
// has none, any other role has its stored value, else the manifest default;
// stored ids no manifest declares are kept through a save and ignored.
// Method: parse known-good and known-bad shapes, each bound at and past its
// limit; round-trip through the serializer; then resolve one declaration list
// for admin, a role without the app, a role with it, and stored stray ids.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_PERMISSION_LIMITS, parseAppPermissionDeclarations } from '#dist/shared/properties/appPermissions.js';
import {
  ADMIN_VIEW,
  ROLE_LIMITS,
  appPermissionsFor,
  parseProjectRoles,
  parseProjectRolesSource,
  roleViewOf,
  sameAppPermissions,
  serializeProjectRoles,
} from '#dist/shared/properties/projectRoles.js';

const admin = { id: 'admin', name: 'Admin', members: ['owner'] };
const file = (roles: readonly unknown[]) => ({ version: 1, roles });
const DECLARED = parseAppPermissionDeclarations([
  { id: 'resolve-threads', label: 'Resolve threads', default: true },
  { id: 'delete-any-comment', label: 'Delete any comment', default: false },
]);

test('a file without app permissions reads as none and writes no key', () => {
  const roles = parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', access: ['panel:apps'] }]));
  assert.deepEqual(roles.roles[2]?.appPermissions, {});
  assert.equal(serializeProjectRoles(roles).includes('appPermissions'), false);
});

test('stored values round-trip, and admin never stores any', () => {
  const stored = { 'feedback-pins': { 'resolve-threads': false, 'delete-any-comment': true } };
  const roles = parseProjectRoles(
    file([
      { ...admin, appPermissions: stored },
      { id: 'writer', name: 'Writer', appPermissions: stored },
    ]),
  );
  assert.deepEqual(roles.roles[0]?.appPermissions, {}, 'admin has every permission: values on it are ignored');
  assert.deepEqual(roles.roles[2]?.appPermissions, stored);
  const again = parseProjectRolesSource(serializeProjectRoles(roles));
  assert.deepEqual(again.roles[2]?.appPermissions, stored);
  assert.equal(sameAppPermissions(again.roles[2]?.appPermissions ?? {}, stored), true);
  assert.equal(sameAppPermissions(stored, { 'feedback-pins': { 'resolve-threads': true, 'delete-any-comment': true } }), false);
  assert.equal(sameAppPermissions(stored, {}), false);
});

test('bad shapes and bounds are refused', () => {
  const writer = (appPermissions: unknown) => () => parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', appPermissions }]));
  assert.throws(writer([]), /Expected object/);
  assert.throws(writer({ 'feedback-pins': [] }), /Expected object/);
  assert.throws(writer({ 'feedback-pins': { 'resolve-threads': 'yes' } }), /true or false/);
  assert.throws(writer({ 'Feedback Pins': { 'resolve-threads': true } }), /not an app id/);
  assert.throws(writer({ 'feedback-pins': { Resolve: true } }), /must start with a letter/);
  assert.throws(writer({ 'feedback-pins': { ['p'.repeat(APP_PERMISSION_LIMITS.idCharsMax + 1)]: true } }), /1 to 48 characters/);
  const values = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, true]));
  assert.doesNotThrow(writer({ app: values(APP_PERMISSION_LIMITS.permissionsMax) }));
  assert.throws(writer({ app: values(APP_PERMISSION_LIMITS.permissionsMax + 1) }), /at most 24 permissions/);
  const apps = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`app${index}`, { p: true }]));
  assert.doesNotThrow(writer(apps(ROLE_LIMITS.appPermissionAppsMax)));
  assert.throws(writer(apps(ROLE_LIMITS.appPermissionAppsMax + 1)), /at most 64 apps/);
});

test('resolution: admin, no app access, default, explicit, and unknown ids', () => {
  const roles = parseProjectRoles(
    file([
      admin,
      // The Apps panel but not the app: it has none of the app's permissions, whatever is stored.
      { id: 'outsider', name: 'Outsider', access: ['panel:apps', 'app:other'], appPermissions: { 'feedback-pins': { 'delete-any-comment': true } } },
      // The app without the Apps panel: no app is reachable, so none either.
      { id: 'hidden', name: 'Hidden', access: ['app:*'] },
      { id: 'fresh', name: 'Fresh', access: ['panel:apps', 'app:feedback-pins'] },
      {
        id: 'writer',
        name: 'Writer',
        access: ['panel:apps', 'app:*'],
        appPermissions: {
          'feedback-pins': { 'resolve-threads': false, 'delete-any-comment': true, 'dropped-in-v2': true },
          'uninstalled-app': { anything: true },
        },
      },
    ]),
  );
  assert.deepEqual(appPermissionsFor(ADMIN_VIEW, 'feedback-pins', DECLARED), { 'resolve-threads': true, 'delete-any-comment': true });
  assert.deepEqual(appPermissionsFor(roleViewOf(roles, 'outsider'), 'feedback-pins', DECLARED), { 'resolve-threads': false, 'delete-any-comment': false });
  assert.deepEqual(appPermissionsFor(roleViewOf(roles, 'hidden'), 'feedback-pins', DECLARED), { 'resolve-threads': false, 'delete-any-comment': false });
  assert.deepEqual(
    appPermissionsFor(roleViewOf(roles, 'fresh'), 'feedback-pins', DECLARED),
    { 'resolve-threads': true, 'delete-any-comment': false },
    'defaults',
  );
  const writer = appPermissionsFor(roleViewOf(roles, 'writer'), 'feedback-pins', DECLARED);
  assert.deepEqual(writer, { 'resolve-threads': false, 'delete-any-comment': true }, 'explicit values win; a dropped id is ignored');
  assert.deepEqual(appPermissionsFor(roleViewOf(roles, 'writer'), 'feedback-pins', []), {}, 'an app that declares none hears none');
  // Kept through a save, so reinstalling the app restores them.
  const saved = parseProjectRolesSource(serializeProjectRoles(roles));
  assert.deepEqual(saved.roles.find((role) => role.id === 'writer')?.appPermissions['uninstalled-app'], { anything: true });
});

test('a permission id that names a prototype property never reads the prototype', () => {
  const declared = parseAppPermissionDeclarations([{ id: 'constructor', label: 'Odd but allowed', default: false }]);
  const roles = parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', access: ['panel:apps', 'app:*'] }]));
  assert.deepEqual(appPermissionsFor(roleViewOf(roles, 'writer'), 'constructor', declared), { constructor: false });
});
