// Goal: Desktop's Edit menu Copy and Paste (⌘C, ⌘V, Ctrl+C, Ctrl+V) act on a text
// field in a focused app frame, as they do in Stacki's own panels (issue #93).
// The menu takes those keys before the page sees them, and the app is another
// document, so the editor sees only its frame focused: Paste used to paste the
// copied element, or nothing, and the field never got the text. Now the menu asks
// the apps runtime, which knows from the app's SDK whether one of its fields has
// focus, and hands the key to the browser's own copy or paste in the focused frame.
// Negative space: focus on a button in the app, focus in the editor, an app frame
// that never attached, and an app that claims the key each keep their old route,
// so canvas element copy and paste still work wherever no app field has focus.
// No app ever reads the clipboard: only the native paste, which the person chose.
// Method: one esbuild bundle of the runtime and the app's key handling (so they
// share module state) runs against JSDOM. The SDK runs inside a JSDOM iframe; its
// `shortcuts.focus` reports are delivered to the editor's window as message events
// from that frame, as Electron delivers them. `window.avb` records the native
// edits the menu asks the main process for. jsdom cannot paste for real: the
// Electron side (webContents.paste on the focused frame) is checked by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<iframe id="canvas"></iframe>', {
  url: 'http://localhost',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent']) {
  global[key] = key === 'window' ? dom.window : dom.window[key];
}
Object.defineProperty(global, 'localStorage', { configurable: true, value: dom.window.localStorage });
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });

const directory = repoPath('node_modules/.stacki-test/app-frame-paste');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'bundle.cjs');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { attachAppFrame, configureAppsRuntime, launchApp, resetAppsRuntime } from './src/features/apps/appsRuntime';",
      "export { menuCopy, menuPaste } from './src/app/model/appKeys';",
      "export { appSdkSource } from './shared/properties/appSdk';",
      "export { ADMIN_VIEW } from './shared/properties/projectRoles';",
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

// The SDK's report of the focused field travels as a message, which jsdom delivers in a later task of its own: two turns of the
// timer queue run it and the answer it causes.
const settle = async () => {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function summary(id, { shortcutClaims = [] } = {}) {
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
      commands: [],
      shortcutClaims,
    },
    lock: {
      id,
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      installedAt: '2026-11-10T00:00:00.000Z',
      source: { kind: 'file', fileName: `${id}.zip` },
      update: undefined,
      autoUpdate: false,
    },
  };
}

const host = {
  viewport: () => ({ widthPx: 1, heightPx: 1, scale: 1, device: 'desktop' }),
  selection: () => ({ nodeId: 'n0' }),
  history: { kind: 'unable' },
  save: () => Promise.resolve({ applied: true }),
  openPalette: { kind: 'unable' },
  escape: () => ({ applied: true }),
  notify: () => undefined,
};

// What the menu did: a native edit asked of the main process, or a canvas element copy or paste.
function recordingMenu(calls) {
  window.avb = {
    nativeCopy: () => (calls.push('native copy'), Promise.resolve({ ok: true })),
    nativePaste: () => (calls.push('native paste'), Promise.resolve({ ok: true })),
  };
  return {
    selectedIdRef: { current: 'n1' },
    pseudoPickRef: { current: undefined },
    pageStateRef: { current: { pageState: { editable: true } } },
    cmsOpenRef: { current: false },
    nodeClipboardRef: { current: { markup: '<div/>' } },
    copyNode: () => calls.push('element copy'),
    pasteNode: () => (calls.push('element paste'), Promise.resolve()),
    reportFailure: (error) => calls.push(String(error)),
  };
}

