// Goal: the pure parts of Design mode's "Unlink component". (1) The markup an instance is unlinked into, read from the
// page as the dev server renders it with Stacki's markers: plain elements with their classes and scope attributes,
// a nested component kept when the page can write what it is given, the page's slot content written back as its own
// source, text escaped for Astro, markers and dev attributes left out; and each refusal (a script, a style, an
// island, a dev-only picture, slot content drawn twice, nothing rendered). (2) The page text: the frontmatter's prop
// bindings, slot content without its slot attribute, imports rebased, aliased or reused, the component's own import
// kept, made bare or removed. (3) The check that keeps an unlink only when the page renders as it did, including the
// page's own scope on the new elements, which may stay only while none of the page's scoped rules starts matching.
//
// Method: the real modules, bundled by test/helpers/rendererModule.js, over documents parsed by jsdom from rendered
// pages shaped like the dev server's (the markers as electron/parse/astroSerializeMarked.ts writes them), and
// templates parsed by the real parser. Each rule has its negative case.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = require('../../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const markup = load('src/app/designMode/designUnlinkMarkup.ts');
const source = load('src/app/designMode/designUnlinkSource.ts');
const { compareRenders } = load('src/app/designMode/designUnlinkCheck.ts');

const parse = (html) => new JSDOM(html).window.document;

const PROBE = `---
import Heading from "@/components/typography/Heading.astro";
import SoakCard from "@/components/SoakCard.astro";
const { title = "Default", items = ["a", "b"], show = true } = Astro.props;
---
<div class="probe">
  <Heading tag="h3">{title}</Heading>
  {show && <p class="probe_show">shown</p>}
  {items.map((item) => <span class="probe_item">{item}</span>)}
  <slot />
  <div class="probe_named"><slot name="aside">fallback</slot></div>
  <SoakCard />
</div>
<style>.probe { padding: 4px; }</style>
`;

const PAGE = `---
import Layout from "@/layouts/BaseLayout.astro";
import Probe from "@/components/Probe.astro";
import Button from "@/components/Button.astro";
---
<Layout>
  <Probe title="Hi there"><Button>Go</Button><b slot="aside">side</b></Probe>
  <Button>Second</Button>
</Layout>
`;

const PROBE_FILE = 'src/components/Probe.astro';
// The probe as the dev server rendered it inside a layout that keeps comments (trimmed of the dev source attributes).
const RENDERED = `<!DOCTYPE html><html><head></head><body><main>
  <!--avb-s:0.0--><!--avb-s:${PROBE_FILE}|0--><div class="probe" data-avb-p="${PROBE_FILE}|0 0.0" data-avb-d="avb-d:0f:${PROBE_FILE}" data-astro-cid-v5njgcdl data-astro-source-file="/x/Probe.astro">
  <!--avb-s:${PROBE_FILE}|0.0--><h3 data-avb-p="src/components/typography/Heading.astro|0.0.0 ${PROBE_FILE}|0.0" data-astro-cid-v5njgcdl="true" class="heading text-style-h3">
      Hi there
    </h3><!--avb-e:${PROBE_FILE}|0.0-->
  <!--avb-s:${PROBE_FILE}|0.1--><p class="probe_show" data-avb-p="${PROBE_FILE}|0.1.0.0" data-astro-cid-v5njgcdl>shown</p><!--avb-e:${PROBE_FILE}|0.1-->
  <!--avb-s:${PROBE_FILE}|0.2--><!--avb-i:0:${PROBE_FILE}|0.2--><span class="probe_item" data-avb-p="${PROBE_FILE}|0.2.0" data-astro-cid-v5njgcdl>a</span><!--avb-i:1:${PROBE_FILE}|0.2--><span class="probe_item" data-avb-p="${PROBE_FILE}|0.2.0" data-astro-cid-v5njgcdl>b</span><!--avb-e:${PROBE_FILE}|0.2-->
  <!--avb-s:${PROBE_FILE}|0.3--><!--avb-s:0.0.0--><button type="button" data-avb-p="src/components/Button.astro|0.0.0 0.0.0" class="button_wrap">
      <span class="button_text text-style-trim" data-avb-p="src/components/Button.astro|0.0.0.0.0.0">Go</span>
    </button>

<!--avb-e:0.0.0--><!--avb-e:${PROBE_FILE}|0.3-->
  <!--avb-s:${PROBE_FILE}|0.4--><div class="probe_named" data-avb-p="${PROBE_FILE}|0.4" data-astro-cid-v5njgcdl><b data-avb-p="0.0.1">side</b></div><!--avb-e:${PROBE_FILE}|0.4-->
  <!--avb-s:${PROBE_FILE}|0.5--><div class="soak-card" data-avb-p="src/components/SoakCard.astro|0 ${PROBE_FILE}|0.5" data-astro-cid-xa34rsyv>
  <h3 class="soak-card_title" data-avb-p="src/components/SoakCard.astro|0.0" data-astro-cid-xa34rsyv>Scoped card title</h3>
</div><!--avb-e:${PROBE_FILE}|0.5-->
</div><!--avb-e:${PROBE_FILE}|0--><!--avb-e:0.0-->
</main></body></html>`;

