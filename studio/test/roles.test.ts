// Goal: the Studio server refuses a write route the sender's role hides (403),
// whatever the UI shows, while reads, admins, local Studio and a project without
// roles stay open; a broken roles file fails closed to the client role; and the
// browser role store reads the old "designer" value as admin and only lets an
// admin "View as" another role.
// Method: run the real request gate (serverAccess.ts) behind a tiny HTTP server
// over a temporary project, with the worker's `x-studio-user` header and
// STUDIO_CONTAINER_TOKEN set as in a deployed Studio, and check status codes and
// whether the route behind it ran. The role store is driven directly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertRouteAllowed, gatedRoutePaths, metadataFeatures, requestRole, RoleRefusal, routeRule } from '../src/features/roles/serverAccess';
import { getEditorRole, getStudioRole, setEditorRole, setStudioRoles } from '../src/features/roles/roleStore';
import { ADMIN_VIEW, DEFAULT_PROJECT_ROLES, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';

const roles = {
  version: 1,
  defaultRole: 'client',
  roles: [
    { id: 'admin', name: 'Admin', members: ['Owner'] },
    { id: 'client', name: 'Client', members: ['acme'] },
    { id: 'writer', name: 'Writer', members: ['sam'], access: ['panel:cms', 'panel:variables'] },
  ],
};

async function project(file: string | undefined) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-roles-'));
  if (file !== undefined) {
    await mkdir(path.join(root, '.stacki'));
    await writeFile(path.join(root, '.stacki/roles.json'), file);
  }
  return root;
}

