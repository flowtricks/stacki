import { useCallback, useEffect, useState } from 'react';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import { readIncomingGitCommits } from './gitChipBridge';
import { createCoalescedRun } from '../../lib/coalescedRun';
import { onWindowReturn } from '../../lib/windowReturn';

export type GitIncomingState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly commits: number }
  | { readonly kind: 'unavailable'; readonly message: string; readonly messageRef?: MessageRef | undefined };

const CHECK_INTERVAL_MS = 30_000;
const checking = { kind: 'checking' } as const;

export interface GitIncoming {
  readonly state: GitIncomingState;
  /** Takes a count learned outside the routine check (a pull, or a check the person asked for). */
  readonly record: (commits: number) => void;
}

/** Mounted with the project so incoming changes are found even with the Git panel closed. */
export function useGitIncoming(projectPath: string | undefined, info: IpcResults['git:info'] | undefined): GitIncoming {
  const repository = info?.isRepo ? info : undefined;
  const branch = repository?.branch;
  const remote = repository?.remote;
  const head = repository?.head;
  const key = JSON.stringify([projectPath, branch, remote, head]);
  const [snapshot, setSnapshot] = useState<{
    readonly key: string;
    readonly value: GitIncomingState;
  }>({ key: '', value: checking });
  useEffect(() => {
    if (!projectPath || !remote || !branch || !head || branch === 'HEAD') {
      return;
    }
    let closed = false;
    const reader = createCoalescedRun(async () => {
      if (closed) {
        return;
      }
      const result = await readIncomingGitCommits(projectPath, branch);
      if (closed) {
        return;
      }
      setSnapshot({
        key,
        value: result.ok
          ? { kind: 'ready', commits: result.value }
          : { kind: 'unavailable', message: result.error, ...(result.errorRef === undefined ? {} : { messageRef: result.errorRef }) },
      });
    });
    const refresh = (): void => {
      // Keep the last confirmed state during routine checks to avoid flickering the button.
      void reader.request();
    };
    refresh();
    const offReturn = onWindowReturn(refresh);
    const timer = window.setInterval(refresh, CHECK_INTERVAL_MS);
    return () => {
      closed = true;
      offReturn();
      window.clearInterval(timer);
    };
  }, [projectPath, branch, remote, head, key]);
  // The key travels with the count: one taken for another branch or commit is never shown.
  const record = useCallback((commits: number) => setSnapshot({ key, value: { kind: 'ready', commits } }), [key]);
  return { state: snapshot.key === key ? snapshot.value : checking, record };
}
