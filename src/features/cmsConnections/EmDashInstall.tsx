// "Add EmDash to this project": the part of the EmDash dialog that installs EmDash into the open Astro project instead of
// starting a new one. The procedure is EmDash's own existing-project guide (shared/properties/emdashInstall.ts says which
// steps Stacki does and which it shows).
//
// A run is only ever started by the confirm button, after the person has seen the exact command and every file that can
// change, and it sends that command back so main refuses to run anything else. While it runs there is a turning ring, the
// streamed output in a highlighted block and Cancel; the dialog cannot be closed from under it. A failure or a cancel
// says in words what happened and lists the files that changed; nothing is reverted. Success is only what detection finds
// after the run, which the dialog shows by re-reading the project.
import { useEffect, useRef, useState } from 'react';
import { CheckIcon, WarningTriangleIcon } from '../../ui/Icons';
import { EmDashCode } from './EmDashCode';
import { ProgressRing } from '../../ui/ProgressRing';
import { SkeletonRows } from '../../ui/Skeleton';
import { cancelEmDashInstall, onEmDashInstallLog, planEmDashInstall, runEmDashInstall } from '../../ipc/emdashBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import {
  EMDASH_CONFIG_EXAMPLE,
  EMDASH_LIVE_CONFIG_TEXT,
  EMDASH_SECRETS_COMMAND,
  appendInstallLog,
  type EmDashInstallResult,
  type EmDashManualStep,
} from '../../../shared/properties/emdashInstall';
import type { EmDashInstallPlan } from '../../../shared/properties/emdashInstall';
import { FAILURE_KEYS, REFUSAL_KEYS, WARNING_KEYS, logTail } from './emdashInstallModel';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';

type Ready = Extract<EmDashInstallPlan, { readonly kind: 'ready' }>;
export type EmDashInstalled = Extract<EmDashInstallResult, { readonly kind: 'installed' }>;

type Phase =
  | { readonly kind: 'planning' }
  | { readonly kind: 'planFailed' }
  | { readonly kind: 'unavailable'; readonly reason: Extract<EmDashInstallPlan, { readonly kind: 'unavailable' }>['reason'] }
  | { readonly kind: 'ready'; readonly plan: Ready }
  | { readonly kind: 'running'; readonly plan: Ready; readonly log: string; readonly stopping: boolean }
  | {
      readonly kind: 'ended';
      readonly plan: Ready;
      readonly log: string;
      readonly result: Extract<EmDashInstallResult, { readonly kind: 'failed' | 'cancelled' }>;
    };

export interface EmDashInstallProps {
  readonly projectPath: string;
  /** Called with the re-read project when the command succeeded. */
  readonly onInstalled: (result: EmDashInstalled) => void;
  /** The preview's Cancel: closes the dialog without running anything. */
  readonly onDismiss: () => void;
  /** True from the confirm click until the run ends, so the dialog stays open. */
  readonly onRunningChange: (running: boolean) => void;
}

