// Oracle steps as engine values: the intent a client would submit for a step,
// authored against a snapshot of the step's input file, and the splices the
// oracle expects. Shared by the oracle suite and the simulator.
import { assert } from '#dist/shared/core/assert.js';
import type { IntentId } from '#dist/shared/core/brand.js';
import { toIntent, type Intent } from '#dist/shared/engine/intent.js';
import { isNodeKind, toAnchorRef, toChildIndex, type AnchorRef } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import { encodeUtf8, toByteSpan, utf8ByteLength, type ByteSpan } from '#dist/shared/core/span.js';
import type { OracleStep } from './oracles.ts';
import type { Splice } from '#dist/shared/engine/planner.js';

export function oracleSpans(step: OracleStep): readonly ByteSpan[] {
  return step.splices.map((splice) => toByteSpan(splice.start, splice.start + utf8ByteLength(splice.expected)));
}

export function oracleSplices(step: OracleStep): readonly Splice[] {
  const spans = oracleSpans(step);
  return step.splices.map((splice, index) => {
    const range = spans[index];
    assert(range !== undefined, 'Every oracle splice has a span');
    return {
      range,
      expectedBytes: encodeUtf8(splice.expected),
      replacementBytes: encodeUtf8(splice.replacement),
    };
  });
}

/** The node anchor at `path` in the snapshot, as a client would author it. */
export function anchorAt(snapshot: Snapshot, path: readonly number[]): AnchorRef {
  const projection = snapshot.projection;
  assert(projection.tag === 'valid', 'Oracle anchors come from a parsing file');
  const node = projection.nodes.find((candidate) => candidate.path.length === path.length && candidate.path.every((step, index) => step === path[index]));
  assert(node !== undefined, `Oracle path ${JSON.stringify(path)} exists in the input`);
  return toAnchorRef({ span: node.span, path: path.map(toChildIndex), expectedKind: node.kind });
}

export function oracleIntent(step: OracleStep, snapshot: Snapshot, id: IntentId): Intent {
  const kind = step.anchor.kind;
  let anchor: AnchorRef;
  if (isNodeKind(kind)) {
    anchor = anchorAt(snapshot, step.anchor.path);
    assert(anchor.expectedKind === kind, 'The oracle anchor names the kind found there');
  } else if (kind === 'frontmatter') {
    const projection = snapshot.projection;
    assert(projection.tag === 'valid', 'A frontmatter anchor comes from a parsing file');
    assert(projection.frontmatter !== undefined, 'The oracle file has frontmatter');
    anchor = toAnchorRef({ span: projection.frontmatter, path: [], expectedKind: kind });
  } else {
    const whole = toByteSpan(0, snapshot.bytes.length);
    anchor = toAnchorRef({ span: whole, path: [], expectedKind: kind });
  }
  const operation = step.operation({
    spans: oracleSpans(step),
    anchorAt: (path) => anchorAt(snapshot, path),
  });
  return toIntent({
    id,
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    anchor,
    operation,
  });
}
