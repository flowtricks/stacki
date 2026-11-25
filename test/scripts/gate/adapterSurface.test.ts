// Goal: the adapter-surface ratchet counts what its header says it counts, so
// a number in the tracker means the same thing at every step (plan §11 step 3).
// Method: one snippet per rule of the written method, plus the exclusions and
// the forms that must not count (comparisons, arrows, DOM writes, comments).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countWholeFileWrites, countTreeEdits, countWrapperCalls } from '#dist/scripts/gate/adapterSurface.js';

test('each rule of the written method counts one site', () => {
  const cases: readonly [string, number, number][] = [
    ['node.value = next;', 1, 0],
    // An element of the page tree is still a tree node: only the DOM-name suffix is exempt.
    ['elementNode.value = next;', 1, 0],
    ['node.children += x; node.name -= y;', 2, 0],
    ['parent.children.splice(index, 0, node);', 1, 0],
    ['delete first.blankBefore; delete n.head; delete n.children;', 1, 0],
    ['const kids = node.children;\nkids.push(child);', 1, 0],
    ['found.list.splice(found.index, 1);', 1, 0],
    ['const { list, index } = found;\nlist.splice(index, 1);', 1, 0],
    ['node.props[key] = value;', 0, 1], // A prop-index write, not a field assignment.
    ['props[attribute] = { type: "string", value };', 0, 1],
    ['delete node.props[key];', 0, 1],
  ];
  for (const [text, mutations, propIndexWrites] of cases) {
    assert.deepEqual(countTreeEdits(text), { mutations, propIndexWrites }, text);
  }
});

test('comparisons, arrows, DOM and CMS objects, and comments do not count', () => {
  const ignored = [
    'if (node.kind === "text") {}',
    'const pick = (node) => node.value => 1;',
    'event.currentTarget.value = "";',
    'master.gain.value = 0.06;',
    'field.value = describe(field);',
    // A receiver named for a DOM element is the platform's node, whatever it holds.
    "inputElement.value = '';",
    'rootElement.children.push(x);',
    '// node.value = next;',
    ' * node.children.push(x)',
  ];
  for (const text of ignored) {
    assert.deepEqual(countTreeEdits(text), { mutations: 0, propIndexWrites: 0 }, text);
  }
});

test('wrapper call sites exclude their own definitions', () => {
  const text = [
    'function mutateModel(update) {}',
    'const applyEdit = useCallback(async () => {});',
    'mutateModel((model) => model);',
    'void applyEdit(rule, () => {});',
    'void applyEdit(rule, () => {});',
  ].join('\n');
  assert.deepEqual(countWrapperCalls(text), { mutateModelCalls: 1, applyEditCalls: 2 });
});

// Step 10: whole-file writes are the `replace-source` operation named in code
// or a `replaceSource(` call; a program's diff write (writeText, writeCurrent,
// writeProjectText) is splices and is not one. Comments do not count.
test('whole-file write sites count the retired operation, never a diff write', () => {
  const text = [
    "operation: { tag: 'replace-source', text },",
    'const report = documents.replaceSource(pagePath, text, base);',
    '// replaceSource(file, text) in a comment',
    'writeProjectText(abs, next);',
    'documents.writeText(file, next, base); documents.writeCurrent(file, next);',
    'case "replace-source":',
  ].join('\n');
  assert.equal(countWholeFileWrites(text), 3);
});
