// The AI panel's chats on disk. Private to this computer and never inside the
// project, so nothing here can be committed:
//
//   userData/ai/projects/<sha256(realpath of the project)>/
//     index.json          the chat list, the trust answer and each chat's agent session
//     chats/<id>.jsonl    one ChatEvent per line, appended in batches
//     reviews/<id>.json   the change ledger's pending reviews (changeLedger.ts)
//
// index.json and reviews are replaced whole (temporary file, then rename), so a
// crash leaves the old file or the new one. A transcript is append-only; a torn
// last line (a crash mid-append) or any line that fails `parseChatEvent` is
// skipped on read, never trusted. Every collection is bounded by AI_LIMITS.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import { toArray, toRecord } from '../../../shared/core/record';
import { parseChatSettings, type ChatSetting } from '../../../shared/ipc/aiChat';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { parseChatEvent, parseChatSummary, toChatId, type ChatEvent, type ChatId, type ChatSummary } from '../../../shared/properties/ai/chatModel';

/** A chat as the index keeps it: the summary, and the agent session it continues. */
export interface ChatRecord extends ChatSummary {
  readonly sessionId: string | undefined;
  /** Settings chosen before the chat had a session, applied once it has one. */
  readonly settings: readonly ChatSetting[];
}

export interface ChatIndex {
  readonly version: 1;
  readonly trusted: boolean;
  readonly chats: readonly ChatRecord[];
}

const EMPTY_INDEX: ChatIndex = { version: 1, trusted: false, chats: [] };

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
    const source = `${JSON.stringify(index)}\n`;
    const file = path.join(this.projectDirectory(projectPath), 'index.json');
    replaceWhole(file, source);
    assert(parseChatIndex(fs.readFileSync(file, 'utf8')).chats.length === index.chats.length, 'writeIndex: the index reads back as written');
  }

  trust(projectPath: string): void {
    this.writeIndex(projectPath, { ...this.readIndex(projectPath), trusted: true });
  }

  list(projectPath: string): readonly ChatSummary[] {
    return this.readIndex(projectPath).chats.map(summaryOf);
  }

  find(projectPath: string, chat: ChatId): ChatRecord | undefined {
    return this.readIndex(projectPath).chats.find((record) => record.id === chat);
  }

  /** A new chat, or undefined when the project has as many as it may. */
  create(projectPath: string, agent: AgentId, title: string, now: number, settings: readonly ChatSetting[] = []): ChatRecord | undefined {
    const index = this.readIndex(projectPath);
    if (index.chats.length >= AI_LIMITS.chatsMax) {
      return undefined;
    }
    const record: ChatRecord = {
      id: toChatId(`c${randomBytes(12).toString('hex')}`),
      agent,
      title: title.slice(0, AI_LIMITS.titleCharsMax),
      pinned: false,
      createdAt: now,
      updatedAt: now,
      sessionId: undefined,
      settings: settings.slice(0, AI_LIMITS.configOptionsMax),
    };
    this.writeIndex(projectPath, { ...index, chats: [record, ...index.chats] });
    return record;
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
    this.writeIndex(projectPath, { ...index, chats: index.chats.map((record) => (record.id === chat ? next : record)) });
    return next;
  }

  delete(projectPath: string, chat: ChatId): void {
    const index = this.readIndex(projectPath);
    this.writeIndex(projectPath, { ...index, chats: index.chats.filter((record) => record.id !== chat) });
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
  };
  assert(summary.id === record.id, 'summaryOf: the same chat');
  return summary;
}

/** The index from its file. A broken file reads as empty rather than locking the person out of the panel. */
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
  if (index === undefined || index['version'] !== 1 || chats === undefined) {
    return EMPTY_INDEX;
  }
  const records: ChatRecord[] = [];
  for (const entry of chats.slice(0, AI_LIMITS.chatsMax)) {
    try {
      const summary = parseChatSummary(entry);
      const session = toRecord(entry)?.['sessionId'];
      let settings: readonly ChatSetting[] = [];
      try {
        settings = parseChatSettings(toRecord(entry)?.['settings'] ?? []);
      } catch {
        settings = []; // Lost settings only mean the agent's own defaults.
      }
      records.push({ ...summary, sessionId: typeof session === 'string' && session.length <= AI_LIMITS.idCharsMax ? session : undefined, settings });
    } catch {
      continue; // One bad record loses that chat, never the list.
    }
  }
  return { version: 1, trusted: index['trusted'] === true, chats: records };
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
