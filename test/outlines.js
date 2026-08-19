// The boxes a hovered node draws on the canvas.
//
//   node test/outlines.js
//
// Hovering a section in the navigator turned the whole page bright green,
// while hovering the same section on the page looked right. The difference is
// how many boxes get drawn: a hover on the page means the copy under the
// pointer, one box; a hover in the navigator means the node, every copy.
//
// And the copies were not copies. Every patch of the page collects its markers
// again, and the runs collected last time were kept — so after fourteen edits
// one section was fourteen identical boxes on the same pixels. The fill is
// translucent, and 14% painted fourteen times is 88%: a green wash over
// everything inside it, which is what the screenshot measured — the app's
// green at α 0.88 over a page you could no longer read.
//
// So two things are checked here: that the page stops reporting one place as
// many, and that the overlay would not stack them even if it did.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const box = (x, y, w, h) => ({ x, y, w, h });
// What a stack of translucent fills comes to, so the numbers here are the ones
// that were on the screen rather than a count of divs.
const stacked = (n, a = 0.14) => 1 - (1 - a) ** n;

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'outline-boxes.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'outlineBoxes.js')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { onePerPlace } = require(bundlePath);

  // --- one box per place -----------------------------------------------------
  const hero = box(0, 100, 1200, 800);
  const fourteen = () => Array.from({ length: 14 }, () => ({ ...hero }));
  check('one box is one box', onePerPlace([hero]).length === 1);
  check(
    'the same box reported fourteen times is one box',
    onePerPlace(fourteen()).length === 1,
    `${onePerPlace(fourteen()).length} boxes`
  );
  check(
    'so the fill stays the fill',
    Math.abs(stacked(onePerPlace(fourteen()).length) - 0.14) < 1e-9,
    `the page would be ${Math.round(stacked(14) * 100)}% green`
  );
  check(
    'a box a rounding error off is still the same place',
    onePerPlace([hero, box(0.4, 100.2, 1199.7, 799.6)]).length === 1
  );
  check('a box inside another is covered by it', onePerPlace([hero, box(40, 200, 300, 100)]).length === 1);

  // A loop renders its child once per item: separate places, all of them
  // labelled, none of them inside another.
  const items = [box(0, 0, 300, 200), box(0, 220, 300, 200), box(0, 440, 300, 200)];
  check('every copy in a loop keeps its box', onePerPlace(items).length === 3);
  check(
    'in the order they are on the page',
    onePerPlace(items).map((b) => b.y).join(',') === '0,220,440',
    onePerPlace(items).map((b) => b.y).join(',')
  );
  check(
    'and duplicates among them collapse without taking the rest',
    onePerPlace([items[0], { ...items[0] }, items[1]]).length === 2
  );
  check(
    'two boxes that merely overlap are still two boxes',
    onePerPlace([box(0, 0, 100, 100), box(50, 50, 100, 100)]).length === 2
  );
  check('an empty box is not drawn', onePerPlace([box(10, 10, 0, 0), hero]).length === 1);
  check('nothing at all is nothing', onePerPlace(undefined).length === 0);

  // --- the overlay uses it ---------------------------------------------------
  const pane = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'PreviewPane.jsx'), 'utf8');
  check(
    'a navigator hover draws one box per place',
    /o\.occ == null \? onePerPlace\(all\)/.test(pane),
    'the hover outlines are back to one box per run'
  );
  check(
    'and so does the dimming around a component being edited',
    /onePerPlace\(rects\[focusPath\]\)/.test(pane),
    'the focus scrim stacks, so the page goes black instead of dim'
  );

  // --- what the page reports --------------------------------------------------
  // The preload's outline half runs in the preview frame, so this is that
  // frame: a document with markers in it, an electron that does nothing, and a
  // parent to post the answers to.
  const { JSDOM } = require('jsdom');
  const marked = (path, html) => `<!--avb-s:${path}-->${html}<!--avb-e:${path}-->`;
  const dom = new JSDOM(
    `<!doctype html><body>
      ${marked('0.1', '<section data-box="section"><h1 data-box="heading">Hi</h1></section>')}
      ${marked('0.2', '<article data-box="one">one</article>')}
      ${marked('0.2', '<article data-box="two">two</article>')}
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  // jsdom lays nothing out, so every box would be zero and nothing would be
  // measurable. Each element carries the name of a box, and the boxes live here
  // — so a "style change" can move an element without touching the DOM around
  // it, which is exactly what a stylesheet does.
  const boxes = {
    section: [0, 100, 1200, 800],
    heading: [10, 120, 400, 60],
    one: [0, 900, 400, 200],
    two: [0, 1120, 400, 200],
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
  // The markers are walked when the document is done parsing, which for jsdom
  // is a turn or two after it is handed over.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Asking for a node's boxes is what the app does on every selection and
  // hover; the answer comes back on the same turn.
  const boxesFor = (p) => {
    const ev = new window.MessageEvent('message', { data: { type: 'avb:track', paths: [p] } });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
    const last = sent.filter((m) => m.type === 'avb:rects').pop();
    return (last?.rects || {})[p] || [];
  };
  // A patch: the page is re-rendered around the nodes that are already there,
  // markers and all, and the app is told the document moved.
  const patch = (p) => {
    const el = document.querySelector(p === '0.1' ? 'section' : 'article');
    el.parentNode.insertBefore(document.createComment(`avb-s:${p}`), el);
    el.parentNode.insertBefore(document.createComment(`avb-e:${p}`), el.nextSibling);
    document.dispatchEvent(new window.Event('avb:morphed'));
  };

  check('a section is one box', boxesFor('0.1').length === 1, JSON.stringify(boxesFor('0.1')));
  check('a loop child is one box per item', boxesFor('0.2').length === 2, JSON.stringify(boxesFor('0.2')));

  patch('0.1');
  check(
    'and still one box after the page is patched',
    boxesFor('0.1').length === 1,
    `${boxesFor('0.1').length} boxes — one edit, one extra copy of the same place`
  );
  patch('0.1');
  patch('0.1');
  check(
    'however many times it is patched',
    boxesFor('0.1').length === 1,
    `${boxesFor('0.1').length} boxes after three edits, painting the fill ${Math.round(
      stacked(boxesFor('0.1').length) * 100
    )}% over the section`
  );
  check(
    'the loop still has its two',
    boxesFor('0.2').length === 2,
    JSON.stringify(boxesFor('0.2'))
  );

  // A patch that replaces the node rather than morphing it: the old run is
  // nodes that have left the document, and what is drawn is where the node is
  // now — not both.
  {
    const old = document.querySelector('section');
    const fresh = document.createElement('section');
    boxes.moved = [0, 300, 1200, 500];
    fresh.setAttribute('data-box', 'moved');
    old.parentNode.insertBefore(document.createComment('avb-s:0.1'), old);
    old.parentNode.insertBefore(fresh, old);
    old.parentNode.insertBefore(document.createComment('avb-e:0.1'), fresh.nextSibling);
    old.remove();
    document.dispatchEvent(new window.Event('avb:morphed'));
    const drawn = boxesFor('0.1');
    check('a node the page replaced is one box', drawn.length === 1, JSON.stringify(drawn));
    check('at the place it is now', drawn[0]?.y === 300, JSON.stringify(drawn));
  }

  // --- keys pressed on the page -----------------------------------------------
  // Clicking an element on the canvas puts keyboard focus inside this frame, so
  // every key after that is delivered here and the app's own listeners never
  // fire. The style panel reads Shift and Option to decide how much of the
  // spacing box a hover applies to — from the app's side, nobody was pressing
  // anything. So the frame says what it heard.
  {
    const heard = () => sent.filter((m) => m.type === 'avb:modifiers');
    sent.length = 0;
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    check('shift on the page is forwarded', heard().length === 1, JSON.stringify(sent));
    check('as being held', heard()[0]?.shiftKey === true, JSON.stringify(heard()[0]));

    sent.length = 0;
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', shiftKey: true }));
    check('and typing on does not repeat it', heard().length === 0, JSON.stringify(sent));

    sent.length = 0;
    window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Shift', shiftKey: false, altKey: true }));
    check('letting go of it is forwarded too', heard()[0]?.shiftKey === false, JSON.stringify(heard()[0]));
    check('along with what is still held', heard()[0]?.altKey === true, JSON.stringify(heard()[0]));

    sent.length = 0;
    window.dispatchEvent(new window.Event('blur'));
    check('and losing focus holds nothing', heard()[0]?.altKey === false, JSON.stringify(heard()[0]));
  }

  // --- styling it moves it, and the outline has to move with it ---------------
  // A style edit reaches the page as CSS: the dev server swaps a <style> in
  // <head>, the element changes shape, and nothing in the body has changed at
  // all. Watching the body alone, the outline stayed where the element used to
  // be until something else asked for a measurement — which, mid-drag, is never.
  {
    // What the app last heard, with nobody asking again.
    const lastSent = () => {
      const last = sent.filter((m) => m.type === 'avb:rects').pop();
      return (last?.rects || {})['0.1']?.[0] || null;
    };
    boxesFor('0.1'); // the app is watching this node
    // Whichever box the section is reading now (the block above replaced it).
    const key = document.querySelector('section').getAttribute('data-box');
    boxes[key] = [0, 100, 1200, 640]; // …and the padding drag just shrank it
    sent.length = 0;
    const style = document.createElement('style');
    style.textContent = '.section { padding-bottom: 2rem }';
    document.head.appendChild(style);
    await new Promise((resolve) => setTimeout(resolve, 60));
    check('a stylesheet arriving re-measures the page', sent.some((m) => m.type === 'avb:rects'), 'nothing was measured');
    check('and the box it reports is the new one', lastSent()?.h === 640, JSON.stringify(lastSent()));

    // The same again, edited in place rather than added — HMR updates a sheet
    // it has already inserted.
    boxes[key] = [0, 100, 1200, 700];
    sent.length = 0;
    style.textContent = '.section { padding-bottom: 4rem }';
    await new Promise((resolve) => setTimeout(resolve, 60));
    check('editing a stylesheet in place re-measures too', lastSent()?.h === 700, JSON.stringify(lastSent()));

    // A change that lands after the one that caused it: the second pass is what
    // catches the layout that had not happened yet when the first one ran.
    sent.length = 0;
    style.textContent = '.section { padding-bottom: 5rem }';
    await new Promise((resolve) => setTimeout(resolve, 10));
    boxes[key] = [0, 100, 1200, 760]; // the browser gets round to it
    await new Promise((resolve) => setTimeout(resolve, 200));
    check('a layout that settles late is measured again', lastSent()?.h === 760, JSON.stringify(lastSent()));
  }

  if (failures.length) {
    console.error(`\noutlines: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`outlines: ${checked} passed`);
  process.exit(0);
})();
