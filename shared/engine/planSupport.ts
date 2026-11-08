// What every operation's planner needs (plan §5.2 steps 2–4): resolving an
// anchor in the bytes it was authored against, mapping it to the bytes on disk
// now, and reading the source around the node it names. Pure, like the planner
// that calls it — bytes and projections in, values out.
//
// Resolution generalizes the step-2 rule for `set-attribute` (planner.ts, its
// header says why): a node is identified by its identity region — for a tag,
// the name through the last attribute; for anything else, the whole node —
// mapped through the diff. The mapper never guesses, and a region whose bytes
// repeat in the file is ambiguous (planner.ts, uniqueOrAmbiguous), so a
// resolved node is the node the intent was authored against, moved whole.
import { assert } from '../core/assert';
import { capabilityAcceptsNodeRewrite, capabilityAcceptsVisualIntent } from '../page/capability';
import { LIMITS } from '../core/limits';
import type { SpanMapping } from './mapSpan';
import type { AnchorRef, NodeKind, StructuralPath } from '../page/ref';
import { err, ok, type Result } from '../core/result';
import type { RejectionReason } from './intent';
import type { Snapshot } from '../page/snapshot';
import type { ProjectedNode, Projection } from '../page/sourceProjection';
import { byteStringsEqual, decodeUtf8, toByteSpan, toByteString, utf16ToByteOffsets, type ByteSpan, type ByteString } from '../core/span';
import { toUtf16Offset } from '../core/brand';

export type SpanMapper = (span: ByteSpan) => SpanMapping;

export type ValidProjection = Extract<Projection, { tag: 'valid' }>;

/** The two snapshots an intent is planned between, and how spans of the first
 * reach the second. */
export interface PlanContext {
  readonly authored: Snapshot;
  readonly current: Snapshot;
  readonly mapSpan: SpanMapper;
}

/** A node the anchor named, found again in the bytes on disk now. `shift` is
 * how far its identity region moved: every span inside that region moved by
 * exactly as much, because a resolved region is kept whole. */
export interface Target {
  readonly authored: ProjectedNode;
  readonly current: ProjectedNode;
  readonly shift: number;
}

const TAG_OPEN = 0x3c; // `<`
const TAG_CLOSE = 0x3e; // `>`
const SLASH = 0x2f; // `/`
const NEWLINE = 0x0a;

/** Both projections, when both parse; a visual intent needs both. */
export function validProjections(context: PlanContext): Result<{ readonly authored: ValidProjection; readonly current: ValidProjection }, RejectionReason> {
  const authored = context.authored.projection;
  const current = context.current.projection;
  if (current.tag === 'parse-error') {
    return err('source-invalid'); // Fix it in code first, stale or not.
  }
  if (authored.tag === 'parse-error') {
    return err('source-invalid'); // No node was ever there to anchor.
  }
  return ok({ authored, current });
}

/** Resolve a node anchor in the authored bytes, then find the same node in the
 * current bytes through its identity region. Every rejection of resolution is
 * decided here, so each operation starts from a node known to be the one the
 * intent named. Capabilities are the operation's to check. */
export function resolveTarget(context: PlanContext, anchor: AnchorRef): Result<Target, RejectionReason> {
  const projections = validProjections(context);
  if (!projections.ok) {
    return projections;
  }
  const authored = nodeAtPath(projections.value.authored, anchor.path);
  if (authored === undefined) {
    return err('anchor-moved');
  }
  if (authored.kind !== anchor.expectedKind) {
    return err('anchor-moved');
  }
  if (!sameSpan(authored.span, anchor.span)) {
    return err('anchor-moved');
  }
  const region = identityRegion(context.authored.bytes, authored);
  const mapped = context.mapSpan(region);
  switch (mapped.tag) {
    case 'resolved': {
      // The consumer side of the mapper's postcondition: a region moves whole.
      assert(mapped.span.end - mapped.span.start === region.end - region.start, 'A resolved region keeps its length');
      const shift = mapped.span.start - region.start;
      return currentTarget(context, projections.value.current, authored, mapped.span, shift);
    }
    case 'ambiguous':
      return err('anchor-ambiguous');
    case 'gone':
      return err('anchor-moved');
    case 'too-costly':
      return err('resource-limit');
    default: {
      const exhaustive: never = mapped;
      return exhaustive;
    }
  }
}

