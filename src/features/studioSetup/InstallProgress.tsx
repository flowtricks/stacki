import { useTranslate } from '../../lib/i18n/useTranslate';
import { memo, useEffect, useMemo, useRef } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import { classifyInstallOutput, type InstallOutputLine } from './installOutputLines';
import { STUDIO_INSTALL_STAGES, studioCompletedStages, type StudioInstallStage } from '../../../shared/ipc/studioProgress';
import type { MessageKey } from '../../lib/i18n/localeContext';
import type { StudioActivity } from './useStudioSetup';

export const STAGE_LABELS: Readonly<Record<StudioInstallStage, MessageKey>> = {
  release: 'studioSetup.stage.release',
  files: 'studioSetup.stage.files',
  dependencies: 'studioSetup.stage.dependencies',
  check: 'studioSetup.stage.check',
  build: 'studioSetup.stage.build',
  activate: 'studioSetup.stage.activate',
  complete: 'studioSetup.stage.complete',
};

export default function InstallProgress({ activity }: { readonly activity: StudioActivity }) {
  const translate = useTranslate();
  const log = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const progress = activity.kind === 'idle' ? undefined : activity.progress;
  useEffect(() => {
    if (followOutput.current && log.current) {
      log.current.scrollTop = log.current.scrollHeight;
    }
  }, [progress?.output]);
  const lines = useMemo(() => classifyInstallOutput(progress?.output ?? ''), [progress?.output]);
  if (!progress) {
    return undefined;
  }
  const completed = studioCompletedStages(progress.stage);
  const total = STUDIO_INSTALL_STAGES.length - 1;
  const label = translate(STAGE_LABELS[progress.stage]);
  return (
    <div className="studio-install-progress" data-active={activity.kind === 'busy'}>
      <div className="studio-install-progress-heading" role="status">
        <strong>{activity.kind === 'error' ? translate('studioSetup.progress.stopped', { stage: label }) : label}</strong>
        <span>{translate('studioSetup.progress.step', { current: Math.min(completed + 1, total), total })}</span>
      </div>
      <progress max={total} value={completed} aria-label={translate('studioSetup.progress.label')} aria-valuetext={label} />
      <div className="studio-install-output-title">{translate('studioSetup.progress.output')}</div>
      <pre
        ref={log}
        className="studio-install-output"
        role="log"
        aria-label={translate('studioSetup.progress.output')}
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        {progress.output ? lines.map((line, index) => <OutputLine key={index} line={line} />) : translate('studioSetup.progress.preparing')}
      </pre>
      {activity.kind === 'busy' && <p className="studio-setup-note">{translate('studioSetup.progress.keepOpen')}</p>}
    </div>
  );
}

// Only a command is coloured; every other line is plain text. Memoised so the lines already
// on screen do not redraw when a new one arrives, which keeps thousands of lines instant.
// Each row ends in a newline inside the <pre>, so copying the log gives back its lines.
const OutputLine = memo(function OutputLine({ line }: { readonly line: InstallOutputLine }) {
  switch (line.kind) {
    case 'command':
      return (
        <>
          <span className="studio-install-output-prefix">{line.prefix}</span>
          <CodeInline text={line.text} language="shell" />
          {'\n'}
        </>
      );
    case 'header':
      return <span className="studio-install-output-header">{line.text + '\n'}</span>;
    case 'log':
      return <>{line.text + '\n'}</>;
    case 'empty':
      return <>{'\n'}</>;
    default: {
      const exhaustive: never = line;
      return exhaustive;
    }
  }
});
