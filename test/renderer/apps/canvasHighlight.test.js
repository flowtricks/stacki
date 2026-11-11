// Goal: `canvas.highlight` draws one element as the editor draws it (docs/apps.md,
// "Highlights"): a component instance as a component (⬡ and its name), an element by
// its first class or tag, inside closed components too; display only, one at a time;
// cleared by the app, by its stopping, by another rail panel and by the outline mode
// resetting.
// Method: the runtime, dispatcher and outline store in one bundle, over a fake host
// whose files are hand-made trees and whose canvas answers every chain with one copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const world = load('test/fixtures/apps/highlightEntry.ts');
const roles = load('shared/properties/projectRoles.ts');

const view = (id, kind, name, children = [], classes = []) => ({ id, kind, name, classes, attributes: {}, text: undefined, children });
const PAGE = 'src/pages/index.astro';
const TREES = {
  'src/layouts/BaseLayout.astro': [view('n0', 'element', 'html', [view('n0.0', 'component', 'Nav')])],
  'src/components/Nav.astro': [view('n0', 'element', 'nav', [view('n0.0', 'component', 'NavLink'), view('n0.1', 'element', 'a', [], ['nav_logo'])])],
};
const nodeRefs = {
  open: () => ({ path: PAGE, editable: true, truncated: false, nodes: [view('layout', 'component', 'Layout', [view('n0.0', 'element', 'section')])] }),
  canvasPage: () => PAGE,
  tree: async (file) => TREES[file],
  locate: async (chain) => ({ path: chain.at(-1).path, occurrence: 0, x: undefined, y: undefined, box: undefined, layers: [] }),
};
const host = { kind: 'desktop', page: nodeRefs.open, node: () => undefined };
const context = { host, role: () => roles.ADMIN_VIEW, setOverlay: () => undefined, nodeRefs, highlight: world.appHighlights };
const sessionOf = (id) => ({ app: { manifest: { id, name: id, version: '1.0.0', shortcutClaims: [] } }, subscriptions: new Set(), ...world.inFlightCounter() });
let requestId = 0;
async function ask(session, params) {
  requestId += 1;
  const answer = await world.answerAppMessage(session, { stacki: 'app', v: 1, id: requestId, method: 'canvas.highlight', params }, context);
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  return answer.value;
}
const steps = (...list) => ({ steps: list.map(([file, nodeId]) => ({ file, nodeId })) });
const summary = (id) => ({ manifest: { id, name: id } });

test('a component instance inside closed components draws as a component, an element by its class', async () => {
  const pins = sessionOf('pins');
  // The <NavLink> in Nav, in BaseLayout's <Nav>, under the page's <Layout>: inside two closed components.
  const navLink = steps([PAGE, 'layout'], ['src/layouts/BaseLayout.astro', 'n0.0'], ['src/components/Nav.astro', 'n0.0']);
  assert.deepEqual(await ask(pins, { ref: navLink }), { applied: true });
  const shown = world.canvasHighlight();
  assert.deepEqual(shown, {
    path: 'src/components/Nav.astro|0.0',
    occurrence: 0,
    node: { kind: 'component', label: 'NavLink', tag: undefined },
    style: 'selected',
  });
  assert.deepEqual(world.deepHoverNode(shown.path), shown.node, 'the outline labels it from the highlight');
  // An element: its first class.
  await ask(pins, { ref: steps([PAGE, 'layout'], ['src/layouts/BaseLayout.astro', 'n0.0'], ['src/components/Nav.astro', 'n0.1']) });
  assert.deepEqual(world.canvasHighlight().node, { kind: 'element', label: '.nav_logo', tag: 'a' });
  // An open-page element by id: its tag when it has no class.
  await ask(pins, { nodeId: 'n0.0' });
  assert.deepEqual(world.canvasHighlight(), { path: '0.0', occurrence: 0, node: { kind: 'element', label: 'section', tag: 'section' }, style: 'selected' });
  // The hover look, when an app asks for it.
  await ask(pins, { nodeId: 'n0.0', style: 'hover' });
  assert.equal(world.canvasHighlight().style, 'hover');
  // Clearing: the app's own clear, with nothing or an empty object.
  assert.deepEqual(await ask(pins, undefined), { applied: true });
  assert.equal(world.canvasHighlight(), undefined);
  await ask(pins, { nodeId: 'n0.0' });
  await ask(pins, {});
  assert.equal(world.canvasHighlight(), undefined);
  // A target that is gone says so and draws nothing.
  assert.match((await ask(pins, { ref: steps(['src/components/Nav.astro', 'n9']) })).reason, /no element/);
  assert.equal(world.canvasHighlight(), undefined);
});

