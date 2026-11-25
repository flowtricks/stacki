// The demo's own controls, outside the editor: what is happening to your edits, a way
// to start over, and why a thing cannot be shown.
import type { NotShownReason } from './pageChange';
import type { StorageState } from './store';
import { DEMO_NOTICE_EVENT, DEMO_NOTICE_READY_EVENT } from '../src/features/notifications/demoNotice';

const STORAGE_NOTES: Readonly<Record<StorageState, string>> = {
  saving: 'Edits stay in this browser.',
  blocked: 'This browser blocks storage, so edits last until you leave.',
  full: 'Browser storage is full, so new edits last until you leave.',
};

// demo.js and studio.js are separate bundles, so a window event carries the notice to
// Studio's own toast stack (useNotifications.ts); the demo draws no toast of its own.
function sendDemoNotice(message: string): void {
  window.dispatchEvent(new CustomEvent(DEMO_NOTICE_EVENT, { detail: message }));
}

export interface DemoChrome {
  readonly storage: (state: StorageState) => void;
  /** Shows the storage note and Reset only while there are edits to reset. */
  readonly edits: (present: boolean) => void;
  readonly notShown: (reasons: readonly NotShownReason[]) => void;
  readonly note: (reason: string) => void;
}

export function installDemoChrome(actions: { readonly reset: () => Promise<void> }): DemoChrome {
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  bar.setAttribute('role', 'status');
  // Hidden until the visitor has an edit: with nothing to reset, Reset is noise.
  bar.hidden = true;
  const storage = document.createElement('span');
  storage.className = 'demo-storage';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'demo-reset';
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => void actions.reset());
  bar.append(storage, reset);
  document.body.append(bar);
  // The reason the page cannot show right now. It is told once per change, not per
  // render, and told again if the editor's toasts mount after it was first found.
  let lasting = '';
  window.addEventListener(DEMO_NOTICE_READY_EVENT, () => {
    if (lasting.length > 0) {
      sendDemoNotice(lasting);
    }
  });
  return {
    storage: (state) => {
      storage.textContent = STORAGE_NOTES[state];
      bar.dataset['storage'] = state;
    },
    edits: (present) => {
      bar.hidden = !present;
    },
    notShown: (reasons) => {
      const next = reasons[0] === undefined ? '' : `Not shown on the page: ${reasons[0]}`;
      if (next !== lasting && next.length > 0) {
        sendDemoNotice(next);
      }
      lasting = next;
    },
    note: sendDemoNotice,
  };
}