export function EmDashInstall({ projectPath, onDismiss, onInstalled, onRunningChange }: EmDashInstallProps) {
  const translate = useTranslate();
  const [phase, setPhase] = useState<Phase>({ kind: 'planning' });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    planEmDashInstall(projectPath).then(
      (plan) => mounted.current && setPhase(plan.kind === 'ready' ? { kind: 'ready', plan } : { kind: 'unavailable', reason: plan.reason }),
      () => mounted.current && setPhase({ kind: 'planFailed' }),
    );
    return () => {
      mounted.current = false;
    };
  }, [projectPath]);
  // Live output, only while a run is out.
  const running = phase.kind === 'running';
  useEffect(() => {
    if (!running) {
      return undefined;
    }
    return onEmDashInstallLog((text) =>
      setPhase((previous) => (previous.kind === 'running' ? { ...previous, log: appendInstallLog(previous.log, text) } : previous)),
    );
  }, [running]);

  const start = (plan: Ready): void => {
    setPhase({ kind: 'running', plan, log: '', stopping: false });
    onRunningChange(true);
    runEmDashInstall(projectPath, plan.command).then(
      (result) => {
        onRunningChange(false);
        if (!mounted.current) {
          return;
        }
        if (result.kind === 'installed') {
          onInstalled(result);
        } else if (result.kind === 'refused') {
          setPhase({ kind: 'unavailable', reason: result.reason });
        } else {
          setPhase((previous) => ({ kind: 'ended', plan, log: previous.kind === 'running' ? previous.log : '', result }));
        }
      },
      () => {
        onRunningChange(false);
        if (mounted.current) {
          setPhase({ kind: 'planFailed' });
        }
      },
    );
  };
  const stop = (): void => {
    setPhase((previous) => (previous.kind === 'running' ? { ...previous, stopping: true } : previous));
    void cancelEmDashInstall(projectPath);
  };

  return (
    <section className="emdash-install" aria-label={translate('emdash.install.title')}>
      <h5 className="emdash-install-heading">{translate(headingKey(phase))}</h5>
      {phase.kind === 'planning' && <SkeletonRows count={2} />}
      {phase.kind === 'planFailed' && <p className="emdash-install-problem">{translate('emdash.install.planFailed')}</p>}
      {phase.kind === 'unavailable' && <p className="emdash-install-problem">{translate(REFUSAL_KEYS[phase.reason])}</p>}
      {phase.kind === 'ready' && <Preview plan={phase.plan} onConfirm={() => start(phase.plan)} onDismiss={onDismiss} />}
      {phase.kind === 'running' && <Running log={phase.log} stopping={phase.stopping} onCancel={stop} />}
      {phase.kind === 'ended' && <Ended phase={phase} onRetry={() => setPhase({ kind: 'ready', plan: phase.plan })} />}
    </section>
  );
}

// The heading says what state the dialog is in, never the one it left.
function headingKey(phase: Phase): MessageKey {
  switch (phase.kind) {
    case 'running':
      return 'emdash.install.heading.running';
    case 'ended':
      return phase.result.kind === 'cancelled' ? 'emdash.install.heading.cancelled' : 'emdash.install.heading.failed';
    case 'planning':
    case 'planFailed':
    case 'unavailable':
    case 'ready':
      return 'emdash.absent.title';
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function Preview({ plan, onConfirm, onDismiss }: { readonly plan: Ready; readonly onConfirm: () => void; readonly onDismiss: () => void }) {
  const translate = useTranslate();
  return (
    <>
      <p>{translate('emdash.install.intro')}</p>
      {plan.warnings.map((warning) => (
        <p key={warning} className="emdash-install-warning">
          <WarningTriangleIcon size={13} />
          <span>{translate(WARNING_KEYS[warning])}</span>
        </p>
      ))}
      <p className="emdash-install-summary">
        {translate(plan.saveFirst ? 'emdash.install.summarySaving' : 'emdash.install.summary', { count: String(plan.files.length), manager: plan.manager })}
      </p>
      <details className="emdash-more">
        <summary>{translate('emdash.install.details')}</summary>
        <div className="emdash-more-body">
          {plan.saveFirst && <p className="emdash-install-note">{translate('emdash.install.saveFirst')}</p>}
          <h6>{translate('emdash.install.command')}</h6>
          <EmDashCode text={plan.command} language="shell" label={translate('emdash.install.command')} />
          <h6>{translate('emdash.install.files')}</h6>
          <FileList files={plan.files} />
        </div>
      </details>
      <div className="emdash-actions">
        <button type="button" onClick={onDismiss}>
          {translate('ui.cancel')}
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          {translate('emdash.install.confirm')}
        </button>
      </div>
    </>
  );
}

function Running({ log, stopping, onCancel }: { readonly log: string; readonly stopping: boolean; readonly onCancel: () => void }) {
  const translate = useTranslate();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scroller.current?.querySelector('pre');
    if (element !== null && element !== undefined) {
      element.scrollTop = element.scrollHeight;
    }
  }, [log]);
  return (
    <>
      <div className="emdash-install-status" role="status">
        <ProgressRing value={undefined} indeterminate sizePx={20} label={translate('emdash.install.running')} />
        <span>{translate(stopping ? 'emdash.install.stopping' : 'emdash.install.status.running')}</span>
        <button type="button" disabled={stopping} onClick={onCancel}>
          {translate('ui.cancel')}
        </button>
      </div>
      <details className="emdash-more" open>
        <summary>{translate('emdash.install.log')}</summary>
        <div className="emdash-install-log" ref={scroller}>
          <EmDashCode text={logTail(log)} language="shell" label={translate('emdash.install.log')} wrap="anywhere" />
        </div>
      </details>
    </>
  );
}

