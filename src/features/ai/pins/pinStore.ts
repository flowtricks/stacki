// Comment pins in the renderer (docs/contracts.md, "Comment pins"): the project's board and its images, whether
// comment mode is on, which pin's popover is open, the saving of the board, and "Send all". The state lives outside
// React, as the chat store's does (aiStore.ts), so pins keep streaming their progress while the panel is closed.
//
// The canvas side (where a click lands, where an element is, what a crop photographs) is the Desktop shell's
// (src/app/shell/DesktopPins.tsx): it installs a navigator here to show a pin's element, and calls `dropPin` and
// `capturePinCrop` with what the canvas measured. Comment mode registers itself in the AI panel's Modes menu
// (panelModes.ts) only while that host is mounted, so a surface without it (Studio) never offers the mode.
//
// "Send all" goes to the chat open in the panel (a new one when none is). For an agent whose subagents the panel can
// follow (Claude) it is one message; each pin becomes its own subagent there and shows its progress. Otherwise
// (Codex) it is one message per pin, sent one after another: the next goes when the turn before ended well, and
// a turn that did not holds the rest until the person continues.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import { pinSendMode } from '../../../../shared/properties/ai/agentPresentation';
import { PIN_LIMITS, type PinSendMode } from '../../../../shared/properties/ai/commentPinBrief';
import {
  EMPTY_PIN_BOARD,
  boardImageIds,
  pinImageChars,
  toPinId,
  toPinImageId,
  type CommentPin,
  type PinAnchor,
  type PinBoard,
  type PinId,
  type PinImageData,
  type PinImageId,
  type PinImageKind,
  type PinImageType,
  type PinPlace,
} from '../../../../shared/properties/ai/commentPins';
import type { ChatId, TurnId } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { reportErrorToast } from '../../../ui/errorNotices';
import { aiPinsRead, aiPinsWrite, aiScreenshot } from '../aiBridge';
import { aiState, newChat, openChat, preferredAgent, sendPinMessage, subscribeAiState } from '../aiStore';
import {
  addPin,
  addPinImages,
  changePin,
  clearSentPins,
  commentLine,
  pinMessage,
  pinProgress,
  pinsToSend,
  removePin,
  reopenPin,
  sendRefusal,
  turnEnd,
  unusedImages,
  type ImageOutcome,
  type PinProgress,
  type SendRefusal,
} from './pinModel';

/** How long typing pauses before the board is saved. */
const SAVE_PAUSE_MS = 400;

/** A `single` send running one pin per message: the pins still to go, in order, and whether it is held. */
export interface SequentialRun {
  readonly chat: ChatId;
  readonly pins: readonly PinId[];
  readonly held: 'paused' | 'running';
}

export interface PinState {
  readonly projectPath: string | undefined;
  readonly loaded: boolean;
  readonly board: PinBoard;
  /** Each image's base64, by id: every image the board names that has been read or added. */
  readonly images: ReadonlyMap<PinImageId, string>;
  readonly mode: 'on' | 'off';
  /** The pin whose popover is open. */
  readonly open: PinId | undefined;
  /** A pin being moved: the next canvas click puts it there instead of dropping a new one. */
  readonly moving: PinId | undefined;
  readonly listOpen: boolean;
  /** A crop is being taken: the popover steps aside for the frame of the capture. */
  readonly capturing: boolean;
  readonly run: SequentialRun | undefined;
  /** Pins of the page shown whose element is gone from it (the shell resolves them, pinModel.ts resolveAnchor). */
  readonly detached: ReadonlySet<PinId>;
}

const INITIAL: PinState = {
  projectPath: undefined,
  loaded: false,
  board: EMPTY_PIN_BOARD,
  images: new Map(),
  mode: 'off',
  open: undefined,
  moving: undefined,
  listOpen: false,
  capturing: false,
  run: undefined,
  detached: new Set(),
};

let state: PinState = INITIAL;
const listeners = new Set<() => void>();
/** Image ids the main process holds on disk: a save sends only the others. */
let stored = new Set<PinImageId>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> = Promise.resolve();

