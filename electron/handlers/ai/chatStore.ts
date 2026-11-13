// The AI panel's chats on disk. Private to this computer and never inside the
// project, so nothing here can be committed:
//
//   userData/ai/projects/<sha256(realpath of the project)>/
//     index.json          the chat list, its sections, the trust answer and each chat's agent session
//     chats/<id>.jsonl    one ChatEvent per line, appended in batches
//     reviews/<id>.json   the change ledger's pending reviews (changeLedger.ts)
//
// index.json and reviews are replaced whole (temporary file, then rename), so a
// crash leaves the old file or the new one. A transcript is append-only; a torn
// last line (a crash mid-append) or any line that fails `parseChatEvent` is
// skipped on read, never trusted. Every collection is bounded by AI_LIMITS.
//
// The index is version 2: chats carry a section, a rank within it, an archive
// time, an unread flag, the last context usage and the chat they were forked
// from; sections are named, ordered and collapsible. A version 1 index reads as
// version 2 (`parseChatIndex`) and is written back as version 2 on the next
// write; an older build reads a version 2 file as empty, so the migration is one
// way (docs/contracts.md, "Chat management"). The list operations below are pure
// functions over the index, so their properties are tested without a disk.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import { toArray, toRecord } from '../../../shared/core/record';
import { err, ok, type Result } from '../../../shared/core/result';
import { parseChatSettings, type AiFailure, type ChatSetting } from '../../../shared/ipc/aiChat';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { described } from './aiMessages';
import {
  parseChatEvent,
  parseChatSection,
  parseChatSummary,
  parseChatSummaryLegacy,
  toChatId,
  toSectionId,
  type ChatEvent,
  type ChatId,
  type ChatList,
  type ChatSection,
  type ChatSummary,
  type SectionId,
} from '../../../shared/properties/ai/chatModel';

/**
 * Where a chat's title came from, which decides what may replace it: the first line of the first
 * prompt is a placeholder, the agent's own title replaces the placeholder (and a newer agent title
 * replaces an older one), and a title the person typed is never replaced. Older records have no
 * source and read as 'first-line'.
 */
export const TITLE_SOURCES = ['first-line', 'ai', 'user'] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];

/** A chat as the index keeps it: the summary, and the agent session it continues. */
export interface ChatRecord extends ChatSummary {
  readonly titleSource: TitleSource;
  readonly sessionId: string | undefined;
  /** Settings chosen before the chat had a session, applied once it has one. */
  readonly settings: readonly ChatSetting[];
}

export interface ChatIndex {
  readonly version: 2;
  readonly trusted: boolean;
  readonly sections: readonly ChatSection[];
  readonly chats: readonly ChatRecord[];
}

const EMPTY_INDEX: ChatIndex = { version: 2, trusted: false, sections: [], chats: [] };

export class ChatStore {
  constructor(private readonly root: string) {
    assert(path.isAbsolute(root), 'ChatStore: the root is absolute');
  }

  /** The project's folder: named by a digest of its real path, so a moved symlink still finds its chats. */
  projectDirectory(projectPath: string): string {
    let real = path.resolve(projectPath);
    try {
      real = fs.realpathSync(real);
    } catch {
      // A project folder that is gone keeps the name its path gives.
    }
    const digest = createHash('sha256').update(real).digest('hex');
    const directory = path.join(this.root, 'projects', digest);
    assert(directory.startsWith(this.root), 'projectDirectory: inside the store');
    return directory;
  }

