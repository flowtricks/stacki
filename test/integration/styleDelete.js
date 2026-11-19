// Goal: deleting a <style> block never puts the dev server's error overlay on the canvas, and an overlay that does
// come up goes away by itself on the next change that fixes it (docs/canvas-recovery.md, "No Astro CSS at index 0").
//
// Method: a generated fixture project (never the owner's) with the studio fixture's packages cloned beside it, as
// canvasRecovery.js does. The real main process is loaded with hidden windows and its IPC handlers called directly;
// the real dev server starts through `dev:start` with the real preview config. A host window with the app's real
// preload (so the canvas frame runs the real frame half, including the overlay report) embeds the page in an iframe
// (#avb-design, so the real morph client runs), and runs the real canvas recovery controller wired as
// appLifecycle.ts wires it. A socket on the dev server's HMR channel records what Vite tells the browser.
// Scenarios, each deleting through the Navigator's own edit (`remove-node` on the <style> node) and undoing through
// its inverse (`revert`):
// (a) the only block of a component: the page renders without an overlay, the block's padding is gone, and Vite
//     never names the deleted block's stylesheet to the browser; undo brings the padding back, no overlay;
// (b) block 0 of two: the remaining block still applies; undo restores both;
// (c) an is:global block, a define:vars block, and the only block of a layout two pages use;
// (e) a component whose regular block follows a self-closing <style is:inline … />, and the same with the inline tag
//     closed (1.4.8: the self-closing one read as no block, its stylesheet was served empty and the component rendered
//     unstyled): block 0 of each is the component's CSS, and both render red in the page;
// (d) the overlay itself, put up the way the dev server's HMR client puts it up for an error message (the message
//     the deleted block caused before this fix); the overlay shows (screenshot),
//     the controller holds it as an error with the dev server's words and reloads nothing while nothing changes,
//     and the next write (undo of a deletion) brings the canvas back by one reload, overlay gone (screenshot).
// Every wait is bounded. Screenshots go to the directory in STACKI_SCREENSHOT_DIR when it is set.
//
// Outside the offline gate (it starts a dev server): `npm run integration:style-delete`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, repoPath } = require('../helpers/sources.js');
const SITE_SOURCE = repoPath('studio/test/fixtures/site');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

const LAYERED = '<style>\n  @layer components {\n    .my-class {\n      padding: 1.25rem;\n    }\n  }\n</style>';
const FILES = {
  'src/components/Div.astro': `---\n---\n<div class="my-class" id="d">Hello</div>\n\n${LAYERED}\n`,
  'src/components/Two.astro':
    '<p class="a b" id="t">Two</p>\n\n<style>\n  .a { color: rgb(255, 0, 0); }\n</style>\n\n<style>\n  .b { padding: 8px; }\n</style>\n',
  'src/components/Global.astro': '<p class="g" id="g">Global</p>\n\n<style is:global>\n  .g { padding-top: 6px; }\n</style>\n',
  'src/components/Vars.astro':
    '---\nconst tone = "rgb(0, 128, 0)";\n---\n<p class="v" id="v">Vars</p>\n\n<style define:vars={{ tone }}>\n  .v { color: var(--tone); }\n</style>\n',
  'src/layouts/Layout.astro': '<html><body><main id="m"><slot /></main></body></html>\n\n<style>\n  main { padding-left: 3px; }\n</style>\n',
  'src/components/SelfClosing.astro':
    '<div class="repro-a" id="sa">A</div>\n<style is:inline set:html={"/* inline */"} />\n<style>.repro-a { color: red; }</style>\n',
  'src/components/Closed.astro':
    '<div class="repro-b" id="sb">B</div>\n<style is:inline set:html={"/* inline */"}></style>\n<style>.repro-b { color: red; }</style>\n',
  'src/pages/self-closing.astro':
    '---\nimport Layout from "../layouts/Layout.astro";\nimport SelfClosing from "../components/SelfClosing.astro";\nimport Closed from "../components/Closed.astro";\n---\n<Layout><SelfClosing /><Closed /></Layout>\n',
  'src/pages/index.astro':
    '---\nimport Layout from "../layouts/Layout.astro";\nimport Two from "../components/Two.astro";\n---\n<Layout><h1>Home</h1><Two /></Layout>\n',
  'src/pages/example-components.astro':
    '---\nimport Layout from "../layouts/Layout.astro";\nimport Div from "../components/Div.astro";\nimport Two from "../components/Two.astro";\nimport Global from "../components/Global.astro";\nimport Vars from "../components/Vars.astro";\n---\n<Layout><Div /><Two /><Global /><Vars /></Layout>\n',
};

