// A prop that takes a list, edited as a list.
//
//   node test/renderer/props/listField.test.js
//
// `options={["Designer", "Developer"]}` is a list of things, so the field is a
// list of rows: drag one to reorder, the bin to drop one, the last row to add
// one, and a click to open one. Opening is a popup, because an item is not
// always a single thing — `{ value: "us", label: "United States" }` is a row
// with two fields, and there is no room beside the row's name for either.
//
// Each of those writes the WHOLE array back, because that is what the file
// holds — one value, not a list of values.
// Pointer presses dispatch down and click separately to catch dismissal races.
//
// The code editor is still one press of `{}` away, and it is the only field
// that can hold an array this cannot show: a spread, an object per item, a name
// standing for a list somewhere else. Those keep the editor rather than being
// flattened into rows (test/renderer/props/arrayValue.test.js).

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const { readSourceGroup } = require('../../helpers/sourceText.js');

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
  const entry = path.join(buildDirectory, 'list-field.entry.jsx');
  fs.writeFileSync(entry, `export { default as ListField } from ${JSON.stringify(repoPath('src/features/props/ListField.tsx'))};\n`);
  const bundle = path.join(buildDirectory, 'list-field.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
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
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { ListField } = require(bundle);

  // Rows are 30px tall and stacked, so "the top half of a row" is a real
  // question a drop can be asked.
  const ROW = 30;
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (!this.classList.contains('list-field-row')) {
      return { x: 0, y: 0, width: 200, height: 0, top: 0, left: 0, right: 200, bottom: 0 };
    }
    const rows = [...this.parentElement.querySelectorAll('.list-field-row')];
    const top = rows.indexOf(this) * ROW;
    return { x: 0, y: top, width: 200, height: ROW, top, left: 0, right: 200, bottom: top + ROW };
  };

  const mount = async (value, placeholder = '') => {
    const host = document.createElement('div');
    document.getElementById('root').appendChild(host);
    const root = createRoot(host);
    const wrote = [];
    // The app's own second argument: false while a value is being typed (the
    // canvas keeps up), true for the edit itself (one undo step).
    const immediate = [];
    // The field is controlled — the panel hands it back what was written, and a
    // second edit has to build on the first. A harness that kept showing the
    // original value would test a field nothing is listening to.
    let current = value;
    const render = async () => {
      await act(async () => {
        root.render(
          React.createElement(ListField, {
            value: current,
            placeholder,
            onChange: (text, now) => {
              wrote.push(text);
              immediate.push(now);
              current = text;
            },
          }),
        );
      });
    };
    await render();
    const rows = () => [...host.querySelectorAll('.list-field-row')];
    const labels = () => [...host.querySelectorAll('.list-field-text')].map((button) => button.textContent);
    const press = async (element) => {
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
      });
      await render();
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      await render();
    };
    // The popup, and its fields by the name the file gives them.
    const popup = () => document.querySelector('.list-item-editor');
    const fieldNames = () => [...document.querySelectorAll('.list-item-field > span')].map((span) => span.textContent);
    const typeInto = async (text, at = 0) => {
      const input = document.querySelectorAll('.list-item-editor input')[at];
      if (!input) {
        return false;
      }
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await render();
      return true;
    };
    // Anywhere else: the popup closes on a press outside it, which is when the
    // edit lands.
    const clickAway = async () => {
      await act(async () => {
        document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
      });
      await render();
    };
    // A drag from one row to a point inside another: the y decides which gap.
    const dragTo = async (from, to, half) => {
      const dt = { effectAllowed: '', setData() {}, getData: () => '' };
      const at = rows()[to].getBoundingClientRect();
      const clientY = at.top + (half === 'top' ? 4 : ROW - 4);
      await act(async () => {
        rows()[from].dispatchEvent(Object.assign(new dom.window.Event('dragstart', { bubbles: true }), { dataTransfer: dt }));
      });
      await act(async () => {
        rows()[to].dispatchEvent(
          Object.assign(new dom.window.Event('dragover', { bubbles: true }), {
            dataTransfer: dt,
            clientY,
          }),
        );
      });
      await act(async () => {
        rows()[to].dispatchEvent(
          Object.assign(new dom.window.Event('drop', { bubbles: true }), {
            dataTransfer: dt,
            clientY,
          }),
        );
      });
    };
    return {
      host,
      wrote,
      immediate,
      rows,
      labels,
      render,
      press,
      typeInto,
      popup,
      fieldNames,
      clickAway,
      dragTo,
      add: () => press(host.querySelector('.list-field-add')),
      input: () => document.querySelector('.list-item-editor input'),
      done: async () => {
        await act(async () => root.unmount());
      },
    };
  };

  // --- a list of rows -------------------------------------------------------------
  {
    const mounted = await mount('["Designer", "Developer", "Producer"]');
    check('one row per item', mounted.rows().length === 3, String(mounted.rows().length));
    check('showing what is in it', mounted.labels().join() === 'Designer,Developer,Producer', mounted.labels().join());
    await mounted.done();
  }

  // --- clicking one to open it ------------------------------------------------------
  {
    const mounted = await mount('["Designer", "Developer"]');
    await mounted.press(mounted.host.querySelectorAll('.list-field-text')[1]);
    check('a row opens a popup', !!mounted.popup(), mounted.host.innerHTML.slice(0, 200));
    check('with one field, called what a word is', mounted.fieldNames().join() === 'value', mounted.fieldNames().join());
    await mounted.typeInto('Engineer');
    check('typing shows on the canvas as it goes', mounted.wrote.pop() === '["Designer", "Engineer"]', JSON.stringify(mounted.wrote));
    check('but not as the edit yet', mounted.immediate.pop() === false, JSON.stringify(mounted.immediate));
    await mounted.clickAway();
    check('closing it is the edit', mounted.immediate.pop() === true, JSON.stringify(mounted.immediate));
    check('and the popup is gone', !mounted.popup());
    await mounted.done();
  }

  // An active trigger toggles closed after edits, without reopening on click.
  {
    const mounted = await mount('["inherit", "light"]');
    const trigger = () => mounted.host.querySelector('.list-field-text');
    await mounted.press(trigger());
    check('active row is expanded', trigger().getAttribute('aria-expanded') === 'true');
    await mounted.typeInto('brand');
    const writesBeforeClose = mounted.wrote.length;
    await mounted.press(trigger());
    check('pressing the active row closes it', !mounted.popup());
    check('closing commits once', mounted.wrote.length === writesBeforeClose + 1);
    check('closing retains edits', mounted.wrote.at(-1) === '["brand", "light"]');
    check('closed row is collapsed', trigger().getAttribute('aria-expanded') === 'false');
    await mounted.press(trigger());
    check('the row can reopen', mounted.input()?.value === 'brand');
    await mounted.press(mounted.host.querySelectorAll('.list-field-text')[1]);
    check('another row opens its own value', mounted.input()?.value === 'light');
    await act(async () => mounted.host.querySelectorAll('.list-field-text')[1].click());
    check('keyboard-style activation also toggles closed', !mounted.popup());
    await mounted.add();
    await mounted.typeInto('dark');
    await mounted.add();
    check('the add trigger closes and retains its pending item', !mounted.popup());
    check('pending item is added once', mounted.wrote.at(-1) === '["brand", "light", "dark"]');
    await mounted.done();
  }

  // An item with several fields is what the popup is for: a row cannot show
  // two things beside its own name.
  {
    const mounted = await mount('[{ value: "us", label: "United States" }, { value: "ca", label: "Canada" }]');
    check('a row per object', mounted.rows().length === 2, String(mounted.rows().length));
    check('named by the field a person reads', mounted.labels().join() === 'United States,Canada', mounted.labels().join());
    await mounted.press(mounted.host.querySelectorAll('.list-field-text')[1]);
    check('and its fields are the object’s own', mounted.fieldNames().join() === 'value,label', mounted.fieldNames().join());
    await mounted.typeInto('mx', 0);
    await mounted.typeInto('Mexico', 1);
    check(
      'each one writes its own key',
      mounted.wrote.pop() === '[{ value: "us", label: "United States" }, { value: "mx", label: "Mexico" }]',
      JSON.stringify(mounted.wrote.slice(-2)),
    );
    await mounted.done();
  }

  // An item emptied is an item left empty — a word with nothing in it still
  // takes its place in the array, and the bin is how a row is removed.
  {
    const mounted = await mount('["Designer", "Developer"]');
    await mounted.press(mounted.host.querySelector('.list-field-text'));
    await mounted.typeInto('');
    check('an emptied word is written as one', mounted.wrote.pop() === '["", "Developer"]', JSON.stringify(mounted.wrote));
    await mounted.clickAway();
    await mounted.done();
  }

  // --- adding one -------------------------------------------------------------------
  {
    const mounted = await mount('["Designer"]');
    await mounted.add();
    check('the new item opens a popup', !!mounted.popup(), mounted.host.innerHTML.slice(0, 200));
    check('and nothing is written yet', mounted.wrote.length === 0, JSON.stringify(mounted.wrote));
    await mounted.typeInto('Producer');
    check('still nothing while it is being typed', mounted.wrote.length === 0, JSON.stringify(mounted.wrote));
    await mounted.clickAway();
    check('the word is added when the popup closes', mounted.wrote.pop() === '["Designer", "Producer"]', JSON.stringify(mounted.wrote));
    await mounted.done();
  }

  // Added to an empty prop, which is where a list starts.
  {
    const mounted = await mount('');
    check('an unset prop is an empty list', mounted.rows().length === 0, String(mounted.rows().length));
    await mounted.add();
    await mounted.typeInto('First');
    await mounted.clickAway();
    check('and the first item makes the array', mounted.wrote.pop() === '["First"]', JSON.stringify(mounted.wrote));
    await mounted.done();
  }

  // A new item in a list of objects has the same fields, so what it writes is
  // an item the component can read.
  {
    const mounted = await mount('[{ value: "us", label: "United States" }]');
    await mounted.add();
    check('a new item is shaped like the list', mounted.fieldNames().join() === 'value,label', mounted.fieldNames().join());
    await mounted.typeInto('ca', 0);
    await mounted.typeInto('Canada', 1);
    await mounted.clickAway();
    check(
      'and lands as an object',
      mounted.wrote.pop() === '[{ value: "us", label: "United States" }, { value: "ca", label: "Canada" }]',
      JSON.stringify(mounted.wrote),
    );
    await mounted.done();
  }

  // A row added and then left empty is not an item.
  {
    const mounted = await mount('["Designer"]');
    await mounted.add();
    await mounted.clickAway();
    check('an empty new row writes nothing', mounted.wrote.length === 0, JSON.stringify(mounted.wrote));
    await mounted.done();
  }

  // --- dropping one ---------------------------------------------------------------------
  {
    const mounted = await mount('["Designer", "Developer"]');
    await mounted.press(mounted.rows()[0].querySelector('.list-field-remove'));
    check('the bin takes the row out', mounted.wrote.pop() === '["Developer"]', JSON.stringify(mounted.wrote));
    await mounted.done();
  }

  // --- dragging one ---------------------------------------------------------------------
  {
    const mounted = await mount('["a", "b", "c"]');
    await mounted.dragTo(0, 2, 'bottom'); // below the last row: the end of the list
    check('a row dragged to the end goes there', mounted.wrote.pop() === '["b", "c", "a"]', JSON.stringify(mounted.wrote));
    await mounted.done();
  }
  {
    const mounted = await mount('["a", "b", "c"]');
    await mounted.dragTo(2, 0, 'top'); // above the first row: the front
    check('and one dragged to the front', mounted.wrote.pop() === '["c", "a", "b"]', JSON.stringify(mounted.wrote));
    await mounted.done();
  }
  {
    const mounted = await mount('["a", "b", "c"]');
    await mounted.dragTo(0, 0, 'bottom'); // the gap it already fills
    check('a drop where it already sits writes nothing', mounted.wrote.length === 0, JSON.stringify(mounted.wrote));
    await mounted.done();
  }

  // --- an empty one -------------------------------------------------------------------------
  //
  // A list with nothing in it says so by being empty. The Add item button is the
  // whole message; a row above it reading `[]` — the prop's declared default,
  // printed as code — is that message a second time, worse said.
  {
    const mounted = await mount('[]', '[]');
    check('an empty list draws no rows', mounted.rows().length === 0, `${mounted.rows().length} rows`);
    check(
      'and says nothing above the button',
      mounted.host.querySelectorAll('.list-field-empty').length === 0,
      mounted.host.querySelector('.list-field-empty')?.textContent,
    );
    check('the way to fill it is still there', !!mounted.host.querySelector('.list-field-add'), 'no Add item');
    check(
      'and it is the only thing in the box',
      mounted.host.querySelector('.list-field')?.children.length === 1,
      `${mounted.host.querySelector('.list-field')?.children.length} children`,
    );
    await mounted.done();
  }
  {
    // Written with a space in it, or as no default at all: the same nothing.
    for (const spelling of ['[ ]', '', '  ']) {
      const mounted = await mount('[]', spelling);
      check(
        `nothing to say, spelled ${JSON.stringify(spelling)}`,
        mounted.host.querySelectorAll('.list-field-empty').length === 0,
        mounted.host.querySelector('.list-field-empty')?.textContent,
      );
      await mounted.done();
    }
  }
  {
    // A default that fills the list in IS worth saying: empty here does not
    // mean empty on the page.
    const mounted = await mount('[]', '["Pastors"]');
    const note = mounted.host.querySelector('.list-field-empty');
    check('a default that puts something there is still said', note?.textContent === '["Pastors"]', note?.textContent);
    await mounted.done();
  }
  {
    const mounted = await mount('["Designer"]', '[]');
    check('a list with something in it is unaffected', mounted.labels().join() === 'Designer', mounted.labels().join());
    check(
      'and draws no empty note either',
      mounted.host.querySelectorAll('.list-field-empty').length === 0,
      mounted.host.querySelector('.list-field-empty')?.textContent,
    );
    await mounted.done();
  }

  // --- the quote the file used ------------------------------------------------------------
  {
    const mounted = await mount("['a', 'b']");
    await mounted.add();
    await mounted.typeInto('c');
    await mounted.clickAway();
    check('a project that writes single quotes keeps them', mounted.wrote.pop() === "['a', 'b', 'c']", JSON.stringify(mounted.wrote));
    await mounted.done();
  }

  // --- and the field it belongs to ----------------------------------------------------------
  // The field and its model, which holds what a value means (PropField.tsx).
  const panel = readSourceGroup(['src/features/props/PropField.tsx', 'src/features/props/propFieldModel.ts']);
  check(
    'an array prop shows the list rather than a code field',
    /type === 'code' && !showExpr && \(value === undefined \|\| arrayItems\(valueText\)\)\)/.test(panel),
    'the list is not reached',
  );
  check(
    'a list is something the control can write, so `{}` is a toggle and not the only way',
    /if \(field\.type === 'code'\) \{\s*return arrayItems\(source\) === undefined;\s*\}/.test(panel),
    'an array would always open as an expression',
  );
  check(
    'and the way back keeps the value',
    new RegExp(/if \(field\.type === 'code' && arrayItems\(source\)\)/.source + / \{\s*return \{ type: 'expr', value: source \};\s*\}/.source).test(panel),
    'coming back from the code editor would drop the prop',
  );
  check('the toggle calls it a list', /field\.type === 'code'\) \{\s*return 'list'/.test(panel));

  // Alone in the box, the button's own top rule would double the box's edge.
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  check(
    'a button alone in the box draws no line above itself',
    /\.list-field-add:first-child\s*\{[^}]*border-top:\s*0/.test(css),
    'the empty box would have two lines across its top',
  );

  if (failures.length) {
    console.error(`\nlist-field: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`list-field: ${checked} passed  [a list of things, as a list of rows]`);
  process.exit(0);
})();
