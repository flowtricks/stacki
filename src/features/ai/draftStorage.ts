// Drafts that survive a reload: what a person has typed in a chat's composer is
// kept in the browser's storage, per project, so closing the window or the
// panel does not lose a half-written message.
//
// Storage is another program's data (an older build, hand-edited, quota-trimmed),
// so a read never throws: every entry goes through the boundary parser
// (`parseDraftSegments`) and a bad entry is dropped alone. A write that fails
// (private window, quota) is only forgotten, as the panel's other preferences
// are. Bounded by `draftsStoredMax` entries per project; attachments are not kept
// (they are encoded images, too large to keep in a draft).
import { assert } from '../../../shared/core/assert';
import { toArray, toRecord } from '../../../shared/core/record';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { toChatId, type ChatId } from '../../../shared/properties/ai/chatModel';
import { parseDraftSegments, type ComposerSegments } from '../../../shared/properties/ai/mentions';

const KEY_PREFIX = 'stacki.ai.drafts.';
const FORMAT_VERSION = 1;

/** Whether a draft has anything worth keeping: some text that is not only space, or any chip. */
export function hasDraftContent(segments: ComposerSegments): boolean {
  return segments.some((segment) => segment.kind === 'chip' || segment.text.trim() !== '');
}

/**
 * The drafts stored for `projectPath`, oldest first. Entries that fail to parse, name a chat id that is
 * not one, or exceed a bound are skipped, never the whole read.
 */
export function readStoredDrafts(projectPath: string): ReadonlyMap<ChatId, ComposerSegments> {
  const drafts = new Map<ChatId, ComposerSegments>();
  let stored: unknown;
  try {
    const source = localStorage.getItem(`${KEY_PREFIX}${projectPath}`);
    if (source === null) {
      return drafts;
    }
    stored = JSON.parse(source);
  } catch {
    return drafts; // Storage unavailable or not JSON: no drafts, as if none were stored.
  }
  const root = toRecord(stored);
  const entries = root === undefined || root['version'] !== FORMAT_VERSION ? undefined : toArray(root['drafts']);
  if (entries === undefined) {
    return drafts;
  }
  for (const entry of entries.slice(0, AI_LIMITS.draftsStoredMax)) {
    const record = toRecord(entry);
    if (record === undefined || typeof record['chat'] !== 'string') {
      continue;
    }
    let chat: ChatId;
    try {
      chat = toChatId(record['chat']);
    } catch {
      continue; // Not a chat id: the entry is not ours.
    }
    const segments = parseDraftSegments(record['segments']);
    if (segments.ok && hasDraftContent(segments.value)) {
      drafts.set(chat, segments.value);
    }
  }
  assert(drafts.size <= AI_LIMITS.draftsStoredMax, 'readStoredDrafts: bounded');
  return drafts;
}

/**
 * Stores the newest `draftsStoredMax` drafts that have content (`drafts` is oldest first), and nothing at
 * all when none has: an emptied composer leaves no key behind.
 */
export function writeStoredDrafts(projectPath: string, drafts: ReadonlyMap<ChatId, ComposerSegments>): void {
  const kept = [...drafts].filter(([, segments]) => hasDraftContent(segments)).slice(-AI_LIMITS.draftsStoredMax);
  assert(kept.length <= AI_LIMITS.draftsStoredMax, 'writeStoredDrafts: bounded');
  try {
    if (kept.length === 0) {
      localStorage.removeItem(`${KEY_PREFIX}${projectPath}`);
      return;
    }
    localStorage.setItem(
      `${KEY_PREFIX}${projectPath}`,
      JSON.stringify({ version: FORMAT_VERSION, drafts: kept.map(([chat, segments]) => ({ chat, segments })) }),
    );
  } catch {
    // A draft that cannot be stored is only forgotten on reload.
  }
}
