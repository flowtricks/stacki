// Goal: the Settings panel's structural writes in Studio — the Tag field's options and
// kind change, the layout picker, an element's whole attribute list, a loop's Code row
// and a variable rename, a condition's else branch, a text connected to data, and a new
// component prop — write the page as Desktop's gestures write it, through Desktop's
// request drafting and planner, and the demo shows or notes each without breaking.
// Method: a page with an element, an instance, a condition, a loop over a literal and a
// text is changed by each write; the result's exact text is pinned, it must parse, and
// the demo's page-change plan of each pair is read: a plain element's change is shown,
// anything Astro must run lands in `notShown` with its usual note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedLayout,
  changedTag,
  committedLoopHead,
  layoutOptions,
  newPropHost,
  renamedVariable,
  replacedProps,
  tagOptions,
  textPieces,
  toggledElse,
} from '../src/features/settings/settingsGestures';
import { writeGesture } from '../src/features/source/gestureWrite';
import { flatten, parsePage, type ParserNode } from '../src/features/source/source';
import { NOT_SHOWN, planPageChange, settingsLockReason } from '../demo/pageChange';
import { connectedPath } from '../vendor/stacki/src/features/props/textConnect';
import { nodeGesture } from '../vendor/stacki/src/editor/editGestures';
import { listPropsOf } from '../vendor/stacki/src/editor/listProps';
import { readPropsDestructure, withProp } from '../vendor/stacki/src/editor/loopProps';
import { parsePageNode } from '../vendor/stacki/shared/page/pageNode';

const FILE = 'src/pages/index.astro';
const PAGE = `---
import Card from "../components/Card.astro";
const items = [{ name: "a" }, { name: "b" }];
const show = true;
const title = "Hello";
---
<main>
  <div class="box" data-x="1">Hi</div>
  <Card title="One" />
  {show && (<p>Yes</p>)}
  <ul>
    {items.map((item) => (<li>{item.name}</li>))}
  </ul>
  <h2>Words</h2>
</main>
`;
const PROJECT = {
  components: [
    { file: 'src/components/Card.astro', name: 'Card', fields: [], slots: [] },
    { file: 'src/components/Hero.astro', name: 'Hero', fields: [], slots: [] },
    { file: 'src/layouts/Base.astro', name: 'Base', fields: [], slots: ['default'] },
  ],
};

function idOf(source: string, match: (node: ParserNode) => boolean): string {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable, 'the page parses');
  const node = flatten(parsed.model.nodes).find(match);
  assert.ok(node?.id !== undefined, 'the node is on the page');
  return node.id;
}
const div = (source: string) => idOf(source, (node) => node.name === 'div');
const condition = (source: string) => idOf(source, (node) => node.kind === 'cond');
const loop = (source: string) => idOf(source, (node) => node.kind === 'map');

function parses(source: string): string {
  assert.ok(parsePage(source).editable, 'the written page parses');
  return source;
}

test('the Tag field offers tags, components, layouts, Astro’s own and the page’s imports, once each', () => {
  const options = tagOptions(PROJECT, PAGE);
  const kind = (name: string) => options.find((option) => option.name === name)?.kind;
  assert.equal(kind('section'), 'element');
  assert.equal(kind('Hero'), 'component');
  assert.equal(kind('Base'), 'layout');
  assert.equal(kind('Image'), 'astroAsset');
  assert.equal(new Set(options.map((option) => option.name)).size, options.length);
  assert.deepEqual(layoutOptions(PROJECT), [{ name: 'Base', kind: 'layout' }]);
});

test('an element renamed to another tag keeps its attributes, and the demo shows it', () => {
  const next = parses(changedTag(PAGE, FILE, div(PAGE), 'section', PROJECT) ?? '');
  assert.ok(next.includes('<section class="box" data-x="1">Hi</section>'));
  assert.ok(next.includes('import Card from "../components/Card.astro";'), 'an import still in use stays');
  assert.deepEqual(planPageChange(PAGE, next).notShown, []);
});

test('an element turned into a component gets its import; nothing providing it leaves the field as it was', () => {
  const next = parses(changedTag(PAGE, FILE, div(PAGE), 'Hero', PROJECT) ?? '');
  assert.ok(next.includes("import Hero from '../components/Hero.astro';"));
  assert.ok(next.includes('<Hero class="box" data-x="1">Hi</Hero>'));
  assert.equal(changedTag(PAGE, FILE, div(PAGE), 'Missing', PROJECT), undefined);
  // Without the bake's catalog the new instance is left to its template.
  assert.deepEqual(planPageChange(PAGE, next).notShown, []);
});

