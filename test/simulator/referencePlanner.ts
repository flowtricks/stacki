// The step-1 reference planner: identity mapping only. It plans an intent when
// the file still holds exactly the bytes the intent was authored against, and
// rejects everything else — it never maps a span through a diff. Step 2's
// planner (shared/engine/planner.ts) maps set-attribute through the diff; this one
// stays as the reference for the zero-diff case, which the shipping planner
// must agree with (plan §10), and plans the other operations in the simulator
// until their steps ship them.
//
// Pure (plan §5.2): snapshot and intent in, Result out. No disk, no clock.
import { assert } from '#dist/shared/core/assert.js';
import { capabilityAcceptsVisualIntent } from '#dist/shared/page/capability.js';
import type { Intent, RejectionReason } from '#dist/shared/engine/intent.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import type { AnchorRef, StructuralPath } from '#dist/shared/page/ref.js';
import { err, ok, type Result } from '#dist/shared/core/result.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import type { ProjectedNode, Projection } from '#dist/shared/page/sourceProjection.js';
import { byteStringsEqual, encodeUtf8, toByteString, type ByteSpan, type ByteString } from '#dist/shared/core/span.js';
import type { CandidatePolicy, Plan, PostKind } from '#dist/shared/engine/planner.js';
import type { Splice } from '#dist/shared/engine/planner.js';

const QUOTE_DOUBLE = 0x22;
const QUOTE_SINGLE = 0x27;

export type { CandidatePolicy, Plan, PostKind };

