// Planning the operations that name byte ranges directly (plan §3.3): a loop
// rename's sites, a frontmatter slot, a code patch's hunks, a revert's hunks,
// a node rewrite's hunks (step 9), a new frontmatter block and a program's
// text rewrite (step 10). The ranges were authored
// against the intent's own snapshot; stale ones are mapped through the diff
// with the region they sit in, and only exactly.
import { assert } from '../core/assert';
import { TAG_NAME_RE, type Operation, type RejectionReason, type SourceEdit } from './intent';
import { LIMITS } from '../core/limits';
import type { CandidatePolicy, Plan, Splice } from './planner';
import { nodeEditable, nodeRewriteable, nodeUnchanged, resolveTarget, sameSpan, slice, validProjections, type PlanContext } from './planSupport';
import type { AnchorRef } from '../page/ref';
import { err, ok, type Result } from '../core/result';
import { byteStringsEqual, encodeUtf8, spansAscending, toByteSpan, utf8ByteLength, type ByteSpan, type ByteString } from '../core/span';

/** Bytes of context each side of a hunk when it is mapped through the diff.
 * A hunk of a few bytes (`Old`, a closing brace) repeats everywhere, and the
 * mapper refuses repeated bytes; with its neighbourhood it is usually unique.
 * The trade is the patch tool's: more context resolves more hunks and rejects
 * more of those whose neighbourhood someone else edited. */
const HUNK_CONTEXT_BYTES = 64;

/** A bare text run given a tag of its own, as one hunk. The run's bytes are
 * kept as written, so an entity such as `&#123;` stays an entity. The tag goes
 * on the same line as the words: a line break inside it would add a space the
 * run did not have. Whitespace holding a line break is the file's layout and
 * stays outside the tag; a space on the run's own line is part of the run. One
 * hunk rather than two insertions, so the new element and its text lie wholly
 * inside what the edit wrote, which is how the session pairs them with the
 * nodes it predicted (src/editor/nodeHandles.ts). Undefined for a blank run:
 * there are no words to wrap. */
export function wrappedTextHunk(run: string, span: ByteSpan, name: string): SourceEdit | undefined {
  assert(utf8ByteLength(run) === span.end - span.start, 'A run is the text of its span');
  assert(TAG_NAME_RE.test(name), 'A wrapped run gets a valid tag name');
  if (run.trim() === '') {
    return undefined;
  }
  const leading = run.slice(0, run.length - run.trimStart().length);
  const trailing = run.slice(run.trimEnd().length);
  const before = leading.includes('\n') ? leading : '';
  const after = trailing.includes('\n') ? trailing : '';
  const kept = run.slice(before.length, run.length - after.length);
  const start = span.start + utf8ByteLength(before);
  const end = span.end - utf8ByteLength(after);
  assert(start < end, 'A wrapped run keeps at least one byte');
  assert(kept.trim() === run.trim(), 'Wrapping keeps every word of the run');
  return { span: toByteSpan(start, end), text: `<${name}>${kept}</${name}>` };
}

/** A loop rename (multi-span): every site holds the old name, as a whole
 * identifier, inside the loop the anchor resolves to. */
export function planRenameBinding(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'rename-binding' }>,
): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!nodeEditable(target.current)) {
    return err('unsupported-operation'); // Code the engine keeps verbatim.
  }
  const from = encodeUtf8(operation.from);
  const splices: Splice[] = [];
  for (const site of operation.sites) {
    // The whole loop is the identity region, so every site in it moved whole.
    const moved = toByteSpan(site.start + target.shift, site.end + target.shift);
    const held = slice(context.current.bytes, moved);
    if (!byteStringsEqual(held, from)) {
      return err('anchor-moved'); // The client named a site that is not the name.
    }
    if (!wholeIdentifier(context.current.bytes, moved)) {
      return err('anchor-moved');
    }
    splices.push({ range: moved, expectedBytes: held, replacementBytes: encodeUtf8(operation.to) });
  }
  const postKinds = [{ path: target.current.path, kind: target.current.kind }];
  return ok({ splices, postKinds, candidate: 'must-parse' });
}

/** A node rewrite (step 9): hunks inside one node, stated against its authored
 * bytes. The node is found again through its identity region and must hold
 * exactly the bytes it was authored with — the hunks were computed from the
 * whole node's text, so any change inside it is someone else's edit, refused
 * rather than merged — and then every hunk moved with it. */
