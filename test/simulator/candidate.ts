// The candidate snapshot of a plan (plan §5.2 step 6), with the step-4 latency
// experiment wired in: a single value splice takes its projection from the
// current one (shared/engine/projectionPatch.ts) instead of a full reparse, and here,
// in the simulator, the full reparse still runs beside it as the brute-force
// reference (plan §10). A patched projection that differs from the reparse by
// one byte fails the run at the event.
import assert from 'node:assert/strict';
import type { FilePath } from '#dist/shared/core/brand.js';
import type { Projector } from '#dist/shared/engine/documentActor.js';
import type { Plan } from '#dist/shared/engine/planner.js';
import { projectValueSplice } from '#dist/shared/engine/projectionPatch.js';
import { createSnapshot, type Snapshot } from '#dist/shared/page/snapshot.js';
import type { ByteString } from '#dist/shared/core/span.js';
import { projectBytes, sha256, snapshotOf } from './project.ts';

export interface PatchCounts {
  /** Candidates whose projection was patched and matched the reparse. */
  readonly patched: number;
  /** Candidates the patch refused, which were reparsed. */
  readonly reparsed: number;
}

// A report counter, the one piece of module state: the entry points read it to
// show the reference compared something, and no simulation decision reads it.
const counts = { patched: 0, reparsed: 0 };

export function patchCounts(): PatchCounts {
  return { ...counts };
}

export function candidateSnapshot(path: FilePath, base: Snapshot, plan: Plan, bytes: ByteString): Snapshot {
  assert.ok(base.path === path, 'The candidate is of the base file');
  const [splice, ...others] = plan.splices;
  if (splice === undefined || others.length > 0) {
    counts.reparsed++;
    return snapshotOf(path, bytes);
  }
  const patched = projectValueSplice(base.projection, base.bytes, splice);
  if (patched === undefined) {
    counts.reparsed++;
    return snapshotOf(path, bytes);
  }
  const reference = projectBytes(path, bytes);
  assert.deepStrictEqual(patched, reference, 'The patched projection is the reparsed one');
  counts.patched++;
  return createSnapshot({ path, bytes, projection: patched }, sha256);
}

/** The actor's parser and hash in the simulator: the real parser, and every
 * patched candidate checked against a full reparse. */
export const SIMULATOR_PROJECTOR: Projector = {
  hash: sha256,
  snapshot: snapshotOf,
  candidate: candidateSnapshot,
};
