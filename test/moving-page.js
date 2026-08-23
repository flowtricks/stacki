// An outline on a page that moves by itself.
//
//   node test/moving-page.js
//
// Every measurement the canvas makes is triggered by something that HAPPENED:
// a scroll, a mutation, a resize, an element changing size. A CSS animation is
// none of those. A marquee translates its track sixty times a second with the
// DOM untouched, the elements the same size and the page not scrolled — so the
// box was measured once, when the node was selected, and then stood still
// while the thing it was drawn around travelled out from under it.
//
// A strip that renders its content twice — one panel, then a copy of it, which
// is how a marquee loops without a gap — makes that unreadable rather than
// merely late. The copy the outline was measured on moves away and the other
// copy arrives exactly where it was, so the box looks like it is stuck on the
// first copy however far along the strip you click.
//
// So the page has to notice on its own: measure now and then, and when the
// boxes have moved with nothing having happened, follow them frame by frame
// until they settle.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'moving-page.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'outlineBoxes.js')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { hoverIsSelection } = require(bundlePath);

  // --- the strip, rendered twice ---------------------------------------------
  // What a marquee is: a track holding a panel and a copy of the panel. The
  // copy carries the same paths, because it is the same markup — one node in
  // the file, two places on the page.
  const { JSDOM } = require('jsdom');
  const panel = (which) => `
    <div data-box="panel-${which}"${which === 'two' ? ' aria-hidden="true" inert' : ''}>
      <p data-avb-p="src/components/Typography/Paragraph.astro|0.0.0 0.1.0" data-box="text-${which}">Design</p>
      <svg data-avb-p="src/components/Media/Icon.astro|0.0.0 0.1.1" data-box="icon-${which}"></svg>
    </div>`;
  const dom = new JSDOM(
    `<!doctype html><body>
      <!--avb-s:0.1--><div data-box="wrap"><div data-box="track">${panel('one')}${panel('two')}</div></div><!--avb-e:0.1-->
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  const document = window.document;

  // jsdom lays nothing out, so the boxes live here — which is also what makes
  // the animation sayable: `travel` moves the track's contents without touching
  // the DOM at all, exactly as a transform does.
  const boxes = {
    wrap: [0, 0, 1200, 200],
    track: [0, 0, 2400, 200],
    'panel-one': [0, 0, 1200, 200],
    'text-one': [40, 60, 200, 40],
    'icon-one': [300, 60, 80, 80],
    'panel-two': [1200, 0, 1200, 200],
    'text-two': [1240, 60, 200, 40],
    'icon-two': [1500, 60, 80, 80],
  };
  let travelled = 0;
  const travel = (by) => {
    travelled += by;
  };
  const MOVES = new Set(['track', 'panel-one', 'text-one', 'icon-one', 'panel-two', 'text-two', 'icon-two']);
  window.Element.prototype.getBoundingClientRect = function () {
    const name = this.getAttribute('data-box');
    const [x, y, w, h] = boxes[name] || [0, 0, 0, 0];
    const at = MOVES.has(name) ? x + travelled : x;
    return { x: at, y, width: w, height: h, left: at, top: y, right: at + w, bottom: y + h };
  };
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Range.prototype.getBoundingClientRect = () => NO_BOX;

  global.window = window;
  global.document = document;
  global.location = window.location;
  global.navigator = window.navigator;
  global.MutationObserver = window.MutationObserver;
  global.Element = window.Element;
  global.Node = window.Node;
  global.MouseEvent = window.MouseEvent;
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);

  const sent = [];
  window.parent = { postMessage: (m) => sent.push(m) };
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
    webUtils: {},
  };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electron : realRequire.apply(this, arguments);
  };
  process.isMainFrame = false; // the preview frame, not the app's own window
  require(path.join(__dirname, '..', 'electron', 'preload.js'));
  Module.prototype.require = realRequire;
  await wait(50);

  const post = (data) => {
    const ev = new window.MessageEvent('message', { data });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
  };
  post({ type: 'avb:design', on: true });
  const ICON = '0.1.1';
  const lastRects = () => (sent.filter((m) => m.type === 'avb:rects').pop()?.rects || {})[ICON] || [];
  post({ type: 'avb:track', paths: [ICON] });
  await wait(30);

  // --- both copies are places -------------------------------------------------
  {
    const drawn = lastRects();
    check('the strip and its copy are two boxes', drawn.length === 2, JSON.stringify(drawn));
    check(
      'in the order they are across the page',
      drawn.map((r) => r.x).join(',') === '300,1500',
      JSON.stringify(drawn.map((r) => r.x))
    );
    const clickOn = (name) => {
      const el = document.querySelector(`[data-box="${name}"]`);
      sent.length = 0;
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      return sent.filter((m) => m.type === 'avb:click-node').pop();
    };
    check('clicking the first copy says the first', clickOn('icon-one')?.occurrence === 0, JSON.stringify(clickOn('icon-one')));
    check(
      'clicking the copy in the second panel says the second',
      clickOn('icon-two')?.occurrence === 1,
      JSON.stringify(clickOn('icon-two'))
    );
  }

  // --- and the boxes follow the strip -----------------------------------------
  // Nothing is touched here but the layout: no scroll, no resize, no mutation,
  // and every element the same size it was. This is the whole of what a CSS
  // animation does, and before this the canvas heard none of it.
  {
    post({ type: 'avb:track', paths: [ICON] });
    await wait(60);
    const before = lastRects();
    let mutations = 0;
    const watcher = new window.MutationObserver((records) => {
      mutations += records.length;
    });
    watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

    travel(-240);
    await wait(400);
    const after = lastRects();
    check(
      'the box goes where the strip went',
      after[0]?.x === before[0]?.x - 240,
      `${JSON.stringify(before[0])} → ${JSON.stringify(after[0])}`
    );
    check(
      'and so does the copy of it',
      after[1]?.x === before[1]?.x - 240,
      `${JSON.stringify(before[1])} → ${JSON.stringify(after[1])}`
    );
    check('both of them, still', after.length === 2, JSON.stringify(after));

    // Travelling again is followed again — a strip runs for as long as the page
    // is open, so noticing once is not enough.
    travel(-360);
    await wait(400);
    const later = lastRects();
    check('a strip that keeps going keeps being followed', later[0]?.x === after[0]?.x - 360, JSON.stringify(later[0]));

    // Following measures. It must not WRITE: the canvas re-measures on any
    // mutation, so a class painted once a frame would answer itself for as
    // long as the animation ran.
    check('and nothing is written to the page to do it', mutations === 0, `${mutations} mutations`);
    watcher.disconnect();
  }

  // --- a page holding still is left alone --------------------------------------
  {
    await wait(500); // let the frames settle after the last move
    const before = sent.length;
    await wait(500);
    check(
      'a page that is not moving reports nothing',
      sent.length === before,
      `${sent.length - before} messages with nothing happening`
    );
  }

  // --- what "the node" means in the navigator ------------------------------------
  // A canvas click picks the copy under the pointer. Every other route to a
  // selection points at the node, and the node is every copy of it — outlining
  // only the first read as the app ignoring the rest of the strip.
  const pane = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'PreviewPane.jsx'), 'utf8');
  check(
    'a selection from anywhere but the canvas means the node',
    /setSelOcc\(null\)/.test(pane) && /React\.useState\(null\)/.test(pane.slice(pane.indexOf('const [selOcc'), pane.indexOf('const [selOcc') + 80)),
    'a navigator selection still means the first copy'
  );
  check(
    'and a click still means the copy that was clicked',
    /setSelOcc\(d\.occurrence \|\| 0\)/.test(pane),
    'a canvas click no longer picks an instance'
  );
  check(
    'which the outline draws as every place',
    /o\.occ == null \? onePerPlace\(all\)/.test(pane),
    'a selection with no occurrence draws one box'
  );
  check(
    'the panels read the first copy when the selection means all of them',
    /selOcc \?\? 0/.test(pane),
    'the spacing box and the class list have no instance to read'
  );
  check(
    'a hover on any copy of an all-copies selection is already outlined',
    hoverIsSelection({ path: '0.1.1', occ: 1 }, { path: '0.1.1', occ: null })
  );
  check(
    'while a hover on another copy of ONE selected copy still draws',
    !hoverIsSelection({ path: '0.1.1', occ: 1 }, { path: '0.1.1', occ: 0 })
  );

  if (failures.length) {
    console.error(`\nmoving-page: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`moving-page: ${checked} passed  [an outline on a page that moves]`);
  process.exit(0);
})();
