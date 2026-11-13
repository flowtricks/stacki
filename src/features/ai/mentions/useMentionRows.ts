// The `@` picker's rows for what was typed after the trigger: the built-in chips
// matched here, and project files and skills asked of the main process. A keystroke
// asks again after a short pause, an answer that arrives after a newer question is
// dropped, and a failed search leaves the built-in rows (and says so) instead of
// breaking the box.
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
  // An answer for an older query would list rows that no longer match what is typed; show the built-in ones until the right one lands.
  const fresh = found?.query === query ? found : undefined;
  return {
    rows: pickerRows(builtins, fresh?.candidates ?? [], translate),
    state: fresh === undefined ? 'searching' : fresh.candidates === undefined ? 'failed' : 'ready',
  };
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
