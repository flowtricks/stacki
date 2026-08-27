// A crash stays the size of the panel it happened in.
//
//   node test/error-boundary.js
//
// React's answer to an uncaught render error is to unmount the whole tree:
// one bad prop shape in one panel and the user gets an empty window, no
// message, no route back — while the app holds unsaved edits to their
// repository. src/ErrorBoundary.jsx is what stands in the way, one per panel
// region, plus a root backstop in main.jsx and window-level listeners for the
// errors React never sees (event handlers, promises nobody awaited).
//
// Three things are checked, each the way it would actually fail:
//   the boundary itself — rendered for real, with a child that throws: the
//     sibling stays up, the fallback names the region and the error, and
//     "Try again" actually remounts
//   the listeners — the real App rendered, a real ErrorEvent dispatched, and
//     the toast that dev-server failures use is where it lands
//   the coverage — every panel region in App.jsx sits inside a boundary, and
//     main.jsx keeps the root backstop; a region added without one is exactly
//     the regression this file exists to catch

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

  const bundle = async (entry, outfile) => {
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', entry)],
      outfile: path.join(buildDir, outfile),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
      logLevel: 'silent',
    });
    return path.join(buildDir, outfile);
  };

  // The same JSDOM setup as test/app-renders.js — the app renders here too.
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.MutationObserver = dom.window.MutationObserver;
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext || class {};
  dom.window.WebGLRenderingContext = global.WebGLRenderingContext;
  global.WebGL2RenderingContext = dom.window.WebGL2RenderingContext || class {};
  dom.window.WebGL2RenderingContext = global.WebGL2RenderingContext;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  const noop = async () => null;
  const bridge = new Proxy(
    {
      gitInfo: async () => ({ isRepo: false }),
      gitLog: async () => ({ commits: [], atEnd: true }),
      gitWorktrees: async () => [],
      gitStatus: async () => [],
      recentProjects: async () => [],
      onCssChanged: () => () => {},
    },
    {
      get: (target, prop) =>
        prop in target
          ? target[prop]
          : typeof prop === 'string' && prop.startsWith('on')
            ? () => () => {}
            : noop,
    }
  );
  dom.window.avb = bridge;
  global.avb = bridge;

  const React = require('react');
  const ReactDOM = require('react-dom');
  const { createRoot } = require('react-dom/client');
  const h = React.createElement;

  // React narrates every caught error to console.error; that is its job, not
  // a failure of these tests. Silenced around the renders that crash on
  // purpose, restored everywhere else.
  const realError = console.error;
  const quietly = (fn) => {
    console.error = () => {};
    try {
      fn();
    } finally {
      console.error = realError;
    }
  };

  // ----------------------------------------------------------------
  // The boundary itself, rendered for real.
  // ----------------------------------------------------------------
  const ErrorBoundary = require(await bundle('ErrorBoundary.jsx', 'error-boundary.bundle.js'))
    .default;

  // A component whose crash is a switch, so "Try again" has something to
  // come back to — the shape of a real recovery, where the state that threw
  // has since changed.
  let broken = true;
  function Panel() {
    if (broken) throw new Error('bad prop shape');
    return h('div', { className: 'panel-alive' }, 'panel content');
  }

  {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    quietly(() => {
      ReactDOM.flushSync(() => {
        root.render(
          h(
            'div',
            null,
            h('div', { className: 'sibling' }, 'the canvas'),
            h(ErrorBoundary, { label: 'the style panel' }, h(Panel))
          )
        );
      });
    });

    check(
      'a crash inside the boundary leaves its siblings standing',
      host.querySelector('.sibling') !== null,
      host.innerHTML.slice(0, 200)
    );
    check('the fallback names the region that failed', /the style panel/.test(host.textContent));
    check('the fallback shows the error itself', /bad prop shape/.test(host.textContent));

    const retry = host.querySelector('.crash-retry');
    check('the fallback offers a way back', !!retry && /try again/i.test(retry.textContent));

    // The state that threw is gone; the button should bring the panel back.
    broken = false;
    ReactDOM.flushSync(() => {
      retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    check(
      '"Try again" remounts the children',
      host.querySelector('.panel-alive') !== null,
      host.innerHTML.slice(0, 200)
    );
    root.unmount();
    host.remove();
  }

  // The root backstop cannot remount its way out — the app it would remount
  // is the thing that crashed — so it offers a reload instead.
  {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    broken = true;
    quietly(() => {
      ReactDOM.flushSync(() => {
        root.render(h(ErrorBoundary, { root: true, label: 'the app' }, h(Panel)));
      });
    });
    const retry = host.querySelector('.crash-retry');
    check('the root boundary offers a reload instead', !!retry && /reload/i.test(retry.textContent));
    root.unmount();
    host.remove();
  }

  // ----------------------------------------------------------------
  // The window-level listeners, through the real App.
  // ----------------------------------------------------------------
  {
    const App = require(await bundle('App.jsx', 'app.bundle.js')).default;
    const root = createRoot(document.getElementById('root'));
    ReactDOM.flushSync(() => {
      root.render(h(App));
    });
    // Effects have run; the listeners are on. An uncaught throw and an
    // unhandled rejection, the two shapes the window reports.
    quietly(() => {
      window.dispatchEvent(
        new dom.window.ErrorEvent('error', { error: new Error('boom from a handler') })
      );
    });
    // The toast renders on React's own schedule, not inside dispatchEvent.
    await new Promise((r) => setTimeout(r, 20));
    let toast = document.querySelector('.toast');
    check(
      'an uncaught error surfaces in the toast dev-server failures use',
      !!toast && /boom from a handler/.test(toast.textContent),
      toast ? toast.textContent : 'no toast rendered'
    );

    // JSDOM has no PromiseRejectionEvent; the listener only reads `reason`.
    const rejection = new dom.window.Event('unhandledrejection');
    rejection.reason = new Error('nobody awaited this');
    quietly(() => {
      window.dispatchEvent(rejection);
    });
    await new Promise((r) => setTimeout(r, 20));
    toast = document.querySelector('.toast');
    check(
      'an unhandled rejection surfaces there too',
      !!toast && /nobody awaited this/.test(toast.textContent),
      toast ? toast.textContent : 'no toast rendered'
    );
    root.unmount();
  }

  // ----------------------------------------------------------------
  // Coverage: the regions are actually wrapped.
  // ----------------------------------------------------------------
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
    const labels = [...app.matchAll(/<ErrorBoundary[^>]*label=\{?[`"]([^`"}]+)/g)].map(
      (m) => m[1]
    );
    for (const region of [
      'the start screen',
      'the canvas',
      'the style panel',
      'the settings panel',
      'the terminal',
      'the code window',
    ]) {
      check(`App.jsx wraps ${region}`, labels.some((l) => l.includes(region)));
    }
    check(
      'App.jsx wraps the left panel, keyed on its tab',
      /<ErrorBoundary\s+key=\{leftTab\}/.test(app)
    );

    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.jsx'), 'utf8');
    check('main.jsx keeps the root backstop', /<ErrorBoundary\s+root\b/.test(main));
  }

  if (failures.length) {
    console.error(`error-boundary: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`error-boundary: ${checked} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
