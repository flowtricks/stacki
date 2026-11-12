// A task handed to the coding agent built into Stacki: a title, the prompt it
// should act on, and the context the prompt is about (files, element
// locations, the findings it came from). Any panel can ask for one; whoever
// handles it — the AI panel once it exists, the terminal dock's agent until
// then, or the clipboard — receives the same value (src/lib/agentTasks.ts).
//
// A task is built by Stacki's own code, but a handler may send it to another
// process or a person's clipboard, so its size is bounded here, where it is made.
import { assert } from '../core/assert';
import type { BuiltinChipId } from './ai/mentions';

export const AGENT_TASK_LIMITS = {
  titleCharsMax: 200,
  promptCharsMax: 60_000,
  filesMax: 200,
  nodeRefsMax: 500,
  findingIdsMax: 1_000,
} as const satisfies Record<string, number>;

/** An element by file and structural path: `src/pages/index.astro` and [0, 2, 1]. */
export interface AgentNodeRef {
  readonly file: string;
  readonly path: readonly number[];
}

/**
 * What a handler does with the prompt. `send` (the default) starts the agent on it. `draft` only places it in
 * a message box for the person to read, edit and send: used where the prompt is a starting point they should
 * review first (the Apps panel's "Build an app"). A handler with no message box declines a draft.
 */
export type AgentTaskDelivery = 'send' | 'draft';

export interface AgentTask {
  readonly title: string;
  readonly prompt: string;
  readonly delivery?: AgentTaskDelivery;
  /**
   * Only with `delivery: 'draft'`: the built-in instructions chip to place in the composer in place of
   * the prompt's text. `prompt` stays required, for a clipboard fallback and for a handler with no
   * composer (the terminal declines drafts), so the chip and the prompt always say the same thing.
   */
  readonly draftChip?: BuiltinChipId;
  readonly context: {
    /** Project-relative files the task is about. */
    readonly files: readonly string[];
    readonly nodeRefs: readonly AgentNodeRef[];
    /** The audit findings it came from, so a handler can mark them handled. */
    readonly findingIds: readonly string[];
  };
}

/** A task checked against its bounds: past one is a programmer error in the builder, so it throws. */
export function agentTask(input: AgentTask): AgentTask {
  assert(input.title.trim().length > 0, 'agentTask: a task has a title');
  assert(input.title.length <= AGENT_TASK_LIMITS.titleCharsMax, 'agentTask: the title is bounded');
  assert(input.prompt.trim().length > 0, 'agentTask: a task has a prompt');
  assert(input.prompt.length <= AGENT_TASK_LIMITS.promptCharsMax, 'agentTask: the prompt is bounded');
  assert(input.draftChip === undefined || input.delivery === 'draft', 'agentTask: a draft chip belongs to a draft');
  assert(input.context.files.length <= AGENT_TASK_LIMITS.filesMax, 'agentTask: the files are bounded');
  assert(input.context.nodeRefs.length <= AGENT_TASK_LIMITS.nodeRefsMax, 'agentTask: the element references are bounded');
  assert(input.context.findingIds.length <= AGENT_TASK_LIMITS.findingIdsMax, 'agentTask: the finding ids are bounded');
  assert(
    input.context.files.every((file) => file.length > 0 && !file.startsWith('/')),
    'agentTask: files are project-relative',
  );
  return input;
}
