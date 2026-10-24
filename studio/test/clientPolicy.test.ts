import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { assertClientAction, assertClientSourceChange } from '../src/features/roles/clientPolicy';
import { setEditorRole } from '../src/features/roles/roleStore';
import { EditorHistory } from '../src/features/collaboration/editorHistory';
import {
  applyEdits,
  flatten,
  nodesOf,
  structuralEdits,
  type TreeAction,
} from '../src/features/source/source';

const source = await readFile(new URL('./fixtures/homepage.astro', import.meta.url), 'utf8');
const heading = flatten(nodesOf(source)).find((node) => node.name === 'Heading');
assert.ok(heading?.id);
const id = heading.id;
const page = 'src/pages/index.astro';

test('Client actions protect the layout and reject all outer insert/move placements', () => {
  const actions: TreeAction[] = [
    { kind: 'delete', node: 'layout' },
    { kind: 'duplicate', node: 'layout' },
    { kind: 'move', node: 'layout', target: id, placement: 'inside' },
    ...(['before', 'after'] as const).flatMap((placement): TreeAction[] => [
      { kind: 'move', node: id, target: 'layout', placement },
      {
        kind: 'insert',
        target: 'layout',
        placement,
        name: 'Button',
        paired: true,
        importPath: './Button.astro',
      },
      { kind: 'insert-content', target: 'layout', placement, content: { type: 'text' } },
    ]),
  ];
  for (const action of actions) {
    assert.throws(() => assertClientAction(source, action), /layout/);
  }
});
test('Client content, component insertion, duplication and deletion stay inside the layout', () => {
  const actions: TreeAction[] = [
    { kind: 'delete', node: id },
    { kind: 'duplicate', node: id },
    {
      kind: 'insert',
      target: 'layout',
      name: 'Button',
      paired: true,
      importPath: './Button.astro',
    },
  ];
  for (const action of actions) {
    assertClientAction(source, action);
    assertClientSourceChange(page, source, applyEdits(source, structuralEdits(source, action)));
  }
  assertClientSourceChange(page, source, source.replace('Style Guide', 'Client content'));
});
test('Client direct edits cannot remove/replace the layout or alter outer markup', () => {
  const withScript = source + '\n<script>console.log("kept")</script>';
  for (const next of [
    source + '<p>Outside</p>',
    source.replace('<Layout', '<Other').replace('</Layout>', '</Other>'),
    source.replace(/<Layout[\s\S]*<\/Layout>/, ''),
  ]) {
    assert.throws(() => assertClientSourceChange(page, source, next));
  }
  assert.throws(() =>
    assertClientSourceChange(page, withScript, withScript.replace('kept', 'changed')),
  );
  assert.throws(() => assertClientSourceChange('src/components/Test.astro', source, source));
  assertClientSourceChange('src/content/posts/example.md', 'Old', 'New');
});
test('Client undo cannot cross back into Developer history or coalesce across roles', async () => {
  const doc = new Y.Doc();
  const undo = new Y.UndoManager(doc.getText('source'));
  const history = new EditorHistory(undo);
  const applied: string[] = [];
  try {
    setEditorRole('designer');
    history.record({ undo: () => applied.push('designer'), redo: () => {}, coalesceKey: 'text' });
    setEditorRole('client');
    history.record({ undo: () => applied.push('client'), redo: () => {}, coalesceKey: 'text' });
    await history.step('undo');
    await assert.rejects(history.step('undo'), /Switch to Developer/);
    assert.deepEqual(applied, ['client']);
    setEditorRole('designer');
    await history.step('undo');
    assert.deepEqual(applied, ['client', 'designer']);
  } finally {
    setEditorRole('designer');
    undo.destroy();
    doc.destroy();
  }
});