export function pinState(): PinState {
  return state;
}

export function usePinState(): PinState {
  return useSyncExternalStore(subscribePins, pinState, pinState);
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(change: (current: PinState) => PinState): void {
  const before = state;
  state = change(state);
  if (state.board !== before.board) {
    scheduleSave();
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

// ---------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------

/** Reads the project's board. A pin left waiting in a run the app closed on was never sent: it is a draft again. */
export async function loadPins(projectPath: string): Promise<void> {
  assert(projectPath.length > 0, 'loadPins: a project is named');
  if (state.projectPath === projectPath && state.loaded) {
    return;
  }
  await flushPinSave();
  state = { ...INITIAL, projectPath };
  stored = new Set();
  const reply = await aiPinsRead({ projectPath });
  if (state.projectPath !== projectPath) {
    return; // Another project opened meanwhile.
  }
  if (!reply.ok) {
    update((current) => ({ ...current, loaded: true }));
    return;
  }
  stored = new Set(reply.value.images.map((image) => image.id));
  const pins = reply.value.board.pins.map((pin) =>
    pin.delivery.kind === 'sent' && pin.delivery.turn === undefined ? { ...pin, delivery: { kind: 'draft' as const } } : pin,
  );
  const images = new Map(reply.value.images.map((image) => [image.id, image.data]));
  // Set without a save: what was read is what is stored.
  state = { ...state, loaded: true, board: { version: 1, pins }, images };
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Forgets the project: its board is saved first. Comment mode ends with it. */
export async function closePins(): Promise<void> {
  await flushPinSave();
  state = INITIAL;
  stored = new Set();
  for (const listener of [...listeners]) {
    listener();
  }
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushPinSave(), SAVE_PAUSE_MS);
}

/** Saves the board now, if a save is waiting; the next save waits for this one. */
export function flushPinSave(): Promise<void> {
  if (saveTimer === undefined) {
    return saving;
  }
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const projectPath = state.projectPath;
  if (projectPath === undefined || !state.loaded) {
    return saving;
  }
  const board = state.board;
  const named = boardImageIds(board);
  const images: PinImageData[] = [];
  for (const id of named) {
    const data = state.images.get(id);
    if (data !== undefined && !stored.has(id)) {
      images.push({ id, data });
    }
  }
  saving = saving.then(async () => {
    const reply = await aiPinsWrite({ projectPath, board, images });
    if (reply.ok) {
      stored = new Set(named);
      dropUnusedImages();
    } else {
      reportErrorToast(reply.error.message);
    }
  });
  return saving;
}

// Bytes of images no pin names any more leave memory once the board that dropped them is saved.
function dropUnusedImages(): void {
  const unused = unusedImages(state.board, state.images.keys());
  if (unused.length === 0) {
    return;
  }
  const images = new Map(state.images);
  for (const id of unused) {
    images.delete(id);
  }
  state = { ...state, images };
}

// ---------------------------------------------------------------------------
// Comment mode and the popover
// ---------------------------------------------------------------------------

export function setCommentMode(mode: 'on' | 'off'): void {
  update((current) => (mode === 'on' ? { ...current, mode } : { ...current, mode, open: undefined, moving: undefined, listOpen: false }));
}

export function openPin(id: PinId | undefined): void {
  update((current) => ({ ...current, open: id, moving: undefined }));
}

export function setPinListOpen(open: 'open' | 'closed'): void {
  update((current) => ({ ...current, listOpen: open === 'open' }));
}

/** The next canvas click moves pin `id` there (a detached pin, or one on the wrong element); undefined cancels. */
export function startMovingPin(id: PinId | undefined): void {
  update((current) => ({ ...current, moving: id, open: undefined }));
}

// ---------------------------------------------------------------------------
// Making and changing pins
// ---------------------------------------------------------------------------

/**
 * A click in comment mode: a new pin there with its popover open, or, while a pin is being moved, that pin moved
 * there. The new pin's id, or undefined when the board is full (said in a toast).
 */
export function dropPin(input: { readonly anchor: PinAnchor; readonly place: PinPlace }, translate: Translator): PinId | undefined {
  const moving = state.moving;
  if (moving !== undefined && state.board.pins.some((pin) => pin.id === moving)) {
    update((current) => ({
      ...current,
      board: changePin(current.board, moving, Date.now(), (pin) => ({ ...pin, anchor: input.anchor, place: input.place })),
      moving: undefined,
      open: moving,
    }));
    return moving;
  }
  const outcome = addPin(state.board, { id: newPinId(), anchor: input.anchor, place: input.place, at: Date.now() });
  if (outcome.kind === 'full') {
    reportErrorToast(translate('ai.pins.full', { count: PIN_LIMITS.pinsMax }));
    return undefined;
  }
  update((current) => ({ ...current, board: outcome.board, open: outcome.pin.id, moving: undefined }));
  return outcome.pin.id;
}

/** The pins of the page shown whose element is gone; a set equal to the one held changes nothing. */
export function setDetachedPins(ids: ReadonlySet<PinId>): void {
  const held = state.detached;
  if (held.size === ids.size && [...ids].every((id) => held.has(id))) {
    return;
  }
  update((current) => ({ ...current, detached: new Set(ids) }));
}

/** A pin's element moved to another path (an edit before it): the pin follows without a word. */
export function followPinElement(id: PinId, path: string): void {
  const pin = state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined || pin.anchor.path === path) {
    return;
  }
  update((current) => ({ ...current, board: changePin(current.board, id, Date.now(), (old) => ({ ...old, anchor: { ...old.anchor, path } })) }));
}

export function setPinComment(id: PinId, comment: string): void {
  const bounded = comment.slice(0, PIN_LIMITS.commentCharsMax);
  update((current) => ({ ...current, board: changePin(current.board, id, Date.now(), (pin) => ({ ...pin, comment: bounded })) }));
}

export function setPinIncluded(id: PinId, choice: 'include' | 'exclude'): void {
  update((current) => ({ ...current, board: changePin(current.board, id, Date.now(), (pin) => ({ ...pin, included: choice === 'include' })) }));
}

export function deletePin(id: PinId): void {
  update((current) => ({
    ...current,
    board: removePin(current.board, id),
    open: current.open === id ? undefined : current.open,
    moving: current.moving === id ? undefined : current.moving,
  }));
}

/** "Clear sent": every sent pin leaves the board (their message stays in the chat). */
export function clearSent(): void {
  update((current) => ({ ...current, board: clearSentPins(current.board), run: undefined }));
}

/** A sent pin back to a draft, to change and send again. */
export function reopenSentPin(id: PinId): void {
  update((current) => ({ ...current, board: changePin(current.board, id, Date.now(), reopenPin), open: id }));
}

/** An image ready for a pin: its bytes and how it is named. */
export interface PinImageInput {
  readonly kind: PinImageKind;
  readonly name: string;
  readonly mimeType: PinImageType;
  readonly data: string;
}

/** Adds images to pin `id` (a crop replaces its earlier crop); the bounds say how many fitted, and a toast says why the rest did not. */
export function addImagesToPin(id: PinId, images: readonly PinImageInput[], translate: Translator): ImageOutcome | undefined {
  const pin = state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined || images.length === 0) {
    return undefined;
  }
  const entries = images.map((image) => ({
    id: newImageId(),
    kind: image.kind,
    name: image.name,
    mimeType: image.mimeType,
    chars: image.data.length,
    data: image.data,
  }));
  const held = [...boardImageIds(state.board)].flatMap((imageId) => {
    const data = state.images.get(imageId);
    return data === undefined ? [] : [{ data }];
  });
  const outcome = addPinImages(pin, entries, pinImageChars(held), (imageId) => state.images.get(imageId)?.length ?? 0);
  const added = new Set(outcome.added.map((image) => image.id));
  update((current) => {
    const nextImages = new Map(current.images);
    for (const entry of entries) {
      if (added.has(entry.id)) {
        nextImages.set(entry.id, entry.data);
      }
    }
    return { ...current, images: nextImages, board: changePin(current.board, id, Date.now(), () => outcome.pin) };
  });
  if (outcome.kind === 'limited') {
    reportErrorToast(outcome.reason === 'count' ? translate('ai.pins.imagesFull', { count: PIN_LIMITS.imagesPerPinMax }) : translate('ai.pins.imagesTooLarge'));
  }
  return outcome;
}

export function removePinImage(id: PinId, image: PinImageId): void {
  update((current) => ({
    ...current,
    board: changePin(current.board, id, Date.now(), (pin) => ({ ...pin, images: pin.images.filter((entry) => entry.id !== image) })),
  }));
}

/**
 * Photographs `rect` of the window (the pinned area, cropRect) and keeps it as the pin's crop. The popover steps
 * aside for the frame of the capture, so the crop shows the page and the pin, never the popover. A failed capture
 * leaves the pin without a crop and says so in a toast.
 */
export async function capturePinCrop(
  id: PinId,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  translate: Translator,
): Promise<void> {
  const projectPath = state.projectPath;
  if (projectPath === undefined) {
    return;
  }
  update((current) => ({ ...current, capturing: true }));
  try {
    await nextPaint();
    const reply = await aiScreenshot({ projectPath, rect });
    if (!reply.ok) {
      reportErrorToast(translate('ai.pins.cropFailed'));
      return;
    }
    addImagesToPin(id, [{ kind: 'crop', name: translate('ai.pins.cropName'), mimeType: reply.value.mimeType, data: reply.value.data }], translate);
  } finally {
    update((current) => ({ ...current, capturing: false }));
  }
}

// ---------------------------------------------------------------------------
// Where a pin is, on request of the list or a message
// ---------------------------------------------------------------------------

/** What the shell installs to show a pin's element: open its page and component, set its width, select and scroll to it. */
export interface PinNavigator {
  readonly reveal: (pin: CommentPin) => void;
}

let navigator: PinNavigator | undefined;

export function setPinNavigator(next: PinNavigator | undefined): void {
  navigator = next;
}

/** Shows pin `id`: comment mode on, its element on the canvas, its popover open. False when there is no such pin. */
export function jumpToPin(id: PinId): boolean {
  const pin = state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined) {
    return false;
  }
  update((current) => ({ ...current, mode: 'on', open: id, moving: undefined }));
  navigator?.reveal(pin);
  return true;
}

