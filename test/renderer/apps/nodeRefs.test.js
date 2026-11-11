// Goal: apps can name elements inside component instances (docs/apps.md, "Layers"
// and "Node refs"), and find the same copy again.
// - The frame: a click on a link NavLink renders, inside Nav, inside BaseLayout,
//   inside the page's <Layout>, names four layers innermost first; slotted page
//   content names only itself; two Nav instances' links are told apart by their
//   copies within each instance; a chain read back lands on the same copy, also
//   after an unrelated edit adds another NavLink earlier on the page.
// - The editor: frame layers become each file's element (id, key, component name,
//   instance path, ref); a ref resolves by key after an edit moves its element,
//   by id otherwise, and says why when it cannot.
// - The RPC: refs parse (each bad shape and each bound fails), node.measure,
//   node.find, canvas.scrollTo and overlay anchors take them, and a ref anchor is
//   drawn at its resolved copy.
// Method: the frame modules run over jsdom markup written the way the marker
// serializer writes it; the editor modules run over hand-made trees, a fake canvas
// and the real dispatcher with a fake host.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = require('../../helpers/rendererModule');

const frame = load('test/fixtures/apps/frameLayersEntry.ts');
const refs = load('src/features/apps/nodeRefs.ts');
const rpc = load('shared/properties/appsRpc.ts');
const { placeOverlays } = load('src/features/apps/overlayPlacement.ts');
const { answerAppMessage, inFlightCounter } = load('src/features/apps/appRpcHost.ts');

const BL = 'src/layouts/BaseLayout.astro|';
const NAV = 'src/components/Nav.astro|';
const LINK = 'src/components/NavLink.astro|';

// A link as Nav renders it at `at`: the instance's markers around NavLink's own.
const link = (at, id, text) => `<!--avb-s:${NAV}${at}--><!--avb-s:${LINK}0--><a id="${id}">${text}</a><!--avb-e:${LINK}0--><!--avb-e:${NAV}${at}-->`;
// Nav as BaseLayout renders it at `at`.
const nav = (at, prefix) =>
  `<!--avb-s:${BL}${at}--><!--avb-s:${NAV}0--><nav>${link('0.0', `${prefix}-home`, 'Home')}${link('0.1', `${prefix}-about`, 'About')}</nav><!--avb-e:${NAV}0--><!--avb-e:${BL}${at}-->`;
// The page: <Layout> (path 0) renders BaseLayout, with a header Nav, the page's slotted <h1>, and a footer Nav.
const page = (slotted) =>
  `<!doctype html><body><!--avb-s:0--><!--avb-s:${BL}0--><div class="page">${nav('0.0', 'top')}<!--avb-s:${BL}0.1--><main>${slotted}</main><!--avb-e:${BL}0.1-->${nav('0.2', 'foot')}</div><!--avb-e:${BL}0--><!--avb-e:0--></body>`;
const HERO = '<!--avb-s:0.0--><h1 id="hero">Hi</h1><!--avb-e:0.0-->';

function collect(html) {
  const dom = new JSDOM(html);
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.Element = dom.window.Element;
  // The jsdom window lays nothing out: every box is empty, which the measuring code reads as such.
  const empty = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  dom.window.Range.prototype.getBoundingClientRect = empty;
  dom.window.Range.prototype.getClientRects = () => [];
  frame.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
  frame.resetFocusCache();
  frame.collectRegions();
  return dom;
}

