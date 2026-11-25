// Goal: the parser opens, reads and previews every Astro file as the Astro
// compiler reads it, or says exactly why it will not. It never throws, never
// loses an attribute, and never reads the frontmatter's end somewhere else
// than the compiler does.
//
//   node test/electron/parse/parserRobustness.test.js
//
// Method, three layers over one catalogue of awkward sources:
//   1. Outcome: each source is expected to open as an editable tree or to
//      degrade to code with a reason naming the construct. Neither may throw.
//   2. Oracle: for every editable source, the tags and attribute names of the
//      tree (and of the preview's marked copy, markers stripped) equal what
//      @astrojs/compiler's own `parse` reports, so a misread attribute (the
//      `{alternates}` bug class: unquoted values, odd names, duplicates) fails
//      here instead of rendering a different page than the file.
//   3. Fuzz: a seeded generator joins attribute and markup fragments; every
//      result must satisfy 1 and 2. A failure prints its seed and source.
// Offsets of located parses are checked too: every attribute's spans slice the
// text they name, and string values sit between their quotes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const compiler = require('@astrojs/compiler');
const { parsePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { readFence } = require('#dist/electron/parse/astroFence.js');

const FRONT = '---\nconst x = 1;\n---\n';
const STAMP = { file: 'src/pages/x.astro', checksum: 'a'.repeat(64) };

// [name, source, outcome]: 'open' = editable tree, otherwise a regexp the degraded reason must match.
const CASES = [
  ['shorthand', '<Foo {x} />', 'open'],
  ['spread', '<Foo {...Astro.props} />', 'open'],
  ['spread object with a brace string', '<Foo {...{a:1,b:"}"}} />', 'open'],
  ['single quotes', "<div class='a b'></div>", 'open'],
  ['expression with template and brace', '<div class={`a ${x ? "}" : ">"}`}></div>', 'open'],
  ['boolean attributes', '<input disabled checked />', 'open'],
  ['nested braces and strings', '<div data-a={{a: {b: "}"}}} title={"a > b"} />', 'open'],
  ['comment inside an expression attribute', '<div a={/* } */ 1} />', 'open'],
  ['arrow function attribute', '<button onclick={() => { return a > b }}></button>', 'open'],
  ['jsx attribute', '<Foo icon={<svg><path d="M0 0"/></svg>} />', 'open'],
  ['directives', '<Foo client:load set:html={x} define:vars={{a}} class:list={["a",{b:true}]} is:raw />', 'open'],
  ['alpine and vue style names', '<div x-data="{open:false}" @click="open=!open" :class="{a:open}" x-on:click.prevent="x"></div>', 'open'],
  ['unicode attribute name', '<div data-é="1" title="日本語 🎉"></div>', 'open'],
  ['punctuated attribute names', '<Foo #c="3" [x]="1" (y)="2" *z="3" />', 'open'],
  ['namespaced attributes', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>', 'open'],
  ['multiline tag with tabs and CRLF', '<div\n  a="1"\n\tb="2"\r\n  c={3}\n></div>', 'open'],
  ['dotted component', '<Foo.Bar a="1" />\n<Foo.Bar>t</Foo.Bar>', 'open'],
  ['custom element with slot', '<my-element a="1"><span slot="x">y</span></my-element>', 'open'],
  ['fragments', '<>\n  <p>a</p>\n</>\n<Fragment slot="x"><p>b</p></Fragment>', 'open'],
  ['conditional and loop markup', '{x && <p>a</p>}\n<ul>{items.map((i) => <li>{i}</li>)}</ul>', 'open'],
  ['comments and doctype', '<!DOCTYPE html>\n<!-- a > b -->\n<p>x</p>', 'open'],
  [
    'script and style variants',
    '<script is:inline>var a = "</p>";</script>\n<style lang="scss">.a { .b { c: d } }</style>\n<script type="application/ld+json" set:html={j} />',
    'open',
  ],
  ['void elements', '<img src="a">\n<br>\n<meta charset="utf-8">', 'open'],
  ['entities and unicode text', '<p>&lt;a&gt; &amp; &copy; 日本語 🎉 ‮abc‬</p>', 'open'],
  ['unquoted value', '<div id=main></div>', /without quotes/],
  ['unquoted value with slashes', '<a href=/foo/bar>x</a>', /without quotes/],
  ['unquoted value before a self close', '<img src=a/ />', /without quotes/],
  ['backtick value', '<div class=`a ${b}`></div>', /backtick/],
  ['duplicate attribute', '<div a="1" a="2"></div>', /duplicate/],
  ['duplicate spread', '<Foo {...a} {...a} />', /duplicate/],
  ['empty braces', '<Foo {} />', /braces/],
  ['unclosed expression attribute', '<Foo a={1 />', /./],
  ['generic component', '<Foo<string> a="1" />', /./],
  ['autoclosed paragraphs', '<p>a\n<p>b', /unclosed/],
  ['stray closing tag', '<div></div></div>', /./],
  ['unclosed comment', '<!-- never closed\n<p>x</p>', /comment/],
];

// Whole files, frontmatter included.
const FILES = [
  ['no frontmatter', '<p>x</p>\n', 'open'],
  ['only frontmatter', '---\nconst a = 1;\n---\n', 'open'],
  ['empty frontmatter', '---\n---\n<p>x</p>\n', 'open'],
  ['empty file', '', 'open'],
  ['bom and crlf', '﻿---\r\nconst a = 1;\r\n---\r\n<p>x</p>\r\n', 'open'],
  [
    'typescript frontmatter',
    '---\ninterface P { a: string }\nenum E { A }\nconst { a } = Astro.props as P;\nconst o = { a: 1 } satisfies Record<string, number>;\nconst r = await fetch("x");\nconst m = await import("./x.js");\nexport const prerender = false;\n---\n<p>{a}</p>\n',
    'open',
  ],
  ['import attributes', '---\nimport j from "./j.json" with { type: "json" };\nimport k from "./k.json" assert { type: "json" };\n---\n<p>x</p>\n', 'open'],
  ['dashes inside a string on one line', '---\nconst a = "---";\n---\n<p>x</p>\n', 'open'],
  ['dashes line inside a template literal', '---\nconst a = `\n---\n`;\n---\n<p>x</p>\n', 'open'],
  ['dashes line inside a block comment', '---\n/*\n---\n*/\nconst a = 1;\n---\n<p>x</p>\n', 'open'],
  ['blank line before the opening fence', '\n---\nconst a = 1;\n---\n<p>x</p>\n', 'open'],
  ['spaces and tabs before the opening fence', '\t  \n  ---\nconst a = 1;\n---\n<p>x</p>\n', 'open'],
  ['spaces after both fences', '---  \nconst a = 1;\n---  \n<p>x</p>\n', 'open'],
  ['unclosed frontmatter', '---\nconst a = 1;\n<p>x</p>\n', /frontmatter fence/],
  ['four dashes', '----\nconst a = 1;\n----\n<p>x</p>\n', /frontmatter fence/],
  ['code on the opening line', '---const a = 1;\n---\n<p>x</p>\n', /frontmatter fence/],
  ['text after the closing fence', '---\nconst a = 1;\n---body\n<p>x</p>\n', /after the closing/],
  ['closing fence sharing a code line', '---\nconst a = 1; ---\n<p>x</p>\n', /shares its line/],
  ['fence after a comment', '<!-- c -->\n---\nconst a = 1;\n---\n<p>x</p>\n', /after a comment/],
  ['lone dashes', '---', /frontmatter fence/],
];

// What the compiler reports for a source, as `name[attribute,…]` for every tag outside an expression.
function oracleTags(node, out, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'oracleTags: depth limit');
  if (['element', 'component', 'custom-element', 'fragment'].includes(node.type)) {
    const name = node.type === 'fragment' ? 'Fragment' : node.name;
    const attributes = (node.attributes || []).filter((attribute) => !attribute.name.startsWith('data-avb-'));
    const marker = name === 'Fragment' && attributes.length === 1 && attributes[0].name === 'set:html' && attributes[0].value === '""';
    if (!marker && !(name === 'Fragment' && attributes.length === 0)) {
      out.push(`${name}[${attributes.map((attribute) => (attribute.kind === 'spread' ? `...${attribute.name}` : attribute.name)).join(',')}]`);
    }
  }
  if (node.type !== 'expression') {
    for (const child of node.children || []) {
      oracleTags(child, out, depth + 1);
    }
  }
}

function treeTags(nodes, out, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'treeTags: depth limit');
  for (const node of nodes) {
    if (node.kind === 'raw') {
      out.push(`${node.name}[${Object.keys(node.props || {}).join(',')}]`);
    } else if (
      (node.kind === 'element' || node.kind === 'component') &&
      !(node.name === 'Fragment' && node.shorthand && !Object.keys(node.props || {}).length)
    ) {
      out.push(`${node.name}[${(node.attrSpans || []).map((span) => span.name).join(',')}]`);
    }
    if ((node.kind === 'element' || node.kind === 'component') && Array.isArray(node.children)) {
      treeTags(node.children, out, depth + 1);
    }
  }
}