export function planRewriteNode(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'rewrite-node' }>,
): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!nodeRewriteable(target.current)) {
    return err('unsupported-operation');
  }
  if (!nodeUnchanged(context, target)) {
    return err('region-externally-modified');
  }
  const shift = target.current.span.start - target.authored.span.start;
  assert(shift === target.shift, 'An unchanged node moved with its identity region');
  const splices = operation.hunks.map((hunk) => {
    const moved = toByteSpan(hunk.span.start + shift, hunk.span.end + shift);
    const splice = spliceAt(context.current.bytes, moved, hunk.text);
    assert(byteStringsEqual(splice.expectedBytes, slice(context.authored.bytes, hunk.span)), 'A rewritten range holds its authored bytes');
    return splice;
  });
  assert(spansAscending(splices.map((splice) => splice.range)), 'Moved hunks keep their order');
  return ok({ splices, postKinds: [], candidate: 'must-parse' });
}

/** A frontmatter slot: the fenced block must be the one authored, found again
 * whole, and the slot inside it holds the authored bytes. */
export function planFrontmatterSlot(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'edit-frontmatter-slot' }>,
): Result<Plan, RejectionReason> {
  const projections = validProjections(context);
  if (!projections.ok) {
    return projections;
  }
  const authored = projections.value.authored.frontmatter;
  if (authored === undefined) {
    return err('anchor-moved');
  }
  if (!sameSpan(authored, anchor.span)) {
    return err('anchor-moved');
  }
  const mapped = context.mapSpan(authored);
  switch (mapped.tag) {
    case 'resolved': {
      const current = projections.value.current.frontmatter;
      if (current === undefined) {
        return err('anchor-moved');
      }
      if (!sameSpan(current, mapped.span)) {
        return err('anchor-moved');
      }
      const shift = mapped.span.start - authored.start;
      const slot = toByteSpan(operation.slot.start + shift, operation.slot.end + shift);
      const splice = spliceAt(context.current.bytes, slot, operation.text);
      return ok({ splices: [splice], postKinds: [], candidate: 'must-parse' });
    }
    case 'ambiguous':
      return err('anchor-ambiguous');
    case 'gone':
      return err('region-externally-modified');
    case 'too-costly':
      return err('resource-limit');
    default: {
      const exhaustive: never = mapped;
      return exhaustive;
    }
  }
}

/** `insert-frontmatter` (step 10): the block of a page that has none, at its
 * top — after a byte-order mark, which opens the file, not the block. A block
 * in either version means the edit that stated a new one is not about this
 * file any more: refused. */
export function planInsertFrontmatter(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'insert-frontmatter' }>,
): Result<Plan, RejectionReason> {
  assert(anchor.expectedKind === 'document', 'A new frontmatter block anchors the document');
  const projections = validProjections(context);
  if (!projections.ok) {
    return projections;
  }
  if (projections.value.authored.frontmatter !== undefined) {
    return err('anchor-moved');
  }
  if (projections.value.current.frontmatter !== undefined) {
    return err('anchor-moved');
  }
  const bytes = context.current.bytes;
  const at = hasByteOrderMark(bytes) ? 3 : 0;
  const splice = spliceAt(bytes, toByteSpan(at, at), operation.source);
  assert(splice.expectedBytes.length === 0, 'A new block replaces nothing');
  return ok({ splices: [splice], postKinds: [], candidate: 'must-parse' });
}

function hasByteOrderMark(bytes: ByteString): boolean {
  if (bytes[0] === 0xef) {
    if (bytes[1] === 0xbb) {
      return bytes[2] === 0xbf;
    }
  }
  return false;
}

/** A code patch (the code editor from step 8; a stylesheet rule at step 6):
 * text may leave the file invalid (plan §3.6); a stale hunk that cannot be
 * found whole is a merge conflict. */
export function planCodePatch(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'apply-code-patch' }>,
): Result<Plan, RejectionReason> {
  return planHunks(context, anchor, operation.hunks, {
    stale: 'merge-conflict',
    candidate: 'may-be-invalid',
  });
}

/** Undo's inverse (plan §11 step 6): the hunks restore bytes an applied intent
 * replaced. They were authored against the bytes that intent left, so an
 * outside edit since maps through the diff or rejects — it is never reverted.
 * A file that parsed when the intent applied must still parse after. */
export function planRevertSplices(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'revert-splices' }>,
): Result<Plan, RejectionReason> {
  const parsed = context.authored.projection.tag === 'valid';
  return planHunks(context, anchor, operation.hunks, {
    stale: 'region-externally-modified',
    candidate: parsed ? 'must-parse' : 'may-be-invalid',
  });
}

