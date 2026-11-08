// A prop hover preview renders one instance with one prop changed, and nothing
// else: not another instance, not another component, not a request without the
// header, and never the file on disk.
//
//   node test/electron/previewServer/variantOverride.test.js
//
// Goal: the override that crosses the canvas message and the dev server header
// (shared/page/variantOverride.ts) parses only what it should, and the marked
// component's first statement applies it only to its target instance, only
// inside the scope the dev server middleware opens for that one request.
//
// Method: the parsers are fed good input and each bad shape (a prototype key, a
// value too long, a non-finite number, a header that is not JSON). The statement
// is then run for real, as the component's frontmatter runs it: a function over a
// fake `Astro.props`, called inside the middleware's `next` (which is where
// Astro renders) and outside it. markCanvasSourceFile is smoke-tested on a
// component on disk: the statement leads its frontmatter, a page never gets
// one, and the file itself is untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseVariantOverride,
  parseVariantMessage,
  parseVariantHeader,
  variantHeaderValue,
  variantOverrideStatement,
  withVariantOverride,
  VARIANT_HEADER,
  VARIANT_LIMITS,
} = require('#dist/shared/page/variantOverride.js');
const { markCanvasSourceFile, markSourceFile, variantScopeMiddleware } = require('#dist/electron/previewServer/previewMarkers.js');

const HEADING = 'src/components/typography/Heading.astro';
const good = { component: HEADING, target: '3', prop: 'variant', value: 'h1' };

