import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { StudioStatus } from '../../../shared/ipc/studioSetup';
import type { StudioInstallProgress } from '../../../shared/ipc/studioProgress';
import { cleanError } from '../../lib/cleanError';
import type { StudioAuthConfig } from '../../../shared/ipc/studioAuth';
import { addStudio, changeStudioSignIn, onStudioProgress, readStudioStatus } from './studioBridge';

export type StudioActivity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly progress: StudioInstallProgress }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly progress: StudioInstallProgress | undefined;
    };

export function useStudioSetup(projectPath: string, revision: number) {
  const [status, setStatus] = useState<StudioStatus>();
  const [activity, setActivity] = useState<StudioActivity>({ kind: 'idle' });
  const subscription = useRef<(() => void) | undefined>();
  const activeRequest = useRef<string | undefined>();
  useStudioStatus(projectPath, revision, setStatus, setActivity);
  useEffect(
    () => () => {
      subscription.current?.();
      activeRequest.current = undefined;
    },
    [projectPath],
  );
  // Retry after a failure reuses the sign-in the person chose.
  const lastAuth = useRef<StudioAuthConfig>();
  const install = async (chosen?: StudioAuthConfig) => {
    const auth: StudioAuthConfig = chosen ?? lastAuth.current ?? { kind: 'github' };
    lastAuth.current = auth;
    if (status?.kind !== 'missing' || activeRequest.current !== undefined) {
      return;
    }
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    setActivity({
      kind: 'busy',
      progress: { projectPath, requestId, stage: 'release', output: '' },
    });
    // Subscribe before invoking so even an immediate download response cannot be missed.
    const unsubscribe = onStudioProgress((progress) => {
      if (activeRequest.current !== requestId) {
        return;
      }
      if (progress.requestId === requestId && progress.projectPath === projectPath) {
        setActivity((previous) => (previous.kind === 'busy' ? { kind: 'busy', progress } : previous));
      }
    });
    subscription.current = unsubscribe;
    try {
      const result = await addStudio(projectPath, requestId, auth);
      if (activeRequest.current !== requestId) {
        return;
      }
      if (result.kind === 'error') {
        setActivity((previous) => studioFailure(previous, result.message));
      } else {
        if (result.kind === 'installed') {
          setStatus({
            kind: 'installed',
            desktopVersion: status.desktopVersion,
            version: result.version,
            signIn: auth.kind,
          });
        }
        setActivity({ kind: 'idle' });
      }
    } catch (error: unknown) {
      if (activeRequest.current === requestId) {
        setActivity((previous) => studioFailure(previous, cleanError(error)));
      }
    } finally {
      unsubscribe();
      if (activeRequest.current === requestId) {
        activeRequest.current = undefined;
        subscription.current = undefined;
      }
    }
  };
  // Edits only the sign-in variables of an installed Studio. Returns the failure sentence, or undefined on success.
  const changeSignIn = async (auth: StudioAuthConfig): Promise<string | undefined> => {
    if (status?.kind !== 'installed') {
      return undefined;
    }
    try {
      const result = await changeStudioSignIn(projectPath, auth);
      if (result.kind === 'error') {
        return result.message;
      }
      setStatus({ ...status, signIn: result.signIn });
      return undefined;
    } catch (error: unknown) {
      return cleanError(error);
    }
  };
  return { status, activity, install, changeSignIn };
}

function studioFailure(previous: StudioActivity, message: string): StudioActivity {
  return {
    kind: 'error',
    message,
    progress: previous.kind === 'idle' ? undefined : previous.progress,
  };
}

function useStudioStatus(
  projectPath: string,
  revision: number,
  setStatus: Dispatch<SetStateAction<StudioStatus | undefined>>,
  setActivity: Dispatch<SetStateAction<StudioActivity>>,
) {
  useEffect(() => {
    let active = true;
    void readStudioStatus(projectPath)
      .then((value) => {
        if (active) {
          setStatus(value);
          setActivity({ kind: 'idle' });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setStatus(undefined);
          setActivity({ kind: 'error', message: cleanError(error), progress: undefined });
        }
      });
    return () => {
      active = false;
    };
  }, [projectPath, revision, setStatus, setActivity]);
}
