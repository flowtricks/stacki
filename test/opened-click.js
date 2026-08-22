// Clicking the component you have open.
//
//   node test/opened-click.js
//
// Double-click a Button to open it, click that same button on the canvas, and
// the component closed. What the app does with a click is decided by
// src/canvasClick.js (test/canvas-click.js), and it was deciding correctly: the
// canvas told it the click landed on something the open file does not own,
// which is somebody looking away from what they are editing.
//
// The canvas was wrong. A component's root path — `Button.astro|0.0.0` — is the
// same in every instance, and the serializer writes it into the markup as a tag
// wherever a marker pair cannot go. The region collector then withdrew that tag
// from every instance a pair did NOT wrap, because it had collected the path
// for the one it did. So the button under the pointer carried no path in the
// open file, and the click could not be placed.
//
// A tag this file adds is bookkeeping and may be withdrawn. A tag the markup
// came with belongs to the file, and taking it away is taking the element's
// name off it.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'electron', 'preload.js');
const SCOPE = 'src/components/Button.astro|';
const ROOT_PATH = `${SCOPE}0.0.0`;

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(ROOT, 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'opened-click.cjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'canvasClick.js')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { canvasClickAction } = require(bundle);

  const { JSDOM } = require('jsdom');
  const marked = (p, html) => `<!--avb-s:${p}-->${html}<!--avb-e:${p}-->`;
  // A row of the same component, rendered five times. The serializer wraps what
  // it can in marker pairs and tags the rest — a component rendered into
  // another one's slot, or whose root is a conditional, can only be tagged.
  // Every instance carries the component's own root path, because in the
  // component's file they are all that one node.
  const instance = (page, label) =>
    `<button data-avb-p="${ROOT_PATH} ${page}" class="button">${label}</button>`;
  const dom = new JSDOM(
    `<!doctype html><body>
      <div class="row">
        ${marked(ROOT_PATH, instance('0.1', 'one'))}
        ${instance('0.2', 'two')}
        ${instance('0.3', 'three')}
      </div>
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  const boxes = new WeakMap();
  let top = 0;
  window.Element.prototype.getBoundingClientRect = function () {
    let b = boxes.get(this);
    if (!b) {
      const y = (top += 50);
      b = { x: 0, y, width: 120, height: 40, left: 0, top: y, right: 120, bottom: y + 40 };
      boxes.set(this, b);
    }
    return b;
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
  require(PRELOAD);
  Module.prototype.require = realRequire;
  // The markers are walked when parsing finishes, and the listeners that answer
  // clicks go on then too.
  await new Promise((r) => setTimeout(r, 60));

  const buttons = [...window.document.querySelectorAll('button')];
  check('the row rendered', buttons.length === 3, String(buttons.length));

  // Open the component from the second instance — the one no marker pair wraps.
  const open = (focus, occ = 0) => {
    const ev = new window.MessageEvent('message', {
      data: { type: 'avb:track', paths: [focus], scope: SCOPE, focus, focusOcc: occ },
    });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
  };
  open('0.2');

  const clickOn = (el) => {
    sent.length = 0;
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return sent.filter((m) => m.type === 'avb:click-node').pop();
  };
  const actionFor = (msg) =>
    msg ? canvasClickAction({ path: msg.path, outside: !!msg.outside, focusPath: '0.2', scope: SCOPE }).kind : '(nothing reported)';

  // --- the report ---------------------------------------------------------------
  {
    const msg = clickOn(buttons[1]);
    check('a click on the open instance is placed', msg?.path === ROOT_PATH, JSON.stringify(msg));
    check('and is not read as landing outside it', msg?.outside === false, JSON.stringify(msg));
    check('so the click selects rather than closes', actionFor(msg) === 'inner', actionFor(msg));
  }

  // The instance a marker pair DID wrap always worked; it still does.
  {
    const msg = clickOn(buttons[0]);
    check('the instance with a marker pair is placed too', msg?.path === ROOT_PATH, JSON.stringify(msg));
    check('and selects', actionFor(msg) === 'inner', actionFor(msg));
  }

  // Every instance is the same node in the component's file, so clicking any of
  // them selects that node. None of them is a way out of the component.
  {
    const msg = clickOn(buttons[2]);
    check('another copy of the component is not a way out', actionFor(msg) !== 'close', JSON.stringify(msg));
  }

  // The tag has to still be ON the element — this is what was being taken away.
  check(
    'every instance still carries the component’s own path',
    buttons.every((b) => (b.getAttribute('data-avb-p') || '').split(' ').includes(ROOT_PATH)),
    buttons.map((b) => b.getAttribute('data-avb-p')).join(' | ')
  );

  // --- and what the withdrawing was for -------------------------------------------
  //
  // The collector tags every element inside a marker pair, so it can answer for
  // the region afterwards. Those tags are its own, and when the region no longer
  // holds the element they have to come off — otherwise one bad pass leaves an
  // element permanently answering to a path it is not in.
  {
    const row = window.document.querySelector('.row');
    const OTHER = `${SCOPE}9`;
    // A fresh region, wrapping one element. The markers are consumed by the
    // walk, which is why they are written again for the second pass.
    const wrap = (el) => {
      el.parentNode.insertBefore(window.document.createComment(`avb-s:${OTHER}`), el);
      el.parentNode.insertBefore(window.document.createComment(`avb-e:${OTHER}`), el.nextSibling);
      window.document.dispatchEvent(new window.CustomEvent('avb:morphed'));
    };
    const first = window.document.createElement('span');
    first.textContent = 'first';
    const second = window.document.createElement('span');
    second.textContent = 'second';
    row.append(first, second);

    wrap(first);
    check(
      'a node inside a region is tagged for it',
      (first.getAttribute('data-avb-p') || '').includes(OTHER),
      String(first.getAttribute('data-avb-p'))
    );

    // The region is somewhere else now — that tag is stale, and it is ours.
    wrap(second);
    check(
      'and loses the tag once the region holds something else',
      !(first.getAttribute('data-avb-p') || '').includes(OTHER),
      String(first.getAttribute('data-avb-p'))
    );
    check(
      'which the node it moved to now carries',
      (second.getAttribute('data-avb-p') || '').includes(OTHER),
      String(second.getAttribute('data-avb-p'))
    );
    check(
      'while the markup’s own tags are left alone',
      buttons.every((b) => (b.getAttribute('data-avb-p') || '').split(' ').includes(ROOT_PATH)),
      buttons.map((b) => b.getAttribute('data-avb-p')).join(' | ')
    );
  }

  if (failures.length) {
    console.error(`\nopened-click: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`opened-click: ${checked} passed  [the tag the markup came with]`);
  process.exit(0);
})();
