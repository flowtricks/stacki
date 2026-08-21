// A click that reported the comment above the thing clicked.
//
//   node test/comment-region.js
//
// Clicking the fine print at the bottom of the docs footer selected `comment`
// — the JSX note written above that row in the source:
//
//   {
//     /* Two elements, because the rule and the content want different widths … */
//   }
//   <div class="site-footer_fine"> … </div>
//
// A comment renders nothing, so its region is a marker pair with only
// whitespace between them. For it to answer for a click on the DIV, that div
// had to be INSIDE the region — which happens when the closing marker ends up
// after it. Two things let that happen, and both are checked here:
//
//   the anchor sync  put the markers back by matching the live page against a
//                    fresh rendering, and any text node stood for any other.
//                    Two renderings rarely have the same number of blank text
//                    nodes, so one could be matched across an element and the
//                    cursor came out past it — every later marker one node
//                    late, and once the cursor ran off the end they were
//                    appended to the parent, closing markers included.
//
//   the collector    walked from a start marker to its end marker, and when
//                    there wasn't one it took every following sibling. A lost
//                    marker turned into a region that owned the rest of the
//                    page — and it TAGGED those elements, so the mistake
//                    outlived the pass that made it.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// The footer, the way the compiler leaves it: the comment is gone and its
// markers sit around the whitespace where it was.
const FOOTER = `
  <!--avb-s:0.0--><div class="container">above</div><!--avb-e:0.0-->
  <!--avb-s:0.1-->

  <!--avb-e:0.1-->
  <!--avb-s:0.2--><div class="site-footer_fine">© 2026</div><!--avb-e:0.2-->
`;

(async () => {
  // ── Putting the markers back ─────────────────────────────────────────────
  // syncAnchors runs in the page, against a live DOM whose blank text nodes
  // are not the server's.
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    global.document = dom.window.document;

    // morphClient is an ES module the dev server serves to the page; the one
    // function under test is lifted out rather than imported.
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'morphClient.js'), 'utf8');
    const start = source.indexOf('const isAnchor =');
    const end = source.indexOf('// Never looked inside.');
    const syncAnchors = new Function(
      'document',
      `${source.slice(start, end)}\nreturn syncAnchors;`
    )(dom.window.document);

    const server = dom.window.document.createElement('div');
    server.innerHTML = FOOTER;
    const live = dom.window.document.createElement('div');
    // The live page: the same content with the markers taken out (the canvas
    // removes them once it has recorded them) and — the part that broke it —
    // its blank text nodes in different places from the fresh rendering's. One
    // trailing newline and none in between is enough: matching any text against
    // any text sent the cursor past both elements to reach it.
    live.innerHTML = '<div class="container">above</div><div class="site-footer_fine">© 2026</div>\n';
    dom.window.document.body.append(live, server);

    syncAnchors(live, server);

    const kids = [...live.childNodes];
    const at = (data) => kids.findIndex((n) => n.nodeType === 8 && n.data === data);
    const elAt = (cls) => kids.findIndex((n) => n.nodeType === 1 && n.className === cls);
    check('every marker is put back', at('avb-s:0.1') >= 0 && at('avb-e:0.1') >= 0, live.innerHTML);
    check(
      "the comment's markers stay together",
      at('avb-e:0.1') === at('avb-s:0.1') + 1,
      live.innerHTML
    );
    check(
      'and the element after it is outside them',
      at('avb-e:0.1') < elAt('site-footer_fine'),
      live.innerHTML
    );
    check(
      'each element is still wrapped by its own pair',
      at('avb-s:0.2') < elAt('site-footer_fine') && at('avb-e:0.2') > elAt('site-footer_fine'),
      live.innerHTML
    );
    check(
      'and so is the one before it',
      at('avb-s:0.0') < elAt('container') && at('avb-e:0.0') > elAt('container'),
      live.innerHTML
    );
    delete global.document;
  }

  // ── Reading them ─────────────────────────────────────────────────────────
  // The real preload, over the real markers: what does a click on the fine
  // print resolve to?
  {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(
      `<!doctype html><body><!--avb-s:0--><footer class="site-footer">${FOOTER}</footer><!--avb-e:0--></body>`,
      { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
    );
    const { window } = dom;
    const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
    window.Element.prototype.getBoundingClientRect = function () {
      return { ...NO_BOX, width: 200, height: 40, right: 200, bottom: 40 };
    };
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

    // Design mode, and tracking every path in the file.
    const send = (data) => {
      const ev = new window.MessageEvent('message', { data });
      Object.defineProperty(ev, 'source', { value: window.parent });
      window.dispatchEvent(ev);
    };
    send({ type: 'avb:design', on: true });
    send({ type: 'avb:track', paths: ['0', '0.0', '0.1', '0.2'] });
    await settle(20);

    const fine = document.querySelector('.site-footer_fine');
    check(
      "the comment's region is not stamped on the element after it",
      !(fine.getAttribute('data-avb-p') || '').split(' ').includes('0.1'),
      fine.getAttribute('data-avb-p')
    );

    sent.length = 0;
    fine.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(20);
    const click = sent.filter((m) => m.type === 'avb:click-node').pop();
    check('a click on the fine print reports it', click?.path === '0.2', JSON.stringify(click));

    // …and the same with the closing marker missing altogether, which is the
    // state that used to make the comment own the rest of the footer.
    const footer = document.querySelector('.site-footer');
    footer.innerHTML =
      '<!--avb-s:0.0--><div class="container">above</div><!--avb-e:0.0-->' +
      '<!--avb-s:0.1-->' + // no close marker at all
      '<!--avb-s:0.2--><div class="site-footer_fine">© 2026</div><!--avb-e:0.2-->';
    document.dispatchEvent(new window.CustomEvent('avb:morphed'));
    await settle(20);

    const fine2 = document.querySelector('.site-footer_fine');
    check(
      'a marker with no close claims nothing',
      !(fine2.getAttribute('data-avb-p') || '').split(' ').includes('0.1'),
      fine2.getAttribute('data-avb-p')
    );
    sent.length = 0;
    fine2.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(20);
    const click2 = sent.filter((m) => m.type === 'avb:click-node').pop();
    check(
      'so the click still reports the element that was clicked',
      click2?.path === '0.2',
      JSON.stringify(click2)
    );
  }

  if (failures.length) {
    console.error(`\ncomment-region: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`comment-region: ${checked} passed  [anchors put back, regions read]`);
  process.exit(0);
})();
