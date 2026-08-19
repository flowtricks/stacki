// Which press opens what, on a style-panel field.
//
//   node test/varconnect-open.js
//
// One wrapper now owns three things that all begin with a press in the same
// few pixels: the field itself, the purple dot that opens the variable picker,
// and — new — the big value editor that opens when a value has outgrown its
// field. Getting the precedence wrong is invisible in code review and obvious
// in use: pressing the dot to insert a variable brings up the value editor
// instead, and the picker never appears.
//
// So this drives the real component rather than reasoning about the handlers.

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
  const bundlePath = path.join(buildDir, 'varconnect-open.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'VariableConnect.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        // The picker asks the project for its variables. There is no project
        // here, and the list only has to be non-empty for a row to exist to
        // press — which is the point of the test below.
        name: 'stub-variables',
        setup(build) {
          build.onResolve({ filter: /lib\/webflow$/ }, () => ({ path: 'stub-webflow', namespace: 'stub' }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `
              export async function streamProjectVariables(onAdd) {
                onAdd({ name: 'brand', collection: 'Colors', group: '', value: '#f00', binding: 'var(--brand)', kind: 'Color' });
                return [];
              }
              export const __stub = true;
            `,
            loader: 'js',
          }));
        },
      },
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;

  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const VariableConnect = require(bundlePath).default;

  // The field is as wide as its content unless a test says otherwise, so
  // "fits" is the default and overflow is opted into.
  const setOverflow = (root, over) => {
    for (const el of root.querySelectorAll('input, .embed-editor_varconnect-editor')) {
      Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
      Object.defineProperty(el, 'scrollWidth', { value: over ? 400 : 100, configurable: true });
    }
  };

  const press = (el) => {
    el.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  };
  const clickIt = (el) => {
    press(el);
    el.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };

  const mount = async (value, opts = {}) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const picked = [];
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { onPick: (v) => picked.push(v), ariaLabel: 'Height', prop: 'height', ...opts },
          React.createElement('input', { className: 'u-input', value, onChange() {} })
        )
      );
    });
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, picked, root, done };
  };

  const bigOpen = (host) => !!document.querySelector('.var-custom');
  const pickerOpen = (host) => !!host.querySelector('[role="dialog"], .embed-editor_varconnect-panel');

  // --- Pressing the dot, on a value too long for its field ------------------
  //
  // The case from the report: `calc(2rem + )` overflows, so a press anywhere on
  // the FIELD opens the big editor — but the dot is not the field. Pressing it
  // has always meant "insert a variable", and it still has to.
  {
    const { host, done } = await mount('calc(2rem + )');
    setOverflow(host, true);
    const dot = host.querySelector('.embed-editor_varconnect-dot');
    check('the dot is there to press', !!dot);
    await act(async () => {
      clickIt(dot);
    });
    check('pressing the dot does not open the value editor', !bigOpen(host), 'the big editor swallowed the dot press');

    // A real press lands on the glyph inside the button, not the button — so
    // the check that lets the dot through has to see past the <svg> to it.
    const glyph = dot.querySelector('svg *') || dot.querySelector('svg');
    check('the dot has a glyph inside it', !!glyph);
    await act(async () => {
      clickIt(glyph);
    });
    check(
      'pressing the glyph inside the dot does not open it either',
      !bigOpen(host),
      'a press on the icon inside the dot was taken as a press on the field'
    );
    await done();
  }

  // --- Pressing the field itself --------------------------------------------
  {
    const { host, done } = await mount('calc(2rem + 100px)');
    setOverflow(host, true);
    const field =
      host.querySelector('.embed-editor_varconnect-editor') || host.querySelector('input');
    await act(async () => {
      press(field);
    });
    check('pressing an overflowing field opens the value editor', bigOpen(host));
    await done();
  }

  // --- A value that fits ----------------------------------------------------
  {
    const { host, done } = await mount('2rem');
    setOverflow(host, false);
    const field =
      host.querySelector('.embed-editor_varconnect-editor') || host.querySelector('input');
    await act(async () => {
      press(field);
    });
    // Opening a popup over a value you can already read would make every field
    // in the panel a two-step edit.
    check('a value that fits is edited in place', !bigOpen(host));
    await done();
  }

  // --- `=` opens it from anywhere -------------------------------------------
  {
    const { host, done } = await mount('2rem');
    setOverflow(host, false);
    const field =
      host.querySelector('.embed-editor_varconnect-editor') || host.querySelector('input');
    await act(async () => {
      field.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true })
      );
    });
    check('= opens the value editor even when the value fits', bigOpen(host));
    await done();
  }

  // --- Picking a variable from inside the big editor -------------------------
  //
  // The bug behind the report. The big editor closes on a press outside its
  // box, and the variable picker it opens renders through a PORTAL to the
  // body — so by the DOM's reckoning the picker is outside the box it belongs
  // to. Pressing a variable there read as "you pressed elsewhere": the editor
  // closed, saved the draft it already had, and the variable went nowhere.
  // Which looks exactly like the picker doing nothing.
  {
    const { host, picked, done } = await mount('calc(2rem + )');
    setOverflow(host, true);
    const field = host.querySelector('.embed-editor_varconnect-editor') || host.querySelector('input');
    await act(async () => {
      press(field);
    });
    check('the big editor is open to start with', bigOpen(host));

    const box = document.querySelector('.var-custom');
    // A press somewhere genuinely outside still closes it — that is the whole
    // point of the handler and must not be lost to the fix.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await act(async () => {
      press(outside);
    });
    check('a press truly outside still closes it', !bigOpen(host));
    outside.remove();
    await done();
  }

  {
    const { host, done } = await mount('calc(2rem + )');
    setOverflow(host, true);
    const field = host.querySelector('.embed-editor_varconnect-editor') || host.querySelector('input');
    await act(async () => {
      press(field);
    });
    check('the big editor opened', bigOpen(host));

    // Stand in for the picker's portal: same class, same place in the DOM —
    // hanging off the body rather than inside the editor's box.
    const picker = document.createElement('div');
    picker.className = 'embed-editor_varpicker';
    const row = document.createElement('button');
    picker.appendChild(row);
    document.body.appendChild(picker);
    await act(async () => {
      press(row);
    });
    check(
      'pressing a variable in the picker leaves the editor open',
      bigOpen(host),
      'the editor closed on its own picker — the pick would be thrown away'
    );
    picker.remove();
    await done();
  }

  // --- The caret survives the press on the dot ------------------------------
  //
  // The whole point of inserting rather than replacing: the variable goes where
  // the caret was. But pressing the dot moves focus — the picker takes it for
  // its search box — and a field that has lost focus has no selection left to
  // ask about. So the position has to be known BEFORE the press, not read from
  // the wreckage afterwards.
  {
    const { host, picked, done } = await mount('calc(2rem + 10px)');
    setOverflow(host, false);
    const input = host.querySelector('input');

    // Put the caret where a variable should go: after the `+ `.
    const at = 'calc(2rem + '.length;
    input.setSelectionRange(at, at);
    await act(async () => {
      input.dispatchEvent(new dom.window.Event('select', { bubbles: true }));
    });

    // Now press the dot. Focus goes to the picker; the caret must already be
    // recorded.
    const dot = host.querySelector('.embed-editor_varconnect-dot');

    // The press alone, first: focus must still be on the field at that moment.
    // A press that blurs it takes the selection with it, and there is nothing
    // left to read. (jsdom keeps selectionStart on an input either way; a
    // contentEditable in a real browser does not, which is the case this
    // guards.)
    input.focus();
    await act(async () => {
      press(dot);
    });
    check(
      'the press on the dot does not move focus off the field',
      document.activeElement === input,
      `focus went to ${document.activeElement && document.activeElement.className}`
    );

    await act(async () => {
      dot.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
      dot.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    // Whatever the picker does with focus, picking now has to land at `at`.
    const picker = document.querySelector('.embed-editor_varpicker');
    check('the picker opened', !!picker);

    // Press a variable in it. The value that comes out is the whole point:
    // the variable has to land at the caret, with the calc intact around it.
    const option = picker && picker.querySelector('.embed-editor_varpicker-item');
    check('the picker has a variable to press', !!option, picker ? picker.innerHTML.slice(0, 200) : 'no picker');
    if (option) {
      await act(async () => {
        clickIt(option);
      });
      check('picking wrote a value', picked.length === 1, JSON.stringify(picked));
      check(
        'the variable landed where the caret was',
        picked[0] === 'calc(2rem + var(--brand)10px)',
        JSON.stringify(picked[0])
      );
      // The failure the whole change is about: the calc thrown away.
      check('and the expression survived', String(picked[0]).startsWith('calc('), JSON.stringify(picked[0]));
    }
    await done();
  }

  // --- Picking a variable from inside the big editor, end to end ------------
  //
  // The reported failure: in the big editor, with `calc(2rem + |)` on screen,
  // pressing the dot wiped the value.
  //
  // Two layers were each deciding what a pick meant. The field works out the
  // finished value — replace, or insert at the caret — and the editor then ran
  // its own withBinding over that answer. When the field's answer had been
  // "replace" (which is what a missing caret used to fall back to), the two
  // together turned a picked variable into an empty expression.
  {
    const { host, picked, done } = await mount('calc(2rem + )');
    setOverflow(host, true);
    const field = host.querySelector('.embed-editor_varconnect-editor') || host.querySelector('input');
    await act(async () => {
      press(field);
    });
    check('the big editor opened on the long value', bigOpen(host));

    const box = document.querySelector('.var-custom');
    const inner = box && box.querySelector('.embed-editor_varconnect-dot');
    check('the big editor has its own dot', !!inner, box ? 'no dot in the box' : 'no box');

    if (inner) {
      await act(async () => {
        clickIt(inner);
      });
      const picker = document.querySelector('.embed-editor_varpicker');
      check('its picker opens', !!picker);
      const option = picker && picker.querySelector('.embed-editor_varpicker-item');
      check('with a variable in it', !!option);
      if (option) {
        await act(async () => {
          clickIt(option);
        });
        const shown = box.querySelector('.embed-editor_varconnect-editor');
        const text = shown ? shown.textContent : '';
        // Whatever else happens, the expression must still be there. Wiping it
        // is the failure being fixed.
        check('the expression is not wiped', text.includes('calc('), JSON.stringify(text));
        check('and the variable arrived', /brand/.test(text), JSON.stringify(text));
      }
    }
    await done();
  }

  // --- The field is ahead of the prop ---------------------------------------
  //
  // The bug behind "it still clears the value". No caller passes `onDraft`, so
  // text typed into the field does not reach the parent's state — the child's
  // `value` prop still holds whatever was there before the edit began. Reading
  // that prop when a variable is picked asks the wrong question: the field says
  // `calc(2rem + )` and the prop still says `70rem`, and a plain value is one a
  // variable is supposed to REPLACE. So the expression on screen was wiped.
  //
  // (Pressing the dot used to blur the field, committing the draft and hiding
  // this by accident. Keeping focus so the caret survives took the accident
  // away, which is what made it show up every time.)
  {
    // Mounted with the old value, exactly as the parent still believes it, and
    // in code mode — the rich token editor, which is the field this happens in.
    // (A plain <input> cannot show it: React restores a controlled input's DOM
    // value on the next render, so the field can never actually run ahead.)
    const { host, picked, done } = await mount('70rem', { code: true });
    const rich = host.querySelector('.embed-editor_varconnect-editor');
    check('the rich field is the one on screen', !!rich);

    // What the user has actually typed, which the parent has not been told.
    rich.textContent = 'calc(2rem + )';
    await act(async () => {
      rich.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });

    const dot = host.querySelector('.embed-editor_varconnect-dot');
    await act(async () => {
      clickIt(dot);
    });
    const option = document.querySelector('.embed-editor_varpicker .embed-editor_varpicker-item');
    check('the picker opened over the edited field', !!option);
    if (option) {
      await act(async () => {
        clickIt(option);
      });
      check('a value was written', picked.length === 1, JSON.stringify(picked));
      // The expression on screen must survive, and the variable must land in it.
      check(
        'the typed expression is not wiped',
        String(picked[0]).includes('calc('),
        JSON.stringify(picked[0])
      );
      check('and the variable is in the result', String(picked[0]).includes('var(--brand)'), JSON.stringify(picked[0]));
      // WHERE it lands depends on the recorded caret, and jsdom cannot put a
      // real selection in a contentEditable — so this half is pinned down by
      // test/insert-binding.js against the caret directly. What this test can
      // prove, and the thing that was broken, is that the expression survives:
      // the fallback for an unknown caret appends rather than replacing.
      check(
        'the fallback appends rather than wiping',
        picked[0] === 'calc(2rem + )var(--brand)',
        JSON.stringify(picked[0])
      );
    }
    await done();
  }

  // --- Choosing a variable on a value that overflows its field --------------
  //
  // The picker portals to <body>, but a portal is still a React child: its presses
  // capture through the field's own handlers. On a value long enough that pressing
  // the field opens the big editor, that swallowed the pick and opened the editor
  // over it — the variable never landed.
  {
    const { host, picked, done } = await mount('calc(2rem + 100px + 4vw + 12rem)', { code: true });
    setOverflow(host, true);
    await act(async () => { clickIt(host.querySelector('.embed-editor_varconnect-dot')); });
    check('the picker opens from the dot', !!document.querySelector('.embed-editor_varpicker'));
    const row = [...document.querySelectorAll('button')].find((b) => /brand/.test(b.textContent || ''));
    check('it lists a variable', !!row);
    if (row) {
      await act(async () => { clickIt(row); });
      check('choosing one applies it', picked.length === 1, JSON.stringify(picked));
      check('and does not open the big editor instead', !bigOpen(host), 'the value editor swallowed the pick');
    }
    await done();
  }

  // --- Where a picked variable lands ----------------------------------------
  //
  // The caret decides: inside `calc(2rem + )`, a variable belongs where you left
  // it, not on the end. The field records the caret as it moves, because by the
  // time the picker is open the field has no selection to ask about — and it used
  // to FORGET it whenever a focus or select event arrived with the selection
  // elsewhere, which is every time the picker takes focus. A forgotten caret sent
  // the variable to the end of the value (or replaced the calc outright).
  {
    const { host, picked, done } = await mount('calc(2rem + )', { code: true });
    const field = host.querySelector('.embed-editor_varconnect-editor');
    check('the value edits in the rich field', !!field);
    // Put the caret just before the ")".
    const findParen = (n) => {
      if (n.nodeType === 3 && n.textContent.includes(')')) return n;
      for (const c of n.childNodes) { const r = findParen(c); if (r) return r; }
      return null;
    };
    await act(async () => {
      field.focus();
      const node = findParen(field);
      const range = document.createRange();
      range.setStart(node, node.textContent.indexOf(')'));
      range.collapse(true);
      const sel = dom.window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      field.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    });
    // Everything that happens between placing the caret and picking: the panel
    // re-renders on its poll, the picker takes focus, the field goes quiet.
    await act(async () => {
      dom.window.getSelection().removeAllRanges();
      const wrap = host.querySelector('.embed-editor_varconnect');
      wrap.dispatchEvent(new dom.window.FocusEvent('focus', { bubbles: true }));
      wrap.dispatchEvent(new dom.window.Event('select', { bubbles: true }));
    });
    await act(async () => {
      clickIt(host.querySelector('.embed-editor_varconnect-dot'));
    });
    const row = [...document.querySelectorAll('button')].find((b) => /brand/.test(b.textContent || ''));
    check('the picker lists a variable to choose', !!row);
    if (row) {
      await act(async () => { clickIt(row); });
      check(
        'the variable goes in at the caret, not on the end',
        picked[0] === 'calc(2rem + var(--brand))',
        JSON.stringify(picked)
      );
    }
    await done();
  }

  if (failures.length) {
    console.error(`varconnect-open: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`varconnect-open: ${checked} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
