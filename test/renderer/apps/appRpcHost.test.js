// Goal: the Apps RPC dispatcher (src/features/apps/appRpcHost.ts) refuses what
// it must, in order: messages that are not app messages are ignored, malformed
// ones answer bad-request, a newer API version answers unsupported-version, an
// app the role may not use is refused everything, a role cannot have an app
// open a panel it does not see, bad params are refused, and at most 32 requests
// wait at once. Every other method is every app's (apps are first-party) and reaches exactly
// the host command the UI uses (Desktop's mapping, desktopAppHost.ts, is held
// to the shell's own setters and gestures below), and events reach only
// sessions that subscribed and may hear them.
// Method: the real dispatcher bundled with esbuild, a recording fake host, and
// role views built from shared/properties/projectRoles.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const rpc = load('src/features/apps/appRpcHost.ts');
const roles = load('shared/properties/projectRoles.ts');
const desktop = load('src/app/shell/desktopAppHost.ts');
const contract = load('shared/properties/appsRpc.ts');

const app = (id = 'heat-map') => ({
  manifest: {
    manifestVersion: 1,
    id,
    name: 'Heat map',
    version: '1.0.0',
    description: '',
    icon: undefined,
    entry: 'index.html',
    window: { mode: 'panel', widthPx: undefined, heightPx: undefined },
    source: undefined,
    authorGitHub: undefined,
  },
  lock: {
    id,
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00Z',
    source: { kind: 'file', fileName: 'a.zip' },
    update: undefined,
  },
});
const session = (id) => ({ app: app(id), subscriptions: new Set(), ...rpc.inFlightCounter() });

function recordingHost() {
  const calls = [];
  const record =
    (name, value) =>
    (...args) => {
      calls.push([name, ...args]);
      return value;
    };
  const applied = { applied: true };
  const host = {
    viewport: record('viewport', { widthPx: 1200, heightPx: 800, scale: 1, device: 'desktop' }),
    setDevice: record('setDevice'),
    setWidth: rpc.able(record('setWidth')),
    scrollTo: rpc.able(record('scrollTo', applied)),
    openPanel: record('openPanel'),
    closePanel: record('closePanel'),
    openRightPanel: record('openRightPanel'),
    panels: record('panels', { left: 'navigator', right: 'style' }),
    selection: record('selection', { nodeId: 'n0' }),
    select: record('select', applied),
    page: record('page', undefined),
    pages: record('pages', []),
    openPage: record('openPage', applied),
    openComponent: rpc.able(record('openComponent', applied)),
    snapshot: rpc.able(record('snapshot', Promise.resolve({ applied: true, url: 'data:image/png;base64,AA==', width: 1, height: 1 }))),
    node: record('node', undefined),
    attributes: rpc.able({ set: record('setAttribute', Promise.resolve(applied)), remove: record('removeAttribute', Promise.resolve(applied)) }),
    classes: rpc.able({ add: record('addClass', Promise.resolve(applied)), remove: record('removeClass', Promise.resolve(applied)) }),
    setStyle: rpc.able(record('setStyle', Promise.resolve(applied))),
    insertElement: rpc.able(record('insertElement', Promise.resolve(applied))),
    insertComponent: record('insertComponent', Promise.resolve(applied)),
    insertAttributes: rpc.able(true),
    insertReplace: rpc.able(true),
    remove: record('remove', Promise.resolve(applied)),
    duplicate: record('duplicate', Promise.resolve(applied)),
    history: rpc.able({ undo: record('undo', Promise.resolve(applied)), redo: record('redo', Promise.resolve(applied)) }),
    save: record('save', Promise.resolve(applied)),
    openPalette: rpc.able(record('openPalette', applied)),
    escape: record('escape', applied),
    notify: record('notify'),
    kind: 'desktop',
    version: async () => '1.0.24',
    person: async () => ({ id: 'a'.repeat(32), name: 'Ada', email: 'ada@example.test', github: 'ada' }),
    onPersonChange: () => () => undefined,
    storage: {
      writer: 'test-window',
      get: record('storageGet', Promise.resolve('stored')),
      set: record('storageSet', Promise.resolve(applied)),
      keys: record('storageKeys', Promise.resolve(['pins/a'])),
      watch: () => () => undefined,
    },
  };
  return { host, calls };
}

