import { useEffect, useState } from 'react';
import { assert } from '../../shared/core/assert';

// A refusal of what is still being typed ("not a complete address" at the third letter) is not news: it is said, as a
// toast, only once the same refusal has stood for `settleMs` with no further edit. A cleared refusal clears at once, so a
// toast never reports a state the form has already left. Why not toast each keystroke: the stack would flicker with
// sentences about half-typed values, and the reader could not tell which one still holds.
export function useSettledMessage(message: string | undefined, settleMs: number): string | undefined {
  assert(Number.isSafeInteger(settleMs), 'useSettledMessage: the delay is whole milliseconds');
  assert(settleMs > 0, 'useSettledMessage: the delay is positive');
  const [settled, setSettled] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (message === undefined) {
      setSettled(undefined);
      return undefined;
    }
    const timer = setTimeout(() => setSettled(message), settleMs);
    return () => clearTimeout(timer);
  }, [message, settleMs]);
  return message === undefined ? undefined : settled;
}
