// Goal: a data file's new variable is written in the file's own style and place, and a
// file the edit cannot be made safely in is refused with the bytes untouched. The style
// read from the existing constants (quotes, semicolons, `as const`, annotations,
// description comments, blank-line grouping, indent, CRLF, naming) is what the new line
// uses; it lands after the last exported constant of a module, or the last `const` of a
// page's frontmatter, never in the markup; a page with no frontmatter gets a fence; an
// invalid, reserved or taken name and a syntax error are refused; a removal takes the
// statement's lines and is refused while the name is used; an add then a remove gives the
// original text back (the undo pair's two sides). A reorder moves each constant with the
// comments directly above it and after it on its line, keeps blank lines and other code in
// place, refuses an order that reads a constant before it is declared, and a move and the
// move back give the original text.
// Method: insertConstant, removeConstant, readConstants and styleOfConstants run over
// literal sources, each case asserting the exact output text, or the refusal and that
// nothing else came back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  constantFileOf,
  insertConstant,
  readConstants,
  removeConstant,
  reorderConstants,
  styleOfConstants,
  type ConstantFile,
} from '#dist/electron/parse/constantFields.js';
import type { ConstantField } from '#dist/shared/properties/cmsConstants.js';
import { data } from '#dist/shared/core/boundary.js';

// JSON's null, as a typed JSON value carries it.
const JSON_NULL = data(JSON.parse('null'));
const MODULE: ConstantFile = { host: 'module', script: 'ts' };
const PAGE: ConstantFile = { host: 'page', script: 'ts' };

function added(source: string, field: ConstantField, file: ConstantFile = MODULE): string {
  const style = styleOfConstants(source, file);
  assert.ok(style.ok, `the style is read (${style.ok ? '' : style.error})`);
  const result = insertConstant(source, field, style.value);
  assert.ok(result.ok, `the field is added (${result.ok ? '' : result.error})`);
  return result.value;
}

function refusedAdd(source: string, field: ConstantField, file: ConstantFile = MODULE): string {
  const style = styleOfConstants(source, file);
  if (!style.ok) {
    return style.error;
  }
  const result = insertConstant(source, field, style.value);
  assert.equal(result.ok, false, 'the add is refused');
  return result.ok ? '' : result.error;
}

test('a single-quoted, semicolon module gets the same quotes and semicolon after its last export', () => {
  const source = "export const SITE_TITLE = 'Astro Blog';\nexport const SITE_DESCRIPTION = 'Welcome!';\n";
  assert.equal(
    added(source, { name: 'SITE_TAGLINE', value: "It's new" }),
    "export const SITE_TITLE = 'Astro Blog';\nexport const SITE_DESCRIPTION = 'Welcome!';\nexport const SITE_TAGLINE = 'It\\'s new';\n",
  );
});

test('a file without semicolons and with double quotes stays that way', () => {
  const source = 'export const A = "one"\nexport const B = "two"\n';
  assert.equal(added(source, { name: 'C', value: 3 }), 'export const A = "one"\nexport const B = "two"\nexport const C = 3\n');
});

test('`as const`, annotations and description comments follow the file when most constants have them', () => {
  const asConst = 'export const A = ["a"] as const;\nexport const B = { b: 1 } as const;\n';
  assert.equal(added(asConst, { name: 'C', value: true }), asConst + 'export const C = true as const;\n');
  const annotated = 'export const A: string = "a";\nexport const B: number = 2;\n';
  assert.equal(added(annotated, { name: 'C', value: ['x', 'y'] }), annotated + 'export const C: string[] = ["x", "y"];\n');
  const described = '/** The name. */\nexport const A = "a";\n\n/** The count. */\nexport const B = 2;\n';
  assert.equal(
    added(described, { name: 'C', value: 'c', description: 'The tagline */ here' }),
    described + '\n/** The tagline * / here */\nexport const C = "c";\n',
  );
  // A JavaScript file never gets TypeScript syntax, whatever the style says.
  const js = 'export const A = "a";\n';
  const style = styleOfConstants(js, { host: 'module', script: 'js' });
  assert.ok(style.ok);
  const written = insertConstant(js, { name: 'B', value: 1 }, { ...style.value, asConst: true, typeAnnotations: true });
  assert.ok(written.ok);
  assert.equal(written.value, js + 'export const B = 1;\n');
});