// Every attribute span slices the text it names; a string value sits between its quotes.
function checkSpans(nodes, source, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'checkSpans: depth limit');
  for (const node of nodes) {
    for (const span of node.attrSpans || []) {
      if (span.nameSpan && span.type !== 'spread') {
        assert.equal(source.slice(span.nameSpan.start, span.nameSpan.end), span.name, `name span of ${span.name}`);
      }
      if (span.type === 'string') {
        const quote = source.charAt(span.valueSpan.start - 1);
        assert.ok(quote === '"' || quote === "'", `${span.name} value opens with a quote`);
        assert.equal(source.charAt(span.valueSpan.end), quote, `${span.name} value closes with its quote`);
      }
    }
    if (Array.isArray(node.children)) {
      checkSpans(node.children, source, depth + 1);
    }
  }
}

// Collapses what a page's flow of tags is, ignoring where whitespace sits.
async function checkAgainstCompiler(label, source) {
  const parsed = parsePage(source, { locs: true });
  assert.ok(typeof parsed.editable === 'boolean', `${label}: a verdict`);
  if (!parsed.editable) {
    assert.ok(parsed.reason.length > 0, `${label}: a degraded page says why`);
    return;
  }
  checkSpans(parsed.model.nodes, source);
  const { ast } = await compiler.parse(source);
  if (!ast.children) {
    return;
  }
  const expected = [];
  oracleTags(ast, expected);
  const actual = [];
  treeTags(parsed.model.nodes, actual);
  // Tags inside expressions stay code in the tree; only the tags outside them are compared.
  assert.deepEqual(actual, expected, `${label}: the tree's tags and attributes match the compiler's`);
  const marked = serializePageMarked(parsed.model, '', STAMP, source);
  const strippedMarked = marked.replace(/<!--avb-[^>]*-->/g, '');
  const { ast: markedAst } = await compiler.parse(strippedMarked);
  const seen = [];
  oracleTags(markedAst, seen);
  // The marked copy rewrites shorthand to `name={name}`, which keeps the name.
  assert.deepEqual(seen, expected, `${label}: the preview's copy keeps every tag and attribute`);
}

