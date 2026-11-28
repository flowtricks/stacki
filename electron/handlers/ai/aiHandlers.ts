// The AI chat panel's IPC channels (shared/ipc/aiChat.ts). Each payload is
// parsed by the registrar before it gets here; each project path must be the project the app
// has open, so an agent can never be started anywhere else.
//
// The one-way `ai:ack` is registered by main.ts with the native ipcMain, next
// to the terminal's, through `registerAiSendChannels`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { parseAiAck, type AiFailure, type SectionAction } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { isProjectRelativePath } from '../../../shared/properties/ai/mentions';
import { createProjectText, writeProjectText } from '../../documents/documentWrites';
import { sameFilesystemPath } from '../../lib/platform';
import { LoginShellSettings } from '../../lib/loginShellSettings';
import { buildShellEnv } from '../../lib/shellEnvironment';
import type { MainHost } from '../mainHost';
import type { AppIpc } from '../../lib/ipcSenders';
import { AgentHost, NEW_CHAT_TITLE, type AgentHostDeps } from './agentHost';
import { AgentSetup } from './agentSetup';
import { findCli } from './agentRegistry';
import { McpSignIn, type ProjectServer } from './mcpSignIn';
import { readMcpListing } from '../../content/mcpFiles';
import { described } from './aiMessages';
import { UnreadableFile, type LedgerFiles } from './changeLedger';
import { closeInterruptedTurns } from './chatEvents';
import {
  ChatStore,
  chainOperations,
  collapseSection,
  createSection,
  deleteSection,
  listOf,
  moveChat,
  moveSection,
  newSectionId,
  renameSection,
  setArchived,
  setPinned,
  setUnread,
  summaryOf,
  updateChat,
  type ChatIndex,
  type ListResult,
} from './chatStore';
import { MentionIndex, listProjectFiles } from './mentionIndex';
import { PinBoardStore } from './pinBoardStore';
import { captureScreenshot, cssRectToWindow } from './screenshotCapture';
import { ScreenRecorder } from './screenRecorder';
import type { ChatSummary } from '../../../shared/properties/ai/chatModel';
import { GIT_SNAPSHOTS } from './treeSnapshot';
import { currentBranch } from '../../git/gitParking';

export interface AiHandlerOptions {
  readonly userData: () => string;
  readonly version: () => string;
  /** The Settings toggle: ask before agents work in a new project, or count opening the panel as yes. */
  readonly askBeforeTrust: () => boolean;
  /** The Settings toggle: take the change ledger's snapshots around each turn. Read at each turn's start, so a toggle applies to the next turn. */
  readonly trackChanges: () => boolean;
  /** The saved "Auto-compact at" percentage: read when an adapter is spawned (so it applies to adapters started afterwards); `set` saves and answers whether it was saved. */
  readonly autoCompact: { readonly get: () => number | undefined; readonly set: (percent: number | undefined) => boolean };
  /** Whether a window is visible and not minimized: an agent is only started early for a person who is looking at the app. Absent means yes. */
  readonly isForeground?: () => boolean;
  /** The small preview of a sent image kept in its chat (attachmentThumbnail.ts); absent: sent images keep their name only. */
  readonly thumbnail?: AgentHostDeps['thumbnail'];
}

/** Registers the invoke channels; the host itself starts nothing until a prompt asks for it. */
/** What main.ts holds of the AI panel: the agents' host, and the stop for everything it runs. */
export interface AiServices {
  readonly host: () => AgentHost;
  readonly stopAll: () => void;
  /** Forget the scanned file and skill lists of the `@` picker; main calls it when a window gains focus. */
  readonly invalidateMentions: () => void;
}