// The error the dev server sent the canvas when the browser asked for a deleted block (the shape of Vite's error
// payload, which Astro's overlay also takes).
const STALE_STYLE_ERROR = {
  message: 'No Astro CSS at index 0',
  stack: '    at LoadPluginContext.handler (node_modules/astro/dist/vite-plugin-astro/index.js:125:7)',
  id: '/src/components/Div.astro?astro&type=style&index=0&lang.css',
  plugin: 'astro:build',
};

function writeFixture(project) {
  for (const [relative, text] of Object.entries(FILES)) {
    const target = path.join(project, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.copyFileSync(path.join(SITE_SOURCE, 'package.json'), path.join(project, 'package.json'));
  fs.writeFileSync(path.join(project, 'astro.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{ "extends": "astro/tsconfigs/strict" }\n');
  // A copy-on-write clone where the file system has one (APFS, Btrfs, ReFS), a plain copy elsewhere.
  fs.cpSync(path.join(SITE_SOURCE, 'node_modules'), path.join(project, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
}

function orchestrate() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-delete-'));
  const project = path.join(directory, 'project');
  writeFixture(project);
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', STACKI_INTEGRATION_DIR: directory, STACKI_INTEGRATION_PROJECT: project };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  const electron = require('electron');
  const child = childProcess.spawn(electron, [__filename, '--electron'], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    const cli = path.join(project, 'node_modules', 'astro', 'bin', 'astro.mjs');
    if (fs.existsSync(cli)) {
      childProcess.spawnSync(process.execPath, [cli, 'dev', 'stop'], { cwd: project, env, stdio: 'ignore', timeout: 20000 });
    }
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = code ?? 1;
  });
}

async function loadMain(electron, sends) {
  const { app, ipcMain, BrowserWindow } = electron;
  const handlers = new Map();
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler);
    register(channel, handler);
  };
  const Module = require('node:module');
  const originalLoad = Module._load;
  const mainPath = repoPath('dist/electron/main.js');
  function HiddenWindow(options) {
    const win = new BrowserWindow({ ...options, show: false, webPreferences: { sandbox: true } });
    win.loadFile = () => win.loadURL('data:text/html,<title>x</title>');
    win.webContents.send = (channel, payload) => sends.forEach((listener) => listener(channel, payload));
    return win;
  }
  Object.setPrototypeOf(HiddenWindow, BrowserWindow);
  Module._load = function (name, parent) {
    if (name === 'electron' && parent?.filename === mainPath) {
      return { ...electron, BrowserWindow: HiddenWindow };
    }
    return originalLoad.apply(this, arguments);
  };
  require(mainPath);
  Module._load = originalLoad;
  await app.whenReady();
  await sleep(100);
  return (channel, ...args) => {
    assert.ok(handlers.has(channel), channel);
    return handlers.get(channel)({}, ...args);
  };
}

// What Vite tells the browser, recorded from its HMR socket (the protocol its own client speaks).
function listenToHMR(serverURL) {
  const messages = [];
  const socket = new WebSocket(serverURL.replace(/^http/, 'ws') + '/', 'vite-hmr');
  socket.onmessage = (message) => messages.push(String(message.data));
  return { messages, close: () => socket.close() };
}

async function inElectron() {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  const directory = process.env.STACKI_INTEGRATION_DIR;
  const project = process.env.STACKI_INTEGRATION_PROJECT;
  const shots = process.env.STACKI_SCREENSHOT_DIR;
  const userData = path.join(directory, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setAppLogsPath(path.join(directory, 'logs'));
  app.setPath('crashDumps', directory);
  const sends = [];
  const invoke = await loadMain(electron, sends);
  const { createCanvasRecovery } = require(repoPath('test/helpers/rendererModule.js'))('src/features/preview/canvasRecovery.ts');
  const fileOf = (relative) => path.join(project, ...relative.split('/'));
  await invoke('project:scan', project);
  const server = await invoke('dev:start', project);
  const host = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      backgroundThrottling: false,
      preload: repoPath('dist/electron/preload/preload.js'),
      contextIsolation: true,
      nodeIntegrationInSubFrames: true,
    },
  });
  // The host relays the frame's overlay reports, as previewRuntime.ts does for the canvas iframe.
  await host.loadURL(
    'data:text/html,<body style="margin:0"><script>window.overlayReports=[];addEventListener("message",(e)=>{if(e.data&&e.data.type==="avb:error-overlay"){overlayReports.push(e.data)}})</script></body>',
  );
  const startedAt = now();
  const say = (message) => fs.writeSync(1, `${String(now() - startedAt).padStart(6)}ms ${message}\n`);
  let route = '/example-components';
  const mount = () =>
    host.webContents.executeJavaScript(
      `(() => { document.querySelectorAll('iframe').forEach((f) => f.remove()); const f = document.createElement('iframe'); f.id='f'; f.style='width:880px;height:680px;border:0'; f.src=${JSON.stringify(server.url + route + '#avb-design')}; document.body.append(f); })()`,
    );
  const frameOf = () => host.webContents.mainFrame.frames.find((candidate) => candidate.url.startsWith(server.url));
  // A frame that is being replaced may never answer: every question to it is bounded.
  const inFrame = async (script) => {
    const frame = frameOf();
    assert.ok(frame, 'the canvas frame is there');
    let timer;
    const late = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the canvas frame did not answer')), 3000);
    });
    try {
      return await Promise.race([frame.executeJavaScript(script), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const overlayShown = () => inFrame("!!document.querySelector('vite-error-overlay')").catch(() => false);
  const computed = (id, property) =>
    inFrame(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return e ? getComputedStyle(e)[${JSON.stringify(property)}] : '<none>'; })()`);
  const until = async (predicate, limitMs) => {
    const began = now();
    while (now() - began < limitMs) {
      if (await predicate().catch(() => false)) {
        return now() - began;
      }
      await sleep(50);
    }
    return undefined;
  };
  const shoot = async (name) => {
    if (!shots) {
      return;
    }
    fs.mkdirSync(shots, { recursive: true });
    const image = await host.webContents.capturePage();
    fs.writeFileSync(path.join(shots, name), image.toPNG());
    say('screenshot ' + path.join(shots, name));
  };

  let reloads = 0;
  const events = [];
  const recovery = createCanvasRecovery({
    pageUrl: () => server.url + route,
    inspect: (url) => invoke('dev:inspect', url),
    reload: () => {
      reloads++;
      say('recovery reload');
      void mount();
    },
    visible: () => true,
    onEvent: (event) => {
      events.push(event);
      say('recovery ' + event.kind + (event.kind === 'failed' ? ': ' + event.error.message : ''));
    },
  });
  sends.push((channel, payload) => {
    if (channel === 'page:maybe-changed') {
      recovery.trigger(payload.external ? 'external' : 'write');
    }
  });
  host.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
    if (!isMainFrame) {
      recovery.loaded();
    }
  });
  const relay = setInterval(async () => {
    const reports = await host.webContents.executeJavaScript('overlayReports.splice(0)').catch(() => []);
    for (const report of reports) {
      if (report.shown) {
        recovery.overlayShown(server.url + route, report.message);
      } else {
        recovery.overlayCleared();
      }
    }
  }, 50);

  // The Navigator's deletion: `remove-node` on the file's <style> node at `which` (0 is the first block).
  const deleteStyle = async (relative, which) => {
    const file = fileOf(relative);
    const page = await invoke('page:read', file);
    assert.ok(page.editable, relative + ' parses');
    const styles = page.model.nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.kind === 'raw' && node.name === 'style');
    const target = styles[which];
    assert.ok(target, `${relative} has style block ${which}`);
    const reply = await invoke('page:edit', {
      pagePath: file,
      authoredChecksum: page.checksum,
      edit: { tag: 'remove-node', target: { path: [target.index], kind: 'raw', span: { start: target.node.start, end: target.node.end } } },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return { file, checksum: reply.checksum, inverse: reply.inverse };
  };
  const undo = async (deleted) => {
    const reply = await invoke('page:edit', { pagePath: deleted.file, authoredChecksum: deleted.checksum, edit: { tag: 'revert', hunks: deleted.inverse } });
    assert.equal(reply.ok, true, JSON.stringify(reply));
  };
  // After a change: the page settles, and the canvas never put the overlay up meanwhile.
  const settled = async (name) => {
    const began = now();
    while (now() - began < 2500) {
      assert.equal(await overlayShown(), false, name + ': no error overlay on the canvas');
      await sleep(100);
    }
  };
  // The stylesheet modules of `relative` that Vite's updates told the browser about: none past the file's last block
  // (`blocksAfter`), and each one it names answers 200 when asked for as the browser asks, never "No Astro CSS at
  // index N".
  const namedStylesAnswer = async (hmr, relative, blocksAfter) => {
    const named = hmr.messages
      .filter((message) => message.includes('"js-update"') || message.includes('"css-update"'))
      .flatMap((message) => JSON.parse(message).updates)
      .filter((update) => update.path.includes('/' + relative + '?astro&type=style'));
    for (const update of named) {
      assert.ok(Number(/index=(\d+)/.exec(update.path)?.[1]) < blocksAfter, `${update.path}: a block the file no longer has`);
      const response = await fetch(server.url + update.path + '&t=' + update.timestamp);
      const body = await response.text();
      assert.equal(response.status, 200, `${update.path}: ${(/"message":"([^"]*)"/.exec(body) ?? [body.slice(0, 200)]).at(-1)}`);
    }
  };

  const hmr = listenToHMR(server.url);
  const results = [];
  try {
    await mount();
    assert.notEqual(await until(async () => (await computed('d', 'paddingTop')) === '20px', 30000), undefined, 'the page renders with the block');
    await sleep(1500);
    await shoot('style-delete-0-start.png');

    say('=== e a self-closing <style is:inline /> before a block');
    route = '/self-closing';
    await mount();
    // The page has rendered once the closed one is red: the closed form styled correctly in 1.4.8 too.
    assert.notEqual(await until(async () => (await computed('sb', 'color')) === 'rgb(255, 0, 0)', 15000), undefined, 'e: the page renders');
    for (const [name, id, className] of [
      ['SelfClosing', 'sa', 'repro-a'],
      ['Closed', 'sb', 'repro-b'],
    ]) {
      // As the browser asks for it: Vite answers with the stylesheet as a module, the CSS in a string.
      const response = await fetch(`${server.url}/src/components/${name}.astro?astro&type=style&index=0&lang.css`);
      const body = await response.text();
      assert.equal(response.status, 200, `e: ${name} block 0 answers`);
      assert.match(body, new RegExp(`\\.${className}[^{]*\\{(?:\\\\n|\\s)*color:\\s*red`), `e: ${name} block 0 is its CSS: ${body.slice(-300)}`);
      const shown = await until(async () => (await computed(id, 'color')) === 'rgb(255, 0, 0)', 10000);
      assert.notEqual(shown, undefined, `e: ${name} renders red in the page (it is ${await computed(id, 'color').catch(() => '?')})`);
    }
    route = '/example-components';
    await mount();
    assert.notEqual(await until(async () => (await computed('d', 'paddingTop')) === '20px', 15000), undefined, 'e: back on the component page');
    results.push('e self-closing and closed inline style before a block: block 0 served, both red');

    say('=== a the only block of a component');
    hmr.messages.length = 0;
    const onlyBlock = await deleteStyle('src/components/Div.astro', 0);
    assert.notEqual(await until(async () => (await computed('d', 'paddingTop')) === '0px', 10000), undefined, 'a: the padding is gone');
    await settled('a');
    await namedStylesAnswer(hmr, 'src/components/Div.astro', 0);
    assert.equal(recovery.state().kind, 'healthy', 'a: the canvas is healthy');
    await shoot('style-delete-1-after-delete.png');
    await undo(onlyBlock);
    assert.notEqual(await until(async () => (await computed('d', 'paddingTop')) === '20px', 10000), undefined, 'a: undo brings the padding back');
    await settled('a undo');
    results.push('a only block: deleted and undone, no overlay, no stale stylesheet update');

    say('=== b block 0 of two');
    hmr.messages.length = 0;
    const firstOfTwo = await deleteStyle('src/components/Two.astro', 0);
    assert.notEqual(await until(async () => (await computed('t', 'color')) === 'rgb(0, 0, 0)', 10000), undefined, 'b: block 0 no longer applies');
    await settled('b');
    assert.equal(await computed('t', 'paddingTop'), '8px', 'b: the remaining block still applies');
    await namedStylesAnswer(hmr, 'src/components/Two.astro', 1);
    await undo(firstOfTwo);
    assert.notEqual(await until(async () => (await computed('t', 'color')) === 'rgb(255, 0, 0)', 10000), undefined, 'b: undo restores block 0');
    await settled('b undo');
    assert.equal(await computed('t', 'paddingTop'), '8px', 'b: and block 1');
    results.push('b block 0 of 2: remaining block applies, undo restores both, no overlay');

    say('=== c is:global, define:vars, a layout two pages use');
    const global = await deleteStyle('src/components/Global.astro', 0);
    assert.notEqual(await until(async () => (await computed('g', 'paddingTop')) === '0px', 10000), undefined, 'c: the global block is gone');
    await settled('c global');
    await undo(global);
    assert.notEqual(await until(async () => (await computed('g', 'paddingTop')) === '6px', 10000), undefined, 'c: undo restores the global block');
    say('c define:vars');
    const vars = await deleteStyle('src/components/Vars.astro', 0);
    assert.notEqual(await until(async () => (await computed('v', 'color')) === 'rgb(0, 0, 0)', 10000), undefined, 'c: the define:vars block is gone');
    await settled('c vars');
    await undo(vars);
    assert.notEqual(await until(async () => (await computed('v', 'color')) === 'rgb(0, 128, 0)', 10000), undefined, 'c: undo restores define:vars');
    say('c layout');
    const layout = await deleteStyle('src/layouts/Layout.astro', 0);
    assert.notEqual(await until(async () => (await computed('m', 'paddingLeft')) === '0px', 10000), undefined, 'c: the layout block is gone');
    await settled('c layout');
    route = '/';
    await mount();
    assert.notEqual(await until(async () => (await computed('t', 'paddingTop')) === '8px', 15000), undefined, 'c: the other page of the layout renders');
    assert.equal(await overlayShown(), false, 'c: without an overlay');
    await undo(layout);
    assert.notEqual(await until(async () => (await computed('m', 'paddingLeft')) === '3px', 10000), undefined, 'c: undo restores the layout block');
    await settled('c layout undo');
    route = '/example-components';
    await mount();
    assert.notEqual(await until(async () => (await computed('d', 'paddingTop')) === '20px', 15000), undefined, 'back on the component page');
    results.push('c is:global, define:vars, layout of two pages: deleted and undone, no overlay');

    say('=== d the overlay comes up, and the next write takes it down');
    await sleep(1000);
    const reloadsBefore = reloads;
    const staged = await deleteStyle('src/components/Div.astro', 0);
    assert.notEqual(await until(async () => (await computed('d', 'paddingTop')) === '0px', 10000), undefined, 'd: deleted');
    await sleep(800);
    // The dev server's error message, as its HMR client handles one ("error"): the overlay element it registered,
    // built with the error Astro sent for the deleted block before this fix, appended to the body. Astro's overlay
    // reads a theme from local storage, which this harness's data: host denies the frame: a stand-in answers.
    await inFrame(
      `(() => { try { void window.localStorage; } catch { Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => undefined, setItem: () => {} } }); } const Overlay = customElements.get('vite-error-overlay'); document.body.appendChild(new Overlay(${JSON.stringify(STALE_STYLE_ERROR)})); return true; })()`,
    );
    assert.notEqual(await until(overlayShown, 10000), undefined, 'd: the dev server shows its overlay');
    assert.notEqual(await until(async () => recovery.state().kind === 'error', 5000), undefined, 'd: the controller holds the overlay as an error');
    assert.equal(recovery.state().error.origin, 'frame');
    assert.match(recovery.state().error.message ?? '', /No Astro CSS at index 0/, 'd: in the dev server words');
    await sleep(500);
    await shoot('style-delete-2-overlay.png');
    await sleep(2000);
    assert.equal(reloads, reloadsBefore, 'd: no reload while nothing has changed');
    assert.equal(await overlayShown(), true, 'd: the overlay stays until something changes');
    await undo(staged);
    assert.notEqual(
      await until(async () => (await computed('d', 'paddingTop')) === '20px' && !(await overlayShown()), 15000),
      undefined,
      'd: the canvas came back',
    );
    await sleep(2500);
    // The canvas comes back by one reload: the controller's, or Vite's own when its first update finds an overlay.
    assert.ok(reloads - reloadsBefore <= 1, `d: at most one reload by the controller, made ${reloads - reloadsBefore}`);
    assert.equal(await overlayShown(), false, 'd: and the overlay is gone');
    assert.equal(recovery.state().kind, 'healthy');
    await shoot('style-delete-3-recovered.png');
    results.push(`d overlay: held as an error, no reload until the write, then back (${reloads} controller reload)`);
    for (const line of results) {
      fs.writeSync(1, line + '\n');
    }
    fs.writeSync(1, 'style delete: all scenarios passed\n');
  } catch (error) {
    await shoot('style-delete-failure.png').catch(() => {});
    throw error;
  } finally {
    clearInterval(relay);
    hmr.close();
    recovery.stop();
    await invoke('project:close').catch(() => {});
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
  }
}

if (process.argv.includes('--electron')) {
  const { app } = require('electron');
  inElectron().then(
    () => app.exit(process.exitCode ?? 0),
    (error) => {
      fs.writeSync(2, String(error.stack || error) + '\n');
      app.exit(1);
    },
  );
} else {
  orchestrate();
}