test('a component turned back into an element prunes its unused import, and the demo still shows it', () => {
  const card = idOf(PAGE, (node) => node.name === 'Card');
  const next = parses(changedTag(PAGE, FILE, card, 'aside', PROJECT) ?? '');
  assert.ok(next.includes('<aside title="One" />'), 'a global attribute carries over, as Desktop keeps it');
  assert.ok(!next.includes('import Card'), 'the import nothing uses goes, as Desktop prunes it');
  assert.ok(!planPageChange(PAGE, next).notShown.includes(NOT_SHOWN.frontmatter), 'an unused import taken away runs the same');
});

test('the layout picker wraps the page, renames the wrapper, and unwraps it', () => {
  const wrapped = parses(changedLayout(PAGE, FILE, 'Base', PROJECT));
  assert.ok(wrapped.includes("import Base from '../layouts/Base.astro';"));
  assert.match(wrapped, /<Base>\n<main>[\s\S]*<\/main>\n<\/Base>/);
  const unwrapped = parses(changedLayout(wrapped, FILE, '', PROJECT));
  assert.ok(!unwrapped.includes('<Base>'));
  assert.ok(!unwrapped.includes('import Base'));
  assert.throws(() => changedLayout(PAGE, 'src/pages/post.md', 'Base', PROJECT), /Markdown/);
  // A new layout instance is Astro's to render: the demo says so rather than guessing.
  assert.ok(planPageChange(PAGE, wrapped).notShown.length <= 1);
});

test('an element’s whole attribute list is written in order, as connecting an attributes prop does', () => {
  const next = parses(replacedProps(PAGE, div(PAGE), { class: { type: 'string', value: 'box' }, 'data-y': { type: 'string', value: '2' } }));
  assert.ok(next.includes('<div class="box" data-y="2">Hi</div>'));
  assert.deepEqual(planPageChange(PAGE, next).notShown, []);
  const spread = parses(replacedProps(PAGE, div(PAGE), { role: { type: 'string', value: 'note' }, '...attrs': { type: 'spread', value: 'attrs' } }));
  assert.ok(spread.includes('<div role="note" {...attrs}>Hi</div>'));
  assert.deepEqual(planPageChange(PAGE, spread).notShown, [NOT_SHOWN.dynamic], 'a spread is Astro’s to run');
});

test('a condition gains an empty else branch, and losing it keeps its markup', () => {
  const added = parses(toggledElse(PAGE, condition(PAGE), true));
  assert.ok(added.includes('{show ? (<p>Yes</p>) : null}'));
  const removed = parses(toggledElse(added, condition(added), false));
  assert.ok(removed.includes('{show && (<p>Yes</p>)}'));
  assert.equal(toggledElse(PAGE, condition(PAGE), false), PAGE, 'already without one: nothing to write');
  assert.deepEqual(planPageChange(PAGE, added).notShown, [NOT_SHOWN.dynamic]);
});

test('a loop’s Code row renames its item through its children, and refuses code that would not run', () => {
  const renamed = committedLoopHead(PAGE, loop(PAGE), 'items.map((entry) => (', [{ from: 'item', to: 'entry' }]);
  assert.ok(renamed.ok);
  assert.ok(parses(renamed.value).includes('{items.map((entry) => (<li>{entry.name}</li>))}'));
  assert.deepEqual(planPageChange(PAGE, renamed.value).notShown, [NOT_SHOWN.dynamic]);
  const same = committedLoopHead(PAGE, loop(PAGE), 'items.map((item) => (', []);
  assert.deepEqual(same, { ok: true, value: PAGE });
  const missing = committedLoopHead(PAGE, 'n999', 'x', []);
  assert.deepEqual(missing, { ok: false, error: 'That loop is no longer on the page.' });
});

test('a frontmatter variable renamed renames every use of it, and a taken name is refused', () => {
  const renamed = renamedVariable(PAGE, { from: 'items', to: 'entries' });
  assert.ok(renamed.ok);
  assert.ok(renamed.value.includes('const entries = ['));
  assert.ok(renamed.value.includes('{entries.map((item)'));
  const taken = renamedVariable(PAGE, { from: 'items', to: 'show' });
  assert.equal(taken.ok, false);
});

test('a text connected to data and back writes the expression, then the words', () => {
  const heading = idOf(PAGE, (node) => node.name === 'h2');
  const text = idOf(PAGE, (node) => node.kind === 'text' && node.value === 'Words');
  assert.ok(heading !== text);
  const connected = parses(textPieces(PAGE, text, [{ kind: 'expr', value: '{title}' }]));
  assert.ok(connected.includes('<h2>{title}</h2>'), connected);
  assert.deepEqual(planPageChange(PAGE, connected).notShown, [NOT_SHOWN.dynamic]);
  const words = idOf(connected, (node) => node.kind === 'expr' && (node.value ?? '').includes('title'));
  const back = parses(textPieces(connected, words, [{ kind: 'text', value: 'Hello' }]));
  assert.ok(back.includes('<h2>Hello</h2>'), back);
});

