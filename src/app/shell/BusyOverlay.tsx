// The full-window "working" cover. Its own module so the start screen can show it
// without pulling the editor shell's modules into the first paint (WelcomeView.tsx).
//
// While it shows, the window is held (src/ui/busyLock.ts): the cover takes the pointer, and every key is taken
// here, in the capture phase, before the app's own shortcuts can undo, paste or type into what the work is changing.
import { useEffect } from 'react';
import { holdWindow } from '../../ui/busyLock';

export function BusyOverlay({ message }: { readonly message: string }) {
  useEffect(() => {
    const release = holdWindow();
    const swallow = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', swallow, { capture: true });
    return () => {
      window.removeEventListener('keydown', swallow, { capture: true });
      release();
    };
  }, []);
  return (
    <div className="busy-overlay">
      <div className="spinner" />
      <div>{message}</div>
    </div>
  );
}
