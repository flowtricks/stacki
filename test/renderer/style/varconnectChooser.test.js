// The variable chooser's gestures in the real field.
//
//   node test/renderer/style/varconnectChooser.test.js
//
// Goal: the gestures a person uses to change a variable inside a value behave
// as they do in an editor. A pressed chip opens the chooser marked on that
// chip's variable and a pick swaps only that chip; typing `var(--` or `--`
// opens the chooser filtered by the typed name, driven by the field's keys;
// ⌘Z and ⇧⌘Z walk the field's own history; and a wheel over a chooser opened
// from the custom-value box is not refused by the box's scroll lock.
// Method: the real VariableConnect is bundled with a two-variable project and
// mounted in jsdom; typing is replayed as beforeinput, DOM change and input,
// the way the browser sends it. The wheel rule is checked through the popup
// registry the app uses.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { repoPath, stubSources } = require('../../helpers/sources.js');

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
  const bundlePath = path.join(buildDirectory, 'varconnect-chooser.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default, connectCustomField } from './src/features/style/VariableConnect';\nexport { wheelBelongsTo } from './src/ui/popupScrollLock';\nexport { registerPopupLayer } from './src/ui/popupOwnership';`,
      resolveDir: repoPath('.'),
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
    plugins: [
      // The picker asks the project for its variables. There is no project
      // here, and the list only has to be non-empty for a row to exist to
      // press — which is the point of the test below.
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
              export async function streamProjectVariables(onAdd) {
                onAdd({
                  name: 'accent', collection: 'Sizes', group: '', value: '2rem',
                  binding: 'var(--accent)', type: 'Size',
                });
                onAdd({
                  name: 'brand', collection: 'Sizes', group: '', value: '1rem',
                  binding: 'var(--brand)', type: 'Size',
                });
                onAdd({
                  name: 'ink', collection: 'Sizes', group: '', value: '#000',
                  binding: 'var(--ink)', type: 'Color',
                });
                return [];
              }
              export const __stub = true;
            `,
          loader: 'js',
        }),
      }),
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
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

  const { wheelBelongsTo } = require(bundlePath);
  const press = (element) => element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const clickIt = (element) => {
    press(element);
    element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const caretAtEnd = (editor) => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  // Typing as the browser does it: the change is announced, made, then reported.
  const type = async (editor, text) => {
    await act(async () => {
      editor.dispatchEvent(new dom.window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      editor.append(document.createTextNode(text));
      caretAtEnd(editor);
      editor.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    });
  };
  const key = async (target, keyName, init = {}) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));
    });
  };

  const mount = async (value) => {
    const host = document.createElement('div');
    host.className = 'embed-editor_root';
    document.body.appendChild(host);
    const root = createRoot(host);
    const picked = [];
    const drafts = [];
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { onPick: (next) => picked.push(next), onDraft: (next) => drafts.push(next), ariaLabel: 'Gap', prop: 'row-gap', code: true },
          React.createElement('input', { className: 'u-input', value, onChange() {} }),
        ),
      );
    });
    await settle();
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, picked, drafts, done, editor: host.querySelector('.embed-editor_varconnect-editor') };
  };

  // --- A pressed chip opens the chooser on its own variable, and a pick swaps that chip only.
  {
    const { host, picked, done } = await mount('calc(var(--accent) + var(--brand))');
    const chips = host.querySelectorAll('[data-chip]');
    check('both variables are chips', chips.length === 2, String(chips.length));
    await act(async () => press(chips[1]));
    await settle();
    const picker = document.querySelector('.embed-editor_varpicker');
    check('pressing a chip opens the chooser', !!picker);
    const selected = picker?.querySelector('.embed-editor_varpicker-item.is-selected');
    check('the pressed chip’s variable is the one marked', selected?.textContent.includes('brand') === true, selected?.textContent);
    const accent = [...(picker?.querySelectorAll('.embed-editor_varpicker-item') ?? [])].find((item) => item.textContent.includes('accent'));
    await act(async () => clickIt(accent));
    check('the pick swaps the pressed chip and keeps the other', picked[0] === 'calc(var(--accent) + var(--accent))', JSON.stringify(picked));
    await done();
  }

  // --- In the chooser's own search box, ↑ and ↓ move the purple mark and preview
  // each variable in the value; Enter takes it; Escape or a press outside puts
  // the original back.
  for (const ending of ['Enter', 'Escape', 'outside']) {
    const { host, picked, drafts, done } = await mount('calc(var(--brand) + 1rem)');
    await act(async () => press(host.querySelector('[data-chip]')));
    await settle();
    const search = document.querySelector('.embed-editor_varpicker-search');
    check(`${ending}: the chooser has its search box`, !!search);
    const marked = () => document.querySelector('.embed-editor_varpicker-item.is-selected')?.textContent ?? '';
    check(`${ending}: the applied variable is marked on open`, marked().includes('brand'), marked());
    await key(search, 'ArrowUp');
    check(`${ending}: ↑ moves the purple mark to accent`, marked().includes('accent'), marked());
    check(`${ending}: and previews it in the value`, drafts.at(-1) === 'calc(var(--accent) + 1rem)', JSON.stringify(drafts.at(-1)));
    await key(search, 'ArrowUp');
    check(`${ending}: ↑ again wraps to the last row`, marked().includes('brand'), marked());
    await key(search, 'ArrowDown');
    check(`${ending}: ↓ wraps back to accent`, marked().includes('accent'), marked());
    if (ending === 'Enter') {
      await key(search, 'Enter');
      check('Enter applies the previewed variable', picked[0] === 'calc(var(--accent) + 1rem)', JSON.stringify(picked));
    } else {
      if (ending === 'Escape') {
        await key(search, 'Escape');
      } else {
        await act(async () => {
          document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
          document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });
      }
      await settle();
      check(`${ending}: the chooser closes`, !document.querySelector('.embed-editor_varpicker'));
      check(`${ending}: nothing is applied`, picked.length === 0, JSON.stringify(picked));
      check(`${ending}: the original value comes back`, drafts.at(-1) === 'calc(var(--brand) + 1rem)', JSON.stringify(drafts.at(-1)));
    }
    await done();
  }

  // --- While a reference is typed, the field's ↓ moves the marked row.
  {
    const { picked, editor, done } = await mount('');
    await act(async () => {
      editor.focus();
      caretAtEnd(editor);
    });
    await type(editor, 'var(--');
    await settle();
    const marked = () => document.querySelector('.embed-editor_varpicker-item.is-active')?.textContent ?? '';
    check('typing marks the first match', marked().includes('accent'), marked());
    await key(editor, 'ArrowDown');
    check('↓ in the field moves to the next', marked().includes('brand'), marked());
    await key(editor, 'Enter');
    check('Enter takes it', picked.at(-1) === 'var(--brand)', JSON.stringify(picked));
    await done();
  }

  // --- Typing var(-- shows the chooser following the typing; Enter takes the marked row.
  {
    const { picked, editor, done } = await mount('');
    await act(async () => {
      editor.focus();
      caretAtEnd(editor);
    });
    await type(editor, 'calc(');
    check('plain typing shows no chooser', !document.querySelector('.embed-editor_varpicker'));
    await type(editor, 'var(--bra');
    await settle();
    const picker = document.querySelector('.embed-editor_varpicker');
    check('typing var(-- shows the chooser', !!picker);
    check('the chooser has no search box of its own while following typing', !picker?.querySelector('.embed-editor_varpicker-search'));
    const rows = picker ? [...picker.querySelectorAll('.embed-editor_varpicker-item')] : [];
    check('the list is filtered by the typed name', rows.length === 1 && rows[0].textContent.includes('brand'), rows.map((row) => row.textContent).join('|'));
    check('the first match is marked for the keyboard', rows[0]?.classList.contains('is-active') === true);
    await key(editor, 'Enter');
    check('Enter completes the reference', picked.at(-1) === 'calc(var(--brand)', JSON.stringify(picked));
    check('and the chooser closes', !document.querySelector('.embed-editor_varpicker'));
    await done();
  }

  // --- Escape puts the typed suggestions away without changing the value.
  {
    const { picked, editor, done } = await mount('');
    await act(async () => {
      editor.focus();
      caretAtEnd(editor);
    });
    await type(editor, '--');
    await settle();
    check('a bare -- shows the chooser', !!document.querySelector('.embed-editor_varpicker'));
    await key(editor, 'Escape');
    await settle();
    check('Escape closes it', !document.querySelector('.embed-editor_varpicker'));
    check('and picks nothing', picked.length === 0, JSON.stringify(picked));
    await done();
  }

  // --- ⌘Z and ⇧⌘Z walk the field's own history, even after a code repaint.
  {
    const { editor, drafts, done } = await mount('');
    await act(async () => {
      editor.focus();
      caretAtEnd(editor);
    });
    await type(editor, '2rem');
    check('the typing is in the field', editor.textContent.includes('2rem'), editor.textContent);
    await key(editor, 'z', { metaKey: true });
    check('⌘Z takes the typing back', !editor.textContent.includes('2rem'), editor.textContent);
    check('and reports the undone value', drafts.at(-1) === '', JSON.stringify(drafts.at(-1)));
    await key(editor, 'z', { metaKey: true, shiftKey: true });
    check('⇧⌘Z puts it back', editor.textContent.includes('2rem'), editor.textContent);
    const prevented = new dom.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => editor.dispatchEvent(prevented));
    check('the field claims ⌘Z so the page history leaves it alone', prevented.defaultPrevented);
    await done();
  }

  // --- The custom-value box's chooser offers only variables that fit the property.
  {
    const { connectCustomField } = require(bundlePath);
    for (const [prop, wanted, unwanted] of [
      ['row-gap', 'brand', 'ink'],
      ['background-color', 'ink', 'brand'],
    ]) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(connectCustomField(React.createElement('textarea', { value: '', onChange() {} }), prop, () => {}));
      });
      await settle();
      await act(async () => clickIt(host.querySelector('.embed-editor_varconnect-dot')));
      await settle();
      const names = [...document.querySelectorAll('.embed-editor_varpicker-item-name')].map((name) => name.textContent);
      check(`${prop} offers ${wanted}`, names.includes(wanted), names.join(','));
      check(`${prop} never offers ${unwanted}`, !names.includes(unwanted), names.join(','));
      await act(async () => root.unmount());
      host.remove();
    }
  }

  // --- A wheel in a popup opened from the box belongs to the box.
  {
    const { registerPopupLayer } = require(bundlePath);
    const box = document.createElement('div');
    const field = document.createElement('span');
    box.append(field);
    const picker = document.createElement('div');
    const row = document.createElement('button');
    picker.append(row);
    const elsewhere = document.createElement('div');
    document.body.append(box, picker, elsewhere);
    check('a wheel inside the box is its own', wheelBelongsTo(box, field));
    check('a wheel in an unrelated popup is not', !wheelBelongsTo(box, row));
    const unregister = registerPopupLayer(picker, field, { root: 'test', depth: 0 });
    check('a wheel in the chooser opened from the box is the box’s', wheelBelongsTo(box, row));
    check('a wheel on the page is refused', !wheelBelongsTo(box, elsewhere));
    check('no box owns nothing', !wheelBelongsTo(undefined, field));
    unregister();
    check('once the chooser closes it no longer counts', !wheelBelongsTo(box, row));
    box.remove();
    picker.remove();
    elsewhere.remove();
  }

  if (failures.length) {
    console.error(`varconnect-chooser: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`varconnect-chooser: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
