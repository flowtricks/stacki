// Goal: a Style panel edit shows on the canvas before its save lands, on exactly
// the rules it edits, and never outlives the save: the shared protocol
// (shared/properties/liveRules.ts) parses strictly; the frame half
// (electron/preload/frameLiveRules.ts, run by Desktop's preload and Studio's
// preview client alike) patches only the stylesheet compiled from the rule's own
// file and keeps Astro's scoping, so another component's scoped `.title` is left
// alone; a failed save puts the page's own value back; a landed save keeps the
// preview until the page's own sheet holds the value, and no longer than the
// settle window; a sheet over the rule cap is refused loudly rather than half
// searched; a grouped rule's member is not previewed; and only a declaration's
// newest edit may settle it.
// Method: the contract is parsed with good input and every bad shape; the frame
// half runs in jsdom with dev stylesheets shaped like Vite's (`data-vite-dev-id`
// and Astro's `[data-astro-cid-…]` scope) and a hand-stepped animation frame, so
// settling is driven frame by frame; the panel's tracker is driven through out-
// of-order save outcomes; usePropEdits is rendered once to call its handlers
// with stand-in hooks; and one probe runs the frame half in Electron's Chromium,
// where the cascade is real, to show the canvas computing the value before the
// save and agreeing after it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');

const contract = loadRenderer('shared/properties/liveRules.ts');
const edits = loadRenderer('src/features/style/model/liveRuleEdits.ts');

const CARD = 'src/components/Card.astro';
const HERO = 'src/components/Hero.astro';
const TITLE = { source: CARD, context: [], selector: '.title', property: 'font-size' };
const SIZE_21 = { kind: 'value', value: '21px', important: false };
const set = (rule, edit) => ({ type: 'avb:live-rule', op: 'set', rule, edit });
const drop = (rule, until) => ({ type: 'avb:live-rule', op: 'drop', rule, ...(until === undefined ? {} : { until }) });

test('live rule messages accept the declarations the panel sends', () => {
  assert.deepEqual(contract.parseLiveRuleMessage(set(TITLE, SIZE_21)), set(TITLE, SIZE_21));
  assert.deepEqual(contract.parseLiveRuleMessage(set(TITLE, { kind: 'removed' })), set(TITLE, { kind: 'removed' }));
  assert.deepEqual(contract.parseLiveRuleMessage(drop(TITLE)), drop(TITLE));
  assert.deepEqual(contract.parseLiveRuleMessage(drop(TITLE, SIZE_21)), drop(TITLE, SIZE_21));
  const queried = { ...TITLE, context: ['@media (max-width: 767px)', '@layer base'], selector: '.md\\:flex > .title' };
  assert.deepEqual(contract.parseLiveRuleMessage(set(queried, { ...SIZE_21, important: true }))?.rule, queried);
  assert.equal(contract.parseLiveRuleMessage(set({ ...TITLE, property: '--gap-size' }, SIZE_21))?.rule.property, '--gap-size');
});

