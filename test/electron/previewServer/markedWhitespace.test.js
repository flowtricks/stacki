// Goal: the canvas's marked copy of a file renders exactly the whitespace the
// file does. A word drawn one letter at a time — `{[...word].map((c) => (
// <span>{c}</span> ))}` with inline-block spans — read "t o d a y" on the
// canvas while the real build showed "today": the marked loop put its
// markers and its <Fragment> wrapper on lines of their own, and every
// newline between them was a text node, so a space, between the letters.
// Method: write components to a temporary project, mark them with
// markSourceFile (what Desktop's dev server and Studio's build compile), then
// compile both the file and its marked copy with Astro 7's compiler and render
// them with Astro's container. With the markers taken out — comments and the
// `data-avb-*` attributes — the two must be the same HTML, character for
// character, so every text node between elements is the same. Loops, both
// conditional forms and expressions are covered, written tight and written
// across lines, plus the inline runs, wrappers and roots around them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { repoPath } = require('../../helpers/sources');
const { markSourceFile } = require('#dist/electron/previewServer/previewMarkers.js');
const { transform } = require(repoPath('studio/node_modules/@astrojs/compiler-rs'));

const FRONTMATTER = '---\nconst word = "today";\nconst items = ["a", "b"];\nconst show = true;\nconst title = "Title";\n---\n';

const CASES = [
  [
    'a loop over inline spans, written across lines',
    '<h2 class="word">\n  {[...word].map((character, index) => (\n    <span class="char" style={`animation-name:a-${index}`}>\n      {character}\n    </span>\n  ))}\n</h2>\n',
  ],
  ['a loop written tight', '<h2>{[...word].map((character) => (<span>{character}</span>))}</h2>'],
  ['a loop without parentheses', '<h2>{items.map((item) => <span>{item}</span>)}</h2>'],
  ['a loop with statements', '<p>{items.map((item) => { const doubled = item + item; return (\n  <b>{doubled}</b>\n); })}</p>'],
  ['a loop with elements side by side', '<div>{items.map((item) => (\n  <b>{item}</b>\n  <i>{item}</i>\n))}</div>'],
  ['a loop wrapped in <> across lines', '<div>{items.map((item) => (<>\n  <b>{item}</b>\n  <i>{item}</i>\n</>))}</div>'],
  ['a loop wrapped in <> tight', '<div>{items.map((item) => (<><b>{item}</b><i>{item}</i></>))}</div>'],
  ['a loop of bare expressions', '<div>{items.map((item) => (<>{item}</>))}</div>'],
  ['a loop of blocks', '<div>{items.map((item) => (\n  <div>\n    <span>{item}</span>\n    <span>{item}</span>\n  </div>\n))}</div>'],
  ['conditionals written tight', '<p>{show && (\n  <span>a</span>\n)}{show ? (\n  <b>x</b>\n) : (\n  <i>y</i>\n)}</p>'],
  ['conditionals across lines', '<div>\n  {show && <span>a</span>}\n  {show && <span>b</span>}\n</div>'],
  ['an expression beside an element, tight', '<div><p>x</p>{title}</div>'],
  ['an expression beside an element, across lines', '<div>\n  <p>x</p>\n  {title}\n</div>'],
  ['an inline run across lines', '<p>\n  <span>a</span>\n  <span>b</span>\n</p>'],
  ['roots side by side', '<span>a</span><span>b</span>'],
  ['roots on lines of their own', '<span>a</span>\n<span>b</span>\n'],
  ['a {/* comment */} on its own', '<div>\n  <p>x</p>\n  {/* A note for the next reader. */}\n  <p>y</p>\n</div>'],
  [
    'a comment inside a branch before its markup',
    '<header>{show ? (\n  /* The breadcrumb: back, then here. */\n  <nav><a href="/">Docs</a></nav>\n) : (\n  <b>x</b>\n)}</header>',
  ],
  ['a comment inside a multi-line expression before markup', '<div>{\n  // Shown first.\n  <i>z</i>\n}</div>'],
  ['a comment between two expressions', '<p>{title}{/* between */}{title /* trailing */}</p>'],
  ['an empty inline element between words', '<p>a<span> </span>b<span></span>c</p>'],
];

