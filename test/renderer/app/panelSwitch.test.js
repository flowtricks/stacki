// Goal: switching between left-rail panels is instant and stable. A panel that
// was opened before must draw its finished content in the first frame it is
// shown again, and a panel never opened must do the same once the app's
// prefetch pass (src/app/shell/panelPrefetch.ts) has run. "Finished" means the
// first frame is the frame the panel settles on: no empty frame, no loading
// skeleton, and no content that is swapped or moved a frame later.
//
// Why this exists: switching panels flickered even after the chunks were
// preloaded. Only the open panel is mounted (AppShell.tsx says why), so each
// open is a fresh mount, and several panels drew something else first: the
// Variables and CMS panels drew their file or group list and opened the
// selected one from an effect a frame later; the Pages panel drew pages in the
// default order until its order file came back; the Instructions and Apps panels
// drew their loading state on every open; the CMS panel's connection rows
// arrived after its collections and pushed them down; and the Git timeline's
// author pictures started every mount on their initials.
//
// Method: the real panels are bundled with esbuild and mounted in jsdom. Their
// bridge modules to the main process are wrapped (stubbedModules below): each
// exported function answers from a fixture after a short delay, like an IPC
// round trip, and every other export is the real one. A small rail mounts only
// the active panel, as LeftPanel does. The first frame is the DOM of the first
// commit, read in its layout effects (FirstCommitProbe), before any passive
// effect can change it; the test then lets the reads land and records every
// distinct frame until the panel holds still. A frame is classified as empty, skeleton, or content with
// a signature of its rows, so "content that moved" shows as a second content
// frame. The measurement is printed per panel; the assertions are that a
// re-open and a prefetched first open each produce exactly one frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.IS_REACT_ACT_ENVIRONMENT = true;
// Anything a panel asks main for that no fixture answers: a subscription returns
// its unsubscribe, any other call answers nothing.
const unanswered = async () => undefined;
const bridge = new Proxy({}, { get: (_target, name) => (typeof name === 'string' && name.startsWith('on') ? () => () => {} : unanswered) });
dom.window.avb = bridge;
global.avb = bridge;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const create = React.createElement;

const PROJECT = '/projects/site';
// An IPC round trip: long enough that a read lands after the first frame.
const ROUND_TRIP_MS = 5;
// A panel that has not held still after this many tasks is a failure in itself.
const SETTLE_TASKS_MAX = 40;

// The bridge modules whose functions answer from fixtures (globalThis.__panelStubs).
const stubbedModules = [
  'src/ipc/variablesBridge.ts',
  'src/features/cms/cmsPanelBridge.ts',
  'src/ipc/projectFolderSettings.ts',
  'src/ipc/cmsConnectionsBridge.ts',
  'src/features/cms/remoteCmsCache.ts',
  'src/ipc/projectMetadataBridge.ts',
  'src/features/instructions/instructionsBridge.ts',
  'src/ipc/appsBridge.ts',
  'src/ipc/appFoldersBridge.ts',
  'src/features/assets/assetPanelBridge.ts',
].map((file) => repoPath(file));

const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), ROUND_TRIP_MS));
const variableGroup = (label, kind, columns) => ({
  kind,
  label,
  columns: columns.map((selector) => ({ selector, label: selector })),
  blocks: [{ kind: 'rows', title: undefined, rows: [{ label: '--space', cells: columns.map(() => ({ value: '1rem' })) }] }],
});
const cmsFile = (rel) => ({
  rel,
  name: rel
    .split('/')
    .at(-1)
    .replace(/\.json$/, ''),
  dir: 'data/team',
  data: [{ title: 'Ada', bio: 'Engineer' }],
});
const reads = { count: 0 };
const fixtures = {
  readCSSVariables: () =>
    later({
      ok: true,
      value: {
        files: [
          {
            rel: 'src/styles/base.css',
            name: 'base.css',
            count: 4,
            groups: [variableGroup(':root', 'single', [':root']), variableGroup('Theme', 'modes', ['.light', '.dark', '.dim'])],
          },
        ],
        values: {},
      },
    }),
  readCmsFiles: () => later({ ok: true, value: [cmsFile('data/team/people.json'), cmsFile('data/team/roles.json')] }),
  readContentCollections: () => later({ ok: true, value: { collections: [], covered: { files: [], dirs: [] } } }),
  readProjectFolderSettings: () => later(undefined),
  listCmsConnections: () => later({ connections: [{ id: 'sanity-1', kind: 'sanity', name: 'Sanity', projectId: 'p', dataset: 'production' }] }),
  prefetchConnection: () => undefined,
  readMetadata: (_project, kind) => {
    reads.count += 1;
    return later({ source: kind === 'pages' ? JSON.stringify({ version: 1, entries: ['zeta.astro', 'index.astro', 'about.astro'] }) : undefined });
  },
  listInstructions: () => later({ files: [{ path: 'AGENTS.md', section: 'rules', sizeBytes: 12, skill: undefined }], folders: [], truncated: false }),
  readInstructionSettings: () => later({ settings: { version: 1, hidden: [] }, source: undefined }),
  listInstalledAppList: () => later({ ok: true, value: { apps: [], broken: [] } }),
  listBrokenAppFolders: () => later({ ok: true, value: [] }),
  readAssetListing: () => later({ ok: true, value: { entries: [], missing: false } }),
};
globalThis.__panelStubs = fixtures;

