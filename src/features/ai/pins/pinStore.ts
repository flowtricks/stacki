// Comment pins in the renderer (docs/contracts.md, "Comment pins"): the project's board and its images, whether
// comment mode is on, which pin's popover is open, the saving of the board, and "Send all". The state lives outside
// React, as the chat store's does (aiStore.ts), so pins keep streaming their progress while the panel is closed.
//
// The canvas side (where a click lands, where an element is, what a crop photographs) is the Desktop shell's
// (src/app/shell/DesktopPins.tsx): it installs a navigator here to show a pin's element, and calls `dropPin` and
// `capturePinCrop` with what the canvas measured. Comment mode registers its button in the AI panel's header
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
  type PinImageRef,
  type PinImageType,
  type PinPlace,
  type PinModel,
} from '../../../../shared/properties/ai/commentPins';
import type { ChatId, ChatOption, TurnId } from '../../../../shared/properties/ai/chatModel';
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { usableSettings } from '../../../../shared/properties/ai/rememberedSettings';
import type { Translator } from '../../../lib/i18n/localeContext';
import { reportActionToast, reportErrorToast } from '../../../ui/errorNotices';
import { aiPinsRead, aiPinsWrite, aiScreenshot } from '../aiBridge';
import type { ComposerSegments } from '../../../../shared/properties/ai/mentions';
import { aiState, loadChatView, newChat, openChat, preferredAgent, sendPinMessage, setChatOption, subscribeAiState } from '../aiStore';
import {
  addPin,
  addPinImages,
  changePin,
  closeOutcome,
  commentLine,
  discardPinEdit,
  hasContentToLose,
  hasPersonContent,
  hasUnsavedChanges,
  movePinAnchor,
  nextPinNumber,
  savePinEdit,
  workingCopy,
  pinFinished,
  pinMessage,
  pinWordsOf,
  wordsOf,
  type PinMessage,
  pinProgress,
  pinsToSend,
  resolvePinModel,
  removePin,
  reopenPin,
  sendRefusal,
  turnEnd,
  unusedImages,
  type ImageOutcome,
  type PinModelChoice,
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
  /**
   * The chat's own model, put back after pins that chose another one; undefined when no pin of the run chose a
   * model (the chat's setting is never touched then). `applied` is the one the run last set.
   */
  readonly models?: { readonly option: string; readonly base: string; readonly applied: string };
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
  /** A marker being dragged to another element. */
  readonly dragging: PinId | undefined;
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
  dragging: undefined,
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
  const pins = reply.value.board.pins
    .filter((pin) => pin.savedAt !== undefined || hasPersonContent(workingCopy(pin)))
    .map((pin) => (pin.delivery.kind === 'sent' && pin.delivery.turn === undefined ? { ...pin, delivery: { kind: 'draft' as const } } : pin));
  const images = new Map(reply.value.images.map((image) => [image.id, image.data]));
  // Set without a save: what was read is what is stored.
  state = { ...state, loaded: true, board: { version: 1, pins }, images };
  chatsAsked = new Set();
  for (const listener of [...listeners]) {
    listener();
  }
  if (following !== undefined) {
    followChatsChange(); // Pins whose work finished while the app was closed are deleted once their chats are read.
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

export function setCommentMode(mode: 'on' | 'off', translate?: Translator): void {
  if (mode === 'off') {
    // Leaving the mode never loses typed words: the open box is kept (saved when it has content).
    closePinBox('keep', translate);
  }
  update((current) => (mode === 'on' ? { ...current, mode } : { ...current, mode, open: undefined, moving: undefined, listOpen: false, dragging: undefined }));
}

/** Opens pin `id`'s box; a box open on another pin is kept first (saved when it has content). */
export function openPin(id: PinId, translate?: Translator): void {
  if (state.open !== undefined && state.open !== id) {
    closePinBox('keep', translate);
  }
  update((current) => ({ ...current, open: id, moving: undefined }));
}

/**
 * Closes the open box. `discard` (its close button, Escape): a pin never saved goes, a saved pin loses only its
 * unsaved changes. When words or images the person made go with it, they come back: a removed pin by the app's Undo
 * (⌘Z), a saved pin's unsaved changes by the toast's Undo. `keep`
 * (a press elsewhere, another pin, leaving the mode or the page): content is saved, an empty box is let go.
 */
export function closePinBox(how: 'keep' | 'discard', translate?: Translator): void {
  const id = state.open;
  const pin = id === undefined ? undefined : state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined) {
    if (id !== undefined) {
      update((current) => ({ ...current, open: undefined }));
    }
    return;
  }
  const outcome = closeOutcome(pin, how);
  const lost = (outcome === 'remove' || outcome === 'discard') && pin.edit !== undefined && hasPersonContent(pin.edit) && hasUnsavedChanges(pin);
  const at = Date.now();
  const removal = lost && outcome === 'remove' && translate !== undefined ? pinSnapshot(pin) : undefined;
  update((current) => {
    switch (outcome) {
      case 'unchanged':
        return { ...current, open: undefined };
      case 'save':
        return { ...current, open: undefined, board: changePin(current.board, pin.id, at, (old) => savePinEdit(old, at)) };
      case 'discard':
        return { ...current, open: undefined, board: changePin(current.board, pin.id, at, discardPinEdit) };
      case 'remove':
        return { ...current, open: undefined, board: removePin(current.board, pin.id) };
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  });
  if (removal !== undefined && translate !== undefined) {
    recordRemoval(removal, translate);
  } else if (lost && translate !== undefined) {
    offerUndo(pin, translate('ai.pins.discardedToast', { number: pin.number }), translate);
  }
}

/** Saves the open box (its Save button, Enter) and closes it; a box without words or an added image is not saved. */
export function savePinBox(): void {
  const id = state.open;
  const pin = id === undefined ? undefined : state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined || pin.delivery.kind === 'sent' || !hasPersonContent(workingCopy(pin))) {
    return;
  }
  const at = Date.now();
  update((current) => ({ ...current, open: undefined, board: changePin(current.board, pin.id, at, (old) => savePinEdit(old, at)) }));
}

/** A pin as it was, with the bytes of its images: what an Undo needs to put it back. */
interface PinSnapshot {
  readonly pin: CommentPin;
  readonly images: ReadonlyMap<PinImageId, string>;
}

function pinSnapshot(pin: CommentPin): PinSnapshot {
  const images = new Map<PinImageId, string>();
  for (const image of [...pin.images, ...(pin.edit?.images ?? [])]) {
    const data = state.images.get(image.id);
    if (data !== undefined) {
      images.set(image.id, data);
    }
  }
  return { pin, images };
}

// A toast that puts a pin back as it was before it was moved, or before its unsaved changes were discarded.
function offerUndo(before: CommentPin, message: string, translate: Translator): void {
  const snapshot = pinSnapshot(before);
  reportActionToast(message, 'info', [
    {
      label: translate('ai.pins.undo'),
      run: () => {
        if (restorePin(snapshot) === 'full') {
          reportErrorToast(translate('ai.pins.full', { count: PIN_LIMITS.pinsMax }));
        }
      },
    },
  ]);
}

/** A removed pin as a step of the app's Undo and Redo, so ⌘Z takes it back in order with every other step. */
export interface PinHistoryStep {
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
}

/** What the shell installs to record a step on the app's history (DesktopPins.tsx), which bounds how many it keeps. */
export type PinHistory = (step: PinHistoryStep) => void;

let history: PinHistory | undefined;

export function setPinHistory(next: PinHistory | undefined): void {
  history = next;
}

// A removal the person made. A removal Stacki makes (a pin whose work finished) is not theirs to undo and is not recorded.
function recordRemoval(removed: PinSnapshot, translate: Translator): void {
  const projectPath = state.projectPath;
  let snapshot = removed;
  history?.({
    // A step left over from another project changes nothing here: its board is not the one open.
    undo: async () => {
      if (state.projectPath === projectPath && restorePin(snapshot) === 'full') {
        throw new Error(translate('ai.pins.full', { count: PIN_LIMITS.pinsMax }));
      }
    },
    redo: async () => {
      const present = state.projectPath === projectPath ? state.board.pins.find((pin) => pin.id === snapshot.pin.id) : undefined;
      if (present !== undefined) {
        snapshot = pinSnapshot(present); // As it is now, so the next Undo brings back what this Redo takes.
        takePin(present.id);
      }
    },
  });
}

// Puts a pin back as the snapshot has it: in place of what is on the board under its id, or added again.
function restorePin(snapshot: PinSnapshot): 'restored' | 'full' {
  const before = snapshot.pin;
  const present = state.board.pins.some((pin) => pin.id === before.id);
  const others = state.board.pins.filter((pin) => pin.id !== before.id);
  if (!present && others.length >= PIN_LIMITS.pinsMax) {
    return 'full';
  }
  // Its number again, unless a newer pin took it meanwhile.
  const number = others.some((pin) => pin.number === before.number) ? nextPinNumber({ version: 1, pins: others }) : before.number;
  update((current) => {
    const images = new Map(current.images);
    for (const [id, data] of snapshot.images) {
      images.set(id, data);
      stored.delete(id); // The save that dropped it may have removed its file: it is written again.
    }
    const restored = { ...stillWaiting(before, current.run), number };
    const pins = present ? current.board.pins.map((pin) => (pin.id === before.id ? restored : pin)) : [...current.board.pins, restored];
    return { ...current, images, board: { ...current.board, pins } };
  });
  return 'restored';
}

// A pin removed while it waited for its turn in a one-per-message run that has since ended is a draft again.
function stillWaiting(pin: CommentPin, run: SequentialRun | undefined): CommentPin {
  const waiting = pin.delivery.kind === 'sent' && pin.delivery.turn === undefined;
  return waiting && run?.pins.includes(pin.id) !== true ? { ...pin, delivery: { kind: 'draft' } } : pin;
}

export function setPinListOpen(open: 'open' | 'closed'): void {
  update((current) => ({ ...current, listOpen: open === 'open' }));
}

/** The next canvas click moves pin `id` there (a detached pin, or one on the wrong element); undefined cancels. */
export function startMovingPin(id: PinId | undefined): void {
  update((current) => ({ ...current, moving: id, open: undefined }));
}

/** A marker being dragged: its box steps aside until it lands. */
export function setDraggingPin(id: PinId | undefined): void {
  update((current) => ({ ...current, dragging: id }));
}

/**
 * Pin `id` moved onto another element (dragged there, or clicked there after "Move the pin"): its words, images and
 * number stay, unsaved changes included; an Undo toast puts it back. True when it moved.
 */
export function movePin(id: PinId, target: { readonly anchor: PinAnchor; readonly place: PinPlace }, translate: Translator): boolean {
  const pin = state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined || pin.delivery.kind === 'sent') {
    return false;
  }
  update((current) => ({ ...current, board: changePin(current.board, id, Date.now(), (old) => movePinAnchor(old, target)), moving: undefined }));
  offerUndo(pin, translate('ai.pins.movedToast', { number: pin.number }), translate);
  return true;
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
  if (moving !== undefined && movePin(moving, input, translate)) {
    update((current) => ({ ...current, open: moving }));
    return moving;
  }
  // Another spot pinned while a box is open: that box is kept (saved when it has content), never lost.
  closePinBox('keep', translate);
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

/** The box's words as plain text: unsaved until Save. */
export function setPinComment(id: PinId, comment: string): void {
  setPinSegments(id, comment === '' ? [] : [{ kind: 'text', text: comment }]);
}

/** The box's words and chips as typed or dictated: unsaved until Save. */
export function setPinSegments(id: PinId, segments: ComposerSegments): void {
  const words = pinWordsOf(segments);
  update((current) => ({
    ...current,
    board: changePin(current.board, id, Date.now(), (pin) => ({ ...pin, edit: { ...words, images: workingCopy(pin).images } })),
  }));
}

export function setPinIncluded(id: PinId, choice: 'include' | 'exclude'): void {
  update((current) => ({ ...current, board: changePin(current.board, id, Date.now(), (pin) => ({ ...pin, included: choice === 'include' })) }));
}

/** Deletes pin `id`, as a step the app's Undo takes back. The list stays open while a saved pin remains, and closes with the last. */
export function deletePin(id: PinId, translate: Translator): void {
  const pin = state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined) {
    return;
  }
  const removal = pinSnapshot(pin);
  takePin(id);
  if (pin.savedAt !== undefined || hasContentToLose(pin)) {
    recordRemoval(removal, translate);
  }
}

