// Goal: every Navigator row at one depth shares the same chevron column, icon x and label x, whatever
// kind it is or whether it has children, and an open subtree's tint belongs to its row's kind family
// (loops and conditionals one flow purple, components green, plain accent) at every nesting.
//
// Method: layout is a browser question, so the alignment half runs in a real Electron window (skipped
// without Electron) that mounts the real NodeList under the real styles.css on a generated fixture:
// a loop holding a component with a condition, an else, text rows, and a loop inside a condition.
// Measurements are relative (siblings against siblings, a child against its parent plus one step), so
// no pixel number is pinned. The tint half is a source check on the class tokens the rows carry
// (subtreeClassName) and the stylesheet rule each token maps to. Waits poll observable state
// (test/helpers/waitFor.js); events are dispatched, never timed. No real project is touched.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const loadRenderer = require('../../helpers/rendererModule.js');
const { navigatorFamily } = loadRenderer('src/features/structure/structureModel.ts');
const plain = { id: 'a', kind: 'element', name: 'div', props: { class: 'x' }, children: [] };
check('a loop is the loop family', navigatorFamily({ id: 'm', kind: 'map', head: 'a.map', children: [] }, { componentRow: false }) === 'loop');
check(
  'a condition and its else are the cond family',
  navigatorFamily({ id: 'c', kind: 'cond', op: '?', test: 'x', children: [] }, { componentRow: false }) === 'cond',
);
check('an else branch is the cond family', navigatorFamily({ id: 'b', kind: 'branch', name: 'else', children: [] }, { componentRow: false }) === 'cond');
check('a component row is the component family, even inside a loop', navigatorFamily(plain, { componentRow: true }) === 'component');
check('plain markup has no family', navigatorFamily(plain, { componentRow: false }) === undefined);

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/navigator-alignment');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { NodeList } from './src/features/structure/StructureTree'
    import './src/app/styles.css'

    const element = (id, name, children = [], cls) => ({ id, kind: 'element', name, props: cls ? { class: cls } : {}, children })
    const component = (id, name, children = []) => ({ id, kind: 'component', name, props: {}, children })
    const text = (id, value) => ({ id, kind: 'text', value })
    const branch = (id, name, children) => ({ id, kind: 'branch', name, children })
    const cond = (id, test, thenKids, elseKids) => ({ id, kind: 'cond', op: '?', test, children: elseKids ? [branch(id + '-then', 'then', thenKids), branch(id + '-else', 'else', elseKids)] : [branch(id + '-then', 'then', thenKids)] })
    const loop = (id, head, children) => ({ id, kind: 'map', head, children })

    const tree = [
      loop('loop', 'cards.map((card) => (', [
        component('column', 'Column', [
          cond('fluted', 'card.fluted', [component('image', 'FlutedImage')], [element('heading', 'h3', [], 'heading'), element('pretty', 'p', [], 'u-text-pretty'), component('button', 'Button', [text('label', 'Go')])]),
          loop('inner', 'card.items.map((item) => (', [element('item', 'li', [], 'item')]),
        ]),
        cond('outer', 'open', [loop('nested', 'rows.map((row) => (', [element('row', 'div', [], 'row')])], [element('closed', 'span', [], 'closed')]),
        element('leaf', 'p', [], 'leaf'),
        element('slot', 'slot'),
        element('ptext', 'p', [text('t1', 'Hello there')]),
        element('img', 'img', [], 'pic'),
        element('a', 'a', [], 'link'),
        element('btn', 'button'),
        element('sec', 'section'),
        element('ul', 'ul'),
        element('svg', 'svg'),
        element('inp', 'input'),
        element('lbl', 'label'),
        element('hd', 'h1'),
        { id: 'expr', kind: 'expr', value: 'title' },
        { id: 'cmt', kind: 'comment', value: ' note ' },
        { id: 'rawn', kind: 'raw', name: 'script', inner: 'x' },
        { id: 'rawl', kind: 'raw-line', value: 'const a = 1' },
        { id: 'chunk', kind: 'chunk-group', name: 'chunk.astro', chunkFile: 'c', children: [] },
        { id: 'frag', kind: 'component', name: 'Fragment', props: {}, children: [] },
        { id: 'asset', kind: 'component', name: 'Image', props: {}, astroAsset: true, children: [] },
        { id: 'dyn', kind: 'component', name: 'Tag', props: {}, dynamicTag: 'Tag', children: [] },
        { id: 'cmp', kind: 'component', name: 'Heading', props: {}, children: [] },
      ]),
    ]
    const byId = new Map()
    const index = (nodes) => { for (const node of nodes) { byId.set(node.id, node); index(node.children ?? []) } }
    index(tree)

    function Harness() {
      const [selectedId, setSelectedId] = useState(undefined)
      window.__select = setSelectedId
      const [dropTarget, setDropTarget] = useState(undefined)
      return (
        <div className="navigator" style={{ width: 360 }}>
          <div className="panel-body">
            <NodeList nodes={tree} parentId={undefined} depth={0} canEdit={() => true} selectedId={selectedId} currentLayoutName="Layout"
              dropTarget={dropTarget} setDropTarget={setDropTarget} isCollapsed={() => false} isDndPayload={() => false}
              performDrop={() => {}} nodeById={(id) => byId.get(id)} onSelect={setSelectedId} toggleCollapse={() => {}} openContextMenu={() => {}}
              hiddenNodeIds={new Set(['leaf', 'heading'])} />
          </div>
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  });
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>body{margin:0}</style><div id="root"></div><script src="bundle.js"></script>',
  );
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('navigator-alignment: skipped, no Electron to lay it out in');
    return;
  }
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     process.on('unhandledRejection', (error) => { console.error('PROBE ERROR ' + String(error).slice(0, 800)); app.exit(1); });
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 700, height: 700 });
       win.webContents.on('console-message', (...a) => console.error('CONSOLE ' + JSON.stringify(a).slice(0, 400)));
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       const { waitFor: pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
       await pollUntil({ what: 'rows drawn', read: () => js("document.querySelectorAll('[data-node-id]').length"), until: (count) => count >= 12 });
       const measure = ${measureRows.toString()};
       const out = { rows: await js('(' + measure + ')()') };
       out.tints = {};
       for (const id of ['loop', 'column', 'fluted', 'inner', 'outer', 'nested', 'fluted-else']) {
         await js('window.__select(' + JSON.stringify(id) + '); true');
         await pollUntil({ what: id + ' selected', read: () => js("document.querySelector('[data-node-id=\\"" + ${'id'} + "\\"]')?.classList.contains('selected') ?? false"), until: (v) => v });
         out['rows@' + id] = await js('(' + measure + ')()');
         out.colors = out.colors ?? {};
         out.colors[id] = await js("(() => { const row = document.querySelector('.structure-node.selected'); return { text: getComputedStyle(row).color, icon: getComputedStyle(row.querySelector('.icon')).color, fill: getComputedStyle(row).backgroundColor } })()");
         out.tints[id] = await js("(() => { const row = document.querySelector('.structure-node.selected'); const sub = row.nextElementSibling; const has = sub && sub.classList.contains('structure-subtree'); return { rowFamily: ['is-loop', 'is-cond', 'is-component'].find((c) => row.classList.contains(c)) ?? null, subFamily: has ? (['is-loop', 'is-cond', 'is-component'].find((c) => sub.classList.contains(c)) ?? null) : undefined, background: has ? getComputedStyle(sub).backgroundColor : null } })()");
       }
       out.normal = await js("(() => { const get = (id) => { const row = document.querySelector('[data-node-id=\\"' + id + '\\"]'); return { text: getComputedStyle(row).color, icon: getComputedStyle(row.querySelector('.icon')).color } }; return { fluted: get('fluted'), else: get('fluted-else'), loop: get('loop'), outer: get('outer'), column: get('column') } })()");
       out.token = await js("getComputedStyle(document.documentElement).getPropertyValue('--flow-purple').trim()");
       console.log('RESULT ' + JSON.stringify(out));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  const line = (run.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('RESULT '));
  if (line === undefined) {
    console.error('navigator-alignment: no result\n' + (run.stderr ?? '').slice(0, 1500) + (run.stdout ?? '').slice(0, 500));
    process.exit(1);
  }
  const out = JSON.parse(line.slice('RESULT '.length));
  if (process.env.STACKI_NAV_DUMP !== undefined) {
    console.log(JSON.stringify(out, undefined, 1));
  }
  const expectedFamily = {
    loop: 'is-loop',
    column: 'is-component',
    fluted: 'is-cond',
    inner: 'is-loop',
    outer: 'is-cond',
    nested: 'is-loop',
    'fluted-else': 'is-cond',
  };
  const backgrounds = new Map();
  for (const [id, family] of Object.entries(expectedFamily)) {
    const tint = out.tints[id];
    check(`${id}: the row carries ${family}`, tint.rowFamily === family, JSON.stringify(tint));
    check(`${id}: its open subtree block carries the same family`, tint.subFamily === family, JSON.stringify(tint));
    const known = backgrounds.get(family);
    check(`${id}: every ${family} block shares one tint`, known === undefined || known === tint.background, `${known} vs ${tint.background}`);
    backgrounds.set(family, tint.background);
  }
  // The conditional token in every state: normal and selected are computed from the real stylesheet; hover is read from its rule.
  check('the flow token is defined', /^#[0-9a-f]{6}$/i.test(out.token), out.token);
  const loopText = out.normal.loop.text;
  for (const name of ['fluted', 'else', 'outer']) {
    check(
      `normal: ${name} text is the loop purple`,
      out.normal[name].text === loopText && out.normal[name].icon === loopText,
      JSON.stringify([out.normal[name], loopText]),
    );
  }
  check('normal: a component is not purple', out.normal.column.text !== loopText);
  for (const id of ['fluted', 'fluted-else', 'outer']) {
    check(
      `selected: ${id} text and icon are the loop purple`,
      out.colors[id].text === loopText && out.colors[id].icon === loopText,
      JSON.stringify(out.colors[id]),
    );
    check(`selected: ${id} fill equals the loop's fill`, out.colors[id].fill === out.colors.loop.fill, JSON.stringify([out.colors[id], out.colors.loop]));
  }
  const sheet = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const ruleBody = (selector) => (sheet.match(new RegExp(selector.replace(/[.:]/g, '\\$&') + '\\s*\\{([^}]*)\\}')) ?? [])[1] ?? '';
  for (const selector of ['.structure-node.is-cond:hover', '.structure-node.is-cond:hover .icon']) {
    check(
      `hover: ${selector} stays on the flow purple token`,
      /var\(--flow-purple\)/.test(ruleBody(selector)) || /\.structure-node\.is-cond:hover,[^{]*\{[^}]*var\(--flow-purple\)/.test(sheet),
      selector,
    );
  }
  check('no amber token is used by the navigator', !/structure-(node|subtree)[^{]*\{[^}]*--(amber|orange|cond-amber)/.test(sheet));
  check(
    'loops and conditionals share the flow tint; components differ',
    backgrounds.get('is-loop') === backgrounds.get('is-cond') && backgrounds.get('is-loop') !== backgrounds.get('is-component'),
    JSON.stringify([...backgrounds]),
  );

  // Alignment: relative to siblings and to one indent step, in every selection state.
  const layouts = [
    out.rows,
    ...Object.entries(out)
      .filter(([key]) => key.startsWith('rows@'))
      .map(([, rows]) => rows),
  ];
  for (const rows of layouts) {
    const byDepth = new Map();
    for (const row of rows) {
      byDepth.set(row.depth, [...(byDepth.get(row.depth) ?? []), row]);
    }
    const first = rows.find((row) => row.depth === 0);
    const step = rows.find((row) => row.depth === 1).handleLeft - first.handleLeft;
    check('one indent step is wider than nothing', step > 0, String(step));
    for (const [depth, group] of byDepth) {
      const anchor = group[0];
      for (const row of group) {
        check(
          `depth ${depth}: ${row.id} (chevron ${row.chevron}) shares the chevron column, icon and label x of ${anchor.id}`,
          row.handleLeft === anchor.handleLeft &&
            row.iconLeft === anchor.iconLeft &&
            row.labelLeft === anchor.labelLeft &&
            row.handleWidth === anchor.handleWidth,
          JSON.stringify([row, anchor]),
        );
      }
      check(
        `depth ${depth}: indentation is one constant step per level`,
        anchor.handleLeft === first.handleLeft + depth * step,
        `${anchor.handleLeft} step ${step}`,
      );
      check(
        `depth ${depth}: the label sits a constant distance right of the chevron column`,
        anchor.labelLeft - anchor.handleLeft === first.labelLeft - first.handleLeft,
      );
    }
  }
  check(
    'the fixture covers rows with and without a chevron at one depth',
    out.rows.some((row) => row.depth === 3 && row.chevron) && out.rows.some((row) => row.depth === 3 && !row.chevron),
  );
  if (failures.length) {
    console.error(`navigator-alignment: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`navigator-alignment: ${checked} passed  [real layout]`);
})();

// Runs in the page: each row's chevron slot, icon and label x, and its depth.
function measureRows() {
  return [...document.querySelectorAll('[data-node-id]')].map((row) => {
    const handle = row.querySelector('.drag-handle').getBoundingClientRect();
    const icon = row.querySelector('.icon').getBoundingClientRect();
    const label = row.querySelector('.label').getBoundingClientRect();
    return {
      id: row.dataset.nodeId,
      depth: Number(row.dataset.depth),
      handleLeft: handle.left,
      handleWidth: handle.width,
      iconLeft: icon.left,
      labelLeft: label.left,
      rowLeft: row.getBoundingClientRect().left,
      chevron: !row.querySelector('.drag-handle').classList.contains('is-empty'),
    };
  });
}