let modules;
test.before(async () => {
  const outfile = repoPath('node_modules/.stacki-test/panel-switch.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const stubbed = new Set(stubbedModules);
  await esbuild.build({
    stdin: {
      contents: [
        `export { default as VariablesPanel } from './src/features/variables/VariablesPanel';`,
        `export { default as CmsPanel } from './src/features/cms/CmsPanel';`,
        `export { default as PagesPanel } from './src/features/pages/PagesPanel';`,
        `export { default as InstructionsPanel } from './src/features/instructions/InstructionsPanel';`,
        `export { default as AppsPanel } from './src/features/apps/AppsPanel';`,
        `export { default as CommitAvatar } from './src/features/history/CommitAvatar';`,
        `export { default as StructurePanel } from './src/features/structure/StructurePanel';`,
        `export { prefetchPanels } from './src/app/shell/panelPrefetch';`,
        `export { prewarmPageOrder } from './src/features/pages/pageOrderPersistence';`,
        `export { prewarmInstalledApps } from './src/features/apps/installedAppsCache';`,
        `export { prewarmInstructionsListing } from './src/features/instructions/instructionsListingCache';`,
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [stubPlugin(stubbed)],
  });
  modules = require(outfile);
});

// Wraps each stubbed module: its exported functions call the fixture of the same
// name when there is one and the real function otherwise; every other export is
// the real module's.
function stubPlugin(stubbed) {
  return {
    name: 'panel-stubs',
    setup(build) {
      build.onResolve({ filter: /^real:/ }, (args) => ({ path: args.path.slice('real:'.length), namespace: 'real' }));
      build.onLoad({ filter: /.*/, namespace: 'real' }, (args) => ({
        contents: fs.readFileSync(args.path, 'utf8'),
        loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
        resolveDir: path.dirname(args.path),
      }));
      build.onLoad({ filter: /\.tsx?$/ }, (args) => {
        if (!stubbed.has(args.path)) {
          return undefined;
        }
        const source = fs.readFileSync(args.path, 'utf8');
        const names = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]);
        const real = JSON.stringify(`real:${args.path}`);
        const wrappers = names.map(
          (name) =>
            `export function ${name}(...args) { const stub = globalThis.__panelStubs[${JSON.stringify(name)}]; return stub ? stub(...args) : real.${name}(...args); }`,
        );
        return {
          contents: [`import * as real from ${real};`, `export * from ${real};`, ...wrappers].join('\n'),
          loader: 'ts',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

// What one frame of a panel shows.
function classify(host) {
  if (host.querySelector('.panel-loading, .apps-skeleton, [role="status"][aria-label^="Loading"]')) {
    return 'skeleton';
  }
  const text = host.textContent.replace(/\s+/g, ' ').trim();
  if (text.includes('Reading the project')) {
    return 'skeleton';
  }
  const rows = [...host.querySelectorAll('.cms-collection, .page-row, [data-page], .tree-row, .instructions-row, .history-avatar img')];
  if (text.length === 0) {
    return 'empty';
  }
  const imageStates = [...host.querySelectorAll('img[data-state]')].map((image) => image.dataset.state).join(',');
  return `content:${rows.length}:${text}:${imageStates}`;
}

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: (element) => act(() => root.render(element)),
    unmount: () => act(() => root.unmount()),
  };
}

// Shows `element` and records each distinct frame until the panel holds still.
async function recordOpen(view, element) {
  const frames = [];
  // The first frame is read in the first commit's layout effects, before any
  // passive effect runs: act flushes those (and the renders they cause) before
  // it returns, but in the app a state update from a passive effect renders in
  // a later task, after the browser has painted the first commit.
  const probe = create(FirstCommitProbe, { host: view.host, frames });
  view.render(create(React.Fragment, undefined, element, probe));
  assert.equal(frames.length, 1, 'The probe read the first commit');
  const after = classify(view.host);
  if (after !== frames.at(-1)) {
    frames.push(after);
  }
  for (let task = 0; task < SETTLE_TASKS_MAX; task++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS)));
    const frame = classify(view.host);
    if (frame !== frames.at(-1)) {
      frames.push(frame);
    }
  }
  return frames;
}

// Rendered after the panel, so its layout effect sees the panel's first commit.
function FirstCommitProbe({ host, frames }) {
  React.useLayoutEffect(() => {
    if (frames.length === 0) {
      frames.push(classify(host));
    }
  });
  return undefined;
}

// The rail: the app state a panel reads (its selection) lives above it and
// survives a switch; the panel itself mounts only while its tab is open.
function railPanels(state) {
  const noop = () => undefined;
  return {
    variables: () =>
      create(modules.VariablesPanel, {
        project: { path: PROJECT },
        place: { openFile: undefined, contextPage: undefined },
        selected: state.variable,
        onSelect: (selection) => {
          state.variable = selection;
        },
      }),
    cms: () =>
      create(modules.CmsPanel, {
        project: { path: PROJECT },
        selectedRel: state.cmsRel,
        selectedContent: undefined,
        currentFile: undefined,
        refreshKey: 0,
        onSelect: (rel) => {
          state.cmsRel = rel;
        },
        onSelectContent: noop,
        onOpenSettings: noop,
        showToast: noop,
      }),
    pages: () =>
      create(modules.PagesPanel, {
        projectPath: PROJECT,
        scan: { pages: ['about', 'index', 'zeta'].map(scanPage), pageFolders: [], layouts: [] },
        currentPage: undefined,
        onSelect: noop,
        onCreate: noop,
        onCreateTemplate: async () => undefined,
        connectSanity: () => undefined,
        onDelete: noop,
        onMovePage: noop,
        onCreateFolder: async () => undefined,
        onRename: async () => undefined,
        onRenameFolder: noop,
        onDeleteFolder: noop,
      }),
    instructions: () => create(modules.InstructionsPanel, { projectPath: PROJECT, showToast: noop }),
    // The selected row sits three levels down, inside rows that start folded.
    navigator: () =>
      create(modules.StructurePanel, {
        pageState: { editable: true, model: { nodes: NAVIGATOR_NODES, imports: [] }, source: '' },
        currentPage: { kind: 'page' },
        layouts: [],
        currentLayoutName: '',
        selectedId: 'deep',
        onSelect: noop,
        onChangeLayout: noop,
        onDropComponent: noop,
        onMoveNode: noop,
      }),
    apps: () =>
      create(modules.AppsPanel, {
        projectPath: PROJECT,
        role: { id: 'admin', name: 'Admin', isAdmin: true, features: new Set(), appPermissions: {}, pinnedApps: [] },
        notify: noop,
      }),
  };
}

const element = (id, children = []) => ({ id, kind: 'element', name: 'div', props: { class: id }, children });
const NAVIGATOR_NODES = [element('page', [element('hero', [element('content', [element('deep')])]), element('footer', [element('links')])])];

function scanPage(name) {
  return { path: `${PROJECT}/src/pages/${name}.astro`, name: `${name}.astro`, route: name === 'index' ? '/' : `/${name}` };
}

const measured = [];
function report(panel, open, frames) {
  const firstContent = frames.findIndex((frame) => frame.startsWith('content'));
  measured.push({
    panel,
    open,
    frames: frames.length,
    framesBeforeContent: firstContent === -1 ? frames.length : firstContent,
    sequence: frames.map((frame) => frame.split(':')[0]).join(' → '),
  });
}

test.after(() => {
  console.log('Panel open sequences (frames until the panel held still):');
  console.table(measured);
});

test('baseline: with nothing cached, a first open draws a skeleton or a list that changes', async () => {
  // Measured before the prefetch runs, against fresh caches: the cost a first
  // open pays when nothing was read ahead. The Variables panel is the one in
  // the report: it drew base.css as a row, then opened it to its groups.
  const state = {};
  const panels = railPanels(state);
  const view = mount();
  const frames = await recordOpen(view, panels.variables());
  report('variables', 'first, nothing cached', frames);
  assert.ok(frames.length > 1, 'An uncached first open settles after its first frame');
  assert.equal(frames[0], 'skeleton', 'With nothing cached, the panel says it is loading');
  view.unmount();
});

test('every rail panel re-opens on its finished content in the first frame', async () => {
  const state = { cmsRel: 'data/team/roles.json' };
  const panels = railPanels(state);
  const view = mount();
  for (const [name, panel] of Object.entries(panels)) {
    // The first visit reads whatever the panel reads and settles.
    await recordOpen(view, panel());
    view.render(create('div'));
    const frames = await recordOpen(view, panel());
    report(name, 're-open', frames);
    assert.equal(frames.length, 1, `${name}: a re-open holds its first frame (${frames.join(' | ')})`);
    assert.ok(frames[0].startsWith('content'), `${name}: a re-open draws content, not ${frames[0]}`);
    view.render(create('div'));
  }
  view.unmount();
});

test('a panel never opened, once prefetched, draws its finished content in its first frame', async () => {
  // A second project: nothing this file did above is cached under it.
  const project = '/projects/other';
  const done = new Promise((resolve) => {
    modules.prefetchPanels({
      projectPath: project,
      preloadChunks: undefined,
      hostReads: [
        () => modules.prewarmPageOrder(project),
        () => modules.prewarmInstalledApps(project),
        () => modules.prewarmInstructionsListing(project),
        async () => resolve(),
      ],
    });
  });
  await done;
  const state = { cmsRel: 'data/team/roles.json' };
  const view = mount();
  const panels = Object.entries(railPanels(state));
  for (const [name, panel] of panels) {
    const element = panel();
    const frames = await recordOpen(view, React.cloneElement(element, retarget(element.props, project)));
    report(name, 'first, prefetched', frames);
    assert.equal(frames.length, 1, `${name}: a prefetched first open holds its first frame (${frames.join(' | ')})`);
    assert.ok(frames[0].startsWith('content'), `${name}: a prefetched first open draws content, not ${frames[0]}`);
    view.render(create('div'));
  }
  view.unmount();
});

test('a prefetch that is cancelled reads nothing', async () => {
  const before = reads.count;
  const cancel = modules.prefetchPanels({
    projectPath: '/projects/closed',
    preloadChunks: undefined,
    hostReads: [() => modules.prewarmPageOrder('/projects/closed')],
  });
  cancel();
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  assert.equal(reads.count, before, 'Closing the project before the pass starts stops it');
  assert.throws(
    () =>
      modules.prefetchPanels({ projectPath: '/projects/many', preloadChunks: undefined, hostReads: Array.from({ length: 7 }, () => async () => undefined) }),
    /prefetchPanels: the host reads are bounded/,
  );
});

test('a Git author picture already shown draws with its row, not on its initials first', async () => {
  const url = 'https://avatars.example/ada.png';
  const view = mount();
  view.render(create(modules.CommitAvatar, { name: 'Ada Lovelace', email: 'ada@example.com', url }));
  const image = view.host.querySelector('img');
  assert.equal(image.dataset.state, 'loading', 'baseline: a picture never shown waits for its load');
  await act(async () => image.dispatchEvent(new dom.window.Event('load')));
  assert.equal(view.host.querySelector('img').dataset.state, 'ready');
  view.render(create('div'));
  view.render(create(modules.CommitAvatar, { name: 'Ada Lovelace', email: 'ada@example.com', url }));
  assert.equal(view.host.querySelector('img').dataset.state, 'ready', 'A re-mounted row starts on its picture');
  assert.equal(view.host.querySelector('img').getAttribute('decoding'), 'sync', 'and decodes it with the row');
  view.unmount();
});

// The props of a rail panel pointed at another project.
function retarget(props, project) {
  if ('project' in props) {
    return { project: { path: project } };
  }
  return { projectPath: project };
}
