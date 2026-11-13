import { useCallback, useState } from 'react';
import type { HistoryCommit, HistoryCommitFile } from './historyBridge';
import { readHistoryLog } from './historyBridge';
import { createPanelCache, usePanelData } from '../../lib/usePanelData';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { summarizeHistoryFiles } from './historyFileSummary';
import HistoryFilesDialog from './HistoryFilesDialog';
import { ChevronRightIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';

const fileCache = createPanelCache<readonly HistoryCommitFile[]>();
const subscribe = () => () => {};

export default function HistoryCommitFiles({
  commit,
  projectPath,
  onRestoreFile,
}: {
  readonly commit: HistoryCommit;
  readonly projectPath: string;
  readonly onRestoreFile?: ((commit: HistoryCommit, file: HistoryCommitFile) => void) | undefined;
}) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const { state, refresh } = useCommitFiles(projectPath, commit);
  const files = commit.files ?? (state.kind === 'ready' ? state.value : undefined);
  if (files === undefined) {
    return <PanelReadStatus state={state} label={translate('history.files.changedLabel')} retry={refresh} />;
  }
  if (files.length === 0) {
    return <p className="history-note">{translate('history.files.none')}</p>;
  }
  const counts = summarizeHistoryFiles(files);
  return (
    <>
      <button
        className="history-view-files"
        aria-label={translate('history.files.view', { count: files.length })}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="history-file-summary">
          <span className="history-count-added" title={translate('history.files.added', { count: counts.added })}>
            +{counts.added}
          </span>
          <span className="history-count-deleted" title={translate('history.files.deleted', { count: counts.deleted })}>
            −{counts.deleted}
          </span>
          <span className="history-count-updated" title={translate('history.files.updated', { count: counts.updated })}>
            ~{counts.updated}
          </span>
        </span>
        <span className="history-view-files-label">
          {translate('history.files.count', { count: files.length })} <ChevronRightIcon size={12} />
        </span>
      </button>
      {open && <HistoryFilesDialog commit={commit} projectPath={projectPath} files={files} onClose={() => setOpen(false)} onRestoreFile={onRestoreFile} />}
    </>
  );
}

function useCommitFiles(projectPath: string, commit: HistoryCommit) {
  const translate = useTranslate();
  const { hash, files } = commit;
  const read = useCallback(async () => {
    if (files !== undefined) {
      return { ok: true, value: files } as const;
    }
    // Hosts may omit file details from graph reads to avoid downloading blobs
    // until the user expands this particular commit.
    const result = await readHistoryLog(projectPath, 0, hash);
    if (!result.ok) {
      return result;
    }
    const detail = result.value.commits[0];
    if (detail?.hash !== hash || detail.files === undefined) {
      return { ok: false, error: translate('history.files.unavailable') } as const;
    }
    return { ok: true, value: detail.files } as const;
  }, [projectPath, hash, files, translate]);
  return usePanelData(fileCache, JSON.stringify([projectPath, hash]), read, subscribe);
}
