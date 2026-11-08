// Planning the tree operations (plan §3.3, §3.4): `insert-node`, `remove-node`,
// `move-node` and step 9's `wrap-nodes`. A removal takes the node's bytes and the whitespace that
// set it apart; an insertion is a splice beside or inside a resolved node,
// separated the way that node is separated from what precedes it unless the
// layout rule below says otherwise; a move is the two at once, and relocates the
// node's original bytes —
// it never prints the node again. Leaving a loop, the moved bytes lose their
// references to the loop's item (loopScope.ts, stripEdits): an expression
// becomes text, the one kind change a move makes.
//
// A node travels with its label: the comment the Navigator folds into its row
// (shared/page/leadingNote.ts). A move relocates the label's bytes, the gap after
// it and the node as one run; a removal takes the run; a move placed before a
// labelled node lands above that node's label, never between the two. Without
// that the label stayed behind as an orphan row and re-attached to whichever
// node came to follow it, so moving one section swapped its neighbours' labels.
//
// Every rejection is decided in the three plan functions; the helpers compute.
import { assert } from '../core/assert';
import { indentUnitOf } from '../core/indent';
import { HTML_INLINE_REPLACED_TAGS, HTML_PHRASING_TAGS, HTML_TEXT_ONLY_PARENTS, HTML_VOID_TAGS, HTML_WHITESPACE_TAGS } from '../page/htmlTags';
import type { Operation, Placement, RejectionReason } from './intent';
import { labelsNode } from '../page/leadingNote';
import { stripEdits, scopeAt, type SourceReplacement } from './loopScope';
import type { ByteRelocation, Plan, PostKind, Splice } from './planner';
import {
  blankText,
  closeTagStart,
  containsNewline,
  lineIndent,
  nodeAtPath,
  nodeEditable,
  nodePlaceable,
  nodeUnchanged,
  openTagEnd,
  parentPath,
  resolveTarget,
  samePath,
  siblingsOf,
  slice,
  startsWith,
  tagNameEnd,
  textOf,
  validProjections,
  whitespaceAfter,
  whitespaceBefore,
  type PlanContext,
  type Target,
  type ValidProjection,
} from './planSupport';
import { toChildIndex, type AnchorRef } from '../page/ref';
import { err, ok, type Result } from '../core/result';
import { markdownPrefix } from './markdownLayout';
import { itemMarker, markdownBeside, markdownInsertion, markdownRemoval, markdownRemoved, reprefixed } from './planMarkdown';
import type { NodeList, ProjectedNode } from '../page/sourceProjection';
import { encodeUtf8, toByteSpan, toByteString, type ByteSpan, type ByteString } from '../core/span';

const NEWLINE = 0x0a;

/** What an insertion writes: a zero-width point, or in Markdown the gap it
 * rewrites (planMarkdown.ts), and the text that goes there. */
interface Insertion {
  readonly range: ByteSpan;
  readonly text: string;
  /** Where the anchor node sits once the text is in: an insertion before it
   * shifts it one sibling on. Undefined when no path can be stated: see
   * besideAnchorPath. */
  readonly anchorPath: readonly number[] | undefined;
}

export function planRemoveNode(context: PlanContext, anchor: AnchorRef): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!movable(target.current.kind)) {
    return err('unsupported-operation'); // A branch or a chunk group is structure.
  }
  if (!nodePlaceable(target.current)) {
    return err('unsupported-operation');
  }
  if (!nodeUnchanged(context, target)) {
    return err('region-externally-modified');
  }
  const current = currentProjection(context);
  const node = target.current;
  switch (node.list) {
    case 'markup': {
      if (leavesCodeEmpty(context.current.bytes, current, node)) {
        return err('unsupported-operation');
      }
      return ok(removalPlan(context.current.bytes, current, node, removalRange));
    }
    case 'blocks':
    case 'items': {
      const removed = markdownRemoved(current, node);
      if (!nodePlaceable(removed)) {
        return err('unsupported-operation'); // The list an only item takes is not placeable.
      }
      const removal = markdownRemoval(context.current.bytes, current, removed);
      if (removal === undefined) {
        return err('unsupported-operation'); // No prefix to write the blank line with.
      }
      const splice = spliceAt(context.current.bytes, removal.range, removal.text);
      const postKinds = parentKind(current, removed);
      return ok({ splices: [splice], postKinds, candidate: 'must-parse' });
    }
    case 'inline':
      return err('unsupported-operation'); // A block's own text: edited, never removed.
    default: {
      const exhaustive: never = node.list;
      return exhaustive;
    }
  }
}

function removalPlan(
  bytes: ByteString,
  projection: ValidProjection,
  node: ProjectedNode,
  range: (bytes: ByteString, projection: ValidProjection, node: ProjectedNode) => ByteSpan,
): Plan {
  const splice = spliceAt(bytes, range(bytes, projection, node), '');
  return { splices: [splice], postKinds: parentKind(projection, node), candidate: 'must-parse' };
}

export function planInsertNode(context: PlanContext, anchor: AnchorRef, operation: Extract<Operation, { tag: 'insert-node' }>): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!placeWritable(context.current.bytes, currentProjection(context), target.current, operation.placement)) {
    return err('unsupported-operation');
  }
  const current = currentProjection(context);
  const insertion = insertionAt(context.current.bytes, current, target.current, operation.placement, { text: operation.source, origin: 'new' });
  if (!insertion.ok) {
    return insertion;
  }
  const splice = spliceAt(context.current.bytes, insertion.value.range, insertion.value.text);
  const anchorPath = insertion.value.anchorPath;
  const postKinds = anchorPath === undefined ? [] : [{ path: anchorPath.map(toChildIndex), kind: target.current.kind }];
  return ok({ splices: [splice], postKinds, candidate: 'must-parse' });
}

/** `wrap-nodes` (step 9): a run of siblings, the anchor through `last`, put
 * inside a new tag — its opening before the first, its closing after the
 * last. Both ends are resolved like any anchor; what lies between them is
 * kept whole, whoever wrote it, and nothing is re-indented. Siblings of one
 * list only, in order, and never code a loop or a condition owns. */