function probeInput(html, overrides = {}) {
  const page = parsePage(PAGE, { locs: true });
  const component = parsePage(PROBE, {});
  assert.ok(page.editable && component.editable, 'the fixtures parse');
  const instance = page.model.nodes[0].children[0];
  assert.equal(instance.name, 'Probe');
  return {
    document: parse(html),
    instancePath: '0.0',
    instanceProps: instance.props,
    children: source.slotChildren(PAGE, instance),
    component: { file: PROBE_FILE, nodes: component.model.nodes, bindings: source.propBindings(source.frontmatterOf(PROBE)) },
    tagFor: (name) => name,
    ...overrides,
  };
}

test('an instance unlinks into what it renders: plain elements, kept components and the page’s own slot content', () => {
  const made = markup.unlinkMarkup(probeInput(RENDERED));
  assert.equal(made.ok, true);
  const text = made.value.markup;
  // The root and the component's own elements, with their classes and the scope that applies its styles.
  assert.match(text, /^<div class="probe" data-astro-cid-v5njgcdl>/);
  assert.match(text, /<p class="probe_show" data-astro-cid-v5njgcdl>shown<\/p>/);
  // A loop and a condition are what they rendered.
  assert.match(text, /<span class="probe_item" data-astro-cid-v5njgcdl>a<\/span><span class="probe_item" data-astro-cid-v5njgcdl>b<\/span>/);
  // A nested component the page can write stays one, given the instance's prop and the scope it was passed.
  assert.match(text, /<Heading tag="h3" data-astro-cid-v5njgcdl>Hi there<\/Heading>/);
  assert.match(text, /<SoakCard \/>/);
  assert.deepEqual([...made.value.kept].sort(), ['Heading', 'SoakCard']);
  // The page's slot content is its own source; a named slot's content loses its slot attribute.
  assert.match(text, /<Button>Go<\/Button>/);
  assert.match(text, /<div class="probe_named" data-astro-cid-v5njgcdl><b>side<\/b><\/div>/);
  // The editor's markers and the dev server's attributes are not the site's.
  assert.doesNotMatch(text, /avb|data-astro-source|button_wrap/);
});

test('a nested component the page cannot write is written as it renders', () => {
  const made = markup.unlinkMarkup(probeInput(RENDERED, { tagFor: (name) => (name === 'Heading' ? undefined : name) }));
  assert.equal(made.ok, true);
  assert.match(made.value.markup, /<h3 data-astro-cid-v5njgcdl="true" class="heading text-style-h3">\s+Hi there\s+<\/h3>/);
  assert.deepEqual([...made.value.kept], ['SoakCard']);
});

