// Goal: the Style panel's first styles (src/features/style/model/firstStyleBlock.ts) do what a
// person who has never written CSS needs, and nothing at all to a project that has styles of its
// own. With no `<style>` block and no stylesheet, the first style applied to an element adds a
// block and a class (`.class`) through ONE host call; the next class-less element gets
// `.class-2` in that block; a project with any hand-written style, or a stylesheet, is written
// exactly as before.
//
// Method, in two layers. (1) The pure decisions, as tables with their negative space: the plan
// for every combination of sources, selector and file, the class names, the block's text for
// LF/CRLF and tab/space files, and the file kinds that can hold a block. (2) The real
// EmbedEditor mounted in jsdom over a host that behaves as Desktop's does: it answers
// `addStyleBlock` and `addClass` by changing the nodes it shows. A value is typed into the
// Opacity field (a write the panel treats like any other), and the calls the panel makes to the
// host are compared with what each case should produce.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitFor, waitForSteady } = require('../../helpers/waitFor.js');
const firstStyles = require('../../helpers/rendererModule')('src/features/style/model/firstStyleBlock.ts');

const PAGE = '/p/src/pages/index.astro';
// One turn of the event loop: React's scheduler runs its queued render in Node's check phase,
// so after this the panel has handled the event just dispatched. A task boundary, not a guess
// at how long anything takes.
const nextTask = () => new Promise((resolve) => setImmediate(resolve));

// ───────────────────────────── The pure decisions ─────────────────────────────

const plan = (changes) =>
  firstStyles.planFirstStyles({
    selector: 'div',
    tag: 'div',
    elementClasses: [],
    sourceCount: 0,
    ruleSelectors: [],
    takenClasses: new Set(),
    filePath: PAGE,
    ...changes,
  });

test('with no source at all, a class-less tag gets a block and a class; a class it has gets a block alone', () => {
  assert.deepEqual(plan({}), { kind: 'block-and-class', className: 'class' });
  assert.deepEqual(plan({ selector: '.hero', elementClasses: ['hero'] }), { kind: 'block' });
  // A tag with classes, a state of the tag, a descendant selector: the person picked it.
  assert.deepEqual(plan({ elementClasses: ['hero'] }), { kind: 'block' });
  assert.deepEqual(plan({ selector: 'div:hover' }), { kind: 'block' });
  assert.deepEqual(plan({ selector: '.a .b' }), { kind: 'block' });
  // The tag is unknown until the canvas answers: no class is invented for an element nobody read.
  assert.deepEqual(plan({ tag: undefined }), { kind: 'block' });
});

test('a first class avoids every name taken in the file', () => {
  assert.deepEqual(plan({ takenClasses: new Set(['class']) }), { kind: 'block-and-class', className: 'class-2' });
  assert.deepEqual(plan({ takenClasses: new Set(['class', 'class-2', 'class-3']) }), { kind: 'block-and-class', className: 'class-4' });
  assert.equal(firstStyles.autoClassName(new Set()), 'class');
  assert.equal(firstStyles.autoClassName(new Set(['class-2'])), 'class', 'a gap is filled from the bottom');
  assert.equal(firstStyles.autoClassName(new Set(['class', 'class-3'])), 'class-2');
  // A name that merely starts like ours is another name.
  assert.equal(firstStyles.autoClassName(new Set(['classy', 'class-x', 'Class'])), 'class');
});

test('the name search is bounded by the names taken', () => {
  const taken = new Set(['class']);
  for (let ordinal = 2; ordinal <= 500; ordinal += 1) {
    taken.add(`class-${ordinal}`);
  }
  assert.equal(firstStyles.autoClassName(taken), 'class-501');
});

test('sources made only of auto classes still give a class-less tag its own class', () => {
  const own = { sourceCount: 1, ruleSelectors: ['.class'], takenClasses: new Set(['class']) };
  assert.deepEqual(plan(own), { kind: 'class', className: 'class-2' });
  assert.deepEqual(plan({ ...own, ruleSelectors: ['.class', '.class-2'], takenClasses: new Set(['class', 'class-2']) }), {
    kind: 'class',
    className: 'class-3',
  });
  // An element that already has a class, or a non-tag pick, is the ordinary path.
  assert.deepEqual(plan({ ...own, elementClasses: ['hero'] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...own, selector: '.class' }), { kind: 'normal' });
});