export function planWrapNodes(context: PlanContext, anchor: AnchorRef, operation: Extract<Operation, { tag: 'wrap-nodes' }>): Result<Plan, RejectionReason> {
  const first = resolveTarget(context, anchor);
  if (!first.ok) {
    return first;
  }
  const last = resolveTarget(context, operation.last);
  if (!last.ok) {
    return last;
  }
  const start = first.value.current;
  const end = last.value.current;
  if (!movable(start.kind) || !movable(end.kind)) {
    return err('unsupported-operation');
  }
  if (!nodePlaceable(start) || !nodePlaceable(end)) {
    return err('unsupported-operation');
  }
  if (!samePath(parentPath(start.path), parentPath(end.path))) {
    return err('unsupported-operation'); // Not one run of siblings.
  }
  if (start.list !== 'markup') {
    return err('unsupported-operation'); // A tag around Markdown blocks is not Markdown.
  }
  if (end.span.start < start.span.start) {
    return err('unsupported-operation');
  }
  const bytes = context.current.bytes;
  const splices = [
    spliceAt(bytes, toByteSpan(start.span.start, start.span.start), operation.open),
    spliceAt(bytes, toByteSpan(end.span.end, end.span.end), operation.close),
  ];
  assert(start.span.start < end.span.end, 'A run of nodes covers at least one byte');
  return ok({ splices, postKinds: [], candidate: 'must-parse' });
}

/** `append-body` (step 9): the first node of a page whose body is empty — no
 * node to stand beside, so the anchor is the document. It goes at the end of
 * the file, on a line of its own. A body that gained a node since was written
 * by someone else; the insertion is refused, to be stated beside a node. */
export function planAppendBody(context: PlanContext, anchor: AnchorRef, operation: Extract<Operation, { tag: 'append-body' }>): Result<Plan, RejectionReason> {
  assert(anchor.expectedKind === 'document', 'An append anchors the whole document');
  const projections = validProjections(context);
  if (!projections.ok) {
    return projections;
  }
  if (projections.value.current.nodes.length > 0) {
    return err('anchor-moved');
  }
  const bytes = context.current.bytes;
  const end = bytes.length;
  const crlf = end > 1 && bytes[end - 2] === 0x0d && bytes[end - 1] === NEWLINE;
  const eol = crlf || bytesHaveCrlf(bytes) ? '\r\n' : '\n';
  const lead = end === 0 || bytes[end - 1] === NEWLINE ? '' : eol;
  const splice = spliceAt(bytes, toByteSpan(end, end), `${lead}${operation.source}${eol}`);
  return ok({ splices: [splice], postKinds: [], candidate: 'must-parse' });
}

function bytesHaveCrlf(bytes: ByteString): boolean {
  for (let index = 1; index < bytes.length; index++) {
    if (bytes[index] === NEWLINE) {
      return bytes[index - 1] === 0x0d; // The file's first line break decides.
    }
  }
  return false;
}

// A node inside a loop is one source node the loop repeats (plan §6). A move
// within its markup container preserves those bytes and bindings. Leaving a
// loop rewrites only references the destination cannot satisfy (§3.3). The
// loop's direct return roots remain code-owned, not a markup sibling list.
export function planMoveNode(context: PlanContext, anchor: AnchorRef, operation: Extract<Operation, { tag: 'move-node' }>): Result<Plan, RejectionReason> {
  const source = resolveTarget(context, anchor);
  if (!source.ok) {
    return source;
  }
  const destination = resolveTarget(context, operation.destination);
  if (!destination.ok) {
    return destination;
  }
  const moved = source.value.current;
  if (!movable(moved.kind)) {
    return err('unsupported-operation');
  }
  if (!nodePlaceable(moved)) {
    if (moved.capability !== 'repeated-source-node') {
      return err('unsupported-operation');
    }
  }
  if (!placeWritable(context.current.bytes, currentProjection(context), destination.value.current, operation.placement)) {
    return err('unsupported-operation');
  }
  if (startsWith(destination.value.current.path, moved.path)) {
    return err('unsupported-operation'); // Into itself or its own subtree.
  }
  if (!nodeUnchanged(context, source.value)) {
    return err('region-externally-modified');
  }
  const current = currentProjection(context);
  const list = listAt(current, destination.value.current, operation.placement);
  if (list !== moved.list) {
    return err('unsupported-operation'); // A block among items, markup among blocks: not a move.
  }
  switch (list) {
    case 'markup':
      if (leavesCodeEmpty(context.current.bytes, current, moved)) {
        return err('unsupported-operation');
      }
      return planRelocation(context, source.value, destination.value, operation.placement);
    case 'blocks':
    case 'items':
      return planMarkdownRelocation(context, moved, destination.value.current, operation.placement);
    case 'inline':
      return err('unsupported-operation');
    default: {
      const exhaustive: never = list;
      return exhaustive;
    }
  }
}

// A Markdown block or item moved: its bytes, their continuation lines carrying
// the destination's prefix, separated there as its neighbours are; its old
// place removed as a removal would. An item keeps its marker, so it moves only
// among items written with the same one — another starts a new list.
function planMarkdownRelocation(context: PlanContext, moved: ProjectedNode, destination: ProjectedNode, placement: Placement): Result<Plan, RejectionReason> {
  const bytes = context.current.bytes;
  const current = currentProjection(context);
  const beside = markdownBeside(current, destination, placement);
  if (beside === undefined) {
    return err('unsupported-operation');
  }
  if (moved.list === 'items') {
    if (itemMarker(bytes, moved) !== itemMarker(bytes, beside.node)) {
      return err('unsupported-operation');
    }
  }
  const prefix = markdownPrefix(bytes, beside.node.span.start);
  const text = prefix === undefined ? undefined : reprefixed(bytes, moved, prefix);
  if (text === undefined) {
    return err('unsupported-operation'); // A line whose container is not written out.
  }
  const anchorPath = placement === 'before' ? shifted(destination.path) : destination.path;
  const insertion = markdownInsertion(bytes, current, beside, anchorPath, text);
  if (insertion === undefined) {
    return err('unsupported-operation');
  }
  const removal = markdownRemoval(bytes, current, markdownRemoved(current, moved));
  if (removal === undefined) {
    return err('unsupported-operation');
  }
  return relocationSplices(bytes, insertion, removal, { span: moved.span, text });
}

function planRelocation(context: PlanContext, source: Target, destination: Target, placement: Placement): Result<Plan, RejectionReason> {
  const bytes = context.current.bytes;
  const current = currentProjection(context);
  const text = relocatedText(bytes, current, source.current, destination.current, placement);
  if (!text.ok) {
    return text;
  }
  // Before a labelled node is above its label: between the two, the moved node
  // would take the label over and leave its owner without one.
  const landing = placement === 'before' ? (labelOf(bytes, current, destination.current) ?? destination.current) : destination.current;
  const insertion = insertionAt(bytes, current, landing, placement, { text: text.value, origin: 'relocated' });
  if (!insertion.ok) {
    return insertion;
  }
  const removal = { range: removalRange(bytes, current, source.current), text: '' };
  // The provenance is the node's own bytes, found once in what lands: a label's
  // gap may be re-indented on the way (labelRealigned), but the node never is, so
  // its handles, and the selection they carry, follow it on every path.
  return relocationSplices(bytes, insertion.value, removal, {
    span: source.current.span,
    text: textOf(bytes, source.current.span),
  });
}

