// The AI panel's state, kept outside React: the panel can be docked, popped out
// or closed and its chats keep streaming, and "Fix with AI" can start a chat
// with no panel mounted. Components read it with `useAiState`; every change
// goes through the functions below, which are the only writers.
//
// Events arrive batched from main (`ai:events`); each batch is folded into its
// chat's view (chatReducer.ts) and then acknowledged, so main's flow control
// tracks what the renderer has applied, not merely received.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AgentAvailability, AiFailure, PromptAttachment, ReviewAction, ReviewOutcome, SetupAction, SetupState } from '../../../shared/ipc/aiChat';
import { AGENT_IDS, type AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { ChatId, ChatOption, ChatSummary, PermissionRequestId, TurnId } from '../../../shared/properties/ai/chatModel';
import {
  acknowledgeAiEvents,
  aiAgents,
  aiCancel,
  aiChatCreate,
  aiChatDelete,
  aiChatRead,
  aiChats,
  aiChatUpdate,
  aiInstallAgent,
  aiPermission,
  aiPrompt,
  aiReview,
  aiSetOption,
  aiTrust,
  onAiAgentStatus,
  onAiEvents,
  onAiSetup,
  aiSetup,
} from './aiBridge';
import { EMPTY_CHAT, reduceChat, type ChatView } from './chatReducer';

/** What a draft carries before it is sent. Images are already encoded (chatImages.ts). */
export interface DraftAttachment {
  readonly id: string;
  readonly attachment: PromptAttachment;
  /** A data URL for the thumbnail; undefined for files. */
  readonly preview: string | undefined;
}

export interface ChatDraft {
  readonly text: string;
  readonly attachments: readonly DraftAttachment[];
}

export interface AiState {
  readonly projectPath: string | undefined;
  readonly loaded: boolean;
  readonly trusted: boolean;
  readonly agents: readonly AgentAvailability[];
  /** Each agent's settings as it last reported them (models, efforts), for a chat not started yet. */
  readonly agentOptions: ReadonlyMap<AgentId, readonly ChatOption[]>;
  readonly chats: readonly ChatSummary[];
  /** Each agent's own CLI: installed, signed in (the guided setup, agentSetup.ts). */
  readonly setups: ReadonlyMap<AgentId, SetupState>;
  readonly open: ChatId | undefined;
  readonly views: ReadonlyMap<ChatId, ChatView>;
  readonly drafts: ReadonlyMap<ChatId, ChatDraft>;
  readonly error: string | undefined;
}

/** Chats whose transcripts stay in memory at once; the oldest others are read again when opened. */
const VIEWS_MAX = 16;

const INITIAL: AiState = {
  projectPath: undefined,
  loaded: false,
  trusted: false,
  agents: [],
  agentOptions: new Map(),
  chats: [],
  setups: new Map(),
  open: undefined,
  views: new Map(),
  drafts: new Map(),
  error: undefined,
};

let state: AiState = INITIAL;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;

export function aiState(): AiState {
  return state;
}

export function useAiState(): AiState {
  return useSyncExternalStore(subscribe, aiState, aiState);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(change: (current: AiState) => AiState): void {
  state = change(state);
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Points the store at `projectPath` and reads its agents and chats. Safe to call again. */
export async function loadAiProject(projectPath: string): Promise<void> {
  assert(projectPath.length > 0, 'loadAiProject: a project is named');
  listen();
  if (state.projectPath !== projectPath) {
    update(() => ({ ...INITIAL, projectPath }));
  }
  const [agents, chats] = await Promise.all([aiAgents(projectPath), aiChats(projectPath)]);
  if (state.projectPath !== projectPath) {
    return; // Another project opened meanwhile.
  }
  update((current) => ({
    ...current,
    loaded: true,
    trusted: agents.ok ? agents.value.trusted : current.trusted,
    agents: agents.ok ? agents.value.agents : current.agents,
    agentOptions: agents.ok ? new Map(agents.value.options.map((entry) => [entry.agent, entry.options])) : current.agentOptions,
    chats: chats.ok ? chats.value : current.chats,
    error: firstError(agents, chats),
  }));
}

export function resetAiStore(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  state = INITIAL;
}

export async function trustProject(): Promise<void> {
  const projectPath = requireProject();
  const reply = await aiTrust(projectPath);
  update((current) => ({ ...current, trusted: reply.ok ? true : current.trusted, error: reply.ok ? undefined : reply.error.message }));
  if (reply.ok) {
    // Trusted now: main may ask the agents for their real models and efforts.
    await loadAiProject(projectPath);
  }
}

export async function installAgent(agent: AgentId): Promise<void> {
  const projectPath = requireProject();
  setAgent({ agent, state: 'installing' });
  const reply = await aiInstallAgent({ projectPath, agent });
  setAgent(reply.ok ? reply.value : { agent, state: 'failed', message: reply.error.message });
}

/** A new chat with `agent`, starting with the settings last chosen for it (rememberSettings). */
export async function newChat(agent: AgentId): Promise<ChatId | undefined> {
  const projectPath = requireProject();
  const settings = rememberedSettings(agent);
  const reply = await aiChatCreate({ projectPath, agent, ...(settings.length === 0 ? {} : { settings }) });
  if (!reply.ok) {
    fail(reply.error);
    return undefined;
  }
  const chat = reply.value;
  update((current) => ({
    ...current,
    chats: [chat, ...current.chats.filter((other) => other.id !== chat.id)],
    open: chat.id,
    views: withView(current.views, chat.id, EMPTY_CHAT),
  }));
  return chat.id;
}

export async function openChat(chat: ChatId | undefined): Promise<void> {
  update((current) => ({ ...current, open: chat }));
  if (chat !== undefined) {
    rememberOpenChat(chat);
  }
  if (chat === undefined || state.views.has(chat)) {
    return;
  }
  const projectPath = requireProject();
  const reply = await aiChatRead({ projectPath, chat });
  if (!reply.ok) {
    fail(reply.error);
    return;
  }
  update((current) => ({ ...current, views: withView(current.views, chat, reduceChat(EMPTY_CHAT, reply.value.events)) }));
}

export async function renameChat(chat: ChatId, title: string): Promise<void> {
  await changeChat(chat, { title });
}

export async function pinChat(chat: ChatId, change: { readonly pinned: boolean }): Promise<void> {
  await changeChat(chat, change);
}

export async function deleteChat(chat: ChatId): Promise<void> {
  const projectPath = requireProject();
  const reply = await aiChatDelete({ projectPath, chat });
  if (!reply.ok) {
    fail(reply.error);
    return;
  }
  update((current) => {
    const views = new Map(current.views);
    views.delete(chat);
    return { ...current, chats: current.chats.filter((other) => other.id !== chat), open: current.open === chat ? undefined : current.open, views };
  });
}

export function setDraft(chat: ChatId, change: (draft: ChatDraft) => ChatDraft): void {
  update((current) => {
    const drafts = new Map(current.drafts);
    const next = change(current.drafts.get(chat) ?? { text: '', attachments: [] });
    assert(next.attachments.length <= AI_LIMITS.attachmentsMax, 'setDraft: attachments are bounded');
    drafts.set(chat, { text: next.text.slice(0, AI_LIMITS.promptCharsMax), attachments: next.attachments });
    return { ...current, drafts };
  });
}

/** Sends the chat's draft, or `text` when given (Retry, a hand-off). True when the agent took it. */
export async function sendPrompt(chat: ChatId, text?: string): Promise<boolean> {
  const projectPath = requireProject();
  const draft = state.drafts.get(chat) ?? { text: '', attachments: [] };
  const prompt = text ?? draft.text;
  const attachments = text === undefined ? draft.attachments.map((entry) => entry.attachment) : [];
  if (prompt.trim() === '' && attachments.length === 0) {
    return false;
  }
  if (text === undefined) {
    setDraft(chat, () => ({ text: '', attachments: [] }));
  }
  const reply = await aiPrompt({ projectPath, chat, text: prompt, attachments });
  if (!reply.ok) {
    if (text === undefined) {
      setDraft(chat, () => draft); // Nothing was sent: the words are not lost.
    }
    fail(reply.error);
    if (reply.error.code === 'not-trusted') {
      update((current) => ({ ...current, trusted: false }));
    }
    return false;
  }
  return true;
}

export async function stopChat(chat: ChatId): Promise<void> {
  await aiCancel({ projectPath: requireProject(), chat });
}

export async function answerPermission(chat: ChatId, request: PermissionRequestId, optionId: string | undefined): Promise<void> {
  const reply = await aiPermission({
    projectPath: requireProject(),
    chat,
    request,
    answer: optionId === undefined ? { kind: 'cancel' } : { kind: 'option', optionId },
  });
  if (!reply.ok) {
    fail(reply.error);
  }
}

export async function setChatOption(chat: ChatId, option: string, value: string): Promise<void> {
  const reply = await aiSetOption({ projectPath: requireProject(), chat, option, value });
  if (!reply.ok) {
    fail(reply.error);
  }
}

export function reviewChange(chat: ChatId, turn: TurnId, path: string, action: ReviewAction): Promise<ReviewOutcome> {
  return aiReview({ projectPath: requireProject(), chat, turn, path, action });
}

export function dismissAiError(): void {
  update((current) => ({ ...current, error: undefined }));
}

/** Applies one pushed batch; exported for tests, which drive the store without IPC. */
export function receiveEvents(push: { readonly projectPath: string; readonly chat: ChatId; readonly events: Parameters<typeof reduceChat>[1] }): void {
  if (push.projectPath !== state.projectPath) {
    return;
  }
  update((current) => {
    const view = current.views.get(push.chat);
    const views = view === undefined ? current.views : withView(current.views, push.chat, reduceChat(view, push.events));
    const title = [...push.events].reverse().find((event) => event.kind === 'title');
    const chats =
      title?.kind === 'title'
        ? current.chats.map((chat) => (chat.id === push.chat ? { ...chat, title: title.title, updatedAt: Date.now() } : chat))
        : current.chats;
    return { ...current, views, chats };
  });
}

// ---------------------------------------------------------------------------

function listen(): void {
  if (unsubscribe !== undefined) {
    return;
  }
  const events = onAiEvents((push) => {
    receiveEvents(push);
    acknowledgeAiEvents(push.chars);
  });
  const status = onAiAgentStatus((push) => {
    if (push.projectPath === state.projectPath) {
      setAgent(push.availability);
      const options = push.options;
      if (options !== undefined) {
        update((current) => ({ ...current, agentOptions: new Map([...current.agentOptions, [push.availability.agent, options]]) }));
      }
    }
  });
  const setup = onAiSetup((next) => setSetup(next));
  unsubscribe = () => {
    events();
    status();
    setup();
  };
}

function setAgent(availability: AgentAvailability): void {
  update((current) => ({
    ...current,
    agents: current.agents.some((agent) => agent.agent === availability.agent)
      ? current.agents.map((agent) => (agent.agent === availability.agent ? availability : agent))
      : [...current.agents, availability],
  }));
}

async function changeChat(chat: ChatId, change: { readonly title?: string; readonly pinned?: boolean }): Promise<void> {
  const reply = await aiChatUpdate({ projectPath: requireProject(), chat, ...change });
  if (!reply.ok) {
    fail(reply.error);
    return;
  }
  update((current) => ({ ...current, chats: current.chats.map((other) => (other.id === chat ? reply.value : other)) }));
}

function withView(views: ReadonlyMap<ChatId, ChatView>, chat: ChatId, view: ChatView): ReadonlyMap<ChatId, ChatView> {
  const next = new Map(views);
  next.delete(chat);
  next.set(chat, view);
  // Oldest first in insertion order: the least recently changed transcripts leave first.
  for (const key of next.keys()) {
    if (next.size <= VIEWS_MAX) {
      break;
    }
    if (key !== state.open) {
      next.delete(key);
    }
  }
  assert(next.size <= VIEWS_MAX + 1, 'withView: transcripts in memory are bounded');
  return next;
}

function fail(error: AiFailure): void {
  update((current) => ({ ...current, error: error.message }));
}

function firstError(...replies: readonly { readonly ok: boolean; readonly error?: AiFailure }[]): string | undefined {
  return replies.find((reply) => !reply.ok)?.error?.message;
}

function requireProject(): string {
  const projectPath = state.projectPath;
  assert(projectPath !== undefined, 'aiStore: a project is loaded before the panel acts in it');
  return projectPath;
}

const PREFERRED_AGENT_KEY = 'stacki.ai.agent';

/** The agent a new chat uses: the last one chosen, else Claude. */
export function preferredAgent(): AgentId {
  let stored: string | undefined;
  try {
    stored = localStorage.getItem(PREFERRED_AGENT_KEY) ?? undefined;
  } catch {
    stored = undefined;
  }
  const remembered = AGENT_IDS.find((id) => id === stored);
  // Claude is the default; the composer's provider menu changes it, and the choice is remembered.
  const agent = remembered ?? 'claude';
  assert(AGENT_IDS.includes(agent), 'preferredAgent: a known agent');
  return agent;
}

export function rememberAgent(agent: AgentId): void {
  try {
    localStorage.setItem(PREFERRED_AGENT_KEY, agent);
  } catch {
    // A preference that cannot be stored is only forgotten.
  }
}

const SETTINGS_KEY_PREFIX = 'stacki.ai.settings.';

/** The settings last chosen for `agent` in the new-chat row, as option and value pairs. */
export function rememberedSettings(agent: AgentId): readonly { readonly option: string; readonly value: string }[] {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(`${SETTINGS_KEY_PREFIX}${agent}`) ?? '{}');
  } catch {
    stored = {};
  }
  if (typeof stored !== 'object' || stored === null) {
    return [];
  }
  const settings = Object.entries(stored)
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].length <= AI_LIMITS.idCharsMax && entry[1].length <= AI_LIMITS.idCharsMax,
    )
    .slice(0, AI_LIMITS.configOptionsMax)
    .map(([option, value]) => ({ option, value }));
  assert(settings.length <= AI_LIMITS.configOptionsMax, 'rememberedSettings: bounded');
  return settings;
}

