import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import Popup from '../../ui/Popup';
import type { StudioStatus } from '../../../shared/ipc/studioSetup';
import { useStudioSetup as useSetup, type StudioActivity } from './useStudioSetup';
import InstallProgress from './InstallProgress';
import LocalStep from './LocalStep';
import CloudStep from './CloudStep';
import './studioSetup.css';
import InstallCommand from './InstallCommand';

interface Props {
  readonly projectPath: string;
  readonly previewURL: string | undefined;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

export default function StudioSetup(props: Props) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const setup = useSetup(props.projectPath, revision);
  const entry = studioEntry(setup.status, setup.activity);
  return (
    <section className="studio-project-settings" aria-label="Stacki Studio">
      <div className="studio-project-settings-card">
        <p className="studio-project-settings-intro">
          Add browser-based editing and collaboration to this project. Setup installs Studio locally and guides you through cloud deployment. Already installed?
          Open setup to continue configuring it.
        </p>
        <div className="studio-install-actions">
          <div className="studio-install-option">
            <p className="studio-install-status" data-state={setup.status?.kind} role="status">
              {entry.status}
            </p>
            <button
              disabled={entry.loading || setup.activity.kind === 'busy'}
              onClick={() => {
                props.onOpen?.();
                setOpen(true);
                if (setup.status?.kind === 'missing') {
                  void setup.install();
                }
              }}
            >
              {entry.label}
            </button>
          </div>
          <InstallCommand />
        </div>
      </div>
      {open && (
        <SetupDialog
          {...props}
          setup={setup}
          onClose={() => {
            setOpen(false);
            setRevision((value) => value + 1);
            props.onClose?.();
          }}
        />
      )}
    </section>
  );
}

function SetupDialog({
  previewURL,
  onClose,
  setup,
}: Props & {
  readonly onClose: () => void;
  readonly setup: ReturnType<typeof useSetup>;
}) {
  const [step, setStep] = useSetupStep(setup.status);
  const busy = setup.activity.kind === 'busy';
  return (
    <Popup className="studio-setup" labelledBy="studio-setup-title" onClose={onClose} dismissible={!busy}>
      {({ close }) => (
        <>
          <SetupHeader busy={busy} onClose={close} />
          <SetupSteps step={step} busy={busy} onStep={setStep} />
          <section className="studio-setup-content">
            {step === 0 && <InstallStep {...setup} />}
            {step === 1 && <LocalStep installed={setup.status?.kind === 'installed'} previewURL={previewURL} />}
            {step === 2 && <CloudStep status={setup.status} />}
            {setup.activity.kind === 'error' && <ErrorToast message={setup.activity.message} />}
          </section>
          <SetupFooter busy={busy} step={step} installed={setup.status?.kind === 'installed'} onClose={close} onStep={setStep} />
        </>
      )}
    </Popup>
  );
}

function SetupFooter({
  busy,
  step,
  installed,
  onClose,
  onStep,
}: {
  readonly busy: boolean;
  readonly step: number;
  readonly installed: boolean;
  readonly onClose: () => void;
  readonly onStep: (step: number) => void;
}) {
  return (
    <footer>
      <button disabled={busy} onClick={onClose}>
        Close
      </button>
      {step > 0 && (
        <button disabled={busy} onClick={() => onStep(step - 1)}>
          Back
        </button>
      )}
      {step < 2 && (
        <button className="primary" disabled={busy} onClick={() => onStep(step === 0 && !installed ? 2 : step + 1)}>
          {step === 0 && !installed ? 'Set up with an agent' : 'Continue'}
        </button>
      )}
    </footer>
  );
}

function useSetupStep(status: StudioStatus | undefined) {
  const [step, setStep] = useState(status?.kind === 'installed' ? 1 : 0);
  useEffect(() => {
    // Advance only after installation succeeds so failures remain available for retry.
    if (status?.kind === 'installed') {
      setStep(1);
    }
  }, [status?.kind]);
  return [step, setStep] as const;
}

function InstallStep({ status, activity, install }: ReturnType<typeof useSetup>) {
  return (
    <>
      <h3>{status?.kind === 'installed' ? 'Studio is installed' : 'Studio installation'}</h3>
      <p>Browser editing and collaboration, installed in /studio.</p>
      {!status && <p role="status">Checking this project…</p>}
      {status?.kind === 'blocked' && <ErrorToast message={status.message} />}
      {status?.kind === 'installed' && <p role="status">Version {status.version}. Continue to local preview or cloud setup.</p>}
      {status?.kind === 'missing' && (
        <>
          <p className="studio-setup-note">Version {status.desktopVersion}</p>
          {activity.kind === 'error' && (
            <button className="primary" onClick={() => void install()}>
              Retry installation
            </button>
          )}
        </>
      )}
      <InstallProgress activity={activity} />
    </>
  );
}

function SetupSteps({ step, busy, onStep }: { readonly step: number; readonly busy: boolean; readonly onStep: (step: number) => void }) {
  return (
    <nav aria-label="Setup steps">
      {['Install', 'Local preview', 'Go live'].map((label, index) => (
        <button key={label} aria-current={step === index ? 'step' : undefined} disabled={busy} onClick={() => onStep(index)}>
          <span>{index + 1}</span>
          {label}
        </button>
      ))}
    </nav>
  );
}

function SetupHeader({ busy, onClose }: { readonly busy: boolean; readonly onClose: () => void }) {
  return (
    <header>
      <div>
        <span className="studio-setup-eyebrow">OPTIONAL PROJECT ADD-ON</span>
        <h2 id="studio-setup-title">Set up Stacki Studio</h2>
      </div>
      <button disabled={busy} onClick={onClose} aria-label="Close Studio setup">
        ×
      </button>
    </header>
  );
}

function studioEntry(status: StudioStatus | undefined, activity: StudioActivity) {
  if (!status) {
    return activity.kind === 'error'
      ? { status: 'Could not check installation', label: 'Open Studio setup', loading: false }
      : { status: 'Checking installation…', label: 'Checking Studio…', loading: true };
  }
  switch (status.kind) {
    case 'installed':
      return {
        status: `Installed · ${status.version}`,
        label: 'Manage Stacki Studio',
        loading: false,
      };
    case 'missing':
      return { status: 'Not installed', label: 'Add to project', loading: false };
    case 'blocked':
      return {
        status: 'Existing studio folder needs review',
        label: 'Review Studio setup',
        loading: false,
      };
  }
}
