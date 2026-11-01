// Where a new node lands.
//
//   node test/renderer/editor/insertTarget.test.js
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

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundle = path.join(buildDirectory, 'insert-target.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/editor/insertTarget.ts')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { insertTargetFor, acceptsChildren, tagOfComponent } = require(bundle);
  const { parseSlots, rootTag } = require('#dist/electron/parse/astroParser.js');

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
      { id: 'hr', kind: 'element', name: 'hr', props: {}, children: undefined },
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
  const at = (selectionId, item = DIV) => insertTargetFor(model, selectionId, item, insertables);

  // ── The report ────────────────────────────────────────────────────────────
  check('a div inserted with the Section selected goes inside it', at('sec').parentId === 'sec', JSON.stringify(at('sec')));
  check('at the end of what it already holds', at('sec').index === 2, JSON.stringify(at('sec')));
  // And the reason it used to land outside — a component with no default slot
  // still can't hold anything.
  check(
    'while one that takes no content puts it alongside instead',
    JSON.stringify(at('img')) === JSON.stringify({ parentId: 'sec', index: 1 }),
    JSON.stringify(at('img')),
  );

  // ── The tags still decide ─────────────────────────────────────────────────
  check('a void element never holds anything', JSON.stringify(at('hr')) === JSON.stringify({ parentId: undefined, index: 4 }), JSON.stringify(at('hr')));
  check('and a <div> inside a <p> lands after the <p>', JSON.stringify(at('p')) === JSON.stringify({ parentId: undefined, index: 2 }), JSON.stringify(at('p')));
  // A component is judged by what it renders, not by being a component.
  const heading = { id: 'h', kind: 'component', name: 'Heading', props: {}, children: [] };
  check('a <p> is refused by a component that renders a heading', acceptsChildren(heading, 'p', insertables) === false);
  check('while a <span> is fine there', acceptsChildren(heading, 'span', insertables) === true);
  check(
    "and the instance's own tag wins over the component's default",
    tagOfComponent(insertables[3], { props: { tag: { type: 'string', value: 'div' } } }) === 'div',
    tagOfComponent(insertables[3], { props: { tag: { type: 'string', value: 'div' } } }),
  );
  // An inserted COMPONENT is judged the same way: <Paragraph> renders a <p>,
  // and a <p> may not sit inside the <h2> a <Heading> renders.
  {
    const para = { type: 'component', name: 'Paragraph' };
    const target = insertTargetFor(model, 'head', para, insertables);
    check(
      'a <Paragraph> inserted into a <Heading> lands after it',
      JSON.stringify(target) === JSON.stringify({ parentId: undefined, index: 3 }),
      JSON.stringify(target),
    );
    const span = insertTargetFor(model, 'head', { type: 'element', tag: 'span' }, insertables);
    check('while a <span> goes inside it', span.parentId === 'head', JSON.stringify(span));
  }
  // Nothing selected: the end of the page.
  check(
    'with nothing selected it goes at the end',
    JSON.stringify(at(undefined)) === JSON.stringify({ parentId: undefined, index: 4 }),
    JSON.stringify(at(undefined)),
  );
  check('and the frontmatter row is not a place', JSON.stringify(at('frontmatter')) === JSON.stringify({ parentId: undefined, index: 4 }));

  const condition = {
    id: 'condition',
    kind: 'cond',
    children: [
      {
        id: 'then',
        kind: 'branch',
        name: 'then',
        children: [{ id: 'conditional-child', kind: 'element', name: 'p', children: [] }],
      },
    ],
  };
  const conditionTarget = insertTargetFor({ nodes: [condition] }, 'condition', DIV, insertables);
  check(
    'an element inserted with an if selected goes inside its visible branch',
    JSON.stringify(conditionTarget) === JSON.stringify({ parentId: 'then', index: 1 }),
    JSON.stringify(conditionTarget),
  );

  // ── The components this came from ─────────────────────────────────────────
  // The table above is only right if the scan really reports that, which is
  // the half that broke.
  const LUMOS = '/Users/timothyricks/Documents/Projects/lumos-framework/src/components';
  // By name, from wherever it sits: this is somebody's working project, and a
  // component moved into a folder should not read as a broken scan — or, as it
  // did, as a crash that takes the rest of the suite with it.
  // A project's component folders are a few levels deep; the bound stops a runaway walk.
  const WALK_LIMITS = { directoryDepthMax: 32 };
  const findComponent = (directory, name, depth = 0) => {
    assert.ok(depth <= WALK_LIMITS.directoryDepthMax, 'findComponent: directory depth limit');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const hit = findComponent(full, name, depth + 1);
        if (hit) {
          return hit;
        }
      } else if (entry.name === `${name}.astro`) {
        return fs.readFileSync(full, 'utf8');
      }
    }
    return undefined;
  };
  if (fs.existsSync(LUMOS)) {
    for (const [name, slots, tag] of [
      ['Section', true, 'section'],
      ['ContentWrapper', true, 'div'],
      ['Img', false, undefined],
    ]) {
      const source = findComponent(LUMOS, name);
      if (source === undefined) {
        continue;
      } // not in this project any more
      check(
        `the real <${name}> ${slots ? 'takes' : 'takes no'} default content`,
        parseSlots(source).includes('default') === slots,
        JSON.stringify(parseSlots(source)),
      );
      if (tag) {
        check(`and renders a <${tag}>`, (rootTag(source) || {}).tag === tag, JSON.stringify(rootTag(source)));
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