// The SDK in the app's frame, with each request it posts delivered to the editor as from that frame.
function appFrame(app) {
  apps.resetAppsRuntime();
  apps.configureAppsRuntime(host, () => apps.ADMIN_VIEW);
  apps.launchApp(app, 'popup');
  // A fresh frame each time: the SDK reports a change of focus, so one left over would stay silent.
  const frame = dom.window.document.createElement('iframe');
  dom.window.document.body.append(frame);
  const child = frame.contentWindow;
  const detach = apps.attachAppFrame(child, app);
  const deliver = (event) => {
    if (event.data?.stacki === 'app' && event.source !== child) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: event.data, source: child }));
    }
  };
  dom.window.addEventListener('message', deliver);
  // And the editor's answers and events back to the app, as from its parent: this jsdom's postMessage
  // refuses the options form the runtime uses.
  child.postMessage = (data) => child.dispatchEvent(new child.MessageEvent('message', { data, source: dom.window }));
  child.eval(apps.appSdkSource());
  child.document.body.innerHTML = '<input id="field"><textarea id="notes"></textarea><button id="button">b</button>';
  return {
    frame,
    child,
    focus: async (id) => {
      frame.focus();
      child.document.getElementById(id).focus();
      await settle();
    },
    stop: () => {
      dom.window.removeEventListener('message', deliver);
      detach();
      frame.remove();
    },
  };
}

test('⌘V and ⌘C in a focused app’s text field are the field’s own, through the browser’s paste and copy', async () => {
  const calls = [];
  const menu = recordingMenu(calls);
  const app = appFrame(summary('fields'));
  await app.focus('field');
  assert.equal(document.activeElement, app.frame, 'the editor sees only the app’s frame focused');
  apps.menuPaste(menu);
  apps.menuCopy(menu);
  await app.focus('notes');
  apps.menuPaste(menu);
  assert.deepEqual(calls, ['native paste', 'native copy', 'native paste'], 'an input and a textarea each get the paste, and no element is pasted');
  app.stop();
  delete window.avb;
});

test('with no app field focused, ⌘V and ⌘C stay the canvas element’s', async () => {
  const calls = [];
  const menu = recordingMenu(calls);
  const app = appFrame(summary('button'));
  await app.focus('button');
  apps.menuPaste(menu);
  apps.menuCopy(menu);
  assert.deepEqual(calls, ['element paste', 'element copy'], 'a button in the app is not a text field');
  calls.length = 0;
  await app.focus('field');
  app.frame.blur();
  dom.window.document.body.focus();
  apps.menuPaste(menu);
  apps.menuCopy(menu);
  assert.deepEqual(calls, ['element paste', 'element copy'], 'focus back in the editor: the app’s last field report does not count');
  calls.length = 0;
  dom.window.document.getElementById('canvas').focus();
  apps.menuPaste(menu);
  assert.deepEqual(calls, ['element paste'], 'a frame that is not an app’s (the canvas, an app not yet attached) is Stacki’s');
  app.stop();
  delete window.avb;
});

test('an app that claims ⌘V hears it as shortcut.press, and neither the field nor the canvas pastes', async () => {
  const calls = [];
  const menu = recordingMenu(calls);
  const app = appFrame(summary('claims', { shortcutClaims: ['Mod+V'] }));
  const pressed = [];
  app.child.stacki.on('shortcut.press', (data) => pressed.push(data.shortcut));
  await app.focus('field');
  apps.menuPaste(menu);
  apps.menuCopy(menu);
  await settle();
  assert.deepEqual(calls, ['native copy'], 'only the claimed key is the app’s; ⌘C still copies the field');
  assert.deepEqual(pressed, ['Mod+V'], 'the app hears its claimed key once');
  app.stop();
  delete window.avb;
});

test('the Edit menu keeps Copy and Paste routed through the renderer, and Cut and Select All native', () => {
  const source = fs.readFileSync(repoPath('electron/app/applicationMenu.ts'), 'utf8');
  assert.match(source, /accelerator: 'CmdOrCtrl\+V', click: \(\) => send\('menu:paste'\)/, 'Paste asks the renderer, which knows where focus is');
  assert.match(source, /accelerator: 'CmdOrCtrl\+C', click: \(\) => send\('menu:copy'\)/, 'Copy asks the renderer');
  assert.match(source, /role: 'cut'/, 'Cut is the focused frame’s own');
  assert.match(source, /role: 'selectAll'/, 'Select All is the focused frame’s own');
});
