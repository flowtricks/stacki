// Goal: the custom audit matcher finds exactly the declarations and text a project's audit describes, and nothing it must not:
// the owner's two examples (a text-align that applies no var(), and a colour property that applies a core swatch instead of a
// theme variable) over fixture CSS with nested at-rules, shorthands, comments, strings and custom properties; text patterns
// line by line with their exclusion; and every bound (match caps, the time budget, the text size) stops a scan and says so.
// Method: compile the audits through the same guard the app uses, scan fixture texts with `scanCustom`, `customSegments` and
// `scanCustomFiles`, and drive the time budget with a fake clock that jumps past the deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_MATCH_LIMITS, blankStrings, customSegments, markupText, scanCustom, scanCustomFiles } from '#dist/shared/page/auditCustom.js';
import { compileCustomAudit, customAuditPreset } from '#dist/shared/properties/customAudits.js';

const OPEN = { matchesMax: 1_000, deadlineMs: Number.POSITIVE_INFINITY };
const clock = (): number => 0;

function compiled(input: Parameters<typeof compileCustomAudit>[0]) {
  const result = compileCustomAudit(input);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result.value;
}

const textAlign = compiled({
  match: { scope: 'declaration', property: '^text-align$', valueMustMatch: undefined, valueMustNotMatch: 'var\\(' },
  exclude: undefined,
});

const STYLES = `/* text-align: left; in a comment is not a declaration */
.hero { text-align: center; color: red; }
.card { text-align: var(--align); }
.quote::before { content: "text-align: right"; }
@media (min-width: 40em) {
  .nav { TEXT-ALIGN: Left }
  @supports (display: grid) { .grid { text-align:end } }
}
.list { --align: left; text-align: var(--align, start); }
a:hover { text-align: justify; }
.nested { & .child { text-align: right; } }
`;

test('owner example 1: every text-align that applies no var(), in nested at-rules and nested rules, comments and strings ignored', () => {
  const scan = scanCustom(STYLES, textAlign, OPEN, clock);
  assert.equal(scan.stopped, 'complete');
  assert.deepEqual(
    scan.matches.map((match) => match.text),
    ['text-align: center', 'TEXT-ALIGN: Left', 'text-align: end', 'text-align: justify', 'text-align: right'],
  );
  const [first] = scan.matches;
  assert.equal(first?.line, 2);
  assert.equal(first?.declaration?.selector, '.hero');
  assert.equal(STYLES.slice(first?.offset ?? 0).startsWith('center'), true, 'the offset is the value’s, in the original text');
  assert.equal(scan.matches[2]?.declaration?.selector, '.grid');
});

test('owner example 2: colour properties and shorthands that apply a core swatch, not those that apply a theme variable', () => {
  const preset = customAuditPreset('core-swatch-instead-of-theme');
  assert.ok(preset !== undefined);
  const swatch = compiled(preset.audit);
  const css = `
:root { --swatch-red: #f00; --theme-text: var(--swatch-red); }
.a { color: var(--swatch-red); background-color: var(--theme-background); }
.b { border: 1px solid var( --swatch-blue ); outline: 2px solid var(--theme-focus); }
.c { box-shadow: 0 0 0 1px var(--swatch-grey), 0 2px 4px var(--theme-shadow); }
.d { filter: drop-shadow(0 0 2px var(--swatch-black)); text-decoration-color: var(--Swatch-Accent); }
.e { padding: var(--swatch-gap); --button-bg: var(--swatch-red); }
.g { fill: var(--swatch-icon); stroke: currentColor; }
`;
  const found = scanCustom(css, swatch, OPEN, clock).matches.map((match) => match.declaration?.property);
  assert.deepEqual(found, ['color', 'border', 'box-shadow', 'filter', 'text-decoration-color', 'fill']);
});

test('custom properties are declarations: the property pattern decides whether they count', () => {
  const both = compiled({
    match: { scope: 'declaration', property: '^(--[a-z-]+|color)$', valueMustMatch: 'var\\(\\s*--swatch-', valueMustNotMatch: undefined },
    exclude: undefined,
  });
  const scan = scanCustom(':root { --text: var(--swatch-black); } .a { color: var(--swatch-red); }', both, OPEN, clock);
  assert.deepEqual(
    scan.matches.map((match) => match.declaration?.property),
    ['--text', 'color'],
  );
});

test('exclude drops a match whose text also matches it', () => {
  const align = compiled({
    match: { scope: 'declaration', property: '^text-align$', valueMustMatch: undefined, valueMustNotMatch: 'var\\(' },
    exclude: 'inherit|start',
  });
  const scan = scanCustom('.a { text-align: inherit } .b { text-align: start } .c { text-align: left }', align, OPEN, clock);
  assert.deepEqual(
    scan.matches.map((match) => match.text),
    ['text-align: left'],
  );
});

test('text patterns match line by line, with their lines, and skip what exclude names', () => {
  const todo = compiled({ match: { scope: 'markup', pattern: '\\b(TODO|FIXME)\\b' }, exclude: 'TODO\\(ok\\)' });
  const markup = '<div>\n  <!-- TODO hero copy -->\n  <p>FIXME and todo</p>\n  <!-- TODO(ok) -->\n</div>';
  const scan = scanCustom(markup, todo, OPEN, clock);
  assert.deepEqual(
    scan.matches.map((match) => [match.line, match.text]),
    [
      [2, 'TODO'],
      [3, 'FIXME'],
      [3, 'todo'],
    ],
  );
});

