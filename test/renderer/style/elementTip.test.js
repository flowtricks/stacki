// The element line's tooltip in the Style panel.
//
//   node test/renderer/style/elementTip.test.js
//
// Goal: the grey line above the selector field (`h2.faq_title.text-style-h1`)
// is one row that a long element cuts off, and it names only `data-*`
// attributes. Resting the pointer on it shows the whole element as chips, the
// tag and id grey, classes blue, attributes purple: the tag, each class, the id,
// then every attribute the author wrote, without
// the `class`/`id` duplicates or the attributes Astro stamps on rendered markup.
//
// Method: the pure part lists case by case (elementParts, elementTipParts),
// then the real ElementTokenPicker mounted in JSDOM with fake timers: nothing
// shows on a passing pointer, the chips show after the app's tooltip delay, and
// leaving hides them.

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
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const texts = (parts) => parts.map((part) => part.text);

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'element-tip.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as ElementTokenPicker, elementParts, elementTipParts } from './src/features/style/ElementTokenPicker'
        export { TOOLTIP_DELAY_MS } from './src/ui/delayedTooltip'
      `,
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
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const bundle = require(bundlePath);
  const { elementParts, elementTipParts, TOOLTIP_DELAY_MS } = bundle;

  // 1. The parts.
  const snapshot = {
    tag: 'h2',
    webflowType: '',
    id: 'faq',
    classes: ['faq_title', 'text-style-h1'],
    classList: ['faq_title', 'text-style-h1'],
    attributes: {
      class: 'faq_title text-style-h1',
      id: 'faq',
      'data-state': 'open',
      'aria-label': 'Questions',
      hidden: '',
      'data-astro-cid-abc123': '',
    },
  };
  check(
    'the line names tag, classes and data attributes',
    same(elementParts(snapshot), ['h2', '.faq_title', '.text-style-h1', '[data-state="open"]']),
    JSON.stringify(elementParts(snapshot)),
  );
  check(
    'the tip names tag, classes, id and every authored attribute',
    same(texts(elementTipParts(snapshot)), ['h2', '.faq_title', '.text-style-h1', '#faq', '[aria-label="Questions"]', '[data-state="open"]', '[hidden]']),
    JSON.stringify(elementTipParts(snapshot)),
  );
  check(
    'each chip says what it names, for its colour',
    same(
      elementTipParts(snapshot).map((part) => part.kind),
      ['tag', 'class', 'class', 'id', 'attribute', 'attribute', 'attribute'],
    ),
  );
  check('the tip leaves out what Astro stamps on the markup', !elementTipParts(snapshot).some((part) => part.text.includes('astro')));
  const bare = { ...snapshot, id: undefined, classes: [], classList: [], attributes: {} };
  check('a bare element is its tag alone', same(elementTipParts(bare), [{ kind: 'tag', text: 'h2' }]));
  check('no element, no parts', same(elementTipParts(undefined), []));
  // A one-letter tag is a whole chip. A length check that wanted two characters
  // threw while rendering a selected <p> or <a> and took the whole window down.
  for (const tag of ['p', 'a', 'b', 'i', 'q', 's', 'u']) {
    const one = { ...bare, tag, attributes: {} };
    let parts;
    let thrown;
    try {
      parts = elementTipParts(one);
    } catch (error) {
      thrown = error;
    }
    check(`a <${tag}> is one chip, without throwing`, thrown === undefined && same(parts, [{ kind: 'tag', text: tag }]), String(thrown));
    check(`and its line is the tag`, same(elementParts(one), [tag]));
  }
  const unnamed = { ...bare, tag: undefined, classes: ['', 'hero'], classList: ['hero'], attributes: { '': '' } };
  check(
    'a nameless class or attribute is left out, not shown or thrown on',
    same(texts(elementTipParts(unnamed)), ['.hero']),
    JSON.stringify(elementTipParts(unnamed)),
  );

  // 2. The mounted line.
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const timers = [];
  global.setTimeout = (run, delayMs) => {
    timers.push({ run, delayMs });
    return timers.length;
  };
  global.clearTimeout = (id) => {
    if (id !== undefined && timers[id - 1]) {
      timers[id - 1].run = () => {};
    }
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(bundle.ElementTokenPicker, { snapshot }));
  });
  const line = document.querySelector('.embed-editor_element-id');
  check('the line shows the selector', line?.textContent === 'h2.faq_title.text-style-h1[data-state="open"]', line?.textContent);
  check('the line has no native title to double the tip', !line?.hasAttribute('title'));
  line.getBoundingClientRect = () => ({ left: 20, right: 300, top: 100, bottom: 118, width: 280, height: 18 });
  const tip = () => document.querySelector('.embed-editor_element-tip');
  await act(async () => {
    line.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  });
  check('a pointer arriving shows nothing yet', tip() === null);
  check('the tip waits the app tooltip delay', timers.at(-1)?.delayMs === TOOLTIP_DELAY_MS, JSON.stringify(timers.at(-1)?.delayMs));
  await act(async () => {
    timers.at(-1).run();
  });
  const chips = [...document.querySelectorAll('.embed-editor_element-tip-chip')].map((chip) => chip.textContent);
  check('after the delay every part is a chip', same(chips, texts(elementTipParts(snapshot))), JSON.stringify(chips));
  const kinds = [...document.querySelectorAll('.embed-editor_element-tip-chip')].map((chip) => chip.className.replace('embed-editor_element-tip-chip ', ''));
  check(
    'the tag is grey, classes blue, attributes purple (by kind class)',
    same(kinds, ['is-tag', 'is-class', 'is-class', 'is-id', 'is-attribute', 'is-attribute', 'is-attribute']),
    JSON.stringify(kinds),
  );
  const css = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
  check('the class chips are the class blue', /\.embed-editor_element-tip-chip\.is-class \{[^}]*var\(--color-class-tag-bg\)/.test(css));
  check('the attribute chips are the connected purple', /\.embed-editor_element-tip-chip\.is-attribute \{[^}]*#453b63/.test(css));
  check('the tip is not the black of the field it opens over', /\.embed-editor_element-tip \{[^}]*var\(--color-bg-surface-raised\)/.test(css));
  check(
    'the tip is under the line, from its left edge',
    tip()?.style.left === '20px' && tip()?.style.top === '124px',
    `${tip()?.style.left} ${tip()?.style.top}`,
  );
  check('the tip is no wider than the line', tip()?.style.maxWidth === '280px', tip()?.style.maxWidth);
  check('the tip is drawn outside the panel, so nothing clips it', tip()?.parentElement === document.body);
  await act(async () => {
    line.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
  check('leaving the line hides the tip', tip() === null);
  await act(async () => {
    root.render(React.createElement(bundle.ElementTokenPicker, { snapshot: { ...bare, tag: 'p', attributes: {} } }));
  });
  check('a selected <p> renders its line', document.querySelector('.embed-editor_element-id')?.textContent === 'p');
  await act(async () => root.unmount());

  if (failures.length) {
    console.error(`elementTip: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`elementTip: ${checked} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
