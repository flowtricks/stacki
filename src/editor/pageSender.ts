// Sending one queue entry of the open page (src/editor/pageEdits.ts) and showing how
// it ended (plan §7, §11.9). The page saver (src/editor/pagePersistence.ts) decides
// when and in what order; this decides what each entry becomes on the wire,
// what a reply means for the page state, and what a refusal shows.
//
// After each applied write the page's origin — the bytes later requests are
// stated against — is the reply, its parse keyed by the session's handles:
// carried from the origin through the write's own splices, and, for the nodes
// a gesture created, from that gesture's own prediction (src/editor/nodeHandles.ts).
// When nothing more is queued, the page shows the reply itself: clean, and
// every node the user was looking at under the handle it had.
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { Digest } from '../../shared/core/brand';
import type { EditBatchRequest, EditRequest } from '../../shared/engine/editRequest';
import { describeRejection, type RejectionReason } from '../../shared/engine/intent';
import type { PageDiskRead, PageEditError, PageEdited } from '../../shared/ipc/pageSave';
import type { Result } from '../../shared/core/result';
import { carriedParse, toEditorPageState, type EditablePageState, type EditorPageState } from './pageState';
import { sendCode } from './codeEdits';
import { carryHandles, seedOf } from './nodeHandles';
import { recordWrite, recordNoChange, sendGesture, type EditDrafts, type EditGesture, type EditsRecord, type PageOrigin, type QueueEntry } from './pageEdits';
import type { EntrySent } from './pagePersistence';
import { saveStateBase, saveStateFailed, saveStateNeedsWrite, saveStateRefused, saveStateStarted, type SaveState } from './saveState';

export interface SenderDeps {
  readonly queue: EditDrafts;
  /** The open page's state now (a ref: installs are seen at once). */
  readonly state: () => EditorPageState | undefined;
  /** Change the open page's state; the change sees the latest one. */
  readonly update: (path: string, change: (current: EditorPageState) => EditorPageState) => void;
  /** The file refused a write: show the conflict notice with its reason. */
  readonly conflict: (reason: RejectionReason | undefined) => void;
  /** An edit failed to apply: report the error and retain earlier successful writes. */
  readonly notice: (message: string) => void;
  /** Prompt the canvas after a discrete edit is confirmed on disk. HMR can
   * arrive later; the canvas serializes overlapping patch requests. */
  readonly onAppliedUrgentEdit?: () => void;
  readonly edit: (request: EditRequest) => Promise<Result<PageEdited, PageEditError>>;
  /** Several requests of one gesture, written at once. */
  readonly editBatch: (request: EditBatchRequest) => Promise<Result<PageEdited, PageEditError>>;
  readonly read: (path: string) => Promise<PageDiskRead>;
}

