// Goal: text a page prints from data that a call hands back (`home = parse(raw) as HomeData` over a YAML file imported
// as text, `section({ heading: "…" })`, `Object.freeze({…})`) is edited on the canvas by writing the typed words into
// the one string literal or YAML scalar they come from, and nowhere else. The regression this holds: double-clicking
// `{platformIntro.heading}` on a page whose data module is `export const home = parse(raw) as HomeData` showed
// "This text comes from a function call in src/data/home.ts" and wrote nothing.
// Method: in-memory project files shaped like the real project (the YAML module copied verbatim from its shape), the
// real resolver and canvas edit planner, and byte comparisons. Each accepted shape is a table row: trace, edit, and the
// file must equal the expected bytes exactly (every other byte unchanged, the quote style kept); undo writes the old
// bytes back. Escaping is a table over every quote style and the awkward characters a person can type. Each refused
// shape is a row with its reason, its file, its line and the sentence the toast shows, pinned.
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const bound = loadRenderer('src/editor/boundText.ts');
const { canvasBoundEdits } = loadRenderer('src/app/model/canvasBoundText.ts');
const { formatMessage } = loadRenderer('shared/core/i18n/catalog.ts');
const { messages } = loadRenderer('shared/properties/i18n/messages/en/preview.ts');

const PAGE = 'src/pages/index.astro';
const pathFor = (id) => id.replace(/^n/, '');
const WORDS = { saved: (path, file) => `Updated ${path} in ${file}`, undo: 'Undo', sourceChanged: 'changed' };

// The project's data module, as it is written: the YAML file is imported as text and parsed by the `yaml` package.
const HOME_MODULE = [
  'import { parse } from "yaml";',
  'import raw from "./home.yaml?raw";',
  '',
  'export interface HomeData {',
  '  platformIntro: { heading: string; cards: { title: string }[] };',
  '}',
  '',
  'export const home = parse(raw) as HomeData;',
  '',
].join('\n');

const HOME_YAML = [
  'template: home',
  'seo:',
  '  title: "Webflow: The agentic web platform for modern businesses"',
  'platformIntro:',
  '  heading: Webflow is the agentic web marketing platform for high-performing brands # shown first',
  "  quoted: 'It''s single'",
  '  cards:',
  '    - title: Build together',
  '    - title: Publish at scale',
  '  block: |',
  '    Two lines',
  '    of text',
  '  folded: one plain line',
  '    folded onto two',
  '  base: &base Shared words',
  '  alias: *base',
  '  tagged: !!str tagged words',
  '  count: 12',
  '',
].join('\n');

const HOME_PAGE = ['---', 'import { home } from "@/data/home.ts";', '', 'const {', '  seo,', '  platformIntro,', '} = home;', '---', ''].join('\n');

// One project per test: the files a page's imports resolve to, keyed by the specifier the importing file writes.
function homeFiles() {
  return {
    '@/data/home.ts': { file: 'src/data/home.ts', text: HOME_MODULE },
    './home.yaml': { file: 'src/data/home.yaml', text: HOME_YAML },
  };
}

function host(files) {
  return async (fromFile, spec) => {
    const file = files[spec];
    return file === undefined ? undefined : { file: file.file, text: file.text };
  };
}

async function trace(page, expression, files) {
  return bound.resolveBoundText({ page: { file: PAGE, text: page + '<p></p>' }, readModule: host(files) }, expression);
}

// A canvas edit through the real planner, written by a host that keeps an undo history the way Desktop's does.
async function canvasEdit(page, files) {
  const parsed = parsePage(page, { locs: true });
  assert.equal(parsed.editable, true);
  const history = [];
  const fileOf = (name) => Object.values(files).find((entry) => entry.file === name);
  const document = {
    file: PAGE,
    projectPath: '/project',
    source: page,
    nodes: parsed.model.nodes,
    pathFor,
    apply: async () => {},
    report: () => {},
    loadContent: async () => [],
  };
  const result = await canvasBoundEdits(
    document,
    {
      readModule: host(files),
      readFile: async (name) => fileOf(name)?.text,
      writeModule: async ({ file, before, after }) => {
        assert.equal(fileOf(file).text, before, 'a write starts from the bytes the edit read');
        fileOf(file).text = after;
        history.push({ file, before, after });
      },
      undo: async () => {
        const last = history.pop();
        fileOf(last.file).text = last.before;
      },
    },
    WORDS,
  );
  return { result, history };
}

