import { useEffect } from 'react';
import type { useDefaultsCanvas } from './useDefaultsCanvas';

// The owned root is the editing boundary, not an instance that can be removed or duplicated.
// Capture before the ordinary editor shortcuts; text fields keep their normal editing keys.
export function useDefaultsKeyboard(
  canvas: ReturnType<typeof useDefaultsCanvas>,
  selection: { readonly selected: string | undefined; readonly root: string | undefined },
): void {
  useEffect(() => {
    if (canvas.state.kind === 'idle') {
      return;
    }
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      if (document.querySelector('[role="dialog"], dialog[open], [role="menu"], [role="listbox"]')) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void canvas.run('done');
        return;
      }
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], .cm-editor')) {
        return;
      }
      if (selection.root === undefined || selection.selected !== selection.root) {
        return;
      }
      const destructive =
        event.key === 'Delete' || event.key === 'Backspace' || ((event.metaKey || event.ctrlKey) && ['d', 'x'].includes(event.key.toLowerCase()));
      if (destructive) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [canvas, selection]);
}