test('a click on a nav link names NavLink, Nav, BaseLayout and the page, innermost first', () => {
  const dom = collect(page(HERO));
  try {
    const about = document.getElementById('top-about');
    assert.deepEqual(frame.layersAt(about), [
      { path: `${LINK}0`, occurrence: 1, copy: 0 },
      { path: `${NAV}0.1`, occurrence: 0, copy: 0 },
      { path: `${BL}0.0`, occurrence: 0, copy: 0 },
      { path: '0', occurrence: 0, copy: 0 },
    ]);
    // The footer's About: the same files and paths, told apart by the copy inside its own Nav instance.
    assert.deepEqual(frame.layersAt(document.getElementById('foot-about')), [
      { path: `${LINK}0`, occurrence: 3, copy: 0 },
      { path: `${NAV}0.1`, occurrence: 1, copy: 0 },
      { path: `${BL}0.2`, occurrence: 0, copy: 0 },
      { path: '0', occurrence: 0, copy: 0 },
    ]);
    // Slot content is the page's own: one layer, never a component's.
    assert.deepEqual(frame.layersAt(document.getElementById('hero')), [{ path: '0.0', occurrence: 0, copy: 0 }]);
  } finally {
    dom.window.close();
  }
});

test('a chain reads back to its copy, also after an unrelated edit adds a NavLink earlier on the page', () => {
  const footer = [
    { path: '0', copy: 0 },
    { path: `${BL}0.2`, copy: 0 },
    { path: `${NAV}0.1`, copy: 0 },
    { path: `${LINK}0`, copy: 0 },
  ];
  const header = footer.map((step) => (step.path === `${BL}0.2` ? { ...step, path: `${BL}0.0` } : step));
  let dom = collect(page(HERO));
  try {
    assert.equal(frame.resolveChain(footer).occurrence, 3);
    assert.equal(frame.resolveChain(header).occurrence, 1);
    assert.equal(frame.resolveChain([...footer.slice(0, 3), { path: `${LINK}0`, copy: 1 }]), undefined, 'one link per Nav position');
  } finally {
    dom.window.close();
  }
  // The page gains a NavLink in its main: every later NavLink's page-wide copy moves on by one.
  dom = collect(page(`${HERO}<!--avb-s:0.1--><!--avb-s:${LINK}0--><a id="extra">Extra</a><!--avb-e:${LINK}0--><!--avb-e:0.1-->`));
  try {
    const found = frame.resolveChain(footer);
    assert.equal(found.occurrence, 4, 'the page-wide copy moved');
    assert.deepEqual(frame.layersAt(document.getElementById('foot-about')).at(0), { path: `${LINK}0`, occurrence: 4, copy: 0 });
    assert.equal(frame.resolveChain(header).occurrence, 1);
  } finally {
    dom.window.close();
  }
  // The frame checks a chain a host sends before reading it.
  assert.deepEqual(frame.parseFrameChain([{ path: '0', copy: 0 }]), [{ path: '0', copy: 0 }]);
  for (const bad of [
    [],
    'x',
    [{ path: '', copy: 0 }],
    [{ path: '0', copy: -1 }],
    [{ path: '0', copy: 1.5 }],
    Array.from({ length: 33 }, () => ({ path: '0', copy: 0 })),
  ]) {
    assert.equal(frame.parseFrameChain(bad), undefined, JSON.stringify(bad).slice(0, 40));
  }
});

// ---------------------------------------------------------------------------
// The editor's half
// ---------------------------------------------------------------------------

