// The if panel and the Navigator, drawn by Chromium with the app's own stylesheets.
//
//   node test/electron/props/conditionPanels.test.js
//
// Goal: pin, in real layout, two things jsdom cannot measure. First, the tinted block under a selected
// Navigator row spans exactly the row's width (the same left and right edge) for an if, an element and a
// component, also when a label runs past the panel; the bug was a block narrower than its row. Second, the
// Settings tab's Condition section draws each kind of test as controls: Lumos Button's
// `render && (isWritten ? content : true)` (Render is true and a Computed part), `variant === "play"`, an
// `||` with a `!`, a computed value, and code that cannot be delimited (highlighted code, no sentence).
//
// Methodology: the Lumos fixture's Button.astro (test/fixtures/lumos, a copy of the starter) is parsed in Node
// with the app's parser; its nodes and a few generated if nodes are handed to a host page
// (test/helpers/conditionPanelHost.tsx) that renders the real NodeList and CondPanel, bundled fresh from
// source, in an Electron window served from 127.0.0.1. The boxes are read back from the DOM in the pixels
// the user sees. Set CONDITION_SHOTS to a folder to keep a screenshot of each tree and panel. Every wait is a
// bounded poll. Nothing touches a real project.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const load = require('../../helpers/rendererModule');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const parser = load('electron/parse/astroParser.ts');
const buttonSource = fs.readFileSync(repoPath('test/fixtures/lumos/components/Button.astro'), 'utf8');
const button = parser.parsePage(buttonSource).model;

// The first node, depth first, that `accept` takes: the fixture is small, and the walk is capped.
function find(nodes, accept) {
  const pending = [...nodes];
  for (let round = 0; pending.length > 0 && round < 10_000; round += 1) {
    const node = pending.shift();
    if (accept(node)) {
      return node;
    }
    pending.push(...(node.children ?? []));
  }
  return undefined;
}

const buttonIf = find(button.nodes, (node) => node.kind === 'cond' && node.test.startsWith('render && (isWritten'));
const playIf = find(button.nodes, (node) => node.kind === 'cond' && node.test === 'variant === "play"');
const element = find(button.nodes, (node) => node.kind === 'element' && (node.children ?? []).length > 0);
const component = find(button.nodes, (node) => node.kind === 'component' && (node.children ?? []).length > 0);
check('the fixture has the Button if', buttonIf !== undefined);
check('the fixture has the play if', playIf !== undefined);
check('the fixture has an element with children', element !== undefined);
check('the fixture has a component with children', component !== undefined);

const condOf = (id, test, children = []) => ({ kind: 'cond', id, op: '&&', test, children: [{ kind: 'branch', id: `${id}.9`, name: 'then', children }] });
// A label far wider than the panel, nested deep: the row overflows, and its block must follow it.
const longSource = `${'<div class="wrapper_level_with_a_long_class_name">'.repeat(6)}{showContent && name && title && company && variant === "a-very-long-variant-name" && (<div class="card_wrap"></div>)}${'</div>'.repeat(6)}`;
const longTree = parser.parsePage(longSource).model;
const longIf = find(longTree.nodes, (node) => node.kind === 'cond');
check('the long tree has its if', longIf !== undefined);

