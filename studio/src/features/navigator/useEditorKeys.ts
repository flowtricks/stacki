import { useEffect } from 'react';
import { copyNode, pasteNode } from './clipboard';
import { menuPasteClaimed } from '../../../vendor/stacki/src/ui/menuPasteClaim';
import type { SharedDocument } from '../collaboration/useDocument';
import type { TreeAction } from '../source/source';
import type { Component } from '../project/projectClient';

export function useEditorKeys(
  document: SharedDocument | undefined,
  selected: string,
  action: (value: TreeAction) => void,
  report: (error: unknown) => void,
  components: readonly Component[],
) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !document) {
        return;
      }
      const primary = event.metaKey || event.ctrlKey;
      const value = event.key.toLowerCase();
      if (primary && (value === 'z' || value === 'y')) {
        event.preventDefault();
        const direction = event.shiftKey || value === 'y' ? 'redo' : 'undo';
        // A step an app named (docs/apps.md, "Undo labels") says which one went: a string reports as a notice.
        void document.history
          .step(direction)
          .then((label) => {
            if (label !== undefined) {
              report(`${direction === 'undo' ? 'Undid' : 'Redid'} ${label}`);
            }
          })
          .catch(report);
        return;
      }
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], .cm-editor')) {
        return;
      }
      if (!selected || selected === 'frontmatter') {
        return;
      }
      // An open tool that reads the clipboard (the clip-path editor) takes ⌘V: the
      // key is left alone so the browser's paste event reaches it (menuPasteClaim.ts).
      if (primary && value === 'v' && menuPasteClaimed()) {
        return;
      }
      if (primary && ['c', 'd', 'v'].includes(value)) {
        event.preventDefault();
        if (value === 'c') {
          copyNode(document, selected, report);
        }
        if (value === 'd') {
          action({ kind: 'duplicate', node: selected });
        }
        if (value === 'v') {
          pasteNode(document, selected, report, components);
        }
      } else if (!primary && (value === 'backspace' || value === 'delete')) {
        event.preventDefault();
        action({ kind: 'delete', node: selected });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [document, selected, action, report, components]);
}