// The insertion and the removal of one move, refused when the new place lies
// inside the old one (or, in Markdown, rewrites a gap the removal takes).
function relocationSplices(
  bytes: ByteString,
  insertion: Pick<Insertion, 'range' | 'text'>,
  removal: { readonly range: ByteSpan; readonly text: string },
  moved: { readonly span: ByteSpan; readonly text: string },
): Result<Plan, RejectionReason> {
  const into = insertion.range;
  const out = removal.range;
  if (overlaps(into, out)) {
    return err('unsupported-operation'); // Beside itself: a move that goes nowhere.
  }
  // Ascending, the insertion first when both start at one byte (orderedSplices
  // keeps that order, and the zero-width splice ends where the removal starts).
  const insert = spliceAt(bytes, into, insertion.text);
  const remove = spliceAt(bytes, out, removal.text);
  const splices = into.end <= out.start ? [insert, remove] : [remove, insert];
  const relocation = relocationOf(bytes, insertion, remove, moved);
  return ok({ splices, relocation, postKinds: [], candidate: 'must-parse' });
}

// Only the move planner may supply this provenance. Searching its insertion
// locates the original subtree within formatting added at the destination;
// it never searches the document for a substitute. Rewritten loop bindings or
// Markdown prefixes have no unchanged byte image and keep the existing refusal.
function relocationOf(
  bytes: ByteString,
  insertion: Pick<Insertion, 'range' | 'text'>,
  removal: Splice,
  moved: { readonly span: ByteSpan; readonly text: string },
): ByteRelocation | undefined {
  const source = moved.span;
  assert(removal.range.start <= source.start, 'The move removes its source start');
  assert(source.end <= removal.range.end, 'The move removes its source end');
  const original = textOf(bytes, source);
  assert(original.length > 0, 'A moved subtree has source text');
  if (original !== moved.text) {
    return undefined;
  }
  const offset = insertion.text.indexOf(original);
  if (offset < 0) {
    return undefined;
  }
  if (insertion.text.indexOf(original, offset + 1) !== -1) {
    return undefined;
  }
  const shift = removal.range.end <= insertion.range.start ? removal.replacementBytes.length - removal.expectedBytes.length : 0;
  const start = insertion.range.start + shift + encodeUtf8(insertion.text.slice(0, offset)).length;
  const target = toByteSpan(start, start + source.end - source.start);
  return { source, target };
}

// Whether an insertion lands inside a removal: a point strictly inside it, or
// a rewritten gap sharing any byte with it. Touching at an edge is not.
function overlaps(into: ByteSpan, out: ByteSpan): boolean {
  if (into.start === into.end) {
    if (out.start < into.start) {
      return into.start < out.end;
    }
    return false;
  }
  if (out.start < into.end) {
    return into.start < out.end;
  }
  return false;
}

function point(at: number): ByteSpan {
  return toByteSpan(at, at);
}

// The moved bytes, minus the loop references the destination cannot satisfy.
function relocatedText(
  bytes: ByteString,
  projection: ValidProjection,
  moved: ProjectedNode,
  destination: ProjectedNode,
  placement: Placement,
): Result<string, RejectionReason> {
  const before = scopeAt(projection, bytes, moved.path);
  const destinationPath = inside(placement) ? [...destination.path, toChildIndex(0)] : destination.path;
  const after = scopeAt(projection, bytes, destinationPath);
  if (before === undefined) {
    return err('unsupported-operation'); // A loop head this cannot read.
  }
  if (after === undefined) {
    return err('unsupported-operation');
  }
  const lost = before.filter((name) => !after.includes(name));
  const edits = lost.length === 0 ? [] : stripEdits(projection, bytes, moved, lost);
  if (edits === undefined) {
    return err('unsupported-operation');
  }
  // The label and the gap below it go along unchanged: the loop's references
  // the edits strip all lie inside the node itself.
  const relocated = withReplacements(bytes, labelledSpan(bytes, projection, moved), edits);
  const text = textOf(relocated, toByteSpan(0, relocated.length));
  return ok(labelRealigned(bytes, projection, moved, text, insertedIndent(bytes, projection, destination, placement)));
}

// A label written on its own line above its node keeps its node in line with it
// at the new depth: the gap's indent becomes the indent the label lands at. Only
// a gap indented as the label's own line is rewritten; anything else the author
// laid out on purpose is kept.
function labelRealigned(bytes: ByteString, projection: ValidProjection, moved: ProjectedNode, text: string, landing: string): string {
  const label = labelOf(bytes, projection, moved);
  if (label === undefined) {
    return text;
  }
  const gap = textOf(bytes, toByteSpan(label.span.end, moved.span.start));
  const newline = gap.lastIndexOf('\n');
  if (newline < 0) {
    return text; // Label and node share a line.
  }
  if (gap.slice(newline + 1) !== lineIndent(bytes, label.span.start)) {
    return text;
  }
  const labelText = textOf(bytes, label.span);
  assert(text.startsWith(labelText + gap), 'labelRealigned: the moved text opens with its label and gap');
  return `${labelText}${gap.slice(0, newline + 1)}${landing}${text.slice(labelText.length + gap.length)}`;
}