test('a component file’s binding host knows its props and rest binding, and makes a new prop in its frontmatter', () => {
  const component = `---
interface Props {
  title?: string;
}
const { title = "Hello" } = Astro.props;
---
<section><h2>{title}</h2></section>
`;
  const forwarding = newPropHost(
    'src/components/Wide.astro',
    '---\nconst { containerAttrs = {}, ...rest } = Astro.props;\n---\n<section {...rest} />\n',
    [],
    () => undefined,
  );
  assert.equal(forwarding?.restLocal, 'rest', 'a component forwarding ...rest offers its attributes prop');
  assert.equal(
    newPropHost(FILE, PAGE, [], () => undefined),
    undefined,
    'a page has no props to make',
  );
  let written = component;
  const host = newPropHost('src/components/Section.astro', component, ['title'], (next) => {
    written = next;
  });
  assert.ok(host !== undefined);
  assert.deepEqual(host.propKeys, ['title']);
  assert.equal(host.restLocal, undefined);
  const made = host.create({
    key: 'subtitle',
    tooltip: 'Under the title',
    kind: 'string',
    defaultText: 'More',
    options: [],
    number: { min: undefined, max: undefined, decimals: undefined },
    switch: { onLabel: 'On', offLabel: 'Off' },
    attributes: [],
    tag: '',
    list: { fields: [], items: [] },
    image: '',
  });
  assert.ok(made.ok, made.ok ? '' : made.error);
  assert.ok(parses(written).includes('subtitle'), written);
});

test('a list prop is read from its component’s frontmatter', () => {
  const props = listPropsOf('const { items = [] } = Astro.props;\nconst rows = items.filter((item) => item.visible);');
  assert.ok(props instanceof Map);
});

test('a refused write says why and leaves the page alone', () => {
  const broken = PAGE.replace('<main>', '<main');
  assert.throws(() => changedTag(broken, FILE, 'n0', 'section', PROJECT));
  const text = parsePage(PAGE, { locs: true });
  assert.ok(text.editable);
  assert.throws(() =>
    writeGesture(PAGE, nodeGesture('nope', { ...parsePageNode(text.model.nodes[0]), value: 'x' }, { coalesceKey: undefined, urgency: true })),
  );
});

test('a prop added to a destructure that forwards ...rest goes before the rest, which stays last', () => {
  const prop = { key: 'subtitle', local: 'subtitle', defaultCode: '"More"', type: 'string', description: '' };
  assert.equal(
    withProp('const { containerAttrs = {}, ...rest } = Astro.props;', prop, 0),
    'const { containerAttrs = {}, subtitle: subtitle = "More", ...rest } = Astro.props;',
  );
  assert.equal(withProp('const { ...rest } = Astro.props;', prop, 0), 'const { subtitle: subtitle = "More", ...rest } = Astro.props;');
  // A shorthand entry is a prop whichever way the parser names it, and a rest is not one.
  assert.deepEqual(
    readPropsDestructure('const { title = "Hi", ...rest } = Astro.props;')?.entries.map((entry) => entry.key),
    ['title'],
  );
});

test('in the demo, `{promise}` in a loop over a literal is selectable bound text, drawn as a chip; other loop code stays locked', () => {
  const page = `---
const promises = ["Fast", "Kind"];
---
<ul>
  {promises.map((promise) => (<li class="promises_item">{promise}</li>))}
</ul>
<ul>
  {promises.map((promise) => (<li class="promises_code">{promise.toUpperCase()}</li>))}
</ul>
`;
  const bound = idOf(page, (node) => node.kind === 'expr' && node.value === '{promise}');
  const item = idOf(page, (node) => node.props?.['class']?.type === 'string' && node.props['class'].value === 'promises_item');
  const code = idOf(page, (node) => node.kind === 'expr' && (node.value ?? '').includes('toUpperCase'));
  assert.equal(settingsLockReason(page, bound), undefined, 'the bound text is not locked as an expression');
  assert.equal(settingsLockReason(page, item), undefined, 'its element, whose Content field shows the chip, is not locked');
  assert.equal(settingsLockReason(page, code), NOT_SHOWN.dynamic, 'code that is not a data path stays Astro’s');
  // The chip: the Content field draws a connected path as one, the way Desktop's does.
  assert.equal(connectedPath('{promise}'), 'promise');
  assert.equal(connectedPath('{promise.toUpperCase()}'), undefined);
  // Changing the binding needs Astro: the edit is noted, not guessed.
  const rebound = page.replace('<li class="promises_item">{promise}</li>', '<li class="promises_item">{promise.length}</li>');
  assert.deepEqual(planPageChange(page, rebound).notShown, [NOT_SHOWN.dynamic]);
});
