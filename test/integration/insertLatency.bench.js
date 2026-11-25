// Goal: say where the time goes between choosing an element in the insert palette and seeing it on
// the canvas, on the real main process and the real dev server, so a change that is meant to make
// the canvas show it sooner is judged by numbers rather than by a feeling.
//
// Method: a generated fixture project (a page of forty-odd nodes, a Section and an Image component)
// is written to a temporary directory with the studio fixture's installed packages cloned beside it
// (copy-on-write on macOS), never the owner's projects. The real main process is loaded with hidden
// windows and its IPC handlers are called directly, as test/integration/styleLatency.js does; the
// real dev server is started through `dev:start`; the canvas is a hidden window on the server's
// `#avb-design` URL, so the real morph client patches it. For each kind (p, div, Section, Image)
// there are RUNS inserts, each: a `page:edit` code patch that writes the node, the same patch-now
// nudge the app sends once a write is confirmed (an `avb:patch-now` message), and an observer in
// the page that stamps the moment the node appears. Every stage is read off one clock: epoch
// milliseconds from `performance.timeOrigin + performance.now()` in both processes.
//
// Stages (ms after the write began): write reply, canvas fetch start, canvas fetch end, node on the
// canvas. A write that never shows within WATCH_MS_MAX is reported as `never`.
//
// Outside the offline gate (it starts a dev server): run as `npm run bench:insert`.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, repoPath } = require('../helpers/sources.js');

const RUNS = 20;
// The deleted and reordered kinds read the same page, so they run on the base page again each time.
const WATCH_MS_MAX = 8000;
const REST_MS = 400;
const BLOCKS = 12;
const SITE_SOURCE = repoPath('studio/test/fixtures/site');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.timeOrigin + performance.now();

// Each kind: how the page's source changes (`apply`), how it changes back (`revert`), and the
// expression that is true in the canvas once the change shows (`shown`).
const insertKind = (name, node) => ({
  name,
  apply: (source, serial) => source.replace('<p data-a>Paragraph 0a</p>', `<p data-a>Paragraph 0a</p>${node(serial)}`),
  revert: (source, serial) => source.replace(node(serial), ''),
  shown: (serial) => `!!document.querySelector('[data-probe="${serial}"]')`,
});
const KINDS = [
  insertKind('p', (serial) => `<p data-probe="${serial}">Paragraph</p>`),
  insertKind('div', (serial) => `<div data-probe="${serial}"></div>`),
  insertKind('Section', (serial) => `<Section data-probe="${serial}"></Section>`),
  insertKind('Image', (serial) => `<Image data-probe="${serial}" alt="probe" />`),
  {
    name: 'delete',
    apply: (source) => source.replace('<p data-b>Paragraph 0b</p>', ''),
    revert: (source) => source.replace('<p data-a>Paragraph 0a</p>', '<p data-a>Paragraph 0a</p><p data-b>Paragraph 0b</p>'),
    shown: () => "!document.querySelector('[data-b]')",
  },
  {
    name: 'reorder',
    apply: (source) => source.replace('<p data-a>Paragraph 0a</p><p data-b>Paragraph 0b</p>', '<p data-b>Paragraph 0b</p><p data-a>Paragraph 0a</p>'),
    revert: (source) => source.replace('<p data-b>Paragraph 0b</p><p data-a>Paragraph 0a</p>', '<p data-a>Paragraph 0a</p><p data-b>Paragraph 0b</p>'),
    shown: () => "!!document.querySelector('.row > [data-b]:first-child')",
  },
  {
    name: 'attribute',
    apply: (source, serial) => source.replace('<h2>Block 0</h2>', `<h2 data-flag="${serial}">Block 0</h2>`),
    revert: (source, serial) => source.replace(`<h2 data-flag="${serial}">Block 0</h2>`, '<h2>Block 0</h2>'),
    shown: (serial) => `!!document.querySelector('[data-flag="${serial}"]')`,
  },
  {
    name: 'text',
    apply: (source, serial) => source.replace('<h2>Block 0</h2>', `<h2>Block 0 ${serial}</h2>`),
    revert: (source, serial) => source.replace(`<h2>Block 0 ${serial}</h2>`, '<h2>Block 0</h2>'),
    shown: (serial) => `document.querySelector('.block h2').textContent === 'Block 0 ${serial}'`,
  },
];