// The bytes of `span` with each edit (absolute, ascending, inside it) applied.
function withReplacements(bytes: ByteString, span: ByteSpan, edits: readonly SourceReplacement[]): ByteString {
  const parts: Uint8Array[] = [];
  let cursor = span.start;
  for (const edit of edits) {
    assert(cursor <= edit.span.start, 'Replacements ascend without overlapping');
    assert(edit.span.end <= span.end, 'Replacements lie inside the moved node');
    parts.push(bytes.subarray(cursor, edit.span.start), encodeUtf8(edit.text));
    cursor = edit.span.end;
  }
  parts.push(bytes.subarray(cursor, span.end));
  const size = parts.reduce((total, part) => total + part.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return toByteString(joined);
}

function inCode(projection: ValidProjection, node: ProjectedNode): boolean {
  if (node.path.length === 1) {
    return false;
  }
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  return parent.kind === 'branch' || parent.kind === 'map';
}

// A condition's branch and a loop's body are JavaScript around markup: taking
// out the only node leaves `cond && ( )`, which the parser reads but no
// JavaScript engine will run. The legacy printer writes `null` there; until a
// planner rule does, such a removal is refused and the page saved whole.
function leavesCodeEmpty(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): boolean {
  if (node.path.length === 1) {
    return false;
  }
  if (!inCode(projection, node)) {
    return false;
  }
  const label = labelOf(bytes, projection, node); // Goes with the node, so it fills nothing.
  const others = siblingsOf(projection, node).filter((sibling) => sibling !== node && sibling !== label && !blankText(bytes, sibling));
  return others.length === 0;
}

/** What a removal takes: the node with its label (labelledSpan) and the
 * preceding whitespace-only separator; otherwise the whitespace after
 * it through the first line break, so no blank line is left; otherwise the
 * node alone (it sat inline). The runs never cross a sibling or the parent. */
export function removalRange(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): ByteSpan {
  const first = labelOf(bytes, projection, node) ?? node;
  const span = toByteSpan(first.span.start, node.span.end);
  const floor = siblingBounds(bytes, projection, first).floor;
  const ceiling = siblingBounds(bytes, projection, node).ceiling;
  const before = whitespaceBefore(bytes, span.start, floor);
  if (before < span.start) {
    return toByteSpan(before, span.end);
  }
  const after = whitespaceAfter(bytes, span.end, ceiling);
  const newline = bytes.subarray(span.end, after).indexOf(0x0a);
  if (newline >= 0) {
    return toByteSpan(span.start, span.end + newline + 1);
  }
  return span;
}

/** The comment that labels `node`, when one does: its sibling directly before
 * it, read by the Navigator's rule (shared/page/leadingNote.ts). Blank text in
 * an inline run is a sibling like any other, as it is in the Navigator's list. */
export function labelOf(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): ProjectedNode | undefined {
  const siblings = siblingsOf(projection, node);
  const index = siblings.indexOf(node);
  assert(index >= 0, 'labelOf: a node is among its siblings');
  const previous = siblings[index - 1];
  if (previous === undefined) {
    return undefined;
  }
  if (!labelsNode(previous.kind, node.kind)) {
    return undefined;
  }
  assert(previous.span.end <= node.span.start, 'labelOf: a label precedes its node');
  assert(textOf(bytes, toByteSpan(previous.span.end, node.span.start)).trim() === '', 'labelOf: only whitespace parts a label from its node');
  return previous;
}

/** The bytes a node takes with its label: from the label's start through the
 * node's end, the gap between them included; the node's own span without one.
 * What a move carries and a duplicate copies. */
export function labelledSpan(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): ByteSpan {
  const label = labelOf(bytes, projection, node);
  if (label === undefined) {
    return node.span;
  }
  assert(label.span.start < node.span.start, 'labelledSpan: a label starts before its node');
  return toByteSpan(label.span.start, node.span.end);
}

function insertionAt(
  bytes: ByteString,
  projection: ValidProjection,
  anchor: ProjectedNode,
  placement: Placement,
  written: Written,
): Result<Insertion, RejectionReason> {
  if (listAt(projection, anchor, placement) !== 'markup') {
    return markdownInsertionAt(bytes, projection, anchor, placement, written.text);
  }
  if (inside(placement)) {
    return insertionInside(bytes, projection, anchor, placement, written);
  }
  if (!movable(anchor.kind)) {
    return err('unsupported-operation'); // Beside a branch is inside its condition.
  }
  if (inCode(projection, anchor)) {
    // A condition's branch or a loop's body is JavaScript around markup: a
    // second node beside the first can land outside the parentheses (a bare
    // `: other ? …` branch) and break the expression. The legacy printer
    // rewraps it; until a planner rule does, the page is saved whole. Between
    // two roots of a loop written as markup, the node joins the run of
    // siblings the parentheses already hold.
    if (!betweenLoopRoots(bytes, projection, anchor, placement)) {
      return err('unsupported-operation');
    }
  }
  return ok(
    insertionBeside(bytes, projection, anchor, placement === 'after' ? 'after' : 'before', written, besideAnchorPath(bytes, projection, anchor, placement)),
  );
}

// Beside a node the anchor's path is known unless the parser reads its siblings'
// gaps as text. Those gaps exist only while the whole run is inline: a copied
// separator adds one, and a block in the run takes them all away, so the anchor's
// index is the new parse's to say. Claiming one refused a valid insertion.
function besideAnchorPath(bytes: ByteString, projection: ValidProjection, anchor: ProjectedNode, placement: Placement): readonly number[] | undefined {
  assert(!inside(placement), 'Inside a parent the anchor is the parent');
  assert(anchor.path.length > 0, 'A tree node has a path');
  if (siblingsOf(projection, anchor).some((sibling) => blankText(bytes, sibling))) {
    return undefined;
  }
  return placement === 'after' ? anchor.path : shifted(anchor.path);
}

// Beside a sibling: on a line of its own when it is new block structure, otherwise
// separated as the sibling is (layoutRule, below).
function insertionBeside(
  bytes: ByteString,
  projection: ValidProjection,
  anchor: ProjectedNode,
  side: 'before' | 'after',
  written: Written,
  anchorPath: readonly number[] | undefined,
): Insertion {
  const lined = written.origin === 'new' ? insertionOnOwnLine(bytes, projection, anchor, side, written.text) : undefined;
  if (lined !== undefined) {
    return { ...lined, anchorPath };
  }
  const separator = written.origin === 'new' ? separatorBeside(bytes, projection, anchor, written.text) : separatorBefore(bytes, projection, anchor);
  if (side === 'after') {
    return { range: point(anchor.span.end), text: `${separator}${written.text}`, anchorPath };
  }
  return { range: point(anchor.span.start), text: `${written.text}${separator}`, anchorPath };
}

// Beside a Markdown block or item, or inside a quote, an item or a list next
// to its first or last child (planMarkdown.ts). A block's inline text has no
// siblings, and an empty container no line to take a prefix from.
function markdownInsertionAt(
  bytes: ByteString,
  projection: ValidProjection,
  anchor: ProjectedNode,
  placement: Placement,
  text: string,
): Result<Insertion, RejectionReason> {
  const beside = markdownBeside(projection, anchor, placement);
  if (beside === undefined) {
    return err('unsupported-operation');
  }
  if (beside.node.list === 'inline') {
    return err('unsupported-operation');
  }
  if (beside.node.list === 'markup') {
    return err('unsupported-operation'); // Markup inside a Markdown container: its own rules.
  }
  const anchorPath = placement === 'before' ? shifted(anchor.path) : anchor.path;
  const insertion = markdownInsertion(bytes, projection, beside, anchorPath, text);
  return insertion === undefined ? err('unsupported-operation') : ok(insertion);
}

/** The list a node placed at `placement` of `anchor` joins: the anchor's own
 * beside it; inside it, the list its children sit in — markup inside markup,
 * and inside a Markdown node whatever its first child says (an empty one says
 * nothing Markdown can place into: `inline`). */
function listAt(projection: ValidProjection, anchor: ProjectedNode, placement: Placement): NodeList {
  if (!inside(placement)) {
    return anchor.list;
  }
  if (anchor.syntax === 'markup') {
    return 'markup';
  }
  const [first] = childrenOf(projection, anchor);
  return first === undefined ? 'inline' : first.list;
}

// Inside a tag, loop, or condition branch: beside its first or last child. An
// empty tag takes its child between its tags, on lines of its own when the layout
// rule allows; an empty branch replaces its `null` placeholder. A self-closing
// non-void tag gains a closing tag with its first child.
function insertionInside(
  bytes: ByteString,
  projection: ValidProjection,
  parent: ProjectedNode,
  placement: Placement,
  written: Written,
): Result<Insertion, RejectionReason> {
  const text = written.text;
  const tag = parent.kind === 'element' || parent.kind === 'component';
  const structure = parent.kind === 'map' || parent.kind === 'branch';
  if (!tag && !structure) {
    return err('unsupported-operation');
  }
  const children = childrenOf(projection, parent);
  const first = children[0];
  const last = children[children.length - 1];
  if (first !== undefined) {
    if (last !== undefined) {
      const beside = placement === 'first-child' ? first : last;
      const anchorPath = parent.path;
      const preserved = branchChildAsMarkup(bytes, parent, beside);
      if (preserved !== undefined) {
        if (placement !== 'first-child') {
          return err('unsupported-operation');
        }
        const separator = separatorBefore(bytes, projection, beside);
        return ok({ range: beside.span, text: `${text}${separator}${preserved}`, anchorPath });
      }
      return ok(insertionBeside(bytes, projection, beside, placement === 'first-child' ? 'before' : 'after', written, anchorPath));
    }
  }
  if (parent.kind === 'branch') {
    return ok({ range: parent.span, text, anchorPath: parent.path });
  }
  if (parent.kind === 'map') {
    // A loop with nothing in it yet returns `(null)`: the serializer writes
    // that, because `() => ()` does not parse. Its first item takes the
    // placeholder's place, which leaves `=> (<item />)`, the loop's markup form.
    const placeholder = emptyLoopPlaceholder(bytes, parent);
    if (placeholder === undefined) {
      return err('unsupported-operation'); // An empty callback this cannot read.
    }
    return ok({ range: placeholder, text, anchorPath: parent.path });
  }
  if (!tag) {
    return err('unsupported-operation');
  }
  const open = openTagEnd(bytes, parent);
  if (open.selfClosing) {
    const name = textOf(bytes, toByteSpan(parent.span.start + 1, tagNameEnd(bytes, parent)));
    if (parent.kind === 'element' && HTML_VOID_TAGS.has(name.toLowerCase())) {
      return err('unsupported-operation');
    }
    return ok(insertionIntoSelfClosingTag(bytes, projection, parent, open.end, text));
  }
  const close = closeTagStart(bytes, parent, open.end);
  if (close === undefined) {
    return err('unsupported-operation');
  }
  return ok(insertionIntoEmptyTag(bytes, projection, parent, toByteSpan(open.end, close), text));
}

// An empty tag's gap is whitespace at most. One already holding a line break keeps
// it for the closing tag; otherwise the rule decides, and the gap gives way to the
// lines it writes. Where whitespace is content nothing is added at all.
function insertionIntoEmptyTag(bytes: ByteString, projection: ValidProjection, parent: ProjectedNode, gap: ByteSpan, text: string): Insertion {
  assert(gap.start <= gap.end, 'A tag closes after it opens');
  assert(textOf(bytes, gap).trim().length === 0, 'An empty tag holds whitespace at most');
  const anchorPath = parent.path;
  if (parentFlow(bytes, projection, parent) === 'whitespace') {
    return { range: point(gap.start), text, anchorPath };
  }
  const eol = eolOf(bytes);
  const indent = `${lineIndent(bytes, parent.span.start)}${indentUnit(bytes)}`;
  if (containsNewline(bytes, gap)) {
    return { range: point(gap.start), text: `${eol}${indent}${text}`, anchorPath };
  }
  if (standsOnOwnLine(bytes, projection, parent, text)) {
    return { range: gap, text: `${eol}${indent}${text}${eol}${lineIndent(bytes, parent.span.start)}`, anchorPath };
  }
  return { range: point(gap.start), text, anchorPath };
}

function insertionIntoSelfClosingTag(bytes: ByteString, projection: ValidProjection, parent: ProjectedNode, openEnd: number, text: string): Insertion {
  assert(parent.kind === 'component' || parent.kind === 'element', 'A paired conversion starts from a tag');
  const slash = openEnd - 2;
  assert(bytes[slash] === 0x2f, 'A self-closing component ends in a slash');
  const nameSpan = toByteSpan(parent.span.start + 1, tagNameEnd(bytes, parent));
  const name = textOf(bytes, nameSpan);
  assert(name.length > 0, 'A component has a written tag name');
  const range = toByteSpan(selfClosingTailStart(bytes, slash), openEnd);
  const eol = eolOf(bytes);
  const outer = lineIndent(bytes, parent.span.start);
  const body = standsOnOwnLine(bytes, projection, parent, text) ? `${eol}${outer}${indentUnit(bytes)}${text}${eol}${outer}` : text;
  return {
    range,
    text: `>${body}</${name}>`,
    anchorPath: parent.path,
  };
}

// On one line, remove the cosmetic space before `/>`; on a line of its own,
// preserve indentation so the closing bracket stays aligned with the tag.
function selfClosingTailStart(bytes: ByteString, slash: number): number {
  let start = slash;
  while (start > 0) {
    const previous = bytes[start - 1];
    assert(previous !== undefined, 'The self-closing tail lies inside the bytes');
    if (previous !== 0x20 && previous !== 0x09) {
      break;
    }
    start--;
  }
  return bytes[start - 1] === NEWLINE ? slash : start;
}

// A value or nested condition is code while it is the branch's only child.
// Once markup stands beside it, braces are what keep that code an Astro
// expression instead of turning its tokens into text nodes.
function branchChildAsMarkup(bytes: ByteString, parent: ProjectedNode, child: ProjectedNode): string | undefined {
  if (parent.kind !== 'branch') {
    return undefined;
  }
  if (child.kind !== 'cond' && child.kind !== 'expr') {
    return undefined;
  }
  assert(parent.span.start <= child.span.start, 'A branch child starts inside its branch');
  assert(child.span.end <= parent.span.end, 'A branch child ends inside its branch');
  const source = textOf(bytes, child.span);
  return source.startsWith('{') ? source : `{${source}}`;
}

// The `null` of an empty loop's `=> (null))}`, as the parser reads that form
// (astroTemplate.ts, parseMapEmpty). Anything else returning nothing is
// callback code, which the projection marks and placeWritable has refused.
const EMPTY_LOOP_TAIL = /=>[ \t\r\n]*\([ \t\r\n]*null[ \t\r\n]*\)[ \t\r\n]*\)[ \t\r\n]*\}?[ \t\r\n]*$/;

