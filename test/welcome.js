// The start screen's project cards.
//
//   node test/welcome.js
//
// A thumbnail that is out of date is the app's problem. It used to be the
// user's: the card carried a badge saying so and a button to do something
// about it. Now the screen quietly takes the picture again — which is only an
// improvement if it is actually quiet, so what is checked here is that nothing
// is announced, that only the cards that need one are re-rendered, that they go
// one at a time, and that closing the screen stops the queue rather than
// leaving it running against a project the user has just opened.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'welcome.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'WelcomeScreen.jsx')],
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
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  // The screen's background is WebGL, which jsdom has none of. A canvas that
  // hands back no context is the same situation as a machine without a GPU, so
  // the background is expected to cope with it — the cards are what is under
  // test here.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext = function WebGLRenderingContext() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const WelcomeScreen = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const all = (selector) => [...container.querySelectorAll(selector)];
  const text = () => container.textContent;

  const recents = [
    { path: '/p/fresh', name: 'fresh', thumb: PIXEL, stale: false, canRefresh: true },
    { path: '/p/stale', name: 'stale', thumb: PIXEL, stale: true, canRefresh: true },
    { path: '/p/never', name: 'never', thumb: null, stale: true, canRefresh: true },
    { path: '/p/nodeps', name: 'nodeps', thumb: null, stale: true, canRefresh: false },
  ];

  // Each refresh waits to be released, so the order and the overlap are
  // observable rather than a matter of timing.
  const asked = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let release = null;
  const toasts = [];

  dom.window.avb = {
    listRecents: async () => recents.map((r) => ({ ...r })),
    removeRecent: async () => ({ ok: true }),
    refreshThumb: async (projectPath) => {
      asked.push(projectPath);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => {
        release = () => {
          release = null;
          resolve();
        };
      });
      inFlight--;
      return { ok: true, thumb: PIXEL, stale: false };
    },
  };

  const mount = async () =>
    act(async () => {
      reactRoot.render(
        React.createElement(WelcomeScreen, {
          onOpen: () => {},
          setBusy: () => {},
          showToast: (message) => toasts.push(message),
        })
      );
      await settle(30);
    });

  await mount();

  check('every recent project gets a card', all('.recent-card').length === 4, `${all('.recent-card').length}`);
  check('nothing tells the user a picture is old', !/out of date/i.test(text()), text());
  check('and nothing offers to fix it', all('.recent-refresh').length === 0);

  // The queue: stale first, one at a time, skipping what cannot be rendered.
  check('the first stale project is being re-rendered', asked[0] === '/p/stale', JSON.stringify(asked));
  check('one at a time', maxInFlight === 1, `${maxInFlight} at once`);
  check('a card that is up to date is left alone', !asked.includes('/p/fresh'));

  await act(async () => {
    release?.();
    await settle(30);
  });
  check('then the one with no picture at all', asked[1] === '/p/never', JSON.stringify(asked));

  await act(async () => {
    release?.();
    await settle(30);
  });
  check(
    'a project with no dependencies is never asked for',
    !asked.includes('/p/nodeps'),
    JSON.stringify(asked)
  );
  check('so the queue ends', asked.length === 2, JSON.stringify(asked));
  check('quietly', toasts.length === 0, JSON.stringify(toasts));

  // Leaving the screen stops it: the machine belongs to the project being
  // opened now.
  const stopped = [];
  dom.window.avb.refreshThumb = async (projectPath) => {
    stopped.push(projectPath);
    return { ok: true, thumb: PIXEL, stale: false };
  };
  await act(async () => {
    reactRoot.unmount();
    await settle(40);
  });
  check('nothing carries on after the screen closes', stopped.length === 0, JSON.stringify(stopped));

  if (failures.length) {
    console.error(`\nwelcome: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`welcome: ${checked} passed`);
})();
