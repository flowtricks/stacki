// The pure rules of comment pins (docs/contracts.md, "Comment pins"): making, changing and numbering pins on a
// board, the bounds on their images, how each pin stands once sent (read from the chat's transcript alone), what
// a "Send all" carries, where a pin is drawn and what its crop takes in. Nothing here reads the DOM, the clock or a
// store: the callers pass what they know, so every rule is tested on values.
import { assert } from '../../../../shared/core/assert';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import {
  PIN_LIMITS,
  pinImageNote,
  pinNumberOfTitle,
  type PinBrief,
  type PinBriefEntry,
  type PinSendMode,
  type SentPin,
} from '../../../../shared/properties/ai/commentPinBrief';
import {
  boardImageIds,
  type CommentPin,
  type PinAnchor,
  type PinBoard,
  type PinEdit,
  type PinId,
  type PinImageId,
  type PinImageRef,
  type PinPlace,
  type PinPoint,
} from '../../../../shared/properties/ai/commentPins';
import type { TurnId } from '../../../../shared/properties/ai/chatModel';
import type { PromptAttachment } from '../../../../shared/ipc/aiChat';
import type { ChatView } from '../chatReducer';
import { deriveSubagentWork, type SubagentStatus, type SubagentWork } from '../subagents';

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The number a new pin takes: one past the highest on the board, or 1 on an empty board. */
export function nextPinNumber(board: PinBoard): number {
  const highest = board.pins.reduce((most, pin) => Math.max(most, pin.number), 0);
  const next = highest + 1;
  assert(next >= 1, 'nextPinNumber: numbers start at one');
  return next;
}

export type AddOutcome = { readonly kind: 'added'; readonly board: PinBoard; readonly pin: CommentPin } | { readonly kind: 'full' };

/** The board with a new draft pin at `anchor`; `full` when the board already holds `pinsMax` pins or numbers ran out. */
export function addPin(board: PinBoard, input: { readonly id: PinId; readonly anchor: PinAnchor; readonly place: PinPlace; readonly at: number }): AddOutcome {
  const number = nextPinNumber(board);
  if (board.pins.length >= PIN_LIMITS.pinsMax || number > PIN_LIMITS.numberMax) {
    return { kind: 'full' };
  }
  assert(!board.pins.some((pin) => pin.id === input.id), 'addPin: a new pin has a new id');
  const pin: CommentPin = {
    id: input.id,
    number,
    createdAt: input.at,
    updatedAt: input.at,
    comment: '',
    images: [],
    savedAt: undefined,
    edit: { comment: '', images: [] },
    anchor: input.anchor,
    place: input.place,
    included: true,
    delivery: { kind: 'draft' },
  };
  const next = { ...board, pins: [...board.pins, pin] };
  assert(next.pins.length <= PIN_LIMITS.pinsMax, 'addPin: the board is bounded');
  return { kind: 'added', board: next, pin };
}

/** The board with `change` applied to pin `id` (its `updatedAt` moved to `at`); unchanged when there is no such pin. */
export function changePin(board: PinBoard, id: PinId, at: number, change: (pin: CommentPin) => CommentPin): PinBoard {
  let found = false;
  const pins = board.pins.map((pin) => {
    if (pin.id !== id) {
      return pin;
    }
    found = true;
    const changed = change(pin);
    assert(changed.id === pin.id, 'changePin: a pin keeps its id');
    assert(changed.number === pin.number, 'changePin: a pin keeps its number');
    return { ...changed, updatedAt: Math.max(at, pin.createdAt) };
  });
  return found ? { ...board, pins } : board;
}

/** The board without pin `id`. */
export function removePin(board: PinBoard, id: PinId): PinBoard {
  const pins = board.pins.filter((pin) => pin.id !== id);
  assert(pins.length >= board.pins.length - 1, 'removePin: at most one pin goes');
  return { ...board, pins };
}

/** What the pin's box shows: its unsaved changes when it has some, else what was saved. */
export function workingCopy(pin: Pick<CommentPin, 'comment' | 'images' | 'edit'>): PinEdit {
  return pin.edit ?? { comment: pin.comment, images: pin.images };
}