// The sentence the toast shows for a refusal, from the English catalog, the way useCanvasText words it.
function refusalSentence(block, expression) {
  const keys = { call: 'preview.text.source.blocked.call', multiline: 'preview.text.source.blocked.multiline' };
  const key = keys[block.reason] ?? `preview.text.source.blocked.${block.reason}`;
  const place = block.line === undefined ? block.file : `${block.file}:${block.line}`;
  const formatted = formatMessage('en', messages[key], { file: place, path: expression, name: block.name ?? expression });
  assert.equal(formatted.ok, true, key);
  return formatted.value;
}

test('the reported shape: a heading from a YAML file a module parses is edited in the YAML file', async () => {
  const files = homeFiles();
  const page = HOME_PAGE + '<h2>{platformIntro.heading}</h2>';
  const { result, history } = await canvasEdit(page, files);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].bound, { kind: 'source', expression: 'platformIntro.heading', file: 'src/data/home.yaml', uses: 1 });
  assert.equal(result[0].target.value, 'Webflow is the agentic web marketing platform for high-performing brands');
  await result[0].apply('Webflow is the web platform: for brands');
  assert.equal(history.length, 1, 'one write, one undo step');
  const expected = HOME_YAML.replace(
    'heading: Webflow is the agentic web marketing platform for high-performing brands # shown first',
    'heading: "Webflow is the web platform: for brands" # shown first',
  );
  assert.equal(files['./home.yaml'].text, expected, 'only the scalar changed; a ": " made the plain scalar double quoted');
  assert.equal(YAML.parse(files['./home.yaml'].text).platformIntro.heading, 'Webflow is the web platform: for brands');
  assert.equal(files['@/data/home.ts'].text, HOME_MODULE, 'the module that parses the file is untouched');
});

test('undo writes the YAML file back byte for byte', async () => {
  const files = homeFiles();
  const { result, history } = await canvasEdit(HOME_PAGE + '<h2>{platformIntro.heading}</h2>', files);
  await result[0].apply('Fresh words');
  assert.notEqual(files['./home.yaml'].text, HOME_YAML);
  assert.equal(history.length, 1);
  const last = history.pop();
  files['./home.yaml'].text = last.before;
  assert.equal(files['./home.yaml'].text, HOME_YAML);
});

test('each card of a loop over a YAML list is its own edit, written to its own item', async () => {
  const files = homeFiles();
  const page = HOME_PAGE + '{platformIntro.cards.map((card) => (<h3>{card.title}</h3>))}';
  const { result } = await canvasEdit(page, files);
  assert.deepEqual(
    result.map((edit) => edit.target.value),
    ['Build together', 'Publish at scale'],
  );
  await result[1].apply('Ship at scale');
  assert.equal(files['./home.yaml'].text, HOME_YAML.replace('- title: Publish at scale', '- title: Ship at scale'));
});