function takePin(id: PinId): void {
  update((current) => {
    const board = removePin(current.board, id);
    return {
      ...current,
      board,
      open: current.open === id ? undefined : current.open,
      moving: current.moving === id ? undefined : current.moving,
      listOpen: board.pins.some((pin) => pin.savedAt !== undefined) ? current.listOpen : false,
    };
  });
}

/** A sent pin back to a draft, to change and send again. */
export function reopenSentPin(id: PinId): void {
  update((current) => ({ ...current, board: changePin(current.board, id, Date.now(), reopenPin), open: id }));
}

/** The model pin `id` will run on; undefined follows the chat's. Chosen at once: it is a setting of the pin, not words to save. */
export function setPinModel(id: PinId, model: PinModel | undefined): void {
  update((current) => ({
    ...current,
    board: changePin(current.board, id, Date.now(), (pin) => {
      assert(pin.delivery.kind === 'draft', 'setPinModel: a sent pin keeps the model it was sent with');
      const rest = withoutModel(pin);
      return model === undefined ? rest : { ...rest, model };
    }),
  }));
}

// The pin with no model of its own: the key goes, as a pin that never had one is stored.
function withoutModel(pin: CommentPin): CommentPin {
  const rest = { ...pin };
  delete rest.model;
  return rest;
}

