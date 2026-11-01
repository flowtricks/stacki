// Goal: the type-level half of the editor-core contracts (plan §10: brand
// separation and exhaustiveness are tsc-checked files using @ts-expect-error).
// Method: each `@ts-expect-error` line below must fail to compile; if a change
// made it compile, tsc reports the directive as unused and the gate fails. The
// runtime test only keeps the file in the suite and asserts the helpers exist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toByteOffset, toIntentId, toUtf16Offset, type ByteOffset, type Digest, type IntentId } from '#dist/shared/core/brand.js';
import type { Capability } from '#dist/shared/page/capability.js';
import type { ByteDiff, DiffOutcome } from '#dist/shared/engine/diff.js';
import type { Outcome, RejectionReason, SubmissionResult } from '#dist/shared/engine/intent.js';
import type { SpanMapping } from '#dist/shared/engine/mapSpan.js';
import type { Plan, PlanningBase } from '#dist/shared/engine/planner.js';
import type { AnchorRef } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import type { Projection } from '#dist/shared/page/sourceProjection.js';
import { utf16ToByteOffsets, type ByteSpan, type Utf16Span } from '#dist/shared/core/span.js';

function byteOnly(offset: ByteOffset): ByteOffset {
  return offset;
}

function describe(outcome: Outcome): string {
  switch (outcome.tag) {
    case 'applied':
      return outcome.checksum;
    case 'rejected':
      return outcome.reason;
    case 'uncertain':
      return outcome.candidateChecksum ?? 'unknown';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// A mapping outcome has no default: adding a variant is a compile error here
// and in the planner, which must decide what the new outcome rejects with.
function mappingReason(mapping: SpanMapping): RejectionReason | undefined {
  switch (mapping.tag) {
    case 'resolved':
      return undefined;
    case 'ambiguous':
      return 'anchor-ambiguous';
    case 'gone':
      return 'anchor-moved';
    case 'too-costly':
      return 'resource-limit';
    default: {
      const exhaustive: never = mapping;
      return exhaustive;
    }
  }
}

export function mappingTypeChecks(mapping: SpanMapping, outcome: DiffOutcome, diff: ByteDiff, base: PlanningBase, plan: Plan): void {
  // @ts-expect-error Only a resolved mapping carries a span: no "best guess" on the others.
  void mapping.span;
  // @ts-expect-error A too-costly diff carries no partial diff to map through.
  void outcome.diff;
  // @ts-expect-error The frontiers stay private to the diff; callers read distances.
  void diff.forward;
  // @ts-expect-error A diff is immutable once computed.
  diff.distance = 0; // eslint-disable-line no-param-reassign -- The error expected here.
  // @ts-expect-error Planning needs the authored snapshot, not only the current one (plan §4).
  const currentOnly: PlanningBase = { current: base.current };
  // @ts-expect-error A plan's splices are read-only.
  plan.splices.length = 0; // eslint-disable-line no-param-reassign -- The error expected here.
  void currentOnly;
}

export function typeChecks(snapshot: Snapshot, projection: Projection, reason: RejectionReason): void {
  const utf16 = toUtf16Offset(3);
  // @ts-expect-error A UTF-16 offset is not a byte offset (plan §3.2).
  byteOnly(utf16);
  // @ts-expect-error A plain number is not a byte offset either.
  byteOnly(3);
  byteOnly(toByteOffset(3));
  // @ts-expect-error The one conversion takes UTF-16 offsets, never bytes.
  utf16ToByteOffsets('abc', [toByteOffset(1)]);
  const utf16Span: Utf16Span = { start: utf16, end: utf16 };
  // @ts-expect-error A UTF-16 span is not a byte span.
  const byteSpan: ByteSpan = utf16Span;
  // @ts-expect-error An intent id is not any string.
  const id: IntentId = 'i1';
  // @ts-expect-error A digest is built only by toDigest.
  const digest: Digest = 'a'.repeat(64);
  // @ts-expect-error A snapshot has no version field (plan §3.1).
  void snapshot.version;
  // @ts-expect-error Backpressure is a submission result, not an outcome (plan §3.5).
  const outcome: Outcome = { tag: 'backpressured' } satisfies SubmissionResult;
  // @ts-expect-error Diagnostics exist only on the parse-error variant.
  void projection.diagnostics;
  // @ts-expect-error `queue-full` is not a rejection reason: a full queue backpressures.
  const full: RejectionReason = 'queue-full';
  // @ts-expect-error Capabilities are a closed set.
  const writable: Capability = 'writable';
  const anchor: AnchorRef = {
    span: { start: toByteOffset(0), end: toByteOffset(0) },
    path: [],
    // @ts-expect-error An anchor's kind is a closed set too.
    expectedKind: 'widget',
  };
  void [byteSpan, id, digest, outcome, full, writable, anchor, reason];
}

test('type-level contracts compile only as intended', () => {
  assert.equal(typeof typeChecks, 'function');
  assert.equal(describe({ tag: 'rejected', intentId: toIntentId('i1'), reason: 'write-race' }), 'write-race');
  assert.equal(typeof mappingTypeChecks, 'function');
  assert.equal(mappingReason({ tag: 'ambiguous' }), 'anchor-ambiguous');
});
