// The start screen's project cards.
//
//   node test/renderer/welcome/welcome.test.js
//
// A thumbnail that is out of date is the app's problem. It used to be the
// user's: the card carried a badge saying so and a button to do something
// about it. Now the screen quietly takes the picture again — which is only an
// improvement if it is actually quiet, so what is checked here is that nothing
// is announced, that only the cards that need one are re-rendered, that they go
// one at a time, and that closing the screen stops the queue rather than
// leaving it running against a project the user has just opened.
// Split actions also verify folder selection, menu focus and dismissal.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

// The DOM answers "none" with null. The fakes below that stand in for DOM APIs
// return the platform's own value, read from JSON because our code never writes one.
const PLATFORM_NULL = JSON.parse('null');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const PIXEL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk' +
  'YAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'welcome.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/welcome/WelcomeScreen.tsx')],
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
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  // The screen's background is WebGL, which jsdom has none of. A canvas that
  // hands back no context is the same situation as a machine without a GPU, so
  // the background is expected to cope with it — the cards are what is under
  // test here.
  dom.window.HTMLCanvasElement.prototype.getContext = () => PLATFORM_NULL;
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext =
    function WebGLRenderingContext() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const WelcomeScreen = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  let reactRoot = createRoot(container);
  const all = (selector) => [...container.querySelectorAll(selector)];
  const text = () => container.textContent;

  const recents = [
    { path: '/p/fresh', name: 'fresh', thumb: PIXEL, stale: false, canRefresh: true, openedAt: 4 },
    { path: '/p/stale', name: 'stale', thumb: PIXEL, stale: true, canRefresh: true, openedAt: 3 },
    {
      path: '/p/never',
      name: 'never',
      thumb: undefined,
      stale: true,
      canRefresh: true,
      openedAt: 2,
    },
    {
      path: '/p/nodeps',
      name: 'nodeps',
      thumb: undefined,
      stale: true,
      canRefresh: false,
      openedAt: 1,
    },
  ];

  // Each refresh waits to be released, so the order and the overlap are
  // observable rather than a matter of timing.
  const asked = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const toasts = [];

  dom.window.avb = {
    listRecents: async () => recents.map((recent) => ({ ...recent })),
    removeRecent: async () => ({ ok: true }),
    refreshThumb: async (projectPath) => {
      asked.push(projectPath);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => {
        release = () => {
          release = undefined;
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
        }),
      );
      await settle(30);
    });

  await mount();

  check(
    'every recent project gets a card',
    all('.recent-card').length === 4,
    `${all('.recent-card').length}`,
  );

  // Three ways to start, in the order they are reached for — and the one the
  // situation calls for is the one that looks like the answer.
  const actions = all('.actions button').map((button) => button.textContent.trim());
  check(
    'the actions read in that order',
    actions.join(' | ') === 'Open from folder |  | Start from Lumos | ',
    actions.join(' | '),
  );
  check(
    'with projects to return to, opening one leads',
    all('.actions button')[0].classList.contains('primary'),
    all('.actions button')
      .map((button) => button.className)
      .join(' | '),
  );
  check('alternate project actions stay in their dropdowns', all('[role=menuitem]').length === 0);
  let folderRequests = 0;
  dom.window.avb.openProjectDialog = async () => {
    folderRequests++;
    return { canceled: true };
  };
  await act(async () => all('.actions button')[0].click());
  check('the main Open from folder button opens the folder picker', folderRequests === 1);
  const arrows = all('.welcome-split-arrow');
  await act(async () => arrows[0].click());
  check(
    'the open menu reveals GitHub',
    all('[role=menuitem]')[0]?.textContent === 'Open from GitHub',
  );
  check(
    'opening the menu focuses its action',
    document.activeElement === all('[role=menuitem]')[0],
  );
  await act(async () => {
    document.activeElement.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    );
  });
  check(
    'Escape closes the menu and restores its trigger',
    all('[role=menuitem]').length === 0 && document.activeElement === arrows[0],
  );
  await act(async () => arrows[1].click());
  check(
    'the starter menu reveals the empty project option',
    all('[role=menuitem]')[0]?.textContent === 'Start from Astro',
  );
  let emptyRequests = 0;
  dom.window.avb.parentDialog = async () => {
    emptyRequests++;
    return { canceled: true };
  };
  await act(async () => all('[role=menuitem]')[0].click());
  check(
    'the empty project option asks where the site should go and closes the menu',
    emptyRequests === 1 && all('[role=menuitem]').length === 0,
  );
  await act(async () => arrows[0].click());
  await act(async () => {
    document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  });
  check('an outside click closes the menu', all('[role=menuitem]').length === 0);
  // The main half beside an open menu is part of the same control: its press is not an
  // outside press, so the first click opens the picker instead of only closing the menu.
  await act(async () => arrows[0].click());
  const openFromFolder = all('.actions button')[0];
  await act(async () => {
    openFromFolder.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    openFromFolder.click();
  });
  check(
    'with its menu open, Open from folder opens the picker on the first click',
    folderRequests === 2,
    String(folderRequests),
  );
  check('and closes the menu', all('[role=menuitem]').length === 0);
  check('nothing tells the user a picture is old', !/out of date/i.test(text()), text());
  check('and nothing offers to fix it', all('.recent-refresh').length === 0);

  // The queue: stale first, one at a time, skipping what cannot be rendered.
  check(
    'the first stale project is being re-rendered',
    asked[0] === '/p/stale',
    JSON.stringify(asked),
  );
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
    JSON.stringify(asked),
  );
  check('so the queue ends', asked.length === 2, JSON.stringify(asked));
  check('quietly', toasts.length === 0, JSON.stringify(toasts));

  // Starting from Lumos: the folder is chosen first, then the site is named.
  // Nothing in between is a screen the user can be left on, so the wizard has
  // to actually arrive.
  {
    let asked = false;
    dom.window.avb.parentDialog = async () => {
      asked = true;
      return { canceled: false, parentPath: '/tmp/sites' };
    };
    dom.window.avb.onCreateLog = () => () => {};
    await act(async () => {
      all('.actions button')[2].click();
      await settle(40);
    });
    check('choosing it asks where the site should go', asked);
    const wizard = dom.window.document.querySelector('.new-project-modal');
    check(
      'and then asks what it is called',
      !!wizard,
      'no wizard appeared after the folder was chosen',
    );
    check(
      'naming it Lumos',
      /Start from Lumos/.test(wizard?.textContent || ''),
      wizard?.textContent?.slice(0, 80),
    );
    check(
      'with a name to edit and where it will land',
      !!wizard?.querySelector('input') && /\/tmp\/sites\/my-site/.test(wizard?.textContent || ''),
      wizard?.textContent?.slice(0, 200),
    );
    const note = () => wizard.querySelector('.starter-note')?.textContent || '';
    check(
      'with npm, the note names only the command it runs',
      note().startsWith('Runs npm create lumos@latest, then starts a git history'),
      note(),
    );
    await act(async () => wizard.querySelector('.dd-trigger').click());
    await act(async () => dom.window.document.querySelectorAll('.dd-option')[1].click());
    check(
      'with pnpm, it also says pnpm installs it',
      note().startsWith('Runs npm create lumos@latest, installs it with pnpm, then starts'),
      note(),
    );

    // Cancelling the folder dialog leaves the screen where it was.
    await act(async () => {
      wizard.querySelector('.modal-footer .ghost').click();
      await settle(20);
    });
    check('cancelling closes it', !dom.window.document.querySelector('.new-project-modal'));
    dom.window.avb.parentDialog = async () => ({ canceled: true });
    await act(async () => {
      all('.actions button')[2].click();
      await settle(30);
    });
    check(
      'and cancelling the folder shows nothing',
      !dom.window.document.querySelector('.new-project-modal'),
    );
  }

  // An empty Astro project is named the same way: where it goes, then its name.
  {
    dom.window.avb.parentDialog = async () => ({ canceled: false, parentPath: '/tmp/sites' });
    const created = [];
    let finish = () => {};
    // Held open until `finish`, so the test can look at the wizard while it runs.
    dom.window.avb.createAstroProject = (payload) => {
      created.push(payload);
      return new Promise((resolve) => {
        finish = () => resolve({ ok: true, installed: true, projectPath: '/tmp/sites/blog-site' });
      });
    };
    await act(async () => all('.actions button')[3].click());
    await act(async () => {
      all('[role=menuitem]')[0].click();
      await settle(30);
    });
    const wizard = dom.window.document.querySelector('.new-project-modal');
    check(
      'the Astro wizard opens after the folder',
      /New Astro Project/.test(wizard?.textContent || ''),
      wizard?.textContent?.slice(0, 80),
    );
    check(
      'with the site name and the folder it becomes',
      !!wizard?.querySelector('input') && /\/tmp\/sites\/my-site/.test(wizard?.textContent || ''),
      wizard?.textContent?.slice(0, 200),
    );
    const input = wizard.querySelector('input');
    const create = () => [...wizard.querySelectorAll('.modal-footer button')].at(-1);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(
        input,
        'bad name/',
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    check('a name that is not a folder name cannot be created', create().disabled === true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(
        input,
        'blog-site',
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const trigger = wizard.querySelector('.dd-trigger');
    check(
      'the package manager is npm by default',
      trigger?.textContent === 'npm',
      trigger?.outerHTML,
    );
    await act(async () => trigger.click());
    const managers = [...dom.window.document.querySelectorAll('.dd-option')];
    check(
      'and offers npm and pnpm',
      managers.map((option) => option.textContent).join() === 'npm,pnpm',
      managers.map((option) => option.textContent).join(),
    );
    await act(async () => managers[1].click());
    check('picking pnpm shows it', trigger?.textContent === 'pnpm', trigger?.textContent);
    await act(async () => {
      create().click();
      await settle(30);
    });
    check(
      'and the one chosen is sent with the site',
      created[0]?.packageManager === 'pnpm',
      JSON.stringify(created),
    );
    check(
      'while it runs, dots animate after the last line of the log',
      !!wizard.querySelector('.create-log .create-log-dots'),
      wizard.querySelector('.create-log')?.outerHTML,
    );
    await act(async () => {
      finish();
      await settle(30);
    });
    check(
      'creating sends the parent folder and the name, not a folder of its own',
      created.length === 1 &&
        created[0].parentPath === '/tmp/sites' &&
        created[0].name === 'blog-site' &&
        !('dir' in created[0]),
      JSON.stringify(created),
    );
    check(
      'and the wizard closes on the project it made',
      !dom.window.document.querySelector('.new-project-modal'),
    );
  }

  // A first run has nothing to return to, so starting a site is the answer
  // rather than opening one.
  {
    dom.window.avb.listRecents = async () => [];
    // A fresh mount: re-rendering the same element keeps the state it fetched,
    // recents and all.
    await act(async () => {
      reactRoot.unmount();
      await settle(10);
    });
    reactRoot = createRoot(container);
    await act(async () => {
      reactRoot.render(
        React.createElement(WelcomeScreen, {
          onOpen: () => {},
          setBusy: () => {},
          showToast: () => {},
        }),
      );
      await settle(40);
    });
    const buttons = all('.actions button');
    check(
      'with no projects, starting from Lumos leads',
      buttons[2]?.classList.contains('primary'),
      buttons.map((button) => button.className).join(' | '),
    );
    check('and opening one does not', !buttons[0]?.classList.contains('primary'));
  }

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
  check(
    'nothing carries on after the screen closes',
    stopped.length === 0,
    JSON.stringify(stopped),
  );

  if (failures.length) {
    console.error(`\nwelcome: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`welcome: ${checked} passed`);
})();
