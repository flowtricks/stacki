// The Feedback list the panel and the canvas share. The file is the only
// state: every change reads it fresh, applies the change, and writes it back,
// so an agent's edits made in the meantime (done flips, its own items) survive.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { FeedbackItem, TrailedFeedbackItem } from '../../../shared/ipc/feedback';
import { readFeedback, writeFeedback } from './feedbackBridge';

export interface FeedbackPin {
  readonly id: string;
  /** The marker path the canvas frame measures and selects by. */
  readonly path: string;
  /** The item's 1-based number among the open items, as the list shows it. */
  readonly index: number;
  readonly note: string;
}

interface FeedbackContext {
  readonly projectPath: string | undefined;
  /** The current selection keys: each drilled-in host, then the leaf. */
  readonly selectionKeys: readonly string[];
  readonly editedRel: string | undefined;
  /** The selected node's name, for a new note's label. */
  readonly label: string | undefined;
  readonly showToast: (message: string, kind: 'error') => void;
}

export function useFeedback(context: FeedbackContext) {
  const { projectPath, selectionKeys, editedRel, label, showToast } = context;
  const [items, setItems] = useState<readonly TrailedFeedbackItem[]>([]);
  // Replies for a project that is no longer open are dropped.
  const projectRef = useRef(projectPath);
  projectRef.current = projectPath;

  const reload = useCallback(async (): Promise<void> => {
    const requested = projectPath;
    if (!requested) {
      setItems([]);
      return;
    }
    const result = await readFeedback(requested);
    if (projectRef.current !== requested) {
      return;
    }
    if (result.ok) {
      setItems(result.value);
    } else {
      showToast(result.error, 'error');
    }
  }, [projectPath, showToast]);

  const change = useCallback(
    async (apply: (items: readonly FeedbackItem[]) => readonly FeedbackItem[]): Promise<void> => {
      if (!projectPath) {
        return;
      }
      const current = await readFeedback(projectPath);
      const written = current.ok ? await writeFeedback(projectPath, apply(current.value)) : current;
      if (projectRef.current !== projectPath) {
        return;
      }
      if (written.ok) {
        setItems(written.value);
      } else {
        showToast(written.error, 'error');
      }
    },
    [projectPath, showToast],
  );

  useEffect(() => {
    void reload();
    const onFocus = (): void => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const keysKey = selectionKeys.join('\n');
  const pins = useMemo(
    () => feedbackPins(items, { selectionKeys: keysKey.split('\n'), editedRel }),
    [items, keysKey, editedRel],
  );
  const add = (note: string): Promise<void> =>
    change((previous) => [...previous, newItem(selectionKeys, label ?? 'page', note)]);
  const toggleDone = (id: string): Promise<void> =>
    change((previous) =>
      previous.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
    );
  const remove = (id: string): Promise<void> =>
    change((previous) => previous.filter((item) => item.id !== id));
  const clearDone = (): Promise<void> =>
    change((previous) => previous.filter((item) => !item.done));
  return { feedback: { items, pins, reload, add, toggleDone, remove, clearDone } };
}

function newItem(keys: readonly string[], label: string, note: string): FeedbackItem {
  return {
    id: crypto.randomUUID().slice(0, 8),
    keys: [...keys],
    label,
    note,
    createdAt: new Date().toISOString(),
    done: false,
  };
}

/**
 * The open items that draw on the canvas: those pinned at the current level of
 * the editing stack (same drilled-in hosts) to a node of the open file.
 * Everything else stays in the list without a pin.
 */
export function feedbackPins(
  items: readonly TrailedFeedbackItem[],
  at: { readonly selectionKeys: readonly string[]; readonly editedRel: string | undefined },
): readonly FeedbackPin[] {
  const currentLeaf = at.selectionKeys.at(-1);
  if (currentLeaf === undefined) {
    return [];
  }
  const currentHosts = at.selectionKeys.slice(0, -1).join('\n');
  const openFile = currentLeaf.slice(0, currentLeaf.indexOf('#'));
  const pins: FeedbackPin[] = [];
  items
    .filter((item) => !item.done)
    .forEach((item, position) => {
      const leaf = item.keys.at(-1);
      if (leaf === undefined || item.keys.slice(0, -1).join('\n') !== currentHosts) {
        return;
      }
      const hash = leaf.indexOf('#');
      const indexPath = leaf.slice(hash + 1);
      // A page-level note (`file#`) or the frontmatter has no box to pin to.
      if (hash === -1 || leaf.slice(0, hash) !== openFile || !/^\d+(\.\d+)*$/.test(indexPath)) {
        return;
      }
      const path = at.editedRel ? `${at.editedRel}|${indexPath}` : indexPath;
      pins.push({ id: item.id, path, index: position + 1, note: item.note });
    });
  assert(pins.length <= items.length, 'At most one pin per item');
  return pins;
}
