// Goal: the dev preview's count of a file's extracted <style> blocks (electron/previewServer/styleBlockScan.ts) is
// Astro's own count, css.length from its compiler, for every template it says it is certain of; and it says
// uncertain, never a wrong count, for templates the compiler might read another way. A count one too low emptied a
// block that exists (1.4.8: `<style is:inline set:html={…} />` before a block read as no block, and the component
// rendered unstyled), so the negative space is the point: self-closing tags, tags in comments, strings, scripts and
// expressions, `>` and `/>` inside attribute values, and tags the compiler rejects.
//
// Method: a table of templates, each with the count it must give (a number, or 'uncertain'). Every certain row is
// also compiled by the real compiler Astro uses (@astrojs/compiler-rs), and the scan's count must equal its
// css.length with no compiler error. Line endings are tested both ways: each row runs as written and again with
// CRLF. A 1 MB file (generated, never read from disk) checks the count at size and that the scan stays linear: the
// same template at a quarter of the size must not take more than a bounded multiple of the time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanStyleBlocks, type StyleBlockScan } from '#dist/electron/previewServer/styleBlockScan.js';

interface Fixture {
  readonly name: string;
  readonly source: string;
  readonly expected: number | 'uncertain';
}

const RED = '<style>.b { color: red; }</style>';

