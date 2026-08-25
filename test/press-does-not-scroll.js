// A press on the canvas selects. It does not go anywhere.
//
//   node test/press-does-not-scroll.js
//
// The canvas is a page, and a press on a page focuses whatever is under the
// pointer. Focusing something reveals it — the browser scrolls to bring it
// into view, sideways as well as down.
//
// On a site of any size that is a trap. A card in a slider is covered by a
// full-bleed link and half of them sit past the right edge; selecting one
// scrolled the canvas across. The page this came from measures 3399px against
// a 1280px frame, so there is a long way to travel and nothing on screen to
// say what happened — the site just looks as though it has slipped off to the
// left, and clicking anything else keeps it there.
//
// Design mode already refuses the click (a link must not navigate). It has to
// refuse the PRESS as well, because focus moves on mousedown, and the reveal
// goes with the focus.
//
// Only in design mode. The interactive preview is a real page: pressing things
// is what it is for.

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

const PRELOAD = path.join(__dirname, '..', 'electron', 'preload.js');

// Both frames run the same file; the hash is the only thing that tells them
// apart, so each one gets its own module instance and its own document.
async function frame(hash) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    `<!doctype html><body>
      <!--avb-s:0--><section data-box="hero">
        <a href="#care" class="clickable_link" data-box="link">A card</a>
      </section><!--avb-e:0-->
    </body>`,
    { url: `http://localhost:4321/${hash}`, pretendToBeVisual: true }
  );
  const { window } = dom;
  // jsdom has no focus to give; what is under test is the refusal.
  window.focus = () => {};
  window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 40, left: 0, top: 0, right: 100, bottom: 40 });
  window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 });
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
  delete require.cache[require.resolve(PRELOAD)];
  require(PRELOAD);
  Module.prototype.require = realRequire;
  await settle(50);
  return { window, dom };
}

const press = (window, target, init = {}) => {
  const e = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(e);
  return e;
};

(async () => {
  {
    const { window } = await frame('#avb-design');
    const link = window.document.querySelector('[data-box="link"]');
    const e = press(window, link);
    check('a press on the canvas is refused', e.defaultPrevented, 'the browser focuses the link and scrolls to it');
    const onNothing = press(window, window.document.querySelector('[data-box="hero"]'));
    check('and so is one on anything else', onNothing.defaultPrevented, 'only links were covered');
    // A right-click is the context menu's, not ours.
    const right = press(window, link, { button: 2 });
    check('a right-click is left alone', !right.defaultPrevented, 'the context menu would never open');
    // The click after it is still refused — that is what stops navigation.
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    check('and the click still is, so a link goes nowhere', click.defaultPrevented, 'the canvas would navigate');
  }

  {
    // The interactive preview: a real page, where pressing things is the point.
    const { window } = await frame('');
    const link = window.document.querySelector('[data-box="link"]');
    const e = press(window, link);
    check('the preview lets a press through', !e.defaultPrevented, 'the site cannot be used');
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    check('and the click with it', !click.defaultPrevented, 'links would not work in the preview');
  }

  // --- and asking for something is how you get back -----------------------------
  //
  // A press no longer travels, but a page can be scrolled sideways all the same
  // — a trackpad, a slider's own script, a site that is simply wider than the
  // frame. There is no scrollbar in the canvas to say so, so the way back has
  // to be the thing you would do anyway: select what you want to look at.
  {
    const { window } = await frame('#avb-design');
    const scrolls = [];
    window.scrollTo = (opts) => scrolls.push(opts);
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollX', { value: 1200, writable: true, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
    // A section off to the left of the frame, as it looks once the canvas has
    // been scrolled across: its box starts well before the viewport does.
    window.Element.prototype.getBoundingClientRect = () => ({
      x: -900, y: 100, width: 600, height: 300, left: -900, top: 100, right: -300, bottom: 400,
    });
    const ev = new window.MessageEvent('message', { data: { type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 } });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
    await settle(30);
    const go = new window.MessageEvent('message', { data: { type: 'avb:scroll-to', path: '0', occ: 0 } });
    Object.defineProperty(go, 'source', { value: window.parent });
    window.dispatchEvent(go);
    await settle(30);
    const last = scrolls[scrolls.length - 1];
    check('asking for a node off to the side scrolls sideways to it', last && typeof last.left === 'number', JSON.stringify(scrolls));
    check(
      'far enough to put it on screen',
      last && last.left < 1200 && last.left >= 0,
      JSON.stringify(last)
    );
    check('and it says where vertically too, in the same move', last && typeof last.top === 'number', JSON.stringify(last));
  }

  const source = fs.readFileSync(PRELOAD, 'utf8');
  check(
    'the press is refused where the click already was',
    /addEventListener\(\s*'mousedown'[\s\S]{0,200}preventDefault\(\)/.test(source),
    'nothing stops the focus that comes with a press'
  );
  check(
    'and the frame still takes focus itself, so the modifiers keep arriving',
    /preventDefault\(\);\s*\n\s*window\.focus\(\);/.test(source),
    'the frame stops hearing the keyboard'
  );

  if (failures.length) {
    console.error(`\npress-does-not-scroll: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`press-does-not-scroll: ${checked} passed  [a press selects, it does not travel]`);
  process.exit(0);
})();