/** The agent "Send all" would go to: the open chat's, else the one a new chat starts with. */
export function pinAgent(ai: ReturnType<typeof aiState>): AgentId {
  return ai.chats.find((candidate) => candidate.id === ai.open)?.agent ?? preferredAgent();
}

/**
 * The settings the panel shows for `agent` now: the open chat's own once it has them, else the agent's last report
 * with what the person last chose, as the composer shows a chat not started yet.
 */
export function pinAgentOptions(ai: ReturnType<typeof aiState>, agent: AgentId, chat: ChatId | undefined = ai.open): readonly ChatOption[] {
  const open = chat === undefined ? undefined : ai.chats.find((candidate) => candidate.id === chat);
  const live = open?.agent === agent ? ai.views.get(open.id)?.options : undefined;
  if (live !== undefined && live.length > 0) {
    return live;
  }
  const reported = ai.agentOptions.get(agent) ?? [];
  const remembered = new Map(usableSettings(reported, ai.remembered[agent]).map((setting) => [setting.option, setting.value]));
  return reported.map((option) => ({ ...option, currentValue: remembered.get(option.id) ?? option.currentValue }));
}

// The model a pin is sent with, saying so once per unavailable model when its choice cannot be used.
function modelsFor(pins: readonly CommentPin[], agent: AgentId, chat: ChatId, translate: Translator): (pin: CommentPin) => PinModelChoice | undefined {
  const options = pinAgentOptions(aiState(), agent, chat);
  const told = new Set<string>();
  const chosen = new Map<PinId, PinModelChoice>();
  for (const pin of pins) {
    const resolved = resolvePinModel(pin, agent, options);
    if (resolved.kind === 'chosen') {
      chosen.set(pin.id, resolved.model);
    } else if (resolved.kind === 'unavailable' && !told.has(resolved.name)) {
      told.add(resolved.name);
      reportErrorToast(translate('ai.pins.model.unavailable', { model: resolved.name }));
    }
  }
  return (pin) => chosen.get(pin.id);
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
    return { ...current, images: nextImages, board: changePin(current.board, id, Date.now(), () => withCrop(pin, outcome.pin, outcome.added)) };
  });
  if (outcome.kind === 'limited') {
    reportErrorToast(outcome.reason === 'count' ? translate('ai.pins.imagesFull', { count: PIN_LIMITS.imagesPerPinMax }) : translate('ai.pins.imagesTooLarge'));
  }
  return outcome;
}

