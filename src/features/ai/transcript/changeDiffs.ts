// Loads, once, the text of a pending file before and after a turn (the `ai:diff` channel) for the
// changes card, and remembers the line counts after the change is settled, because the host keeps
// no content for a settled file (docs/contracts.md, AI panel). The card remounts when the transcript
// does, so the answers live here, not in component state.
//
// Both maps are bounded and drop their oldest entry first (AGENTS.md section 10): a long session
// that reviews many turns must not hold every file's text.
import type { ChatId, TurnId } from '../../../../shared/properties/ai/chatModel';
import { loadChangeDiff } from '../aiStore';
import { buildFileDiff, countsOf, type ChangeCounts } from './diffModel';
import type { DiffSides } from './DiffView';

export const CHANGE_DIFF_LIMITS = {
  /** Files whose text is held for an inline diff. */
  textEntriesMax: 48,
  /** Files whose line counts are remembered after Keep or Undo. */
  countEntriesMax: 1_000,
  /** Files of one card whose diff is fetched on its own; a larger card loads a file when it is opened. */
  autoLoadMax: 24,
} as const satisfies Record<string, number>;

/** What loading a pending file's diff came to. `unavailable`: the host had no text for it (settled, moved on, or the call failed). */
export type LoadedDiff = { readonly state: 'ready'; readonly sides: DiffSides; readonly counts: ChangeCounts | undefined } | { readonly state: 'unavailable' };

const texts = new Map<string, Promise<LoadedDiff>>();
const counts = new Map<string, ChangeCounts | 'none'>();

function keyOf(chat: ChatId, turn: TurnId, path: string): string {
  return `${chat}\u0000${turn}\u0000${path}`;
}

/** The diff of a pending file; one request per file however many times it is asked for. */
export function loadFileDiff(chat: ChatId, turn: TurnId, path: string): Promise<LoadedDiff> {
  const key = keyOf(chat, turn, path);
  const known = texts.get(key);
  if (known !== undefined) {
    return known;
  }
  const request = fetchDiff(chat, turn, path).then((loaded) => {
    if (loaded.state === 'unavailable') {
      // A failure is not remembered: the next ask may succeed (the host was busy), and a settled file is never asked for.
      texts.delete(key);
    } else {
      counts.set(key, loaded.counts ?? 'none');
      trim(counts, CHANGE_DIFF_LIMITS.countEntriesMax);
    }
    return loaded;
  });
  texts.set(key, request);
  trim(texts, CHANGE_DIFF_LIMITS.textEntriesMax);
  return request;
}

/** The counts of a file loaded earlier, `'none'` for a file with nothing to count, undefined when never loaded. */
export function rememberedCounts(chat: ChatId, turn: TurnId, path: string): ChangeCounts | 'none' | undefined {
  return counts.get(keyOf(chat, turn, path));
}

/** Forgets everything; a new project or a test starts clean. */
export function resetChangeDiffs(): void {
  texts.clear();
  counts.clear();
}

async function fetchDiff(chat: ChatId, turn: TurnId, path: string): Promise<LoadedDiff> {
  try {
    const reply = await loadChangeDiff(chat, turn, path);
    if (!reply.ok) {
      return { state: 'unavailable' };
    }
    const { oldText, newText } = reply.value;
    // Neither side present: the ledger has nothing to compare.
    if (oldText === undefined && newText === undefined) {
      return { state: 'unavailable' };
    }
    return { state: 'ready', sides: { path, oldText, newText }, counts: countsOf(buildFileDiff(oldText, newText)) };
  } catch (error: unknown) {
    // The bridge turns failures into replies, so a throw is a bug elsewhere; the row shows the diff as unavailable rather than breaking the card.
    console.error('Loading a change diff failed', error);
    return { state: 'unavailable' };
  }
}

function trim<Value>(map: Map<string, Value>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) {
      return;
    }
    map.delete(oldest.value);
  }
}
