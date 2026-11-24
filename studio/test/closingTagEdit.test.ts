// Goal: Settings and Style writes that sit before a closing tag stay inside the edited node,
// when the parent's closing tag starts on the very next character.
// Method: edit an empty element and a code block that are their parent's last child, with
// and without space after them, and compare the whole page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineContentEdit, nodeTextEdit } from '../src/features/settings/settingsEdits';
import { applyEdits, flatten, nodesOf } from '../src/features/source/source';

function idOf(source: string, name: string): string {
  const node = flatten(nodesOf(source)).find((candidate) => candidate.name === name);
  assert.ok(node?.id);
  return node.id;
}

test('content written into an empty last child stays inside it', () => {
  for (const gap of ['', '\n']) {
    const source = `<div><p></p>${gap}</div>`;
    const edit = inlineContentEdit(source, idOf(source, 'p'), [{ kind: 'text', value: 'hi' }]);
    assert.equal(applyEdits(source, [edit]), `<div><p>hi</p>${gap}</div>`);
  }
});

test('a style or script block that closes against its parent can be rewritten', () => {
  for (const [name, attributes] of [
    ['style', ''],
    ['script', ' is:inline'],
  ] as const) {
    const source = `<div><${name}${attributes}>a{}</${name}></div>`;
    const edit = nodeTextEdit(source, idOf(source, name), 'b{}');
    assert.equal(applyEdits(source, [edit]), `<div><${name}${attributes}>b{}</${name}></div>`);
  }
});

test('an element that cannot hold content is still refused', () => {
  const source = '<div><br></div>';
  assert.throws(() => inlineContentEdit(source, idOf(source, 'br'), [{ kind: 'text', value: 'hi' }]), /cannot contain content/);
});
