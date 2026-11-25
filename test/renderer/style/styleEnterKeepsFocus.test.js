// Enter in a Style panel value field keeps the focus where it is.
//
//   node test/renderer/style/styleEnterKeepsFocus.test.js
//
// Goal: pressing Enter in a value field commits it and leaves the focus (and the
// caret) in that field, so the arrow keys can nudge the value straight after. The
// owner's report: typing `2rem` in Size > Height and pressing Enter threw the focus
// out of the field.
//
// Root cause: a code field (VariableConnect `code`) draws a contentEditable token
// editor over its input, and THAT is what holds the focus in the real panel. Enter
// reached `tokenFieldKeyDown`, which blurred it; the keep-focus hand-back existed
// only on the hidden input's key handler, which never saw the key. A second cause:
// a slow write turned the editor's deferred `busy` on, and `disabled={busy}` drops
// the focus of the field being typed in.
//
// Method: mount the real components in jsdom (the Size section, the grid area
// inputs, the token editor), type, press Enter, re-render the way a commit does,
// and read document.activeElement and the caret. Negative space: Escape, Tab, an
// outside click, an invalid value, a field that is meant to leave on Enter (the
// spacing editor), and a write that outlasts the busy delay while a field is focused.

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

// The busy lock arrives after a delay the editor starts with window.setTimeout. The test drives that timer: it holds the
// callback the editor asks for and runs it, instead of sleeping past the delay and hoping the runner was quick enough.
async function runBusyDelay(controls) {
  const realSetTimeout = window.setTimeout;
  let held;
  window.setTimeout = (callback) => {
    held = callback;
    return 1;
  };
  try {
    controls.setBusyBoth(true);
  } finally {
    window.setTimeout = realSetTimeout;
  }
  check('Busy: the write asked for a deferred lock', typeof held === 'function');
  if (typeof held === 'function') {
    held();
  }
}

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'enter-keeps-focus.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as SizeSection } from './src/features/style/SizeSection'
        export { AreaNameInput, AreaNumberInput } from './src/features/style/GridAreas'
        export { useBusyState, useEditorRefs } from './src/features/style/embed/useEditorFoundation'
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
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.HTMLInputElement = dom.window.HTMLInputElement;
  global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  };
  // The bridge: every method answers with nothing (a subscription returns its unsubscribe).
  dom.window.avb = new Proxy(
    {},
    {
      get: (_target, name) => (typeof name === 'string' && name.startsWith('on') ? () => () => {} : async () => ({ entries: [], variables: [] })),
    },
  );

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { SizeSection, AreaNameInput, AreaNumberInput, useBusyState, useEditorRefs } = require(bundlePath);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;

  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = (element) => act(async () => root.render(element));
  const press = (target, key, init = {}) =>
    act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });
  const typeInto = (input, text) =>
    act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });

  // Size > Height: the real section, whose code fields are token editors.
  const committed = [];
  const sizeProps = () => ({
    read: () => undefined,
    busy: false,
    setProp: (prop, value) => committed.push(`${prop}=${value}`),
    clearProp: () => {},
    liveSetProp: () => {},
    onProvenance: () => {},
    onSelectSelector: () => {},
  });
  await render(React.createElement(SizeSection, sizeProps()));
  const heightInput = document.querySelector('input[data-prop="height"]');
  check('the Height field is there', heightInput !== null);
  const editors = [...document.querySelectorAll('[role="textbox"]')];
  const heightEditor = editors.find((editor) => editor.parentElement?.contains(heightInput));
  check('Height is drawn as a token editor, the element that holds the focus', heightEditor !== undefined);

  if (heightEditor !== undefined) {
    await act(async () => {
      heightEditor.focus();
    });
    await act(async () => {
      heightEditor.textContent = '2rem';
      const selection = dom.window.getSelection();
      const range = document.createRange();
      range.setStart(heightEditor.firstChild, 4);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      heightEditor.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    });
    await press(heightEditor, 'Enter');
    await render(React.createElement(SizeSection, sizeProps())); // the re-render a commit brings
    check('Height: Enter commits the value', committed.includes('height=2rem'), committed.join(','));
    check('Height: the editor still holds the focus after the re-render', document.activeElement === heightEditor, String(document.activeElement?.tagName));
    const caret = dom.window.getSelection().getRangeAt(0);
    const upToCaret = document.createRange();
    upToCaret.setStart(heightEditor, 0);
    upToCaret.setEnd(caret.endContainer, caret.endOffset);
    check('Height: the caret is where it was', upToCaret.toString().length === 4, String(upToCaret.toString().length));

    // Tab leaves (the browser moves the focus; here the blur it causes), and commits.
    const writes = committed.length;
    await act(async () => {
      heightEditor.blur();
    });
    check('Height: leaving commits', committed.length > writes && committed[committed.length - 1] === 'height=2rem', committed.join(','));
    check('Height: and the focus is gone, as a Tab or a click elsewhere leaves it', document.activeElement !== heightEditor);
  }

  // Size > Max W: a second Size field, its own draft.
  const maxEditor = [...document.querySelectorAll('[role="textbox"]')].find((editor) => editor.parentElement?.querySelector('input[data-prop="max-width"]'));
  if (maxEditor !== undefined) {
    await act(async () => {
      maxEditor.focus();
    });
    await act(async () => {
      maxEditor.textContent = '40rem';
      maxEditor.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    });
    await press(maxEditor, 'Enter');
    check('Max W: Enter commits and keeps the focus', committed.includes('max-width=40rem') && document.activeElement === maxEditor);
    await act(async () => {
      maxEditor.blur();
    });
    check('Max W: Tab or an outside click still leaves the field', document.activeElement !== maxEditor);
  }

  // Grid area name: a plain text input, re-rendered with the committed value.
  const names = [];
  const nameField = (value) => React.createElement(AreaNameInput, { value, busy: false, onCommit: (next) => names.push(next) });
  await render(nameField('hero'));
  const nameInput = container.querySelector('input');
  await act(async () => {
    nameInput.focus();
  });
  await typeInto(nameInput, 'header');
  nameInput.setSelectionRange(3, 3);
  await press(nameInput, 'Enter');
  await render(nameField('header'));
  check('Area name: Enter commits', names[names.length - 1] === 'header', names.join(','));
  check('Area name: focus stays across the re-render', document.activeElement === nameInput);
  check('Area name: caret kept', nameInput.selectionStart === 3, String(nameInput.selectionStart));

  // Escape is not Enter: nothing commits and nothing is moved.
  const namesBefore = names.length;
  await press(nameInput, 'Escape');
  check('Area name: Escape does not commit', names.length === namesBefore);

  // An outside click blurs the field, which commits.
  await typeInto(nameInput, 'footer');
  await act(async () => {
    nameInput.blur();
  });
  check('Area name: leaving commits', names[names.length - 1] === 'footer', names.join(','));
  check('Area name: and leaves the field', document.activeElement !== nameInput);

  // Grid area number: invalid text on Enter reverts, keeps the focus, adds no message.
  const numbers = [];
  await render(React.createElement(AreaNumberInput, { value: 2, ariaLabel: 'Column start', busy: false, onCommit: (cell) => numbers.push(cell) }));
  const numberInput = container.querySelector('input');
  await act(async () => {
    numberInput.focus();
  });
  await typeInto(numberInput, 'abc');
  const textBefore = container.textContent;
  await press(numberInput, 'Enter');
  check('Number: an invalid value commits nothing', numbers.length === 0, numbers.join(','));
  check('Number: it reverts to the saved value', numberInput.value === '2', numberInput.value);
  check('Number: the focus stays', document.activeElement === numberInput);
  check('Number: no error paragraph was added to the panel', container.textContent === textBefore && container.querySelectorAll('p').length === 0);
  await typeInto(numberInput, '5');
  await press(numberInput, 'Enter');
  check('Number: a valid value commits and keeps the focus', numbers[numbers.length - 1] === 5 && document.activeElement === numberInput, numbers.join(','));
  await press(numberInput, 'ArrowUp');
  check('Number: the arrow keys work straight after Enter', numbers[numbers.length - 1] === 3, numbers.join(','));

  // A write that outlasts the busy delay does not lock the field being typed in.
  const states = [];
  let controls;
  function Probe() {
    const refs = useEditorRefs();
    const state = useBusyState(refs);
    controls = state;
    states.push(state.busy);
    return React.createElement('input', { id: 'typing' });
  }
  await render(React.createElement(Probe));
  const typing = document.getElementById('typing');
  await act(async () => {
    typing.focus();
  });
  await act(async () => {
    await runBusyDelay(controls);
  });
  check('Busy: a focused field is not locked by a slow write', controls.busy === false);
  await act(async () => {
    typing.blur();
  });
  check('Busy: once it is left, the lock the write asked for applies', controls.busy === true);
  await act(async () => {
    controls.setBusyBoth(false);
  });
  check('Busy: and lifts when the write ends', controls.busy === false);
  await act(async () => {
    await runBusyDelay(controls);
  });
  check('Busy: with nothing focused a slow write still locks the panel', controls.busy === true);
  await act(async () => {
    controls.setBusyBoth(false);
  });

  if (failures.length) {
    console.error(`enter-keeps-focus: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`enter-keeps-focus: ${checked} passed`);
  process.exit(0);
})();
