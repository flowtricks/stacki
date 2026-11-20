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
import SignInDialog from './SignInDialog';
import type { StudioAuthConfig, StudioAuthKind } from '../../../shared/ipc/studioAuth';
import InfoHint from '../../ui/InfoHint';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';

interface Props {
  readonly projectPath: string;
  readonly previewURL: string | undefined;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

export default function StudioSetup(props: Props) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  // The sign-in question: before installing (`add`) or on an installed Studio (`change`).
  const [signInDialog, setSignInDialog] = useState<'closed' | 'add' | 'change'>('closed');
  const [signInSaved, setSignInSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const setup = useSetup(props.projectPath, revision);
  const entry = studioEntry(setup.status, setup.activity, translate);
  return (
    <section className="studio-project-settings" aria-label={translate('studioSetup.name')}>
      <div className="studio-project-settings-card">
        <div className="studio-install-actions">
          <div className="studio-install-option">
            <p className="studio-install-status" data-state={setup.status?.kind} role="status">
              {entry.status}
              <InfoHint text={translate('settings.studio.info')} />
            </p>
            <button
              disabled={entry.loading || setup.activity.kind === 'busy'}
              onClick={() => {
                if (setup.status?.kind === 'missing') {
                  // Ask how people sign in first; installation starts when this is answered.
                  setSignInDialog('add');
                  return;
                }
                props.onOpen?.();
                setOpen(true);
              }}
            >
              {entry.label}
            </button>
          </div>
          <InstallCommand />
        </div>
        {setup.status?.kind === 'installed' && (
          <div className="studio-auth-current">
            <p className="studio-install-status" role="status">
              {translate('studioSetup.auth.current', { type: signInName(setup.status.signIn, translate) })}
              {signInSaved && ` · ${translate('studioSetup.auth.change.saved')}`}
            </p>
            <button onClick={() => setSignInDialog('change')}>{translate('studioSetup.auth.change')}</button>
          </div>
        )}
      </div>
      {signInDialog !== 'closed' && (
        <SignInDialog
          mode={signInDialog}
          initialKind={initialSignIn(setup.status)}
          onClose={() => setSignInDialog('closed')}
          onConfirm={async (auth: StudioAuthConfig) => {
            if (signInDialog === 'add') {
              setSignInDialog('closed');
              props.onOpen?.();
              setOpen(true);
              void setup.install(auth);
              return undefined;
            }
            const failure = await setup.changeSignIn(auth);
            if (failure === undefined) {
              setSignInSaved(true);
              setSignInDialog('closed');
            }
            return failure;
          }}
        />
      )}
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
  const translate = useTranslate();
  return (
    <footer>
      <button disabled={busy} onClick={onClose}>
        {translate('ui.close')}
      </button>
      {step > 0 && (
        <button disabled={busy} onClick={() => onStep(step - 1)}>
          {translate('studioSetup.back')}
        </button>
      )}
      {step < 2 && (
        <button className="primary" disabled={busy} onClick={() => onStep(step === 0 && !installed ? 2 : step + 1)}>
          {step === 0 && !installed ? translate('studioSetup.setUpWithAgent') : translate('ui.continue')}
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
  const translate = useTranslate();
  return (
    <>
      <h3>{status?.kind === 'installed' ? translate('studioSetup.install.installed') : translate('studioSetup.install.title')}</h3>
      <p>{translate('studioSetup.install.hint')}</p>
      {!status && <p role="status">{translate('studioSetup.install.checking')}</p>}
      {status?.kind === 'blocked' && <ErrorToast message={status.message} />}
      {status?.kind === 'installed' && <p role="status">{translate('studioSetup.install.version', { version: status.version })}</p>}
      {status?.kind === 'missing' && (
        <>
          <p className="studio-setup-note">{translate('studioSetup.install.versionShort', { version: status.desktopVersion })}</p>
          {activity.kind === 'error' && (
            <button className="primary" onClick={() => void install()}>
              {translate('studioSetup.install.retry')}
            </button>
          )}
        </>
      )}
      <InstallProgress activity={activity} />
    </>
  );
}

function SetupSteps({ step, busy, onStep }: { readonly step: number; readonly busy: boolean; readonly onStep: (step: number) => void }) {
  const translate = useTranslate();
  return (
    <nav aria-label={translate('studioSetup.steps.label')}>
      {(['studioSetup.steps.install', 'studioSetup.steps.local', 'studioSetup.steps.live'] as const).map((labelKey, index) => (
        <button key={labelKey} aria-current={step === index ? 'step' : undefined} disabled={busy} onClick={() => onStep(index)}>
          <span>{index + 1}</span>
          {translate(labelKey)}
        </button>
      ))}
    </nav>
  );
}

function SetupHeader({ busy, onClose }: { readonly busy: boolean; readonly onClose: () => void }) {
  const translate = useTranslate();
  return (
    <header>
      <div>
        <span className="studio-setup-eyebrow">{translate('studioSetup.eyebrow')}</span>
        <h2 id="studio-setup-title">{translate('studioSetup.setUp')}</h2>
      </div>
      <button disabled={busy} onClick={onClose} aria-label={translate('studioSetup.closeLabel')}>
        ×
      </button>
    </header>
  );
}

function studioEntry(status: StudioStatus | undefined, activity: StudioActivity, translate: Translator) {
  if (!status) {
    return activity.kind === 'error'
      ? { status: translate('studioSetup.entry.failed'), label: translate('studioSetup.entry.open'), loading: false }
      : { status: translate('studioSetup.entry.checking'), label: translate('studioSetup.entry.checkingLabel'), loading: true };
  }
  switch (status.kind) {
    case 'installed':
      return {
        status: translate('studioSetup.entry.installed', { version: status.version }),
        label: translate('studioSetup.entry.manage'),
        loading: false,
      };
    case 'missing':
      return { status: translate('studioSetup.entry.missing'), label: translate('studioSetup.entry.add'), loading: false };
    case 'blocked':
      return {
        status: translate('studioSetup.entry.blocked'),
        label: translate('studioSetup.entry.review'),
        loading: false,
      };
  }
}

function initialSignIn(status: StudioStatus | undefined): StudioAuthKind {
  return status?.kind === 'installed' && status.signIn !== 'custom' ? status.signIn : 'github';
}

function signInName(signIn: StudioAuthKind | 'custom', translate: Translator): string {
  return signIn === 'custom' ? translate('studioSetup.auth.currentCustom') : translate(`studioSetup.auth.kind.${signIn}.label`);
}
