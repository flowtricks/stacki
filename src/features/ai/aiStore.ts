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
import type {
  AgentAvailability,
  AiFailure,
  DiffReply,
  PromptAttachment,
  ReviewAction,
  ReviewOutcome,
  SectionAction,
  SetupAction,
  SetupState,
} from '../../../shared/ipc/aiChat';
import { AGENT_IDS, type AgentId } from '../../../shared/properties/ai/agentIds';
import { AGENT_PRESENTATION } from '../../../shared/properties/ai/agentPresentation';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type {
  ChatEvent,
  ChatId,
  ChatList,
  ChatOption,
  ChatSection,
  ChatSummary,
  PermissionRequestId,
  SectionId,
  TurnId,
  TurnStop,
} from '../../../shared/properties/ai/chatModel';
import {
  plainTextOf,
  promptPartsOf,
  type BuiltinChipId,
  type ComposerSegments,
  type MentionCandidate,
  type MentionKind,
  type PromptPart,
} from '../../../shared/properties/ai/mentions';
import {
  acknowledgeAiEvents,
  aiAgents,
  aiCancel,
  aiChatCreate,
  aiChatDelete,
  aiChatFork,
  aiChatMove,
  aiChatRead,
  aiChats,
  aiChatUpdate,
  aiCompact,
  aiDiff,
  aiInstallAgent,
  aiMentions,
  aiPermission,
  aiPrompt,
  aiReview,
  aiSections,
  aiSetOption,
  aiSteer,
  aiTrust,
  onAiAgentStatus,
  onAiEvents,
  onAiSetup,
  aiSetup,
  type AiReply,
} from './aiBridge';
import { EMPTY_CHAT, reduceChat, type ChatView } from './chatReducer';
import { readStoredDrafts, writeStoredDrafts } from './draftStorage';

/** What a draft carries before it is sent. Images are already encoded (chatImages.ts). */
export interface DraftAttachment {
  readonly id: string;
  readonly attachment: PromptAttachment;
  /** A data URL for the thumbnail; undefined for files. */
  readonly preview: string | undefined;
}

/**
 * What the composer holds: text runs and mention chips in the order typed, and the attachments. The
 * plain text is `draftText(draft)`; a draft with no chip is one text run.
 */
export interface ChatDraft {
  readonly segments: ComposerSegments;
  readonly attachments: readonly DraftAttachment[];
}

export const EMPTY_DRAFT: ChatDraft = { segments: [], attachments: [] };

/** The draft as one string, each chip as the plain text a prompt carries for it (`@path`, `/skill`, a title). */
export function draftText(draft: ChatDraft): string {
  return plainTextOf(draft.segments);
}

/** A draft of plain text and no attachments (a hand-off, a restored message). */
export function draftFromText(text: string): ChatDraft {
  return { segments: text === '' ? [] : [{ kind: 'text', text }], attachments: [] };
}

/** The draft with its text replaced by `text`, attachments kept. A plain text box has no chips, so it is one run. */
export function draftWithText(draft: ChatDraft, text: string): ChatDraft {
  return { ...draft, segments: text === '' ? [] : [{ kind: 'text', text }] };
}

/** The draft with `text` added at the end after a space (dictation); chips stay where they are. */
export function draftWithAppendedText(draft: ChatDraft, text: string): ChatDraft {
  const last = draft.segments[draft.segments.length - 1];
  if (last?.kind === 'text') {
    const joined: ComposerSegments[number] = { kind: 'text', text: `${last.text}${last.text === '' ? '' : ' '}${text}` };
    return { ...draft, segments: [...draft.segments.slice(0, -1), joined] };
  }
  return { ...draft, segments: [...draft.segments, { kind: 'text', text }] };
}

/** Whether sending the draft would send nothing: no chip, only space for text, no attachment. */
export function isDraftEmpty(draft: ChatDraft): boolean {
  return draft.attachments.length === 0 && !draft.segments.some((segment) => segment.kind === 'chip' || segment.text.trim() !== '');
}

/**
 * The segments cut to what a prompt can carry: at most `composerSegmentsMax` segments, `mentionsMax` chips
 * and `promptCharsMax` characters of text, the rest dropped from the end. An editor keeps within these; the
 * cut is the store's backstop so no path (a paste, a restored draft) can hand the parser an oversized prompt.
 */
