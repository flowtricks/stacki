// Deciding when a value has outgrown its field.
//
//   node test/renderer/style/customValue.test.js
//
// A long CSS value — a clamp() of four variables, a calc() of three — is the
// one most worth reading and the one a 90px field shows least of. Editing it
// through a slot showing a third of itself is the worst place in the app to be.
//
// The variables sheet has opened a bigger box for this for a while; the style
// panel now uses the same one, so the test that used to belong to the sheet
// belongs to both. Both open it the same two ways: a press on a field whose
// value does not fit, and `=` in any field at all.
//
// What is checked here is the DECIDING, which is the part that can be wrong
// without anything failing: open the box for a value that fitted fine and
// editing becomes a popup for every field; miss one that overflows and the
// value stays unreadable with no sign there was ever a better way to edit it.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LIMITS } = require('#dist/shared/core/limits.js');
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
  const bundlePath = path.join(buildDirectory, 'custom-value.bundle.js');
  await esbuild.build({
    // The editor and the picker field the app hands it (connectCustomField).
    stdin: {
      contents:
        "export * from './src/features/style/CustomValueEditor.tsx';\n" + "export { connectCustomField } from './src/features/style/VariableConnect.tsx';\n",
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { isLong, doesNotFit, withBinding } = require(bundlePath);

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>');
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.document = dom.window.document;

  // A field of a given rendered width, holding a value of a given drawn width.
  // JSDOM lays nothing out, so the two are supplied — that is exactly the seam
  // a real browser fills in, and everything above it is what is being tested.
  const fieldWith = (clientWidth, scrollWidth, cls = 'var-input') => {
    const wrap = dom.window.document.createElement('div');
    const input = dom.window.document.createElement('input');
    input.className = cls;
    Object.defineProperty(input, 'clientWidth', { value: clientWidth });
    Object.defineProperty(input, 'scrollWidth', { value: scrollWidth });
    wrap.appendChild(input);
    return wrap;
  };

  // --- Counting characters, for when nothing can be measured ----------------
  {
    check('a short value is not long', isLong('10px') === false);
    check('a normal one is not either', isLong('calc(100% - 20px)') === false);
    // 34 characters is the line, and past it a field cannot show the value at
    // any width the panel actually gives one.
    check('a long expression is', isLong('clamp(1rem, calc(2vw + 1rem), 3.5rem) + more') === true);
    // A value with a newline can never fit a single-line field, however short.
    check('anything with a line break is', isLong('a\nb') === true);
    check('an empty value is not', isLong('') === false);
    check('and neither is undefined', isLong(undefined) === false);
  }

  // --- Measuring, which is the real test ------------------------------------
  {
    // The value is drawn wider than the box holding it — the only reliable
    // answer, and the reason character counting is a fallback rather than the
    // rule.
    check('a value drawn wider than its field does not fit', doesNotFit(fieldWith(100, 240), 'short'), 'measured overflow missed');
    check('one that fits, fits', !doesNotFit(fieldWith(240, 240), 'short'));
    // A pixel of slack, so a value that exactly fills its field is not treated
    // as overflowing by a rounding error.
    check('a hair over is still a fit', !doesNotFit(fieldWith(240, 241), 'short'));
    check('two pixels over is not', doesNotFit(fieldWith(240, 242), 'short'));

    // Before layout — and in every headless render — clientWidth is 0. Falling
    // back to the count is what keeps the decision sane there rather than
    // deciding everything fits.
    check('an unlaid-out field falls back to counting', doesNotFit(fieldWith(0, 0), 'x'.repeat(40)));
    check('and still says short values fit', !doesNotFit(fieldWith(0, 0), '10px'));

    // The rich token editor is what is visible when a value has a chip in it;
    // the plain input is still in the DOM behind it, and measuring that one
    // would measure something nobody can see.
    const both = fieldWith(240, 240);
    const rich = dom.window.document.createElement('div');
    rich.className = 'embed-editor_varconnect-editor';
    Object.defineProperty(rich, 'clientWidth', { value: 100 });
    Object.defineProperty(rich, 'scrollWidth', { value: 300 });
    both.insertBefore(rich, both.firstChild);
    check('the visible editor is the one measured', doesNotFit(both, 'short'), 'measured the hidden input instead');

    // A style-panel field is a plain <input> with neither class, and it has to
    // be found too or the panel would never open the box by measurement.
    check('a bare input is found as well', doesNotFit(fieldWith(100, 300, 'u-input'), 'short'));
    // Nothing to measure at all: fall back rather than throw.
    check('a container with no field falls back', doesNotFit(dom.window.document.createElement('div'), 'x'.repeat(40)));
  }

  // --- Picking a variable inside an expression ------------------------------
  {
    // The box carries the variable picker, so choosing one from inside a long
    // expression has to replace the reference and not the expression around it.
    check(
      'a variable swap keeps the calc around it',
      withBinding('calc(var(--a) + 10px)', 'var(--b)') === 'calc(var(--b) + 10px)',
      withBinding('calc(var(--a) + 10px)', 'var(--b)'),
    );
    check('a value with no variable becomes the binding', withBinding('10px', 'var(--b)') === 'var(--b)', withBinding('10px', 'var(--b)'));
    check(
      'only the first reference is replaced',
      withBinding('calc(var(--a) + var(--c))', 'var(--b)') === 'calc(var(--b) + var(--c))',
      withBinding('calc(var(--a) + var(--c))', 'var(--b)'),
    );
  }

  // --- What the box saves ---------------------------------------------------
  //
  // The field you type in is the rich token editor; the <textarea> behind it only
  // carries the value, and the rich one pushes to it through the textarea's own
  // onChange (so React sees the change) when it commits on blur. Two things used
  // to drop an edit on the floor there: that push went through
  // HTMLInputElement's value setter, which REFUSES to run on a textarea, and
  // closing the box saved its draft without taking the rich field out of focus
  // first. Either way the box wrote back the value you started with — moving a
  // `)` past a variable chip looked like it saved and reopened unchanged.
  {
    const { JSDOM: JSDOM2 } = require('jsdom');
    const win = new JSDOM2('<!doctype html><div id="root"></div>', { pretendToBeVisual: true }).window;
    const previous = {
      window: global.window,
      document: global.document,
      navigator: global.navigator,
    };
    require('../../helpers/popupDom').installPopupDOM(win);
    global.window = win;
    // The pickers listen for variable changes, as they do under the real preload.
    win.avb = { onCssChanged: () => () => {} };
    global.document = win.document;
    global.navigator = win.navigator;
    global.Node = win.Node;
    global.Element = win.Element;
    global.HTMLElement = win.HTMLElement;
    global.HTMLInputElement = win.HTMLInputElement;
    global.HTMLTextAreaElement = win.HTMLTextAreaElement;
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    win.ResizeObserver = global.ResizeObserver;
    global.IS_REACT_ACT_ENVIRONMENT = true;

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = require('react');
    const { CustomValue, connectCustomField } = require(bundlePath);
    const saved = [];
    const root = createRoot(win.document.getElementById('root'));
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => win.setTimeout(resolve, 20));
      });

    await act(async () => {
      root.render(
        React.createElement(CustomValue, {
          connectField: connectCustomField,
          value: 'calc(2rem + )var(--nav-height)',
          label: 'width',
          anchor: { left: 10, top: 10, bottom: 40, right: 200, width: 190, height: 30 },
          onSave: (value) => saved.push(value),
          onCancel: () => saved.push('CANCELLED'),
        }),
      );
    });
    await settle();

    const rich = win.document.querySelector('.embed-editor_varconnect-editor');
    check('the box edits through the rich field', !!rich);
    if (rich) {
      // The edit: the closing paren moved past the variable — with the chip left
      // where it is, which is the shape the real field has.
      const chip = rich.querySelector('[data-chip]');
      check('the variable draws as a chip', !!chip, rich.innerHTML.slice(0, 120));
      await act(async () => {
        rich.focus();
        const findParen = (node, depth = 0) => {
          assert.ok(depth <= LIMITS.treeDepthMax, 'findParen: DOM depth limit');
          if (node.nodeType === 3 && node.textContent.includes(')')) {
            return node;
          }
          for (const child of node.childNodes) {
            const found = findParen(child, depth + 1);
            if (found) {
              return found;
            }
          }
          return undefined;
        };
        const textNode = findParen(rich);
        textNode.textContent = textNode.textContent.replace(')', '');
        rich.appendChild(win.document.createTextNode(')'));
        rich.dispatchEvent(new win.Event('input', { bubbles: true }));
      });
      await settle();
      // Typed, not committed: the value behind the field is already up to date, so
      // no close path depends on a blur having run first.
      check(
        'every keystroke reaches the value behind the field',
        win.document.querySelector('.var-custom-input')?.value === 'calc(2rem + var(--nav-height))',
        win.document.querySelector('.var-custom-input')?.value,
      );
      // Closed by pressing outside it.
      await act(async () => {
        win.document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
      });
      await settle();
      check('closing it saves what the rich field holds', saved[0] === 'calc(2rem + var(--nav-height))', JSON.stringify(saved));
    }
    // The box focuses its field on a timer of its own; unmount inside act so that
    // last update doesn't land outside one (React warns, and the suite prints it).
    await act(async () => {
      root.unmount();
    });
    global.window = previous.window;
    global.document = previous.document;
    global.navigator = previous.navigator;
  }

  if (failures.length) {
    console.error(`custom-value: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`custom-value: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
