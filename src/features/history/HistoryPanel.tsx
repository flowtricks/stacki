import React, { useState } from 'react';
export { dayGroup, relativeTime, summarize } from './historyModel';
import { HistorySection } from './HistorySections';
import HistoryTimeline from './HistoryTimeline';
import type { HistoryPanelProps } from './historyPanelTypes';

export default function HistoryPanel(props: HistoryPanelProps) {
  const [timelineOpen, setTimelineOpen] = useState(true);
  const branch = props.gitInfo?.isRepo ? props.gitInfo.branch : undefined;
  const head = props.gitInfo?.isRepo ? props.gitInfo.head : undefined;

  if (!props.project) {
    return undefined;
  }
  const userEmail = props.gitInfo?.isRepo ? props.gitInfo.userEmail : undefined;
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Git</h2>
      </div>
      <div className="panel-body history-body">
        {props.controls}
        {props.previewRef && (
          <button className="history-exit-preview" onClick={props.onExitPreview}>
            Back to now
          </button>
        )}
        {props.gitInfo?.isRepo && (
          <HistorySection title="Version history" open={timelineOpen} onToggle={() => setTimelineOpen((value) => !value)}>
            <HistoryTimeline
              projectPath={props.project.path}
              branch={branch}
              trunk={props.gitInfo.trunk ?? 'main'}
              branches={props.gitInfo.branches}
              head={head}
              userEmail={userEmail}
              previewRef={props.previewRef}
              onPreviewCommit={props.onPreviewCommit}
              onExitPreview={props.onExitPreview}
              onRestoreFile={props.onRestoreFile}
              onRestoreProject={props.onRestoreProject}
            />
          </HistorySection>
        )}
      </div>
    </div>
  );
}
