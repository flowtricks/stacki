// A visual edit planned, not written (plan §7, §11.9): the page's unsaved
// gestures shown as text when the user reviews a conflicted page in code. The
// preview is the engine's own plan applied to bytes the renderer supplies — the
// bytes its gestures were stated against — so the text under review is exactly
// what the edits would have written: splices of the origin, never a reprint of
// the file (the no-whole-file-regeneration rule, eslint.config.mjs). Kept, that
// text is saved as a code patch of whatever the disk holds now (plan §3.6).
//
// Pure: no actor, no disk. The bytes stand for the file at `authoredChecksum`,
// and planning with nothing between authored and current is the planner's
// exact path.
import { assert } from '../../shared/core/assert';
import { toFilePath, toIntentId, type Digest } from '../../shared/core/brand';
import type { Edit } from '../../shared/engine/editRequest';
import { toIntent, type RejectionReason, type SourceEdit } from '../../shared/engine/intent';
import { planIntent } from '../../shared/engine/planner';
import { err, ok, type Result } from '../../shared/core/result';
import type { ByteString } from '../../shared/core/span';
import { applySplices, inverseEdits } from '../../shared/engine/splice';
import { candidateOf } from '../../shared/engine/documentActor';
import { rebaseIntent, type CommitRecord } from '../../shared/engine/rebase';
import type { Snapshot } from '../../shared/page/snapshot';
import { NODE_PROJECTOR } from './documentDisk';
import { buildEdit, buildEditIntent } from './editRequests';

export interface EditPreviewed {
  readonly bytes: ByteString;
  readonly checksum: Digest;
  /** What Undo would submit had it been written — kept so a preview reply has
   * the same shape as a write's. */
  readonly inverse: readonly SourceEdit[];
}

/** The bytes `edit` would leave, planned against `bytes` as the file at
 * `authoredChecksum`. A rejection is the planner's own, as `page:edit` would
 * have answered it over unchanged bytes. */
export function previewEdit(file: string, bytes: ByteString, authoredChecksum: Digest, edit: Edit): Result<EditPreviewed, RejectionReason> {
  const path = toFilePath(file);
  const snapshot = NODE_PROJECTOR.snapshot(path, bytes);
  // The renderer states each request against the reply before it, whose bytes
  // it sends: a mismatch is a broken caller, not an operating failure.
  assert(snapshot.checksum === authoredChecksum, 'A preview names the bytes it is sent');
  const draft = buildEditIntent(edit, snapshot);
  if (!draft.ok) {
    return err(draft.error);
  }
  const id = toIntentId('preview');
  const intent = toIntent({ id, file: path, authoredChecksum, ...draft.value });
  const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
  if (!planned.ok) {
    return err(planned.error);
  }
  const splices = planned.value.splices;
  const after = applySplices(snapshot.bytes, splices);
  const checksum = NODE_PROJECTOR.hash(after);
  const unchanged = checksum === authoredChecksum;
  assert(splices.length > 0 || unchanged, 'No splices leave the bytes as they were');
  return ok({ bytes: after, checksum, inverse: inverseEdits(splices) });
}

/** The bytes a batch of edits leaves, planned one after another in memory
 * against `bytes` as the file at `authoredChecksum`, so the batch can be
 * written once (page:editBatch). Two writes of one gesture let the dev server
 * render the page between them: a loop that reads `teamEntries` before the
 * declaration of `teamEntries` lands. Each edit is built and rebased exactly
 * as the actor would build and rebase it after the ones before it had been
 * committed, and its candidate is checked as a write would check it, so a
 * batch accepts nothing its edits would be refused alone. The first refusal
 * refuses the batch; nothing is written. */
export function previewEdits(
  file: string,
  bytes: ByteString,
  authoredChecksum: Digest,
  edits: readonly Edit[],
): Result<{ readonly bytes: ByteString; readonly checksum: Digest }, RejectionReason> {
  assert(edits.length > 0, 'A batch holds at least one edit');
  const path = toFilePath(file);
  const authored = NODE_PROJECTOR.snapshot(path, bytes);
  // The handler reads these bytes from the actor at that checksum.
  assert(authored.checksum === authoredChecksum, 'A batch names the bytes it is planned on');
  let current: Snapshot = authored;
  const chain: CommitRecord[] = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    assert(edit !== undefined, 'Batch index is in bounds');
    const built = buildEdit(edit, { authored, current, history: chain.length === 0 ? 'unchanged' : 'own-commits' });
    if (!built.ok) {
      return built;
    }
    const basis = built.value.basis === 'current' ? current : authored;
    const stated = toIntent({ id: toIntentId(`batch-${index}`), file: path, authoredChecksum: basis.checksum, ...built.value.draft });
    const intent = basis === current ? ok(stated) : rebaseIntent(stated, chain, current);
    if (!intent.ok) {
      return intent;
    }
    const planned = planIntent({ authored: current, current }, intent.value);
    if (!planned.ok) {
      return planned;
    }
    const candidate = candidateOf(path, current, planned.value, NODE_PROJECTOR);
    if (!candidate.ok) {
      return err(candidate.error.reason);
    }
    chain.push({ from: current.checksum, to: candidate.value.checksum, splices: planned.value.splices, relocation: planned.value.relocation });
    current = candidate.value;
  }
  assert(chain.length === edits.length, 'Every edit of a batch was planned');
  return ok({ bytes: current.bytes, checksum: current.checksum });
}