export function boundSegments(segments: ComposerSegments): ComposerSegments {
  const kept: ComposerSegments[number][] = [];
  let characters = 0;
  let chips = 0;
  for (const segment of segments) {
    if (kept.length >= AI_LIMITS.composerSegmentsMax) {
      break;
    }
    if (segment.kind === 'chip') {
      if (chips >= AI_LIMITS.mentionsMax) {
        continue;
      }
      chips += 1;
      kept.push(segment);
    } else {
      const room = AI_LIMITS.promptCharsMax - characters;
      if (room <= 0) {
        continue;
      }
      const text = segment.text.slice(0, room);
      characters += text.length;
      kept.push(text === segment.text ? segment : { kind: 'text', text });
    }
  }
  assert(kept.length <= AI_LIMITS.composerSegmentsMax, 'boundSegments: bounded segments');
  assert(characters <= AI_LIMITS.promptCharsMax, 'boundSegments: bounded text');
  return kept;
}

/** A message set aside while the agent works, sent when its turn ends (⌘⏎). Kept in this window's memory only. */
export interface QueuedPrompt {
  readonly id: string;
  /** The plain text, for the chip above the composer. */
  readonly text: string;
  readonly draft: ChatDraft;
}

/** What the chat list shows: a text search, and which chats count. */
export interface ChatListFilter {
  readonly query: string;
  readonly showArchived: boolean;
  readonly onlyUnread: boolean;
  readonly onlyPinned: boolean;
  /** Only chats with this agent; undefined: both. */
  readonly agent: AgentId | undefined;
}

export const DEFAULT_CHAT_FILTER: ChatListFilter = { query: '', showArchived: false, onlyUnread: false, onlyPinned: false, agent: undefined };

/** Whether the panel is on screen: a turn that ends in the open chat is read at once only when it is. */
export type PanelVisibility = 'visible' | 'hidden';

export interface AiState {
  readonly projectPath: string | undefined;
  readonly loaded: boolean;
  readonly trusted: boolean;
  readonly agents: readonly AgentAvailability[];
  /** Each agent's settings as it last reported them (models, efforts), for a chat not started yet. */
  readonly agentOptions: ReadonlyMap<AgentId, readonly ChatOption[]>;
  /** The project's chats in display order (pinned first within a section, then by rank), archived ones included. */
  readonly chats: readonly ChatSummary[];
  readonly sections: readonly ChatSection[];
  readonly filter: ChatListFilter;
  readonly visibility: PanelVisibility;
  /** Each agent's own CLI: installed, signed in (the guided setup, agentSetup.ts). */
  readonly setups: ReadonlyMap<AgentId, SetupState>;
  readonly open: ChatId | undefined;
  readonly views: ReadonlyMap<ChatId, ChatView>;
  readonly drafts: ReadonlyMap<ChatId, ChatDraft>;
  /** Messages waiting for the running turn to end, per chat, oldest first. */
  readonly queue: ReadonlyMap<ChatId, readonly QueuedPrompt[]>;
  /** Chats whose queue is held because their last turn did not end normally; shown as "Paused". */
  readonly queuePaused: ReadonlySet<ChatId>;
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
  sections: [],
  filter: DEFAULT_CHAT_FILTER,
  visibility: 'hidden',
  setups: new Map(),
  open: undefined,
  views: new Map(),
  drafts: new Map(),
  queue: new Map(),
  queuePaused: new Set(),
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
    flushDrafts(); // The old project's last words are stored before its state goes.
    update(() => ({ ...INITIAL, projectPath, visibility: state.visibility }));
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
    chats: chats.ok ? chats.value.chats : current.chats,
    sections: chats.ok ? chats.value.sections : current.sections,
    drafts: chats.ok ? withStoredDrafts(current.drafts, chats.value.chats, readStoredDrafts(projectPath)) : current.drafts,
    error: firstError(agents, chats),
  }));
}

export function resetAiStore(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  state = INITIAL;
}

/** Re-reads the chat list from the main process; for changes whose reply is one chat but which move others (pin, archive, create). */
export async function refreshChatList(): Promise<void> {
  const projectPath = requireProject();
  const reply = await aiChats(projectPath);
  if (!reply.ok) {
    fail(reply.error);
    return;
  }
  if (state.projectPath === projectPath) {
    applyList(reply.value);
  }
}

