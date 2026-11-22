// The `@` picker's rows for what was typed after the trigger: the built-in chips
// matched here, and project files and skills asked of the main process. A keystroke
// asks again after a short pause, an answer that arrives after a newer question is
// dropped, and a failed search leaves the built-in rows (and says so) instead of
// breaking the box.
//
// Stale while it revalidates: between a keystroke and its answer the picker keeps the
// last answer, narrowed to what is typed now, rather than dropping to the built-in rows
// and back, which made the list flicker as each answer landed.
import { useEffect, useState } from 'react';
import type { MentionCandidate, MentionKind } from '../../../../shared/properties/ai/mentions';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { AiReply } from '../aiBridge';
import { matchingBuiltinChips } from './builtinChips';
import { pickerRows, type PickerRow } from './mentionChips';

/** The pause between the last keystroke and the question to the main process. */
export const SEARCH_DELAY_MS = 60;
const KINDS: readonly MentionKind[] = ['skill', 'file'];

export type MentionSearch = (query: string, kinds: readonly MentionKind[]) => Promise<AiReply<readonly MentionCandidate[]>>;

export interface MentionRows {
  readonly rows: readonly PickerRow[];
  /** The search failed or has not answered yet; the rows are only the built-in ones. */
  readonly state: 'searching' | 'ready' | 'failed';
}

/** `query` is undefined while the picker is closed: nothing is asked then. */
export function useMentionRows(query: string | undefined, search: MentionSearch): MentionRows {
  const translate = useTranslate();
  const [found, setFound] = useState<{ readonly query: string; readonly candidates: readonly MentionCandidate[] | undefined } | undefined>(undefined);
  useEffect(() => {
    if (query === undefined) {
      setFound(undefined);
      return undefined;
    }
    let current = true;
    const timer = setTimeout(() => {
      const answer = askSafely(search, query);
      void answer.then((candidates) => {
        if (current) {
          setFound({ query, candidates });
        }
      });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, search]);
  if (query === undefined) {
    return { rows: [], state: 'ready' };
  }
  const builtins = matchingBuiltinChips(query);
  const candidates = found?.query === query ? found.candidates : stillMatching(found?.candidates, query);
  return {
    rows: pickerRows(builtins, candidates ?? [], translate),
    state: found === undefined ? 'searching' : found.candidates === undefined ? 'failed' : 'ready',
  };
}

/** An older answer narrowed to what is typed now: a candidate stays while its name or path still holds the query. */
export function stillMatching(candidates: readonly MentionCandidate[] | undefined, query: string): readonly MentionCandidate[] | undefined {
  if (candidates === undefined) {
    return undefined;
  }
  const needle = query.trim().toLocaleLowerCase();
  return candidates.filter((candidate) => needle === '' || `${candidate.name} ${candidate.path}`.toLocaleLowerCase().includes(needle));
}

/** The candidates, or undefined when the search could not run (no project open, the main process refused). */
async function askSafely(search: MentionSearch, query: string): Promise<readonly MentionCandidate[] | undefined> {
  try {
    const reply = await search(query, KINDS);
    return reply.ok ? reply.value : undefined;
  } catch {
    // The search is optional help: a bridge error must not take the message box down with it.
    return undefined;
  }
}
