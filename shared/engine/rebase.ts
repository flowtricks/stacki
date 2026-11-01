// Rebasing an intent through the actor's own recent commits (plan §4, §7:
// staleness the app caused itself). The renderer authors every edit against the
// page it shows — the last bytes it read or was sent back — and keeps authoring
// against them while earlier edits are still reaching the disk. Those earlier
// edits are this actor's own commits, and the host logged exactly what each
// one spliced, so a span of the authored bytes has an exact image in the bytes
// on disk now: no diff runs and nothing is guessed. A move also records the
// before/after spans of an unchanged subtree, so it and its descendants follow
// that relocation. Other spans a commit cut through have no image and are refused.
//
// The images, through one commit's splices (ascending, disjoint):
//   a splice wholly after the span, or a zero-width one at its end: unchanged;
//   a splice wholly before it, or a zero-width one at its start: moved by the
//     splice's size change (an insertion before a node pushes the node on);
//   a splice inside it: the span grows or shrinks by the size change (a
//     value edited inside an element leaves the same element);
//   any other overlap: no image.
//
// Rebased, an intent names the current bytes: its anchor's path is found again
// there by span and kind, and it plans on the fast path. The planner still
// checks every witness against the current bytes, so a rebased set-attribute
// replaces whatever the actor's own previous commit left there — the user's
// latest word on that attribute.
import { assert } from '../core/assert';
import { toIntent, type Intent, type Operation, type RejectionReason } from './intent';
import { LIMITS } from '../core/limits';
import type { ByteRelocation, Splice } from './planner';
import { isNodeKind, toAnchorRef, type AnchorRef } from '../page/ref';
import { err, ok, type Result } from '../core/result';
import type { Snapshot } from '../page/snapshot';
import { toByteSpan, toByteString, type ByteSpan } from '../core/span';
import { orderedSplices } from './splice';

/** One commit an actor made: the bytes it started from, the bytes it left,
 * and the splices between them. */
export interface CommitRecord {
  readonly from: Snapshot['checksum'];
  readonly to: Snapshot['checksum'];
  readonly splices: readonly Splice[];
  readonly relocation?: ByteRelocation | undefined;
}

/** The commits leading from `authored` to `current`, oldest first, when the
 * log holds an unbroken chain; undefined otherwise. */
export function commitChain(log: readonly CommitRecord[], authored: Snapshot['checksum'], current: Snapshot['checksum']): readonly CommitRecord[] | undefined {
  assert(log.length <= LIMITS.commitLogEntriesMax, 'The commit log is inside its bound');
  const chain: CommitRecord[] = [];
  let at = authored;
  // Each pass follows one record, and a record is followed at most once.
  for (let pass = 0; pass <= log.length; pass++) {
    if (at === current) {
      return chain;
    }
    const next = log.find((record) => record.from === at && !chain.includes(record));
    if (next === undefined) {
      return undefined;
    }
    chain.push(next);
    at = next.to;
  }
  return undefined;
}

/** The same edit as the fewest bytes: each splice without the prefix and
 * suffix its witness and replacement share, so a commit that rewrote a region
 * with much of it unchanged is the region it really changed, and an edit
 * authored before it still rebases through it. The result writes the same
 * bytes. */
