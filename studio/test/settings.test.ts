import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits, flatten, nodesOf, parsePage } from '../src/features/source/source';
import { assetProp, frontmatterEdit, inlineContentEdit, nodeTextEdit } from '../src/features/settings/settingsEdits';
function id(source: string, kind: string) {
  const node = flatten(nodesOf(source)).find((node) => node.kind === kind);
  assert.ok(node?.id);
  return node.id;
}
test('rich text, style and condition edits preserve neighboring source bytes', () => {
  const source = '<!-- keep -->\n<p class="x">Old</p>\n<style>p { color: red; }</style>\n';
  const rich = applyEdits(source, [inlineContentEdit(source, id(source, 'element'), [{ kind: 'text', value: 'A & B < C' }])]);
  assert.equal(rich, source.replace('Old', 'A &amp; B &lt; C'));
  const style = applyEdits(source, [nodeTextEdit(source, id(source, 'raw'), 'p { color: blue; }')]);
  assert.equal(style, source.replace('color: red', 'color: blue'));
  const condition = '{show && <p data-note="preserve">Original</p>}';
  assert.equal(applyEdits(condition, [nodeTextEdit(condition, id(condition, 'cond'), 'visible')]), condition.replace('show', 'visible'));
});
test('frontmatter and asset imports keep CRLF and untouched body bytes', () => {
  const source = '---\r\nconst keep = 1;\r\n---\r\n<img src="/old.png" />\r\n';
  const updated = assetProp(source, id(source, 'element'), 'src/pages/index.astro', 'src', 'src/assets/new.png');
  assert.ok(updated.startsWith('---\r\nimport studioAsset from "../assets/new.png";\r\nconst keep = 1;\r\n---\r\n'));
  assert.ok(parsePage(updated).editable);
  assert.equal(applyEdits(source, [frontmatterEdit(source, 'const keep = 2;')]), source.replace('keep = 1', 'keep = 2'));
});
test('component insertion supports empty pages and empty paired containers without corrupting imports', () => {
  for (const source of ['---\r\nconst keep = 1;\r\n---\r\n', '<div />']) {
    const target = nodesOf(source)[0]?.id ?? '';
    const next = applyEdits(
      source,
      structuralEdits(source, {
        kind: 'insert',
        target,
        placement: 'inside',
        name: 'Button',
        importPath: '../components/Button.astro',
        paired: true,
      }),
    );
    assert.ok(parsePage(next).editable);
    assert.ok(next.includes('<Button>Text</Button>'));
    if (source.includes('<div')) {
      assert.ok(next.includes('</div>'));
    } else {
      assert.ok(next.includes('---\r\nimport'));
    }
  }
});
