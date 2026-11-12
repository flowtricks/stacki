// The "Build an app" prompt: short on purpose, it gets an AI agent started (what
// an app is, the files, the API in brief, how to test) and links to the full
// guide (docs/apps.md). Its one source is docs/apps-prompt.md, through its
// generated module; test/renderer/apps/appPrompt.test.js holds the module to the
// Markdown. Both the Apps panel's + menu and the insert palette hand it to the AI
// chat (requestBuildApp) as the App builder instructions chip in the message box: the person adds their own words
// and sends it, or clicks the chip to copy the instructions for an agent outside the project.
import { assert } from '../../../shared/core/assert';
import { agentTask } from '../../../shared/properties/agentTask';
import { requestAgentTask } from '../../lib/agentTasks';
import { provideBuiltinInstructions } from '../../lib/builtinInstructions';
import { APPS_PROMPT } from './generated/appsPrompt';

export const BUILD_APP_LABEL = 'Build an app';

/** The prompt text. */
export function appBuildPrompt(): string {
  assert(APPS_PROMPT.length > 0, 'The prompt is never empty');
  return APPS_PROMPT;
}

// The AI panel's "App builder instructions" chip carries this text; the panel reads it through lib because features
// may not import each other (src/lib/builtinInstructions.ts).
provideBuiltinInstructions('app-builder', appBuildPrompt);

/**
 * Opens the AI chat with the App builder instructions chip waiting in its message box, unsent (delivery `draft`,
 * `draftChip`, agentTasks.ts). With no AI chat to take it (a role without the panel, Studio without a chat) the prompt is copied
 * instead, and `notify` says so: the person is never left with nothing happening.
 */
export async function requestBuildApp(notify: (message: string, kind: 'success' | 'error') => void): Promise<void> {
  const outcome = await requestAgentTask(
    agentTask({
      title: BUILD_APP_LABEL,
      prompt: appBuildPrompt(),
      delivery: 'draft',
      draftChip: 'app-builder',
      context: { files: [], nodeRefs: [], findingIds: [] },
    }),
  );
  switch (outcome.tag) {
    case 'sent':
      return; // The chat is open with the chip in it; a notice would only repeat what is on screen.
    case 'copied':
      notify('The AI chat isn’t available here, so the “Build an app” prompt is copied. Paste it into your AI agent.', 'success');
      return;
    case 'failed':
      notify(`Stacki could not open the AI chat or copy the prompt: ${outcome.message}`, 'error');
      return;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
