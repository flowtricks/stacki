// Goal: opening another file (a component drilled into, the page backed out to) paints the
// Style panel's selector chips at once. A user saw the chip placeholder for a long time after
// opening a component: every switch read every stylesheet and component file again over IPC
// (twice: the page and component passes listed the same sources) before the panel could even
// look its element up, and the remembered answer for an element of that file was never found,
// because it was looked up under the previous file's stylesheets.
// Method, in two parts.
// (1) memoryContent.ts directly, over a host set by the test: remembered documents are reused
//     by key, the open file's blocks are parsed from the model, a source never read is reported
//     missing, a source whose role changed is parsed again from its text, the open file's own
//     component copy is forgotten, and the memory is bounded.
// (2) The real StylePanel in jsdom (test/helpers/stylePanelHarness.js): open a component, back
//     out to the page, then open the component again with the canvas holding every reply and
//     with stylesheet reads counted. The component's root paints its chips in the first frames,
//     reading only the page it was opened from and with no canvas answer; a first visit draws the chips' structure (the well and
//     its placeholder) in the same render that switches. No timing thresholds; fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountStylePanel, settle } = require('../../helpers/stylePanelHarness.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

function loadMemoryModule() {
  const esbuild = require('esbuild');
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const bundle = path.join(directory, `memory-content-${process.pid}.bundle.js`);
  esbuild.buildSync({
    stdin: {
      contents: [
        `export * from './src/features/style/embed/memoryContent'`,
        `export { setHost, getHost } from './src/features/style/model/host'`,
        `export { documentFromCode } from './src/features/style/model/webflow'`,
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    loader: { '.css': 'empty', '.svg': 'text' },
    logLevel: 'silent',
  });
  try {
    return require(bundle);
  } finally {
    fs.rmSync(bundle, { force: true });
  }
}

const memory = loadMemoryModule();

const BASE = { rel: 'src/styles/base.css', name: 'base.css', path: '/p/src/styles/base.css', size: 1 };
const CARD = { rel: 'src/components/Card.astro', name: 'Card.astro', path: '/p/src/components/Card.astro', size: 1 };
const PAGE = '/p/src/pages/index.astro';
const styleNode = (id, css) => ({ id, kind: 'raw', name: 'style', inner: css, props: {}, children: [] });

function openPage(nodes) {
  memory.setHost({ ...memory.getHost(), projectPath: '/p', files: [BASE], astroFiles: [CARD], nodes, openFilePath: PAGE, openFileKind: 'page' });
}
function openCard(nodes) {
  memory.setHost({
    ...memory.getHost(),
    projectPath: '/p',
    files: [BASE],
    astroFiles: [CARD],
    nodes,
    openFilePath: CARD.path,
    openFileKind: 'component',
    contextPagePath: PAGE,
  });
}

test('memory: remembered sources are reused, model blocks parsed, unread sources missing', () => {
  memory.forgetDocuments();
  openPage([styleNode('0', '.page { color: red; }')]);
  const first = memory.memoryContent();
  assert.deepEqual(
    first.missing.map((source) => source.key),
    [`file:${BASE.path}`, `astro:${CARD.path}`],
    'nothing read yet: the files are missing, the page block is not',
  );
  const pageBlock = first.docs[2];
  assert.equal(pageBlock?.code, '.page { color: red; }', 'the open file’s block is parsed from the model');
  // A read of the two files, as the panel stores it.
  const read = first.missing.map((source) =>
    memory.documentFromCode(source, source.key.startsWith('file:') ? '.base { margin: 0; }' : '<style is:global>.card { gap: 1rem; }</style>'),
  );
  const docs = memory.filledDocuments(first, read);
  assert.equal(docs.length, 3, 'every source has its document once filled');
  memory.rememberDocuments(docs, PAGE);
  const again = memory.memoryContent();
  assert.deepEqual(again.missing, [], 'a second look needs no read');
  assert.equal(again.docs[0], docs[0], 'the live stylesheet document is reused, not copied');
  assert.equal(again.docs[2], docs[2], 'the page block holding the model text is reused');
});

test('memory: opening a component forgets its own copy and reads the page it was opened from', () => {
  // Continues from the page state remembered above.
  openCard([styleNode('0', '.card { gap: 2rem; }')]);
  const opened = memory.memoryContent();
  const keys = opened.scan.embeds.map((source) => source.key);
  assert.ok(!keys.includes(`astro:${CARD.path}`), 'the open component is not also read as a file');
  assert.deepEqual(
    opened.missing.map((source) => source.key),
    [`astro:${PAGE}`],
    'only the page the component is open on needs a read',
  );
  const page = memory.documentFromCode(opened.missing[0], '<style>:global(.card) { color: blue; }</style>');
  memory.rememberDocuments(memory.filledDocuments(opened, [page]), CARD.path);
  // Back to the page: the component's copy was forgotten while it was open (its blocks were
  // edited through the model), so it is read again rather than drawn from the stale copy.
  openPage([styleNode('0', '.page { color: red; }')]);
  assert.deepEqual(
    memory.memoryContent().missing.map((source) => source.key),
    [`astro:${CARD.path}`],
    'the component edited while open is read afresh',
  );
});

test('memory: a source whose role changed is parsed again; a changed model block is not reused', () => {
  memory.forgetDocuments();
  openPage([styleNode('0', '.a { color: red; }')]);
  const content = memory.memoryContent();
  const docs = memory.filledDocuments(
    content,
    content.missing.map((source) => memory.documentFromCode(source, '.x { color: red; }')),
  );
  memory.rememberDocuments(docs, PAGE);
  openPage([styleNode('0', '.a { color: green; }')]);
  const edited = memory.memoryContent();
  assert.notEqual(edited.docs[2], docs[2], 'a block the model changed is parsed again');
  assert.equal(edited.docs[2]?.code, '.a { color: green; }');
  // The same key in another role: the component file now reaches as the context page.
  memory.setHost({ ...memory.getHost(), openFilePath: '/p/src/components/Other.astro', openFileKind: 'component', contextPagePath: CARD.path, nodes: [] });
  const asPage = memory.memoryContent();
  const index = asPage.scan.embeds.findIndex((source) => source.key === `astro:${CARD.path}`);
  assert.ok(index >= 0, 'the card is listed');
  assert.notEqual(asPage.docs[index], docs[1], 'a source in another role is not the same document');
  assert.equal(asPage.docs[index]?.code, docs[1].code, 'it is parsed from the remembered text');
});

test('memory: bounded', () => {
  memory.forgetDocuments();
  openPage([]);
  const source = memory.memoryContent().scan.embeds[0];
  const many = [];
  for (let index = 0; index < memory.MEMORY_DOCUMENTS_MAX + 10; index += 1) {
    many.push(memory.documentFromCode({ ...source, key: `file:/p/${index}.css`, origin: { kind: 'file', path: `/p/${index}.css` } }, ''));
  }
  memory.rememberDocuments(many, undefined);
  assert.equal(memory.rememberedDocumentCount(), memory.MEMORY_DOCUMENTS_MAX);
  memory.forgetDocuments();
  assert.equal(memory.rememberedDocumentCount(), 0);
});

// ───────────────────────────── The panel ─────────────────────────────

const COMPONENT_PATH = '/fixture/src/components/Grid.astro';
const PAGE_PATH = '/fixture/src/pages/index.astro';
const PAGE_NODES = [
  {
    id: 'n0',
    kind: 'element',
    name: 'section',
    props: { class: { type: 'string', value: 'section' } },
    children: [{ id: 'n1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'plain' } }, children: [] }],
  },
];
// The component's tree: node ids are tree paths, so its root shares no id with the page's.
const COMPONENT_NODES = [
  { id: 'c0', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'grid' } }, children: [] },
  styleNode('c1', '.grid { display: grid; }'),
];
const PANEL_FIXTURE = {
  sheets: [{ rel: 'src/styles/base.css', css: ':target { scroll-margin-top: 2rem; }\n.plain { color: red; }\n.section { padding: 1rem; }' }],
  nodes: PAGE_NODES,
  markup: '<section class="section" data-avb-p="n0"><p class="plain" data-avb-p="n1">a</p></section><div class="grid" data-avb-p="c0">g</div>',
  selectedId: 'n1',
};

function chipsState(container) {
  return {
    well: container.querySelector('.embed-editor_selector-well') !== null,
    placeholder: container.querySelector('.embed-editor_selector-chips.is-placeholder') !== null,
    chips: [...container.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.textContent.trim()),
  };
}

const frame = (window) => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

function openComponent(panel) {
  panel.rerender({
    model: { nodes: COMPONENT_NODES },
    node: { id: 'c0' },
    openFilePath: COMPONENT_PATH,
    openFileKind: 'component',
    contextPagePath: PAGE_PATH,
  });
}
function openPageAgain(panel) {
  panel.rerender({ model: { nodes: PAGE_NODES }, node: { id: 'n1' }, openFilePath: PAGE_PATH, openFileKind: 'page', contextPagePath: undefined });
}

test('panel: a first visit draws the chip well in the switching render; a second paints its chips with no answer and one read', async (context) => {
  const panel = await mountStylePanel(PANEL_FIXTURE);
  context.after(() => panel.unmount());
  memory.forgetDocuments(); // The test module's copy, not the panel's: the panel keeps its own.
  await panel.settle();
  assert.ok(chipsState(panel.container).chips.includes('.plain'), 'the page element is drawn');

  // First visit, with the canvas holding its answers: the well is there at once, as a placeholder.
  panel.bridge.mode = 'held';
  openComponent(panel);
  await frame(panel.window);
  await frame(panel.window);
  const first = chipsState(panel.container);
  assert.ok(first.well, 'the chip well is in the first frames of a first visit');
  assert.ok(first.placeholder, 'a first visit waits for the canvas in the chips’ shape');
  assert.ok(!first.chips.includes('.plain'), 'the page element’s chips are never offered as the component’s');
  panel.bridge.mode = 'immediate';
  panel.bridge.release();
  await panel.settle();
  const settledChips = chipsState(panel.container).chips;
  assert.ok(settledChips.includes('.grid'), `the component root is styled by .grid: ${settledChips}`);

  openPageAgain(panel);
  await panel.settle();
  assert.ok(chipsState(panel.container).chips.includes('.plain'), 'back on the page');

  // Second visit: count the stylesheet reads, hold every canvas answer.
  const reads = [];
  const read = panel.window.avb.readStyleFile;
  panel.window.avb.readStyleFile = (payload) => {
    reads.push(typeof payload === 'string' ? payload : (payload?.path ?? payload?.filePath ?? ''));
    return read(payload);
  };
  panel.bridge.mode = 'held';
  openComponent(panel);
  await frame(panel.window);
  await frame(panel.window);
  const again = chipsState(panel.container);
  assert.equal(again.placeholder, false, 'no placeholder on a second visit');
  assert.deepEqual(again.chips, settledChips, 'the remembered chips are drawn at once');
  // The page the component is open on is the one source read: its blocks were model nodes
  // while it was open, so no copy of it as a file is remembered (memoryContent.ts).
  assert.deepEqual(reads, [PAGE_PATH], 'no stylesheet is read again before the chips; only the page it was opened from');
  panel.bridge.mode = 'immediate';
  panel.bridge.release();
  await settle(panel.container);
  assert.deepEqual(chipsState(panel.container).chips, settledChips, 'the canvas’s fresh answer agrees and changes nothing');
});
