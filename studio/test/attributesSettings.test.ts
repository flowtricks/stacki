// Goal: Studio's Settings panel shows Desktop's Attributes section for a plain element
// and for an instance whose component forwards `...rest`, and its add, edit, rename and
// remove write the source as Desktop's planner writes it. The demo shows a plain
// element's attribute edits without Astro, and hands an instance's to its templates.
// Method: a Section component written the way the marketing site writes it
// (`containerAttrs = {}, ...rest`) is analysed as the project scan analyses it; the
// panel's rule is read for an element and for instances with and without a rest spread
// (the shared panel renders the section exactly when that rule holds: ElementAttributes
// in src/features/props/ElementFields.tsx, which a Node test cannot load for its CSS); then each write the section makes is applied to a page, its
// exact text pinned, and the demo's page-change plan of each pair read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComponentAnalysis } from '../src/features/project/componentAnalysis';
import { parseProject } from '../src/features/project/projectClient';
import { renameAttribute, takesAttributes, writeAttributes } from '../src/features/settings/attributeEdit';
import { flatten, parsePage, type ParserNode } from '../src/features/source/source';
import { parsePageNode } from '../vendor/stacki/shared/page/pageNode';
import { planPageChange } from '../demo/pageChange';

const SECTION = `---
const { containerAttrs = {}, ...rest } = Astro.props;
---
<section {...rest}><div {...containerAttrs}><slot /></div></section>
`;
const CARD = `---
const { title } = Astro.props;
---
<article>{title}</article>
`;
const PAGE = `---
import Section from "../components/Section.astro";
import Card from "../components/Card.astro";
---
<Section class="hero" data-hero-card="a">
  <h1 class="title">Hello</h1>
  <Card title="One" />
</Section>
`;

const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));

function nodeOf(source: string, match: (node: ParserNode) => boolean): ParserNode {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable);
  const node = flatten(parsed.model.nodes).find(match);
  assert.ok(node?.id !== undefined, 'the node is on the page');
  return node;
}
const heading = (source: string) => nodeOf(source, (node) => node.name === 'h1');
const section = (source: string) => nodeOf(source, (node) => node.name === 'Section');
const card = (source: string) => nodeOf(source, (node) => node.name === 'Card');
const idOf = (node: ParserNode) => node.id ?? '';
/** The panel's view of a tag: an element or an instance, which is what the layout reads. */
function tagOf(node: ParserNode) {
  const checked = parsePageNode(node);
  assert.ok(checked.kind === 'element' || checked.kind === 'component', 'a tag is an element or an instance');
  return checked;
}

function demoShows(before: string, after: string) {
  const plan = planPageChange(before, after);
  assert.deepEqual(plan.notShown, [], 'the demo shows the edit');
  return plan;
}

test('the scan reads whether a component forwards ...rest, and the project keeps it', async () => {
  const analysis = new ComponentAnalysis();
  const section = await analysis.read('src/components/Section.astro', SECTION, missing);
  const card = await analysis.read('src/components/Card.astro', CARD, missing);
  assert.equal(section.hasRest, true);
  assert.equal(card.hasRest, false);
  const project = parseProject({
    name: 'Site',
    pages: [],
    collections: [],
    assets: [],
    classes: [],
    components: [{ file: 'src/components/Section.astro', name: 'Section', ...section }],
  });
  assert.equal(project.components[0]?.hasRest, true);
  assert.throws(
    () =>
      parseProject({
        name: 'Site',
        pages: [],
        collections: [],
        assets: [],
        classes: [],
        components: [{ file: 'src/components/Section.astro', name: 'Section', fields: [], slots: [], hasRest: 'yes' }],
      }),
    /Invalid rest attributes flag/,
  );
});

test('Attributes shows for an element and a rest-forwarding instance, not for a closed one or frontmatter', () => {
  const element = tagOf(heading(PAGE));
  const instance = tagOf(section(PAGE));
  const closed = tagOf(card(PAGE));
  assert.equal(takesAttributes(element, undefined), true);
  assert.equal(takesAttributes(instance, { hasRest: true }), true);
  assert.equal(takesAttributes(closed, { hasRest: false }), false);
  assert.equal(takesAttributes(instance, undefined), false, 'an unknown component is not guessed open');
  assert.equal(takesAttributes({ kind: 'frontmatter' }, undefined), false);
  assert.equal(takesAttributes(undefined, undefined), false);
});

