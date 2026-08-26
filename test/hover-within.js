// A node answers for the space it is in, not the space above it.
//
//   node test/hover-within.js
//
// Pointing at the gap above a heading lit the heading up, and reading that as
// "the margin is part of the component" is fair — that is exactly what it looks
// like. What is really there is a word.
//
// Text animation rebuilds a heading into one element per word, and gives each
// of them a line box taller than the line it draws. Measured on the page this
// came from, a `.word` box hangs thirteen pixels above the box of the component
// that holds it. The browser is asked what is under the pointer, answers with
// the word, truthfully — and the node that came back was one whose outline
// starts below the pointer that summoned it.
//
// So the rule is the one a person would state: what lights up has to contain
// the pointer. An element whose box does not hold the point hands the question
// to the element above it. Something with no box at all — a <template>, a node
// display:none — cannot answer either way and is left as it was.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { JSDOM } = require('jsdom');
  // A section holding a heading whose words spill above it, the way a split
  // line does. Every box is named so the layout can be stated rather than
  // computed — jsdom lays nothing out.
  const dom = new JSDOM(
    `<!doctype html><body>
      <!--avb-s:0-->
      <section data-avb-p="0" data-box="section">
        <!--avb-s:0.0-->
        <p data-avb-p="0.0" data-box="eyebrow">Beginnings</p>
        <!--avb-e:0.0-->
        <!--avb-s:0.1-->
        <div data-avb-p="0.1" data-box="wrap">
          <h2 data-box="text"><span class="word" data-box="word">Every</span></h2>
        </div>
        <!--avb-e:0.1-->
      </section>
      <!--avb-e:0-->
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  // The section runs from 0 to 800. The eyebrow sits at the top. The component
  // starts at 300 — and its word, given a line box taller than its line, starts
  // at 287: thirteen pixels above the thing that holds it.
  const boxes = {
    section: [0, 0, 1000, 800],
    eyebrow: [0, 20, 400, 40],
    wrap: [0, 300, 900, 400],
    text: [0, 346, 900, 300],
    word: [0, 287, 300, 200],
  };
  window.Element.prototype.getBoundingClientRect = function () {
    const [x, y, w, h] = boxes[this.getAttribute('data-box')] || [0, 0, 0, 0];
    return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };
  };
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Range.prototype.getBoundingClientRect = () => NO_BOX;
  window.focus = () => {};
  // jsdom has no hit testing, and the canvas asks for it by coordinate. What is
  // under a point here is what the boxes above say is under it — the deepest
  // element whose box holds it, which is what a browser would answer.
  window.document.elementFromPoint = (x, y) => {
    let found = null;
    for (const el of window.document.querySelectorAll('[data-box]')) {
      const b = el.getBoundingClientRect();
      if (x < b.left || x > b.right || y < b.top || y > b.bottom) continue;
      if (!found || found.contains(el)) found = el;
    }
    return found;
  };

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
  post({ type: 'avb:design', on: true });
  post({ type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 });
  await settle(40);

  // The pointer lands where it lands; what it is OVER is the browser's answer,
  // which in the gap above the component is the word.
  const pointAt = (box, y) => {
    const el = window.document.querySelector(`[data-box="${box}"]`);
    sent.length = 0;
    el.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: y }));
    return sent.filter((m) => m.type === 'avb:hover-node').pop();
  };

  // 290: inside the word's box, above the component's. Nothing is drawn there.
  check(
    'the gap above a component is not the component',
    pointAt('word', 290)?.path === '0',
    JSON.stringify(pointAt('word', 290))
  );
  // 400: inside both. This is the component, and always was.
  check(
    'pointing at the component is the component',
    pointAt('word', 400)?.path === '0.1',
    JSON.stringify(pointAt('word', 400))
  );
  // The neighbour above keeps its own space.
  check(
    'and its neighbour keeps its own',
    pointAt('eyebrow', 30)?.path === '0.0',
    JSON.stringify(pointAt('eyebrow', 30))
  );
  // A click says the same thing as the hover — the two resolve the same way,
  // so what you select is what lit up.
  {
    const el = window.document.querySelector('[data-box="word"]');
    sent.length = 0;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 100, clientY: 290 }));
    const msg = sent.filter((m) => m.type === 'avb:click-node').pop();
    check('and a click in that gap selects what a hover showed', msg?.path === '0', JSON.stringify(msg));
  }

  // An event with no coordinates — something synthesised — has no point to
  // judge, and is answered as before rather than refused.
  {
    const el = window.document.querySelector('[data-box="word"]');
    sent.length = 0;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const msg = sent.filter((m) => m.type === 'avb:click-node').pop();
    check('a click with nowhere to be still resolves', msg?.path === '0.1', JSON.stringify(msg));
  }

  if (failures.length) {
    console.error(`\nhover-within: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`hover-within: ${checked} passed  [what lights up contains the pointer]`);
  process.exit(0);
})();
