import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePublishAvailability, UNKNOWN_PUBLISH_AVAILABILITY } from '../../../vendor/stacki/shared/properties/publishState';
import { request } from '../project/projectClient';
import type { PublishState } from './publish';

export function usePublishAvailability(state: PublishState) {
  const [availability, setAvailability] = useState(UNKNOWN_PUBLISH_AVAILABILITY);
  const active = useRef<AbortController>();
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
          setAvailability(next);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAvailability(UNKNOWN_PUBLISH_AVAILABILITY);
        }
      });
  }, []);
  useEffect(() => {
    if (state.kind !== 'building') {
      refresh();
    }
    return () => active.current?.abort();
  }, [state, refresh]);
  const invalidate = useCallback(() => {
    active.current?.abort();
    setAvailability(UNKNOWN_PUBLISH_AVAILABILITY);
  }, []);
  useDraftStatusRefresh(refresh, invalidate);
  return { availability, refresh };
}

// Source broadcasts include other editors and asset/project mutations. Debounce reads, but
// immediately stop advertising an old snapshot as current while a new check is pending.
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
