// Structural planning runs on the server; the browser shares only source readers
// and validated actions, keeping filesystem checksum dependencies out of its bundle.
import type { InsertionDefaults } from './instanceDefaults';
import { sourcePlanner } from './sourcePlanner';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { indentedFragment } from '../../../vendor/stacki/shared/engine/planSupport';
import { wrappedTextHunk } from '../../../vendor/stacki/shared/engine/planText';
import { componentInsertionEdits } from './componentInsertion';
import { contentInsertionEdits } from './insertContent';
import { nodeAt, bounds, type ParserNode, type TreeAction, type Edit } from './source';

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
  if (action.kind === 'wrap-text') {
    return textWrapEdits(source, node, action.name);
  }
  if (action.kind === 'duplicate') {
    return planner.plan(node, { tag: 'insert-node', placement: 'after', source: planner.labelledText(node) });
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
// The same hunk Desktop writes (wrappedTextHunk): the run's own bytes, in its tag.
function textWrapEdits(source: string, node: ParserNode, name: 'div' | 'span'): Edit[] {
  if (node.kind !== 'text') {
    throw new Error('Only plain text converts to a tag');
  }
  const planner = sourcePlanner(source);
  const { span } = planner.anchor(node);
  const range = bounds(node);
  const hunk = wrappedTextHunk(source.slice(range.start, range.end), span, name);
  if (hunk === undefined) {
    throw new Error('This text is blank');
  }
  const planned = planner.plan(node, { tag: 'rewrite-node', hunks: [hunk] });
  assert(planned.length === 1, 'A wrapped run is one source splice');
  const edit = planned[0];
  assert(edit !== undefined, 'The wrapped run splice is present');
  // Applied as the two tags alone. The words keep their shared-text characters,
  // which is what the room reads a selection through: after this edit
  // (actionSelection.ts) the first new node is the element, and after an undo the
  // anchor falls back onto the words (selectionPositions.ts).
  return [
    { start: edit.start, end: edit.start, text: `<${name}>` },
    { start: edit.end, end: edit.end, text: `</${name}>` },
  ];
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
  const planner = sourcePlanner(source);
  const placement = !action.placement || action.placement === 'inside' ? 'last-child' : action.placement;
  // A printed fragment starts at column zero and ends its last line. The planner
  // places its first line and the gaps around it; the rest is indented to match.
  const printed = fragment.replace(/\r?\n$/, '');
  const edits = planner.plan(target, {
    tag: 'insert-node',
    placement,
    source: indentedFragment(printed, planner.indent(target, placement), eol),
  });
  assert(edits.length === 1, 'A markup insertion has one source splice');
  const edit = edits[0];
  assert(edit !== undefined, 'The insertion splice is present');
  return edit;
}