test('one highlight at a time, cleared by another panel, an outline reset and its app stopping', async () => {
  world.launchApp(summary('pins'), 'panel');
  world.launchApp(summary('notes'), 'panel');
  const pins = sessionOf('pins');
  const notes = sessionOf('notes');
  await ask(pins, { nodeId: 'n0.0' });
  await ask(notes, { nodeId: 'layout' });
  assert.equal(world.canvasHighlight().path, '0', 'the latest app draws');
  await ask(pins, undefined);
  assert.equal(world.canvasHighlight().path, '0', 'an app clears only its own');
  // Another rail panel.
  world.noteLeftPanel('apps');
  assert.notEqual(world.canvasHighlight(), undefined, 'the Apps panel keeps it');
  world.noteLeftPanel('navigator');
  assert.equal(world.canvasHighlight(), undefined);
  // The outline mode resetting.
  world.outlineModeOwner.set('notes', 'deep');
  await ask(notes, { nodeId: 'layout' });
  world.outlineModeOwner.reset('replaced');
  assert.equal(world.canvasHighlight(), undefined);
  // Its app stopping.
  await ask(notes, { nodeId: 'layout' });
  world.stopApp('pins');
  assert.notEqual(world.canvasHighlight(), undefined, 'another app stopping leaves it');
  world.stopApp('notes');
  assert.equal(world.canvasHighlight(), undefined);
});

test('the outline draws a highlight in the selected look, in its own slot beside a real selection', () => {
  const overlays = load('test/fixtures/apps/highlightOverlaysEntry.ts');
  const draw = (highlight, selectionPath) => {
    overlays.setCanvasHighlight(highlight);
    return overlays.renderToStaticMarkup(
      overlays.createElement(overlays.PreviewOverlays, {
        rects: { '0.0': [{ x: 0, y: 0, w: 10, h: 10 }], 'src/components/Nav.astro|0.0': [{ x: 0, y: 40, w: 10, h: 10 }] },
        spacing: {},
        scale: 1,
        selPath: selectionPath,
        selOcc: 0,
        hoverPath: undefined,
        hoverOcc: undefined,
        focusPath: undefined,
        focusWhole: false,
        overlayInfo: (path) =>
          path === '0.0'
            ? {
                label: '.hero',
                kind: 'element',
                tag: 'section',
                astroAsset: false,
                dynamicTag: false,
                nodeKind: 'element',
                childCount: 0,
                isLayout: false,
                bound: false,
              }
            : undefined,
      }),
    );
  };
  // A component inside a closed component: the selected component outline, its name and the component chip.
  const component = draw(
    { path: 'src/components/Nav.astro|0.0', occurrence: 0, node: { kind: 'component', label: 'NavLink', tag: undefined }, style: 'selected' },
    '0.0',
  );
  assert.match(component, /class="node-outline sel component[^"]*"[^>]*>.*NavLink/);
  assert.match(component, /node-outline-edit/, 'the component chip shows its icon');
  assert.match(component, /class="node-outline sel element[^"]*"[^>]*>.*\.hero/, 'the real selection still shows beside it');
  // An element: the selected element outline and its label.
  const element = draw({ path: '0.0', occurrence: 0, node: { kind: 'element', label: '.hero', tag: 'section' }, style: 'selected' }, undefined);
  assert.match(element, /class="node-outline sel element[^"]*"[^>]*>.*\.hero/);
  // The hover look on request; and nothing once cleared.
  assert.match(
    draw({ path: '0.0', occurrence: 0, node: { kind: 'element', label: '.hero', tag: 'section' }, style: 'hover' }, undefined),
    /node-outline hover element/,
  );
  assert.doesNotMatch(draw(undefined, undefined), /node-outline/);
});

test('the params are bounded: a target or nothing, never both shapes', () => {
  const rpc = load('shared/properties/appsRpc.ts');
  const parse = rpc.APP_METHODS['canvas.highlight'].params;
  assert.deepEqual(parse(undefined), { target: undefined, style: 'selected' });
  assert.deepEqual(parse({}), { target: undefined, style: 'selected' });
  assert.deepEqual(parse({ nodeId: 'n1' }), { target: { nodeId: 'n1', occurrence: undefined }, style: 'selected' });
  assert.deepEqual(parse({ nodeId: 'n1', style: 'hover' }).style, 'hover');
  assert.throws(() => parse({ nodeId: 'n1', style: 'loud' }), /style/);
  assert.throws(() => parse({ ref: { steps: [] } }), /at least one step/);
  assert.throws(() => parse({ ref: { steps: [{ file: 'src/a.astro', nodeId: 'n0' }] }, occurrence: 1 }), /names one copy/);
  assert.throws(() => parse({ nodeId: 'has space' }), /nodeId/);
  assert.throws(() => parse('n1'), /object/i);
});
