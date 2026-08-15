// Data binding: how a prop value carries text and chips together, and what a
// keypress against a chip does.
//
//   node test/binding.js
//
// A bound value is edited as parts — the text someone typed and the data they
// dropped into it — and written back as one of three things: a bare expression
// when it is only a binding, a plain string when it is only text, a template
// literal when it is both. Getting that wrong writes markup that renders the
// wrong thing (`cols="3"` where a number was meant) or, worse, silently turns
// typed text into a binding. The round trips below are the whole contract.
//
// The keypress half is the reason this file needs a DOM: a chip is a
// `contenteditable=false` span, and a caret sitting against one is a position
// the browser's own delete heuristics handle badly — they can take the rest of
// the field with them.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  const bundle = async (rel, name) => {
    const out = path.join(buildDir, name);
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', rel)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      logLevel: 'silent',
    });
    return import(`file://${out}`);
  };

  const { partsFromValue, valueFromParts } = await bundle('src/bindings.js', 'bindings.bundle.mjs');

  // ── values ↔ parts ────────────────────────────────────────────────────────
  const J = JSON.stringify;
  const round = (parts, opts) => partsFromValue(valueFromParts(parts, opts));

  check('a bare path reads as one chip', J(partsFromValue({ type: 'expr', value: 'post.data.pubDate' })) === J([{ expr: 'post.data.pubDate' }]));
  check('a string reads as text', J(partsFromValue({ type: 'string', value: 'Hello' })) === J([{ text: 'Hello' }]));
  check('an unset prop has no parts', J(partsFromValue(undefined)) === J([]));
  check(
    'a template reads as text around its holes',
    J(partsFromValue({ type: 'expr', value: '`Posted ${post.data.pubDate} today`' })) ===
      J([{ text: 'Posted ' }, { expr: 'post.data.pubDate' }, { text: ' today' }])
  );
  check('an indexed path is still a path', J(partsFromValue({ type: 'expr', value: 'posts[0].data.title' })) === J([{ expr: 'posts[0].data.title' }]));

  // Values written as expressions because that is how the prop is written —
  // there is nothing bound in them, and they edit as the text they look like.
  check('a number is text, not a binding', J(partsFromValue({ type: 'expr', value: '12' })) === J([{ text: '12' }]));
  check('true is text, not a binding', J(partsFromValue({ type: 'expr', value: 'true' })) === J([{ text: 'true' }]));
  check('a name that starts with true still binds', J(partsFromValue({ type: 'expr', value: 'trueValue' })) === J([{ expr: 'trueValue' }]));

  // Code no field of chips and text can hold keeps the code editor. (An
  // expression that is only paths and operators does have parts — see the
  // section below.)
  check('a call has no parts', partsFromValue({ type: 'expr', value: 'items.filter(Boolean)' }) === null);
  check('a computed hole makes the whole thing code', partsFromValue({ type: 'expr', value: '`a ${x + 1}`' }) === null);
  check('an unclosed hole is code', partsFromValue({ type: 'expr', value: '`a ${x`' }) === null);

  check('one binding stays one expression', J(valueFromParts([{ expr: 'a.b' }])) === J({ type: 'expr', value: 'a.b' }));
  check('text alone is a string', J(valueFromParts([{ text: 'hi' }])) === J({ type: 'string', value: 'hi' }));
  check('text on a numeric prop stays an expression', J(valueFromParts([{ text: '12' }], { numeric: true })) === J({ type: 'expr', value: '12' }));
  check('an empty field unsets the prop', valueFromParts([{ text: '' }]) === undefined);
  check(
    'text and data together make a template',
    J(valueFromParts([{ text: 'Posted ' }, { expr: 'a.b' }])) === J({ type: 'expr', value: '`Posted ${a.b}`' })
  );

  // Text that looks like template syntax has to survive being written into a
  // template — otherwise typing ${x} turns into a binding on the next read.
  for (const [name, parts] of [
    ['a dollar-brace in typed text', [{ text: 'cost ${x}' }, { expr: 'y' }]],
    ['a backtick in typed text', [{ text: 'a`b' }, { expr: 'y' }]],
    ['a backslash in typed text', [{ text: 'a\\b' }, { expr: 'y' }]],
    ['two chips side by side', [{ expr: 'a' }, { text: ' ' }, { expr: 'b' }]],
  ])
    check(`${name} round trips`, J(round(parts)) === J(parts), J(round(parts)));

  // ── data inside an expression ─────────────────────────────────────────────
  // `a ?? b` is not one thing to bind, it is two with a fallback between them.
  // The data in it chips; the code around it stays text you can edit.
  const { valueModeOf, codeParts } = await bundle('src/bindings.js', 'bindings2.bundle.mjs');
  const expr = (v) => ({ type: 'expr', value: v });

  check(
    'a fallback splits into its two paths',
    J(partsFromValue(expr('post.data.seo.title ?? post.data.title'))) ===
      J([{ expr: 'post.data.seo.title' }, { text: ' ?? ' }, { expr: 'post.data.title' }])
  );
  check(
    'a ternary keeps its operators as text',
    J(partsFromValue(expr('cond ? a.b : c.d'))) ===
      J([{ expr: 'cond' }, { text: ' ? ' }, { expr: 'a.b' }, { text: ' : ' }, { expr: 'c.d' }])
  );
  check('arithmetic chips the value in it', J(partsFromValue(expr('count + 1'))) === J([{ expr: 'count' }, { text: ' + 1' }]));
  check(
    'a name inside a string stays a string',
    J(partsFromValue(expr('x.y ?? "none"'))) === J([{ expr: 'x.y' }, { text: ' ?? "none"' }])
  );
  check('a call is still code', partsFromValue(expr('items.filter(Boolean)')) === null);
  check('an arrow is still code', partsFromValue(expr('items.map(i => i.on)')) === null);
  check('an object literal is still code', codeParts('{ a: b }') === null);
  check('an expression with no data in it is not worth chipping', codeParts('1 + 2') === null);
  check('keywords are not data', J(partsFromValue(expr('a.b ?? null'))) === J([{ expr: 'a.b' }, { text: ' ?? null' }]));

  check('an expression is written back as one', J(valueModeOf(expr('a.b ?? c.d'))) === J('code'));
  check('a plain path is not', J(valueModeOf(expr('a.b'))) === J('text'));
  check('a string is not', J(valueModeOf({ type: 'string', value: 'hi' })) === J('text'));
  check(
    'an expression round trips as written',
    J(valueFromParts(partsFromValue(expr('a.b ?? c.d')), { mode: 'code' })) === J(expr('a.b ?? c.d'))
  );
  check(
    'and the same parts as content would be a template',
    J(valueFromParts([{ expr: 'a.b' }, { text: ' ?? ' }], { mode: 'text' })) ===
      J(expr('`${a.b} ?? `'))
  );

  // ── a keypress against a chip ─────────────────────────────────────────────
  const { deleteChipAtCaret } = await bundle('src/ui/chipKeys.js', 'chipkeys.bundle.mjs');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="host" contenteditable></div></body>');
  global.window = dom.window;
  global.document = dom.window.document;
  const host = document.getElementById('host');

  const chip = (p) => `<span class="expr-chip" contenteditable="false" data-expr="${p}">${p}</span>`;
  const caret = (node, offset) => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  };
  const key = (k, mods) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  const shown = () =>
    [...host.childNodes]
      .map((n) => (n.nodeType === 3 ? J(n.nodeValue) : `[${n.getAttribute('data-expr')}]`))
      .join(' ');

  // The case that made this necessary: chips with no text around them, caret
  // at the end. Left to the browser this took the whole field.
  host.innerHTML = chip('a.b') + chip('c.d') + chip('e.f');
  caret(host, 3);
  check(
    'backspace takes one chip, not the field',
    deleteChipAtCaret(host, key('Backspace')) && shown() === '[a.b] [c.d]',
    shown()
  );

  host.innerHTML = chip('a.b') + 'hello';
  caret(host.childNodes[1], 0);
  check('backspace from the start of text takes the chip before it', deleteChipAtCaret(host, key('Backspace')) && shown() === '"hello"', shown());

  host.innerHTML = chip('a.b') + 'hello';
  caret(host.childNodes[1], 3);
  check('backspace inside text is left to the browser', deleteChipAtCaret(host, key('Backspace')) === false);

  host.innerHTML = `hi ${chip('a.b')} there`;
  caret(host.childNodes[0], 3);
  check('delete takes the chip ahead of the caret', deleteChipAtCaret(host, key('Delete')) && shown() === '"hi " " there"', shown());

  host.innerHTML = 'hi';
  caret(host.childNodes[0], 2);
  check('delete at the end of text is left to the browser', deleteChipAtCaret(host, key('Delete')) === false);

  host.innerHTML = `a${chip('x.y')}b`;
  caret(host.childNodes[2], 0);
  deleteChipAtCaret(host, key('Backspace'));
  const range = window.getSelection().getRangeAt(0);
  check('the caret stays where the chip was', range.startContainer === host && range.startOffset === 1);

  host.innerHTML = chip('a.b');
  caret(host, 1);
  check('a modified backspace is left to the browser', deleteChipAtCaret(host, key('Backspace', { altKey: true })) === false);
  check('other keys are ignored', deleteChipAtCaret(host, key('x')) === false);

  // ── queries the picker writes, and takes back ─────────────────────────────
  const {
    autoQueryName,
    dataTree,
    markedQueries,
    namesInScope,
    queriesInScope,
    removeMarkedQuery,
    QUERY_MARK,
  } = await bundle('src/dataSuggest.js', 'datasuggest.bundle.mjs');

  check('a collection query is named for what it holds', autoQueryName('blog') === 'blogEntries');
  check('a hyphenated collection camel-cases', autoQueryName('case-studies') === 'caseStudiesEntries');
  check('a taken name is stepped past', autoQueryName('blog', new Set(['blogEntries'])) === 'blogEntries2');
  check(
    'an existing query is found so it can be reused',
    queriesInScope('const posts = await getCollection("blog");').get('blog') === 'posts'
  );
  check(
    'getEntry is not a collection query',
    queriesInScope('const one = await getEntry("blog", id);').size === 0
  );
  check(
    'names already bound are known',
    ['posts', 'x', 'Layout'].every((n) =>
      namesInScope('const posts = 1;\nconst { x } = y;', [{ name: 'Layout' }]).has(n)
    )
  );

  // A collection the page doesn't read yet is offered with the name its query
  // WOULD get, so the path is known before anything is written.
  const offered = dataTree({ frontmatter: '', collections: [{ name: 'blog', count: 7 }] });
  check('an unread collection is offered', offered.length === 1 && offered[0].path === 'blogEntries');
  check('it says what it is', offered[0].preview === '7 entries' && offered[0].section === 'collections');
  check('it carries what must be written first', offered[0].query?.collection === 'blog');
  check('and nothing is fetched for it yet', offered[0].lazy === true);
  check(
    'a collection already read is not offered twice',
    dataTree({
      frontmatter: 'const posts = await getCollection("blog");',
      collections: [{ name: 'blog', count: 7 }],
    }).every((n) => n.section !== 'collections')
  );

  // Inside a loop, the item leads: it is what the markup in there is for.
  const inLoop = dataTree({
    frontmatter: 'const { post } = Astro.props;\nconst rows = [{ name: "a" }];',
    ancestorHeads: ['rows.map((row) => ('],
  });
  check('the loop item comes before this file\'s props', inLoop.map((n) => n.key)[0] === 'row', inLoop.map((n) => n.key).join(', '));

  const nested = dataTree({
    frontmatter: 'const rows = [{ cells: [{ v: 1 }] }];',
    ancestorHeads: ['rows.map((row) => (', 'row.cells.map((cell, i) => ('],
  });
  check(
    'and the innermost loop leads the outer one',
    nested.map((n) => n.key).slice(0, 3).join() === 'cell,i,row',
    nested.map((n) => n.key).join(', ')
  );

  // Cleanup only ever considers what Stacki wrote.
  const written = `const a = 1;\nconst blogEntries = await getCollection('blog'); // ${QUERY_MARK}\nconst b = 2;`;
  check('a written query is recognised', markedQueries(written).map((q) => q.name).join() === 'blogEntries');
  check('a hand-written one is not', markedQueries('const posts = await getCollection("blog");').length === 0);
  check(
    'removing one takes its line and nothing else',
    removeMarkedQuery(written, 'blogEntries') === 'const a = 1;\nconst b = 2;'
  );
  check(
    'removing the only line leaves nothing behind',
    removeMarkedQuery(`const x = await getCollection('a'); // ${QUERY_MARK}`, 'x') === ''
  );
  check('removing an unknown name changes nothing', removeMarkedQuery(written, 'nope') === written);

  // ── the write, through the real parser ───────────────────────────────────
  // The picker edits someone's source file. What matters is that what it adds
  // comes back the same way (the marker included, or cleanup could never find
  // it again) and that removing it leaves the file as it was.
  const astro = require(path.join(__dirname, '..', 'electron', 'astroParser.js'));
  const original = [
    '---',
    'import Layout from "@/layouts/BaseLayout.astro";',
    '',
    'const heading = "Hi";',
    '---',
    '<Layout><h1>{heading}</h1></Layout>',
    '',
  ].join('\n');

  // Serializing reformats the template (a one-line <Layout> comes back
  // indented), so the baseline is the file as this parser writes it — the
  // question here is whether adding a query and taking it back changes it.
  const baseline = astro.serializePage(astro.parsePage(original).model);
  const { model } = astro.parsePage(original);
  model.imports.push({
    name: 'getCollection',
    imported: 'getCollection',
    path: 'astro:content',
    quote: "'",
    named: true,
  });
  model.extraFrontmatter += `\nconst blogEntries = await getCollection('blog'); // ${QUERY_MARK}`;
  const file = astro.serializePage(model);

  check('the import is written as a named import', file.includes("import { getCollection } from 'astro:content';"));
  check('the query is written', file.includes("const blogEntries = await getCollection('blog');"));

  const reparsed = astro.parsePage(file).model;
  check('the marker survives a round trip', markedQueries(reparsed.extraFrontmatter).length === 1, reparsed.extraFrontmatter);
  check(
    'the import survives as one entry',
    reparsed.imports.filter((i) => i.name === 'getCollection' && i.path === 'astro:content').length === 1
  );

  // …and taking it back leaves what was there before.
  reparsed.extraFrontmatter = removeMarkedQuery(reparsed.extraFrontmatter, 'blogEntries');
  reparsed.imports = reparsed.imports.filter((i) => i.name !== 'getCollection');
  check(
    'removing it restores the file',
    astro.serializePage(reparsed) === baseline,
    astro.serializePage(reparsed)
  );

  if (failures.length) {
    console.error(`\nbinding: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`binding: ${checked} passed`);
})();