function emptyLoopPlaceholder(bytes: ByteString, loop: ProjectedNode): ByteSpan | undefined {
  assert(loop.kind === 'map', 'Only a loop holds an empty-loop placeholder');
  assert(loop.callback !== true, 'A callback loop is refused before its placeholder is read');
  const source = textOf(bytes, loop.span);
  const match = EMPTY_LOOP_TAIL.exec(source);
  if (match === null) {
    return undefined;
  }
  const keyword = source.lastIndexOf('null');
  assert(keyword > match.index, 'The placeholder lies inside the matched tail');
  // The tail after the keyword is ASCII whitespace and brackets, so its UTF-16
  // length is its length in bytes.
  const tailBytes = source.length - keyword;
  const start = loop.span.end - tailBytes;
  assert(start >= loop.span.start, 'The placeholder starts inside the loop');
  return toByteSpan(start, start + 'null'.length);
}

// How the node is set apart from what precedes it: the whitespace run between
// them, above its label when it has one (the gap under a label is not the
// node's separator). A root node with nothing before it on its line gets a line break.
function separatorBefore(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): string {
  const first = labelOf(bytes, projection, node) ?? node;
  const bounds = siblingBounds(bytes, projection, first);
  const start = whitespaceBefore(bytes, first.span.start, bounds.floor);
  const separator = textOf(bytes, toByteSpan(start, first.span.start));
  if (separator === '') {
    if (node.path.length === 1) {
      return '\n';
    }
  }
  return separator;
}