test('a project with a style of its own is never touched', () => {
  const base = { sourceCount: 1, takenClasses: new Set() };
  // One hand-written selector anywhere ends it, however many auto classes sit beside it.
  assert.deepEqual(plan({ ...base, ruleSelectors: ['.hero'] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...base, ruleSelectors: ['.class', '.hero'] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...base, ruleSelectors: ['div'] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...base, ruleSelectors: [':root'] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...base, ruleSelectors: ['.class-1'] }), { kind: 'normal' }, '.class-1 is a person’s name');
  assert.deepEqual(plan({ ...base, ruleSelectors: ['.class-0'] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...base, ruleSelectors: ['.class .x'] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...base, ruleSelectors: ['.class:hover'] }), { kind: 'normal' });
  // A block with no rules in it is the person's own too: it is not ours until a rule of ours is in it.
  assert.deepEqual(plan({ ...base, ruleSelectors: [] }), { kind: 'normal' });
  assert.deepEqual(plan({ ...base, sourceCount: 3, ruleSelectors: ['.hero'] }), { kind: 'normal' });
});

test('a file that cannot hold a block is refused with what to do', () => {
  for (const filePath of ['/p/src/pages/notes.md', '/p/src/pages/notes.mdx', '/p/src/pages/index.html', '/p/src/pages/index.astro.bak', undefined]) {
    const refused = plan({ filePath });
    assert.equal(refused.kind, 'refused', String(filePath));
    assert.equal(refused.message, firstStyles.UNSUPPORTED_FILE_MESSAGE);
  }
  assert.equal(firstStyles.styleBlockFileSupported('/p/src/pages/Index.ASTRO'), true);
  assert.equal(firstStyles.styleBlockFileSupported('/p/src/components/Card.astro'), true);
  // Sources exist: the plan never reads the file kind, because nothing needs a block.
  assert.deepEqual(plan({ filePath: '/p/notes.md', sourceCount: 1, ruleSelectors: ['.hero'] }), { kind: 'normal' });
});

test('auto selectors are exactly .class and .class-N from 2', () => {
  for (const selector of ['.class', '.class-2', '.class-9', '.class-10', '.class-123', ' .class ']) {
    assert.equal(firstStyles.isAutoClassSelector(selector), true, selector);
  }
  for (const selector of [
    '.class-1',
    '.class-0',
    '.class-02',
    '.classy',
    '.class-',
    '.class-a',
    'class',
    '#class',
    '.Class',
    '.class.class-2',
    '',
    '.class,.class-2',
  ]) {
    assert.equal(firstStyles.isAutoClassSelector(selector), false, selector);
  }
});

test('the block text follows the file: its indent unit and its line ending', () => {
  const rule = '.class {\n\tpadding: 1rem;\n}\n';
  const tabs = firstStyles.fileLayoutOf('<main>\n\t<p>x</p>\n</main>\n');
  assert.deepEqual(tabs, { unit: '\t', eol: '\n' });
  assert.equal(firstStyles.styleBlockInner(rule, tabs), '\n\t.class {\n\t\tpadding: 1rem;\n\t}\n');
  const spaces = firstStyles.fileLayoutOf('<main>\n  <p>x</p>\n</main>\n');
  assert.deepEqual(spaces, { unit: '  ', eol: '\n' });
  assert.equal(firstStyles.styleBlockInner(rule, spaces), '\n  .class {\n    padding: 1rem;\n  }\n');
  const crlf = firstStyles.fileLayoutOf('<main>\r\n\t<p>x</p>\r\n</main>\r\n');
  assert.deepEqual(crlf, { unit: '\t', eol: '\r\n' });
  assert.equal(firstStyles.styleBlockInner(rule, crlf), '\r\n\t.class {\r\n\t\tpadding: 1rem;\r\n\t}\r\n');
  // Leading and trailing blank lines of the panel's text never reach the page; blank lines inside stay.
  assert.equal(firstStyles.styleBlockInner('\n\n.a {\n\tx: y;\n}\n\n.b {\n}\n\n', tabs), '\n\t.a {\n\t\tx: y;\n\t}\n\n\t.b {\n\t}\n');
  assert.throws(() => firstStyles.styleBlockInner('\n\n', tabs), /at least one rule line/);
  assert.throws(() => firstStyles.styleBlockInner('.a {\r\n}', tabs), /\\n line ends/);
});

// ───────────────────────────── The panel, mounted ─────────────────────────────

const SIZE = 240;
let environment;

// The panel, its host setter and a jsdom window, set up once for the file.
async function panelEnvironment() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'first-styles-panel.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './src/features/style/EmbedEditor'\nexport { setHost, getHost } from './src/features/style/model/host'\nexport { subscribeErrorToasts } from './src/ui/errorNotices'`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: false,
  };
  // Node defines navigator as a getter, so each global is defined, not assigned.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = Observer;
  dom.window.ResizeObserver = Observer;
  dom.window.Element.prototype.scrollIntoView = function () {};
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

