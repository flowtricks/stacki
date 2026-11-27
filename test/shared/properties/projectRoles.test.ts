// Goal: `.stacki/roles.json` parses only into a bounded, unambiguous set of roles
// with an admin member whenever any role has members (a file with no members at all
// is "unclaimed" and grants as no file does); old "developer"/"designer" values read as admin;
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
  adminMembershipRefusal,
  can,
  memberRole,
  parseGitHubLogin,
  parseProjectRoles,
  parseProjectRolesSource,
  resolveRole,
  roleIdFor,
  roleViewOf,
  rolesClaimed,
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
    componentRules: [],
    editorOff: [],
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
  assert.throws(bad(file([{ id: 'client', members: ['acme'] }])), /Add an admin before adding people to other roles/);
  assert.throws(
    bad(
      file([
        { id: 'admin', members: [] },
        { id: 'writer', name: 'W', members: ['sam'] },
      ]),
    ),
    /Add an admin before adding people/,
  );
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
  assert.equal(parseProjectRolesSource(serializeProjectRoles(DEFAULT_PROJECT_ROLES)).roles.length, 2, 'the defaults serialize unclaimed');
  const orphan = { ...DEFAULT_PROJECT_ROLES, roles: DEFAULT_PROJECT_ROLES.roles.map((role) => (role.id === 'client' ? { ...role, members: ['acme'] } : role)) };
  assert.throws(() => serializeProjectRoles(orphan), /Add an admin before adding people to other roles/);
});

test('an unclaimed file (no member in any role) parses, keeps everything, and grants as no file does', () => {
  const source = JSON.stringify(
    file(
      [
        { id: 'admin', name: 'Admin', members: [], pinnedApps: ['seo'] },
        { id: 'client', name: 'Editor', access: ['panel:pages'] },
        { id: 'writer', name: 'Writer', access: ['panel:cms'], appPermissions: { seo: { publish: false } } },
      ],
      { defaultRole: 'client' },
    ),
  );
  const roles = parseProjectRolesSource(source);
  assert.equal(rolesClaimed(roles), false);
  assert.equal(adminMembershipRefusal(roles.roles), undefined, 'empty everywhere is allowed');
  assert.equal(roles.defaultRole, 'client', 'the default role is kept');
  assert.equal(roles.roles[1]?.name, 'Editor');
  assert.deepEqual(roles.roles[2]?.appPermissions, { seo: { publish: false } });
  assert.deepEqual(parseProjectRolesSource(serializeProjectRoles(roles)), roles, 'it round-trips unclaimed');
  // Resolution: everyone is the file's admin role (its pins apply), whatever the fallback; the default role restricts nobody.
  for (const fallback of ['default', 'admin'] as const) {
    const view = resolveRole(roles, 'stranger', fallback, ['email:a@b.com']);
    assert.equal(view.isAdmin, true, fallback);
    assert.deepEqual(view.pinnedApps, ['seo'], 'admin pins from the file apply');
  }
  assert.equal(resolveRole(roles, undefined, 'default').isAdmin, true);
  assert.equal(memberRole(roles, 'stranger'), undefined, 'nobody is a member');
  // "View as" still offers each role as the file defines it.
  assert.equal(can(roleViewOf(roles, 'client'), 'panel:cms'), false);
  assert.equal(can(roleViewOf(roles, 'writer'), 'panel:cms'), true);
});

test('claiming: once admin has a member the file applies as usual, and admin-less members stay refused', () => {
  const claimed = parseProjectRoles(file([admin, { id: 'client', members: [] }], { defaultRole: 'client' }));
  assert.equal(rolesClaimed(claimed), true);
  assert.equal(resolveRole(claimed, 'stranger', 'default').id, 'client', 'the default role applies again');
  assert.equal(resolveRole(claimed, 'owner', 'default').isAdmin, true);
  const orphan = claimed.roles.map((role) => (role.id === 'admin' ? { ...role, members: [] } : { ...role, members: ['acme'] }));
  assert.equal(adminMembershipRefusal(orphan)?.message, 'Add an admin before adding people to other roles');
  assert.deepEqual(adminMembershipRefusal(orphan)?.messageRef, { key: 'roles.error.adminFirst' });
  assert.equal(adminMembershipRefusal(claimed.roles.map((role) => ({ ...role, members: [] }))), undefined, 'removing every member makes it unclaimed again');
  // The consumer-side assertion pairs with the parser's rule: a hand-built claimed set without an admin is a bug.
  assert.throws(() => rolesClaimed({ ...claimed, roles: orphan }), /Assertion failed: A claimed roles file names an admin/);
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
  assert.deepEqual([...listed].sort(), ACCESS_FEATURES.filter((feature) => feature !== 'settings:roles' && feature !== 'cli:roles').sort());
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

// Add elements (`panel:elements`): roles files written before the permission existed have no grant for it, so a role that holds a
// design panel or a page edit permission has it by default; a role without those does not; admin always does; the parser knows the id.
const elementsRoles = (access: readonly string[]) => roleViewOf(parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', access }])), 'writer');

test('Add elements: a role without design panels does not have it', () => {
  for (const access of [[], ['cli:read'], ['panel:pages'], ['panel:apps', 'app:*'], ['panel:assets', 'panel:cms', 'publish'], ['settings:editor']]) {
    assert.equal(can(elementsRoles(access), 'panel:elements'), false, access.join(','));
  }
});

test('Add elements: a legacy role with the Navigator or a page edit permission has it by default', () => {
  for (const access of [
    ['panel:navigator'],
    ['page:create'],
    ['page:delete'],
    ['page:rename'],
    ['page:layout'],
    ['panel:pages', 'panel:navigator', 'publish'],
  ]) {
    assert.equal(can(elementsRoles(access), 'panel:elements'), true, access.join(','));
  }
});

test('Add elements: an explicit grant alone gives it, and gives nothing else', () => {
  const view = elementsRoles(['panel:elements']);
  assert.equal(can(view, 'panel:elements'), true);
  assert.equal(can(view, 'panel:navigator'), false);
  assert.equal(can(view, 'page:create'), false);
});

test('Add elements: admin always has it, and the client default holds it with its design panels', () => {
  assert.equal(can(ADMIN_VIEW, 'panel:elements'), true);
  assert.equal(can(roleViewOf(parseProjectRoles(file([{ ...admin, access: [] }])), 'admin'), 'panel:elements'), true);
  assert.ok(CLIENT_DEFAULT_ACCESS.includes('panel:elements'));
  assert.ok(CLIENT_DEFAULT_ACCESS.includes('panel:navigator'));
  assert.equal(can(roleViewOf(DEFAULT_PROJECT_ROLES, 'client'), 'panel:elements'), true);
});

test('Add elements: the parser accepts the id and still refuses a lookalike, and the grant round-trips', () => {
  const roles = parseProjectRoles(file([admin, { id: 'writer', name: 'Writer', access: ['panel:elements'] }]));
  assert.deepEqual(roles.roles[2]?.access, ['panel:elements']);
  assert.deepEqual(parseProjectRolesSource(serializeProjectRoles(roles)).roles, roles.roles);
  for (const lookalike of ['panel:element', 'panel:Elements', 'panel:elements ', 'elements', 'panel:add-elements']) {
    assert.throws(() => parseProjectRoles(file([admin, { id: 'writer', name: 'W', access: [lookalike] }])), /Unknown access feature/, lookalike);
  }
  assert.ok(
    ACCESS_GROUPS[0]?.features.some((item) => item.feature === 'panel:elements' && item.label === 'Add elements'),
    'the Panels group lists it',
  );
});
