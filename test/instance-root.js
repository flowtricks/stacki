// Where a component instance is named on the page.
//
//   node test/instance-root.js
//
// The serializer hands a component the page's path for that instance as a prop,
// and the component decides where its `...rest` ends up. A form field forwards
// it to the control:
//
//   <label class="field form-select">      ← the component's root
//     <span class="field_label">State</span>
//     <span class="form-select_control"><select {...rest} /></span>
//   </label>
//
// so the page's name for the FormSelect landed on the <select>. Everything
// downstream then meant the control rather than the field: the outline drew
// around the box and left the field's own label outside it, and a click on that
// label reached past the component to whatever contained it.
//
// The canvas puts the name back where the instance begins — the outermost
// element of that component's rendering. Not for an element that IS a root: a
// page section is the root of Section.astro AND sits in the layout's slot, so
// it carries a path in the layout's namespace too, and climbing that would put
// the section's name on <body>.

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

const SELECT = 'src/components/FormSelect.astro|';
const SECTION = 'src/components/Section.astro|';
const LAYOUT = 'src/layouts/BaseLayout.astro|';
const BUTTON = 'src/components/Button.astro|';

(async () => {
  const dom = new JSDOM(
    `<!doctype html><body data-avb-p="${LAYOUT}1.1">
      <main data-avb-p="${LAYOUT}1.1.2">
        <!--avb-s:0.1-->
        <!-- the layout's namespace first, as the collector leaves it: the order
             the paths happen to be in must not decide this -->
        <section class="section" data-avb-p="${LAYOUT}1.1.2.0 ${SECTION}0 ${SECTION}0.0.0 0.1">
          <div class="container" data-avb-p="${SECTION}0.0.0.1.0.0 0.1">
            <!-- a field: the component's root is the label, and the page's name
                 for the instance rode in on the spread, onto the control -->
            <label class="field" data-avb-p="${SELECT}0.0.0">
              <span class="field_label" data-avb-p="${SELECT}0.0.0.0">State</span>
              <span class="control" data-avb-p="${SELECT}0.0.0.1">
                <select class="field_control" data-avb-p="${SELECT}0.0.0.1.0 0.1.0.0"></select>
              </span>
            </label>
            <!-- a component whose own root takes the spread: already named there -->
            <button class="button" data-avb-p="${BUTTON}0.0.0 0.1.0.1">Go</button>
          </div>
        </section>
        <!--avb-e:0.1-->
      </main>
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  // Boxes that nest the way the elements do: the field's label is 80 tall and
  // holds a 30-tall control, so "which element the outline is drawn around" is
  // a question the numbers can answer.
  const BOXES = {
    'field': [0, 100, 300, 80],
    'field_label': [0, 100, 300, 20],
    'control': [0, 130, 300, 50],
    'field_control': [0, 130, 300, 30],
    'button': [0, 200, 100, 40],
    'container': [0, 50, 400, 400],
    'section': [0, 0, 400, 500],
  };
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Element.prototype.getBoundingClientRect = function () {
    const key = (this.getAttribute('class') || '').split(' ')[0];
    const b = BOXES[key];
    if (!b) return NO_BOX;
    const [x, y, w, h] = b;
    return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };
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
  await new Promise((r) => setTimeout(r, 60));

  const q = (sel) => window.document.querySelector(sel);
  const carries = (el, p) => (el.getAttribute('data-avb-p') || '').split(' ').includes(p);

  // --- the report ---------------------------------------------------------------
  check('the field answers to the instance', carries(q('label.field'), '0.1.0.0'), q('label.field').getAttribute('data-avb-p'));
  check(
    'and so does the control it came in on',
    carries(q('select.field_control'), '0.1.0.0'),
    q('select.field_control').getAttribute('data-avb-p')
  );

  const boxFor = (p) => {
    const ev = new window.MessageEvent('message', {
      data: { type: 'avb:track', paths: [p], scope: '', focus: '', focusOcc: 0 },
    });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
    const rects = sent.filter((m) => m.type === 'avb:rects').pop();
    return ((rects?.rects || {})[p] || [])[0];
  };
  {
    const box = boxFor('0.1.0.0');
    check('the outline is the whole field', box && box.h === 80 && box.y === 100, JSON.stringify(box));
    check('not just the control inside it', !(box && box.h === 30), JSON.stringify(box));
  }

  // A click on the field's own label is a click on the component, not on
  // whatever the component happens to sit in.
  {
    sent.length = 0;
    q('span.field_label').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const msg = sent.filter((m) => m.type === 'avb:click-node').pop();
    check('a click on the label reaches the component', msg?.path === '0.1.0.0', JSON.stringify(msg));
  }

  // --- what must NOT be renamed ----------------------------------------------------
  //
  // The section is the root of Section.astro and is slotted into the layout, so
  // it carries a path in the layout's namespace as well. That is not a name
  // handed in on a spread, and climbing it would walk to <body>.
  check('the layout body is not given the page path', !carries(q('body'), '0.1'), q('body').getAttribute('data-avb-p'));
  check('nor is <main>', !carries(q('main'), '0.1'), q('main').getAttribute('data-avb-p'));
  check('the section still has it', carries(q('section'), '0.1'), q('section').getAttribute('data-avb-p'));
  {
    const box = boxFor('0.1');
    check('and it measures as the section, not the page', box && box.h === 500, JSON.stringify(box));
  }

  // A component whose own root takes the spread was already named there, and
  // nothing moves.
  check('a component named on its root is left alone', carries(q('button.button'), '0.1.0.1'));
  {
    const box = boxFor('0.1.0.1');
    check('and measures as itself', box && box.h === 40, JSON.stringify(box));
  }

  // --- said once ---------------------------------------------------------------------
  const source = fs.readFileSync(PRELOAD, 'utf8');
  check(
    'the rule lives in one place',
    /const promoteInstanceTags = \(\) => \{/.test(source),
    'the promotion is inlined somewhere and will drift'
  );
  check(
    'and it refuses to climb out of a root',
    /a root: leave it alone/.test(source),
    'nothing stops the climb at a component that names itself'
  );

  if (failures.length) {
    console.error(`\ninstance-root: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`instance-root: ${checked} passed  [where an instance is named]`);
  process.exit(0);
})();
