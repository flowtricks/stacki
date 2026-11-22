// The one path every attachment takes into a draft: images pasted, dropped or picked, project files and
// screenshots are all appended here, so the count bound and the total image bound hold whichever way
// an attachment arrived. Pure, so tests drive it without a composer.
import { assert } from '../../../../shared/core/assert';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { DraftAttachment } from '../aiStore';

/**
 * The base64 characters all of a draft's images may hold together: eight prepared images at their
 * 1.5 million character target. It keeps one message far below the agents' request limits and the
 * draft's memory small (the bytes live only in memory, and only until the message is sent or cleared).
 */
export const DRAFT_IMAGE_CHARS_MAX = AI_LIMITS.attachmentsMax * 1_500_000;

export type AppendOutcome =
  | { readonly kind: 'appended'; readonly attachments: readonly DraftAttachment[] }
  /** Some or all were left out; `attachments` holds what fits, in order. */
  | { readonly kind: 'limited'; readonly attachments: readonly DraftAttachment[]; readonly reason: 'count' | 'size' };

/** `current` with as many of `added` as fit, in order; the first one that does not fit stops the rest. */
export function appendAttachments(current: readonly DraftAttachment[], added: readonly DraftAttachment[]): AppendOutcome {
  assert(current.length <= AI_LIMITS.attachmentsMax, 'appendAttachments: the draft is already within the count bound');
  assert(imageChars(current) <= DRAFT_IMAGE_CHARS_MAX, 'appendAttachments: the draft is already within the size bound');
  const next = [...current];
  let chars = imageChars(current);
  for (const entry of added) {
    if (next.length < AI_LIMITS.attachmentsMax) {
      const size = entry.attachment.kind === 'image' ? entry.attachment.data.length : 0;
      if (chars + size <= DRAFT_IMAGE_CHARS_MAX) {
        next.push(entry);
        chars += size;
      } else {
        return { kind: 'limited', attachments: next, reason: 'size' };
      }
    } else {
      return { kind: 'limited', attachments: next, reason: 'count' };
    }
  }
  assert(next.length === current.length + added.length, 'appendAttachments: everything fitted');
  return { kind: 'appended', attachments: next };
}

/** The number the next screenshot in this draft takes: one past the highest, so a removal never repeats a number. */
export function nextScreenshotNumber(attachments: readonly DraftAttachment[]): number {
  assert(attachments.length <= AI_LIMITS.attachmentsMax, 'nextScreenshotNumber: the draft is bounded');
  const highest = attachments.reduce((most, entry) => Math.max(most, entry.screenshotNumber ?? 0), 0);
  return highest + 1;
}

function imageChars(attachments: readonly DraftAttachment[]): number {
  return attachments.reduce((sum, entry) => sum + (entry.attachment.kind === 'image' ? entry.attachment.data.length : 0), 0);
}
