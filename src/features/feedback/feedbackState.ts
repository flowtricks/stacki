// The Feedback notes the panel and the canvas share. The file is the only
// state: every change reads it fresh, applies the change, and writes it back,
// so an agent's edits made in the meantime (done flips, its own items) survive.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { Result } from '../../../shared/core/result';
import type { FeedbackItem, TrailedFeedbackItem } from '../../../shared/ipc/feedback';
import { readFeedback, writeFeedback } from './feedbackBridge';

export interface FeedbackPin {
  readonly id: string;
  /** The element's marker path, in whichever file rendered it. */
  readonly path: string;
  readonly occurrence: number;
  /** The item's 1-based number among the open items, as the list shows it. */
  readonly index: number;
  readonly note: string;
}

/** A click on the canvas while annotating: the element and the files it
 * renders through, outermost first ('' is the page). */
export interface FeedbackAnnotation {
  readonly path: string;
  readonly occurrence: number;
  readonly chain: readonly { readonly file: string; readonly path: string }[];
  readonly label: string;
}

interface Composing {
  readonly keys: readonly string[];
  readonly marker: { readonly path: string; readonly occurrence: number };
  readonly label: string;
}

interface FeedbackContext {
  readonly projectPath: string | undefined;
  /** Whether the Feedback tab is open: notes load, pin and annotate only then. */
  readonly active: boolean;
  /** The open page, project-relative: what a chain's '' file means. */
  readonly pageRel: string | undefined;
  readonly showToast: (message: string, kind: 'error') => void;
}

export function useFeedback(context: FeedbackContext) {
  const { active, pageRel } = context;
  const { items, reload, change } = useFeedbackFile(context);
  const [composing, setComposing] = useState<Composing | undefined>(undefined);
  const [openPinId, setOpenPinId] = useState<string | undefined>(undefined);
  const pins = useMemo(
    () => (active && pageRel ? feedbackPins(items, pageRel) : []),
    [active, items, pageRel],
  );
  const compose = (annotation: FeedbackAnnotation): void => {
    if (!pageRel) {
      return;
    }
    setOpenPinId(undefined);
    setComposing({
      keys: annotation.chain.map((step) => `${step.file || pageRel}#${step.path}`),
      marker: { path: annotation.path, occurrence: annotation.occurrence },
      label: annotation.label,
    });
  };
  const add = (note: string): Promise<void> => {
    if (!composing) {
      return Promise.resolve();
    }
    setComposing(undefined);
    return change((previous) => [...previous, newItem(composing, note)]);
  };
  const toggleDone = (id: string): Promise<void> =>
    change((previous) =>
      previous.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
    );
  const remove = (id: string): Promise<void> =>
    change((previous) => previous.filter((item) => item.id !== id));
  const clearDone = (): Promise<void> =>
    change((previous) => previous.filter((item) => !item.done));
  const composer =
    active && composing ? { ...composing.marker, target: composing.label } : undefined;
  const cancel = (): void => setComposing(undefined);
  const actions = { reload, compose, add, cancel, toggleDone, remove, clearDone };
  return { feedback: { items, pins, composer, openPinId, setOpenPinId, ...actions } };
}

// The file's items while the tab is open: read on opening, on window focus, and
// before every change, which is applied to the fresh read and written back.
function useFeedbackFile({ projectPath, active, showToast }: FeedbackContext) {
  const [items, setItems] = useState<readonly TrailedFeedbackItem[]>([]);
  // Replies for a project that is no longer open are dropped.
  const projectRef = useRef(projectPath);
  projectRef.current = projectPath;
  const settle = useCallback(
    (requested: string, result: Result<readonly TrailedFeedbackItem[], string>): void => {
      if (projectRef.current !== requested) {
        return;
      }
      if (result.ok) {
        setItems(result.value);
      } else {
        showToast(result.error, 'error');
      }
    },
    [showToast],
  );
  const reload = useCallback(async (): Promise<void> => {
    if (projectPath) {
      settle(projectPath, await readFeedback(projectPath));
    }
  }, [projectPath, settle]);
  const change = useCallback(
    async (apply: (items: readonly FeedbackItem[]) => readonly FeedbackItem[]): Promise<void> => {
      if (!projectPath) {
        return;
      }
      const current = await readFeedback(projectPath);
      const next = current.ok ? await writeFeedback(projectPath, apply(current.value)) : current;
      settle(projectPath, next);
    },
    [projectPath, settle],
  );
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const onFocus = (): void => void reload();
    onFocus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active, reload]);
  return { items, reload, change };
}

function newItem(composing: Composing, note: string): FeedbackItem {
  return {
    id: crypto.randomUUID().slice(0, 8),
    keys: [...composing.keys],
    marker: composing.marker,
    label: composing.label,
    note,
    createdAt: new Date().toISOString(),
    done: false,
  };
}

/**
 * The open items that draw on the canvas: those left on the open page that
 * know where they were clicked. Everything else (another page, an agent's own
 * item) stays in the list without a pin.
 */
export function feedbackPins(
  items: readonly TrailedFeedbackItem[],
  pageRel: string,
): readonly FeedbackPin[] {
  const onPage = (key: string): boolean => key.slice(0, key.indexOf('#')) === pageRel;
  const pins: FeedbackPin[] = [];
  items
    .filter((item) => !item.done)
    .forEach((item, position) => {
      if (item.marker && item.keys.some(onPage)) {
        const { path, occurrence } = item.marker;
        pins.push({ id: item.id, path, occurrence, index: position + 1, note: item.note });
      }
    });
  assert(pins.length <= items.length, 'At most one pin per item');
  return pins;
}