export function setChatListFilter(filter: ChatListFilter): void {
  update((current) => ({ ...current, filter }));
}

/** The panel mounts and unmounts with its window; a chat that is open while it is hidden is not being read. */
export function setPanelVisibility(visibility: PanelVisibility): void {
  update((current) => ({ ...current, visibility }));
  const open = state.open;
  if (visibility === 'visible' && open !== undefined && state.chats.find((chat) => chat.id === open)?.unread === true) {
    void markRead(open);
  }
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
  // The new chat shows at once; where it ranks among pinned chats and sections is the main process's to say.
  void refreshChatList();
  return chat.id;
}

export async function openChat(chat: ChatId | undefined): Promise<void> {
  update((current) => ({ ...current, open: chat }));
  if (chat !== undefined) {
    rememberOpenChat(chat);
    if (state.chats.find((candidate) => candidate.id === chat)?.unread === true) {
      void markRead(chat);
    }
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
  await changeChat(chat, { title }, { reorders: 'no' });
}

export async function pinChat(chat: ChatId, change: { readonly pinned: boolean }): Promise<void> {
  // A pinned chat moves to the top of its section, so the list is read again.
  await changeChat(chat, change, { reorders: 'yes' });
}

/** Takes a chat out of the list (it keeps its place, so a restore puts it back) and stops its agent session. */
export async function archiveChat(chat: ChatId): Promise<void> {
  await changeChat(chat, { archived: true }, { reorders: 'yes' });
  if (state.open === chat) {
    await openChat(undefined);
  }
}

export async function restoreChat(chat: ChatId): Promise<void> {
  await changeChat(chat, { archived: false }, { reorders: 'yes' });
}

export async function markUnread(chat: ChatId): Promise<void> {
  await changeChat(chat, { unread: true }, { reorders: 'no' });
}

export async function markRead(chat: ChatId): Promise<void> {
  await changeChat(chat, { unread: false }, { reorders: 'no' });
}

/** A copy of the chat right below it, with its transcript; opens the copy. */
export async function forkChat(chat: ChatId): Promise<ChatId | undefined> {
  const projectPath = requireProject();
  const reply = await aiChatFork({ projectPath, chat });
  if (!reply.ok) {
    fail(reply.error);
    return undefined;
  }
  await refreshChatList();
  await openChat(reply.value.id);
  return reply.value.id;
}

/** Puts a chat in `target.section` (undefined: the first, unsectioned one) before `target.before` (undefined: last). */
export async function moveChat(chat: ChatId, target: { readonly section: SectionId | undefined; readonly before: ChatId | undefined }): Promise<void> {
  assert(target.before !== chat, 'moveChat: a chat is not placed before itself');
  const reply = await aiChatMove({
    projectPath: requireProject(),
    chat,
    ...(target.section === undefined ? {} : { section: target.section }),
    ...(target.before === undefined ? {} : { before: target.before }),
  });
  if (reply.ok) {
    applyList(reply.value);
  } else {
    fail(reply.error);
  }
}

/** Starts a section and returns its id, or undefined when the main process refused (a repeated name, too many). */
export async function createSection(name: string): Promise<SectionId | undefined> {
  const known = new Set(state.sections.map((section) => section.id));
  const list = await changeSections({ kind: 'create', name });
  return list?.sections.find((section) => !known.has(section.id))?.id;
}

export async function renameSection(section: SectionId, name: string): Promise<void> {
  await changeSections({ kind: 'rename', section, name });
}

/** Deletes a section; its chats move to the first section, none is deleted. */
export async function deleteSection(section: SectionId): Promise<void> {
  await changeSections({ kind: 'delete', section });
}

export async function collapseSection(section: SectionId, change: { readonly collapsed: boolean }): Promise<void> {
  await changeSections({ kind: 'collapse', section, collapsed: change.collapsed });
}

/** Puts a section before `before` (undefined: last). */
export async function moveSection(section: SectionId, target: { readonly before: SectionId | undefined }): Promise<void> {
  await changeSections({ kind: 'move', section, before: target.before });
}

/** The `@` picker's rows for `query`: project files and skills. A failure is the caller's to show or ignore. */
export function mentionCandidates(query: string, kinds: readonly MentionKind[]): Promise<AiReply<readonly MentionCandidate[]>> {
  return aiMentions({ projectPath: requireProject(), query, kinds });
}

/** One pending file's text before and after a turn, for the changes card's inline diff. */
export function loadChangeDiff(chat: ChatId, turn: TurnId, path: string): Promise<AiReply<DiffReply>> {
  return aiDiff({ projectPath: requireProject(), chat, turn, path });
}

/** Asks the agent to compact its context now. The agent reports progress as compaction events. */
export async function compactChat(chat: ChatId): Promise<void> {
  const reply = await aiCompact({ projectPath: requireProject(), chat });
  if (!reply.ok) {
    fail(reply.error);
  }
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
    const drafts = new Map(current.drafts);
    drafts.delete(chat);
    const queue = new Map(current.queue);
    queue.delete(chat);
    const queuePaused = new Set(current.queuePaused);
    queuePaused.delete(chat);
    return {
      ...current,
      chats: current.chats.filter((other) => other.id !== chat),
      open: current.open === chat ? undefined : current.open,
      views,
      drafts,
      queue,
      queuePaused,
    };
  });
  schedulePersist();
}