const request = (id, method, params) => ({ stacki: 'app', v: 1, id, method, params });
const context = (host, role = roles.ADMIN_VIEW, overlays = []) => ({ host, role: () => role, setOverlay: (appId, items) => overlays.push([appId, items]) });
const client = { id: 'client', name: 'Client', isAdmin: false, features: new Set(['panel:apps', 'app:heat-map', 'panel:pages']) };

test('non-app messages are ignored; malformed ones and newer versions are answered', async () => {
  const { host } = recordingHost();
  const one = session();
  assert.equal(await rpc.answerAppMessage(one, { type: 'avb:rects' }, context(host)), undefined);
  assert.equal(await rpc.answerAppMessage(one, 'hello', context(host)), undefined);
  const bad = await rpc.answerAppMessage(one, { stacki: 'app', v: 1, id: 4, method: 7 }, context(host));
  assert.equal(bad.error.code, 'bad-request');
  const newer = await rpc.answerAppMessage(one, { stacki: 'app', v: 2, id: 5, method: 'selection.get' }, context(host));
  assert.equal(newer.error.code, 'unsupported-version');
  assert.equal((await rpc.answerAppMessage(one, request(6, 'nope.never'), context(host))).error.code, 'unknown-method');
});

test('roles: an app the role lacks is refused everything; a panel the role lacks stays closed', async () => {
  const { host, calls } = recordingHost();
  const none = { ...client, features: new Set(['panel:pages']) };
  const everything = session();
  assert.equal((await rpc.answerAppMessage(everything, request(1, 'selection.get'), context(host, none))).error.code, 'role-denied');
  assert.equal((await rpc.answerAppMessage(everything, request(2, 'panels.open', { panel: 'code' }), context(host, client))).error.code, 'role-denied');
  assert.equal(
    (await rpc.answerAppMessage(everything, request(3, 'node.remove', { nodeId: 'n0' }), context(host, client))).ok,
    true,
    'editing is not narrowed beyond the app grant',
  );
  const pages = await rpc.answerAppMessage(everything, request(4, 'panels.open', { panel: 'pages' }), context(host, client));
  assert.equal(pages.ok, true);
  assert.deepEqual(
    calls.filter(([name]) => name === 'openPanel'),
    [['openPanel', 'pages']],
  );
});

test('bad params are refused with the reason, and requests in flight are bounded', async () => {
  const { host } = recordingHost();
  const one = session();
  const reasons = [
    request(1, 'node.setAttribute', { nodeId: 'n0', name: 'onclick', value: 'x' }),
    request(2, 'node.setAttribute', { nodeId: 'n0', name: 'client:load', value: '' }),
    request(3, 'node.addClass', { nodeId: 'n0', className: 'has space' }),
    request(4, 'canvas.setWidth', { widthPx: 10 }),
    request(5, 'node.insert', { kind: 'element', tag: 'script' }),
    request(6, 'node.insert', { kind: 'element', tag: 'div', attributes: { onclick: 'x' } }),
    request(7, 'node.insert', { kind: 'element', tag: 'div', replace: 'n0', position: 'after', anchor: 'n1' }),
  ];
  for (const message of reasons) {
    assert.equal((await rpc.answerAppMessage(one, message, context(host))).error.code, 'bad-params', message.method);
  }
  let release;
  const slow = {
    ...host,
    history: rpc.able({ undo: () => new Promise((resolve) => (release = () => resolve({ applied: true }))), redo: async () => ({ applied: true }) }),
  };
  const waiting = Array.from({ length: 32 }, (_, index) => rpc.answerAppMessage(one, request(100 + index, 'history.undo'), context(slow)));
  const busy = await rpc.answerAppMessage(one, request(200, 'history.undo'), context(slow));
  assert.equal(busy.error.code, 'busy');
  release();
  await Promise.race(waiting);
});

