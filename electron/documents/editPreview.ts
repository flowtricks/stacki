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
import { NODE_PROJECTOR } from './documentDisk';
import { buildEditIntent } from './editRequests';

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
