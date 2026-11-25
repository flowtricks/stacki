// Goal: Design mode's model reads a page copy, changes it and describes the change correctly: design ids and
// instance tags on the baseline, every DOM gesture (move, free placement, styles, hide, duplicate, insert, unlink,
// reset), the comparison the AI hand-off sends, snapping arithmetic, click picking, the bounded undo history, the
// draft parser, and the hand-off's note lines. Each contract has its known-good case and its invalid inputs.
//
// Method: the real modules (bundled by test/helpers/rendererModule.js) over JSDOM documents built from small marked
// pages that look like what the canvas hands over (data-avb-p paths, component namespaces). JSDOM lays nothing out,
// so geometry is tested through the pure functions (designSnap, resizeBox) and through stubbed rects.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = require('../../../helpers/rendererModule');

const prepare = load('src/app/designMode/model/designPrepare.ts');
const dom = load('src/app/designMode/model/designDom.ts');
const changes = load('src/app/designMode/model/designChanges.ts');
const snap = load('src/app/designMode/model/designSnap.ts');
const select = load('src/app/designMode/model/designSelect.ts');
const history = load('src/app/designMode/model/designHistory.ts');
const drafts = load('src/app/designMode/runtime/designDrafts.ts');
const handoff = load('src/app/designMode/runtime/designHandoffText.ts');

const PAGE = `<!DOCTYPE html><html><head><title>t</title></head><body>
<main data-avb-p="src/layouts/Base.astro|1 0">
  <section data-avb-p="src/components/Section.astro|0 0.0" class="section">
    <h1 data-avb-p="src/components/Heading.astro|0 0.0.0" class="heading">Hello world</h1>
    <p data-avb-p="0.0.1" class="text">Intro text</p>
    <a data-avb-p="src/components/Button.astro|0 0.0.2" class="button_wrap">Go</a>
  </section>
</main></body></html>`;

const MODEL = {
  model: {
    imports: [],
    nodes: [
      {
        kind: 'component',
        id: 'n0',
        name: 'Layout',
        start: 0,
        children: [
          {
            kind: 'component',
            id: 'n1',
            name: 'Section',
            start: 30,
            children: [
              {
                kind: 'component',
                id: 'n2',
                name: 'Heading',
                start: 50,
                props: { tag: { type: 'string', value: 'h1' } },
                children: [{ kind: 'text', id: 'n3', value: 'Hello world' }],
              },
              { kind: 'element', id: 'n4', name: 'p', start: 80, children: [{ kind: 'text', id: 'n5', value: 'Intro text' }] },
              {
                kind: 'component',
                id: 'n6',
                name: 'Button',
                start: 110,
                props: {
                  emphasis: { type: 'string', value: 'primary' },
                  small: { type: 'bare' },
                  size: { type: 'expr', value: '3' },
                  data: { type: 'expr', value: 'items[0]' },
                },
                children: [{ kind: 'text', id: 'n7', value: 'Go' }],
              },
            ],
          },
        ],
      },
    ],
  },
  text: '---\n---\n<Layout>\n  <Section>\n    <Heading tag="h1">Hello world</Heading>\n' + ' '.repeat(200),
};

const COMPONENTS = [
  { name: 'Layout', path: 'src/layouts/Base.astro' },
  { name: 'Section', path: 'src/components/Section.astro' },
  { name: 'Heading', path: 'src/components/Heading.astro' },
  { name: 'Button', path: 'src/components/Button.astro' },
];

function documentOf(html) {
  return new JSDOM(html).window.document;
}

function prepared() {
  const document = documentOf(PAGE);
  const result = prepare.prepareBaseline(document, MODEL, COMPONENTS);
  return { document, result };
}

test('a baseline numbers every body element and tags each component instance once', () => {
  const { document, result } = prepared();
  const ids = [...document.querySelectorAll('[data-dm-id]')].map((element) => element.getAttribute('data-dm-id'));
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(document.body.getAttribute('data-dm-id'), 'e0');
  assert.equal(result.elementCount, ids.length);
  const instances = [...result.instances.values()];
  assert.deepEqual(instances.map((instance) => instance.name).sort(), ['Button', 'Heading', 'Layout', 'Section']);
  const button = instances.find((instance) => instance.name === 'Button');
  assert.equal(button.component, 'src/components/Button.astro');
  assert.deepEqual(button.props, { emphasis: 'primary', small: true, size: 3 });
  assert.deepEqual(button.codeProps, { data: 'items[0]' });
  assert.deepEqual(button.slots, ['default']);
  assert.equal(document.querySelector('a').getAttribute('data-dm-instance') !== null, true);
  assert.equal(document.querySelector('p').hasAttribute('data-dm-instance'), false, 'a plain element is no instance');
});