/**
 * A crop is Stacki's, not the person's, so it needs no Save: on a saved pin it replaces the saved crop too, and a pin
 * with no unsaved changes gets none from it. Anything the person added stays in the box until Save.
 */
function withCrop(before: CommentPin, after: CommentPin, added: readonly PinImageRef[]): CommentPin {
  const crop = added.find((image) => image.kind === 'crop');
  if (crop === undefined || before.savedAt === undefined || !added.every((image) => image.kind === 'crop')) {
    return after;
  }
  const savedImages = [crop, ...before.images.filter((image) => image.kind !== 'crop')].slice(0, PIN_LIMITS.imagesPerPinMax);
  return { ...after, images: savedImages, edit: before.edit === undefined ? undefined : after.edit };
}

/** Takes an image out of the box: unsaved until Save. */
export function removePinImage(id: PinId, image: PinImageId): void {
  update((current) => ({
    ...current,
    board: changePin(current.board, id, Date.now(), (pin) => {
      const working = workingCopy(pin);
      return { ...pin, edit: { ...wordsOf(working), images: working.images.filter((entry) => entry.id !== image) } };
    }),
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

/** What the shell installs to move a dragged pin: the canvas point (its CSS pixels) it was released at. */
export type PinMover = (id: PinId, point: { readonly x: number; readonly y: number }, translate: Translator) => Promise<void>;

let mover: PinMover | undefined;

export function setPinMover(next: PinMover | undefined): void {
  mover = next;
}

/** Moves pin `id` to what is under `point` on the canvas; nothing happens where the shell has no canvas. */
export function movePinTo(id: PinId, point: { readonly x: number; readonly y: number }, translate: Translator): Promise<void> {
  return mover === undefined ? Promise.resolve() : mover(id, point, translate);
}

/** Shows pin `id`: comment mode on, its element on the canvas, its popover open. False when there is no such pin. */
export function jumpToPin(id: PinId): boolean {
  const pin = state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined) {
    return false;
  }
  if (state.open !== undefined && state.open !== id) {
    closePinBox('keep');
  }
  // The list steps aside for the pin's box.
  update((current) => ({ ...current, mode: 'on', open: id, moving: undefined, listOpen: false }));
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

/** Where "Send all" stands for the chat it would go to: nothing to send (there is no Send), ready (and how), or why not. */
export type SendReadiness =
  | { readonly kind: 'empty'; readonly count: 0 }
  | { readonly kind: 'ready'; readonly mode: PinSendMode; readonly count: number }
  | { readonly kind: 'blocked'; readonly reason: SendBlock; readonly count: number };

export type SendBlock = Exclude<SendRefusal, 'none'> | 'busy' | 'running' | 'not-ready';

/** Whether "Send all" can go now: something to send, within one message's bounds, the chat idle and its agent ready. */
export function sendReadiness(pins: PinState, ai: ReturnType<typeof aiState>): SendReadiness {
  const chosen = pinsToSend(pins.board);
  const chat = ai.open === undefined ? undefined : ai.chats.find((candidate) => candidate.id === ai.open);
  const agent = chat?.agent ?? preferredAgent();
  const mode = pinSendMode(agent);
  const count = chosen.length;
  const refusal = sendRefusal(chosen, mode);
  if (refusal === 'none') {
    return { kind: 'empty', count: 0 };
  }
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
  const agent = aiState().chats.find((candidate) => candidate.id === chat)?.agent ?? preferredAgent();
  if (readiness.mode === 'subagents') {
    const modelOf = modelsFor(pins, agent, chat, translate);
    const message = pinMessage(pins, 'subagents', (id) => state.images.get(id), summary, modelOf);
    const turn = await sendPinMessage(chat, pinPrompt(message));
    if (turn === undefined) {
      return false;
    }
    markSent(pins, { chat, turn, mode: 'subagents' });
    void openChat(chat);
    return true;
  }
  markSent(pins, { chat, turn: undefined, mode: 'single' });
  const models = runModels(pins, agent, chat);
  update((current) => ({ ...current, run: { chat, pins: pins.map((pin) => pin.id), held: 'running', ...(models === undefined ? {} : { models }) } }));
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
  void restoreRunModel(run);
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

function pinPrompt({ brief, ...message }: PinMessage): Parameters<typeof sendPinMessage>[1] {
  return { ...message, pins: brief };
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
    await restoreRunModel(run);
    update((current) => ({ ...current, run: undefined }));
    return true;
  }
  const agent = aiState().chats.find((candidate) => candidate.id === run.chat)?.agent ?? preferredAgent();
  const model = await applyRunModel(next, agent, translate);
  const message = pinMessage(
    [next],
    'single',
    (id) => state.images.get(id),
    (sent) => pinSummaryText(sent, translate),
    () => model,
  );
  const turn = await sendPinMessage(run.chat, pinPrompt(message));
  if (turn === undefined) {
    holdRun();
    return false;
  }
  update((current) => ({
    ...current,
    board: changePin(current.board, next.id, Date.now(), (pin) => (pin.delivery.kind === 'sent' ? { ...pin, delivery: { ...pin.delivery, turn } } : pin)),
  }));
  return true;
}

// A run's note of the chat's model, kept only when a pin of it chose one.
function runModels(pins: readonly CommentPin[], agent: AgentId, chat: ChatId): SequentialRun['models'] {
  const option = pinAgentOptions(aiState(), agent, chat).find((candidate) => candidate.id === 'model' || candidate.category === 'model');
  if (option === undefined || !pins.some((pin) => pin.model !== undefined)) {
    return undefined;
  }
  return { option: option.id, base: option.currentValue, applied: option.currentValue };
}

// Switches the chat to the model `pin` runs on (its own choice, else the chat's) before its message goes. The
// model the message will really run on when the pin chose one, so the sent card never names another.
async function applyRunModel(pin: CommentPin, agent: AgentId, translate: Translator): Promise<PinModelChoice | undefined> {
  const run = state.run;
  if (run === undefined) {
    return undefined;
  }
  const chosen = modelsFor([pin], agent, run.chat, translate)(pin);
  const models = run.models;
  if (models === undefined) {
    return undefined;
  }
  const wanted = chosen?.value ?? models.base;
  if (wanted !== models.applied) {
    if (!(await setChatOption(run.chat, models.option, wanted))) {
      return undefined; // The refusal was shown; the pin runs on the model the chat still has.
    }
    update((current) => ({ ...current, run: current.run?.models === undefined ? current.run : { ...current.run, models: { ...models, applied: wanted } } }));
  }
  return chosen;
}

// Puts the chat's own model back once a run ends or is held.
async function restoreRunModel(run: SequentialRun): Promise<void> {
  const models = state.run?.models ?? run.models;
  if (models === undefined || models.applied === models.base) {
    return;
  }
  update((current) => ({
    ...current,
    run: current.run?.models === undefined ? current.run : { ...current.run, models: { ...models, applied: models.base } },
  }));
  await setChatOption(run.chat, models.option, models.base);
}

function holdRun(): void {
  const run = state.run;
  if (run === undefined) {
    return;
  }
  update((current) => ({ ...current, run: current.run === undefined ? undefined : { ...current.run, held: 'paused' } }));
  void restoreRunModel(run);
}

// Every change of the chats: a run moves on, then pins whose work finished well are deleted.
function followChatsChange(): void {
  followRun();
  readSentChats();
  deleteFinishedPins();
}

/**
 * Deletes every pin whose work is confirmed finished well (pinModel.ts pinFinished): its marker, its box, its row and,
 * with the save, its images. The chat's message keeps its own copy (words and thumbnail), so the transcript is whole.
 * A sent pin holding words typed and not saved (dictation that landed after the send) is not deleted: it becomes a
 * draft with them, so nothing typed is lost. When no pin is left the list closes; comment mode stays on.
 */
function deleteFinishedPins(): void {
  const finished = state.board.pins.filter((pin) => pin.delivery.kind === 'sent' && pinFinished(pin, aiState().views.get(pin.delivery.chat)));
  if (finished.length === 0) {
    return;
  }
  const kept = new Set(finished.filter((pin) => hasUnsavedChanges(pin) && pin.edit !== undefined && hasPersonContent(pin.edit)).map((pin) => pin.id));
  const gone = new Set(finished.filter((pin) => !kept.has(pin.id)).map((pin) => pin.id));
  update((current) => {
    const pins = current.board.pins.flatMap((pin) => (gone.has(pin.id) ? [] : [kept.has(pin.id) ? reopenPin(pin) : pin]));
    assert(pins.length === current.board.pins.length - gone.size, 'deleteFinishedPins: only finished pins go');
    const empty = !pins.some((pin) => pin.savedAt !== undefined);
    return {
      ...current,
      board: { ...current.board, pins },
      open: current.open !== undefined && gone.has(current.open) ? undefined : current.open,
      moving: current.moving !== undefined && gone.has(current.moving) ? undefined : current.moving,
      listOpen: empty ? false : current.listOpen,
    };
  });
}

/** Chats whose transcripts were asked for, so a chat that cannot be read is not asked again on every change. */
let chatsAsked = new Set<ChatId>();

// The transcripts of the chats sent pins went to, read once each (a pin's progress is read from its chat's
// transcript, and a chat not open here would otherwise leave a finished pin on the board after a restart).
function readSentChats(): void {
  if (aiState().projectPath !== state.projectPath || !state.loaded) {
    return;
  }
  if (chatsAsked.size >= PIN_LIMITS.pinsMax) {
    chatsAsked = new Set(); // Bounded: a board's pins name at most `pinsMax` chats, so a full set is old asks.
  }
  for (const pin of state.board.pins) {
    const delivery = pin.delivery;
    if (delivery.kind === 'sent' && delivery.turn !== undefined && !chatsAsked.has(delivery.chat) && !aiState().views.has(delivery.chat)) {
      chatsAsked.add(delivery.chat);
      void loadChatView(delivery.chat);
    }
  }
  assert(chatsAsked.size <= PIN_LIMITS.pinsMax * 2, 'readSentChats: one read per chat a pin went to');
}

// A run follows its chat: when the turn of the pin it sent last ends well, the next pin goes; when it ends any
// other way, the run is held until the person continues it.
function followRun(): void {
  const run = state.run;
  if (run === undefined || run.held === 'paused') {
    return;
  }
  // A reply waiting to go (an answer to a pin's question) goes first; the run moves on after it.
  const queued = aiState().queue.get(run.chat)?.length ?? 0;
  if (queued > 0 && !aiState().queuePaused.has(run.chat)) {
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
    holdRun();
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
  const stop = subscribeAiState(followChatsChange);
  following = stop;
  followChatsChange();
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
  chatsAsked = new Set();
  navigator = undefined;
  mover = undefined;
  state = INITIAL;
}