export function setDraft(chat: ChatId, change: (draft: ChatDraft) => ChatDraft): void {
  update((current) => {
    const drafts = new Map(current.drafts);
    const next = change(current.drafts.get(chat) ?? EMPTY_DRAFT);
    assert(next.attachments.length <= AI_LIMITS.attachmentsMax, 'setDraft: attachments are bounded');
    // Delete then set: the map stays ordered by recency, which the stored drafts' bound relies on.
    drafts.delete(chat);
    drafts.set(chat, { segments: boundSegments(next.segments), attachments: next.attachments });
    return { ...current, drafts };
  });
  schedulePersist();
}

/** Registers where the bundled instructions of a built-in chip come from; the renderer holds their text, the main process never reads it. */
export function registerBuiltinChipText(resolve: (id: BuiltinChipId) => string): void {
  builtinChipText = resolve;
}

let builtinChipText: ((id: BuiltinChipId) => string) | undefined;

function builtinTextOf(id: BuiltinChipId): string {
  assert(builtinChipText !== undefined, 'aiStore: built-in chip text is registered before a chip can be sent');
  return builtinChipText(id);
}

/** What a prompt carries to the main process. `parts` only when the message has a chip: a plain message is plain text, as before. */
interface PromptContent {
  readonly text: string;
  readonly parts: readonly PromptPart[] | undefined;
  readonly attachments: readonly PromptAttachment[];
}

function contentOf(draft: ChatDraft): PromptContent {
  const hasChip = draft.segments.some((segment) => segment.kind === 'chip');
  return {
    text: draftText(draft),
    parts: hasChip ? promptPartsOf(draft.segments, builtinTextOf) : undefined,
    attachments: draft.attachments.map((entry) => entry.attachment),
  };
}

function partsField(content: PromptContent): { readonly parts?: readonly PromptPart[] } {
  return content.parts === undefined ? {} : { parts: content.parts };
}

function submitPrompt(chat: ChatId, content: PromptContent): Promise<AiReply<{ readonly turn: TurnId }>> {
  return aiPrompt({ projectPath: requireProject(), chat, text: content.text, attachments: content.attachments, ...partsField(content) });
}

function submitSteer(chat: ChatId, content: PromptContent): Promise<AiReply<unknown>> {
  return aiSteer({ projectPath: requireProject(), chat, text: content.text, attachments: content.attachments, ...partsField(content) });
}

/** What a refused send does to the panel: a sign-in failure is the sign-in card's, an untrusted project asks again. */
function reportSendFailure(error: AiFailure): void {
  // A sign-in failure is drawn by the sign-in card (the host publishes the agent's status); a toast would repeat it.
  if (error.code !== 'sign-in') {
    fail(error);
  }
  if (error.code === 'not-trusted') {
    update((current) => ({ ...current, trusted: false }));
  }
}

/** Sends the chat's draft, or `text` when given (Retry, a hand-off). True when the agent took it. */
export async function sendPrompt(chat: ChatId, text?: string): Promise<boolean> {
  const draft = state.drafts.get(chat) ?? EMPTY_DRAFT;
  const content = text === undefined ? contentOf(draft) : { text, parts: undefined, attachments: [] };
  if (content.text.trim() === '' && content.attachments.length === 0) {
    return false;
  }
  if (text === undefined) {
    setDraft(chat, () => EMPTY_DRAFT);
  }
  const reply = await submitPrompt(chat, content);
  if (!reply.ok) {
    if (text === undefined) {
      setDraft(chat, () => draft); // Nothing was sent: the words are not lost.
    }
    reportSendFailure(reply.error);
    return false;
  }
  return true;
}