/** The pin a sent message names: by its chat, turn and number. */
export function sentPinOf(chat: ChatId, turn: TurnId, number: number): CommentPin | undefined {
  return state.board.pins.find((pin) => pin.number === number && pin.delivery.kind === 'sent' && pin.delivery.chat === chat && pin.delivery.turn === turn);
}

// ---------------------------------------------------------------------------
// Send all
// ---------------------------------------------------------------------------

/** Where "Send all" stands for the chat it would go to: ready (and how), or why not. */
export type SendReadiness =
  | { readonly kind: 'ready'; readonly mode: PinSendMode; readonly count: number }
  | { readonly kind: 'blocked'; readonly reason: SendBlock; readonly count: number };

export type SendBlock = SendRefusal | 'busy' | 'running' | 'not-ready';

/** Whether "Send all" can go now: something to send, within one message's bounds, the chat idle and its agent ready. */
export function sendReadiness(pins: PinState, ai: ReturnType<typeof aiState>): SendReadiness {
  const chosen = pinsToSend(pins.board);
  const chat = ai.open === undefined ? undefined : ai.chats.find((candidate) => candidate.id === ai.open);
  const agent = chat?.agent ?? preferredAgent();
  const mode = pinSendMode(agent);
  const count = chosen.length;
  const refusal = sendRefusal(chosen, mode);
  if (refusal !== undefined) {
    return { kind: 'blocked', reason: refusal, count };
  }
  if (pins.run !== undefined) {
    return { kind: 'blocked', reason: 'running', count };
  }
  if (!ai.trusted || ai.agents.find((entry) => entry.agent === agent)?.state !== 'ready') {
    return { kind: 'blocked', reason: 'not-ready', count };
  }
  if (chat !== undefined && ai.views.get(chat.id)?.running !== undefined) {
    return { kind: 'blocked', reason: 'busy', count };
  }
  return { kind: 'ready', mode, count };
}