test('blank-line grouping, comments, imports and other code are kept, and the line follows the last export', () => {
  const source = [
    "import { x } from './x';",
    '',
    '// Site settings.',
    'export const SITE = "s"; // the name',
    '',
    'export const URL = "u";',
    '',
    'export function helper() {',
    '  return x;',
    '}',
    '',
  ].join('\n');
  assert.equal(
    added(source, { name: 'LOCALE', value: 'en' }),
    source.replace('export const URL = "u";', 'export const URL = "u";\n\nexport const LOCALE = "en";'),
  );
  // A trailing comment on the last constant's line stays on that line.
  const commented = 'export const A = 1; // first\n';
  assert.equal(added(commented, { name: 'B', value: 2 }), 'export const A = 1; // first\nexport const B = 2;\n');
});

test('CRLF files are written with CRLF, and long arrays and objects break the way the file indents', () => {
  const source = 'export const A = {\r\n    one: 1,\r\n};\r\n';
  const value = { title: 'A long enough title to break the line', subtitle: 'And a subtitle that pushes it past eighty columns' };
  assert.equal(
    added(source, { name: 'B', value }),
    source +
      'export const B = {\r\n    title: "A long enough title to break the line",\r\n    subtitle: "And a subtitle that pushes it past eighty columns",\r\n};\r\n',
  );
  assert.equal(
    added('export const A = 1;\n', { name: 'B', value: { 'two words': [1, JSON_NULL] } }),
    'export const A = 1;\nexport const B = { "two words": [1, null] };\n',
  );
});

test('a file with no constants gets the defaults: double quotes, semicolons, export const at the end', () => {
  assert.equal(added('', { name: 'SITE', value: 'x' }), 'export const SITE = "x";\n');
  assert.equal(added("import a from 'a';\n", { name: 'SITE', value: 'x' }), "import a from 'a';\n\nexport const SITE = 'x';\n");
  const read = readConstants('', MODULE);
  assert.ok(read.ok);
  assert.equal(read.value.style.naming, 'screamingSnake');
  assert.equal(read.value.style.quote, 'double');
  assert.equal(read.value.style.semicolons, true);
});

test('invalid, reserved and taken names are refused, and so is a file with a syntax error', () => {
  const source = "import { thing } from './thing';\nexport const TAKEN = 1;\nfunction helper() {}\n";
  assert.equal(refusedAdd(source, { name: '1st', value: 1 }), 'invalidName');
  assert.equal(refusedAdd(source, { name: 'has space', value: 1 }), 'invalidName');
  assert.equal(refusedAdd(source, { name: '', value: 1 }), 'invalidName');
  assert.equal(refusedAdd(source, { name: 'class', value: 1 }), 'reservedName');
  assert.equal(refusedAdd(source, { name: 'TAKEN', value: 1 }), 'duplicateName');
  assert.equal(refusedAdd(source, { name: 'thing', value: 1 }), 'duplicateName');
  assert.equal(refusedAdd(source, { name: 'helper', value: 1 }), 'duplicateName');
  assert.equal(refusedAdd('export const A = {;\n', { name: 'B', value: 1 }), 'syntax');
  assert.equal(readConstants('export const A = (;\n', MODULE).ok, false);
});

test('a page gets the variable inside its frontmatter after the last const, never in the markup', () => {
  const page = [
    '---',
    "import Layout from '../layouts/Layout.astro';",
    'interface Props { title: string }',
    'const { title } = Astro.props;',
    "const heading = 'Hello';",
    "const NOT_IN_MARKUP = 'x';",
    '---',
    '<Layout title={title}><h1>{heading}</h1></Layout>',
    '',
  ].join('\n');
  const result = added(page, { name: 'subtitle', value: 'World' }, PAGE);
  assert.equal(result, page.replace("const NOT_IN_MARKUP = 'x';\n", "const NOT_IN_MARKUP = 'x';\nconst subtitle = 'World';\n"));
  // Astro and the page's imports are taken names.
  assert.equal(refusedAdd(page, { name: 'Astro', value: 1 }, PAGE), 'duplicateName');
  assert.equal(refusedAdd(page, { name: 'Layout', value: 1 }, PAGE), 'duplicateName');
  // A frontmatter with only imports ends with the new line, a blank line below them.
  const importsOnly = "---\nimport A from './A.astro';\n---\n<A />\n";
  assert.equal(added(importsOnly, { name: 'title', value: 'T' }, PAGE), "---\nimport A from './A.astro';\n\nconst title = 'T';\n---\n<A />\n");
  // An empty fence holds just the new line.
  assert.equal(added('---\n---\n<p />\n', { name: 'title', value: 'T' }, PAGE), '---\nconst title = "T";\n---\n<p />\n');
});