/**
 * Sends the draft into the running turn (⏎ while the agent works). An agent that cannot take it, or
 * refuses, gets it later instead: it joins the queue, so the words are neither lost nor dropped.
 */
export async function steerPrompt(chat: ChatId): Promise<boolean> {
  const draft = state.drafts.get(chat) ?? EMPTY_DRAFT;
  if (isDraftEmpty(draft)) {
    return false;
  }
  setDraft(chat, () => EMPTY_DRAFT);
  const reply = await submitSteer(chat, contentOf(draft));
  if (reply.ok) {
    return true;
  }
  const queued = reply.error.code === 'unsupported' || reply.error.code === 'agent-failed' || reply.error.code === 'busy';
  if (queued && enqueue(chat, draft)) {
    if (state.views.get(chat)?.running === undefined) {
      void sendNextQueued(chat); // The turn ended while the steer was in flight: nothing to wait for.
    }
    return true;
  }
  setDraft(chat, () => draft);
  reportSendFailure(reply.error);
  return false;
}

/**
 * Sets the draft aside until the running turn ends (⌘⏎). With no turn running there is nothing to wait
 * for, so it sends. A queue that is full refuses the message and keeps the draft.
 */
export async function queuePrompt(chat: ChatId): Promise<boolean> {
  const draft = state.drafts.get(chat) ?? EMPTY_DRAFT;
  if (isDraftEmpty(draft)) {
    return false;
  }
  if (state.views.get(chat)?.running === undefined) {
    return sendPrompt(chat);
  }
  if (!enqueue(chat, draft)) {
    return false;
  }
  setDraft(chat, () => EMPTY_DRAFT);
  return true;
}

export function removeQueued(chat: ChatId, id: string): void {
  update((current) => {
    const remaining = (current.queue.get(chat) ?? []).filter((entry) => entry.id !== id);
    return { ...current, queue: withQueue(current.queue, chat, remaining) };
  });
}

/** Sends one queued message now: into the running turn, or as a new turn when none runs. A refusal leaves it queued. */
export async function sendQueuedNow(chat: ChatId, id: string): Promise<boolean> {
  const entry = (state.queue.get(chat) ?? []).find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return false;
  }
  removeQueued(chat, id);
  const content = contentOf(entry.draft);
  const reply = state.views.get(chat)?.running === undefined ? await submitPrompt(chat, content) : await submitSteer(chat, content);
  if (!reply.ok) {
    putBack(chat, entry);
    reportSendFailure(reply.error);
    return false;
  }
  return true;
}

/** Sends the held queue's first message and lifts the pause ("Resume"). */
export function resumeQueue(chat: ChatId): Promise<void> {
  update((current) => ({ ...current, queuePaused: withoutChat(current.queuePaused, chat) }));
  return state.views.get(chat)?.running === undefined ? sendNextQueued(chat) : Promise.resolve();
}

/** Adds to the chat's queue; false (and a message) when the queue is at its bound. */
function enqueue(chat: ChatId, draft: ChatDraft): boolean {
  const queued = state.queue.get(chat) ?? [];
  if (queued.length >= AI_LIMITS.queuedPromptsMax) {
    fail({ code: 'invalid', message: `Only ${AI_LIMITS.queuedPromptsMax} messages can wait. Send or remove one first.` });
    return false;
  }
  const entry: QueuedPrompt = { id: crypto.randomUUID(), text: draftText(draft), draft };
  update((current) => ({ ...current, queue: withQueue(current.queue, chat, [...(current.queue.get(chat) ?? []), entry]) }));
  return true;
}

/** A refused queued message returns to the front and the queue pauses: nothing sends itself after a failure. */
function putBack(chat: ChatId, entry: QueuedPrompt): void {
  update((current) => ({
    ...current,
    queue: withQueue(current.queue, chat, [entry, ...(current.queue.get(chat) ?? [])]),
    queuePaused: new Set([...current.queuePaused, chat]),
  }));
}