const FIXTURES: readonly Fixture[] = [
  // The 1.4.8 report and its closed twin.
  {
    name: 'self-closing is:inline before a block',
    source: '<div class="repro-a">A</div>\n<style is:inline set:html={"/* inline */"} />\n<style>.repro-a { color: red; }</style>',
    expected: 1,
  },
  {
    name: 'closed is:inline before a block',
    source: '<div class="repro-a">A</div>\n<style is:inline set:html={"/* inline */"}></style>\n<style>.repro-a { color: red; }</style>',
    expected: 1,
  },
  { name: 'self-closing is:inline after a block', source: `${RED}<style is:inline set:html={"x"} />`, expected: 1 },
  { name: 'self-closing is:inline between blocks', source: `<style>.a { color: red; }</style><style is:inline set:html={"x"} />${RED}`, expected: 2 },
  { name: 'several self-closing styles', source: `<style is:inline set:html={"x"} /><style set:html={"y"}/><style is:inline />\n${RED}`, expected: 1 },
  { name: 'a bare self-closing style', source: `<div>A</div>\n<style />\n${RED}`, expected: 1 },
  { name: 'self-closing style in an svg', source: `<svg><style/></svg>${RED}`, expected: 1 },
  // What keeps a block in the markup.
  { name: 'is:inline', source: `<style is:inline>.a {}</style>${RED}`, expected: 1 },
  { name: 'is:inline with a value', source: `<style is:inline={true}>.a {}</style>${RED}`, expected: 1 },
  { name: 'is:inline on its own line', source: `<style\nis:inline>.a {}</style><style\n>.b { color: red; }</style>`, expected: 1 },
  { name: 'is:inline with define:vars', source: `<style is:inline define:vars={{ c: 1 }}>.a {}</style>${RED}`, expected: 1 },
  { name: 'is:inline in capitals is another attribute', source: `<style IS:INLINE>.a {}</style>${RED}`, expected: 2 },
  { name: 'is:inline as a prefix is another attribute', source: '<style is:inlinex>.a { color: red; }</style>', expected: 1 },
  { name: 'is:inline inside a quoted value', source: '<style data-x="is:inline">.a { color: red; }</style>', expected: 1 },
  { name: 'set:html with a body', source: `<style set:html={"x"}>.a { color: red; }</style>${RED}`, expected: 1 },
  { name: 'set:text as a string', source: '<style set:text="x">.a { color: red; }</style>', expected: 0 },
  { name: 'empty block', source: `<style></style>${RED}`, expected: 1 },
  { name: 'white space only, CRLF', source: `<style>\r\n  \t</style>${RED}`, expected: 1 },
  { name: 'no-break space only', source: '<style>\u00A0</style>', expected: 0 },
  { name: 'a comment is CSS', source: `<style>/* x */</style>${RED}`, expected: 2 },
  { name: 'an HTML comment is CSS text', source: `<style><!-- --></style>${RED}`, expected: 2 },
  { name: 'style in an svg', source: `<svg><svg></svg><style>.x { fill: red; }</style></svg>${RED}`, expected: 1 },
  { name: 'style under svg foreignObject', source: '<svg><foreignObject><style>.x { color: red; }</style></foreignObject></svg>', expected: 0 },
  { name: 'style in a template, nested', source: '<template><div><style>.x { color: red; }</style></div></template>', expected: 0 },
  { name: 'style in noscript', source: '<noscript><style>.x { color: red; }</style></noscript>', expected: 0 },
  { name: 'SVG in capitals is not svg', source: '<SVG><style>.x { color: red; }</style></SVG>', expected: 1 },
  // What the compiler extracts like any other block.
  { name: 'is:global', source: '<style is:global>.a { color: red; }</style>', expected: 1 },
  { name: 'define:vars', source: '---\nconst c = "red";\n---\n<style define:vars={{ c }}>.a { color: var(--c); }</style>', expected: 1 },
  { name: 'lang scss', source: '<style lang="scss">.a { color: red; }</style>', expected: 1 },
  { name: 'is:raw on a style', source: '<style is:raw>.a { color: red; }</style>', expected: 1 },
  { name: 'nested in elements', source: '<div><style>.a { color: red; }</style></div>', expected: 1 },
  { name: 'head and body', source: '<html><head><style>.a { color: red; }</style></head><body><style>.b { color: red; }</style></body></html>', expected: 2 },
  { name: 'after </html>', source: '<html><body></body></html>\n<style>.a { color: red; }</style>', expected: 1 },
  { name: 'in a component child', source: '---\nimport C from "./C.astro";\n---\n<C><style>.a { color: red; }</style></C>', expected: 1 },
  { name: 'in a slotted fragment', source: '<Fragment slot="x"><style>.x { color: red; }</style></Fragment>', expected: 1 },
  { name: 'in a short fragment', source: '<><style>.a { color: red; }</style></>', expected: 1 },
  { name: 'in code and pre', source: '<code><style>.x { color: red; }</style></code><pre><style>.y { color: red; }</style></pre>', expected: 2 },
  { name: 'in textarea and title, which are not raw text', source: `<textarea><style>.x { color: red; }</style></textarea><title>${RED}</title>`, expected: 2 },
  { name: 'in math', source: `<math><style>.x {}</style></math>${RED}`, expected: 2 },
  {
    name: 'four kinds in order',
    source: '<style>.a { color: red; }</style><style is:inline>.b {}</style><style is:global>.c { color: red; }</style><style>.d { color: red; }</style>',
    expected: 3,
  },
  // Text that only looks like a block.
  { name: 'in an HTML comment', source: `<!-- <style>.x {}</style> -->\n${RED}`, expected: 1 },
  { name: 'in a {/* */} comment', source: `{/* <style>.x {}</style> */}\n${RED}`, expected: 1 },
  { name: 'in a frontmatter string', source: `---\nconst s = "<style>.x {}</style>";\n---\n${RED}`, expected: 1 },
  { name: 'in a frontmatter template literal', source: '---\nconst s = `<style>${1}</style>`;\n---\n<p />', expected: 0 },
  { name: 'a --- inside a frontmatter string', source: `---\nconst a = "---";\n---\n${RED}`, expected: 1 },
  { name: 'frontmatter after blank lines', source: `\n\n---\nconst a = "<style>x</style>";\n---\n${RED}`, expected: 1 },
  { name: 'in a script string', source: `<script>const s = "<style>.x {}</style>";</script>${RED}`, expected: 1 },
  { name: 'in a script, inserted at run time', source: '<script>document.head.insertAdjacentHTML("beforeend", "<style>.x {}</style>")</script>', expected: 0 },
  { name: 'a </style> in an inline script comment', source: `<script is:inline>/* </style> */</script>${RED}`, expected: 1 },
  { name: 'a <style> in a block', source: `<style>.a { content: "<style>"; }</style>${RED}`, expected: 2 },
  { name: 'in an expression', source: `{true && <style>.a { color: red; }</style>}\n${RED}`, expected: 1 },
  { name: 'in a map', source: `{[1].map(() => <style>.x { color: red; }</style>)}${RED}`, expected: 1 },
  { name: 'in an expression string', source: `{"<style>"}${RED}`, expected: 1 },
  { name: 'in an attribute expression', source: '<C x={<style>.x { color: red; }</style>} />', expected: 0 },
  { name: 'nested template literal in an expression', source: '{`${`}`}`}' + RED, expected: 1 },
  { name: 'a regular expression holding a brace', source: `{/}/.test(x) && 1}${RED}`, expected: 1 },
  { name: 'in an is:raw element', source: `<div is:raw><style>.x { color: red; }</style></div>${RED}`, expected: 1 },
  { name: 'names that start with style', source: `<styles>.x</styles><style-x>y</style-x>${RED}`, expected: 1 },
  // Tags whose attributes hold > or />.
  { name: '> in a quoted value', source: '<style data-x="a>b">.a { color: red; }</style>', expected: 1 },
  { name: '/> in a quoted value', source: '<style data-x="/>">.a { color: red; }</style>', expected: 1 },
  { name: 'nested braces and a } string in an expression value', source: '<style data-x={{ a: { b: "}" } }}>.a { color: red; }</style>', expected: 1 },
  { name: '> in values of other tags', source: `<div class={"a>b"} data-y='c>d'>x</div><img src="a>b">${RED}`, expected: 1 },
  { name: 'a template literal value', source: '<a href=`/x/${1}`>x</a>' + RED, expected: 1 },
  { name: 'a spread holding a brace', source: `<div {...{ a: "}" }}>x</div>${RED}`, expected: 1 },
  { name: 'an unquoted value', source: '<style data-x=a>.b { color: red; }</style>', expected: 1 },
  { name: 'text with < and >', source: `<p>a > b</p><p>a < b</p>${RED}`, expected: 1 },
  { name: 'a doctype', source: `<!DOCTYPE html>${RED}`, expected: 1 },
  { name: 'a closing tag with a space', source: '<style>.b { color: red; }</style >', expected: 1 },
  { name: 'a byte-order mark', source: `\uFEFF${RED}`, expected: 1 },
  { name: 'a byte-order mark as the body is CSS', source: `<style>\uFEFF</style>${RED}`, expected: 2 },
  // Nothing at all.
  { name: 'an empty file', source: '', expected: 0 },
  { name: 'frontmatter only', source: '---\nconst a = 1;\n---\n', expected: 0 },
  { name: 'markup without style', source: '<main><h1>Home</h1></main>\n', expected: 0 },
  { name: 'only inline styles', source: '<style is:inline>.a {}</style><style is:inline set:html={"x"} />', expected: 0 },
  // What the compiler rejects or reads its own way: never a count.
  { name: 'STYLE in capitals', source: '<STYLE>.a { color: red; }</STYLE>', expected: 'uncertain' },
  { name: 'Style in mixed case', source: '<Style>.a { color: red; }</Style>', expected: 'uncertain' },
  { name: '</STYLE> in capitals', source: '<style>.b { color: red; }</STYLE>', expected: 'uncertain' },
  { name: '</SCRIPT> in capitals', source: `<script>a</SCRIPT>${RED}`, expected: 'uncertain' },
  { name: 'an unclosed style', source: '<style>.b { color: red; }', expected: 'uncertain' },
  { name: 'an unclosed comment', source: '<!-- <style>.b { color: red; }</style>', expected: 'uncertain' },
  { name: 'a </style> in CSS comment', source: '<style>/* </style> */.a { color: red; }</style>', expected: 'uncertain' },
  { name: 'a closing tag that is not </style>', source: `<style>.a {}</stylex></style>${RED}`, expected: 'uncertain' },
  { name: 'a stray }', source: `<p>a } b</p>${RED}`, expected: 'uncertain' },
  { name: 'an unclosed svg', source: `<svg>${RED}`, expected: 'uncertain' },
  { name: 'an unclosed p', source: `<p>a<p>b${RED}`, expected: 'uncertain' },
  { name: 'a stray closing tag', source: `</div>${RED}`, expected: 'uncertain' },
  { name: 'a closed void element', source: `<br></br>${RED}`, expected: 'uncertain' },
  { name: 'a CDATA section', source: `<p><![CDATA[ <style>.x {}</style> ]]></p>${RED}`, expected: 'uncertain' },
  { name: 'an unclosed expression', source: `{cond && <p>${RED}`, expected: 'uncertain' },
  { name: 'an unclosed quoted value', source: '<style data-x="a>.b { color: red; }</style>', expected: 'uncertain' },
];