test('a page without frontmatter gets a fence at the top; an unreadable fence is refused', () => {
  assert.equal(added('<h1>Hi</h1>\n', { name: 'title', value: 'Hi' }, PAGE), '---\nconst title = "Hi";\n---\n<h1>Hi</h1>\n');
  assert.equal(refusedAdd('---\nconst a = 1;\n<h1>never closed</h1>\n', { name: 'b', value: 2 }, PAGE), 'fence');
});

test('names follow the file: SCREAMING_SNAKE, camelCase, or a mix', () => {
  const naming = (source: string, file: ConstantFile) => {
    const read = readConstants(source, file);
    assert.ok(read.ok);
    return read.value.style.naming;
  };
  assert.equal(naming('export const SITE_NAME = 1;\nexport const URL = 2;\n', MODULE), 'screamingSnake');
  assert.equal(naming('export const siteName = 1;\nexport const url = 2;\n', MODULE), 'camel');
  assert.equal(naming('export const siteName = 1;\nexport const URL_BASE = 2;\n', MODULE), 'mixed');
  assert.equal(naming('---\n---\n', PAGE), 'camel');
});

test('the listing names each variable with its type and a preview, and every top-level name as taken', () => {
  const read = readConstants(
    'import x from "x";\nexport const A = "a";\nexport const B = -2;\nexport const C = [1];\nexport const D = { d: 1 } as const;\nexport const E = x();\nconst F = 1;\n',
    MODULE,
  );
  assert.ok(read.ok);
  assert.deepEqual(
    read.value.fields.map((field) => [field.name, field.type, field.preview]),
    [
      ['A', 'string', '"a"'],
      ['B', 'number', '-2'],
      ['C', 'array', '[1]'],
      ['D', 'object', '{ d: 1 } as const'],
      ['E', 'code', 'x()'],
    ],
  );
  assert.deepEqual([...read.value.taken].sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'x']);
});

test('a removal takes the statement, its comment and one blank line, and is refused while the name is used', () => {
  const source = 'export const A = 1;\n\n/** Bee. */\nexport const B = 2;\n\nexport const C = 3;\n';
  const removed = removeConstant(source, 'B', MODULE);
  assert.ok(removed.ok);
  assert.equal(removed.value, 'export const A = 1;\n\nexport const C = 3;\n');
  assert.deepEqual(removeConstant(source, 'MISSING', MODULE), { ok: false, error: 'missing' });
  assert.deepEqual(removeConstant('export const A = 1;\nexport const B = A + 1;\n', 'A', MODULE), { ok: false, error: 'inUse' });
  assert.deepEqual(removeConstant('export const A = 1, B = 2;\n', 'A', MODULE), { ok: false, error: 'compound' });
  // A page's markup counts as a use.
  assert.deepEqual(removeConstant('---\nconst title = "T";\n---\n<h1>{title}</h1>\n', 'title', PAGE), { ok: false, error: 'inUse' });
});

test('adding then removing a field gives back the original text, so undo and redo are exact', () => {
  for (const source of ["export const A = 'a';\n", 'export const A = "a"\r\n\r\nexport const B = 1\r\n', '---\nconst a = 1;\n---\n<p>{a}</p>\n']) {
    const file = source.startsWith('---') ? PAGE : MODULE;
    const next = added(source, { name: file === PAGE ? 'added' : 'ADDED', value: 'x' }, file);
    assert.notEqual(next, source);
    const back = removeConstant(next, file === PAGE ? 'added' : 'ADDED', file);
    assert.ok(back.ok);
    assert.equal(back.value, source);
    // The same add on the same text writes the same bytes.
    assert.equal(added(source, { name: file === PAGE ? 'added' : 'ADDED', value: 'x' }, file), next);
  }
});

test('file kinds come from the extension, and other files have none', () => {
  assert.deepEqual(constantFileOf('/site/src/consts.ts'), MODULE);
  assert.deepEqual(constantFileOf('/site/src/pages/index.astro'), PAGE);
  assert.deepEqual(constantFileOf('/site/src/data.mjs'), { host: 'module', script: 'js' });
  assert.equal(constantFileOf('/site/src/data.json'), undefined);
  assert.equal(constantFileOf('/site/src/README'), undefined);
});

function reordered(source: string, order: readonly string[], file: ConstantFile = MODULE): string {
  const result = reorderConstants(source, order, file);
  assert.ok(result.ok, `the reorder applies (${result.ok ? '' : result.error})`);
  return result.value;
}

