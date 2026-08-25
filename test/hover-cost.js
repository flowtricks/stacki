// What moving the pointer costs the canvas.
//
//   node test/hover-cost.js
//
// The canvas answers two different questions for the app.
//
//   Where the tracked nodes ARE — a box each, for the two or three paths the
//   app is watching. It changes when the page scrolls, when something moves,
//   and when the app starts watching a different node.
//
//   What the page IS — which nodes put anything on it at all, and what each
//   one's classes came out as. Those are facts about the whole file. Answering
//   them walks every marked node: five thousand of them on a page of any size.
//
// Both were answered together, on every `avb:track` — and the app tracks a new
// path every time the pointer lands on a new node. So hovering re-walked the
// whole page, once per node crossed, and on a large page that walk is most of a
// second: the wait before an outline appears.
//
// The page-wide answers are still given whenever the question changes — the DOM
// moved, or the app narrowed its interest to one component instance. What they
// are not given for is the pointer.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { JSDOM } = require('jsdom');
  const marked = (p, html) => `<!--avb-s:${p}-->${html}<!--avb-e:${p}-->`;
  const dom = new JSDOM(
    `<!doctype html><body>
      ${marked('0', '<section class="hero" data-box="hero"><h1 data-box="head">Hi</h1></section>')}
      ${marked('1', '<section class="rest" data-box="rest"><p data-box="copy">Words</p></section>')}
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  const boxes = {
    hero: [0, 0, 800, 400],
    head: [10, 20, 300, 60],
    rest: [0, 400, 800, 400],
    copy: [10, 420, 300, 40],
  };
  window.Element.prototype.getBoundingClientRect = function () {
    const [x, y, w, h] = boxes[this.getAttribute('data-box')] || [0, 0, 0, 0];
    return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };
  };
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Range.prototype.getBoundingClientRect = () => NO_BOX;

  global.window = window;
  global.document = window.document;
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
  process.isMainFrame = false;
  require(path.join(__dirname, '..', 'electron', 'preload.js'));
  Module.prototype.require = realRequire;
  await settle(60);

  const post = (data) => {
    const ev = new window.MessageEvent('message', { data });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
  };
  const count = (type) => sent.filter((m) => m.type === type).length;
  const pageAnswers = () => count('avb:rendered-nodes') + count('avb:node-classes');
  const track = async (paths, extra = {}) => {
    post({ type: 'avb:track', paths, scope: '', focus: '', focusOcc: 0, ...extra });
    await settle(120);
  };

  // --- the first question is answered in full ---------------------------------
  await track(['0']);
  check('the canvas says where the tracked node is', count('avb:rects') >= 1, `${count('avb:rects')} rect answers`);
  check('and what the page holds', pageAnswers() > 0, 'the page was never described');

  // --- and then the pointer moves ----------------------------------------------
  const afterFirst = pageAnswers();
  const rectsAfterFirst = count('avb:rects');
  await track(['1']);
  await track(['0.0']);
  await track(['1.0']);
  check(
    'every node hovered gets its boxes measured',
    count('avb:rects') >= rectsAfterFirst + 3,
    `${count('avb:rects') - rectsAfterFirst} rect answers for 3 hovers`
  );
  check(
    'and none of them re-walks the page',
    pageAnswers() === afterFirst,
    `${pageAnswers() - afterFirst} extra page answers for three hovers`
  );

  // --- and when the page itself moves ------------------------------------------
  const beforeEdit = pageAnswers();
  // A marked node's classes — which is what the navigator labels rows with.
  window.document.querySelector('[data-box="rest"]').classList.add('is-new');
  await settle(400); // the mutation observer's own settle, then the rAF

  check(
    'a change to the page asks again',
    pageAnswers() > beforeEdit,
    'an edit leaves the navigator describing the page as it was'
  );

  // --- unless the question really did change -----------------------------------
  // Opening a component narrows everything to one instance: which nodes count
  // as rendered is a different question inside it.
  const beforeScope = pageAnswers();
  await track(['0.0'], { scope: 'src/components/Card.astro|', focus: 'src/components/Card.astro|0' });
  check(
    'stepping into a component asks again',
    pageAnswers() > beforeScope,
    'the page-wide answers are stale inside a component'
  );

  // --- a scroll is not a change ---------------------------------------------------
  const beforeScroll = pageAnswers();
  const rectsBeforeScroll = count('avb:rects');
  window.dispatchEvent(new window.Event('scroll'));
  await settle(60);
  check('scrolling re-measures the boxes', count('avb:rects') > rectsBeforeScroll, 'the outline would stay behind');
  check(
    'and nothing else',
    pageAnswers() === beforeScroll,
    `${pageAnswers() - beforeScroll} page answers for a scroll`
  );

  if (failures.length) {
    console.error(`\nhover-cost: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`hover-cost: ${checked} passed  [the pointer does not pay for the page]`);
  process.exit(0);
})();
