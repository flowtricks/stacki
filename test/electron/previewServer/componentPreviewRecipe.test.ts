// Goal: a component preview (the Components panel's hover card and the insert palette's cards, which
// load the same route) shows what inserting the component produces. Where `.stacki/components.json`
// gives the component a recipe, its props, text and nested children are what the route renders; where
// it gives none, or the file is missing, broken or names something that does not resolve, the preview
// keeps its own inputs (prop defaults and the first instance's sample).
//
// Method: build a small project on disk (a card with a named slot, a button, a section used on a page),
// write recipes beside it, and call the real Vite plugin's `load` for the props module the route
// imports, with a fake plugin context that records watched files. The recipe node component the route
// renders with is checked for its fixed slot positions. Without a recipe, a page instance's children
// (components, slotted fragments, expressions) are read into the same nodes, and a component's
// design-mode `preview` switch and a missing `id` are supplied so it shows what it holds; rendering it is exercised against Astro itself
// by hand, not here, because the suite does not run an Astro server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { componentPreviewPlugin, renderComponentPreviewPage, renderComponentPreviewRecipe } from '#dist/electron/previewServer/componentPreview.js';
import {
  componentPreviewRecipe,
  instanceMarkupNodes,
  PREVIEW_EXPRESSION_TEXT,
  recipeFiles,
  RECIPE_LIMITS,
} from '#dist/electron/previewServer/componentPreviewRecipe.js';
import { componentPreviewInputs } from '#dist/electron/previewServer/componentPreview.js';
import { parseComponentDefaults } from '#dist/shared/properties/componentDefaults.js';

const card = `---
interface Props { title?: string; tone?: 'light' | 'dark'; }
const { title = 'Card', tone = 'light' } = Astro.props;
---
<div class:list={['card', tone]}><h2>{title}</h2><header><slot name="head" /></header><slot /></div>`;

const button = `---
interface Props { label?: string; }
const { label = 'Button' } = Astro.props;
---
<button>{label}<slot /></button>`;

const section = `---
---
<section><slot /></section>`;

const page = `---
import Section from '../components/Section.astro';
---
<Section>From the page</Section>`;

function project(context: { readonly after: (callback: () => void) => void }, recipes?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-recipe-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'src/components/Card.astro': card,
    'src/components/Button.astro': button,
    'src/components/Section.astro': section,
    'src/pages/index.astro': page,
  };
  if (recipes !== undefined) {
    files['.stacki/components.json'] = recipes;
  }
  for (const [relative, source] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), source);
  }
  return root;
}

function watcher() {
  const watched: string[] = [];
  return {
    watched,
    addWatchFile: (file: string) => {
      watched.push(file);
    },
  };
}

function inputs(root: string, component: string, context = watcher()): unknown {
  const plugin = componentPreviewPlugin([root]);
  const loaded = plugin.load.call(context, path.join(root, component) + '?raw&stacki-preview-props');
  assert.ok(loaded !== undefined, 'the props module loads');
  const prefix = 'export default ';
  assert.ok(loaded.startsWith(prefix));
  const parsed: unknown = JSON.parse(loaded.slice(prefix.length, -1));
  return parsed;
}

const cardRecipe = JSON.stringify({
  version: 1,
  components: {
    'src/components/Card.astro': {
      props: { title: 'Plan your visit', tone: 'dark' },
      children: [
        { literal: 'Sunday at 10' },
        { element: 'span', props: { slot: 'head' }, text: 'This week' },
        { component: 'src/components/Button.astro', props: { label: 'Go' } },
      ],
    },
    'src/components/Button.astro': { props: { label: 'Join us' } },
  },
});

test('a recipe supplies the props and the nested children, grouped by the slot each one fills', (context) => {
  const root = project(context, cardRecipe);
  const recorded = watcher();
  assert.deepEqual(inputs(root, 'src/components/Card.astro', recorded), {
    props: { title: 'Plan your visit', tone: 'dark' },
    missing: [],
    slot: {
      kind: 'recipe',
      node: {
        component: 'src/components/Card.astro',
        props: { title: 'Plan your visit', tone: 'dark' },
        content: {
          kind: 'children',
          children: [
            {
              name: 'default',
              children: [{ literal: 'Sunday at 10' }, { component: 'src/components/Button.astro', props: { label: 'Go' }, content: { kind: 'empty' } }],
            },
            { name: 'head', children: [{ element: 'span', props: { slot: 'head' }, content: { kind: 'text', text: 'This week' } }] },
          ],
        },
      },
      files: ['src/components/Card.astro', 'src/components/Button.astro'],
    },
  });
  assert.deepEqual(
    recorded.watched,
    [path.join(root, '.stacki/components.json'), path.join(root, 'src/components/Button.astro')],
    'saving the recipe, or editing a component it nests, reloads the preview',
  );
});