export function rememberSetting(agent: AgentId, option: string, value: string): void {
  const current = Object.fromEntries(rememberedSettings(agent).map((setting) => [setting.option, setting.value]));
  try {
    localStorage.setItem(`${SETTINGS_KEY_PREFIX}${agent}`, JSON.stringify({ ...current, [option]: value }));
  } catch {
    // A preference that cannot be stored is only forgotten.
  }
}

/** One guided-setup step for `agent`: detect, install, sign in, paste a code, cancel, sign out. */
export async function runSetup(agent: AgentId, action: SetupAction): Promise<void> {
  const projectPath = requireProject();
  const reply = await aiSetup({ projectPath, agent, action });
  if (!reply.ok) {
    fail(reply.error);
    return;
  }
  setSetup(reply.value);
  if (reply.value.step === 'ready') {
    // Signed in: the agent's connector comes next, without a separate step for the person.
    const availability = state.agents.find((entry) => entry.agent === agent);
    if (availability?.state === 'needs-install' || availability?.state === 'missing-cli') {
      await installAgent(agent);
    }
  }
}

function setSetup(next: SetupState): void {
  update((current) => ({ ...current, setups: new Map([...current.setups, [next.agent, next]]) }));
}

const OPEN_CHAT_KEY_PREFIX = 'stacki.ai.open.';

