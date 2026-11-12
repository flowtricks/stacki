// The AI panel as the agent-task handler (src/lib/agentTasks.ts), above the
// terminal's: "Fix with AI" in the Audits panel, or any other hand-off, opens a
// new chat with the task's prompt. When the project is trusted and the agent is
// ready the prompt is sent at once; otherwise it waits in the composer, and the
// panel shows what is missing (trust, the connector, a sign-in). A task whose
// delivery is `draft` (the Apps panel's "Build an app") is never sent: it waits
// in the composer for the person to review and send. When the task carries a
// `draftChip` it is the chip that waits (App builder instructions), added to the end of a
// draft the person already has in the open chat, never over it.
import { assert } from '../../../shared/core/assert';
import { agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { ChatId } from '../../../shared/properties/ai/chatModel';
import type { BuiltinChipId } from '../../../shared/properties/ai/mentions';
import type { AgentTask } from '../../../shared/properties/agentTask';
import type { AgentTaskHandler } from '../../lib/agentTasks';
import { aiState, draftFromText, draftText, isDraftEmpty, loadAiProject, newChat, preferredAgent, sendPrompt, setDraft } from './aiStore';
import { builtinChip } from './mentions/builtinChips';
import { appendChip, hasBuiltinChip } from './mentions/mentionChips';

/** Above the terminal's priority (10, DesktopAudits.tsx): the panel answers first when it can. */
export const AI_PANEL_HANDLER_PRIORITY = 20;

export function aiAgentTaskHandler(deps: {
  readonly projectPath: () => string | undefined;
  readonly available: () => boolean;
  readonly openPanel: () => void;
}): AgentTaskHandler {
  return async (task) => {
    const projectPath = deps.projectPath();
    if (projectPath === undefined || !deps.available()) {
      return { tag: 'declined' };
    }
    await loadAiProject(projectPath);
    const agent = preferredAgent();
    if (task.delivery === 'draft') {
      return task.draftChip === undefined ? handDraft(task.prompt, agent, deps.openPanel) : handDraftChip(task, task.draftChip, agent, deps.openPanel);
    }
    const chat = await newChat(agent);
    if (chat === undefined) {
      return { tag: 'declined' };
    }
    assert(aiState().open === chat, 'aiAgentTaskHandler: the new chat is the open one');
    deps.openPanel();
    const ready = aiState().trusted && aiState().agents.some((entry) => entry.agent === agent && entry.state === 'ready');
    if (ready) {
      await sendPrompt(chat, task.prompt);
    } else {
      setDraft(chat, (draft) => ({ ...draftFromText(task.prompt), attachments: draft.attachments }));
    }
    return { tag: 'sent', where: `${agentLabel(agent)} in the AI panel` };
  };
}

/**
 * A prompt for the person to review: it waits in a chat's message box and is never sent, whether or not the agent
 * is ready (a panel that still needs a sign-in shows its setup beside the box, and the words are there when it
 * clears). An empty chat with an empty box is reused so repeated requests do not pile up blank chats; any other
 * open chat is left as it is, so a draft the person was typing is never overwritten, and the prompt gets a new one.
 */
async function handDraft(
  prompt: string,
  agent: AgentId,
  openPanel: () => void,
): Promise<{ readonly tag: 'sent'; readonly where: string } | { readonly tag: 'declined' }> {
  // A box holds at most promptCharsMax characters and would cut the rest silently; a longer prompt is a bug in its builder.
  assert(prompt.length <= AI_LIMITS.promptCharsMax, 'handDraft: the prompt fits the message box');
  const chat = reusableChat() ?? (await newChat(agent));
  if (chat === undefined) {
    return { tag: 'declined' };
  }
  assert(aiState().open === chat, 'handDraft: the chat holding the prompt is the open one');
  setDraft(chat, () => draftFromText(prompt));
  assert(draftText(aiState().drafts.get(chat) ?? draftFromText('')) === prompt, 'handDraft: the prompt is in the box');
  openPanel();
  return { tag: 'sent', where: `${agentLabel(aiState().chats.find((entry) => entry.id === chat)?.agent ?? agent)} in the AI panel` };
}

/**
 * A built-in chip for the person to review: it is added to the end of the open chat's draft when that holds one (what
 * they were typing stays), else it goes to an empty open chat or a new one, as `handDraft` does for text. A chip already
 * in the draft is not added twice. Declined when the chip cannot be added (the draft is at the mention limit), which
 * sends the task's prompt to the clipboard instead, so the click is never a silent nothing.
 */
async function handDraftChip(
  task: AgentTask,
  id: BuiltinChipId,
  agent: AgentId,
  openPanel: () => void,
): Promise<{ readonly tag: 'sent'; readonly where: string } | { readonly tag: 'declined' }> {
  assert(task.delivery === 'draft', 'handDraftChip: a chip belongs to a draft');
  const chat = chatHoldingDraft() ?? reusableChat() ?? (await newChat(agent));
  if (chat === undefined) {
    return { tag: 'declined' };
  }
  assert(aiState().open === chat, 'handDraftChip: the chat holding the chip is the open one');
  setDraft(chat, (draft) => (hasBuiltinChip(draft.segments, id) ? draft : { ...draft, segments: appendChip(draft.segments, builtinChip(id)) }));
  const placed = aiState().drafts.get(chat);
  if (placed === undefined || !hasBuiltinChip(placed.segments, id)) {
    return { tag: 'declined' };
  }
  openPanel();
  return { tag: 'sent', where: `${agentLabel(aiState().chats.find((entry) => entry.id === chat)?.agent ?? agent)} in the AI panel` };
}

/** The open chat when its message box holds something (text, a chip or an attachment), else undefined. */
function chatHoldingDraft(): ChatId | undefined {
  const state = aiState();
  const open = state.open;
  const draft = open === undefined ? undefined : state.drafts.get(open);
  return open !== undefined && draft !== undefined && !isDraftEmpty(draft) ? open : undefined;
}

/** The open chat when it has no messages and nothing typed, else undefined. */
function reusableChat(): ChatId | undefined {
  const state = aiState();
  const open = state.open;
  if (open === undefined) {
    return undefined;
  }
  const view = state.views.get(open);
  const draft = state.drafts.get(open);
  const typed = draft !== undefined && !isDraftEmpty(draft);
  if (view === undefined || view.items.length > 0 || typed) {
    return undefined;
  }
  return open;
}