// Accepted shapes: the module, the expression the page prints, the words typed, and the module as it must read after.
const PAGE_OF = (names) => `---\nimport { ${names} } from "@lib/content";\n---\n`;
const ACCEPTED = [
  {
    shape: 'YAML double-quoted scalar keeps its quotes',
    page: HOME_PAGE,
    expression: 'seo.title',
    typed: 'Webflow: "new" platform',
    files: homeFiles,
    file: './home.yaml',
    before: '"Webflow: The agentic web platform for modern businesses"',
    after: '"Webflow: \\"new\\" platform"',
  },
  {
    shape: 'YAML single-quoted scalar keeps its quotes and doubles a quote',
    page: HOME_PAGE,
    expression: 'platformIntro.quoted',
    typed: "Don't stop",
    files: homeFiles,
    file: './home.yaml',
    before: "'It''s single'",
    after: "'Don''t stop'",
  },
  {
    shape: 'YAML anchor: the anchored scalar is written, the alias reads it',
    page: HOME_PAGE,
    expression: 'platformIntro.base',
    typed: 'New shared',
    files: homeFiles,
    file: './home.yaml',
    before: '&base Shared words',
    after: '&base New shared',
  },
  ...[
    ['default import, YAML.parse', 'import YAML from "yaml";\nimport raw from "./c.yaml?raw";\nexport const data = YAML.parse(raw);\n'],
    ['namespace import, Y.parse', 'import * as Y from "yaml";\nimport raw from "./c.yml?raw";\nexport const data = Y.parse(raw) satisfies Data;\n'],
    ['aliased parse', 'import { parse as readYaml } from "yaml";\nimport raw from "./c.yaml?raw";\nexport const data = (readYaml(raw) as Data);\n'],
    ['js-yaml load', 'import { load } from "js-yaml";\nimport raw from "./c.yaml?raw";\nexport const data = Object.freeze(load(raw));\n'],
  ].map(([shape, module]) => ({
    shape: `YAML through ${shape}`,
    page: PAGE_OF('data'),
    expression: 'data.hero.title',
    typed: 'Edited',
    files: () => ({
      '@lib/content': { file: 'src/lib/content.ts', text: module },
      './c.yaml': { file: 'src/lib/c.yaml', text: 'hero:\n  title: Old words\n' },
      './c.yml': { file: 'src/lib/c.yml', text: 'hero:\n  title: Old words\n' },
    }),
    file: module.includes('c.yml') ? './c.yml' : './c.yaml',
    before: 'Old words',
    after: 'Edited',
  })),
  {
    shape: 'a YAML file imported as data (a bundler plugin)',
    page: '---\nimport home from "./home.yaml";\n---\n',
    expression: 'home.hero.title',
    typed: 'Plugin words',
    files: () => ({ './home.yaml': { file: 'src/pages/home.yaml', text: '# Data\nhero:\n  title: "Old"\n' } }),
    file: './home.yaml',
    before: '"Old"',
    after: '"Plugin words"',
  },
  ...[
    ['an identity function declaration', 'function section<T>(content: T): T {\n  return content;\n}\n'],
    ['an arrow returning a spread copy', 'const section = (content: Section) => ({ ...content, kind: "section" });\n'],
    ['a function expression', 'const section = function (content) {\n  return content;\n};\n'],
    ['a destructured parameter returned by shorthand', 'function section({ heading, body: text }) {\n  return { heading, text };\n}\n'],
  ].map(([shape, helper]) => ({
    shape: `section({ heading: "…" }) through ${shape}`,
    page: PAGE_OF('platformIntro'),
    expression: 'platformIntro.heading',
    typed: 'It\'s "new" \\ ${here} </script> 🚀',
    files: () => ({
      '@lib/content': {
        file: 'src/lib/content.ts',
        text: `${helper}\nexport const platformIntro = section({\n  heading: "Webflow is the agentic platform",\n  body: 'x',\n}) as const;\n`,
      },
    }),
    file: '@lib/content',
    before: '"Webflow is the agentic platform"',
    after: '"It\'s \\"new\\" \\\\ ${here} </script> 🚀"',
  })),
  {
    shape: 'copy("…") where copy returns its argument, single quotes kept',
    page: PAGE_OF('title'),
    expression: 'title',
    typed: "Don't",
    files: () => ({ '@lib/content': { file: 'src/lib/content.ts', text: "const copy = (text: string) => text;\nexport const title = copy('Old');\n" } }),
    file: '@lib/content',
    before: "'Old'",
    after: "'Don\\'t'",
  },
  {
    shape: 'a backtick literal without holes through Object.freeze keeps the backtick and escapes ${',
    page: PAGE_OF('hero'),
    expression: 'hero.title',
    typed: 'Cost ${price}\nnext line',
    files: () => ({ '@lib/content': { file: 'src/lib/content.ts', text: 'export const hero = Object.freeze({ title: `Old` });\n' } }),
    file: '@lib/content',
    before: '`Old`',
    after: '`Cost \\${price}\nnext line`',
  },
  {
    shape: 'nested calls, a spread with an override and an imported helper',
    page: PAGE_OF('hero'),
    expression: 'hero.title',
    typed: 'Override',
    files: () => ({
      '@lib/content': {
        file: 'src/lib/content.ts',
        text: 'import { section } from "./helpers";\nconst base = { title: "Base", kind: "hero" };\nexport const hero = section(Object.freeze({ ...base, title: "Mine" }));\n',
      },
      './helpers': { file: 'src/lib/helpers.ts', text: 'export function section(value) {\n  return value;\n}\n' },
    }),
    file: '@lib/content',
    before: '"Mine"',
    after: '"Override"',
  },
];

