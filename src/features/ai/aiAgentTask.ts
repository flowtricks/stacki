// The AI panel as the agent-task handler (src/lib/agentTasks.ts), above the
// terminal's: "Fix with AI" in the Audits panel, or any other hand-off, opens a
// new chat with the task's prompt. When the project is trusted and the agent is
// ready the prompt is sent at once; otherwise it waits in the composer, and the
// panel shows what is missing (trust, the connector, a sign-in).
import { assert } from '../../../shared/core/assert';
import { agentLabel } from '../../../shared/properties/ai/agentIds';
import type { AgentTaskHandler } from '../../lib/agentTasks';
import { aiState, loadAiProject, newChat, preferredAgent, sendPrompt, setDraft } from './aiStore';

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
      setDraft(chat, (draft) => ({ ...draft, text: task.prompt }));
    }
    return { tag: 'sent', where: `${agentLabel(agent)} in the AI panel` };
  };
}
