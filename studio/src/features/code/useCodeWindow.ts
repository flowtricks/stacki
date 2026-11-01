import { useEffect, useState } from 'react';
import { useEditorRole } from '../roles/useEditorRole';
import type { SharedDocument } from '../collaboration/useDocument';
import { codeWindowEdit, codeWindowSource } from './codeWindowSource';

export function useCodeWindow(document: SharedDocument | undefined, selected: string, report: (error: unknown) => void) {
  const role = useEditorRole();
  const [target, setTarget] = useState<{
    readonly document: SharedDocument;
    readonly id: string;
  }>();
  useEffect(() => {
    if (role === 'client') {
      setTarget(undefined);
    }
  }, [role]);
  const source = document?.text.toString() ?? '';
  const current = target?.document === document && target ? codeWindowSource(source, target.id) : undefined;
  const open = (id = selected) => {
    if (role === 'client') {
      return false;
    }
    if (!document?.ready || !document.file.endsWith('.astro') || !codeWindowSource(source, id)) {
      return false;
    }
    if (!document.canEdit(id)) {
      return false;
    }
    setTarget({ document, id });
    return true;
  };
  useCodeWindowKeys(open);
  return {
    current: role === 'client' ? undefined : current,
    key: document?.file + ':' + target?.id,
    open,
    close: () => setTarget(undefined),
    change: (value: string) => {
      if (role === 'client') {
        return;
      }
      if (!document?.ready || !current || target?.document !== document) {
        return;
      }
      if (!document.canEdit(target.id)) {
        return;
      }
      try {
        document.replaceSource(codeWindowEdit(document.text.toString(), target.id, current.value, value));
      } catch (error) {
        report(error);
      }
    },
  };
}

function useCodeWindowKeys(open: () => boolean) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) {
        return;
      }
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], .cm-editor, button, a, [role="button"]')) {
        return;
      }
      if (open()) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
}