function pageSource() {
  const blocks = [];
  for (let index = 0; index < BLOCKS; index += 1) {
    blocks.push(
      `    <section class="block"><h2>Block ${index}</h2><div class="row"><p${index === 0 ? ' data-a' : ''}>Paragraph ${index}a</p><p${index === 0 ? ' data-b' : ''}>Paragraph ${index}b</p>` +
        '<ul><li>One</li><li>Two</li><li>Three</li></ul></div></section>',
    );
  }
  return [
    '---',
    'import Section from "../components/Section.astro";',
    'import Image from "../components/Image.astro";',
    '---',
    '<html><body>',
    '  <main id="m">',
    ...blocks,
    '  </main>',
    '</body></html>',
    '',
  ].join('\n');
}

function writeFixture(project) {
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
  fs.copyFileSync(path.join(SITE_SOURCE, 'package.json'), path.join(project, 'package.json'));
  fs.writeFileSync(path.join(project, 'astro.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{ "extends": "astro/tsconfigs/strict" }\n');
  fs.writeFileSync(path.join(project, 'src', 'pages', 'index.astro'), pageSource());
  fs.writeFileSync(path.join(project, 'src', 'components', 'Section.astro'), '<section {...Astro.props}><div><slot /></div></section>\n');
  fs.writeFileSync(path.join(project, 'src', 'components', 'Image.astro'), '<img {...Astro.props} src="/a.png" width="64" height="64" />\n');
  // Astro resolves packages by walking up from the project, so a symlink breaks it: clone.
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE_SOURCE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0, 'node_modules cloned');
}

function orchestrate() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-insert-latency-'));
  const project = path.join(directory, 'project');
  writeFixture(project);
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', STACKI_INTEGRATION_DIR: directory, STACKI_INTEGRATION_PROJECT: project };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  env.SHELL = process.platform === 'win32' ? env.SHELL : '/usr/bin/false';
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  const electron = require('electron');
  const child = childProcess.spawn(electron, [__filename, '--electron', '--use-mock-keychain'], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    const cli = path.join(project, 'node_modules', 'astro', 'bin', 'astro.mjs');
    if (fs.existsSync(cli)) {
      childProcess.spawnSync(process.execPath, [cli, 'dev', 'stop'], { cwd: project, env, stdio: 'ignore', timeout: 20000 });
    }
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = code ?? 1;
  });
}

async function loadMain(electron) {
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
    win.loadFile = () => win.loadURL('data:text/html,<title>Stacki insert latency</title>');
    win.webContents.send = () => {};
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
    assert.ok(handlers.has(channel), `${channel} is registered`);
    return handlers.get(channel)({}, ...args);
  };
}

// In the page: when each probe appears, and when the page fetches itself (the morph's pull).
const INSTRUMENT = `(() => {
  const clock = () => performance.timeOrigin + performance.now();
  window.__probe = { test: undefined, seenAt: undefined };
  window.__fetches = [];
  const look = () => {
    if (window.__probe.test && window.__probe.seenAt === undefined && window.__probe.test()) {
      window.__probe.seenAt = clock();
    }
  };
  new MutationObserver(look).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  const fetchPage = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.split('?')[0] !== location.href.split('?')[0]) return fetchPage(input, init);
    const entry = { start: clock(), end: undefined };
    window.__fetches.push(entry);
    return fetchPage(input, init).then((response) => { entry.end = clock(); return response; });
  };
  window.__arm = (expression) => { window.__probe = { test: new Function('return (' + expression + ')'), seenAt: undefined }; window.__fetches = []; };
  return true;
})()`;

async function openCanvas(BrowserWindow, url) {
  const canvas = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await canvas.loadURL(url);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await canvas.webContents.executeJavaScript("!!document.querySelector('#m')")) {
      break;
    }
    await sleep(50);
  }
  assert.equal(await canvas.webContents.executeJavaScript(INSTRUMENT), true);
  return canvas;
}

async function writeNode(invoke, codePatch, pagePath, change) {
  const read = await invoke('page:read', pagePath);
  const next = change(read.source);
  assert.notEqual(next, read.source, 'the edit changes the page');
  const hunks = codePatch.diffCodePatch(read.source, next);
  assert.equal(hunks.ok, true, 'the patch is within bounds');
  const reply = await invoke('page:edit', { pagePath, authoredChecksum: read.checksum, edit: { tag: 'code-patch', hunks: hunks.value } });
  assert.equal(reply.ok, true, `page:edit applied: ${JSON.stringify(reply.error ?? '')}`);
}

