// Structural planning runs on the server; the browser shares only source readers
// and validated actions, keeping filesystem checksum dependencies out of its bundle.
import type { InsertionDefaults } from './instanceDefaults';
import { sourcePlanner } from './sourcePlanner';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { componentInsertionEdits } from './componentInsertion';
import { contentInsertionEdits } from './insertContent';
import { nodeAt, bounds, type TreeAction, type Edit } from './source';

export function structuralEdits(source: string, action: TreeAction, file = '', settings?: InsertionDefaults): Edit[] {
  if (action.kind === 'paste') {
    throw new Error('Paste requires the destination file context');
  }
  if (action.kind === 'insert-content') {
    return contentInsertionEdits(source, action);
  }
  if (action.kind === 'insert') {
    return componentInsertionEdits(source, action, file, settings);
  }
  const node = nodeAt(source, action.node);
  if (node.id === 'layout') {
    throw new Error('The page layout cannot be removed or moved');
  }
  const range = bounds(node);
  const planner = sourcePlanner(source);
  if (action.kind === 'delete') {
    return planner.plan(node, { tag: 'remove-node' });
  }
  const fragment = source.slice(range.start, range.end);
  if (action.kind === 'duplicate') {
    return planner.plan(node, { tag: 'insert-node', placement: 'after', source: fragment });
  }
  const target = nodeAt(source, action.target);
  const targetBounds = bounds(target);
  if (range.start <= targetBounds.start && range.end >= targetBounds.end) {
    throw new Error('Cannot move an element into itself');
  }
  return planner.plan(node, {
    tag: 'move-node',
    destination: planner.anchor(target),
    placement: action.placement === 'inside' ? 'last-child' : action.placement,
  });
}
export function insertFragment(
  source: string,
  action: { readonly target: string; readonly placement?: 'before' | 'after' | 'inside' },
  fragment: string,
  empty: boolean,
): Edit {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = `${eol}${fragment}${eol}`;
  if (!action.target && empty) {
    return { start: source.length, end: source.length, text };
  }
  const target = nodeAt(source, action.target);
  const edits = sourcePlanner(source).plan(target, {
    tag: 'insert-node',
    placement: !action.placement || action.placement === 'inside' ? 'last-child' : action.placement,
    source: fragment,
  });
  assert(edits.length === 1, 'A markup insertion has one source splice');
  const edit = edits[0];
  assert(edit !== undefined, 'The insertion splice is present');
  return edit;
}