/**
 * Whether words or images hold something the person made: the crop is taken by Stacki and taken again on a new
 * pin, so a crop alone is not content (it neither enables Save nor asks before it goes).
 */
export function hasPersonContent(edit: Pick<PinEdit, 'comment' | 'images'>): boolean {
  return edit.comment.trim() !== '' || edit.images.some((image) => image.kind === 'added');
}

/** Whether deleting the pin loses something the person made, saved or not. */
export function hasContentToLose(pin: Pick<CommentPin, 'comment' | 'images' | 'edit'>): boolean {
  return hasPersonContent(pin) || (pin.edit !== undefined && hasPersonContent(pin.edit));
}

/** Whether the box holds changes that differ from what was saved. */
export function hasUnsavedChanges(pin: Pick<CommentPin, 'comment' | 'images' | 'edit'>): boolean {
  const edit = pin.edit;
  if (edit === undefined) {
    return false;
  }
  return edit.comment !== pin.comment || edit.images.map((image) => image.id).join() !== pin.images.map((image) => image.id).join();
}

/** The pin with its box saved: the working words and images become the pin's own, and "Send all" takes them. */
export function savePinEdit(pin: CommentPin, at: number): CommentPin {
  const edit = workingCopy(pin);
  assert(hasPersonContent(edit), 'savePinEdit: a pin is saved with words or an added image');
  const saved = { ...pin, comment: edit.comment, images: edit.images, savedAt: Math.max(at, pin.createdAt), edit: undefined };
  assert(saved.edit === undefined, 'savePinEdit: nothing is left unsaved');
  return saved;
}

/** The pin without its unsaved changes: what was saved stays. */
export function discardPinEdit(pin: CommentPin): CommentPin {
  assert(pin.savedAt !== undefined, 'discardPinEdit: only a saved pin keeps itself without its box');
  return { ...pin, edit: undefined };
}

/** How closing a pin's box ends: kept as it is, saved, discarded, or the pin removed. */
export type CloseOutcome = 'unchanged' | 'save' | 'discard' | 'remove';

/**
 * What closing the box does. `discard` (its close button, Escape): a pin never saved goes, a saved one loses only
 * its unsaved changes. `keep` (a press elsewhere, another pin, leaving the mode or the page): content is saved,
 * and an empty box leaves a pin never saved out and a saved pin as it was saved.
 */
export function closeOutcome(pin: Pick<CommentPin, 'comment' | 'images' | 'edit' | 'savedAt' | 'delivery'>, how: 'keep' | 'discard'): CloseOutcome {
  if (pin.delivery.kind === 'sent') {
    return 'unchanged'; // A sent pin's box is read-only.
  }
  if (pin.savedAt === undefined) {
    return how === 'keep' && hasPersonContent(workingCopy(pin)) ? 'save' : 'remove';
  }
  if (!hasUnsavedChanges(pin)) {
    return pin.edit === undefined ? 'unchanged' : 'discard';
  }
  return how === 'keep' && hasPersonContent(workingCopy(pin)) ? 'save' : 'discard';
}

/** The pin stuck to another element: its words, images and number stay; the crop is taken again by the caller. */
export function movePinAnchor(pin: CommentPin, target: { readonly anchor: PinAnchor; readonly place: PinPlace }): CommentPin {
  assert(pin.delivery.kind === 'draft', 'movePinAnchor: a sent pin stays where it was sent from');
  return { ...pin, anchor: target.anchor, place: target.place };
}

/** A sent pin back to a draft (Reopen): its words and images stay, and "Send all" takes it again. */
export function reopenPin(pin: CommentPin): CommentPin {
  return { ...pin, delivery: { kind: 'draft' }, included: true };
}

export type ImageOutcome =
  | { readonly kind: 'added'; readonly pin: CommentPin; readonly added: readonly PinImageRef[] }
  /** Some or none fitted: `pin` holds those that did, `reason` says which bound stopped the rest. */
  | { readonly kind: 'limited'; readonly pin: CommentPin; readonly added: readonly PinImageRef[]; readonly reason: 'count' | 'size' };

/**
 * The pin with `images` added to its box (its unsaved working copy) in order, as many as fit `imagesPerPinMax` and, with `boardChars` (the base64
 * characters the board's images already hold), `boardImageCharsMax`. A crop replaces the pin's earlier crop.
 */
