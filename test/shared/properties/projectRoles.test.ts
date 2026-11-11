// Goal: `.stacki/roles.json` parses only into a bounded, unambiguous set of roles
// with at least one admin; old "developer"/"designer" values read as admin;
// `can()` is always true for admin and exactly the grants for everyone else; and a
// GitHub login resolves to one role, case-insensitively, with the right fallback.
// Method: parse known-good shapes and pin the result, then each known-bad shape
// and each bound just past its limit, pinning the error; round-trip through the
// serializer; then ask `can()` and `resolveRole()` on both sides of every rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_FEATURES,
  ACCESS_GROUPS,
  ADMIN_VIEW,
  CLIENT_DEFAULT_ACCESS,
  DEFAULT_PROJECT_ROLES,
  ROLE_LIMITS,
  can,
  memberRole,
  parseGitHubLogin,
  parseProjectRoles,
  parseProjectRolesSource,
  resolveRole,
  roleIdFor,
  roleViewOf,
  sameLogin,
  serializeProjectRoles,
} from '#dist/shared/properties/projectRoles.js';

const admin = { id: 'admin', name: 'Admin', members: ['Owner'] };
const file = (roles: readonly unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, roles, ...extra });

test('a minimal file holds admin first, then the built-in client with its default access', () => {
  const roles = parseProjectRoles(file([admin]));
  assert.equal(roles.defaultRole, 'admin');
  assert.deepEqual(
    roles.roles.map((role) => role.id),
    ['admin', 'client'],
  );
  assert.deepEqual(roles.roles[1]?.access, CLIENT_DEFAULT_ACCESS);
  assert.deepEqual(roles.roles[0]?.access, [], 'admin stores no access: it has everything');
});

test('Client takes the name the file gives it, keeps its id, and admin is always Admin', () => {
  const renamed = parseProjectRoles(
    file(
      [
        { ...admin, name: 'Owners' },
        { id: 'client', name: 'Customer', members: ['acme'] },
      ],
      { defaultRole: 'client' },
    ),
  );
  assert.equal(renamed.roles[0]?.name, 'Admin', 'admin is always named Admin');
  assert.equal(renamed.roles[1]?.id, 'client');
  assert.equal(renamed.roles[1]?.name, 'Customer', 'the name is display only');
  assert.equal(renamed.defaultRole, 'client', 'the default role is still the id');
  assert.equal(resolveRole(renamed, 'ACME', 'admin').id, 'client', 'resolution goes by id');
  assert.equal(parseProjectRoles(file([admin])).roles[1]?.name, 'Client', 'a file without a name reads Client');
  const reread = parseProjectRolesSource(serializeProjectRoles(renamed));
  assert.equal(reread.roles[1]?.name, 'Customer', 'the name round-trips');
});

test('custom roles keep their members, access and app grants', () => {
  const roles = parseProjectRoles(
    file([admin, { id: 'writer', name: 'Writer', members: ['sam', 'Kim-Lee'], access: ['panel:cms', 'panel:apps', 'app:seo', 'app:seo'] }], {
      defaultRole: 'writer',
    }),
  );
  const writer = roles.roles.find((role) => role.id === 'writer');
  assert.deepEqual(writer, {
    id: 'writer',
    name: 'Writer',
    members: ['sam', 'Kim-Lee'],
    access: ['panel:cms', 'panel:apps', 'app:seo'],
    appPermissions: {},
    pinnedApps: [],
  });
  assert.equal(roles.defaultRole, 'writer');
});

test('"developer" and "designer" read as admin, in role ids and the default role', () => {
  const roles = parseProjectRoles(file([{ id: 'developer', members: ['owner'] }], { defaultRole: 'designer' }));
  assert.equal(roles.roles[0]?.id, 'admin');
  assert.deepEqual(roles.roles[0]?.members, ['owner']);
  assert.equal(roles.defaultRole, 'admin');
  assert.equal(resolveRole(roles, 'OWNER', 'default').isAdmin, true);
});

test('admin ignores any access list: it can never be restricted', () => {
  const roles = parseProjectRoles(file([{ ...admin, access: [] }]));
  const view = roleViewOf(roles, 'admin');
  for (const feature of ACCESS_FEATURES) {
    assert.equal(can(view, feature), true, feature);
  }
  assert.equal(can(view, 'app:anything'), true);
});

