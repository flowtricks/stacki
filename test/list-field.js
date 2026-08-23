// A prop that takes a list, edited as a list.
//
//   node test/list-field.js
//
// `options={["Designer", "Developer"]}` is a list of things, so the field is a
// list of rows: drag one to reorder, the bin to drop one, the last row to add
// one, and a click to open one. Opening is a popup, because an item is not
// always a single thing — `{ value: "us", label: "United States" }` is a row
// with two fields, and there is no room beside the row's name for either.
//
// Each of those writes the WHOLE array back, because that is what the file
// holds — one value, not a list of values.
//
// The code editor is still one press of `{}` away, and it is the only field
// that can hold an array this cannot show: a spread, an object per item, a name
// standing for a list somewhere else. Those keep the editor rather than being
// flattened into rows (test/array-value.js).

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
  const entry = path.join(buildDir, 'list-field.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as ListField } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'panels', 'ListField.jsx')
    )};\n`
  );
  const bundle = path.join(buildDir, 'list-field.bundle.js');
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
    if (!this.classList.contains('list-field-row')) return { x: 0, y: 0, width: 200, height: 0, top: 0, left: 0, right: 200, bottom: 0 };
    const rows = [...this.parentElement.querySelectorAll('.list-field-row')];
    const top = rows.indexOf(this) * ROW;
    return { x: 0, y: top, width: 200, height: ROW, top, left: 0, right: 200, bottom: top + ROW };
  };

  const mount = async (value) => {
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
            placeholder: '',
            onChange: (text, now) => { wrote.push(text); immediate.push(now); current = text },
          })
        );
      });
    };
    await render();
    const rows = () => [...host.querySelectorAll('.list-field-row')];
    const labels = () => [...host.querySelectorAll('.list-field-text')].map((b) => b.textContent);
    const press = async (el) => {
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      await render();
    };
    // The popup, and its fields by the name the file gives them.
    const popup = () => document.querySelector('.list-item-editor');
    const fieldNames = () => [...document.querySelectorAll('.list-item-field > span')].map((s) => s.textContent);
    const typeInto = async (text, at = 0) => {
      const input = document.querySelectorAll('.list-item-editor input')[at];
      if (!input) return false;
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
        rows()[from].dispatchEvent(
          Object.assign(new dom.window.Event('dragstart', { bubbles: true }), { dataTransfer: dt })
        );
      });
      await act(async () => {
        rows()[to].dispatchEvent(
          Object.assign(new dom.window.Event('dragover', { bubbles: true }), { dataTransfer: dt, clientY })
        );
      });
      await act(async () => {
        rows()[to].dispatchEvent(
          Object.assign(new dom.window.Event('drop', { bubbles: true }), { dataTransfer: dt, clientY })
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
      done: async () => { await act(async () => root.unmount()) },
    };
  };

  // --- a list of rows -------------------------------------------------------------
  {
    const m = await mount('["Designer", "Developer", "Producer"]');
    check('one row per item', m.rows().length === 3, String(m.rows().length));
    check('showing what is in it', m.labels().join() === 'Designer,Developer,Producer', m.labels().join());
    await m.done();
  }

  // --- clicking one to open it ------------------------------------------------------
  {
    const m = await mount('["Designer", "Developer"]');
    await m.press(m.host.querySelectorAll('.list-field-text')[1]);
    check('a row opens a popup', !!m.popup(), m.host.innerHTML.slice(0, 200));
    check('with one field, called what a word is', m.fieldNames().join() === 'value', m.fieldNames().join());
    await m.typeInto('Engineer');
    check('typing shows on the canvas as it goes', m.wrote.pop() === '["Designer", "Engineer"]', JSON.stringify(m.wrote));
    check('but not as the edit yet', m.immediate.pop() === false, JSON.stringify(m.immediate));
    await m.clickAway();
    check('closing it is the edit', m.immediate.pop() === true, JSON.stringify(m.immediate));
    check('and the popup is gone', !m.popup());
    await m.done();
  }

  // An item with several fields is what the popup is for: a row cannot show
  // two things beside its own name.
  {
    const m = await mount('[{ value: "us", label: "United States" }, { value: "ca", label: "Canada" }]');
    check('a row per object', m.rows().length === 2, String(m.rows().length));
    check('named by the field a person reads', m.labels().join() === 'United States,Canada', m.labels().join());
    await m.press(m.host.querySelectorAll('.list-field-text')[1]);
    check('and its fields are the object’s own', m.fieldNames().join() === 'value,label', m.fieldNames().join());
    await m.typeInto('mx', 0);
    await m.typeInto('Mexico', 1);
    check(
      'each one writes its own key',
      m.wrote.pop() === '[{ value: "us", label: "United States" }, { value: "mx", label: "Mexico" }]',
      JSON.stringify(m.wrote.slice(-2))
    );
    await m.done();
  }

  // An item emptied is an item left empty — a word with nothing in it still
  // takes its place in the array, and the bin is how a row is removed.
  {
    const m = await mount('["Designer", "Developer"]');
    await m.press(m.host.querySelector('.list-field-text'));
    await m.typeInto('');
    check('an emptied word is written as one', m.wrote.pop() === '["", "Developer"]', JSON.stringify(m.wrote));
    await m.clickAway();
    await m.done();
  }

  // --- adding one -------------------------------------------------------------------
  {
    const m = await mount('["Designer"]');
    await m.add();
    check('the new item opens a popup', !!m.popup(), m.host.innerHTML.slice(0, 200));
    check('and nothing is written yet', m.wrote.length === 0, JSON.stringify(m.wrote));
    await m.typeInto('Producer');
    check('still nothing while it is being typed', m.wrote.length === 0, JSON.stringify(m.wrote));
    await m.clickAway();
    check('the word is added when the popup closes', m.wrote.pop() === '["Designer", "Producer"]', JSON.stringify(m.wrote));
    await m.done();
  }

  // Added to an empty prop, which is where a list starts.
  {
    const m = await mount('');
    check('an unset prop is an empty list', m.rows().length === 0, String(m.rows().length));
    await m.add();
    await m.typeInto('First');
    await m.clickAway();
    check('and the first item makes the array', m.wrote.pop() === '["First"]', JSON.stringify(m.wrote));
    await m.done();
  }

  // A new item in a list of objects has the same fields, so what it writes is
  // an item the component can read.
  {
    const m = await mount('[{ value: "us", label: "United States" }]');
    await m.add();
    check('a new item is shaped like the list', m.fieldNames().join() === 'value,label', m.fieldNames().join());
    await m.typeInto('ca', 0);
    await m.typeInto('Canada', 1);
    await m.clickAway();
    check(
      'and lands as an object',
      m.wrote.pop() === '[{ value: "us", label: "United States" }, { value: "ca", label: "Canada" }]',
      JSON.stringify(m.wrote)
    );
    await m.done();
  }

  // A row added and then left empty is not an item.
  {
    const m = await mount('["Designer"]');
    await m.add();
    await m.clickAway();
    check('an empty new row writes nothing', m.wrote.length === 0, JSON.stringify(m.wrote));
    await m.done();
  }

  // --- dropping one ---------------------------------------------------------------------
  {
    const m = await mount('["Designer", "Developer"]');
    await m.press(m.rows()[0].querySelector('.list-field-remove'));
    check('the bin takes the row out', m.wrote.pop() === '["Developer"]', JSON.stringify(m.wrote));
    await m.done();
  }

  // --- dragging one ---------------------------------------------------------------------
  {
    const m = await mount('["a", "b", "c"]');
    await m.dragTo(0, 2, 'bottom'); // below the last row: the end of the list
    check('a row dragged to the end goes there', m.wrote.pop() === '["b", "c", "a"]', JSON.stringify(m.wrote));
    await m.done();
  }
  {
    const m = await mount('["a", "b", "c"]');
    await m.dragTo(2, 0, 'top'); // above the first row: the front
    check('and one dragged to the front', m.wrote.pop() === '["c", "a", "b"]', JSON.stringify(m.wrote));
    await m.done();
  }
  {
    const m = await mount('["a", "b", "c"]');
    await m.dragTo(0, 0, 'bottom'); // the gap it already fills
    check('a drop where it already sits writes nothing', m.wrote.length === 0, JSON.stringify(m.wrote));
    await m.done();
  }

  // --- the quote the file used ------------------------------------------------------------
  {
    const m = await mount("['a', 'b']");
    await m.add();
    await m.typeInto('c');
    await m.clickAway();
    check(
      'a project that writes single quotes keeps them',
      m.wrote.pop() === "['a', 'b', 'c']",
      JSON.stringify(m.wrote)
    );
    await m.done();
  }

  // --- and the field it belongs to ----------------------------------------------------------
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx'), 'utf8');
  check(
    'an array prop shows the list rather than a code field',
    /if \(type === 'code' && !showExpr && \(value === undefined \|\| arrayItems\(str\)\)\)/.test(panel),
    'the list is not reached'
  );
  check(
    'a list is something the control can write, so `{}` is a toggle and not the only way',
    /if \(field\.type === 'code'\) return arrayItems\(src\) === null;/.test(panel),
    'an array would always open as an expression'
  );
  check(
    'and the way back keeps the value',
    /if \(field\.type === 'code' && arrayItems\(src\)\) return \{ type: 'expr', value: src \};/.test(panel),
    'coming back from the code editor would drop the prop'
  );
  check('the toggle calls it a list', /field\.type === 'code'\) return 'list'/.test(panel));

  if (failures.length) {
    console.error(`\nlist-field: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`list-field: ${checked} passed  [a list of things, as a list of rows]`);
  process.exit(0);
})();
