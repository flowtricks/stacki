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
      ${marked('0.4', '<div class="widget">widget</div><script>var x = 1</script>')}
      <!-- A component whose root is a conditional has no marker pair: a marker
           beside the branch would sit outside it, and would mark the instance
           whether the branch rendered or not. The path rides on the element the
           branch rendered instead. -->
      <section>
        <details data-avb-p="src/components/AccordionItem.astro|0.0.0 0.5.0" class="accordion_item">first</details>
        <details data-avb-p="src/components/AccordionItem.astro|0.0.0 0.5.1" class="accordion_item">second</details>
      </section>
      <!-- The same, in a loop: one page path, one tagged element per item. -->
      <ul>
        <li data-avb-p="src/components/Row.astro|0.0.0 0.6.0" class="row">a</li>
        <li data-avb-p="src/components/Row.astro|0.0.0 0.6.0" class="row">b</li>
        <li data-avb-p="src/components/Row.astro|0.0.0 0.6.0" class="row">c</li>
      </ul>
    </body>`,
    { url, pretendToBeVisual: true }
  );
  const { window } = dom;
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  // jsdom lays nothing out, and a node with no box is not a place — which is
  // how the canvas tells a real occurrence from a hollow leftover. Give every
  // element that renders a box of its own, stacked down the page.
  let top = 0;
  window.Element.prototype.getBoundingClientRect = function () {
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'TITLE', 'HEAD'].includes(this.tagName)) return NO_BOX;
    const y = (top += 50);
    return { x: 0, y, width: 200, height: 40, left: 0, top: y, right: 200, bottom: y + 40 };
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
  process.isMainFrame = false; // a frame showing the site, not the app's window
  delete require.cache[require.resolve(PRELOAD)];
  require(PRELOAD);
  Module.prototype.require = realRequire;

  // What the app says when it opens a component: the file in scope, the
  // instance, and which copy of it.
  const track = (focus, focusOcc = 0) => {
    const ev = new window.MessageEvent('message', {
      data: {
        type: 'avb:track',
        paths: ['0.1', '0.2', '0.3', '0.4', '0.5.0', '0.5.1', '0.6.0'],
        scope: '',
        focus,
        focusOcc,
      },
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

  // --- a component whose root is a conditional -------------------------------------
  //
  // `{render && heading && content && (<details/>)}` — the details IS the
  // instance, and it carries the path rather than being wrapped in a pair.
  // Marking what the branch rendered is the only thing there is to mark.
  canvas.track('0.5.0', 0);
  check('an instance addressed by attribute is marked', canvas.opened().join() === 'first', canvas.opened().join());
  canvas.track('0.5.1', 0);
  check('and its neighbour is a different one', canvas.opened().join() === 'second', canvas.opened().join());

  // The same component inside a loop: one path, one tagged element per item,
  // and the occurrence is the copy that was double-clicked — the same list the
  // click that opened it counted.
  canvas.track('0.6.0', 1);
  check('a conditional root inside a loop marks the copy that was opened', canvas.opened().join() === 'b', canvas.opened().join());
  canvas.track('0.6.0', 2);
  check('and the next copy along', canvas.opened().join() === 'c', canvas.opened().join());
  check('one copy at a time', canvas.opened().length === 1, canvas.opened().join());

  // --- what is not a root ------------------------------------------------------------
  //
  // A component's region holds its <script> and <style> too. They are elements
  // and they are not what anyone means by the root of the component.
  canvas.track('0.4', 0);
  check('the script in a component is not marked', canvas.opened().join() === 'widget', canvas.opened().join());

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
  // Both halves come from the lists everything else in the canvas already uses,
  // so "the open instance" and "which copy" mean one thing across the outline,
  // the hit testing, the scroll-to and this.
  const roots = source.slice(source.indexOf('const openedRoots'), source.indexOf('let openedEls'));
  check(
    'the marked instance is the one the rest of the canvas narrows to',
    /focusRoots\(\)/.test(roots),
    'openedRoots works the instance out for itself'
  );
  check(
    'and an instance with no marker pair counts copies the way the click does',
    /taggedPlaces\(focusPath\)/.test(roots) && /places\[focusOcc\]/.test(roots),
    roots
  );

  if (failures.length) {
    console.error(`\nopened-class: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`opened-class: ${checked} passed  [the instance you opened, the frame you are in]`);
  process.exit(0);
})();