const view = (id, kind, name, children = [], attributes = {}) => ({ id, kind, name, classes: [], attributes, text: undefined, children });
const KEY = 'kabc123def456';
// Files as page.getTree reads them: positional ids from disk; the open page with its live ids.
function files({ shifted = false } = {}) {
  const linkTree = [view('n0', 'element', 'a', [], { 'data-stacki-key': KEY })];
  const navTree = [view('n0', 'element', 'nav', [view('n0.0', 'component', 'NavLink'), view('n0.1', 'component', 'NavLink')])];
  // An unrelated edit puts a <p> first in the layout: its nodes shift by one, keyed ones keep their key.
  const layoutRoot = shifted
    ? view('n0', 'element', 'div', [
        view('n0.0', 'element', 'p'),
        view('n0.1', 'component', 'Nav', [], { 'data-stacki-key': 'knavkey12345' }),
        view('n0.2', 'element', 'main'),
        view('n0.3', 'component', 'Nav'),
      ])
    : view('n0', 'element', 'div', [
        view('n0.0', 'component', 'Nav', [], { 'data-stacki-key': 'knavkey12345' }),
        view('n0.1', 'element', 'main'),
        view('n0.2', 'component', 'Nav'),
      ]);
  return {
    'src/components/NavLink.astro': linkTree,
    'src/components/Nav.astro': navTree,
    'src/layouts/BaseLayout.astro': [layoutRoot],
  };
}
function host(options = {}) {
  const trees = files(options);
  const asked = [];
  return {
    asked,
    open: () => ({
      path: 'src/pages/index.astro',
      editable: true,
      truncated: false,
      nodes: [view('layout', 'component', 'Layout', [view('h7', 'element', 'h1')])],
    }),
    canvasPage: () => 'src/pages/index.astro',
    tree: async (file) => trees[file],
    locate: async (chain) => {
      asked.push(chain);
      return { path: chain.at(-1).path, occurrence: 3, x: undefined, y: undefined, box: { x: 10, y: 20, w: 30, h: 40 }, layers: [] };
    },
  };
}
const FRAME_LAYERS = [
  { path: `${LINK}0`, occurrence: 3, copy: 0 },
  { path: `${NAV}0.1`, occurrence: 1, copy: 0 },
  { path: `${BL}0.2`, occurrence: 0, copy: 0 },
  { path: '0', occurrence: 0, copy: 0 },
];

test('frame layers become each file element, with its instances and a ref', async () => {
  const layers = await refs.nodeLayers(host(), FRAME_LAYERS);
  assert.deepEqual(
    layers.map((layer) => [layer.file, layer.nodeId, layer.key, layer.component, layer.instancePath.length]),
    [
      ['src/components/NavLink.astro', 'n0', KEY, undefined, 3],
      ['src/components/Nav.astro', 'n0.1', undefined, 'NavLink', 2],
      ['src/layouts/BaseLayout.astro', 'n0.2', undefined, 'Nav', 1],
      ['src/pages/index.astro', 'layout', undefined, 'Layout', 0],
    ],
  );
  const inner = layers[0];
  assert.deepEqual(inner.ref.steps, [...inner.instancePath, { file: 'src/components/NavLink.astro', nodeId: 'n0', key: KEY, copy: 0 }]);
  assert.deepEqual(inner.instancePath[0], { file: 'src/pages/index.astro', nodeId: 'layout', key: undefined, copy: 0 });
  // A layer Stacki cannot name in its file is left out rather than invented.
  const unnamed = await refs.nodeLayers(host(), [{ path: `${LINK}9`, occurrence: 0, copy: 0 }, ...FRAME_LAYERS.slice(1)]);
  assert.equal(unnamed.length, 3);
});