/**
 * Sends every included draft to the chat open in the panel (a new chat with the preferred agent when none is).
 * Never runs by itself: only the person's "Send all" calls it. True when the pins went (or, one per message,
 * when the first went).
 */
export async function sendAllPins(translate: Translator): Promise<boolean> {
  const readiness = sendReadiness(state, aiState());
  if (readiness.kind !== 'ready') {
    return false;
  }
  const chat = aiState().open ?? (await newChat(preferredAgent()));
  if (chat === undefined) {
    return false;
  }
  const pins = pinsToSend(state.board);
  const summary = (sent: readonly CommentPin[]): string => pinSummaryText(sent, translate);
  if (readiness.mode === 'subagents') {
    const message = pinMessage(pins, 'subagents', (id) => state.images.get(id), summary);
    const turn = await sendPinMessage(chat, { text: message.text, attachments: message.attachments, pins: message.brief });
    if (turn === undefined) {
      return false;
    }
    markSent(pins, { chat, turn, mode: 'subagents' });
    void openChat(chat);
    return true;
  }
  markSent(pins, { chat, turn: undefined, mode: 'single' });
  update((current) => ({ ...current, run: { chat, pins: pins.map((pin) => pin.id), held: 'running' } }));
  void openChat(chat);
  return sendNextInRun(translate);
}

