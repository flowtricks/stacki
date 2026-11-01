import { useSyncExternalStore } from 'react';
import { record, string } from '../../shared/validation';
import { parseImages, type ChatImage } from './chatContracts';
import type { ProposedChange } from './agent';

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
}
export interface ChatThread {
  readonly id: string;
  readonly title: string;
  readonly draft: string;
  readonly images: readonly ChatImage[];
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly status: 'idle' | 'working' | 'applying';
  readonly error: string;
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
    title: 'New chat',
    draft: '',
    images: [],
    model,
    messages: [],
    status: 'idle',
    error: '',
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
  if (state.threads.length >= 20) {
    return;
  }
  const chat = newThread(model);
  commit({ ...state, threads: [...state.threads, chat], active: chat.id });
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
    transaction.objectStore('chats').put({ threads: state.threads, active: state.active }, 'session');
    transaction.onerror = storageError;
  } catch {
    storageError();
  }
}
function storageError() {
  state = {
    ...state,
    ready: true,
    notice: 'Chat history could not be saved on this device. Keep this tab open.',
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
  const input = record(value);
  const raw = input['threads'];
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) {
    throw new Error('Invalid chats');
  }
  const threads = raw.map(parseThread);
  const active = string(input['active'], 100);
  state = {
    ...state,
    threads,
    active: threads.some((chat) => chat.id === active) ? active : (threads[0]?.id ?? ''),
  };
}
function parseThread(value: unknown): ChatThread {
  const chat = record(value);
  const messages = chat['messages'];
  if (!Array.isArray(messages) || messages.length > 40) {
    throw new Error('Invalid messages');
  }
  return {
    id: string(chat['id'], 100),
    title: string(chat['title'], 100),
    draft: string(chat['draft'], 12_000),
    images: parseImages(chat['images']),
    model: string(chat['model'], 160),
    messages: messages.map(parseMessage),
    status: 'idle',
    error: chat['status'] === 'idle' ? '' : 'This request was interrupted by a reload. Check the draft before retrying.',
  };
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