test('a ref resolves by key after an edit moves its element, by id otherwise, and says why it cannot', async () => {
  const before = host();
  const keyed = {
    steps: [
      { file: 'src/pages/index.astro', nodeId: 'layout', key: undefined, copy: 0 },
      { file: 'src/layouts/BaseLayout.astro', nodeId: 'n0.0', key: 'knavkey12345', copy: 0 },
      { file: 'src/components/Nav.astro', nodeId: 'n0.1', key: undefined, copy: 0 },
      { file: 'src/components/NavLink.astro', nodeId: 'n0', key: KEY, copy: 0 },
    ],
  };
  const target = await refs.resolveNodeRef(before, keyed);
  assert.deepEqual(target, { path: `${LINK}0`, occurrence: 3, box: { x: 10, y: 20, width: 30, height: 40 } });
  assert.deepEqual(
    before.asked[0].map((step) => step.path),
    ['0', `${BL}0.0`, `${NAV}0.1`, `${LINK}0`],
  );
  // An unrelated edit shifts the layout: the keyed Nav is found at its new place, under a new id.
  const after = host({ shifted: true });
  await refs.resolveNodeRef(after, keyed);
  assert.equal(after.asked[0][1].path, `${BL}0.1`);
  const found = await refs.resolveNodeRefSteps(after, keyed);
  assert.equal(found.ref.steps[1].nodeId, 'n0.1');
  assert.equal(found.openNodeId, 'layout', 'the open page element holding it');
  // By id alone it is still the element at that id; a missing element says so.
  const gone = await refs.resolveNodeRef(after, { steps: [{ file: 'src/components/Nav.astro', nodeId: 'n9', key: undefined, copy: 0 }] });
  assert.match(gone.reason, /no element n9/);
  const unreadable = await refs.resolveNodeRef(after, { steps: [{ file: 'src/components/Missing.astro', nodeId: 'n0', key: undefined, copy: 0 }] });
  assert.match(unreadable.reason, /cannot read/);
  // The canvas does not draw it.
  const offCanvas = { ...host(), locate: async () => ({ path: undefined, occurrence: 0, box: undefined, layers: [] }) };
  assert.match((await refs.resolveNodeRef(offCanvas, keyed)).reason, /not drawn/);
});

test('refs parse with their bounds, and every bad shape fails', () => {
  const step = { file: 'src/components/Nav.astro', nodeId: 'n0.1' };
  assert.deepEqual(rpc.parseNodeRef({ steps: [step] }), { steps: [{ file: 'src/components/Nav.astro', nodeId: 'n0.1', key: undefined, copy: 0 }] });
  assert.deepEqual(rpc.parseNodeRef({ steps: [{ file: 'src/a.astro', key: KEY, copy: 2, nodeId: JSON.parse('null') }] }).steps[0], {
    file: 'src/a.astro',
    nodeId: undefined,
    key: KEY,
    copy: 2,
  });
  const bad = [
    [undefined, /object/i],
    [{}, /steps must be a list/],
    [{ steps: [] }, /at least one step/],
    [{ steps: Array.from({ length: rpc.APP_RPC_LIMITS.nodeLayersMax + 1 }, () => step) }, /at most 32 steps/],
    [{ steps: [{ file: 'src/a.astro' }] }, /nodeId, key or both/],
    [{ steps: [{ ...step, file: '/abs.astro' }] }, /relative/],
    [{ steps: [{ ...step, file: 'src/a.css' }] }, /page or component/],
    [{ steps: [{ ...step, file: 'src/a|b.astro' }] }, /no \|/],
    [{ steps: [{ ...step, key: 'nope' }] }, /key/],
    [{ steps: [{ ...step, nodeId: 'has space' }] }, /nodeId/],
    [{ steps: [{ ...step, copy: -1 }] }, /copy/],
    [{ steps: [{ ...step, copy: rpc.APP_RPC_LIMITS.nodeCopyMax + 1 }] }, /copy/],
    [{ steps: [{ ...step, copy: 'first' }] }, /copy/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => rpc.parseNodeRef(input), message, JSON.stringify(input)?.slice(0, 60));
  }
  // The methods take a ref where they take an element, and never both.
  const ref = { steps: [step] };
  assert.deepEqual(rpc.APP_METHODS['node.measure'].params({ ref }), { ref: rpc.parseNodeRef(ref) });
  assert.deepEqual(rpc.APP_METHODS['node.measure'].params({ nodeId: 'n1' }), { nodeId: 'n1', occurrence: undefined });
  assert.throws(() => rpc.APP_METHODS['node.measure'].params({ ref, occurrence: 1 }), /names one copy/);
  assert.deepEqual(rpc.APP_METHODS['node.find'].params({ ref }), { ref: rpc.parseNodeRef(ref) });
  assert.throws(() => rpc.APP_METHODS['node.find'].params({ ref, key: KEY }), /not both/);
  assert.deepEqual(rpc.APP_METHODS['canvas.scrollTo'].params({ ref, block: 'start' }), { ref: rpc.parseNodeRef(ref), block: 'start' });
  assert.throws(() => rpc.APP_METHODS['canvas.scrollTo'].params({ ref, nodeId: 'n1' }), /not both/);
  assert.deepEqual(rpc.APP_METHODS['canvas.snapshot'].params({ ref }).target, { ref: rpc.parseNodeRef(ref) });
  const [pin] = rpc.parseOverlayItems([{ kind: 'pin', id: 'p', anchor: { ref, at: { x: 0.5, y: 0 } } }]);
  assert.deepEqual(pin.anchor, { ref: rpc.parseNodeRef(ref), at: { x: 0.5, y: 0 } });
  assert.throws(() => rpc.parseOverlayItems([{ kind: 'pin', id: 'p', anchor: { ref, nodeId: 'n1' } }]), /not both/);
  // A stored ref may carry null where JSON wrote nothing: it reads as absent.
  // Equal refs are one anchor against the bound; their key ignores how they were written.
  assert.equal(rpc.nodeRefKey(rpc.parseNodeRef(ref)), rpc.nodeRefKey(rpc.parseNodeRef({ steps: [{ ...step, copy: 0 }] })));
});

