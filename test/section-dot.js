// A section header says what is inside it.
//
//   node test/section-dot.js
//
// The panel groups properties into collapsible sections, and collapsed, a
// section is a label and a chevron — one holding three properties looked exactly
// like an empty one, so the only way to find out was to open each in turn. Worst
// for the section that starts collapsed (Flex/Grid Child).
//
// So a section with anything in it carries a dot at its right edge, in the two
// colours the property labels inside already use:
//
//   orange — something styles this element from another selector
//   blue   — the selector you have picked is one of the things setting it
//
// The distinction is the part that can be quietly wrong. Blue everywhere would
// claim your selector sets things it doesn't; orange everywhere would never tell
// you where your own work is. Both look like a working feature.
//
// Mounted over the whole panel rather than the header alone, because the header
// renders the dot correctly whether or not anything ever tells it to.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = false;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;

  const React = require('react');
  const { createRoot } = require('react-dom/client');

  const bundle = path.join(buildDir, 'section-dot.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as EmbedEditor } from './EmbedEditor'
        export { setHost } from './lib/host'
      `,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'tsx',
    },
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  // `.card` sets a Flex/Grid Child property itself. `.plain` sets none — but the
  // bare `div` rule sets one that reaches it anyway, which is the orange case.
  const CSS = `
    div { align-self: center }
    .card { order: 3 }
    .plain { color: red }
  `;
  const SHEET = { rel: 'src/styles/main.css', name: 'main.css', path: '/p/src/styles/main.css', size: 10 };
  dom.window.avb = {
    listStyleFiles: async () => ({ files: [SHEET] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => ({ css: CSS }),
  };

  const { EmbedEditor, setHost } = require(bundle);
  const NODES = [
    { id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'card' } } },
    { id: 'n2', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'plain' } } },
  ];

  const panel = document.createElement('div');
  document.body.appendChild(panel);
  const root = createRoot(panel);
  const wait = (ms) => new Promise((r) => dom.window.setTimeout(r, ms));

  const select = async (id) => {
    setHost({ projectPath: '/p', nodes: NODES, selectedId: id, files: [SHEET], astroFiles: [], renderedClasses: [], pathOf: () => '0.1' });
    root.render(React.createElement(EmbedEditor));
    await wait(400);
  };

  // The section by its title, and whether its header carries the dot.
  const sectionNamed = (label) =>
    [...panel.querySelectorAll('.embed-editor_section-block')].find(
      (b) => b.querySelector('.embed-editor_section-title')?.textContent?.trim() === label
    );
  const dotOn = (label) => !!sectionNamed(label)?.querySelector('.embed-editor_section-dot');
  const collapsed = (label) => !!sectionNamed(label)?.classList.contains('is-collapsed');

  const dotOf = (label) => {
    const dot = sectionNamed(label)?.querySelector('.embed-editor_section-dot');
    if (!dot) return 'none';
    return dot.classList.contains('is-own') ? 'blue' : 'orange';
  };

  await select('n1');
  check('the panel mounts with its sections', !!sectionNamed('Flex/Grid Child'), [...panel.querySelectorAll('.embed-editor_section-title')].map((t) => t.textContent).join(' | '));
  check('and Flex/Grid Child starts collapsed', collapsed('Flex/Grid Child'), 'it is open, so the collapsed case is not being tested');

  // `.card { order: 3 }` — the picked selector is one of the things styling this
  // section, so the dot is blue.
  check('a section your own selector styles is blue', dotOf('Flex/Grid Child') === 'blue', dotOf('Flex/Grid Child'));

  // Open, the property labels inside say the same thing in the same colours, so
  // the dot stands down.
  const toggle = sectionNamed('Flex/Grid Child').querySelector('.embed-editor_section-toggle');
  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  check('and the section really opens', !collapsed('Flex/Grid Child'));
  check('opening it puts the dot away', dotOf('Flex/Grid Child') === 'none', dotOf('Flex/Grid Child'));
  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  check('closing it brings the dot back', dotOf('Flex/Grid Child') === 'blue', dotOf('Flex/Grid Child'));

  // It sits at the right edge, beside the chevron — not next to the label.
  const header = sectionNamed('Flex/Grid Child').querySelector('.embed-editor_section-header');
  const kids = [...header.children];
  const dotAt = kids.findIndex((el) => el.classList.contains('embed-editor_section-dot'));
  const chevronAt = kids.findIndex((el) => el.classList.contains('embed-editor_section-chevron-btn'));
  const titleAt = kids.findIndex((el) => el.classList.contains('embed-editor_section-toggle'));
  check('the dot sits after the label', dotAt > titleAt, `dot ${dotAt}, label ${titleAt}`);
  check('and immediately before the chevron', chevronAt === dotAt + 1, `dot ${dotAt}, chevron ${chevronAt}`);

  // `.plain` sets nothing in this section, but the bare `div` rule sets
  // `align-self`, which reaches the element from another selector.
  await select('n2');
  check('a section styled only from elsewhere is orange', dotOf('Flex/Grid Child') === 'orange', dotOf('Flex/Grid Child'));
  // …and it really is reaching the element, or the case above proves nothing.
  const openIt = sectionNamed('Flex/Grid Child').querySelector('.embed-editor_section-toggle');
  openIt.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  const body = sectionNamed('Flex/Grid Child')?.textContent ?? '';
  check('because the section is not empty for it', body.length > 'Flex/Grid Child'.length, body.slice(0, 120));
  openIt.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(120);

  // A section nothing reaches at all carries no dot — otherwise every header has
  // one and the dot stops meaning anything.
  // Named explicitly, and checked to EXIST first: `dotOf` reports 'none' for a
  // section that isn't rendered, so without this the case passes by absence.
  const empties = ['Backgrounds', 'Effects', 'Borders'];
  check('the empty sections are on screen to be checked', empties.every((l) => !!sectionNamed(l)),
    [...panel.querySelectorAll('.embed-editor_section-title')].map((t) => t.textContent.trim()).join(' | '));
  const bare = empties.map((l) => [l, dotOf(l)]).filter(([, d]) => d !== 'none');
  check('a section nothing styles has no dot', bare.length === 0, JSON.stringify(bare));

  root.unmount();
  panel.remove();

  if (failures.length) {
    console.error(`section-dot: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`section-dot: ${checked} passed  [orange vs blue, right edge, closed only]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