type Compile = (source: string) => { readonly count: number; readonly errors: number };

async function astroCompile(): Promise<Compile> {
  const { transform } = await import('@astrojs/compiler-rs');
  return (source) => {
    const result = transform(source, { filename: '/project/src/components/Fixture.astro', resolvePath: (specifier: string) => specifier });
    return { count: result.css.length, errors: result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length };
  };
}

function described(scan: StyleBlockScan): string {
  return scan.kind === 'certain' ? `certain ${scan.count}` : `uncertain (${scan.reason})`;
}

const crlf = (source: string): string => source.replace(/\r?\n/g, '\r\n');

test('the table covers every case the report and the scan rules name', () => {
  assert.ok(FIXTURES.length >= 40, `${FIXTURES.length} fixtures`);
  assert.equal(new Set(FIXTURES.map((fixture) => fixture.name)).size, FIXTURES.length, 'names are unique');
  assert.ok(
    FIXTURES.some((fixture) => fixture.expected === 'uncertain'),
    'the negative space is in the table',
  );
});

test("every certain count is Astro's own css.length, LF and CRLF", async () => {
  const compile = await astroCompile();
  for (const fixture of FIXTURES) {
    for (const [ending, source] of [
      ['LF', fixture.source],
      ['CRLF', crlf(fixture.source)],
    ] as const) {
      const scan = scanStyleBlocks(source);
      const label = `${fixture.name} (${ending}): scanned ${described(scan)}`;
      if (fixture.expected === 'uncertain') {
        assert.equal(scan.kind, 'uncertain', label);
        continue;
      }
      assert.equal(scan.kind, 'certain', label);
      assert.ok(scan.kind === 'certain');
      assert.equal(scan.count, fixture.expected, label);
      const compiled = compile(source);
      assert.equal(compiled.errors, 0, `${label}: the compiler reads it`);
      assert.equal(scan.count, compiled.count, `${label}: Astro extracts ${compiled.count}`);
    }
  }
});

