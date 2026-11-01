import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeWindowSource, codeWindowEdit } from '../src/features/code/codeWindowSource';
import { flatten, parsePage } from '../src/features/source/source';

test('frontmatter popup edits preserve fences, line endings and page markup', () => {
  const source = '---\r\nconst title = "Hi";\r\n---\r\n<h1>{title}</h1>\r\n';
  const target = codeWindowSource(source, 'frontmatter');
  assert.equal(target?.title, 'Frontmatter');
  assert.equal(target?.language, 'javascript');
  assert.equal(target?.value, 'const title = "Hi";');
  assert.equal(codeWindowEdit(source, 'frontmatter', target.value, 'const title = "Hello";'), source.replace('"Hi"', '"Hello"'));
});

test('script and style popups edit only their contents and reject stale edits', () => {
  const source = '<div>Keep me</div>\n<script is:inline data-label="x > y">\nconsole.log("hello");\n</script>\n<style>\nh1 { color: red; }\n</style>\n';
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable);
  for (const node of flatten(parsed.model.nodes).filter((node) => node.kind === 'raw')) {
    assert.ok(node.id);
    const target = codeWindowSource(source, node.id);
    assert.ok(target);
    assert.equal(target.language, node.name === 'script' ? 'javascript' : 'css');
    const next = target.value + '/* saved */\n';
    const updated = codeWindowEdit(source, node.id, target.value, next);
    assert.equal(updated, source.replace(target.value, next));
    assert.throws(() => codeWindowEdit(updated, node.id ?? '', target.value, 'stale'), /code changed/);
  }
  assert.equal(codeWindowSource(source, 'n0'), undefined);
  assert.equal(codeWindowSource(source, 'missing'), undefined);
});

test('an empty frontmatter popup retains the BOM and does not duplicate fences', () => {
  const source = '\uFEFF---\n---\n<h1>Keep me</h1>\n';
  assert.equal(codeWindowSource(source, 'frontmatter')?.value, '');
  assert.equal(codeWindowEdit(source, 'frontmatter', '', 'const title = "Hi";'), '\uFEFF---\nconst title = "Hi";\n---\n<h1>Keep me</h1>\n');
});
