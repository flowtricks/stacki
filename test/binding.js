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
  const { valueModeOf, codeParts, templateHoles } = await bundle('src/bindings.js', 'bindings2.bundle.mjs');
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

  // Code that stays code still has data in it, and the data is still drawn as
  // chips — inside the editor, over the text, so the program reads as written.
  const style = 'maxWidth ? `--_mw: ${maxWidth}ch;` : undefined';
  check('an expression like this one keeps the code editor', partsFromValue(expr(style)) === null);
  check(
    'and its hole is found where it sits',
    J(templateHoles(style)) === J([{ from: 19, to: 30, path: 'maxWidth' }]),
    J(templateHoles(style))
  );
  check(
    'every hole in a template, not just the first',
    J(templateHoles('`${a} and ${b.c}`')) ===
      J([{ from: 1, to: 5, path: 'a' }, { from: 10, to: 16, path: 'b.c' }]),
    J(templateHoles('`${a} and ${b.c}`'))
  );
  check(
    'a hole holding an expression is not a chip — no picker could choose it',
    J(templateHoles('`${a + 1}`')) === J([])
  );
  check('an escaped hole is text', J(templateHoles('`\\${notAHole}`')) === J([]));
  check('an unclosed hole is nothing yet', J(templateHoles('`${half')) === J([]));
  check('code with no template has no holes', J(templateHoles('a ?? b')) === J([]));
  // The range covers the whole `${…}`, so repointing swaps the interpolation
  // rather than leaving its braces behind.
  check(
    'the range is the whole interpolation',
    style.slice(19, 30) === '${maxWidth}',
    style.slice(19, 30)
  );

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

  // The field really draws them, and pressing one repoints that hole alone.
  const panel = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx'),
    'utf8'
  );
  check('the code field marks its holes', /chipsOf=\{templateHoles\}/.test(panel));
  check('a press on one opens the picker', /onChipClick=\{\(hit\) => open\(hit\)\}/.test(panel));
  check(
    'and the pick rewrites that hole, not the expression',
    /replaceRange\(chip\.from, chip\.to/.test(panel)
  );
  check(
    'with the press surviving its own mousedown',
    /'\.bind-menu, \.bind-pick, \.expr-chip, \.cm-chip'/.test(panel)
  );

  // ── The chip as it is actually drawn ────────────────────────────────────────
  //
  // A mark over the text would show the syntax as well as the name —
  // `${maxWidth}` in a purple box — which is not the chip the rest of the app
  // draws. This one is drawn INSTEAD of its text, and the text stays in the
  // document underneath: what the field writes back has to come out byte for
  // byte the way it went in.
  const chipDom = await (async () => {
    const entry = path.join(buildDir, 'chip.entry.jsx');
    fs.writeFileSync(
      entry,
      `export { default as ExprInput } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'ui', 'ExprInput.jsx')
      )};\n`
    );
    const out = path.join(buildDir, 'chip.bundle.js');
    await esbuild.build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      loader: { '.jsx': 'jsx' },
      logLevel: 'silent',
    });

    const { JSDOM: JSDOM2 } = require('jsdom');
    const view = new JSDOM2('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
    // Restored below by hand: `navigator` is a getter on the global, so the
    // whole set can't be put back with an assign.
    const prior = { window: global.window, document: global.document };
    global.window = view.window;
    global.document = view.window.document;
    global.MutationObserver = view.window.MutationObserver;
    global.getComputedStyle = view.window.getComputedStyle.bind(view.window);
    global.DOMRect = view.window.DOMRect;
    // CodeMirror's measure loop asks `x instanceof Window`; without the global
    // that check throws from inside jsdom's animation-frame runner, which
    // prints a stack over the test's own output.
    global.Window = view.window.Window;
    global.requestAnimationFrame = view.window.requestAnimationFrame.bind(view.window);
    global.cancelAnimationFrame = view.window.cancelAnimationFrame.bind(view.window);
    global.IS_REACT_ACT_ENVIRONMENT = true;
    // CodeMirror measures; jsdom lays nothing out.
    view.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
    view.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = React;
    const { ExprInput } = require(out);

    const source = 'maxWidth ? `--_mw: ${maxWidth}ch;` : undefined';
    let committed = null;
    const root = createRoot(view.window.document.getElementById('root'));
    await act(async () => {
      root.render(
        React.createElement(ExprInput, {
          value: source,
          syncValue: source,
          chipsOf: templateHoles,
          onCommit: (v) => {
            committed = v;
          },
        })
      );
    });
    await act(async () => {});
    const chips = [...view.window.document.querySelectorAll('.expr-chip')];
    // Blur is what commits, and what it commits is the document itself.
    await act(async () => {
      view.window.document
        .querySelector('.cm-content')
        ?.dispatchEvent(new view.window.FocusEvent('blur'));
    });
    // Unmounted before the globals go back: CodeMirror keeps a measure loop on
    // requestAnimationFrame, and a frame that lands after the DOM it measures
    // has been swapped out throws into jsdom's own callback runner.
    await act(async () => {
      root.unmount();
    });
    global.window = prior.window;
    global.document = prior.document;
    return { chips: chips.map((c) => c.textContent), committed, source };
  })();

  check('the hole is drawn as one chip', chipDom.chips.length === 1, J(chipDom.chips));
  check(
    'showing the name, not the syntax around it',
    chipDom.chips[0] === 'maxWidth',
    J(chipDom.chips[0])
  );
  check(
    'and the value underneath is untouched',
    chipDom.committed === chipDom.source,
    J(chipDom.committed)
  );

  // ── The label activates nothing ─────────────────────────────────────────────
  //
  // A <label> forwards a click to the first control inside it. These labels
  // hold the bind dot and the `{}` toggle, so a press on the empty space beside
  // a prop's name pressed a button — and on a field showing an expression that
  // button means "use the control instead", which drops a value no control can
  // hold. Clicking next to the name cleared the prop.
  {
    const { JSDOM: JSDOM3 } = require('jsdom');
    const page = new JSDOM(
      '<!doctype html><div class="props-field"><label id="lab">' +
        '<span class="prop-label">style</span><button id="btn"></button>' +
        '</label><input></div>'
    );
    const doc = page.window.document;
    const clickLabel = () =>
      doc
        .getElementById('lab')
        .dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    let pressed = 0;
    doc.getElementById('btn').addEventListener('click', () => {
      pressed += 1;
    });
    clickLabel();
    check('a bare label really does press the button inside it', pressed === 1, String(pressed));
    doc.getElementById('lab').addEventListener('click', (e) => e.preventDefault());
    pressed = 0;
    clickLabel();
    check('cancelling the label\'s default stops that', pressed === 0, String(pressed));
    pressed = 0;
    doc
      .getElementById('btn')
      .dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('while a press on the button itself still counts', pressed === 1, String(pressed));
  }
  // …so every label in the panel carries the guard. A new one without it opens
  // the hole again, silently.
  const labels = (panel.match(/<label[ >]/g) || []).length;
  const guarded = (panel.match(/<label onClick=\{noLabelActivation\}>/g) || []).length;
  check('every label in the props panel is guarded', labels === guarded, `${guarded} of ${labels}`);

  if (failures.length) {
    console.error(`\nbinding: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`binding: ${checked} passed`);
})();
