// Goal: the deep outline mode and drag to insert hold their contracts (docs/apps.md,
// "Outline modes" and "Drag to insert").
// - Deep outlines: in deep mode a hover inside a closed component names the
//   node editing that component would outline (an instance as a component, an
//   element by its class or tag); the page's layout counts as the page; slot
//   content, the page's own instances and normal mode are unchanged. The mode belongs to the app that set it and resets when it
//   sets normal, stops, another app takes the panel or the mode, the person opens
//   another rail panel, or the project closes.
// - Drag to insert: the drop place follows the pointer (before, inside, after;
//   beside only for a closed component or a void element); a drop on a target
//   inserts there through node.insert's path as one edit and answers its id; a drop
//   off the canvas and Escape insert nothing; a host that cannot insert refuses at
//   the start.
// Method: the frame modules over jsdom markup written as the marker serializer
// writes it; the owner and drag stores with fake callbacks; the real dispatcher
// with a fake host whose insert records each call as one undo step.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = require('../../helpers/rendererModule');

const frame = load('test/fixtures/apps/frameLayersEntry.ts');
const { componentNameOf, elementHoverNode, outsideScope, parseDeepHoverNode, parseOutlineMode } = load('shared/properties/deepOutline.ts');
const { createOutlineModeOwner } = load('src/features/apps/outlineModeOwner.ts');
const { createInsertDrag, dropTarget } = load('src/features/apps/insertDrag.ts');
const { answerAppMessage, inFlightCounter } = load('src/features/apps/appRpcHost.ts');
const rpc = load('shared/properties/appsRpc.ts');

const NAV = 'src/components/Nav.astro|';
const LINK = 'src/components/NavLink.astro|';
const PAGE = `<!doctype html><body><!--avb-s:0--><!--avb-s:${NAV}0--><nav><!--avb-s:${NAV}0.0--><!--avb-s:${LINK}0--><a id="home">Home</a><!--avb-e:${LINK}0--><!--avb-e:${NAV}0.0--></nav><!--avb-e:${NAV}0--><!--avb-e:0--><!--avb-s:1--><h1 id="hero">Hi</h1><!--avb-e:1--></body>`;

test('deep mode outlines what editing the closed component would, and only on hover', () => {
  const dom = new JSDOM(PAGE);
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  try {
    frame.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
    frame.resetFocusCache();
    frame.collectRegions();
    const home = document.getElementById('home');
    assert.equal(frame.deepHoverAt(home, '0'), undefined, 'normal mode: the open page owns the hover');
    assert.equal(frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'deep' }), true);
    assert.equal(frame.outlineMode(), 'deep');
    // The innermost instance: the <NavLink> in Nav.astro, named as the component it renders.
    assert.deepEqual(frame.deepHoverAt(home, '0'), { path: `${NAV}0.0`, occurrence: 0, node: { kind: 'component', label: 'NavLink', tag: undefined } });
    // On Nav's own markup, Nav's element, as editing Nav would outline it.
    assert.deepEqual(frame.deepHoverAt(document.querySelector('nav'), '0'), {
      path: `${NAV}0`,
      occurrence: 0,
      node: { kind: 'element', label: 'nav', tag: 'nav' },
    });
    assert.equal(frame.deepHoverAt(document.getElementById('hero'), '1'), undefined, 'the page own element stays its own');
    // Anything but `deep` is the editor's own mode; other messages are not ours.
    assert.equal(frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'deeper' }), true);
    assert.equal(frame.outlineMode(), 'normal');
    assert.equal(frame.receiveOutlineMode({ type: 'avb:query' }), false);
  } finally {
    dom.window.close();
  }
  assert.equal(componentNameOf(`${LINK}0`), 'NavLink');
  assert.equal(componentNameOf(`${LINK}0.1`), 'NavLink', 'no "Inside" label: the name is the component');
  assert.equal(componentNameOf('0.1'), undefined);
  assert.equal(componentNameOf(`${LINK}x`), undefined);
  assert.equal(outsideScope(`${LINK}0`, ''), true);
  assert.equal(outsideScope('0.2', ''), false);
  assert.equal(outsideScope(`${NAV}0`, NAV), false);
  assert.equal(parseOutlineMode('deep'), 'deep');
  assert.equal(parseOutlineMode('x'), undefined);
});

