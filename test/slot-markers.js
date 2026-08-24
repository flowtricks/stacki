// Markers that survive a component reading its own slot.
//
//   node test/slot-markers.js
//
// A component doesn't have to render `<slot />` and leave it at that. It can
// render the slot to a string and put the string back with `set:html` — which
// is how a component asks "did my slot render anything?", and the usual way to
// answer is to drop html comments before looking, because a comment is content
// that isn't:
//
//   const content = await slots.render('default');
//   return content.replace(/<!--[\s\S]*?-->/g, '').trim();
//
// Every Stacki marker in that subtree goes with them. Nothing on the page then
// answers to those paths, and the navigator reported every row inside such a
// component as rendering nothing — on a page where they were plainly on
// screen, five rows in a row wearing the crossed-out eye.
//
// So inside slot content the path also rides on the element itself, as the
// `data-avb-p` the collector writes at runtime anyway. An attribute survives
// anything done to comments, and unlike a marker node it is invisible to
// :nth-child, :first-child, + and ~ — which is the whole reason the markers
// are comments in the first place.
//
// Both halves are checked: the tag is written, and a page that kept only the
// tags still reports those nodes as rendered.

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

const { parsePage, serializePageMarked } = require('../electron/astroParser.js');

// ── What the serializer writes ──────────────────────────────────────────────
{
  const source =
    '---\nimport Layout from "../layouts/Base.astro";\nimport Wrap from "../components/Wrap.astro";\nimport Eyebrow from "../components/Eyebrow.astro";\nimport Img from "../components/Img.astro";\n---\n' +
    '<Layout title="t">\n' +
    '  <Wrap>\n' +
    '    <Eyebrow>stack</Eyebrow>\n' +
    '    <div class="a">\n' +
    '      <p class="b">deep</p>\n' +
    '    </div>\n' +
    '    <Img slot="column2" />\n' +
    '  </Wrap>\n' +
    '</Layout>\n';
  const parsed = parsePage(source);
  check('the page parses', parsed.editable, parsed.reason);
  const marked = serializePageMarked(parsed.model);

  const tagged = (tag, p) =>
    new RegExp(`<${tag}\\b[^>]*\\bdata-avb-p="${p.replace(/\./g, '\\.')}"`).test(marked);

  // A component instance carries it as a prop. It only reaches the DOM where
  // that component spreads its rest props — most do, and where one doesn't
  // this is no worse than the comment that was being dropped.
  check('a component in slot content carries its path', tagged('Wrap', '0.0'), marked);
  check('and so does one nested deeper', tagged('Eyebrow', '0.0.0'), marked);
  // An element carries it as an attribute, which always arrives.
  check('an element in slot content carries its path', tagged('div', '0.0.1'), marked);
  // The strip takes the whole subtree, not just the top of it.
  check('as does an element below that element', tagged('p', '0.0.1.0'), marked);
  // Unchanged: a slotted node was already addressed this way.
  check('a slotted node still carries its own', tagged('Img', '0.0.2'), marked);

  // The markers are still there. They are what works when nothing interferes,
  // and they carry what an attribute can't — text, a loop, a branch.
  for (const p of ['0.0', '0.0.0', '0.0.1', '0.0.1.0']) {
    check(`the marker pair for ${p} is still written`, marked.includes(`avb-s:${p}--`) && marked.includes(`avb-e:${p}--`), marked);
  }

  // Not just slot content. What gets scrubbed is everything the slot rendered,
  // which includes the output of every component inside it — a component
  // written with its markup at the top of its own file, a page away from any
  // slot, still loses every marker for being placed inside one. So the tag is
  // on the markup wherever it is.
  const plain = serializePageMarked(parsePage('---\n---\n<section>\n  <p>hi</p>\n</section>\n').model);
  check('the top level of a file carries it too', /<section data-avb-p=\{\["0", /.test(plain), plain);
  check('and so does what is inside it', /<p data-avb-p="0\.0">/.test(plain), plain);

  // ── A file's own roots carry whatever they were called by ──────────────────
  //
  // The attribute on a component is a prop, and it only reaches the DOM if
  // that component puts it there. Waiting for `{...rest}` was not good enough:
  // a slider written without one, placed inside a <Section> that scrubs
  // comments before checking whether its slot rendered anything, had no marker
  // left and no attribute either. Nothing on the page answered to it — no
  // outline, no click, and the navigator wore the crossed-out eye on a row
  // that was plainly on screen.
  //
  // So a root says both names: its own, and whatever the caller called it.
  {
    const noSpread = serializePageMarked(
      parsePage('---\nconst { slides } = Astro.props;\n---\n<div class="slider">{slides.length}</div>\n').model,
      'src/components/Slider.astro|'
    );
    check(
      'a root that never asked for rest props still carries the caller’s name',
      /data-avb-p=\{\["src\/components\/Slider\.astro\|0", Astro\.props\["data-avb-p"\]\]/.test(noSpread),
      noSpread
    );

    // The common shape for a component that can decline to render: the root is
    // a condition, and what the branch renders is what the caller placed.
    const conditional = serializePageMarked(
      parsePage(
        '---\nconst { render = true, slides } = Astro.props;\n---\n{\n  render && slides.length > 0 && (\n    <div class="slider">x</div>\n  )\n}\n'
      ).model,
      'src/components/Slider.astro|'
    );
    check(
      'a root written as a condition carries it too',
      /<div class="slider" data-avb-p=\{\["src\/components\/Slider\.astro\|0\.0\.0", Astro\.props\["data-avb-p"\]\]/.test(conditional),
      conditional
    );

    // Only the roots. An element deeper in the file is not what the caller
    // placed, and naming it after the caller would put the page's name for the
    // whole component on some div inside it.
    check(
      'nothing deeper in the file does',
      !/<p data-avb-p=\{/.test(plain),
      plain
    );
  }

  // The two that render no element of their own: there is nothing for an
  // attribute to ride on, and their markers are what address them.
  const passthrough = serializePageMarked(
    parsePage('---\n---\n<div>\n  <Fragment>\n    <slot />\n  </Fragment>\n</div>\n').model
  );
  check('a <Fragment> is left alone', !/<Fragment data-avb-p/.test(passthrough), passthrough);
  check('and so is a <slot />', !/<slot data-avb-p/.test(passthrough), passthrough);

  // Where a node forwards its rest props, the caller's path for this instance
  // arrives inside the spread and both want the same attribute — so the one
  // written here names both, and has to be the one that survives.
  //
  // Which side of the spread that is depends on what the spread is, and
  // getting it backwards is silent: the tag is there, holding the wrong file's
  // path. <Tabs>'s root div kept the page's path, so with Tabs open a click on
  // it resolved to nothing — which is how the canvas hears "done in here", and
  // the component closed itself the moment you clicked inside it.
  const el = serializePageMarked(
    parsePage('---\nconst { ...rest } = Astro.props;\n---\n<span {...rest}>x</span>\n').model,
    'src/components/Icon.astro|'
  );
  const comp = serializePageMarked(
    parsePage('---\nconst { ...rest } = Astro.props;\n---\n<Svg {...rest} />\n').model,
    'src/components/Icon.astro|'
  );
  for (const [what, out] of [['an element', el], ['a component', comp]]) {
    check(
      `${what} that forwards rest props keeps the path that arrived`,
      /data-avb-p=\{\["src\/components\/Icon\.astro\|0", Astro\.props\["data-avb-p"\]\]\.filter\(Boolean\)\.join\(" "\)\}/.test(out),
      out
    );
  }
  // An element's attributes are text, and an html parser keeps the FIRST of
  // two with the same name.
  check('an element writes it before the spread', el.indexOf('data-avb-p') < el.indexOf('{...rest}'), el);
  // A component's are an object, where the later key overwrites.
  check('a component writes it after', comp.indexOf('{...rest}') < comp.indexOf('data-avb-p'), comp);
  // Everything else stays the plain attribute — no expression, nothing to
  // evaluate, nothing to go wrong in a file that never mentions Astro.props.
  const nested = serializePageMarked(parsePage('---\n---\n<div><span>x</span></div>\n').model);
  check(
    'a node that is neither a root nor a spread gets the plain attribute',
    /<span data-avb-p="0\.0">/.test(nested),
    nested
  );
}

// ── What the page reports when only the tags survive ────────────────────────
(async () => {
  const { JSDOM } = require('jsdom');
  // The <Wrap> instance is a direct child of the page's <Layout>, so its own
  // markers are slot content too — but a layout renders <slot /> plainly, so
  // they arrive. Everything below it went through the string round trip: the
  // elements are on the page and every comment between them is gone.
  const dom = new JSDOM(
    `<!doctype html><body>
      <!--avb-s:0-->
      <div class="layout">
        <div class="eyebrow" data-avb-p="0.0">stack</div>
        <div class="a" data-avb-p="0.1"><p class="b" data-avb-p="0.1.0">deep</p></div>
        <div class="c" data-avb-p="0.2"><span data-avb-p="0.2">spread onto an inner element</span></div>
        <em data-avb-p="src/components/Icon.astro|0.0 0.3">two files, one element</em>
      </div>
      <!--avb-e:0-->
    </body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Element.prototype.getBoundingClientRect = function () {
    return { ...NO_BOX, width: 100, height: 20, right: 100, bottom: 20 };
  };
  window.Range.prototype.getBoundingClientRect = () => NO_BOX;

  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.navigator = window.navigator;
  global.MutationObserver = window.MutationObserver;
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  global.Element = window.Element;
  global.Node = window.Node;

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

  const ev = new window.MessageEvent('message', { data: { type: 'avb:track', paths: ['0', '0.2'] } });
  Object.defineProperty(ev, 'source', { value: window.parent });
  window.dispatchEvent(ev);
  await settle(20);

  const rendered = sent.filter((m) => m.type === 'avb:rendered-nodes').pop();
  const paths = rendered?.paths || [];
  check('the page reports what rendered', !!rendered, JSON.stringify(sent.map((m) => m.type)));
  check('the wrapped node is on the page', paths.includes('0'), JSON.stringify(paths));
  for (const p of ['0.0', '0.1', '0.1.0']) {
    check(`the tag alone puts ${p} on the page`, paths.includes(p), JSON.stringify(paths));
  }
  // An element can answer to more than one file: the component that rendered
  // it has a name for it, and so does the page that placed that component.
  check('an element in two namespaces answers to the page', paths.includes('0.3'), JSON.stringify(paths));
  // The other half of the report: nothing here is display:none, and a node the
  // page can't find says nothing about itself either way.
  const states = sent.filter((m) => m.type === 'avb:node-states').pop();
  check('and none of them is called hidden', !(states?.hidden || []).length, JSON.stringify(states));

  // A component that spreads its rest props puts the path on whatever element
  // it spreads onto, which can sit inside the one the collector tagged. That
  // is one copy addressed twice — not two — and the boxes have to agree with
  // the occurrence a click reports, or a node with a single instance answers
  // "copy 2" for a click in the wrong half of itself.
  const rects = sent.filter((m) => m.type === 'avb:rects').pop();
  check(
    'a path on an element and again inside it is one copy',
    (rects?.rects?.['0.2'] || []).length === 1,
    JSON.stringify(rects?.rects?.['0.2'])
  );
  check(
    'and its classes are read once, from the outer one',
    JSON.stringify(rects?.classes?.['0.2']) === JSON.stringify([['c']]),
    JSON.stringify(rects?.classes?.['0.2'])
  );

  if (failures.length) {
    console.error(`\nslot-markers: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`slot-markers: ${checked} passed  [comments dropped, paths kept]`);
})();
