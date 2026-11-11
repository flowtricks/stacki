// Goal: an app frame's keys, Stacki's override points and app commands behave as
// docs/apps.md says.
// - Shortcuts: the SDK forwards undo, redo, save, the palette and Escape once per
//   press; a text field keeps its own undo; a listener's preventDefault() and a
//   claim keep the key in the app; a reserved key runs a command. Desktop's menu
//   (which takes ⌘Z before a focused frame sees it) routes to the field, to an app
//   that claims the key, or to Stacki, never two of them.
// - Overrides: picked, default, cancel, the time limit and an app closing
//   mid-request each end a request once; the latest running registration owns a
//   point and the others queue; a role without the app or the point's panel gets
//   Stacki's picker; Alt bypasses the app. A pick is written through the field's
//   own pick callbacks, the same call the Assets panel's pick makes, so it is the
//   one undo step a panel pick is. A pick with alt text is one write of both, and
//   on the undo stack one step: undo puts the image and its alt back together.
// - Commands: the first installed app keeps a shortcut, a rebind moves one, a
//   command whose app is not running launches it and reaches it once its frame
//   listens, and no Stacki rich text shortcut answers a reserved key.
// A `commands.register` call replaces the app's earlier runtime commands, keys
// and all; an empty list clears them.
// Method: one esbuild bundle of the runtime, dispatcher, slot, asset pick and
// commands (so they share module state) run against JSDOM; the SDK runs inside a
// JSDOM iframe whose posts to its parent are recorded, and answers are dispatched
// back as message events from the parent window. The undo stack is the app's
// AppHistory, placed by its own rule (editStepPlacement) and filled by the real
// gestures (propsGesture) the element's alt writer (altPickWriter) commits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<iframe id="app"></iframe><iframe id="other"></iframe>', {
  url: 'http://localhost',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent']) {
  global[key] = key === 'window' ? dom.window : dom.window[key];
}
Object.defineProperty(global, 'localStorage', { configurable: true, value: dom.window.localStorage });
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });

const directory = repoPath('node_modules/.stacki-test/app-shortcuts-overrides');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'bundle.cjs');
esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/features/apps/appsRuntime';",
      "export { createAppOverrides } from './src/features/apps/appOverrides';",
      "export { setAppOverrideSlot, askAppOverride } from './src/ui/appOverrideSlot';",
      "export { chooseAsset, onAssetRequest } from './src/ui/assetPick';",
      "export { bindCommands, parseRebinds, configureAppCommands, runShortcutCommand, runAppCommand, rebindCommand, resetAppCommands, registerAppCommands } from './src/features/apps/appCommands';",
      "export { answerAppMessage, inFlightCounter } from './src/features/apps/appRpcHost';",
      "export { appSdkSource } from './shared/properties/appSdk';",
      "export { shortcutAction } from './src/ui/richTextCommands';",
      "export { APP_RESERVED_SHORTCUTS } from './shared/properties/appShortcuts';",
      "export { ADMIN_VIEW } from './shared/properties/projectRoles';",
      "export { editStepPlacement } from './src/app/model/editSteps';",
      "export { propsGesture } from './src/editor/editGestures';",
      "export { altPickWriter } from './src/features/props/elementState';",
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
const client = { id: 'client', name: 'Client', isAdmin: false, features: new Set(['panel:apps', 'panel:assets', 'panel:cms', 'app:picker']) };

function summary(id, { installedAt = '2026-11-10T00:00:00.000Z', commands = [], shortcutClaims = [] } = {}) {
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name: `App ${id}`,
      version: '1.0.0',
      description: '',
      icon: undefined,
      entry: 'index.html',
      window: { mode: 'popup', widthPx: undefined, heightPx: undefined },
      source: undefined,
      authorGitHub: undefined,
      commands,
      shortcutClaims,
    },
    lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt, source: { kind: 'file', fileName: `${id}.zip` }, update: undefined, autoUpdate: false },
  };
}

function hostCommands(calls) {
  const record =
    (name, value) =>
    (...args) => {
      calls.push([name, ...args]);
      return value;
    };
  const applied = { applied: true };
  return {
    viewport: record('viewport', { widthPx: 1, heightPx: 1, scale: 1, device: 'desktop' }),
    selection: record('selection', { nodeId: 'n0' }),
    history: { kind: 'able', run: { undo: record('undo', Promise.resolve(applied)), redo: record('redo', Promise.resolve(applied)) } },
    save: record('save', Promise.resolve(applied)),
    openPalette: { kind: 'able', run: record('openPalette', applied) },
    escape: record('escape', applied),
    notify: record('notify'),
  };
}

