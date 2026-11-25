import { useCallback, useEffect, useRef } from 'react';
import { parsePublishAvailability } from '../../../vendor/stacki/shared/properties/publishState';
import { useConfirmedAvailability } from '../../../vendor/stacki/src/features/publishing/useConfirmedAvailability';
import { request } from '../project/projectClient';
import type { PublishState } from './publish';

export function usePublishAvailability(state: PublishState) {
  const active = useRef<AbortController>();
  const check = useRef<() => void>(() => undefined);
  const confirmAgain = useCallback(() => check.current(), []);
  const { availability, report } = useConfirmedAvailability(confirmAgain);
  const refresh = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    void request('/studio/api/publish/availability', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
    })
      .then((input) => {
        const next = parsePublishAvailability(input);
        if (!controller.signal.aborted) {
          report({ kind: 'checked', result: next });
        }
      })
      .catch(() => {
        // A failed check proves nothing; the button keeps its last confirmed state.
        if (!controller.signal.aborted) {
          report({ kind: 'failed' });
        }
      });
  }, [report]);
  check.current = refresh;
  useEffect(() => {
    if (state.kind !== 'building') {
      refresh();
    }
    return () => active.current?.abort();
  }, [state, refresh]);
  const invalidate = useCallback(() => {
    // Only stop listening to the old check: the last confirmed answer stays on screen until a new check replies.
    active.current?.abort();
  }, []);
  useDraftStatusRefresh(refresh, invalidate);
  return { availability, refresh };
}

// Source broadcasts include other editors and asset/project mutations. Debounce reads, but
// stop waiting on an old check; the button keeps drawing the last confirmed answer meanwhile.
function useDraftStatusRefresh(refresh: () => void, reset: () => void) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      reset();
      clearTimeout(timer);
      timer = setTimeout(refresh, 2500);
    };
    window.addEventListener('studio:source-updated', changed);
    window.addEventListener('studio:project-changed', changed);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('studio:source-updated', changed);
      window.removeEventListener('studio:project-changed', changed);
    };
  }, [refresh, reset]);
}
