// Goal: clicking audit findings in three different components and then pressing the green back arrow once returns
// to the page. The bug: every finding in another component opened it on top of the last one, so the back arrow
// stepped through each component the Audits panel had ever opened before it reached the page.
// Method: the real App in jsdom, with every panel stubbed to record its props (stubPanels), the rail stubbed so the
// test can open the Audits tab, and the Audits panel stubbed so the test calls the real onReveal Desktop hands it
// (src/app/shell/DesktopAudits.tsx) as a finding click does. Each file read is held and answered by the test, which
// tells what the editor opened. The back arrow is the title bar's real `.comp-back` button, clicked in the DOM.
// A finding on a page, clicked from inside a component, is checked to leave the component context entirely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { repoPath, stubPanels, stubSources } = require('../../helpers/sources.js');

const { waitForSteady } = require('../../helpers/waitFor.js');

// One turn of the event loop: the promises a bridge call resolves, and the render they cause, run before the next line.
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const pageState = (label) => {
  const source = `<div data-label="${label}"></div>\n`;
  return { ...parsePage(source, { locs: true }), source, checksum: sha256(source) };
};
const recorder = (name) => `export default function Stub(props) { globalThis.__panels[${JSON.stringify(name)}] = props; return null; }`;

// A failed assertion skips the unmount, leaving the App's timers alive; exit regardless once the tests are done.
test.after(() => {
  setTimeout(() => process.exit(), 2000).unref();
});

test('three audit jumps into components, then one back, returns to the page', async () => {
  const directory = repoPath('node_modules/.stacki-test/audit-component-jump');
  fs.mkdirSync(directory, { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/app/App.tsx')],
    outfile: path.join(directory, 'app.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('audit-jump-stubs', {
        'src/app/LeftRail.tsx': () => ({ contents: recorder('LeftRail'), loader: 'jsx' }),
        'src/features/audits/AuditsPanel.tsx': () => ({ contents: recorder('AuditsPanel'), loader: 'jsx' }),
        // The runner reads the project from disk; the test drives findings by hand.
        'src/features/audits/useAuditRunner.ts': () => ({ contents: 'export function useAuditRunner() {}', loader: 'js' }),
      }),
      stubPanels('capture-panels', (name) => ({ contents: "export const relativeTime = () => ''; " + recorder(name), loader: 'jsx' })),
    ],
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.ResizeObserver = global.ResizeObserver;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  global.__panels = {};
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const pages = ['index', 'second'].map((name) => ({
    name: `${name}.astro`,
    path: `/project/src/pages/${name}.astro`,
    route: name === 'index' ? '/' : `/${name}`,
  }));
  const components = ['Choice', 'Footer', 'Slider'].map((name) => ({ name, path: `/project/src/components/${name}.astro`, folder: '' }));
  const scan = { pages, components, layouts: [], pageFolders: [] };
  // Every read is answered with a page whose label is the file's basename, so what is open is told by its label.
  const reads = [];
  const bridge = new Proxy(
    {
      pendingProject: async () => undefined,
      scanProject: async () => scan,
      startDevServer: async () => ({ url: 'http://localhost:4321' }),
      listProjectClasses: async () => [],
      readPage: async (file) => {
        reads.push(file);
        return pageState(path.basename(file, '.astro'));
      },
      gitInfo: async () => ({ isRepo: false }),
      publishAvailability: async () => ({ github: 'unknown', hosting: 'unconfigured' }),
      onCssChanged: () => () => {},
    },
    {
      get: (target, key) => {
        if (key in target) {
          return target[key];
        }
        return String(key).startsWith('on') ? () => () => {} : async () => undefined;
      },
    },
  );
  window.avb = bridge;
  global.avb = bridge;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const root = createRoot(document.getElementById('root'));
  const App = require(path.join(directory, 'app.js')).default;
  const openPath = () => reads.at(-1);
  const backButton = () => document.querySelector('.comp-back') ?? undefined;
  // The app is settled when what the test reads (how many files were read, which one is open, the back arrow) stopped changing, not
  // after a guessed time.
  const settle = () =>
    waitForSteady({
      what: 'the open file, the reads and the back arrow stopped changing',
      read: async () => {
        await act(async () => {
          await tick();
        });
        return JSON.stringify([reads.length, openPath(), backButton()?.textContent ?? 'none']);
      },
      until: () => true,
    });
  await act(async () => {
    root.render(React.createElement(App));
    await tick();
  });
  await act(async () => {
    await __panels.WelcomeScreen.onOpen('/project');
    await tick();
  });
  await settle();
  assert.equal(openPath(), pages[0].path, 'the project opens on its index page');
  assert.equal(backButton(), undefined, 'a page has no back arrow');
  await act(async () => {
    __panels.LeftRail.onSelect('audits');
    await tick();
  });
  await settle();
  assert.ok(__panels.AuditsPanel, 'the Audits tab is open');

  for (const component of components) {
    await act(async () => {
      __panels.AuditsPanel.onReveal(`src/components/${component.name}.astro`, [0], undefined);
      await tick();
    });
    await settle();
    assert.equal(openPath(), component.path, `the finding opens ${component.name}`);
    assert.ok(backButton(), 'a component shows the back arrow');
    assert.match(backButton().textContent, new RegExp(component.name));
  }
  // Re-clicking a finding in the open component opens nothing again.
  const readsBefore = reads.length;
  await act(async () => {
    __panels.AuditsPanel.onReveal('src/components/Slider.astro', [0], undefined);
    await tick();
  });
  await settle();
  assert.equal(reads.length, readsBefore, 'the open component is not read or stacked again');

  await act(async () => {
    backButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
  });
  await settle();
  assert.equal(openPath(), pages[0].path, 'one back returns to the page');
  assert.equal(backButton(), undefined, 'nothing is left to back out of');

  // A finding on a page, clicked from inside a component, leaves the component for that page.
  await act(async () => {
    __panels.AuditsPanel.onReveal('src/components/Footer.astro', [0], undefined);
    await tick();
  });
  await settle();
  assert.ok(backButton(), 'Footer is open');
  await act(async () => {
    __panels.AuditsPanel.onReveal('src/pages/second.astro', undefined, undefined);
    await tick();
  });
  await settle();
  assert.equal(openPath(), pages[1].path);
  assert.equal(backButton(), undefined, 'the page finding exits the component context');
  await act(async () => {
    root.unmount();
  });
});