test('the region is found by attributes alone where a slot scrubbed the comments', () => {
  const html = `<html><body><div class="layout"><div class="soak-card" data-avb-p="src/components/SoakCard.astro|0 0.0.0.15.0" data-astro-cid-xa34rsyv>
  <h3 class="soak-card_title" data-avb-p="src/components/SoakCard.astro|0.0" data-astro-cid-xa34rsyv>Title {with} &lt;braces&gt;</h3>
</div><p data-avb-p="0.0.0.16">next</p></div></body></html>`;
  const document = parse(html);
  const region = markup.instanceRegion(document, '0.0.0.15.0');
  assert.equal(region.length, 1);
  const made = markup.unlinkMarkup({
    document,
    instancePath: '0.0.0.15.0',
    instanceProps: {},
    children: [],
    component: { file: 'src/components/SoakCard.astro', nodes: [], bindings: new Map() },
    tagFor: () => undefined,
  });
  assert.equal(made.ok, true);
  assert.equal(
    made.value.markup,
    '<div class="soak-card" data-astro-cid-xa34rsyv>\n  <h3 class="soak-card_title" data-astro-cid-xa34rsyv>Title &#123;with&#125; &lt;braces&gt;</h3>\n</div>',
  );
  // A stranger between two roots is another node's: no region.
  const split = parse(`<html><body><i data-avb-p="1">a</i><b>x</b><i data-avb-p="1">c</i></body></html>`);
  assert.equal(markup.instanceRegion(split, '1'), undefined);
  assert.equal(markup.instanceRegion(split, '2'), undefined);
});

test('what plain markup cannot carry is refused, never approximated', () => {
  const one = (inner) =>
    markup.unlinkMarkup({
      document: parse(`<html><body><div data-avb-p="0">${inner}</div></body></html>`),
      instancePath: '0',
      instanceProps: {},
      children: [],
      component: { file: 'src/components/X.astro', nodes: [], bindings: new Map() },
      tagFor: () => undefined,
    });
  assert.deepEqual(one('<script type="module" src="/src/x.ts"></script>'), { ok: false, error: 'script' });
  assert.deepEqual(one('<style>.a{}</style>'), { ok: false, error: 'inline-style' });
  assert.deepEqual(one('<astro-island uid="1"></astro-island>'), { ok: false, error: 'island' });
  assert.deepEqual(one('<img src="/_image?href=%2Fx.png">'), { ok: false, error: 'picture' });
  assert.deepEqual(one('<img srcset="/@fs/Users/x.png 1x">'), { ok: false, error: 'picture' });
  assert.deepEqual(one('<div style="background: url(/src/assets/x.png)"></div>'), { ok: false, error: 'picture' });
  assert.equal(one('<img src="/images/x.png" alt="">').ok, true);
  assert.equal(one('<a href="/src-files/">x</a>').ok, true);
  assert.deepEqual(one('<p :class="x">x</p>'), { ok: false, error: 'unsupported' });
  const nothing = markup.unlinkMarkup({
    document: parse('<html><body><p>other</p></body></html>'),
    instancePath: '0',
    instanceProps: {},
    children: [],
    component: { file: 'src/components/X.astro', nodes: [], bindings: new Map() },
    tagFor: () => undefined,
  });
  assert.deepEqual(nothing, { ok: false, error: 'not-rendered' });
});

test('slot content drawn twice is refused; two roots of one child are one', () => {
  const twice = `<html><body><div data-avb-p="0"><b data-avb-p="0.0">a</b><hr><b data-avb-p="0.0">a</b></div></body></html>`;
  const input = {
    instancePath: '0',
    instanceProps: {},
    children: [{ source: '<b>a</b>', slot: undefined, blank: false }],
    component: { file: 'src/components/X.astro', nodes: [], bindings: new Map() },
    tagFor: () => undefined,
  };
  assert.deepEqual(markup.unlinkMarkup({ ...input, document: parse(twice) }), { ok: false, error: 'slot-twice' });
  const roots = `<html><body><div data-avb-p="0"><b data-avb-p="0.0">a</b> <i data-avb-p="0.0">b</i></div></body></html>`;
  const made = markup.unlinkMarkup({ ...input, document: parse(roots) });
  assert.equal(made.ok, true);
  assert.equal(made.value.markup, '<div><b>a</b> </div>');
});

test('the frontmatter’s prop bindings: const destructuring only, never one assigned again', () => {
  const bindings = source.propBindings(`import X from "./x";
const { title = "Default", "aria-label": label, class: className, count = 3, items = [1, 2], ...rest } = Astro.props as Props;
const other = 1;`);
  assert.deepEqual(Object.fromEntries(bindings), {
    title: { key: 'title', fallback: '"Default"' },
    label: { key: 'aria-label', fallback: undefined },
    className: { key: 'class', fallback: undefined },
    count: { key: 'count', fallback: '3' },
    items: { key: 'items', fallback: '[1, 2]' },
  });
  assert.equal(source.propBindings('let { title } = Astro.props;').size, 0);
  assert.equal(source.propBindings('const { a } = Astro.props; const { b } = Astro.props;').size, 0);
  assert.deepEqual([...source.propBindings('const { a, b } = Astro.props;\nb += 1;\nif (a == 2) {}').keys()], ['a']);
  assert.equal(source.frontmatterOf('<div />'), '');
});