function Ended({ phase, onRetry }: { readonly phase: Extract<Phase, { readonly kind: 'ended' }>; readonly onRetry: () => void }) {
  const translate = useTranslate();
  const { result } = phase;
  return (
    <>
      {result.kind === 'failed' && <p className="emdash-install-problem">{translate(FAILURE_KEYS[result.reason])}</p>}
      <ChangedFiles files={result.changedFiles} />
      <details className="emdash-more">
        <summary>{translate('emdash.install.log')}</summary>
        <div className="emdash-install-log">
          <EmDashCode text={logTail(phase.log)} language="shell" label={translate('emdash.install.log')} wrap="anywhere" />
        </div>
      </details>
      <div className="emdash-actions">
        <button type="button" className="primary" onClick={onRetry}>
          {translate('emdash.install.retry')}
        </button>
      </div>
    </>
  );
}

/** The files a plan names: the name in mono, cut with an ellipsis (the full path is its tooltip), and a small pill saying new or changed. */
function FileList({ files }: { readonly files: Ready['files'] }) {
  const translate = useTranslate();
  return (
    <ul className="emdash-install-files">
      {files.map((file) => (
        <li key={file.path}>
          <code title={file.path}>{file.path}</code>
          <span className="emdash-pill" data-change={file.change}>
            {translate(file.change === 'create' ? 'emdash.install.file.create' : 'emdash.install.file.edit')}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What changed on disk, in a disclosure; nothing is reverted by Stacki. */
export function ChangedFiles({ files }: { readonly files: readonly string[] }) {
  const translate = useTranslate();
  if (files.length === 0) {
    return <p>{translate('emdash.install.changedNone')}</p>;
  }
  return (
    <details className="emdash-more">
      <summary>{translate('emdash.install.changed', { count: String(files.length) })}</summary>
      <ul className="emdash-install-files">
        {files.map((file) => (
          <li key={file}>
            <code title={file}>{file}</code>
          </li>
        ))}
      </ul>
      <p>{translate('emdash.install.notReverted')}</p>
    </details>
  );
}

const STEP_CODE: Readonly<Record<EmDashManualStep, { readonly text: string; readonly language: 'javascript' | 'typescript' | 'shell' } | undefined>> = {
  admin: undefined,
  astroConfig: { text: EMDASH_CONFIG_EXAMPLE, language: 'javascript' },
  liveConfig: { text: EMDASH_LIVE_CONFIG_TEXT, language: 'typescript' },
  secrets: { text: EMDASH_SECRETS_COMMAND, language: 'shell' },
};

/** One line of the success checklist: a tick or an empty mark, the step in a few words, and the code behind it when it is still ahead. */
export function Check({ done, label, step }: { readonly done: boolean; readonly label: string; readonly step?: EmDashManualStep | undefined }) {
  const code = step === undefined ? undefined : STEP_CODE[step];
  return (
    <li data-done={done}>
      <span className="emdash-check-mark" aria-hidden="true">
        {done && <CheckIcon size={12} />}
      </span>
      {code === undefined ? (
        <span>{label}</span>
      ) : (
        <details>
          <summary>{label}</summary>
          <EmDashCode text={code.text} language={code.language} label={label} />
        </details>
      )}
    </li>
  );
}