async function sendNextQueued(chat: ChatId): Promise<void> {
  const entry = (state.queue.get(chat) ?? [])[0];
  if (entry === undefined || state.queuePaused.has(chat)) {
    return;
  }
  // Out of the queue before the send, so a second trigger cannot send it twice.
  removeQueued(chat, entry.id);
  const reply = await submitPrompt(chat, contentOf(entry.draft));
  if (!reply.ok) {
    putBack(chat, entry);
    reportSendFailure(reply.error);
  }
}

function withQueue(queue: AiState['queue'], chat: ChatId, entries: readonly QueuedPrompt[]): AiState['queue'] {
  assert(entries.length <= AI_LIMITS.queuedPromptsMax, 'withQueue: the queue is bounded');
  const next = new Map(queue);
  if (entries.length === 0) {
    next.delete(chat);
  } else {
    next.set(chat, entries);
  }
  return next;
}

function withoutChat(chats: ReadonlySet<ChatId>, chat: ChatId): ReadonlySet<ChatId> {
  const next = new Set(chats);
  next.delete(chat);
  return next;
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
export function receiveEvents(push: { readonly projectPath: string; readonly chat: ChatId; readonly events: readonly ChatEvent[] }): void {
  if (push.projectPath !== state.projectPath) {
    return;
  }
  const lastOf = <K extends ChatEvent['kind']>(kind: K): Extract<ChatEvent, { readonly kind: K }> | undefined =>
    [...push.events].reverse().find((event): event is Extract<ChatEvent, { readonly kind: K }> => event.kind === kind);
  update((current) => {
    const view = current.views.get(push.chat);
    const views = view === undefined ? current.views : withView(current.views, push.chat, reduceChat(view, push.events));
    const title = lastOf('title');
    const usage = lastOf('usage');
    // The list mirrors what the main process stores from the same events, so a row shows them without a re-read.
    const chats =
      title === undefined && usage === undefined
        ? current.chats
        : current.chats.map((chat) =>
            chat.id === push.chat
              ? {
                  ...chat,
                  ...(title === undefined ? {} : { title: title.title, updatedAt: Date.now() }),
                  ...(usage === undefined ? {} : { context: { used: usage.used, size: usage.size } }),
                }
              : chat,
          );
    return { ...current, views, chats };
  });
  const ended = lastOf('turn-end');
  if (ended !== undefined && state.views.get(push.chat)?.running === undefined) {
    afterTurnEnd(push.chat, ended.stop);
  }
}

/**
 * A turn ended: the chat is read at once when it is open on screen, else marked unread (as the main process
 * marks it); and the next queued message goes only after a normal end, never after an error or a stop.
 */
function afterTurnEnd(chat: ChatId, stop: TurnStop): void {
  if (state.open === chat && state.visibility === 'visible') {
    void markRead(chat);
  } else {
    update((current) => ({ ...current, chats: current.chats.map((other) => (other.id === chat ? { ...other, unread: true } : other)) }));
  }
  if ((state.queue.get(chat) ?? []).length === 0) {
    return;
  }
  if (stop === 'end_turn') {
    update((current) => ({ ...current, queuePaused: withoutChat(current.queuePaused, chat) }));
    void sendNextQueued(chat);
  } else {
    update((current) => ({ ...current, queuePaused: new Set([...current.queuePaused, chat]) }));
  }
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
  const setup = onAiSetup((next) => {
    // A "ready" push while the agent's sign-in has expired is runSetup's to apply, together with the fresh availability
    // (one update, no flash of the expired card between the two).
    const expired = state.agents.some((entry) => entry.agent === next.agent && entry.state === 'sign-in');
    if (next.step !== 'ready' || !expired) {
      setSetup(next);
    }
  });
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

interface ChatChange {
  readonly title?: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly unread?: boolean;
}

/** `reorders: 'yes'` for a change that moves other chats too, so the list is read again after it. */
async function changeChat(chat: ChatId, change: ChatChange, effect: { readonly reorders: 'yes' | 'no' }): Promise<void> {
  const reply = await aiChatUpdate({ projectPath: requireProject(), chat, ...change });
  if (!reply.ok) {
    fail(reply.error);
    return;
  }
  update((current) => ({ ...current, chats: current.chats.map((other) => (other.id === chat ? reply.value : other)) }));
  if (effect.reorders === 'yes') {
    await refreshChatList();
  }
}

async function changeSections(action: SectionAction): Promise<ChatList | undefined> {
  const reply = await aiSections({ projectPath: requireProject(), action });
  if (!reply.ok) {
    fail(reply.error);
    return undefined;
  }
  applyList(reply.value);
  return reply.value;
}

/** The main process's list replaces the renderer's whole: replies to list changes are never merged. */
function applyList(list: ChatList): void {
  update((current) => ({ ...current, chats: list.chats, sections: list.sections }));
}

// ---------------------------------------------------------------------------
// Drafts kept across reloads (draftStorage.ts)
// ---------------------------------------------------------------------------

/** How long typing pauses before the drafts are written; a keystroke does not touch storage. */
const PERSIST_DELAY_MS = 400;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePersist(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
  }
  const projectPath = state.projectPath;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (projectPath !== undefined && state.projectPath === projectPath) {
      writeStoredDrafts(projectPath, new Map([...state.drafts].map(([chat, draft]) => [chat, draft.segments])));
    }
  }, PERSIST_DELAY_MS);
}

