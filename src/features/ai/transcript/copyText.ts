// Copying text for the transcript's "Copy" actions. Clipboard access can be refused (no permission,
// an insecure context, a test window), so the result is a value the button shows, never a throw.
import { useEffect, useRef, useState } from 'react';

export const COPY_LIMITS = {
  /** How long a button says "Copied" before it goes back to "Copy". */
  confirmMs: 1_500,
} as const satisfies Record<string, number>;

export type CopyState = 'idle' | 'copied' | 'failed';

/** Writes `text` to the clipboard. */
export async function copyText(text: string): Promise<'copied' | 'failed'> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch (error: unknown) {
    console.error('Copying to the clipboard failed', error);
    return 'failed';
  }
}

/** A copy action and the state its button shows: "Copied" or "Couldn't copy" for a moment, then idle. */
export function useCopy(): { readonly state: CopyState; readonly copy: (text: string) => void } {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  const copy = (text: string): void => {
    void copyText(text).then((result) => {
      setState(result);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), COPY_LIMITS.confirmMs);
    });
  };
  return { state, copy };
}