test('a reorder moves each constant with its comments above and after it; blank lines and other code stay', () => {
  const source = [
    "import x from './x';",
    '',
    '// The name, as the header shows it.',
    '/* Two comments, one block. */',
    'export const NAME = "n"; // short',
    '',
    'function helper() {}',
    '',
    '/** The address. */',
    'export const URL = "u";',
    'export const LOCALE = "en";',
    '',
  ].join('\n');
  assert.equal(
    reordered(source, ['LOCALE', 'NAME', 'URL']),
    [
      "import x from './x';",
      '',
      'export const LOCALE = "en";',
      '',
      'function helper() {}',
      '',
      '// The name, as the header shows it.',
      '/* Two comments, one block. */',
      'export const NAME = "n"; // short',
      '/** The address. */',
      'export const URL = "u";',
      '',
    ].join('\n'),
  );
});

test('a comment set apart by a blank line stays where it is', () => {
  const source = '// Settings.\n\nexport const A = 1;\nexport const B = 2;\n';
  assert.equal(reordered(source, ['B', 'A']), '// Settings.\n\nexport const B = 2;\nexport const A = 1;\n');
});

test('first and last places, CRLF, and a page frontmatter reorder', () => {
  const crlf = 'export const A = 1;\r\nexport const B = 2;\r\nexport const C = 3;\r\n';
  assert.equal(reordered(crlf, ['C', 'A', 'B']), 'export const C = 3;\r\nexport const A = 1;\r\nexport const B = 2;\r\n');
  assert.equal(reordered(crlf, ['B', 'C', 'A']), 'export const B = 2;\r\nexport const C = 3;\r\nexport const A = 1;\r\n');
  const page = '---\nimport A from "./A.astro";\nconst title = "T";\nconst subtitle = "S";\n---\n<A>{title}{subtitle}</A>\n';
  assert.equal(
    reordered(page, ['subtitle', 'title'], PAGE),
    '---\nimport A from "./A.astro";\nconst subtitle = "S";\nconst title = "T";\n---\n<A>{title}{subtitle}</A>\n',
  );
});

test('an order that reads a constant before it is declared is refused; a read inside a function is not', () => {
  const source = 'export const FOUNDED = 1990;\nexport const AGE = 2026 - FOUNDED;\n';
  assert.deepEqual(reorderConstants(source, ['AGE', 'FOUNDED'], MODULE), { ok: false, error: 'dependency' });
  const later = 'export const FOUNDED = 1990;\nexport const age = () => 2026 - FOUNDED;\n';
  assert.equal(reordered(later, ['age', 'FOUNDED']), 'export const age = () => 2026 - FOUNDED;\nexport const FOUNDED = 1990;\n');
  // Other code between the constants that reads one counts too.
  const between = 'export const A = 1;\nconsole.log(A);\nexport const B = 2;\n';
  assert.deepEqual(reorderConstants(between, ['B', 'A'], MODULE), { ok: false, error: 'dependency' });
});

test('a reorder is refused on a syntax error, a wrong order or a shared statement, and leaves the same order as it is', () => {
  assert.deepEqual(reorderConstants('export const A = (;\n', ['A'], MODULE), { ok: false, error: 'syntax' });
  assert.deepEqual(reorderConstants('export const A = 1;\nexport const B = 2;\n', ['A'], MODULE), { ok: false, error: 'missing' });
  assert.deepEqual(reorderConstants('export const A = 1;\nexport const B = 2;\n', ['A', 'C'], MODULE), { ok: false, error: 'missing' });
  assert.deepEqual(reorderConstants('export const A = 1, B = 2;\n', ['A'], MODULE), { ok: false, error: 'compound' });
  assert.deepEqual(reorderConstants('export const A = 1; export const B = 2;\n', ['B', 'A'], MODULE), { ok: false, error: 'compound' });
  const source = '/** A. */\nexport const A = 1;\n\nexport const B = 2;\n';
  assert.equal(reordered(source, ['A', 'B']), source, 'the order it has writes the same bytes');
});

test('a move and the move back give the original text', () => {
  const source = '// One.\nexport const A = 1; // a\n\n/** Two. */\nexport const B = [\n  1,\n];\nexport const C = "c";\n';
  const moved = reordered(source, ['C', 'A', 'B']);
  assert.notEqual(moved, source);
  assert.equal(reordered(moved, ['A', 'B', 'C']), source);
});
