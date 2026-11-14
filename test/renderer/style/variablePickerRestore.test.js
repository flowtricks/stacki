// Leaving the variable picker without a pick always puts the original value back.
//
//   node test/renderer/style/variablePickerRestore.test.js
//
// Goal: the picker previews the hovered variable in the field and on the canvas. A user reported that
// quickly hovering through the list and clicking out without applying sometimes left the last hovered
// value in place. The causes this pins: the press that dismisses the picker also blurs the field, whose
// blur committed what it showed (the preview) before the close, which waits out a 160ms exit motion, put
// the original back; a hover waiting for its frame (or a live edit waiting for its 100ms timer) could
// land after the restore; and a field torn down by the selection changing dropped the restoring edit.
// Now the original is captured once when the picker opens, every way out (a press anywhere including
// the canvas, Escape, Tab, window blur, the canvas's click message, selection change, unmount, the chip
// toggle) runs one idempotent restore ahead of the browser's own focus change, and each preview carries
// an epoch that the restore bumps, so a late preview is dropped.
// Method: the real VariableConnect and LiveInput in jsdom over a fake project: timers and animation
// frames are VIRTUAL (the test advances time), and the canvas is a fake bridge that delays and reorders
// the messages the field sends (a frame applies the newest by sequence number). Named cases pin each
// cause; then a seeded loop of 200 random hover/leave/wait/exit sequences must always end at the
// original, or at the picked value when the sequence picks, in the canvas, the field, the chip and the
// committed value, with the picker closed and no timer left. Events are dispatched, never real input.

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
  const bundlePath = path.join(buildDirectory, 'variable-picker-restore.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as VariableConnect } from './src/features/style/VariableConnect';
        export { default as LiveInput } from './src/features/style/components/LiveInput';
        export { getHost, setHost } from './src/features/style/model/host';`,
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
            const weight = (name, value) => ({ name, collection: 'Weights', group: '', value, binding: 'var(--' + name + ')', type: 'Number' });
            export async function streamProjectVariables(onAdd) {
              for (const [name, value] of [['w-light', '300'], ['w-regular', '400'], ['w-bold', '700'], ['w-black', '900']]) onAdd(weight(name, value));
              return [];
            }
            export const __stub = true;
          `,
          loader: 'js',
        }),
      }),
    ],
  });

  // Virtual time: every timer and frame the code under test sets runs when the test advances the clock.
  const realSetTimeout = setTimeout;
  const clock = { now: 0, sequence: 0, timers: new Map() };
  const virtualSet = (callback, delay = 0) => {
    clock.sequence += 1;
    clock.timers.set(clock.sequence, { at: clock.now + delay, callback, id: clock.sequence });
    return clock.sequence;
  };
  const virtualClear = (id) => clock.timers.delete(id);

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  // Motion on, as for a person: a popup leaves through a 160ms exit before it closes, which is when the
  // press that dismissed it has already blurred the field.
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
  for (const target of [global, dom.window]) {
    target.setTimeout = virtualSet;
    target.clearTimeout = virtualClear;
    target.requestAnimationFrame = (callback) => virtualSet(() => callback(clock.now), 16);
    target.cancelAnimationFrame = virtualClear;
  }
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
  const { VariableConnect, LiveInput, getHost, setHost } = require(bundlePath);
  const mouse = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  const keydown = (target, key) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  // The most timers one advance may run: a loop of timers rescheduling themselves fails here, not by hanging.
  const TIMERS_PER_ADVANCE_MAX = 100000;
  const advance = async (ms) => {
    const target = clock.now + ms;
    for (let ran = 0; ran < TIMERS_PER_ADVANCE_MAX; ran += 1) {
      let next;
      for (const timer of clock.timers.values()) {
        if (timer.at <= target && (next === undefined || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) {
          next = timer;
        }
      }
      if (next === undefined) {
        break;
      }
      clock.timers.delete(next.id);
      clock.now = Math.max(clock.now, next.at);
      await act(async () => {
        next.callback();
      });
    }
    clock.now = target;
    await act(async () => {});
  };

  const ORIGINAL = 'var(--w-regular)';
  const NAMES = ['w-light', 'w-regular', 'w-bold', 'w-black'];

  // The project and the page: the committed value, and a canvas fed by a bridge that delays and reorders.
  const mount = async (random) => {
    const model = { saved: ORIGINAL, commits: [], canvas: ORIGINAL, lastApplied: 0, sent: 0, unmounted: false };
    const post = (value) => {
      model.sent += 1;
      const message = { sequence: model.sent, value };
      // A delay up to 300ms, so a later message can arrive before an earlier one.
      virtualSet(
        () => {
          if (message.sequence > model.lastApplied) {
            model.lastApplied = message.sequence;
            model.canvas = message.value;
          }
        },
        Math.floor(random() * 300),
      );
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    function Project() {
      const [saved, setSaved] = React.useState(ORIGINAL);
      const commit = (value) => {
        model.saved = value;
        model.commits.push(value);
        post(value);
        setSaved(value);
      };
      return React.createElement(LiveInput, {
        value: saved,
        busy: false,
        ariaLabel: 'Weight',
        prop: 'font-weight',
        onLive: (value) => post(value),
        onCommit: commit,
      });
    }
    await act(async () => root.render(React.createElement(Project)));
    await advance(50);
    const chip = () => host.querySelector('[data-chip]');
    const editor = () => host.querySelector('.embed-editor_varconnect-editor');
    const open = async () => {
      // The user was in the field: it holds focus when the chooser opens.
      await act(async () => editor()?.focus());
      await act(async () => chip().dispatchEvent(mouse('mousedown')));
      await advance(50);
    };
    const rowOf = (name) => document.querySelector(`.embed-editor_varpicker-item[data-binding="var(--${name})"]`);
    const hover = (name) => act(async () => rowOf(name)?.dispatchEvent(mouse('pointerover')));
    const leaveList = () =>
      act(async () => document.querySelector('.embed-editor_varpicker-list')?.dispatchEvent(mouse('pointerout', { relatedTarget: document.body })));
    // A press outside: the browser's order is the press, then the focus change it causes.
    const pressOutside = async () => {
      await act(async () => {
        document.body.dispatchEvent(mouse('pointerdown'));
        document.body.dispatchEvent(mouse('mousedown'));
        document.activeElement?.blur?.();
      });
    };
    const field = () => host.querySelector('input.u-input');
    const chipName = () => host.querySelector('.embed-editor_varconnect-token-name')?.textContent;
    const done = async () => {
      model.unmounted = true;
      await act(async () => root.unmount());
      host.remove();
    };
    return { model, host, open, rowOf, hover, leaveList, pressOutside, field, chipName, done, editor, chip, root };
  };

  const settledAt = async (view, expected, label) => {
    await advance(2000);
    check(`${label}: the canvas shows ${expected}`, view.model.canvas === expected, `canvas ${view.model.canvas}`);
    check(
      `${label}: the committed value is ${expected}`,
      view.model.saved === expected,
      `saved ${view.model.saved}, commits ${JSON.stringify(view.model.commits)}`,
    );
    check(`${label}: the picker is closed`, document.querySelector('.embed-editor_varpicker') === null);
    if (!view.model.unmounted) {
      check(`${label}: the field shows ${expected}`, view.field()?.value === expected, view.field()?.value);
      const shown = view.chipName();
      check(`${label}: the chip names it`, shown === undefined || `var(--${shown})` === expected, shown);
    }
    check(`${label}: no timer is left`, clock.timers.size === 0, `${clock.timers.size} left`);
  };
  const flat = () => 0.5;

  // --- A press outside, after the preview reached the canvas: the blur must not commit it.
  {
    const view = await mount(flat);
    await view.open();
    await view.hover('w-bold');
    await advance(400);
    check('the preview reached the canvas', view.model.canvas === 'var(--w-bold)', view.model.canvas);
    await view.pressOutside();
    await settledAt(view, ORIGINAL, 'press outside after a settled preview');
    check(
      'only the original was ever committed',
      view.model.commits.every((value) => value === ORIGINAL),
      JSON.stringify(view.model.commits),
    );
    await view.done();
  }

  // --- Enter A, B, C within one frame, then press outside before any frame: nothing previews at all.
  {
    const view = await mount(flat);
    await view.open();
    await act(async () => {
      for (const name of ['w-light', 'w-bold', 'w-black']) {
        view.rowOf(name).dispatchEvent(mouse('pointerover'));
      }
      document.body.dispatchEvent(mouse('pointerdown'));
    });
    await advance(16);
    await view.pressOutside();
    await settledAt(view, ORIGINAL, 'three hovers then a press before the frame');
    await view.done();
  }

  // --- A preview that was applied, then Escape, Tab, window blur and the canvas's click message.
  for (const exit of ['escape', 'tab', 'window-blur', 'canvas-click']) {
    const view = await mount(flat);
    await view.open();
    await view.hover('w-black');
    await advance(30);
    await act(async () => {
      if (exit === 'escape') {
        keydown(document.querySelector('.embed-editor_varpicker-search'), 'Escape');
      } else if (exit === 'tab') {
        keydown(document.querySelector('.embed-editor_varpicker-search'), 'Tab');
      } else if (exit === 'window-blur') {
        dom.window.dispatchEvent(new dom.window.Event('blur'));
      } else {
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'avb:click-node', path: '0' } }));
      }
    });
    if (exit === 'tab' || exit === 'window-blur' || exit === 'canvas-click') {
      // These do not close the picker themselves; the value is already back, and the chooser is closed by the press that follows.
      check(`${exit}: the field is back at the original at once`, view.field()?.value === ORIGINAL, view.field()?.value);
      await view.pressOutside();
    }
    await settledAt(view, ORIGINAL, `${exit} after a preview`);
    await view.done();
  }

  // --- The selection changing while previewing, and unmounting while previewing.
  {
    const view = await mount(flat);
    await view.open();
    await view.hover('w-light');
    await advance(30);
    await act(async () => setHost({ ...getHost(), selectedId: 'another-node' }));
    check('a selection change restores the field at once', view.field()?.value === ORIGINAL, view.field()?.value);
    await view.pressOutside();
    await settledAt(view, ORIGINAL, 'selection change');
    await view.done();
  }
  {
    const view = await mount(flat);
    await view.open();
    await view.hover('w-light');
    await advance(130);
    await view.done();
    await settledAt(view, ORIGINAL, 'unmount while previewing');
  }

  // --- The chip toggle closes without a pick.
  {
    const view = await mount(flat);
    await view.open();
    await view.hover('w-bold');
    await advance(130);
    await act(async () => view.chip().dispatchEvent(mouse('mousedown')));
    await settledAt(view, ORIGINAL, 'chip toggle');
    await view.done();
  }

  // --- A pick commits the picked value, passing through no original.
  {
    const view = await mount(flat);
    await view.open();
    await view.hover('w-bold');
    await advance(130);
    await act(async () => {
      const row = view.rowOf('w-bold');
      row.dispatchEvent(mouse('pointerdown'));
      row.dispatchEvent(mouse('mousedown'));
      row.dispatchEvent(mouse('click'));
    });
    await settledAt(view, 'var(--w-bold)', 'a pick');
    await view.done();
  }

  // --- Seeded random sequences: 200 of them, each must end at the original or the pick.
  const generator = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const EXITS = ['outside-press', 'escape', 'tab', 'window-blur', 'canvas-click', 'selection-change', 'unmount', 'chip-toggle', 'pick'];
  const SEQUENCE_COUNT_MAX = 200;
  for (let sequence = 0; sequence < SEQUENCE_COUNT_MAX; sequence += 1) {
    const random = generator(1000 + sequence);
    const choose = (list) => list[Math.floor(random() * list.length)];
    const view = await mount(random);
    await view.open();
    const trace = [];
    const steps = 1 + Math.floor(random() * 7);
    for (let step = 0; step < steps; step += 1) {
      const action = choose(['hover', 'hover', 'hover', 'leave', 'wait']);
      trace.push(action);
      if (action === 'hover') {
        const name = choose(NAMES);
        trace.push(name);
        await view.hover(name);
      } else if (action === 'leave') {
        await view.leaveList();
      }
      // From within one frame to past the 100ms live timer and the bridge's delays.
      await advance(Math.floor(random() * 5) === 0 ? 0 : Math.floor(random() * 180));
    }
    const exit = choose(EXITS);
    trace.push(exit);
    let expected = ORIGINAL;
    await act(async () => {
      if (exit === 'escape') {
        keydown(document.querySelector('.embed-editor_varpicker-search'), 'Escape');
      } else if (exit === 'tab') {
        keydown(document.querySelector('.embed-editor_varpicker-search'), 'Tab');
      }
    });
    if (exit === 'window-blur') {
      await act(async () => dom.window.dispatchEvent(new dom.window.Event('blur')));
    } else if (exit === 'canvas-click') {
      await act(async () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'avb:click-node', path: '0' } })));
    } else if (exit === 'selection-change') {
      await act(async () => setHost({ ...getHost(), selectedId: `node-${sequence}` }));
    } else if (exit === 'chip-toggle') {
      await act(async () => view.chip().dispatchEvent(mouse('mousedown')));
    } else if (exit === 'pick') {
      const name = choose(NAMES);
      expected = `var(--${name})`;
      await act(async () => {
        const row = view.rowOf(name);
        row.dispatchEvent(mouse('pointerdown'));
        row.dispatchEvent(mouse('mousedown'));
        row.dispatchEvent(mouse('click'));
      });
    }
    if (exit !== 'pick' && exit !== 'unmount' && exit !== 'chip-toggle' && exit !== 'escape') {
      await view.pressOutside();
    }
    if (exit === 'unmount') {
      await view.done();
    }
    const unmounted = exit === 'unmount';
    await advance(2000);
    const label = `sequence ${sequence} (${trace.join(' ')})`;
    check(`${label}: canvas`, view.model.canvas === expected, `canvas ${view.model.canvas}, expected ${expected}`);
    check(`${label}: committed`, view.model.saved === expected, `saved ${view.model.saved}, commits ${JSON.stringify(view.model.commits)}`);
    check(
      `${label}: nothing but the original or the pick was ever committed`,
      view.model.commits.every((value) => value === ORIGINAL || value === expected),
      JSON.stringify(view.model.commits),
    );
    check(`${label}: picker closed`, document.querySelector('.embed-editor_varpicker') === null);
    if (!unmounted) {
      check(`${label}: field`, view.field()?.value === expected, view.field()?.value);
      check(`${label}: chip`, `var(--${view.chipName()})` === expected, view.chipName());
      await view.done();
    }
    check(`${label}: no timer left`, clock.timers.size === 0, `${clock.timers.size} left`);
    if (failures.length > 12) {
      break;
    }
    setHost({ ...getHost(), selectedId: undefined });
  }

  if (failures.length > 0) {
    console.error(`variablePickerRestore: ${failures.length} of ${checked} failed\n${failures.slice(0, 40).join('\n')}`);
    process.exit(1);
  }
  console.log(`variablePickerRestore: ${checked} checks passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
