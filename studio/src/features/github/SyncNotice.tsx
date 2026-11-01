import { useEffect, useRef, useState } from 'react';
import { request } from '../project/projectClient';
import { record, string } from '../../shared/validation';

export function SyncNotice({ refresh, report }: { readonly refresh: () => void; readonly report: (problem: unknown) => void }) {
  const callback = useRef(refresh);
  callback.current = refresh;
  const [conflict, setConflict] = useState<{ sha: string; files: string[] }>();
  const [busy, setBusy] = useState(false);
  const last = useRef('');
  const lastFailure = useRef('');
  function failed(problem: unknown) {
    const message = problem instanceof Error ? problem.message : String(problem);
    if (message !== lastFailure.current) {
      lastFailure.current = message;
      report(message);
    }
  }
  async function sync(side?: 'draft' | 'github') {
    setBusy(true);
    try {
      const value = record(
        await request('/studio/api/sync', {
          method: 'POST',
          ...(side && conflict ? { body: JSON.stringify({ side, sha: conflict.sha }) } : {}),
        }),
      );
      if (value['kind'] === 'conflict') {
        lastFailure.current = '';
        const files = value['files'];
        if (!Array.isArray(files)) {
          throw new Error('Invalid sync conflicts');
        }
        setConflict({ sha: string(value['sha']), files: files.map((file) => string(file)) });
      } else if (value['kind'] === 'failed') {
        failed(string(value['message']));
      } else if (value['kind'] === 'synced') {
        lastFailure.current = '';
        setConflict(undefined);
        const sha = string(value['sha']);
        if (last.current !== sha) {
          last.current = sha;
          callback.current();
        }
      }
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  }
  const poll = useRef(sync);
  poll.current = sync;
  useSyncPolling(poll);
  return conflict ? <SyncConflict conflict={conflict} busy={busy} sync={sync} /> : null;
}

function SyncConflict({
  conflict,
  busy,
  sync,
}: {
  readonly conflict: { readonly files: readonly string[] };
  readonly busy: boolean;
  readonly sync: (side: 'draft' | 'github') => Promise<void>;
}) {
  return (
    <div className="sync-notice" role="status">
      <p>GitHub and the draft changed the same content. Choose which version to keep for these files.</p>
      {conflict.files.map((file) => (
        <code key={file}>{file}</code>
      ))}
      <div className="node-actions">
        <button disabled={busy} onClick={() => void sync('draft')}>
          Keep draft versions
        </button>
        <button disabled={busy} onClick={() => void sync('github')}>
          Use GitHub versions
        </button>
      </div>
    </div>
  );
}

function useSyncPolling(poll: React.MutableRefObject<() => Promise<void>>) {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) {
        await poll.current();
      }
      if (!stopped) {
        timer = setTimeout(() => {
          void tick();
        }, 60_000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [poll]);
}
