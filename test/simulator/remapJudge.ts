// Judging a stale set-attribute intent (step 3, the spike): the planner decided
// from the diff alone; this module decides again from the byte origins the
// simulator recorded (provenance.ts) and says whether the planner was right.
//
//   applied-correct    planned at the element the authored one became
//   wrong-site         planned at any other element — the one outcome the
//                      step-4 gate allows zero of
//   conservative       rejected by the mapping although the element and the
//                      value being edited both survived: a missed edit, never
//                      a wrong one (plan §14)
//   rejected-conflict  rejected; the element survived, but another writer
//                      rewrote the very value being edited, so applying would
//                      have overwritten that edit
//   rejected-gone      rejected; the element no longer exists
//   other              rejected for a reason that is not a mapping decision
//   unjudged           no ground truth: git replaced the whole file in between
//
// An element is identified by its own `<` byte: it survived when that byte's
// origin is still in the file and an element of the same kind starts there.
// Editing its attributes does not make it another element; a pasted copy is
// new bytes, so it is another element however alike the two look.
//
// The same case also holds the fast mapper to the brute-force reference on the
// scenario's real bytes (plan §10), and checks that the planner's decision is
// the one the mapping implies.
import { assert } from '#dist/shared/core/assert.js';
import { DIFF_BUDGET } from '#dist/shared/engine/diff.js';
import type { Intent, RejectionReason } from '#dist/shared/engine/intent.js';
import { mapSpan, type SpanMapping } from '#dist/shared/engine/mapSpan.js';
import type { Plan } from '#dist/shared/engine/planner.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import type { ProjectedNode, Projection } from '#dist/shared/page/sourceProjection.js';
import { toByteSpan, type ByteSpan, type ByteString } from '#dist/shared/core/span.js';
import { applySplices } from '#dist/shared/engine/splice.js';
import type { Splice } from '#dist/shared/engine/planner.js';
import { survivingSpan, type Origins } from './provenance.ts';
import { referenceMapSpan, referenceTables } from './referenceDiff.ts';

export type RemapDecision = { readonly tag: 'planned'; readonly plan: Plan } | { readonly tag: 'rejected'; readonly reason: RejectionReason };

export type RemapVerdict =
  | { readonly tag: 'applied-correct' }
  | { readonly tag: 'wrong-site'; readonly detail: string }
  | { readonly tag: 'conservative'; readonly reason: RejectionReason }
  | { readonly tag: 'rejected-conflict'; readonly reason: RejectionReason }
  | { readonly tag: 'rejected-gone'; readonly reason: RejectionReason }
  | { readonly tag: 'other'; readonly reason: RejectionReason }
  | { readonly tag: 'unjudged'; readonly decision: RemapDecision['tag'] };

export interface RemapCase {
  readonly intent: Intent;
  readonly authored: Snapshot;
  readonly current: Snapshot;
  /** Undefined when the run no longer holds them (bounded retention). */
  readonly authoredOrigins: Origins | undefined;
  readonly currentOrigins: Origins | undefined;
  /** A git-style replacement happened between the two versions. */
  readonly replacedWhole: boolean;
  readonly decision: RemapDecision;
}

/** The brute-force table this check builds at most: files up to about 1 KB. */
export const JUDGE_REFERENCE_CELLS_MAX = 1_000_000;

const MAPPING_REASONS: readonly RejectionReason[] = ['anchor-ambiguous', 'anchor-moved', 'resource-limit'];

type ValidProjection = Extract<Projection, { tag: 'valid' }>;

/** The attribute a judged intent edits by name: a set's, a rename's old name;
 * none for a tag rename, which edits the tag's name (step 9). */