test('a nested component keeps a prop the page passed as an expression, or its literal default', () => {
  const component = parsePage(PROBE, {});
  const page = parsePage(PAGE.replace('title="Hi there"', 'title={pageTitle}'), { locs: true });
  const instance = page.model.nodes[0].children[0];
  const made = markup.unlinkMarkup({
    ...probeInput(RENDERED),
    instanceProps: instance.props,
    component: { file: PROBE_FILE, nodes: component.model.nodes, bindings: source.propBindings(source.frontmatterOf(PROBE)) },
  });
  assert.equal(made.ok, true);
  assert.match(made.value.markup, /<Heading tag="h3" data-astro-cid-v5njgcdl>\{pageTitle\}<\/Heading>/);
  const absent = markup.unlinkMarkup({ ...probeInput(RENDERED), instanceProps: {} });
  assert.match(absent.value.markup, /<Heading tag="h3" data-astro-cid-v5njgcdl>\{"Default"\}<\/Heading>/);
  const spread = markup.unlinkMarkup({ ...probeInput(RENDERED), instanceProps: { '...x': { type: 'spread', value: 'x' } } });
  assert.match(spread.value.markup, /<h3 data-astro-cid-v5njgcdl="true"/);
});

test('slot content loses only its slot attribute; a slot written as code is not carried', () => {
  const page = parsePage(`<X><b class="a" slot="aside" id="b">t</b><i slot={name}>u</i>text</X>`, { locs: true });
  const children = source.slotChildren(page.source ?? `<X><b class="a" slot="aside" id="b">t</b><i slot={name}>u</i>text</X>`, page.model.nodes[0]);
  assert.deepEqual(children[0], { source: '<b class="a" id="b">t</b>', slot: 'aside', blank: false });
  assert.equal(children[1], undefined);
  assert.deepEqual(children[2], { source: 'text', slot: undefined, blank: false });
});

test('imports: rebased from the component’s folder, reused, or aliased past a name in use', () => {
  assert.equal(source.rebasedSpec('./Heading.astro', 'src/components/cards/Card.astro', 'src/pages/index.astro'), '../components/cards/Heading.astro');
  assert.equal(source.rebasedSpec('../ui/Icon.astro', 'src/components/cards/Card.astro', 'src/pages/blog/post.astro'), '../../components/ui/Icon.astro');
  assert.equal(source.rebasedSpec('./x.astro', 'src/pages/a.astro', 'src/pages/b.astro'), './x.astro');
  assert.equal(source.rebasedSpec('@/components/H.astro', 'src/components/Card.astro', 'src/pages/index.astro'), '@/components/H.astro');
  const decl = { name: 'Heading', path: '@/components/H.astro', quote: '"' };
  assert.deepEqual(
    source.pageImportOf(decl, decl.path, [{ name: 'Title', path: '@/components/H.astro', quote: '"' }], 'import Title from "@/components/H.astro";', '"'),
    {
      local: 'Title',
      statement: undefined,
    },
  );
  assert.deepEqual(source.pageImportOf(decl, decl.path, [], 'const Heading = 1;', "'"), {
    local: 'Heading2',
    statement: "import Heading2 from '@/components/H.astro';",
  });
  assert.deepEqual(source.pageImportOf({ name: 'Image', path: 'astro:assets', quote: '"', named: true }, 'astro:assets', [], '', '"'), {
    local: 'Image',
    statement: 'import { Image } from "astro:assets";',
  });
});

