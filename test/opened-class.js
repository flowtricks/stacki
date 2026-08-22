// The two classes the canvas puts on the page.
//
//   node test/opened-class.js
//
// A project styling for the editor needs to know two things the page cannot
// work out for itself:
//
//   `stacki-opened` — on the instance you opened by double-clicking it. Not on
//   every copy of the component: open one card in a list of twelve and it is
//   THAT card, the same one the outline is drawn around and the same one the
//   style panel is writing to.
//
//   `stacki-designer` / `stacki-preview` — on <html>, saying which of the two
//   frames the page is being shown in.
//
// Both are the canvas talking to the page, so neither may come back the other
// way: a class this file adds must never appear among the element's own, or it
// shows up in the class picker, in the selector well and in the navigator's
// labels as something the project wrote.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const PRELOAD = path.join(__dirname, '..', 'electron', 'preload.js');
const { JSDOM } = require('jsdom');

const marked = (p, html) => `<!--avb-s:${p}-->${html}<!--avb-e:${p}-->`;

// The preview frame, as the canvas sees it: a document with markers in it, an
// electron that does nothing, and a parent to post the answers to.
const frame = (url) => {
  const dom = new JSDOM(
    `<!doctype html><body>
      <ul>
        ${marked('0.1', '<article class="card">one</article>')}
        ${marked('0.1', '<article class="card">two</article>')}
        ${marked('0.1', '<article class="card">three</article>')}
      </ul>
      ${marked('0.2', '<div class="promo">promo</div>')}
      ${marked('0.3', '<h2 class="pair-head">head</h2><p class="pair-body">body</p>')}
    </body>`,
    { url, pretendToBeVisual: true }
  );
  const { window } = dom;
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Element.prototype.getBoundingClientRect = () => NO_BOX;
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
  process.isMainFrame = false; // a frame showing the site, not the app's window
  delete require.cache[require.resolve(PRELOAD)];
  require(PRELOAD);
  Module.prototype.require = realRequire;

  // What the app says when it opens a component: the file in scope, the
  // instance, and which copy of it.
  const track = (focus, focusOcc = 0) => {
    const ev = new window.MessageEvent('message', {
      data: { type: 'avb:track', paths: ['0.1', '0.2', '0.3'], scope: '', focus, focusOcc },
    });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
  };
  const opened = () => [...window.document.querySelectorAll('.stacki-opened')].map((el) => el.textContent);
  // Read the moment the script has run, before any event has had a chance to
  // fire: the page paints before DOMContentLoaded, and a canvas that spent that
  // time looking like the preview would flash.
  const markedOnLoad = window.document.documentElement.className;
  return { window, sent, track, opened, markedOnLoad, doc: window.document };
};

(async () => {
  // --- the canvas ---------------------------------------------------------------
  const canvas = frame('http://localhost:4321/#avb-design');
  await new Promise((r) => setTimeout(r, 50)); // the markers are walked once parsing is done

  check(
    'the canvas frame says so on <html>',
    canvas.doc.documentElement.classList.contains('stacki-designer'),
    canvas.doc.documentElement.className
  );
  check(
    'and does not also claim to be the preview',
    !canvas.doc.documentElement.classList.contains('stacki-preview')
  );
  check(
    'from the moment the script runs, not from an event later on',
    canvas.markedOnLoad.includes('stacki-designer'),
    JSON.stringify(canvas.markedOnLoad)
  );

  // --- opening one copy of a component in a loop ---------------------------------
  //
  // Three cards, one path, three runs. Opening the second means the second.
  canvas.track('0.1', 1);
  check('the copy that was opened is marked', canvas.opened().join() === 'two', canvas.opened().join());

  canvas.track('0.1', 0);
  check('opening another copy moves the mark', canvas.opened().join() === 'one', canvas.opened().join());

  canvas.track('0.1', 2);
  check('and the last one is reachable too', canvas.opened().join() === 'three', canvas.opened().join());

  // A component that renders two siblings has no single root, so both are it.
  canvas.track('0.3', 0);
  check('a component with two roots marks both', canvas.opened().join() === 'head,body', canvas.opened().join());

  // --- and leaving ----------------------------------------------------------------
  canvas.track('', 0);
  check('backing out takes the mark off', canvas.opened().length === 0, canvas.opened().join());

  // --- what the app is told the element's classes are -----------------------------
  //
  // The page's own classes, and only those. `stacki-opened` is on the element
  // and must not be in the answer.
  canvas.track('0.1', 1);
  const classesFor = (p) => {
    const rects = canvas.sent.filter((m) => m.type === 'avb:rects').pop();
    const list = (rects?.classes || {})[p];
    return list ? list.flat() : [];
  };
  check('the marked element still reports its own class', classesFor('0.1').includes('card'), JSON.stringify(classesFor('0.1')));
  check(
    'and not the one the canvas put there',
    !classesFor('0.1').includes('stacki-opened'),
    JSON.stringify(classesFor('0.1'))
  );
  const nodeClasses = canvas.sent.filter((m) => m.type === 'avb:node-classes').pop();
  check(
    'nor in the classes the navigator reads',
    !JSON.stringify(nodeClasses?.classes || {}).includes('stacki-'),
    JSON.stringify(nodeClasses?.classes || {})
  );

  // --- the interactive preview ------------------------------------------------------
  //
  // The same page in the other frame. It is told nothing — it never receives
  // avb:track — so the class has to come from the frame itself, and it has to
  // be there from the first paint rather than after a message that never comes.
  const preview = frame('http://localhost:4321/');
  await new Promise((r) => setTimeout(r, 50));
  check(
    'the preview frame says so on <html>',
    preview.doc.documentElement.classList.contains('stacki-preview'),
    preview.doc.documentElement.className
  );
  check(
    'and not that it is the designer',
    !preview.doc.documentElement.classList.contains('stacki-designer'),
    preview.doc.documentElement.className
  );
  check(
    'as immediately as the canvas does',
    preview.markedOnLoad.includes('stacki-preview'),
    JSON.stringify(preview.markedOnLoad)
  );
  check(
    'nothing is opened in a frame that is only being browsed',
    preview.doc.querySelectorAll('.stacki-opened').length === 0
  );

  // --- the source, for the rule that spans both -------------------------------------
  const source = fs.readFileSync(PRELOAD, 'utf8');
  check(
    'the classes the canvas adds are named in one place',
    /const STACKI_CLASSES = new Set\(\[/.test(source),
    'a second list of them will drift from the first'
  );
  // The one raw read left is the filter's own; anything else is a way for these
  // classes to reach the app.
  const raw = source.split('\n').filter((l) => /\[\.\.\.\w+\.classList\]/.test(l));
  check(
    'and every reported class list is filtered through it',
    raw.length === 1 && /ownClasses/.test(raw[0]),
    raw.join('\n    ')
  );
  check(
    'the open instance is painted from the same run everything else narrows to',
    /const roots = focusRoots\(\);/.test(source.slice(source.indexOf('const paintOpened'))),
    'paintOpened works out the instance for itself'
  );

  if (failures.length) {
    console.error(`\nopened-class: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`opened-class: ${checked} passed  [the instance you opened, the frame you are in]`);
  process.exit(0);
})();