test('a props-only recipe keeps the component empty, and a text recipe fills the default slot escaped', (context) => {
  const root = project(
    context,
    JSON.stringify({
      version: 1,
      components: {
        'src/components/Button.astro': { props: { label: 'Join us' } },
        'src/components/Section.astro': { text: 'Fish & <chips>' },
      },
    }),
  );
  assert.deepEqual(inputs(root, 'src/components/Button.astro'), { props: { label: 'Join us' }, missing: [], slot: { kind: 'none' } });
  assert.deepEqual(inputs(root, 'src/components/Section.astro'), {
    props: {},
    missing: [],
    slot: { kind: 'html', html: 'Fish &amp; &lt;chips&gt;' },
  });
});

test('a recipe wins over the first instance on the site', (context) => {
  const root = project(context, JSON.stringify({ version: 1, components: { 'src/components/Section.astro': { text: 'From the recipe' } } }));
  const loaded = inputs(root, 'src/components/Section.astro');
  assert.deepEqual(loaded, { props: {}, missing: [], slot: { kind: 'html', html: 'From the recipe' } });
});

test('without a usable recipe the preview keeps its own inputs', (context) => {
  // No file: the page's instance supplies the slot, as before recipes.
  const plain = project(context);
  assert.deepEqual(inputs(plain, 'src/components/Section.astro'), { props: {}, missing: [], slot: { kind: 'html', html: 'From the page' } });
  assert.deepEqual(inputs(plain, 'src/components/Card.astro'), { props: {}, missing: [], slot: { kind: 'name' } });
  // A file that does not parse, a recipe for another component, and one naming a missing component.
  for (const recipes of [
    '{ not json',
    JSON.stringify({ version: 2, components: {} }),
    JSON.stringify({ version: 1, components: { 'src/components/Button.astro': { props: { label: 'Other' } } } }),
    JSON.stringify({ version: 1, components: { 'src/components/Card.astro': { children: [{ component: 'src/components/Gone.astro' }] } } }),
    JSON.stringify({ version: 1, components: { 'src/components/Card.astro': { children: [{ element: 'p', props: { slot: 'nowhere' } }] } } }),
  ]) {
    const root = project(context, recipes);
    assert.deepEqual(inputs(root, 'src/components/Card.astro'), { props: {}, missing: [], slot: { kind: 'name' } }, recipes);
  }
});

test('children that fill more slots than the route has positions leave the recipe out', (context) => {
  const slots = Array.from({ length: RECIPE_LIMITS.slotsMax + 1 }, (_, index) => `s${index}`);
  const wide = `---\n---\n<div>${slots.map((name) => `<slot name="${name}" />`).join('')}<slot /></div>`;
  const root = project(
    context,
    JSON.stringify({
      version: 1,
      components: { 'src/components/Wide.astro': { children: slots.map((name) => ({ element: 'i', props: { slot: name } })) } },
    }),
  );
  fs.writeFileSync(path.join(root, 'src/components/Wide.astro'), wide);
  const config = parseComponentDefaults(JSON.parse(fs.readFileSync(path.join(root, '.stacki/components.json'), 'utf8')));
  assert.equal(componentPreviewRecipe(root, 'src/components/Wide.astro', config), undefined);
  const fits = parseComponentDefaults({
    version: 1,
    components: { 'src/components/Wide.astro': { children: slots.slice(0, RECIPE_LIMITS.slotsMax).map((name) => ({ element: 'i', props: { slot: name } })) } },
  });
  assert.equal(componentPreviewRecipe(root, 'src/components/Wide.astro', fits)?.node.content.kind, 'children');
});

test('recipe files list each nested component once, in first-use order', () => {
  const button = { component: 'src/components/Button.astro', props: {}, content: { kind: 'empty' as const } };
  const files = recipeFiles({
    component: 'src/components/Card.astro',
    props: {},
    content: {
      kind: 'children',
      children: [button, { element: 'div', props: {}, content: { kind: 'children', children: [button, { literal: 'x' }] } }],
    },
  });
  assert.deepEqual(files, ['src/components/Button.astro']);
});

