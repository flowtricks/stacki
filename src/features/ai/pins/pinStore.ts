// Comment pins in the renderer (docs/contracts.md, "Comment pins"): the project's board and its images, whether
// comment mode is on, which pin's popover is open, the saving of the board, and "Send all". The state lives outside
// React, as the chat store's does (aiStore.ts), so pins keep streaming their progress while the panel is closed.
//
// The canvas side (where a click lands, where an element is, what a crop photographs) is the Desktop shell's
// (src/app/shell/DesktopPins.tsx): it installs a navigator here to show a pin's element, and calls `dropPin` and
// `capturePinCrop` with what the canvas measured. Comment mode registers its button in the AI panel's header
// (panelModes.ts) only while that host is mounted, so a surface without it (Studio) never offers the mode.
//
// "Send all" always starts at once, whatever else is running. It goes to the chat open in the panel (a new one when
// none is) while that chat is idle; while it is answering, the pins get a chat of their own in the background, so the
// reply goes on untouched. For an agent whose subagents the panel can follow (Claude) a send is one message and each
// pin becomes its own subagent there. Otherwise (Codex) each pin is a message in a chat of its own, all sent at once.
// Each send is its own chat's reply: stopping or answering one leaves the others alone.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import { isDangerousMode, pinSendMode } from '../../../../shared/properties/ai/agentPresentation';
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
import {
  aiState,
  holdChatViews,
  isChatIdle,
  loadChatView,
  newBackgroundChat,
  newChat,
  openChat,
  preferredAgent,
  sendPinMessage,
  subscribeAiState,
} from '../aiStore';
import type { ChatSetting } from '../../../../shared/ipc/aiChat';
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
  pinRunning,
  unusedImages,
  type ImageOutcome,
  type PinModelChoice,
  type PinProgress,
} from './pinModel';

/** How long typing pauses before the board is saved. */
const SAVE_PAUSE_MS = 400;

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
  /** Pins on their way out: sent for, their reply not started yet. No second send takes them. */
  readonly sending: ReadonlySet<PinId>;
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
  sending: new Set(),
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

/** Reads the project's board. A pin stored as sent with no reply of its own (an older Stacki's queue) is a draft again. */
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
  if (pin === undefined || pin.delivery.kind === 'sent' || state.sending.has(pin.id) || !hasPersonContent(workingCopy(pin))) {
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
  const now = state.board.pins.find((pin) => pin.id === before.id);
  if (now !== undefined && (state.sending.has(now.id) || pinRunning(progressOf(now)))) {
    return 'restored'; // It was sent meanwhile and is at work: an older draft of it would let it run twice.
  }
  const present = now !== undefined;
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
    const restored = { ...withoutWaiting(before), number };
    const pins = present ? current.board.pins.map((pin) => (pin.id === before.id ? restored : pin)) : [...current.board.pins, restored];
    return { ...current, images, board: { ...current.board, pins } };
  });
  return 'restored';
}