test('an override parses only from the shape it has', () => {
  assert.deepEqual(parseVariantOverride(good), good);
  assert.deepEqual(parseVariantOverride({ ...good, value: 3 }), { ...good, value: 3 });
  assert.deepEqual(
    parseVariantOverride({ component: HEADING, target: '3', prop: 'variant' }),
    { ...good, value: undefined },
    'no value renders the prop unset',
  );
  for (const bad of [
    undefined,
    'variant',
    [],
    { ...good, component: '' },
    { ...good, target: 7 },
    { ...good, prop: '__proto__' },
    { ...good, prop: 'constructor' },
    { ...good, prop: 'not a name' },
    { ...good, prop: 'x'.repeat(VARIANT_LIMITS.propCharsMax + 1) },
    { ...good, value: Number.NaN },
    { ...good, value: Number.POSITIVE_INFINITY },
    { ...good, value: true },
    { ...good, value: 'x'.repeat(VARIANT_LIMITS.valueCharsMax + 1) },
    { ...good, component: 'x'.repeat(VARIANT_LIMITS.pathCharsMax + 1) },
  ]) {
    assert.equal(parseVariantOverride(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(parseVariantMessage({ type: 'avb:variant', override: good }), { kind: 'show', override: good });
  assert.deepEqual(parseVariantMessage({ type: 'avb:variant-cancel' }), { kind: 'cancel' });
  assert.deepEqual(parseVariantMessage({ type: 'avb:variant-commit' }), { kind: 'commit' });
  assert.equal(parseVariantMessage({ type: 'avb:variant', override: { ...good, prop: '__proto__' } }), undefined);
  assert.equal(parseVariantMessage({ type: 'avb:patch-now' }), undefined, 'not every canvas message is a preview');
  const header = variantHeaderValue({ ...good, value: 'größe' });
  assert.match(header, /^[\x20-\x7e]+$/, 'the header is ASCII');
  assert.deepEqual(parseVariantHeader(header), { ...good, value: 'größe' });
  assert.equal(parseVariantHeader('%E0%A4%A'), undefined, 'a broken encoding is no override');
  assert.equal(parseVariantHeader('not json'), undefined);
  assert.equal(parseVariantHeader(['a', 'b']), undefined, 'a repeated header is no override');
});

// Runs the statement as a frontmatter would, over these props, inside `override`'s request or none.
function render(props, override) {
  const run = new Function('Astro', variantOverrideStatement(HEADING));
  const Astro = { props: { ...props } };
  const headers = override === undefined ? {} : { [VARIANT_HEADER]: variantHeaderValue(override) };
  variantScopeMiddleware({ headers }, {}, () => run(Astro));
  return Astro.props;
}

test('the statement changes the target instance only, and only inside its request', () => {
  const instance = { 'data-avb-p': '3', variant: 'h2' };
  assert.deepEqual(render(instance, good), { 'data-avb-p': '3', variant: 'h1' });
  assert.deepEqual(render(instance, { ...good, value: undefined }), { 'data-avb-p': '3' }, 'unset removes the prop');
  assert.deepEqual(render({ 'data-avb-p': '3 0.1' }, good), { 'data-avb-p': '3 0.1', variant: 'h1' }, 'the first path is the instance itself');
  assert.deepEqual(render(instance, undefined), instance, 'a request without the header renders as written');
  assert.deepEqual(render(instance, { ...good, target: '4' }), instance, 'another instance is untouched');
  assert.deepEqual(render({ 'data-avb-p': '0.3', variant: 'h2' }, good), { 'data-avb-p': '0.3', variant: 'h2' }, 'a nested path is not the target');
  assert.deepEqual(render(instance, { ...good, component: 'src/components/Other.astro' }), instance, 'another component is untouched');
  assert.deepEqual(render({ variant: 'h2' }, good), { variant: 'h2' }, 'an unmarked instance is untouched');
  const malformed = { 'data-avb-p': '3', variant: 'h2' };
  const run = new Function('Astro', variantOverrideStatement(HEADING));
  const Astro = { props: { ...malformed } };
  variantScopeMiddleware({ headers: { [VARIANT_HEADER]: 'garbage' } }, {}, () => run(Astro));
  assert.deepEqual(Astro.props, malformed, 'a malformed header renders as written');
});

test('withVariantOverride leads the frontmatter, or adds one', () => {
  const statement = variantOverrideStatement(HEADING);
  assert.equal(withVariantOverride('---\nconst a = 1;\n---\n<div />\n', HEADING), `---\n${statement}\nconst a = 1;\n---\n<div />\n`);
  assert.equal(withVariantOverride('<div />\n', HEADING), `---\n${statement}\n---\n<div />\n`);
  assert.equal(statement.includes('\n'), false, 'one line, so the file’s lines move by one at most');
});

test('markCanvasSourceFile adds the check to a component, never to a page, and leaves the file alone', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-variant-'));
  const component = path.join(directory, 'src/components/typography/Heading.astro');
  const page = path.join(directory, 'src/pages/index.astro');
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.mkdirSync(path.dirname(page), { recursive: true });
  const componentText = '---\ninterface Props { variant?: "h1" | "h2" }\nconst { variant = "h2" } = Astro.props;\n---\n<h2 class={variant}><slot /></h2>\n';
  fs.writeFileSync(component, componentText);
  fs.writeFileSync(page, '---\nimport Heading from "../components/typography/Heading.astro";\n---\n<Heading>Hi</Heading>\n');
  try {
    const marked = markCanvasSourceFile(component, [directory]);
    assert.ok(marked, 'the component is marked');
    assert.equal(marked.file, HEADING);
    assert.ok(marked.code.startsWith(`---\n${variantOverrideStatement(HEADING)}\n`), 'the check is the first line');
    assert.ok(marked.code.indexOf(variantOverrideStatement(HEADING)) < marked.code.indexOf('Astro.props;'), 'before the props are read');
    const plain = markSourceFile(component, [directory]);
    assert.equal(plain.code.includes('__avbVariant'), false, 'markSourceFile itself is unchanged (Studio marks with its own)');
    const pageMarked = markCanvasSourceFile(page, [directory]);
    assert.equal(pageMarked.page, true);
    assert.equal(pageMarked.code.includes('__avbVariant'), false, 'a page is never overridden');
    assert.equal(fs.readFileSync(component, 'utf8'), componentText, 'the file on disk is untouched');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The CardVisual case on stacki.build: a closed component whose root is picked by
// `variant` (each option renders a different child component, so there is no
// static root), written into another component's named slot. On a stale Desktop
// the hover preview left the old child on the canvas; the dev server it ran had a
// config generated before the preview existed, so neither the check nor the
// middleware was there. These pin both halves: the marked component applies the
// override before its frontmatter reads `Astro.props`, and Desktop's generated
// config compiles components through markCanvasSourceFile and opens the scope.
test('a component whose root the prop picks, slotted into another, previews its option', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-variant-'));
  const file = 'src/components/site/CardVisual.astro';
  const component = path.join(directory, file);
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.mkdirSync(path.join(directory, 'src/components/site/vignettes'), { recursive: true });
  fs.writeFileSync(
    component,
    [
      '---',
      '/** The visual in a card, picked by `variant`. */',
      'import Navigator from "@/components/site/vignettes/Navigator.astro";',
      'import Style from "@/components/site/vignettes/Style.astro";',
      'interface Props { render?: boolean; variant?: "navigator" | "style"; slot?: string; class?: string }',
      'const { render = true, variant = "navigator", class: className } = Astro.props;',
      '---',
      '',
      '{render && variant === "navigator" && <Navigator class={className} />}',
      '{render && variant === "style" && <Style class={className} />}',
      '',
    ].join('\n'),
  );
  try {
    const marked = markCanvasSourceFile(component, [directory]);
    assert.ok(marked, 'a component with no static root is still marked');
    const statement = variantOverrideStatement(file);
    assert.ok(marked.code.startsWith(`---\n${statement}\n`), 'the check leads the frontmatter, ahead of its doc comment and imports');
    assert.ok(marked.code.indexOf(statement) < marked.code.indexOf('= Astro.props;'), 'before the props are read');
    // The props as the page passes them to an instance in Card's `visual` slot.
    const run = new Function('Astro', statement);
    const Astro = { props: { slot: 'visual', variant: 'navigator', 'data-avb-p': '0.1.1.1.0' } };
    const override = { component: file, target: '0.1.1.1.0', prop: 'variant', value: 'style' };
    variantScopeMiddleware({ headers: { [VARIANT_HEADER]: variantHeaderValue(override) } }, {}, () => run(Astro));
    assert.deepEqual(Astro.props, { slot: 'visual', variant: 'style', 'data-avb-p': '0.1.1.1.0' }, 'the slotted instance renders the hovered option');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const { MARKER_CONFIG_PARTS, renderMarkerConfig } = require('#dist/electron/preview/markerConfig.js');
  const config = renderMarkerConfig(MARKER_CONFIG_PARTS.slice(1).map(() => '"x"'));
  assert.match(config, /const \{[^}]*\bmarkCanvasSourceFile\b[^}]*\bvariantScopeMiddleware\b[^}]*\} = require\(/, 'the config loads both halves');
  assert.match(config, /markCanvasSourceFile\(file, PROJECT_DIRS\)/, 'components compile with the preview check');
  assert.match(config, /server\.middlewares\.use\(variantScopeMiddleware\)/, 'preview requests render inside the scope');
  assert.equal(/\bmarkSourceFile\(/.test(config), false, 'no component compiles without the check');
});