test('markup leaves out the frontmatter, styles and scripts, keeping every offset', () => {
  const source = '---\nconst TODO = 1;\n---\n<h1>TODO</h1>\n<style>.a { /* TODO */ }</style>\n<script>// TODO</script>\n';
  const text = markupText(source);
  assert.equal(text.length, source.length);
  assert.equal(text.split('\n').length, source.split('\n').length);
  assert.equal((text.match(/TODO/g) ?? []).length, 1);
  assert.equal(text.indexOf('TODO'), source.indexOf('<h1>TODO') + 4);
});

test('segments: a stylesheet whole, an .astro file’s style blocks or template, nothing for rendered or other files', () => {
  const astro = '---\n---\n<div style="x">a</div>\n<style is:global>\n.a { text-align: left }\n</style>\n';
  const [block] = customSegments('src/pages/index.astro', astro, 'declaration');
  assert.ok(block !== undefined);
  assert.equal(astro.slice(block.offset, block.offset + block.text.length), block.text);
  assert.ok(block.text.includes('text-align: left'));
  assert.equal(customSegments('src/styles/site.css', '.a{}', 'css').length, 1);
  assert.equal(customSegments('src/styles/site.css', '.a{}', 'markup').length, 0);
  assert.equal(customSegments('src/pages/index.astro', astro, 'markup').length, 1);
  assert.equal(customSegments('src/pages/index.astro', astro, 'rendered').length, 0);
  assert.equal(customSegments('src/consts.ts', 'x', 'css').length, 0);
});

test('a scan over files reports the count, the first samples with file lines, and the files it read', () => {
  const files = [
    { file: 'src/styles/site.css', source: '.a { text-align: left }\n.b { text-align: var(--x) }\n.c { text-align: right }\n' },
    { file: 'src/pages/index.astro', source: '---\n---\n<p>x</p>\n<style>\n.d { text-align: center }\n</style>\n' },
  ];
  const scan = scanCustomFiles(files, textAlign, { samplesMax: 2, startedMs: 0 }, clock);
  assert.equal(scan.count, 3);
  assert.equal(scan.files, 2);
  assert.equal(scan.stopped, 'complete');
  assert.deepEqual(scan.samples, [
    { file: 'src/styles/site.css', line: 1, text: 'text-align: left' },
    { file: 'src/styles/site.css', line: 3, text: 'text-align: right' },
  ]);
  const astroOnly = scanCustomFiles([files[1] ?? { file: 'x', source: '' }], textAlign, { samplesMax: 5, startedMs: 0 }, clock);
  assert.equal(astroOnly.samples[0]?.line, 5, 'a style block’s match is on the file’s own line');
});

test('bounds: the match cap, the per-run cap, the time budget and the text size each stop a scan and say why', () => {
  const many = Array.from({ length: 300 }, (_, index) => `.r${index} { text-align: left }`).join('\n');
  const capped = scanCustom(many, textAlign, { matchesMax: CUSTOM_MATCH_LIMITS.matchesPerFileMax, deadlineMs: Number.POSITIVE_INFINITY }, clock);
  assert.equal(capped.matches.length, CUSTOM_MATCH_LIMITS.matchesPerFileMax);
  assert.equal(capped.stopped, 'match-limit');
  let now = 0;
  const late = scanCustom(many, textAlign, { matchesMax: 1_000, deadlineMs: 10 }, () => {
    now += 1; // Each declaration takes "a millisecond": the deadline passes partway through.
    return now;
  });
  assert.equal(late.stopped, 'time-limit');
  assert.ok(late.matches.length < 300);
  const huge = scanCustom('a'.repeat(CUSTOM_MATCH_LIMITS.textCharsMax + 1), textAlign, OPEN, clock);
  assert.equal(huge.stopped, 'too-large');
  assert.equal(huge.matches.length, 0);
  const files = Array.from({ length: 20 }, (_, index) => ({ file: `src/s${index}.css`, source: many }));
  const run = scanCustomFiles(files, textAlign, { samplesMax: 0, startedMs: 0 }, clock);
  assert.equal(run.count, CUSTOM_MATCH_LIMITS.matchesPerRunMax);
  assert.equal(run.stopped, 'match-limit');
});

test('a long line is cut before a pattern sees it, so one call’s cost is bounded by the line bound', () => {
  const tail = compiled({ match: { scope: 'css', pattern: 'needle' }, exclude: undefined });
  const line = `${'x'.repeat(CUSTOM_MATCH_LIMITS.lineCharsMax)}needle`;
  assert.equal(scanCustom(line, tail, OPEN, clock).matches.length, 0);
  assert.equal(scanCustom(`needle${'x'.repeat(5_000)}`, tail, OPEN, clock).matches.length, 1);
});

test('strings are blanked for discovery with their offsets kept', () => {
  const text = `a: "b; c" 'd: e' f`;
  const blank = blankStrings(text);
  assert.equal(blank.length, text.length);
  assert.ok(!blank.includes(';'));
  assert.ok(blank.startsWith('a: "'));
});
