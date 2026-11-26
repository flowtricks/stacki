// Design mode (experimental, removable: docs/design-mode/REMOVE.md): Send to AI.
//
// The AI cannot work while the window is on the sandbox (the fence refuses the agent), and what it should rebuild
// is the project itself. So Send to AI writes the request first: the chosen frame's picture and one sentence naming
// the page. Nothing else of the design goes: no source changes, no styles, no positions, which would only lead the
// AI to copy a drag's offsets instead of building what the picture shows. Main holds the request across the window's
// reload back to the project (`design:session` exit, then take-handoff), and there it becomes the AI panel's draft,
// to be read, changed and sent by the person.
import type { PromptAttachment } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { DesignHandoff } from '../../../shared/ipc/designSession';
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

/** The whole request: the page, and that the picture is what it should look like. */
export function handoffText(route: string, pictures: number, words: DesignWords): string {
  return pictures > 1 ? words('handoff.many', { page: route }) : words('handoff.one', { page: route });
}

/** Puts a handoff in the AI panel's message box for the project now open. False when no chat could take it. */
export async function draftHandoff(projectPath: string, handoff: DesignHandoff): Promise<boolean> {
  await loadAiProject(projectPath);
  const chat = await chatForDraft();
  if (chat === undefined) {
    return false;
  }
  const attachments: DraftAttachment[] = handoff.images.slice(0, AI_LIMITS.attachmentsMax).map((image, index) => {
    const mimeType = image.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
    const name = `${handoff.names[index] ?? String(index + 1)}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
    const attachment: PromptAttachment = { kind: 'image', name, mimeType, data: image.slice(image.indexOf(',') + 1), note: name };
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