export function minimalSplices(splices: readonly Splice[]): readonly Splice[] {
  return orderedSplices(splices).map((splice) => {
    const expected = splice.expectedBytes;
    const replacement = splice.replacementBytes;
    let prefix = 0;
    const shorter = Math.min(expected.length, replacement.length);
    while (prefix < shorter && expected[prefix] === replacement[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (suffix < shorter - prefix && expected[expected.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) {
      suffix++;
    }
    const start = splice.range.start + prefix;
    return {
      range: toByteSpan(start, splice.range.end - suffix),
      expectedBytes: toByteString(expected.subarray(prefix, expected.length - suffix)),
      replacementBytes: toByteString(replacement.subarray(prefix, replacement.length - suffix)),
    };
  });
}

/** The image of `span` after `splices`, or undefined when one cuts through it. */
export function rebaseSpan(span: ByteSpan, splices: readonly Splice[]): ByteSpan | undefined {
  let start: number = span.start;
  let end: number = span.end;
  // Splices ascend; every size change before a position moves it. Positions
  // are read in the original coordinates and adjusted by what came before.
  let startShift = 0;
  let endShift = 0;
  for (const splice of orderedSplices(splices)) {
    const delta = splice.replacementBytes.length - (splice.range.end - splice.range.start);
    const first = splice.range.start;
    const last = splice.range.end;
    if (last <= span.start) {
      if (first < span.start || first === last) {
        startShift += delta; // Wholly before, or an insertion at the start.
        endShift += delta;
        continue;
      }
    }
    if (span.end <= first) {
      continue; // Wholly after, or an insertion at the end.
    }
    if (span.start <= first && last <= span.end) {
      endShift += delta; // Inside: the span holds the change.
      continue;
    }
    return undefined;
  }
  start += startShift;
  end += endShift;
  assert(start <= end, 'An image keeps its order');
  return toByteSpan(start, end);
}

/** `intent`, authored against the first commit's `from`, restated against
 * `current`, the last commit's `to`. */
export function rebaseIntent(intent: Intent, chain: readonly CommitRecord[], current: Snapshot): Result<Intent, RejectionReason> {
  assert(chain.length > 0, 'A rebase follows at least one commit');
  assert(chain[chain.length - 1]?.to === current.checksum, 'The chain ends at the current bytes');
  const through = (span: ByteSpan): ByteSpan | undefined =>
    chain.reduce<ByteSpan | undefined>((image, record) => (image === undefined ? undefined : rebaseCommittedSpan(image, record, rebaseSpan)), span);
  const untouched = (span: ByteSpan): ByteSpan | undefined =>
    chain.reduce<ByteSpan | undefined>((image, record) => (image === undefined ? undefined : rebaseCommittedSpan(image, record, shiftUntouched)), span);
  const anchor = rebaseAnchor(intent.anchor, through, current);
  if (!anchor.ok) {
    return anchor;
  }
  const operation = rebaseOperation(intent.operation, { through, untouched }, current);
  if (!operation.ok) {
    return operation;
  }
  return ok(
    toIntent({
      id: intent.id,
      file: intent.file,
      authoredChecksum: current.checksum,
      anchor: anchor.value,
      operation: operation.value,
    }),
  );
}

type Through = (span: ByteSpan) => ByteSpan | undefined;

// A move records the exact subtree it relocated. Descendants share its byte
// shift; ancestors and unrelated nodes still follow the ordinary splices.
function rebaseCommittedSpan(
  span: ByteSpan,
  record: CommitRecord,
  map: (span: ByteSpan, splices: readonly Splice[]) => ByteSpan | undefined,
): ByteSpan | undefined {
  const relocation = record.relocation;
  if (relocation !== undefined) {
    const { source, target } = relocation;
    assert(source.start < source.end, 'A relocation has a non-empty source');
    assert(source.end - source.start === target.end - target.start, 'A relocation preserves its bytes and length');
    // An empty hunk at an edge could belong outside the relocated subtree.
    if (span.start === span.end) {
      if (span.start === source.start) {
        return undefined;
      }
      if (span.end === source.end) {
        return undefined;
      }
    }
    if (source.start <= span.start) {
      if (span.end <= source.end) {
        const shift = target.start - source.start;
        return toByteSpan(span.start + shift, span.end + shift);
      }
    }
  }
  return map(span, record.splices);
}

/** Images through the chain: `through` lets a span hold a change made inside
 * it (a value edited inside an element leaves the same element); `untouched`
 * gives an image only to a span no commit changed or touched. */
interface Images {
  readonly through: Through;
  readonly untouched: Through;
}

/** The image of `span` after `splices` that changed none of its bytes and
 * none at its edges; undefined when one did. A code patch's hunk replaces the
 * bytes it was authored against: a commit inside it changed those bytes, and
 * one at its edge cannot be ordered against it (shared/engine/codePatch.ts). */
export function shiftUntouched(span: ByteSpan, splices: readonly Splice[]): ByteSpan | undefined {
  for (const splice of splices) {
    if (splice.range.start <= span.end) {
      if (span.start <= splice.range.end) {
        return undefined;
      }
    }
  }
  const image = rebaseSpan(span, splices);
  assert(image !== undefined, 'A span no splice touches has an image');
  assert(image.end - image.start === span.end - span.start, 'An untouched span keeps its length');
  return image;
}

function rebaseAnchor(anchor: AnchorRef, through: Through, current: Snapshot): Result<AnchorRef, RejectionReason> {
  if (anchor.expectedKind === 'document') {
    return ok(
      toAnchorRef({
        span: toByteSpan(0, current.bytes.length),
        path: [],
        expectedKind: 'document',
      }),
    );
  }
  const span = through(anchor.span);
  if (span === undefined) {
    return err('anchor-moved');
  }
  const projection = current.projection;
  if (projection.tag === 'parse-error') {
    return err('source-invalid');
  }
  if (anchor.expectedKind === 'frontmatter') {
    const block = projection.frontmatter;
    if (block === undefined) {
      return err('anchor-moved');
    }
    if (block.start === span.start && block.end === span.end) {
      return ok(toAnchorRef({ span, path: [], expectedKind: 'frontmatter' }));
    }
    return err('anchor-moved');
  }
  assert(isNodeKind(anchor.expectedKind), 'The remaining anchors name nodes');
  // Found again by its image and its kind: a span and a kind name one node,
  // except a node and a same-kind first descendant covering the same bytes,
  // which is refused rather than chosen.
  const found = projection.nodes.filter((node) => node.kind === anchor.expectedKind && node.span.start === span.start && node.span.end === span.end);
  const [node] = found;
  if (node === undefined) {
    return err('anchor-moved');
  }
  if (found.length > 1) {
    return err('anchor-ambiguous');
  }
  return ok(toAnchorRef({ span, path: node.path, expectedKind: node.kind }));
}

function rebaseOperation(operation: Operation, images: Images, current: Snapshot): Result<Operation, RejectionReason> {
  const { through } = images;
  switch (operation.tag) {
    case 'set-attribute':
    case 'remove-attribute':
    case 'insert-node':
    case 'remove-node':
    case 'set-inline-style':
    case 'rename-tag':
    case 'rename-attribute':
    case 'append-body':
    case 'insert-frontmatter':
      return ok(operation);
    case 'rewrite-text':
      // A program's rewrite names the exact bytes it read: never rebased.
      return err('region-externally-modified');
    case 'move-node': {
      const destination = rebaseAnchor(operation.destination, through, current);
      return destination.ok ? ok({ ...operation, destination: destination.value }) : destination;
    }
    case 'wrap-nodes': {
      const last = rebaseAnchor(operation.last, through, current);
      return last.ok ? ok({ ...operation, last: last.value }) : last;
    }
    case 'rename-binding': {
      const sites = rebaseSpans(operation.sites, through);
      return sites === undefined ? err('anchor-moved') : ok({ ...operation, sites });
    }
    case 'edit-frontmatter-slot': {
      const slot = through(operation.slot);
      return slot === undefined ? err('region-externally-modified') : ok({ ...operation, slot });
    }
    case 'apply-code-patch':
    case 'revert-splices':
    case 'rewrite-node': {
      // A code patch replaces only the bytes it was written against: a commit
      // inside a hunk or at its edge is a merge conflict, never overwritten
      // (step 8). A node rewrite states the node's whole new text, so any
      // commit that touched its hunks is the node changed under it (step 9).
      // Reverts keep step 6's images.
      const spans = rebaseSpans(
        operation.hunks.map((hunk) => hunk.span),
        operation.tag === 'revert-splices' ? through : images.untouched,
      );
      if (spans === undefined) {
        return err(operation.tag === 'apply-code-patch' ? 'merge-conflict' : 'region-externally-modified');
      }
      const hunks = operation.hunks.map((hunk, index) => {
        const span = spans[index];
        assert(span !== undefined, 'Every hunk has an image');
        return { span, text: hunk.text };
      });
      return ok({ ...operation, hunks });
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function rebaseSpans(spans: readonly ByteSpan[], through: Through): readonly ByteSpan[] | undefined {
  const images: ByteSpan[] = [];
  for (const span of spans) {
    const image = through(span);
    if (image === undefined) {
      return undefined;
    }
    images.push(image);
  }
  return images;
}