// The mapped bytes are the authored identity region; the node found there must
// still parse as it — the context can change around unchanged bytes (a comment
// opened above turns an element into comment text).
function currentTarget(
  context: PlanContext,
  current: ValidProjection,
  authored: ProjectedNode,
  mappedRegion: ByteSpan,
  shift: number,
): Result<Target, RejectionReason> {
  const start = authored.span.start + shift;
  const found = current.nodes.filter((node) => node.span.start === start && node.kind === authored.kind);
  const [node, ...others] = found.length > 1 ? atDepthOf(found, authored) : found;
  if (node === undefined) {
    return err(found.length > 1 ? 'anchor-ambiguous' : 'anchor-moved');
  }
  if (others.length > 0) {
    return err('anchor-ambiguous');
  }
  if (!sameSpan(identityRegion(context.current.bytes, node), mappedRegion)) {
    return err('anchor-moved');
  }
  // The same bytes can mean a different node once the file around them changed:
  // an element someone wrapped in a loop outside Stacki is now one source node
  // rendered many times, and an edit authored against one element would change
  // every copy. What the user saw is the authored capability; a different one
  // now is a change they have not seen (step 7).
  if (node.capability !== authored.capability) {
    return err('region-externally-modified');
  }
  return ok({ authored, current: node, shift });
}

// A tag opens one element: two same-kind nodes cannot start on one byte,
// except a node and its own first descendant of the same kind. A text-only
// span could share one; a Markdown list always shares its first line with its
// first item (step 10). One holds the other, so they differ in depth: the node
// at the anchor's depth is the one it named, and anything else is refused
// rather than chosen.
function atDepthOf(found: readonly ProjectedNode[], authored: ProjectedNode): readonly ProjectedNode[] {
  assert(found.length > 1, 'Only several candidates need their depth compared');
  return found.filter((node) => node.path.length === authored.path.length);
}

/** Whether a node is written as a tag: an element, component or raw block of
 * markup. A Markdown block has no tag — a paragraph, a heading, a list — and
 * the attributes Markdown writes (an image's alt) are its own syntax. */
export function writtenAsTag(node: ProjectedNode): boolean {
  if (node.syntax === 'markup') {
    return isTagKind(node.kind);
  }
  return false;
}

/** For a tag with attributes, the name through the end of the last one; for
 * anything else — a bare tag included — the whole node. A bare tag's name is
 * shared by every tag of that name (`p`), so alone it identifies nothing; its
 * bytes with its content usually do, at the price of refusing a stale intent
 * whose node someone edited inside. The first byte of a tag is its `<`. A
 * Markdown block is its whole node: it has no name to start from. */
export function identityRegion(bytes: ByteString, node: ProjectedNode): ByteSpan {
  if (writtenAsTag(node)) {
    assert(bytes[node.span.start] === TAG_OPEN, 'A tag opens with `<`');
    const nameEnd = tagNameEnd(bytes, node);
    const end = node.attributes.reduce<number>((last, attribute) => Math.max(last, attribute.span.end), nameEnd);
    assert(end <= node.span.end, 'Attributes lie inside their node');
    if (end > nameEnd) {
      return toByteSpan(node.span.start + 1, end);
    }
  }
  assert(node.span.start < node.span.end, 'A projected node covers at least one byte');
  return node.span;
}