test('every method calls the one host command it maps to', async () => {
  const { host, calls } = recordingHost();
  const overlays = [];
  const all = session();
  const cases = [
    ['canvas.setDevice', { device: 'tablet' }, ['setDevice', 'tablet']],
    ['canvas.setWidth', { widthPx: 768 }, ['setWidth', 768]],
    ['canvas.scrollTo', { nodeId: 'n0.1' }, ['scrollTo', { nodeId: 'n0.1', occurrence: undefined, block: 'center' }]],
    ['canvas.scrollTo', { nodeId: 'n0.1', occurrence: 2 }, ['scrollTo', { nodeId: 'n0.1', occurrence: 2, block: 'center' }]],
    ['panels.open', { panel: 'assets' }, ['openPanel', 'assets']],
    ['panels.openRight', { panel: 'settings' }, ['openRightPanel', 'settings']],
    ['selection.set', { nodeId: 'n0.2' }, ['select', 'n0.2']],
    ['node.setAttribute', { nodeId: 'n0', name: 'title', value: 'Hi' }, ['setAttribute', 'n0', 'title', 'Hi', undefined]],
    ['node.setAttribute', { nodeId: 'n0', name: 'data-pin', value: '1', label: 'Pin feedback' }, ['setAttribute', 'n0', 'data-pin', '1', 'Pin feedback']],
    ['node.removeAttribute', { nodeId: 'n0', name: 'title' }, ['removeAttribute', 'n0', 'title', undefined]],
    ['node.addClass', { nodeId: 'n0', className: 'is-on', label: 'Turn on' }, ['addClass', 'n0', 'is-on', 'Turn on']],
    ['node.removeClass', { nodeId: 'n0', className: 'is-on' }, ['removeClass', 'n0', 'is-on', undefined]],
    ['node.setStyle', { nodeId: 'n0', css: 'color: red' }, ['setStyle', 'n0', 'color: red', undefined]],
    [
      'node.insert',
      { kind: 'component', name: 'Card', label: 'Add a card' },
      ['insertComponent', { item: { kind: 'component', name: 'Card', props: {} }, place: { kind: 'selection' }, label: 'Add a card' }],
    ],
    [
      'node.insert',
      { kind: 'element', tag: 'section' },
      ['insertElement', { item: { kind: 'element', tag: 'section', attributes: {} }, place: { kind: 'selection' }, label: undefined }],
    ],
    [
      'node.insert',
      { kind: 'element', tag: 'img', attributes: { src: '/a.png', alt: 'A' }, position: 'inside', anchor: 'n0', index: 1 },
      [
        'insertElement',
        { item: { kind: 'element', tag: 'img', attributes: { src: '/a.png', alt: 'A' } }, place: { kind: 'inside', anchor: 'n0', index: 1 }, label: undefined },
      ],
    ],
    [
      'node.insert',
      { kind: 'component', name: 'Card', props: { title: 'Hi' }, replace: 'n0.2', label: 'Swap' },
      ['insertComponent', { item: { kind: 'component', name: 'Card', props: { title: 'Hi' } }, place: { kind: 'replace', nodeId: 'n0.2' }, label: 'Swap' }],
    ],
    ['node.remove', { nodeId: 'n0', label: 'Resolve pin' }, ['remove', 'n0', 'Resolve pin']],
    ['node.duplicate', { nodeId: 'n0' }, ['duplicate', 'n0', undefined]],
    ['storage.get', { key: 'pins/a' }, ['storageGet', 'heat-map', 'project', 'pins/a']],
    ['storage.set', { key: 'pins/a', value: '{}', scope: 'local' }, ['storageSet', 'heat-map', 'local', 'pins/a', '{}']],
    ['storage.remove', { key: 'pins/a' }, ['storageSet', 'heat-map', 'project', 'pins/a', undefined]],
    ['storage.keys', {}, ['storageKeys', 'heat-map', 'project']],
    ['history.undo', undefined, ['undo']],
    ['history.redo', undefined, ['redo']],
    // A forwarded key runs the command the editor's own key runs.
    ['shortcuts.run', { shortcut: 'undo' }, ['undo']],
    ['shortcuts.run', { shortcut: 'redo' }, ['redo']],
    ['shortcuts.run', { shortcut: 'save' }, ['save']],
    ['shortcuts.run', { shortcut: 'palette' }, ['openPalette']],
    ['shortcuts.run', { shortcut: 'escape' }, ['escape']],
  ];
  let id = 1;
  for (const [method, params, expected] of cases) {
    calls.length = 0;
    const answer = await rpc.answerAppMessage(all, request(id++, method, params), context(host, roles.ADMIN_VIEW, overlays));
    assert.equal(answer.ok, true, method);
    assert.deepEqual(calls[0], expected, method);
  }
  await rpc.answerAppMessage(
    all,
    request(id++, 'overlay.set', { items: [{ kind: 'box', id: 'a', anchor: { nodeId: 'n0' } }] }),
    context(host, roles.ADMIN_VIEW, overlays),
  );
  await rpc.answerAppMessage(all, request(id++, 'overlay.clear'), context(host, roles.ADMIN_VIEW, overlays));
  assert.equal(overlays[0][0], 'heat-map');
  assert.equal(overlays[0][1].length, 1);
  assert.deepEqual(overlays[1], ['heat-map', undefined]);
  calls.length = 0;
  await rpc.answerAppMessage(all, request(id++, 'ui.notify', { message: 'Done', kind: 'success' }), context(host));
  assert.deepEqual(calls[0], ['notify', 'Heat map: Done', 'success'], 'notices name the app that sent them');
});

