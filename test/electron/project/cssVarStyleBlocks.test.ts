// Goal: a custom property declared in an Astro `<style>` is a real variable in the
// Variables panel. It is read with its true value, written back to that block and
// nowhere else, says who it reaches, and never collides silently with a stylesheet
// or another page. What only looks like one (a comment, a string, a `<style>` in an
// expression) stays out.
// Method: each case writes a small project to a temporary folder, reads it through
// the same `readVariables` the panel calls, and edits it through the same operations
// the IPC handlers call, comparing the bytes on disk. Offsets come from the read, so
// a mistranslated offset fails as a wrong write rather than passing unnoticed.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addSection,
  addVariable,
  moveHeading,
  moveSection,
  moveVariable,
  readVariables,
  removeSection,
  renameVariables,
  setSectionTitle,
  setVariable,
} from '#dist/electron/project/cssVars.js';
import { announceVariableWrite } from '#dist/electron/handlers/cssVariableHandlers.js';

type Model = ReturnType<typeof readVariables>;
type FileModel = Model['files'][number];

function project(context: TestContext, files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-blocks-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

function cells(file: FileModel | undefined) {
  assert.ok(file, 'the file is in the panel');
  return file.groups.flatMap((group) => group.blocks.flatMap((block) => block.rows.flatMap((row) => row.cells.flatMap((cell) => (cell ? [cell] : [])))));
}

function cellOf(model: Model, rel: string, name: string) {
  const cell = cells(model.files.find((file) => file.rel === rel)).find((candidate) => candidate.name === name);
  assert.ok(cell, `${name} is read from ${rel}`);
  return cell;
}

// A described cell's field: the model's row type still names the undescribed cell.
const resolvedOf = (cell: object): unknown => Reflect.get(cell, 'resolved');

const names = (model: Model): readonly string[] => model.files.flatMap((file) => cells(file).map((cell) => cell.name));

const PAGE = 'src/pages/index.astro';
const HOME = `---
const title = 'Home';
---
<html>
  <head>
    <title>{title}</title>
    <style is:global>
    :root {
      /* colors */
      --brand: #2b5cf6;
      --brand-text: var(--light);
      --light: white;
    }
    @media (width < 50rem) {
      :root {
        --brand: red;
      }
    }
    </style>
  </head>
  <body></body>
</html>
`;

test('A page <style> is read with its real values, at offsets of the file itself', (context) => {
  const root = project(context, { [PAGE]: HOME });
  const model = readVariables(root);
  assert.deepEqual(
    model.files.map((file) => file.rel),
    [PAGE],
  );
  const cell = cellOf(model, PAGE, '--brand-text');
  assert.equal(cell.value, 'var(--light)');
  assert.equal(HOME.slice(cell.valueStart, cell.valueEnd), 'var(--light)');
  assert.equal(HOME.split('\n')[cell.line - 1]?.trim(), '--brand-text: var(--light);');
  assert.equal(model.values['--light'], 'white');
});

test('Comments, strings, expressions and files with no <style> declare nothing', (context) => {
  const root = project(context, {
    'src/pages/none.astro': '<main style="--inline: 1"><p>No style tags here, not even --x: 1;</p></main>\n',
    'src/pages/frontmatter.astro': "---\nconst css = '<style>:root { --from-string: 1 }</style>';\n---\n<p>{css}</p>\n",
    'src/pages/html-comment.astro': '<!-- <style>:root { --from-comment: 1 }</style> -->\n<p>x</p>\n',
    'src/pages/script.astro': "<script>const a = '<style>:root { --from-script: 1 }</style>';</script>\n<p>x</p>\n",
    'src/pages/template-string.astro': '<p>{`<style>:root { --from-template-string: 1 }</style>`}</p>\n',
    'src/pages/condition.astro': '---\nconst on = true;\n---\n<div>{on && <style>:root { --from-condition: 1 }</style>}</div>\n',
    'src/pages/map.astro': '<ul>{[1].map((item) => <li><style>:root { --from-map: 1 }</style>{item}</li>)}</ul>\n',
    'src/pages/css-noise.astro': `<style is:global>
      /* --in-comment: 1; */
      :root { --real: 1; --quoted: "--in-string: 2;"; }
      .a::after { content: "--in-content: 3;"; }
    </style>`,
  });
  const model = readVariables(root);
  assert.deepEqual(names(model), ['--real', '--quoted']);
  assert.equal(cellOf(model, 'src/pages/css-noise.astro', '--quoted').value, '"--in-string: 2;"');
});

test('A <style> in an expression stays out when the parser cannot read the page either', (context) => {
  // An unbalanced `<div>` is left to the template scanner rather than the parser.
  const scanned = '<section>\n{true && <style>:root { --from-expression: 1 }</style>}\n</div>\n<style is:global>:root { --kept: 1 }</style>\n';
  const root = project(context, { 'src/pages/scanned.astro': scanned });
  assert.deepEqual(names(readVariables(root)), ['--kept']);
});

test('Each way of writing <style> states its reach honestly', (context) => {
  const block = (attributes: string): string =>
    `<style${attributes}>:root { --root-${attributes.length}: 1 } .card { --card-${attributes.length}: 2 }</style>\n`;
  const root = project(context, {
    'src/pages/global.astro': block(' is:global'),
    'src/pages/inline.astro': block(' is:inline'),
    'src/pages/plain.astro': block(''),
    'src/components/Card.astro': block(''),
    'src/layouts/Base.astro': block(' is:global'),
    'src/pages/nested.astro':
      '<style>.a { :root & { --nested: 1 } } :root, .b { --mixed: 1 } :global(.c) { --escaped: 1 } html { --html: 1 } body { --body: 1 }</style>',
  });
  const scopes = (rel: string) => {
    const file = readVariables(root).files.find((candidate) => candidate.rel === rel);
    assert.ok(file);
    return file.groups.map((group) => [group.columns[0]?.selector, group.scope?.reach, group.scope?.written]);
  };
  assert.deepEqual(scopes('src/pages/global.astro'), [
    [':root', 'page', 'global'],
    ['.card', 'page', 'global'],
  ]);
  assert.deepEqual(scopes('src/pages/inline.astro'), [
    [':root', 'page', 'inline'],
    ['.card', 'page', 'inline'],
  ]);
  // Astro leaves `:root` alone in a plain block and hashes `.card`.
  assert.deepEqual(scopes('src/pages/plain.astro'), [
    [':root', 'page', 'scoped'],
    ['.card', 'scoped', 'scoped'],
  ]);
  assert.deepEqual(scopes('src/components/Card.astro'), [
    [':root', 'rendered', 'scoped'],
    ['.card', 'scoped', 'scoped'],
  ]);
  assert.deepEqual(scopes('src/layouts/Base.astro'), [
    [':root', 'rendered', 'global'],
    ['.card', 'rendered', 'global'],
  ]);
  const reachOf = (name: string): string | undefined => {
    const file = readVariables(root).files.find((candidate) => candidate.rel === 'src/pages/nested.astro');
    assert.ok(file);
    return file.groups.find((group) => group.blocks.some((entry) => entry.rows.some((row) => row.cells.some((cell) => cell?.name === name))))?.scope?.reach;
  };
  assert.equal(reachOf('--nested'), 'scoped', 'a nested rule inherits its parent selector');
  assert.equal(reachOf('--mixed'), 'scoped', 'a list with one hashed selector is not page wide');
  assert.equal(reachOf('--escaped'), 'page');
  assert.equal(reachOf('--html'), 'page');
  assert.equal(reachOf('--body'), 'page');
});

test('A stylesheet has no scope, and comes before the pages', (context) => {
  const root = project(context, { [PAGE]: HOME, 'src/styles/tokens.css': ':root { --token: 1; }\n' });
  const model = readVariables(root);
  assert.deepEqual(
    model.files.map((file) => file.rel),
    ['src/styles/tokens.css', PAGE],
  );
  assert.equal(model.files[0]?.groups[0]?.scope, undefined);
  assert.equal(model.files[1]?.name, 'pages/index.astro', 'two pages named index.astro stay apart');
});

test('A block that cannot be read says so, and a file with no variables stays quiet', (context) => {
  const root = project(context, {
    'src/pages/broken.astro': '<style is:global>\n:root { --broken: 1;\n@media {\n</style>\n',
    'src/pages/sass.astro': '<style lang="scss">:root { --sass: 1 }</style>\n',
    'src/pages/bem.astro': '<style lang="scss">.card--wide { color: red; }</style>\n',
  });
  const files = readVariables(root).files;
  assert.deepEqual(
    files.map((file) => file.rel),
    ['src/pages/broken.astro', 'src/pages/sass.astro'],
  );
  assert.match(files[0]?.error ?? '', /^Could not parse — The <style> block on line 1:/);
  assert.match(files[1]?.error ?? '', /not plain CSS/);
});

test('Editing a value changes that value and no other byte of the file', (context) => {
  const root = project(context, { [PAGE]: HOME, 'src/styles/tokens.css': ':root { --brand: blue; }\n' });
  const cell = cellOf(readVariables(root), PAGE, '--brand');
  const result = setVariable(root, { file: PAGE, valueStart: cell.valueStart, valueEnd: cell.valueEnd, expect: cell.value, value: '#123456' });
  assert.deepEqual(result, { ok: true });
  assert.equal(read(root, PAGE), HOME.replace('--brand: #2b5cf6;', '--brand: #123456;'));
  assert.equal(read(root, 'src/styles/tokens.css'), ':root { --brand: blue; }\n');
});

test('A file changed under the panel refuses the write', (context) => {
  const root = project(context, { [PAGE]: HOME });
  const cell = cellOf(readVariables(root), PAGE, '--brand');
  const moved = `<!-- new line -->\n${HOME}`;
  fs.writeFileSync(path.join(root, PAGE), moved);
  const result = setVariable(root, { file: PAGE, valueStart: cell.valueStart, valueEnd: cell.valueEnd, expect: cell.value, value: 'red' });
  assert.equal(result.stale, true);
  assert.equal(read(root, PAGE), moved);
});

test('Nothing typed into the panel can leave the <style> block', (context) => {
  const root = project(context, { [PAGE]: HOME });
  const cell = cellOf(readVariables(root), PAGE, '--brand');
  const escape = 'red</style><script>alert(1)</script><style>';
  const value = setVariable(root, { file: PAGE, valueStart: cell.valueStart, valueEnd: cell.valueEnd, expect: cell.value, value: escape });
  assert.equal(value.ok, false);
  assert.match(value.error ?? '', /outside its <style> block/);
  const added = addVariable(root, { file: PAGE, selector: ':root', name: '--new', value: escape, after: '--light' });
  assert.equal(added.ok, false);
  const heading = addSection(root, { file: PAGE, selector: ':root', title: '</style>', before: '--light' });
  assert.equal(heading.ok, false);
  assert.equal(read(root, PAGE), HOME);
});

test('Rows and headings move, add and go inside their own block', (context) => {
  const root = project(context, { [PAGE]: HOME });
  assert.equal(addVariable(root, { file: PAGE, selector: ':root', name: '--added', value: '1px', after: '--brand' }).ok, true);
  assert.equal(read(root, PAGE), HOME.replace('      --brand: #2b5cf6;\n', '      --brand: #2b5cf6;\n      --added: 1px;\n'));

  assert.equal(moveVariable(root, { file: PAGE, selector: ':root', name: '--light', target: '--brand' }).ok, true);
  const moved = read(root, PAGE);
  assert.ok(moved.indexOf('--light: white') < moved.indexOf('--brand: #2b5cf6'));

  assert.equal(moveSection(root, { file: PAGE, selector: ':root', names: ['--added'] }).ok, true);
  assert.equal(addSection(root, { file: PAGE, selector: ':root', title: 'spacing', before: '--added' }).ok, true);
  assert.match(read(root, PAGE), /\/\* spacing \*\/\n\s*--added: 1px;/);

  const block = readVariables(root).files[0]?.groups[0]?.blocks.find((entry) => entry.title === 'spacing');
  assert.ok(block?.titleStart !== undefined);
  assert.ok(block.titleEnd !== undefined);
  const range = { file: PAGE, start: block.titleStart, end: block.titleEnd, expect: 'spacing' };
  assert.equal(setSectionTitle(root, { ...range, title: 'gaps' }).ok, true);
  const renamed = readVariables(root).files[0]?.groups[0]?.blocks.find((entry) => entry.title === 'gaps');
  assert.ok(renamed?.titleStart !== undefined);
  assert.ok(renamed.titleEnd !== undefined);
  const next = { file: PAGE, start: renamed.titleStart, end: renamed.titleEnd, expect: 'gaps' };
  assert.equal(moveHeading(root, { ...next, selector: ':root', before: '--brand' }).ok, true);
  assert.ok(read(root, PAGE).indexOf('/* gaps */') < read(root, PAGE).indexOf('--brand: #2b5cf6'));
  const again = readVariables(root).files[0]?.groups[0]?.blocks.find((entry) => entry.title === 'gaps');
  assert.ok(again?.titleStart !== undefined);
  assert.ok(again.titleEnd !== undefined);
  assert.equal(removeSection(root, { file: PAGE, start: again.titleStart, end: again.titleEnd, expect: 'gaps' }).ok, true);
  assert.equal(read(root, PAGE).includes('gaps'), false);
  assert.ok(read(root, PAGE).startsWith("---\nconst title = 'Home';\n---\n<html>"), 'the frontmatter is untouched');
});

test('Two blocks of one file are told apart, or the edit is refused', (context) => {
  const twoBlocks = '<style>\n:root {\n  --a: 1;\n}\n</style>\n<p>between</p>\n<style is:global>\n:root {\n  --b: 2;\n}\n</style>\n';
  const root = project(context, { [PAGE]: twoBlocks });
  const model = readVariables(root);
  assert.deepEqual(names(model), ['--a', '--b']);
  assert.equal(addVariable(root, { file: PAGE, selector: ':root', name: '--c', value: '3', after: '--b' }).ok, true);
  assert.equal(read(root, PAGE).split('</style>')[0], '<style>\n:root {\n  --a: 1;\n}\n', 'the first block is left alone');
  assert.match(read(root, PAGE), /--b: 2;[\s\S]*--c: 3;/);

  const unclear = addVariable(root, { file: PAGE, selector: ':root', name: '--d', value: '4' });
  assert.equal(unclear.ok, false);
  assert.match(unclear.error ?? '', /more than one <style> block/);
});

test('A rule written on one line refuses an added row rather than landing outside the block', (context) => {
  const oneLine = '<style is:global>:root { --a: 1; }</style>\n';
  const root = project(context, { [PAGE]: oneLine });
  const added = addVariable(root, { file: PAGE, selector: ':root', name: '--b', value: '2', after: '--a' });
  assert.equal(added.ok, false);
  assert.match(added.error ?? '', /outside its <style> block/);
  assert.equal(read(root, PAGE), oneLine);
});

test('Rename reaches declarations and references everywhere, and respects names in blocks', (context) => {
  const root = project(context, {
    [PAGE]: HOME,
    'src/pages/about.astro': '<style is:global>:root { --brand: green; --about: 1; }</style>\n<p style="color: var(--brand)">x</p>\n',
    'src/styles/tokens.css': '.a { color: var(--brand); }\n',
  });
  const taken = renameVariables(root, { renames: [{ from: '--brand', to: '--about' }] });
  assert.deepEqual(taken, { ok: false, error: '--about already exists.', errorRef: { key: 'variables.error.alreadyExists', params: { name: '--about' } } });
  assert.equal(read(root, PAGE), HOME);

  const result = renameVariables(root, { renames: [{ from: '--brand', to: '--primary' }] });
  assert.equal(result.ok, true);
  assert.equal(result.files, 3);
  assert.equal(read(root, PAGE).includes('--brand:'), false);
  assert.ok(read(root, PAGE).includes('--brand-text: var(--light)'), 'a longer name is a different name');
  assert.match(read(root, 'src/pages/about.astro'), /--primary: green;[\s\S]*var\(--primary\)/);
  assert.equal(read(root, 'src/styles/tokens.css'), '.a { color: var(--primary); }\n');
});

test('A name in frontmatter or markup is not a taken name', (context) => {
  const root = project(context, { [PAGE]: '---\nconst a = \'--free: 1\';\n---\n<p style="--free: 2">x</p>\n<style>:root { --old: 1 }</style>\n' });
  assert.equal(renameVariables(root, { renames: [{ from: '--old', to: '--free' }] }).ok, true);
});

test('One name in a stylesheet and two pages stays three declarations with three answers', (context) => {
  const root = project(context, {
    'src/styles/tokens.css': ':root { --brand: blue; --alias: var(--brand); }\n',
    'src/pages/a.astro': '<style is:global>:root { --brand: red; --a-alias: var(--brand); }</style>\n',
    'src/pages/b.astro': '<style is:global>:root { --brand: green; --b-alias: var(--brand); --only-b: 1px; }</style>\n',
  });
  const model = readVariables(root);
  assert.equal(cellOf(model, 'src/styles/tokens.css', '--brand').value, 'blue');
  assert.equal(cellOf(model, 'src/pages/a.astro', '--brand').value, 'red');
  assert.equal(cellOf(model, 'src/pages/b.astro', '--brand').value, 'green');
  assert.equal(resolvedOf(cellOf(model, 'src/styles/tokens.css', '--alias')), 'blue', 'a page never answers for a stylesheet');
  assert.equal(resolvedOf(cellOf(model, 'src/pages/a.astro', '--a-alias')), 'red', 'a page reads its own value first');
  assert.equal(resolvedOf(cellOf(model, 'src/pages/b.astro', '--b-alias')), 'green');
  assert.equal(model.values['--brand'], 'blue', 'the project-wide answer is the stylesheet');
  assert.equal(model.values['--only-b'], '1px', 'a name only a page declares is still known');

  const cell = cellOf(model, 'src/pages/a.astro', '--brand');
  assert.equal(setVariable(root, { file: cell.file, valueStart: cell.valueStart, valueEnd: cell.valueEnd, expect: cell.value, value: 'pink' }).ok, true);
  assert.match(read(root, 'src/pages/a.astro'), /--brand: pink;/);
  assert.match(read(root, 'src/pages/b.astro'), /--brand: green;/);
  assert.match(read(root, 'src/styles/tokens.css'), /--brand: blue;/);
});

test('A variable write names the Astro files it touched, so the open page reloads', () => {
  const sent: Array<readonly [string, unknown]> = [];
  const send = (channel: string, payload?: unknown): void => {
    sent.push([channel, payload]);
  };
  announceVariableWrite(send, ['/site/src/styles/tokens.css']);
  assert.deepEqual(sent, [['css:changed', {}]]);
  sent.length = 0;
  announceVariableWrite(send, ['/site/src/styles/tokens.css', '/site/src/pages/index.astro']);
  assert.deepEqual(sent, [
    ['css:changed', {}],
    ['fs:changed', { files: ['/site/src/pages/index.astro'] }],
  ]);
});
