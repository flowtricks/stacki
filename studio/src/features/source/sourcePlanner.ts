import { createHash } from 'node:crypto';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { toDigest, toFilePath, toIntentId } from '../../../vendor/stacki/shared/core/brand';
import { toByteString } from '../../../vendor/stacki/shared/core/span';
import { toIntent, type Operation } from '../../../vendor/stacki/shared/engine/intent';
import { planIntent } from '../../../vendor/stacki/shared/engine/planner';
import { parsePageResult } from '../../../vendor/stacki/shared/page/pageNode';
import { toAnchorRef } from '../../../vendor/stacki/shared/page/ref';
import { createSnapshot } from '../../../vendor/stacki/shared/page/snapshot';
import { projectPage } from '../../../vendor/stacki/shared/page/sourceProjection';
import { parsePage } from '../../../vendor/stacki/electron/parse/astroParser';
import type { ParserNode } from '../../../vendor/stacki/electron/parse/astroParserTypes';
import type { Edit } from './source';

// Use Desktop's source-preserving planner so moves, copies and removals share
// one whitespace policy. Studio applies its splices through the shared document.
export function sourcePlanner(source: string) {
  const bytes = Buffer.from(source);
  const projection = projectPage(source, parsePageResult(parsePage(source, { locs: true })));
  if (projection.tag !== 'valid') {
    throw new Error('Fix the source before editing its structure.');
  }
  const snapshot = createSnapshot({ path: toFilePath('/studio/source.astro'), bytes: toByteString(bytes), projection }, (value) =>
    toDigest(createHash('sha256').update(value).digest('hex')),
  );
  const anchor = (node: ParserNode) => {
    assert(node.start !== undefined, 'A structural target has a source start');
    assert(node.end !== undefined, 'A structural target has a source end');
    const start = Buffer.byteLength(source.slice(0, node.start));
    const end = Buffer.byteLength(source.slice(0, node.end));
    const projected = projection.nodes.find((item) => item.span.start === start && item.span.end === end && item.kind === node.kind);
    if (!projected) {
      throw new Error('Selection changed. Select the element again.');
    }
    return toAnchorRef({
      span: projected.span,
      path: projected.path,
      expectedKind: projected.kind,
    });
  };
  const plan = (node: ParserNode, operation: Operation): Edit[] => {
    const result = planIntent(
      { authored: snapshot, current: snapshot },
      toIntent({
        id: toIntentId('studio-structure'),
        file: snapshot.path,
        authoredChecksum: snapshot.checksum,
        anchor: anchor(node),
        operation,
      }),
    );
    if (!result.ok) {
      throw new Error(`Cannot edit this structure safely: ${result.error}`);
    }
    return result.value.splices.map((splice) => ({
      start: bytes.subarray(0, splice.range.start).toString('utf8').length,
      end: bytes.subarray(0, splice.range.end).toString('utf8').length,
      text: Buffer.from(splice.replacementBytes).toString('utf8'),
    }));
  };
  return { anchor, plan };
}