/** `rewrite-text` (step 10, replacing the whole-file `replace-source`): a
 * program's change to a file's text as hunks of the bytes it read — a
 * stylesheet rule, a CMS entry, a property batch. It never maps: its witness
 * is the authored checksum itself, so any change since it was read is a
 * rejection, and every hunk is written at its own range with its authored
 * bytes as the witness. The result may not parse — a raw page, a stylesheet —
 * so the candidate is not required to. Agrees exactly with the step-1
 * reference (test/simulator/referencePlanner.ts). */
export function planRewriteText(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'rewrite-text' }>,
): Result<Plan, RejectionReason> {
  assert(anchor.expectedKind === 'document', 'A rewrite anchors the whole document');
  assert(anchor.span.start === 0, 'A document anchor starts at byte 0');
  if (context.current.checksum !== context.authored.checksum) {
    return err('region-externally-modified');
  }
  if (anchor.span.end !== context.current.bytes.length) {
    return err('anchor-moved'); // The anchor names bytes of another length.
  }
  const bytes = context.current.bytes;
  const splices = operation.hunks.map((hunk) => spliceAt(bytes, hunk.span, hunk.text));
  assert(splices.length <= LIMITS.splicesPerIntentMax, 'A rewrite fits one intent');
  return ok({ splices, postKinds: [], candidate: 'may-be-invalid' });
}

interface HunkPolicy {
  readonly stale: RejectionReason;
  readonly candidate: CandidatePolicy;
}

function planHunks(context: PlanContext, anchor: AnchorRef, hunks: readonly SourceEdit[], policy: HunkPolicy): Result<Plan, RejectionReason> {
  assert(anchor.expectedKind === 'document', 'Hunks anchor the whole document');
  const authored = context.authored.bytes;
  if (anchor.span.end !== authored.length) {
    return err('anchor-moved'); // The anchor names bytes of another length.
  }
  const fresh = context.authored.checksum === context.current.checksum;
  const splices: Splice[] = [];
  for (const hunk of hunks) {
    const mapped = fresh ? ok(hunk.span) : mapHunk(context, hunk.span, policy.stale);
    if (!mapped.ok) {
      return mapped;
    }
    const splice = spliceAt(context.current.bytes, mapped.value, hunk.text);
    // The witness: what the hunk replaces is what it replaced when authored.
    assert(byteStringsEqual(splice.expectedBytes, slice(authored, hunk.span)), 'A mapped hunk holds its authored bytes');
    splices.push(splice);
  }
  if (!spansAscending(splices.map((splice) => splice.range))) {
    return err(policy.stale); // Mapped hunks crossed: not the patch that was written.
  }
  return ok({ splices, postKinds: [], candidate: policy.candidate });
}

// A hunk with up to HUNK_CONTEXT_BYTES of neighbourhood each side, mapped as
// one region; the hunk sits at the same offset inside it.
function mapHunk(context: PlanContext, span: ByteSpan, stale: RejectionReason): Result<ByteSpan, RejectionReason> {
  const length = context.authored.bytes.length;
  const region = toByteSpan(Math.max(0, span.start - HUNK_CONTEXT_BYTES), Math.min(length, span.end + HUNK_CONTEXT_BYTES));
  if (region.start === region.end) {
    return err(stale); // An empty file has no neighbourhood to find.
  }
  const mapped = context.mapSpan(region);
  switch (mapped.tag) {
    case 'resolved': {
      const shift = mapped.span.start - region.start;
      return ok(toByteSpan(span.start + shift, span.end + shift));
    }
    case 'ambiguous':
    case 'gone':
      return err(stale);
    case 'too-costly':
      return err('resource-limit');
    default: {
      const exhaustive: never = mapped;
      return exhaustive;
    }
  }
}

function wholeIdentifier(bytes: ByteString, span: ByteSpan): boolean {
  const before = bytes[span.start - 1];
  const after = bytes[span.end];
  if (before !== undefined) {
    if (identifierByte(before) || before === 0x2e) {
      return false; // `x.item` is a property, not the loop's item.
    }
  }
  if (after !== undefined) {
    return !identifierByte(after);
  }
  return true;
}

function identifierByte(byte: number): boolean {
  if (byte >= 0x30 && byte <= 0x39) {
    return true;
  }
  if (byte >= 0x41 && byte <= 0x5a) {
    return true;
  }
  if (byte >= 0x61 && byte <= 0x7a) {
    return true;
  }
  return byte === 0x5f || byte === 0x24 || byte >= 0x80;
}

function spliceAt(bytes: ByteString, range: ByteSpan, replacement: string): Splice {
  return {
    range,
    expectedBytes: slice(bytes, range),
    replacementBytes: encodeUtf8(replacement),
  };
}
