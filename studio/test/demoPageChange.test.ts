// Goal: the demo only shows what Astro would have shown. Plain edits become a plan and
// everything that needs a render is named as not shown, never approximated.
// Method: pairs of page sources, one change apart, including each thing that must be
// refused and each path that must follow a node that moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markupOf, NOT_SHOWN, planPageChange, settingsLockReason } from '../demo/pageChange';

const PAGE = `---
import Card from "../components/Card.astro";
const items = ["a"];
---
<main>
  <h1 class="title">Heading</h1>
  <p>Body</p>
  <div id="one">One</div>
  <div id="two">Two</div>
  <Card title="A">Slot text</Card>
  <ul>{items.map((item) => <li>{item}</li>)}</ul>
</main>
`;

const NO_TEMPLATES = { file: 'src/pages/index.astro', catalog: { templates: [], instances: {} } } as const;

function changed(from: string, to: string): string {
  assert.ok(PAGE.includes(from), `The fixture holds ${from}`);
  return PAGE.replace(from, to);
}

test('an unchanged page has an empty plan', () => {
  const plan = planPageChange(PAGE, PAGE);
  assert.deepEqual(plan.notShown, []);
  assert.deepEqual(plan.texts, []);
  assert.deepEqual(plan.placements, []);
});

test('a text edit names its owner and both values', () => {
  const plan = planPageChange(PAGE, changed('>Heading<', '>New heading<'));
  assert.deepEqual(plan.notShown, []);
  assert.equal(plan.texts.length, 1);
  assert.equal(plan.texts[0]?.before.trim(), 'Heading');
  assert.equal(plan.texts[0]?.after.trim(), 'New heading');
  assert.equal(plan.texts[0]?.owner, '0.0');
});

test('text inside a component slot is still literal text', () => {
  const plan = planPageChange(PAGE, changed('Slot text', 'Other text'));
  assert.deepEqual(plan.notShown, []);
  assert.equal(plan.texts[0]?.after.trim(), 'Other text');
});

test('a literal attribute edit is applied and a removal clears it', () => {
  const edited = planPageChange(PAGE, changed('class="title"', 'class="title big"'));
  assert.deepEqual(edited.attributes, [{ path: '0.0', name: 'class', value: 'title big' }]);
  const removed = planPageChange(PAGE, changed(' class="title"', ''));
  assert.deepEqual(removed.attributes, [{ path: '0.0', name: 'class', value: undefined }]);
});

test('deleting a node removes it and renumbers the siblings after it', () => {
  const plan = planPageChange(PAGE, changed('  <div id="one">One</div>\n', ''));
  assert.deepEqual(plan.notShown, []);
  assert.deepEqual(plan.removals, [{ kind: 'node', path: '0.2' }]);
  assert.ok(plan.paths.some(([from, to]) => from === '0.3' && to === '0.2'));
  assert.ok(plan.paths.some(([from, to]) => from === '0.5' && to === '0.4'));
});

test('swapping siblings moves one node, and both paths follow', () => {
  const swapped = PAGE.replace('<div id="one">One</div>\n  <div id="two">Two</div>', '<div id="two">Two</div>\n  <div id="one">One</div>');
  const plan = planPageChange(PAGE, swapped);
  assert.deepEqual(plan.notShown, []);
  assert.deepEqual(plan.removals, []);
  assert.equal(plan.placements.length, 1);
  assert.equal(plan.placements[0]?.node.kind, 'move');
  assert.ok(plan.paths.some(([from, to]) => from === '0.2' && to === '0.3'));
  assert.ok(plan.paths.some(([from, to]) => from === '0.3' && to === '0.2'));
});

test('a node moving to another parent stays one node', () => {
  const moved = PAGE.replace('  <div id="two">Two</div>\n', '').replace('<div id="one">One</div>', '<div id="one">One<div id="two">Two</div></div>');
  const plan = planPageChange(PAGE, moved);
  assert.deepEqual(plan.notShown, []);
  assert.equal(plan.placements.filter((placement) => placement.node.kind === 'move').length, 1);
  assert.deepEqual(plan.removals, []);
});

test('a new plain element is built from its source', () => {
  const plan = planPageChange(PAGE, changed('<p>Body</p>', '<p>Body</p>\n  <aside class="note">New</aside>'));
  assert.deepEqual(plan.notShown, []);
  const created = plan.placements[0]?.node;
  assert.equal(created?.kind, 'create');
  assert.deepEqual(created?.kind === 'create' ? created.created : undefined, {
    kind: 'element',
    tag: 'aside',
    path: '0.2',
    attributes: [['class', 'note']],
    children: [{ kind: 'text', value: 'New' }],
  });
});