/** Continues a held one-pin-per-message run with its next pin. */
export function continueRun(translate: Translator): Promise<boolean> {
  const run = state.run;
  if (run === undefined) {
    return Promise.resolve(false);
  }
  update((current) => ({ ...current, run: { ...run, held: 'running' } }));
  return sendNextInRun(translate);
}

/** Ends a held run: the pins it had not sent yet are drafts again. */
export function cancelRun(): void {
  const run = state.run;
  if (run === undefined) {
    return;
  }
  const waiting = new Set(run.pins);
  update((current) => ({
    ...current,
    run: undefined,
    board: {
      ...current.board,
      pins: current.board.pins.map((pin) =>
        waiting.has(pin.id) && pin.delivery.kind === 'sent' && pin.delivery.turn === undefined ? { ...pin, delivery: { kind: 'draft' } } : pin,
      ),
    },
  }));
}

// The plain text of a message of pins: what Copy, an export and the chat's title read. Each pin's own words, numbered.
function pinSummaryText(pins: readonly CommentPin[], translate: Translator): string {
  const lines = pins.map((pin) =>
    translate('ai.pins.summaryLine', {
      number: pin.number,
      comment: pin.comment.trim() === '' ? translate('ai.pins.noComment') : commentLine(pin.comment, PIN_SUMMARY_LINE_CHARS_MAX),
    }),
  );
  return [translate('ai.pins.summaryTitle', { count: pins.length }), ...lines].join('\n');
}

/** Characters of each pin's comment in a message's plain text. */
const PIN_SUMMARY_LINE_CHARS_MAX = 200;

function markSent(pins: readonly CommentPin[], target: { readonly chat: ChatId; readonly turn: TurnId | undefined; readonly mode: PinSendMode }): void {
  const ids = new Set(pins.map((pin) => pin.id));
  const at = Date.now();
  update((current) => ({
    ...current,
    open: current.open !== undefined && ids.has(current.open) ? undefined : current.open,
    board: {
      ...current.board,
      pins: current.board.pins.map((pin) => (ids.has(pin.id) ? { ...pin, delivery: { kind: 'sent', ...target, at } } : pin)),
    },
  }));
}

let runTranslate: Translator | undefined;

