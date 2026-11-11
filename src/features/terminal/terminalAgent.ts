// The terminal dock as an agent-task handler (src/lib/agentTasks.ts): until the
// AI panel exists, a "Fix with AI" hand-off opens the dock on a new tab that
// starts the agent the dock is set to auto-launch (Claude Code or Codex) with
// the task's prompt as its first message. The prompt is passed as one
// shell-quoted argument, so the agent receives it whole rather than as typed
// keystrokes racing its startup.
//
// The dock declines — and the prompt goes to the clipboard instead — when it is
// set to a plain shell or a custom command (Stacki cannot know how that takes a
// prompt), on Windows (whose shells quote differently), or when the role has no
// terminal.
import { assert } from '../../../shared/core/assert';
import type { AgentTaskHandler } from '../../lib/agentTasks';

/** The key the dock's auto-launch choice is stored under (TerminalDock.tsx writes it). */
export const TERMINAL_LAUNCH_MODE_KEY = 'stacki.terminal.autoLaunch';

export type LaunchMode = 'none' | 'claude' | 'codex' | 'custom';

export function parseLaunchMode(value: string): LaunchMode {
  switch (value) {
    case 'claude':
    case 'codex':
    case 'custom':
    case 'none':
      return value;
    default:
      return 'none';
  }
}

/** The dock's stored auto-launch choice. */
export function storedLaunchMode(): LaunchMode {
  try {
    return parseLaunchMode(localStorage.getItem(TERMINAL_LAUNCH_MODE_KEY) ?? 'none');
  } catch {
    return 'none'; // Storage blocked: the dock itself falls back to a plain shell.
  }
}

/** `value` as one POSIX shell word: single-quoted, each quote closed, escaped and reopened. */
export function posixQuote(value: string): string {
  const quoted = `'${value.replace(/'/g, `'\\''`)}'`;
  assert(quoted.startsWith("'"), 'posixQuote: opens a quote');
  assert(quoted.endsWith("'"), 'posixQuote: closes a quote');
  return quoted;
}

/** The command that starts `mode`'s agent on `prompt`, or undefined when the dock cannot. */
export function agentLaunchCommand(mode: LaunchMode, prompt: string, platform: string): string | undefined {
  assert(prompt.length > 0, 'agentLaunchCommand: a task has a prompt');
  if (platform === 'win32') {
    return undefined;
  }
  switch (mode) {
    case 'claude':
      return `claude ${posixQuote(prompt)}`;
    case 'codex':
      return `codex ${posixQuote(prompt)}`;
    case 'custom':
    case 'none':
      return undefined;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

type TabRequestListener = (command: string) => void;
const tabListeners = new Set<TabRequestListener>();

/** Asks the mounted dock for a new tab that runs `command`; false when no dock is listening. */
export function requestTerminalTab(command: string): boolean {
  assert(command.trim().length > 0, 'requestTerminalTab: a tab runs a command');
  for (const listener of tabListeners) {
    listener(command);
  }
  return tabListeners.size > 0;
}

/** The dock's subscription to tab requests; returns the unsubscribe. */
export function onTerminalTabRequest(listener: TabRequestListener): () => void {
  tabListeners.add(listener);
  return () => {
    tabListeners.delete(listener);
  };
}

/** The handler the shell registers: opens the dock and starts the agent on the task. */
export function terminalAgentHandler(deps: {
  readonly platform: string;
  readonly available: () => boolean;
  readonly openDock: () => void;
  readonly mode?: () => LaunchMode;
}): AgentTaskHandler {
  return async (task) => {
    const mode = (deps.mode ?? storedLaunchMode)();
    const command = deps.available() ? agentLaunchCommand(mode, task.prompt, deps.platform) : undefined;
    if (command === undefined) {
      return { tag: 'declined' };
    }
    deps.openDock();
    // The dock mounts its listener with the shell; a frame lets an opening dock settle first.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!requestTerminalTab(command)) {
      return { tag: 'declined' };
    }
    return { tag: 'sent', where: mode === 'claude' ? 'Claude Code in the terminal' : 'Codex in the terminal' };
  };
}