test('a ref anchor is drawn at its resolved copy, and not before it resolves', () => {
  const ref = rpc.parseNodeRef({ steps: [{ file: 'src/components/NavLink.astro', nodeId: 'n0' }] });
  const overlays = new Map([['pins', rpc.parseOverlayItems([{ kind: 'pin', id: 'p', anchor: { ref, at: { x: 0, y: 0 } } }])]]);
  const rects = {
    [`${LINK}0`]: [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 100, y: 200, w: 10, h: 10 },
    ],
  };
  assert.deepEqual(
    placeOverlays(overlays, rects, 1, { target: () => undefined }, () => undefined),
    [],
    'unresolved: nothing drawn',
  );
  const [placed] = placeOverlays(overlays, rects, 2, { target: () => ({ path: `${LINK}0`, occurrence: 1 }) }, () => undefined);
  assert.deepEqual([placed.left, placed.top, placed.nodeId, placed.copy], [200, 400, undefined, 1]);
});

test('node.measure, node.find and canvas.scrollTo answer for a ref through the dispatcher', async () => {
  const roles = load('shared/properties/projectRoles.ts');
  const told = [];
  const nodeRefs = host();
  const context = {
    host: { kind: 'desktop', page: nodeRefs.open, node: () => undefined, scrollTo: { kind: 'able', run: () => ({ applied: true }) } },
    role: () => roles.ADMIN_VIEW,
    setOverlay: () => undefined,
    tellCanvas: (message) => told.push(message) > 0,
    nodeRefs,
  };
  const session = { app: { manifest: { id: 'pins', name: 'Pins', version: '1.0.0', shortcutClaims: [] } }, subscriptions: new Set(), ...inFlightCounter() };
  const ref = { steps: [{ file: 'src/components/NavLink.astro', nodeId: 'n0', key: KEY }] };
  let id = 0;
  const ask = async (method, params) => {
    id += 1;
    const answer = await answerAppMessage(session, { stacki: 'app', v: 1, id, method, params }, context);
    assert.equal(answer.error, undefined, JSON.stringify(answer.error));
    return answer.value;
  };
  assert.deepEqual(await ask('node.measure', { ref }), { rects: [{ x: 10, y: 20, width: 30, height: 40 }] });
  const found = await ask('node.find', { ref });
  assert.equal(found.ref.steps[0].key, KEY);
  assert.equal(found.nodeId, undefined, 'the open page holds no step of it');
  assert.deepEqual(await ask('canvas.scrollTo', { ref, block: 'start' }), { applied: true });
  assert.deepEqual(told.at(-1), { type: 'avb:app-scroll', space: 'viewport', x: 10, y: 20, w: 30, h: 40, block: 'start' });
});