const styleNode = (inner, extra = {}) => ({ id: 'n9', kind: 'raw', name: 'style', props: { 'is:global': { type: 'bare' } }, inner, ...extra });
const scopedNode = (inner) => ({ id: 'n9', kind: 'raw', name: 'style', props: {}, inner });
const classAttr = (value) => ({ type: 'string', value });

// Mount the panel over `nodes` with the element `n1` selected and the given sources. The host
// answers addClass and addStyleBlock the way Desktop does: by changing the nodes it shows.
async function mountPanel({ nodes, files = [], disk = '', openFilePath = PAGE, refuse, styles, holdBlock = false, openStyleTagSettings }) {
  const { dom, React, createRoot, EmbedEditor, setHost, subscribeErrorToasts } = await panelEnvironment();
  const calls = [];
  // The panel reports a failure as an error toast; the app's toast owner is stood in for here.
  const toasts = [];
  const unsubscribe = subscribeErrorToasts(
    (notice) => toasts.push(notice.message),
    () => {},
  );
  const state = { nodes };
  let releaseBlock = () => {};
  const blockSaved = holdBlock ? new Promise((resolve) => (releaseBlock = resolve)) : Promise.resolve();
  const shown = () => ({ ...state, nodes: state.nodes.map((node) => ({ ...node })) });
  const withClass = (name) => {
    state.nodes = state.nodes.map((node) =>
      node.id === 'n1' ? { ...node, props: { ...node.props, class: classAttr([node.props?.class?.value, name].filter(Boolean).join(' ')) } } : node,
    );
  };
  const host = {
    projectPath: '/p',
    selectedId: 'n1',
    files,
    astroFiles: [],
    openFilePath,
    openFileKind: 'page',
    renderedClasses: [],
    pathOf: () => undefined,
    openStyleTagSettings,
    addClass: async (name, placement) => {
      calls.push(['addClass', name, placement]);
      withClass(name);
      setHost({ ...host, ...shown(), renderedClasses: state.nodes[0].props?.class?.value.split(' ') ?? [] });
      return { tag: 'applied' };
    },
    addStyleBlock: async (request) => {
      calls.push(['addStyleBlock', request]);
      if (refuse) {
        return { tag: 'refused', message: refuse };
      }
      // Desktop queues the edit and then waits for the save to reach disk. With `holdBlock` the
      // save stays on its way until the test calls `releaseBlock`, so "while the first tag is
      // saving" is a state the test is in, not a race against a timer.
      await blockSaved;
      if (request.className) {
        withClass(request.className);
      }
      state.nodes = [
        ...state.nodes,
        request.attributes.some((attribute) => attribute.name === 'is:global') ? styleNode(`\n${request.css}`) : scopedNode(`\n${request.css}`),
      ];
      setHost({ ...host, ...shown(), renderedClasses: state.nodes[0].props?.class?.value.split(' ') ?? [] });
      return { tag: 'applied' };
    },
    writeStyleNode: (target, css, immediate) => {
      calls.push(['writeStyleNode', target.nodeId, css, immediate]);
      state.nodes = state.nodes.map((node) => (node.id === target.nodeId ? { ...node, inner: css } : node));
      return true;
    },
  };
  dom.window.avb = {
    projectMetadata: async () => (styles === undefined ? { ok: true, value: { source: undefined } } : { ok: true, value: { source: JSON.stringify(styles) } }),
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => ({ css: disk }),
    writeStyleFile: async ({ css }) => {
      calls.push(['writeStyleFile', css]);
      return { ok: true };
    },
  };
  setHost({ ...host, ...shown() });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(EmbedEditor));
  const opacityField = () => [...container.querySelectorAll('input')].find((candidate) => candidate.getAttribute('aria-label') === 'Opacity');
  // Everything the test can observe of the panel and its host, for waiting until it stops changing.
  const observed = () => ({
    calls: calls.map((call) => JSON.stringify(call)),
    nodes: state.nodes.map((node) => [node.id, node.inner, node.props?.class?.value]),
    toasts: [...toasts],
    picker: container.querySelector('.embed-editor_source-picker')?.textContent,
    chips: [...container.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.textContent),
    field: opacityField()?.value,
  });
  // The panel settled: what it wrote, shows and reports has stopped changing (test/helpers/waitFor.js).
  const settled = (what) => waitForSteady({ what, read: observed, until: () => true });
  await waitFor({
    what: 'the panel drawn with its Opacity field and source picker',
    read: observed,
    until: (seen) => seen.field !== undefined && seen.picker !== undefined,
  });
  await settled('the panel at rest after mounting');
  const selectorTexts = () => [...container.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.textContent);
  // Type into the Opacity field and commit with Enter: a write like any other.
  // `then: 'settle'` waits for the panel to go quiet; `then: 'continue'` returns at once, for
  // commits made back to back while an earlier one is still saving.
  // Typing and committing are separate steps so a test can commit at a moment it chose.
  const draftOpacity = async (value) => {
    const input = opacityField();
    assert.ok(input, 'the Opacity field is drawn');
    input.focus();
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await nextTask();
  };
  // The panel disables its fields while a write is saving (busy), so no person can commit into
  // one then; a test that dispatched Enter into a disabled field would test nothing real.
  const commitOpacity = () => {
    const input = opacityField();
    assert.ok(input, 'the Opacity field is drawn');
    assert.equal(input.disabled, false, 'the Opacity field takes the commit: it is not disabled by a save in progress');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  const typeOpacity = async (value, then = 'settle') => {
    await draftOpacity(value);
    commitOpacity();
    if (then === 'settle') {
      await settled(`the panel quiet after committing opacity ${value}`);
    }
  };
  // Drag the padding-top number down by `distancePx` and let go. Shift held on release writes all
  // four sides and Alt the opposite one too: one setProp per side, back to back in one event,
  // before the panel has seen any of them land (SpacingFill.tsx useSideDrag).
  const dragPadding = async (distancePx, modifiers = {}, then = 'settle') => {
    const label = container.querySelector('button[data-prop="padding-top"]');
    assert.ok(label, 'the padding-top label is drawn');
    const pointer = (type, y) =>
      label.dispatchEvent(
        new (dom.window.PointerEvent ?? dom.window.MouseEvent)(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y, pointerId: 1, ...modifiers }),
      );
    pointer('pointerdown', 100);
    for (let step = 1; step <= 4; step += 1) {
      pointer('pointermove', 100 + Math.round((distancePx * step) / 4));
      await nextTask();
    }
    pointer('pointerup', 100 + distancePx);
    if (then === 'settle') {
      await settled(`the panel quiet after a ${distancePx} px padding drag`);
    }
  };
  // Select another element: the host's selection moves and the panel is told.
  const select = async (id) => {
    state.selected = id;
    setHost({ ...host, ...shown(), selectedId: id, renderedClasses: [] });
    await settled(`the panel quiet after selecting ${id}`);
  };
  return {
    calls,
    container,
    state,
    settled,
    // Let the held first-tag save reach disk (`holdBlock`).
    releaseBlock: () => releaseBlock(),
    typeOpacity,
    draftOpacity,
    commitOpacity,
    dragPadding,
    selectorTexts,
    select,
    errorText: () => toasts.join(' | '),
    unmount: () => {
      unsubscribe();
      root.unmount();
      container.remove();
    },
  };
}