// A pin stored as sent with no reply of its own is a draft again.
function withoutWaiting(pin: CommentPin): CommentPin {
  return pin.delivery.kind === 'sent' && pin.delivery.turn === undefined ? { ...pin, delivery: { kind: 'draft' } } : pin;
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
  if (pin === undefined || pin.delivery.kind === 'sent' || state.sending.has(id)) {
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

/** A sent pin back to a draft, to change and send again. Not while it is at work: a pin never runs twice at once. */
export function reopenSentPin(id: PinId): void {
  const pin = state.board.pins.find((candidate) => candidate.id === id);
  if (pin === undefined || pinRunning(progressOf(pin))) {
    return;
  }
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

/** Where "Send all" stands: nothing to send (there is no Send), ready (and how), or why not. */
export type SendReadiness =
  | { readonly kind: 'empty'; readonly count: 0 }
  | { readonly kind: 'ready'; readonly mode: PinSendMode; readonly count: number }
  | { readonly kind: 'blocked'; readonly reason: 'not-ready'; readonly count: number };

/** The saved, included drafts no send has taken yet. */
function pinsWaiting(pins: PinState): readonly CommentPin[] {
  return pinsToSend(pins.board).filter((pin) => !pins.sending.has(pin.id));
}

/**
 * Whether "Send all" can go now: something to send and its agent ready. What is already running, in the open chat or
 * any other, never holds a send back.
 */
export function sendReadiness(pins: PinState, ai: ReturnType<typeof aiState>): SendReadiness {
  const count = pinsWaiting(pins).length;
  if (count === 0) {
    return { kind: 'empty', count: 0 };
  }
  const agent = pinAgent(ai);
  if (!ai.trusted || ai.agents.find((entry) => entry.agent === agent)?.state !== 'ready') {
    return { kind: 'blocked', reason: 'not-ready', count };
  }
  return { kind: 'ready', mode: pinSendMode(agent), count };
}

/** Chats made for messages still on their way: no sent pin names them yet, and their transcripts must be kept. */
const posting = new Set<ChatId>();

/** Where one message of a send goes: a chat that exists, or a chat still to be made for it. */
type SendTarget = { readonly kind: 'chat'; readonly chat: ChatId } | { readonly kind: 'own' };

/** What every message of one send shares. */
interface Send {
  readonly agent: AgentId;
  readonly mode: PinSendMode;
  /** The chat open when the send began: its settings are what a chat made for the send starts with. */
  readonly from: ChatId | undefined;
  readonly translate: Translator;
}

/** One message of a send as it ended: the chat its reply runs in, and whether that chat was made for it in the background. */
type Sent = { readonly kind: 'sent'; readonly chat: ChatId; readonly where: 'open' | 'own' } | { readonly kind: 'refused' };

/**
 * Sends every included draft, now. One message for all of them where the agent's subagents can be followed, else one
 * message a pin, all at once. A message goes to the open chat when that chat is idle (a new one, opened, when none
 * is open), else to a chat of its own in the background. Never runs by itself: only the person's "Send all" calls it.
 * The pins are taken before anything is waited for, so a second press cannot send them again. True when any went.
 */
export async function sendAllPins(translate: Translator): Promise<boolean> {
  const readiness = sendReadiness(state, aiState());
  if (readiness.kind !== 'ready') {
    return false;
  }
  const pins = pinsWaiting(state);
  const projectPath = state.projectPath;
  take(pins, 'take');
  try {
    const send: Send = { agent: pinAgent(aiState()), mode: readiness.mode, from: aiState().open, translate };
    const messages = send.mode === 'subagents' ? [pins] : pins.map((pin) => [pin]);
    const first = await firstTarget(send, messages);
    if (first === undefined) {
      return false;
    }
    const sent = await Promise.all(messages.map((message, index) => sendMessage(send, message, index === 0 ? first : { kind: 'own' })));
    if (state.projectPath === projectPath) {
      announce(sent, translate);
    }
    return sent.some((outcome) => outcome.kind === 'sent');
  } finally {
    take(pins, 'release');
  }
}

// Where the first message goes. With no chat open, a new one is made and opened, as the composer's first message
// would. The open chat takes a message only while it is idle, and a chat is never switched to another model for a pin:
// one pin of its own with a chosen model goes to a chat made with that model.
async function firstTarget(send: Send, messages: readonly (readonly CommentPin[])[]): Promise<SendTarget | undefined> {
  if (send.from === undefined) {
    const alone = messages.length === 1 && !(send.mode === 'single' && messages[0]?.[0]?.model !== undefined);
    if (!alone) {
      return { kind: 'own' };
    }
    const chat = await newChat(send.agent);
    return chat === undefined ? undefined : { kind: 'chat', chat };
  }
  const switches = send.mode === 'single' && messages[0]?.[0]?.model !== undefined;
  const several = messages.length > 1;
  return isChatIdle(send.from) && !switches && !several ? { kind: 'chat', chat: send.from } : { kind: 'own' };
}

// Sends one message of a send. A chat that turns out to be taken (a reply began there in the same moment) is left to
// it: the pins go to a chat of their own.
async function sendMessage(send: Send, pins: readonly CommentPin[], target: SendTarget): Promise<Sent> {
  if (target.kind === 'chat') {
    const outcome = await post(send, pins, target.chat);
    if (outcome !== 'taken') {
      const opened = send.from === undefined || target.chat === send.from;
      return outcome === 'sent' ? { kind: 'sent', chat: target.chat, where: opened ? 'open' : 'own' } : { kind: 'refused' };
    }
  }
  // Held from the moment it is made: other chats of the same send arrive while this one's message is on its way.
  const chat = await newBackgroundChat(send.agent, ownChatSettings(send, pins), (made) => posting.add(made));
  if (chat === undefined) {
    return { kind: 'refused' };
  }
  const outcome = await post(send, pins, chat);
  posting.delete(chat);
  if (outcome === 'taken') {
    reportErrorToast(send.translate('ai.error.stillAnswering'));
  }
  return outcome === 'sent' ? { kind: 'sent', chat, where: 'own' } : { kind: 'refused' };
}

async function post(send: Send, pins: readonly CommentPin[], chat: ChatId): Promise<'sent' | 'taken' | 'refused'> {
  const summary = (sent: readonly CommentPin[]): string => pinSummaryText(sent, send.translate);
  // A one-pin message runs on its chat's model, which was set when the chat was made: the card names what ran.
  const modelOf = modelsFor(pins, send.agent, send.from ?? chat, send.translate);
  const message = pinMessage(pins, send.mode, (id) => state.images.get(id), summary, modelOf);
  const outcome = await sendPinMessage(chat, pinPrompt(message));
  if (outcome.kind !== 'sent') {
    return outcome.kind;
  }
  markSent(pins, { chat, turn: outcome.turn, mode: send.mode });
  if (aiState().open === chat) {
    void openChat(chat);
  }
  return 'sent';
}

/**
 * The settings a chat made for a send starts with: those of the chat that was open (its model, effort and mode), and
 * a one-pin message's chosen model. A mode that skips every permission is never carried into another chat.
 */
function ownChatSettings(send: Send, pins: readonly CommentPin[]): readonly ChatSetting[] {
  const open = aiState().chats.find((candidate) => candidate.id === send.from);
  const options = pinAgentOptions(aiState(), send.agent, send.from);
  const carried = open?.agent === send.agent ? options : [];
  const settings = carried
    .filter((option) => !((option.category === 'mode' || option.id === 'mode') && isDangerousMode(send.agent, option.currentValue)))
    .map((option) => ({ option: option.id, value: option.currentValue }));
  const model = options.find((option) => option.id === 'model' || option.category === 'model');
  const chosen = send.mode === 'single' ? pins[0]?.model : undefined;
  if (model === undefined || chosen === undefined || resolvePinModel({ model: chosen }, send.agent, options).kind !== 'chosen') {
    return settings;
  }
  return [...settings.filter((setting) => setting.option !== model.id), { option: model.id, value: chosen.value }];
}

// Pins that went to chats of their own are said once, with the way there: the person's own chat did not change.
function announce(sent: readonly Sent[], translate: Translator): void {
  const own = sent.flatMap((outcome) => (outcome.kind === 'sent' && outcome.where === 'own' ? [outcome.chat] : []));
  const first = own[0];
  if (first === undefined) {
    return;
  }
  const message = translate('ai.pins.ownChats', { count: own.length });
  reportActionToast(message, 'info', [{ label: translate('ai.pins.showChat'), run: () => void openChat(first) }]);
}

// Marks pins as on their way, or gives them back.
function take(pins: readonly CommentPin[], how: 'take' | 'release'): void {
  update((current) => {
    const sending = new Set(current.sending);
    for (const pin of pins) {
      if (how === 'take') {
        sending.add(pin.id);
      } else {
        sending.delete(pin.id);
      }
    }
    assert(sending.size <= PIN_LIMITS.pinsMax * 2, 'take: pins on their way are bounded by the board');
    return { ...current, sending };
  });
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

// Every change of the chats: pins whose work finished well are deleted.
function followChatsChange(): void {
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

let following: (() => void) | undefined;

/** Starts following the chats for pins' progress; returns the stop. Called by the host while it is mounted. */
export function followChats(): () => void {
  following?.();
  // A sent pin's chat stays readable however many other chats there are: how the pin stands is read from it.
  holdChatViews(() => new Set([...posting, ...state.board.pins.flatMap((pin) => (pin.delivery.kind === 'sent' ? [pin.delivery.chat] : []))]));
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
  // Taken by a send whose reply has not started: waiting, for the moment that takes.
  return delivery.kind === 'draft' && state.sending.has(pin.id) ? { kind: 'queued' } : pinProgress(pin, view);
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
  posting.clear();
  chatsAsked = new Set();
  navigator = undefined;
  mover = undefined;
  state = INITIAL;
}