test('every malformed file is refused with its reason', () => {
  const bad = (input: unknown) => () => parseProjectRoles(input);
  assert.throws(bad({ version: 2, roles: [admin] }), /version must be 1/);
  assert.throws(bad({ version: 1 }), /needs a roles list/);
  assert.throws(bad(file([])), /At least one person must be an admin/);
  assert.throws(bad(file([{ id: 'admin', members: [] }])), /At least one person must be an admin/);
  assert.throws(bad(file([admin, { id: 'Writer', name: 'W' }])), /lowercase letters/);
  assert.throws(bad(file([admin, { id: 'writer' }])), /needs a name/);
  assert.throws(bad(file([admin, { id: 'writer', name: ' ' }])), /1 to 60 characters/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', members: 'sam' }])), /list of GitHub usernames/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', members: ['-sam'] }])), /not a GitHub username/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', members: ['sam', 'SAM'] }])), /listed twice/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', members: ['owner'] }])), /more than one role/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', access: ['panel:nope'] }])), /Unknown access feature/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', access: ['settings:roles'] }])), /Only admin can edit roles/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', access: ['app:'] }])), /1 to 64 characters/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'W', access: ['app:Bad App'] }])), /not an app grant/);
  assert.throws(bad(file([admin, { id: 'writer', name: 'A' }, { id: 'writer', name: 'B' }])), /listed twice/);
  assert.throws(bad(file([admin, { id: 'client' }, { id: 'client' }])), /listed twice/);
  assert.throws(bad(file([admin], { defaultRole: 'ghost' })), /is not a role/);
  assert.throws(() => parseProjectRolesSource('{'), SyntaxError);
});

test('each bound is enforced just past its limit', () => {
  const many = Array.from({ length: ROLE_LIMITS.rolesMax - 1 }, (_, index) => ({ id: `r${index}`, name: `R${index}` }));
  assert.throws(() => parseProjectRoles(file([admin, ...many])), /at most 32 roles/);
  const members = Array.from({ length: ROLE_LIMITS.membersMax + 1 }, (_, index) => `user${index}`);
  assert.throws(() => parseProjectRoles(file([admin, { id: 'writer', name: 'W', members }])), /at most 200 members/);
  const access = Array.from({ length: ROLE_LIMITS.accessMax + 1 }, (_, index) => `app:a${index}`);
  assert.throws(() => parseProjectRoles(file([admin, { id: 'writer', name: 'W', access }])), /at most 256 grants/);
  assert.throws(() => parseGitHubLogin('a'.repeat(ROLE_LIMITS.loginCharsMax + 1)), /1 to 39 characters/);
  assert.equal(parseGitHubLogin('a'.repeat(ROLE_LIMITS.loginCharsMax)).length, 39);
  assert.throws(() => parseProjectRoles(file([admin, { id: 'a'.repeat(ROLE_LIMITS.roleIdCharsMax + 1), name: 'W' }])), /1 to 40 characters/);
  assert.throws(() => parseProjectRolesSource(' '.repeat(ROLE_LIMITS.fileCharsMax + 1)), /exceeds/);
});

test('the serializer writes a stable file that parses back to the same roles', () => {
  const roles = parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', members: ['sam'], access: ['panel:cms'] }]));
  const source = serializeProjectRoles(roles);
  assert.deepEqual(parseProjectRolesSource(source), roles);
  assert.ok(!source.includes('"access": []') || source.indexOf('"access"') > source.indexOf('"client"'), 'admin carries no access');
  assert.throws(() => serializeProjectRoles(DEFAULT_PROJECT_ROLES), /At least one person must be an admin/);
});

test('can() is exactly the grants for a non-admin role, and app grants need the Apps panel', () => {
  const roles = parseProjectRoles(
    file([admin, { id: 'writer', name: 'W', access: ['panel:cms', 'app:seo'] }, { id: 'apps', name: 'A', access: ['panel:apps', 'app:*'] }]),
  );
  const writer = roleViewOf(roles, 'writer');
  assert.equal(can(writer, 'panel:cms'), true);
  assert.equal(can(writer, 'panel:code'), false);
  assert.equal(can(writer, 'settings:roles'), false);
  assert.equal(can(writer, 'app:seo'), false, 'without panel:apps no app is reachable');
  const apps = roleViewOf(roles, 'apps');
  assert.equal(can(apps, 'app:seo'), true, 'app:* allows every app');
  assert.equal(can(ADMIN_VIEW, 'settings:roles'), true);
  const client = roleViewOf(roles, 'client');
  assert.equal(can(client, 'page:layout'), false, 'client edits stay inside the layout');
  assert.equal(can(client, 'publish'), true);
});

