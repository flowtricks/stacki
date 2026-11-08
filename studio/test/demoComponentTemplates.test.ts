// Goal: a component prop edit renders without Astro only where the bake's probes prove
// how the prop reaches the output. A string or number that is copied into text or an
// attribute becomes a hole; every combination of booleans and choices the component's
// types allow is a pre-rendered state, each with one text prop or slot moved, so a
// variant and the props only it shows render together, fallbacks included. A prop
// that is transformed or measured, two text moves at once, a combination the types
// forbid, a prop written as code and an attribute nothing models all refuse, never guess.
// Method: probe outputs are written by hand as Astro would render a small component,
// built into templates by the bake's own code, and rendered by the demo's own code;
// the string re-render then runs on a page fragment shaped like a baked page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Attr } from '../vendor/stacki/shared/page/pageNodeTypes';
import {
  buildTemplate,
  dependsOnPage,
  extractProbes,
  onceGuard,
  pageInstances,
  planProbes,
  probeSpec,
  sentinel,
  specStates,
  requiredProps,
  stateShares,
  type ProbeSpec,
} from '../src/features/bake/bakeProbes';
import {
  attrValue,
  differenceChars,
  escapeHTML,
  joinOutput,
  parseComponentCatalog,
  PATH_SENTINEL,
  renderTemplate,
  entryInstancesKey,
  slotMarker,
  stateDifference,
  stateHTML,
  TEMPLATE_LIMITS,
  type ComponentTemplate,
  type Literal,
} from '../src/features/bake/componentTemplates';
import { canRenderUse, liftSlots, pageOnce, renderEditsInText, renderUse, restorePageOnce } from '../demo/componentRender';

const FILE = 'src/components/Badge.astro';
const FIELDS = [
  { name: 'label', type: 'string' },
  { name: 'tone', type: 'enum', options: ['info', 'warn'] },
  { name: 'outlined', type: 'boolean' },
  { name: 'slug', type: 'string' },
  { name: 'count', type: 'number' },
] as const;

const str = (value: string): Attr => ({ type: 'string', value });

/** How the hand-written Badge renders: label into text and an attribute, tone and
 * outlined into classes, slug transformed (lower-cased), and a default slot. */
function badge(props: Readonly<Record<string, Literal | undefined>>, slot: string): string {
  const label = props['label'];
  const tone = props['tone'] ?? 'info';
  const outlined = props['outlined'] === true ? ' outlined' : '';
  const slug = typeof props['slug'] === 'string' ? ` id="${props['slug'].toLowerCase()}"` : '';
  // A number read by logic: one is the default and writes nothing.
  const count = typeof props['count'] === 'number' && props['count'] !== 1 ? ` data-count="${props['count']}"` : '';
  // The props a component spreads onto its root, `slot` among them.
  const slotted = typeof props['slot'] === 'string' ? ` slot="${props['slot']}"` : '';
  const heading = typeof label === 'string' && label !== '' ? `<b title="${escapeHTML(label)}">${escapeHTML(label)}</b>` : '';
  return `<span${slotted} class="badge ${String(tone)}${outlined}" data-avb-p="${FILE}|0 ${PATH_SENTINEL}"${slug}${count}>${heading}${slot}</span>`;
}

function specFor(attrs: Readonly<Record<string, Attr>>): ProbeSpec {
  return probeSpec({
    file: FILE,
    name: 'Badge',
    node: { props: attrs },
    slots: ['default'],
    fields: FIELDS,
    stamp: undefined,
    instance: { page: 'src/pages/index.astro', path: '0.1' },
  });
}

/** Renders every probe the way the build would, and builds the template from them. */
function templateFor(attrs: Readonly<Record<string, Attr>>): ComponentTemplate {
  const spec = specFor(attrs);
  const plan = planProbes(new Map([['src/pages/index.astro', [spec]]]));
  return templateFrom(spec, plan, badge);
}

type Renderer = (props: Readonly<Record<string, Literal | undefined>>, slot: string) => string;

/** Renders every probe of `plan` with `component`, as the build would, and builds the template. */
function templateFrom(spec: ProbeSpec, plan: ReturnType<typeof planProbes>, component: Renderer): ComponentTemplate {
  const page = plan.pages.get('src/pages/index.astro');
  const states = plan.states[0];
  assert.ok(page);
  assert.ok(states);
  const outputs = new Map<string, [string | undefined, string | undefined]>();
  for (const render of page.renders) {
    const props: Record<string, Literal | undefined> = {};
    for (const [name, attr] of Object.entries(spec.attrs).filter(([name]) => !name.startsWith('...'))) {
      const value = attrValue(attr);
      props[name] = value.kind === 'literal' ? value.value : undefined;
    }
    let filled = spec.slots;
    if (render.target.kind === 'state') {
      const state = states[render.target.index];
      for (const [name, value] of state?.overrides ?? []) {
        props[name] = value.kind === 'literal' ? value.value : undefined;
      }
      filled = state?.slots ?? filled;
    }
    for (const [name, value] of render.sentinels) {
      props[name] = value;
    }
    const key = render.target.kind === 'state' ? `state:${render.target.index}` : render.target.kind === 'single' ? `single:${render.target.prop}` : 'actual';
    const pair = outputs.get(key) ?? [undefined, undefined];
    pair[render.run] = component(props, filled.includes('default') ? slotMarker('default') : '');
    outputs.set(key, pair);
  }
  const template = buildTemplate(spec, states, outputs, page.renders);
  assert.ok(template, 'The base renders');
  return template;
}