// The SDK in a JSDOM iframe: what it posts to its parent is recorded, and `answer` replies as the host would.
function sdkFrame() {
  const frame = dom.window.document.createElement('iframe');
  dom.window.document.body.append(frame);
  const child = frame.contentWindow;
  const posts = [];
  const record = (event) => {
    if (event.data?.stacki === 'app') {
      posts.push(event.data);
    }
  };
  dom.window.addEventListener('message', record);
  child.eval(apps.appSdkSource());
  const reply = (data) => child.dispatchEvent(new child.MessageEvent('message', { data, source: dom.window }));
  return {
    child,
    posts,
    reply,
    answer: (id, value) => reply({ stacki: 'host', v: 1, id, ok: true, value }),
    press: (target, init) => {
      const event = new child.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
    stop: () => {
      dom.window.removeEventListener('message', record);
      frame.remove();
    },
  };
}

test('the SDK forwards each editor shortcut once, and leaves text fields and opted-out keys alone', async () => {
  const sdk = sdkFrame();
  const body = sdk.child.document.body;
  body.innerHTML = '<input id="field"><div contenteditable="true"><span id="rich">x</span></div><button id="keeps">k</button>';
  await settle();
  sdk.posts.length = 0;
  const undo = sdk.press(body, { key: 'z', code: 'KeyZ', metaKey: true });
  sdk.press(body, { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
  sdk.press(body, { key: 's', code: 'KeyS', metaKey: true });
  sdk.press(body, { key: 'e', code: 'KeyE', metaKey: true });
  sdk.press(body, { key: 'Escape', code: 'Escape' });
  sdk.press(body, { key: 'k', code: 'KeyK', metaKey: true });
  await settle();
  assert.equal(undo.defaultPrevented, true, 'a forwarded key goes no further: the menu does not take it as well');
  assert.deepEqual(
    sdk.posts.filter((post) => post.method === 'shortcuts.run').map((post) => post.params.shortcut),
    ['undo', 'redo', 'save', 'palette', 'escape'],
    'one request per press, ⌘K is the app’s',
  );
  sdk.posts.length = 0;
  const typed = sdk.press(sdk.child.document.getElementById('field'), { key: 'z', code: 'KeyZ', metaKey: true });
  sdk.press(sdk.child.document.getElementById('rich'), { key: 'z', code: 'KeyZ', metaKey: true });
  const keeps = sdk.child.document.getElementById('keeps');
  keeps.addEventListener('keydown', (event) => event.preventDefault());
  sdk.press(keeps, { key: 'z', code: 'KeyZ', metaKey: true });
  await settle();
  assert.equal(typed.defaultPrevented, false, 'the field’s own undo runs');
  assert.deepEqual(
    sdk.posts.filter((post) => post.method === 'shortcuts.run'),
    [],
    'fields and preventDefault keep the key',
  );
  sdk.stop();
});

test('a claim keeps the key in the app, heard as shortcut.press; a reserved key runs a command', async () => {
  const sdk = sdkFrame();
  const body = sdk.child.document.body;
  await settle();
  const pressed = [];
  sdk.child.stacki.on('shortcut.press', (data) => pressed.push(data.shortcut));
  const claiming = sdk.child.stacki.shortcuts.claim(['mod+z']);
  await settle();
  const request = sdk.posts.find((post) => post.method === 'shortcuts.claim');
  assert.equal(JSON.stringify(request.params), JSON.stringify({ shortcuts: ['mod+z'] }));
  sdk.answer(request.id, { shortcuts: ['Mod+Z'] });
  await claiming;
  sdk.posts.length = 0;
  sdk.press(body, { key: 'z', code: 'KeyZ', metaKey: true });
  sdk.press(body, { key: '¡', code: 'Digit1', metaKey: true, altKey: true, shiftKey: true });
  await settle();
  assert.deepEqual(pressed, ['Mod+Z']);
  assert.equal(
    JSON.stringify(sdk.posts.filter((post) => post.method !== 'events.subscribe').map((post) => [post.method, post.params])),
    JSON.stringify([['commands.trigger', { shortcut: 'Mod+Alt+Shift+1' }]]),
  );
  sdk.stop();
});

test('the menu routes ⌘Z to a field in the app, an app that claims it, or Stacki, once', () => {
  apps.resetAppsRuntime();
  const frame = dom.window.document.getElementById('app');
  const claims = summary('claims', { shortcutClaims: ['Mod+Z'] });
  const plain = summary('plain');
  const context = { host: hostCommands([]), role: () => apps.ADMIN_VIEW, setOverlay: () => undefined };
  apps.configureAppsRuntime(context.host, context.role);
  apps.launchApp(plain, 'popup');
  const detach = apps.attachAppFrame(frame.contentWindow, plain);
  frame.focus();
  assert.equal(apps.appShortcutRoute('Mod+Z', frame), 'stacki', 'focus in the app, not in a field: Stacki’s undo');
  assert.equal(apps.appShortcutRoute('Mod+Z', dom.window.document.body), 'stacki', 'focus in the editor');
  detach();
  const again = apps.attachAppFrame(frame.contentWindow, claims);
  assert.equal(apps.appShortcutRoute('Mod+Z', frame), 'app', 'a manifest claim is known before the key');
  assert.equal(apps.appShortcutRoute('Mod+Shift+Z', frame), 'stacki', 'only the claimed key');
  again();
});

test('overrides: picked, default, cancel, timeout, app closed, ownership order, role', async () => {
  const posts = [];
  const running = new Set(['first', 'second']);
  let role = apps.ADMIN_VIEW;
  const overrides = apps.createAppOverrides({
    post: (session, message) => posts.push([session.app.manifest.id, message]),
    role: () => role,
    running: (id) => running.has(id),
    selection: () => 'n7',
    timeoutMs: 30,
  });
  const session = (id) => ({ app: summary(id), subscriptions: new Set(), ...apps.inFlightCounter() });
  const first = session('first');
  const second = session('second');
  const ask = { point: 'cms.bind', context: { purpose: 'field', current: undefined, paths: ['post.title'] } };
  assert.equal((await overrides.dispatch(ask).answer).result.kind, 'default', 'no owner: Stacki’s picker');
  assert.deepEqual(overrides.register(first, 'cms.bind'), { owner: true });
  assert.deepEqual(overrides.register(second, 'cms.bind'), { owner: true });
  assert.equal(overrides.ownerOf('cms.bind'), second, 'the latest registration owns the point');

  const picked = overrides.dispatch(ask);
  const [to, request] = posts.at(-1);
  assert.equal(to, 'second');
  assert.equal(request.event, 'override.request');
  assert.equal(request.data.context.selection, 'n7', 'cms.bind says what is selected');
  assert.deepEqual(
    overrides.resolve(first, request.data.call, { point: 'cms.bind', result: { kind: 'picked', path: 'post.title' } }).applied,
    false,
    'another app cannot answer',
  );
  assert.equal(overrides.resolve(second, request.data.call, { point: 'assets.pick', result: { kind: 'default' } }).applied, false, 'nor at another point');
  assert.equal(overrides.resolve(second, request.data.call, { point: 'cms.bind', result: { kind: 'picked', path: 'post.title' } }).applied, true);
  assert.deepEqual((await picked.answer).result, { kind: 'picked', path: 'post.title' });
  assert.equal(overrides.resolve(second, request.data.call, { point: 'cms.bind', result: { kind: 'default' } }).applied, false, 'answered once');

  const cancelled = overrides.dispatch(ask);
  cancelled.cancel();
  assert.equal((await cancelled.answer).result.kind, 'cancel');
  assert.equal(posts.at(-1)[1].event, 'override.cancel', 'the app is told to close its picker');

  const timed = overrides.dispatch(ask);
  assert.equal((await timed.answer).result.kind, 'default', 'the time limit means Stacki’s picker');
  assert.equal(posts.at(-1)[1].event, 'override.cancel');

  const closing = overrides.dispatch(ask);
  overrides.drop(second);
  assert.equal((await closing.answer).result.kind, 'default', 'the app went away mid-request');
  assert.equal(overrides.ownerOf('cms.bind'), first, 'the next registration owns the point again');

  running.delete('first');
  overrides.changed();
  assert.equal(overrides.ownerOf('cms.bind'), undefined, 'an app that stopped owns nothing');
  running.add('first');
  role = { ...client, features: new Set(['panel:apps', 'panel:assets', 'app:first']) };
  assert.equal(overrides.ownerOf('cms.bind'), undefined, 'a role without the CMS keeps Stacki’s picker');
  role = { ...client, features: new Set(['panel:apps', 'panel:cms']) };
  assert.equal(overrides.ownerOf('cms.bind'), undefined, 'a role without the app keeps Stacki’s picker');
  assert.equal(overrides.waiting(), 0);
});

test('an asset pick is written through the field’s own callbacks; Alt and a URL the field cannot take open Stacki’s picker', async () => {
  const writes = [];
  const opened = [];
  const stop = apps.onAssetRequest((request) => request !== undefined && opened.push(request.current));
  // A field's request as AssetField builds it: onPick writes a project path, onPickURL a URL.
  const request = (urls) => ({
    mediaKind: 'image',
    current: 'public/old.png',
    onPick: (rel) => writes.push(['value', rel, true]),
    ...(urls ? { onPickURL: (url) => writes.push(['value', url, true]) } : {}),
    onPickWithAlt: (pick, alt) => writes.push(['with alt', pick, alt]),
  });
  let answer = { kind: 'default' };
  const asked = [];
  apps.setAppOverrideSlot({
    owner: () => 'Picker',
    dispatch: (ask) => {
      asked.push(ask);
      return { answer: Promise.resolve({ point: 'assets.pick', result: answer }), cancel: () => undefined };
    },
    subscribe: () => () => undefined,
  });
  answer = { kind: 'picked', url: 'https://cdn.example/a.png', alt: 'A dog' };
  await apps.chooseAsset(request(true), { bypass: false, target: { nodeId: 'n3', field: 'src' } });
  assert.deepEqual(asked[0].context, { nodeId: 'n3', field: 'src', accepts: ['image'], current: 'public/old.png', acceptsURL: true });
  const fromApp = writes.splice(0);
  assert.deepEqual(fromApp, [['with alt', { kind: 'url', url: 'https://cdn.example/a.png' }, 'A dog']], 'the URL and its alt are one write');
  answer = { kind: 'picked', url: 'https://cdn.example/a.png', alt: undefined };
  await apps.chooseAsset(request(true), { bypass: false, target: undefined });
  const withoutAlt = writes.splice(0);
  // The Assets panel's own pick of the same file calls the same callback with the same arguments.
  request(true).onPickURL('https://cdn.example/a.png');
  assert.deepEqual(writes.splice(0), withoutAlt);
  writes.length = 0;
  answer = { kind: 'picked', url: 'public/images/b.png', alt: undefined };
  await apps.chooseAsset(request(false), { bypass: false, target: undefined });
  assert.deepEqual(writes, [['value', 'public/images/b.png', true]]);
  writes.length = 0;
  answer = { kind: 'picked', url: 'https://cdn.example/a.png', alt: undefined };
  await apps.chooseAsset(request(false), { bypass: false, target: undefined });
  assert.deepEqual(writes, [], 'a URL for a field of project files is not written');
  assert.equal(opened.length, 1, 'Stacki’s picker opens instead');
  answer = { kind: 'cancel' };
  await apps.chooseAsset(request(true), { bypass: false, target: undefined });
  assert.equal(opened.length, 1, 'cancel changes nothing');
  const before = asked.length;
  await apps.chooseAsset(request(true), { bypass: true, target: undefined });
  assert.equal(asked.length, before, 'Alt-click never asks the app');
  assert.equal(opened.length, 2, 'Alt-click opens Stacki’s picker');
  apps.setAppOverrideSlot(undefined);
  stop();
});

// The undo stack as the app keeps it (pushEditHistory in appHistory.ts): each
// committed gesture is placed by the app's own rule, and a new step remembers
// the model it started from, which undo restores.
function undoStack(model) {
  const history = { past: [], future: [], lastPush: 0, lastKey: undefined };
  const before = new Map();
  let shown = model;
  return {
    history,
    shown: () => shown,
    commit: (gesture) => {
      const now = Date.now();
      const placement = apps.editStepPlacement(history, gesture.coalesceKey, undefined, now);
      history.future = [];
      history.lastKey = gesture.coalesceKey;
      history.lastPush = now;
      if (placement === 'new') {
        const record = { outcome: { tag: 'applied', applied: [] } };
        history.past.push({ kind: 'edits', record });
        before.set(record, shown);
      }
      shown = gesture.apply(shown);
    },
    undo: () => {
      const step = history.past.pop();
      assert.ok(step !== undefined, 'there is a step to undo');
      history.future.push(step);
      shown = before.get(step.record);
    },
  };
}

test('a pick with alt text is one undo step: one undo restores the image and its alt', async () => {
  const image = {
    id: 'n3',
    kind: 'element',
    name: 'img',
    props: { src: { type: 'string', value: '/old.png' }, alt: { type: 'string', value: 'Old photo' } },
    children: [],
  };
  const stack = undoStack({ nodes: [image], imports: [] });
  // An earlier, unrelated edit: the step the pick must not fold into, and must not undo.
  stack.commit(apps.propsGesture('n3', { loading: { type: 'string', value: 'lazy' } }, { coalesceKey: 'prop:n3:loading', urgency: true }));
  const previous = stack.shown();
  const assetWrites = [];
  // The element's writers as AppPanes.tsx builds them: setProp, setProps and setAssetProp's keys.
  const write = apps.altPickWriter(
    {
      node: image,
      onSetProps: (nodeId, patch) =>
        stack.commit(apps.propsGesture(nodeId, patch, { coalesceKey: `props:${nodeId}:${Object.keys(patch).join(',')}`, urgency: true })),
      onSetAssetProp: (...args) => assetWrites.push(args),
    },
    [],
  );
  assert.equal(typeof write, 'function', 'an <img> takes the alt an app picks');
  // The field's request as AssetField builds it for `src`.
  const request = {
    mediaKind: 'image',
    current: 'public/old.png',
    onPick: () => assert.fail('a pick with alt goes through onPickWithAlt'),
    onPickURL: (url) => stack.commit(apps.propsGesture('n3', { src: { type: 'string', value: url } }, { coalesceKey: 'prop:n3:src', urgency: true })),
    onPickWithAlt: (pick, alt) => write('src', pick.kind === 'url' ? { kind: 'value', value: pick.url } : assert.fail('a URL was picked'), alt),
  };
  apps.setAppOverrideSlot({
    owner: () => 'Picker',
    dispatch: () => ({
      answer: Promise.resolve({ point: 'assets.pick', result: { kind: 'picked', url: 'https://cdn.example/dog.png', alt: 'A dog' } }),
      cancel: () => undefined,
    }),
    subscribe: () => () => undefined,
  });
  const stepsBefore = stack.history.past.length;
  await apps.chooseAsset(request, { bypass: false, target: { nodeId: 'n3', field: 'src' } });
  assert.equal(stack.history.past.length, stepsBefore + 1, 'the pick is one step on the undo stack');
  const picked = stack.shown().nodes[0].props;
  assert.deepEqual(picked.src, { type: 'string', value: 'https://cdn.example/dog.png' });
  assert.deepEqual(picked.alt, { type: 'string', value: 'A dog' });
  stack.undo();
  assert.equal(stack.shown(), previous, 'one undo restores the model from before the pick, src and alt alike');
  assert.deepEqual(stack.shown().nodes[0].props.src, { type: 'string', value: '/old.png' });
  assert.deepEqual(stack.shown().nodes[0].props.alt, { type: 'string', value: 'Old photo' });
  assert.equal(stack.shown().nodes[0].props.loading.value, 'lazy', 'the earlier edit is still there: undo took one step');
  // A project file with alt text goes through the asset write, the alt carried into its one edit.
  write('src', { kind: 'entry', entry: { rel: 'src/assets/dog.png', root: 'src' } }, 'A dog');
  assert.deepEqual(assetWrites, [['n3', 'src', { rel: 'src/assets/dog.png', root: 'src' }, 'url', { alt: { type: 'string', value: 'A dog' } }]]);
  // An element without an alt takes none.
  assert.equal(apps.altPickWriter({ node: { ...image, name: 'video' }, onSetProps: () => undefined }, []), undefined);
  apps.setAppOverrideSlot(undefined);
});

test('commands: the first installed app keeps a shortcut; rebinds move or clear one', () => {
  const early = summary('early', {
    installedAt: '2026-01-01T00:00:00.000Z',
    commands: [{ id: 'go', title: 'Go', shortcut: 'Mod+Alt+Shift+1', panel: undefined }],
  });
  const late = summary('late', { installedAt: '2026-06-01T00:00:00.000Z', commands: [{ id: 'go', title: 'Go', shortcut: 'Mod+Alt+Shift+1', panel: 'p' }] });
  const bound = apps.bindCommands([late, early], new Map(), {});
  assert.equal(bound.find((entry) => entry.app === early).shortcut, 'Mod+Alt+Shift+1');
  assert.deepEqual(bound.find((entry) => entry.app === late).inUse, { shortcut: 'Mod+Alt+Shift+1', holder: 'App early' });
  const moved = apps.bindCommands([late, early], new Map(), { late: { go: 'Mod+Alt+Shift+2' } });
  assert.equal(moved.find((entry) => entry.app === late).shortcut, 'Mod+Alt+Shift+2');
  const cleared = apps.bindCommands([late, early], new Map(), { early: { go: 'none' } });
  assert.equal(cleared.find((entry) => entry.app === late).shortcut, 'Mod+Alt+Shift+1', 'clearing the holder frees the key');
  assert.deepEqual(
    apps.parseRebinds({ late: { go: 'Mod+Z', ok: 'none', key: 'Mod+Alt+Shift+9' } }),
    { late: { ok: 'none', key: 'Mod+Alt+Shift+9' } },
    'only reserved keys',
  );
  assert.throws(() => apps.parseRebinds('x'), /Expected object/);
});

test('a command launches its app when it is not running and reaches it once its frame listens', async () => {
  apps.resetAppsRuntime();
  apps.resetAppCommands();
  const calls = [];
  const host = hostCommands(calls);
  let role = apps.ADMIN_VIEW;
  apps.configureAppsRuntime(host, () => role);
  const app = summary('picker', { commands: [{ id: 'images', title: 'Images', shortcut: 'Mod+Alt+Shift+3', panel: 'images' }] });
  apps.configureAppCommands('/projects/site', [app], () => role);
  assert.equal(apps.runShortcutCommand('Mod+Alt+Shift+4'), false, 'a free key is not taken');
  assert.equal(apps.runShortcutCommand('Mod+Alt+Shift+3'), true);
  assert.deepEqual(
    apps.runningApps().map((running) => running.app.manifest.id),
    ['picker'],
    'launched',
  );
  // The app's frame loads, subscribes to command.run, and hears the run that waited for it.
  const frame = dom.window.document.getElementById('other');
  const heard = [];
  // JSDOM's postMessage takes no options object; the frame's posts are read here instead.
  frame.contentWindow.postMessage = (message) => {
    if (message?.event === 'command.run') {
      heard.push(message.data);
    }
  };
  const detach = apps.attachAppFrame(frame.contentWindow, app);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: { stacki: 'app', v: 1, id: 1, method: 'events.subscribe', params: { events: ['command.run'] } },
      source: frame.contentWindow,
    }),
  );
  await settle();
  await settle();
  assert.equal(JSON.stringify(heard), JSON.stringify([{ id: 'images', panel: 'images', shortcut: 'Mod+Alt+Shift+3' }]));
  role = { ...client, features: new Set(['panel:apps']) };
  assert.equal(apps.runShortcutCommand('Mod+Alt+Shift+3'), false, 'a role without the app has none of its commands');
  detach();
  apps.resetAppCommands();
  apps.resetAppsRuntime();
});