// node.insert answers with the host's id for the new node, so an app can edit it next without reading the tree.
test('node.insert answers the new node’s id from the host, and a part the host cannot do refuses it', async () => {
  const { host } = recordingHost();
  const one = session();
  const named = {
    ...host,
    insertElement: rpc.able(async () => ({ applied: true, nodeId: 'n0.1' })),
    insertComponent: async () => ({ applied: true, nodeId: 'n2' }),
  };
  const inside = await rpc.answerAppMessage(
    one,
    request(1, 'node.insert', { kind: 'element', tag: 'p', position: 'inside', anchor: 'n0', index: 1 }),
    context(named),
  );
  assert.deepEqual(inside.value, { applied: true, nodeId: 'n0.1' });
  const swapped = await rpc.answerAppMessage(one, request(2, 'node.insert', { kind: 'component', name: 'Card', replace: 'n2' }), context(named));
  assert.deepEqual(swapped.value, { applied: true, nodeId: 'n2' });
  const reason = 'Not in this editor yet.';
  const limited = { ...named, insertReplace: rpc.unable(reason) };
  const refused = await rpc.answerAppMessage(one, request(3, 'node.insert', { kind: 'component', name: 'Card', replace: 'n2' }), context(limited));
  assert.deepEqual(refused.value, { applied: false, reason });
});

test('events reach only sessions that subscribed, may hear them, and whose role allows the app', async () => {
  const { host } = recordingHost();
  const listening = session();
  await rpc.answerAppMessage(listening, request(1, 'events.subscribe', { events: ['selection.change', 'role.change'] }), context(host));
  assert.deepEqual(rpc.eventForSession(listening, roles.ADMIN_VIEW, 'selection.change', { nodeId: 'n1' }).data, { nodeId: 'n1' });
  assert.equal(rpc.eventForSession(listening, roles.ADMIN_VIEW, 'hover.change', { nodeId: 'n1' }), undefined, 'not subscribed');
  assert.equal(rpc.eventForSession(listening, { ...client, features: new Set() }, 'selection.change', { nodeId: 'n1' }), undefined, 'role lacks the app');
  await rpc.answerAppMessage(listening, request(2, 'events.unsubscribe', { events: ['selection.change'] }), context(host));
  assert.equal(rpc.eventForSession(listening, roles.ADMIN_VIEW, 'selection.change', { nodeId: 'n1' }), undefined);
});