// How far the page's clock reads ahead of this process's: the two epochs are taken from each
// process's own time origin, which can differ by tens of milliseconds, so every page time is
// shifted by the offset measured across a round trip just before the insert.
async function pageClockOffset(canvas) {
  const before = now();
  const page = await canvas.webContents.executeJavaScript('performance.timeOrigin + performance.now()');
  const after = now();
  return page - (before + after) / 2;
}

async function oneInsert(invoke, codePatch, canvas, pagePath, kind, serial) {
  await canvas.webContents.executeJavaScript(`window.__arm(${JSON.stringify(kind.shown(serial))})`);
  const offset = await pageClockOffset(canvas);
  const started = now();
  await writeNode(invoke, codePatch, pagePath, (source) => kind.apply(source, serial));
  const replied = now();
  // What the app does once a write is confirmed (appLifecycle.ts onAppliedUrgentEdit).
  await canvas.webContents.executeJavaScript("window.postMessage({ type: 'avb:patch-now' }, '*')");
  let seenAt;
  let fetches = [];
  while (now() - started <= WATCH_MS_MAX) {
    [seenAt, fetches] = await canvas.webContents.executeJavaScript('[window.__probe.seenAt, window.__fetches]');
    if (seenAt !== undefined) {
      break;
    }
    await sleep(5);
  }
  const first = fetches[0];
  const row = {
    kind: kind.name,
    replyMs: replied - started,
    fetchStartMs: first === undefined ? undefined : first.start - offset - started,
    fetchEndMs: first?.end === undefined ? undefined : first.end - offset - started,
    shownMs: seenAt === undefined ? undefined : seenAt - offset - started,
    fetches: fetches.length,
  };
  await sleep(REST_MS);
  await writeNode(invoke, codePatch, pagePath, (source) => kind.revert(source, serial));
  await sleep(REST_MS);
  return row;
}

function summary(values) {
  const known = values.filter((value) => value !== undefined).sort((left, right) => left - right);
  if (known.length === 0) {
    return { median: 'never', worst: 'never' };
  }
  return { median: known[Math.floor(known.length / 2)].toFixed(0), worst: known.at(-1).toFixed(0) };
}

function report(rowsByKind) {
  const say = (message) => fs.writeSync(1, message + '\n');
  say(`\nInsert latency, ${RUNS} inserts per kind (ms after the write began; median / worst)`);
  say('kind      write reply    fetch start    fetch end      on canvas      page fetches per insert');
  for (const [kind, rows] of Object.entries(rowsByKind)) {
    const cell = (key) => {
      const { median, worst } = summary(rows.map((row) => row[key]));
      return `${median} / ${worst}`.padEnd(15);
    };
    const fetches = rows.map((row) => row.fetches);
    say(`${kind.padEnd(10)}${cell('replyMs')}${cell('fetchStartMs')}${cell('fetchEndMs')}${cell('shownMs')}${Math.min(...fetches)}-${Math.max(...fetches)}`);
  }
}

async function inElectron() {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  const directory = process.env.STACKI_INTEGRATION_DIR;
  const project = process.env.STACKI_INTEGRATION_PROJECT;
  assert.ok(directory && path.basename(directory).startsWith('stacki-insert-latency-'));
  assert.equal(path.dirname(project), directory, 'use the generated fixture only');
  const userData = path.join(directory, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setAppLogsPath(path.join(directory, 'logs'));
  app.setPath('crashDumps', directory);
  const invoke = await loadMain(electron);
  const codePatch = require(repoPath('dist/shared/engine/codePatch.js'));
  const pagePath = path.join(project, 'src', 'pages', 'index.astro');
  try {
    await invoke('project:scan', project);
    const server = await invoke('dev:start', project);
    const canvas = await openCanvas(BrowserWindow, `${server.url}/#avb-design`);
    let serial = 0;
    const rowsByKind = {};
    for (const kind of KINDS) {
      rowsByKind[kind.name] = [];
      for (let run = 0; run < RUNS; run += 1) {
        serial += 1;
        rowsByKind[kind.name].push(await oneInsert(invoke, codePatch, canvas, pagePath, kind, serial));
      }
    }
    report(rowsByKind);
  } finally {
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