// The next pin of a run, as its own message. A refused send holds the run, so nothing sends itself after a failure.
async function sendNextInRun(translate: Translator): Promise<boolean> {
  runTranslate = translate;
  if (runSending) {
    return false; // A send is on its way: the store's next change asks again once its turn is known.
  }
  runSending = true;
  try {
    return await sendNextInRunNow(translate);
  } finally {
    runSending = false;
  }
}

/** Whether a run's next message is on its way, so a second change of the chat store cannot send the same pin twice. */
let runSending = false;

async function sendNextInRunNow(translate: Translator): Promise<boolean> {
  const run = state.run;
  if (run === undefined || run.held === 'paused') {
    return false;
  }
  const next = run.pins
    .map((id) => state.board.pins.find((pin) => pin.id === id))
    .find((pin) => pin?.delivery.kind === 'sent' && pin.delivery.turn === undefined);
  if (next === undefined) {
    update((current) => ({ ...current, run: undefined }));
    return true;
  }
  const message = pinMessage(
    [next],
    'single',
    (id) => state.images.get(id),
    (sent) => pinSummaryText(sent, translate),
  );
  const turn = await sendPinMessage(run.chat, { text: message.text, attachments: message.attachments, pins: message.brief });
  if (turn === undefined) {
    update((current) => ({ ...current, run: current.run === undefined ? undefined : { ...current.run, held: 'paused' } }));
    return false;
  }
  update((current) => ({
    ...current,
    board: changePin(current.board, next.id, Date.now(), (pin) => (pin.delivery.kind === 'sent' ? { ...pin, delivery: { ...pin.delivery, turn } } : pin)),
  }));
  return true;
}

// A run follows its chat: when the turn of the pin it sent last ends well, the next pin goes; when it ends any
// other way, the run is held until the person continues it.
function followRun(): void {
  const run = state.run;
  if (run === undefined || run.held === 'paused') {
    return;
  }
  const view = aiState().views.get(run.chat);
  const sentTurns = run.pins.flatMap((id) => {
    const pin = state.board.pins.find((candidate) => candidate.id === id);
    return pin?.delivery.kind === 'sent' && pin.delivery.turn !== undefined ? [pin.delivery.turn] : [];
  });
  const last = sentTurns[sentTurns.length - 1];
  if (view === undefined || last === undefined) {
    return;
  }
  const ended = turnEnd(view, last);
  if (ended === undefined || view.running !== undefined) {
    return;
  }
  if (ended !== 'end_turn') {
    update((current) => ({ ...current, run: current.run === undefined ? undefined : { ...current.run, held: 'paused' } }));
    return;
  }
  const translate = runTranslate;
  if (translate !== undefined) {
    void sendNextInRun(translate);
  }
}

let following: (() => void) | undefined;

/** Starts following the chats for runs; returns the stop. Called by the host while it is mounted. */
export function followChats(): () => void {
  following?.();
  const stop = subscribeAiState(followRun);
  following = stop;
  return () => {
    stop();
    if (following === stop) {
      following = undefined;
    }
  };
}

/** How pin `pin` stands now, read from the chat store's transcripts. */
export function progressOf(pin: CommentPin): PinProgress {
  const delivery = pin.delivery;
  const view = delivery.kind === 'sent' ? aiState().views.get(delivery.chat) : undefined;
  const held = state.run !== undefined && state.run.held === 'paused' && state.run.pins.includes(pin.id) ? 'paused' : 'running';
  return pinProgress(pin, view, held);
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

function newPinId(): PinId {
  return toPinId(`p${randomHex()}`);
}

function newImageId(): PinImageId {
  return toPinImageId(`i${randomHex()}`);
}

function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert(hex.length === 16, 'randomHex: sixteen hex digits');
  return hex;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** For tests: the store as a fresh app has it. */
export function resetPinStore(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  saving = Promise.resolve();
  stored = new Set();
  following?.();
  following = undefined;
  runTranslate = undefined;
  runSending = false;
  navigator = undefined;
  state = INITIAL;
}
