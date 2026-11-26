// A hold on the AI panel's agent: while one is set, the panel keeps its chats readable but offers nothing the
// agent would act on (no trust or setup card, no early start, the composer disabled with the hold's reason).
//
// Set by Design mode (experimental, docs/design-mode/REMOVE.md) while the window works on a sandbox copy, where
// main refuses the agent: a live button the fence refuses would do nothing. With nobody setting it this module
// changes nothing. Framework-free; React reads it through `useAiHold`.
import { useSyncExternalStore } from 'react';

let reason: string | undefined = undefined;
const listeners = new Set<() => void>();

/** Holds the agent with `next` as the reason shown, or releases it with undefined. */
export function setAiHold(next: string | undefined): void {
  if (next === reason) {
    return;
  }
  reason = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const current = (): string | undefined => reason;

/** The hold's reason, or undefined when the agent is free. */
export function useAiHold(): string | undefined {
  return useSyncExternalStore(subscribe, current, current);
}
