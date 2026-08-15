// The variables sheet, mounted over a real stylesheet.
//
//   node test/vars-view.js [projectDir]
//
// The model decides what the tables are (see test/css-vars.js); this checks the
// sheet actually draws them — a header per column, a row per name, a swatch
// where a value resolves to a colour — and that typing a new value into a cell
// writes it to the file it came from and nothing else.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cssVars = require('../electron/cssVars.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const STYLESHEET = `/* ==========================================================================
   Tokens
   ========================================================================== */

:root {
  /* Swatches */
  --light-100: #ffffff;
  --dark-900: #1f1d1e;
  --brand-500: #c6fb50;

  /* Fluid */
  --too-steep: clamp(var(--too-steep-min) / 16 * 1rem, ((var(--too-steep-min) - ((var(--too-steep-max) - var(--too-steep-min)) / (1440 - 320) * 320)) / 16 * 1rem + ((var(--too-steep-max) - var(--too-steep-min)) / (1440 - 320)) * 100vw), var(--too-steep-max) / 16 * 1rem);
  --too-steep-min: 16;
  --too-steep-max: 64;
  --no-rem: clamp(1rem, 0rem + 2vw, 2rem);
  --fine: clamp(1rem, 0.5rem + 1vw, 2rem);

  /* Heading styles */
  --h1: clamp(var(--h1-min) * 1rem, calc(1rem + var(--h1-min) * 1vw), var(--h1-max) * 1rem);
  --h1-line-height: 1;
  --h1-margin-top: 2rem;
  --h2: 2rem;
  --h2-line-height: 1.1;
  --h2-margin-top: 1.5rem;
}

:root,
.theme-light {
  --background: var(--light-100);
  --text: var(--dark-900);
  --selection-background: var(--text);
  --selection-text: var(--background);
}

