// A control that doesn't guess while the page is still being asked.
//
//   node test/renderer/style/computedHold.test.js
//
// When nothing in the project's CSS declares a property, a control highlights
// what the PAGE computes for the selected element — `pointer-events` may be
// `none` because a parent set it, `display` is whatever the UA stylesheet says.
// That answer costs a round trip to the canvas.
//
// Clearing a property opens a gap. The cached computed values are dropped on
// every CSS edit (an edit is exactly what changes them), so the control goes
// straight from "authored" to "asked, no answer yet" with the round trip in
// between. Filling that gap with the control's hard-coded fallback is a guess,
// and a wrong one whenever the value comes from somewhere else — clearing
// `pointer-events: none` on an element that INHERITS none would jump the
// highlight to Auto and then, once the page answered, slide it back to None.
// These bars draw their selection as one pill that slides, so every wrong guess
// was a visible round trip of its own.
//
// So: hold the previous highlight until there is an answer, then move once. The
// hold lasts only as long as an answer is actually coming — with no canvas to
// ask, the fallback is the best there is and is used at once.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath, sourceSpecifier, stubSources } = require('../../helpers/sources.js');

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
  const root = ROOT;
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });

  // Stand in for the preview frame, so the round trip can be held open and the
  // answer chosen per case. Everything else is the real panel.
  const stub = `
    export const onCanvasReady = () => () => {};
    export const hasCanvas = () => !globalThis.__noCanvas;
    export const queryCanvas = (p, a, b, props) => new Promise((resolve) => {
      globalThis.__answer = () => {
        const computedProps = {};
        for (const prop of props) computedProps[prop] = (globalThis.__computed || {})[prop] ?? '';
        resolve({ computedProps, authoredProps: {}, identity: { tag: 'div' } });
      };
    });
  `;
  const entry = path.join(buildDirectory, 'computed-hold.entry.jsx');
  const reexports = [
    ['{ default as EffectsSection }', 'src/features/style/EffectsSection.tsx'],
    ['{ LayoutModeSections }', 'src/features/style/embed/LayoutRows.tsx'],
    ['{ setHost }', 'src/features/style/model/host.ts'],
    ['{ forgetComputedStyles }', 'src/features/style/model/computedStyle.ts'],
  ];
  fs.writeFileSync(entry, reexports.map(([names, file]) => `export ${names} from ${sourceSpecifier(file)};\n`).join(''));
  const bundlePath = path.join(buildDirectory, 'computed-hold.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    plugins: [
      stubSources('stub-canvas', {
        'src/editor/canvasQuery.ts': () => ({
          contents: stub,
          loader: 'js',
          resolveDir: root,
        }),
      }),
    ],
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
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

  // React warns when a state update lands outside act(). The updates here come
  // from the panel's own batched round trip resolving on a timer, which is the
  // thing being tested — the warning is noise, and loud enough to bury a real
  // failure in the output.
  const realError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) {
      return;
    }
    realError(...args);
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { EffectsSection, LayoutModeSections, setHost, forgetComputedStyles } = require(bundlePath);

  // A selected element, so there is something to ask the page about.
  setHost({
    selectedId: 'n1',
    pathOf: () => 'page:1',
    nodes: [{ id: 'n1', kind: 'element', name: 'div' }],
  });

  const mount = async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rootElement = createRoot(host);
    let decls = {};
    const render = async () => {
      const read = (property) =>
        decls[property] !== undefined
          ? {
              source: 'selected',
              overridden: false,
              contributors: [],
              winner: { selectorText: '.x', value: decls[property], important: false },
              selectedValue: { value: decls[property], important: false },
            }
          : undefined;
      await act(async () => {
        rootElement.render(
          React.createElement(EffectsSection, {
            read,
            busy: false,
            setProp: () => {},
            clearProp: () => {},
            liveSetProp: () => {},
            onProvenance: () => {},
            onSelectSelector: () => {},
          }),
        );
      });
    };
    // Every CSS edit drops the cached computed values — that is what opens the gap.
    const set = async (property, value) => {
      forgetComputedStyles();
      decls = { ...decls, [property]: value };
      await render();
    };
    const clear = async (property) => {
      forgetComputedStyles();
      const next = { ...decls };
      delete next[property];
      decls = next;
      await render();
    };
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    };
    // Resolving the round trip lands a state update, so it happens inside act().
    const answer = async () => {
      await act(async () => {
        globalThis.__answer?.();
        globalThis.__answer = undefined;
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      await settle();
    };
    const selected = () => {
      const bar = host.querySelector('[aria-label="Pointer events"]');
      const on = [...bar.querySelectorAll('.embed-editor_display-seg')].filter((segment) => segment.classList.contains('is-selected'));
      return on.map((segment) => segment.getAttribute('aria-label')).join(',') || '(none)';
    };
    await render();
    return {
      host,
      set,
      clear,
      settle,
      answer,
      selected,
      done: async () => {
        await act(async () => rootElement.unmount());
        host.remove();
      },
    };
  };

  // --- The page still computes `none` (it is inherited) ------------------------
  {
    globalThis.__noCanvas = false;
    globalThis.__computed = { 'pointer-events': 'none' };
    const mounted = await mount();
    await mounted.set('pointer-events', 'none');
    await mounted.settle();
    await mounted.answer();
    check('an authored value is shown', mounted.selected() === 'None', mounted.selected());

    await mounted.clear('pointer-events');
    await mounted.settle();
    // The gap. Nothing is authored and the page has not answered yet.
    check(
      'clearing it does not jump to the fallback',
      mounted.selected() === 'None',
      `${mounted.selected()} — this is the guess, and the page has not been asked yet`,
    );
    await mounted.answer();
    check('and the answer confirms it, so nothing moved at all', mounted.selected() === 'None', mounted.selected());
    await mounted.done();
  }

  // --- The page computes something else --------------------------------------
  {
    globalThis.__computed = { 'pointer-events': 'auto' };
    const mounted = await mount();
    await mounted.set('pointer-events', 'none');
    await mounted.settle();
    await mounted.answer();
    check('starts on the authored value', mounted.selected() === 'None', mounted.selected());

    await mounted.clear('pointer-events');
    await mounted.settle();
    check('still holds while the page is asked', mounted.selected() === 'None', mounted.selected());
    await mounted.answer();
    // One move, and to the place the page actually named.
    check('then moves once, to what the page says', mounted.selected() === 'Auto', mounted.selected());
    await mounted.done();
  }

  // --- No canvas to ask -------------------------------------------------------
  {
    // Nothing is ever coming, so holding would hold for ever. The fallback is the
    // best answer available and it is used straight away.
    globalThis.__noCanvas = true;
    const mounted = await mount();
    await mounted.set('pointer-events', 'none');
    await mounted.settle();
    check('the authored value still wins', mounted.selected() === 'None', mounted.selected());
    await mounted.clear('pointer-events');
    await mounted.settle();
    check('clearing falls back at once with no page to ask', mounted.selected() === 'Auto', mounted.selected());
    await mounted.done();
    globalThis.__noCanvas = false;
  }

  // --- A resolving display does not collapse its controls ---------------------
  // The resolver replaces the old model in two steps. During the gap `display`
  // is absent, but that is not a new block display; it is no answer yet. Keep the
  // disclosure and Align Y row in place until resolution settles.
  {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rootElement = createRoot(host);
    let display = 'inline-block';
    let resolving = false;
    const render = async () => {
      const read = (property) =>
        property === 'display' && display
          ? {
              source: 'selected',
              overridden: false,
              contributors: [],
              winner: { selectorText: '.x', value: display, important: false },
              selectedValue: { value: display, important: false },
            }
          : undefined;
      await act(async () => {
        rootElement.render(
          React.createElement(LayoutModeSections, {
            read,
            resolving,
            busy: false,
            setProp: () => {},
            clearProp: () => {},
            liveSetProp: () => {},
            onProvenance: () => {},
            onSelectSelector: () => {},
            activeSelector: '.x',
          }),
        );
      });
    };
    const hasAlignY = () => host.querySelector('button[aria-label="Align Y"]') !== null;
    await render();
    check('an inline display shows Align Y', hasAlignY());
    display = '';
    resolving = true;
    await render();
    check('the resolving gap keeps Align Y in place', hasAlignY());
    resolving = false;
    await render();
    check('a settled non-inline display closes Align Y', !hasAlignY());
    display = 'inline-block';
    await render();
    check('returning to inline restores Align Y', hasAlignY());
    await act(async () => rootElement.unmount());
    host.remove();
  }

  if (failures.length) {
    console.error(`computed-hold: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`computed-hold: ${checked} passed  [holds while asking, falls back with nothing to ask]`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
