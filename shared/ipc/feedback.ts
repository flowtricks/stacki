// The Feedback panel's file, `.stacki/feedback.json` in the open project: notes
// pinned to canvas selections, read and edited by Stacki and by a coding agent
// alike. The file is the whole interface; nothing listens on a port.
import { assert } from '../core/assert';
import { boolean, list, object, optional, record, text } from '../core/boundary';
import type { Parsed } from '../core/boundary';

export const FEEDBACK_FILE_VERSION = 1;

// `keys` are selection keys (`<file>#<index path>`: the page, each drilled-in
// host, then the leaf). An agent may append its own items with `keys: []`, so
// `createdAt` is optional for them; the trail is main's to resolve, never read.
export const parseFeedbackItem = object({
  id: text,
  keys: list(text),
  label: text,
  note: text,
  createdAt: optional(text),
  done: boolean,
});
export type FeedbackItem = Parsed<typeof parseFeedbackItem>;

/** An item with the `file:line` trail main resolved from its keys. */
export type TrailedFeedbackItem = FeedbackItem & { readonly trail: readonly string[] };

export interface FeedbackFile {
  readonly version: typeof FEEDBACK_FILE_VERSION;
  readonly items: readonly FeedbackItem[];
}

export function parseFeedbackFile(input: unknown): FeedbackFile {
  const value = record(input);
  if (value['version'] !== FEEDBACK_FILE_VERSION) {
    throw new Error(`Feedback file: expected version ${FEEDBACK_FILE_VERSION}`);
  }
  const items = list(parseFeedbackItem)(value['items']);
  // Ids key the list and the pins; two items sharing one would edit each other.
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error('Feedback file: duplicate item id');
  }
  assert(Array.isArray(items), 'Feedback items parse to an array');
  assert(
    items.every((item) => typeof item.done === 'boolean'),
    'Every feedback item says whether it is done',
  );
  return { version: FEEDBACK_FILE_VERSION, items };
}
