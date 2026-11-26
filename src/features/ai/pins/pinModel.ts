// The pure rules of comment pins (docs/contracts.md, "Comment pins"): making, changing and numbering pins on a
// board, the bounds on their images, how each pin stands once sent (read from the chat's transcript alone), which
// models a pin can run on, what
// a "Send all" carries, where a pin is drawn and what its crop takes in. Nothing here reads the DOM, the clock or a
// store: the callers pass what they know, so every rule is tested on values.
import { assert } from '../../../../shared/core/assert';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import {
  PIN_LIMITS,
  pinImageNote,
  isSubagentModel,
  pinNumberOfTitle,
  pinQuestionsOf,
  type PinBrief,
  type PinBriefEntry,
  type PinQuestion,
  type PinSendMode,
  type PinWords,
  type SentPin,
} from '../../../../shared/properties/ai/commentPinBrief';
import { isReferenceChip, plainTextOf, type ComposerSegments } from '../../../../shared/properties/ai/mentions';
import { pinSendMode } from '../../../../shared/properties/ai/agentPresentation';
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
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
import type { ChatOption, PermissionRequestId, TurnId } from '../../../../shared/properties/ai/chatModel';
import type { PromptAttachment } from '../../../../shared/ipc/aiChat';
import type { ChatView, TranscriptItem } from '../chatReducer';
import { deriveSubagentWork, sessionModelName, type SubagentStatus, type SubagentWork } from '../subagents';

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
export function workingCopy(pin: Pick<CommentPin, 'comment' | 'segments' | 'images' | 'edit'>): PinEdit {
  return pin.edit ?? { ...wordsOf(pin), images: pin.images };
}

/** The words and chips of a pin or its box, and nothing else of it. */
export function wordsOf({ comment, segments }: PinWords): PinWords {
  return segments === undefined ? { comment } : { comment, segments };
}

/** A box's words as the chat's composer holds them: its chips, or the text alone. */
export function segmentsOfWords({ comment, segments }: PinWords): ComposerSegments {
  return segments ?? (comment === '' ? [] : [{ kind: 'text', text: comment }]);
}

/**
 * What the box's editor holds as a pin keeps it, within `commentCharsMax` characters of plain text: past the bound
 * the end is dropped (text is cut; a chip goes whole, as half a reference would name something else).
 */