function judgedAttribute(operation: Intent['operation']): string | undefined {
  switch (operation.tag) {
    case 'set-attribute':
      return operation.name;
    case 'rename-attribute':
      return operation.from;
    case 'rename-tag':
      return undefined;
    case 'remove-attribute':
    case 'set-inline-style':
    case 'insert-node':
    case 'remove-node':
    case 'move-node':
    case 'rename-binding':
    case 'apply-code-patch':
    case 'edit-frontmatter-slot':
    case 'revert-splices':
    case 'rewrite-node':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
    case 'rewrite-text':
      throw new Error(`Assertion failed: ${operation.tag} is not judged by element survival`);
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export function judgeRemap(input: RemapCase): RemapVerdict {
  assert(input.authored.checksum !== input.current.checksum, 'Only stale intents are judged');
  const operation = input.intent.operation;
  const attributeName = judgedAttribute(operation);
  const decision = input.decision;
  const authored = input.authored.projection;
  const current = input.current.projection;
  if (authored.tag === 'parse-error') {
    return otherRejection(decision);
  }
  if (current.tag === 'parse-error') {
    return otherRejection(decision);
  }
  const node = anchoredNode(authored, input.intent);
  const named = node.attributes.filter((attribute) => attribute.name === attributeName);
  if (decision.tag === 'rejected') {
    if (!MAPPING_REASONS.includes(decision.reason)) {
      return { tag: 'other', reason: decision.reason };
    }
    if (named.length > 1) {
      return { tag: 'other', reason: decision.reason }; // Duplicate names, before any mapping.
    }
  }
  if (input.authoredOrigins === undefined) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  if (input.currentOrigins === undefined || input.replacedWhole) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  const survivor = survivingElement(node, input.authoredOrigins, current, input.currentOrigins);
  if (decision.tag === 'rejected') {
    const reason = decision.reason;
    if (survivor === undefined) {
      return { tag: 'rejected-gone', reason };
    }
    if (named.length === 0) {
      // Step 6: an absent attribute is inserted; the element survived, so a
      // refusal kept it from nothing it could conflict with.
      return { tag: 'conservative', reason };
    }
    assert(named.length === 1, 'A mapping decision was reached for one named attribute');
    const [attribute] = named;
    assert(attribute !== undefined, 'The named attribute exists');
    const kept = survivingSpan(input.authoredOrigins, attribute.span, input.currentOrigins);
    const now = survivor.attributes.find((candidate) => candidate.name === attributeName);
    if (kept !== undefined && kept.start === now?.span.start) {
      return { tag: 'conservative', reason };
    }
    return { tag: 'rejected-conflict', reason };
  }
  const target = plannedTarget(current, input.current.bytes, decision.plan);
  if (survivor === undefined) {
    return { tag: 'wrong-site', detail: `${describe(input, target)}; the element is gone` };
  }
  if (target.span.start === survivor.span.start) {
    return { tag: 'applied-correct' };
  }
  const detail = `${describe(input, target)}; the element is at ${survivor.span.start}`;
  return { tag: 'wrong-site', detail };
}

/** Judging a stale Markdown block intent (step 10): a text typed, a block or
 * an item removed, inserted beside, or moved. A Markdown node survives as the
 * node of its kind that now holds most of its content bytes by origin
 * (survivingBlock) — not by its first byte, as a tag by its `<`: a block's
 * first line can be duplicated away from the rest of it. The plan was right
 * when its splices sit where the operation says, at the survivor: a rewrite
 * inside it, a removal around it, an insertion against it, a move around it
 * and against the survivor of its destination. */
export function judgeBlockRemap(input: RemapCase): RemapVerdict {
  assert(input.authored.checksum !== input.current.checksum, 'Only stale intents are judged');
  const decision = input.decision;
  const authored = input.authored.projection;
  const current = input.current.projection;
  if (authored.tag === 'parse-error') {
    return otherRejection(decision);
  }
  if (current.tag === 'parse-error') {
    return otherRejection(decision);
  }
  if (decision.tag === 'rejected') {
    if (!MAPPING_REASONS.includes(decision.reason)) {
      return { tag: 'other', reason: decision.reason };
    }
  }
  const authoredOrigins = input.authoredOrigins;
  const currentOrigins = input.currentOrigins;
  if (authoredOrigins === undefined || currentOrigins === undefined || input.replacedWhole) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  const origins = { authored: authoredOrigins, current: currentOrigins };
  const node = anchoredNode(authored, input.intent);
  const bytes = { authored: input.authored.bytes, current: input.current.bytes };
  const survivor = survivingBlock(node, origins, current, bytes.authored, bytes.current);
  if (decision.tag === 'rejected') {
    const reason = decision.reason;
    if (survivor === undefined) {
      return { tag: 'rejected-gone', reason };
    }
    const kept = survivingSpan(origins.authored, node.span, origins.current);
    const whole = kept !== undefined && kept.start === survivor.span.start;
    return whole ? { tag: 'conservative', reason } : { tag: 'rejected-conflict', reason };
  }
  const { id, file, operation } = input.intent;
  if (survivor === undefined && identicalRewritten(node, input)) {
    // The node is gone, and a node of its kind holds exactly its bytes under
    // other origins — rewritten identically, or restored by an undo mapped
    // through other writes. No byte rule can tell the two apart (planner.test,
    // BYTES CANNOT TELL): counted, not judged.
    return { tag: 'unjudged', decision: decision.tag };
  }
  if (survivor === undefined) {
    const text = JSON.stringify(sliceText(input.authored.bytes, node.span.start, node.span.end));
    const where = `${node.kind} ${node.path.join('/')} ${text} at ${node.span.start}`;
    const planned = splicesText(decision.plan.splices, input.current.bytes);
    const what = `${id} ${operation.tag} on ${file}`;
    const detail = `${what}: the node (${where}) is gone; planned ${planned}`;
    return { tag: 'wrong-site', detail };
  }
  const splices = decision.plan.splices;
  const views = {
    authored,
    current,
    origins,
    bytes: input.authored.bytes,
    currentBytes: input.current.bytes,
  };
  const placed = blockPlanPlaced(operation, splices, survivor, views);
  if (placed === 'placed') {
    return { tag: 'applied-correct' };
  }
  if (placed === 'unjudged') {
    return { tag: 'unjudged', decision: decision.tag };
  }
  const was = JSON.stringify(sliceText(input.authored.bytes, node.span.start, node.span.end));
  const is = JSON.stringify(sliceText(input.current.bytes, survivor.span.start, survivor.span.end));
  const now = `${survivor.span.start}-${survivor.span.end} (${node.kind} ${was}, now ${is})`;
  const planned = splicesText(splices, input.current.bytes);
  const what = `${id} ${operation.tag} on ${file}`;
  const detail = `${what}: not at the node, now at ${now}; planned ${planned}`;
  return { tag: 'wrong-site', detail };
}

interface BlockOrigins {
  readonly authored: Origins;
  readonly current: Origins;
}

// Where each operation's splices must sit relative to the survivor.
function blockPlanPlaced(
  operation: Intent['operation'],
  splices: readonly Splice[],
  survivor: ProjectedNode,
  views: {
    readonly authored: ValidProjection;
    readonly current: ValidProjection;
    readonly origins: BlockOrigins;
    /** The authored bytes. */
    readonly bytes: ByteString;
    readonly currentBytes: ByteString;
  },
): 'placed' | 'misplaced' | 'unjudged' {
  const span = survivor.span;
  switch (operation.tag) {
    case 'rewrite-node':
      return splices.every((splice) => within(splice.range, span)) ? 'placed' : 'misplaced';
    case 'remove-node':
      return splices.some((splice) => within(span, splice.range)) ? 'placed' : 'misplaced';
    case 'insert-node':
      return splices.every((splice) => touches(splice.range, span)) ? 'placed' : 'misplaced';
    case 'move-node': {
      const destination = views.authored.nodes.find(
        (candidate) =>
          candidate.path.length === operation.destination.path.length && candidate.path.every((step, index) => step === operation.destination.path[index]),
      );
      assert(destination !== undefined, 'A move names a node of its authored view');
      const there = survivingBlock(destination, views.origins, views.current, views.bytes, views.currentBytes);
      if (there === undefined) {
        // Gone, or re-created identically under other origins: the same limit
        // as the node's own (identicalRewritten).
        const rewritten = identicalIn(destination, views.bytes, views.current, views.currentBytes);
        return rewritten ? 'unjudged' : 'misplaced';
      }
      const out = splices.filter((splice) => within(span, splice.range));
      const into = splices.filter((splice) => touches(splice.range, there.span));
      return out.length > 0 && into.length > 0 ? 'placed' : 'misplaced';
    }
    case 'set-attribute':
    case 'remove-attribute':
    case 'rename-binding':
    case 'set-inline-style':
    case 'apply-code-patch':
    case 'revert-splices':
    case 'edit-frontmatter-slot':
    case 'rewrite-text':
    case 'rename-tag':
    case 'rename-attribute':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
      throw new Error(`Assertion failed: ${operation.tag} is not a judged block operation`);
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function splicesText(splices: readonly Splice[], bytes: ByteString): string {
  return splices
    .map((splice) => {
      const around = sliceText(bytes, splice.range.start - 30, splice.range.end + 30);
      return `${splice.range.start}-${splice.range.end} in ${JSON.stringify(around)}`;
    })
    .join(', ');
}

function sliceText(bytes: ByteString, start: number, end: number): string {
  return Buffer.from(bytes.subarray(Math.max(0, start), Math.min(bytes.length, end))).toString();
}

// Whether the current file holds a node of `node`'s kind whose bytes are
// exactly the authored node's.
function identicalRewritten(node: ProjectedNode, input: RemapCase): boolean {
  const current = input.current.projection;
  if (current.tag !== 'valid') {
    return false;
  }
  return identicalIn(node, input.authored.bytes, current, input.current.bytes);
}

function identicalIn(node: ProjectedNode, bytes: ByteString, current: ValidProjection, currentBytes: ByteString): boolean {
  const text = sliceText(bytes, node.span.start, node.span.end);
  return current.nodes.some((candidate) => candidate.kind === node.kind && sliceText(currentBytes, candidate.span.start, candidate.span.end) === text);
}

function within(inner: ByteSpan, outer: ByteSpan): boolean {
  if (outer.start <= inner.start) {
    return inner.end <= outer.end;
  }
  return false;
}

// Sharing a byte, or meeting at an edge.
function touches(range: ByteSpan, span: ByteSpan): boolean {
  if (range.start <= span.end) {
    return span.start <= range.end;
  }
  return false;
}

// The node of the same kind now holding more than half of the authored node's
// content bytes by origin (separators are rewritten around blocks, so they
// are not counted). A list holds all of its item's bytes and a quote all of
// its paragraph's, so of every node holding most of them the one most like
// the authored node wins (closer). A node whose first line someone duplicated is where
// most of it went, not where its first byte stayed; a node retyped under new
// origins is gone.
function survivingBlock(
  node: ProjectedNode,
  origins: BlockOrigins,
  current: ValidProjection,
  bytes: ByteString,
  currentBytes: ByteString,
): ProjectedNode | undefined {
  const wanted = new Set<number>();
  for (let at = node.span.start; at < node.span.end; at++) {
    const byte = bytes[at];
    const origin = origins.authored[at];
    if (byte !== undefined && origin !== undefined && !isSeparatorByte(byte)) {
      wanted.add(origin);
    }
  }
  if (wanted.size === 0) {
    return undefined;
  }
  // Every node of the kind holding most of the content; of those, the one
  // most like the authored node.
  const like = {
    node,
    text: sliceText(bytes, node.span.start, node.span.end),
    bytes: currentBytes,
  };
  let best: ProjectedNode | undefined;
  for (const candidate of current.nodes) {
    if (candidate.kind !== node.kind) {
      continue;
    }
    let count = 0;
    for (let at = candidate.span.start; at < candidate.span.end; at++) {
      count += wanted.has(origins.current[at] ?? -1) ? 1 : 0;
    }
    if (count * 2 > wanted.size) {
      if (best === undefined || closer(candidate, best, like)) {
        best = candidate;
      }
    }
  }
  return best;
}

function width(node: ProjectedNode): number {
  return node.span.end - node.span.start;
}

// Whether `candidate` is more like `authored` than `other` is: holding exactly
// its bytes, then closest in size, then at its depth. A list and its only
// item hold the same content, and so do a quote and its paragraph; a block
// nested since keeps its text but not its depth.
function closer(
  candidate: ProjectedNode,
  other: ProjectedNode,
  authored: { readonly node: ProjectedNode; readonly text: string; readonly bytes: ByteString },
): boolean {
  const same = (node: ProjectedNode) => sliceText(authored.bytes, node.span.start, node.span.end) === authored.text;
  if (same(candidate) !== same(other)) {
    return same(candidate);
  }
  const mine = Math.abs(width(candidate) - width(authored.node));
  const theirs = Math.abs(width(other) - width(authored.node));
  if (mine !== theirs) {
    return mine < theirs;
  }
  const depth = authored.node.path.length;
  return candidate.path.length === depth && other.path.length !== depth;
}

function isSeparatorByte(byte: number): boolean {
  switch (byte) {
    case 0x20:
    case 0x09:
    case 0x0a:
    case 0x0d:
    case 0x3e:
      return true;
    default:
      return false;
  }
}

/** Judging a stale oracle gesture step (step 6: every operation maps). The
 * oracle's hand-derived splices name the authored bytes the edit replaces; if
 * the origins show each of those ranges survived whole, the right result is
 * the current file with the same replacements at the surviving ranges, and the
 * plan must write exactly that. Where a range did not survive, there is no
 * ground truth to compare with: unjudged. */
export function judgeOracleRemap(input: RemapCase, authoredSplices: readonly Splice[]): RemapVerdict {
  assert(input.authored.checksum !== input.current.checksum, 'Only stale intents are judged');
  const decision = input.decision;
  if (input.authoredOrigins === undefined || input.currentOrigins === undefined) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  if (input.replacedWhole) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  const authoredOrigins = input.authoredOrigins;
  const currentOrigins = input.currentOrigins;
  const survived = authoredSplices.map((splice) => ({
    splice,
    span: survivingRange(authoredOrigins, splice.range, currentOrigins),
  }));
  const whole = survived.every((entry) => entry.span !== undefined);
  if (decision.tag === 'rejected') {
    if (!MAPPING_REASONS.includes(decision.reason)) {
      return { tag: 'other', reason: decision.reason };
    }
    return whole ? { tag: 'conservative', reason: decision.reason } : { tag: 'rejected-conflict', reason: decision.reason };
  }
  if (!whole) {
    return { tag: 'unjudged', decision: decision.tag };
  }
  const moved: Splice[] = survived.map(({ splice, span }) => {
    assert(span !== undefined, 'Every range survived');
    return { ...splice, range: span };
  });
  const expected = applySplices(input.current.bytes, moved);
  const actual = applySplices(input.current.bytes, decision.plan.splices);
  // Up to whitespace runs: a removal range that starts at a line break keeps
  // its origin when another writer turns LF into CRLF, and replaying it leaves
  // the new `\r` behind, where the planner — reading the current bytes — takes
  // it too (seed 5). Which element was edited, and how, survives the collapse.
  if (collapsed(expected) === collapsed(actual)) {
    return { tag: 'applied-correct' };
  }
  const { id, file, operation } = input.intent;
  const what = `${id} ${operation.tag} on ${file}`;
  const detail = `${what}: another result ${firstDifference(expected, actual)}`;
  return { tag: 'wrong-site', detail };
}

// Where two results part, with a little of each: what a wrong-site report shows.
function firstDifference(expected: ByteString, actual: ByteString): string {
  let at = 0;
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) {
    at++;
  }
  const around = (bytes: ByteString) => JSON.stringify(Buffer.from(bytes.subarray(Math.max(0, at - 12), at + 24)).toString('utf8'));
  return `at byte ${at}: expected ${around(expected)}, planned ${around(actual)}`;
}

// A range's survivor: its own bytes whole, or — an insertion's point, which
// holds no byte — the byte before it (the point follows it), else the byte
// after it (the point precedes it).
function survivingRange(authored: Origins, range: ByteSpan, current: Origins): ByteSpan | undefined {
  if (range.start < range.end) {
    return survivingSpan(authored, range, current);
  }
  if (range.start > 0) {
    const before = survivingSpan(authored, toByteSpan(range.start - 1, range.start), current);
    return before === undefined ? undefined : toByteSpan(before.end, before.end);
  }
  if (range.start < authored.length) {
    const after = survivingSpan(authored, toByteSpan(range.start, range.start + 1), current);
    return after === undefined ? undefined : toByteSpan(after.start, after.start);
  }
  return undefined;
}

function collapsed(bytes: ByteString): string {
  return Buffer.from(bytes).toString('utf8').replace(/\s+/g, ' ');
}

/** Fast mapper and brute-force reference agree on the planner's region, and
 * the planner's decision is the one the mapping implies. False when the files
 * are too large for the reference table. */
export function checkMappingReference(input: RemapCase): boolean {
  const operation = input.intent.operation;
  assert(operation.tag === 'set-attribute', 'Only set-attribute is mapped at step 3');
  const authored = input.authored.projection;
  if (authored.tag === 'parse-error') {
    return false;
  }
  if (input.current.projection.tag === 'parse-error') {
    return false; // Rejected before mapping: nothing to compare.
  }
  const node = anchoredNode(authored, input.intent);
  const region = identityRegion(node);
  if (region === undefined) {
    return false;
  }
  const cells = (input.authored.bytes.length + 1) * (input.current.bytes.length + 1);
  if (cells > JUDGE_REFERENCE_CELLS_MAX) {
    return false;
  }
  const fast = mapSpan(input.authored.bytes, input.current.bytes, region, DIFF_BUDGET);
  const tables = referenceTables(input.authored.bytes, input.current.bytes);
  const reference = referenceMapSpan(tables, region);
  assert(sameMapping(fast, reference), 'The fast mapper agrees with the brute-force reference');
  checkDecisionFollowsMapping(input.decision, fast, region, node, operation.name);
  return true;
}

function checkDecisionFollowsMapping(decision: RemapDecision, mapping: SpanMapping, region: ByteSpan, node: ProjectedNode, name: string): void {
  if (decision.tag === 'planned') {
    assert(mapping.tag === 'resolved', 'A stale plan follows a resolved mapping');
    const [splice] = decision.plan.splices;
    assert(splice !== undefined, 'A set-attribute plan has a splice');
    const shift = mapping.span.start - region.start;
    const value = node.attributes.find((attribute) => attribute.name === name)?.valueSpan;
    if (value !== undefined) {
      if (splice.range.end - splice.range.start === value.end - value.start) {
        if (splice.expectedBytes.length === value.end - value.start) {
          assert(splice.range.start === value.start + shift, 'The splice sits at the mapped value');
          return;
        }
      }
    }
    // A re-quoted or a new attribute: inside the mapped region, its end included.
    assert(splice.range.start >= mapping.span.start, 'The splice lies in the mapped region');
    assert(splice.range.end <= mapping.span.end, 'The splice ends in the mapped region');
    return;
  }
  const reason = decision.reason;
  if (mapping.tag === 'ambiguous') {
    assert(reason !== 'anchor-moved', 'An ambiguous mapping never reads as a move');
  }
  if (mapping.tag === 'too-costly') {
    assert(reason === 'resource-limit', 'An exhausted diff is a resource limit');
  }
}

/** The authored node the intent names: its own view's projection holds it. */
function anchoredNode(projection: ValidProjection, intent: Intent): ProjectedNode {
  const anchor = intent.anchor;
  const node = projection.nodes.find((candidate) => {
    if (candidate.path.length === anchor.path.length) {
      return candidate.path.every((step, index) => step === anchor.path[index]);
    }
    return false;
  });
  assert(node !== undefined, 'A visual intent names a node of its authored view');
  assert(node.span.start === anchor.span.start, 'The anchor span is the node span');
  assert(node.kind === anchor.expectedKind, 'The anchor kind is the node kind');
  return node;
}

/** The planner's identity region, rebuilt here from its definition (tag name
 * through the last attribute), so the planner's own helper is not the judge. */
function identityRegion(node: ProjectedNode): ByteSpan | undefined {
  const end = node.attributes.reduce<number>((last, attribute) => Math.max(last, attribute.span.end), node.span.start);
  return end > node.span.start + 1 ? toByteSpan(node.span.start + 1, end) : undefined;
}

// The element survived if its own `<` byte is still in the file and an element
// of the same kind still starts there: a `<` that became comment text is gone.
function survivingElement(node: ProjectedNode, authoredOrigins: Origins, current: ValidProjection, currentOrigins: Origins): ProjectedNode | undefined {
  const opening = survivingSpan(authoredOrigins, toByteSpan(node.span.start, node.span.start + 1), currentOrigins);
  if (opening === undefined) {
    return undefined;
  }
  return current.nodes.find((candidate) => {
    if (candidate.span.start === opening.start) {
      return candidate.kind === node.kind;
    }
    return false;
  });
}

// The current tag whose attributes the splice edits: from step 6 a value, a
// whole re-quoted attribute, or a new one after the last. A tag's attribute
// region runs from its `<` to its last attribute (or its name); nested tags'
// regions never overlap, so exactly one contains the splice.
// The tag whose name-and-attributes region holds the plan's first splice: the
// one splice of an attribute edit, or a tag rename's opening name (its second
// splice, the closing name, lies in that tag's content).
function plannedTarget(current: ValidProjection, bytes: ByteString, plan: Plan): ProjectedNode {
  assert(plan.splices.length >= 1, 'A judged plan has a splice');
  assert(plan.splices.length <= 2, 'A judged plan edits one attribute or one tag name');
  const [splice] = plan.splices;
  assert(splice !== undefined, 'The splice exists');
  const owners = current.nodes.filter((node) => {
    const end = attributesEnd(bytes, node);
    return node.span.start < splice.range.start && splice.range.end <= end;
  });
  const [target] = owners;
  assert(owners.length === 1, 'The splice edits the attributes of one current tag');
  assert(target !== undefined, 'The splice lands in the attributes of a current tag');
  return target;
}

// Rebuilt from the definition, not borrowed from the planner.
function attributesEnd(bytes: ByteString, node: ProjectedNode): number {
  if (node.kind !== 'element' && node.kind !== 'component' && node.kind !== 'raw') {
    return -1;
  }
  let nameEnd = node.span.start + 1;
  for (; nameEnd < node.span.end; nameEnd++) {
    const byte = bytes[nameEnd];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x2f || byte === 0x3e) {
      break;
    }
  }
  return node.attributes.reduce((last, attribute) => Math.max(last, attribute.span.end), nameEnd);
}

function otherRejection(decision: RemapDecision): RemapVerdict {
  assert(decision.tag === 'rejected', 'A file that does not parse plans no visual intent');
  return { tag: 'other', reason: decision.reason };
}

function sameMapping(left: SpanMapping, right: SpanMapping): boolean {
  if (left.tag === 'resolved') {
    if (right.tag === 'resolved') {
      return left.span.start === right.span.start;
    }
    return false;
  }
  return left.tag === right.tag;
}

function describe(input: RemapCase, target: ProjectedNode): string {
  return `${input.intent.id} on ${input.intent.file} planned at byte ${target.span.start}`;
}
