// Goal: the token settings added for unit and size choices behave as the Audits settings promise, and every raw-value
// finding a `<style>` block yields knows where its declaration is. Pinned: allowed units (em, %, viewport, ch/ex) are fine on
// every property while px, rem and other units keep flagging, token by token inside calc(); widths and heights (physical,
// logical, min and max) are fine unless `sizes` is on; 0 in any unit, 1 and 1px are always fine while 1.5px, 10px and -1px
// are not; `.stacki/audits.json` reads files written before these fields as the old behaviour, tolerates unknown units, and
// writes the new fields only when they differ from the defaults. Line mapping: each finding's offset is into its block's text,
// so the line counted there holds the declaration, whatever precedes the block in the file (frontmatter, markup, an earlier
// block) and however deep the at-rules (@layer, @supports, nesting, ::before, selector lists) go.
// Method: lint small stylesheets under variations of the default rules; parse and serialise audit files written by hand; audit
// an .astro fixture with two style blocks and check every finding's offset, block line and file line against the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintCss } from '#dist/shared/page/auditTokens.js';
import {
  DEFAULT_PLACEHOLDERS,
  DEFAULT_TOKEN_SETTINGS,
  parseAuditIgnoresSource,
  serializeAuditIgnores,
  tokenUnit,
  unitGroupAllowed,
  unitGroupOf,
  withUnitGroup,
} from '#dist/shared/properties/auditIgnores.js';
import { auditFile } from '#dist/shared/page/auditStatic.js';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';

const rules = DEFAULT_TOKEN_SETTINGS;
const kinds = (css: string, settings = rules) => lintCss(css, settings).map((issue) => `${issue.kind}:${issue.token}`);
// A field of a value read back from JSON or the parser, without trusting its shape.
const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);
const withEm = { ...rules, allowedUnits: ['em'] as const };

test('an allowed unit is fine on every property; other units still flag, token by token', () => {
  const select = '.form-select_field { padding-inline-end: 3em; gap: 0.5em; margin: 2em 12px; }';
  assert.deepEqual(kinds(select), ['token-value:3em', 'token-value:0.5em', 'token-value:2em', 'token-value:12px'], 'em is flagged by default, as before');
  assert.deepEqual(kinds(select, withEm), ['token-value:12px']);
  assert.deepEqual(kinds('.a { margin: calc(1em + 2px); padding: calc(2.75rem - var(--x)); }', withEm), ['token-value:2px', 'token-value:2.75rem']);
  assert.deepEqual(kinds('.a { padding: -1em; gap: 1EM; }', withEm), [], 'negative and upper-case em are em');
  assert.deepEqual(kinds('.a { padding: 3em; }', { ...rules, allowedUnits: ['%'] }), ['token-value:3em'], 'allowing % leaves em flagged');
  assert.deepEqual(kinds('.a { padding: 5vw 2vh; }', { ...rules, allowedUnits: ['vw', 'vh'] }), []);
  assert.deepEqual(kinds('.a { --pad: 3em; padding: var(--pad, 2em); }'), [], 'custom properties and var() fallbacks are never flagged');
});

test('widths and heights are fine unless sizes are tracked; then every size property needs a variable', () => {
  const sizes = [
    'width',
    'height',
    'min-width',
    'max-width',
    'min-height',
    'max-height',
    'inline-size',
    'block-size',
    'min-inline-size',
    'max-inline-size',
    'min-block-size',
    'max-block-size',
  ];
  for (const property of sizes) {
    assert.deepEqual(kinds(`.slider_marker { ${property}: 0.75rem; }`), [], `${property} is not flagged by default`);
    assert.deepEqual(
      kinds(`.slider_marker { ${property}: 0.75rem; }`, { ...rules, sizes: true }),
      ['token-value:0.75rem'],
      `${property} is flagged when tracked`,
    );
  }
  assert.deepEqual(kinds('.a { width: 12px; }'), [], 'not even px outside variables');
  const tracked = { ...rules, sizes: true };
  assert.deepEqual(kinds('.a { width: 100%; height: auto; max-width: var(--w); --w: 20rem; }', tracked), [], 'allowed values, var() and definitions');
  assert.deepEqual(kinds('.a { width: calc(var(--w) * 2); max-width: min(22rem, calc(100vw - var(--m) * 2)); }', tracked), [
    'token-value:22rem',
    'token-value:100vw',
  ]);
  assert.deepEqual(kinds('.a { padding: 1.5rem; gap: 12px; }'), ['token-value:1.5rem', 'token-value:12px'], 'spacing keeps its behaviour');
});

