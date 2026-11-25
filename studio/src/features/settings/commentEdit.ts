// The Settings panel's Comment field, as Studio writes it: the comment that labels a
// node in the Navigator ("Section / What you can do") is added, reworded or cleared
// in the source. Which comment that is comes from the one shared rule
// (shared/page/leadingNote.ts), the one Desktop's field and the move planner use, so
// the field edits exactly the label the Navigator shows and a move carries.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { labelsNode } from '../../../vendor/stacki/shared/page/leadingNote';
import { noteText, noteValue } from '../../../vendor/stacki/src/editor/treeSelection';
import { bounds, parsePage, type Edit, type ParserNode } from '../source/source';

/** Nodes a page may hold, the walk's bound (as the parser bounds its tree). */
const COMMENT_WALK_NODES_MAX = 10_000;

/** The node and the comment labelling it, when one does. */
export function labelOf(source: string, id: string): { readonly node: ParserNode; readonly label: ParserNode | undefined } {
  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  const pending: (readonly ParserNode[])[] = [parsed.model.nodes];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < COMMENT_WALK_NODES_MAX, 'A page stays inside its node bound');
    const list = pending[visited];
    assert(list !== undefined, 'The visit index lies inside the list');
    for (const [index, node] of list.entries()) {
      if (node.id === id) {
        const previous = list[index - 1];
        return { node, label: previous !== undefined && labelsNode(previous.kind, node.kind) ? previous : undefined };
      }
      if (node.children !== undefined) {
        pending.push(node.children);
      }
    }
  }
  throw new Error('Selection changed. Select the element again.');
}

/** What the Comment field shows for a node: its label's words, without a divider rule. */
export function commentFieldValue(source: string, id: string): string {
  const { label } = labelOf(source, id);
  return label === undefined ? '' : noteText(label.value);
}

/** The label's own line, removed whole when it is alone on it, so no blank row is left.
 * This runs in the browser, so it cannot use the server's structural planner (whose
 * checksums need Node); a comment removal needs no more than its line. */
function removedLine(source: string, label: ParserNode): Edit {
  const range = bounds(label);
  const lineStart = source.lastIndexOf('\n', range.start - 1) + 1;
  const before = source.slice(lineStart, range.start);
  const after = /^[ \t]*\r?\n/.exec(source.slice(range.end))?.[0];
  if (/^[ \t]*$/.test(before) && after !== undefined) {
    return { start: lineStart, end: range.end + after.length, text: '' };
  }
  return { start: range.start, end: range.end, text: '' };
}

/** The edits that make `text` the node's label: a new comment written on the line
 * above it, the existing one reworded in its own syntax (a divider keeps its rule),
 * or, for empty text, the label removed with its line. */
export function commentEdits(source: string, id: string, text: string): readonly Edit[] {
  const { node, label } = labelOf(source, id);
  if (!labelsNode('comment', node.kind)) {
    throw new Error('Only an element or a component takes a comment.');
  }
  const value = noteValue(label?.value, text);
  if (value === undefined) {
    return label === undefined ? [] : [removedLine(source, label)];
  }
  if (label !== undefined) {
    const range = bounds(label);
    return [{ start: range.start, end: range.end, text: label.jsx === true ? `{/*${value}*/}` : `<!--${value}-->` }];
  }
  // New, it is written as Desktop prints a new note (astroSerialize.ts), on a line
  // of its own when the node starts one, so the two read as a heading and its section.
  const start = bounds(node).start;
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const indent = source.slice(lineStart, start);
  const ownLine = /^[ \t]*$/.test(indent);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return [{ start, end: start, text: ownLine ? `<!--${value}-->${eol}${indent}` : `<!--${value}--> ` }];
}