test('members match case-insensitively and resolve with the host fallback', () => {
  const roles = parseProjectRoles(file([admin, { id: 'client', members: ['Acme'] }], { defaultRole: 'client' }));
  assert.equal(sameLogin('Acme', 'aCME'), true);
  assert.equal(memberRole(roles, 'ACME')?.id, 'client');
  assert.equal(resolveRole(roles, 'acme', 'admin').id, 'client', 'a named client is client on Desktop too');
  assert.equal(resolveRole(roles, 'stranger', 'default').id, 'client', 'Studio gives the default role');
  assert.equal(resolveRole(roles, 'stranger', 'admin').isAdmin, true, 'Desktop keeps the unnamed local user admin');
  assert.equal(resolveRole(roles, undefined, 'default').isAdmin, true, 'nobody signed in is admin');
  assert.equal(resolveRole(undefined, 'acme', 'default').isAdmin, true, 'no file is admin: today’s behaviour');
});

test('generated role ids are unique slugs that never take a built-in name', () => {
  assert.equal(roleIdFor('Content Writer', ['admin', 'client']), 'content-writer');
  assert.equal(roleIdFor('Writer', ['admin', 'client', 'writer']), 'writer-2');
  assert.equal(roleIdFor('Admin', ['admin', 'client']), 'admin-2');
  assert.equal(roleIdFor('42', ['admin', 'client']), 'role');
});

test('every grantable feature has one toggle in the Roles tab', () => {
  const listed = ACCESS_GROUPS.flatMap((group) => group.features.map((item) => item.feature));
  assert.deepEqual([...listed].sort(), ACCESS_FEATURES.filter((feature) => feature !== 'settings:roles').sort());
  assert.equal(new Set(listed).size, listed.length);
});

test('pinned apps parse per role, admin included, bounded, read once each and written only when set', () => {
  const roles = parseProjectRoles(
    file([
      { ...admin, pinnedApps: ['seo', 'feedback'] },
      { id: 'writer', name: 'Writer', members: ['sam'], access: ['panel:apps', 'app:seo'], pinnedApps: ['seo', 'gone', 'seo'] },
    ]),
  );
  assert.deepEqual(roles.roles[0]?.pinnedApps, ['seo', 'feedback'], 'admin can pin apps');
  assert.deepEqual(roles.roles[1]?.pinnedApps, [], 'client without pins has none');
  assert.deepEqual(roles.roles[2]?.pinnedApps, ['seo', 'gone'], 'an uninstalled id is kept; a repeat is read once');
  const maxed = Array.from({ length: ROLE_LIMITS.pinnedAppsMax }, (_, index) => `app-${index}`);
  assert.equal(parseProjectRoles(file([{ ...admin, pinnedApps: maxed }])).roles[0]?.pinnedApps.length, ROLE_LIMITS.pinnedAppsMax, 'the bound itself parses');
  assert.throws(() => parseProjectRoles(file([{ ...admin, pinnedApps: [...maxed, 'one-more'] }])), /pins at most 12 apps/);
  assert.throws(() => parseProjectRoles(file([{ ...admin, pinnedApps: 'seo' }])), /Pinned apps must be a list/);
  assert.throws(() => parseProjectRoles(file([{ ...admin, pinnedApps: ['Not An Id'] }])), /is not an app id/);
  assert.throws(() => parseProjectRoles(file([{ ...admin, pinnedApps: [''] }])), /An app id is 1 to 64 characters/);
  assert.throws(() => parseProjectRoles(file([{ ...admin, pinnedApps: ['x'.repeat(ROLE_LIMITS.appIdCharsMax + 1)] }])), /An app id is 1 to 64/);

  const source = serializeProjectRoles(roles);
  assert.deepEqual(parseProjectRolesSource(source).roles, roles.roles, 'pins round-trip in order');
  assert.doesNotMatch(serializeProjectRoles(parseProjectRoles(file([admin]))), /pinnedApps/, 'a file without pins is written as before');
});

test('the role view carries its pins, and admin resolves to the file admin role with its own', () => {
  const roles = parseProjectRoles(
    file([
      { ...admin, pinnedApps: ['seo'] },
      { id: 'writer', name: 'Writer', members: ['sam'], access: ['panel:apps', 'app:*'], pinnedApps: ['feedback'] },
    ]),
  );
  assert.deepEqual(ADMIN_VIEW.pinnedApps, [], 'the bare admin view pins nothing');
  assert.deepEqual(roleViewOf(roles, 'writer').pinnedApps, ['feedback']);
  for (const view of [
    roleViewOf(roles, 'admin'),
    resolveRole(roles, undefined, 'admin'),
    resolveRole(roles, 'stranger', 'admin'),
    resolveRole(roles, 'owner', 'default'),
  ]) {
    assert.equal(view.isAdmin, true);
    assert.deepEqual(view.pinnedApps, ['seo'], 'admin sees its pins however it resolves');
    assert.equal(can(view, 'app:anything'), true, 'pins never change what admin may do');
  }
  assert.equal(resolveRole(undefined, undefined, 'admin'), ADMIN_VIEW, 'no file is the bare admin view');
});