test('each thing that needs Astro is named and not planned', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    [changed('const items = ["a"];', 'const items = ["b"];'), NOT_SHOWN.frontmatter, 'frontmatter'],
    [changed('title="A"', 'title="B"'), NOT_SHOWN.component, 'component property'],
    [changed('<p>Body</p>', '<p>{items.length}</p>'), NOT_SHOWN.dynamic, 'a new expression'],
    [changed('<li>{item}</li>', '<li>x{item}</li>'), NOT_SHOWN.dynamic, 'a loop body'],
    [changed('<p>Body</p>', '<p>Body</p>\n  <Card title="B" />'), NOT_SHOWN.newComponent, 'a new component'],
    [changed('<p>Body</p>', '<p class={items[0]}>Body</p>'), NOT_SHOWN.dynamic, 'an expression attribute'],
    [changed('<p>Body</p>', '<p>Body</p>\n  <script>console.log(1)</script>'), NOT_SHOWN.script, 'a new script'],
  ];
  for (const [source, reason, name] of cases) {
    assert.deepEqual(planPageChange(PAGE, source, NO_TEMPLATES).notShown, [reason], name);
  }
});

test('without the catalog a component edit is left to the rendering, not refused', () => {
  const plan = planPageChange(PAGE, changed('title="A"', 'title="B"'));
  assert.deepEqual(plan.notShown, []);
  assert.deepEqual(
    plan.components.map((edit) => [edit.path, edit.file, edit.attrs['title']]),
    [['0.4', undefined, { type: 'string', value: 'B' }]],
    'The rendering learns which file from its own context',
  );
  const placed = planPageChange(PAGE, changed('title="A"', 'title="B"'), { file: 'src/pages/index.astro', catalog: { templates: [], instances: {} } });
  assert.deepEqual(placed.components, [], 'With an empty catalog the edit is refused instead');
});

test('source that does not parse keeps the last good page', () => {
  const plan = planPageChange(PAGE, PAGE.replace('</main>', '</main></div'));
  assert.deepEqual(plan.notShown, [NOT_SHOWN.syntax]);
  assert.deepEqual(plan.placements, []);
});

test('style block edits are not a page change', () => {
  const page = `${PAGE}<style>.a { color: red; }</style>\n`;
  assert.deepEqual(planPageChange(page, page.replace('red', 'blue')).notShown, []);
});

test('the settings lock follows what the selection is', () => {
  assert.equal(settingsLockReason(PAGE, 'frontmatter'), NOT_SHOWN.frontmatter);
  assert.equal(settingsLockReason(PAGE, 'n0.0'), undefined, 'A plain element stays editable');
  assert.equal(
    settingsLockReason(PAGE, 'n0.4', NO_TEMPLATES),
    undefined,
    'A component is never locked, even with no template: its edits save, and the canvas says what it cannot show',
  );
  assert.equal(settingsLockReason(PAGE, 'n0.4'), undefined, 'Without the catalog the rendering decides');
  assert.equal(settingsLockReason(PAGE, 'n0.5.0.0'), undefined, 'Bound text inside a loop over a literal reads as its chip');
  assert.equal(settingsLockReason(PAGE.replace('<li>{item}</li>', '<li>{item.at(0)}</li>'), 'n0.5.0.0'), NOT_SHOWN.dynamic, 'Code inside a loop');
  assert.equal(settingsLockReason(PAGE, 'n9'), undefined, 'A stale selection locks nothing');
});

test('a component compares by markup, so its styles can still change', () => {
  const component = '<div>Hi</div>\n<style>.a { color: red; }</style>\n';
  assert.equal(markupOf(component), markupOf(component.replace('red', 'blue')));
  assert.notEqual(markupOf(component), markupOf(component.replace('Hi', 'Bye')));
});

test('an insertion that adds a component import is not a frontmatter change', () => {
  const inserted = changed(
    'import Card from "../components/Card.astro";',
    'import Card from "../components/Card.astro";\nimport Badge from "../components/Badge.astro";',
  ).replace('<p>Body</p>', '<p>Body</p>\n  <Badge />');
  const plan = planPageChange(PAGE, inserted, NO_TEMPLATES);
  assert.deepEqual(plan.notShown, [NOT_SHOWN.newComponent], 'Only the missing template is named, not the frontmatter');
  const code = changed('const items = ["a"];', 'const items = ["a"];\nimport Badge from "../components/Badge.astro"; console.log(1);');
  assert.deepEqual(planPageChange(PAGE, code).notShown, [NOT_SHOWN.frontmatter], 'Anything more than an import still is');
});