// The rendered HTML with the preview's markers taken out: its comments and
// the path and stamp attributes. What is left is the page itself.
const withoutMarkers = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/ data-avb-[pd]="[^"]*"/g, '');

async function renderer() {
  const internalURL = pathToFileURL(repoPath('studio/node_modules/astro/dist/runtime/compiler/index.js')).href;
  const containerURL = pathToFileURL(repoPath('studio/node_modules/astro/dist/container/index.js')).href;
  const { experimental_AstroContainer } = await import(containerURL);
  const container = await experimental_AstroContainer.create({ streaming: false });
  return async (source) => {
    const compiled = await transform(source, { internalURL, filename: '/Case.astro', resolvePath: (specifier) => specifier, resultScopedSlot: true });
    const component = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
    return container.renderToString(component.default, { partial: true });
  };
}

test('a marked component renders the same whitespace as the file', async () => {
  const render = await renderer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-marked-whitespace-'));
  try {
    fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
    for (const [what, template] of CASES) {
      const file = path.join(project, 'src', 'components', 'Case.astro');
      fs.writeFileSync(file, FRONTMATTER + template);
      const marked = markSourceFile(file, [project]);
      assert.ok(marked, `${what}: the file is marked`);
      const markedHtml = await render(marked.code);
      assert.match(markedHtml, /data-avb-p="src\/components\/Case\.astro\|/, `${what}: the marked copy carries its paths`);
      assert.equal(withoutMarkers(markedHtml), withoutMarkers(await render(FRONTMATTER + template)), `${what}: the same text nodes between elements`);
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a word drawn a letter at a time has nothing between its letters', async () => {
  const render = await renderer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-marked-whitespace-'));
  try {
    fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
    const file = path.join(project, 'src', 'components', 'Case.astro');
    fs.writeFileSync(file, FRONTMATTER + (CASES[0] ?? [])[1]);
    const marked = markSourceFile(file, [project]);
    assert.ok(marked, 'the file is marked');
    const html = withoutMarkers(await render(marked.code));
    assert.equal((html.match(/<span class="char"/g) ?? []).length, 5, 'one span per letter');
    assert.doesNotMatch(html, /<\/span>\s+<span/, 'no whitespace between one letter and the next');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// Text editing opens only when the rendering's stamp for the file names the bytes
// the editor holds (electron/preload/frameText.ts): the frame walks the rendered
// document for stamp comments and `data-avb-d` tokens, one checksum per file. With
// markers written against their nodes, the stamp comment is too, so this checks it
// still lands in the DOM whole and names the file's own checksum — for a component
// and for a page, whose stamp follows `</html>`.
test('the rendered stamp names the bytes the editor holds, so text editing can open', async () => {
  const { JSDOM } = require('jsdom');
  const { createHash } = require('node:crypto');
  const { parseStampData, manifestOf } = require('#dist/shared/page/previewToken.js');
  const render = await renderer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-marked-whitespace-'));
  try {
    fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
    const files = [
      ['src/components/Case.astro', FRONTMATTER + (CASES[0] ?? [])[1]],
      ['src/pages/index.astro', `${FRONTMATTER}<html lang="en">\n  <body>\n    <h1>Edit Astro sites visually</h1>\n  </body>\n</html>\n`],
    ];
    for (const [file, source] of files) {
      fs.writeFileSync(path.join(project, file), source);
      const marked = markSourceFile(path.join(project, file), [project]);
      assert.ok(marked, `${file}: marked`);
      const dom = new JSDOM(await render(marked.code));
      try {
        const { document, NodeFilter } = dom.window;
        const stamps = [];
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const data = node.nodeType === 8 ? [node.data] : (node.getAttribute('data-avb-d') ?? '').split('\n');
          stamps.push(...data.map(parseStampData).filter((stamp) => stamp !== undefined));
        }
        const manifest = manifestOf(stamps);
        assert.equal(manifest.ok, true, `${file}: one checksum per file`);
        const checksum = createHash('sha256').update(source).digest('hex');
        assert.deepEqual(
          manifest.value.filter((stamp) => stamp.file === file).map((stamp) => stamp.checksum),
          [checksum],
          `${file}: the rendering is stamped with the source's own checksum`,
        );
      } finally {
        dom.window.close();
      }
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