const BL = 'src/layouts/BaseLayout.astro|';
const FOOT = 'src/components/global/Footer.astro|';
const ICON = 'src/components/media/Icon.astro|';
// A page whose layout renders the document, with a Footer holding a plain link and an <Icon>.
const LAYOUT_PAGE =
  `<!--avb-s:0--><!--avb-s:${BL}1--><html data-avb-p="${BL}1 0"><body data-avb-p="${BL}1.1">` +
  `<!--avb-s:${BL}1.1.3--><!--avb-s:${FOOT}0--><footer class="footer" data-avb-p="${FOOT}0 ${BL}1.1.3">` +
  `<!--avb-s:${FOOT}0.0--><a class="footer_link" id="footer-link" data-avb-p="${FOOT}0.0">About</a><!--avb-e:${FOOT}0.0-->` +
  `<!--avb-s:${FOOT}0.1--><!--avb-s:${ICON}0--><svg class="icon" id="footer-logo" data-avb-p="${ICON}0 ${FOOT}0.1"></svg><!--avb-e:${ICON}0--><!--avb-e:${FOOT}0.1-->` +
  `</footer><!--avb-e:${FOOT}0--><!--avb-e:${BL}1.1.3--></body></html><!--avb-e:${BL}1--><!--avb-e:0-->`;

test('deep hover outlines what editing the footer would: its plain link as an element, its logo as a component', () => {
  const dom = new JSDOM(LAYOUT_PAGE);
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  dom.window.Range.prototype.getClientRects = () => [];
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  try {
    frame.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
    frame.resetFocusCache();
    frame.collectRegions();
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'deep' });
    assert.deepEqual(frame.deepHoverAt(document.getElementById('footer-link'), '0'), {
      path: `${FOOT}0.0`,
      occurrence: 0,
      node: { kind: 'element', label: '.footer_link', tag: 'a' },
    });
    assert.deepEqual(frame.deepHoverAt(document.getElementById('footer-logo'), '0'), {
      path: `${FOOT}0.1`,
      occurrence: 0,
      node: { kind: 'component', label: 'Icon', tag: undefined },
    });
    // The layout's own markup is the page's, as the editor treats its chrome: nothing deep to draw.
    assert.equal(frame.deepHoverAt(document.body, '0'), undefined);
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'normal' });
  } finally {
    dom.window.close();
  }
  // Labels as the editor's own: the first authored class, else the tag; build classes never name it.
  assert.deepEqual(elementHoverNode('A', 'astro-x1 nav_link is-current'), { kind: 'element', label: '.nav_link', tag: 'a' });
  assert.deepEqual(elementHoverNode('SECTION', ''), { kind: 'element', label: 'section', tag: 'section' });
  assert.deepEqual(parseDeepHoverNode({ kind: 'element', label: '.x', tag: 'a' }), { kind: 'element', label: '.x', tag: 'a' });
  assert.equal(parseDeepHoverNode({ kind: 'element', label: '.x' }), undefined);
  assert.equal(parseDeepHoverNode({ kind: 'component', label: '' }), undefined);
});

function ownerWorld() {
  const sent = [];
  const applied = [];
  const running = new Set(['inspect', 'pins']);
  const owner = createOutlineModeOwner({
    emit: (appId, event, data) => sent.push([appId, event, data]),
    running: (appId) => running.has(appId),
    apply: (mode) => applied.push(mode),
  });
  return { owner, sent, applied, running };
}

test('the outline mode belongs to its app and resets by every rule', () => {
  const world = ownerWorld();
  const { owner, sent, applied } = world;
  assert.deepEqual(owner.set('gone', 'deep'), { applied: false, reason: 'Only a running app sets the outline mode' });
  assert.deepEqual(owner.set('inspect', 'deep'), { applied: true });
  assert.equal(owner.owner(), 'inspect');
  assert.deepEqual(applied, ['deep']);
  assert.deepEqual(sent.at(-1), ['inspect', 'canvas.outline', { mode: 'deep', reason: 'app' }]);
  // Another rail panel.
  assert.equal(owner.reset('panel'), true);
  assert.deepEqual(sent.at(-1), ['inspect', 'canvas.outline', { mode: 'normal', reason: 'panel' }]);
  assert.equal(owner.reset('panel'), false, 'nothing held: nothing said');
  // Another app opened or brought to the panel; the owner shown again keeps it.
  owner.set('inspect', 'deep');
  owner.shown('inspect');
  assert.equal(owner.owner(), 'inspect');
  owner.shown('pins');
  assert.equal(owner.owner(), undefined);
  assert.deepEqual(sent.at(-1), ['inspect', 'canvas.outline', { mode: 'normal', reason: 'replaced' }]);
  // Another app setting deep takes it.
  owner.set('inspect', 'deep');
  owner.set('pins', 'deep');
  assert.equal(owner.owner(), 'pins');
  assert.deepEqual(sent.at(-2), ['inspect', 'canvas.outline', { mode: 'normal', reason: 'replaced' }]);
  // The project closing.
  owner.reset('project');
  assert.deepEqual(sent.at(-1), ['pins', 'canvas.outline', { mode: 'normal', reason: 'project' }]);
  // Its own normal; and a stopped owner, silently.
  owner.set('pins', 'deep');
  owner.set('inspect', 'normal');
  assert.equal(owner.owner(), 'pins', 'another app setting normal leaves the owner be');
  owner.set('pins', 'normal');
  assert.equal(owner.owner(), undefined);
  owner.set('pins', 'deep');
  const heard = sent.length;
  world.running.delete('pins');
  owner.changed();
  assert.equal(owner.owner(), undefined);
  assert.equal(sent.length, heard);
  assert.equal(applied.at(-1), 'normal');
  assert.deepEqual(rpc.APP_METHODS['canvas.setOutlineMode'].params({ mode: 'deep' }), { mode: 'deep' });
});

