// Enter in a Props panel field keeps the focus where it is.
//
//   node test/renderer/props/enterKeepsFocus.test.js
//
// Goal: pressing Enter in a Props panel text field commits it and leaves the focus
// (and the caret) in that field, as the Style panel's fields do, so the next edit
// does not take a click. The fields used to blur on Enter, which wrote the value and
// threw the focus away.
//
// Method: mount the real components in jsdom (the object field's text box, the loop
// literal list's item box, the binding input), type, press Enter, re-render the way a
// commit does, and read document.activeElement and the caret. Negative space: a blur
// from Tab or an outside click still commits and leaves, Escape reverts without
// committing, and the binding input's Enter does not split its one line.

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
  const bundlePath = path.join(buildDirectory, 'props-enter-keeps-focus.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as ObjectField } from './src/features/props/ObjectField'
        export { LiteralItemsSection } from './src/features/props/LoopLiteralItems'
        export { default as BindInput } from './src/features/props/BindInput'
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
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLInputElement = dom.window.HTMLInputElement;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // The bridge: every method answers with nothing (a subscription returns its unsubscribe).
  dom.window.avb = new Proxy(
    {},
    {
      get: (_target, name) => (typeof name === 'string' && name.startsWith('on') ? () => () => {} : async () => ({ entries: [] })),
    },
  );

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { ObjectField, LiteralItemsSection, BindInput } = require(bundlePath);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;

  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = (element) => act(async () => root.render(element));
  const press = (target, key) =>
    act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  const typeInto = (input, text) =>
    act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });

  // Object field: a text box that commits on blur.
  const wrote = [];
  let current = '{ legend: "Ministry" }';
  const objectField = () =>
    React.createElement(ObjectField, {
      value: current,
      onChange: (text) => {
        wrote.push(text);
        current = text;
      },
    });
  await render(objectField());
  const objectInput = container.querySelector('.object-field-input');
  check('the object field has a text box', objectInput !== null);
  await act(async () => {
    objectInput.focus();
  });
  await typeInto(objectInput, 'Staff');
  await render(objectField()); // The panel is controlled: the keystroke comes back as the value.
  objectInput.setSelectionRange(2, 2);
  await press(objectInput, 'Enter');
  await render(objectField());
  check(
    'Object field: Enter commits',
    wrote.some((text) => text.includes('Staff')),
    wrote.join(' | '),
  );
  check('Object field: the focus stays across the re-render', document.activeElement === objectInput);
  check('Object field: the caret is where it was', objectInput.selectionStart === 2, String(objectInput.selectionStart));
  const writes = wrote.length;
  await typeInto(objectInput, 'Crew');
  await render(objectField());
  await act(async () => {
    objectInput.blur();
  });
  check('Object field: Tab or an outside click still commits', wrote.length > writes && wrote[wrote.length - 1].includes('Crew'), wrote.join(' | '));
  check('Object field: and leaves the field', document.activeElement !== objectInput);

  // Loop literal list: the draft is local, Escape puts the saved text back.
  const items = ['one', 'two'];
  const changes = [];
  const literals = () =>
    React.createElement(LiteralItemsSection, {
      items,
      data: JSON.stringify(items),
      onChange: (next) => changes.push([...next]),
      onCode: () => undefined,
    });
  await render(literals());
  const literalInput = container.querySelector('.loop-settings-literal-input');
  check('the literal list has an item box', literalInput !== null);
  if (literalInput !== null) {
    await act(async () => {
      literalInput.focus();
    });
    await typeInto(literalInput, 'uno');
    await press(literalInput, 'Enter');
    check('Literal item: Enter commits', changes.length === 1 && changes[0][0] === 'uno', JSON.stringify(changes));
    check('Literal item: the focus stays', document.activeElement === literalInput);
    await typeInto(literalInput, 'xyz');
    await press(literalInput, 'Escape');
    check('Literal item: Escape puts the saved text back and commits nothing', literalInput.value === 'one' && changes.length === 1, literalInput.value);
    await act(async () => {
      literalInput.blur();
    });
    check('Literal item: leaving commits nothing when nothing changed', changes.length === 1, JSON.stringify(changes));
  }

  // Binding input: a contentEditable line; Enter must not split it either.
  const bound = [];
  await render(React.createElement(BindInput, { parts: [{ text: 'hello' }], onChange: (parts) => bound.push(parts) }));
  const editor = container.querySelector('[role="textbox"]');
  check('the binding input is there', editor !== null);
  if (editor !== null) {
    await act(async () => {
      editor.focus();
    });
    await act(async () => {
      const range = document.createRange();
      range.setStart(editor.firstChild, 3);
      range.collapse(true);
      const selection = dom.window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const blurred = [];
    editor.addEventListener('blur', () => blurred.push(true));
    await press(editor, 'Enter');
    check('Binding input: Enter commits through a blur', blurred.length === 1, String(blurred.length));
    check('Binding input: and the focus stays', document.activeElement === editor);
    check('Binding input: the caret is where it was', dom.window.getSelection().focusOffset === 3, String(dom.window.getSelection().focusOffset));
    check('Binding input: still one line', editor.textContent === 'hello' && editor.querySelectorAll('br,div').length === 0, editor.innerHTML);
    await act(async () => {
      editor.blur();
    });
    check('Binding input: an outside click leaves it', document.activeElement !== editor);
  }

  if (failures.length) {
    console.error(`props-enter-keeps-focus: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`props-enter-keeps-focus: ${checked} passed`);
  process.exit(0);
})();
