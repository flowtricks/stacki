import { useCallback, useEffect, useRef, useState } from 'react';

export const POPUP_MOTION_MS = 160;
export type PopupPhase = 'opening' | 'open' | 'closing' | 'closed';

export function usePopupLifecycle({ open }: { readonly open: boolean }, onClose: () => void) {
  const [phase, setPhase] = useState<PopupPhase>(open ? 'opening' : 'closed');
  const completion = useRef<(() => void) | undefined>(undefined);
  const callback = useRef(onClose);
  callback.current = onClose;
  const finish = useCallback((action: () => void): void => {
    if (completion.current) {
      return;
    }
    completion.current = action;
    setPhase('closing');
  }, []);
  const close = useCallback(() => finish(() => callback.current()), [finish]);
  // Only a change of `open` restarts or ends the popup, never the mount: a passive effect runs after the popup is on
  // screen, so a close asked for in between would lose its action to it. The popup then left the screen without
  // `onClose`, and its owner kept a dialog nobody could see (the next question never appeared).
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) {
      return;
    }
    wasOpen.current = open;
    completion.current = undefined;
    setPhase((current) => (open ? 'opening' : current === 'closed' ? 'closed' : 'closing'));
  }, [open]);
  useEffect(() => {
    if (phase === 'opening') {
      let frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          // An Escape or outside press can arrive before the opening frame paints.
          setPhase((current) => (current === 'opening' ? 'open' : current));
        });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (phase !== 'closing') {
      return undefined;
    }
    const done = (): void => {
      const action = completion.current;
      completion.current = undefined;
      setPhase('closed');
      action?.();
    };
    // Keep content mounted through exit; reduced-motion users get immediate dismissal.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduced) {
      let active = true;
      queueMicrotask(() => {
        if (active) {
          done();
        }
      });
      return () => {
        active = false;
      };
    }
    const timer = window.setTimeout(done, POPUP_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  return { phase, close, finish } as const;
}