function render(template: ComponentTemplate, attrs: Readonly<Record<string, Attr>>): string | undefined {
  const result = renderTemplate(template, attrs, ['default'], '0.1');
  return result.ok ? joinOutput(result.output, () => 'SLOT') : undefined;
}

const BASE = { label: str('Hello'), tone: str('info') };

test('a string copied into text and an attribute is a hole, escaped as Astro escapes', () => {
  const template = templateFor(BASE);
  assert.equal(render(template, BASE), badge({ label: 'Hello', tone: 'info' }, 'SLOT').replace(PATH_SENTINEL, '0.1'), 'The base reproduces the build');
  assert.equal(
    render(template, { ...BASE, label: str('A & <b>"q"</b>') }),
    badge({ label: 'A & <b>"q"</b>', tone: 'info' }, 'SLOT').replace(PATH_SENTINEL, '0.1'),
  );
});

test('the base state points at the base instead of storing its HTML a second time', () => {
  const template = templateFor(BASE);
  const base = template.base;
  const state = template.states[0];
  assert.ok(base !== undefined, 'The base renders');
  assert.ok(state !== undefined, 'The base is the first state');
  const output = template.outputs[state.output];
  assert.ok(output !== undefined, 'The base state names an output');
  assert.equal(differenceChars(output), 0, 'The base state stores no HTML of its own');
  assert.equal(stateHTML(template, output), base, 'The base state still renders the base');
  // Pair with the reader: the snapshot's parser accepts it and renders the same base.
  const parsed = parseComponentCatalog(JSON.parse(JSON.stringify({ templates: [template], instances: {} })));
  const [read] = parsed.templates;
  assert.ok(read !== undefined, 'The template survives the snapshot');
  assert.equal(stateHTML(read, read.outputs[state.output] ?? output), base, 'The parsed base state renders the base');
  assert.equal(render(template, BASE), badge({ label: 'Hello', tone: 'info' }, 'SLOT').replace(PATH_SENTINEL, '0.1'), 'The base reproduces the build');
});

test('an empty or absent string is its own state, not an empty hole', () => {
  const template = templateFor(BASE);
  assert.equal(render(template, { ...BASE, label: str('') }), badge({ label: '', tone: 'info' }, 'SLOT').replace(PATH_SENTINEL, '0.1'));
  assert.equal(render(template, { tone: str('info') }), badge({ tone: 'info' }, 'SLOT').replace(PATH_SENTINEL, '0.1'));
});

test('a choice and a boolean pick a pre-rendered state, and a string still fills it', () => {
  const template = templateFor(BASE);
  assert.equal(render(template, { ...BASE, tone: str('warn') }), badge({ label: 'Hello', tone: 'warn' }, 'SLOT').replace(PATH_SENTINEL, '0.1'));
  assert.equal(
    render(template, { ...BASE, outlined: { type: 'bare' }, label: str('Bye') }),
    badge({ label: 'Bye', tone: 'info', outlined: true }, 'SLOT').replace(PATH_SENTINEL, '0.1'),
  );
  assert.equal(
    render(template, { ...BASE, tone: { type: 'expr', value: '"warn"' } }),
    render(template, { ...BASE, tone: str('warn') }),
    'A literal written as code is the same value',
  );
});

test('negative space: what the probes cannot prove refuses', () => {
  const template = templateFor(BASE);
  assert.equal(render(template, { ...BASE, slug: str('Mixed') }), undefined, 'A transformed prop has no state that renders it');
  assert.equal(render(template, { ...BASE, slug: str('a'), count: { type: 'expr', value: '2' } }), undefined, 'Two text moves at once');
  assert.equal(render(template, { ...BASE, tone: str('loud') }), undefined, 'A value the choice does not offer');
  assert.equal(render(template, { ...BASE, label: { type: 'expr', value: 'site.title' } }), undefined, 'A value only code knows');
  assert.equal(render(template, { ...BASE, id: str('x') }), undefined, 'An attribute nothing models');
  assert.equal(renderTemplate(template, BASE, ['default', 'icon'], '0.1').ok, false, 'A slot the bake never filled');
});

test('a transformed prop in the base leaves the others editable through their singles', () => {
  const template = templateFor({ ...BASE, slug: str('Hi') });
  assert.equal(template.base, undefined, 'The shared run disagrees');
  assert.equal(
    render(template, { ...BASE, slug: str('Hi'), label: str('Bye') }),
    badge({ label: 'Bye', tone: 'info', slug: 'Hi' }, 'SLOT').replace(PATH_SENTINEL, '0.1'),
  );
  assert.equal(render(template, { ...BASE, slug: str('Other') }), undefined);
});