/** Writes the drafts now; for the moment a project's state is about to be replaced. */
function flushDrafts(): void {
  if (persistTimer === undefined) {
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = undefined;
  if (state.projectPath !== undefined) {
    writeStoredDrafts(state.projectPath, new Map([...state.drafts].map(([chat, draft]) => [chat, draft.segments])));
  }
}

/** Restores stored drafts for chats that exist and have nothing typed in this window yet. */
function withStoredDrafts(
  drafts: ReadonlyMap<ChatId, ChatDraft>,
  chats: readonly ChatSummary[],
  stored: ReadonlyMap<ChatId, ComposerSegments>,
): ReadonlyMap<ChatId, ChatDraft> {
  const known = new Set(chats.map((chat) => chat.id));
  const next = new Map(drafts);
  for (const [chat, segments] of stored) {
    if (known.has(chat) && !next.has(chat)) {
      next.set(chat, { segments: boundSegments(segments), attachments: [] });
    }
  }
  assert(next.size <= drafts.size + stored.size, 'withStoredDrafts: only stored drafts were added');
  return next;
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

/**
 * The options whose value is never remembered between chats: the mode (and Codex's plan switch). A new chat
 * starts in the mode that asks first; a mode kept from an earlier chat, say "Bypass permissions", must not
 * carry its permissions into a chat the person did not choose them for. Values stored by an older build are ignored.
 */
function isModeOption(agent: AgentId, option: string): boolean {
  const modes = AGENT_PRESENTATION[agent].modes;
  return option === modes.optionId || option === modes.planOptionId;
}

/** The settings last chosen for `agent` in the new-chat row, as option and value pairs. Never a mode. */
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
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[0].length <= AI_LIMITS.idCharsMax && entry[1].length <= AI_LIMITS.idCharsMax && !isModeOption(agent, entry[0]),
    )
    .slice(0, AI_LIMITS.configOptionsMax)
    .map(([option, value]) => ({ option, value }));
  assert(settings.length <= AI_LIMITS.configOptionsMax, 'rememberedSettings: bounded');
  return settings;
}

export function rememberSetting(agent: AgentId, option: string, value: string): void {
  if (isModeOption(agent, option)) {
    return; // See isModeOption: a mode belongs to the chat it was chosen in.
  }
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
  if (reply.value.step === 'ready' && (action.kind === 'signIn' || action.kind === 'code')) {
    // Signed in: the host cleared its sign-in wait. Read the agent's availability first and apply it with the
    // setup in one update, so the sign-in card gives way without a flash of the old "expired" card.
    const agents = await aiAgents(projectPath);
    const fresh = agents.ok && state.projectPath === projectPath ? agents.value.agents : undefined;
    update((current) => ({
      ...current,
      agents: fresh ?? current.agents,
      setups: new Map([...current.setups, [reply.value.agent, reply.value]]),
    }));
  } else {
    setSetup(reply.value);
  }
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
  // An archived chat is out of the list, so the panel never opens on one.
  const listed = state.chats.filter((chat) => chat.archivedAt === undefined);
  const remembered = listed.find((chat) => chat.id === last);
  const newest = [...listed].sort((left, right) => right.updatedAt - left.updatedAt)[0];
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