export function addPinImages(
  pin: CommentPin,
  images: readonly (PinImageRef & { readonly chars: number })[],
  boardChars: number,
  sizeOf: (id: PinImageId) => number,
): ImageOutcome {
  assert(boardChars >= 0, 'addPinImages: the board holds a nonnegative weight');
  const working = workingCopy(pin);
  const withImages = (images: readonly PinImageRef[]): CommentPin => ({ ...pin, edit: { comment: working.comment, images } });
  let kept = [...working.images];
  let chars = boardChars;
  const added: PinImageRef[] = [];
  for (const image of images) {
    if (image.kind === 'crop') {
      // The new crop takes the old one's place, first in the list, and its weight off the board.
      const old = kept.find((entry) => entry.kind === 'crop');
      if (old !== undefined) {
        chars -= sizeOf(old.id);
        kept = kept.filter((entry) => entry !== old);
      }
    }
    if (kept.length >= PIN_LIMITS.imagesPerPinMax) {
      return { kind: 'limited', pin: withImages(kept), added, reason: 'count' };
    }
    if (chars + image.chars > PIN_LIMITS.boardImageCharsMax) {
      return { kind: 'limited', pin: withImages(kept), added, reason: 'size' };
    }
    const ref: PinImageRef = { id: image.id, kind: image.kind, name: image.name, mimeType: image.mimeType };
    kept = image.kind === 'crop' ? [ref, ...kept] : [...kept, ref];
    added.push(ref);
    chars += image.chars;
  }
  assert(kept.length <= PIN_LIMITS.imagesPerPinMax, 'addPinImages: a pin’s images are bounded');
  return { kind: 'added', pin: withImages(kept), added };
}

/** Image ids held in memory that the board no longer names: dropped from memory with the save that drops them. */
export function unusedImages(board: PinBoard, held: Iterable<PinImageId>): readonly PinImageId[] {
  const named = boardImageIds(board);
  return [...held].filter((id) => !named.has(id));
}

// ---------------------------------------------------------------------------
// How a sent pin stands
// ---------------------------------------------------------------------------

/** Why a pin needs the person: a question waits (a permission), its work failed, it was stopped, or its run was held. */
export type AttentionReason = 'permission' | 'failed' | 'stopped' | 'paused';

