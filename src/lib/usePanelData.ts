import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from '../../shared/core/result';
import { createCoalescedRun } from './coalescedRun';
import { onWindowReturn } from './windowReturn';
import { assert } from '../../shared/core/assert';

export type PanelData<T> = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly value: T } | { readonly kind: 'error'; readonly message: string };

// Panels share bounded refresh work and retry when the window returns. A failed
// read is never an empty collection, and an unmounted project cannot publish data.
export function usePanelData<T>(
  cache: PanelCache<T>,
  projectPath: string,
  read: () => Promise<Result<T, string>>,
  subscribe: (changed: () => void) => () => void,
) {
  const [state, setState] = useState<PanelData<T>>(() => cache.get(projectPath) ?? { kind: 'loading' });
  const request = useRef<() => Promise<void>>(() => Promise.resolve());
  const refresh = useCallback(() => request.current(), []);
  useEffect(() => {
    let active = true;
    const reader = createCoalescedRun(async () => {
      if (!active) {
        return;
      }
      const result = await read();
      if (active) {
        if (result.ok) {
          cache.set(projectPath, result.value);
        }
        setState(result.ok ? { kind: 'ready', value: result.value } : { kind: 'error', message: result.error });
      }
    });
    request.current = reader.request;
    const changed = () => void reader.request();
    changed();
    const unsubscribe = subscribe(changed);
    const offReturn = onWindowReturn(changed);
    return () => {
      active = false;
      unsubscribe();
      offReturn();
    };
  }, [cache, projectPath, read, subscribe]);
  return { state, refresh };
}

interface PanelCache<T> {
  readonly get: (projectPath: string) => PanelData<T> | undefined;
  readonly set: (projectPath: string, value: T) => void;
}

// Keep only successful data for the eight most recently viewed projects. Opening
// a panel still revalidates it, so hidden panels need no persistent subscriptions.
export function createPanelCache<T>(): PanelCache<T> {
  const entries = new Map<string, T>();
  return {
    get: (projectPath) => {
      const value = entries.get(projectPath);
      return value === undefined ? undefined : { kind: 'ready', value };
    },
    set: (projectPath, value) => {
      assert(projectPath.length > 0, 'Panel cache belongs to a project');
      entries.delete(projectPath);
      entries.set(projectPath, value);
      if (entries.size > 8) {
        const oldest = entries.keys().next().value;
        assert(oldest !== undefined, 'A full panel cache has an oldest project');
        entries.delete(oldest);
      }
      assert(entries.size <= 8, 'Panel cache stays within its project bound');
    },
  };
}
