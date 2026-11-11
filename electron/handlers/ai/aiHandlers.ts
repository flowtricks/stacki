// The AI chat panel's IPC channels (shared/ipc/aiChat.ts). Each payload is
// parsed by the registrar before it gets here and gated on `code:edit` for
// every write (channelAccess.ts); each project path must be the project the app
// has open, so an agent can never be started anywhere else.
//
// The one-way `ai:ack` is registered by main.ts with the native ipcMain, next
// to the terminal's, through `registerAiSendChannels`.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { err, ok } from '../../../shared/core/result';
import { parseAiAck } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { createProjectText, writeProjectText } from '../../documents/documentWrites';
import { sameFilesystemPath } from '../../lib/platform';
import { buildShellEnv } from '../../lib/shellEnvironment';
import type { MainHost } from '../mainHost';
import { AgentHost, NEW_CHAT_TITLE } from './agentHost';
import { AgentSetup } from './agentSetup';
import { UnreadableFile, type LedgerFiles } from './changeLedger';
import { ChatStore, summaryOf } from './chatStore';
import { GIT_SNAPSHOTS } from './treeSnapshot';

export interface AiHandlerOptions {
  readonly userData: () => string;
  readonly version: () => string;
  /** The Settings toggle: ask before agents work in a new project, or count opening the panel as yes. */
  readonly askBeforeTrust: () => boolean;
}

/** Registers the invoke channels; the host itself starts nothing until a prompt asks for it. */
/** What main.ts holds of the AI panel: the agents' host, and the stop for everything it runs. */
export interface AiServices {
  readonly host: () => AgentHost;
  readonly stopAll: () => void;
}

export function registerAiHandlers(host: Pick<MainHost, 'ipcMain' | 'openProject' | 'send' | 'shell'>, options: AiHandlerOptions): AiServices {
  let agents: AgentHost | undefined;
  let store: ChatStore | undefined;
  // Created on first use: userData is only known once the app is ready.
  const chats = (): ChatStore => {
    store ??= new ChatStore(path.join(options.userData(), 'ai'));
    return store;
  };
  const agentHost = (): AgentHost => {
    agents ??= new AgentHost({
      userData: options.userData(),
      store: chats(),
      send: host.send,
      files: projectFiles(host),
      snapshots: GIT_SNAPSHOTS,
      environment: buildShellEnv,
      now: Date.now,
      version: options.version(),
      askBeforeTrust: options.askBeforeTrust,
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
  let setup: AgentSetup | undefined;
  const agentSetup = (): AgentSetup => {
    setup ??= new AgentSetup({
      environment: buildShellEnv,
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
  host.ipcMain.handle('ai:agents', (_event, input) => agentHost().agents(open(input.projectPath)));
  host.ipcMain.handle('ai:installAgent', (_event, input) => agentHost().install(input.agent, open(input.projectPath)));
  host.ipcMain.handle('ai:trust', (_event, input) => {
    chats().trust(open(input.projectPath));
    return { ok: true as const };
  });
  host.ipcMain.handle('ai:chats', (_event, input) => chats().list(open(input.projectPath)));
  host.ipcMain.handle('ai:chatCreate', (_event, input) => {
    const now = Date.now();
    const record = chats().create(open(input.projectPath), input.agent, input.title ?? NEW_CHAT_TITLE, now, input.settings ?? []);
    return record === undefined
      ? err({ code: 'read-only' as const, message: `A project keeps at most ${AI_LIMITS.chatsMax} chats. Delete some to start another.` })
      : ok(summaryOf(record));
  });
  host.ipcMain.handle('ai:chatUpdate', (_event, input) => {
    const record = chats().update(open(input.projectPath), input.chat, (current) => ({
      ...current,
      title: input.title ?? current.title,
      pinned: input.pinned ?? current.pinned,
      // Settings chosen before the chat's session exists; a running session is changed through ai:setOption.
      settings: input.settings ?? current.settings,
    }));
    return record === undefined ? err({ code: 'chat-missing' as const, message: 'This chat no longer exists.' }) : ok(summaryOf(record));
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
      return err({ code: 'chat-missing' as const, message: 'This chat no longer exists.' });
    }
    const transcript = chats().read(root, input.chat);
    return ok({ summary: summaryOf(record), events: transcript.events, full: transcript.full });
  });
  host.ipcMain.handle('ai:prompt', (_event, input) => agentHost().prompt(open(input.projectPath), input.chat, input.text, input.attachments));
  host.ipcMain.handle('ai:cancel', (_event, input) => {
    agentHost().cancel(open(input.projectPath), input.chat);
    return { ok: true as const };
  });
  host.ipcMain.handle('ai:permission', (_event, input) => agentHost().answerPermission(open(input.projectPath), input.chat, input.request, input.answer));
  host.ipcMain.handle('ai:setOption', (_event, input) => agentHost().setOption(open(input.projectPath), input.chat, input.option, input.value));
  host.ipcMain.handle('ai:review', (_event, input) => agentHost().review(open(input.projectPath), input.chat, input.turn, input.path, input.action));
  return {
    host: agentHost,
    stopAll: () => {
      setup?.stopAll();
      agents?.stopAll();
    },
  };
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
export function registerAiSendChannels(ipcMain: Pick<Electron.IpcMain, 'on'>, agents: () => AgentHost): void {
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
