import { useCallback, useEffect, useRef, useState } from 'react';
import { loadProject, type Project } from './projectClient';
import { onWindowReturn } from '../../../vendor/stacki/src/lib/windowReturn';
import { StudioRequestError } from './responseError';

export function useProjectLoad(report: (error: unknown) => void) {
  const [project, setProject] = useState<Project>();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState('');
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController>();
  const pending = useRef(false);
  const refresh: () => void = useCallback(() => {
    // Aborting a browser read does not cancel the server's filesystem scan.
    // Keep one running read and one pending refresh, even during rapid edits.
    if (active.current) {
      pending.current = true;
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setFailure('');
    setRevision((value) => value + 1);
    void openProject(controller.signal, setAttempt)
      .then((value) => {
        if (!controller.signal.aborted) {
          setProject(value);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFailure(error instanceof Error ? error.message : 'Unable to open your studio.');
          report(error);
        }
      })
      .finally(() => {
        if (active.current === controller) {
          active.current = undefined;
          if (pending.current) {
            pending.current = false;
            queueMicrotask(refresh);
          }
        }
      });
  }, [report]);
  const reconcile = useCallback(() => {
    // Focus and stream connection do not prove a change. Let an existing read
    // finish; cancelling it cannot stop the container's filesystem work.
    if (!active.current) {
      refresh();
    }
  }, [refresh]);
  useEffect(() => {
    refresh();
    window.addEventListener('studio:project-changed', refresh);
    const offReturn = onWindowReturn(reconcile);
    return () => {
      window.removeEventListener('studio:project-changed', refresh);
      offReturn();
      active.current?.abort();
      active.current = undefined;
      pending.current = false;
    };
  }, [refresh, reconcile]);
  return { project, refresh, reconcile, attempt, failure, revision };
}

async function openProject(signal: AbortSignal, progress: (attempt: number) => void) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    progress(attempt);
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException('Startup timed out', 'TimeoutError')),
      // The first request includes container restoration. Match the transport's
      // cold-start budget; retries after a failed connection stay short.
      attempt === 1 ? 240_000 : 20_000,
    );
    try {
      return await loadProject(AbortSignal.any([signal, timeout.signal]));
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 3 || !(error instanceof StudioRequestError) || (error.status !== 0 && error.status < 500)) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Unable to connect to your workspace. Please retry.');
}