test('every accepted shape writes only the literal, in its own quote style, and undo restores the bytes', async () => {
  for (const row of ACCEPTED) {
    const files = row.files();
    const found = await trace(row.page, row.expression, files);
    assert.equal(found.ok, true, `${row.shape}: ${found.ok ? '' : found.block.detail}`);
    const original = files[row.file].text;
    assert.equal(found.site.file, files[row.file].file, row.shape);
    assert.equal(original.slice(found.site.start, found.site.end).endsWith(row.before.replace(/^&base /, '')), true, row.shape);
    const next = bound.rewriteBoundText(original, found.site, row.typed);
    assert.equal(next, original.replace(row.before, row.after), row.shape);
    const again = await trace(row.page, row.expression, { ...files, [row.file]: { ...files[row.file], text: next } });
    assert.equal(again.ok, true, row.shape);
    assert.equal(again.site.value, row.typed, `${row.shape}: the written file reads back as the typed words`);
    // Undo is the old bytes written back: the history keeps them, it never re-encodes.
    assert.equal(original, files[row.file].text, row.shape);
  }
});

// Escaping: every YAML style against the characters that mean something to YAML or to the page.
const AWKWARD = [
  'plain words',
  'Say "hi"',
  "It's",
  'back\\slash',
  'two\nlines',
  'tab\there',
  'Cost ${price}',
  '</script><script>',
  'emoji 🚀 and é',
  'key: value',
  'hash # sign',
  '#first',
  '- dash',
  ' leading space',
  'trailing space ',
  'true',
  '123',
  'null',
  '~',
  '[list]',
  '{map}',
  'a, b',
  '@at',
  '`tick`',
  '\u0007bell',
];

test('every typed text round trips through every YAML scalar style, and the style is kept when it can spell the words', () => {
  const styles = [
    ['yaml-plain', 'Old words'],
    ['yaml-single', "'Old words'"],
    ['yaml-double', '"Old words"'],
  ];
  for (const [quote, raw] of styles) {
    const text = `# Leading comment\nhero:\n  title: ${raw} # trailing comment\n  other: kept\n`;
    const start = text.indexOf(raw);
    const site = { file: 'src/data/home.yaml', start, end: start + raw.length, quote, value: 'Old words', raw };
    for (const typed of AWKWARD) {
      const next = bound.rewriteBoundText(text, site, typed);
      assert.equal(typeof next, 'string', `${quote}: ${JSON.stringify(typed)}`);
      assert.equal(YAML.parse(next).hero.title, typed, `${quote}: ${JSON.stringify(typed)} reads back`);
      assert.equal(YAML.parse(next).hero.other, 'kept');
      assert.equal(next.startsWith('# Leading comment\nhero:\n  title: '), true, 'the bytes before the scalar are kept');
      assert.equal(next.endsWith(' # trailing comment\n  other: kept\n'), true, 'the bytes after the scalar are kept');
      assert.equal(next.split('\n').length, text.split('\n').length, 'the scalar stays on one line');
    }
    const kept = bound.rewriteBoundText(text, site, 'Simple words');
    assert.equal(kept, text.replace(raw, quote === 'yaml-plain' ? 'Simple words' : quote === 'yaml-single' ? "'Simple words'" : '"Simple words"'));
  }
  const plain = { file: 'f.yaml', start: 0, end: 3, quote: 'yaml-plain', value: 'Old', raw: 'Old' };
  assert.equal(bound.encodeStringLiteral('key: value', 'yaml-plain'), '"key: value"', 'a plain scalar that cannot spell the words is double quoted');
  assert.equal(bound.encodeStringLiteral('two\nlines', 'yaml-single'), '"two\\nlines"', 'a newline needs the escape only double quotes have');
  assert.equal(bound.encodeStringLiteral('true', 'yaml-plain'), '"true"', 'a word YAML reads as another type is quoted');
  assert.equal(bound.rewriteBoundText('Old', plain, 'New'), 'New');
});

