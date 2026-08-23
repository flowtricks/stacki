// Where a new node lands.
//
//   node test/insert-target.js
//
// Select a <Section> on the canvas, insert a div, and it appeared NEXT to the
// section rather than in it. Nothing about the section says why: it is a
// component that renders a <section>, it holds children on the page, and the
// navigator draws them under it.
//
// The rule is that a component accepts children only when it takes default
// slot content — and this one never writes `<slot />`. It reads its slot
// itself (`await slotContent(Astro.slots)`), which is how a component that
// draws nothing when empty has to be written, and the scan for `<slot` found
// none. So: takes no content, can't hold the div, insert beside it.
//
// The other half of the rule is the tags: a component is a stand-in for what
// it renders, and a <p> is no more allowed inside a heading for being wrapped
// in one.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'insert-target.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'insertTarget.js')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { insertTargetFor, acceptsChildren, tagOfComponent } = require(bundle);
  const { parseSlots, rootTag } = require('../electron/astroParser.js');

  // The page from the report: a <Section> with children, inside a layout.
  const model = {
    nodes: [
      {
        id: 'sec',
        kind: 'component',
        name: 'Section',
        props: {},
        children: [
          { id: 'img', kind: 'component', name: 'Img', props: {}, children: [] },
          { id: 'wrap', kind: 'component', name: 'ContentWrapper', props: {}, children: [] },
        ],
      },
      { id: 'p', kind: 'element', name: 'p', props: {}, children: [] },
      { id: 'head', kind: 'component', name: 'Heading', props: {}, children: [] },
      { id: 'hr', kind: 'element', name: 'hr', props: {}, children: null },
    ],
  };
  const DIV = { type: 'element', tag: 'div' };
  // What the scan reports for these components — read from the real files
  // below, spelled out here so the rule can be checked on its own.
  const insertables = [
    { name: 'Section', slots: ['default', 'background'], renderTag: { tag: 'section' } },
    { name: 'ContentWrapper', slots: ['default', 'column2'], renderTag: { tag: 'div' } },
    { name: 'Img', slots: [], renderTag: { tag: 'img' } },
    { name: 'Heading', slots: ['default'], renderTag: { prop: 'tag', tag: 'h2' } },
    { name: 'Paragraph', slots: ['default'], renderTag: { prop: 'tag', tag: 'p' } },
  ];
  const at = (selId, item = DIV) => insertTargetFor(model, selId, item, insertables);

  // ── The report ────────────────────────────────────────────────────────────
  check(
    'a div inserted with the Section selected goes inside it',
    at('sec').parentId === 'sec',
    JSON.stringify(at('sec'))
  );
  check('at the end of what it already holds', at('sec').index === 2, JSON.stringify(at('sec')));
  // And the reason it used to land outside — a component with no default slot
  // still can't hold anything.
  check(
    'while one that takes no content puts it alongside instead',
    JSON.stringify(at('img')) === JSON.stringify({ parentId: 'sec', index: 1 }),
    JSON.stringify(at('img'))
  );

  // ── The tags still decide ─────────────────────────────────────────────────
  check('a void element never holds anything', JSON.stringify(at('hr')) === JSON.stringify({ parentId: null, index: 4 }), JSON.stringify(at('hr')));
  check(
    'and a <div> inside a <p> lands after the <p>',
    JSON.stringify(at('p')) === JSON.stringify({ parentId: null, index: 2 }),
    JSON.stringify(at('p'))
  );
  // A component is judged by what it renders, not by being a component.
  const heading = { id: 'h', kind: 'component', name: 'Heading', props: {}, children: [] };
  check(
    'a <p> is refused by a component that renders a heading',
    acceptsChildren(heading, 'p', insertables) === false
  );
  check(
    'while a <span> is fine there',
    acceptsChildren(heading, 'span', insertables) === true
  );
  check(
    "and the instance's own tag wins over the component's default",
    tagOfComponent(insertables[3], { props: { tag: { type: 'string', value: 'div' } } }) === 'div',
    tagOfComponent(insertables[3], { props: { tag: { type: 'string', value: 'div' } } })
  );
  // An inserted COMPONENT is judged the same way: <Paragraph> renders a <p>,
  // and a <p> may not sit inside the <h2> a <Heading> renders.
  {
    const para = { type: 'component', name: 'Paragraph' };
    const target = insertTargetFor(model, 'head', para, insertables);
    check(
      'a <Paragraph> inserted into a <Heading> lands after it',
      JSON.stringify(target) === JSON.stringify({ parentId: null, index: 3 }),
      JSON.stringify(target)
    );
    const span = insertTargetFor(model, 'head', { type: 'element', tag: 'span' }, insertables);
    check('while a <span> goes inside it', span.parentId === 'head', JSON.stringify(span));
  }
  // Nothing selected: the end of the page.
  check('with nothing selected it goes at the end', JSON.stringify(at(null)) === JSON.stringify({ parentId: null, index: 4 }), JSON.stringify(at(null)));
  check('and the frontmatter row is not a place', JSON.stringify(at('frontmatter')) === JSON.stringify({ parentId: null, index: 4 }));

  // ── The components this came from ─────────────────────────────────────────
  // The table above is only right if the scan really reports that, which is
  // the half that broke.
  const LUMOS = '/Users/timothyricks/Documents/Projects/lumos-framework/src/components';
  // By name, from wherever it sits: this is somebody's working project, and a
  // component moved into a folder should not read as a broken scan — or, as it
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
    for (const [name, slots, tag] of [
      ['Section', true, 'section'],
      ['ContentWrapper', true, 'div'],
      ['Img', false, null],
    ]) {
      const src = findComponent(LUMOS, name);
      if (src == null) continue; // not in this project any more
      check(
        `the real <${name}> ${slots ? 'takes' : 'takes no'} default content`,
        parseSlots(src).includes('default') === slots,
        JSON.stringify(parseSlots(src))
      );
      if (tag) {
        check(`and renders a <${tag}>`, (rootTag(src) || {}).tag === tag, JSON.stringify(rootTag(src)));
      }
    }
  }

  if (failures.length) {
    console.error(`\ninsert-target: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`insert-target: ${checked} passed  [inside, or beside]`);
})();
