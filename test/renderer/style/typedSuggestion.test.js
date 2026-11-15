// Goal: a reference typed in a value field, and the variable picker's own search, offer the names
// that start like the query first; the suggestion list follows the caret wherever a reference is
// being typed (after a chip, an operator, a comma, inside nested calls, at either end), and never
// shows for a number, a unit or a keyword; a typed `(` closes itself around the token after it
// (a chip included) as one undo step.
// Method: the real VariableConnect is bundled with a project of space-1..space-10 and variables whose
// VALUES mention var(--space-7), mounted in jsdom. Typing and caret moves are replayed as the
// browser sends them (text change, selection, input, keyup); waits are bounded polls (waitFor).
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { repoPath, stubSources } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

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
  const bundlePath = path.join(buildDirectory, 'typed-suggestion.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default, connectCustomField } from './src/features/style/VariableConnect';\nexport { PreviewPropContext } from './src/features/style/connectFieldHelpers';\nexport { wheelBelongsTo } from './src/ui/popupScrollLock';\nexport { registerPopupLayer } from './src/ui/popupOwnership';`,
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
                const add = (name, value, group = '') => onAdd({ name, collection: 'src/styles/base.css', group, value, binding: 'var(--' + name + ')', type: 'Size' });
                add('accent', '2rem');
                add('brand', '1rem');
                add('full', '100%');
                add('section-space-nav-overlap', 'clamp(var(--section-space-nav), 1rem, 2rem)');
                add('display-margin-top', 'var(--space-7)', 'display-margin');
                add('display-margin-bottom', 'var(--space-6)', 'display-margin');
                add('h1-margin', 'var(--space-7)');
                for (const number of [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) add('space-' + number, number + 'rem');
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

  const { wheelBelongsTo, PreviewPropContext } = require(bundlePath);
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
    // What the canvas-only preview showed, in order (the value it opened on once taken back): the
    // arrows preview there and in the field, never through the field's own change or onDraft.
    const drafts = [];
    const reached = [];
    await act(async () => {
      root.render(
        React.createElement(
          PreviewPropContext.Provider,
          { value: (prop, next) => drafts.push(next ?? value) },
          React.createElement(
            VariableConnect,
            {
              onPick: (next) => picked.push(next),
              onDraft: (next) => reached.push(next),
              ariaLabel: 'Gap',
              prop: 'row-gap',
              canvasProperty: 'row-gap',
              code: true,
            },
            React.createElement('input', { className: 'u-input', value, onChange: (event) => reached.push(event.target.value) }),
          ),
        ),
      );
    });
    await settle();
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, picked, drafts, reached, done, editor: host.querySelector('.embed-editor_varconnect-editor') };
  };

  const pickerNames = () => [...document.querySelectorAll('.embed-editor_varpicker-item-name')].map((name) => name.textContent);
  const pickerOpen = () => !!document.querySelector('.embed-editor_varpicker');
  const textNodes = (editor) => {
    const walker = document.createTreeWalker(editor, 4);
    const found = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest('[data-chip]')) {
        found.push(node);
      }
    }
    return found;
  };
  const placeCaret = (node, offset) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  // The caret just after the last `--` in the field, as if it had just been typed there.
  const caretAfterDashes = (editor) => {
    let target;
    let offset = 0;
    for (const node of textNodes(editor)) {
      const at = node.data.lastIndexOf('--');
      if (at >= 0) {
        target = node;
        offset = at + 2;
      }
    }
    placeCaret(target, offset);
  };
  const typed = async (editor) => {
    await act(async () => {
      editor.focus();
      editor.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '-' }));
    });
  };
  const caretKey = async (editor, keyName) => {
    await act(async () => {
      editor.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: keyName, bubbles: true }));
    });
  };
  const gone = async () => {
    await settle();
    return !pickerOpen();
  };

  // The project's variables load when a chooser first opens (the app has done so by the time anyone types).
  {
    const { host, done } = await mount('2rem');
    await act(async () => clickIt(host.querySelector('.embed-editor_varconnect-dot')));
    await waitFor({ what: 'the project variables', read: pickerNames, until: (list) => list.length > 0 });
    await done();
  }

  // --- The reported list: names that start with --space- come before every value that mentions it.
  {
    const { editor, done } = await mount('');
    await act(async () => {
      editor.focus();
      caretAtEnd(editor);
    });
    await type(editor, 'calc(--space-');
    const names = await waitFor({ what: 'the suggestion rows', read: pickerNames, until: (list) => list.length > 0 });
    const spaceRows = names.filter((name) => /^\d+$/.test(name));
    check('the typed list holds the ten space rows', spaceRows.length === 10, names.join(','));
    check('and they come first, in natural order', names.slice(0, 10).join() === '1,2,3,4,5,6,7,8,9,10', names.join(','));
    check('the first row is the marked one', document.querySelector('.embed-editor_varpicker-item.is-active')?.textContent.startsWith('1') === true);
    check('rows whose value mentions it follow', names.indexOf('h1-margin') > 9 && names.indexOf('top') > 9, names.join(','));
    await done();
  }

  // --- The picker's own search box ranks the same way, with or without the dashes.
  for (const query of ['--space-', 'space-']) {
    const { host, done } = await mount('2rem');
    await act(async () => clickIt(host.querySelector('.embed-editor_varconnect-dot')));
    await waitFor({ what: 'the picker', read: pickerOpen, until: Boolean });
    const search = document.querySelector('.embed-editor_varpicker-search');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(search, query);
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const names = await waitFor({ what: 'the filtered list', read: pickerNames, until: (list) => list.length > 0 && !list.includes('accent') });
    check(`search ${query}: names first in natural order`, names.slice(0, 10).join() === '1,2,3,4,5,6,7,8,9,10', names.join(','));
    check(`search ${query}: the group holding only value matches is not first`, names[0] === '1', names.join(','));
    await done();
  }

  // --- The list opens wherever the caret is inside a reference being typed.
  for (const [value, label] of [
    ['calc(var(--accent) + --)', 'after a chip and an operator, before )'],
    ['var(--accent) * --', 'after a leading chip, at the end'],
    ['calc(var(--accent) * var(--brand) + --)', 'with several chips'],
    ['calc(clamp(1px, --, 2px))', 'in nested calls after a comma'],
    ['calc(--)', 'right after ('],
    ['--', 'at the start and end of the field'],
    ['calc(1px + --x)', 'a name begun'],
  ]) {
    const { editor, done } = await mount(value);
    await act(async () => editor.focus());
    caretAfterDashes(editor);
    await typed(editor);
    try {
      await waitFor({ what: `the list ${label}`, read: pickerOpen, until: Boolean });
      check(`the list opens ${label}`, true);
    } catch (error) {
      check(`the list opens ${label}`, false, String(error.message));
    }
    await done();
  }
  {
    const { editor, done } = await mount('calc(var(--accent) + --)');
    await act(async () => editor.focus());
    caretAfterDashes(editor);
    await typed(editor);
    await waitFor({ what: 'the list', read: pickerOpen, until: Boolean });
    check('a bare -- lists every variable, ranked', pickerNames().length === 17 && pickerNames()[0] === 'accent', pickerNames().join(','));
    // The caret moves away with an arrow: the list closes. Back onto the reference: it opens.
    const first = textNodes(editor)[0];
    placeCaret(first, 1);
    await caretKey(editor, 'ArrowLeft');
    check('the list closes when the caret leaves the reference', await gone());
    caretAfterDashes(editor);
    await caretKey(editor, 'ArrowRight');
    await waitFor({ what: 'the list on return', read: pickerOpen, until: Boolean });
    check('and opens again when it comes back', pickerOpen());
    await done();
  }
  for (const [value, find, label] of [
    ['calc(2rem + 1px)', 'calc', 'a keyword'],
    ['calc(2rem + 1px)', '2rem', 'a number with its unit'],
    ['calc(var(--accent) + 1px)', '1px', 'a unit after a chip'],
  ]) {
    const { editor, done } = await mount(value);
    await act(async () => editor.focus());
    // The text is coloured in runs ('2' and 'rem' are separate nodes), so walk the runs.
    let remaining =
      textNodes(editor)
        .map((node) => node.data)
        .join('')
        .indexOf(find) + find.length;
    for (const node of textNodes(editor)) {
      if (remaining <= node.data.length) {
        placeCaret(node, remaining);
        break;
      }
      remaining -= node.data.length;
    }
    await typed(editor);
    check(`no list in ${label}`, await gone());
    await done();
  }

  // --- The slot decides: after a colour in color-mix() only a percentage variable is offered.
  {
    const { editor, done } = await mount('color-mix(in srgb, red 10%, transparent --)');
    await act(async () => editor.focus());
    caretAfterDashes(editor);
    await typed(editor);
    const names = await waitFor({ what: 'the percentage rows', read: pickerNames, until: (list) => list.length > 0 });
    check('only the percentage variable is offered after a colour', names.join() === 'full', names.join(','));
    await done();
  }
  {
    const { editor, done } = await mount('color-mix(in --)');
    await act(async () => editor.focus());
    caretAfterDashes(editor);
    await typed(editor);
    check('the colour space slot shows no list and no empty card', await gone());
    await done();
  }

  // --- A typed ( closes itself, around a chip when one follows; one undo step takes it back.
  {
    const { host, editor, reached, done } = await mount('var(--accent)');
    await act(async () => editor.focus());
    const lead = textNodes(editor)[0];
    // In front of the lone chip: type calc, then (.
    await act(async () => {
      lead.data = 'calc';
      placeCaret(lead, 4);
      editor.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'c' }));
    });
    await act(async () => {
      const event = new dom.window.KeyboardEvent('keydown', { key: '(', bubbles: true, cancelable: true });
      editor.dispatchEvent(event);
    });
    const text = editor.textContent.replace(/\u200B/g, '');
    check('the ( wraps the chip', /^calc\(.*accent.*\)$/.test(text), text);
    check('the value is valid CSS', reached.at(-1) === 'calc(var(--accent))', JSON.stringify(reached.at(-1)));
    const caretNode = document.getSelection().anchorNode;
    const chipNode = host.querySelector('[data-chip]');
    check(
      'the caret is after the chip, before the new )',
      !!(chipNode.compareDocumentPosition(caretNode) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) && !chipNode.contains(caretNode),
    );
    check('the chip is still one chip', host.querySelectorAll('[data-chip]').length === 1);
    await act(async () => {
      editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
    });
    check(
      'one undo takes the whole auto-close back',
      reached.at(-1) === 'calcvar(--accent)' || reached.at(-1) === 'var(--accent)',
      JSON.stringify(reached.at(-1)),
    );
    await act(async () => {
      editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    check('after undo the caret is inside the field', editor.contains(document.getSelection().anchorNode));
    check('redo puts it back as one step', reached.at(-1) === 'calc(var(--accent))', JSON.stringify(reached.at(-1)));
    await done();
  }

  if (failures.length) {
    console.error(`typed-suggestion: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`typed-suggestion: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