const div = (id, classes) => ({ id, kind: 'element', name: 'div', props: classes ? { class: classAttr(classes) } : {}, children: [] });
const kinds = (calls) => calls.map((call) => call[0]);

test('no style source: one host call adds the block and the class, and the pick becomes .class', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1')] });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  assert.deepEqual(kinds(panel.calls), ['addStyleBlock'], 'one call to the host, no separate class edit and no stylesheet write');
  const [, request] = panel.calls[0];
  assert.equal(request.className, 'class');
  assert.equal(request.css, '\n.class {\n\topacity: 0.5;\n}');
  assert.deepEqual(request.placement, { kind: 'end' });
  assert.ok(panel.selectorTexts().includes('.class'), `the chip shows .class: ${panel.selectorTexts()}`);
});

test('after the first edit, more edits write into the same rule and add nothing new', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1')] });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  await panel.typeOpacity('0.25');
  const later = panel.calls.slice(1);
  assert.equal(panel.calls[0][0], 'addStyleBlock');
  assert.ok(later.length > 0 && later.every((call) => call[0] === 'writeStyleNode'), `only writes to the block follow: ${kinds(later)}`);
  const [, nodeId, css] = later[later.length - 1];
  assert.equal(nodeId, 'n9', 'the block the host added');
  assert.match(css, /\.class \{\s*opacity: 0\.25;\s*\}/);
  assert.equal(css.match(/\.class/g).length, 1, 'one rule, edited in place');
});

test('the next class-less element gets .class-2 in the block that exists', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1'), div('n2')] });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  await panel.select('n2');
  await panel.typeOpacity('0.3');
  assert.deepEqual(kinds(panel.calls), ['addStyleBlock', 'addClass', 'writeStyleNode']);
  assert.equal(panel.calls[1][1], 'class-2');
  const css = panel.calls[2][2];
  assert.match(css, /\.class \{\s*opacity: 0\.5;\s*\}/, 'the first rule is untouched');
  assert.match(css, /\.class-2 \{\s*opacity: 0\.3;\s*\}/);
});