test("commands.register replaces the app's earlier runtime commands", () => {
  apps.resetAppsRuntime();
  apps.resetAppCommands();
  const role = apps.ADMIN_VIEW;
  apps.configureAppsRuntime(hostCommands([]), () => role);
  const app = summary('pins', { commands: [] });
  apps.configureAppCommands('/projects/site', [app], () => role);
  apps.launchApp(app, 'panel');
  apps.registerAppCommands('pins', [{ id: 'old', title: 'Old', shortcut: 'Mod+Alt+Shift+5', panel: undefined }]);
  assert.equal(apps.runAppCommand('pins', 'old'), true, 'a registered command runs');
  apps.registerAppCommands('pins', [{ id: 'new', title: 'New', shortcut: 'Mod+Alt+Shift+6', panel: undefined }]);
  assert.equal(apps.runAppCommand('pins', 'old'), false, 'the earlier registration is gone');
  assert.equal(apps.runShortcutCommand('Mod+Alt+Shift+5'), false, 'and its key is free');
  assert.equal(apps.runAppCommand('pins', 'new'), true);
  apps.registerAppCommands('pins', []);
  assert.equal(apps.runAppCommand('pins', 'new'), false, 'an empty list clears them');
  apps.resetAppCommands();
  apps.resetAppsRuntime();
});

test('no rich text shortcut answers a key in the reserved range', () => {
  for (const shortcut of apps.APP_RESERVED_SHORTCUTS) {
    const digit = shortcut.at(-1);
    assert.equal(apps.shortcutAction({ key: digit, code: `Digit${digit}`, mod: true, shift: true, alt: true }), undefined, shortcut);
  }
  assert.notEqual(apps.shortcutAction({ key: '1', code: 'Digit1', mod: true, shift: false, alt: true }), undefined, '⌥⌘1 is still a heading');
});
