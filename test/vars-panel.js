// The variables panel: stylesheets, and what is in them.
//
//   node test/vars-panel.js
//
// Two clicks to see a variable is one too many — opening a stylesheet opens its
// first group, so the sheet beside the list is never empty while a file is
// open. The rest is what the list says about each file, which is the only place
// a stylesheet the panel could not read gets to say so.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cssVars = require('../electron/cssVars.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-vp-'));
  fs.mkdirSync(path.join(dir, 'src', 'styles'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'styles', 'tokens.css'),
    ':root {\n  --blue: #0af;\n  --ink: #111;\n}\n\n.light { --bg: white; }\n.dark { --bg: black; }\n'
  );
  fs.writeFileSync(path.join(dir, 'src', 'styles', 'other.css'), '.card { --lift: 2px; --shade: 4px; }\n');
  // One rule, so one group: there is no inside to show.
  fs.writeFileSync(path.join(dir, 'src', 'styles', 'motion.css'), ':root { --ease: linear; --duration: 200ms; }\n');

  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'vars-panel.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'VariablesPanel.jsx')],
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
  dom.window.avb = {
    cssVariables: async () => cssVars.readVariables(dir),
    onCssChanged: () => () => {},
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const VariablesPanel = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const all = (selector) => [...container.querySelectorAll(selector)];
  const names = () => all('.cms-collection-name').map((n) => n.textContent);

  // The panel's `selected` is state in the app, not a value the panel owns —
  // and the difference matters here, because backing out sets both at once. A
  // host that holds it the way App does is what makes that observable.
  let selected = null;
  function Host() {
    const [value, setValue] = React.useState(null);
    selected = value;
    return React.createElement(VariablesPanel, {
      project: { path: dir },
      selected: value,
      onSelect: setValue,
    });
  }
  const render = async () =>
    act(async () => {
      reactRoot.render(React.createElement(Host));
      await settle(40);
    });

  await render();
  check('stylesheets are listed', names().join('|') === 'motion.css|other.css|tokens.css', names().join('|'));
  check(
    'with what each one holds',
    all('.cms-collection-count').map((n) => n.textContent).join('|') === '2 variables|2 variables|4 variables',
    all('.cms-collection-count').map((n) => n.textContent).join('|')
  );
  check('and nothing is open yet', selected === null);

  // A stylesheet with one group opens that group, and stays in the list: there
  // is no inside to go into.
  await act(async () => {
    all('.cms-collection')[0].click();
    await settle(30);
  });
  check('a one-group stylesheet opens straight away', selected?.file.endsWith('motion.css'), JSON.stringify(selected));
  check('and the list stays where it was', names().join('|') === 'motion.css|other.css|tokens.css', names().join('|'));
  check(
    'with that stylesheet marked as the open one',
    all('.cms-collection.on').length === 1 &&
      all('.cms-collection.on')[0].textContent.includes('motion.css'),
    all('.cms-collection').map((n) => n.className).join('|')
  );
  check(
    'and no chevron promising more inside it',
    !all('.cms-collection')[0].querySelector('.cms-collection-chevron'),
    'it still points further in'
  );

  // A stylesheet with more than one opens its first group and goes inside.
  await act(async () => {
    all('.cms-collection')[2].click();
    await settle(30);
  });
  check('opening a stylesheet selects its first group', !!selected, JSON.stringify(selected));
  check('which is the first one', selected?.index === 0 && selected.file.endsWith('tokens.css'), JSON.stringify(selected));

  check('and the groups inside are listed', names().join('|') === ':root|Light', names().join('|'));
  check(
    'the open one is marked',
    all('.cms-collection.on').length === 1 && all('.cms-collection.on')[0].textContent.includes(':root'),
    all('.cms-collection').map((n) => n.className).join('|')
  );
  check(
    'a group of modes says how many',
    all('.cms-collection-count').map((n) => n.textContent).join('|') === '2 variables|2 modes',
    all('.cms-collection-count').map((n) => n.textContent).join('|')
  );

  // Backing out closes the sheet rather than leaving it on a file nobody is
  // looking at.
  await act(async () => {
    container.querySelector('.cms-crumb button').click();
    await settle(30);
  });
  check('backing out closes the sheet', selected === null);
  check(
    'and shows the stylesheets again',
    names().join('|') === 'motion.css|other.css|tokens.css',
    names().join('|')
  );

  await act(async () => reactRoot.unmount());
  fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nvars-panel: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`vars-panel: ${checked} passed`);
})();