export function planByIdentity(snapshot: Snapshot, intent: Intent): Result<Plan, RejectionReason> {
  assert(snapshot.path === intent.file, 'An intent is planned against its own file');
  const operation = intent.operation;
  // A file that does not parse rejects every visual intent the same way,
  // stale or not: the useful reason is "fix it in code", not "it moved".
  if (snapshot.projection.tag === 'parse-error') {
    if (isVisual(operation.tag)) {
      return err('source-invalid');
    }
  }
  if (snapshot.checksum !== intent.authoredChecksum) {
    return err(staleReason(operation.tag));
  }
  switch (operation.tag) {
    case 'rewrite-text': {
      if (intent.anchor.span.end !== snapshot.bytes.length) {
        return err('anchor-moved');
      }
      const splices = operation.hunks.map((hunk) => spliceAt(snapshot.bytes, hunk.span, hunk.text));
      return ok({ splices, postKinds: [], candidate: 'may-be-invalid' });
    }
    case 'apply-code-patch': {
      const splices = operation.hunks.map((hunk) => spliceAt(snapshot.bytes, hunk.span, hunk.text));
      return ok({ splices, postKinds: [], candidate: 'may-be-invalid' });
    }
    case 'revert-splices': {
      // Step 6: a revert restores bytes, so a parsing file must keep parsing.
      const splices = operation.hunks.map((hunk) => spliceAt(snapshot.bytes, hunk.span, hunk.text));
      const candidate = snapshot.projection.tag === 'valid' ? 'must-parse' : 'may-be-invalid';
      return ok({ splices, postKinds: [], candidate });
    }
    case 'set-attribute':
    case 'rename-binding':
    case 'edit-frontmatter-slot':
      return planVisual(snapshot, intent);
    case 'remove-attribute':
    case 'insert-node':
    case 'remove-node':
    case 'move-node':
    case 'set-inline-style':
    case 'rename-tag':
    case 'rename-attribute':
    case 'rewrite-node':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
      // Planned from step 6 (step 9 for the renames and rewrites) by the
      // shipping planner only; this reference stays
      // the step-1 identity planner for the operations it was written for.
      return err('unsupported-operation');
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unknown operation ${JSON.stringify(exhaustive)}`);
    }
  }
}

function isVisual(tag: Intent['operation']['tag']): boolean {
  switch (tag) {
    case 'rewrite-text':
    case 'apply-code-patch':
    case 'revert-splices':
      return false;
    case 'set-attribute':
    case 'remove-attribute':
    case 'insert-node':
    case 'remove-node':
    case 'move-node':
    case 'rename-binding':
    case 'set-inline-style':
    case 'edit-frontmatter-slot':
    case 'rename-tag':
    case 'rename-attribute':
    case 'rewrite-node':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
      return true;
    default: {
      const exhaustive: never = tag;
      return exhaustive;
    }
  }
}

function staleReason(tag: Intent['operation']['tag']): RejectionReason {
  switch (tag) {
    case 'rewrite-text':
    case 'revert-splices':
      return 'region-externally-modified';
    case 'apply-code-patch':
      return 'merge-conflict';
    case 'set-attribute':
    case 'remove-attribute':
    case 'insert-node':
    case 'remove-node':
    case 'move-node':
    case 'rename-binding':
    case 'set-inline-style':
    case 'edit-frontmatter-slot':
    case 'rename-tag':
    case 'rename-attribute':
    case 'rewrite-node':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
      return 'anchor-moved';
    default: {
      const exhaustive: never = tag;
      return exhaustive;
    }
  }
}

function planVisual(snapshot: Snapshot, intent: Intent): Result<Plan, RejectionReason> {
  const projection = snapshot.projection;
  if (projection.tag === 'parse-error') {
    return err('source-invalid');
  }
  const operation = intent.operation;
  if (operation.tag === 'edit-frontmatter-slot') {
    if (!sameSpan(projection.frontmatter, intent.anchor.span)) {
      return err('anchor-moved');
    }
    const splice = spliceAt(snapshot.bytes, operation.slot, operation.text);
    return ok({ splices: [splice], postKinds: [], candidate: 'must-parse' });
  }
  const node = resolveNode(projection, intent.anchor);
  if (!node.ok) {
    return node;
  }
  if (!capabilityAcceptsVisualIntent(node.value.capability)) {
    return err('unsupported-operation');
  }
  const postKinds = [{ path: node.value.path, kind: node.value.kind }];
  if (operation.tag === 'set-attribute') {
    const splice = planSetAttribute(snapshot.bytes, node.value, operation);
    return splice.ok ? ok({ splices: [splice.value], postKinds, candidate: 'must-parse' }) : splice;
  }
  assert(operation.tag === 'rename-binding', 'The remaining visual operation is a rename');
  const splices = operation.sites.map((site) => spliceAt(snapshot.bytes, site, operation.to));
  const from = encodeUtf8(operation.from);
  if (splices.every((splice) => byteStringsEqual(splice.expectedBytes, from))) {
    return ok({ splices, postKinds, candidate: 'must-parse' });
  }
  return err('anchor-moved');
}

/** Resolution without mapping: the node at the authored path must still have
 * the authored span and kind, or the anchor has moved. */
export function resolveNode(projection: Extract<Projection, { tag: 'valid' }>, anchor: AnchorRef): Result<ProjectedNode, RejectionReason> {
  const node = projection.nodes.find((candidate) => samePath(candidate.path, anchor.path));
  if (node === undefined) {
    return err('anchor-moved');
  }
  if (node.kind === anchor.expectedKind) {
    return sameSpan(node.span, anchor.span) ? ok(node) : err('anchor-moved');
  }
  return err('anchor-moved');
}

function planSetAttribute(
  bytes: ByteString,
  node: ProjectedNode,
  operation: Extract<Intent['operation'], { tag: 'set-attribute' }>,
): Result<Splice, RejectionReason> {
  const found = node.attributes.filter((attribute) => attribute.name === operation.name);
  const [attribute] = found;
  if (attribute === undefined) {
    return err('unsupported-operation'); // Inserting an attribute arrives at step 6.
  }
  if (found.length > 1) {
    return err('anchor-ambiguous'); // Duplicate names: which one the page uses is a guess.
  }
  if (operation.value.type !== 'string') {
    return err('unsupported-operation');
  }
  if (attribute.type === 'string') {
    assert(attribute.valueSpan !== undefined, 'A string attribute has a value span');
    // The value sits between quotes the splice keeps. A new value containing
    // that quote would end the attribute early and re-parse as another tree —
    // the simulator's first seeded run found exactly that. Re-quoting is a
    // step-6 gesture; until then the edit is refused, visibly.
    const quote = bytes[attribute.valueSpan.start - 1];
    assert(quote === QUOTE_DOUBLE || quote === QUOTE_SINGLE, 'A string value sits in quotes');
    if (operation.value.value.includes(String.fromCharCode(quote))) {
      return err('unsupported-operation');
    }
    return ok(spliceAt(bytes, attribute.valueSpan, operation.value.value));
  }
  return err('unsupported-operation');
}

function spliceAt(bytes: ByteString, range: ByteSpan, replacement: string): Splice {
  assert(range.end <= bytes.length, 'A planned range lies inside the file');
  assert(range.end - range.start <= LIMITS.sourceBytesMax, 'A planned range is inside the bound');
  return {
    range,
    expectedBytes: toByteString(bytes.subarray(range.start, range.end)),
    replacementBytes: encodeUtf8(replacement),
  };
}

function sameSpan(left: ByteSpan | undefined, right: ByteSpan): boolean {
  if (left === undefined) {
    return false;
  }
  return left.start === right.start ? left.end === right.end : false;
}

function samePath(left: StructuralPath, right: StructuralPath): boolean {
  if (left.length === right.length) {
    return left.every((step, index) => step === right[index]);
  }
  return false;
}