test('an element that already has a class gets a block holding that class, and no new class', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1', 'hero')] });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  assert.deepEqual(kinds(panel.calls), ['addStyleBlock']);
  assert.equal(panel.calls[0][1].className, undefined);
  assert.equal(panel.calls[0][1].css, '\n.hero {\n\topacity: 0.5;\n}');
});

test('a name already used in the file is skipped', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1'), div('n2', 'class')] });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  assert.equal(panel.calls[0][1].className, 'class-2');
});

test('a refusal from the host is shown and nothing is claimed saved', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1')], refuse: 'the edit could not be queued' });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  assert.deepEqual(kinds(panel.calls), ['addStyleBlock']);
  assert.match(panel.errorText(), /the edit could not be queued/);
  assert.equal(panel.state.nodes.length, 1, 'the page was not changed');
});

test('a Markdown page is refused with what to do, and the host is not asked', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1')], openFilePath: '/p/src/pages/notes.md' });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  assert.deepEqual(panel.calls, []);
  assert.match(panel.errorText(), /no place for a style block/);
});

test('a project with a style of its own is written as it always was', async (context) => {
  // A hand-written block: the class-less tag gets a tag rule in it, no class, no new block.
  const handWritten = await mountPanel({ nodes: [div('n1'), styleNode('\n.hero {\n\tcolor: red;\n}\n')] });
  context.after(handWritten.unmount);
  await handWritten.typeOpacity('0.5');
  assert.deepEqual(kinds(handWritten.calls), ['writeStyleNode']);
  assert.match(handWritten.calls[0][2], /\.hero \{\s*color: red;\s*\}[\s\S]*div \{\s*opacity: 0\.5;\s*\}/);
  handWritten.unmount();

  // An empty block is a style tag the person made: still theirs.
  const empty = await mountPanel({ nodes: [div('n1'), styleNode('')] });
  context.after(empty.unmount);
  await empty.typeOpacity('0.5');
  assert.deepEqual(kinds(empty.calls), ['writeStyleNode']);
  assert.match(empty.calls[0][2], /div \{\s*opacity: 0\.5;\s*\}/);
  empty.unmount();

  // A stylesheet and no tag: the new selector goes to the virtual Create <style> entry (a tag rule in a new block),
  // and a selector the stylesheet already defines is still written there.
  const sheet = { rel: 'src/styles/site.css', name: 'site.css', path: '/p/src/styles/site.css', size: 20 };
  const stylesheet = await mountPanel({ nodes: [div('n1', 'hero')], files: [sheet], disk: '.hero { color: red; }' });
  context.after(stylesheet.unmount);
  await stylesheet.typeOpacity('0.5');
  assert.deepEqual(kinds(stylesheet.calls), ['writeStyleFile']);
  assert.match(stylesheet.calls[0][1], /\.hero \{ color: red;[\s\S]*opacity: 0\.5;/);
});

test('a new selector with a stylesheet and no <style> goes to Create <style>: nothing is written until the first style, then one block', async (context) => {
  const sheet = { rel: 'src/styles/site.css', name: 'site.css', path: '/p/src/styles/site.css', size: 20 };
  const panel = await mountPanel({ nodes: [div('n1', 'fresh')], files: [sheet], disk: '.other { color: red; }' });
  context.after(panel.unmount);
  assert.deepEqual(panel.calls, [], 'selecting writes nothing');
  assert.match(panel.container.querySelector('.embed-editor_source-picker').textContent, /Create <style>/);
  await panel.typeOpacity('0.5');
  assert.deepEqual(kinds(panel.calls), ['addStyleBlock']);
  const [, request] = panel.calls[0];
  assert.deepEqual(request.attributes, [{ name: 'is:global', value: undefined }], 'a project that never wrote the section gets Stacki’s default, is:global');
  assert.equal(request.css, '\n.fresh {\n\topacity: 0.5;\n}');
  assert.equal(request.className, undefined);
});

test('with the setting on, the block is global and the template wraps the rule; a page with a tag shows <style>', async (context) => {
  const styles = { version: 1, keep: [], newStyleTag: { version: 1, isGlobal: true, content: '@layer components {}' } };
  const sheet = { rel: 'src/styles/site.css', name: 'site.css', path: '/p/src/styles/site.css', size: 20 };
  const panel = await mountPanel({ nodes: [div('n1', 'fresh')], files: [sheet], disk: '', styles });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  const request = panel.calls[0][1];
  assert.deepEqual(request.attributes, [{ name: 'is:global', value: undefined }]);
  assert.match(request.css, /@layer components \{[\s\S]*\.fresh \{[\s\S]*opacity: 0\.5;[\s\S]*\}\s*\}/);
  panel.unmount();
  const tagged = await mountPanel({ nodes: [div('n1', 'fresh'), scopedNode('')], files: [sheet], disk: '' });
  context.after(tagged.unmount);
  const label = tagged.container.querySelector('.embed-editor_source-picker').textContent;
  assert.match(label, /<style>/);
  assert.doesNotMatch(label, /Create/);
  await tagged.typeOpacity('0.5');
  assert.deepEqual(kinds(tagged.calls), ['writeStyleNode'], 'the page tag, not the stylesheet, takes the first style');
});

// ───────────────── One tag however fast the first styles arrive ─────────────────
//
// A Shift-drag of a padding band (or Shift+Enter in its editor) commits four sides back to back
// in one event; a quick series of drags commits again while the first save is still on its way
// to disk. Each of those commits found no rule for the new class, and each made a `<style>` of
// its own: four tags where one was meant. The first tag is now created once per file, and every
// write that arrives while it is being created lands in that same tag.

const STYLESHEET = { rel: 'src/styles/site.css', name: 'site.css', path: '/p/src/styles/site.css', size: 20 };
const blockCalls = (calls) => calls.filter((call) => call[0] === 'addStyleBlock');
// The page's `<style>` nodes, as the host now shows them.
const styleTags = (panel) => panel.state.nodes.filter((node) => node.name === 'style');

// Each test holds the first tag's save (`holdBlock`) and releases it itself, so "while the first
// tag is saving" is a state the test is in rather than a race against a save timer: on a loaded
// runner a 400 ms timer could fire between two commits the test meant to land inside it.
const lastOpacityLands = (panel, value) =>
  waitForSteady({
    what: `opacity ${value} in the one tag, and nothing writing over it`,
    read: () => styleTags(panel).map((node) => node.inner),
    until: (inners) => inners.length === 1 && inners[0].includes(`opacity: ${value};`),
  });

test('a Shift-drag of a padding on a fresh class makes ONE tag holding all four sides, in one host call', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '.other { color: red; }', holdBlock: true });
  context.after(panel.unmount);
  await panel.dragPadding(24, { shiftKey: true });
  assert.equal(blockCalls(panel.calls).length, 1, `one tag is created: ${kinds(panel.calls)}`);
  assert.equal(panel.calls[0][0], 'addStyleBlock', 'the four sides go in with the tag, so one undo takes the whole drag back');
  const css = panel.calls[0][1].css;
  assert.equal(css.match(/\.my-class/g).length, 1, `one rule: ${css}`);
  // Four equal sides are written as the shorthand (spacingShorthand.test.js), so all four are in this one write.
  assert.match(css, /\tpadding: [\d.]+rem;/, css);
  assert.doesNotMatch(css, /padding-(top|right|bottom|left)/, css);
  panel.releaseBlock();
  await panel.settled('the panel quiet after the tag saved');
  assert.equal(styleTags(panel).length, 1);
  assert.equal(blockCalls(panel.calls).length, 1, `still one tag once it saved: ${kinds(panel.calls)}`);
  assert.equal(kinds(panel.calls).filter((kind) => kind === 'writeStyleFile').length, 0, 'the stylesheet is left alone');
});

