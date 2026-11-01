// What both of main's intent front ends share (editRequests.ts for .astro and
// markup, markdownEdits.ts for Markdown; plan §2 layer 3): the snapshot an
// edit names, the check that a renderer's node reference is a node of those
// bytes, and the placement of a printer's change on a node's own bytes.
//
// The renderer names a node by the path, kind and UTF-16 range of the parse it
// shows. Main's projection of the same bytes must agree on all three before
// the reference becomes an anchor; a mismatch means the renderer's parse is
// not of these bytes, and the edit is refused as moved — never guessed.
import { assert } from '../../shared/core/assert';
import { toUtf16Offset } from '../../shared/core/brand';
import { diffCodePatch } from '../../shared/engine/codePatch';
import { DIFF_BUDGET, diffBytes, type ByteDiff } from '../../shared/engine/diff';
import type { NodeRef } from '../../shared/engine/editRequest';
import type { RejectionReason, SourceEdit } from '../../shared/engine/intent';
import { mapSpanThroughDiff } from '../../shared/engine/mapSpan';
import { nodeAtPath, type ValidProjection } from '../../shared/engine/planSupport';
import { toAnchorRef, toChildIndex, type AnchorRef } from '../../shared/page/ref';
import { err, ok, type Result } from '../../shared/core/result';
import type { Snapshot } from '../../shared/page/snapshot';
import type { ProjectedNode } from '../../shared/page/sourceProjection';
import { encodeUtf8, spansAscending, toByteSpan, utf16ToByteOffsets, type ByteSpan } from '../../shared/core/span';

/** How a page is written: its file's extension decides the parser. */
export type PageFormat = 'astro' | 'md' | 'mdx';

/** The snapshot an edit was authored against, decoded and parsed. */
export interface Authored {
  readonly snapshot: Snapshot;
  readonly text: string;
  readonly projection: ValidProjection;
  readonly format: PageFormat;
}

/** A node reference checked against the projection: the anchor an intent
 * carries, and the projected node it names. */
export interface Resolved {
  readonly anchor: AnchorRef;
  readonly node: ProjectedNode;
}

export function pageFormat(file: string): PageFormat {
  if (/\.mdx$/i.test(file)) {
    return 'mdx';
  }
  return /\.md$/i.test(file) ? 'md' : 'astro';
}

/** The renderer's node reference, checked against the projection of the same
 * bytes: the node at that path must have that kind and that range. */
export function resolveRef(authored: Authored, ref: NodeRef): Result<Resolved, RejectionReason> {
  const node = nodeAtPath(authored.projection, ref.path.map(toChildIndex));
  if (node === undefined) {
    return err('anchor-moved');
  }
  if (node.kind !== ref.kind) {
    return err('anchor-moved');
  }
  const span = byteSpanOf(authored.text, ref.span.start, ref.span.end);
  if (span === undefined) {
    return err('anchor-moved');
  }
  if (span.start !== node.span.start || span.end !== node.span.end) {
    return err('anchor-moved');
  }
  const anchor = toAnchorRef({ span, path: node.path, expectedKind: node.kind });
  return ok({ anchor, node });
}

/** UTF-16 offsets from the wire: inside the text and on code-point
 * boundaries, or no span at all. */
export function byteSpanOf(text: string, start: number, end: number): ByteSpan | undefined {
  if (end > text.length) {
    return undefined;
  }
  if (splitsPair(text, start) || splitsPair(text, end)) {
    return undefined;
  }
  const [first, last] = utf16ToByteOffsets(text, [toUtf16Offset(start), toUtf16Offset(end)]);
  assert(first !== undefined, 'The start was converted');
  assert(last !== undefined, 'The end was converted');
  return toByteSpan(first, last);
}

