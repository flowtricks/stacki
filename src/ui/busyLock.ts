// Whether the window is held by its full-window "working" cover (BusyOverlay). While it is, nothing the person does
// may change the project underneath the work in progress: the cover takes the pointer, BusyOverlay takes every key
// before the app's own listeners, and the menu's edit commands, which reach the window over IPC and not as keys,
// ask here first (windowHeld). Counted, so two covers that overlap release the window only when both are gone.
// The one piece of module state is the count; holdWindow's release is the only thing that lowers it.

import { assert } from '../../shared/core/assert';

let holds = 0;

/** Holds the window until the returned release is called; calling it twice releases once. */
export function holdWindow(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    holds -= 1;
    assert(holds >= 0, 'holdWindow: releases never outnumber holds');
  };
}

/** Whether a cover holds the window: a menu command that changes the project does nothing while it does. */
export function windowHeld(): boolean {
  assert(holds >= 0, 'windowHeld: the hold count is never negative');
  return holds > 0;
}