.theme-dark {
  --background: var(--dark-900);
  --text: var(--light-100);
  --selection-background: var(--text);
  --selection-text: var(--background);
}
`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-vars-'));
  fs.mkdirSync(path.join(dir, 'src', 'styles'), { recursive: true });
  const file = path.join(dir, 'src', 'styles', 'tokens.css');
  fs.writeFileSync(file, STYLESHEET);

  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'vars-view.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'VariablesView.jsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // The reorder hook asks whether an event target is an Element, and jsdom's
  // classes only live on its window.
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;

  const toasts = [];
  dom.window.avb = {
    cssVariables: async () => cssVars.readVariables(dir),
    addCssVariables: async ({ adds }) => {
      let last = { ok: true };
      for (const a of adds) last = cssVars.addVariable(dir, a);
      return last;
    },
    setCssVariable: async ({ projectPath, ...edit }) => cssVars.setVariable(dir, edit),
    moveCssVariables: async ({ moves }) => {
      let last = { ok: true };
      // The same split the main process makes: a group carries names, a row
      // does not.
      for (const move of moves) {
        last = move.names ? cssVars.moveSection(dir, move) : cssVars.moveVariable(dir, move);
      }
      return last;
    },
    onCssChanged: () => () => {},
    // What the style panel's variable picker reads. The sheet borrows that
    // control for its fields, so the chip only resolves if this answers.
    listStyleFiles: async () => ({ files: [{ path: file, rel: 'src/styles/tokens.css', name: 'tokens.css' }] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    readStyleFile: async () => ({ css: fs.readFileSync(file, 'utf8') }),
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const VariablesView = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const all = (selector) => [...container.querySelectorAll(selector)];
  const find = (selector) => container.querySelector(selector);
  const texts = (selector) => all(selector).map((n) => n.textContent);
  // The name cell carries a glyph whose <title> is part of its text.
  const rowNames = () => all('.vars-name-text').map((n) => n.textContent);

  const show = async (index) =>
    act(async () => {
      reactRoot.render(
        React.createElement(VariablesView, {
          project: { path: dir },
          selected: { file: 'src/styles/tokens.css', index },
          hidden: false,
          onClose: () => {},
          showToast: (m) => toasts.push(m),
        })
      );
      await settle(40);
    });

  // --- the :root group: a comment section and a family table ----------------
  await show(0);
  check('the sheet renders', !!find('.vars-table'), container.innerHTML.slice(0, 200));
  check('a comment becomes a heading', texts('.vars-section').includes('Swatches'), texts('.vars-section').join());
  check('swatch names are rows', rowNames().includes('light-100'), rowNames().join('|'));
  check('a colour gets a swatch', all('.u-color-swatch').length >= 3, `${all('.u-color-swatch').length}`);
  check(
    'the swatch is the colour it resolves to',
    all('.u-color-swatch-fill').some((n) => /255, 255, 255|#ffffff/.test(n.getAttribute('style') || '')),
    all('.u-color-swatch-fill').map((n) => n.getAttribute('style')).join(' | ')
  );
  check(
    'the swatch is beside the field, not inside it',
    all('.var-cell').every((cell) => !cell.querySelector('input .u-color-swatch'))
  );
  check(
    'a value is a field, not a button',
    all('input.var-input').length > 0 && all('.var-token').length === 0,
    `${all('input.var-input').length} fields`
  );
  check(
    'a colour row carries the colour glyph',
    all('.vars-name svg title').some((n) => n.textContent === 'Colour'),
    all('.vars-name svg title').map((n) => n.textContent).join('|')
  );
  check(
    'a unitless number carries the number glyph',
    all('.vars-name svg title').some((n) => n.textContent === 'Number'),
    all('.vars-name svg title').map((n) => n.textContent).join('|')
  );

  const headingTable = all('.vars-table').find((t) => t.textContent.includes('Heading styles'));
  check('a family becomes a table', !!headingTable);
  check(
    'with a column per heading',
    headingTable && /h1/.test(headingTable.textContent) && /h2/.test(headingTable.textContent)
  );
  check(
    'and the shared properties as rows',
    headingTable && ['value', 'line-height', 'margin-top'].every((r) => headingTable.textContent.includes(r)),
    headingTable?.textContent
  );

  // --- fluid values a reader cannot enlarge ---------------------------------
  {
    const badgeFor = (name) => {
      const row = all('.vars-fixed .vars-name-text').findIndex((n) => n.textContent === name);
      if (row < 0) return null;
      const table = all('.vars-fixed .vars-name-text')[row].closest('.vars-table');
      const at = [...table.querySelectorAll('.vars-fixed .vars-name-text')].findIndex((n) => n.textContent === name);
      const valueRows = table.querySelectorAll('.vars-scroll .vars-row:not(.is-head):not(.vars-section)');
      return valueRows[at]?.querySelector('.fluid-badge') || null;
    };

    const steep = badgeFor('too-steep');
    check('a scale steeper than 2.5x is flagged', !!steep, 'no badge');
    check('as an error', steep?.classList.contains('is-error'), steep?.className);
    check(
      'saying what is wrong, in the words the rule uses',
      /does not reach 2x of its original size at a 500% zoom/i.test(steep?.getAttribute('aria-label') || ''),
      steep?.getAttribute('aria-label')
    );
    // The message is drawn on the document, not inside the scrolling column
    // that would crop it.
    await act(async () => {
      // React synthesises enter/leave from the bubbling pair, so that is what a
      // pointer arriving actually looks like to it.
      steep.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      await settle(20);
    });
    const tip = dom.window.document.querySelector('body > .fluid-tip');
    check('and showing it outside the scroller', !!tip, 'the message is inside the column');
    check(
      'with the whole message in it',
      /reduce difference between max and min variable size/i.test(tip?.textContent || ''),
      tip?.textContent
    );
    check('and a way to read why', /read why/i.test(tip?.textContent || ''));
    await act(async () => {
      steep.dispatchEvent(
        new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.body })
      );
      await settle(20);
    });
    check('it goes away again', !dom.window.document.querySelector('body > .fluid-tip'));
    check('and linking to why', steep?.getAttribute('href')?.includes('smashingmagazine.com'), steep?.getAttribute('href'));

    const flat = badgeFor('no-rem');
    check('a value with no rem part is flagged', !!flat);
    check('as a warning', flat?.classList.contains('is-warning'), flat?.className);
    check(
      'with its own words',
      /shrinks when increasing zoom/i.test(flat?.getAttribute('aria-label') || ''),
      flat?.getAttribute('aria-label')
    );
    check('shown on focus too, not only hover', typeof flat?.onfocus !== 'undefined');
    check('and reachable from the keyboard', flat?.getAttribute('tabindex') === '0');

    check('a value that passes gets nothing', !badgeFor('fine'));
    check('and neither does a plain value', !badgeFor('light-100'));

    // Typing into a variable the clamp references re-checks it on the
    // keystroke, without saving anything.
    const table = all('.vars-fixed .vars-name-text')
      .find((n) => n.textContent === 'too-steep')
      .closest('.vars-table');
    const minInput = [...table.querySelectorAll('input.var-input')].find((n) => n.value === '16');
    check('the value it depends on is in the same table', !!minInput, 'no field holding the minimum');

    // Typed where it is actually typed: the rich field over the input. It
    // commits on blur, so a badge watching the value only moves with the
    // keystroke if the field says what it holds as it holds it.
    const rich = minInput.closest('.var-cell').querySelector('.embed-editor_varconnect-editor');
    check('the field being typed into is the rich one', !!rich, 'no editor over the input');

    const before = fs.readFileSync(file, 'utf8');
    const type = async (text) =>
      act(async () => {
        rich.textContent = text;
        rich.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        await settle(30);
      });

    await type('40');
    check('raising it clears the error as it is typed', !badgeFor('too-steep'), 'the badge is still there');
    check('and nothing has been written yet', fs.readFileSync(file, 'utf8') === before);

    await type('16');
    check('typing it back brings the error back', !!badgeFor('too-steep'));
  }

  // --- a value too long for its column opens in the bigger editor ------------
  {
    // Long values are usually full of references, and a value with a reference
    // is drawn by the token editor with the real input hidden behind it. Wait
    // for that to happen, so the press lands where it lands in the app.
    await act(async () => settle(400));
    // The one built out of variables — the fixture has other clamps now, and
    // this case is about the chips inside a long value.
    const long = all('input.var-input').find((n) => n.value.includes('var(--h1-min)'));
    check('the long value is in the sheet', !!long, all('input.var-input').map((n) => n.value).join(' | '));
    const cell = long.closest('.var-cell');
    check(
      'and it is drawn as a chip, with the field behind it',
      !!cell.querySelector('[data-chip]'),
      cell.innerHTML.slice(0, 200)
    );
    check('nothing is open yet', !dom.window.document.querySelector('.var-custom'));

    // Pressing the CHIP of a value too long to read opens the value, not the
    // variable picker — and only one of them. Cancelling the browser's default
    // is not enough to stop the chip's own handler; the press has to be
    // stopped where it is caught, or both open at once and fight for the space.
    await act(async () => {
      cell.querySelector('[data-chip]').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await settle(40);
    });
    check('pressing its chip opens the value', !!dom.window.document.querySelector('.var-custom'));
    check('and not the variable picker as well', !dom.window.document.querySelector('.embed-editor_varpicker'));
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(40);
    });
    check('closed again', !dom.window.document.querySelector('.var-custom'));
    await act(async () => {
      // Pressing on the token editor, which is what is actually under the
      // pointer — not the hidden input.
      const editor = cell.querySelector('.embed-editor_varconnect-editor') || long;
      editor.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      await settle(40);
    });
    const box = dom.window.document.querySelector('.var-custom');
    check('pressing it opens the custom value editor', !!box);
    check('titled as such', box?.textContent.includes('Custom value'));
    check('naming the variable', box?.textContent.includes('--h1'), box?.textContent);
    const area = box?.querySelector('.var-custom-input');
    check('with the whole value in it', area?.value === long.value, area?.value);
    // Every variable in the expression is a chip, not just the first one.
    await act(async () => settle(300));
    const chips = [...box.querySelectorAll('[data-chip]')];
    check('every reference in it is a chip', chips.length === 3, `${chips.length} chips`);
    check(
      'each named after the variable it stands for',
      chips.map((c) => c.textContent.trim()).join(',') === 'h1-min,h1-min,h1-max',
      chips.map((c) => c.textContent.trim()).join(',')
    );
    check(
      'and each remembers its own',
      chips.map((c) => c.dataset.binding).join(',') === 'var(--h1-min),var(--h1-min),var(--h1-max)',
      chips.map((c) => c.dataset.binding).join(',')
    );

    // Editing there writes the file, the same as editing in place.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, 'clamp(2rem, 5vw, 5rem)');
      area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      area.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle(80);
    });
    check('Enter saves it', fs.readFileSync(file, 'utf8').includes('--h1: clamp(2rem, 5vw, 5rem);'), fs.readFileSync(file, 'utf8').slice(200, 420));
    check('and closes the editor', !dom.window.document.querySelector('.var-custom'));

    // "=" opens it on any field, however short the value.
    const short = all('input.var-input').find((n) => n.value === '1');
    await act(async () => {
      short.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '=', bubbles: true }));
      await settle(40);
    });
    check('pressing = opens it on a short value too', !!dom.window.document.querySelector('.var-custom'));
    // Opened to be edited, so the caret is already in it — and in the field
    // that is actually visible, not the input behind it.
    const opened = dom.window.document.querySelector('.var-custom');
    // The focus is set a tick after the box mounts (see CustomValue), so let
    // that tick happen before asking where it went.
    await act(async () => settle(40));
    check(
      'and it arrives focused',
      opened?.contains(dom.window.document.activeElement),
      dom.window.document.activeElement?.className
    );
    check(
      'in the field, not the value carrier behind it',
      dom.window.document.activeElement?.classList.contains('embed-editor_varconnect-editor'),
      dom.window.document.activeElement?.className
    );

    // Nothing behind it moves while it is open: the box is anchored to the cell
    // it came from, and a panel scrolling underneath would slide that cell away.
    {
      const outside = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
      find('.vars-body').dispatchEvent(outside);
      check('a scroll behind the box is refused', outside.defaultPrevented);
      const inside = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
      dom.window.document.querySelector('.var-custom .embed-editor_varconnect-editor').dispatchEvent(inside);
      check('and a scroll inside it is not', !inside.defaultPrevented);
    }

    // Opening another closes this one — one box at a time, whichever cell it
    // belongs to.
    {
      const other = all('.var-cell').filter((c) => c.querySelector('.embed-editor_varconnect-editor')).pop();
      await act(async () => {
        other.querySelector('.embed-editor_varconnect-editor')
          .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '=', bubbles: true }));
        await settle(60);
      });
      check(
        'opening another leaves only one open',
        dom.window.document.querySelectorAll('.var-custom').length === 1,
        `${dom.window.document.querySelectorAll('.var-custom').length} boxes`
      );
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle(40);
      });
    }
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(40);
    });
    check('and Escape closes it without writing', !dom.window.document.querySelector('.var-custom'));
    check('leaving the value alone', fs.readFileSync(file, 'utf8').includes('--h1-line-height: 1;'));

    // What decides is whether the value FITS, not how many characters it has.
    // A value drawn with a chip in it runs wider than its own text, so counting
    // characters called cells readable when they were showing half an
    // expression. Layout is the authority wherever there is layout to read.
    const editing = all('.var-cell').find((c) => c.querySelector('.embed-editor_varconnect-editor'));
    const field = editing?.querySelector('.embed-editor_varconnect-editor');
    check('the cells are fields that can be measured', !!field);
    if (field) {
      // jsdom lays nothing out, so the widths are staged by hand — the reading
      // a browser gives for a value overflowing its column.
      Object.defineProperty(field, 'clientWidth', { value: 120, configurable: true });
      Object.defineProperty(field, 'scrollWidth', { value: 260, configurable: true });
      await act(async () => {
        field.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
        await settle(40);
      });
      check('a value wider than its field opens, however short its text', !!dom.window.document.querySelector('.var-custom'));
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settle(40);
      });
      // And the reverse: one that fits is edited where it is.
      Object.defineProperty(field, 'scrollWidth', { value: 100, configurable: true });
      await act(async () => {
        field.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
        await settle(40);
      });
      check('a value that fits is edited in place', !dom.window.document.querySelector('.var-custom'));
    }
  }

  // --- focus belongs to the field you can see -------------------------------
  {
    // The rich field tells the input's own handlers when it takes focus, and
    // one of those selects the input's text — which focuses the input. That put
    // the caret in the hidden element behind every cell: the value looked
    // clickable and nothing typed into it.
    const cell = all('.var-cell').find((c) => c.querySelector('.embed-editor_varconnect-editor'));
    const editor = cell?.querySelector('.embed-editor_varconnect-editor');
    check('a cell is a rich field', !!editor);
    await act(async () => {
      editor.focus();
      await settle(40);
    });
    check(
      'focusing it leaves the focus there',
      dom.window.document.activeElement === editor,
      dom.window.document.activeElement?.className
    );
  }

  // --- editing a cell writes the file ---------------------------------------
  {
    const before = fs.readFileSync(file, 'utf8');
    const input = all('input.var-input').find((n) => n.value === '#c6fb50');
    check('the value is in a field, ready to type in', !!input);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '#00ff00');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
      await settle(80);
    });
    const after = fs.readFileSync(file, 'utf8');
    check('the file has the new value', after.includes('--brand-500: #00ff00;'), after.slice(0, 300));
    check(
      'and one line changed',
      before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length === 1
    );
    check('nothing was reported to the user', toasts.length === 0, toasts.join());
  }

  // --- dragging a row moves the declaration ---------------------------------
  {
    // Names and values are two stacks; the grip and the gesture are on the
    // name side, so that is the row a drag starts from.
    const rows = all('.vars-fixed .vars-row:not(.is-head):not(.vars-section):not(.vars-add)');
    check('rows are elements, so a row can be hovered as one', rows.length > 3, `${rows.length}`);
    check(
      'each has a grip to drag it by',
      rows.every((row) => row.querySelector('.vars-grip')),
      `${rows.length} rows`
    );

    // The Swatches section: light-100, dark-900, brand-500. Drag the last one
    // to the top.
    const swatchRows = [...all('.vars-table')]
      .find((t) => t.textContent.includes('Swatches'))
      .querySelectorAll('.vars-fixed .vars-row:not(.is-head):not(.vars-section):not(.vars-add)');
    const grip = swatchRows[2];
    const box = (node, top) => {
      node.getBoundingClientRect = () => ({ top, bottom: top + 24, height: 24, left: 0, right: 300, width: 300 });
    };
    swatchRows.forEach((node, i) => box(node, 100 + i * 24));

    // Pressing and dragging are separate turns: the hook only starts listening
    // for the move once the press has re-rendered.
    await act(async () => {
      grip.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 148 }));
      await settle(10);
    });
    await act(async () => {
      // Past the slop threshold first, so it counts as a drag and not a click.
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientY: 130 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientY: 104 }));
      await settle(10);
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientY: 104 }));
      await settle(90);
    });
    const order = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^\s*--(light|dark|brand)/.test(l))
      .map((l) => l.trim().split(':')[0]);
    check(
      'dragging a row to the top moves its line in the file',
      order[0] === '--brand-500',
      order.join(' ')
    );
    check('and takes nothing else with it', order.length === 3, order.join(' '));
  }

  // --- dragging a group moves everything under its heading -------------------
  {
    // The value side carries an empty counterpart of each heading, to keep the
    // two stacks in step; the real one is on the name side.
    const heads = all('.vars-fixed .vars-section');
    check('group headings are rows with a grip', heads.every((h) => h.querySelector('.vars-grip')));
    // The value side's counterpart has to measure the same as the rows under
    // it, or its rule stops at the edge of the scroller while theirs run the
    // full width of the columns.
    // Each table has its own column count — a matrix brings its own — so the
    // comparison is within a table, not across the sheet.
    const tables = all('.vars-table').filter((t) => t.querySelector('.vars-scroll .vars-section'));
    check(
      'the heading rule runs as wide as the columns do',
      tables.length > 0 &&
        tables.every((table) => {
          const section = table.querySelector('.vars-scroll .vars-section');
          const head = table.querySelector('.vars-scroll .vars-row.is-head');
          return !head || section.style.gridTemplateColumns === head.style.gridTemplateColumns;
        }),
      tables
        .map((t) => {
          const s2 = t.querySelector('.vars-scroll .vars-section')?.style.gridTemplateColumns;
          const h = t.querySelector('.vars-scroll .vars-row.is-head')?.style.gridTemplateColumns;
          return `${s2} vs ${h}`;
        })
        .join(' | ')
    );
    check(
      'and their text starts where the variable names do',
      heads.every((h) => h.querySelector('.vars-section-text')),
      heads.map((h) => h.textContent).join('|')
    );

    // Swatches sits above Heading styles; drag it below.
    const swatches = heads.find((h) => h.textContent.includes('Swatches'));
    const headings = heads.find((h) => h.textContent.includes('Heading styles'));
    const box = (node, top) => {
      node.getBoundingClientRect = () => ({ top, bottom: top + 20, height: 20, left: 0, right: 300, width: 300 });
    };
    box(swatches, 100);
    box(headings, 200);

    await act(async () => {
      swatches.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 106 }));
      await settle(10);
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientY: 150 }));
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientY: 260 }));
      await settle(10);
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientY: 260 }));
      await settle(90);
    });

    const written = fs.readFileSync(file, 'utf8');
    check(
      'the group moves below the one it was dragged past',
      written.indexOf('/* Swatches */') > written.indexOf('/* Heading styles */'),
      written
    );
    check('its heading goes with it', (written.match(/\/\* Swatches \*\//g) || []).length === 1);
    check(
      'and so does every variable under it',
      written.indexOf('--light-100') > written.indexOf('--h1-margin-top'),
      written
    );
  }

  // --- adding a variable to a group ------------------------------------------
  {
    const swatchTable = all('.vars-table').find((t) => t.textContent.includes('Swatches'));
    const addRow = swatchTable.querySelector('.vars-fixed .vars-add');
    check('every group ends with a way to add one', !!addRow, swatchTable.innerHTML.slice(-200));
    check('and it reads as a row', addRow.classList.contains('vars-row'));
    check(
      'the value side leaves that line to the scrollbar',
      !swatchTable.querySelector('.vars-scroll .vars-add'),
      'a counterpart row there pushes the scrollbar a line below the button'
    );
    check(
      'it starts where the names do, not in the middle of the column',
      addRow.querySelector('.vars-add-btn')?.previousElementSibling?.tagName === 'SPAN',
      'the button is not in the name track'
    );

    await act(async () => {
      addRow.querySelector('.vars-add-btn').click();
      await settle(30);
    });
    const input = swatchTable.querySelector('.vars-add-field input');
    check('clicking it asks for a name', !!input);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'mid-500');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle(80);
    });

    const written = fs.readFileSync(file, 'utf8');
    check('the variable is written', written.includes('--mid-500:'), written.slice(0, 300));
    // Landing in the group means landing directly under that group's last
    // variable, wherever the group itself has ended up.
    const lines = written.split('\n').map((l) => l.trim());
    const at = lines.findIndex((l) => l.startsWith('--mid-500'));
    check(
      'under the group it was added to, not at the end of the rule',
      /^--(light|dark|brand)/.test(lines[at - 1] || ''),
      `after: ${lines[at - 1]}`
    );
    check('and it shows up in the sheet', rowNames().includes('mid-500'), rowNames().join('|'));
    check('with an empty value ready to fill in', /--mid-500:\s*;/.test(written), written.slice(0, 300));
  }

  // --- the theme group: modes as columns ------------------------------------
  await show(1);
  check(
    'the modes are columns',
    texts('.vars-head').slice(0, 3).join('|') === 'Name|Theme light|Theme dark',
    texts('.vars-head').join('|')
  );
  check(
    'and the heading is written once, not per section',
    texts('.vars-head').filter((t) => t === 'Name').length === 1,
    texts('.vars-head').join('|')
  );
  check('a name is one row across them', rowNames().includes('background'), rowNames().join('|'));
  check(
    'each mode has its own value',
    all('input.var-input').filter((n) => /light-100|dark-900/.test(n.value)).length >= 2,
    all('input.var-input').map((n) => n.value).join(' | ')
  );
  check('a shared prefix becomes a section', texts('.vars-section').includes('selection'), texts('.vars-section').join());
  // The chip is the style panel's control, rendered inside the field.
  await settle(400);
  check(
    'a reference becomes a purple chip inside the field',
    all('.embed-editor_varconnect-token').length > 0,
    container.querySelector('.embed-editor_varconnect')?.outerHTML?.slice(0, 300)
  );
  check(
    'the chip is named after the variable it points at',
    all('.embed-editor_varconnect-token-name').some((n) => n.textContent === 'light-100'),
    all('.embed-editor_varconnect-token-name').map((n) => n.textContent).join('|')
  );

  // --- search ---------------------------------------------------------------
  await act(async () => {
    const search = find('.vars-search');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, 'selection');
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(30);
  });
  check('search narrows to matching rows', rowNames().join('|') === 'background|text', rowNames().join('|'));

  await act(async () => reactRoot.unmount());
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nvars-view: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`vars-view: ${checked} passed`);
})();