test('the page text: the instance replaced, its import kept, made bare or removed, new imports beside it', () => {
  const page = `---\nimport A from "./A.astro";\nimport Probe from "@/components/Probe.astro";\n---\n<A><Probe title="x" /></A>\n`;
  const start = page.indexOf('<Probe');
  const end = page.indexOf('/></A>') + 2;
  const statement = source.importStatementOf(page, { name: 'Probe', path: '@/components/Probe.astro', quote: '"' });
  assert.equal(statement, 'import Probe from "@/components/Probe.astro";');
  const common = { statement, bare: 'import "@/components/Probe.astro";', added: ['import Heading from "@/components/H.astro";'] };
  const bare = source.editedPage(page, { start, end }, '<div>x</div>', { ...common, ownImport: 'bare' });
  assert.equal(
    bare.source,
    `---\nimport A from "./A.astro";\nimport "@/components/Probe.astro";\nimport Heading from "@/components/H.astro";\n---\n<A><div>x</div></A>\n`,
  );
  assert.equal(bare.source.slice(bare.markupAt, bare.markupAt + 12), '<div>x</div>');
  const removed = source.editedPage(page, { start, end }, '<div>x</div>', { ...common, ownImport: 'remove', added: [] });
  assert.equal(removed.source, `---\nimport A from "./A.astro";\n---\n<A><div>x</div></A>\n`);
  assert.equal(removed.source.slice(removed.markupAt, removed.markupAt + 5), '<div>');
  const kept = source.editedPage(page, { start, end }, '<p />', { ...common, ownImport: 'keep', added: [] });
  assert.equal(kept.source, page.replace('<Probe title="x" />', '<p />'));
  assert.equal(source.importStatementOf('---\nimport A, { B } from "./a";\n---', { name: 'A', path: './a', quote: '"' }), undefined);
  assert.equal(source.editedPage(page, { start, end }, 'x', { ...common, statement: 'import Gone from "x";', ownImport: 'bare' }), undefined);
});

const head = '<head><style data-vite-dev-id="/p/page.astro?astro&type=style">.lead[data-astro-cid-page] { color: red; } .x { color: blue; }</style></head>';

test('a page that renders as it did is the same, markers and dev attributes aside', () => {
  const before = parse(`<html>${head}<body><!--avb-s:0--><div class="a" data-avb-p="C|0 0" data-astro-cid-c>Hi  there<!--avb-e:0--></div></body></html>`);
  const after = parse(`<html>${head}<body><div data-astro-source-loc="1:1" class="a" data-avb-p="0" data-astro-cid-c="">Hi <!--x-->there</div></body></html>`);
  assert.deepEqual(compareRenders(before, after), { kind: 'same' });
  const changed = parse(`<html>${head}<body><div class="a b" data-astro-cid-c>Hi there</div></body></html>`);
  assert.equal(compareRenders(before, changed).kind, 'different');
  const text = parse(`<html>${head}<body><div class="a" data-astro-cid-c>Hi here</div></body></html>`);
  assert.equal(compareRenders(before, text).kind, 'different');
  const pre = (inner) => parse(`<html>${head}<body><pre>${inner}</pre></body></html>`);
  assert.equal(compareRenders(pre('a  b'), pre('a b')).kind, 'different');
  const sheets = parse(`<html><head><style data-vite-dev-id="/p/other.css"></style></head><body><div class="a" data-astro-cid-c>Hi there</div></body></html>`);
  assert.deepEqual(compareRenders(before, sheets), { kind: 'different', detail: 'stylesheets' });
});

test('the page’s own scope on the new elements is kept only while none of its scoped rules starts matching', () => {
  const before = parse(`<html>${head}<body><p class="lead" data-astro-cid-page>x</p><div class="a" data-astro-cid-c>y</div></body></html>`);
  const harmless = parse(
    `<html>${head}<body><p class="lead" data-astro-cid-page>x</p><div class="a" data-astro-cid-c data-astro-cid-page>y</div></body></html>`,
  );
  assert.deepEqual(compareRenders(before, harmless), { kind: 'same' });
  const styled = parse(`<html>${head}<body><p class="lead" data-astro-cid-page>x</p><div class="a lead" data-astro-cid-c>y</div></body></html>`);
  const styledAfter = parse(
    `<html>${head}<body><p class="lead" data-astro-cid-page>x</p><div class="a lead" data-astro-cid-c data-astro-cid-page>y</div></body></html>`,
  );
  assert.deepEqual(compareRenders(styled, styledAfter), { kind: 'different', detail: 'page styles' });
  const two = parse(
    `<html>${head}<body><p class="lead" data-astro-cid-page data-astro-cid-z>x</p><div class="a" data-astro-cid-c data-astro-cid-page>y</div></body></html>`,
  );
  assert.equal(compareRenders(before, two).kind, 'different');
});