/**
 * Opening the panel goes straight to a chat, never the list: the one open last
 * in this project, else the newest, else a new empty one with the preferred agent.
 */
export async function openStartingChat(): Promise<void> {
  const projectPath = requireProject();
  if (state.open !== undefined) {
    return;
  }
  let last: string | undefined;
  try {
    last = localStorage.getItem(`${OPEN_CHAT_KEY_PREFIX}${projectPath}`) ?? undefined;
  } catch {
    last = undefined;
  }
  const remembered = state.chats.find((chat) => chat.id === last);
  const newest = [...state.chats].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const chat = remembered ?? newest;
  if (chat !== undefined) {
    await openChat(chat.id);
    return;
  }
  await newChat(preferredAgent());
  assert(state.open !== undefined || state.error !== undefined, 'openStartingChat: a chat is open, or why not is shown');
}

function rememberOpenChat(chat: ChatId): void {
  const projectPath = state.projectPath;
  if (projectPath === undefined) {
    return;
  }
  try {
    localStorage.setItem(`${OPEN_CHAT_KEY_PREFIX}${projectPath}`, chat);
  } catch {
    // A preference that cannot be stored is only forgotten.
  }
}

/**
 * The composer's provider menu: a chat with no message yet becomes a chat with `agent` (the empty
 * one is replaced); one with messages stays as it is, and a new chat with `agent` opens.
 */
export async function switchProvider(chat: ChatId, agent: AgentId, options: { readonly started: boolean }): Promise<ChatId | undefined> {
  const before = state.chats.find((candidate) => candidate.id === chat);
  assert(before === undefined || before.agent !== agent, 'switchProvider: a different provider');
  const draft = state.drafts.get(chat);
  if (!options.started) {
    await deleteChat(chat);
  }
  const next = await newChat(agent);
  if (next !== undefined && draft !== undefined && !options.started) {
    setDraft(next, () => draft); // What the person had typed moves with them.
  }
  return next;
}

/** Settings chosen before the chat's session exists: stored with the chat, applied when it starts. */
export async function updateChatSettings(chat: ChatId, agent: AgentId): Promise<void> {
  const reply = await aiChatUpdate({ projectPath: requireProject(), chat, settings: rememberedSettings(agent) });
  if (!reply.ok) {
    fail(reply.error);
  }
}