test('an element: add, edit, rename and remove write the source as Desktop does, and the demo shows each', () => {
  const id = idOf(heading(PAGE));
  // Add: the name first, bare, after the last attribute; then its value.
  const named = writeAttributes(PAGE, id, { 'data-x': { type: 'bare' } });
  assert.ok(named.includes('<h1 class="title" data-x>Hello</h1>'));
  demoShows(PAGE, named);
  const valued = writeAttributes(named, id, { 'data-x': { type: 'string', value: 'one' } });
  assert.ok(valued.includes('<h1 class="title" data-x="one">Hello</h1>'));
  demoShows(named, valued);
  // Edit: the value alone is replaced, in its quotes.
  const edited = writeAttributes(valued, id, { 'data-x': { type: 'string', value: 'two' } });
  assert.ok(edited.includes('<h1 class="title" data-x="two">Hello</h1>'));
  const shown = demoShows(valued, edited);
  assert.deepEqual(shown.attributes, [{ path: shown.attributes[0]?.path, name: 'data-x', value: 'two' }]);
  // Rename keeps the value and the place.
  const renamed = renameAttribute(edited, id, 'data-x', 'aria-label');
  assert.ok(renamed.includes('<h1 class="title" aria-label="two">Hello</h1>'));
  demoShows(edited, renamed);
  // Remove takes the space in front with it.
  const removed = writeAttributes(renamed, id, { 'aria-label': undefined });
  assert.equal(removed, PAGE);
  demoShows(renamed, removed);
});

test('pasting several pairs writes them in order as one change', () => {
  const id = idOf(heading(PAGE));
  const next = writeAttributes(PAGE, id, { id: { type: 'string', value: 'top' }, role: { type: 'string', value: 'banner' } });
  assert.ok(next.includes('<h1 class="title" id="top" role="banner">Hello</h1>'));
  demoShows(PAGE, next);
});

test('renaming onto a name the tag already has gives that name up first', () => {
  const page = PAGE.replace('<h1 class="title">', '<h1 class="title" id="a" title="b">');
  const next = renameAttribute(page, idOf(heading(page)), 'title', 'id');
  assert.ok(next.includes('<h1 class="title" id="b">Hello</h1>'));
});

test('an instance: add, edit and remove write its props in place', () => {
  const id = idOf(section(PAGE));
  const added = writeAttributes(PAGE, id, { id: { type: 'string', value: 'hero' } });
  assert.ok(added.includes('<Section class="hero" data-hero-card="a" id="hero">'));
  const plan = planPageChange(PAGE, added);
  assert.deepEqual(plan.notShown, [], 'without the bake catalog the instance is left to its template');
  assert.equal(plan.components.length, 1, 'the instance is re-rendered from its template, not patched');
  const edited = writeAttributes(added, idOf(section(added)), { 'data-hero-card': { type: 'string', value: 'b' } });
  assert.ok(edited.includes('<Section class="hero" data-hero-card="b" id="hero">'));
  const removed = writeAttributes(edited, idOf(section(edited)), { 'data-hero-card': undefined, id: undefined });
  assert.ok(removed.includes('<Section class="hero">'));
});

test('a spread is removed with the space in front of it; a new one is refused', () => {
  const page = PAGE.replace('<h1 class="title">', '<h1 class="title" {...extra}>');
  const id = idOf(heading(page));
  assert.equal(writeAttributes(page, id, { '...extra': undefined }), PAGE);
  assert.throws(() => writeAttributes(page, id, { '...more': { type: 'spread', value: 'more' } }), /Add a spread in Code/);
});

test('a write the planner refuses says why and leaves the page alone', () => {
  const page = PAGE.replace('<h1 class="title">', '<h1 class="title" class="other">');
  assert.throws(() => writeAttributes(page, idOf(heading(page)), { class: { type: 'string', value: 'x' } }), /written more than once/);
  assert.throws(() => writeAttributes(PAGE, 'missing', { id: { type: 'string', value: 'x' } }), /Selection changed/);
});