/** Whether a UTF-16 offset falls between the halves of a surrogate pair. */
export function splitsPair(text: string, offset: number): boolean {
  if (offset === 0 || offset >= text.length) {
    return false;
  }
  const before = text.charCodeAt(offset - 1);
  const at = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

/** The printer's change from `before` to `after`, as hunks of `own` — the
 * node's bytes. Equal renderings mean the printer and the bytes agree, and
 * the change applies as it is; otherwise each hunk is placed on `own` through
 * the diff from `before`, and a hunk the formatting itself changed has no
 * place: refused, never reprinted. */
export function placedHunks(before: string, after: string, own: string): Result<readonly SourceEdit[], RejectionReason> {
  const change = diffCodePatch(before, after);
  if (!change.ok) {
    return change;
  }
  if (change.value.length === 0) {
    return err('unsupported-operation'); // The gesture changed nothing the printer writes.
  }
  if (before === own) {
    return ok(change.value.map((hunk) => ({ span: hunk.span, text: hunk.text })));
  }
  const diff = diffBytes(encodeUtf8(before), encodeUtf8(own), DIFF_BUDGET);
  if (diff.tag === 'too-costly') {
    return err('resource-limit');
  }
  const placed: SourceEdit[] = [];
  for (const hunk of change.value) {
    const span = placedSpan(diff.diff, hunk.span);
    if (span === undefined) {
      return err('unsupported-operation');
    }
    placed.push({ span, text: hunk.text });
  }
  if (!spansAscending(placed.map((hunk) => hunk.span))) {
    return err('unsupported-operation');
  }
  return ok(placed);
}

// A range of the rendering on the node's bytes: its own bytes kept whole, or,
// for an insertion, a neighbouring byte kept whole beside it.
function placedSpan(diff: ByteDiff, span: ByteSpan): ByteSpan | undefined {
  if (span.start < span.end) {
    const mapped = mapSpanThroughDiff(diff, span);
    return mapped.tag === 'resolved' ? mapped.span : undefined;
  }
  if (span.start > 0) {
    const before = mapSpanThroughDiff(diff, toByteSpan(span.start - 1, span.start));
    if (before.tag === 'resolved') {
      return toByteSpan(before.span.end, before.span.end);
    }
  }
  if (span.start < diff.source.length) {
    const after = mapSpanThroughDiff(diff, toByteSpan(span.start, span.start + 1));
    if (after.tag === 'resolved') {
      return toByteSpan(after.span.start, after.span.start);
    }
  }
  return undefined;
}

/** Hunks of a node's own text moved to the file: shifted by where the node
 * starts. */
export function shiftedHunks(hunks: readonly SourceEdit[], start: number): readonly SourceEdit[] {
  return hunks.map((hunk) => ({
    span: toByteSpan(hunk.span.start + start, hunk.span.end + start),
    text: hunk.text,
  }));
}

/** A frontmatter block's new text as the slot where it differs from the block
 * on disk: the common start and end are kept, whole code points only. */
export function frontmatterSlot(block: ByteSpan, before: string, printed: string): { readonly slot: ByteSpan; readonly text: string } {
  let prefix = 0;
  const shorter = Math.min(before.length, printed.length);
  while (prefix < shorter && before.charCodeAt(prefix) === printed.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  while (suffix < shorter - prefix && before.charCodeAt(before.length - 1 - suffix) === printed.charCodeAt(printed.length - 1 - suffix)) {
    suffix++;
  }
  // Whole code points only: a boundary inside a pair moves out of it.
  if (splitsPair(before, prefix) || splitsPair(printed, prefix)) {
    prefix--;
  }
  if (splitsPair(before, before.length - suffix) || splitsPair(printed, printed.length - suffix)) {
    suffix--;
  }
  const slot = byteSpanOf(before, prefix, before.length - suffix);
  assert(slot !== undefined, 'The slot lies inside the block on code-point boundaries');
  const shifted = toByteSpan(block.start + slot.start, block.start + slot.end);
  return { slot: shifted, text: printed.slice(prefix, printed.length - suffix) };
}
