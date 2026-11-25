// Whether CSS in the code editors is drawn with chips ("Show CSS chips in code"). The preference lives
// in the app's own settings file (main process, `codeChips`), once per person and never in a project.
//
// The renderer keeps one copy. It starts on, the default, so the first frame of an editor already has
// its chips; the saved choice is read once, the first time an editor asks, and replaced whenever the
// person flips the switch in Settings. Every editor listens (codeChipsExtension.ts), so turning it off
// shows plain CSS in each open editor at once, with no remount. Studio and the demo have no app
// settings file and keep the default.

import { useSyncExternalStore } from 'react';
import { parseIpcPayload } from '../../../../shared/ipc/ipcPayloads';
import { parsePreferences } from '../../../../shared/ipc/preferences';

/** `shown`: values are drawn as chips. `plain`: the editors show the CSS as written, nothing over it. */
export type CodeChipsMode = 'shown' | 'plain';

let mode: CodeChipsMode = 'shown';
let loadStarted = false;
const listeners = new Set<() => void>();

/** The mode a saved `codeChips` switch stands for. */
export function codeChipsModeOf({ enabled }: { readonly enabled: boolean }): CodeChipsMode {
  return enabled ? 'shown' : 'plain';
}

/** Makes `next` the mode every editor shows. Used by the loader and by Settings. */
export function publishCodeChipsMode(next: CodeChipsMode): void {
  if (next === mode) {
    return;
  }
  mode = next;
  for (const listener of listeners) {
    listener();
  }
}

export function currentCodeChipsMode(): CodeChipsMode {
  return mode;
}

/** Calls `listener` after each change of mode; the returned function stops it. */
export function subscribeCodeChipsMode(listener: () => void): () => void {
  listeners.add(listener);
  loadCodeChipsModeOnce();
  return () => {
    listeners.delete(listener);
  };
}

export function useCodeChipsMode(): CodeChipsMode {
  return useSyncExternalStore(subscribeCodeChipsMode, currentCodeChipsMode, currentCodeChipsMode);
}

// Reads the saved choice the first time anything listens. Only Desktop has the settings channel; a
// failure keeps the default, since an editor is never blocked on a setting.
function loadCodeChipsModeOnce(): void {
  if (loadStarted) {
    return;
  }
  loadStarted = true;
  if (typeof window === 'undefined') {
    return;
  }
  if (typeof window.avb?.settings !== 'function') {
    return;
  }
  void window.avb.settings(parseIpcPayload('settings:get', undefined)).then(
    (reply: unknown) => publishCodeChipsMode(codeChipsModeOf({ enabled: parsePreferences(reply).codeChips })),
    (error: unknown) => console.error('Reading the CSS chips preference failed', error),
  );
}
