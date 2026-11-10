import { useCallback, useState } from 'react';
import GitChip from '../../../vendor/stacki/src/features/git/GitChip';
import { readGitInfo } from '../../../vendor/stacki/src/features/git/gitChipBridge';
import { useGitIncoming } from '../../../vendor/stacki/src/features/git/useGitIncoming';
import HistoryTimeline from '../../../vendor/stacki/src/features/history/HistoryTimeline';
import { HistorySection } from '../../../vendor/stacki/src/features/history/HistorySections';
import { createPanelCache, usePanelData } from '../../../vendor/stacki/src/lib/usePanelData';
import { PanelReadStatus } from '../../../vendor/stacki/src/ui/PanelReadStatus';
import type { IpcResults } from '../../../vendor/stacki/shared/ipc/ipcResults';
import type { Project } from '../project/projectClient';

const cache = createPanelCache<IpcResults['git:info']>();
const noPreview = () => {};
function subscribe(refresh: () => void) {
  window.addEventListener('studio:project-changed', refresh);
  window.addEventListener('studio:source-updated', refresh);
  return () => {
    window.removeEventListener('studio:project-changed', refresh);
    window.removeEventListener('studio:source-updated', refresh);
  };
}
export function GitPanel({
  project,
  flushSave,
  refreshProject,
  report,
}: {
  readonly project: Project;
  readonly flushSave: () => Promise<unknown>;
  readonly refreshProject: () => Promise<unknown>;
  readonly report: (error: unknown) => void;
}) {
  const key = project.workspaceId ?? project.name;
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState('');
  const read = useCallback(() => readGitInfo('studio'), []);
  const { state, refresh } = usePanelData(cache, key, read, subscribe);
  const info = state.kind === 'ready' ? state.value : undefined;
  const incoming = useGitIncoming('studio', info);
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Git</h2>
      </div>
      <div className="panel-body history-body">
        <PanelReadStatus state={state} label="Git history" layout="history" retry={refresh} />
        {info && (
          <GitChip
            info={info}
            refresh={refresh}
            busy={undefined}
            project={{ path: 'studio', name: project.name }}
            incoming={incoming}
            flushSave={flushSave}
            onWorktreeChanged={refreshProject}
            showToast={(message, kind) => (kind === 'error' ? report(message) : setNotice(message))}
          />
        )}
        {notice && (
          <p role="status" className="history-note">
            {notice}
          </p>
        )}
        {info?.isRepo && (
          <HistorySection title="Version history" open={open} onToggle={() => setOpen(!open)}>
            <HistoryTimeline
              projectPath={key}
              branch={info.branch}
              branches={info.branches}
              trunk={info.trunk ?? info.branch}
              head={info.head}
              userEmail={info.userEmail}
              previewRef={undefined}
              onExitPreview={noPreview}
            />
          </HistorySection>
        )}
      </div>
    </div>
  );
}
