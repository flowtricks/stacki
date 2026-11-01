// Does the app render at all.
//
//   node test/renderer/app/appRenders.test.js
//
// One check, for one failure: App.tsx is ~4000 lines of hooks in a single
// component, and a hook whose dependency array names something declared
// further down the component throws
//
//   ReferenceError: Cannot access 'x' before initialization
//
// the moment React calls the function. A dependency array is evaluated during
// render, not when the callback runs, so this is not caught by lint, not
// caught by the build, and not caught by any of the other tests here — they
// all exercise modules rather than the component. What the user sees is a
// black screen and nothing else.
//
// It has happened once, to `showToast`, and it will happen again: the fix for
// it is to move a block of hooks, and moving hooks is exactly the edit that
// causes it. So this renders the real component once, with the preload bridge
// stubbed, and fails if it throws.
//
// Deliberately shallow — it renders with no project open, which is the state
// the app starts in. That is enough to evaluate every hook in the component,
// which is the whole point.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

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
  const bundlePath = path.join(buildDirectory, 'app.bundle.js');

  await esbuild.build({
    entryPoints: [repoPath('src/app/App.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    // The app imports its stylesheets; nothing here draws, so they are dropped.
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });

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
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.MutationObserver = dom.window.MutationObserver;
  // JSDOM has no WebGL, and something in the style panel feature-detects it.
  // A missing global throws where a missing capability would not, so it is
  // declared and left useless.
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext || class {};
  dom.window.WebGLRenderingContext = global.WebGLRenderingContext;
  global.WebGL2RenderingContext = dom.window.WebGL2RenderingContext || class {};
  dom.window.WebGL2RenderingContext = global.WebGL2RenderingContext;
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });

  // The preload bridge. Every method answers with something harmless, so the
  // component gets past its first effects without a real main process.
  const noop = async () => undefined;
  const bridge = new Proxy(
    {
      // The few whose shape is actually read during a bare first render.
      gitInfo: async () => ({ isRepo: false }),
      gitLog: async () => ({ commits: [], atEnd: true }),
      gitWorktrees: async () => [],
      gitStatus: async () => [],
      recentProjects: async () => [],
      onCssChanged: () => () => {},
    },
    {
      // Anything else: a function returning null, and an `on*` subscription
      // returning its own unsubscribe.
      get: (target, prop) => (prop in target ? target[prop] : typeof prop === 'string' && prop.startsWith('on') ? () => () => {} : noop),
    },
  );
  dom.window.avb = bridge;
  global.avb = bridge;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const App = require(bundlePath).default;

  // React reports render errors to console.error rather than throwing them
  // where they can be caught, so both routes are watched.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => {
    errors.push(args.map((argument) => (argument && argument.stack) || String(argument)).join(' '));
  };

  let threw;
  try {
    const root = createRoot(document.getElementById('root'));
    // Synchronous, so the render happens inside this block.
    require('react-dom').flushSync(() => {
      root.render(React.createElement(App));
    });
  } catch (error) {
    threw = error;
  } finally {
    console.error = realError;
  }

  check('the app renders without throwing', !threw, threw && (threw.stack || String(threw)));

  // The one this file exists for. It is called out separately because the
  // message is so specific, and because seeing it named makes the fix obvious:
  // move the hook below whatever it names.
  const tdz = errors.find((error) => /before initialization/.test(error));
  check(
    'no hook reads something declared later in the component',
    !tdz,
    tdz && `${tdz.split('\n').slice(0, 3).join('\n    ')}\n` + `    → move that hook below the declaration it names`,
  );

  const other = errors.filter((error) => !/before initialization/.test(error) && /Error|Warning: Failed/.test(error));
  check(
    'nothing else was reported during render',
    other.length === 0,
    other
      .slice(0, 2)
      .map((error) => error.split('\n')[0])
      .join('\n    '),
  );

  check('something was actually rendered', document.getElementById('root').innerHTML.length > 0);

  // Native confirm()/alert() are a different application interrupting this one:
  // system chrome, system type, a title bar naming localhost, and two buttons
  // that can only say OK and Cancel. They are replaced by the app's own dialog
  // (src/ui/ConfirmDialog.tsx), and the bundle is checked rather than the
  // source so a call reintroduced through any import is caught too.
  {
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    // The app's own code, not the libraries it pulls in — CodeMirror and
    // friends have their own reasons. esbuild puts each module under a banner
    // naming its file, so the split is by module rather than by line: xterm
    // ships a `confirm()` before opening a link from terminal output, minified
    // onto lines that say nothing about where they came from.
    // Linked dependencies can have parent-relative or absolute module banners.
    const ours = bundle
      .split(/^(?=\/\/ \S+\n)/m)
      .filter((chunk) => !/^\/\/ (?:.*[/\\])?node_modules[/\\]/.test(chunk))
      .join('\n');
    const native = [...ours.matchAll(/(?<![.\w])(?:window\.)?(confirm|alert)\s*\(/g)]
      .map((match) => match[0])
      // confirmDialog / confirmLabel are ours and read the same to a regex.
      .filter((hit) => !/confirmDialog|confirmLabel/.test(hit));
    check(
      'no native confirm() or alert() survives in the app',
      native.length === 0,
      native.length ? `found ${native.length}: ${[...new Set(native)].join(', ')}` : '',
    );
  }

  if (failures.length) {
    console.error(`app-renders: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`app-renders: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