test('a page with no model tags no instance, and a page past the element bound is refused', () => {
  const document = documentOf(PAGE);
  const result = prepare.prepareBaseline(document, undefined, COMPONENTS);
  assert.equal(result.instances.size, 0);
  const huge = documentOf('<body>' + '<i></i>'.repeat(60_001) + '</body>');
  assert.throws(() => prepare.prepareBaseline(huge, undefined, []), /within the element bound/);
});

test('literal props are read from expressions, code stays code', () => {
  assert.equal(prepare.literalOf('true'), true);
  assert.equal(prepare.literalOf(' false '), false);
  assert.equal(prepare.literalOf('-2.5'), -2.5);
  assert.equal(prepare.literalOf('"a\\"b"'), 'a"b');
  assert.equal(prepare.literalOf('items[0]'), undefined);
  assert.equal(prepare.literalOf('`x${y}`'), undefined, 'a template with code is code');
});

test('every gesture changes the frame copy, and the comparison names it', () => {
  const { document: baseline, result } = prepared();
  const frame = documentOf(prepare.prepareBaseline(documentOf(PAGE), MODEL, COMPONENTS).html);
  const mint = new dom.ElementIdMint(frame);
  const section = frame.querySelector('section');
  const heading = frame.querySelector('h1');
  const paragraph = frame.querySelector('p');
  const button = frame.querySelector('a');
  // Move the paragraph before the heading.
  dom.moveInFlow(paragraph, section, heading);
  // Restyle and retext the heading.
  dom.setInlineStyle(heading, 'font-size', '64px');
  heading.textContent = 'Hello design';
  // Hide the button, duplicate the paragraph, add text.
  dom.setHidden(button, 'hidden');
  const copy = dom.duplicateAfter(paragraph, mint);
  assert.equal(copy.getAttribute('data-dm-copy-of'), paragraph.getAttribute('data-dm-id'));
  assert.notEqual(copy.getAttribute('data-dm-id'), paragraph.getAttribute('data-dm-id'));
  const fragment = dom.parseFragment(frame, '<p>New words</p><script>alert(1)</script><!--avb-s:0-->');
  assert.equal(fragment.querySelectorAll('script').length, 0, 'scripts never enter a frame');
  dom.insertFragment(section, undefined, fragment, mint, 'text');
  // Change the button's props as a rendering would leave them, then unlink the section.
  button.setAttribute('data-dm-props', JSON.stringify({ emphasis: 'secondary', small: true, size: 3 }));
  const sectionKey = section.getAttribute('data-dm-instance');
  assert.equal(dom.unlinkInstance(frame, sectionKey, 'src/components/Section.astro'), 1);
  const found = changes.designChanges(baseline, frame, { instances: result.instances, sources: prepare.pageSources(MODEL), pageFile: 'src/pages/index.astro' });
  const kinds = found.map((change) => change.kind).sort();
  for (const kind of ['moved', 'restyled', 'text', 'hidden', 'added', 'props', 'unlinked']) {
    assert.ok(kinds.includes(kind), `the comparison names a ${kind} change: ${kinds.join(',')}`);
  }
  const props = found.find((change) => change.kind === 'props');
  assert.deepEqual(props.props, [{ property: 'emphasis', before: '"primary"', after: '"secondary"' }]);
  const restyled = found.find((change) => change.kind === 'restyled');
  assert.deepEqual(restyled.styles, [{ property: 'font-size', before: '', after: '64px' }]);
  assert.match(handoff.changeSentence(props), /Button .*src\/components\/Button\.astro at src\/pages\/index\.astro:\d+.*emphasis "primary" → "secondary"/);
  // Deleting the copy and the new text: the copy's change disappears with it; removing an original is a removal.
  copy.remove();
  paragraph.remove();
  const after = changes.designChanges(baseline, frame, { instances: result.instances, sources: new Map(), pageFile: undefined });
  assert.ok(after.some((change) => change.kind === 'removed' && change.element.label.includes('Intro text')));
});