test('0 in any unit, 1 and 1px are always fine; other numbers are not', () => {
  assert.deepEqual(kinds('.a { margin-top: 0; margin-bottom: 0px; padding: 0rem 0em 0% -0; gap: 0.0; }'), []);
  assert.deepEqual(kinds('.a { line-height: 1; padding: 1px; margin: 1.0 01; gap: calc(1px + 1rem); }'), ['token-value:1rem']);
  assert.deepEqual(kinds('.a { padding: 1.5px 10px -1px; line-height: 1.5; }'), [
    'token-value:1.5px',
    'token-value:10px',
    'token-value:-1px',
    'token-value:1.5',
  ]);
  assert.deepEqual(kinds('.a { border-width: 1px; outline: 1px solid; top: 4px; }'), ['token-unit:4px']);
});

test('the unit groups: membership, allowing and flagging again, in a stable order', () => {
  assert.equal(tokenUnit('3em'), 'em');
  assert.equal(tokenUnit('-50%'), '%');
  assert.equal(tokenUnit('.5VW'), 'vw');
  assert.equal(tokenUnit('12'), '');
  assert.equal(unitGroupOf('3em'), 'em');
  assert.equal(unitGroupOf('50%'), 'percent');
  assert.equal(unitGroupOf('100dvh'), 'viewport');
  assert.equal(unitGroupOf('60ch'), 'character');
  assert.equal(unitGroupOf('12px'), undefined, 'px has its own switch');
  assert.equal(unitGroupOf('1rem'), undefined, 'rem has its own switch');
  const viewport = withUnitGroup(rules, 'viewport', 'allowed');
  assert.ok(unitGroupAllowed(viewport, 'viewport'));
  const both = withUnitGroup(viewport, 'em', 'allowed');
  assert.deepEqual(both.allowedUnits, ['em', 'vw', 'vh', 'vmin', 'vmax', 'svh', 'dvh', 'lvh']);
  assert.deepEqual(withUnitGroup(both, 'viewport', 'flagged').allowedUnits, ['em']);
  assert.equal(unitGroupAllowed({ allowedUnits: ['vw'] }, 'viewport'), false, 'a group is allowed only when all its units are');
});

test('audits.json: old files read as before, new fields read leniently and are written only when set', () => {
  const old = parseAuditIgnoresSource(JSON.stringify({ version: 2, ignored: [], tokens: { px: true, allowed: ['0'] } }));
  assert.equal(old.tokens.sizes, false, 'an unset sizes reads as off');
  assert.deepEqual(old.tokens.allowedUnits, [], 'an unset allowedUnits allows none');
  const loose = parseAuditIgnoresSource(JSON.stringify({ version: 2, ignored: [], tokens: { allowedUnits: ['EM', 'px', 'rem', 'furlong', 'em', '%'] } }));
  assert.deepEqual(loose.tokens.allowedUnits, ['em', '%'], 'case and repeats do not matter; unknown units, px and rem are dropped');
  assert.throws(() => parseAuditIgnoresSource(JSON.stringify({ version: 2, ignored: [], tokens: { allowedUnits: 'em' } })), /allowedUnits: expected an array/);
  assert.throws(() => parseAuditIgnoresSource(JSON.stringify({ version: 2, ignored: [], tokens: { allowedUnits: [3] } })), /allowedUnits\[0\]/);
  assert.throws(() => parseAuditIgnoresSource(JSON.stringify({ version: 2, ignored: [], tokens: { sizes: 'yes' } })), /tokens\.sizes: expected a boolean/);
  const base = parseAuditIgnoresSource(undefined);
  assert.equal(serializeAuditIgnores(base).includes('tokens'), false, 'defaults write nothing');
  const offOnly = serializeAuditIgnores({ ...base, tokens: { ...base.tokens, px: false } });
  assert.equal(offOnly.includes('allowedUnits'), false, 'an empty list is left out, so an older Stacki still reads the file');
  assert.equal(offOnly.includes('sizes'), false, 'sizes off is left out');
  const set = { ...base, tokens: { ...withUnitGroup(base.tokens, 'em', 'allowed'), sizes: true } };
  const written = serializeAuditIgnores(set);
  const tokens: unknown = field(JSON.parse(written), 'tokens');
  assert.deepEqual(field(tokens, 'allowedUnits'), ['em']);
  assert.equal(field(tokens, 'sizes'), true);
  assert.deepEqual(parseAuditIgnoresSource(written).tokens, set.tokens, 'what is written reads back');
});