const TREES = [
  { name: 'if', nodes: button.nodes, selectedId: buttonIf?.id },
  { name: 'element', nodes: button.nodes, selectedId: element?.id },
  { name: 'component', nodes: button.nodes, selectedId: component?.id },
  { name: 'long-if', nodes: longTree.nodes, selectedId: longIf?.id },
];
const PANELS = [
  { name: 'button', node: buttonIf },
  { name: 'play', node: playIf },
  { name: 'or-not', node: condOf('n700', '!render || pressed') },
  { name: 'computed', node: condOf('n701', 'isWritten && emphasis !== "primary"') },
  { name: 'code', node: condOf('n702', '/^a/.test(label)') },
];
const CONTEXT = {
  frontmatter: buttonSource.split('---')[1] ?? '',
  propsSchema: [
    { name: 'variant', type: 'enum', options: ['main', 'link', 'play', 'close', 'arrow'] },
    { name: 'emphasis', type: 'enum', options: ['primary', 'secondary'] },
    { name: 'render', type: 'boolean' },
    { name: 'pressed', type: 'boolean' },
    { name: 'label', type: 'string' },
  ],
  origin: { file: 'src/components/Button.astro', page: undefined },
};

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const SHOTS = ${JSON.stringify(process.env.CONDITION_SHOTS ?? '')};
app.on('window-all-closed', () => {});
const logs = [];
app.whenReady().then(async () => { try {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const file = path.join(DIRECTORY, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 1400, height: 1000, backgroundColor: '#1e1e1e', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (event, level, message) => { logs.push(message); });
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
  let answer;
  for (let attempt = 0; attempt < 100; attempt++) {
    answer = await win.webContents.executeJavaScript('(() => { if (!window.conditionHost) { return undefined; } const panels = {}; for (const p of document.querySelectorAll("[data-panel]")) { const box = p.getBoundingClientRect(); panels[p.dataset.panel] = { text: p.textContent, rows: p.querySelectorAll(".conditional-condition").length, computed: [...p.querySelectorAll(".conditional-chip-computed")].map((c) => c.textContent), code: !!p.querySelector(".props-cond-field"), subjects: [...p.querySelectorAll(".conditional-condition [aria-label=Property]")].map((s) => s.textContent.trim()), otherwise: [...p.querySelectorAll(".condition-otherwise .u-segmented-button")].map((b) => b.textContent), box: { x: box.x, y: box.y, width: box.width, height: box.height } }; } const trees = {}; for (const t of document.querySelectorAll("[data-tree]")) { const box = t.getBoundingClientRect(); trees[t.dataset.tree] = { label: (t.querySelector(".structure-node.selected .label") || {}).textContent, title: (t.querySelector(".structure-node.selected .label") || {}).title, box: { x: box.x, y: box.y, width: box.width, height: box.height } }; } return { edges: window.conditionHost.measure(), panels, trees }; })()');
    if (answer && Object.keys(answer.panels).length > 0) { break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (SHOTS !== '' && answer) {
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const [kind, group] of [['tree', answer.trees], ['panel', answer.panels]]) {
      for (const [name, seen] of Object.entries(group)) {
        const rect = { x: Math.floor(seen.box.x), y: Math.floor(seen.box.y), width: Math.ceil(seen.box.width), height: Math.ceil(seen.box.height) };
        fs.writeFileSync(path.join(SHOTS, kind + '-' + name + '.png'), (await win.webContents.capturePage(rect)).toPNG());
      }
    }
    fs.writeFileSync(path.join(SHOTS, 'all.png'), (await win.webContents.capturePage()).toPNG());
  }
  // The long label's tree scrolled to its right end: the block still matches the row there.
  const scrolled = await win.webContents.executeJavaScript('(() => { const body = document.querySelector("[data-tree=long-if] .panel-body"); body.scrollLeft = body.scrollWidth; return window.conditionHost.measure()["long-if"]; })()');
  // Otherwise: the segments keep their widths while the pointer rests on Else branch, and its tooltip sits under it.
  const segments = 'Array.from(document.querySelectorAll("[data-panel=button] .condition-otherwise-switch .u-segmented-button")).map((b) => { const r = b.getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, bottom: r.bottom }; })';
  const before = await win.webContents.executeJavaScript(segments);
  const target = before[1];
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(target.left + target.width / 2), y: Math.round((target.top + target.bottom) / 2) });
  let tooltip;
  for (let attempt = 0; attempt < 40 && !tooltip; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    tooltip = await win.webContents.executeJavaScript('(() => { const t = document.querySelector(".u-segmented-tooltip, [role=tooltip]"); if (!t) { return undefined; } const r = t.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, text: t.textContent }; })()');
  }
  const hovering = await win.webContents.executeJavaScript(segments);
  if (SHOTS !== '') {
    const panel = answer.panels.button.box;
    fs.writeFileSync(path.join(SHOTS, 'otherwise-hover.png'), (await win.webContents.capturePage({ x: Math.floor(panel.x), y: Math.floor(panel.y), width: Math.ceil(panel.width), height: Math.ceil(panel.height) + 60 })).toPNG());
  }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
  // A Computed part opens in the code editor on a click.
  await win.webContents.executeJavaScript('document.querySelector("[data-panel=button] .conditional-code-condition.is-editable").click()');
  let editing = false;
  for (let attempt = 0; attempt < 40 && !editing; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    editing = await win.webContents.executeJavaScript('!!document.querySelector("[data-panel=button] .conditional-code-condition.is-editing .cm-editor")');
  }
  if (SHOTS !== '') {
    const panel = answer.panels.button.box;
    fs.writeFileSync(path.join(SHOTS, 'computed-editing.png'), (await win.webContents.capturePage({ x: Math.floor(panel.x), y: Math.floor(panel.y), width: Math.ceil(panel.width), height: Math.ceil(panel.height) })).toPNG());
  }
  console.log('RESULT ' + JSON.stringify({ ...answer, scrolled, before, hovering, tooltip, editing }));
  win.destroy();
  app.exit(0);
  } catch (error) { console.log('RESULT ' + JSON.stringify({ error: String(error), logs })); app.exit(0); }
});`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('condition-panels: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/condition-panels');
  fs.mkdirSync(directory, { recursive: true });
  esbuild.buildSync({
    entryPoints: [repoPath('test/helpers/conditionPanelHost.tsx')],
    outfile: path.join(directory, 'host.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.svg': 'text', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    absWorkingDir: ROOT,
  });
  // The app's stylesheets as the renderer loads them: tokens, the app's own, then every shared control's.
  const sheets = [
    'src/features/style/tokens.css',
    'src/app/styles.css',
    ...fs
      .readdirSync(repoPath('src/ui'))
      .filter((name) => name.endsWith('.css'))
      .map((name) => `src/ui/${name}`),
  ];
  const appCss = sheets.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  fs.writeFileSync(path.join(directory, 'app.css'), appCss);
  const input = JSON.stringify({ trees: TREES, panels: PANELS, context: CONTEXT }).replace(/</g, '\\u003c');
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/host.css"><style>html,body{margin:0;background:var(--bg)}</style></head><body><div id="root"></div><script>window.conditionHostInput = ${input};</script><script src="/host.js"></script></body></html>`,
  );
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 2000));
  } else {
    const seen = JSON.parse(line.slice('RESULT '.length));
    if (seen.error !== undefined) {
      check('the host page drew', false, `${seen.error}\n${seen.logs.join('\n').slice(0, 2000)}`);
      console.error(`condition-panels: the host page did not draw\n${failures.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    for (const tree of TREES) {
      const edges = seen.edges[tree.name];
      check(`${tree.name}: a row is selected`, edges.row !== undefined, JSON.stringify(edges));
      check(`${tree.name}: a block is drawn under it`, edges.block !== undefined, JSON.stringify(edges));
      if (edges.row !== undefined && edges.block !== undefined) {
        check(`${tree.name}: the block starts where the row starts`, Math.abs(edges.row.left - edges.block.left) < 0.5, JSON.stringify(edges));
        check(`${tree.name}: the block ends where the row ends`, Math.abs(edges.row.right - edges.block.right) < 0.5, JSON.stringify(edges));
      }
    }
    const scrolled = seen.scrolled;
    check('long-if scrolled: the block still ends where the row ends', Math.abs(scrolled.row.right - scrolled.block.right) < 0.5, JSON.stringify(scrolled));
    check('the if row reads in words', seen.trees.if.label === 'if Render and Is Written…', seen.trees.if.label);
    check('and its tooltip is the test', seen.trees.if.title === 'render && (isWritten ? content : true)', seen.trees.if.title);
    check('Otherwise: two segments', seen.before.length === 2, JSON.stringify(seen.before));
    for (const [index, segment] of seen.before.entries()) {
      check(`Otherwise: segment ${index} keeps its width on hover`, Math.abs(segment.width - seen.hovering[index].width) < 0.5, JSON.stringify(seen.hovering));
      check(`Otherwise: segment ${index} keeps its place on hover`, Math.abs(segment.left - seen.hovering[index].left) < 0.5, JSON.stringify(seen.hovering));
    }
    check('Otherwise: the segments are equal', Math.abs(seen.before[0].width - seen.before[1].width) < 1, JSON.stringify(seen.before));
    check(
      'Otherwise: the tooltip says what Else branch does',
      seen.tooltip !== undefined && seen.tooltip.text.includes('Render another branch'),
      JSON.stringify(seen.tooltip),
    );
    if (seen.tooltip !== undefined) {
      const middle = seen.before[1].left + seen.before[1].width / 2;
      check('Otherwise: the tooltip is over the hovered segment', seen.tooltip.left <= middle && seen.tooltip.right >= middle, JSON.stringify(seen.tooltip));
    }
    check('a Computed part opens in the code editor on a click', seen.editing === true);
    const panels = seen.panels;
    check('Button: two rows', panels.button.rows === 2, JSON.stringify(panels.button));
    check(
      'Button: Render, then a Computed part',
      panels.button.subjects[0] === 'Render' && panels.button.computed[0] === 'Computed',
      JSON.stringify(panels.button),
    );
    check('Button: Otherwise is a switch', panels.button.otherwise.join('|') === 'Nothing|Else branch', JSON.stringify(panels.button.otherwise));
    check('play: one row on Variant', panels.play.rows === 1 && panels.play.subjects[0] === 'Variant', JSON.stringify(panels.play));
    check('or-not: two rows', panels['or-not'].rows === 2, JSON.stringify(panels['or-not']));
    check('computed: Is Written by its label', panels.computed.subjects[0] === 'Is Written', JSON.stringify(panels.computed));
    check('computed: the plainer condition is offered', panels.computed.text.includes('Same as: Variant is any of Main, Link'), panels.computed.text);
    check('code: the code editor, no rows', panels.code.code && panels.code.rows === 0, JSON.stringify(panels.code));
    for (const [name, panel] of Object.entries(panels)) {
      check(`${name}: no "too complex" sentence`, !panel.text.includes('Too complex'), panel.text);
    }
  }
  if (failures.length > 0) {
    console.error(`condition-panels: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`condition-panels: ${checked} checks passed`);
  }
})();
