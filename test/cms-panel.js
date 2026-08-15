// The panel that lists collections, mounted.
//
//   node test/cms-panel.js [projectDir]
//
// It answers to two sources now — the JSON files under src/, and the
// collections the content config declares — and the reason this test exists is
// that asking both at once made either one's failure look like an empty
// project. A panel that shows nothing is indistinguishable from a project with
// nothing in it, which is the worst thing it could do.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readContentConfig, stopAllServices } = require('../electron/contentConfig.js');
const { listEntries, countEntries, coveredPaths } = require('../electron/contentEntries.js');

const DEFAULT_FIXTURE = path.join(os.homedir(), 'Downloads', 'awesome-client-main');
const source = path.resolve(process.argv[2] || process.env.STACKI_CONTENT_FIXTURE || DEFAULT_FIXTURE);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Every .json under src/, the way the main process lists it — enough of
// cms:list for the panel to have something to show.
function listCms(root) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, entryRel);
      else if (/\.json$/i.test(entry.name)) {
        try {
          files.push({
            rel: entryRel,
            name: entry.name,
            dir: rel,
            data: JSON.parse(fs.readFileSync(full, 'utf8')),
          });
        } catch {
          /* not our problem here */
        }
      }
    }
  };
  walk(path.join(root, 'src'), '');
  return { files };
}

(async () => {
  if (!fs.existsSync(path.join(source, 'src', 'content.config.ts'))) {
    console.log(`cms-panel: skipped (no project at ${source})`);
    return;
  }
  const config = await readContentConfig(source, { force: true });
  if (config.error) {
    console.error(`cms-panel: could not read the config — ${config.error}`);
    process.exit(1);
  }

  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'cms-panel.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'CmsPanel.jsx')],
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
  // jsdom has no layout, so it has no scrollIntoView; the popup calls it to
  // keep the highlighted option visible.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const contentCollections = async () => ({
    collections: config.collections.map((c) => ({
      name: c.name,
      editable: c.editable,
      loader: c.loader,
      error: c.error || null,
      count: countEntries(source, c),
    })),
    covered: coveredPaths(config.collections),
    configPath: config.configPath,
  });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const CmsPanel = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);

  const mount = async (bridge) => {
    dom.window.avb = { onCmsChanged: () => () => {}, ...bridge };
    await act(async () => {
      reactRoot.render(
        React.createElement(CmsPanel, {
          project: { path: source },
          selectedRel: null,
          selectedContent: null,
          currentFile: null,
          refreshKey: Math.random(),
          onSelect: () => {},
          onSelectContent: () => {},
          onOpenSettings: () => {},
          showToast: () => {},
        })
      );
      await settle(80);
    });
  };
  const all = (selector) => [...container.querySelectorAll(selector)];
  const text = () => container.textContent;
  const rowNamed = (name) =>
    all('.cms-collection').find((node) => node.querySelector('.cms-collection-name')?.textContent === name);

  // --- both sources present --------------------------------------------------
  await mount({ listCms: async (root) => listCms(root), contentCollections });
  check('the content group is listed', !!rowNamed('Content collections'), text());
  check(
    'with every collection counted',
    /26 collections/.test(rowNamed('Content collections')?.textContent || ''),
    rowNamed('Content collections')?.textContent
  );
  check('and the project does not read as empty', !/No content found/.test(text()));
  check(
    'a data file a collection owns is not listed twice',
    !all('.cms-collection').some((n) => /^Data$/.test(n.querySelector('.cms-collection-name')?.textContent || '')),
    all('.cms-collection').map((n) => n.querySelector('.cms-collection-name')?.textContent).join(', ')
  );

  // --- the content config cannot be read ------------------------------------
  await mount({
    listCms: async (root) => listCms(root),
    contentCollections: async () => {
      throw new Error('no dependencies installed');
    },
  });
  check(
    'a broken content config leaves the JSON files listed',
    all('.cms-collection').length > 0,
    'the panel went empty because one of its two questions failed'
  );
  check('and does not claim the project is empty', !/No content found/.test(text()));

  // --- an older preload, with no content bridge at all ------------------------
  await mount({ listCms: async (root) => listCms(root) });
  check('a missing bridge is survivable', all('.cms-collection').length > 0);

  // --- a project with neither ------------------------------------------------
  await mount({ listCms: async () => ({ files: [] }), contentCollections: async () => ({ collections: [] }) });
  check('an actually empty project says so', /No content found/.test(text()));

  await act(async () => reactRoot.unmount());

  if (failures.length) {
    console.error(`\ncms-panel: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    stopAllServices();
    process.exit(1);
  }
  console.log(`cms-panel: ${checked} passed  [${path.basename(source)}]`);
  stopAllServices();
})();