const FIXTURE = [
  '---',
  "const { label = 'Choose' } = Astro.props;",
  '---',
  '<div class="form-select">',
  '  <select class="form-select_field"><option>{label}</option></select>',
  '  <span class="form-select_mark"></span>',
  '</div>',
  '<style is:global>',
  '  @layer components {',
  '    .form-select_field { padding-inline-end: 3em; }',
  '    .form-select_mark { inset-inline-end: 1em; top: 50%; rotate: 90deg; }',
  '    @supports (appearance: base-select) {',
  '      .form-select_field, .form-select_other { gap: 0.5em; }',
  '      .form-select_field::picker(select) { padding: 12px; }',
  '    }',
  '  }',
  '</style>',
  '<style is:global>',
  '  @layer components {',
  '    .form-select { &:has(:focus) { margin-top: 0.25rem; } }',
  '    .form-select::before { padding-block: 2px; }',
  '  }',
  '</style>',
].join('\n');

test('every raw value in a style block knows its block, its offset there and its line in the file', () => {
  const parsed = parsePageResult(parsePage(FIXTURE, { locs: true }));
  assert.ok(parsed.editable);
  const findings = auditFile(
    {
      file: 'src/components/Select.astro',
      kind: 'component',
      nodes: parsed.model.nodes,
      imports: parsed.model.imports,
      frontmatter: '',
      source: FIXTURE,
      route: undefined,
    },
    {
      routes: ['/'],
      publicFiles: new Map(),
      imageSizes: new Map(),
      site: { title: undefined, description: undefined, lang: undefined },
      noindexRoutes: [],
      tokens: rules,
      variables: new Map(),
      placeholders: DEFAULT_PLACEHOLDERS,
    },
  ).findings.filter((finding) => finding.check === 'token-value');
  assert.deepEqual(
    findings.map((finding) => `${finding.css?.selector} { ${finding.css?.property}: ${finding.css?.token} }`),
    [
      '.form-select_field { padding-inline-end: 3em }',
      '.form-select_field, .form-select_other { gap: 0.5em }',
      '.form-select_field::picker(select) { padding: 12px }',
      '&:has(:focus) { margin-top: 0.25rem }',
      '.form-select::before { padding-block: 2px }',
    ],
    'inset, top and rotate are not covered properties; everything inside @layer, @supports, nesting and pseudo-elements is found',
  );
  const lines = FIXTURE.split('\n');
  for (const finding of findings) {
    const css = finding.css;
    assert.ok(css !== undefined);
    assert.equal(css.place?.tag, 'style-block');
    if (css.place?.tag !== 'style-block') {
      continue;
    }
    const block: unknown = parsed.model.nodes[css.place.path[0] ?? -1];
    assert.equal(field(block, 'kind'), 'raw', 'the place names the style block');
    const inner: unknown = field(block, 'inner');
    assert.ok(typeof inner === 'string');
    assert.equal(inner.slice(css.place.offset, css.place.offset + css.token.length), css.token, 'the offset is the token, in the block');
    const blockLine = inner.slice(0, css.place.offset).split('\n').length;
    assert.ok(inner.split('\n')[blockLine - 1]?.includes(`${css.property}: ${css.value}`), 'the block line holds the declaration');
    assert.ok(css.line !== undefined && lines[css.line - 1]?.includes(`${css.property}: ${css.value}`), 'the file line holds it too');
  }
});
