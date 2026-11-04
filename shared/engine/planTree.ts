// Planning the tree operations (plan §3.3, §3.4): `insert-node`, `remove-node`,
// `move-node` and step 9's `wrap-nodes`. A removal takes the node's bytes and the whitespace that
// set it apart; an insertion is a zero-width splice beside or inside a
// resolved node, separated the way that node is separated from what precedes
// it; a move is the two at once, and relocates the node's original bytes —
// it never prints the node again. Leaving a loop, the moved bytes lose their
// references to the loop's item (loopScope.ts, stripEdits): an expression
// becomes text, the one kind change a move makes.
//
// Every rejection is decided in the three plan functions; the helpers compute.
import { assert } from '../core/assert';
import { HTML_VOID_TAGS } from '../page/htmlTags';
import type { Operation, Placement, RejectionReason } from './intent';
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
   * shifts it one sibling on. */
  readonly anchorPath: readonly number[];
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
  const insertion = insertionAt(context.current.bytes, current, target.current, operation.placement, operation.source);
  if (!insertion.ok) {
    return insertion;
  }
  const splice = spliceAt(context.current.bytes, insertion.value.range, insertion.value.text);
  const postKinds = [{ path: insertion.value.anchorPath.map(toChildIndex), kind: target.current.kind }];
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
  const insertion = insertionAt(bytes, current, destination.current, placement, text.value);
  if (!insertion.ok) {
    return insertion;
  }
  const removal = { range: removalRange(bytes, current, source.current), text: '' };
  return relocationSplices(bytes, insertion.value, removal, {
    span: source.current.span,
    text: text.value,
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
  const relocated = withReplacements(bytes, moved.span, edits);
  return ok(textOf(relocated, toByteSpan(0, relocated.length)));
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
  const others = siblingsOf(projection, node).filter((sibling) => sibling !== node && !blankText(bytes, sibling));
  return others.length === 0;
}

/** What a removal takes: the node and its preceding whitespace-only separator;
 * otherwise the whitespace after
 * it through the first line break, so no blank line is left; otherwise the
 * node alone (it sat inline). The runs never cross a sibling or the parent. */
export function removalRange(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): ByteSpan {
  const bounds = siblingBounds(bytes, projection, node);
  const before = whitespaceBefore(bytes, node.span.start, bounds.floor);
  if (before < node.span.start) {
    return toByteSpan(before, node.span.end);
  }
  const after = whitespaceAfter(bytes, node.span.end, bounds.ceiling);
  const newline = bytes.subarray(node.span.end, after).indexOf(0x0a);
  if (newline >= 0) {
    return toByteSpan(node.span.start, node.span.end + newline + 1);
  }
  return node.span;
}

function insertionAt(
  bytes: ByteString,
  projection: ValidProjection,
  anchor: ProjectedNode,
  placement: Placement,
  text: string,
): Result<Insertion, RejectionReason> {
  if (listAt(projection, anchor, placement) !== 'markup') {
    return markdownInsertionAt(bytes, projection, anchor, placement, text);
  }
  if (inside(placement)) {
    return insertionInside(bytes, projection, anchor, placement, text);
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
  const separator = separatorBefore(bytes, projection, anchor);
  if (placement === 'after') {
    const at = toByteSpan(anchor.span.end, anchor.span.end);
    return ok({ range: at, text: `${separator}${text}`, anchorPath: anchor.path });
  }
  return ok({
    range: toByteSpan(anchor.span.start, anchor.span.start),
    text: `${text}${separator}`,
    anchorPath: shifted(anchor.path),
  });
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
// empty tag writes after its opening tag; an empty branch replaces its `null`
// placeholder. A self-closing non-void tag gains a closing tag with its first child.
function insertionInside(
  bytes: ByteString,
  projection: ValidProjection,
  parent: ProjectedNode,
  placement: Placement,
  text: string,
): Result<Insertion, RejectionReason> {
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
      const separator = separatorBefore(bytes, projection, beside);
      const anchorPath = parent.path;
      const preserved = branchChildAsMarkup(bytes, parent, beside);
      if (preserved !== undefined) {
        if (placement !== 'first-child') {
          return err('unsupported-operation');
        }
        return ok({ range: beside.span, text: `${text}${separator}${preserved}`, anchorPath });
      }
      if (placement === 'first-child') {
        return ok({ range: point(first.span.start), text: `${text}${separator}`, anchorPath });
      }
      return ok({ range: point(last.span.end), text: `${separator}${text}`, anchorPath });
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
    return ok(insertionIntoSelfClosingTag(bytes, parent, open.end, text));
  }
  const close = closeTagStart(bytes, parent, open.end);
  if (close === undefined) {
    return err('unsupported-operation');
  }
  const lined = containsNewline(bytes, toByteSpan(open.end, close));
  const lead = lined ? `\n${lineIndent(bytes, parent.span.start)}  ` : '';
  return ok({ range: point(open.end), text: `${lead}${text}`, anchorPath: parent.path });
}

function insertionIntoSelfClosingTag(bytes: ByteString, parent: ProjectedNode, openEnd: number, text: string): Insertion {
  assert(parent.kind === 'component' || parent.kind === 'element', 'A paired conversion starts from a tag');
  const slash = openEnd - 2;
  assert(bytes[slash] === 0x2f, 'A self-closing component ends in a slash');
  const nameSpan = toByteSpan(parent.span.start + 1, tagNameEnd(bytes, parent));
  const name = textOf(bytes, nameSpan);
  assert(name.length > 0, 'A component has a written tag name');
  const range = toByteSpan(selfClosingTailStart(bytes, slash), openEnd);
  return {
    range,
    text: `>${text}</${name}>`,
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
// them. A root node with nothing before it on its line gets a line break.
function separatorBefore(bytes: ByteString, projection: ValidProjection, node: ProjectedNode): string {
  const bounds = siblingBounds(bytes, projection, node);
  const start = whitespaceBefore(bytes, node.span.start, bounds.floor);
  const separator = textOf(bytes, toByteSpan(start, node.span.start));
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
  // Blank text between siblings is the separator itself, never a neighbour.
  const siblings = siblingsOf(projection, node).filter((sibling) => sibling === node || !blankText(bytes, sibling));
  const index = siblings.indexOf(node);
  assert(index >= 0, 'A node is among its siblings');
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const outer = contentOf(bytes, projection, node);
  return {
    floor: previous === undefined ? outer.start : previous.span.end,
    ceiling: next === undefined ? outer.end : next.span.start,
  };
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
