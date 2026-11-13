import { useSyncExternalStore } from 'react';
import { studioTranslate } from './studioWords';
import { record, string } from '../../shared/validation';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { parseDraftSegments, plainTextOf, type ComposerSegments } from '../../../vendor/stacki/shared/properties/ai/mentions';
import { applyMove, type DragSection, type DropMove } from '../../../vendor/stacki/src/ui/sectionedDragModel';
import { parseImages, type ChatImage } from './chatContracts';
import type { ProposedChange } from './agent';

/** The most chats a project keeps; the oldest cannot be dropped silently, so a new chat waits for a delete. */
export const CHATS_MAX = 20;
/** The longest a chat's name may be, typed or derived from its first message. */
export const CHAT_TITLE_CHARS_MAX = 100;
/** The two groups of the chat list: pinned chats first, then the rest. */
export const PINNED_SECTION = 'pinned';
export const CHATS_SECTION = 'chats';
/** What the browser stores. Version 2 keeps the list in display order (pinned first, newest first); version 1 was oldest first. */
const STORED_VERSION = 2;

export interface ChatProposal {
  readonly id: string;
  readonly summary: string;
  readonly changes: readonly ProposedChange[];
}
export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly images: readonly ChatImage[];
  readonly proposal?: ChatProposal | undefined;
  readonly outcome?: string;
  /** How long the assistant worked on this reply; absent on replies stored before the timer existed. */
  readonly durationMs?: number | undefined;
}
export interface ChatThread {
  readonly id: string;
  readonly title: string;
  /** The draft as plain text, each chip as its `@path`; always `plainTextOf(segments)`, kept for what only needs the words. */
  readonly draft: string;
  /** The draft with its file chips; the composer edits this. */
  readonly segments: ComposerSegments;
  readonly images: readonly ChatImage[];
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly status: 'idle' | 'working' | 'applying';
  readonly error: string;
  /** Pinned chats are listed first. The list's order is the array's order, so a pinned chat is never after an unpinned one. */
  readonly pinned: boolean;
  /** When the chat last changed, in milliseconds; 0 for a chat stored before the list showed ages. */
  readonly updatedAt: number;
  /** When the running request began, for the live timer; only while `status` is not idle, and never stored. */
  readonly startedAt?: number | undefined;
}
interface ChatState {
  readonly threads: readonly ChatThread[];
  readonly active: string;
  readonly notice: string;
  readonly ready: boolean;
}
export function newThread(model = ''): ChatThread {
  return {
    id: crypto.randomUUID(),
    title: studioTranslate()('ai.sessions.newChat'),
    draft: '',
    segments: [],
    images: [],
    model,
    messages: [],
    status: 'idle',
    error: '',
    pinned: false,
    updatedAt: Date.now(),
  };
}
const first = newThread();
let state: ChatState = { threads: [first], active: first.id, notice: '', ready: false };
const listeners = new Set<() => void>();
let database: IDBDatabase | undefined;
let initialized = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function emit() {
  listeners.forEach((listener) => listener());
}
export function chatState() {
  return state;
}
export function useChats() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, chatState);
}
export function updateChat(id: string, update: (chat: ChatThread) => ChatThread) {
  commit({
    ...state,
    threads: state.threads.map((chat) => (chat.id === id ? update(chat) : chat)),
  });
}
export function selectChat(id: string) {
  commit({ ...state, active: id });
}
export function createChat(model: string) {
  if (state.threads.length >= CHATS_MAX) {
    return;
  }
  const chat = newThread(model);
  // The newest chat leads the unpinned chats, below the pinned ones.
  const pinned = state.threads.filter((thread) => thread.pinned);
  const rest = state.threads.filter((thread) => !thread.pinned);
  commit({ ...state, threads: [...pinned, chat, ...rest], active: chat.id });
}
/** Replaces the draft with `segments`, and keeps the plain text beside it in step. */
export function setDraftSegments(id: string, segments: ComposerSegments) {
  updateChat(id, (thread) => ({ ...thread, segments, draft: plainTextOf(segments) }));
}
/** Replaces the draft with plain text (a starter prompt, dictation); its chips, if any, become the words they stood for. */
export function setDraftText(id: string, text: string) {
  setDraftSegments(id, text === '' ? [] : [{ kind: 'text', text }]);
}
/** Gives a chat a name of its own. A blank or over-long name is ignored: the caller shows the limit before it gets here. */
export function renameChat(id: string, title: string) {
  const name = title.trim();
  if (name === '' || name.length > CHAT_TITLE_CHARS_MAX) {
    return;
  }
  updateChat(id, (thread) => ({ ...thread, title: name }));
}
/** Pins or unpins a chat; it moves to the end of the pinned chats, or to the top of the others. */
export function setPinned(id: string, pinned: boolean) {
  const chat = state.threads.find((thread) => thread.id === id);
  if (chat === undefined || chat.pinned === pinned) {
    return;
  }
  const others = state.threads.filter((thread) => thread.id !== id);
  const pinnedOthers = others.filter((thread) => thread.pinned);
  const unpinnedOthers = others.filter((thread) => !thread.pinned);
  const moved = { ...chat, pinned };
  commit({ ...state, threads: [...pinnedOthers, moved, ...unpinnedOthers] });
}
/** The list as the drag model sees it: two sections, in display order. */
export function chatSections(threads: readonly ChatThread[]): readonly DragSection[] {
  return [
    { id: PINNED_SECTION, collapsed: false, itemIds: threads.filter((thread) => thread.pinned).map((thread) => thread.id) },
    { id: CHATS_SECTION, collapsed: false, itemIds: threads.filter((thread) => !thread.pinned).map((thread) => thread.id) },
  ];
}
/** Applies a drag-to-reorder: the chat takes its new place, and the section it lands in decides whether it is pinned. */
export function moveChat(move: DropMove) {
  commit({ ...state, threads: reorder(state.threads, move) });
}
/** Pure form of `moveChat`, so the order rules can be tested without the store. */
export function reorder(threads: readonly ChatThread[], move: DropMove): readonly ChatThread[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const next = applyMove(chatSections(threads), move).flatMap((section) =>
    section.itemIds.flatMap((id) => {
      const thread = byId.get(id);
      return thread === undefined ? [] : [{ ...thread, pinned: section.id === PINNED_SECTION }];
    }),
  );
  assert(next.length === threads.length, 'reorder: a move keeps every chat');
  assert(new Set(next.map((thread) => thread.id)).size === next.length, 'reorder: a move keeps every chat once');
  return next;
}
export function deleteChat(id: string) {
  const remaining = state.threads.filter((chat) => chat.id !== id);
  const threads = remaining.length ? remaining : [newThread()];
  commit({
    ...state,
    threads,
    active: state.active === id ? (threads[0]?.id ?? '') : state.active,
  });
}
function commit(next: ChatState) {
  state = next;
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 150);
}
function save() {
  if (!database) {
    return;
  }
  try {
    const transaction = database.transaction('chats', 'readwrite');
    transaction.objectStore('chats').put({ version: STORED_VERSION, threads: state.threads.map(storable), active: state.active }, 'session');
    transaction.onerror = storageError;
  } catch {
    storageError();
  }
}
function storageError() {
  state = {
    ...state,
    ready: true,
    notice: studioTranslate()('ai.studio.storageFailed'),
  };
  emit();
}
export function initializeChats() {
  if (initialized) {
    return;
  }
  initialized = true;
  try {
    const open = indexedDB.open('studio-ai-chats', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('chats');
    };
    open.onerror = storageError;
    open.onsuccess = () => {
      database = open.result;
      const read = database.transaction('chats').objectStore('chats').get('session');
      read.onerror = storageError;
      read.onsuccess = () => {
        try {
          const value: unknown = read.result;
          if (value) {
            restore(value);
          }
          state = { ...state, ready: true };
          emit();
        } catch {
          storageError();
        }
      };
    };
  } catch {
    storageError();
  }
}
function restore(value: unknown) {
  const restored = restoreChats(value);
  state = { ...state, threads: restored.threads, active: restored.active };
}
/** The thread as it is kept in the browser: the live timer and the running status are not. */
function storable(thread: ChatThread): ChatThread {
  const { startedAt: _startedAt, ...rest } = thread;
  return rest;
}
/**
 * Reads what the browser stored. Version 1 (no `version`) listed chats oldest first and had no pins or ages, so it is
 * turned around into display order; version 2 is read as it is. Anything else is refused, which the caller shows as a
 * history that could not be read.
 */