export function registerAiHandlers(host: Pick<MainHost, 'ipcMain' | 'openProject' | 'send' | 'shell'>, options: AiHandlerOptions): AiServices {
  let agents: AgentHost | undefined;
  let store: ChatStore | undefined;
  // Created on first use: userData is only known once the app is ready.
  const chats = (): ChatStore => {
    store ??= new ChatStore(path.join(options.userData(), 'ai'));
    return store;
  };
  // The sign-in settings set only in the person's shell startup files, for the agents alone. Nothing is read
  // until an agent is first checked or started, so opening the app never waits for a shell.
  const loginShell = new LoginShellSettings({ environment: buildShellEnv });
  const agentEnvironment = loginShell.environmentFor.bind(loginShell);
  let pinStore: PinBoardStore | undefined;
  // Beside the project's chats, so a project's private AI state stays in one folder.
  const pins = (): PinBoardStore => {
    pinStore ??= new PinBoardStore((projectPath) => chats().projectDirectory(projectPath));
    return pinStore;
  };
  const agentHost = (): AgentHost => {
    agents ??= new AgentHost({
      userData: options.userData(),
      store: chats(),
      send: host.send,
      files: projectFiles(host),
      snapshots: GIT_SNAPSHOTS,
      environment: buildShellEnv,
      agentEnvironment,
      permit: (agent) => agentSetup().permit(agent),
      sessionSignal: (agent, signal) => agentSetup().sessionSignal(agent, signal),
      now: Date.now,
      version: options.version(),
      askBeforeTrust: options.askBeforeTrust,
      trackChanges: options.trackChanges,
      autoCompactPercent: options.autoCompact.get,
      currentBranch,
      ...(options.thumbnail === undefined ? {} : { thumbnail: options.thumbnail }),
      ...(options.isForeground === undefined ? {} : { isForeground: options.isForeground }),
    });
    return agents;
  };
  // The project itself, not a file inside it (assertInProject refuses the root): agents work at its root.
  const open = (projectPath: string): string => {
    const root = host.openProject();
    if (root === undefined || !sameProject(root, projectPath)) {
      throw new Error('The AI panel works in the open project only.');
    }
    assert(path.isAbsolute(root), 'ai: the open project has an absolute path');
    return root;
  };
  const recorder = new ScreenRecorder({
    now: Date.now,
    setTimer: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return { cancel: () => clearTimeout(timer) };
    },
  });
  const mentions = new MentionIndex({ home: () => os.homedir(), now: Date.now, listFiles: listProjectFiles });
  let setup: AgentSetup | undefined;
  const agentSetup = (): AgentSetup => {
    setup ??= new AgentSetup({
      environment: buildShellEnv,
      agentEnvironment,
      signInCompleted: (agent) => agentHost().noteSignedIn(agent),
      openExternal: (url) => void host.shell.openExternal(url),
      publish: (state) => {
        host.send('ai:setupState', state);
        if (state.step === 'ready') {
          agentHost().noteSignedIn(state.agent);
        }
      },
    });
    return setup;
  };
  host.ipcMain.handle('ai:setup', (_event, input) => {
    open(input.projectPath);
    return agentSetup().act(input.agent, input.action);
  });
  // Signing in to the project's MCP servers, through each agent's own CLI (mcpSignIn.ts).
  let signIns: McpSignIn | undefined;
  const mcpSignIn = (): McpSignIn => {
    signIns ??= new McpSignIn({
      findCli: (agent) => findCli(agent, { environment: buildShellEnv() }),
      environment: agentEnvironment,
      projectServers: signInServers,
      // As the agent host reads it: with "ask before allowing agents" off, working in the project is the allowance.
      trusted: (root) => chats().readIndex(root).trusted || !options.askBeforeTrust(),
      openExternal: (url) => void host.shell.openExternal(url),
      publish: (projectPath, entry, notice) => host.send('ai:mcpAuthState', { projectPath, entry, notice }),
      changed: (agent) => agentHost().reloadTools(agent),
    });
    return signIns;
  };
  host.ipcMain.handle('ai:mcpAuth', async (_event, input) => {
    const root = open(input.projectPath);
    return mcpSignIn().act(root, input.request);
  });
  host.ipcMain.handle('ai:agents', (_event, input) => agentHost().agents(open(input.projectPath)));
  host.ipcMain.handle('ai:installAgent', (_event, input) => agentHost().install(input.agent, open(input.projectPath)));
  host.ipcMain.handle('ai:trust', (_event, input) => {
    chats().trust(open(input.projectPath));
    return { ok: true as const };
  });
  // Fire and forget from the panel: a project that is no longer the open one is ignored, not an error to show.
  host.ipcMain.handle('ai:prewarm', (_event, input) => {
    const root = host.openProject();
    if (root !== undefined && sameProject(root, input.projectPath)) {
      agentHost().prewarm(root, input.agent, input.action);
    }
    return { ok: true as const };
  });
  host.ipcMain.handle('ai:chats', (_event, input) => chats().list(open(input.projectPath)));
  host.ipcMain.handle('ai:chatCreate', (_event, input) => {
    const now = Date.now();
    const record = chats().create(
      open(input.projectPath),
      input.agent,
      input.title ?? NEW_CHAT_TITLE,
      now,
      input.settings ?? [],
      input.title === undefined ? 'first-line' : 'user',
    );
    return record === undefined
      ? err({ code: 'read-only' as const, ...described('ai.error.chatsFull', { count: AI_LIMITS.chatsMax }) })
      : ok(summaryOf(record));
  });
  host.ipcMain.handle('ai:chatUpdate', (_event, input) => {
    const root = open(input.projectPath);
    const now = Date.now();
    const result = chats().mutate(root, (index) =>
      chainOperations(index, [
        (current) =>
          updateChat(current, input.chat, (record) => ({
            ...record,
            title: input.title ?? record.title,
            // A title the person typed is never replaced by the first line or the agent's own.
            titleSource: input.title === undefined ? record.titleSource : 'user',
            // Settings chosen before the chat's session exists; a running session is changed through ai:setOption.
            settings: input.settings ?? record.settings,
          })),
        (current) => (input.pinned === undefined ? ok(current) : setPinned(current, input.chat, { pinned: input.pinned })),
        (current) => (input.unread === undefined ? ok(current) : setUnread(current, input.chat, { unread: input.unread })),
        // Archiving keeps the time it first happened; restoring clears it.
        (current) => (input.archived === undefined ? ok(current) : archive(current, input.chat, { archived: input.archived, now })),
      ]),
    );
    if (!result.ok) {
      return result;
    }
    if (input.archived === true) {
      // An archived chat has no live session: its adapter work stops, and a restore resumes it from the stored session id.
      agentHost().forget(root, input.chat);
    }
    return summaryResult(result.value, input.chat);
  });
  host.ipcMain.handle('ai:chatDelete', (_event, input) => {
    const root = open(input.projectPath);
    agentHost().forget(root, input.chat);
    chats().delete(root, input.chat);
    return { ok: true as const };
  });
  host.ipcMain.handle('ai:chatRead', (_event, input) => {
    const root = open(input.projectPath);
    const record = chats().find(root, input.chat);
    if (record === undefined) {
      return err({ code: 'chat-missing' as const, ...described('ai.error.chatMissing') });
    }
    const transcript = chats().read(root, input.chat);
    const events = closeInterruptedTurns(transcript.events, agentHost().runningTurn(root, input.chat));
    return ok({ summary: summaryOf(record), events, full: transcript.full });
  });
  host.ipcMain.handle('ai:chatImage', (_event, input) => {
    const root = open(input.projectPath);
    if (chats().find(root, input.chat) === undefined) {
      return err({ code: 'chat-missing' as const, ...described('ai.error.chatMissing') });
    }
    const image = chats().readImage(root, input.chat, input.image);
    // The panel falls back to the message's small preview and says so in its own words.
    return image === undefined ? err({ code: 'invalid' as const, ...described('ai.images.smallOnly') }) : ok(image);
  });
  host.ipcMain.handle('ai:prompt', (_event, input) => {
    const root = open(input.projectPath);
    // A steer injects into the running turn (and starts one when none runs); a send is refused while a turn runs.
    if (input.mode === 'steer') {
      if (input.pins !== undefined) {
        // Pins start a turn of their own: their instructions assume nothing else is running.
        return err({ code: 'invalid' as const, ...described('ai.error.pinsSteer') });
      }
      return agentHost().steer(root, input.chat, input.text, input.attachments, input.parts);
    }
    return agentHost().prompt(root, input.chat, input.text, input.attachments, { parts: input.parts, pins: input.pins });
  });
  host.ipcMain.handle('ai:steer', (_event, input) => agentHost().steer(open(input.projectPath), input.chat, input.text, input.attachments, input.parts));
  host.ipcMain.handle('ai:autoCompactGet', () => ({ percent: options.autoCompact.get() }));
  host.ipcMain.handle('ai:autoCompactSet', (_event, input) => {
    options.autoCompact.set(input.percent);
    return { percent: options.autoCompact.get() };
  });
  host.ipcMain.handle('ai:compact', (_event, input) => agentHost().compact(open(input.projectPath), input.chat));
  host.ipcMain.handle('ai:pinsRead', (_event, input) => ok(pins().read(open(input.projectPath))));
  host.ipcMain.handle('ai:pinsWrite', (_event, input) => {
    const saved = pins().write(open(input.projectPath), input.board, input.images);
    return saved ? ok({ saved: true as const }) : err({ code: 'invalid' as const, ...described('ai.error.pinsTooLarge') });
  });
  host.ipcMain.handle('ai:chatFork', (_event, input) => {
    const forked = chats().fork(open(input.projectPath), input.chat, Date.now());
    return forked.ok ? ok(summaryOf(forked.value)) : forked;
  });
  host.ipcMain.handle('ai:chatMove', (_event, input) =>
    listResult(chats().mutate(open(input.projectPath), (index) => moveChat(index, input.chat, input.section, input.before))),
  );
  host.ipcMain.handle('ai:sections', (_event, input) =>
    listResult(chats().mutate(open(input.projectPath), (index) => applySectionAction(index, input.action))),
  );
  host.ipcMain.handle('ai:diff', (_event, input): Result<{ readonly oldText: string | undefined; readonly newText: string | undefined }, AiFailure> => {
    const root = open(input.projectPath);
    if (chats().find(root, input.chat) === undefined) {
      return err({ code: 'chat-missing', ...described('ai.error.chatMissing') });
    }
    if (!isProjectRelativePath(input.path)) {
      return err({ code: 'invalid', ...described('ai.error.changePath') });
    }
    // The live ledger, the one Keep and Undo act on: current before the reviews file was ever written.
    const diff = agentHost().diff(root, input.chat, input.turn, input.path);
    return diff === undefined ? err({ code: 'invalid', ...described('ai.error.diffGone') }) : ok(diff);
  });
  host.ipcMain.handle('ai:mentions', async (_event, input) => ok(await mentions.search(open(input.projectPath), input.query, input.kinds)));
  // The sender's own window only: a renderer can photograph what it already shows, never another window.
  host.ipcMain.handle('ai:screenshot', (event, input) => {
    open(input.projectPath);
    return captureScreenshot(event.sender, cssRectToWindow(input.rect, event.sender.getZoomFactor()));
  });
  // A recording of the sender's own window, held in memory only; a closing window frees it.
  host.ipcMain.handle('ai:record', (event, input) => {
    open(input.projectPath);
    if (input.action.kind === 'start') {
      event.sender.once('destroyed', () => recorder.release());
    }
    const action = input.action.kind === 'start' ? { ...input.action, rect: cssRectToWindow(input.action.rect, event.sender.getZoomFactor()) } : input.action;
    return recorder.act(action, {
      capture: (rect) => event.sender.capturePage(rect, { stayHidden: false, stayAwake: false }),
      visible: options.isForeground ?? (() => true),
    });
  });
  host.ipcMain.handle('ai:cancel', (_event, input) => {
    agentHost().cancel(open(input.projectPath), input.chat);
    return { ok: true as const };
  });
  host.ipcMain.handle('ai:permission', (_event, input) => agentHost().answerPermission(open(input.projectPath), input.chat, input.request, input.answer));
  host.ipcMain.handle('ai:setOption', (_event, input) => agentHost().setOption(open(input.projectPath), input.chat, input.option, input.value));
  host.ipcMain.handle('ai:remember', (_event, input) => {
    open(input.projectPath);
    return agentHost().remember(input.agent, input.action);
  });
  host.ipcMain.handle('ai:review', (_event, input) => agentHost().review(open(input.projectPath), input.chat, input.turn, input.path, input.action));
  return {
    host: agentHost,
    stopAll: () => {
      recorder.release();
      setup?.stopAll();
      signIns?.stopAll();
      agents?.stopAll();
    },
    invalidateMentions: () => mentions.invalidate(),
  };
}

