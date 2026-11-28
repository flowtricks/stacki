// The editor's side of the preview supervisor (src/features/preview/previewSupervisor.ts): which server it asks after,
// and how it starts it again. One for the life of a project, not of a server address: a restart can answer at another
// address, and the bounds on restarting must outlive it. Nothing about the editor is reset: the open page, the
// selection and unsaved work stay as they are while the pages are loaded again.
import { useEffect, useRef } from 'react';
import { createPreviewSupervisor, type PreviewSupervisor } from '../../features/preview/previewSupervisor';
import { askPreviewFrames } from '../../features/preview/previewFrames';
import { adoptPreviewSupervisor, publishSupervisedReload, publishSupervision, publishSupervisionFailure } from '../../features/preview/previewSupervisorBus';
import { onDevRestart, onPreviewFailed, probeProjectPreview, startProjectPreview } from '../../ipc/appBridge';
import { cleanError } from '../../lib/cleanError';
import { parseTrailingSlash } from '../model/nodeFactory';
import type { useCoreState } from './appLifecycle';

/** Vite's own small client script: asking for it renders no page. */
const SERVER_ANSWER_PATH = '/@vite/client';
/** The longest a restart of main's own holds the supervisor back; past it, silence counts again. */
const MAIN_RESTART_MS_MAX = 180_000;

export function usePreviewSupervision(coreState: ReturnType<typeof useCoreState>) {
  const { devStatus, devUrl, project, setDevStatus, setDevUrl, setRefreshKey, setTrailingSlash } = coreState;
  const previewRef = useRef({ devStatus, devUrl });
  previewRef.current = { devStatus, devUrl };
  const supervisorRef = useRef<PreviewSupervisor | undefined>(undefined);
  const projectPath = project?.path;
  useEffect(() => {
    // The bridge arrives with the main process, which a newer renderer may outrun: absent means nothing to ask.
    if (projectPath === undefined || typeof window.avb.probeDevPage !== 'function') {
      return undefined;
    }
    let left = false;
    // When a restart main announced stops being waited for (shared/ipc/devRestart.ts); 0 while there is none.
    let restartingUntil = 0;
    const serverAddress = (): string | undefined => (previewRef.current.devStatus === 'on' ? previewRef.current.devUrl : undefined);
    const supervisor = createPreviewSupervisor({
      active: () => serverAddress() !== undefined && Date.now() >= restartingUntil,
      visible: () => document.visibilityState === 'visible',
      serverAnswers: async () => {
        const address = serverAddress();
        if (address === undefined) {
          return false;
        }
        // Any status is an answer; 0 is a refused or unanswered request (electron/preview/devProbe.ts).
        return (await probeProjectPreview(new URL(SERVER_ANSWER_PATH, address).href)).status !== 0;
      },
      frames: askPreviewFrames,
      restartServer: async () => {
        try {
          const started = await startProjectPreview(projectPath);
          if (left) {
            return false;
          }
          setDevUrl(started.url);
          if (started.trailingSlash) {
            setTrailingSlash(parseTrailingSlash(started.trailingSlash));
          }
          setDevStatus('on');
          publishSupervisionFailure(undefined);
          return true;
        } catch (error: unknown) {
          // Kept for the cover's diagnostics: a toast of the whole log would sit on top of its button.
          if (!left) {
            publishSupervisionFailure(cleanError(error));
          }
          return false;
        }
      },
      reload: () => {
        setRefreshKey((count) => count + 1);
        publishSupervisedReload();
      },
      onChange: publishSupervision,
    });
    supervisorRef.current = supervisor;
    const release = adoptPreviewSupervisor(supervisor);
    const returned = (): void => {
      if (document.visibilityState === 'visible') {
        supervisor.check('return');
      }
    };
    document.addEventListener('visibilitychange', returned);
    window.addEventListener('focus', returned);
    // A restart on purpose (the preview on the local network on or off, say) is not a failure. Once the server is
    // back the pages are loaded from it; the old ones stay on show until then, and the selection is the editor's own.
    const offRestart =
      typeof window.avb.onDevRestart === 'function'
        ? onDevRestart((notice) => {
            if (notice.kind === 'begun') {
              restartingUntil = Date.now() + MAIN_RESTART_MS_MAX;
              return;
            }
            restartingUntil = 0;
            if (notice.url !== undefined && serverAddress() !== undefined) {
              setDevUrl(notice.url);
              setRefreshKey((count) => count + 1);
              publishSupervisedReload();
            }
          })
        : undefined;
    const offFailure = typeof window.avb.onPreviewFailed === 'function' ? onPreviewFailed(() => supervisor.check('failed')) : undefined;
    return () => {
      left = true;
      offRestart?.();
      offFailure?.();
      document.removeEventListener('visibilitychange', returned);
      window.removeEventListener('focus', returned);
      release();
      supervisor.stop();
      supervisorRef.current = undefined;
    };
  }, [projectPath, setDevStatus, setDevUrl, setRefreshKey, setTrailingSlash]);
  /** The dev server's process ended. True when there was a preview on show, which is then started again here. */
  const serverExitedRef = useRef((): boolean => {
    const supervisor = supervisorRef.current;
    if (supervisor === undefined || previewRef.current.devStatus !== 'on') {
      return false;
    }
    supervisor.exited();
    return true;
  });
  return { serverExited: serverExitedRef.current };
}
