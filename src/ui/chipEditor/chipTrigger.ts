// Detecting the `@` a chip picker opens from, and the keys a picker takes over from the editor.
//
// `chipTrigger` watches the cursor and reports the trigger it sits in (`@sk` -> query "sk")
// or that there is none. It reports nothing while an input method is composing: an IME
// candidate window and a picker both want the arrow keys and Enter, and the IME has the
// better claim. The picker itself is ChipPicker.tsx; the editor keeps focus the whole time,
// so these keys have to be routed from the editor, which `pickerKeymap` does.
import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { assert } from '../../../shared/core/assert';
import { findTrigger } from './chipModel';

export interface ActiveTrigger {
  /** Document positions of the trigger character through the cursor: replacing them replaces what was typed. */
  readonly from: number;
  readonly to: number;
  readonly query: string;
  /** Where the trigger is on screen (viewport coordinates); undefined when the editor cannot measure it (not laid out). */
  readonly anchor: { readonly left: number; readonly top: number; readonly bottom: number } | undefined;
}

export interface ChipTriggerOptions {
  /** The character that opens the picker. */
  readonly trigger: string;
  readonly onChange: (trigger: ActiveTrigger | undefined) => void;
}

export function chipTrigger(options: ChipTriggerOptions): Extension {
  assert(options.trigger.length === 1, 'chipTrigger: the trigger is one character');
  return ViewPlugin.fromClass(
    class {
      private reported: { readonly from: number; readonly to: number; readonly query: string } | undefined;

      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.selectionSet && !update.focusChanged) {
          return;
        }
        const match = this.find(update.view);
        if (match === undefined) {
          // Nothing to measure: a stale measurement still queued must not reopen the picker.
          update.view.requestMeasure({ key: this, read: () => undefined, write: () => undefined });
          this.report(undefined);
          return;
        }
        const unchanged = this.reported?.from === match.from && this.reported.to === match.to && this.reported.query === match.query;
        if (unchanged) {
          return;
        }
        // Screen coordinates need layout, which an editor update may not read; CodeMirror's
        // measure phase runs right after it, so the caller is told once the position is known.
        update.view.requestMeasure({
          key: this,
          read: (view) => view.coordsAtPos(match.from) ?? undefined,
          write: (coordinates) => {
            this.report({
              ...match,
              anchor: coordinates === undefined ? undefined : { left: coordinates.left, top: coordinates.top, bottom: coordinates.bottom },
            });
          },
        });
      }

      destroy(): void {
        this.report(undefined);
      }

      private find(view: EditorView): Omit<ActiveTrigger, 'anchor'> | undefined {
        const selection = view.state.selection.main;
        if (!selection.empty || view.composing || !view.hasFocus) {
          return undefined;
        }
        const line = view.state.doc.lineAt(selection.head);
        const match = findTrigger(line.text.slice(0, selection.head - line.from), options.trigger);
        if (match === undefined) {
          return undefined;
        }
        return { from: line.from + match.offset, to: selection.head, query: match.query };
      }

      // The caller is told only when the trigger actually changes, not on every keystroke elsewhere.
      private report(next: ActiveTrigger | undefined): void {
        const previous = this.reported;
        if (previous === undefined && next === undefined) {
          return;
        }
        this.reported = next === undefined ? undefined : { from: next.from, to: next.to, query: next.query };
        options.onChange(next);
      }
    },
  );
}

export type PickerKey = 'up' | 'down' | 'choose' | 'close';

export interface PickerKeymapOptions {
  /** Read each time a key arrives: keys pass through to the editor whenever this is false. */
  readonly isOpen: () => boolean;
  /** Return true when the key was used, which stops the editor from also acting on it. */
  readonly onKey: (key: PickerKey) => boolean;
}

/** Routes the picker's keys (arrows, Enter, Tab, Escape) from the editor while the picker is open. */
export function pickerKeymap(options: PickerKeymapOptions): Extension {
  const route =
    (key: PickerKey) =>
    (view: EditorView): boolean =>
      // An input method that is composing owns these keys.
      options.isOpen() && !view.composing && options.onKey(key);
  return Prec.highest(
    keymap.of([
      { key: 'ArrowDown', run: route('down') },
      { key: 'ArrowUp', run: route('up') },
      { key: 'Enter', run: route('choose') },
      { key: 'Tab', run: route('choose') },
      { key: 'Escape', run: route('close') },
    ]),
  );
}