// A node's whitespace neighbourhood ends at its siblings, else at its parent's
// content (inside a tag's opening and closing), else at the file's body.
function siblingBounds(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): { readonly floor: number; readonly ceiling: number } {
  const { previous, next } = neighboursOf(bytes, projection, node);
  const outer = contentOf(bytes, projection, node);
  return {
    floor: previous === undefined ? outer.start : previous.span.end,
    ceiling: next === undefined ? outer.end : next.span.start,
  };
}

// The siblings either side of a node. Blank text between siblings is the separator
// itself, never a neighbour.
function neighboursOf(
  bytes: ByteString,
  projection: ValidProjection,
  node: ProjectedNode,
): { readonly previous: ProjectedNode | undefined; readonly next: ProjectedNode | undefined } {
  const siblings = siblingsOf(projection, node).filter((sibling) => sibling === node || !blankText(bytes, sibling));
  const index = siblings.indexOf(node);
  assert(index >= 0, 'A node is among its siblings');
  return { previous: siblings[index - 1], next: siblings[index + 1] };
}

// The bytes a node's parent holds its children in.
function contentOf(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): ByteSpan {
  if (node.path.length === 1) {
    const body = projection.frontmatter === undefined ? bomLength(bytes) : projection.frontmatter.end;
    return toByteSpan(body, bytes.length);
  }
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  if (parent.kind === 'element' || parent.kind === 'component') {
    const open = openTagEnd(bytes, parent);
    const close = closeTagStart(bytes, parent, open.end);
    assert(close !== undefined, 'A tag with children has a closing tag');
    return toByteSpan(open.end, close);
  }
  return parent.span;
}

// --- Layout of new source --------------------------------------------------------
//
// The layout rule. A line break is whitespace, so it goes only where a browser
// shows none, and only for code Stacki is writing:
//
// 1. Whitespace beside a block-level box, or at either edge of a block container,
//    never renders. So a block element stands on its own lines wherever it goes,
//    and any tag does at the edge of a flow container: `<div>`, `<section>`, `<li>`.
//    Words do not: `<div>Text</div>` is how the printer writes them too.
// 2. Between inline content a line break is a visible space, and the parser reads
//    it as a text node. So an inline element or words beside inline content touch
//    it, and inside a phrasing parent (`<p>`, `<h1>`, `<span>`, `<a>`) they stay on
//    the parent's line. A separator between two inline siblings is a space the
//    author chose and is copied; what is never copied is whitespace beside a block
//    or at the parent's edge, which renders nothing where it stands and a space
//    between two inline siblings.
// 3. In a whitespace element (`<pre>`, `<textarea>`, `<code>`, `<script>`, `<style>`)
//    or anywhere below one, whitespace is content: nothing is added, block or not.
// 4. A component renders what it likes, so it is known to be neither. It stands on
//    its own lines in a flow container or another component, whose edges are where
//    its own markup decides, and a phrasing element in a component stays tight: the
//    component may be a link.
// 5. Only the new node and the gaps around it change. A move relocates what is
//    already laid out: it takes rule 1 into an empty parent, where nothing else
//    stands, and otherwise keeps its neighbours' separators, so reordering a
//    one-line list leaves it one line. Block siblings the file wrote on one line
//    get a new block on its own line; a run with anything inline in it is left be.
//
// Tags are classified by the tables in htmlTags.ts, the ones the insert palette's
// `canContainTag` reads, so CSS display is not seen: an inline-block `<div>` is a
// block here.

/** What an insertion writes, and whether it is new here or relocated from elsewhere
 * in the file, whose layout the move keeps. */
interface Written {
  readonly text: string;
  readonly origin: 'new' | 'relocated';
}

/** How a node takes part in a line, from what can be read off its tag. */
type FlowLevel = 'block' | 'inline' | 'opaque' | 'text';

/** What a parent's content is. */
type ParentFlow = 'flow' | 'opaque' | 'phrasing' | 'whitespace';

const TAG_NAME_AT_START = /^<([A-Za-z][^\s/>]*)/;

/** A comment at the start of a fragment, with something written after it. */
const LEADING_NOTE = /^(?:\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->)(?=[\s\S]*\S)/;

/** The indentation a node placed at `placement` of `anchor` lands at: what a printed
 * node's later lines are indented to (indentedFragment). The node's siblings say,
 * when one stands at the start of a line. */
export function insertedIndent(bytes: ByteString, projection: ValidProjection, anchor: ProjectedNode, placement: Placement): string {
  assert(anchor.span.start <= anchor.span.end, 'An anchor covers its own bytes');
  assert(anchor.span.end <= bytes.length, 'An anchor lies inside the bytes');
  if (inside(placement)) {
    return childIndent(bytes, projection, anchor);
  }
  const parent = tagParent(projection, anchor);
  if (parent === undefined) {
    return lineIndent(bytes, anchor.span.start);
  }
  return startsLine(bytes, anchor.span.start) ? lineIndent(bytes, anchor.span.start) : childIndent(bytes, projection, parent);
}