test('coming back to an app restores the deep mode it last asked for, and only that', () => {
  const world = ownerWorld();
  const { owner, sent, applied } = world;
  // Leave for the Navigator, come back: deep again, heard as restored.
  owner.set('inspect', 'deep');
  owner.reset('panel');
  assert.equal(owner.owner(), undefined);
  assert.equal(owner.restore('inspect'), true);
  assert.equal(owner.owner(), 'inspect');
  assert.equal(applied.at(-1), 'deep');
  assert.deepEqual(sent.at(-1), ['inspect', 'canvas.outline', { mode: 'deep', reason: 'restored' }]);
  assert.equal(owner.restore('inspect'), false, 'already its: nothing said twice');
  // Another app in front, then back: the first app's request outlived the replacement.
  owner.shown('pins');
  assert.equal(owner.restore('pins'), false, 'an app that never asked gets nothing');
  assert.equal(owner.restore('inspect'), true);
  // Its own normal is not restored.
  owner.set('inspect', 'normal');
  owner.reset('panel');
  assert.equal(owner.restore('inspect'), false);
  assert.equal(applied.at(-1), 'normal');
  // A stopped app is not restored, even when it starts again.
  owner.set('inspect', 'deep');
  owner.reset('panel');
  world.running.delete('inspect');
  owner.changed();
  world.running.add('inspect');
  assert.equal(owner.restore('inspect'), false);
  // The project closing forgets every request.
  owner.set('pins', 'deep');
  owner.reset('project');
  assert.equal(owner.restore('pins'), false);

  assert.throws(() => rpc.APP_METHODS['canvas.setOutlineMode'].params({ mode: 'x' }), /mode/);
});

// ---------------------------------------------------------------------------
// Drag to insert
// ---------------------------------------------------------------------------

const view = (id, kind, name) => ({ id, kind, name, classes: [], attributes: {}, text: undefined, children: [] });
const BOX = { x: 0, y: 100, width: 200, height: 100 };

test('the drop place follows the pointer, and a closed component takes it only beside it', () => {
  const section = { node: view('s1', 'element', 'section'), box: BOX };
  assert.deepEqual(dropTarget(section, 110).place, { kind: 'before', anchor: 's1' });
  assert.deepEqual(dropTarget(section, 150).place, { kind: 'inside', anchor: 's1', index: undefined });
  assert.deepEqual(dropTarget(section, 190).place, { kind: 'after', anchor: 's1' });
  const card = { node: view('c1', 'component', 'Card'), box: BOX };
  assert.deepEqual(dropTarget(card, 140).place, { kind: 'before', anchor: 'c1' });
  assert.deepEqual(dropTarget(card, 160).place, { kind: 'after', anchor: 'c1' });
  const image = { node: view('i1', 'element', 'img'), box: BOX };
  assert.equal(dropTarget(image, 150).line, 'after');
});

