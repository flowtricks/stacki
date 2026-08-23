// Slots a component takes without ever writing <slot />.
//
//   node test/slot-api.js
//
// A component can read its own slot instead of rendering it:
//
//   const content = await slotContent(Astro.slots);        // slots.ts helper
//   const column2 = await Astro.slots.render('column2');
//
// which is the only way to ask whether the slot rendered anything — and so the
// shape of every component that draws nothing when it is empty. The panel read
// slots by looking for `<slot`, found none, and decided the component takes no
// content: a <Paragraph> selected on the canvas had no Content field, and there
// was no way to give it its first words. The `slot` dropdown on its children
// was empty for the same reason.
//
// The trap on the other side is a component that only TALKS about slots. Three
// files across two projects grew a slot called "0" out of a frontmatter comment
// explaining how `Astro.slots.render()` works, so what a file says about itself
// is blanked before any of this is read.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { parseSlots, defaultSlotInline } = require('../electron/astroParser.js');

const page = (frontmatter, body) => `---\n${frontmatter}\n---\n${body}\n`;
const slots = (fm, body) => JSON.stringify(parseSlots(page(fm, body)));

// ── The old way, unchanged ──────────────────────────────────────────────────
check('a plain <slot /> is the default slot', slots('', '<div><slot /></div>') === '["default"]');
check(
  'a named slot is named',
  slots('', '<div><slot name="footer" /></div>') === '["footer"]',
  slots('', '<div><slot name="footer" /></div>')
);
check(
  'and both together put the default first',
  slots('', '<div><slot name="footer" /><slot /></div>') === '["default","footer"]',
  slots('', '<div><slot name="footer" /><slot /></div>')
);
check('a component with no slot at all takes none', slots('', '<hr />') === '[]');

// ── Read through Astro.slots ────────────────────────────────────────────────
check(
  'render() with nothing named is the default slot',
  slots('const c = await Astro.slots.render();', '<p set:html={c} />') === '["default"]',
  slots('const c = await Astro.slots.render();', '<p set:html={c} />')
);
check(
  'render("x") names its slot',
  slots("const c = await Astro.slots.render('footer');", '<p set:html={c} />') === '["footer"]',
  slots("const c = await Astro.slots.render('footer');", '<p set:html={c} />')
);
check(
  'has("x") counts too — asking is taking',
  slots('const has = Astro.slots.has("background");', '<div />') === '["background"]',
  slots('const has = Astro.slots.has("background");', '<div />')
);
// Handed to a helper, the string beside it is the name.
check(
  'a helper given Astro.slots and nothing else means the default',
  slots('const c = await slotContent(Astro.slots);', '<div set:html={c} />') === '["default"]',
  slots('const c = await slotContent(Astro.slots);', '<div set:html={c} />')
);
{
  const fm =
    'const column1 = await slotContent(Astro.slots);\nconst column2 = await slotContent(Astro.slots, "column2");';
  check(
    'and both columns of a two-slot layout are found',
    slots(fm, '<div />') === '["default","column2"]',
    slots(fm, '<div />')
  );
}
// The name comes from the call it is in, not from the next one down the file.
{
  const fm = 'const a = await slotContent(Astro.slots);\nconst b = await slotContent(Astro.slots, "aside");';
  check('a call cannot borrow the name of a later one', slots(fm, '<div />') === '["default","aside"]', slots(fm, '<div />'));
}
check(
  'a variable slot name reads as the default rather than as itself',
  slots('const c = await Astro.slots.render(name);', '<div set:html={c} />') === '["default"]',
  slots('const c = await Astro.slots.render(name);', '<div set:html={c} />')
);

// ── What a file says about itself is not what it does ───────────────────────
{
  const fm =
    '/**\n * A <script> never reaches the page when the parent consumes it through\n * `Astro.slots.render()`, which is how `Section` handles its slots.\n */\nconst id = "x";';
  check('a comment about Astro.slots declares no slot', slots(fm, '<div />') === '[]', slots(fm, '<div />'));
}
check(
  'nor does a line comment',
  slots('// uses Astro.slots.render("aside") one day\nconst x = 1;', '<div />') === '[]',
  slots('// uses Astro.slots.render("aside") one day\nconst x = 1;', '<div />')
);
check(
  'and an html comment in the body says nothing either',
  slots('', '<div><!-- Astro.slots.render("aside") --></div>') === '[]',
  slots('', '<div><!-- Astro.slots.render("aside") --></div>')
);
// A URL in the template is not a comment, whatever `//` looks like.
check(
  'a url keeps the rest of its line',
  slots('const c = await Astro.slots.render();', '<a href="https://x.dev">link</a>\n<p set:html={c} />') === '["default"]',
  slots('const c = await Astro.slots.render();', '<a href="https://x.dev">link</a>\n<p set:html={c} />')
);