test('every typed text round trips through every JavaScript quote at a call argument', async () => {
  for (const quote of ['"', "'", '`']) {
    const module = `const copy = (text) => text;\nexport const title = copy(${quote}Old${quote});\n`;
    const files = { '@lib/content': { file: 'src/lib/content.ts', text: module } };
    const found = await trace(PAGE_OF('title'), 'title', files);
    assert.equal(found.ok, true, quote);
    assert.equal(found.site.quote, quote);
    for (const typed of AWKWARD) {
      const next = bound.rewriteBoundText(module, found.site, typed);
      const literal = next.slice(found.site.start, next.length - module.length + found.site.end);
      assert.equal(literal.startsWith(quote), true, `${quote}: ${JSON.stringify(typed)} keeps its quote`);
      assert.equal(bound.decodeStringLiteral(literal), typed, `${quote}: ${JSON.stringify(typed)} reads back`);
      assert.equal(next.slice(0, found.site.start), module.slice(0, found.site.start));
      assert.equal(next.slice(found.site.start + literal.length), module.slice(found.site.end));
    }
  }
});

// Refused shapes: what is written, the reason, the file, the line and the toast's sentence.
const REFUSED = [
  {
    shape: 'a function the project does not write',
    module: 'export const title = make("x");\n',
    expression: 'title',
    reason: 'call',
    line: 1,
    sentence: 'This text is returned by make() in src/lib/content.ts:1, which the editor cannot follow to one string: edit it there.',
  },
  {
    shape: 'a package helper',
    module: 'import { defineContent } from "content-kit";\n\nexport const hero = defineContent({ title: "x" });\n',
    expression: 'hero.title',
    reason: 'call',
    line: 3,
    sentence: 'This text is returned by defineContent() in src/lib/content.ts:3, which the editor cannot follow to one string: edit it there.',
  },
  {
    shape: 'a method call',
    module: 'const words = ["a", "b"];\nexport const title = words.join(", ");\n',
    expression: 'title',
    reason: 'call',
    line: 2,
    sentence: 'This text is returned by words.join() in src/lib/content.ts:2, which the editor cannot follow to one string: edit it there.',
  },
  {
    shape: 'a tagged template',
    module: 'export const title = html`Hi`;\n',
    expression: 'title',
    reason: 'call',
    line: 1,
    sentence: 'This text is returned by html() in src/lib/content.ts:1, which the editor cannot follow to one string: edit it there.',
  },
  {
    shape: 'an awaited fetch',
    module: 'export const page = await fetch("/api").then((response) => response.json());\n',
    expression: 'page.title',
    reason: 'call',
    line: 1,
  },
  {
    shape: 'a YAML parse with options',
    module: 'import { parse } from "yaml";\nimport raw from "./c.yaml?raw";\nexport const data = parse(raw, { merge: true });\n',
    expression: 'data.title',
    reason: 'call',
    line: 3,
  },
  {
    shape: 'a function that joins its argument',
    module: 'const shout = (text) => text + "!";\nexport const title = shout("hi");\n',
    expression: 'title',
    reason: 'concatenation',
    line: 1,
    sentence: 'This text is joined from pieces in src/lib/content.ts:1: edit it there.',
  },
  {
    shape: 'an argument that is a let',
    module: 'let words = "x";\nconst copy = (text) => text;\nexport const title = copy(words);\n',
    expression: 'title',
    reason: 'mutable',
  },
  {
    shape: 'a catalog lookup by a key (t("key"))',
    module: 'const messages = { hello: "Hi" };\nconst t = (key) => messages[key];\nexport const title = t("hello");\n',
    expression: 'title',
    reason: 'computed',
    line: 2,
  },
  {
    shape: 'a call with a spread argument',
    module: 'const parts = ["x"];\nconst copy = (text) => text;\nexport const title = copy(...parts);\n',
    expression: 'title',
    reason: 'call',
    line: 3,
  },
];