test('drags that arrive while the first tag is saving land in that tag: one rule, one declaration', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '', holdBlock: true });
  context.after(panel.unmount);
  for (const distancePx of [4, 8, 12, 16, 20]) {
    await panel.dragPadding(distancePx, {}, 'continue');
  }
  await panel.settled('the drags made while the tag is held');
  assert.equal(blockCalls(panel.calls).length, 1, `one tag asked for while it saves: ${kinds(panel.calls)}`);
  panel.releaseBlock();
  await panel.settled('the panel quiet after the tag saved');
  assert.equal(blockCalls(panel.calls).length, 1, `exactly one tag: ${kinds(panel.calls)}`);
  assert.equal(styleTags(panel).length, 1);
  const inner = styleTags(panel)[0].inner;
  assert.equal(inner.match(/\.my-class/g).length, 1, `one rule: ${inner}`);
  assert.equal(inner.match(/padding-top/g).length, 1, `one declaration: ${inner}`);
  assert.equal(kinds(panel.calls).filter((kind) => kind === 'writeStyleFile').length, 0, 'the stylesheet is left alone');
});

// Commits as fast as the Opacity field takes them, and the values it took. Once the panel draws
// the save in progress it disables its fields, so how many land before that depends on the
// machine: all five on a fast one, two on a loaded one (reproduced locally with 20 CPU burners).
// No person can commit into a disabled field, so the test does not either.
async function commitWhileTheFieldTakesThem(panel, values) {
  const field = () => [...panel.container.querySelectorAll('input')].find((candidate) => candidate.getAttribute('aria-label') === 'Opacity');
  const taken = [];
  for (const value of values) {
    await panel.draftOpacity(value);
    if (field().disabled) {
      break;
    }
    panel.commitOpacity();
    taken.push(value);
  }
  return taken;
}