test('the route renders a recipe through the node component, which has one position per slot', () => {
  const page = renderComponentPreviewPage();
  assert.match(page, /import RecipeNode from '\.\/stacki-preview-recipe\.astro';/);
  assert.match(page, /slot\.kind === 'recipe' \? <RecipeNode node=\{slot\.node\} modules=\{recipeModules\} \/>/);
  const node = renderComponentPreviewRecipe();
  assert.equal(node.includes('__STACKI_SLOT_POSITIONS__'), false);
  for (let index = 0; index < RECIPE_LIMITS.slotsMax; index++) {
    assert.ok(node.includes(`<Fragment slot={slotName(${index})}>`), `slot position ${index}`);
  }
  assert.equal(node.includes(`slotName(${RECIPE_LIMITS.slotsMax})`), false);
});

const imports = [
  { name: 'TabLink', relative: 'src/components/TabLink.astro' },
  { name: 'Paragraph', relative: 'src/components/Paragraph.astro' },
];

test('an instance body becomes nodes: components, slotted fragments, elements and expressions', () => {
  const nodes = instanceMarkupNodes(
    `
    <Fragment slot="links">
      <TabLink>One</TabLink>
      <TabLink>Two</TabLink>
    </Fragment>
    <!-- a note -->
    <div class="panel" data-x={1}><Paragraph maxWidth={36} text={copy}>{text}</Paragraph><img src="/a.png" alt="" /></div>
    {items.map((item) => <p>{item}</p>)}
    `,
    imports,
  );
  assert.deepEqual(nodes, [
    { component: 'src/components/TabLink.astro', props: { slot: 'links' }, content: { kind: 'children', children: [{ literal: 'One' }] } },
    { component: 'src/components/TabLink.astro', props: { slot: 'links' }, content: { kind: 'children', children: [{ literal: 'Two' }] } },
    {
      element: 'div',
      props: { class: 'panel', 'data-x': 1 },
      content: {
        kind: 'children',
        children: [
          {
            component: 'src/components/Paragraph.astro',
            props: { maxWidth: 36 },
            content: { kind: 'children', children: [{ literal: PREVIEW_EXPRESSION_TEXT }] },
          },
          { element: 'img', props: { src: '/a.png', alt: '' }, content: { kind: 'empty' } },
        ],
      },
    },
  ]);
});

test('negative space: an instance body that cannot be read leaves the placeholder', () => {
  for (const markup of [
    '<Unknown />',
    '<div><p>open</div>',
    '<p>unclosed',
    '</p>',
    '<script>run()</script>',
    '<p>{unclosed</p>',
    '<!-- never closed',
    'x'.repeat(64 * 1024 + 1),
    '<div>'.repeat(20) + '</div>'.repeat(20),
  ]) {
    assert.equal(instanceMarkupNodes(markup, imports), undefined, markup.slice(0, 40));
  }
  assert.deepEqual(instanceMarkupNodes('  \n ', imports), [], 'whitespace is no content');
});

test('without a recipe, the first instance on a page renders with its nested components', (context) => {
  const root = project(context);
  fs.writeFileSync(
    path.join(root, 'src/pages/index.astro'),
    `---\nimport Card from '../components/Card.astro';\nimport Button from '../components/Button.astro';\n---\n<Card title="From the page"><span slot="head">Top</span><Button label="Go" /></Card>`,
  );
  const loaded = inputs(root, 'src/components/Card.astro');
  assert.deepEqual(loaded, {
    props: { title: 'From the page' },
    missing: [],
    slot: {
      kind: 'recipe',
      node: {
        component: 'src/components/Card.astro',
        props: { title: 'From the page' },
        content: {
          kind: 'children',
          children: [
            { name: 'head', children: [{ element: 'span', props: { slot: 'head' }, content: { kind: 'children', children: [{ literal: 'Top' }] } }] },
            { name: 'default', children: [{ component: 'src/components/Button.astro', props: { label: 'Go' }, content: { kind: 'empty' } }] },
          ],
        },
      },
      files: ['src/components/Card.astro', 'src/components/Button.astro'],
    },
  });
});

test('a design-mode preview switch is turned on, and a missing id is supplied', () => {
  const modal = `---
interface Props { id?: string; label?: string; preview?: boolean; open?: boolean; }
const { id, label, preview = false } = Astro.props;
---
<dialog id={id}><slot /></dialog>`;
  assert.deepEqual(componentPreviewInputs(modal, 'Modal').props, { id: 'stacki-preview-Modal', label: 'Modal', preview: true });
  const other = `---
interface Props { preview?: string; id?: string; }
const { preview = 'x', id = 'given' } = Astro.props;
---
<div />`;
  assert.deepEqual(componentPreviewInputs(other, 'Other').props, {}, "a preview prop that is not a boolean, and an id with a default, are the author's");
});
