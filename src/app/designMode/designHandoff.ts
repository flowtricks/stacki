// Design mode (experimental, removable: docs/design-mode/REMOVE.md): Send to AI.
//
// The AI cannot work while the window is on the sandbox (the fence refuses the agent), and what it should rebuild
// is the project itself. So Send to AI writes the request first: every frame's picture and its changed source,
// as hunks against the project. Main holds it across the window's reload back to the project
// (`design:session` exit, then take-handoff), and there it becomes the AI panel's draft, waiting to be sent.
import type { PromptAttachment } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { DESIGN_SESSION_LIMITS, type DesignFrameChanges, type DesignHandoff } from '../../../shared/ipc/designSession';
import {
  aiState,
  draftFromText,
  isDraftEmpty,
  loadAiProject,
  newChat,
  preferredAgent,
  requestComposerFocus,
  setDraft,
  type DraftAttachment,
} from '../../features/ai/aiStore';
import { appendAttachments } from '../../features/ai/screenshot/draftAttachments';
import type { DesignWords } from './i18n/designWords';

/** The request: what to do, then each frame's changes, within what the composer takes. */
export function handoffText(frames: readonly DesignFrameChanges[], active: string, words: DesignWords): string {
  const parts = [words('handoff.intro', { name: active })];
  for (const frame of frames) {
    if (frame.changedFiles === 0) {
      parts.push(words('handoff.unchanged', { name: frame.name }));
    } else {
      parts.push(`${words('handoff.frame', { name: frame.name, count: frame.changedFiles })}\n\`\`\`diff\n${frame.text}\n\`\`\``);
    }
  }
  const text = parts.join('\n\n');
  const charsMax = Math.min(DESIGN_SESSION_LIMITS.handoffTextCharsMax, AI_LIMITS.promptCharsMax);
  return text.length <= charsMax ? text : `${text.slice(0, charsMax - 1)}…`;
}

/** Puts a handoff in the AI panel's message box for the project now open. False when no chat could take it. */
export async function draftHandoff(projectPath: string, handoff: DesignHandoff): Promise<boolean> {
  await loadAiProject(projectPath);
  const chat = await chatForDraft();
  if (chat === undefined) {
    return false;
  }
  const attachments: DraftAttachment[] = handoff.images.slice(0, AI_LIMITS.attachmentsMax).map((image, index) => {
    const name = `${handoff.names[index] ?? String(index + 1)}.png`;
    const attachment: PromptAttachment = { kind: 'image', name, mimeType: 'image/png', data: image.slice(image.indexOf(',') + 1), note: name };
    return { id: crypto.randomUUID(), attachment, preview: image };
  });
  setDraft(chat, () => ({ ...draftFromText(handoff.text), attachments: appendAttachments([], attachments).attachments }));
  requestComposerFocus();
  return true;
}

/** The open chat when it is empty, else a new one: a draft the person was typing is never replaced. */
async function chatForDraft() {
  const state = aiState();
  const open = state.open;
  if (open !== undefined) {
    const view = state.views.get(open);
    const draft = state.drafts.get(open);
    if (view !== undefined && view.items.length === 0 && (draft === undefined || isDraftEmpty(draft))) {
      return open;
    }
  }
  return newChat(preferredAgent(), 'chat');
}
