// The simulator invariants (plan §10), checked from the outside. Each check
// recomputes what it needs from the recorded bytes and projections instead of
// trusting the actor's own conclusions — an invariant the actor asserts about
// itself is the producer side; these are the consumer side of the same pair.
//
//   1. Every accepted intent reaches one terminal result.     (checkOutcome, checkQuiescent)
//   2. Every applied splice matched its expected bytes.       (checkCommitted)
//   3. Bytes outside splice ranges are unchanged.             (checkCommitted)
//   4. No anchor resolves to the wrong node kind.             (checkCommitted)
//   5. Ambiguous anchors never apply.                         (checkCommitted)
//   6. A stale preview cannot submit a silently remapped edit.(checkCommitted,
//      and world.ts judges every remap against the recorded byte origins)
//   7. The actor never commits an older snapshot over a newer one. (checkGeneration)
//   8. Queue, parser, diff and snapshot bounds hold.          (checkBounds)
//   9. The same seed produces the same results.               (the suite runs seeds twice)
import { assert } from '#dist/shared/core/assert.js';
import type { Intent, Outcome } from '#dist/shared/engine/intent.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { isNodeKind } from '#dist/shared/page/ref.js';
import type { ActorEffect, ActorState } from '#dist/shared/engine/documentActor.js';
import { orderedSplices } from '#dist/shared/engine/splice.js';
import { tagNameEnd } from '#dist/shared/engine/planSupport.js';

type Committed = Extract<ActorEffect, { tag: 'committed' }>;

export function checkOutcome(outcome: Outcome, accepted: ReadonlyMap<string, Intent>, terminal: ReadonlyMap<string, Outcome>): void {
  assert(accepted.has(outcome.intentId), 'Invariant 1: only accepted intents reach an outcome');
  assert(!terminal.has(outcome.intentId), 'Invariant 1: an intent reaches exactly one outcome');
}

export function checkQuiescent(accepted: ReadonlyMap<string, Intent>, terminal: ReadonlyMap<string, Outcome>): void {
  for (const id of accepted.keys()) {
    assert(terminal.has(id), `Invariant 1: accepted intent ${id} reached a terminal outcome`);
  }
  assert(terminal.size === accepted.size, 'Invariant 1: no outcome without an accepted intent');
}

export function checkCommitted(effect: Committed): void {
  const before = effect.base.bytes;
  const after = effect.candidate.bytes;
  const splices = orderedSplices(effect.plan.splices);
  assert(splices.length <= LIMITS.splicesPerIntentMax, 'Invariant 8: splice count is bounded');
  let cursorBefore = 0;
  let cursorAfter = 0;
  for (const splice of splices) {
    const found = before.subarray(splice.range.start, splice.range.end);
    assert(equalBytes(found, splice.expectedBytes), 'Invariant 2: the splice matched its witness');
    const gap = splice.range.start - cursorBefore;
    assert(
      equalBytes(before.subarray(cursorBefore, splice.range.start), after.subarray(cursorAfter, cursorAfter + gap)),
      'Invariant 3: bytes before a splice are unchanged',
    );
    cursorAfter += gap;
    const replaced = after.subarray(cursorAfter, cursorAfter + splice.replacementBytes.length);
    assert(equalBytes(replaced, splice.replacementBytes), 'The replacement landed where planned');
    cursorAfter += splice.replacementBytes.length;
    cursorBefore = splice.range.end;
  }
  assert(equalBytes(before.subarray(cursorBefore), after.subarray(cursorAfter)), 'Invariant 3: the tail is unchanged');
  checkTarget(effect);
  // Invariant 6, the part checkable here: a program's text rewrite is never
  // mapped, so one applied to bytes it was not authored against is a silent
  // remap. Every other operation maps from step 6, and world.ts judges each
  // mapped one against where the authored bytes really went — not against the
  // planner's own claim.
  if (effect.intent.authoredChecksum !== effect.base.checksum) {
    assert(effect.intent.operation.tag !== 'rewrite-text', 'Invariant 6: no silent remap');
  }
  checkGeneration(effect.previousGeneration, effect.generation);
}