test('an unchanged copy has no changes, and moves are the fewest that explain the order', () => {
  const { document: baseline, result } = prepared();
  const frame = documentOf(baseline.documentElement.outerHTML);
  assert.deepEqual(changes.designChanges(baseline, frame, { instances: result.instances, sources: new Map(), pageFile: undefined }), []);
  assert.deepEqual(changes.longestRun([2, 0, 1, 3]), [0, 1, 3]);
  assert.deepEqual(changes.longestRun([]), []);
  const section = frame.querySelector('section');
  dom.moveInFlow(frame.querySelector('a'), section, section.firstElementChild);
  const moved = changes
    .designChanges(baseline, frame, { instances: result.instances, sources: new Map(), pageFile: undefined })
    .filter((change) => change.kind === 'moved');
  assert.equal(moved.length, 1, 'moving one element to the front is one move, not two');
});

test('a free element is said once as a placement, and back in the flow it is no change', () => {
  const { document: baseline, result } = prepared();
  const frame = documentOf(baseline.documentElement.outerHTML);
  const paragraph = frame.querySelector('p');
  dom.makeFree(paragraph, { leftPx: 10.4, topPx: 20, widthPx: 300, heightPx: 40 });
  assert.equal(dom.inlineStyleOf(paragraph, 'position'), 'absolute');
  assert.equal(dom.inlineStyleOf(paragraph, 'left'), '10px');
  assert.equal(dom.inlineStyleOf(paragraph, 'height'), '', 'text keeps its own height');
  assert.equal(dom.inlineStyleOf(frame.querySelector('section'), 'position'), 'relative', 'the parent becomes the containing block');
  const found = changes.designChanges(baseline, frame, { instances: result.instances, sources: new Map(), pageFile: undefined });
  const freed = found.filter((change) => change.kind === 'freed');
  assert.equal(freed.length, 1);
  assert.ok(!found.some((change) => change.kind === 'restyled' && change.element.id === freed[0].element.id), 'no separate restyle for the placement');
  assert.throws(() => dom.moveInFlow(frame.querySelector('section'), frame.querySelector('h1'), undefined), /never moves into itself/);
  assert.throws(() => dom.px(Number.NaN), /a finite length/);
});

test('reset puts an element back as the page had it, keeping where it is', () => {
  const { document: baseline } = prepared();
  const frame = documentOf(baseline.documentElement.outerHTML);
  const heading = frame.querySelector('h1');
  dom.setInlineStyle(heading, 'color', 'red');
  heading.textContent = 'Changed';
  assert.equal(dom.resetElement(heading, baseline), true);
  assert.equal(heading.textContent, 'Hello world');
  assert.equal(heading.hasAttribute('style'), false);
  const made = frame.createElement('div');
  made.setAttribute('data-dm-id', 'n9');
  assert.equal(dom.resetElement(made, baseline), false, 'an element the page never had has nothing to go back to');
});

test('snapping finds the nearest line within the threshold, guides and gaps follow it', () => {
  const moving = { xPx: 103, yPx: 50, widthPx: 100, heightPx: 20 };
  const parent = { xPx: 0, yPx: 0, widthPx: 600, heightPx: 400 };
  const sibling = { xPx: 100, yPx: 0, widthPx: 100, heightPx: 30 };
  const result = snap.snapMove(moving, [parent, sibling], 6);
  assert.equal(result.dxPx, -3, 'left edges line up');
  assert.equal(result.dyPx, 0, 'nothing within reach vertically: 50 is 20 from the sibling bottom');
  assert.ok(result.guides.some((guide) => guide.axis === 'x' && guide.positionPx === 100));
  assert.ok(result.gaps.some((gap) => gap.axis === 'y' && gap.distancePx === 20));
  assert.equal(snap.nearestShift([10], [30], 6), undefined, 'out of reach');
  assert.throws(() => snap.nearestShift([0], [0], -1), /never negative/);
  assert.deepEqual(snap.resizeBox({ xPx: 0, yPx: 0, widthPx: 100, heightPx: 50 }, 'se', 20, 999, 'ratio'), { xPx: 0, yPx: 0, widthPx: 120, heightPx: 60 });
  assert.deepEqual(snap.resizeBox({ xPx: 10, yPx: 10, widthPx: 100, heightPx: 50 }, 'nw', 200, 200, 'free'), { xPx: 109, yPx: 59, widthPx: 1, heightPx: 1 });
});