  readIndex(projectPath: string): ChatIndex {
    const file = path.join(this.projectDirectory(projectPath), 'index.json');
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      return EMPTY_INDEX;
    }
    const index = parseChatIndex(source);
    assert(index.chats.length <= AI_LIMITS.chatsMax, 'readIndex: the parsed index is bounded');
    return index;
  }

  writeIndex(projectPath: string, index: ChatIndex): void {
    assert(index.chats.length <= AI_LIMITS.chatsMax, 'writeIndex: the chat list is bounded');
    assert(index.sections.length <= AI_LIMITS.sectionsMax, 'writeIndex: the sections are bounded');
    const source = `${JSON.stringify(index)}\n`;
    const file = path.join(this.projectDirectory(projectPath), 'index.json');
    replaceWhole(file, source);
    const stored = parseChatIndex(fs.readFileSync(file, 'utf8'));
    assert(stored.chats.length === index.chats.length, 'writeIndex: the chats read back as written');
    assert(stored.sections.length === index.sections.length, 'writeIndex: the sections read back as written');
  }

  trust(projectPath: string): void {
    this.writeIndex(projectPath, { ...this.readIndex(projectPath), trusted: true });
  }

  list(projectPath: string): ChatList {
    return listOf(this.readIndex(projectPath));
  }

  find(projectPath: string, chat: ChatId): ChatRecord | undefined {
    return this.readIndex(projectPath).chats.find((record) => record.id === chat);
  }

  /** A new chat at the top of the unsectioned chats, or undefined when the project has as many as it may. */
  create(
    projectPath: string,
    agent: AgentId,
    title: string,
    now: number,
    settings: readonly ChatSetting[] = [],
    titleSource: TitleSource = 'first-line',
  ): ChatRecord | undefined {
    const index = this.readIndex(projectPath);
    if (index.chats.length >= AI_LIMITS.chatsMax) {
      return undefined;
    }
    const record: ChatRecord = {
      id: toChatId(`c${randomBytes(12).toString('hex')}`),
      agent,
      title: title.slice(0, AI_LIMITS.titleCharsMax),
      titleSource,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      section: undefined,
      rank: TOP_OF_GROUP,
      archivedAt: undefined,
      unread: false,
      context: undefined,
      forkOf: undefined,
      sessionId: undefined,
      settings: settings.slice(0, AI_LIMITS.configOptionsMax),
    };
    const next = normalizeIndex({ ...index, chats: [record, ...index.chats] });
    this.writeIndex(projectPath, next);
    const stored = next.chats.find((candidate) => candidate.id === record.id);
    assert(stored !== undefined, 'create: the new chat is in the list');
    return stored;
  }

  /** Changes one chat's record; undefined when there is no such chat. */
  update(projectPath: string, chat: ChatId, change: (record: ChatRecord) => ChatRecord): ChatRecord | undefined {
    const index = this.readIndex(projectPath);
    const current = index.chats.find((record) => record.id === chat);
    if (current === undefined) {
      return undefined;
    }
    const next = change(current);
    assert(next.id === chat, 'update: a chat keeps its id');
    const written = normalizeIndex({ ...index, chats: index.chats.map((record) => (record.id === chat ? next : record)) });
    this.writeIndex(projectPath, written);
    return written.chats.find((record) => record.id === chat);
  }

  /** One list operation (move, pin, archive, section change): read, apply, write. A refusal writes nothing. */
  mutate(projectPath: string, operation: (index: ChatIndex) => Result<ChatIndex, AiFailure>): Result<ChatIndex, AiFailure> {
    const index = this.readIndex(projectPath);
    const changed = operation(index);
    if (!changed.ok) {
      return changed;
    }
    const written = normalizeIndex(changed.value);
    this.writeIndex(projectPath, written);
    return ok(written);
  }

  /** A fork of `chat`: its record right below the original and a copy of the transcript. */
  fork(projectPath: string, chat: ChatId, now: number): Result<ChatRecord, AiFailure> {
    const created = forkRecord(this.readIndex(projectPath), chat, toChatId(`c${randomBytes(12).toString('hex')}`), now);
    if (!created.ok) {
      return created;
    }
    this.writeIndex(projectPath, created.value.index);
    // The copy is the fork's own history; its pending reviews are settled, since the fork has no ledger (forkEvents).
    const copied = forkEvents(this.read(projectPath, chat).events);
    if (copied.length > 0) {
      this.append(projectPath, created.value.record.id, copied);
    }
    return ok(created.value.record);
  }

  delete(projectPath: string, chat: ChatId): void {
    const index = this.readIndex(projectPath);
    this.writeIndex(projectPath, normalizeIndex({ ...index, chats: index.chats.filter((record) => record.id !== chat) }));
    const directory = this.projectDirectory(projectPath);
    fs.rmSync(path.join(directory, 'chats', `${chat}.jsonl`), { force: true });
    fs.rmSync(path.join(directory, 'reviews', `${chat}.json`), { force: true });
    assert(!fs.existsSync(path.join(directory, 'chats', `${chat}.jsonl`)), 'delete: the transcript is gone');
  }

  /** Appends events in one write. False when the transcript is full: the events are not stored. */
  append(projectPath: string, chat: ChatId, events: readonly ChatEvent[]): boolean {
    assert(events.length > 0, 'append: something to store');
    const file = this.transcriptFile(projectPath, chat);
    const lines = events.map((event) => JSON.stringify(event)).join('\n');
    const size = sizeOf(file);
    if (size + lines.length + 1 > AI_LIMITS.chatBytesMax) {
      return false;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${lines}\n`, 'utf8');
    assert(sizeOf(file) > size, 'append: the transcript grew');
    return true;
  }

  /** The chat's events in order, the unreadable lines skipped, and whether it is full. */
  read(projectPath: string, chat: ChatId): { readonly events: readonly ChatEvent[]; readonly full: boolean } {
    const file = this.transcriptFile(projectPath, chat);
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      return { events: [], full: false };
    }
    const events: ChatEvent[] = [];
    for (const line of source.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      if (events.length >= AI_LIMITS.chatEventsMax) {
        break;
      }
      const event = parseLine(line);
      if (event !== undefined) {
        events.push(event);
      }
    }
    assert(events.length <= AI_LIMITS.chatEventsMax, 'read: the events are bounded');
    return { events, full: events.length >= AI_LIMITS.chatEventsMax || source.length >= AI_LIMITS.chatBytesMax };
  }

  /** Each agent's settings as it last reported them (agentHost.ts); undefined before any did. */
  readAgentOptions(): unknown {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(this.root, 'agent-options.json'), 'utf8'));
      return value;
    } catch {
      return undefined;
    }
  }

  writeAgentOptions(source: string): void {
    assert(source.length <= AI_LIMITS.chatBytesMax, 'writeAgentOptions: bounded');
    replaceWhole(path.join(this.root, 'agent-options.json'), source);
  }

  /** The composer settings last used, as stored (rememberedSettings.ts reads them); undefined before any were stored or when unreadable. */
  readRememberedSettings(): unknown {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(this.root, 'remembered-settings.json'), 'utf8'));
      return value;
    } catch {
      return undefined;
    }
  }

  writeRememberedSettings(source: string): void {
    assert(source.length <= AI_LIMITS.chatBytesMax, 'writeRememberedSettings: bounded');
    replaceWhole(path.join(this.root, 'remembered-settings.json'), source);
  }

  readReviews(projectPath: string, chat: ChatId): unknown {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.reviewsFile(projectPath, chat), 'utf8'));
      return value;
    } catch {
      return undefined;
    }
  }

  writeReviews(projectPath: string, chat: ChatId, source: string): void {
    assert(source.length <= AI_LIMITS.ledgerBytesMax * 2, 'writeReviews: the ledger is bounded before it is written');
    replaceWhole(this.reviewsFile(projectPath, chat), source);
  }

  private transcriptFile(projectPath: string, chat: ChatId): string {
    return path.join(this.projectDirectory(projectPath), 'chats', `${toChatId(chat)}.jsonl`);
  }

  private reviewsFile(projectPath: string, chat: ChatId): string {
    return path.join(this.projectDirectory(projectPath), 'reviews', `${toChatId(chat)}.json`);
  }
}

export function summaryOf(record: ChatRecord): ChatSummary {
  const summary: ChatSummary = {
    id: record.id,
    agent: record.agent,
    title: record.title,
    pinned: record.pinned,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    section: record.section,
    rank: record.rank,
    archivedAt: record.archivedAt,
    unread: record.unread,
    context: record.context,
    forkOf: record.forkOf,
  };
  assert(summary.id === record.id, 'summaryOf: the same chat');
  return summary;
}

/** The list the renderer shows: chats in display order (the first section, then each section in order, each by rank), and the sections in order. */
export function listOf(index: ChatIndex): ChatList {
  const sectionRank = new Map(index.sections.map((section) => [section.id, section.rank] as const));
  const place = (chat: ChatRecord): number => (chat.section === undefined ? -1 : (sectionRank.get(chat.section) ?? -1));
  const shown = [...index.chats].sort((left, right) => place(left) - place(right) || left.rank - right.rank);
  assert(shown.length === index.chats.length, 'listOf: every chat is listed once');
  return { chats: shown.map(summaryOf), sections: index.sections };
}

/**
 * The index from its file. A broken file reads as empty rather than locking the person out of the
 * panel. Version 1 is migrated: every chat keeps its place in the list the person saw (pinned
 * first, then the most recently updated), unsectioned, unread-free; a record that fails to parse
 * loses only that chat.
 */
export function parseChatIndex(source: string): ChatIndex {
  let value: unknown;
  try {
    const parsed: unknown = JSON.parse(source);
    value = parsed;
  } catch {
    return EMPTY_INDEX;
  }
  const index = toRecord(value);
  const chats = toArray(index?.['chats']);
  if (index === undefined || chats === undefined) {
    return EMPTY_INDEX;
  }
  if (index['version'] === 1) {
    return migrateLegacyIndex(index, chats);
  }
  if (index['version'] !== 2) {
    return EMPTY_INDEX;
  }
  const sections: ChatSection[] = [];
  for (const entry of (toArray(index['sections']) ?? []).slice(0, AI_LIMITS.sectionsMax)) {
    try {
      sections.push(parseChatSection(entry));
    } catch {
      continue; // One bad section loses that section; its chats fall back to the first section.
    }
  }
  const records: ChatRecord[] = [];
  for (const entry of chats.slice(0, AI_LIMITS.chatsMax)) {
    try {
      records.push(withSession(parseChatSummary(entry), entry));
    } catch {
      continue; // One bad record loses that chat, never the list.
    }
  }
  return normalizeIndex({ version: 2, trusted: index['trusted'] === true, sections, chats: records });
}

function migrateLegacyIndex(index: Record<string, unknown>, chats: readonly unknown[]): ChatIndex {
  const records: ChatRecord[] = [];
  chats.slice(0, AI_LIMITS.chatsMax).forEach((entry, position) => {
    try {
      records.push(withSession(parseChatSummaryLegacy(entry, position), entry));
    } catch {
      // One bad record loses that chat, never the list.
    }
  });
  // The v1 list was displayed pinned first, then newest update first: that order becomes the ranks.
  const shown = [...records].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);
  const ranked = records.map((record) => ({ ...record, rank: shown.indexOf(record) }));
  const migrated = normalizeIndex({ version: 2, trusted: index['trusted'] === true, sections: [], chats: ranked });
  assert(migrated.chats.length === records.length, 'migrateLegacyIndex: every readable chat survives');
  return migrated;
}

function withSession(summary: ChatSummary, entry: unknown): ChatRecord {
  const session = toRecord(entry)?.['sessionId'];
  let settings: readonly ChatSetting[] = [];
  try {
    settings = parseChatSettings(toRecord(entry)?.['settings'] ?? []);
  } catch {
    settings = []; // Lost settings only mean the agent's own defaults.
  }
  const titleSource = parseTitleSource(toRecord(entry)?.['titleSource']);
  return { ...summary, titleSource, sessionId: typeof session === 'string' && session.length <= AI_LIMITS.idCharsMax ? session : undefined, settings };
}

/** A stored title source; a missing or unknown one is 'first-line', so a record from an older build keeps working. */
export function parseTitleSource(input: unknown): TitleSource {
  return TITLE_SOURCES.find((source) => source === input) ?? 'first-line';
}

/** An agent's title as a chat title: control characters and line breaks become spaces, runs of space collapse, trimmed, cut to the title limit. Empty: undefined. */
export function cleanAgentTitle(raw: string): string | undefined {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') {
    return undefined;
  }
  return Array.from(cleaned).slice(0, AI_LIMITS.titleCharsMax).join('').trim();
}

/**
 * The record with the agent's title, or undefined when nothing changes: the title is empty once cleaned,
 * the person named the chat (a rename always wins), or the chat already has this title.
 */
export function withAgentTitle(record: ChatRecord, raw: string): ChatRecord | undefined {
  if (record.titleSource === 'user') {
    return undefined;
  }
  const title = cleanAgentTitle(raw);
  if (title === undefined) {
    return undefined;
  }
  if (title === record.title && record.titleSource === 'ai') {
    return undefined;
  }
  const next: ChatRecord = { ...record, title, titleSource: 'ai' };
  assert(next.title.length <= AI_LIMITS.titleCharsMax, 'withAgentTitle: within the title limit');
  assert(next.titleSource === 'ai', 'withAgentTitle: the title is marked as the agent’s');
  return next;
}

// ---------------------------------------------------------------------------
// List operations: pure functions over the index (property-tested in
// test/electron/handlers/ai/chatStore.test.ts).
//
// Order is a rank per chat within its section (the unsectioned chats are the
// first section). Inside a section pinned chats come first, then the rest;
// `normalizeIndex` enforces that and renumbers each section 0..n-1, so every
// operation only has to say where a chat should sit (a fractional rank) and let
// normalization place it. That also gives the drag rule for free: dropping an
// unpinned chat among pinned ones lands it at the boundary.
// ---------------------------------------------------------------------------

/** A rank that sorts before every other in its group once normalized. */
const TOP_OF_GROUP = -1;

/**
 * The index with its invariants restored: sections unique, in order and numbered 0..n-1; every
 * chat in an existing section (else the first); each section's chats pinned first, then by rank,
 * numbered 0..n-1. Idempotent.
 */
export function normalizeIndex(index: ChatIndex): ChatIndex {
  const seen = new Set<SectionId>();
  const ordered = [...index.sections]
    .sort((left, right) => left.rank - right.rank)
    .filter((section) => {
      if (seen.has(section.id) || seen.size >= AI_LIMITS.sectionsMax) {
        return false;
      }
      seen.add(section.id);
      return true;
    });
  const sections = ordered.map((section, position) => ({ ...section, rank: position }));
  const groups = new Map<SectionId | undefined, ChatRecord[]>();
  for (const chat of index.chats) {
    const key = chat.section !== undefined && seen.has(chat.section) ? chat.section : undefined;
    groups.set(key, [...(groups.get(key) ?? []), { ...chat, section: key }]);
  }
  const placed = new Map<ChatId, ChatRecord>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.rank - right.rank);
    sorted.forEach((chat, position) => placed.set(chat.id, { ...chat, rank: position }));
  }
  const chats = index.chats.map((chat) => placed.get(chat.id) ?? chat);
  assert(chats.length === index.chats.length, 'normalizeIndex: no chat is lost');
  assert(sections.length <= index.sections.length, 'normalizeIndex: never more sections than there were');
  return { ...index, sections, chats };
}

export type ListResult = Result<ChatIndex, AiFailure>;

/** Applies list operations in order, stopping at the first refusal, so a request that does several things is all or nothing. */
export function chainOperations(index: ChatIndex, operations: readonly ((index: ChatIndex) => ListResult)[]): ListResult {
  assert(operations.length <= 16, 'chainOperations: a request names a handful of changes');
  let current: ListResult = ok(index);
  for (const operation of operations) {
    if (!current.ok) {
      break;
    }
    current = operation(current.value);
  }
  return current;
}

function chatMissing(): AiFailure {
  return { code: 'chat-missing', ...described('ai.error.chatMissing') };
}

function sectionMissing(): AiFailure {
  return { code: 'section-missing', ...described('ai.error.sectionMissing') };
}

function invalid(refusal: ReturnType<typeof described>): AiFailure {
  assert(refusal.message.length > 0, 'invalid: a refusal says why');
  return { code: 'invalid', ...refusal };
}

/** Changes one chat's record in the index; a refusal when there is no such chat. */
export function updateChat(index: ChatIndex, chat: ChatId, change: (record: ChatRecord) => ChatRecord): ListResult {
  if (!index.chats.some((record) => record.id === chat)) {
    return err(chatMissing());
  }
  return ok({ ...index, chats: index.chats.map((record) => (record.id === chat ? change(record) : record)) });
}

/**
 * Moves a chat into `section` (undefined: the first, unsectioned one), right before `before`, or last
 * when `before` is undefined. Dropping a chat on itself changes nothing. A pinned chat stays among the
 * pinned, an unpinned one among the rest: a drop on the wrong side lands at the boundary.
 */
export function moveChat(index: ChatIndex, chat: ChatId, section: SectionId | undefined, before: ChatId | undefined): ListResult {
  const moved = index.chats.find((record) => record.id === chat);
  if (moved === undefined) {
    return err(chatMissing());
  }
  if (moved.archivedAt !== undefined) {
    return err(invalid(described('ai.error.archivedMove')));
  }
  if (section !== undefined && !index.sections.some((candidate) => candidate.id === section)) {
    return err(sectionMissing());
  }
  if (before === chat) {
    return ok(index);
  }
  let rank = Number.MAX_SAFE_INTEGER;
  if (before !== undefined) {
    const anchor = index.chats.find((record) => record.id === before);
    if (anchor === undefined) {
      return err(chatMissing());
    }
    if (anchor.section !== section) {
      return err(invalid(described('ai.error.dropOtherSection')));
    }
    rank = anchor.rank - 0.5;
  }
  return updateChat(index, chat, (record) => ({ ...record, section, rank }));
}

/** Pins or unpins a chat; it goes to the top of its new group. No change when it already is. */
export function setPinned(index: ChatIndex, chat: ChatId, change: { readonly pinned: boolean }): ListResult {
  const { pinned } = change;
  return updateChat(index, chat, (record) => (record.pinned === pinned ? record : { ...record, pinned, rank: TOP_OF_GROUP }));
}

/** Archives (a time) or restores (undefined) a chat. It keeps its section and rank, so restoring puts it back. */
export function setArchived(index: ChatIndex, chat: ChatId, archivedAt: number | undefined): ListResult {
  return updateChat(index, chat, (record) => ({ ...record, archivedAt }));
}

export function setUnread(index: ChatIndex, chat: ChatId, change: { readonly unread: boolean }): ListResult {
  const { unread } = change;
  return updateChat(index, chat, (record) => ({ ...record, unread }));
}

/** The record of a fork: right below its original in the same section, unpinned, with no session yet. */
export function forkRecord(
  index: ChatIndex,
  chat: ChatId,
  id: ChatId,
  now: number,
): Result<{ readonly index: ChatIndex; readonly record: ChatRecord }, AiFailure> {
  const source = index.chats.find((record) => record.id === chat);
  if (source === undefined) {
    return err(chatMissing());
  }
  if (index.chats.length >= AI_LIMITS.chatsMax) {
    return err({ code: 'read-only', ...described('ai.error.chatsFull', { count: AI_LIMITS.chatsMax }) });
  }
  const record: ChatRecord = {
    ...source,
    id,
    title: `${source.title} (fork)`.slice(0, AI_LIMITS.titleCharsMax),
    // The fork's name is derived from the original's; the agent's title for the forked session would lose it.
    titleSource: 'user',
    pinned: false,
    createdAt: now,
    updatedAt: now,
    rank: source.rank + 0.5,
    archivedAt: undefined,
    unread: false,
    forkOf: source.id,
    sessionId: undefined,
  };
  const next = normalizeIndex({ ...index, chats: [...index.chats, record] });
  const stored = next.chats.find((candidate) => candidate.id === id);
  assert(stored !== undefined, 'forkRecord: the fork is in the list');
  assert(stored.forkOf === source.id, 'forkRecord: the fork names its original');
  return ok({ index: next, record: stored });
}

/**
 * A fork's copy of a transcript. Pending reviews become kept: the edits are on disk, the fork has
 * no ledger to undo them with, and a Keep or Undo button that can only fail is worse than none.
 */
export function forkEvents(events: readonly ChatEvent[]): readonly ChatEvent[] {
  return events.map((event) => {
    if (event.kind !== 'changes') {
      return event;
    }
    return { ...event, files: event.files.map((file) => (file.review === 'pending' ? { ...file, review: 'kept' as const } : file)) };
  });
}

// --- Sections ---------------------------------------------------------------

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** A new section after the last. Names are unique, ignoring case. */
export function createSection(index: ChatIndex, id: SectionId, name: string): ListResult {
  if (index.sections.length >= AI_LIMITS.sectionsMax) {
    return err(invalid(described('ai.error.sectionsFull', { count: AI_LIMITS.sectionsMax })));
  }
  if (index.sections.some((section) => sameName(section.name, name))) {
    return err(invalid(described('ai.error.sectionNameTaken')));
  }
  return ok({ ...index, sections: [...index.sections, { id, name, collapsed: false, rank: index.sections.length }] });
}

function changeSection(index: ChatIndex, id: SectionId, change: (section: ChatSection) => ChatSection): ListResult {
  if (!index.sections.some((section) => section.id === id)) {
    return err(sectionMissing());
  }
  return ok({ ...index, sections: index.sections.map((section) => (section.id === id ? change(section) : section)) });
}

export function renameSection(index: ChatIndex, id: SectionId, name: string): ListResult {
  if (index.sections.some((section) => section.id !== id && sameName(section.name, name))) {
    return err(invalid(described('ai.error.sectionNameTaken')));
  }
  return changeSection(index, id, (section) => ({ ...section, name }));
}

export function collapseSection(index: ChatIndex, id: SectionId, change: { readonly collapsed: boolean }): ListResult {
  const { collapsed } = change;
  return changeSection(index, id, (section) => ({ ...section, collapsed }));
}

/** Moves a section before another, or last when `before` is undefined. */
export function moveSection(index: ChatIndex, id: SectionId, before: SectionId | undefined): ListResult {
  if (before === id) {
    return ok(index);
  }
  const anchor = before === undefined ? undefined : index.sections.find((section) => section.id === before);
  if (before !== undefined && anchor === undefined) {
    return err(sectionMissing());
  }
  return changeSection(index, id, (section) => ({ ...section, rank: anchor === undefined ? Number.MAX_SAFE_INTEGER : anchor.rank - 0.5 }));
}

/** Deletes a section. Its chats are never deleted: they move, in order, to the end of the unsectioned chats. */
export function deleteSection(index: ChatIndex, id: SectionId): ListResult {
  if (!index.sections.some((section) => section.id === id)) {
    return err(sectionMissing());
  }
  const unsectioned = index.chats.filter((chat) => chat.section === undefined).length;
  return ok({
    ...index,
    sections: index.sections.filter((section) => section.id !== id),
    chats: index.chats.map((chat) => (chat.section === id ? { ...chat, section: undefined, rank: unsectioned + chat.rank } : chat)),
  });
}

/** A fresh section id. */
export function newSectionId(): SectionId {
  return toSectionId(`s${randomBytes(8).toString('hex')}`);
}

function parseLine(line: string): ChatEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return parseChatEvent(value);
  } catch {
    return undefined;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function replaceWhole(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, source, { flag: 'wx' });
  fs.renameSync(temporary, file);
}
