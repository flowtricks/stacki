// Clearing a property, in the field that held it.
//
//   node test/renderer/style/clearShows.test.js
//
// The value was gone from the CSS the moment Clear was pressed — and the field
// went on showing it. What a field shows is its own draft, which follows the
// model whenever nobody is typing; and the model, after any edit, is a save
// followed by a re-resolve: every rule matched against the element again,
// asking the page where it has to. Until all that came back, the one thing the
// panel knew for certain — that this property was just deleted — was the one
// thing it wasn't saying.
//
// So the field empties when Clear is pressed. The model still arrives and still
// wins: when the save finishes, the field shows what the file now says, which
// may be a value from a rule further down that was there all along.

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

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'clear-shows.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as SizeSection } from './src/features/style/SizeSection'`,
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
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  };
  dom.window.avb = { listAssets: async () => ({ entries: [] }) };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { SizeSection } = require(bundlePath);

  // A width the page declares, the way the model reports one.
  const declared = (value) => ({
    source: 'selected',
    overridden: false,
    winner: { selectorText: '.card_time_element', value, important: false },
    selectedValue: { value, important: false },
    contributors: [],
  });

  const cleared = [];
  const root = createRoot(document.getElementById('root'));
  let width = declared('100%');
  let busy = false;
  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(SizeSection, {
          read: (prop) => (prop === 'width' ? width : undefined),
          busy,
          setProp: () => {},
          clearProp: (prop) => cleared.push(prop),
          liveSetProp: () => {},
          onProvenance: () => {},
          onSelectSelector: () => {},
        }),
      );
    });
  };
  await render();

  const field = () => document.querySelector('input[data-prop="width"]');
  const label = () => [...document.querySelectorAll('.u-field-label, .u-field-label-wrap button')].find((element) => element.textContent.trim() === 'Width');
  const click = async (element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  check('the width the page declares is in the field', field()?.value === '100%', field()?.value);

  // Option-click is the shortcut for the same Clear the menu offers.
  await act(async () => {
    label().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
  });
  check('clearing asks for the property to go', cleared.join() === 'width', cleared.join());
  check('and the field stops showing it at once', field()?.value === '', field()?.value);

  // The save is running: the model still says 100%, because nothing has
  // re-resolved yet. The field must not snap back to it.
  busy = true;
  await render();
  check('it stays empty while the save runs', field()?.value === '', field()?.value);

  // The save finishes and the model has caught up — the property is gone.
  busy = false;
  width = undefined;
  await render();
  check('and stays empty once the model agrees', field()?.value === '', field()?.value);

  // A save runs with the field disabled, so a clear is always pressed from
  // idle. What follows the press is the question.
  const clear = async () => {
    await act(async () => {
      label().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
    });
  };

  // The other ending: something further down the cascade declared it too, so
  // clearing this rule leaves a value behind. The field has to show that.
  width = declared('100%');
  busy = false;
  await render();
  await clear();
  check('a second clear empties it again', field()?.value === '', field()?.value);
  busy = true;
  await render();
  width = declared('50rem'); // what the rule below it says
  busy = false;
  await render();
  check('and the value that was underneath comes up', field()?.value === '50rem', field()?.value);

  // The value the model reports never changed across the save — a clear that
  // turned out to change nothing here (the declaration lives in a rule this
  // panel isn't editing). Without the end of the save to sync on, there is no
  // change for the field to notice, and it would sit empty saying the property
  // is gone when it is not.
  await clear();
  check('a clear that changed nothing empties the field first', field()?.value === '', field()?.value);
  busy = true;
  await render();
  busy = false;
  await render();
  check('and the unchanged value comes back when the save ends', field()?.value === '50rem', field()?.value);

  // Typing is still nobody else's business.
  await act(async () => {
    field().focus();
  });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(field(), '12px');
    field().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  width = declared('80rem');
  await render();
  check('a model that changes under a field being typed in does not take it over', field()?.value === '12px', field()?.value);

  if (failures.length) {
    console.error(`\nclear-shows: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`clear-shows: ${checked} passed  [a cleared field shows it cleared]`);
  process.exit(0);
})();
