// Handing work to the coding agent built into Stacki. Any panel asks with
// `requestAgentTask(task)`; handlers registered here answer, highest priority
// first, and the first that takes the task wins. Today the terminal dock's agent
// (Claude Code or Codex, src/features/terminal/terminalAgent.ts) registers one;
// the AI panel, when it lands, registers its own at a higher priority and every
// caller reaches it without a change. With no handler willing, the prompt goes
// to the clipboard, so a hand-off never silently does nothing.
import { assert } from '../../shared/core/assert';
import { agentTask, type AgentTask } from '../../shared/properties/agentTask';

/** How a hand-off ended, for the caller's toast. */
export type AgentTaskOutcome =
  /** A handler took it: `where` names it for the toast ("the terminal’s Claude Code"). */
  | { readonly tag: 'sent'; readonly where: string }
  /** No handler took it and the prompt is on the clipboard. */
  | { readonly tag: 'copied' }
  /** Nothing could take it, the clipboard included. */
  | { readonly tag: 'failed'; readonly message: string };

/** A handler answers `declined` when it cannot take this task now (no agent configured, no access). */
export type AgentTaskHandler = (task: AgentTask) => Promise<{ readonly tag: 'sent'; readonly where: string } | { readonly tag: 'declined' }>;

interface Registration {
  readonly name: string;
  /** Higher runs first: the AI panel above the terminal. */
  readonly priority: number;
  readonly handle: AgentTaskHandler;
}

const HANDLERS_MAX = 16;
const handlers: Registration[] = [];

/** Registers `handle` under `name`, replacing an earlier one of that name; returns the unregister. */
export function registerAgentTaskHandler(name: string, priority: number, handle: AgentTaskHandler): () => void {
  assert(name.length > 0, 'registerAgentTaskHandler: a handler has a name');
  assert(Number.isFinite(priority), 'registerAgentTaskHandler: a priority is a number');
  const existing = handlers.findIndex((entry) => entry.name === name);
  if (existing !== -1) {
    handlers.splice(existing, 1);
  }
  assert(handlers.length < HANDLERS_MAX, 'registerAgentTaskHandler: handlers are bounded');
  const registration: Registration = { name, priority, handle };
  handlers.push(registration);
  handlers.sort((left, right) => right.priority - left.priority);
  return () => {
    const index = handlers.indexOf(registration);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  };
}

/** The registered handler names, highest priority first. */
export function agentTaskHandlerNames(): readonly string[] {
  return handlers.map((entry) => entry.name);
}

/** Hands `task` to the first handler that takes it, or copies its prompt. */
export async function requestAgentTask(task: AgentTask): Promise<AgentTaskOutcome> {
  const checked = agentTask(task);
  for (const registration of [...handlers]) {
    let answer: Awaited<ReturnType<AgentTaskHandler>>;
    try {
      answer = await registration.handle(checked);
    } catch {
      continue; // A failing handler is passed over; the next one, or the clipboard, still takes the task.
    }
    if (answer.tag === 'sent') {
      return answer;
    }
  }
  return copyPrompt(checked.prompt);
}

async function copyPrompt(prompt: string): Promise<AgentTaskOutcome> {
  try {
    await navigator.clipboard.writeText(prompt);
    return { tag: 'copied' };
  } catch (error: unknown) {
    return { tag: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** The toast a hand-off ends with. */
export function agentTaskMessage(outcome: AgentTaskOutcome): { readonly message: string; readonly kind: 'success' | 'info' | 'error' } {
  switch (outcome.tag) {
    case 'sent':
      return { message: `Sent to ${outcome.where}.`, kind: 'success' };
    case 'copied':
      return { message: 'Prompt copied. Paste it into your coding agent.', kind: 'info' };
    case 'failed':
      return { message: `Couldn’t hand this off: ${outcome.message}`, kind: 'error' };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
