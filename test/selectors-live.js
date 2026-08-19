// Removing a class updates the selectors panel on the spot.
//
//   node test/selectors-live.js
//
// The class list is edited in the Settings tab, which unmounts the style panel; the
// panel's own snapshot is refreshed by a canvas round trip and a re-match of every
// rule, and it unions the authored classes with whatever the PREVIEW last reported —
// which goes on reporting a class you deleted until the dev server re-renders. So a
// removed class used to sit in the selector well for seconds, and a re-scan in
// between put it back. These check the two halves of the fix: the classes that count
// as gone (useRemovedClasses) and taking them out of the snapshot (withoutClasses).

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
  const bundlePath = path.join(buildDir, 'selectors-live.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        import { useRemovedClasses, withoutClasses } from './EmbedEditor'
        export { withoutClasses }
        export { setHost } from './lib/host'
        export function Probe() {
          const removed = useRemovedClasses()
          return <div data-removed={[...removed].join(',')} />
        }
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
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const { Probe, withoutClasses, setHost } = require(bundlePath);

  // --- taking a class out of a snapshot ------------------------------------
  const snap = {
    tag: 'div',
    webflowType: '',
    id: null,
    classes: ['card', 'is-active'],
    classList: ['card', 'is-active'],
    attributes: { class: 'card is-active' },
  };
  const pruned = withoutClasses(snap, new Set(['is-active']));
  check('the class is gone from the list', pruned.classList.join(' ') === 'card', pruned.classList.join(' '));
  check('and from the class attribute selectors read', pruned.attributes.class === 'card', pruned.attributes.class);
  check('the original is left alone', snap.classList.length === 2, `${snap.classList.length}`);
  check('hiding nothing returns the same object', withoutClasses(snap, new Set()) === snap);
  check('no snapshot stays no snapshot', withoutClasses(undefined, new Set(['x'])) === undefined);

  // --- which classes count as just-removed ----------------------------------
  const node = { id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'card is-active' } } };
  setHost({ selectedId: 'n1', nodes: [node], renderedClasses: ['card', 'is-active'] });

  const reactRoot = createRoot(document.getElementById('root'));
  // The host tells its subscribers on a microtask (see lib/host), so let it land.
  const settle = () => act(async () => { await new Promise((r) => dom.window.setTimeout(r, 5)); });
  const hidden = () => document.querySelector('[data-removed]').dataset.removed;

  await act(async () => { reactRoot.render(React.createElement(Probe)); });
  await settle();
  check('nothing is hidden to begin with', hidden() === '', hidden());

  // The edit: the model loses the class while the preview still reports it.
  node.props.class.value = 'card';
  setHost({ nodes: [{ ...node }] });
  await settle();
  check('a removed class is hidden at once', hidden() === 'is-active', hidden());

  // The dev server re-renders: there is nothing left to hide.
  setHost({ renderedClasses: ['card'] });
  await settle();
  check('and forgotten once the preview agrees', hidden() === '', hidden());

  // Putting it back shows it again.
  node.props.class.value = 'card is-active';
  setHost({ nodes: [{ ...node }], renderedClasses: ['card', 'is-active'] });
  await settle();
  check('adding it back un-hides it', hidden() === '', hidden());

  // A different element starts clean — one element's removal isn't another's.
  node.props.class.value = 'card';
  setHost({ nodes: [{ ...node }] });
  await settle();
  check('still hidden on the element it was removed from', hidden() === 'is-active', hidden());
  setHost({ selectedId: 'n2', nodes: [{ ...node }, { id: 'n2', kind: 'element', name: 'p', props: {} }] });
  await settle();
  check('selecting another element carries nothing over', hidden() === '', hidden());

  if (failures.length) {
    console.error(`selectors-live: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`selectors-live: ${checked} passed  [snapshot pruning, removal tracking]`);
})();