function checkOutcome(label, source, outcome) {
  const parsed = parsePage(source);
  if (outcome === 'open') {
    assert.equal(parsed.editable, true, `${label}: opens as a tree${parsed.editable ? '' : ` (${parsed.reason})`}`);
  } else {
    assert.equal(parsed.editable, false, `${label}: degrades to code`);
    assert.match(parsed.reason, outcome, `${label}: the reason names the construct`);
  }
}

test('every catalogued markup either opens or degrades with its reason', async () => {
  for (const [name, markup, outcome] of CASES) {
    const source = `${FRONT}${markup}\n`;
    checkOutcome(name, source, outcome);
    await checkAgainstCompiler(name, source);
  }
});

test('every catalogued file either opens or degrades with its reason', async () => {
  for (const [name, source, outcome] of FILES) {
    checkOutcome(name, source, outcome);
    if (name !== 'empty file') {
      await checkAgainstCompiler(name, source);
    }
  }
});

// The fence reader is the one every module shares; where it reads a fence, the
// compiler reads the same code, and where it reads none, the compiler finds none.
test('the fence reader agrees with the compiler on every readable fence', async () => {
  const sources = [...FILES.map(([, source]) => source), ...CASES.map(([, markup]) => `${FRONT}${markup}\n`)];
  for (const source of sources) {
    const fence = readFence(source);
    if (fence.kind === 'unreadable') {
      continue;
    }
    const { ast } = await compiler.parse(source);
    const frontmatter = (ast.children || []).find((node) => node.type === 'frontmatter');
    if (fence.kind === 'none') {
      assert.equal(frontmatter, undefined, `no fence in ${JSON.stringify(source.slice(0, 40))}`);
    } else {
      assert.ok(frontmatter, `a fence in ${JSON.stringify(source.slice(0, 40))}`);
      assert.equal(frontmatter.value.trim(), fence.code.trim(), `the code of ${JSON.stringify(source.slice(0, 40))}`);
    }
  }
});