export function isTagKind(kind: NodeKind): boolean {
  switch (kind) {
    case 'element':
    case 'component':
    case 'raw':
      return true;
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** One past the tag name: the name runs to the first whitespace, `/` or `>`.
 * A shorthand fragment `<>` has none: its name ends where it starts. */
export function tagNameEnd(bytes: ByteString, node: ProjectedNode): number {
  let index = node.span.start + 1;
  while (index < node.span.end) {
    const byte = bytes[index];
    assert(byte !== undefined, 'The tag lies inside the bytes');
    if (isWhitespace(byte) || byte === SLASH || byte === TAG_CLOSE) {
      break;
    }
    index++;
  }
  // `<>` is a shorthand fragment: a tag without a name.
  return index;
}

/** One past the `>` that ends a tag's opening, and whether it closes itself. */
export function openTagEnd(bytes: ByteString, node: ProjectedNode): { readonly end: number; readonly selfClosing: boolean } {
  assert(isTagKind(node.kind), 'Only a tag has an opening tag');
  // Past the name and every attribute: a `>` inside a quoted value is not it.
  let index = node.attributes.reduce<number>((last, attribute) => Math.max(last, attribute.span.end), tagNameEnd(bytes, node));
  while (index < node.span.end) {
    const byte = bytes[index];
    assert(byte !== undefined, 'The tag lies inside the bytes');
    if (byte === TAG_CLOSE) {
      return { end: index + 1, selfClosing: bytes[index - 1] === SLASH };
    }
    index++;
  }
  throw new Error('Assertion failed: an opening tag ends with `>` inside its node');
}

/** Where a paired tag's closing tag starts: the last `</` inside the node. */
export function closeTagStart(bytes: ByteString, node: ProjectedNode, from: number): number | undefined {
  for (let index = node.span.end - 2; index >= from; index--) {
    if (bytes[index] === TAG_OPEN) {
      if (bytes[index + 1] === SLASH) {
        return index;
      }
    }
  }
  return undefined;
}

export function nodeAtPath(projection: ValidProjection, path: StructuralPath): ProjectedNode | undefined {
  assert(projection.nodes.length <= LIMITS.treeNodesMax, 'The projection is inside its bound');
  return projection.nodes.find((candidate) => samePath(candidate.path, path));
}

/** A node's parent path; the root list's is empty. */
export function parentPath(path: StructuralPath): StructuralPath {
  assert(path.length > 0, 'A tree node has a path');
  return path.slice(0, -1);
}

/** Whether a node is a text node of whitespace alone: the parser keeps the
 * line breaks between root nodes as text, and they separate, not content. */
export function blankText(bytes: ByteString, node: ProjectedNode): boolean {
  if (node.kind !== 'text') {
    return false;
  }
  for (let index = node.span.start; index < node.span.end; index++) {
    const byte = bytes[index];
    assert(byte !== undefined, 'A text node lies inside the bytes');
    if (!isWhitespace(byte)) {
      return false;
    }
  }
  return true;
}

/** The node's siblings in document order, itself included. */
export function siblingsOf(projection: ValidProjection, node: ProjectedNode): readonly ProjectedNode[] {
  const parent = parentPath(node.path);
  return projection.nodes.filter((candidate) => candidate.path.length === node.path.length && startsWith(candidate.path, parent));
}

/** The nodes of the subtree rooted at `node`, itself first, in document order. */
export function subtreeOf(projection: ValidProjection, node: ProjectedNode): readonly ProjectedNode[] {
  return projection.nodes.filter((candidate) => startsWith(candidate.path, node.path));
}

/** Proper ancestors, outermost first. */
export function ancestorsOf(projection: ValidProjection, path: StructuralPath): readonly ProjectedNode[] {
  const found: ProjectedNode[] = [];
  for (let depth = 1; depth < path.length; depth++) {
    const ancestor = nodeAtPath(projection, path.slice(0, depth));
    assert(ancestor !== undefined, 'Every ancestor of a projected node is projected');
    found.push(ancestor);
  }
  return found;
}

export function startsWith(path: StructuralPath, prefix: StructuralPath): boolean {
  if (prefix.length <= path.length) {
    return prefix.every((step, index) => step === path[index]);
  }
  return false;
}

export function samePath(left: StructuralPath, right: StructuralPath): boolean {
  if (left.length === right.length) {
    return startsWith(left, right);
  }
  return false;
}

export function sameSpan(left: ByteSpan, right: ByteSpan): boolean {
  if (left.start === right.start) {
    return left.end === right.end;
  }
  return false;
}

export function slice(bytes: ByteString, span: ByteSpan): ByteString {
  assert(span.end <= bytes.length, 'A sliced span lies inside the bytes');
  return toByteString(bytes.subarray(span.start, span.end));
}

/** The node's bytes are the ones it was authored with: a remove or a move
 * takes the whole node, so a change anywhere inside it is someone else's. */
export function nodeUnchanged(context: PlanContext, target: Target): boolean {
  const authored = slice(context.authored.bytes, target.authored.span);
  return byteStringsEqual(authored, slice(context.current.bytes, target.current.span));
}

/** The text of a span. Spans come from the parser's code-point boundaries, so
 * the slice is valid UTF-8 whenever the file is. */
export function textOf(bytes: ByteString, span: ByteSpan): string {
  const decoded = decodeUtf8(slice(bytes, span));
  assert(decoded.ok, 'A projected span decodes');
  return decoded.value;
}

/** Byte offsets, relative to the text's start, of ascending UTF-16 offsets. */
export function byteOffsetsIn(text: string, offsets: readonly number[]): readonly number[] {
  return utf16ToByteOffsets(
    text,
    offsets.map((offset) => toUtf16Offset(offset)),
  );
}

export function isWhitespace(byte: number): boolean {
  switch (byte) {
    case 0x20:
    case 0x09:
    case 0x0a:
    case 0x0d:
      return true;
    default:
      return false;
  }
}

/** Where the run of whitespace ending at `end` starts, no earlier than `floor`. */
export function whitespaceBefore(bytes: ByteString, end: number, floor: number): number {
  let index = end;
  while (index > floor) {
    const byte = bytes[index - 1];
    assert(byte !== undefined, 'The scan lies inside the bytes');
    if (!isWhitespace(byte)) {
      break;
    }
    index--;
  }
  return index;
}

/** Where the run of whitespace starting at `start` ends, no later than `ceiling`. */
export function whitespaceAfter(bytes: ByteString, start: number, ceiling: number): number {
  let index = start;
  while (index < ceiling) {
    const byte = bytes[index];
    assert(byte !== undefined, 'The scan lies inside the bytes');
    if (!isWhitespace(byte)) {
      break;
    }
    index++;
  }
  return index;
}

export function containsNewline(bytes: ByteString, span: ByteSpan): boolean {
  return bytes.subarray(span.start, span.end).includes(NEWLINE);
}

// An element whose line breaks are content, as a fragment writes it (HTML_WHITESPACE_TAGS).
const WHITESPACE_ELEMENT = /<(code|pre|script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** A printed fragment for a place `indent` deep: its first line goes where the
 * insertion puts it, each later line takes the indent, and line breaks become the
 * file's `eol`. A line inside `<pre>` or its like is content, so it keeps its own
 * start: indenting it would put spaces on the page. */
export function indentedFragment(text: string, indent: string, eol: '\n' | '\r\n'): string {
  assert(indent.trim().length === 0, 'indentedFragment: an indent is only whitespace');
  const kept = Array.from(text.matchAll(WHITESPACE_ELEMENT), (match) => ({ start: match.index, end: match.index + match[0].length }));
  const written = text.replace(/\r?\n/g, (_lineBreak: string, at: number) => {
    const content = kept.some((element) => element.start <= at && at < element.end);
    return content ? eol : `${eol}${indent}`;
  });
  assert(written.split('\n').length === text.split('\n').length, 'indentedFragment: every line stays a line');
  return written;
}

/** The indentation of the line holding `offset`: its leading spaces and tabs. */
export function lineIndent(bytes: ByteString, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0) {
    if (bytes[lineStart - 1] === NEWLINE) {
      break;
    }
    lineStart--;
  }
  let index = lineStart;
  while (index < offset) {
    const byte = bytes[index];
    if (byte === 0x20 || byte === 0x09) {
      index++;
    } else {
      break;
    }
  }
  return textOf(bytes, toByteSpan(lineStart, index));
}

/** Whether a node may be taken out, put back or stood beside whole. Its own
 * content may be code the editor does not read (an expression, a `<style>`,
 * `set:html`); the list it sits in is still plain markup. A node a loop
 * repeats, or one assembled from another file, is not. */
export function nodePlaceable(node: ProjectedNode): boolean {
  switch (node.capability) {
    case 'editable':
    case 'read-only-opaque':
      return true;
    case 'repeated-source-node':
    case 'runtime-aggregate':
    case 'unsupported':
      return false;
    default: {
      const exhaustive: never = node.capability;
      return exhaustive;
    }
  }
}

/** Whether visual intents may edit this node. A node repeated by a loop is
 * one source node shown many times (plan §6): since step 7 the canvas addresses
 * that source node, and an edit of it changes every copy. Only a move may take
 * one out of its loop (planTree.ts); nothing is placed beside it. */
export function nodeEditable(node: ProjectedNode): boolean {
  return capabilityAcceptsVisualIntent(node.capability);
}

/** A replacement changes only hunks proven to belong to one source node, so
 * it can safely carry visual edits through syntax whose contents stay opaque. */
export function nodeRewriteable(node: ProjectedNode): boolean {
  return capabilityAcceptsNodeRewrite(node.capability);
}