export function pinWordsOf(segments: ComposerSegments): PinWords {
  let kept = segments;
  // Each round shortens the last segment or drops it, so there are at most two rounds a segment.
  for (let round = 0; round <= segments.length * 2 && plainTextOf(kept).length > PIN_LIMITS.commentCharsMax; round += 1) {
    const last = kept[kept.length - 1];
    assert(last !== undefined, 'pinWordsOf: words over the bound have a segment');
    const over = plainTextOf(kept).length - PIN_LIMITS.commentCharsMax;
    const cut = last.kind === 'text' && last.text.length > over ? [{ kind: 'text' as const, text: last.text.slice(0, last.text.length - over) }] : [];
    kept = [...kept.slice(0, -1), ...cut];
  }
  const comment = plainTextOf(kept);
  assert(comment.length <= PIN_LIMITS.commentCharsMax, 'pinWordsOf: within the bound');
  return kept.some((segment) => segment.kind === 'chip') ? { comment, segments: kept } : { comment };
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
  const before = { ...pin };
  delete before.segments; // The box's words replace the saved ones whole: chips it no longer has go with them.
  const saved = { ...before, ...wordsOf(edit), images: edit.images, savedAt: Math.max(at, pin.createdAt), edit: undefined };
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
  const withImages = (images: readonly PinImageRef[]): CommentPin => ({ ...pin, edit: { ...wordsOf(working), images } });
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

/** Why a pin did not get done: its work failed, it was stopped, or the run ended before it was started. */
export type UnfinishedReason = 'failed' | 'stopped' | 'not-started';

export type PinProgress =
  | { readonly kind: 'draft' }
  /** Not started: waiting for a place in its wave (subagents) or for its turn (one pin per message). */
  | { readonly kind: 'queued' }
  /** `end` `reply`: the agent runs in the background, so its end shows only when the whole reply ends. */
  | { readonly kind: 'working'; readonly end: 'own' | 'reply' }
  | { readonly kind: 'done' }
  /** Needs the person, and there is something to answer: a permission card in the chat, or the agent's question. */
  | { readonly kind: 'attention'; readonly reason: 'permission'; readonly request: PermissionRequestId }
  | { readonly kind: 'attention'; readonly reason: 'question'; readonly question: PinQuestion }
  /** Ended without being done. Nothing waits on the person: the pin can be reopened and sent again. */
  | { readonly kind: 'unfinished'; readonly reason: UnfinishedReason }
  /** Waiting in a one-pin-per-message run that is held; the pin list continues or ends it. */
  | { readonly kind: 'held' }
  /** Its agent was started and nothing says how it went (Codex's own subagents). */
  | { readonly kind: 'unreported' }
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
 * How a pin stands, read from its chat's transcript (`view`, undefined when not open here). `paused` says a
 * one-pin-per-message run was held after a reply that did not end well.
 *
 * In order: an open question about the pin; a permission card its work waits on; its subagent (the newest titled
 * "Pin <number>", in the send's reply or any later one, since a person can have the agent resume or restart a pin);
 * else the reply it is in: the send's, or the one that answered its question. "Needs you" is only ever one of the
 * first two, so there is always something to answer.
 */
export function pinProgress(pin: Pick<CommentPin, 'number' | 'delivery'>, view: ChatView | undefined, paused: 'paused' | 'running'): PinProgress {
  const delivery = pin.delivery;
  if (delivery.kind === 'draft') {
    return { kind: 'draft' };
  }
  const turn = delivery.turn;
  if (turn === undefined) {
    return paused === 'paused' ? { kind: 'held' } : { kind: 'queued' };
  }
  const span = view === undefined ? undefined : pinSpan(view, turn, pin.number);
  if (view === undefined || span === undefined) {
    return { kind: 'sent' };
  }
  const asked = pinQuestion(view, span, pin.number);
  if (asked.kind === 'open') {
    return { kind: 'attention', reason: 'question', question: asked.question };
  }
  const answer = asked.kind === 'answered' ? asked : undefined;
  const unit = pinUnit(view, span, pin.number);
  // After an answer, a subagent that has done nothing since says nothing about it: the answering reply does.
  const current = unit !== undefined && (answer === undefined || unit.lastIndex > answer.index) ? unit : undefined;
  const replyTurn = answer?.turn ?? turn;
  const request = waitingRequest(view, current === undefined ? { turn: replyTurn, mode: delivery.mode } : { call: current.call });
  if (request !== undefined) {
    return { kind: 'attention', reason: 'permission', request };
  }
  if (current !== undefined) {
    return progressOfSubagent(current.status);
  }
  const ended = turnEnd(view, replyTurn);
  // Other pins of this send have subagents and this one has none: it was never started.
  const unstarted = delivery.mode === 'subagents' && answer === undefined && hasPinUnits(view, span);
  if (ended === undefined) {
    return unstarted ? { kind: 'queued' } : { kind: 'working', end: 'own' };
  }
  return unstarted ? { kind: 'unfinished', reason: 'not-started' } : progressOfEnd(ended);
}

/** Whether a sent pin's work is confirmed finished well, so the pin can be deleted: it reads done, and nothing else does. */
export function pinFinished(pin: Pick<CommentPin, 'number' | 'delivery'>, view: ChatView | undefined): boolean {
  const delivery = pin.delivery;
  if (delivery.kind !== 'sent' || delivery.turn === undefined || view === undefined) {
    return false;
  }
  return pinProgress(pin, view, 'running').kind === 'done';
}

/** The call of the subagent working on pin `number` of the send in `turn`, to open its transcript. */
export function pinSubagentCall(view: ChatView, turn: TurnId, number: number): string | undefined {
  const span = pinSpan(view, turn, number);
  return span === undefined ? undefined : pinUnit(view, span, number)?.call;
}

/** The words that open the person's reply about a pin: they say which question the reply answers. */
export function pinReplyLead(pin: Pick<SentPin, 'comment' | 'elementLabel'>): string {
  const about = commentLine(pin.comment.trim() === '' ? pin.elementLabel : pin.comment, REPLY_LEAD_CHARS_MAX);
  assert(about !== '', 'pinReplyLead: a pin has words or an element name');
  return `“${about}”: `;
}

/** Characters of a pin's words a reply to its question quotes. */
const REPLY_LEAD_CHARS_MAX = 60;

// The part of a chat that is about one pin of one send: from that message to the next one that sends a pin with the
// same number (numbers start again once the board empties, and a reopened pin keeps its own).
interface PinSpan {
  readonly from: number;
  readonly to: number;
}

function sentPinsIn(item: TranscriptItem): readonly SentPin[] {
  if (item.kind !== 'user') {
    return [];
  }
  const part = item.parts?.find((candidate) => candidate.kind === 'pins');
  return part?.kind === 'pins' ? part.pins : [];
}

function pinSpan(view: ChatView, turn: TurnId, number: number): PinSpan | undefined {
  // A steering message shares its turn's id: the send is the turn's message that carries the pins, when one does.
  const withPin = view.items.findIndex((item) => item.kind === 'user' && item.turn === turn && sentPinsIn(item).some((pin) => pin.number === number));
  const from = withPin === -1 ? view.items.findIndex((item) => item.kind === 'user' && item.turn === turn) : withPin;
  if (from === -1) {
    return undefined;
  }
  const next = view.items.findIndex((item, index) => index > from && sentPinsIn(item).some((pin) => pin.number === number));
  const span = { from, to: next === -1 ? view.items.length : next };
  assert(span.from < span.to, 'pinSpan: a span holds its message');
  return span;
}

type AskedState =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly question: PinQuestion }
  | { readonly kind: 'answered'; readonly index: number; readonly turn: TurnId };

interface Asked {
  readonly index: number;
  readonly turn: TurnId;
  readonly question: PinQuestion;
}

// The questions the agent asked about pin `number`, in its own words and in its subagents' reports, in order.
function questionsAsked(view: ChatView, span: PinSpan, number: number): readonly Asked[] {
  const asked: Asked[] = [];
  const work = workOf(view);
  for (let index = span.from; index < span.to; index += 1) {
    const item = view.items[index];
    if (item?.kind !== 'text' && item?.kind !== 'tool') {
      continue;
    }
    // The agent's own words, or the report a subagent handed back.
    const said = item.kind === 'tool' ? work.units.get(item.call)?.agent.result : item.role === 'agent' && item.parent === undefined ? item.text : undefined;
    for (const question of pinQuestionsOf(said ?? '')) {
      if (question.number === number) {
        asked.push({ index, turn: item.turn, question });
      }
    }
  }
  return asked;
}

// The first message of the person after `from` that answers pin `number`: one that opens with another pin's reply
// words answers that pin only; any other message answers every question before it. A send of pins answers nothing.
function answerAfter(view: ChatView, from: number, number: number): { readonly index: number; readonly turn: TurnId } | undefined {
  const sent = view.items.flatMap(sentPinsIn);
  for (let index = from + 1; index < view.items.length; index += 1) {
    const item = view.items[index];
    if (item?.kind !== 'user' || sentPinsIn(item).length > 0) {
      continue;
    }
    const named = sent.filter((pin) => item.text.startsWith(pinReplyLead(pin)));
    if (named.length === 0 || named.some((pin) => pin.number === number)) {
      return { index, turn: item.turn };
    }
  }
  return undefined;
}

function pinQuestion(view: ChatView, span: PinSpan, number: number): AskedState {
  const asked = questionsAsked(view, span, number);
  const latest = asked[asked.length - 1];
  if (latest === undefined) {
    return { kind: 'none' };
  }
  const answer = answerAfter(view, latest.index, number);
  if (answer !== undefined) {
    return { kind: 'answered', ...answer };
  }
  // The same words again in the reply an answer was sent into (the agent's closing summary) repeat an answered question.
  for (const earlier of asked.slice(0, -1)) {
    const before = answerAfter(view, earlier.index, number);
    if (earlier.question.question === latest.question.question && before !== undefined && before.turn === latest.turn) {
      return { kind: 'answered', ...before };
    }
  }
  return { kind: 'open', question: latest.question };
}

interface PinUnit {
  readonly call: string;
  readonly status: SubagentStatus;
  /** The place in the transcript of the newest thing it did or was told. */
  readonly lastIndex: number;
}

// The newest subagent titled for pin `number` inside the pin's span, as it stands.
function pinUnit(view: ChatView, span: PinSpan, number: number): PinUnit | undefined {
  const work = workOf(view);
  let found: { readonly call: string; readonly status: SubagentStatus; readonly index: number } | undefined;
  for (let index = span.from; index < span.to; index += 1) {
    const item = view.items[index];
    const agent = item?.kind === 'tool' ? work.units.get(item.call)?.agent : undefined;
    if (agent !== undefined && agent.kind === 'agent' && pinNumberOfTitle(agent.title) === number) {
      found = { call: agent.call, status: agent.status, index };
    }
  }
  if (found === undefined) {
    return undefined;
  }
  let lastIndex = found.index;
  for (let index = view.items.length - 1; index > found.index; index -= 1) {
    const item = view.items[index];
    if ((item?.kind === 'tool' || item?.kind === 'text') && item.parent === found.call) {
      lastIndex = index;
      break;
    }
  }
  return { call: found.call, status: found.status, lastIndex };
}

function hasPinUnits(view: ChatView, span: PinSpan): boolean {
  const work = workOf(view);
  return view.items.slice(span.from, span.to).some((item) => {
    const agent = item.kind === 'tool' ? work.units.get(item.call)?.agent : undefined;
    return agent !== undefined && pinNumberOfTitle(agent.title) !== undefined;
  });
}

// The oldest permission card still waiting for the pin: its subagent's, or (with no subagent) the reply's own in a
// one-pin-per-message send. A card waits only while a reply runs.
function waitingRequest(
  view: ChatView,
  of: { readonly call: string } | { readonly turn: TurnId; readonly mode: PinSendMode },
): PermissionRequestId | undefined {
  if (view.running === undefined) {
    return undefined;
  }
  const unitOf = workOf(view).unitOf;
  for (const item of view.items) {
    if (item.kind !== 'permission' || item.answer !== undefined) {
      continue;
    }
    const mine = 'call' in of ? item.call === of.call || unitOf.get(item.call) === of.call : of.mode === 'single' && item.turn === of.turn;
    if (mine) {
      return item.request;
    }
  }
  return undefined;
}

function progressOfSubagent(status: SubagentStatus): PinProgress {
  switch (status.kind) {
    case 'queued':
      return { kind: 'working', end: 'own' };
    case 'running':
      return { kind: 'working', end: status.end };
    case 'waiting':
      // Its card was answered or is not this pin's: with nothing to answer, it is at work.
      return { kind: 'working', end: 'own' };
    case 'done':
      return { kind: 'done' };
    case 'failed':
      return { kind: 'unfinished', reason: 'failed' };
    case 'stopped':
      return { kind: 'unfinished', reason: 'stopped' };
    case 'unreported':
      return { kind: 'unreported' };
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
  return { kind: 'unfinished', reason: stop === 'cancelled' ? 'stopped' : 'failed' };
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

/** A model a pin can be sent with: a value and name of the agent's model option. */
export interface PinModelChoice {
  readonly value: string;
  readonly name: string;
}

/**
 * The models a pin of `agent` can run on, from the agent's model option as the panel lists it. A one-message send
 * runs each pin in a subagent, which takes only Claude's short model names; one message per pin switches the chat's
 * model for that message, so every model counts. Empty while the agent has not reported its models.
 */
export function pinModelChoices(mode: PinSendMode, options: readonly ChatOption[]): readonly PinModelChoice[] {
  const option = options.find((candidate) => candidate.id === 'model' || candidate.category === 'model');
  const choices = (option?.choices ?? []).filter((choice) => mode === 'single' || isSubagentModel(choice.value));
  return choices.map((choice) => ({ value: choice.value, name: choice.name }));
}

export type ResolvedPinModel =
  /** No model was chosen: the pin runs on the chat's. */
  | { readonly kind: 'chat' }
  | { readonly kind: 'chosen'; readonly model: PinModelChoice }
  /** The chosen model cannot be used where the pin is going: it runs on the chat's, and the person is told. */
  | { readonly kind: 'unavailable'; readonly name: string };

/** What a pin's choice means for a send to `agent`. With no list reported yet, the agent's own choice is trusted. */
export function resolvePinModel(pin: Pick<CommentPin, 'model'>, agent: AgentId, options: readonly ChatOption[]): ResolvedPinModel {
  const chosen = pin.model;
  if (chosen === undefined) {
    return { kind: 'chat' };
  }
  if (chosen.agent !== agent) {
    return { kind: 'unavailable', name: chosen.name };
  }
  const mode = pinSendMode(agent);
  const listed = pinModelChoices(mode, options);
  const known = options.some((option) => option.id === 'model' || option.category === 'model');
  const usable = known ? listed.some((choice) => choice.value === chosen.value) : mode === 'single' || isSubagentModel(chosen.value);
  return usable ? { kind: 'chosen', model: { value: chosen.value, name: chosen.name } } : { kind: 'unavailable', name: chosen.name };
}

/** The row value that leaves a pin following the chat's model: no model id is empty. */
export const PIN_FOLLOWS_CHAT = '';

export interface PinModelRows {
  /** One row per model: the value is the model's id, or `PIN_FOLLOWS_CHAT` on the chat's own model. */
  readonly rows: readonly { readonly value: string; readonly label: string }[];
  /** The row of the model the pin runs on. */
  readonly selected: string;
}

/**
 * The rows of a pin's model list, labelled with model names only. The chat's model is not listed a second time: its
 * own row is the one that follows the chat, so picking it makes the pin follow again. A pin that chose that same
 * model keeps its choice (the row then carries the model's id), so what is stored keeps its meaning. When the
 * chat's model is not one of the choices, or has no known name (`unnamed` then stands for it), it gets a row of its
 * own, first.
 */
export function pinModelRows({
  choices,
  options,
  resolved,
  unnamed,
}: {
  readonly choices: readonly PinModelChoice[];
  readonly options: readonly ChatOption[];
  readonly resolved: ResolvedPinModel;
  readonly unnamed: string;
}): PinModelRows {
  const option = options.find((candidate) => candidate.id === 'model' || candidate.category === 'model');
  const name = sessionModelName(options);
  // By id first. A chat on "Default" names the model it stands for, which is then found by that name.
  const own =
    choices.find((choice) => choice.value === option?.currentValue) ??
    choices.find((choice) => name !== undefined && choice.name.toLowerCase() === name.toLowerCase());
  const chosen = resolved.kind === 'chosen' ? resolved.model.value : undefined;
  const rows = choices.map((choice) => {
    if (choice !== own) {
      return { value: choice.value, label: choice.name };
    }
    // The "Default" entry's own name is no model's name.
    const label = choice.value === 'default' && name !== undefined ? name : choice.name;
    return { value: chosen === choice.value ? choice.value : PIN_FOLLOWS_CHAT, label };
  });
  const all = own === undefined ? [{ value: PIN_FOLLOWS_CHAT, label: name ?? unnamed }, ...rows] : rows;
  const selected = chosen ?? PIN_FOLLOWS_CHAT;
  assert(all.filter((row) => row.value === PIN_FOLLOWS_CHAT).length <= 1, 'pinModelRows: at most one row follows the chat');
  assert(choices.length === 0 || all.some((row) => row.value === selected), 'pinModelRows: the effective model is listed');
  return { rows: all, selected };
}

export interface PinMessage {
  /** The plain fallback the transcript keeps as the message's text: what Copy, export and the chat's title read. */
  readonly text: string;
  readonly attachments: readonly PromptAttachment[];
  readonly brief: PinBrief;
  /** Each pin's chips and words, for the check a send runs on mentions. */
  readonly drafts: readonly ComposerSegments[];
  /** The files, skills and instructions the pins mention, each after a line naming its pin; empty when there are none. */
  readonly mentions: ComposerSegments;
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
  modelOf: (pin: CommentPin) => PinModelChoice | undefined = () => undefined,
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
    const model = modelOf(pin);
    entries.push({ ...briefEntry(pin, indexes), ...(model === undefined ? {} : { model: model.value, modelName: model.name }) });
  }
  assert(entries.length === pins.length, 'pinMessage: one entry per pin');
  const mentions = pinExpandedMentions(pins, AI_LIMITS.mentionsMax);
  return {
    text: summary(pins),
    attachments,
    brief: { mode, pins: entries },
    // What the chat checks against the project before any of it is sent.
    drafts: pins.flatMap((pin) => (pin.segments === undefined ? [] : [pin.segments])),
    mentions: mentions.flatMap((mention, at) => {
      const number = pins[mention.pinIndex]?.number;
      assert(number !== undefined, 'pinMessage: a mention belongs to a pin');
      const lead = mentions[at - 1]?.pinIndex === mention.pinIndex ? ' ' : `${at === 0 ? '' : '\n'}Pin ${number} mentions: `;
      return [{ kind: 'text' as const, text: lead }, mention.segment];
    }),
  };
}

function briefEntry(pin: CommentPin, images: readonly number[]): PinBriefEntry {
  return {
    number: pin.number,
    ...wordsOf(pin),
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

/**
 * The chips of `pins` that the host expands into context of its own (a file, a skill, built-in instructions), each
 * once, at most `max` (a message's bound on mentions). Every other chip is already in its pin's plain text as the
 * reference the chat's composer sends; so is one past the bound, whose path or name the agent can still follow.
 */
export function pinExpandedMentions(
  pins: readonly PinWords[],
  max: number,
): readonly { readonly pinIndex: number; readonly segment: ComposerSegments[number] }[] {
  const seen = new Set<string>();
  const found: { readonly pinIndex: number; readonly segment: ComposerSegments[number] }[] = [];
  pins.forEach((pin, pinIndex) => {
    for (const segment of pin.segments ?? []) {
      if (segment.kind !== 'chip' || isReferenceChip(segment.chip)) {
        continue;
      }
      const chip = segment.chip;
      const key = chip.kind === 'builtin' ? `builtin:${chip.id}` : `${chip.kind}:${'path' in chip ? chip.path : ''}`;
      if (!seen.has(key) && found.length < max) {
        seen.add(key);
        found.push({ pinIndex, segment });
      }
    }
  });
  assert(found.length <= max, 'pinExpandedMentions: bounded');
  return found;
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
  // The screenshot takes whole pixels, and the canvas's box often is not on them (a fixed width centred in the pane
  // starts on half a pixel). So the crop is cut to the whole pixels inside the canvas: cut to the box itself, it kept
  // the fraction, the request was refused, and the pin silently had no picture.
  const x = Math.max(Math.ceil(clip.x), Math.floor(across.start));
  const y = Math.max(Math.ceil(clip.y), Math.floor(down.start));
  const right = Math.min(Math.floor(clip.x + clip.width), Math.ceil(across.start + across.size));
  const bottom = Math.min(Math.floor(clip.y + clip.height), Math.ceil(down.start + down.size));
  if (right - x < 1) {
    return undefined;
  }
  if (bottom - y < 1) {
    return undefined;
  }
  assert([x, y, right, bottom].every(Number.isSafeInteger), 'cropRect: a crop is whole pixels');
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