/** Whether a new tag around `first` may stand on lines of its own: the same rule,
 * read from inside. A link around words keeps them tight, since a line break inside
 * it is an underlined space; around a block it is not. */
export function wrapperTakesLines(bytes: ByteString, projection: ValidProjection, first: ProjectedNode, name: string): boolean {
  assert(name.length > 0, 'A wrapper has a tag name');
  assert(first.span.end <= bytes.length, 'A wrapped node lies inside the bytes');
  const parent = tagParent(projection, first);
  if (parent !== undefined) {
    if (parentFlow(bytes, projection, parent) === 'whitespace') {
      return false;
    }
  }
  return tagLevel(name) === 'block' ? true : nodeLevel(bytes, first) === 'block';
}

// A new block beside block siblings the file wrote without a line break between
// them (rule 5). Undefined when the rule leaves the separator alone: the separator
// already breaks the line, or anything on either side might render the break.
function insertionOnOwnLine(
  bytes: ByteString,
  projection: ValidProjection,
  anchor: ProjectedNode,
  side: 'before' | 'after',
  text: string,
): Pick<Insertion, 'range' | 'text'> | undefined {
  const parent = tagParent(projection, anchor);
  if (parent === undefined) {
    return undefined; // A root, a loop's or a branch's child: copied as ever.
  }
  if (fragmentLevel(text) !== 'block') {
    return undefined;
  }
  if (parentFlow(bytes, projection, parent) === 'whitespace') {
    return undefined;
  }
  if (separatorBefore(bytes, projection, anchor).includes('\n')) {
    return undefined;
  }
  const neighbours = neighboursOf(bytes, projection, anchor);
  const previous = side === 'after' ? anchor : neighbours.previous;
  const next = side === 'after' ? neighbours.next : anchor;
  if (!blockOrEdge(bytes, previous)) {
    return undefined;
  }
  if (!blockOrEdge(bytes, next)) {
    return undefined;
  }
  const bounds = siblingBounds(bytes, projection, anchor);
  const gap = side === 'after' ? toByteSpan(anchor.span.end, bounds.ceiling) : toByteSpan(bounds.floor, anchor.span.start);
  assert(textOf(bytes, gap).trim().length === 0, 'Block siblings are set apart by whitespace at most');
  const eol = eolOf(bytes);
  const indent = childIndent(bytes, projection, parent);
  if (containsNewline(bytes, gap)) {
    return { range: point(gap.start), text: `${eol}${indent}${text}` }; // The next line is already written.
  }
  const after = next === undefined ? lineIndent(bytes, parent.span.start) : indent;
  return { range: gap, text: `${eol}${indent}${text}${eol}${after}` };
}

function blockOrEdge(bytes: ByteString, node: ProjectedNode | undefined): boolean {
  return node === undefined ? true : nodeLevel(bytes, node) === 'block';
}

// The separator a new node takes beside a sibling: the sibling's own, unless that
// renders nothing where it stands and both sides of the new seam are inline, where
// it would (rule 2).
function separatorBeside(bytes: ByteString, projection: ValidProjection, anchor: ProjectedNode, text: string): string {
  const separator = separatorBefore(bytes, projection, anchor);
  if (tagParent(projection, anchor) === undefined) {
    return separator;
  }
  if (!blockOrEdge(bytes, neighboursOf(bytes, projection, anchor).previous)) {
    return separator;
  }
  if (!inlineLevel(fragmentLevel(text))) {
    return separator;
  }
  return inlineLevel(nodeLevel(bytes, anchor)) ? '' : separator;
}

function inlineLevel(level: FlowLevel): boolean {
  return level === 'inline' || level === 'text';
}

// Rules 1, 3 and 4, for the first child of a tag with nothing in it.
function standsOnOwnLine(bytes: ByteString, projection: ValidProjection, parent: ProjectedNode, text: string): boolean {
  const flow = parentFlow(bytes, projection, parent);
  const level = fragmentLevel(text);
  switch (flow) {
    case 'whitespace':
      return false;
    case 'phrasing':
      return level === 'block';
    case 'opaque':
      return level === 'block' || level === 'opaque';
    case 'flow':
      return level !== 'text';
    default: {
      const exhaustive: never = flow;
      return exhaustive;
    }
  }
}

// What a parent holds, from its own tag. A whitespace element anywhere above it
// decides first: a `<div>` inside a `<pre>` still shows every line break. The walk
// is bounded by the path, whose depth the parser bounds.
function parentFlow(bytes: ByteString, projection: ValidProjection, parent: ProjectedNode): ParentFlow {
  assert(parent.kind === 'element' || parent.kind === 'component', 'Only a tag has a flow');
  for (let depth = parent.path.length; depth > 0; depth--) {
    const ancestor = nodeAtPath(projection, parent.path.slice(0, depth));
    assert(ancestor !== undefined, 'A node has every ancestor on its path');
    if (ancestor.kind === 'element') {
      if (HTML_WHITESPACE_TAGS.has(tagNameOf(bytes, ancestor))) {
        return 'whitespace';
      }
    }
  }
  if (parent.kind === 'component') {
    return 'opaque';
  }
  const name = tagNameOf(bytes, parent);
  if (name.includes('-')) {
    return 'opaque'; // A custom element is inline until its own CSS says otherwise.
  }
  if (HTML_TEXT_ONLY_PARENTS.has(name)) {
    return 'phrasing';
  }
  return HTML_PHRASING_TAGS.has(name) ? 'phrasing' : 'flow';
}

// The level of source about to be written, by what it starts with. `{title}` reads
// as words; a statement over several lines is a loop or condition, structure.
function fragmentLevel(text: string): FlowLevel {
  // A copied label renders nothing; the level is the labelled node's.
  const note = LEADING_NOTE.exec(text.trimStart());
  const trimmed = note === null ? text.trimStart() : text.trimStart().slice(note[0].length).trimStart();
  const name = TAG_NAME_AT_START.exec(trimmed)?.[1];
  if (name !== undefined) {
    return tagLevel(name);
  }
  if (trimmed.startsWith('<')) {
    return 'opaque'; // A comment, a doctype, a fragment.
  }
  if (trimmed.startsWith('{')) {
    return trimmed.includes('\n') ? 'opaque' : 'text';
  }
  return 'text';
}