test('live rule messages refuse every malformed shape', () => {
  const long = (charsMax) => 'a'.repeat(charsMax + 1);
  const limits = contract.LIVE_RULE_LIMITS;
  const bad = [
    undefined,
    JSON.parse('null'),
    'avb:live-rule',
    {},
    { type: 'avb:live-variable', op: 'set', rule: TITLE, edit: SIZE_21 },
    { type: 'avb:live-rule', rule: TITLE, edit: SIZE_21 },
    { type: 'avb:live-rule', op: 'clear', rule: TITLE },
    { type: 'avb:live-rule', op: 'set', edit: SIZE_21 },
    { type: 'avb:live-rule', op: 'set', rule: TITLE },
    set('not a rule', SIZE_21),
    // The source: project-relative, inside the project, no query.
    set({ ...TITLE, source: '/abs/src/components/Card.astro' }, SIZE_21),
    set({ ...TITLE, source: '../outside/Card.astro' }, SIZE_21),
    set({ ...TITLE, source: 'src//Card.astro' }, SIZE_21),
    set({ ...TITLE, source: 'src/Card.astro?astro&type=style' }, SIZE_21),
    set({ ...TITLE, source: 'src\\Card.astro' }, SIZE_21),
    set({ ...TITLE, source: '' }, SIZE_21),
    set({ ...TITLE, source: long(limits.sourceCharsMax) }, SIZE_21),
    set({ ...TITLE, source: 7 }, SIZE_21),
    // The context: at-rules only, bounded.
    set({ ...TITLE, context: '@media print' }, SIZE_21),
    set({ ...TITLE, context: ['.parent'] }, SIZE_21),
    set({ ...TITLE, context: ['@media print { }'] }, SIZE_21),
    set({ ...TITLE, context: [3] }, SIZE_21),
    set({ ...TITLE, context: Array.from({ length: limits.contextMax + 1 }, () => '@media print') }, SIZE_21),
    set({ ...TITLE, context: [`@media ${long(limits.contextCharsMax)}`] }, SIZE_21),
    // The selector and the property.
    set({ ...TITLE, selector: '' }, SIZE_21),
    set({ ...TITLE, selector: '.a { color: red } .b' }, SIZE_21),
    set({ ...TITLE, selector: long(limits.selectorCharsMax) }, SIZE_21),
    set({ ...TITLE, property: 'Font-Size' }, SIZE_21),
    set({ ...TITLE, property: 'font-size: 3px' }, SIZE_21),
    set({ ...TITLE, property: '' }, SIZE_21),
    // The edit: a value that stays one declaration, and a real boolean `important`.
    set(TITLE, { kind: 'value', value: '21px !important', important: false }),
    set(TITLE, { kind: 'value', value: '21px; color: red', important: false }),
    set(TITLE, { kind: 'value', value: '', important: false }),
    set(TITLE, { kind: 'value', value: long(limits.valueCharsMax), important: false }),
    set(TITLE, { kind: 'value', important: false }),
    set(TITLE, { kind: 'value', value: '21px' }),
    set(TITLE, { kind: 'value', value: '21px', important: 'true' }),
    set(TITLE, { kind: 'value', value: '21px', important: 1 }),
    set(TITLE, { kind: 'value', value: '21px', important: undefined }),
    set(TITLE, { kind: 'renamed' }),
    set(TITLE, { value: '21px', important: false }),
    drop(TITLE, { kind: 'value', value: '21px', important: 'yes' }),
    drop(TITLE, 'saved'),
  ];
  for (const input of bad) {
    assert.equal(contract.parseLiveRuleMessage(input), undefined, JSON.stringify(input));
  }
});

test('matching keeps scoping: only the source sheet, and only its own scope set aside', () => {
  assert.equal(contract.sheetPathIsSource('/Users/me/site/src/components/Card.astro?astro&type=style&index=0&lang.css', CARD), true);
  assert.equal(contract.sheetPathIsSource('C:\\site\\src\\components\\Card.astro?astro', CARD), true);
  assert.equal(contract.sheetPathIsSource('/site/src/components/BigCard.astro?astro', 'components/Card.astro'), false);
  assert.equal(contract.sheetPathIsSource('/styles/site.css', 'public/styles/site.css'), true);
  assert.equal(contract.sheetPathIsSource('/site/src/components/Hero.astro', CARD), false);
  assert.equal(contract.sheetPathIsAstroStyle('/site/src/components/Card.astro?astro&type=style&index=0&lang.css'), true);
  assert.equal(contract.sheetPathIsAstroStyle('/site/src/components/Card.astro?astro&type=script&index=0&lang.ts'), false);
  assert.equal(contract.sheetPathIsAstroStyle('/site/src/styles/global.css'), false);

  assert.equal(contract.sheetScopeOf(['.title[data-astro-cid-abc]', '.a[data-astro-cid-abc] .b[data-astro-cid-abc]', '.other']), 'abc');
  assert.equal(contract.sheetScopeOf(['.title[data-astro-cid-abc]', '.title[data-astro-cid-def]']), undefined);
  assert.equal(contract.sheetScopeOf(['.title']), undefined);
  assert.deepEqual(contract.selectorKeyOf('.a[data-astro-cid-abc] > .title[data-astro-cid-abc]', 'abc'), { scope: 'scoped', selector: '.a>.title' });
  assert.deepEqual(contract.selectorKeyOf('.title[data-astro-cid-def]', 'abc'), { scope: 'global', selector: '.title[data-astro-cid-def]' });
  assert.deepEqual(contract.selectorKeyOf('.title[data-astro-cid-def]', undefined), { scope: 'global', selector: '.title[data-astro-cid-def]' });
  assert.deepEqual(contract.sourceSelectorKey(':global(.title)'), { scope: 'global', selector: '.title' });
  assert.deepEqual(contract.sourceSelectorKey('.card :global(.title)'), { scope: 'scoped', selector: '.card .title' });
  assert.equal(contract.normalizeSelector('.a  >  .b ,.c:before [type=text]'), '.a>.b,.c::before [type="text"]');
  assert.equal(contract.normalizeAtRule('@media ( max-width:767px )'), contract.normalizeAtRule('@media (max-width: 767px)'));
  assert.equal(contract.isConditionAtRule('@layer base'), false);
  assert.equal(contract.isConditionAtRule('@container card (min-width: 400px)'), true);
});

