// No hover, in any control of the Style panel, ever writes.
//
//   node test/renderer/style/hoverNeverWrites.test.js
//
// Goal: hovering or arrowing through a picker or a dropdown is a look. It is shown in the
// control and on the canvas (the canvas-only preview channel, PreviewPropContext, which
// becomes `avb:hover-style`), and nothing it does reaches a write path: not a field's change
// handler (where every field's live write starts), not onLive / onLiveCommit / liveSetProp,
// not onCommit / setProp, not onDraft. Every way out without a pick puts back exactly what
// was there: the canvas preview is taken back and the control shows its own value again.
// The families, one per way a control reaches the picker or a dropdown:
//   - the Typography fields (LiveTextInput), opened from a chip, and a colour field opened from
//     its computed hint (which never previewed before);
//   - the shared field (components/LiveInput: borders, transitions);
//   - every other wrapped field (SizeKit, PositionSection, ShadowFields, BackgroundKit, ...): a
//     plain input under VariableConnect, with and without a whole property to preview as;
//   - the dropdown hover-scrub (Select), through the real Weight and Font family fields.
// Exits: leaving the list, Escape, Tab, a press outside, the window losing focus, a press in
// the canvas (its click message), the selection changing, and unmounting.
// Method: the real components in jsdom over a stubbed project (three weight variables);
// presses, keys and hovers are dispatched events and animation frames are run by hand, so the
// test is the same on every platform and needs no real pointer.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');

