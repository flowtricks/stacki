import { useEffect, useRef } from 'react';
import { STUDIO_INSTALL_STAGES, studioCompletedStages, type StudioInstallStage } from '../../../shared/ipc/studioProgress';
import type { StudioActivity } from './useStudioSetup';

const STAGE_LABELS: Readonly<Record<StudioInstallStage, string>> = {
  release: 'Preparing Studio release',
  files: 'Preparing project files',
  dependencies: 'Installing dependencies',
  check: 'Checking Studio',
  build: 'Building Studio',
  activate: 'Finishing installation',
  complete: 'Studio is ready',
};

export default function InstallProgress({ activity }: { readonly activity: StudioActivity }) {
  const log = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const progress = activity.kind === 'idle' ? undefined : activity.progress;
  useEffect(() => {
    if (followOutput.current && log.current) {
      log.current.scrollTop = log.current.scrollHeight;
    }
  }, [progress?.output]);
  if (!progress) {
    return undefined;
  }
  const completed = studioCompletedStages(progress.stage);
  const total = STUDIO_INSTALL_STAGES.length - 1;
  const label = STAGE_LABELS[progress.stage];
  return (
    <div className="studio-install-progress" data-active={activity.kind === 'busy'}>
      <div className="studio-install-progress-heading" role="status">
        <strong>{activity.kind === 'error' ? `Stopped: ${label}` : label}</strong>
        <span>
          Step {Math.min(completed + 1, total)} of {total}
        </span>
      </div>
      <progress max={total} value={completed} aria-label="Studio installation progress" aria-valuetext={label} />
      <div className="studio-install-output-title">Installation output</div>
      <pre
        ref={log}
        className="studio-install-output"
        role="log"
        aria-label="Installation output"
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        {progress.output || 'Preparing installation…'}
      </pre>
      {activity.kind === 'busy' && <p className="studio-setup-note">Keep Stacki open while installation runs.</p>}
    </div>
  );
}