// The gate as integration.ts runs it, in front of a route that records that it ran.
async function server(root: string) {
  const ran: string[] = [];
  const instance = createServer((request: IncomingMessage, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://studio').pathname;
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
      }
      const rule = routeRule(request.method, pathname);
      try {
        if (rule !== undefined) {
          assertRouteAllowed(await requestRole(root, request), rule, body);
        }
        ran.push(`${request.method ?? ''} ${pathname}`);
        response.end('{}');
      } catch (error) {
        response.statusCode = error instanceof RoleRefusal ? 403 : 400;
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    ran,
    // `user` undefined sends exactly `headers`, so a test can omit or garble the user header.
    send: (user: string | undefined, method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + route, {
        method,
        headers: user === undefined ? headers : { 'x-studio-user': user },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    close: () => {
      instance.close();
      instance.closeAllConnections();
    },
  };
}

test('a hidden panel’s write route is refused on the server with 403, and its handler never runs', async (context) => {
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  const root = await project(JSON.stringify(roles));
  const studio = await server(root);
  context.after(async () => {
    studio.close();
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await studio.send('acme', 'POST', '/studio/api/variables', {})).status, 403, 'client has no Variables');
  assert.equal((await studio.send('stranger', 'POST', '/studio/api/ai/propose', {})).status, 403, 'the default role (client) has no AI');
  assert.equal((await studio.send('sam', 'POST', '/studio/api/publish', {})).status, 403, 'a writer cannot publish');
  assert.equal((await studio.send('sam', 'POST', '/studio/api/metadata', { kind: 'roles', source: '{}' })).status, 403, 'only admin writes roles');
  assert.deepEqual(studio.ran, []);
  assert.equal((await studio.send('SAM', 'POST', '/studio/api/variables', {})).status, 200, 'members match case-insensitively');
  assert.equal((await studio.send('acme', 'POST', '/studio/api/publish', {})).status, 200, 'client may publish by default');
  assert.equal((await studio.send('acme', 'GET', '/studio/api/variables')).status, 200, 'reads are open');
  assert.equal((await studio.send('owner', 'POST', '/studio/api/metadata', { kind: 'roles', source: '{}' })).status, 200, 'admin writes roles');
  assert.equal(studio.ran.length, 4);
});

test('no roles file, or a local Studio, keeps every route open; a broken file fails closed', async (context) => {
  const open = await project(undefined);
  const broken = await project('{ nope');
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await rm(open, { recursive: true, force: true });
    await rm(broken, { recursive: true, force: true });
  });
  const headers = { headers: { 'x-studio-user': 'acme' } };
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  assert.equal((await requestRole(open, headers)).isAdmin, true, 'no file: everyone is admin, as before');
  const closed = await requestRole(broken, headers);
  assert.equal(closed.id, 'client');
  assert.throws(() => assertRouteAllowed(closed, { kind: 'features', features: ['panel:code'] }, ''), RoleRefusal);
  delete process.env['STUDIO_CONTAINER_TOKEN'];
  assert.equal((await requestRole(broken, headers)).isAdmin, true, 'a local Studio has no sign-in: its user is admin');
});

// Unclaimed: a roles file with no member in any role resolves as no file does (admin for every hosted person, the
// default role restricting nobody), while a file naming a member but no admin is invalid and fails closed to client.
test('an unclaimed roles file resolves every hosted person as admin; an admin-less file with members fails closed', async (context) => {
  const unclaimed = await project(
    JSON.stringify({
      version: 1,
      defaultRole: 'client',
      roles: [
        { id: 'admin', members: [] },
        { id: 'client', access: ['panel:pages'] },
      ],
    }),
  );
  const orphan = await project(JSON.stringify({ version: 1, roles: [{ id: 'client', members: ['acme'] }] }));
  const claimed = await project(JSON.stringify({ version: 1, defaultRole: 'client', roles: [{ id: 'admin', members: ['owner'] }] }));
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    for (const root of [unclaimed, orphan, claimed]) {
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  const github = { headers: { 'x-studio-user': 'acme' } };
  const google = { headers: { 'x-studio-identity': 'google:a@b.test' } };
  for (const request of [github, google]) {
    const role = await requestRole(unclaimed, request);
    assert.equal(role.isAdmin, true, 'unclaimed: admin, as with no file');
    assert.doesNotThrow(() => assertRouteAllowed(role, { kind: 'features', features: ['panel:code'] }, ''));
    assert.equal((await requestRole(claimed, request)).id, 'client', 'claimed: the default role applies again');
  }
  const closed = await requestRole(orphan, github);
  assert.equal(closed.id, 'client', 'a member without an admin is an invalid file: client, never the member role');
  assert.throws(() => assertRouteAllowed(closed, { kind: 'features', features: ['settings:roles'] }, ''), RoleRefusal);
  await assert.rejects(requestRole(unclaimed, { headers: {} }), /login|GitHub|characters/i, 'no person still reaches no role');
});

// Issue #80: a request with no x-studio-user must never resolve to a role, least of all the
// admin view a project without roles.json gives everyone.
test('a hosted request that names no user reaches no gated route, with or without a roles file', async (context) => {
  process.env['STUDIO_CONTAINER_TOKEN'] = 'test-token';
  const withRoles = await project(JSON.stringify(roles));
  const withoutRoles = await project(undefined);
  const studios = [await server(withRoles), await server(withoutRoles)];
  context.after(async () => {
    for (const studio of studios) {
      studio.close();
    }
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await rm(withRoles, { recursive: true, force: true });
    await rm(withoutRoles, { recursive: true, force: true });
  });
  const paths = gatedRoutePaths();
  assert.ok(paths.length > 30, 'Every gated route is listed');
  for (const pathname of paths) {
    assert.ok(routeRule('POST', pathname), pathname + ' is gated');
  }
  for (const studio of studios) {
    for (const header of [undefined, '', ' ', 'not a login!', '../owner']) {
      for (const pathname of paths) {
        const headers: Record<string, string> = header === undefined ? {} : { 'x-studio-user': header };
        const response = await studio.send(undefined, 'POST', pathname, { kind: 'roles', source: '{}' }, headers);
        assert.notEqual(response.status, 200, `${pathname} with user ${JSON.stringify(header)}`);
      }
    }
    assert.deepEqual(studio.ran, []);
  }
  await assert.rejects(requestRole(withoutRoles, { headers: {} }), /login|GitHub|characters/i);
});

test('route rules cover writes only and settings files by kind', () => {
  assert.equal(routeRule('GET', '/studio/api/publish'), undefined);
  assert.deepEqual(routeRule('POST', '/studio/api/git/commit'), { kind: 'features', features: ['panel:history'] });
  assert.deepEqual(routeRule('POST', '/studio/api/cms-remote/write'), { kind: 'features', features: ['panel:cms'] });
  assert.equal(routeRule('POST', '/studio/api/file'), undefined);
  assert.deepEqual(metadataFeatures(JSON.stringify({ kind: 'folders' })), ['settings:folders']);
  assert.equal(metadataFeatures(JSON.stringify({ kind: 'guide' })), undefined);
  assert.throws(() => metadataFeatures(JSON.stringify({ kind: 'secrets' })), /Unknown project metadata file/);
});

test('the marketplace routes need their role features: Client is refused both, admin has both', () => {
  const browse = routeRule('POST', '/studio/api/apps/marketplace');
  const install = routeRule('POST', '/studio/api/apps/marketplace/install');
  assert.deepEqual(browse, { kind: 'features', features: ['marketplace:view'] });
  assert.deepEqual(install, { kind: 'features', features: ['marketplace:install'] });
  assert.ok(browse !== undefined && install !== undefined);
  const client = roleViewOf(DEFAULT_PROJECT_ROLES, 'client');
  assert.throws(() => assertRouteAllowed(client, browse, ''), RoleRefusal);
  assert.throws(() => assertRouteAllowed(client, install, ''), RoleRefusal);
  assertRouteAllowed(ADMIN_VIEW, browse, '');
  assertRouteAllowed(ADMIN_VIEW, install, '');
});

test('the share and publish routes need apps:share and marketplace:publish: Client is refused, admin allowed', () => {
  const rules = {
    share: routeRule('POST', '/studio/api/apps/publish/share'),
    switchSource: routeRule('POST', '/studio/api/apps/publish/switch-source'),
    makePublic: routeRule('POST', '/studio/api/apps/publish/make-public'),
    addLicense: routeRule('POST', '/studio/api/apps/publish/add-license'),
    check: routeRule('POST', '/studio/api/apps/publish/check'),
    submit: routeRule('POST', '/studio/api/apps/publish/submit'),
    scan: routeRule('POST', '/studio/api/apps/publish/scan'),
  };
  assert.deepEqual(rules.share, { kind: 'features', features: ['apps:share'] });
  assert.deepEqual(rules.switchSource, { kind: 'features', features: ['apps:share'] });
  assert.deepEqual(rules.makePublic, { kind: 'features', features: ['marketplace:publish'] });
  assert.deepEqual(rules.addLicense, { kind: 'features', features: ['marketplace:publish'] });
  assert.deepEqual(rules.check, { kind: 'features', features: ['marketplace:publish'] });
  assert.deepEqual(rules.submit, { kind: 'features', features: ['marketplace:publish'] });
  assert.deepEqual(rules.scan, { kind: 'features', features: ['apps:share', 'marketplace:publish'] });
  const client = roleViewOf(DEFAULT_PROJECT_ROLES, 'client');
  for (const rule of Object.values(rules)) {
    assert.ok(rule !== undefined);
    assert.throws(() => assertRouteAllowed(client, rule, ''), RoleRefusal);
    assertRouteAllowed(ADMIN_VIEW, rule, '');
  }
  assert.deepEqual(routeRule('POST', '/studio/api/apps/settings/write'), { kind: 'features', features: ['panel:apps'] });
  assert.deepEqual(routeRule('POST', '/studio/api/apps/visibility'), { kind: 'features', features: ['panel:apps'] });
});

test('the browser store reads "designer" as admin and lets only an admin view as another role', () => {
  setStudioRoles(DEFAULT_PROJECT_ROLES, ADMIN_VIEW);
  setEditorRole('designer');
  assert.equal(getStudioRole().isAdmin, true);
  assert.equal(getEditorRole(), 'admin');
  setEditorRole('client');
  assert.equal(getStudioRole().id, 'client');
  assert.equal(getEditorRole(), 'client', 'client edits stay inside the layout');
  setEditorRole('developer');
  assert.equal(getStudioRole().isAdmin, true);
  setStudioRoles(DEFAULT_PROJECT_ROLES, roleViewOf(DEFAULT_PROJECT_ROLES, 'client'));
  assert.equal(getStudioRole().id, 'client');
  assert.throws(() => setEditorRole('admin'), /Only an admin can view as another role/);
  setStudioRoles(DEFAULT_PROJECT_ROLES, ADMIN_VIEW);
});
