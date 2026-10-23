// Leaving a project.
//
//   node test/electron/app/closeProject.test.js
//
// There was no way out of a project. Not a menu item, not a button — the only
// route back to the welcome screen was to close the app and start it again,
// which on macOS is not what it sounds like: the window goes and the process
// stays, so coming back finds the same project exactly where it was left. "I
// close Stacki to close out the project and it just keeps the previous project
// open" is that, and it is the app's fault for having nothing else to offer.
//
// So: Open Project… and Close Project, and the window reloads to do it. Forty
// pieces of state, an undo stack, a canvas holding a page, a watcher, a shell
// and a dev server all belong to the project that was open, and starting the
// renderer over is the only way to be sure none of them are still here when the
// next one opens. The choice of what to open next has to survive that reload,
// so main holds it.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const { readFolderSource, readSource } = require('../../helpers/sourceText.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'close-project.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/app/App.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
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
  global.IS_REACT_ACT_ENVIRONMENT = true;

  // What the app asked main to do. `reloads` is the window starting over, which
  // is what leaving a project actually is.
  const closed = [];
  const opened = [];
  let dialogAnswer = { projectPath: '/projects/next' };
  const menu = new Map();
  const noop = async () => undefined;
  const bridge = new Proxy(
    {
      onMenu: (channel, callback) => {
        menu.set(channel, callback);
        return () => menu.delete(channel);
      },
      openProjectDialog: async () => dialogAnswer,
      closeProject: async (next) => {
        closed.push(next);
        return { ok: true };
      },
      pendingProject: async () => undefined,
      scanProject: async (projectPath) => {
        opened.push(projectPath);
        return { pages: [], layouts: [], components: [], pageFolders: [] };
      },
      listProjectClasses: async () => [],
      startDevServer: async () => ({ url: 'http://localhost:4321' }),
      gitInfo: async () => ({ isRepo: false }),
      publishAvailability: async () => ({ github: 'unknown', hosting: 'unconfigured' }),
      gitLog: async () => ({ commits: [], atEnd: true }),
      gitWorktrees: async () => [],
      gitStatus: async () => [],
      listRecents: async () => [],
      onCssChanged: () => () => {},
    },
    {
      get: (target, prop) =>
        prop in target
          ? target[prop]
          : typeof prop === 'string' && prop.startsWith('on')
            ? () => () => {}
            : noop,
    },
  );
  dom.window.avb = bridge;
  global.avb = bridge;
  // Starting the window over is main's half of the same act, so what the app
  // does here is ask — see the source checks at the end for the rest.

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const App = require(bundlePath).default;

  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(App));
    await settle(40);
  });

  const fire = async (channel, ...args) => {
    const callback = menu.get(channel);
    if (!callback) {
      return false;
    }
    await act(async () => {
      await callback(...args);
      await settle(40);
    });
    return true;
  };
  const welcome = () => !!container.querySelector('.welcome-mode, .welcome');

  // --- the menu is there to be asked ---------------------------------------------
  check('the app listens for Close Project', menu.has('closeProject'), [...menu.keys()].join());
  check('and for Open Project', menu.has('openProject'), [...menu.keys()].join());
  check('and starts on the welcome screen', welcome(), container.innerHTML.slice(0, 120));

  // --- with nothing open there is nothing to leave ---------------------------------
  await fire('closeProject');
  check('closing with no project open does nothing', closed.length === 0, JSON.stringify(closed));

  // --- opening one from the menu when none is open ----------------------------------
  // This is the welcome screen's own button by another route: there is nothing
  // to let go of, so nothing reloads.
  await fire('openProject');
  check('opening with no project open opens it', opened.includes('/projects/next'), opened.join());
  check('and the welcome screen gives way to it', !welcome(), 'still on the welcome screen');

  // --- leaving the one that is open --------------------------------------------------
  await fire('closeProject');
  check('closing tells main to let the project go', closed.length === 1, JSON.stringify(closed));
  check('with nothing to open next', closed[0] === undefined, JSON.stringify(closed));

  // --- switching to another one ---------------------------------------------------------
  // The reload is what lets go, so the project being opened has to be handed
  // over BEFORE it — main holds it for the window that comes back.
  dialogAnswer = { projectPath: '/projects/third' };
  await fire('openProject');
  check('switching lets the old project go', closed.length === 2, JSON.stringify(closed));
  check(
    'and hands over the one to open next',
    closed[1] === '/projects/third',
    JSON.stringify(closed),
  );
  check(
    'without opening it in the window that is going away',
    !opened.includes('/projects/third'),
    opened.join(),
  );

  // --- a dialog nobody answered ----------------------------------------------------------
  dialogAnswer = { canceled: true };
  await fire('openProject');
  check(
    'cancelling the picker leaves the project alone',
    closed.length === 2,
    JSON.stringify(closed),
  );

  // --- what main does with it -------------------------------------------------------------
  const main = readSource('electron/main.ts');
  check(
    'the File menu offers a way in',
    /label: 'Open Project…'/.test(main),
    'no Open Project item',
  );
  check('and a way out', /label: 'Close Project'/.test(main), 'no Close Project item');
  const close = main.slice(
    main.indexOf("ipcMain.handle('project:close'"),
    main.indexOf("app.on('window-all-closed'"),
  );
  check('letting go stops the dev server', /devServers\.stop\(\)/.test(close), close.slice(0, 200));
  check(
    'and the shells, which outlive a window',
    /cleanupTerminals\(\)/.test(close),
    close.slice(0, 200),
  );
  check('and the watcher', /stopWatchingProject\(\)/.test(close), close.slice(0, 200));
  check(
    'and puts the project out of reach',
    /openProjectRoot = undefined/.test(close),
    close.slice(0, 200),
  );
  check(
    'and starts the window over, which is what lets the renderer go',
    /mainWindow\?\.webContents\.reload\(\)/.test(close),
    'the next project opens into the last one’s state',
  );
  check(
    'the project to open next is consumed as it is handed over',
    /const asked = pendingProject;\s*\n\s*pendingProject = undefined;/.test(main),
    'a pending project would be opened again on the next reload',
  );
  check(
    'and a window somebody CLOSED forgets what it had',
    /mainWindow\.on\('closed', \(\) => \{\s*\n\s*openProjectRoot = undefined;/.test(main),
    'the next window comes back holding the last project',
  );

  const preload = readFolderSource('electron/preload');
  check(
    'the app can ask for both',
    /closeProject: invoke\('project:close'\)/.test(preload) &&
      /pendingProject: invoke\('project:pending'\)/.test(preload),
    'the bridge is missing one',
  );

  if (failures.length) {
    console.error(
      `\nclose-project: ${failures.length} failed, ${checked - failures.length} passed\n`,
    );
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`close-project: ${checked} passed  [a project you can leave]`);
  process.exit(0);
})();