test('elements locate each block: its tag, its CSS and its attribute names', () => {
  const source = `<p>x</p>\n<style is:inline set:html={"x"} />\n<style is:global lang="css">.a { color: red; }</style>`;
  const scan = scanStyleBlocks(source);
  assert.equal(scan.kind, 'certain', described(scan));
  assert.ok(scan.kind === 'certain');
  assert.equal(scan.elements.length, 2);
  const [inline, global] = scan.elements;
  assert.ok(inline !== undefined);
  assert.ok(global !== undefined);
  assert.equal(source.slice(inline.start, inline.end), '<style is:inline set:html={"x"} />');
  assert.equal(inline.bodyStart, inline.bodyEnd, 'a self-closing tag has no body');
  assert.equal(inline.extracted, false);
  assert.deepEqual(inline.attributes, ['is:inline', 'set:html']);
  assert.equal(source.slice(global.bodyStart, global.bodyEnd), '.a { color: red; }');
  assert.equal(source.slice(global.end - '</style>'.length, global.end), '</style>');
  assert.deepEqual(global.attributes, ['is:global', 'lang']);
  assert.equal(global.extracted, true);
});

// One unit of a large component: markup, an expression with markup inside, a self-closing inline style, a block.
const UNIT =
  '<section class="s"><h2 title="a > b">Title</h2>{items.map((item) => <li>{item}</li>)}<p>Copy &amp; more copy, a < b.</p>' +
  '<style is:inline set:html={"/* inline */"} /></section>\n<style>.s { color: red; }</style>\n';

function generated(sizeChars: number): { readonly source: string; readonly units: number } {
  const units = Math.ceil(sizeChars / UNIT.length);
  return { source: `---\nconst items = [1, 2];\n---\n${UNIT.repeat(units)}`, units };
}

function timedMs(source: string): number {
  const started = performance.now();
  scanStyleBlocks(source);
  return performance.now() - started;
}

test('a 1 MB file is counted whole, in time linear in its size', async () => {
  const large = generated(1024 * 1024);
  const scan = scanStyleBlocks(large.source);
  assert.equal(scan.kind, 'certain', described(scan));
  assert.ok(scan.kind === 'certain');
  assert.equal(scan.count, large.units, 'one block a unit');
  assert.equal(scan.count, (await astroCompile())(large.source).count, "and Astro's count");
  // The best of three runs, so one slow moment on a shared machine is not read as quadratic cost.
  const quarter = generated(256 * 1024).source;
  const quarterMs = Math.min(timedMs(quarter), timedMs(quarter), timedMs(quarter));
  const wholeMs = Math.min(timedMs(large.source), timedMs(large.source), timedMs(large.source));
  assert.ok(wholeMs < 2000, `1 MB scanned in ${Math.round(wholeMs)} ms`);
  // Four times the text: linear is about 4x; quadratic would be 16x.
  assert.ok(wholeMs <= Math.max(quarterMs, 1) * 10, `4x the text took ${Math.round(wholeMs)} ms against ${Math.round(quarterMs)} ms`);
});

test('a file past the scan bound is uncertain, not partly read', () => {
  const scan = scanStyleBlocks(' '.repeat(32 * 1024 * 1024 + 1));
  assert.equal(scan.kind, 'uncertain');
});
