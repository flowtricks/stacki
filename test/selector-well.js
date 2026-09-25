// The selector well while it is still filling.
//
//   node test/selector-well.js
//
// The well is a black box that holds one chip per selector styling the element.
// Empty, it says "nothing styles this" — and it is empty for the same seconds the
// scan takes, so the panel confidently gave the wrong answer and then quietly
// changed it. These check that the wait shows as a wait: a spinner while the scan
// is running and there is nothing to show yet, and nothing extra once there is
// (or once the scan is done and the answer really is none). It also verifies
// that component-authored selector provenance reaches the chip's visual class.
//
// In two halves, because the first version of this only had the first one and the
// spinner still never appeared in the app: the well rendered it correctly, and was
// never told to. So the second half mounts the whole panel over a stylesheet read
// that answers late, and watches the well fill.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);}
};

const channelLuminance = (value) => {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
};
const colorLuminance = (hex) => {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16));
  if (!channels || channels.length !== 3) {return null;}
  return (
    0.2126 * channelLuminance(channels[0]) +
    0.7152 * channelLuminance(channels[1]) +
    0.0722 * channelLuminance(channels[2])
  );
};
const contrastRatio = (first, second) => {
  const firstLuminance = colorLuminance(first);
  const secondLuminance = colorLuminance(second);
  if (firstLuminance == null || secondLuminance == null) {return null;}
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'selector-well.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { SelectorPicker } from './EmbedEditor'
        export { listMatchedSelectors } from './lib/resolved'
        export { selectorDependsOnAncestor } from './lib/selectors'
      `,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
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
  global.window = dom.window;
  global.Window = dom.window.Window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
    toJSON: () => ({}),
  });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const {
    SelectorPicker,
    listMatchedSelectors,
    selectorDependsOnAncestor,
  } = require(bundlePath);

  const CHIPS = [
    { key: 'a', text: 'html.theme-dark', fromComponent: true },
    { key: 'b', text: '.theme-dark', fromComponent: false },
  ];
  const reactRoot = createRoot(document.getElementById('root'));
  const show = async (props) =>
    act(async () => {
      reactRoot.render(
        React.createElement(SelectorPicker, {
          selectors: [],
          suggestions: [],
          activeSelector: '',
          activePicked: false,
          busy: false,
          loading: false,
          onSelect: () => {},
          onDeselect: () => {},
          onAdd: () => {},
          ...props,
        })
      );
    });
  const spinner = () => document.querySelector('.embed-editor_selector-loading');
  const chips = () => document.querySelectorAll('.embed-editor_selector-chip').length;

  await show({ loading: true });
  check('an empty well says it is still counting', spinner() != null);
  check('and says so in words, for a screen reader', /finding/i.test(spinner()?.textContent || ''), spinner()?.textContent);
  check('with no chips beside it', chips() === 0, `${chips()} chips`);

  await show({ loading: true, selectors: CHIPS });
  check('chips that have arrived show without a spinner', spinner() == null && chips() === 2, `${chips()} chips`);

  await show({ loading: false, selectors: [] });
  check('a finished scan with no selectors shows an empty well', spinner() == null && chips() === 0);

  await show({ loading: false, selectors: CHIPS });
  check('and a finished one with selectors shows them', spinner() == null && chips() === 2, `${chips()} chips`);
  const renderedChips = [...document.querySelectorAll('.embed-editor_selector-chip')];
  check(
    'a component selector receives the green component class',
    renderedChips[0]?.classList.contains('is-component') === true,
    renderedChips[0]?.className
  );
  check(
    'a non-component selector keeps the standard class treatment',
    renderedChips[1]?.classList.contains('is-component') === false,
    renderedChips[1]?.className
  );
  check(
    'component provenance is included in the accessible name',
    renderedChips[0]?.getAttribute('aria-label') ===
      'html.theme-dark, component selector',
    renderedChips[0]?.getAttribute('aria-label')
  );
  check(
    'an inactive selector exposes its unpressed state',
    renderedChips[0]?.getAttribute('aria-pressed') === 'false'
  );
  await show({ loading: false, selectors: CHIPS, activeSelector: 'html.theme-dark' });
  check(
    'the selected selector exposes its pressed state',
    document.querySelector('.embed-editor_selector-chip')?.getAttribute('aria-pressed') === 'true'
  );
  let defaultDeselections = 0;
  let defaultSelections = 0;
  await show({
    loading: false,
    selectors: CHIPS,
    activeSelector: 'html.theme-dark',
    onDeselect: () => {defaultDeselections += 1;},
    onSelect: () => {defaultSelections += 1;},
  });
  await act(async () => document.querySelector('.embed-editor_selector-chip')?.click());
  check(
    'the initially active selector deselects on its first click',
    defaultDeselections === 1 && defaultSelections === 0,
    `${defaultDeselections} deselections, ${defaultSelections} selections`
  );

  check(
    'an ancestor selector is classified as inherited',
    selectorDependsOnAncestor('.layout > .heading') === true
  );
  check(
    'a sibling condition inside :has does not become inherited',
    selectorDependsOnAncestor('.heading:has(+ .text)') === false
  );
  check(
    'a sibling selector is not described as a parent relationship',
    selectorDependsOnAncestor('.eyebrow + .heading') === false
  );

  const CATEGORY_CHIPS = [
    { key: 'direct', text: '.heading:has(+ .text)', fromComponent: true },
    { key: 'tag', text: 'h1', fromComponent: false },
    { key: 'state', text: ':focus-visible', fromComponent: false },
    { key: 'parent', text: '.hero .heading', fromComponent: true },
  ];
  let visibleSelectors = [];
  await show({
    loading: false,
    selectors: CATEGORY_CHIPS,
    onVisibleSelectorsChange: (selectors) => {visibleSelectors = [...selectors];},
  });
  check('global selectors are hidden initially', chips() === 1, `${chips()} chips`);
  check(
    'the picker reports only selectors visible with both filters closed',
    visibleSelectors.join('|') === '.heading:has(+ .text)',
    visibleSelectors.join('|')
  );
  const filterLabel = (name) =>
    [...document.querySelectorAll('.embed-editor_selector-filter')]
      .find((label) => label.textContent.includes(name));
  check(
    'tag and broad-state selectors are counted as global',
    filterLabel('global')?.textContent.includes('(2)') === true,
    filterLabel('global')?.textContent
  );
  check(
    'parent-qualified selectors are counted as inherited',
    filterLabel('inherited')?.textContent.includes('(1)') === true,
    filterLabel('inherited')?.textContent
  );

  await act(async () => filterLabel('global')?.querySelector('input')?.click());
  const globalChips = [...document.querySelectorAll('.embed-editor_selector-chip')];
  check('revealing globals adds both grey chips', globalChips.length === 3);
  check(
    'the visible-selector report follows the global checkbox',
    visibleSelectors.includes('h1') && visibleSelectors.includes(':focus-visible'),
    visibleSelectors.join('|')
  );
  check(
    'a tag selector receives the global grey class',
    globalChips.find((chip) => chip.textContent === 'h1')?.classList.contains('is-global') === true
  );
  check(
    'a global selector is named for assistive technology',
    globalChips.find((chip) => chip.textContent === 'h1')?.getAttribute('aria-label') ===
      'h1, global selector'
  );

  await act(async () => filterLabel('global')?.querySelector('input')?.click());
  await act(async () => filterLabel('inherited')?.querySelector('input')?.click());
  const inheritedChip = [...document.querySelectorAll('.embed-editor_selector-chip')]
    .find((chip) => chip.textContent === '.hero .heading');
  check(
    'an ancestor-qualified selector receives the inherited grey class',
    inheritedChip?.classList.contains('is-inherited') === true,
    inheritedChip?.className
  );
  check(
    'grey category naming preserves component provenance',
    inheritedChip?.getAttribute('aria-label') ===
      '.hero .heading, inherited and component selector',
    inheritedChip?.getAttribute('aria-label')
  );

  // The same selector may be authored globally and inside a component. The chip is
  // deduplicated, but it remains component-colored if any matching source is one.
  const matchedRule = (text, fromComponent, order) => ({
    rule: {
      declarations: [{ prop: 'color' }],
      selectorText: text,
      atContext: [],
      fromComponent,
    },
    matchedSelectors: [{ text, specificity: [0, 1, 0], pseudoElement: null }],
    order,
  });
  const listed = listMatchedSelectors(
    {
      base: [
        matchedRule('.shared', false, 0),
        matchedRule('.shared', true, 1),
        matchedRule('.global', false, 2),
      ],
      conditional: [],
    },
    ''
  );
  check(
    'component provenance survives selector deduplication',
    listed.find((selector) => selector.text === '.shared')?.fromComponent === true
  );
  check(
    'ordinary stylesheet provenance remains ordinary',
    listed.find((selector) => selector.text === '.global')?.fromComponent === false
  );

  // A global selector (`:target`, `*`) is folded away unless asked for — the well
  // then has nothing in it, and the scan is over, so it must not spin forever.
  await show({ loading: false, selectors: [{ key: 'g', text: ':focus-visible' }] });
  check('a folded-away global leaves the well quiet', spinner() == null && chips() === 0, `${chips()} chips`);

  // --- the whole panel, from a cold open ------------------------------------
  //
  // What the panel does on a real open, in order: it mounts and scans before the
  // project's stylesheet list has been fetched, reads nothing, matches nothing,
  // and calls itself ready. The list lands a moment later. Until this, the well
  // stayed empty and silent through all of it — the panel only noticed the files
  // on its next background refresh, throttled to 4s, which is exactly how long a
  // layout's well sat blank while the CSS that styles it was there on disk.
  const panelBundle = path.join(buildDir, 'panel-mount.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as EmbedEditor } from './EmbedEditor'
        export { setHost } from './lib/host'
        export { setCanvasFrame } from '../canvasQuery.js'
        export { EditorView } from '@codemirror/view'
      `,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'tsx',
    },
    outfile: panelBundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const READ_MS = 250;
  const SHEET = { rel: 'src/styles/main.css', name: 'main.css', path: '/p/src/styles/main.css', size: 10 };
  let styleWriteCount = 0;
  let writtenCss = '';
  dom.window.avb = {
    listStyleFiles: async () => ({ files: [] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: () =>
      new Promise((r) => dom.window.setTimeout(() => r({
        css: 'section { margin: 0 } div { display: block } .card { color: red }',
      }), READ_MS)),
    writeStyleFile: async ({ css }) => {styleWriteCount += 1; writtenCss = css;},
  };

  const { EditorView, EmbedEditor, setHost, setCanvasFrame } = require(panelBundle);
  // A classless element, so the well holds only what the stylesheets earn — an
  // element's own class gets a chip either way, which would hide the empty case.
  const NODES = [
    { id: 'n1', kind: 'element', name: 'section', props: {} },
    { id: 'n2', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'card' } } },
  ];
  setHost({
    projectPath: '/p',
    nodes: NODES,
    selectedId: 'n1',
    files: [], // not listed yet — the fetch is still in flight
    astroFiles: [],
    renderedClasses: [],
    pathOf: () => '0.1',
  });

  const panel = document.createElement('div');
  document.body.appendChild(panel);
  // No act(): the panel is deliberately watched mid-flight, which is the one
  // state act() exists to skip past.
  global.IS_REACT_ACT_ENVIRONMENT = false;
  const panelRoot = createRoot(panel);
  panelRoot.render(React.createElement(EmbedEditor));
  const wait = (ms) => new Promise((r) => dom.window.setTimeout(r, ms));
  const panelChips = () => [...panel.querySelectorAll('.embed-editor_selector-chip')];
  const panelSpinner = () => panel.querySelector('.embed-editor_selector-loading');

  await wait(200);
  check('the panel mounts', panel.querySelector('.embed-editor_selector-well') != null);
  const cssCodeToggle = () => panel.querySelector('.embed-editor_css-code-toggle');
  check(
    'the CSS Code section starts closed',
    cssCodeToggle()?.getAttribute('aria-expanded') === 'false'
  );
  check('a project with no stylesheets to read settles empty', panelChips().length === 0, `${panelChips().length} chips`);
  check('and does not pretend to be waiting', panelSpinner() == null);

  // The list arrives, after the panel already called itself ready.
  setHost({ files: [SHEET] });
  await wait(60);
  check('the well waits on stylesheets it has just been offered', panelSpinner() != null);
  check('with nothing in it yet', panelChips().length === 0, `${panelChips().length} chips`);

  await wait(READ_MS + 400); // still far inside the 4s refresh throttle it used to wait out
  check(
    'the global rule is counted after the stylesheet lands',
    panel.querySelector('.embed-editor_selector-filter')?.textContent.includes('(1)') === true
  );
  check('the global rule stays folded initially', panelChips().length === 0);
  check('and the spinner goes with the completed scan', panelSpinner() == null);

  panel.querySelector('.embed-editor_selector-filter input')?.click();
  await wait(30);
  check(
    'revealing globals shows the stylesheet selector',
    panelChips()[0]?.textContent === 'section',
    panelChips()[0]?.textContent
  );
  panelChips()[0]?.click();
  await wait(30);
  panelChips()[0]?.click();
  await wait(30);
  check(
    'a picked selector names the file its CSS comes from',
    panel.querySelector('.embed-editor_css-code-source')?.textContent === 'src/styles/main.css',
    panel.querySelector('.embed-editor_css-code-source')?.textContent
  );
  cssCodeToggle()?.click();
  await wait(30);
  check(
    'the CSS Code section opens on request',
    cssCodeToggle()?.getAttribute('aria-expanded') === 'true'
  );
  panel.querySelector('.embed-editor_css-code-source')?.click();
  await wait(30);
  check(
    'clicking the filename closes the whole CSS Code disclosure',
    cssCodeToggle()?.getAttribute('aria-expanded') === 'false'
  );
  cssCodeToggle()?.click();
  await wait(30);

  // --- and on the next element, with the stylesheets already read -----------
  //
  // The other wait: picking another element re-uses the scanned stylesheets, so
  // nothing is re-read and the panel never re-enters its scanning phase. What it
  // waits on is the canvas answering what the element really renders as. A frame
  // that never answers stands in for a busy one (the ask gives up after ~1.5s).
  setCanvasFrame({ postMessage() {} });
  setHost({ selectedId: 'n2' }); // same nodes — only the selection moves, as in the app
  await wait(120);
  check(
    'the CSS Code disclosure stays open when the element changes',
    cssCodeToggle()?.getAttribute('aria-expanded') === 'true'
  );
  check('picking another element empties the well', panelChips().length === 0, `${panelChips().length} chips`);
  check('and it spins while the canvas is asked', panelSpinner() != null);

  await wait(2000);
  check('the well fills once the answer (or its absence) lands', panelChips().length === 2, panelChips().map((c) => c.textContent).join(','));
  check('and stops spinning', panelSpinner() == null);
  const codeText = () => (
    panel.querySelector('.embed-editor_css-code-editor .cm-content')?.textContent ||
    panel.querySelector('.embed-editor_css-code-preview')?.textContent ||
    ''
  );
  check(
    'the initially selected core class filters the CSS view',
    codeText().includes('.card {') && !codeText().includes('div {'),
    codeText()
  );
  check(
    'the initially selected core class opens an editable CSS box',
    panel.querySelector('.embed-editor_css-code-editor .cm-editor') != null
  );
  panelChips().find((chip) => chip.textContent === '.card')?.click();
  await wait(30);
  check(
    'one click deselects the initially active core class',
    codeText().includes('.card {') && codeText().includes('div {'),
    codeText()
  );
  panelChips().find((chip) => chip.textContent === '.card')?.click();
  await wait(30);
  const editorElement = panel.querySelector('.embed-editor_css-code-editor .cm-editor');
  check('an individually selected selector has an editable CSS box', editorElement != null);
  if (editorElement) {
    const editor = EditorView.findFromDOM(editorElement);
    const nextCss = '.card { color: blue }';
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: nextCss },
      selection: { anchor: nextCss.length },
    });
    await wait(450);
    check(
      'typing in the CSS box automatically writes the selected rule',
      writtenCss.includes('.card { color: blue }')
    );
    const currentEditorElement = panel.querySelector('.embed-editor_css-code-editor .cm-editor');
    check(
      'autosave does not remount the editor or move its caret',
      currentEditorElement === editorElement &&
        editor.state.selection.main.head === editor.state.doc.length,
      `same element: ${currentEditorElement === editorElement}; ` +
        `caret: ${editor.state.selection.main.head}; length: ${editor.state.doc.length}`
    );
    check(
      'the autosaving editor has no manual Save CSS button',
      !panel.textContent.includes('Save CSS')
    );
    check(
      'the style panel refreshes from the edited CSS',
      panel.querySelector('[data-prop="color"]')?.value === 'blue',
      panel.querySelector('[data-prop="color"]')?.value
    );
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: '.card { color:' },
    });
    await wait(700);
    check(
      'an invalid intermediate draft is not written or retried',
      styleWriteCount === 1,
      `${styleWriteCount} stylesheet writes`
    );
  }

  panelChips().find((chip) => chip.textContent === '.card')?.click();
  await wait(30);
  check(
    'deselecting shows code for every currently visible selector',
    codeText().includes('.card {') && codeText().includes('div {'),
    codeText()
  );
  panel.querySelector('.embed-editor_selector-filter input')?.click();
  await wait(30);
  check(
    'hiding global selectors also removes their code',
    codeText().includes('.card {') && !codeText().includes('div {'),
    codeText()
  );

  // --- the well doesn't rearrange itself when the scan lands ------------------
  //
  // Loading and loaded have to occupy the same box: the spinner stands as tall as
  // the chips it stands in for, and the globals checkbox holds its row whether or
  // not there is anything to reveal. Both used to appear/grow on arrival, which
  // moved everything under them just as the panel became usable.
  {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'style-panel', 'embed-editor.css'),
      'utf8'
    );
    const chipHeight = /--embed-editor_chip-h:/.test(css);
    check('a chip row has one stated height', chipHeight);
    const codeBody = css.slice(css.indexOf('.embed-editor_css-code-body {'));
    const codeBodyRule = codeBody.slice(0, codeBody.indexOf('}'));
    check(
      'the CSS box uses the full section width',
      /padding:\s*0 0 var\(--space-4\)/.test(codeBodyRule) &&
        /\.code-editor\.embed-editor_css-code-editor\s*\{[^}]*padding:\s*0;/s.test(css),
      `${codeBodyRule}\n${css.match(/\.code-editor\.embed-editor_css-code-editor\s*\{[^}]*\}/s)?.[0]}`
    );
    const codePreview = css.slice(css.indexOf('.embed-editor_css-code-preview {'));
    const codePreviewRule = codePreview.slice(0, codePreview.indexOf('}'));
    check(
      'the CSS preview has a tight independently scrollable height',
      /max-height: min\(36vh, 360px\)/.test(codePreviewRule) &&
        /overflow-y: auto/.test(codePreviewRule),
      codePreviewRule
    );
    const componentChip = css.slice(css.indexOf('.embed-editor_selector-chip.is-component'));
    check(
      'the component chip class uses the component green tokens',
      /--color-component-tag-bg/.test(componentChip.slice(0, 800)) &&
        /--color-component-tag\)/.test(componentChip.slice(0, 800)),
      componentChip.slice(0, 800)
    );
    check(
      'component hover and selected states use different brightness tokens',
      /--color-component-tag-bg-hover/.test(componentChip.slice(0, 800)) &&
        /--color-component-tag-bg-active/.test(componentChip.slice(0, 800)),
      componentChip.slice(0, 800)
    );
    const tokens = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'style-panel', 'tokens.css'),
      'utf8'
    );
    const activeGreen = tokens.match(/--color-component-tag-bg-active:\s*(#[0-9a-f]{6})/i)?.[1];
    const activeContrast = activeGreen ? contrastRatio('#ffffff', activeGreen) : null;
    check(
      'selected component text meets WCAG AA contrast',
      activeContrast != null && activeContrast >= 4.5,
      activeContrast == null ? String(activeGreen) : `${activeContrast.toFixed(2)}:1`
    );
    const loading = css.slice(css.indexOf('.embed-editor_selector-loading {'));
    check(
      'the spinner row is exactly that tall',
      /min-height: var\(--embed-editor_chip-h\)/.test(loading.slice(0, loading.indexOf('}'))),
      loading.slice(0, loading.indexOf('}'))
    );
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'style-panel', 'EmbedEditor.tsx'),
      'utf8'
    );
    const check_ = src.slice(src.indexOf('embed-editor_selector-filter'));
    check(
      'the globals checkbox is not conditional on having any',
      !/\{globals\.length \? \(/.test(src),
      'it still renders only when there are globals'
    );
    check(
      'it disables itself instead when there are none',
      /disabled=\{busy \|\| !globals\.length\}/.test(check_)
    );
    const contextualChip = css.slice(
      css.indexOf('.embed-editor_selector-chip:is(.is-global, .is-inherited)')
    );
    check(
      'global and inherited chips use the neutral grey ramp',
      /--color-selector-context-bg/.test(contextualChip.slice(0, 1000)) &&
        /--color-selector-context-bg-hover/.test(contextualChip.slice(0, 1000)) &&
        /--color-selector-context-bg-active/.test(contextualChip.slice(0, 1000)),
      contextualChip.slice(0, 1000)
    );
  }

  if (failures.length) {
    console.error(`selector-well: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`selector-well: ${checked} passed  [well markup, cold open, late stylesheets, next element]`);
  // jsdom's timers keep the loop alive.
  process.exit(0);
})();
