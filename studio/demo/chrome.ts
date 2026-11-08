// The demo's own controls, outside the editor: what is happening to your edits, a way
// to start over, and why a thing cannot be shown.
import type { NotShownReason } from './pageChange';
import type { StorageState } from './store';

const STORAGE_NOTES: Readonly<Record<StorageState, string>> = {
  saving: 'Edits stay in this browser.',
  blocked: 'This browser blocks storage, so edits last until you leave.',
  full: 'Browser storage is full, so new edits last until you leave.',
};

const NOTE_MS = 6_000;

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
  const note = document.createElement('p');
  note.className = 'demo-note';
  note.hidden = true;
  bar.append(storage, reset);
  document.body.append(bar, note);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lasting = '';
  const show = (text: string) => {
    note.textContent = text;
    note.hidden = text.length === 0;
  };
  return {
    storage: (state) => {
      storage.textContent = STORAGE_NOTES[state];
      bar.dataset['storage'] = state;
    },
    edits: (present) => {
      bar.hidden = !present;
    },
    notShown: (reasons) => {
      lasting = reasons[0] === undefined ? '' : `Not shown on the page: ${reasons[0]}`;
      if (timer === undefined) {
        show(lasting);
      }
    },
    note: (reason) => {
      clearTimeout(timer);
      show(reason);
      timer = setTimeout(() => {
        timer = undefined;
        show(lasting);
      }, NOTE_MS);
    },
  };
}
