// The picker groups variables the way the Variables panel does.
//
//   node test/renderer/style/variablePickerGroups.test.js
//
// Goal: for names mirroring the panel's screenshot, the picker draws the same section headings,
// the same short names, in the panel's order; ungrouped names come first without a heading;
// headings are not options; search finds group plus name and hides empty sections; the keyboard
// walks the rows across sections; the applied variable keeps its section.
// Method: the real picker is mounted in jsdom and read back from the DOM; the expected grouping is
// computed by calling the shared function the panel uses (dist/shared/properties/variableGroups.js).
// Keys and events are dispatched; no pointer is needed.

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const NAMES = [
  'background',
  'background-2',
  'text',
  'text-2',
  'selection-background',
  'selection-text',
  'button-background',
  'button-border',
  'button-text',
  'button-2-background',
  'button-2-border',
  'button-2-text',
  'link-text',
  'link-border',
];

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'variable-picker-groups.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/VariablePicker.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stub-webflow', {
        'src/features/style/model/webflow.ts': () => ({ contents: 'export const streamProjectVariables = async () => [];', loader: 'js' }),
      }),
    ],
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.Element.prototype.scrollIntoView = () => {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { VariablePicker } = require(bundlePath);
  const { arrangeNames, shortLabel } = require(repoPath('dist/shared/properties/variableGroups.js'));

  const variables = NAMES.map((name) => ({
    name,
    value: '#123456',
    type: 'Color',
    collection: 'src/styles/base.css',
    group: ':root',
    binding: `var(--${name})`,
  }));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root = createRoot(host);
  const render = async (extra = {}) => {
    await act(async () => {
      root.render(React.createElement(VariablePicker, { anchor, vars: variables, loading: false, prop: '--anything', onPick() {}, onClose() {}, ...extra }));
    });
    await settle();
  };
  // What the picker draws: [heading or undefined, short names].
  const drawn = () => {
    const out = [];
    for (const section of document.querySelectorAll('.embed-editor_varpicker-family')) {
      const title = section.getAttribute('aria-label');
      // The ungrouped names are a card like the others, headed "Other".
      out.push([title === 'Other' ? undefined : title, [...section.querySelectorAll('.embed-editor_varpicker-item-name')].map((node) => node.textContent)]);
    }
    return out;
  };
  // The panel's blocks. A group is a group when two or more of its names are OFFERED (every name here);
  // a search only narrows the rows shown, so a group down to one row keeps its heading and short name.
  const expected = (shown, offered = NAMES) => {
    const offeredBlocks = arrangeNames(
      NAMES.map((name) => `--${name}`),
      new Set(offered.map((name) => `--${name}`)),
    );
    const groupSize = new Map(offeredBlocks.filter((block) => block.title !== undefined).map((block) => [block.title, block.names.length]));
    const blocks = arrangeNames(
      NAMES.map((name) => `--${name}`),
      new Set(shown.map((name) => `--${name}`)),
    );
    const flat = [];
    const groups = [];
    for (const block of blocks) {
      if (block.title === undefined || (groupSize.get(block.title) ?? 0) < 2) {
        flat.push(...block.names.map((name) => shortLabel(name)));
      } else {
        groups.push([block.title, block.names.map((name) => shortLabel(name, block.title))]);
      }
    }
    return [...(flat.length > 0 ? [[undefined, flat]] : []), ...groups];
  };
  const same = (label, actual, wanted) =>
    check(label, JSON.stringify(actual) === JSON.stringify(wanted), `${JSON.stringify(actual)} !== ${JSON.stringify(wanted)}`);

  await render();
  same('headings and short names equal the panel grouping', drawn(), expected(NAMES));
  same(
    'sections are selection, button, button-2, link, after the ungrouped run',
    drawn().map((entry) => entry[0]),
    [undefined, 'selection', 'button', 'button-2', 'link'],
  );
  const headings = [...document.querySelectorAll('.embed-editor_varpicker-family-name')];
  check(
    'headings are hidden from assistive technology as options',
    headings.length === 5 && headings.every((node) => node.getAttribute('aria-hidden') === 'true'),
  );
  check('the sections are labelled groups', [...document.querySelectorAll('[role="group"]')].length === 5);
  check('headings are not rows', document.querySelectorAll('.embed-editor_varpicker-item').length === NAMES.length);
  const row = document.querySelector('[data-binding="var(--button-text)"]');
  check('a row under a heading still names the full variable', row?.getAttribute('aria-label') === '--button-text: #123456', row?.getAttribute('aria-label'));
  check('and shows the short name', row?.querySelector('.embed-editor_varpicker-item-name')?.textContent === 'text');

  // Search: group plus name, grouped, empty sections hidden.
  const search = document.querySelector('.embed-editor_varpicker-search');
  const type = async (value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(search, value);
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await settle();
  };
  await type('button background');
  same('"button background" finds the group and the name; each group stays a group with one short row', drawn(), [
    ['button', ['background']],
    ['button-2', ['background']],
  ]);
  same('and equals the panel grouping', drawn(), expected(['button-background', 'button-2-background']));
  await type('button');
  same('two or more rows keep their groups', drawn(), expected(NAMES.filter((name) => name.startsWith('button'))));
  check(
    'a heading is just the group name (or Other for the ungrouped card)',
    [...document.querySelectorAll('.embed-editor_varpicker-family')].every(
      (section) => section.querySelector('.embed-editor_varpicker-family-name')?.textContent === section.getAttribute('aria-label'),
    ),
  );
  await type('button-border');
  same('the full name keeps the group too', drawn(), [['button', ['border']]]);
  await type('selection-bac');
  same('a longer search keeps the group heading and the short name (the bug: it used to flatten)', drawn(), [['selection', ['background']]]);
  await type('zzz');
  check('zero matching rows hides the group', document.querySelectorAll('.embed-editor_varpicker-family').length === 0);
  await type('zzz');
  check('nothing matching shows the empty state', !!document.querySelector('.embed-editor_varpicker-empty'));
  await type('');

  // Keyboard across sections: the arrows walk the rows in the drawn order and skip the headings.
  const marked = () => document.querySelector('.embed-editor_varpicker-item.is-selected')?.dataset.binding;
  const key = (name) => act(async () => search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
  const order = [...document.querySelectorAll('.embed-editor_varpicker-item')].map((node) => node.dataset.binding);
  await key('ArrowDown');
  check('ArrowDown marks the first drawn row', marked() === order[0], marked());
  for (let step = 0; step < 4; step += 1) {
    await key('ArrowDown');
  }
  check('and walks on across the heading to the fifth row', marked() === order[4], marked());

  // The applied variable keeps its section.
  await act(async () => root.unmount());
  root = createRoot(host);
  await render({ selectedBinding: 'var(--link-border)' });
  check(
    'the applied variable is marked in its section',
    document.querySelector('.embed-editor_varpicker-family[aria-label="link"] .is-selected')?.dataset.binding === 'var(--link-border)',
  );

  // The ungrouped names are a card with the same look as a named group, and a project with no groups at all shows no heading.
  const other = [...document.querySelectorAll('.embed-editor_varpicker-family')].find((node) => node.getAttribute('aria-label') === 'Other');
  check(
    "the ungrouped card is drawn with the named groups' own class",
    !!other && other.className === document.querySelector('.embed-editor_varpicker-family[aria-label="button"]')?.className,
  );
  // The tooltip describes the row under the pointer: it is built from that row's own data.
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  for (const name of ['link-text', 'button-border', 'text-2']) {
    const target = document.querySelector(`[data-binding="var(--${name})"]`);
    await act(async () => target.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true })));
    check(
      `the tooltip of the hovered row names ${name}`,
      target.getAttribute('title')?.includes(name) && target.getAttribute('aria-label')?.startsWith(`--${name}`),
      `${target.title} | ${target.getAttribute('aria-label')}`,
    );
  }
  const titles = [...document.querySelectorAll('.embed-editor_varpicker-item')].map((node) => node.title);
  check('and no two rows share a tooltip', new Set(titles).size === titles.length);

  // Three levels read apart, and nothing sits left of the list's edge.
  const css = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
  const block = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  };
  const file = block('.embed-editor_varpicker-collection-name');
  const heading = block('.embed-editor_varpicker-family-name');
  const rowRule = block('.embed-editor_varpicker-item');
  check('the file is md and bold', /font-size:\s*var\(--font-size-md\)/.test(file) && /font-weight:\s*var\(--font-weight-bold\)/.test(file), file);
  check(
    'the group is 0.75rem, medium weight, secondary text',
    /font-size:\s*0\.75rem/.test(heading) && /--font-weight-medium/.test(heading) && /--color-text-secondary/.test(heading),
    heading,
  );
  check('the row is sm and regular', /font-size:\s*var\(--font-size-sm\)/.test(rowRule) && !/font-weight/.test(rowRule), rowRule);
  check(
    'heading padding keeps the text inside the list edge, no negative offsets in the picker',
    /padding:\s*var\(--space-2\) var\(--space-3\)/.test(heading) && !/margin-left:\s*-/.test(heading + rowRule + block('.embed-editor_varpicker-family')),
  );
  check('no borders on the group', !/\bborder(?!-radius)/.test(block('.embed-editor_varpicker-family')));
  await act(async () => root.unmount());
  if (failures.length > 0) {
    console.error(`variablePickerGroups: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerGroups: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