test('sources past the page limits degrade instead of throwing', () => {
  const sources = [
    `${FRONT}${'<div>'.repeat(5000)}x${'</div>'.repeat(5000)}`,
    `${FRONT}<p>${'{'.repeat(5000)}${'}'.repeat(5000)}</p>`,
    `${FRONT}${'<'.repeat(20000)}`,
    `${FRONT}${'{"'.repeat(5000)}`,
    `${FRONT}${'<!--'.repeat(5000)}`,
    `---\n${Array.from({ length: 5000 }, (_, i) => `import A${i} from "./a${i}";`).join('\n')}\n---\n<A0 />\n`,
  ];
  for (const source of sources) {
    const parsed = parsePage(source);
    assert.equal(typeof parsed.editable, 'boolean');
    if (!parsed.editable) {
      assert.ok(parsed.reason.length > 0);
    }
  }
});

// mulberry32: deterministic, so a failing seed replays exactly.
function rng(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const ATTRIBUTE_FRAGMENTS = [
  'a="1"',
  "b='2'",
  'c={x}',
  'd={{e: {f: "}"}}}',
  '{x}',
  '{...rest}',
  'disabled',
  'data-é="1"',
  ':p="1"',
  '@click="go()"',
  'x:y="1"',
  'client:load',
  'id=main',
  'a="dup"',
  'e={`}${"}"}`}',
  'f={/* } */ 1}',
  'g={() => a > b}',
  '{-}',
  'h=`t`',
  'title="a > b"',
  'class:list={["a", { b }]}',
];
const TAGS = ['div', 'p', 'span', 'Foo', 'Foo.Bar', 'my-el', 'svg', 'img', 'input', 'A'];
const TEXTS = ['text', '{x}', '{x && <b>y</b>}', '{items.map((i) => <li>{i}</li>)}', '<!-- c -->', '&amp; < >', '{"}"}', '\n  ', '日本語'];

function fuzzMarkup(rand, depth) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'fuzzMarkup: depth limit');
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const count = 1 + Math.floor(rand() * 3);
  let out = '';
  for (let i = 0; i < count; i++) {
    if (depth > 3 || rand() < 0.3) {
      out += pick(TEXTS);
      continue;
    }
    const tag = pick(TAGS);
    const attributes = Array.from({ length: Math.floor(rand() * 4) }, () => pick(ATTRIBUTE_FRAGMENTS)).join(rand() < 0.2 ? '\n  ' : ' ');
    const open = `<${tag}${attributes ? ' ' : ''}${attributes}`;
    out += rand() < 0.3 ? `${open} />` : `${open}>${fuzzMarkup(rand, depth + 1)}</${tag}>`;
  }
  return out;
}

test('generated markup never throws, and what opens matches the compiler', async () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rand = rng(seed);
    const source = `${FRONT}${fuzzMarkup(rand, 0)}\n`;
    try {
      await checkAgainstCompiler(`seed ${seed}`, source);
    } catch (failure) {
      throw new Error(`seed ${seed} failed on ${JSON.stringify(source)}: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }
});