test('commits made while the first tag is saving: the last value wins', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '', holdBlock: true });
  context.after(panel.unmount);
  const taken = await commitWhileTheFieldTakesThem(panel, ['0.1', '0.2', '0.3', '0.4', '0.5']);
  assert.ok(taken.length >= 1, 'the first commit is taken');
  panel.releaseBlock();
  await lastOpacityLands(panel, taken.at(-1));
  assert.equal(blockCalls(panel.calls).length, 1, `exactly one tag: ${kinds(panel.calls)}`);
  const inner = styleTags(panel)[0].inner;
  assert.equal(inner.match(/\.my-class/g).length, 1, `one rule: ${inner}`);
  assert.equal(inner.match(/opacity/g).length, 1, `one declaration: ${inner}`);
  assert.equal(kinds(panel.calls).filter((kind) => kind === 'writeStyleFile').length, 0, 'the stylesheet is left alone');
});

test('a commit made as the first tag lands is not overwritten by an older one that waited for it', async (context) => {
  // Check on 20293df9 (Windows) left 0.4 on the page after 0.5 was typed: the scan had shown the
  // new tag, so 0.5 went straight into its rule, and then the lane drained the 0.4 that had waited
  // for the tag, over it. The commit here is made at that moment, found by watching the panel: the
  // source picker names the tag (the scan shows it) before the lane has let go.
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '', holdBlock: true });
  context.after(panel.unmount);
  const taken = await commitWhileTheFieldTakesThem(panel, ['0.1', '0.2', '0.3', '0.4']);
  assert.ok(taken.length >= 1, 'the first commit is taken');
  const pickerText = () => panel.container.querySelector('.embed-editor_source-picker').textContent;
  const field = () => [...panel.container.querySelectorAll('input')].find((candidate) => candidate.getAttribute('aria-label') === 'Opacity');
  assert.match(pickerText(), /Create <style>/, 'the tag is still being saved');
  // 0.5 is typed while the tag saves when the field still takes typing (a fast machine), so the
  // commit can follow in the same task the scan shows the tag in; otherwise once it is enabled again.
  const draftedEarly = field().disabled === false;
  if (draftedEarly) {
    await panel.draftOpacity('0.5');
  }
  panel.releaseBlock();
  // Task by task (not 50 ms polls): the moment lasts a few tasks on a fast machine. It begins when
  // the scan shows the tag and the field takes commits again.
  for (let task = 0; task < 2000 && (/Create <style>/.test(pickerText()) || field().disabled); task += 1) {
    await nextTask();
  }
  assert.doesNotMatch(pickerText(), /Create <style>/, `the scan shows the tag: ${pickerText()}`);
  if (!draftedEarly) {
    await panel.draftOpacity('0.5');
  }
  panel.commitOpacity();
  await lastOpacityLands(panel, '0.5');
  assert.equal(blockCalls(panel.calls).length, 1, `exactly one tag: ${kinds(panel.calls)}`);
  assert.equal(styleTags(panel)[0].inner.match(/opacity/g).length, 1, `one declaration: ${styleTags(panel)[0].inner}`);
});

test('two properties interleaved during the first save share one tag and one rule', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '', holdBlock: true });
  context.after(panel.unmount);
  await panel.dragPadding(10, {}, 'continue');
  await panel.typeOpacity('0.5', 'continue');
  await panel.dragPadding(30, { altKey: true }, 'continue');
  panel.releaseBlock();
  await lastOpacityLands(panel, '0.5');
  assert.equal(blockCalls(panel.calls).length, 1, `exactly one tag: ${kinds(panel.calls)}`);
  assert.equal(kinds(panel.calls).filter((kind) => kind === 'writeStyleFile').length, 0, `the stylesheet is left alone: ${kinds(panel.calls)}`);
  const inner = styleTags(panel)[0].inner;
  assert.equal(inner.match(/\.my-class/g).length, 1, `one rule: ${inner}`);
  assert.match(inner, /padding-(top|block)/, inner);
});