// The most frames or settles one wait may run: a preview that never arrives fails, not hangs.
const SETTLE_TICKS_MAX = 20;

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/hover-never-writes');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as VariableConnect } from './src/features/style/VariableConnect';
export { LiveInput } from './src/features/style/LiveTextInput';
export { default as SharedLiveInput } from './src/features/style/components/LiveInput';
export { WeightField, FontFamilyField } from './src/features/style/FontFields';
export { PreviewPropContext } from './src/features/style/connectFieldHelpers';
export { getHost, setHost } from './src/features/style/model/host';`,
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
    plugins: [
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
            const weight = (name, value) => ({ name, collection: 'Weights', group: '', value, binding: 'var(--' + name + ')', type: 'Number' });
            const colour = (name, value) => ({ name, collection: 'Colours', group: '', value, binding: 'var(--' + name + ')', type: 'Color' });
            export async function streamProjectVariables(onAdd) {
              for (const [name, value] of [['w-light', '300'], ['w-regular', '400'], ['w-bold', '700']]) onAdd(weight(name, value));
              for (const [name, value] of [['c-ink', '#111111'], ['c-paper', '#ffffff']]) onAdd(colour(name, value));
              return [];
            }
            export async function getProjectFontFamilies() {
              return ['Arial', 'Georgia', 'Inter'];
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
  dom.window.avb = { listAssets: async () => ({ entries: [] }) };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { VariableConnect, LiveInput, SharedLiveInput, WeightField, FontFamilyField, PreviewPropContext, getHost, setHost } = require(bundlePath);
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const mouse = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  const keydown = (target, key, init = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  setHost({ ...getHost(), selectedId: 'node-1' });

  const failures = [];
  let checked = 0;
  const check = (what, condition, detail) => {
    checked += 1;
    if (!condition) {
      failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
    }
  };

  // One mounted control: `writes` logs every write path it reached, `canvas` every preview message.
  const mount = async (render) => {
    const writes = [];
    const canvas = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const previewProp = (prop, value) => canvas.push({ prop: Array.isArray(prop) ? prop.join('+') : prop, value });
    await act(async () => {
      root.render(
        React.createElement(
          PreviewPropContext.Provider,
          { value: previewProp },
          render(
            (name) =>
              (...args) =>
                writes.push(`${name} ${args[0]}`),
          ),
        ),
      );
    });
    await settle();
    let unmounted = false;
    const unmount = async () => {
      if (!unmounted) {
        unmounted = true;
        await act(async () => root.unmount());
        host.remove();
      }
    };
    return { host, writes, canvas, unmount, unmounted: () => unmounted };
  };

  const pickerOpen = () => document.querySelector('.embed-editor_varpicker') !== null;
  const rowOf = (binding) => document.querySelector(`.embed-editor_varpicker-item[data-binding="${binding}"]`);
  const hoverRow = (binding) => act(async () => rowOf(binding)?.dispatchEvent(mouse('pointerover')));
  const search = () => document.querySelector('.embed-editor_varpicker-search');

  // The ways out of an open picker that do not pick.
  const EXITS = {
    'leave the list': () =>
      act(async () => document.querySelector('.embed-editor_varpicker-list')?.dispatchEvent(mouse('pointerout', { relatedTarget: document.body }))),
    Escape: () => act(async () => keydown(search(), 'Escape')),
    Tab: () => act(async () => keydown(search(), 'Tab')),
    'Shift+Tab': () => act(async () => keydown(search(), 'Tab', { shiftKey: true })),
    'a press outside': () =>
      act(async () => {
        document.body.dispatchEvent(mouse('pointerdown'));
        document.body.dispatchEvent(mouse('mousedown'));
        document.activeElement?.blur?.();
      }),
    'the window losing focus': () => act(async () => dom.window.dispatchEvent(new dom.window.Event('blur'))),
    'a press in the canvas': () =>
      act(async () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'avb:click-node', path: '0' } }))),
    'the selection changing': async () => {
      await act(async () => setHost({ ...getHost(), selectedId: 'node-2' }));
      await act(async () => setHost({ ...getHost(), selectedId: 'node-1' }));
    },
  };

  // A picker family: open it, hover two rows, leave by each exit, and hold the rules.
  const pickerFamily = async (label, { render, open, original, canvasProp, hovered }) => {
    for (const [exitName, exit] of [...Object.entries(EXITS), ['unmounting', undefined]]) {
      const view = await mount(render);
      await open(view.host);
      await settle();
      check(`${label}: the picker opens`, pickerOpen());
      await hoverRow(hovered[0]);
      await settle();
      await hoverRow(hovered[1]);
      await settle();
      const shown = view.canvas.filter((message) => message.value !== undefined).map((message) => message.value);
      if (canvasProp === undefined) {
        check(`${label}: a part of a value has nothing to show on the canvas`, view.canvas.length === 0, JSON.stringify(view.canvas));
      } else {
        check(`${label}: the hovered rows show on the canvas`, shown.includes(hovered[1]), JSON.stringify(view.canvas));
        check(
          `${label}: as the field's property`,
          view.canvas.every((message) => message.prop === canvasProp),
          JSON.stringify(view.canvas),
        );
      }
      const chip = view.host.querySelector('[data-chip]')?.getAttribute('data-binding') ?? undefined;
      check(`${label}: the field shows the hovered row`, chip === hovered[1], chip);
      if (exit === undefined) {
        await view.unmount();
      } else {
        await exit();
        await settle();
        await settle();
      }
      const where = `${label}, out by ${exitName}`;
      check(`${where}: nothing reached a write path`, view.writes.length === 0, JSON.stringify(view.writes));
      if (canvasProp !== undefined) {
        check(`${where}: the canvas preview is taken back`, view.canvas.at(-1)?.value === undefined, JSON.stringify(view.canvas));
      }
      if (!view.unmounted()) {
        const after = view.host.querySelector('[data-chip]')?.getAttribute('data-binding') ?? '';
        const text = view.host.querySelector('.embed-editor_varconnect-editor')?.textContent ?? '';
        check(`${where}: the field shows its own value again`, after === original || (original === '' && after === ''), `${after} / ${text}`);
        await act(async () => keydown(document.body, 'Escape'));
        await view.unmount();
        check(`${where}: unmounting after the exit writes nothing`, view.writes.length === 0, JSON.stringify(view.writes));
      }
    }
  };
  const pressChip = (host) => act(async () => host.querySelector('[data-chip]')?.dispatchEvent(mouse('mousedown')));
  const pressHint = (host) => act(async () => host.querySelector('.embed-editor_varconnect-hint button')?.click());
  const WEIGHT_ROWS = ['var(--w-light)', 'var(--w-bold)'];

  // --- The Typography fields (LiveTextInput), opened from the applied variable's chip.
  await pickerFamily('a Typography field', {
    render: (spy) =>
      React.createElement(LiveInput, {
        value: 'var(--w-regular)',
        busy: false,
        ariaLabel: 'Weight',
        className: 'u-input',
        prop: 'font-weight',
        dataProp: 'font-weight',
        onCommit: spy('commit'),
        onLiveCommit: spy('live'),
        onClear: spy('clear'),
      }),
    open: pressChip,
    original: 'var(--w-regular)',
    canvasProp: 'font-weight',
    hovered: WEIGHT_ROWS,
  });

  // --- A colour field with no declaration of its own, opened from its computed hint.
  await pickerFamily('a colour field opened from its hint', {
    render: (spy) =>
      React.createElement(LiveInput, {
        value: '',
        busy: false,
        placeholder: 'var(--c-ink)',
        ariaLabel: 'Color',
        className: 'u-input',
        prop: 'color',
        dataProp: 'color',
        onCommit: spy('commit'),
        onLiveCommit: spy('live'),
        onClear: spy('clear'),
      }),
    open: pressHint,
    original: '',
    canvasProp: 'color',
    hovered: ['var(--c-paper)', 'var(--c-ink)'],
  });

  // --- The shared field (components/LiveInput).
  await pickerFamily('the shared field', {
    render: (spy) =>
      React.createElement(SharedLiveInput, {
        value: 'var(--w-regular)',
        busy: false,
        ariaLabel: 'Width',
        prop: 'font-weight',
        onLive: spy('live'),
        onCommit: spy('commit'),
      }),
    open: pressChip,
    original: 'var(--w-regular)',
    canvasProp: 'font-weight',
    hovered: WEIGHT_ROWS,
  });

  // --- Every other wrapped field: its own change handler is where its live write starts.
  for (const canvasProp of ['font-weight', undefined]) {
    await pickerFamily(canvasProp === undefined ? 'a field that is one part of a value' : 'a field holding a whole value', {
      render: (spy) =>
        React.createElement(
          VariableConnect,
          {
            onPick: spy('pick'),
            onDraft: spy('draft'),
            ariaLabel: 'Value',
            prop: 'font-weight',
            code: true,
            ...(canvasProp === undefined ? {} : { canvasProperty: canvasProp }),
          },
          React.createElement('input', { className: 'u-input', value: 'var(--w-regular)', onChange: spy('change'), onBlur: spy('blur') }),
        ),
      open: pressChip,
      original: 'var(--w-regular)',
      canvasProp,
      hovered: WEIGHT_ROWS,
    });
  }

  // --- The dropdown hover-scrub: a deliberate scrub-to-preview, so it is canvas-only too.
  const fieldProps = (spy, model) => ({
    read: (prop) => model.get(prop),
    busy: false,
    setProp: spy('setProp'),
    clearProp: spy('clearProp'),
    liveSetProp: spy('liveSetProp'),
    onProvenance: () => {},
    onSelectSelector: () => {},
  });
  const declared = (value) => ({
    source: 'selected',
    overridden: false,
    winner: { selectorText: '.card', value, important: false },
    selectedValue: { value, important: false },
    contributors: [],
  });
  const options = () => [...document.querySelectorAll('.u-select-option')];
  for (const [label, Field, prop, value] of [
    ['the Weight dropdown', WeightField, 'font-weight', '500'],
    ['the Font family dropdown', FontFamilyField, 'font-family', 'Arial'],
  ]) {
    for (const exitName of ['leaving the list', 'Escape', 'a press outside', 'unmounting']) {
      const model = new Map([[prop, declared(value)]]);
      const view = await mount((spy) => React.createElement(Field, fieldProps(spy, model)));
      await act(async () => view.host.querySelector('.u-select-button')?.click());
      await settle();
      // Rows that are real values: not the one applied, not Default or Custom.
      const rows = options().filter((row) => /^(300|400|600|700|800|900|Georgia|Inter)\b/.test(row.textContent.trim()));
      check(`${label}: the menu lists other options`, rows.length >= 2, String(rows.length));
      for (const row of rows.slice(0, 2)) {
        await act(async () => row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
        for (let tick = 0; tick < SETTLE_TICKS_MAX && view.canvas.length === 0; tick += 1) {
          await settle();
        }
      }
      check(
        `${label}: the hovered option shows on the canvas`,
        view.canvas.some((message) => message.value !== undefined && message.prop === prop),
        JSON.stringify(view.canvas),
      );
      if (exitName === 'leaving the list') {
        await act(async () =>
          document.querySelector('.u-select-list')?.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })),
        );
      } else if (exitName === 'Escape') {
        await act(async () => keydown(document.activeElement ?? document.body, 'Escape'));
      } else if (exitName === 'a press outside') {
        await act(async () => {
          document.body.dispatchEvent(mouse('pointerdown'));
          document.body.dispatchEvent(mouse('mousedown'));
        });
      } else {
        await view.unmount();
      }
      await settle();
      await settle();
      const where = `${label}, out by ${exitName}`;
      check(`${where}: nothing reached liveSetProp or setProp`, view.writes.length === 0, JSON.stringify(view.writes));
      check(`${where}: the canvas preview is taken back`, view.canvas.at(-1)?.value === undefined, JSON.stringify(view.canvas));
      await view.unmount();
    }
  }

  if (failures.length > 0) {
    console.error(`hoverNeverWrites: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  assert.ok(checked > 0, 'hoverNeverWrites: something was checked');
  console.log(`hoverNeverWrites: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