// ── Where the content lands decides what arrives in it ──────────────────────
const inline = (fm, body) => defaultSlotInline(page(fm, body));
check('a slot inside a <p> wants words', inline('', '<p><slot /></p>') === true);
check('a slot inside a <div> wants blocks', inline('', '<div><slot /></div>') === false);
// The same question for a component that put its slot back itself: the
// Fragment renders nothing, so what wraps the content is the tag above it.
check(
  'set:html inside a <p> wants words',
  inline('const c = await slotContent(Astro.slots);', '<p><Fragment set:html={c} /></p>') === true,
  String(inline('const c = await slotContent(Astro.slots);', '<p><Fragment set:html={c} /></p>'))
);
check(
  'set:html inside a <div> wants blocks',
  inline('const c = await slotContent(Astro.slots);', '<div><Fragment set:html={c} /></div>') === false
);
// `<Tag>` is a variable — resolve it to what it defaults to.
{
  const fm = 'const { tag = "p" } = Astro.props;\nconst Tag = tag;\nconst c = await slotContent(Astro.slots);';
  check(
    'and a dynamic tag is resolved before it is judged',
    inline(fm, '<Tag><Fragment set:html={c} /></Tag>') === true,
    String(inline(fm, '<Tag><Fragment set:html={c} /></Tag>'))
  );
}
// Set on the element itself, that element is the wrapper.
check(
  'an element that takes the content directly is the wrapper',
  inline('const c = await slotContent(Astro.slots);', '<p set:html={c} />') === true,
  String(inline('const c = await slotContent(Astro.slots);', '<p set:html={c} />'))
);
check(
  'a named slot never decides this',
  inline('const c = await slotContent(Astro.slots, "aside");', '<p><Fragment set:html={c} /></p>') === false,
  String(inline('const c = await slotContent(Astro.slots, "aside");', '<p><Fragment set:html={c} /></p>'))
);

// ── The files this came from ────────────────────────────────────────────────
const LUMOS = '/Users/timothyricks/Documents/Projects/lumos-framework/src/components';
// By name, from wherever it sits. This is somebody's working project: the
// components were in one folder when this was written and are in a tree of
// them now, and a moved file should not read as a broken parser — or, as it
// did, as a crash that takes the rest of the suite with it.
const findComponent = (dir, name) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findComponent(full, name);
      if (hit) return hit;
    } else if (entry.name === `${name}.astro`) {
      return fs.readFileSync(full, 'utf8');
    }
  }
  return null;
};
if (fs.existsSync(LUMOS)) {
  const read = (n) => findComponent(LUMOS, n);
  const onceReal = (what, name, run) => {
    const source = read(name);
    if (source == null) return; // that component is not in this project any more
    run(source, what);
  };
  onceReal('the real <Paragraph> takes content', 'Paragraph', (src) => {
    check('the real <Paragraph> takes content', JSON.stringify(parseSlots(src)) === '["default"]', JSON.stringify(parseSlots(src)));
    check('and it takes words', defaultSlotInline(src) === true);
  });
  onceReal('the real <ContentWrapper>', 'ContentWrapper', (src) => {
    check(
      'the real <ContentWrapper> offers its second column',
      JSON.stringify(parseSlots(src)) === '["default","column2"]',
      JSON.stringify(parseSlots(src))
    );
    check('while it takes blocks, not words', defaultSlotInline(src) === false);
  });
  onceReal('a component with no slots', 'Img', (src) => {
    check('a component with no slots still reports none', JSON.stringify(parseSlots(src)) === '[]', JSON.stringify(parseSlots(src)));
  });
}

// ── The field it was all for ────────────────────────────────────────────────
(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'slot-api.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.DOMRect = dom.window.DOMRect;
  global.Window = dom.window.Window;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  dom.window.Range.prototype.getBoundingClientRect = () => NO_BOX;
  dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const PropsPanel = require(bundle).default;

  const mount = async (takesSlotText) => {
    const host = dom.window.document.getElementById('root');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(PropsPanel, {
          // An empty instance, exactly as the page writes it: <Paragraph />.
          node: { id: 'n1', kind: 'component', name: 'Paragraph', props: {}, children: [] },
          projectPath: '/p',
          schema: [],
          takesSlotText,
          onSetProp: () => {},
          onSetProps: () => {},
          onRenameProp: () => {},
          onOpenCode: () => {},
          onSetText: () => {},
        })
      );
    });
    const labels = [...host.querySelectorAll('.prop-label')].map((n) => n.textContent.trim());
    await act(async () => root.unmount());
    return labels;
  };

  const withSlot = await mount(true);
  check('a component that takes content is offered a Content field', withSlot.includes('Content'), JSON.stringify(withSlot));
  const without = await mount(false);
  check('one that takes none is not', !without.includes('Content'), JSON.stringify(without));

  if (failures.length) {
    console.error(`\nslot-api: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`slot-api: ${checked} passed  [read, not written]`);
})();