function archive(index: ChatIndex, chat: ChatSummary['id'], change: { readonly archived: boolean; readonly now: number }): ListResult {
  const { archived, now } = change;
  const current = index.chats.find((record) => record.id === chat);
  if (!archived) {
    return setArchived(index, chat, undefined);
  }
  return setArchived(index, chat, current?.archivedAt ?? now);
}

/** The reply of a change to the list: the whole list, so the renderer replaces its copy in one step. */
function listResult(result: ListResult): Result<ReturnType<typeof listOf>, AiFailure> {
  return result.ok ? ok(listOf(result.value)) : result;
}

function summaryResult(index: ChatIndex, chat: ChatSummary['id']): Result<ChatSummary, AiFailure> {
  const record = index.chats.find((candidate) => candidate.id === chat);
  return record === undefined ? err({ code: 'chat-missing', ...described('ai.error.chatMissing') }) : ok(summaryOf(record));
}

function applySectionAction(index: ChatIndex, action: SectionAction): ListResult {
  switch (action.kind) {
    case 'create':
      return createSection(index, newSectionId(), action.name);
    case 'rename':
      return renameSection(index, action.section, action.name);
    case 'delete':
      return deleteSection(index, action.section);
    case 'collapse':
      return collapseSection(index, action.section, { collapsed: action.collapsed });
    case 'move':
      return moveSection(index, action.section, action.before);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

// The renderer names the project as it opened it; a link in the path still names the same folder.
function sameProject(root: string, projectPath: string): boolean {
  if (sameFilesystemPath(root, path.resolve(projectPath))) {
    return true;
  }
  try {
    return sameFilesystemPath(fs.realpathSync(root), fs.realpathSync(projectPath));
  } catch {
    return false;
  }
}

/** `ai:ack`: a one-way send, parsed before it reaches the event pump. */
export function registerAiSendChannels(ipcMain: Pick<AppIpc, 'on'>, agents: () => AgentHost): void {
  ipcMain.on('ai:ack', (_event: unknown, input: unknown) => {
    const payload = parseSendPayload('ai:ack', input);
    if (payload !== undefined) {
      agents().acknowledge(payload.chars);
    }
  });
}

// A refused acknowledgement has no reply to carry the refusal; the log is where a renderer bug shows.
function parseSendPayload(channel: 'ai:ack', input: unknown): { readonly chars: number } | undefined {
  try {
    return parseAiAck(input);
  } catch (error: unknown) {
    console.error(`[ai] ${channel}: refused payload — ${String(error)}`);
    return undefined;
  }
}

/** The project's files, as the change ledger and the agents' fs requests use them: writes through the document actors. */
function projectFiles(host: Pick<MainHost, 'shell'>): LedgerFiles {
  return {
    read: (file) => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        return undefined;
      }
      if (!stat.isFile() || stat.size > AI_LIMITS.fileCharsMax) {
        throw new UnreadableFile(file);
      }
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\0')) {
        throw new UnreadableFile(file);
      }
      return text;
    },
    write: (file, text, expected) => {
      writeProjectText(file, text, expected);
    },
    create: (file, text) => {
      createProjectText(file, text);
    },
    trash: (file) => host.shell.trashItem(file),
  };
}

/**
 * The project's `.mcp.json` servers as a sign-in sees them: a remote address with no Authorization header of its
 * own may take one; a local command, a header token and an unreadable entry never do. An unreadable file is none.
 */
export function signInServers(projectRoot: string): readonly ProjectServer[] {
  const listing = readMcpListing(projectRoot);
  if (!listing.ok) {
    return [];
  }
  return listing.value.servers.map((server) => {
    const remote = server.status === 'server' && server.summary.transport !== 'stdio' ? server.summary : undefined;
    const ownToken = remote?.headers.some((header) => header.name.toLowerCase() === 'authorization') === true;
    return { name: server.name, kind: remote !== undefined && !ownToken ? 'oauth-capable' : 'other' };
  });
}
