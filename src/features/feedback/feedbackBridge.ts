// The Feedback file through main: read, write, and the replies parsed before
// the panel trusts them. Also the text Copy for agent puts on the clipboard.
import { list, record, text } from '../../../shared/core/boundary';
import { parseFeedbackItem } from '../../../shared/ipc/feedback';
import type { FeedbackItem, TrailedFeedbackItem } from '../../../shared/ipc/feedback';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import type { Result } from '../../../shared/core/result';
import { cleanError } from '../../lib/cleanError';

export function parseFeedbackReply(input: unknown): readonly TrailedFeedbackItem[] {
  return list((entry) => ({
    ...parseFeedbackItem(entry),
    trail: list(text)(record(entry)['trail']),
  }))(record(input)['items']);
}

export function readFeedback(projectPath: string) {
  const payload = parseIpcPayload('feedback:read', { projectPath });
  return feedbackRequest(() => window.avb.readFeedback(payload));
}

export function writeFeedback(projectPath: string, items: readonly FeedbackItem[]) {
  // The trail is main's to resolve; the payload carries only the item fields.
  const payload = parseIpcPayload('feedback:write', { projectPath, items });
  return feedbackRequest(() => window.avb.writeFeedback(payload));
}

/** The one paste that starts the agent: the protocol, then each open item. The
 * file is named absolutely, so the paste works wherever the agent was started. */
export function renderHandoff(items: readonly TrailedFeedbackItem[], projectPath: string): string {
  const open = items.filter((item) => !item.done);
  const lines = open.map((item, index) => {
    const where = item.trail.length > 0 ? item.trail.join(' › ') : '(no source location)';
    return `${index + 1}. ${where} (${item.label}): ${item.note}`;
  });
  return [
    `Address the open items in ${projectPath}/.stacki/feedback.json (${open.length} open). ` +
      `Trails are relative to ${projectPath}. For each item, open every file:line in its ` +
      'trail — the last entry is the element, the earlier ones are the page and the ' +
      'component instances it sits in — make the change, then set that item\'s "done" to ' +
      'true in the file.',
    '',
    ...lines,
  ].join('\n');
}

async function feedbackRequest(
  invoke: () => Promise<unknown>,
): Promise<Result<readonly TrailedFeedbackItem[], string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parseFeedbackReply(response) };
}
