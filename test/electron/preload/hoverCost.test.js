// What moving the pointer costs the canvas.
//
//   node test/electron/preload/hoverCost.test.js
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
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const { JSDOM } = require('jsdom');
  const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;
  const dom = new JSDOM(
    `<!doctype html><body>
      ${marked('0', '<section class="hero" data-box="hero"><h1 data-box="head">Hi</h1></section>')}
      ${marked('1', '<section class="rest" data-box="rest"><p data-box="copy">Words</p></section>')}
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true },
  );
  const { window } = dom;
  const boxes = {
    hero: [0, 0, 800, 400],
    head: [10, 20, 300, 60],
    rest: [0, 400, 800, 400],
    copy: [10, 420, 300, 40],
  };
  window.Element.prototype.getBoundingClientRect = function () {
    const [x, y, width, height] = boxes[this.getAttribute('data-box')] || [0, 0, 0, 0];
    return {
      x,
      y,
      width: width,
      height: height,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
    };
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
  // The set-vh case rewrites stylesheets; jsdom has only some CSSOM rule
  // classes, and a missing one matches nothing.
  for (const rule of ['CSSGroupingRule', 'CSSMediaRule', 'CSSSupportsRule', 'CSSStyleRule']) {
    global[rule] = window[rule] ?? class {};
  }

  const sent = [];
  window.parent = { postMessage: (message) => sent.push(message) };
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
  require(repoPath('dist/electron/preload/preload.js'));
  Module.prototype.require = realRequire;
  await settle(60);

  const post = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
  };
  const count = (type) => sent.filter((message) => message.type === type).length;
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
    `${count('avb:rects') - rectsAfterFirst} rect answers for 3 hovers`,
  );
  check('and none of them re-walks the page', pageAnswers() === afterFirst, `${pageAnswers() - afterFirst} extra page answers for three hovers`);

  // --- and when the page itself moves ------------------------------------------
  const beforeEdit = pageAnswers();
  // A marked node's classes — which is what the navigator labels rows with.
  window.document.querySelector('[data-box="rest"]').classList.add('is-new');
  await settle(400); // the mutation observer's own settle, then the rAF

  check('a change to the page asks again', pageAnswers() > beforeEdit, 'an edit leaves the navigator describing the page as it was');

  // --- unless the question really did change -----------------------------------
  // Opening a component narrows everything to one instance: which nodes count
  // as rendered is a different question inside it.
  const beforeScope = pageAnswers();
  await track(['0.0'], {
    scope: 'src/components/Card.astro|',
    focus: 'src/components/Card.astro|0',
  });
  check('stepping into a component asks again', pageAnswers() > beforeScope, 'the page-wide answers are stale inside a component');

  // --- a scroll is not a change ---------------------------------------------------
  const beforeScroll = pageAnswers();
  const rectsBeforeScroll = count('avb:rects');
  window.dispatchEvent(new window.Event('scroll'));
  await settle(60);
  check('scrolling re-measures the boxes', count('avb:rects') > rectsBeforeScroll, 'the outline would stay behind');
  check('and nothing else', pageAnswers() === beforeScroll, `${pageAnswers() - beforeScroll} page answers for a scroll`);

  // Counting the messages is not enough, and believing it cost half a second a
  // frame on a real page: the page-wide answers are only SENT when they have
  // changed, and a scroll changes nothing — so the walk can run in full, find
  // the same answer, say nothing, and look like a fix.
  //
  // What it costs is the walk, so the walk is what is counted. Every one of
  // them asks the document for its tagged elements, over and over; measuring
  // the boxes of one tracked node asks once or twice.
  const asksOf = async (what) => {
    const real = window.document.querySelectorAll.bind(window.document);
    let asked = 0;
    window.document.querySelectorAll = (...args) => {
      asked++;
      return real(...args);
    };
    try {
      await what();
    } finally {
      window.document.querySelectorAll = real;
    }
    return asked;
  };

  const forScroll = await asksOf(async () => {
    window.dispatchEvent(new window.Event('scroll'));
    await settle(60);
  });
  // What re-measuring costs on its own: the app asking for the same node's
  // boxes again, which is exactly what a scroll has to do.
  const forTrack = await asksOf(async () => {
    await track(['0']);
  });
  const forEdit = await asksOf(async () => {
    window.document.querySelector('[data-box="hero"]').classList.add('is-touched');
    await settle(200);
  });
  check(
    'a scroll costs what re-measuring costs, and nothing more',
    // Chromium can run one pending motion check in the same sampling window
    // on Windows. A page refresh costs several extra walks; one query is
    // bounded scheduling noise rather than the regression this pins out.
    forScroll <= forTrack + 1,
    `${forScroll} document queries for a scroll against ${forTrack} for a re-measure ` + `— the scroll is walking the page`,
  );
  check('while a change to the page really does walk it', forEdit > forTrack, `${forEdit} for an edit against ${forTrack} for a re-measure`);

  // --- the canvas's own writes are not changes to the page ----------------------
  // The canvas writes to the page too: a probe element the style panel's
  // colours are computed on, the viewport-height variable, its own classes.
  // Each one used to walk the whole page — once for every colour the style
  // panel asked about. They are told apart by what they touched.
  // What a quiet moment costs: the canvas looks for motion on its own clock,
  // and a window this long can hold one look.
  const forIdle = await asksOf(() => settle(200));
  const forProbe = await asksOf(async () => {
    post({ type: 'avb:query', id: 7, compute: ['rgb(1, 2, 3)'] });
    await settle(200);
  });
  check('computing a colour for the style panel walks nothing', forProbe <= forIdle, `${forProbe} document queries after a probe`);
  const forViewport = await asksOf(async () => {
    post({ type: 'avb:set-vh', px: 812 });
    await settle(200);
  });
  check('freezing the viewport height walks nothing', forViewport <= forIdle, `${forViewport} document queries after set-vh`);
  const opened = window.document.querySelector('[data-box="copy"]');
  const forOwnClass = await asksOf(async () => {
    opened.classList.add('stacki-opened');
    await settle(200);
  });
  check('a class of the canvas’s own walks nothing', forOwnClass <= forIdle, `${forOwnClass} document queries after stacki-opened`);
  const forMixedClass = await asksOf(async () => {
    opened.classList.remove('stacki-opened');
    opened.classList.add('is-mixed');
    await settle(200);
  });
  check(
    'but the page’s class in the same batch is a change to the page',
    forMixedClass > forTrack,
    `${forMixedClass} for a mixed batch against ${forTrack} for a re-measure`,
  );

  // --- a restyle moves boxes and can hide a node, but renders nothing new --------
  // An inline style written every frame (an animation library) re-measures the
  // boxes and re-reads which nodes are hidden — never the structural walk.
  sent.length = 0;
  const forRestyle = await asksOf(async () => {
    window.document.querySelector('[data-box="rest"]').style.display = 'none';
    await settle(200);
  });
  const states = sent.filter((message) => message.type === 'avb:node-states').pop();
  check('a restyle reports a node it hid', (states?.hidden ?? []).includes('1'), JSON.stringify(states));
  check('and costs less than a change to the page', forRestyle < forEdit, `${forRestyle} for a restyle against ${forEdit} for an edit`);

  if (failures.length) {
    console.error(`\nhover-cost: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`hover-cost: ${checked} passed  [the pointer does not pay for the page]`);
  process.exit(0);
})();