export function createEntrySender(deps: SenderDeps): (path: string, entry: QueueEntry) => Promise<EntrySent> {
  return async (path, entry) => {
    const state = deps.state();
    assert(state !== undefined, 'An entry is sent for an open page');
    deps.update(path, (current) => withSave(current, started(current.save)));
    switch (entry.tag) {
      case 'gesture':
        return sendGestureEntry(deps, path, entry);
      case 'code':
        return sendCodeEntry(deps, path, entry);
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  };
}

// --- Gestures ----------------------------------------------------------------------

async function sendGestureEntry(deps: SenderDeps, path: string, entry: Extract<QueueEntry, { tag: 'gesture' }>): Promise<EntrySent> {
  const state = deps.state();
  assert(state?.editable === true, 'A gesture is sent for an editable page');
  const origin = state.origin;
  if (origin === undefined) {
    // Typed code made the page parse and its save has not replied: nothing
    // names a node yet. The gesture waits, unsent, for the next save.
    deps.update(path, (current) => withSave(current, failed(current.save, 'The page’s text is not saved yet.')));
    return { tag: 'failed', error: new Error('The page’s text is not saved yet.') };
  }
  const sent = await sendGesture({
    path,
    origin,
    gesture: entry.gesture,
    record: entry.record,
    send: deps.edit,
    sendBatch: deps.editBatch,
  });
  switch (sent.tag) {
    case 'applied':
      settle(deps, path, advanced(origin, sent.replies, entry.gesture));
      if (entry.gesture.urgency === true && sent.replies.length > 0) {
        deps.onAppliedUrgentEdit?.();
      }
      return { tag: 'sent' };
    case 'refused': {
      const now = advanced(origin, sent.replies, entry.gesture);
      if (sent.diskChecksum === now.checksum) {
        // Nothing changed on disk: the gesture itself has no form the engine
        // can plan here. It is taken back, and the page says why (plan §6: a
        // fallback is visible, never silent) — never saved some other way.
        withdraw(deps, path, now, entry.record, sent.reason);
        return { tag: 'sent' };
      }
      advance(deps, path, now);
      refuse(deps, path, sent.reason, now.checksum, sent.diskChecksum);
      return { tag: 'conflicted' };
    }
    case 'retry':
      deps.update(path, (current) => withSave(current, failed(current.save, sent.message)));
      return { tag: 'failed', error: new Error(sent.message) };
    case 'uncertain':
      return uncertain(deps, path, advanced(origin, sent.replies, entry.gesture), sent.message);
    default: {
      const exhaustive: never = sent;
      return exhaustive;
    }
  }
}

// The origin after the gesture's applied replies: each parse keyed by carrying
// the previous one's handles through that reply's own splices, and the nodes
// the gesture created by its own prediction.
function advanced(origin: PageOrigin, replies: readonly PageEdited[], gesture: EditGesture): PageOrigin {
  const predicted = gesture.apply(origin.model);
  return replies.reduce<PageOrigin>((before, reply) => {
    assert(reply.editable, 'A visual edit leaves a page that parses');
    const after = { source: reply.source, seed: seedOf(reply.checksum), model: reply.model };
    const model = carryHandles({ before, after, own: reply.inverse, predicted });
    return { checksum: reply.checksum, source: reply.source, model };
  }, origin);
}

// A write should not be sent again when it may have landed: sending an
// insertion twice inserts twice. The disk says: untouched, send again later;
// changed, the page asks the user.
async function uncertain(deps: SenderDeps, path: string, origin: PageOrigin, message: string): Promise<EntrySent> {
  advance(deps, path, origin);
  let disk: Digest;
  try {
    disk = (await deps.read(path)).checksum;
  } catch {
    deps.update(path, (current) => withSave(current, failed(current.save, message)));
    return { tag: 'failed', error: new Error(message) };
  }
  if (disk === origin.checksum) {
    deps.update(path, (current) => withSave(current, failed(current.save, message)));
    return { tag: 'failed', error: new Error(message) };
  }
  refuse(deps, path, 'write-race', origin.checksum, disk);
  return { tag: 'conflicted' };
}

// --- Previewing gestures ----------------------------------------------------------

/** All queued gestures planned without writing, or the error preventing a
 * complete review. An incomplete version must never replace the user's draft. */
export type GesturesPreviewed = { readonly tag: 'previewed'; readonly origin: PageOrigin } | { readonly tag: 'failed'; readonly message: string };

/** The page's unsaved gestures as the bytes they would write (plan §7: the
 * reviewed version of a conflicted page), each planned by main against the
 * bytes the one before left (`preview`, page:previewEdit) and keyed as a save
 * would key it. The text is the origin's bytes spliced — never a reprint. */
export async function previewGestures(input: {
  readonly path: string;
  readonly origin: PageOrigin;
  readonly gestures: readonly EditGesture[];
  readonly preview: (request: EditRequest, source: string) => Promise<Result<PageEdited, PageEditError>>;
}): Promise<GesturesPreviewed> {
  assert(input.gestures.length <= LIMITS.intentsPendingMax, 'The queue stays inside its bound');
  let origin = input.origin; // The bytes the next request is stated against.
  for (const gesture of input.gestures) {
    let source = origin.source; // A gesture's later requests name its earlier replies.
    const send = async (request: EditRequest): Promise<Result<PageEdited, PageEditError>> => {
      const answer = await input.preview(request, source);
      if (answer.ok) {
        source = answer.value.source;
      }
      return answer;
    };
    // A preview has no undo step: a dropped record takes no answers.
    const record: EditsRecord = { outcome: { tag: 'dropped' } };
    const sent = await sendGesture({ path: input.path, origin, gesture, record, send });
    switch (sent.tag) {
      case 'applied':
        origin = advanced(origin, sent.replies, gesture);
        continue;
      case 'refused':
        return { tag: 'failed', message: describeRejection(sent.reason) };
      case 'retry':
      case 'uncertain':
        return { tag: 'failed', message: sent.message };
      default: {
        const exhaustive: never = sent;
        return exhaustive;
      }
    }
  }
  return { tag: 'previewed', origin };
}

// --- Typed code ----------------------------------------------------------------------

async function sendCodeEntry(deps: SenderDeps, path: string, entry: Extract<QueueEntry, { tag: 'code' }>): Promise<EntrySent> {
  const state = deps.state();
  assert(state !== undefined, 'Typed code belongs to an open page');
  const sent = await sendCode({
    path,
    text: state.source,
    baseline: entry.baseline,
    base: saveStateBase(state.save),
    stateBase: saveStateBase(state.save),
    store: deps.queue,
    send: deps.edit,
    read: deps.read,
  });
  switch (sent.tag) {
    case 'applied': {
      const { last, inverse } = sent;
      if (inverse === undefined) {
        for (const record of entry.records) {
          record.outcome = { tag: 'dropped' }; // The text was the disk's: nothing written.
        }
      } else {
        recordWrite(entry.records, { checksum: last.checksum, inverse });
      }
      settleRead(deps, path, last);
      return { tag: 'sent' };
    }
    case 'refused':
      refuse(deps, path, sent.reason, sent.baseChecksum, sent.diskChecksum);
      return { tag: 'conflicted' };
    case 'failed':
      deps.update(path, (current) => withSave(current, failed(current.save, sent.message)));
      return { tag: 'failed', error: new Error(sent.message) };
    default: {
      const exhaustive: never = sent;
      return exhaustive;
    }
  }
}

// --- Installing outcomes ------------------------------------------------------------

// A gesture applied: the page is the reply when nothing more is owed; else the
// shown model keeps the newer edits and only the origin moves on.
function settle(deps: SenderDeps, path: string, origin: PageOrigin): void {
  deps.update(path, (current) => {
    if (!current.editable) {
      return current;
    }
    if (deps.queue.empty(path)) {
      const read = { editable: true as const, model: origin.model, source: origin.source };
      return toEditorPageState({ ...read, checksum: origin.checksum });
    }
    return movedOn(current, origin);
  });
}

// A code save applied: its reply, carried from the page shown by the diff
// (typed text keeps its handles), is the page when nothing more is owed.
function settleRead(deps: SenderDeps, path: string, read: PageDiskRead): void {
  deps.update(path, (current) => {
    const page = toEditorPageState(carriedParse(current, read));
    if (deps.queue.empty(path)) {
      return page;
    }
    if (current.editable && page.editable && page.origin !== undefined) {
      return movedOn(current, page.origin);
    }
    return withSave(current, { tag: 'dirty', baseChecksum: read.checksum });
  });
}

function movedOn(current: EditablePageState, origin: PageOrigin): EditorPageState {
  const dirty: SaveState = { tag: 'dirty', baseChecksum: origin.checksum };
  const save = current.save.tag === 'conflicted' ? current.save : dirty;
  return { ...current, origin, save };
}

function advance(deps: SenderDeps, path: string, origin: PageOrigin): void {
  deps.update(path, (current) => (current.editable ? { ...current, origin } : current));
}

function refuse(deps: SenderDeps, path: string, reason: RejectionReason | undefined, base: Digest, disk: Digest): void {
  deps.conflict(reason);
  deps.update(path, (current) => (current.save.tag === 'clean' ? current : withSave(current, saveStateRefused(current.save, base, disk))));
}

// A gesture the engine cannot plan, taken back: the shown model is the origin
// with the gestures still queued applied again. Earlier successful requests in
// this gesture keep their undo information; only the failed request is settled.
function withdraw(deps: SenderDeps, path: string, origin: PageOrigin, record: EditsRecord, reason: RejectionReason): void {
  recordNoChange(record);
  deps.notice(`Stacki couldn’t apply this edit. ${describeRejection(reason)}`);
  const queued = deps.queue.entries(path);
  const code = queued.some((entry) => entry.tag !== 'gesture');
  deps.update(path, (current) => {
    if (!current.editable || code) {
      return current.editable ? { ...current, origin } : current;
    }
    const model = queued.reduce((shown, entry) => (entry.tag === 'gesture' ? entry.gesture.apply(shown) : shown), origin.model);
    const save: SaveState = queued.length === 0 ? { tag: 'clean', checksum: origin.checksum } : { tag: 'dirty', baseChecksum: origin.checksum };
    return { ...current, model, parsedFrom: origin.source, source: origin.source, origin, save };
  });
}

function withSave(current: EditorPageState, save: SaveState): EditorPageState {
  return { ...current, save };
}

function started(save: SaveState): SaveState {
  return saveStateNeedsWrite(save) ? saveStateStarted(save) : save;
}

function failed(save: SaveState, message: string): SaveState {
  if (save.tag === 'clean' || save.tag === 'conflicted') {
    return save;
  }
  return saveStateFailed(save, message);
}
