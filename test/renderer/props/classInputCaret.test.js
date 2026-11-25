// The Settings panel's class field: a caret between its class tags.
//
//   node test/renderer/props/classInputCaret.test.js
//
// Goal: the class field is an ordered list the person edits, so a click in the
// gap between two tags puts the typing caret in that gap, and a class typed
// there (ended with Enter or Space) is written there in the class attribute, in
// that order. A click before the first tag or past the last puts the caret
// there too; ← and → step it across tags while nothing is typed. The field
// used to send every click on its own space to the end, so a gap click typed
// the class last. (The Style panel's selector field deliberately does the
// opposite, from the same gap arithmetic: test/renderer/style/selectorCaret.test.js.)
//
// Method: the real ClassInput is mounted in JSDOM inside a harness that holds
// the value the way the Settings panel does (onChange feeds the next value
// back in). JSDOM has no layout, so each tag is given a box on one row, 50px
// apart, before every click. The caret's place is read two ways: the input's
// CSS order against the tags' (tag i at 2i, the caret at 2·gap − 1), and the
// class attribute that typing produces. The input must also stay the same
// focused DOM node, last in the field, whichever gap it stands in: moving a
// focused input in the DOM drops its focus.

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
  const bundlePath = path.join(buildDirectory, 'class-input-caret.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as ClassInput } from './src/features/props/ClassInput'`,
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
  global.Window = dom.window.Window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

  const { ClassInput } = require(bundlePath);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');

  const written = [];
  // Holds the class value the way the Settings panel does: each change is the next value.
  function Harness({ initial }) {
    const [value, setValue] = React.useState(initial);
    return React.createElement(ClassInput, {
      value,
      suggestions: [],
      onChange: (next) => {
        written.push(next);
        setValue(next);
      },
    });
  }

  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(Harness, { initial: 'pricing_title text-style-h1' }));
  });

  const wrap = () => document.querySelector('.class-input');
  const tags = () => [...document.querySelectorAll('.class-tag')];
  const input = () => document.querySelector('.class-input-field');
  const caretOrder = () => Number(input()?.style.order);
  // One row, 50px apart: tag i spans i·50 … i·50 + 40.
  const layout = () => {
    tags().forEach((element, index) => {
      element.getBoundingClientRect = () => ({ left: index * 50, right: index * 50 + 40, top: 0, bottom: 20, width: 40, height: 20 });
    });
  };
  const clickField = async (x) => {
    layout();
    await act(async () => {
      wrap().dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: 10 }));
    });
  };
  const key = async (name) =>
    act(async () => {
      input().dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const type = async (text) =>
    act(async () => {
      setter.call(input(), text);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const inputIsLast = () => wrap()?.lastElementChild === input();
  const tagOrders = () => tags().map((element) => Number(element.style.order));

  const field = input();
  check('the tags are laid out by CSS order, 2i', JSON.stringify(tagOrders()) === '[0,2]', JSON.stringify(tagOrders()));
  check('the caret starts after the last tag', caretOrder() === 3, String(caretOrder()));

  // A click in the gap between pricing_title (0–40) and text-style-h1 (50–90).
  await clickField(45);
  check('a gap click focuses the input', document.activeElement === input());
  check('with the caret in that gap (order 2·1 − 1)', caretOrder() === 1, String(caretOrder()));
  check('the input did not move in the DOM', input() === field && inputIsLast());
  await type('new_class');
  await key('Enter');
  check('a class typed in the gap and ended with Enter is written there', written.at(-1) === 'pricing_title new_class text-style-h1', JSON.stringify(written));
  check('and the caret moves past it', caretOrder() === 3, String(caretOrder()));
  check('and the input is still focused, in place', document.activeElement === field && inputIsLast());

  // Space ends a class too.
  await clickField(95);
  check('a gap click between the second and third tags puts the caret there', caretOrder() === 3, String(caretOrder()));
  await type('spaced');
  await key(' ');
  check('a class ended with Space is written in that gap', written.at(-1) === 'pricing_title new_class spaced text-style-h1', JSON.stringify(written));

  // Before the first tag and past the last.
  await clickField(2);
  check('a click before the first tag puts the caret at gap 0', caretOrder() === -1, String(caretOrder()));
  await type('first');
  await key('Enter');
  check('a class typed there goes first', written.at(-1) === 'first pricing_title new_class spaced text-style-h1', JSON.stringify(written));
  await clickField(1000);
  check('a click past the last tag puts the caret at the end', caretOrder() === 2 * tags().length - 1, String(caretOrder()));
  await type('last');
  await key('Enter');
  check('a class typed there goes last', written.at(-1) === 'first pricing_title new_class spaced text-style-h1 last', JSON.stringify(written));

  // ← and → step the caret while nothing is typed, and stop at the ends.
  const count = tags().length;
  await key('ArrowLeft');
  check('← steps the caret one tag left', caretOrder() === 2 * (count - 1) - 1, String(caretOrder()));
  await key('ArrowLeft');
  await key('ArrowRight');
  check('→ steps it back', caretOrder() === 2 * (count - 1) - 1, String(caretOrder()));
  for (let step = 0; step < count + 2; step++) {
    await key('ArrowLeft');
  }
  check('← stops at gap 0', caretOrder() === -1, String(caretOrder()));
  await key('ArrowRight');
  await type('second');
  await key('Enter');
  check('a class typed after arrowing is written at the arrowed gap', written.at(-1)?.split(' ')[1] === 'second', JSON.stringify(written.at(-1)));
  check('the input stayed the same focused node throughout', document.activeElement === field && input() === field && inputIsLast());

  // A tag click still puts the caret after that tag.
  layout();
  await act(async () => {
    tags()[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  check('a tag click puts the caret after that tag', caretOrder() === 1, String(caretOrder()));

  await act(async () => root.unmount());

  if (failures.length) {
    console.error(`classInputCaret: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`classInputCaret: ${checked} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