export type PinProgress =
  | { readonly kind: 'draft' }
  /** Waiting for its wave (subagents) or its turn (one pin per message). */
  | { readonly kind: 'queued' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done' }
  | { readonly kind: 'attention'; readonly reason: AttentionReason }
  /** Sent, but its chat's transcript is not open in this window, so how it stands is not known here. */
  | { readonly kind: 'sent' };

export type PinProgressKind = PinProgress['kind'];

const WORK_CACHE = new WeakMap<ChatView, SubagentWork>();

// Reading every subagent of a chat is a pass over its transcript; one pass per view serves every pin of the send.
function workOf(view: ChatView): SubagentWork {
  const cached = WORK_CACHE.get(view);
  if (cached !== undefined) {
    return cached;
  }
  const work = deriveSubagentWork(view);
  WORK_CACHE.set(view, work);
  return work;
}

/**
 * How a pin stands. A draft is a draft. A sent pin is read from its chat's transcript (`view`, undefined when not
 * open here): in a `subagents` send, from the subagent whose title starts "Pin <number>", or from the turn while
 * none does (queued while other pins' subagents are running, working before any is); in a `single` send, from its
 * own turn. `paused` says a `single` run was held after a turn that did not end well, so a pin still waiting for
 * its turn needs the person.
 */
export function pinProgress(pin: Pick<CommentPin, 'number' | 'delivery'>, view: ChatView | undefined, paused: 'paused' | 'running'): PinProgress {
  const delivery = pin.delivery;
  if (delivery.kind === 'draft') {
    return { kind: 'draft' };
  }
  const turn = delivery.turn;
  if (turn === undefined) {
    return paused === 'paused' ? { kind: 'attention', reason: 'paused' } : { kind: 'queued' };
  }
  if (view === undefined || !view.items.some((item) => item.kind === 'user' && item.turn === turn)) {
    return { kind: 'sent' };
  }
  const ended = turnEnd(view, turn);
  if (delivery.mode === 'subagents') {
    const status = pinSubagentStatus(workOf(view), turn, pin.number);
    if (status !== undefined) {
      return progressOfSubagent(status);
    }
    if (ended === undefined) {
      const others = [...workOf(view).units.values()].some((unit) => unit.agent.turn === turn && pinNumberOfTitle(unit.agent.title) !== undefined);
      return others ? { kind: 'queued' } : { kind: 'working' };
    }
  } else if (ended === undefined) {
    return waitingInTurn(view, turn) ? { kind: 'attention', reason: 'permission' } : { kind: 'working' };
  }
  assert(ended !== undefined, 'pinProgress: a turn still running was answered above');
  return progressOfEnd(ended);
}

/**
 * Whether a sent pin's work is confirmed finished well, so the pin can be deleted: it reads done, and, for a subagent
 * pin, its turn has not ended any other way (a subagent sent to the background reads done once its turn is over,
 * whatever became of it; a turn that ended well vouches for it). Nothing else is finished: a draft, a pin not yet
 * sent, a chat not open here, a pin at work, waiting, failed or stopped.
 */
export function pinFinished(pin: Pick<CommentPin, 'number' | 'delivery'>, view: ChatView | undefined): boolean {
  const delivery = pin.delivery;
  if (delivery.kind !== 'sent' || delivery.turn === undefined || view === undefined) {
    return false;
  }
  if (pinProgress(pin, view, 'running').kind !== 'done') {
    return false;
  }
  const ended = turnEnd(view, delivery.turn);
  assert(delivery.mode === 'subagents' || ended === 'end_turn', 'pinFinished: a pin of its own turn is done only when that turn ended well');
  return ended === undefined || ended === 'end_turn';
}

/** The newest subagent of `turn` titled for pin `number`, as it stands. */
export function pinSubagentStatus(work: SubagentWork, turn: TurnId, number: number): SubagentStatus | undefined {
  let found: SubagentStatus | undefined;
  for (const unit of work.units.values()) {
    if (unit.agent.kind === 'agent' && unit.agent.turn === turn && pinNumberOfTitle(unit.agent.title) === number) {
      found = unit.agent.status;
    }
  }
  return found;
}

/** The call of the newest subagent of `turn` titled for pin `number`, to open its transcript. */
export function pinSubagentCall(view: ChatView, turn: TurnId, number: number): string | undefined {
  let call: string | undefined;
  for (const unit of workOf(view).units.values()) {
    if (unit.agent.kind === 'agent' && unit.agent.turn === turn && pinNumberOfTitle(unit.agent.title) === number) {
      call = unit.agent.call;
    }
  }
  return call;
}

function progressOfSubagent(status: SubagentStatus): PinProgress {
  switch (status.kind) {
    case 'queued':
      return { kind: 'queued' };
    case 'running':
      return { kind: 'working' };
    case 'waiting':
      return { kind: 'attention', reason: 'permission' };
    case 'done':
      return { kind: 'done' };
    case 'failed':
      return { kind: 'attention', reason: 'failed' };
    case 'stopped':
      return { kind: 'attention', reason: 'stopped' };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function progressOfEnd(stop: TurnEnd): PinProgress {
  if (stop === 'end_turn') {
    return { kind: 'done' };
  }
  return stop === 'cancelled' ? { kind: 'attention', reason: 'stopped' } : { kind: 'attention', reason: 'failed' };
}

type TurnEnd = Extract<ChatView['items'][number], { readonly kind: 'turn-end' }>['stop'];

/** How `turn` ended, or undefined while it runs. */
export function turnEnd(view: ChatView, turn: TurnId): TurnEnd | undefined {
  for (let index = view.items.length - 1; index >= 0; index -= 1) {
    const item = view.items[index];
    if (item?.kind === 'turn-end' && item.turn === turn) {
      return item.stop;
    }
  }
  return undefined;
}

function waitingInTurn(view: ChatView, turn: TurnId): boolean {
  return view.items.some((item) => item.kind === 'permission' && item.turn === turn && item.answer === undefined);
}

// ---------------------------------------------------------------------------
// What "Send all" carries
// ---------------------------------------------------------------------------

/** The pins "Send all" takes: saved drafts that are included, in number order. Unsaved changes are never sent. */
export function pinsToSend(board: PinBoard): readonly CommentPin[] {
  return board.pins
    .filter((pin) => pin.delivery.kind === 'draft' && pin.included && pin.savedAt !== undefined)
    .sort((left, right) => left.number - right.number);
}

export type SendRefusal = 'none' | 'too-many-pins' | 'too-many-images';

/** Why the pins cannot go in one message, or undefined when they can: a message holds `pinsPerSendMax` pins and `attachmentsMax` images. */
export function sendRefusal(pins: readonly Pick<CommentPin, 'images'>[], mode: PinSendMode): SendRefusal | undefined {
  if (pins.length === 0) {
    return 'none';
  }
  if (mode === 'single') {
    return undefined; // One message per pin: each pin's images are within `imagesPerPinMax`.
  }
  if (pins.length > PIN_LIMITS.pinsPerSendMax) {
    return 'too-many-pins';
  }
  const images = pins.reduce((sum, pin) => sum + pin.images.length, 0);
  return images > AI_LIMITS.attachmentsMax ? 'too-many-images' : undefined;
}

export interface PinMessage {
  /** The plain fallback the transcript keeps as the message's text: what Copy, export and the chat's title read. */
  readonly text: string;
  readonly attachments: readonly PromptAttachment[];
  readonly brief: PinBrief;
}

/**
 * One message for `pins`: each pin's images become the message's attachments, in pin order, each with a note
 * naming its pin; the brief names every pin's images by their place among them. `text` is the person's own
 * words, numbered, so a reader of the plain text sees what was asked. Images whose bytes are not held are
 * left out.
 */
export function pinMessage(
  pins: readonly CommentPin[],
  mode: PinSendMode,
  imageData: (id: PinImageId) => string | undefined,
  summary: (pins: readonly CommentPin[]) => string,
): PinMessage {
  assert(pins.length >= 1, 'pinMessage: a message has a pin');
  assert(mode === 'subagents' || pins.length === 1, 'pinMessage: a single send carries one pin');
  const attachments: PromptAttachment[] = [];
  const entries: PinBriefEntry[] = [];
  for (const pin of pins) {
    const indexes: number[] = [];
    let position = 0;
    for (const image of pin.images) {
      const data = imageData(image.id);
      if (data !== undefined && attachments.length < AI_LIMITS.attachmentsMax) {
        position += 1;
        indexes.push(attachments.length);
        attachments.push({
          kind: 'image',
          name: image.name,
          mimeType: image.mimeType,
          data,
          note: pinImageNote({ number: pin.number, breakpointPx: pin.place.breakpointPx }, { position, kind: image.kind }),
        });
      }
    }
    entries.push(briefEntry(pin, indexes));
  }
  assert(entries.length === pins.length, 'pinMessage: one entry per pin');
  return { text: summary(pins), attachments, brief: { mode, pins: entries } };
}

function briefEntry(pin: CommentPin, images: readonly number[]): PinBriefEntry {
  return {
    number: pin.number,
    comment: pin.comment,
    pageLabel: pin.place.pageLabel,
    page: pin.place.page,
    elementLabel: pin.place.elementLabel,
    file: pin.place.file,
    locator: pin.place.locator,
    tag: pin.anchor.tag,
    text: pin.anchor.text,
    componentFile: pin.place.componentFile,
    breakpointPx: pin.place.breakpointPx,
    images,
  };
}

/** The first line of a comment, cut for a list row or a message's plain text. */
export function commentLine(comment: string, charsMax: number): string {
  assert(charsMax >= 2, 'commentLine: room for a character and an ellipsis');
  const line = comment.trim().split('\n')[0] ?? '';
  return line.length > charsMax ? `${line.slice(0, charsMax - 1).trimEnd()}…` : line;
}

/** The sent pins of a message, by number: what PinsMessage draws. */
export function sentPinsByNumber(pins: readonly SentPin[]): ReadonlyMap<number, SentPin> {
  return new Map(pins.map((pin) => [pin.number, pin]));
}

// ---------------------------------------------------------------------------
// Where pins are drawn, and what a crop takes in
// ---------------------------------------------------------------------------

/** A box on the canvas, in the page's CSS pixels (as the canvas measures it). */
export interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where in its box a click landed, 0 to 1 across and down; the middle when the box has no size. */
export function pointInBox(box: CanvasBox, click: { readonly x: number; readonly y: number }): PinPoint {
  const across = box.w > 0 ? (click.x - box.x) / box.w : 0.5;
  const down = box.h > 0 ? (click.y - box.y) / box.h : 0.5;
  const point = { x: clampUnit(across), y: clampUnit(down) };
  assert(point.x >= 0, 'pointInBox: inside the box across');
  assert(point.y <= 1, 'pointInBox: inside the box down');
  return point;
}

/** The pin's point on the overlay layer (already scaled by the canvas zoom). */
export function markerPosition(box: CanvasBox, at: PinPoint, scale: number): { readonly left: number; readonly top: number } {
  assert(scale > 0, 'markerPosition: the canvas scale is positive');
  return { left: (box.x + at.x * Math.max(0, box.w)) * scale, top: (box.y + at.y * Math.max(0, box.h)) * scale };
}

/** A region of the window, in its CSS pixels. */
export interface WindowBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The bounds of a crop: room around a small element, and no more than a screenful of a large one. */
export const CROP_LIMITS = {
  /** Space kept around the element, in window pixels. */
  paddingPx: 24,
  /** The smallest crop, so a tiny element is seen in its surroundings. */
  widthPxMin: 240,
  heightPxMin: 160,
  /** The largest crop: a large section is cropped around the pin's point. */
  widthPxMax: 960,
  heightPxMax: 640,
} as const satisfies Record<string, number>;

/**
 * The part of the window a pin's crop photographs: the element's box (canvas pixels, drawn at `scale` from
 * `origin`, the canvas's top-left corner in the window) with padding, at least the minimum size, at most the
 * maximum (then centred on the pin's point), and inside `clip`, the canvas's visible part. Undefined when none
 * of it is visible.
 */
export function cropRect(input: {
  readonly box: CanvasBox;
  readonly at: PinPoint;
  readonly scale: number;
  readonly origin: { readonly x: number; readonly y: number };
  readonly clip: WindowBox;
}): WindowBox | undefined {
  const { box, at, scale, origin, clip } = input;
  assert(scale > 0, 'cropRect: the canvas scale is positive');
  const left = origin.x + box.x * scale - CROP_LIMITS.paddingPx;
  const top = origin.y + box.y * scale - CROP_LIMITS.paddingPx;
  const pointX = origin.x + (box.x + at.x * box.w) * scale;
  const pointY = origin.y + (box.y + at.y * box.h) * scale;
  const span = (start: number, size: number, point: number, sizeMin: number, sizeMax: number): { readonly start: number; readonly size: number } => {
    if (size < sizeMin) {
      return { start: start - (sizeMin - size) / 2, size: sizeMin };
    }
    if (size > sizeMax) {
      return { start: point - sizeMax / 2, size: sizeMax };
    }
    return { start, size };
  };
  // A crop that would hang over the canvas's edge slides back inside it (when it fits) before it is cut to it.
  const inside = (range: { readonly start: number; readonly size: number }, edge: number, room: number): { readonly start: number; readonly size: number } => ({
    start: range.size >= room ? edge : Math.min(Math.max(range.start, edge), edge + room - range.size),
    size: Math.min(range.size, room),
  });
  const wide = span(left, box.w * scale + CROP_LIMITS.paddingPx * 2, pointX, CROP_LIMITS.widthPxMin, CROP_LIMITS.widthPxMax);
  const tall = span(top, box.h * scale + CROP_LIMITS.paddingPx * 2, pointY, CROP_LIMITS.heightPxMin, CROP_LIMITS.heightPxMax);
  const overlaps = (range: { readonly start: number; readonly size: number }, edge: number, room: number): boolean =>
    range.start < edge + room && range.start + range.size > edge;
  if (!overlaps(wide, clip.x, clip.width) || !overlaps(tall, clip.y, clip.height)) {
    return undefined; // None of it is on the canvas's visible part.
  }
  const across = inside(wide, clip.x, clip.width);
  const down = inside(tall, clip.y, clip.height);
  const x = Math.max(clip.x, Math.floor(across.start));
  const y = Math.max(clip.y, Math.floor(down.start));
  const right = Math.min(clip.x + clip.width, Math.ceil(across.start + across.size));
  const bottom = Math.min(clip.y + clip.height, Math.ceil(down.start + down.size));
  if (right - x < 1) {
    return undefined;
  }
  if (bottom - y < 1) {
    return undefined;
  }
  return { x, y, width: right - x, height: bottom - y };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Finding a pin's element again
// ---------------------------------------------------------------------------

/** What the canvas shows now, as far as a pin's anchor needs it. */
export interface CanvasNow {
  /** The page the canvas renders, relative to the project. */
  readonly page: string | undefined;
  /** The component file open on the canvas, relative to the project; undefined on the page itself. */
  readonly scope: string | undefined;
  /** The paths the canvas rendered; undefined until it has reported. */
  readonly rendered: ReadonlySet<string> | undefined;
  /** Whether a canvas path is the open file's own markup, so its element can be checked against the open file. */
  readonly owns: (path: string) => boolean;
  /** The open file's element at a canvas path, as tag and own words; undefined where there is none. */
  readonly elementAt: (path: string) => { readonly tag: string; readonly text: string | undefined } | undefined;
  /** The canvas paths of the open file's elements with this tag and these words, in document order (bounded by the caller). */
  readonly find: (tag: string, text: string | undefined) => readonly string[];
}

export type AnchorState =
  /** Another page, or another open component: the pin is not on this canvas. */
  | { readonly kind: 'elsewhere' }
  /** On this canvas at `path` (its stored path, or the one its element moved to). */
  | { readonly kind: 'attached'; readonly path: string; readonly moved: boolean }
  /** Its element is gone from this canvas: the pin keeps its words and images and waits to be moved. */
  | { readonly kind: 'detached' };

/**
 * Where a pin's element is on the canvas now. The stored path wins while the element there still has the pin's
 * tag (and its words, when both have some). Otherwise the open file is searched for the one rendered element with
 * that tag and those words; a single match is the element moved. With no single match, the same tag still at the
 * stored path is the element with its words edited; anything else is a detached pin. A path of another file's
 * markup (`<file>|…` the open file does not own) cannot be checked, so it holds while it is rendered.
 */
export function resolveAnchor(pin: Pick<CommentPin, 'anchor' | 'place'>, canvas: CanvasNow): AnchorState {
  if (canvas.page !== pin.place.page || canvas.scope !== pin.place.scope) {
    return { kind: 'elsewhere' };
  }
  const { path, tag, text } = pin.anchor;
  const rendered = canvas.rendered;
  if (rendered === undefined) {
    return { kind: 'attached', path, moved: false }; // The canvas has not reported yet: the pin waits where it was.
  }
  if (!canvas.owns(path)) {
    return rendered.has(path) ? { kind: 'attached', path, moved: false } : { kind: 'detached' };
  }
  const here = canvas.elementAt(path);
  if (here !== undefined && rendered.has(path) && sameElement(here, tag, text)) {
    return { kind: 'attached', path, moved: false };
  }
  const candidates = canvas.find(tag, text).filter((candidate) => rendered.has(candidate));
  if (candidates.length === 1) {
    const found = candidates[0];
    assert(found !== undefined, 'resolveAnchor: one candidate is there');
    return { kind: 'attached', path: found, moved: found !== path };
  }
  // No other element has its words: the same tag still at its path is the element, its words edited in place.
  if (here !== undefined && rendered.has(path) && here.tag === tag) {
    return { kind: 'attached', path, moved: false };
  }
  return { kind: 'detached' };
}

function sameElement(here: { readonly tag: string; readonly text: string | undefined }, tag: string, text: string | undefined): boolean {
  if (here.tag !== tag) {
    return false;
  }
  if (text === undefined || here.text === undefined) {
    return true; // Words on one side only: an edit added or removed them, the tag still says it is the element.
  }
  return normalizedWords(here.text) === normalizedWords(text);
}

/** Words as a pin compares them: spaces folded, cut to the bound a pin keeps. */
export function normalizedWords(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, PIN_LIMITS.textCharsMax);
}
