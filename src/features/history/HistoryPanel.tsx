import React, { useState } from 'react';
export { dayGroup, relativeTime, summarize } from './historyModel';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { HistorySection } from './HistorySections';
import HistoryTimeline from './HistoryTimeline';
import type { HistoryPanelProps } from './historyPanelTypes';

export default function HistoryPanel(props: HistoryPanelProps) {
  const translate = useTranslate();
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
        {/* i18n-ignore: Git is a product name. */}
        <h2>Git</h2>
      </div>
      <div className="panel-body history-body">
        {props.controls}
        {props.previewRef && (
          <button className="history-exit-preview primary" onClick={props.onExitPreview}>
            {translate('history.backToNow')}
          </button>
        )}
        {props.gitInfo?.isRepo && (
          <HistorySection title={translate('history.versionHistory')} open={timelineOpen} onToggle={() => setTimelineOpen((value) => !value)}>
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
