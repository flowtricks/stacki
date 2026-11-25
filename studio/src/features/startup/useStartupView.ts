import { useEffect, useState } from 'react';
import { pollStartup, readStartupView } from './startupPoll';
import type { StartupView } from './startupStages';

const realClock = { now: () => Date.now(), sleep: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)) };

/**
 * Where the container's start is, while `active`; `undefined` until the Worker has said (and
 * for good when it has no such route). Polling stops at ready, at the poll limit, or when
 * `active` turns false.
 */
export function useStartupView(active: boolean, firstDelayMs: number): StartupView | undefined {
  const [view, setView] = useState<StartupView>();
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    setView(undefined);
    const controller = new AbortController();
    void pollStartup({ read: readStartupView, onView: setView, clock: realClock, signal: controller.signal, firstDelayMs });
    return () => controller.abort();
  }, [active, firstDelayMs]);
  // A view read for an earlier wait says nothing about this one.
  return active ? view : undefined;
}
