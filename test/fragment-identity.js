// A Fragment is not the thing inside it.
//
//   node test/fragment-identity.js
//
// `<Fragment slot="column2"><FeatureImage /></Fragment>` put a row in the
// navigator called `feature-image_wrap`, with the component drawn underneath
// it — so the component's own root div read as a page element wrapping the
// component, which is upside down.
//
// The label comes from the page: a node whose source has no class is named
// after what it actually rendered with, which is the only way to name
// `class:list={[…]}`. And the page can only answer about elements. Asked what
// the Fragment rendered with, the canvas finds the element between its markers
// — the component's root div — and says so. That div answers to the Fragment's
// path on purpose: it is how a click inside the slot finds the node that put it
// there. So the canvas cannot tell them apart, and it should not have to. The
// model knows a Fragment is a Fragment.

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
  const out = path.join(buildDir, 'renders-element.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'liveClasses.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { rendersOwnElement, liveClassesById } = await import(`file://${out}?v=${Date.now()}`);

  // --- what renders something of its own ------------------------------------
  check('a div does', rendersOwnElement({ kind: 'element', name: 'div' }) === true);
  check('and a component does', rendersOwnElement({ kind: 'component', name: 'FeatureImage' }) === true);
  check('a Fragment does not', rendersOwnElement({ kind: 'component', name: 'Fragment' }) === false);
  check('nor does a slot', rendersOwnElement({ kind: 'element', name: 'slot' }) === false);
  check('and nothing at all is nothing', rendersOwnElement(null) === false);

  // --- and who asks -----------------------------------------------------------
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  check(
    'the app builds its labels through it',
    /classesByNodeId\(nodeClasses, model\.nodes/.test(app),
    'the app walks the tree itself and the rule is somewhere else'
  );
  check(
    'and the same question decides what "renders nothing" is a fact about',
    /const answers = \(n\) => MARKABLE\.has\(n\.kind\) && rendersOwnElement\(n\)/.test(app),
    'the two places disagree about what a Fragment renders'
  );

  // --- the navigator, with the map the app would build -------------------------
  const bundlePath = path.join(buildDir, 'fragment-identity.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'StructurePanel.jsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.ResizeObserver = global.ResizeObserver;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const StructurePanel = require(bundlePath).default;

  const image = { id: 'img', kind: 'component', name: 'FeatureImage', props: {} };
  // Written as a tag rather than as a component — which is what the Tag field
  // in the settings panel makes of it, and what the row in the report was.
  // Either way it renders nothing of its own.
  const fragment = {
    id: 'frag',
    kind: 'element',
    name: 'Fragment',
    props: { slot: { type: 'string', value: 'column2' } },
    children: [image],
  };
  // An element whose class the source cannot show — `class:list={[…]}` — is
  // the reason rows are named after what the page reports at all.
  const listed = { id: 'listed', kind: 'element', name: 'div', props: {} };
  const wrapper = { id: 'wrap', kind: 'component', name: 'ContentWrapper', props: {}, children: [fragment, listed] };

  const container = document.getElementById('root');
  const root = createRoot(container);
  // The map the app hands down. Both rows carry the same classes here, because
  // that is exactly what the page reports for them — the Fragment's entry is
  // the one that must never have been made.
  // Built the way the app builds it, from what the page actually reports —
  // where the Fragment and the component it holds carry the same classes,
  // because the div between the Fragment's markers answers to both paths.
  const live = liveClassesById(
    {
      '0.0': ['feature-image_wrap', 'is-condensed'],
      '0.0.0': ['feature-image_wrap', 'is-condensed'],
      '0.1': ['card_wrap'],
    },
    [wrapper]
  );
  await act(async () => {
    root.render(
      React.createElement(StructurePanel, {
        pageState: { editable: true, model: { nodes: [wrapper], imports: [] } },
        layouts: [],
        currentLayoutName: '',
        selectedId: null,
        liveClassesById: live,
        onSelect: () => {},
        onDropComponent: () => {},
        onMoveNode: () => {},
        onRemoveNode: () => {},
        onCopyNode: () => {},
        onDuplicateNode: () => {},
        onPasteNode: () => {},
        onChangeLayout: () => {},
        onRawChange: () => {},
        onHoverNode: () => {},
        onOpenComponent: () => {},
        hasClipboard: false,
      })
    );
    await new Promise((r) => setTimeout(r, 30));
  });
  await act(async () => {
    container.querySelector('.panel-header button')?.click();
    await new Promise((r) => setTimeout(r, 30));
  });

  const labelOf = (id) =>
    container.querySelector(`.structure-node[data-node-id="${id}"] .label`)?.textContent?.trim() || '';
  check('the Fragment says what it is', labelOf('frag') === 'Fragment', labelOf('frag'));
  check('the component it holds says what IT is', labelOf('img') === 'FeatureImage', labelOf('img'));
  check(
    'and an element still wears the class the page says it rendered with',
    labelOf('listed') === 'card_wrap',
    labelOf('listed')
  );

  if (failures.length) {
    console.error(`\nfragment-identity: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`fragment-identity: ${checked} passed  [a Fragment is not what it holds]`);
  process.exit(0);
})();
