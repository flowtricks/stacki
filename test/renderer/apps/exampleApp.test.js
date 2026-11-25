// Goal: end to end, the example app in test/fixtures/apps/selection-outline
// installs from a zip, loads the SDK Stacki serves, and through the real RPC
// follows the selection, draws an overlay box on the selected element, counts
// project changes and hears clicks on its overlay. Malformed params are refused
// at the boundary, and a role without the app is refused everything.
// Method: the fixture folder is zipped with writeStoredZip and read by the real
// bundle reader; the SDK (shared/properties/appSdk.ts) and the app's own
// app.js run in a Node vm context standing in for the sandboxed frame, whose
// postMessage to its parent reaches the real dispatcher (appRpcHost.ts) with a
// fake host, and whose answers and events come back as message events.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources');

const bundleModule = load('shared/properties/appBundle.ts');
const sdkModule = load('shared/properties/appSdk.ts');
const rpc = load('src/features/apps/appRpcHost.ts');
const roles = load('shared/properties/projectRoles.ts');

const FIXTURE = repoPath('test/fixtures/apps/selection-outline');

function fixtureZip() {
  const files = fs.readdirSync(FIXTURE).map((name) => ({ path: name, bytes: new Uint8Array(fs.readFileSync(path.join(FIXTURE, name))) }));
  return bundleModule.writeStoredZip(files);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function frame(bundle, host, overlays) {
  const summary = {
    manifest: bundle.manifest,
    lock: {
      id: bundle.manifest.id,
      version: bundle.manifest.version,
      sha256: 'a'.repeat(64),
      installedAt: '2026-11-10T00:00:00Z',
      source: { kind: 'file', fileName: 'selection-outline.zip' },
      update: undefined,
    },
  };
  const session = { app: summary, subscriptions: new Set(), ...rpc.inFlightCounter() };
  const listeners = [];
  const elements = { selected: { textContent: '' }, changes: { textContent: '' } };
  const parent = {
    postMessage: (message) => {
      // The host answers asynchronously, as the real runtime does.
      void rpc
        .answerAppMessage(session, structuredClone(message), { host, role: () => roles.ADMIN_VIEW, setOverlay: (id, items) => overlays.push([id, items]) })
        .then((answer) => {
          if (answer !== undefined) {
            deliver(answer);
          }
        });
    },
  };
  const window = {
    parent,
    addEventListener: (type, listener) => {
      if (type === 'message') {
        listeners.push(listener);
      }
    },
  };
  const deliver = (data) => {
    for (const listener of listeners) {
      listener({ source: parent, data: structuredClone(data) });
    }
  };
  const context = vm.createContext({ window, document: { getElementById: (id) => elements[id] }, console, Promise, Map, Set, Error, Object, structuredClone });
  window.window = window;
  vm.runInContext(sdkModule.appSdkSource(), context);
  context.stacki = window.stacki;
  const appScript = bundle.files.find((file) => file.path === 'app.js');
  vm.runInContext(new TextDecoder().decode(appScript.bytes), context);
  return { session, elements, deliver, request: (method, params) => window.stacki.request(method, params) };
}

test('the example app installs, follows the selection, draws its overlay and hears events', async () => {
  const bundle = bundleModule.readAppBundle(fixtureZip(), (data, size) => new Uint8Array(zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, size) })));
  assert.equal(bundle.manifest.id, 'selection-outline');
  assert.equal(bundle.manifest.authorGitHub, 'octocat');

  const overlays = [];
  const host = { selection: () => ({ nodeId: 'n0.1' }) };
  const app = frame(bundle, host, overlays);
  await settle();
  await settle();
  // It subscribed to its three events, and drew on the selection it read at start.
  assert.deepEqual([...app.session.subscriptions].sort(), ['overlay.click', 'project.change', 'selection.change']);
  assert.equal(app.elements.selected.textContent, 'Selected n0.1');
  assert.equal(overlays.at(-1)[0], 'selection-outline');
  assert.deepEqual(overlays.at(-1)[1][0].anchor, { nodeId: 'n0.1', occurrence: undefined, at: undefined });

  // Stacki's events, as the runtime sends them.
  app.deliver(rpc.eventForSession(app.session, roles.ADMIN_VIEW, 'selection.change', { nodeId: 'n0.4' }));
  await settle();
  await settle();
  assert.equal(app.elements.selected.textContent, 'Selected n0.4');
  assert.deepEqual(overlays.at(-1)[1][0].anchor.nodeId, 'n0.4');
  app.deliver(rpc.eventForSession(app.session, roles.ADMIN_VIEW, 'project.change', { source: 'styles' }));
  app.deliver(rpc.eventForSession(app.session, roles.ADMIN_VIEW, 'project.change', { source: 'page' }));
  assert.equal(app.elements.changes.textContent, '2 project changes (last: page)');
  app.deliver(rpc.eventForSession(app.session, roles.ADMIN_VIEW, 'overlay.click', { itemId: 'selected', nodeId: 'n0.4' }));
  assert.equal(app.elements.selected.textContent, 'Clicked selected');

  // Clearing the selection clears the overlay.
  app.deliver(rpc.eventForSession(app.session, roles.ADMIN_VIEW, 'selection.change', { nodeId: undefined }));
  await settle();
  await settle();
  assert.deepEqual(overlays.at(-1), ['selection-outline', undefined]);

  // A malformed request is refused at the boundary, with the reason.
  await assert.rejects(app.request('node.addClass', { nodeId: 'n0.4', className: 'not a class' }), (error) => error.code === 'bad-params');
});