// ───────────────────────────── The frame half, in jsdom ─────────────────────────────

let frames = [];
function installDom(head) {
  const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body></body></html>`);
  global.window = dom.window;
  for (const name of ['document', 'Element', 'Node', 'CSSGroupingRule', 'HTMLStyleElement']) {
    global[name] = dom.window[name];
  }
  frames = [];
  global.requestAnimationFrame = (callback) => frames.push(callback);
  return dom;
}
// One animation frame: what was scheduled for it runs, and schedules the next.
function step(count = 1) {
  for (let index = 0; index < count; index += 1) {
    const due = frames;
    frames = [];
    due.forEach((callback) => callback(0));
  }
}
// Vite's id: an .astro file's block carries Astro's query; a stylesheet is its own path.
const devStyle = (file, css) => {
  const query = file.endsWith('.astro') ? '?astro&amp;type=style&amp;index=0&amp;lang.css' : '';
  return `<style data-vite-dev-id="/Users/me/site/${file}${query}">${css}</style>`;
};
const ruleOf = (file, index = 0) => {
  const style = document.querySelector(`style[data-vite-dev-id*="${file}"]`);
  return style.sheet.cssRules[index];
};
const sizeOf = (file, index = 0) => ruleOf(file, index).style.getPropertyValue('font-size');
function loadFrame() {
  return loadRenderer('electron/preload/frameLiveRules.ts');
}

test("an edit to one component's .title leaves another component's scoped .title alone", () => {
  installDom(
    devStyle(CARD, '.title[data-astro-cid-aaa] { font-size: 10px }') +
      devStyle(HERO, '.title[data-astro-cid-bbb] { font-size: 10px }') +
      devStyle('src/styles/global.css', '.title { font-size: 10px } .title[data-astro-cid-aaa] { font-size: 10px }'),
  );
  const frame = loadFrame();
  assert.equal(frame.receiveLiveRules({ type: 'avb:query' }), false);
  assert.equal(frame.receiveLiveRules(set(TITLE, SIZE_21)), true);
  assert.equal(sizeOf(CARD), '21px');
  assert.equal(sizeOf(HERO), '10px', 'the other component keeps its value');
  assert.equal(sizeOf('src/styles/global.css', 0), '10px', 'a global sheet is another source');
  // In a global stylesheet a hand-written scope is part of the selector, not set aside.
  frame.receiveLiveRules(set({ ...TITLE, source: 'src/styles/global.css' }, SIZE_21));
  assert.equal(sizeOf('src/styles/global.css', 0), '21px');
  assert.equal(sizeOf('src/styles/global.css', 1), '10px');
});

test('conditions must match, layers do not matter, and :global stays apart from scoped rules', () => {
  installDom(
    devStyle(
      CARD,
      [
        '.title[data-astro-cid-aaa] { font-size: 10px }',
        '@media (max-width: 767px) { .title[data-astro-cid-aaa] { font-size: 11px } }',
        '@layer base { @media (max-width:767px) { .title[data-astro-cid-aaa] { font-size: 12px } } }',
        '.title { font-size: 13px }',
      ].join('\n'),
    ),
  );
  const frame = loadFrame();
  frame.receiveLiveRules(set({ ...TITLE, context: ['@media (max-width:767px)'] }, SIZE_21));
  assert.equal(sizeOf(CARD, 0), '10px', 'outside the query');
  assert.equal(ruleOf(CARD, 1).cssRules[0].style.getPropertyValue('font-size'), '21px');
  assert.equal(ruleOf(CARD, 2).cssRules[0].cssRules[0].style.getPropertyValue('font-size'), '21px', 'the layer is ignored');
  assert.equal(sizeOf(CARD, 3), '13px', 'the unscoped rule is another rule');
  frame.receiveLiveRules(set({ ...TITLE, selector: ':global(.title)' }, SIZE_21));
  assert.equal(sizeOf(CARD, 3), '21px');
  assert.equal(sizeOf(CARD, 0), '10px');
});

test("a failed save puts the page's own value back, priority and absence included", () => {
  installDom(devStyle(CARD, '.title[data-astro-cid-aaa] { font-size: 10px !important }'));
  const frame = loadFrame();
  frame.receiveLiveRules(set(TITLE, SIZE_21));
  frame.receiveLiveRules(set(TITLE, { kind: 'value', value: '22px', important: true }));
  assert.equal(sizeOf(CARD), '22px');
  frame.receiveLiveRules(drop(TITLE));
  assert.equal(sizeOf(CARD), '10px');
  assert.equal(ruleOf(CARD).style.getPropertyPriority('font-size'), 'important');
  frame.receiveLiveRules(set({ ...TITLE, property: 'color' }, { kind: 'value', value: 'red', important: false }));
  assert.equal(ruleOf(CARD).style.getPropertyValue('color'), 'red');
  frame.receiveLiveRules(drop({ ...TITLE, property: 'color' }));
  assert.equal(ruleOf(CARD).style.getPropertyValue('color'), '', 'a property the rule lacked is removed again');
  // A cleared property is previewed as removed, and restored the same way.
  frame.receiveLiveRules(set(TITLE, { kind: 'removed' }));
  assert.equal(sizeOf(CARD), '');
  frame.receiveLiveRules(drop(TITLE));
  assert.equal(sizeOf(CARD), '10px');
  assert.equal(frame.liveRuleCount(), 0);
  step(contract.LIVE_RULE_LIMITS.settleFramesMax);
  assert.equal(sizeOf(CARD), '10px', 'nothing comes back later');
});

test('a landed save drops the preview once the page computes the value, re-patching an older render', () => {
  installDom(devStyle(CARD, '.title[data-astro-cid-aaa] { font-size: 10px }'));
  const frame = loadFrame();
  const style = document.querySelector('style');
  frame.receiveLiveRules(set(TITLE, SIZE_21));
  frame.receiveLiveRules(drop(TITLE, SIZE_21));
  step(3);
  assert.equal(frame.liveRuleCount(), 1, 'the page has not re-rendered yet');
  assert.equal(sizeOf(CARD), '21px');
  // An older save's render arrives first: the preview is put on its fresh sheet.
  style.textContent = '.title[data-astro-cid-aaa] { font-size: 15px }';
  step();
  assert.equal(sizeOf(CARD), '21px', 'the older value never shows');
  assert.equal(frame.liveRuleCount(), 1);
  // The save's own render: the page holds the value itself, and the preview goes.
  style.textContent = '.title[data-astro-cid-aaa] { font-size: 21px }';
  step();
  assert.equal(frame.liveRuleCount(), 0);
  assert.equal(sizeOf(CARD), '21px');
  assert.equal(frames.length, 0, 'nothing is left scheduled');
});

test('a released preview the page never agrees with is restored when the settle window ends', () => {
  installDom(devStyle(CARD, '.title[data-astro-cid-aaa] { font-size: 10px }'));
  const frame = loadFrame();
  frame.receiveLiveRules(set(TITLE, SIZE_21));
  frame.receiveLiveRules(drop(TITLE, SIZE_21));
  const settleFramesMax = contract.LIVE_RULE_LIMITS.settleFramesMax;
  step(settleFramesMax - 1);
  assert.equal(sizeOf(CARD), '21px');
  assert.equal(frame.liveRuleCount(), 1);
  step();
  assert.equal(frame.liveRuleCount(), 0);
  assert.equal(sizeOf(CARD), '10px', 'nothing outlives its window');
});

test('a stylesheet over the rule cap is refused loudly, not half searched', () => {
  const rulesMax = contract.LIVE_RULE_LIMITS.sheetRulesMax;
  const css = Array.from({ length: rulesMax + 1 }, (_, index) => `.r${index} { color: red }`).join('\n') + '\n.title { font-size: 10px }';
  installDom(devStyle(CARD, css));
  const frame = loadFrame();
  const found = frame.matchingRules(document, TITLE);
  assert.equal(found.ok, false);
  assert.equal(found.error.code, 'rules-over-cap');
  const warned = [];
  const warn = console.warn;
  console.warn = (message) => warned.push(message);
  try {
    frame.receiveLiveRules(set(TITLE, SIZE_21));
    frame.receiveLiveRules(set(TITLE, SIZE_21));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(
    frame.liveRuleProblems().map((problem) => problem.code),
    ['rules-over-cap'],
  );
  assert.equal(warned.length, 1, 'once per sheet');
  assert.match(warned[0], /more than 20000 rules/);
  assert.equal(ruleOf(CARD, rulesMax + 1).style.getPropertyValue('font-size'), '10px');
});

// ───────────────────────────── The panel's half ─────────────────────────────

test("only a declaration's newest edit settles it, so a scrub's earlier saves do not", () => {
  const posted = [];
  const live = edits.createLiveRules((message) => posted.push(message));
  const first = live.show(TITLE, SIZE_21);
  const second = live.show(TITLE, { ...SIZE_21, value: '22px' });
  live.landed(first, SIZE_21);
  live.failed(first);
  assert.deepEqual(
    posted.map((message) => message.op),
    ['set', 'set'],
  );
  live.landed(second, { ...SIZE_21, value: '22px' });
  assert.deepEqual(posted.at(-1), drop(TITLE, { ...SIZE_21, value: '22px' }));
  live.failed(second);
  assert.equal(posted.length, 3, 'a settled preview is settled once');
  const third = live.show(TITLE, SIZE_21);
  live.failed(third);
  assert.deepEqual(posted.at(-1), drop(TITLE));
});

test('the panel names a rule by its project-relative file, and skips what the canvas cannot find', () => {
  assert.equal(edits.projectRelative('/Users/me/site/src/components/Card.astro', '/Users/me/site'), CARD);
  assert.equal(edits.projectRelative('C:\\site\\src\\components\\Card.astro', 'C:\\site\\'), CARD);
  assert.equal(edits.projectRelative('src/components/Card.astro', 'studio'), CARD);
  assert.equal(edits.projectRelative('/Users/me/site/../x.css', '/Users/me/site'), undefined);
  const rule = { selectorText: '.title', atContext: ['@media (max-width: 767px)'] };
  const source = { origin: { kind: 'astro', path: '/Users/me/site/src/components/Card.astro' } };
  assert.deepEqual(edits.liveRuleTargetOf(rule, source, 'font-size', '/Users/me/site'), {
    source: CARD,
    context: ['@media (max-width: 767px)'],
    selector: '.title',
    property: 'font-size',
  });
  assert.equal(edits.liveRuleTargetOf({ ...rule, written: { parents: ['.hero'], head: '.title' } }, source, 'font-size', '/Users/me/site'), undefined);
  assert.equal(edits.liveRuleTargetOf(rule, { origin: { kind: 'node', nodeId: 'n1', filePath: undefined } }, 'font-size', '/Users/me/site'), undefined);
});

// usePropEdits with stand-in hooks, rendered once on the server: the handlers it returns
// are the ones the panel calls. The canvas frame is a stand-in that records messages.
function loadPropEdits() {
  installDom('');
  // Inside the repository, so the bundle resolves the repository's own React.
  const output = repoPath('node_modules/.stacki-test/live-rule-prop-edits.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: {
      contents:
        "export { usePropEdits } from './src/features/style/embed/useEditorRuleEdits.ts';\nexport { setCanvasFrame } from './src/editor/canvasQuery.ts';\nexport { setHost } from './src/features/style/model/host.ts';\n",
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  delete require.cache[output];
  return require(output);
}

function renderPropEdits(module, { grouped, saves }) {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  let handlers;
  const splitForEditHook = { isGroupedSplittable: () => grouped, splitForEdit: (rule) => ({ rule, remap: (declaration) => declaration }) };
  const applyEditHook = {
    applyEdit: () => saves.shift() ?? Promise.resolve(true),
    liveTargetOf: (rule, prop) => ({ source: CARD, context: [], selector: rule.selectorText, property: prop }),
    classGatesRef: { current: new Map() },
  };
  function Probe() {
    handlers = module.usePropEdits(splitForEditHook, applyEditHook);
    return undefined;
  }
  renderToString(React.createElement(Probe));
  return handlers;
}

test("the panel previews an edit, settles it by its save, and skips a grouped rule's member", async () => {
  const module = loadPropEdits();
  const posted = [];
  module.setCanvasFrame({ postMessage: (message) => posted.push(message) });
  const rule = { selectorText: '.title', atContext: [] };

  const grouped = renderPropEdits(module, { grouped: true, saves: [] });
  grouped.onSetProp(rule, 'font-size', '21px', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted, [], 'a member of `.a, .b` is split by the save; the canvas would change both');

  let fail;
  const failing = new Promise((resolve) => {
    fail = () => resolve(false);
  });
  const plain = renderPropEdits(module, { grouped: false, saves: [failing, Promise.resolve(true)] });
  plain.onSetProp(rule, 'font-size', '21px', false);
  assert.deepEqual(posted, [set(TITLE, SIZE_21)], 'shown before the save resolves');
  fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted.at(-1), drop(TITLE), 'a refused save puts the page value back');

  plain.onClearProp(rule, ['font-size', 'padding-top']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(posted.slice(-2), [set(TITLE, { kind: 'removed' }), drop(TITLE, { kind: 'removed' })], 'a padding side is left to the save');
});

// ───────────────────────────── The frame half, in Chromium ─────────────────────────────

test('in a real browser the canvas shows the value before the save and agrees after it', (context) => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    context.skip('no Chromium to hand (the electron package is missing)');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-live-rules-probe-'));
  try {
    const bundle = buildSync({
      entryPoints: [repoPath('electron/preload/frameLiveRules.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'liveRules',
      logLevel: 'silent',
    });
    const page = `<!doctype html><html><head>
      ${devStyle(CARD, '.title[data-astro-cid-aaa] { font-size: 10px }')}
      ${devStyle(HERO, '.title[data-astro-cid-bbb] { font-size: 10px }')}
      </head><body>
      <h2 id="card" class="title" data-astro-cid-aaa>Card</h2>
      <h2 id="hero" class="title" data-astro-cid-bbb>Hero</h2>
      </body></html>`;
    const script = path.join(directory, 'probe.js');
    fs.writeFileSync(
      script,
      `const { app, BrowserWindow } = require('electron');
       const source = ${JSON.stringify(bundle.outputFiles[0].text)};
       app.on('window-all-closed', () => app.quit());
       app.whenReady().then(async () => {
         const win = new BrowserWindow({ show: false, width: 400, height: 300 });
         await win.loadURL('data:text/html,' + encodeURIComponent(${JSON.stringify(page)}));
         await win.webContents.executeJavaScript(source + ';0');
         const run = (code) => win.webContents.executeJavaScript(code);
         const sizes = () => run("[getComputedStyle(card).fontSize, getComputedStyle(hero).fontSize, liveRules.liveRuleCount()]");
         const frames = (count) => run('new Promise((resolve) => { let left = ' + count + '; const next = () => (--left <= 0 ? resolve() : requestAnimationFrame(next)); requestAnimationFrame(next); })');
         const message = (value) => JSON.stringify(value);
         const out = {};
         out.before = await sizes();
         await run('liveRules.receiveLiveRules(' + message(${JSON.stringify(set(TITLE, SIZE_21))}) + ')');
         out.previewed = await sizes();
         await run('liveRules.receiveLiveRules(' + message(${JSON.stringify(drop(TITLE, SIZE_21))}) + ')');
         await frames(3);
         out.waiting = await sizes();
         await run("document.querySelector('style').textContent = '.title[data-astro-cid-aaa] { font-size: 21px }'");
         await frames(3);
         out.saved = await sizes();
         await run('liveRules.receiveLiveRules(' + message(${JSON.stringify(set(TITLE, { ...SIZE_21, value: '30px' }))}) + ')');
         out.again = await sizes();
         await run('liveRules.receiveLiveRules(' + message(${JSON.stringify(drop(TITLE))}) + ')');
         out.refused = await sizes();
         console.log(JSON.stringify(out));
         app.quit();
       });`,
    );
    const { spawnSync } = require('node:child_process');
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electronPath, [script], { encoding: 'utf8', timeout: 60_000, env: environment });
    const line = (run.stdout || '').split('\n').find((entry) => entry.trim().startsWith('{'));
    assert.ok(line, (run.stderr || run.stdout || '').slice(0, 500));
    const out = JSON.parse(line);
    assert.deepEqual(out.before, ['10px', '10px', 0]);
    assert.deepEqual(out.previewed, ['21px', '10px', 1], 'shown before the save, on this component only');
    assert.deepEqual(out.waiting, ['21px', '10px', 1], 'held while the page has not re-rendered');
    assert.deepEqual(out.saved, ['21px', '10px', 0], 'the page agrees, and the preview is gone');
    assert.deepEqual(out.again, ['30px', '10px', 1]);
    assert.deepEqual(out.refused, ['21px', '10px', 0], 'a refused save shows the page value again');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