export function restoreChats(value: unknown): { readonly threads: readonly ChatThread[]; readonly active: string } {
  const input = record(value);
  const raw = input['threads'];
  if (!Array.isArray(raw) || !raw.length || raw.length > CHATS_MAX) {
    throw new Error('Invalid chats');
  }
  const version = input['version'];
  if (version !== undefined && version !== STORED_VERSION) {
    throw new Error('Unknown chat history version');
  }
  const parsed = raw.map(parseThread);
  const threads = version === undefined ? [...parsed].reverse() : parsed;
  // Pinned chats lead, in the order they were stored; a stored list that breaks this is repaired, not refused.
  const ordered = [...threads.filter((thread) => thread.pinned), ...threads.filter((thread) => !thread.pinned)];
  const active = string(input['active'], 100);
  return { threads: ordered, active: ordered.some((chat) => chat.id === active) ? active : (ordered[0]?.id ?? '') };
}
function parseThread(value: unknown): ChatThread {
  const chat = record(value);
  const messages = chat['messages'];
  if (!Array.isArray(messages) || messages.length > 40) {
    throw new Error('Invalid messages');
  }
  const draft = string(chat['draft'], 12_000);
  const segments = parseSegments(chat['segments'], draft);
  return {
    id: string(chat['id'], 100),
    title: string(chat['title'], CHAT_TITLE_CHARS_MAX),
    draft: plainTextOf(segments),
    segments,
    images: parseImages(chat['images']),
    model: string(chat['model'], 160),
    messages: messages.map(parseMessage),
    status: 'idle',
    error: chat['status'] === 'idle' ? '' : studioTranslate()('ai.studio.interrupted'),
    pinned: chat['pinned'] === true,
    updatedAt: typeof chat['updatedAt'] === 'number' && Number.isSafeInteger(chat['updatedAt']) && chat['updatedAt'] >= 0 ? chat['updatedAt'] : 0,
  };
}
/** Chips come back when the stored draft is readable; otherwise the plain words are all the draft was. */
function parseSegments(value: unknown, draft: string): ComposerSegments {
  if (value !== undefined) {
    const result = parseDraftSegments(value);
    if (result.ok) {
      return result.value;
    }
  }
  return draft === '' ? [] : [{ kind: 'text', text: draft }];
}
function parseMessage(value: unknown): ChatMessage {
  const message = record(value);
  const role = message['role'];
  if (role !== 'user' && role !== 'assistant') {
    throw new Error('Invalid role');
  }
  return {
    id: string(message['id'], 100),
    role,
    content: string(message['content'], 12_000),
    images: parseImages(message['images']),
    ...(message['proposal'] ? { proposal: parseProposal(message['proposal']) } : {}),
    ...(message['outcome'] ? { outcome: string(message['outcome'], 300) } : {}),
    ...(typeof message['durationMs'] === 'number' && Number.isSafeInteger(message['durationMs']) && message['durationMs'] >= 0
      ? { durationMs: message['durationMs'] }
      : {}),
  };
}
export function parseProposal(value: unknown): ChatProposal {
  const input = record(value);
  const changes = input['changes'];
  if (!Array.isArray(changes) || changes.length > 20) {
    throw new Error('Invalid proposal');
  }
  return {
    id: string(input['id'], 100),
    summary: string(input['summary'], 4000),
    changes: changes.map((value) => {
      const change = record(value);
      return {
        file: string(change['file'], 500),
        before: string(change['before']),
        after: string(change['after']),
      };
    }),
  };
}
