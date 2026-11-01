import { useCallback, useState } from 'react';
import type { HistoryCommit, HistoryCommitFile } from './historyBridge';
import { readHistoryLog } from './historyBridge';
import { createPanelCache, usePanelData } from '../../lib/usePanelData';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { summarizeHistoryFiles } from './historyFileSummary';
import HistoryFilesDialog from './HistoryFilesDialog';
import { ChevronRightIcon } from '../../ui/Icons';

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
  const [open, setOpen] = useState(false);
  const { state, refresh } = useCommitFiles(projectPath, commit);
  const files = commit.files ?? (state.kind === 'ready' ? state.value : undefined);
  if (files === undefined) {
    return <PanelReadStatus state={state} label="changed files" retry={refresh} />;
  }
  if (files.length === 0) {
    return <p className="history-note">No files changed.</p>;
  }
  const counts = summarizeHistoryFiles(files);
  return (
    <>
      <button className="history-view-files" aria-label={`View changed files (${files.length})`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="history-file-summary">
          <span className="history-count-added" title={`${counts.added} files added`}>
            +{counts.added}
          </span>
          <span className="history-count-deleted" title={`${counts.deleted} files deleted`}>
            −{counts.deleted}
          </span>
          <span className="history-count-updated" title={`${counts.updated} files updated`}>
            ~{counts.updated}
          </span>
        </span>
        <span className="history-view-files-label">
          {files.length} {files.length === 1 ? 'file' : 'files'} <ChevronRightIcon size={12} />
        </span>
      </button>
      {open && <HistoryFilesDialog commit={commit} projectPath={projectPath} files={files} onClose={() => setOpen(false)} onRestoreFile={onRestoreFile} />}
    </>
  );
}

function useCommitFiles(projectPath: string, commit: HistoryCommit) {
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
      return { ok: false, error: 'Changed files are unavailable for this commit.' } as const;
    }
    return { ok: true, value: detail.files } as const;
  }, [projectPath, hash, files]);
  return usePanelData(fileCache, JSON.stringify([projectPath, hash]), read, subscribe);
}
