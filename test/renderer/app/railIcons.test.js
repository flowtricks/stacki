// Goal: the left rail can draw three icon sets (Stacki's own, Phosphor's and a
// custom one), each covering every rail button, and Settings → Editor → Rail
// icons switches between them for every icon on screen and remembers the choice.
// Method: bundle the real Settings dialog, the feature icon mapping and the
// rail icon store with esbuild into one module (so they share the store),
// stubbing the Settings sections other suites cover. The mapping is checked as
// data and as rendered markup; the switch is driven through the store and through
// the Settings dropdown in jsdom, with the stored value parsed like any input.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/rail-icons.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const stubs = {
  name: 'settings-section-stubs',
  setup(build) {
    build.onResolve(
      { filter: /cmsConnections\/CmsConnections$|studioSetup\/StudioSetup$|\/FolderSettings$|\/RolesSettings$|\/InstructionsSettings$/ },
      (args) => ({ path: args.path, namespace: 'stub' }),
    );
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      const name = args.path.split('/').pop();
      const contents = name === 'StudioSetup' ? 'export default function StudioSetup() { return null; }' : `export function ${name}() { return null; }`;
      return { loader: 'jsx', contents };
    });
  },
};
const bundled = esbuild.build({
  stdin: {
    contents: [
      "export { default as Settings } from './src/app/settings/Settings';",
      "export { FEATURE_ICONS, RAIL_ICONS, RailMoreIcon } from './src/app/featureIcons';",
      "export { RAIL_ICON_KEYS } from './src/ui/railIcons';",
      "export * from './src/app/railIconSet';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  plugins: [stubs],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
// The test DOM draws no layout, so the dropdown's scroll to its highlighted row is a no-op here.
dom.window.Element.prototype.scrollIntoView = () => undefined;
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
const menuListeners = new Map();
window.avb = {
  onMenu: (name, callback) => {
    menuListeners.set(name, callback);
    return () => menuListeners.delete(name);
  },
  settings: async () => ({ sound: false, usageCountsEnabled: true }),
  setPreference: async (input) => ({ sound: input.enabled, usageCountsEnabled: true, saved: true }),
};

const React = require('react');
const { act } = React;
const { renderToStaticMarkup } = require('react-dom/server');
const { createRoot } = require('react-dom/client');
let rail;
test.before(async () => {
  await bundled;
  rail = require(output);
});

const SETS = ['stacki', 'phosphor', 'custom'];
// Every panel the rail can show, as its access feature, and the rail key it draws.
const RAIL_FEATURES = [
  'pages',
  'navigator',
  'properties',
  'components',
  'assets',
  'cms',
  'variables',
  'selectors',
  'code',
  'history',
  'apps',
  'ai',
  'instructions',
  'audits',
];
const markup = (Icon) => renderToStaticMarkup(React.createElement(Icon, { size: 20 }));

// The icon's markup without its style attribute, which the DOM and the server serialize differently.
const drawing = (html) => html.replace(/ style="[^"]*"/g, '');
// A fresh container for each mount, so no element is handed to createRoot twice.
function container() {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

async function click(element) {
  await act(async () => element.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

test('every set draws every rail button, as a 20px SVG of its own', () => {
  assert.deepEqual(rail.RAIL_ICON_SETS, SETS);
  assert.deepEqual([...rail.RAIL_ICON_KEYS], [...RAIL_FEATURES, 'more']);
  for (const set of SETS) {
    assert.deepEqual(Object.keys(rail.RAIL_ICONS[set]).sort(), [...rail.RAIL_ICON_KEYS].sort(), `${set} covers every rail button`);
    for (const key of rail.RAIL_ICON_KEYS) {
      const drawn = markup(rail.RAIL_ICONS[set][key]);
      assert.match(drawn, /^<svg[^>]* width="20" height="20"/, `${set}/${key} is a 20px SVG`);
      assert.match(drawn, /<(path|circle|rect|ellipse)/, `${set}/${key} draws something`);
    }
  }
  for (const key of rail.RAIL_ICON_KEYS) {
    const drawn = SETS.map((set) => markup(rail.RAIL_ICONS[set][key]));
    assert.equal(new Set(drawn).size, SETS.length, `${key} differs in each set`);
  }
  assert.match(markup(rail.RAIL_ICONS.phosphor.pages), /viewBox="0 0 256 256"/, 'Phosphor draws on its 256 grid');
  assert.match(markup(rail.RAIL_ICONS.phosphor.variables), /stroke-width="16"/, 'the Phosphor-style Variables icon uses its 16-unit stroke');
  assert.match(markup(rail.RAIL_ICONS.custom.pages), /viewBox="0 0 20 20"[^>]*stroke-width="1.25"/, 'Custom draws a 1.25px stroke at 20px');
});

test('each rail feature draws its key in the chosen set', () => {
  for (const set of SETS) {
    rail.saveRailIconSet(set);
    for (const key of RAIL_FEATURES) {
      assert.equal(markup(rail.FEATURE_ICONS[`panel:${key}`]), markup(rail.RAIL_ICONS[set][key]), `panel:${key} in ${set}`);
    }
    assert.equal(markup(rail.RailMoreIcon), markup(rail.RAIL_ICONS[set].more), `More in ${set}`);
  }
});

test('a stored set is parsed: anything else falls back to Custom', () => {
  assert.equal(rail.RAIL_ICON_SET_DEFAULT, 'custom');
  assert.equal(rail.parseStoredRailIconSet('phosphor'), 'phosphor');
  assert.equal(rail.parseStoredRailIconSet('stacki'), 'stacki');
  for (const raw of [JSON.parse('null'), undefined, '', 'Phosphor', 'light', 7, {}]) {
    assert.equal(rail.parseStoredRailIconSet(raw), 'custom', `${String(raw)} falls back`);
  }
  localStorage.setItem('stacki.rail.iconSet', 'bogus');
  assert.equal(rail.loadRailIconSet(), 'custom');
  assert.throws(() => rail.saveRailIconSet('bogus'), /Assertion failed: A rail icon set is one of RAIL_ICON_SETS/);
});

test('switching the set redraws a mounted icon and is remembered', async () => {
  rail.saveRailIconSet('stacki');
  const host = container();
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(rail.FEATURE_ICONS['panel:pages'], { size: 20 })));
  const shown = () => drawing(host.innerHTML);
  assert.equal(shown(), drawing(markup(rail.RAIL_ICONS.stacki.pages)));
  await act(async () => rail.saveRailIconSet('phosphor'));
  assert.equal(shown(), drawing(markup(rail.RAIL_ICONS.phosphor.pages)));
  assert.equal(localStorage.getItem('stacki.rail.iconSet'), 'phosphor');
  assert.equal(rail.loadRailIconSet(), 'phosphor');
  await act(async () => root.unmount());
});

test('Settings → Editor → Rail icons switches the set', async () => {
  rail.saveRailIconSet('custom');
  const iconHost = container();
  const icon = createRoot(iconHost);
  await act(async () => icon.render(React.createElement(rail.FEATURE_ICONS['panel:selectors'], { size: 20 })));
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(rail.Settings, { projectPath: '/project', previewURL: undefined })));
  await act(async () => menuListeners.get('settings')());
  const trigger = document.querySelector('button[aria-label="Rail icons"]');
  assert.ok(trigger, 'Editor settings has a Rail icons dropdown');
  assert.match(trigger.textContent, /Custom/);
  await click(trigger);
  const labels = [...document.querySelectorAll('.dd-option .dd-option-label')].map((label) => label.textContent);
  assert.deepEqual(labels, ['Stacki (current)', 'Phosphor', 'Custom']);
  await click([...document.querySelectorAll('.dd-option')].find((option) => option.textContent.includes('Phosphor')));
  assert.equal(rail.loadRailIconSet(), 'phosphor');
  assert.equal(drawing(iconHost.innerHTML), drawing(markup(rail.RAIL_ICONS.phosphor.selectors)));
  await act(async () => root.unmount());
  await act(async () => icon.unmount());
});
