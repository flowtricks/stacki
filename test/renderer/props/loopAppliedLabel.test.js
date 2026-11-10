// Goal: a loop section that filters, sorts or limits the list says so with a
// blue title, and that title behaves as every other set label does: a click (or
// Enter) opens the shared Reset menu, and Reset clears that section alone through
// the section's own write, so the other sections keep their bytes. An unapplied
// title stays a plain, non-interactive label.
//
// Method: the label's markup is rendered as the panel loads it. Then the real
// LoopSettings, bundled as the app bundles it, renders in jsdom over a small host
// that runs the real planLoop and re-renders with what it wrote, as
// loopSectionCode.test.js does; each section's title is clicked, Reset chosen,
// and the loop's head compared with the head the other sections had.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const load = require('../../helpers/rendererModule');

const { planLoop } = load('src/editor/loopQueryPlan.ts');
const { filtersReset, sortReset, limitReset } = load('src/features/props/loopSettingsModel.ts');

const directory = repoPath('node_modules/.stacki-test/loop-applied-label');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'loop-applied-label.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as LoopSettings } from './src/features/props/LoopSettings';",
      "export { AppliedLabel } from './src/features/props/LoopRows';",
    ].join('\n'),
    resolveDir: ROOT,
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

const LIST = `interface Props {
  features?: readonly { title: string; number: number; on: boolean }[];
}
const { features = [] } = Astro.props;
`;
const headOf = (data) => `${data}.map((item, index) => (`;
const listModel = (data) => ({ head: headOf(data), frontmatter: LIST, imports: [] });

const FILTER = '.filter((item) => item.number > 1)';
const SORT = '.toSorted((a, b) => (a.number ?? 0) - (b.number ?? 0))';
const LIMIT = '.slice(0, 3)';

let React;
let act;
let createRoot;
let renderToStaticMarkup;
let modules;
function installDom() {
  if (modules !== undefined) {
    return;
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // CodeMirror measures text; jsdom lays nothing out.
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ renderToStaticMarkup } = require('react-dom/server'));
  ({ act } = React);
  modules = require(output);
}

// A host that applies what the panel asks through the real plan, as the app
// does, and renders again from what the plan wrote.
async function panel(context, start) {
  installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const state = { ...start, applied: [] };
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = () => {
    const data = state.head.slice(0, state.head.lastIndexOf('.map('));
    root.render(
      React.createElement(modules.LoopSettings, {
        input: { frontmatter: state.frontmatter, imports: state.imports, data },
        projectPath: undefined,
        filePath: 'src/components/Card.astro',
        lists: [],
        onApply,
      }),
    );
  };
  const onApply = (target) => {
    state.applied.push(target);
    const loop = { id: 'loop', kind: 'map', head: state.head, children: [] };
    const model = { extraFrontmatter: state.frontmatter, imports: state.imports, nodes: [loop] };
    const result = planLoop({ model, loop, target, sanityClient: 'unavailable' });
    if (!result.ok) {
      return result;
    }
    state.head = result.plan.loop.head;
    state.frontmatter = result.plan.extraFrontmatter;
    render();
    return { ok: true, unbound: 0, lost: [], restored: false };
  };
  await act(async () => render());
  return { host, state };
}

const TITLES = { filter: 'Filters', sort: 'Sort', limit: 'Limit items' };
const sectionOf = (host, section) => host.querySelector(`button[aria-label="${TITLES[section]} as code"]`).closest('.loop-settings-section');
const labelOf = (host, section) => sectionOf(host, section).querySelector('.loop-settings-label .prop-label');
const menu = () => document.querySelector('.prop-menu') ?? undefined;
const click = async (element) => {
  assert.ok(element, 'the control is there');
  await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
};

async function resetSection(host, section) {
  const label = labelOf(host, section);
  assert.ok(label.classList.contains('set'), `${section} reads as applied`);
  assert.equal(menu(), undefined, 'no menu before the click');
  await click(label);
  assert.ok(menu(), 'the click opens the reset menu');
  const items = [...menu().querySelectorAll('.prop-menu-item')];
  assert.deepEqual(
    items.map((item) => item.textContent),
    ['Reset'],
  );
  await click(items[0]);
  assert.equal(menu(), undefined, 'choosing Reset closes the menu');
}

test('an applied label is the shared reset label; an unapplied one is plain text', () => {
  installDom();
  const markup = (applied) => renderToStaticMarkup(React.createElement(modules.AppliedLabel, { title: 'Filters', reset: { applied, onReset: () => {} } }));
  assert.match(markup(true), /^<span class="prop-label set" role="button" tabindex="0" title="[^"]+">Filters<\/span>$/);
  assert.equal(markup(false), '<span class="prop-label">Filters</span>');
});

test('the reset helpers clear their own section and leave the rest', () => {
  const query = {
    match: 'any',
    conditions: [{ kind: 'custom', code: 'isLive' }],
    sorts: [{ field: 'number', direction: 'ascending', order: 'number' }],
    random: true,
    customSort: '(a, b) => 0',
    limit: 3,
    offset: 2,
  };
  assert.deepEqual(filtersReset(query), { ...query, conditions: [], match: 'all' });
  assert.deepEqual(sortReset(query), { ...query, sorts: [], random: false, customSort: undefined });
  assert.deepEqual(limitReset(query), { ...query, limit: undefined, offset: 0 });
});

test('Reset on each section’s title clears that section alone', async (context) => {
  const expected = { filter: `features${SORT}${LIMIT}`, sort: `features${FILTER}${LIMIT}`, limit: `features${FILTER}${SORT}` };
  for (const section of ['filter', 'sort', 'limit']) {
    const { host, state } = await panel(context, listModel(`features${FILTER}${SORT}${LIMIT}`));
    await resetSection(host, section);
    assert.equal(state.head, headOf(expected[section]), section);
    assert.equal(state.applied.length, 1, 'one write, so one undo takes it back');
    assert.equal(labelOf(host, section).classList.contains('set'), false, `${section} reads as unapplied`);
    assert.equal(labelOf(host, section).getAttribute('role') ?? undefined, undefined);
  }
});

test('Enter on an applied title opens the same menu', async (context) => {
  const { host } = await panel(context, listModel(`features${FILTER}`));
  const label = labelOf(host, 'filter');
  await act(async () => label.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.ok(menu(), 'Enter opens the reset menu');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(menu(), undefined, 'Escape closes it');
});

test('a section shown as code resets its code alone', async (context) => {
  const { host, state } = await panel(context, listModel(`features.filter(isLive)${LIMIT}`));
  assert.ok(sectionOf(host, 'filter').querySelector('.cm-content'), 'the filter shows as code');
  await resetSection(host, 'filter');
  assert.equal(state.head, headOf(`features${LIMIT}`));
  assert.deepEqual(
    state.applied.map((target) => target.kind),
    ['section'],
  );
});

test('an unapplied title opens nothing', async (context) => {
  const { host, state } = await panel(context, listModel('features'));
  for (const section of ['filter', 'sort', 'limit']) {
    const label = labelOf(host, section);
    assert.equal(label.classList.contains('set'), false, section);
    assert.equal(label.getAttribute('role') ?? undefined, undefined);
    assert.equal(label.getAttribute('tabindex') ?? undefined, undefined);
    await click(label);
    assert.equal(menu(), undefined, `${section} opens no menu`);
  }
  assert.deepEqual(state.applied, []);
});
