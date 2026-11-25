// Dismissing the picker without a pick leaves the field exactly as it was: no focus, no write.
//
//   node test/renderer/style/variablePickerDismissFocus.test.js
//
// Goal: a user reported that hovering a few rows of the Color picker and clicking outside put focus (and
// a caret) into the Color field and turned its label blue, as if a value had been set, when the click
// should have taken focus where it landed and applied nothing. Causes this pins: the popup returned focus
// to its anchor whenever it closed with focus on the page body or inside itself, which an outside press
// causes; the previews had been written live into the stylesheet, and restoring an originally UNSET
// property wrote nothing back, so the previewed declaration stayed; and a blur of an untouched field
// committed the text it showed. Now an outside press moves no focus into the field and commits nothing,
// the unset property goes back to unset (a draft is cleared, not overwritten with the displayed default),
// and only Escape or a pick returns focus to the field.
// Method: the real LiveInput (TextField's input) and VariableConnect in jsdom over a fake project: a
// document of declarations, a live write that appends a declaration like the real one, a commit that
// records history, and a clear that removes. Motion is on (the popup exits over 160ms, as for a person)
// and a press does what the browser does after it: focus the target if it takes focus, else the body.
// Cases: an originally unset and an originally set Color, and a Size, each dismissed by an outside press,
// Escape, Tab and a press on another input; an untouched blur; a typed edit then blur, which does commit.

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'variable-picker-dismiss-focus.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { LiveInput } from './src/features/style/LiveTextInput';`,
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
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
            const colour = (name, value) => ({ name, collection: 'Colors', group: '', value, binding: 'var(--' + name + ')', type: 'Color' });
            export async function streamProjectVariables(onAdd) {
              for (const [name, value] of [['c-a', '#ff0000'], ['c-b', '#00ff00'], ['c-c', '#0000ff'], ['c-d', '#ffff00']]) onAdd(colour(name, value));
              for (const [name, value] of [['s-a', '1rem'], ['s-b', '2rem'], ['s-c', '3rem'], ['s-d', '4rem']]) onAdd({ name, collection: 'Sizes', group: '', value, binding: 'var(--' + name + ')', type: 'Size' });
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
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  // Motion on, as for a person: the popup leaves over 160ms, so its focus handling runs after the press.
  dom.window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  });
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  dom.window.requestAnimationFrame = global.requestAnimationFrame;
  dom.window.cancelAnimationFrame = global.cancelAnimationFrame;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.Element.prototype.scrollIntoView = () => {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { LiveInput } = require(bundlePath);
  const mouse = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const keydown = (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  // The project: declarations by property. A live write appends or changes one like the real live edit;
  // a commit records history; a clear removes the declaration.
  const mount = async ({ prop, original }) => {
    const model = { declared: new Map(original === undefined ? [] : [[prop, original]]), history: [] };
    const before = { text: [...model.declared].join(';'), has: model.declared.has(prop) };
    const host = document.createElement('div');
    const outside = document.createElement('div');
    outside.id = 'outside';
    outside.textContent = 'a neutral area';
    const other = document.createElement('input');
    other.id = 'other';
    document.body.append(host, outside, other);
    const root = createRoot(host);
    function Project() {
      const [, tick] = React.useState(0);
      const rerender = () => tick((count) => count + 1);
      return React.createElement(LiveInput, {
        value: model.declared.get(prop) ?? '',
        busy: false,
        placeholder: 'currentColor',
        ariaLabel: prop,
        className: 'u-input',
        prop,
        onCommit: (value) => {
          model.history.push(`commit ${value}`);
          model.declared.set(prop, value);
          rerender();
        },
        onLiveCommit: (value) => {
          model.declared.set(prop, value);
          rerender();
        },
        onClear: () => {
          if (model.declared.has(prop)) {
            model.declared.delete(prop);
            // Clearing a declaration that was the original is a history entry; clearing a live-only one is the draft going.
            if (before.has) {
              model.history.push('clear');
            }
          }
          rerender();
        },
      });
    }
    await act(async () => root.render(React.createElement(Project)));
    await wait(40);
    const open = async () => {
      await act(async () => host.querySelector('.embed-editor_varconnect-dot').dispatchEvent(mouse('click')));
      await wait(60);
    };
    const row = (name) => document.querySelector(`.embed-editor_varpicker-item[data-binding="var(--${name})"]`);
    const hoverRows = async () => {
      // The first three rows the picker offers for this property.
      const rows = [...document.querySelectorAll('.embed-editor_varpicker-item')].slice(0, 3);
      check('the picker offered rows to hover', rows.length === 3, String(rows.length));
      for (const target of rows) {
        await act(async () => target.dispatchEvent(mouse('pointerover')));
        await wait(130);
      }
    };
    // What the browser does with a press: the default action focuses the target if it takes focus, else the body.
    const press = async (target) => {
      await act(async () => {
        target.dispatchEvent(mouse('pointerdown'));
        const notPrevented = target.dispatchEvent(mouse('mousedown'));
        if (notPrevented) {
          if (target.matches('input, textarea, button, [tabindex]')) {
            target.focus();
          } else {
            document.activeElement?.blur?.();
          }
        }
        target.dispatchEvent(mouse('mouseup'));
        target.dispatchEvent(mouse('click'));
      });
      await wait(400);
    };
    const inField = () => host.contains(document.activeElement);
    const same = () => [...model.declared].join(';') === before.text && model.declared.has(prop) === before.has;
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
      outside.remove();
      other.remove();
    };
    return { model, before, host, outside, other, open, row, hoverRows, press, inField, same, done };
  };

  const CASES = [
    { name: 'an unset Color', prop: 'color', original: undefined },
    { name: 'a set Color', prop: 'color', original: 'red' },
    { name: 'an unset Size', prop: 'font-size', original: undefined },
    { name: 'a set Size', prop: 'font-size', original: '1rem' },
  ];
  for (const { name, prop, original } of CASES) {
    // --- A press on a neutral area after hovering rows.
    {
      const view = await mount({ prop, original });
      await view.open();
      await view.hoverRows();
      await view.press(view.outside);
      check(`${name}: an outside press leaves the document as it was`, view.same(), JSON.stringify([...view.model.declared]));
      check(`${name}: and the label state (unset stays unset)`, view.model.declared.has(prop) === view.before.has);
      check(`${name}: no history entry`, view.model.history.length === 0, JSON.stringify(view.model.history));
      check(`${name}: focus is not in the field`, !view.inField(), String(document.activeElement?.className));
      check(
        `${name}: and no caret in its input`,
        document.activeElement === document.body || document.activeElement === view.outside,
        String(document.activeElement?.tagName),
      );
      check(`${name}: the picker closed`, document.querySelector('.embed-editor_varpicker') === null);
      await view.done();
    }
    // --- Escape returns focus to the field and changes nothing.
    {
      const view = await mount({ prop, original });
      await view.open();
      await view.hoverRows();
      await act(async () => keydown(document.querySelector('.embed-editor_varpicker-search'), 'Escape'));
      await wait(400);
      check(`${name}: Escape leaves the document as it was`, view.same(), JSON.stringify([...view.model.declared]));
      check(`${name}: Escape commits nothing`, view.model.history.length === 0, JSON.stringify(view.model.history));
      check(`${name}: Escape returns focus to the field`, view.inField(), String(document.activeElement?.tagName));
      await view.done();
    }
    // --- Tab takes the normal order and commits nothing.
    {
      const view = await mount({ prop, original });
      await view.open();
      await view.hoverRows();
      await act(async () => keydown(document.querySelector('.embed-editor_varpicker-search'), 'Tab'));
      await view.press(view.outside);
      check(`${name}: Tab then a press leaves the document as it was`, view.same(), JSON.stringify([...view.model.declared]));
      check(`${name}: and commits nothing`, view.model.history.length === 0, JSON.stringify(view.model.history));
      await view.done();
    }
    // --- A press on another input: focus lands there, and nothing is written.
    {
      const view = await mount({ prop, original });
      await view.open();
      await view.hoverRows();
      await view.press(view.other);
      check(`${name}: a press on another input focuses it`, document.activeElement === view.other, String(document.activeElement?.tagName));
      check(`${name}: and writes nothing`, view.same() && view.model.history.length === 0, JSON.stringify([...view.model.declared]));
      await view.done();
    }
  }

  // --- A blur of an untouched field showing its default never commits.
  for (const { name, prop, original } of CASES) {
    const view = await mount({ prop, original });
    const input = view.host.querySelector('input.u-input');
    await act(async () => input.focus());
    await act(async () => input.blur());
    await wait(60);
    check(`${name}: blurring an untouched field commits nothing`, view.model.history.length === 0 && view.same(), JSON.stringify(view.model.history));
    await view.done();
  }

  // --- A typed edit then blur does commit.
  {
    const view = await mount({ prop: 'color', original: undefined });
    const input = view.host.querySelector('input.u-input');
    await act(async () => input.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'tomato');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => input.blur());
    await wait(60);
    check(
      'a typed edit then blur commits it',
      view.model.history.includes('commit tomato') && view.model.declared.get('color') === 'tomato',
      JSON.stringify(view.model.history),
    );
    await view.done();
  }

  if (failures.length > 0) {
    console.error(`variablePickerDismissFocus: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`variablePickerDismissFocus: ${checked} checks passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