function nodeLevel(bytes: ByteString, node: ProjectedNode): FlowLevel {
  switch (node.kind) {
    case 'element':
      return tagLevel(tagNameOf(bytes, node));
    case 'raw':
      return 'block'; // A `<style>` or `<script>` renders no box to sit beside.
    case 'text':
    case 'expr':
      return 'text';
    case 'component':
    case 'comment':
    case 'raw-line':
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return 'opaque';
    default: {
      const exhaustive: never = node.kind;
      return exhaustive;
    }
  }
}

function tagLevel(name: string): FlowLevel {
  assert(name.length > 0, 'A classified tag has a name');
  const lower = name.toLowerCase();
  if (name !== lower) {
    return 'opaque'; // A component, or a member of one.
  }
  if (name.includes('-')) {
    return 'opaque';
  }
  if (name.includes('.')) {
    return 'opaque';
  }
  if (HTML_PHRASING_TAGS.has(name)) {
    return 'inline';
  }
  return HTML_INLINE_REPLACED_TAGS.has(name) ? 'inline' : 'block';
}

function tagNameOf(bytes: ByteString, node: ProjectedNode): string {
  assert(node.kind === 'element' || node.kind === 'component', 'Only a tag has a name');
  return textOf(bytes, toByteSpan(node.span.start + 1, tagNameEnd(bytes, node))).toLowerCase();
}

// The parent whose lines a node's neighbours are laid out on: a tag, never a root's
// file or the JavaScript of a loop or a condition, which have their own rules.
function tagParent(projection: ValidProjection, node: ProjectedNode): ProjectedNode | undefined {
  if (node.path.length === 1) {
    return undefined;
  }
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  return parent.kind === 'element' || parent.kind === 'component' ? parent : undefined;
}

// Where a parent's children stand: as one that starts a line does, else a level in.
function childIndent(bytes: ByteString, projection: ValidProjection, parent: ProjectedNode): string {
  const lined = childrenOf(projection, parent).find((child) => !blankText(bytes, child) && startsLine(bytes, child.span.start));
  return lined === undefined ? `${lineIndent(bytes, parent.span.start)}${indentUnit(bytes)}` : lineIndent(bytes, lined.span.start);
}

function indentUnit(bytes: ByteString): string {
  return indentUnitOf(textOf(bytes, toByteSpan(0, bytes.length)));
}

function eolOf(bytes: ByteString): '\n' | '\r\n' {
  return bytesHaveCrlf(bytes) ? '\r\n' : '\n';
}

// Whether only indentation stands before `offset` on its line.
function startsLine(bytes: ByteString, offset: number): boolean {
  const indent = lineIndent(bytes, offset);
  const start = offset - indent.length;
  return start === 0 ? true : bytes[start - 1] === NEWLINE;
}

function bomLength(bytes: ByteString): number {
  if (bytes[0] === 0xef) {
    if (bytes[1] === 0xbb) {
      return bytes[2] === 0xbf ? 3 : 0;
    }
  }
  return 0;
}

function childrenOf(projection: ValidProjection, node: ProjectedNode): readonly ProjectedNode[] {
  return projection.nodes.filter((candidate) => candidate.path.length === node.path.length + 1 && startsWith(candidate.path, node.path));
}

function parentKind(projection: ValidProjection, node: ProjectedNode): readonly PostKind[] {
  if (node.path.length === 1) {
    return [];
  }
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  return [{ path: parent.path, kind: parent.kind }];
}

function currentProjection(context: PlanContext): ValidProjection {
  const projection = context.current.projection;
  assert(projection.tag === 'valid', 'A resolved target lies in a parsing file');
  return projection;
}

function shifted(path: readonly number[]): readonly number[] {
  const last = path[path.length - 1];
  assert(last !== undefined, 'A tree node has a path');
  return [...path.slice(0, -1), last + 1];
}

// Beside a node, the list it sits in is written; inside it, its own content.
function placeWritable(bytes: ByteString, projection: ValidProjection, node: ProjectedNode, placement: Placement): boolean {
  if (inside(placement)) {
    if (node.callback === true) {
      return false; // Separate return sites cannot receive one shared sibling insertion.
    }
    return nodeEditable(node);
  }
  if (node.capability === 'repeated-source-node') {
    // Repetition is inherited by every descendant. Only the immediate owner
    // decides whether siblings are markup or separate JavaScript return sites.
    const parent = nodeAtPath(projection, parentPath(node.path));
    assert(parent !== undefined, 'A repeated source node has an enclosing owner');
    assert(node.list === 'markup', 'Repeated source nodes belong to markup syntax');
    if (parent.kind === 'element' || parent.kind === 'component') {
      return true;
    }
    return betweenLoopRoots(bytes, projection, node, placement);
  }
  return nodePlaceable(node);
}

// Beside a root of a loop written as markup, `=> (<a /> <b />)`, with another
// root on that side: the insertion lands inside the run of siblings the
// parentheses hold, which the parser reads back as the loop's markup. At
// either edge it is addressed inside the loop instead (first-child or
// last-child, insertionInside), so it can never stand outside the run; and a
// callback's roots are separate JavaScript return sites, never one run.
function betweenLoopRoots(bytes: ByteString, projection: ValidProjection, node: ProjectedNode, placement: Placement): boolean {
  assert(!inside(placement), 'Only a placement beside a root stands between roots');
  assert(node.path.length > 1, 'A loop root has a parent');
  const parent = nodeAtPath(projection, parentPath(node.path));
  assert(parent !== undefined, 'A nested node has a parent');
  if (parent.kind !== 'map') {
    return false;
  }
  if (parent.callback === true) {
    return false;
  }
  const roots = siblingsOf(projection, node).filter((sibling) => !blankText(bytes, sibling));
  const index = roots.indexOf(node);
  assert(index >= 0, 'A loop root is among its siblings');
  if (placement === 'before') {
    return 0 < index;
  }
  return index + 1 < roots.length;
}

function inside(placement: Placement): boolean {
  switch (placement) {
    case 'first-child':
    case 'last-child':
      return true;
    case 'before':
    case 'after':
      return false;
    default: {
      const exhaustive: never = placement;
      return exhaustive;
    }
  }
}

// A branch belongs to its condition and a chunk group to its chunk file; the
// rest of the tree can be taken out, put back, or stood beside.
function movable(kind: ProjectedNode['kind']): boolean {
  switch (kind) {
    case 'branch':
    case 'chunk-group':
      return false;
    case 'component':
    case 'element':
    case 'raw':
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'map':
    case 'cond':
      return true;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function spliceAt(bytes: ByteString, range: ByteSpan, replacement: string): Splice {
  return {
    range,
    expectedBytes: slice(bytes, range),
    replacementBytes: encodeUtf8(replacement),
  };
}