test('a value a call computes is refused with its reason, file, line and an accurate sentence', async () => {
  for (const row of REFUSED) {
    const files = {
      '@lib/content': { file: 'src/lib/content.ts', text: row.module },
      './c.yaml': { file: 'src/lib/c.yaml', text: 'title: x\n' },
    };
    const root = row.expression.split('.')[0];
    const found = await trace(PAGE_OF(root), row.expression, files);
    assert.equal(found.ok, false, row.shape);
    assert.equal(found.block.reason, row.reason, `${row.shape}: ${found.block.detail}`);
    assert.equal(found.block.file, 'src/lib/content.ts', row.shape);
    if (row.line !== undefined) {
      assert.equal(found.block.line, row.line, row.shape);
    }
    if (row.sentence !== undefined) {
      assert.equal(refusalSentence(found.block, row.expression), row.sentence, row.shape);
    }
  }
});

test('YAML values that are not one line of text are refused in the YAML file, by line', async () => {
  const rows = [
    ['platformIntro.block', 'multiline', 10, 'This text is a YAML value written over several lines in src/data/home.yaml:10: edit it there.'],
    ['platformIntro.folded', 'multiline', 13],
    ['platformIntro.alias', 'computed', 16],
    ['platformIntro.tagged', 'computed', 17],
    ['platformIntro.count', 'not-text', 18],
    ['platformIntro.nothing', 'missing', 5],
    ['platformIntro.cards[7].title', 'missing', 8],
  ];
  for (const [expression, reason, line, sentence] of rows) {
    const found = await trace(HOME_PAGE, expression, homeFiles());
    assert.equal(found.ok, false, expression);
    assert.equal(found.block.reason, reason, `${expression}: ${found.block.detail}`);
    assert.equal(found.block.file, 'src/data/home.yaml', expression);
    assert.equal(found.block.line, line, expression);
    if (sentence !== undefined) {
      assert.equal(refusalSentence(found.block, expression), sentence);
    }
  }
  const broken = homeFiles();
  broken['./home.yaml'].text = 'platformIntro:\n  heading: a\n  heading: b\n';
  const duplicate = await trace(HOME_PAGE, 'platformIntro.heading', broken);
  assert.equal(duplicate.block.reason, 'unreadable', 'a YAML file with a repeated key is not guessed at');
});

test('a refused text on the canvas carries the line and the function to the toast', async () => {
  const files = { '@lib/content': { file: 'src/lib/content.ts', text: 'export const title = make("x");\n' } };
  const { result } = await canvasEdit(PAGE_OF('title') + '<h1>{title}</h1>', files);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].bound, { kind: 'blocked', expression: 'title', file: 'src/lib/content.ts', reason: 'call', line: 1, name: 'make' });
  await assert.rejects(result[0].apply('x'));
});

test('a YAML scalar two texts print says so, and one write updates both', async () => {
  const files = homeFiles();
  const page = HOME_PAGE + '<h2>{platformIntro.heading}</h2><p>{home.platformIntro.heading}</p>';
  const { result, history } = await canvasEdit(page.replace('import { home }', 'import { home }'), files);
  assert.deepEqual(
    result.map((edit) => edit.bound.uses),
    [2, 2],
  );
  await result[0].apply('Shared heading');
  assert.equal(history.length, 1, 'the YAML file is written once');
});
