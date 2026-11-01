import { useEffect, useState } from 'react';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import { readIncomingGitCommits } from './gitChipBridge';
import { createCoalescedRun } from '../../lib/coalescedRun';
import { onWindowReturn } from '../../lib/windowReturn';

export type GitIncomingState =
  { readonly kind: 'checking' } | { readonly kind: 'ready'; readonly commits: number } | { readonly kind: 'unavailable'; readonly message: string };

const CHECK_INTERVAL_MS = 30_000;
const checking = { kind: 'checking' } as const;

/** Mounted with the project so incoming changes are found even with the Git panel closed. */
export function useGitIncoming(projectPath: string | undefined, info: IpcResults['git:info'] | undefined): GitIncomingState {
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
        value: result.ok ? { kind: 'ready', commits: result.value } : { kind: 'unavailable', message: result.error },
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
  return snapshot.key === key ? snapshot.value : checking;
}