function dragWorld(hostOverrides = {}) {
  const inserts = [];
  const running = new Set(['blocks']);
  const drag = createInsertDrag({
    // The canvas sits at 100,0 in the window, at zoom 1; left of it is a panel.
    toCanvas: (x, y) => (x < 100 ? undefined : { x: x - 100, y }),
    locate: async (x, y) => (y >= 100 && y <= 200 ? { node: view('s1', 'element', 'section'), box: BOX } : undefined),
    running: (appId) => running.has(appId),
  });
  const host = {
    kind: 'desktop',
    page: () => undefined,
    node: () => undefined,
    insertElement: {
      kind: 'able',
      run: async (insert) => {
        inserts.push(insert);
        return { applied: true, nodeId: 'new1' };
      },
    },
    insertComponent: async (insert) => {
      inserts.push(insert);
      return { applied: true, nodeId: 'new2' };
    },
    insertAttributes: { kind: 'able', run: true },
    insertReplace: { kind: 'able', run: true },
    ...hostOverrides,
  };
  const roles = load('shared/properties/projectRoles.ts');
  const context = { host, role: () => roles.ADMIN_VIEW, setOverlay: () => undefined, insertDrag: drag, frameOrigin: () => ({ left: 0, top: 0 }) };
  const session = { app: { manifest: { id: 'blocks', name: 'Blocks', version: '1.0.0', shortcutClaims: [] } }, subscriptions: new Set(), ...inFlightCounter() };
  let id = 0;
  const ask = async (method, params) => {
    id += 1;
    const answer = await answerAppMessage(session, { stacki: 'app', v: 1, id, method, params }, context);
    assert.equal(answer.error, undefined, JSON.stringify(answer.error));
    return answer.value;
  };
  return { drag, inserts, ask };
}

test('a drop on a target inserts there once and answers the new id', async () => {
  const { drag, inserts, ask } = dragWorld();
  assert.deepEqual(await ask('canvas.startInsertDrag', { kind: 'element', tag: 'p', attributes: { class: 'note' }, label: 'Add note' }), { applied: true });
  assert.equal(drag.view().preview, '<p>');
  assert.deepEqual(await ask('canvas.insertDrag', { phase: 'move', x: 50, y: 150 }), { over: false }, 'over a panel');
  assert.deepEqual(await ask('canvas.insertDrag', { phase: 'move', x: 150, y: 150 }), { over: true });
  assert.equal(drag.view().target.line, 'inside');
  assert.deepEqual(await ask('canvas.insertDrag', { phase: 'drop', x: 150, y: 190 }), { applied: true, nodeId: 'new1' });
  assert.equal(inserts.length, 1, 'one insert: one undo step');
  assert.deepEqual(inserts[0], {
    item: { kind: 'element', tag: 'p', attributes: { class: 'note' } },
    place: { kind: 'after', anchor: 's1' },
    label: 'Add note',
  });
  assert.equal(drag.view(), undefined, 'the drop ends the drag');
});

test('a drop off any target, Escape and a host that cannot insert all insert nothing', async () => {
  const off = dragWorld();
  await off.ask('canvas.startInsertDrag', { kind: 'component', name: 'Card' });
  assert.deepEqual(await off.ask('canvas.insertDrag', { phase: 'drop', x: 150, y: 20 }), {
    applied: false,
    reason: 'Nothing on the canvas there takes the drop',
  });
  assert.equal(off.inserts.length, 0);
  // Escape in the editor cancels; the drop the app then reports answers why.
  const escaped = dragWorld();
  await escaped.ask('canvas.startInsertDrag', { kind: 'component', name: 'Card' });
  assert.equal(escaped.drag.cancel(), true);
  assert.deepEqual(await escaped.ask('canvas.insertDrag', { phase: 'drop', x: 150, y: 150 }), { applied: false, reason: 'The drag was cancelled' });
  // Escape in the app.
  await escaped.ask('canvas.startInsertDrag', { kind: 'component', name: 'Card' });
  assert.deepEqual(await escaped.ask('canvas.insertDrag', { phase: 'cancel' }), { applied: false, reason: 'The drag was cancelled' });
  assert.equal(escaped.drag.view(), undefined);
  assert.equal(escaped.inserts.length, 0);
  // A host whose element insert is unavailable refuses before anything is dragged.
  const unable = dragWorld({ insertElement: { kind: 'unable', reason: 'Not here yet' } });
  assert.deepEqual(await unable.ask('canvas.startInsertDrag', { kind: 'element', tag: 'p' }), { applied: false, reason: 'Not here yet' });
  assert.equal(unable.drag.view(), undefined);
  // The payload is node.insert's, checked the same way, and placed only by the drop.
  assert.throws(() => rpc.APP_METHODS['canvas.startInsertDrag'].params({ kind: 'element', tag: 'script' }), /code/);
  assert.throws(() => rpc.APP_METHODS['canvas.startInsertDrag'].params({ kind: 'element', tag: 'p', position: 'before', anchor: 'n1' }), /placed by the drop/);
  assert.throws(() => rpc.APP_METHODS['canvas.startInsertDrag'].params({ kind: 'element', tag: 'p', preview: 'x'.repeat(121) }), /preview/);
  assert.throws(() => rpc.APP_METHODS['canvas.insertDrag'].params({ phase: 'move', x: 2e6, y: 0 }), /range/);
  assert.throws(() => rpc.APP_METHODS['canvas.insertDrag'].params({ phase: 'hover', x: 0, y: 0 }), /phase/);
});