test('with the template on, the first tag holds the wrapper once and later commits stay inside it', async (context) => {
  const styles = { version: 1, keep: [], newStyleTag: { version: 1, isGlobal: true, content: '@layer components {}' } };
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '', styles, holdBlock: true });
  context.after(panel.unmount);
  await panel.dragPadding(12, { shiftKey: true }, 'continue');
  await panel.typeOpacity('0.5', 'continue');
  panel.releaseBlock();
  await lastOpacityLands(panel, '0.5');
  assert.equal(blockCalls(panel.calls).length, 1, `exactly one tag: ${kinds(panel.calls)}`);
  assert.deepEqual(panel.calls[0][1].attributes, [{ name: 'is:global', value: undefined }]);
  const inner = styleTags(panel)[0].inner;
  assert.equal(inner.match(/@layer components/g).length, 1, `one wrapper: ${inner}`);
  assert.equal(inner.match(/\.my-class/g).length, 1, `one rule: ${inner}`);
  assert.match(inner, /@layer components \{[\s\S]*\.my-class \{[\s\S]*padding: [\d.]+rem;[\s\S]*opacity: 0\.5;[\s\S]*\}\s*\}/, inner);
});

test('a refused first tag leaves nothing queued behind it: the next commit tries again, once', async (context) => {
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '', refuse: 'the edit could not be queued' });
  context.after(panel.unmount);
  await panel.dragPadding(10, { shiftKey: true });
  assert.equal(blockCalls(panel.calls).length, 1, 'four sides, one attempt');
  assert.match(panel.errorText(), /the edit could not be queued/);
  await panel.dragPadding(12);
  assert.equal(blockCalls(panel.calls).length, 2, 'a later commit is a new attempt');
  assert.equal(styleTags(panel).length, 0);
});

// The source picker's list, once it is open: its rows are drawn.
const pickerListOpen = (what) => waitFor({ what, read: () => document.querySelectorAll('[role="option"]').length, until: (count) => count > 0 });

test('the "Add custom styles in" list ends with a link to the style tag defaults, only where the host has them', async (context) => {
  const opened = [];
  const panel = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '', openStyleTagSettings: () => opened.push('styles') });
  context.after(panel.unmount);
  const trigger = panel.container.querySelector('.embed-editor_source-picker button');
  assert.ok(trigger, 'the source picker is drawn');
  trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const link = await waitFor({
    what: 'the "Style tag defaults…" footer row',
    read: () =>
      [...document.querySelectorAll('.u-select-footer [role="option"], .u-select-footer *')].find((element) => element.textContent === 'Style tag defaults…'),
    until: (element) => element !== undefined,
  });
  link.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor({ what: 'the settings opened', read: () => opened.length, until: (count) => count > 0 });
  await panel.settled('the panel quiet after the link');
  assert.deepEqual(opened, ['styles'], 'it opens the settings');
  assert.match(panel.container.querySelector('.embed-editor_source-picker').textContent, /Create <style>/, 'the source pick is unchanged');
  assert.deepEqual(panel.calls, [], 'nothing is written');
  panel.unmount();

  const studio = await mountPanel({ nodes: [div('n1', 'my-class')], files: [STYLESHEET], disk: '' });
  context.after(studio.unmount);
  studio.container.querySelector('.embed-editor_source-picker button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await pickerListOpen('the source list open, without settings to link to');
  assert.ok(
    ![...document.querySelectorAll('.u-select-footer *')].some((element) => element.textContent === 'Style tag defaults…'),
    'no link without settings to open',
  );
});

test('a version 2 setting with its own attributes gives the new tag exactly those, and a scoped one stays scoped', async (context) => {
  const styles = { version: 1, keep: [], newStyleTag: { version: 2, attributes: 'lang="scss" media="screen"', content: '' } };
  const panel = await mountPanel({ nodes: [div('n1', 'fresh')], files: [STYLESHEET], disk: '', styles });
  context.after(panel.unmount);
  await panel.typeOpacity('0.5');
  assert.deepEqual(panel.calls[0][1].attributes, [
    { name: 'lang', value: 'scss' },
    { name: 'media', value: 'screen' },
  ]);
  panel.unmount();
  const scoped = await mountPanel({
    nodes: [div('n1', 'fresh')],
    files: [STYLESHEET],
    disk: '',
    styles: { version: 1, keep: [], newStyleTag: { version: 1, isGlobal: false } },
  });
  context.after(scoped.unmount);
  await scoped.typeOpacity('0.5');
  assert.deepEqual(scoped.calls[0][1].attributes, [], 'an explicit version 1 choice of a plain <style> is kept');
});