test('Desktop maps each command to the shell setter or gesture the UI uses', async () => {
  const calls = [];
  const record =
    (name, value) =>
    (...args) => {
      calls.push([name, ...args]);
      return value;
    };
  const node = {
    id: 'n0',
    kind: 'element',
    name: 'section',
    props: { class: { type: 'string', value: 'hero dark' }, id: { type: 'string', value: 'top' } },
    children: [],
  };
  const shell = {
    pageState: { editable: true, source: '<section/>', model: { nodes: [node] } },
    currentPage: { path: '/p/src/pages/index.astro' },
    project: { path: '/p' },
    scan: { pages: [{ path: '/p/src/pages/index.astro', name: 'index.astro', route: '/', title: 'Home' }] },
    selectedId: 'n0',
    leftTab: 'navigator',
    rightTab: 'style',
    device: 'desktop',
    insertables: [{ name: 'Card', path: '/p/src/components/Card.astro' }],
    pathFor: (id) => (id === 'n0' ? '0' : undefined),
    setDevice: record('setDevice'),
    requestCanvasWidth: record('requestCanvasWidth'),
    setLeftTab: record('setLeftTab'),
    setRightTab: record('setRightTab'),
    setSelectedId: record('setSelectedId'),
    setRevealTick: record('setRevealTick'),
    setProp: record('setProp'),
    addClassToNode: record('addClassToNode', Promise.resolve({ tag: 'applied' })),
    removeClassFromNode: record('removeClassFromNode', Promise.resolve({ tag: 'refused', message: 'locked' })),
    removeAttributeFromNode: record('removeAttributeFromNode', Promise.resolve({ tag: 'applied' })),
    removeNode: record('removeNode'),
    duplicateNode: record('duplicateNode'),
    insertForApp: record('insertForApp', Promise.resolve({ applied: true, nodeId: 'n0' })),
    undo: record('undo', Promise.resolve()),
    redo: record('redo', Promise.resolve()),
    showToast: record('showToast'),
    flushSave: record('flushSave', Promise.resolve()),
    historyRef: { current: { past: [], future: [], lastPush: 0, lastKey: undefined } },
  };
  const host = desktop.desktopAppHost({ current: shell });
  const run = (ability) => {
    assert.equal(ability.kind, 'able', 'Desktop has every edit');
    return ability.run;
  };
  host.setDevice('phone');
  run(host.setWidth)(500);
  host.openPanel('assets');
  host.openRightPanel('settings');
  host.select('n0');
  assert.deepEqual(await run(host.classes).add('n0', 'big', undefined), { applied: true });
  assert.deepEqual(await run(host.classes).remove('n0', 'hero', undefined), { applied: false, reason: 'locked' });
  assert.deepEqual(await run(host.attributes).set('n0', 'title', 'Hi', undefined), { applied: true });
  assert.deepEqual(await run(host.setStyle)('n0', 'color: red', undefined), { applied: true });
  assert.deepEqual(await host.remove('n9', undefined), { applied: false, reason: 'No editable element has that id on the open page' });
  const card = { item: { kind: 'component', name: 'Card', props: {} }, place: { kind: 'after', anchor: 'n0' }, label: undefined };
  shell.pageStateRef = { current: { pageState: shell.pageState } };
  assert.deepEqual(await host.insertComponent(card), { applied: true, nodeId: 'n0' });
  await run(host.history).undo();
  const names = calls.map(([name]) => name);
  for (const name of [
    'setDevice',
    'requestCanvasWidth',
    'setLeftTab',
    'setRightTab',
    'setSelectedId',
    'setRevealTick',
    'addClassToNode',
    'removeClassFromNode',
    'setProp',
    'insertForApp',
    'undo',
    'flushSave',
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes('removeNode'), 'an unknown node is never removed');
  assert.deepEqual(
    calls.find(([name]) => name === 'setProp'),
    ['setProp', 'n0', 'title', { type: 'string', value: 'Hi' }, true],
  );
  const page = host.page();
  assert.equal(page.path, 'src/pages/index.astro');
  assert.deepEqual(page.nodes[0].classes, ['hero', 'dark']);
  assert.deepEqual(page.nodes[0].attributes, { id: 'top' });
  // Relative to the project, as page.get, page.getTree and page.open name files.
  assert.deepEqual(host.pages(), [{ path: 'src/pages/index.astro', route: '/', title: 'Home' }]);
});

// Undo labels: an app's label names the step its edit pushed, and only that step.
test('Desktop names the undo step an edit pushed with the app’s label, and no other step', async () => {
  const past = [];
  const node = { id: 'n0', kind: 'element', name: 'section', props: {}, children: [] };
  const shell = {
    pageState: { editable: true, source: '<section/>', model: { nodes: [node] } },
    historyRef: { current: { past, future: [], lastPush: 0, lastKey: undefined } },
    setProp: () => past.push({ kind: 'edits', record: { outcome: { tag: 'applied', applied: [] } } }),
    addClassToNode: async () => ({ tag: 'applied' }), // folds into the step before: pushes none
    flushSave: async () => undefined,
  };
  const host = desktop.desktopAppHost({ current: shell });
  assert.equal(host.attributes.kind, 'able');
  await host.attributes.run.set('n0', 'data-pin', '1', 'Pin feedback');
  assert.equal(past.at(-1).label, 'Pin feedback', 'the new step carries the label');
  await host.classes.run.add('n0', 'pinned', 'Mark pinned');
  assert.equal(past.length, 1, 'the class edit pushed no step of its own');
  assert.equal(past[0].label, 'Pin feedback', 'a step the edit did not make keeps its own name');
});

// `can` is read from the very abilities the methods answer from: an unable host says so in
// `app.info` and answers each such method `applied: false` with that same reason.
test('app.info `can` matches every method’s real answer, on a host with and without each ability', async () => {
  const { host } = recordingHost();
  const reason = 'Not in this editor yet.';
  const limited = {
    ...host,
    attributes: rpc.unable(reason),
    classes: rpc.unable(reason),
    setStyle: rpc.unable(reason),
    insertElement: rpc.unable(reason),
    insertAttributes: rpc.unable(reason),
    insertReplace: rpc.unable(reason),
    openPalette: rpc.unable(reason),
    setWidth: rpc.unable(reason),
    snapshot: rpc.unable(reason),
  };
  // A canvas that has drawn every element, and a clock past the snapshot interval at each call.
  let clockMs = 0;
  const canvas = (candidate) => ({
    ...context(candidate),
    measure: { measure: async () => [{ x: 0, y: 0, width: 10, height: 10 }] },
    nowMs: () => (clockMs += contract.APP_RPC_LIMITS.snapshotIntervalMs),
  });
  const probes = {
    setAttribute: ['node.setAttribute', { nodeId: 'n0', name: 'title', value: 'x' }],
    addClass: ['node.addClass', { nodeId: 'n0', className: 'x' }],
    setStyle: ['node.setStyle', { nodeId: 'n0', css: 'color: red' }],
    insertElement: ['node.insert', { kind: 'element', tag: 'div' }],
    // Component inserts are every host's, so these probe the parts beyond the node itself.
    insertAttributes: ['node.insert', { kind: 'component', name: 'Card', props: { title: 'x' } }],
    insertReplace: ['node.insert', { kind: 'component', name: 'Card', replace: 'n0' }],
    openPalette: ['shortcuts.run', { shortcut: 'palette' }],
    undo: ['history.undo', undefined],
    setWidth: ['canvas.setWidth', { widthPx: 800 }],
    scrollTo: ['canvas.scrollTo', { nodeId: 'n0' }],
    snapshot: ['canvas.snapshot', { nodeId: 'n0' }],
  };
  let id = 1;
  for (const candidate of [host, limited]) {
    const one = session();
    const info = await rpc.answerAppMessage(one, request(id++, 'app.info'), context(candidate));
    assert.deepEqual(info.value.host, { kind: 'desktop', version: '1.0.24' });
    assert.deepEqual(Object.keys(info.value.can).sort(), Object.keys(probes).sort(), 'every capability is answered');
    for (const [capability, [method, params]] of Object.entries(probes)) {
      const answer = await rpc.answerAppMessage(one, request(id++, method, params), canvas(candidate));
      // A viewport answer cannot say `applied: false`: an unable setWidth fails with the reason instead.
      const worked = answer.ok && (answer.value.applied === true || answer.value.widthPx !== undefined);
      assert.equal(worked, info.value.can[capability], `${capability}: can says ${info.value.can[capability]}`);
      if (!worked) {
        assert.ok(answer.ok ? answer.value.reason === reason : answer.error.message === reason, `${capability} answers the host's own reason`);
      }
    }
  }
});

test('app.badge sets the rail count through the registry, within its bound', async () => {
  const { host } = recordingHost();
  const set = [];
  const withBadges = { ...context(host), badges: { set: (appId, count) => set.push([appId, count]) } };
  const one = session();
  assert.equal((await rpc.answerAppMessage(one, request(1, 'app.badge', { count: 4 }), withBadges)).ok, true);
  assert.equal((await rpc.answerAppMessage(one, request(2, 'app.badge', { count: 0 }), withBadges)).ok, true);
  assert.equal((await rpc.answerAppMessage(one, request(3, 'app.badge', { count: -1 }), withBadges)).error.code, 'bad-params');
  assert.equal((await rpc.answerAppMessage(one, request(4, 'app.badge', { count: 10_000 }), withBadges)).error.code, 'bad-params');
  assert.deepEqual(set, [
    ['heat-map', 4],
    ['heat-map', 0],
  ]);
});

test('an app’s page edit is marked as its own while it runs', async () => {
  const { host } = recordingHost();
  const marks = [];
  const tracked = {
    ...context(host),
    editOrigin: {
      begin: (appId) => {
        marks.push(['begin', appId]);
        return () => marks.push(['end', appId]);
      },
    },
  };
  await rpc.answerAppMessage(session(), request(1, 'node.remove', { nodeId: 'n0' }), tracked);
  await rpc.answerAppMessage(session(), request(2, 'selection.get'), tracked);
  assert.deepEqual(marks, [
    ['begin', 'heat-map'],
    ['end', 'heat-map'],
  ]);
});

test('person.get answers the host’s person', async () => {
  const { host } = recordingHost();
  const answer = await rpc.answerAppMessage(session(), request(1, 'person.get'), context(host));
  assert.equal(answer.value.id, 'a'.repeat(32));
});

test('page.open and component.open open the file and answer once page.get names it, within the bound', async () => {
  const { host, calls } = recordingHost();
  let open = 'src/pages/index.astro';
  const navigating = {
    ...host,
    pages: () => [
      { path: 'src/pages/index.astro', route: '/', title: undefined },
      { path: 'src/pages/about.astro', route: '/about', title: undefined },
    ],
    page: () => ({ path: open, editable: true, nodes: [], truncated: false }),
    openPage: (path) => {
      calls.push(['openPage', path]);
      setTimeout(() => (open = path), 60); // The editor opens it a few frames later.
      return { applied: true };
    },
    openComponent: rpc.able((path) => {
      calls.push(['openComponent', path]);
      open = path;
      return { applied: true };
    }),
  };
  const one = session();
  const opened = await rpc.answerAppMessage(one, request(1, 'page.open', { path: 'src/pages/about.astro' }), context(navigating));
  assert.deepEqual(opened.value, { applied: true });
  assert.equal(open, 'src/pages/about.astro', 'it answers only once the page is open');
  const unknown = await rpc.answerAppMessage(one, request(2, 'page.open', { path: 'src/pages/missing.astro' }), context(navigating));
  assert.match(unknown.value.reason, /no page at that path/);
  assert.equal((await rpc.answerAppMessage(one, request(3, 'page.open', { path: '/abs/index.astro' }), context(navigating))).error.code, 'bad-params');
  const entered = await rpc.answerAppMessage(one, request(4, 'component.open', { path: 'src/components/Card.astro' }), context(navigating));
  assert.deepEqual(entered.value, { applied: true });
  assert.equal((await rpc.answerAppMessage(one, request(5, 'component.open', { path: 'src/pages/blog.md' }), context(navigating))).error.code, 'bad-params');
  const refused = await rpc.answerAppMessage(
    one,
    request(6, 'component.open', { path: 'src/components/Card.astro' }),
    context({ ...navigating, openComponent: rpc.unable('Not here.') }),
  );
  assert.deepEqual(refused.value, { applied: false, reason: 'Not here.' });
});

test('page.open says when the editor does not open the page in time', async (testContext) => {
  testContext.mock.timers.enable({ apis: ['setTimeout'] });
  const { host } = recordingHost();
  const stuck = {
    ...host,
    pages: () => [{ path: 'src/pages/a.astro', route: '/a', title: undefined }],
    page: () => undefined,
    openPage: () => ({ applied: true }),
  };
  const answer = rpc.answerAppMessage(session(), request(1, 'page.open', { path: 'src/pages/a.astro' }), context(stuck));
  for (let step = 0; step <= contract.APP_RPC_LIMITS.navigateTimeoutMs / 50; step += 1) {
    await Promise.resolve();
    testContext.mock.timers.tick(50);
  }
  assert.match((await answer).value.reason, /did not open src\/pages\/a.astro within 5 s/);
});

test('canvas.scrollTo waits for the element, aligns `start` itself, and scrolls points through the canvas', async () => {
  const { host, calls } = recordingHost();
  const told = [];
  let measured = 0;
  const canvas = {
    ...context(host),
    tellCanvas: (message) => told.push(message) > 0,
    // Drawn on the third measurement: a page just opened.
    measure: { measure: async () => (++measured >= 3 ? [{ x: 10, y: 400, width: 100, height: 50 }] : []) },
  };
  const one = session();
  assert.deepEqual((await rpc.answerAppMessage(one, request(1, 'canvas.scrollTo', { nodeId: 'n0', block: 'start' }), canvas)).value, { applied: true });
  assert.equal(measured, 3);
  assert.deepEqual(told, [{ type: 'avb:app-scroll', space: 'viewport', x: 10, y: 400, w: 100, h: 50, block: 'start' }]);
  assert.equal(calls.length, 0, 'start aligns without the editor’s reveal');
  await rpc.answerAppMessage(one, request(2, 'canvas.scrollTo', { nodeId: 'n0', occurrence: 1 }), canvas);
  assert.deepEqual(calls.at(-1), ['scrollTo', { nodeId: 'n0', occurrence: 1, block: 'center' }]);
  await rpc.answerAppMessage(one, request(3, 'canvas.scrollTo', { x: 0, y: 1200 }), canvas);
  assert.deepEqual(told.at(-1), { type: 'avb:app-scroll', space: 'page', x: 0, y: 1200, w: 0, h: 0, block: 'center' });
  const never = { ...canvas, measure: { measure: async () => [] } };
  assert.match((await rpc.answerAppMessage(one, request(4, 'canvas.scrollTo', { nodeId: 'n9' }), never)).value.reason, /not drawn on the canvas within 5 s/);
  for (const bad of [
    { nodeId: 'n0', block: 'end' },
    { x: -1, y: 0 },
    { nodeId: 'n0', occurrence: -1 },
  ]) {
    assert.equal((await rpc.answerAppMessage(one, request(5, 'canvas.scrollTo', bad), canvas)).error.code, 'bad-params', JSON.stringify(bad));
  }
});

test('canvas.snapshot photographs the measured box, once per interval per app, within its bounds', async () => {
  const { host, calls } = recordingHost();
  let nowMs = 100_000;
  const canvas = { ...context(host), nowMs: () => nowMs, measure: { measure: async () => [{ x: 5, y: 6, width: 70, height: 80 }] } };
  const pins = session('pins-snapshot');
  const first = await rpc.answerAppMessage(pins, request(1, 'canvas.snapshot', { nodeId: 'n0', widthMax: 200 }), canvas);
  assert.equal(first.value.applied, true);
  assert.deepEqual(calls.at(-1), ['snapshot', { x: 5, y: 6, width: 70, height: 80 }, 200]);
  nowMs += contract.APP_RPC_LIMITS.snapshotIntervalMs - 1;
  assert.match((await rpc.answerAppMessage(pins, request(2, 'canvas.snapshot', { nodeId: 'n0' }), canvas)).value.reason, /One snapshot per 1 s/);
  // Another app keeps its own rate.
  assert.equal((await rpc.answerAppMessage(session('notes-snapshot'), request(3, 'canvas.snapshot', { nodeId: 'n0' }), canvas)).value.applied, true);
  assert.deepEqual(calls.at(-1), ['snapshot', { x: 5, y: 6, width: 70, height: 80 }, contract.APP_RPC_LIMITS.snapshotWidthPxDefault]);
  nowMs += 1;
  assert.equal((await rpc.answerAppMessage(pins, request(4, 'canvas.snapshot', { nodeId: 'n0' }), canvas)).value.applied, true);
  for (const widthMax of [15, contract.APP_RPC_LIMITS.snapshotWidthPxMax + 1, 'wide']) {
    assert.equal((await rpc.answerAppMessage(pins, request(5, 'canvas.snapshot', { nodeId: 'n0', widthMax }), canvas)).error.code, 'bad-params');
  }
});
