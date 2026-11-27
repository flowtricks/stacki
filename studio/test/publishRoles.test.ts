// Goal: a role without Publish, a read only role included, can never publish or change publish
// settings through any route custom hosting and staging added or use, and Studio never takes a
// staging publish for a production one. Method: ask the server's two gates (the route rule and
// the editing options) about each publishing write, with a role that lacks Publish, a read only
// role that was granted it and a limited role that keeps it; ask the collaboration socket's check
// about both publish settings files; then call the publish routes with a publisher that records
// whether it was ever started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { IncomingMessage, ServerResponse } from 'node:http';
import { assertRouteAllowed, routeRule, RoleRefusal } from '../src/features/roles/serverAccess';
import { assertDocumentChangeAllowed } from '../src/features/roles/documentAccess';
import { assertEditorRequest } from '../src/features/roles/editorRoutes';
import { publishRoute } from '../src/features/publishing/publishRoutes';
import { customRoute } from '../src/features/publishing/customRoutes';
import { Publisher } from '../src/features/publishing/publish';
import { can, parseProjectRoles, roleViewOf, type EditorPart, type RoleView } from '../vendor/stacki/shared/properties/projectRoles';

function role(access: readonly string[], off: readonly EditorPart[] = []): RoleView {
  const roles = parseProjectRoles({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'writer', name: 'Writer', members: ['writer'], access, editorOff: off },
    ],
  });
  return roleViewOf(roles, 'writer');
}

const EVERYTHING_BUT_PUBLISH = ['panel:pages', 'panel:style', 'panel:settings', 'panel:cms', 'panel:history', 'panel:code', 'code:edit', 'page:layout'];
const WITHOUT_PUBLISH = role(EVERYTHING_BUT_PUBLISH);
const READ_ONLY = role([...EVERYTHING_BUT_PUBLISH, 'publish'], ['drag', 'text', 'images']);
const PUBLISHER = role([...EVERYTHING_BUT_PUBLISH, 'publish']);

const PUBLISH_WRITES: readonly (readonly [string, string])[] = [
  ['/studio/api/publish', ''],
  ['/studio/api/publish/account', ''],
  ['/studio/api/publish/repository', ''],
  ['/studio/api/publish/worker', ''],
  ['/studio/api/publish/netlify-site', ''],
  ['/studio/api/metadata', JSON.stringify({ kind: 'publish' })],
  ['/studio/api/metadata', JSON.stringify({ kind: 'publishDestinations' })],
];

// Both gates, in the order integration.ts asks them.
function request(view: RoleView, pathname: string, body: string): void {
  const rule = routeRule('POST', pathname);
  assert.ok(rule, `${pathname} is a gated write`);
  assertRouteAllowed(view, rule, body);
  assertEditorRequest(view, pathname, body);
}

test('only a role that may publish can publish or change publish settings', () => {
  assert.equal(can(READ_ONLY, 'publish'), false, 'Read only takes Publish away even where it was granted');
  for (const [pathname, body] of PUBLISH_WRITES) {
    assert.throws(() => request(WITHOUT_PUBLISH, pathname, body), RoleRefusal, `${pathname} ${body}`);
    assert.throws(() => request(READ_ONLY, pathname, body), RoleRefusal, `${pathname} ${body}`);
    assert.doesNotThrow(() => request(PUBLISHER, pathname, body), `${pathname} ${body}`);
  }
});

test('the publish settings files take the same permission over the collaboration socket', () => {
  for (const file of ['.stacki/publish.json', '.stacki/publish-destinations.json']) {
    for (const view of [WITHOUT_PUBLISH, READ_ONLY]) {
      assert.throws(() => assertDocumentChangeAllowed(view, file, '{}', '{"version":1}'), RoleRefusal, file);
    }
    assert.doesNotThrow(() => assertDocumentChangeAllowed(PUBLISHER, file, '{}', '{"version":1}'), file);
  }
});

function exchange(method: string, url: string) {
  const incoming = new IncomingMessage(new Socket());
  incoming.method = method;
  incoming.url = url;
  return { incoming, outgoing: new ServerResponse(incoming) };
}

test('a staging publish asked of Studio is refused and starts nothing', () => {
  const publisher = new Publisher('/nowhere', undefined);
  let started = 0;
  publisher.start = () => {
    started += 1;
    return publisher.state;
  };
  for (const method of ['POST', 'GET']) {
    const { incoming, outgoing } = exchange(method, '/studio/api/publish?target=staging');
    assert.throws(() => publishRoute(publisher, incoming, outgoing, '/studio/api/publish'), /Choose all, github, or hosting/);
  }
  assert.equal(started, 0);
});

test('the custom host route only reads', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { incoming, outgoing } = exchange(method, '/studio/api/publish/custom');
    assert.equal(await customRoute('/nowhere', incoming, outgoing, '/studio/api/publish/custom'), true);
    assert.equal(outgoing.statusCode, 405, method);
  }
});