test('a click picks at the selection level, a double click goes one in, Cmd goes deepest', () => {
  const document = documentOf(PAGE);
  // JSDOM lays nothing out: give every element a distinct box so no wrapper is passed through.
  let offset = 0;
  for (const element of document.querySelectorAll('*')) {
    const box = { left: offset, top: offset, width: 500 - offset, height: 500 - offset };
    offset += 3;
    element.getBoundingClientRect = () => box;
  }
  const heading = document.querySelector('h1');
  const main = document.querySelector('main');
  const section = document.querySelector('section');
  assert.equal(select.pickOnClick(heading, [], 'level'), main, 'nothing selected: the top level');
  assert.equal(select.pickOnClick(heading, [], 'deepest'), heading);
  assert.equal(select.pickOnDoubleClick(heading, [main]), section, 'one level in');
  assert.equal(select.pickOnClick(heading, [section], 'level'), section, 'inside the selection, the selection');
  assert.equal(select.pickOnClick(document.querySelector('p'), [heading], 'level'), document.querySelector('p'), 'a sibling of the selection');
  assert.equal(select.isSelectable(document.head), false);
  assert.equal(select.isSelectable(heading), true);
});

test('the undo history steps back and forth, drops a no-op, and stays within its bounds', () => {
  const kept = new history.DesignHistory();
  const state = (inner) => ({ attributes: [], inner });
  kept.push({ kind: 'frame', frame: 'f1', before: state('a'), after: state('a'), selectionBefore: undefined, selectionAfter: undefined });
  assert.equal(kept.canUndo(), false, 'a step that changed nothing is not kept');
  kept.push({ kind: 'frame', frame: 'f1', before: state('a'), after: state('b'), selectionBefore: undefined, selectionAfter: undefined });
  assert.equal(kept.undo().after.inner, 'b');
  assert.equal(kept.canRedo(), true);
  assert.equal(kept.redo().after.inner, 'b');
  for (let index = 0; index < 200; index += 1) {
    kept.push({
      kind: 'frame',
      frame: 'f1',
      before: state(String(index)),
      after: state(String(index + 1)),
      selectionBefore: undefined,
      selectionAfter: undefined,
    });
  }
  let steps = 0;
  while (kept.undo() !== undefined) {
    steps += 1;
  }
  assert.equal(steps, 120, 'the oldest steps were dropped at the entry bound');
  const document = documentOf('<body class="x"><p>one</p></body>');
  const body = history.bodyStateOf(document);
  document.body.innerHTML = '<p>two</p>';
  document.body.removeAttribute('class');
  history.restoreBodyState(document, body);
  assert.equal(document.body.innerHTML, '<p>one</p>');
  assert.equal(document.body.className, 'x');
});

test('a stored draft is parsed: a good one comes back, anything else reads as no draft', () => {
  const record = { id: 'f1', name: 'Home', widthPx: 1440, viewportHeightPx: 900, xPx: 0, yPx: 0 };
  const good = {
    savedAtMs: 1,
    baselines: [{ id: 'b1', html: '<p>', url: 'http://localhost/', instances: [], sources: [] }],
    frames: [{ record, baseline: 'b1', html: '<p>' }],
  };
  assert.equal(drafts.parseDraft(good).frames[0].record.name, 'Home');
  assert.equal(drafts.parseDraft(undefined), undefined);
  assert.equal(drafts.parseDraft({ ...good, frames: [] }), undefined, 'a draft with no frame');
  assert.equal(drafts.parseDraft({ ...good, frames: [{ ...good.frames[0], baseline: 'b2' }] }), undefined, 'a frame of a missing baseline');
  assert.equal(drafts.parseDraft({ ...good, frames: [{ ...good.frames[0], record: { ...record, id: '../x' } }] }), undefined, 'a forged frame id');
  assert.equal(drafts.parseDraft({ ...good, savedAtMs: Number.NaN }), undefined);
  assert.equal(drafts.draftKey({ projectPath: '/p', file: 'src/pages/index.astro', route: '/', title: 'Home' }), '/p\nsrc/pages/index.astro');
});

test('hand-off notes are one bounded line that says what the pictures are', () => {
  const line = handoff.noteLine('a\nb\u0000c ' + 'x'.repeat(600));
  assert.ok(line.length <= 500);
  assert.ok(!/\p{Cc}/u.test(line), 'no control characters');
  assert.ok(line.endsWith('…'));
  const note = handoff.overviewNote(
    { projectPath: '/p', file: 'src/pages/index.astro', route: '/', title: 'Home' },
    { id: 'f1', name: 'Home 2', widthPx: 768, viewportHeightPx: 900, xPx: 0, yPx: 0 },
    3,
    2,
  );
  assert.match(note, /Design mode mockup "Home 2" of src\/pages\/index\.astro \(route \/\), 768px wide/);
  assert.match(note, /nothing was saved/);
  assert.match(note, /3 changes, described with the close-ups that follow/);
});
