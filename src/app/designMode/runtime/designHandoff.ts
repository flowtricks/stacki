// "Send to AI": a frame becomes a message waiting in the AI panel, never sent by itself. The message is the
// person's request (editable, prefilled) and pictures: the whole frame first, then a close-up of each changed
// area. What changed travels as each picture's note, which the agent reads right before the picture and the
// transcript never shows or stores (shared/ipc/aiChat.ts, `note`): the person sees their words and images, the
// agent gets the files, lines, components and values. Notes are one line of at most 500 characters each.
import type { PromptAttachment } from '../../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
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
} from '../../../features/ai/aiStore';
import { appendAttachments } from '../../../features/ai/screenshot/draftAttachments';
import { designChanges, type DesignChange } from '../model/designChanges';
import { changeSentence, noteLine, overviewNote } from './designHandoffText';
import { elementByDesignId, rectOf } from '../model/designDom';
import type { DesignFrameRecord, DesignPage } from '../model/designTypes';
import { captureFrame, cropCapture, encodeCanvas, type FrameCapture } from './designCapture';
import { frameBaseline, frameDocument, serializeFrame } from './designSession';

/** Close-ups at most: the attachment bound, less the overview and one the person may add. */
const CLOSE_UPS_MAX = AI_LIMITS.attachmentsMax - 2;
const CLOSE_UP_PADDING_PX = 32;
/** Each picture's size target, as the composer's own images aim (chatImages.ts). */
const IMAGE_CHARS_TARGET = 1_500_000;
const OVERVIEW_CHARS_TARGET = 4_000_000;

export type HandoffOutcome =
  { readonly kind: 'drafted'; readonly changes: number } | { readonly kind: 'failed'; readonly reason: 'capture' | 'chat' | 'frame' };

interface CloseUp {
  readonly region: { readonly xPx: number; readonly yPx: number; readonly widthPx: number; readonly heightPx: number };
  readonly sentences: readonly string[];
}

/** Changes grouped by the area of the frame they are in, top to bottom: one close-up per group. */
function closeUpsOf(document: Document, changes: readonly DesignChange[], frame: DesignFrameRecord): readonly CloseUp[] {
  const groups = new Map<Element, string[]>();
  for (const change of changes) {
    const element = anchorOf(document, change);
    if (element === undefined) {
      continue;
    }
    const sentences = groups.get(element) ?? [];
    sentences.push(changeSentence(change));
    groups.set(element, sentences);
  }
  const closeUps = [...groups].map(([element, sentences]) => {
    const rect = rectOf(element);
    return {
      region: {
        xPx: Math.max(0, rect.xPx - CLOSE_UP_PADDING_PX),
        yPx: Math.max(0, rect.yPx - CLOSE_UP_PADDING_PX),
        widthPx: Math.min(frame.widthPx, rect.widthPx + CLOSE_UP_PADDING_PX * 2),
        heightPx: Math.max(24, Math.min(frame.widthPx * 1.5, rect.heightPx + CLOSE_UP_PADDING_PX * 2)),
      },
      sentences,
    };
  });
  closeUps.sort((first, second) => first.region.yPx - second.region.yPx);
  if (closeUps.length <= CLOSE_UPS_MAX) {
    return closeUps;
  }
  // Past the bound, the last close-up carries the rest of the sentences.
  const kept = closeUps.slice(0, CLOSE_UPS_MAX);
  const rest = closeUps.slice(CLOSE_UPS_MAX).flatMap((closeUp) => closeUp.sentences);
  const last = kept.pop();
  return last === undefined ? kept : [...kept, { region: last.region, sentences: [...last.sentences, ...rest] }];
}

/** The visible element a change is about: itself, or for a removed element its parent. */
function anchorOf(document: Document, change: DesignChange): Element | undefined {
  const element = change.element.id === undefined ? undefined : elementByDesignId(document, change.element.id);
  if (element !== undefined && rectOf(element).heightPx > 0) {
    return element;
  }
  const parentId = 'parent' in change ? change.parent.id : undefined;
  const parent = parentId === undefined ? undefined : elementByDesignId(document, parentId);
  return parent ?? document.body ?? undefined;
}

function attachment(canvas: HTMLCanvasElement, name: string, note: string, charsMax: number): DraftAttachment | undefined {
  const encoded = encodeCanvas(canvas, charsMax);
  if (encoded === undefined) {
    return undefined;
  }
  const image: PromptAttachment = { kind: 'image', name, mimeType: encoded.mimeType, data: encoded.data, note };
  return { id: crypto.randomUUID(), attachment: image, preview: `data:${encoded.mimeType};base64,${encoded.data}` };
}

/** Captures a frame at one pixel per CSS pixel. */
export async function captureForAi(projectPath: string, frame: DesignFrameRecord): Promise<FrameCapture | undefined> {
  const html = serializeFrame(frame.id);
  return html === undefined ? undefined : captureFrame(projectPath, html, frame.widthPx, frame.viewportHeightPx, 1);
}

/** Puts the frame in the AI panel's message box with the request, waiting to be sent. */
export async function sendFrameToAi(page: DesignPage, frame: DesignFrameRecord, request: string, openPanel: () => void): Promise<HandoffOutcome> {
  const document = frameDocument(frame.id);
  const baseline = frameBaseline(frame.id);
  if (document === undefined || baseline === undefined) {
    return { kind: 'failed', reason: 'frame' };
  }
  const changes = designChanges(baseline.document, document, { instances: baseline.instances, sources: baseline.sources, pageFile: page.file });
  const closeUps = closeUpsOf(document, changes, frame);
  const capture = await captureForAi(page.projectPath, frame);
  if (capture === undefined) {
    return { kind: 'failed', reason: 'capture' };
  }
  const added: DraftAttachment[] = [];
  const overview = attachment(capture.canvas, `${frame.name}.png`, overviewNote(page, frame, changes.length, closeUps.length), OVERVIEW_CHARS_TARGET);
  if (overview === undefined) {
    return { kind: 'failed', reason: 'capture' };
  }
  added.push(overview);
  closeUps.forEach((closeUp, index) => {
    const note = noteLine(`Close-up ${String(index + 1)} of "${frame.name}": ${closeUp.sentences.join('; ')}`);
    const image = attachment(cropCapture(capture, closeUp.region), `${frame.name} close-up ${String(index + 1)}.png`, note, IMAGE_CHARS_TARGET);
    if (image !== undefined) {
      added.push(image);
    }
  });
  await loadAiProject(page.projectPath);
  const chat = await chatForDraft();
  if (chat === undefined) {
    return { kind: 'failed', reason: 'chat' };
  }
  setDraft(chat, () => ({ ...draftFromText(request), attachments: appendAttachments([], added).attachments }));
  openPanel();
  requestComposerFocus();
  return { kind: 'drafted', changes: changes.length };
}

/** The open chat when it is empty, else a new one: a draft the person was typing is never replaced. */
async function chatForDraft() {
  // As the AI panel's own hand-offs choose (aiAgentTask.ts reusableChat): an open chat with no messages and nothing typed.
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