test('the bake lists every state once, and sentinels differ by run and by prop', () => {
  const states = specStates(specFor(BASE));
  // Choices: tone at info, warn or absent; outlined absent or true, since false is its
  // default and absence stands for it. Each of the six combinations, then each with one
  // text move: label, slug and count to their two other classes, or the slot left out.
  // One more state checks that an explicit false renders as absence.
  assert.equal(states.length, 6 * (1 + 7) + 1);
  assert.equal(new Set(states.map((state) => state.key)).size, states.length, 'No state twice');
  assert.notEqual(sentinel({ kind: 'string' }, 0, 0), sentinel({ kind: 'string' }, 0, 1));
  assert.notEqual(sentinel({ kind: 'string' }, 0, 0), sentinel({ kind: 'string' }, 1, 0));
  assert.match(String(sentinel({ kind: 'string' }, 0, 0)), /&"/, 'Sentinels carry characters Astro escapes');
});

test('a template survives the snapshot, and a forged one is refused', () => {
  const template = templateFor(BASE);
  const catalog = parseComponentCatalog(JSON.parse(JSON.stringify({ templates: [template], instances: { 'src/pages/index.astro': { '0.1': 0 } } })));
  assert.equal(render(catalog.templates[0] ?? template, BASE), render(template, BASE));
  assert.throws(() => parseComponentCatalog({ templates: [template], instances: { 'src/pages/index.astro': { '0.1': 1 } } }), /count within/);
  assert.throws(() => parseComponentCatalog({ templates: [{ ...template, holes: [] }], instances: {} }), /names no hole/);
});

test('probes are cut out of a built page and nothing else is', () => {
  const html =
    '<html><body><p>Page</p></body></html>\n<!--stacki-probe:0--><b>a</b><!--/stacki-probe:0-->\n<!--stacki-probe:1--><i>b</i><!--/stacki-probe:1-->\n<script src="m.js"></script>';
  const extracted = extractProbes(html);
  assert.equal(extracted.html, '<html><body><p>Page</p></body></html>\n<script src="m.js"></script>');
  assert.deepEqual(
    [...extracted.outputs],
    [
      [0, '<b>a</b>'],
      [1, '<i>b</i>'],
    ],
  );
  assert.throws(
    () => extractProbes('<!--stacki-probe:0-->x<!--/stacki-probe:0--><p>stray</p><!--stacki-probe:1-->y<!--/stacki-probe:1-->'),
    /more than probes/,
  );
});

test('slot content is lifted as written, anchored at both ends', () => {
  assert.deepEqual([...(liftSlots('<a><x></x></a>', ['<a>', { slot: 'default' }, '</a>']) ?? [])], [['default', '<x></x>']]);
  assert.equal(liftSlots('<b>x</b>', ['<a>', { slot: 'default' }, '</a>']), undefined, 'A run the template did not make');
});

test('an edited instance is re-rendered in the page text and its slot content kept', () => {
  const template = templateFor(BASE);
  const catalog = { templates: [template], instances: { 'src/pages/index.astro': { '0.1': 0 } } };
  const slot = '<!--avb-s:0.1.0--><em data-avb-p="0.1.0">kept</em><!--avb-e:0.1.0-->';
  const page = `<main>\n  <!--avb-s:0.1-->\n  ${badge({ label: 'Hello', tone: 'info' }, slot).replace(PATH_SENTINEL, '0.1')}\n  <!--avb-e:0.1-->\n</main>`;
  const edit = { path: '0.1', file: FILE, attrs: { ...BASE, tone: str('warn') }, slots: ['default'] };
  const result = renderEditsInText(page, [edit], catalog, 'src/pages/index.astro');
  assert.deepEqual(result.failed, []);
  assert.equal(result.html, page.replace('badge info', 'badge warn'));
  const refused = renderEditsInText(page, [{ ...edit, attrs: { ...BASE, slug: str('X') } }], catalog, 'src/pages/index.astro');
  assert.deepEqual(refused, { html: page, failed: [{ ...edit, attrs: { ...BASE, slug: str('X') } }] }, 'A refused edit leaves the page as baked');
});

test('inside a slot whose comments were stripped, the instance is found by its root element', () => {
  const template = templateFor(BASE);
  const catalog = { templates: [template], instances: { 'src/pages/index.astro': { '0.1': 0 } } };
  const nested = '<span data-avb-p="0.1.0">inner <span>deep</span></span>';
  const root = badge({ label: 'Hello', tone: 'info' }, nested).replace(PATH_SENTINEL, '0.1');
  const page = `<section><div>${root}</div><span class="badge info">after</span></section>`;
  const edit = { path: '0.1', file: FILE, attrs: { ...BASE, label: str('Bye') }, slots: ['default'] };
  const result = renderEditsInText(page, [edit], catalog, 'src/pages/index.astro');
  assert.deepEqual(result.failed, []);
  assert.equal(
    result.html,
    page.replace(root, badge({ label: 'Bye', tone: 'info' }, nested).replace(PATH_SENTINEL, '0.1')),
    'Nested spans of the same name close the right element',
  );
  const twice = `${page}${root}`;
  assert.equal(renderEditsInText(twice, [edit], catalog, 'src/pages/index.astro').failed.length, 1, 'Two roots with the path: a loop, refused');
});

test('a variant switches on a slotted instance whose slot holds inline elements', () => {
  // Like the overview Paragraph on stacki.build: placed in a named slot, which the
  // component spreads onto its root, with inline code inside its own slot.
  const attrs = { ...BASE, slot: str('column2') };
  const template = templateFor(attrs);
  const catalog = { templates: [template], instances: { 'src/pages/index.astro': { '0.1': 0 } } };
  const inline = 'Every change is written back as <code data-avb-p="0.1.1">.astro</code> source.';
  const root = badge({ label: 'Hello', tone: 'info', slot: 'column2' }, inline).replace(PATH_SENTINEL, '0.1');
  const page = `<div class="columns">${root}</div>`;
  const edit = { path: '0.1', file: FILE, attrs: { ...attrs, tone: str('warn') }, slots: ['default'] };
  const result = renderEditsInText(page, [edit], catalog, 'src/pages/index.astro');
  assert.deepEqual(result.failed, []);
  assert.equal(result.html, page.replace('badge info', 'badge warn'), 'The slot attribute and the inline code are kept');
});

test('a number read by logic refuses the values its stand-ins could not prove', () => {
  const template = templateFor({ ...BASE, count: { type: 'expr', value: '1' } });
  const at = (count: string) => render(template, { ...BASE, count: { type: 'expr', value: count } });
  assert.equal(at('1'), badge({ label: 'Hello', tone: 'info', count: 1 }, 'SLOT').replace(PATH_SENTINEL, '0.1'), 'The base reproduces the page');
  assert.equal(at('3'), undefined, 'Its stand-in wrote an attribute the value 1 never does, so a change is refused');
  assert.equal(
    render(template, { ...BASE, count: { type: 'expr', value: '1' }, tone: str('warn') }),
    badge({ label: 'Hello', tone: 'warn', count: 1 }, 'SLOT').replace(PATH_SENTINEL, '0.1'),
    'Other switches still work, with the number as it was',
  );
});

test('emptying a slot renders the component as if nothing were written in it', () => {
  const template = templateFor(BASE);
  const result = renderTemplate(template, BASE, [], '0.1');
  assert.ok(result.ok);
  assert.equal(
    joinOutput(result.output, () => 'SLOT'),
    badge({ label: 'Hello', tone: 'info' }, '').replace(PATH_SENTINEL, '0.1'),
  );
});

// A button shaped like stacki.build's: `variant` picks the arm of a props union, and
// each arm shows its own props. An arrow has a direction and a label that falls back
// to Next or Previous; a download falls back to Download; a main button renders only
// with content. The hero instance is a download with no content.
const BUTTON = 'src/components/Button.astro';
const BUTTON_FIELDS = [
  {
    name: 'variant',
    type: 'enum',
    options: ['main', 'arrow', 'download'],
    default: 'main',
    unions: [
      {
        names: ['variant', 'label', 'direction'],
        branches: [
          { forbids: ['label', 'direction'], pins: { variant: ['main'] } },
          { forbids: [], pins: { variant: ['arrow'], direction: ['forward', 'back'] } },
          { forbids: ['direction'], pins: { variant: ['download'] } },
        ],
      },
    ],
  },
  { name: 'emphasis', type: 'enum', options: ['primary', 'secondary'], default: 'primary' },
  { name: 'direction', type: 'enum', options: ['forward', 'back'], default: 'forward' },
  { name: 'label', type: 'string' },
] as const;

function button(props: Readonly<Record<string, Literal | undefined>>, slot: string): string {
  const variant = props['variant'] ?? 'main';
  const emphasis = (props['emphasis'] ?? 'primary') === 'primary' ? '' : ' secondary';
  const label = props['label'];
  const path = `data-avb-p="${BUTTON}|0 ${PATH_SENTINEL}"`;
  if (variant === 'arrow') {
    const back = props['direction'] === 'back';
    const name = typeof label === 'string' ? label : back ? 'Previous' : 'Next';
    return `<button class="button arrow${back ? ' back' : ''}${emphasis}" aria-label="${escapeHTML(name)}" ${path}></button>`;
  }
  if (variant === 'download') {
    const any = typeof label === 'string' ? label : 'Download';
    return `<a class="button${emphasis}" href="/download" ${path}><span>${escapeHTML(any)}</span><span>Download for Mac</span></a>`;
  }
  return slot === '' ? '' : `<button class="button${emphasis}" ${path}>${slot}</button>`;
}

const HERO = { variant: str('download'), class: str('hero_download') };

function heroTemplate(): ComponentTemplate {
  const spec = probeSpec({
    file: BUTTON,
    name: 'Button',
    node: { props: { variant: HERO.variant } },
    slots: [],
    fields: BUTTON_FIELDS,
    stamp: undefined,
    instance: { page: 'src/pages/index.astro', path: '0.1' },
  });
  return templateFrom(spec, planProbes(new Map([['src/pages/index.astro', [spec]]])), button);
}

function heroRender(template: ComponentTemplate, attrs: Readonly<Record<string, Attr>>): string | undefined {
  const result = renderTemplate(template, attrs, [], '0.1');
  return result.ok ? joinOutput(result.output, () => '') : undefined;
}

const built = (props: Readonly<Record<string, Literal | undefined>>) => button(props, '').replace(PATH_SENTINEL, '0.1');

test('a variant renders with every prop its arm shows, and each falls back as the component does', () => {
  const template = heroTemplate();
  const arrow = { variant: str('arrow') };
  assert.equal(heroRender(template, { variant: str('download') }), built({ variant: 'download' }), 'The download falls back to Download');
  assert.equal(heroRender(template, { variant: str('download'), label: str('Get it') }), built({ variant: 'download', label: 'Get it' }));
  assert.equal(heroRender(template, arrow), built({ variant: 'arrow' }), 'An arrow falls back to Next');
  assert.equal(heroRender(template, { ...arrow, direction: str('back') }), built({ variant: 'arrow', direction: 'back' }), 'and to Previous going back');
  assert.equal(
    heroRender(template, { ...arrow, direction: str('back'), emphasis: str('secondary'), label: str('Earlier & before') }),
    built({ variant: 'arrow', direction: 'back', emphasis: 'secondary', label: 'Earlier & before' }),
    'Three choices and a label together',
  );
  assert.equal(heroRender(template, { ...arrow, label: str('') }), built({ variant: 'arrow', label: '' }), 'An empty label is not a missing one');
  assert.equal(heroRender(template, { variant: str('main') }), '', 'A main button with no content renders nothing, as Astro would');
  assert.equal(heroRender(template, {}), '', 'and so does the default variant');
});

test('an explicit default renders as its absence, and the types bound the combinations', () => {
  const template = heroTemplate();
  assert.deepEqual(template.collapsed, { variant: 'option:main', emphasis: 'option:primary', direction: 'option:forward' });
  assert.equal(
    heroRender(template, { variant: str('arrow'), direction: str('forward'), emphasis: str('primary') }),
    built({ variant: 'arrow' }),
    'Written defaults look up as absent',
  );
  assert.equal(
    heroRender(template, { variant: str('download'), direction: str('back') }),
    undefined,
    'A direction on a download is a type error: never rendered',
  );
  assert.equal(heroRender(template, { variant: str('main'), label: str('x') }), undefined, 'A label on a main button neither');
  const catalog = parseComponentCatalog(JSON.parse(JSON.stringify({ templates: [template], instances: {} })));
  assert.equal(
    heroRender(catalog.templates[0] ?? template, { variant: str('arrow'), direction: str('back') }),
    built({ variant: 'arrow', direction: 'back' }),
    'States survive the snapshot',
  );
  assert.throws(
    () => parseComponentCatalog({ templates: [{ ...template, states: [{ ...template.states[0], key: 'zz' }] }], instances: {} }),
    /wrong length|class the prop/,
    'A forged key is refused',
  );
});

test('a default the component tells apart from absence is not collapsed', () => {
  // `emphasis="primary"` written out adds a class that absence does not.
  const distinguishing: Renderer = (props, slot) =>
    button(props, slot).replace('class="button', props['emphasis'] === 'primary' ? 'class="button primary' : 'class="button');
  const spec = probeSpec({
    file: BUTTON,
    name: 'Button',
    node: { props: { variant: HERO.variant } },
    slots: [],
    fields: BUTTON_FIELDS,
    stamp: undefined,
    instance: { page: 'src/pages/index.astro', path: '0.1' },
  });
  const template = templateFrom(spec, planProbes(new Map([['src/pages/index.astro', [spec]]])), distinguishing);
  assert.equal(template.collapsed['emphasis'], undefined);
  assert.equal(
    heroRender(template, { variant: str('download'), emphasis: str('primary') }),
    distinguishing({ variant: 'download', emphasis: 'primary' }, '').replace(PATH_SENTINEL, '0.1'),
    'Its own state, next to the base',
  );
  assert.equal(heroRender(template, { variant: str('arrow'), emphasis: str('primary') }), undefined, 'Elsewhere it refuses rather than guess');
});

// A row of chips like stacki.build's: `items`, an array of strings written as a
// literal, rendered by a `.map()`, and a `marginTop` choice. The scan types the list
// only as code; the instance's literal makes it a list.
const CHIPS = 'src/components/site/Chips.astro';
const CHIPS_FIELDS = [
  { name: 'items', type: 'code', defaultExpr: true },
  { name: 'marginTop', type: 'enum', options: ['default', '2', '7'], default: 'default' },
] as const;

function chips(props: Readonly<Record<string, Literal | readonly Literal[] | undefined>>): string {
  const listed = props['items'];
  const items = Array.isArray(listed) ? listed : ['Short fact', 'Short fact', 'Short fact'];
  const margin = props['marginTop'] ?? 'default';
  return `<ul class="chips" data-margin="${String(margin)}" data-avb-p="${CHIPS}|0 ${PATH_SENTINEL}">${items.map((item) => `<li>${escapeHTML(String(item))}</li>`).join('')}</ul>`;
}

const list = (...items: readonly string[]): Attr => ({
  type: 'expr',
  value: items.length === 0 ? '[]' : `[\n  ${items.map((item) => JSON.stringify(item)).join(',\n  ')},\n]`,
});

function chipsTemplate(): ComponentTemplate {
  const spec = probeSpec({
    file: CHIPS,
    name: 'Chips',
    node: { props: { items: list('Free', 'Open', 'Easy') } },
    slots: [],
    fields: CHIPS_FIELDS,
    stamp: undefined,
    instance: { page: 'src/pages/index.astro', path: '0.1' },
  });
  // Lists reach the component as arrays, which the Badge-shaped harness cannot pass, so
  // the probes are rendered here from each render's sentinels and overrides directly.
  const plan = planProbes(new Map([['src/pages/index.astro', [spec]]]));
  const page = plan.pages.get('src/pages/index.astro');
  const states = plan.states[0];
  assert.ok(page);
  assert.ok(states);
  const outputs = new Map<string, [string | undefined, string | undefined]>();
  for (const render of page.renders) {
    const props: Record<string, Literal | readonly Literal[] | undefined> = { items: ['Free', 'Open', 'Easy'] };
    if (render.target.kind === 'state') {
      for (const [name, value] of states[render.target.index]?.overrides ?? []) {
        props[name] = value.kind === 'literal' ? value.value : value.kind === 'list' ? Array.from({ length: value.length }, () => '') : undefined;
      }
    }
    const written = props['items'];
    const items: Literal[] | undefined = typeof written === 'object' ? [...written] : undefined;
    for (const [name, value] of render.sentinels) {
      const item = /^items\.(\d+)$/.exec(name);
      if (item !== null && items !== undefined) {
        items[Number(item[1])] = value;
      } else {
        props[name] = value;
      }
    }
    if (items !== undefined) {
      props['items'] = items;
    }
    const key = render.target.kind === 'state' ? `state:${render.target.index}` : render.target.kind === 'single' ? `single:${render.target.prop}` : 'actual';
    const pair = outputs.get(key) ?? [undefined, undefined];
    pair[render.run] = chips(props);
    outputs.set(key, pair);
  }
  const template = buildTemplate(spec, states, outputs, page.renders);
  assert.ok(template);
  return template;
}

test('a list of strings renders reordered, edited, longer or shorter, and with its other props', () => {
  const template = chipsTemplate();
  const at = (attrs: Readonly<Record<string, Attr>>) => heroRender(template, attrs);
  const built = (items: readonly string[] | undefined, marginTop?: string) => chips({ items, marginTop }).replace(PATH_SENTINEL, '0.1');
  assert.equal(at({ items: list('Free', 'Open', 'Easy') }), built(['Free', 'Open', 'Easy']), 'As written');
  assert.equal(at({ items: list('Easy', 'Free', 'Open') }), built(['Easy', 'Free', 'Open']), 'Reordered');
  assert.equal(at({ items: list('Free & <b>', 'Open', 'Easy') }), built(['Free & <b>', 'Open', 'Easy']), 'Edited, escaped as Astro escapes');
  assert.equal(at({ items: list('One', 'Two', 'Three', 'Four') }), built(['One', 'Two', 'Three', 'Four']), 'Longer');
  assert.equal(at({ items: list() }), built([]), 'Empty');
  assert.equal(at({}), built(undefined), 'Unset falls back to the component’s default');
  assert.equal(at({ items: list('Free', 'Open', 'Easy'), marginTop: str('7') }), built(['Free', 'Open', 'Easy'], '7'), 'A choice beside the list');
  assert.equal(at({ items: list('A', 'B'), marginTop: str('7') }), built(['A', 'B'], '7'), 'and with a new list');
  assert.equal(at({ items: { type: 'expr', value: 'facts' } }), undefined, 'A list only code knows refuses');
  assert.equal(
    at({ items: list(...Array.from({ length: TEMPLATE_LIMITS.listItemsMax + 1 }, (_, index) => String(index))) }),
    undefined,
    'Past the item limit refuses',
  );
});

test('only instances a probe at the end of the page can stand for are probed', () => {
  const page = [
    '---',
    'import Badge from "../components/Badge.astro";',
    'const group = groups[0];',
    '---',
    '<Badge label="Plain" />',
    '{group && <Badge label={group.id} />}',
    '{groups.map((each) => <Badge label={each.id} />)}',
    '',
  ].join('\n');
  const specs = pageInstances('src/pages/index.astro', page, () => FIELDS, 'stamp');
  assert.deepEqual(
    specs.map((spec) => spec.attrs['label']),
    [str('Plain')],
    'Not inside a condition, whose guard the probe would lose, nor inside a loop',
  );
});

test('a page shares its render budget, so no instance is starved by the ones above it', () => {
  assert.deepEqual(stateShares([10, 20, 30], 200), [10, 20, 30], 'Everything fits');
  assert.deepEqual(stateShares([1000, 5, 1000], 202), [48, 5, 48], 'The small one is whole; the large two split the rest');
  assert.deepEqual(stateShares([7, 7], 0), [0, 0], 'No room, no states');
});

test('a prop the component requires is never left unset by a probe', () => {
  const fields = [
    { name: 'group', type: 'string', optional: false },
    { name: 'variant', type: 'enum', options: ['featured', 'directory'], default: 'directory', optional: true },
  ] as const;
  assert.deepEqual(requiredProps(fields), ['group']);
  const spec = probeSpec({
    file: 'src/components/site/DocsGroup.astro',
    name: 'DocsGroup',
    node: { props: { group: str('Start') } },
    slots: [],
    fields,
    stamp: undefined,
    instance: undefined,
  });
  const states = specStates(spec);
  assert.ok(states.length > 1, 'The other props still move');
  assert.equal(
    states.some((state) => state.classes.get('group') === 'absent'),
    false,
    'No state renders the component without the prop it needs',
  );
});

test('a template page renders its probes with one entry only', () => {
  assert.equal(onceGuard('src/pages/index.astro', '<X />'), '<X />', 'An ordinary page renders them once anyway');
  const guarded = onceGuard('src/pages/docs/[...slug].astro', '<X />');
  assert.match(guarded, /^\{.*&& <X \/>\}$/);
  // The guard's condition, run as the build runs it once per entry.
  const condition = guarded.slice(1, guarded.indexOf(' && <X'));
  const store: Record<string, unknown> = {};
  const run = new Function('globalThis', `return ${condition};`) as (scope: Record<string, unknown>) => unknown;
  assert.deepEqual([run(store), run(store), run(store)], [true, false, false], 'The first entry renders them, no later one does');
});

test('an instance that reads the page’s code is probed and kept per template entry', () => {
  const literal = specFor(BASE);
  const computed = specFor({ ...BASE, label: { type: 'expr', value: 'doc.data.title' } });
  assert.equal(dependsOnPage(literal), false, 'Literals render alike on every entry');
  assert.equal(dependsOnPage(computed), true, 'Code may read the entry');
  const page = 'src/pages/docs/[...slug].astro';
  const plan = planProbes(
    new Map([
      [
        page,
        [
          { ...literal, instance: { page, path: '0' } },
          { ...computed, instance: { page, path: '1' } },
        ],
      ],
    ]),
  );
  const markup = plan.pages.get(page)?.markup ?? '';
  assert.equal((markup.match(/__stackiProbedTemplates/g) ?? []).length, 1, 'Only the literal instance renders once');
  assert.equal(entryInstancesKey(page, 'docs/install/index.html'), `${page}#docs/install/index.html`);
});

test('what Astro writes once per page is set aside to lift a run, and put back after', () => {
  const template = '<html><head>\n  <title>A</title>\n  </head><body>SLOT</body></html>';
  const run =
    '<html><head>\n  <title>A</title>\n  <link rel="stylesheet" href="/a.css">\n<script type="module" src="/b.js"></script>\n</head><body><p>x</p></body></html>';
  const once = pageOnce(run, template.replace('SLOT', ''));
  assert.ok(once);
  assert.equal(once.removed.length, 2);
  assert.equal(once.text, '<html><head>\n  <title>A</title>\n  </head><body><p>x</p></body></html>');
  const edited = once.text.replace('<p>x</p>', '<p>y</p>');
  assert.equal(restorePageOnce(edited, once), run.replace('<p>x</p>', '<p>y</p>'), 'Back in place, in order');
  assert.equal(
    restorePageOnce(once.text.replace('<title>A</title>', '<title>B</title>'), once),
    undefined,
    'An edit to the text that places them refuses rather than guess',
  );
  assert.equal(restorePageOnce('<html></html>', once), undefined, 'An edit that removed their place refuses');
  assert.equal(pageOnce(run.replace(/<link[^>]*>\n|<script[^>]*><\/script>\n/g, ''), template), undefined, 'Nothing to set aside');
});

test('changes far apart are kept as line hunks, not the whole span between them', () => {
  const lines = Array.from({ length: 400 }, (_, index) => `<p class="line">Line ${index}</p>\n`);
  const base = `<html class="article">\n${lines.join('')}<footer class="article"></footer>\n</html>`;
  const html = base.replace('<html class="article">', '<html class="index">').replace('<footer class="article">', '<footer class="index">');
  const difference = stateDifference(base, html);
  assert.ok(difference.hunks, 'Two hunks');
  assert.equal(difference.hunks.length, 2);
  assert.ok(differenceChars(difference) < 200, 'A few lines stored, not the page between them');
  const template = { ...templateFor(BASE), base, outputs: [difference], states: [], singles: {} };
  assert.equal(stateHTML(template, difference), html);
  const parsed = parseComponentCatalog(JSON.parse(JSON.stringify({ templates: [template], instances: {} })));
  assert.equal(stateHTML(parsed.templates[0] ?? template, parsed.templates[0]?.outputs[0] ?? difference), html, 'Hunks survive the snapshot');
  assert.throws(
    () => parseComponentCatalog({ templates: [{ ...template, outputs: [{ ...difference, hunks: [[10, 5, 'x']] }] }], instances: {} }),
    /out of order/,
  );
  assert.throws(
    () => parseComponentCatalog({ templates: [{ ...template, outputs: [{ ...difference, hunks: [[0, base.length + 1, 'x']] }] }], instances: {} }),
    /outside the base/,
  );
});

// The parser checks hole tokens piece by piece instead of rebuilding every rendering.
// It must still answer exactly as the rebuilt rendering would: a token cut across a
// seam, or one inside a single piece, that names no hole is refused; one that names a
// hole passes.
test('the parser refuses a hole token that names no hole, wherever the rendering joins it', () => {
  const template = templateFor(BASE);
  const holes = template.holes.length;
  const bad = String(holes + 7);
  const catalog = (base: string, output: object): unknown =>
    JSON.parse(JSON.stringify({ templates: [{ ...template, base, outputs: [output], states: [], singles: {} }], instances: {} }));
  const parse = (base: string, output: object) => () => parseComponentCatalog(catalog(base, output));
  const open = '';
  const close = '';
  // Valid: a known hole in the base, in a middle, and opened in the base and closed in the middle.
  assert.doesNotThrow(parse(`<p>${open}0${close}</p>`, { prefix: 3, suffix: 4, middle: `<b>${open}0${close}</b>` }));
  assert.doesNotThrow(parse(`<p>${open}0</p>`, { prefix: 4, suffix: 0, middle: `${close}</p>` }), 'A seam inside a token that names a hole');
  // A bad token the rendering cuts out of the base is not in the rendering.
  assert.doesNotThrow(parse(`<p>${open}${bad}${close}</p>`, { prefix: 3, suffix: 4, middle: '' }));
  // Invalid inside one piece.
  assert.throws(parse('<p></p>', { prefix: 3, suffix: 4, middle: `${open}${bad}${close}` }), /names no hole/);
  assert.throws(parse(`<p>${open}${bad}${close}</p>`, { prefix: 3 + bad.length + 2, suffix: 4, middle: '' }), /names no hole/, 'A bad token in the base');
  // Invalid only once joined: the base opens it, the middle closes it.
  assert.throws(parse(`<p>${open}${bad}</p>`, { prefix: 3 + 1 + bad.length, suffix: 0, middle: `${close}</p>` }), /names no hole/);
  // Joined across three pieces: an opening, a run of digits, then the close in the base's suffix.
  assert.throws(parse(`${open}1x${close}`, { prefix: 1, suffix: 1, middle: bad }), /names no hole/);
  // Joined by a hunk: the base opens it and the hunk's text closes it.
  const base = `${open}${bad}\nrest\n`;
  assert.throws(parse(base, { prefix: 0, suffix: 0, middle: '', hunks: [[1 + bad.length, base.length, `${close}\n`]] }), /names no hole/);
  assert.doesNotThrow(parse(`${open}0\nrest\n`, { prefix: 0, suffix: 0, middle: '', hunks: [[2, 8, `${close}\n`]] }));
});

// An insertion recipe is baked with no instance: its template is found by file alone,
// at the recipe's own defaults. Its base state points at the base like any other, and
// must survive the snapshot and still render a new use of the component.
test('an insertion recipe template round-trips the snapshot and renders a new use', () => {
  const recipe = { label: str('New badge'), tone: str('warn') };
  const spec = probeSpec({ file: FILE, name: 'Badge', node: { props: recipe }, slots: ['default'], fields: FIELDS, stamp: undefined, instance: undefined });
  const plan = planProbes(new Map([['src/pages/index.astro', [spec]]]));
  const template = templateFrom(spec, plan, badge);
  const state = template.states[0];
  assert.ok(state !== undefined, 'The recipe has its base state');
  assert.equal(differenceChars(template.outputs[state.output] ?? { prefix: 0, suffix: 0, middle: 'x' }), 0, 'Its base state points at the base');
  const catalog = parseComponentCatalog(JSON.parse(JSON.stringify({ templates: [template], instances: {} })));
  const expected = badge({ label: 'New badge', tone: 'warn' }, 'SLOT').replace(PATH_SENTINEL, '0.4');
  const use = { file: FILE, path: '0.4', attrs: recipe, slots: ['default'] };
  assert.equal(canRenderUse(catalog, use), true, 'A new use of the recipe renders');
  const output = renderUse(catalog, use, undefined);
  assert.ok(output !== undefined);
  assert.equal(
    joinOutput(output, () => 'SLOT'),
    expected,
    'It renders as the build did',
  );
  assert.equal(canRenderUse(catalog, { ...use, file: 'src/components/Other.astro' }), false, 'Another file has no template');
});

// A single holds one prop as a hole with every other prop and slot at the base. A use
// that moves that prop to another class (absent), or leaves a slot the base filled
// empty, is a different state: the template refuses it, never fills a hole without a
// value, so the demo can try the file's other templates (an insertion's own recipe).
test('a single serves only a text change at the base slots, and otherwise refuses', () => {
  const attrs = { ...BASE, slug: str('Mixed-Case') };
  const template = templateFor(attrs);
  assert.ok(template.singles['label'] !== undefined, 'The transformed slug leaves the label a single');
  const result = (use: Readonly<Record<string, Attr>>, slots: readonly string[]) => renderTemplate(template, use, slots, '0.1');
  const moved = result({ ...attrs, label: str('Moved') }, ['default']);
  assert.ok(moved.ok, 'A text change uses the single');
  assert.equal(
    joinOutput(moved.output, () => 'SLOT'),
    badge({ label: 'Moved', tone: 'info', slug: 'Mixed-Case' }, 'SLOT').replace(PATH_SENTINEL, '0.1'),
  );
  const { label: _label, ...withoutLabel } = attrs;
  assert.deepEqual(result(withoutLabel, ['default']), { ok: false, reason: 'state' }, 'An absent label is not the single');
  assert.deepEqual(result({ ...attrs, label: str('Moved') }, []), { ok: false, reason: 'state' }, 'An empty slot is not the single');
});
