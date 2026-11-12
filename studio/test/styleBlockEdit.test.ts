// Goal: Studio's first styles (the Style panel's mode for a page with nothing to write styles into)
// produce one source text holding the class and the block, laid out as the file is laid out.
// Method: real source edits over LF, CRLF and space-indented pages and the class shapes the panel
// meets, with the negative space beside them: a file kind that cannot hold a block, a class name
// that cannot be written, a node that is not an element. Every case compares whole texts, and a
// failed case must return nothing rather than a half-edited page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addStyleBlockSource } from '../src/features/settings/styleBlockEdit';
import { flatten, nodeId, nodesOf } from '../src/features/source/source';

const RULE = '.class {\n\tpadding: 1rem;\n}\n';
const PAGE = '---\nconst a = 1;\n---\n<main>\n\t<h1>Hi</h1>\n\t<p class="intro">Intro</p>\n</main>\n';
const FILE = 'src/pages/index.astro';

function idOf(source: string, name: string): string {
  const node = flatten(nodesOf(source)).find((candidate) => candidate.name === name);
  assert.ok(node, `a ${name} node`);
  return nodeId(node);
}

test('the class and the block land in one text, the block last', () => {
  const result = addStyleBlockSource(PAGE, FILE, idOf(PAGE, 'h1'), { className: 'class', css: RULE });
  assert.equal(result, PAGE.replace('<h1>', '<h1 class="class">') + '<style is:global>\n\t.class {\n\t\tpadding: 1rem;\n\t}\n</style>\n');
});

test('an existing class is kept and the new one appended', () => {
  const result = addStyleBlockSource(PAGE, FILE, idOf(PAGE, 'p'), { className: 'class', css: RULE });
  assert.equal(result, PAGE.replace('class="intro"', 'class="intro class"') + '<style is:global>\n\t.class {\n\t\tpadding: 1rem;\n\t}\n</style>\n');
});

test('a class:list keeps its expression', () => {
  const source = '<p class:list={["a", dynamic]}>x</p>\n';
  const result = addStyleBlockSource(source, FILE, idOf(source, 'p'), { className: 'class', css: RULE });
  assert.equal(result, '<p class:list={["a", dynamic, "class"]}>x</p>\n<style is:global>\n\t.class {\n\t\tpadding: 1rem;\n\t}\n</style>\n');
});

test('no class is added when the rule is for a class the element has', () => {
  const result = addStyleBlockSource(PAGE, FILE, idOf(PAGE, 'p'), { className: undefined, css: '.intro {\n\tcolor: red;\n}\n' });
  assert.equal(result, PAGE + '<style is:global>\n\t.intro {\n\t\tcolor: red;\n\t}\n</style>\n');
});

test('a CRLF page gets CRLF throughout', () => {
  const crlf = PAGE.replace(/\n/g, '\r\n');
  const result = addStyleBlockSource(crlf, FILE, idOf(crlf, 'h1'), { className: 'class', css: RULE });
  assert.equal(result, crlf.replace('<h1>', '<h1 class="class">') + '<style is:global>\r\n\t.class {\r\n\t\tpadding: 1rem;\r\n\t}\r\n</style>\r\n');
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
});

test('a page indented with spaces gets spaces', () => {
  const spaced = PAGE.replace(/\t/g, '  ');
  const result = addStyleBlockSource(spaced, FILE, idOf(spaced, 'h1'), { className: 'class', css: RULE });
  assert.ok(result.endsWith('<style is:global>\n  .class {\n    padding: 1rem;\n  }\n</style>\n'));
});

test('a file with no final newline still gets the block on its own line', () => {
  const bare = PAGE.slice(0, -1);
  const result = addStyleBlockSource(bare, FILE, idOf(bare, 'h1'), { className: 'class', css: RULE });
  assert.ok(result.includes('</main>\n<style is:global>'));
});

test('refusals return nothing and name what to do', () => {
  for (const file of ['src/pages/notes.md', 'src/pages/notes.mdx', 'src/pages/index.html']) {
    assert.throws(() => addStyleBlockSource(PAGE, file, idOf(PAGE, 'h1'), { className: 'class', css: RULE }), /no place for a style block/, file);
  }
  assert.throws(() => addStyleBlockSource(PAGE, FILE, idOf(PAGE, 'h1'), { className: 'two classes', css: RULE }), /single class name/);
  assert.throws(() => addStyleBlockSource(PAGE, FILE, 'missing', { className: 'class', css: RULE }), /Select the element again/);
  assert.throws(() => addStyleBlockSource(PAGE, FILE, idOf(PAGE, 'h1'), { className: 'class', css: '\n\n' }), /at least one rule line/);
});