// Invariants 4 and 5, from the projections alone: the anchored node had the
// expected kind before and after, and an attribute edit named one attribute.
// The target in the base is found from the splice, not from the anchor path: a
// remapped intent's authored path can name another node in the base.
function checkTarget(effect: Committed): void {
  const anchor = effect.intent.anchor;
  if (!isNodeKind(anchor.expectedKind)) {
    return;
  }
  const before = effect.base.projection;
  const after = effect.candidate.projection;
  assert(before.tag === 'valid', 'A node intent applied to a parsing file');
  assert(after.tag === 'valid', 'A node intent produced a parsing file');
  const operation = effect.intent.operation;
  if (effect.intent.authoredChecksum !== effect.base.checksum) {
    if (operation.tag !== 'set-attribute') {
      // A mapped gesture step's authored path may name another node in the
      // base; world.ts judges where it landed, and its post-kinds hold below.
      checkPostKinds(effect, after);
      return;
    }
  }
  const path = targetPath(effect);
  const same = (candidate: readonly number[]) => candidate.length === path.length && candidate.every((step, index) => step === path[index]);
  const target = before.nodes.find((node) => same(node.path));
  assert(target?.kind === anchor.expectedKind, 'Invariant 4: the anchor held the expected kind');
  if (staysInPlace(operation.tag)) {
    const result = after.nodes.find((node) => same(node.path));
    assert(result?.kind === anchor.expectedKind, 'Invariant 4: the target kept its kind');
  }
  checkPostKinds(effect, after);
  if (operation.tag === 'set-attribute') {
    const named = target.attributes.filter((attribute) => attribute.name === operation.name);
    // None: step 6 inserts it. Two or more: which one the page uses is a guess.
    assert(named.length <= 1, 'Invariant 5: an ambiguous attribute never applies');
  }
}

// What the plan promised about the candidate, checked on this side too.
function checkPostKinds(effect: Committed, after: Extract<Committed['candidate']['projection'], { tag: 'valid' }>): void {
  for (const post of effect.plan.postKinds) {
    const found = after.nodes.find((node) => node.path.length === post.path.length && node.path.every((step, index) => step === post.path[index]));
    assert(found?.kind === post.kind, 'Invariant 4: every planned post-kind holds');
  }
}

// A removal takes its target away and a move (step 6) puts it elsewhere, out
// of a loop perhaps as another kind; an insertion before it shifts it. Their
// candidates are checked through the plan's post-kinds instead.
function staysInPlace(tag: Intent['operation']['tag']): boolean {
  switch (tag) {
    case 'set-attribute':
    case 'remove-attribute':
    case 'set-inline-style':
    case 'rename-binding':
    case 'rename-attribute':
      return true;
    case 'insert-node':
    case 'remove-node':
    case 'move-node':
    case 'edit-frontmatter-slot':
    case 'apply-code-patch':
    case 'revert-splices':
    case 'rewrite-text':
    // A tag rename may change its node's kind (`div` → `Card`); a rewrite
    // states the node's new text, which may parse as another node.
    case 'rename-tag':
    case 'rewrite-node':
    case 'wrap-nodes':
    case 'append-body':
    case 'insert-frontmatter':
      return false;
    default: {
      const exhaustive: never = tag;
      return exhaustive;
    }
  }
}

// The anchor path for an unmapped intent; for a set-attribute, the path of the
// base tag whose attributes the splice edits — a value, a whole attribute, or
// a new one after the last (step 6) — which, unmapped, must be the anchor's
// own node. A tag's attribute region runs from its `<` through its last
// attribute; nested tags' regions never overlap, so the owner is unique.
function targetPath(effect: Committed): readonly number[] {
  const operation = effect.intent.operation;
  const anchorPath = effect.intent.anchor.path;
  if (operation.tag !== 'set-attribute') {
    return anchorPath;
  }
  const before = effect.base.projection;
  assert(before.tag === 'valid', 'A set-attribute applied to a parsing file');
  const [splice] = effect.plan.splices;
  assert(splice !== undefined, 'A set-attribute plan has a splice');
  const bytes = effect.base.bytes;
  const owners = before.nodes.filter((node) => {
    if (node.kind !== 'element' && node.kind !== 'component' && node.kind !== 'raw') {
      return false;
    }
    const end = node.attributes.reduce((last, attribute) => Math.max(last, attribute.span.end), tagNameEnd(bytes, node));
    return node.span.start < splice.range.start && splice.range.end <= end;
  });
  const [owner] = owners;
  assert(owners.length === 1, 'The splice edits the attributes of exactly one base tag');
  assert(owner !== undefined, 'The splice edits the attributes of a base tag');
  if (effect.intent.authoredChecksum === effect.base.checksum) {
    const unmoved = owner.path.length === anchorPath.length;
    assert(unmoved, 'Invariant 6: an unmapped intent edits its own node');
    assert(
      owner.path.every((step, index) => step === anchorPath[index]),
      'Invariant 6: an unmapped intent edits its own node',
    );
  }
  return owner.path;
}

export function checkGeneration(previous: number, next: number): void {
  assert(next >= previous, 'Invariant 7: a snapshot never goes back to an older generation');
}

export function checkBounds(actors: Iterable<ActorState>, parses: number): void {
  assert(parses <= LIMITS.parseTasksInFlightMax, 'Invariant 8: parses per step are bounded');
  for (const actor of actors) {
    assert(actor.queue.length <= LIMITS.intentsPendingMax, 'Invariant 8: the queue is bounded');
    const retained = (actor.snapshot === undefined ? 0 : 1) + (actor.phase.tag === 'idle' ? 0 : 1);
    assert(retained <= LIMITS.snapshotsRetainedMax, 'Invariant 8: retained snapshots are bounded');
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length === right.length) {
    return left.every((byte, index) => byte === right[index]);
  }
  return false;
}
