import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import Popup from '../../ui/Popup';
import type { StudioStatus } from '../../../shared/ipc/studioSetup';
import { useStudioSetup as useSetup, type StudioActivity } from './useStudioSetup';
import InstallProgress from './InstallProgress';
import LocalStep from './LocalStep';
import CloudStep from './CloudStep';
import './studioSetup.css';
import InstallCommand, { STUDIO_CREATE_COMMAND } from './InstallCommand';
import StudioUpgrade, { type ManageAction } from './StudioUpgrade';
import { StudioActionSkeleton, StudioDisclosure, StudioSettingsSection, StudioStatusCard } from './StudioStatusCard';
import { SignInProviderIcon } from './signInProviderIcons';
import SignInDialog from './SignInDialog';
import type { StudioAuthConfig, StudioAuthKind } from '../../../shared/ipc/studioAuth';
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
  const manage: ManageAction = {
    label: entry.label,
    disabled: entry.kind === 'checking' || setup.activity.kind === 'busy',
    onClick: () => {
      if (setup.status?.kind === 'missing') {
        // Ask how people sign in first; installation starts when this is answered.
        setSignInDialog('add');
        return;
      }
      props.onOpen?.();
      setOpen(true);
    },
  };
  return (
    <section className="studio-project-settings" aria-label={translate('studioSetup.name')}>
      <StudioSettingsSection title={translate('studioSetup.install.title')} info={translate('settings.studio.info')}>
        {setup.status?.kind === 'installed' ? (
          <StudioUpgrade
            projectPath={props.projectPath}
            installedVersion={setup.status.version}
            manage={manage}
            onUpgraded={() => setRevision((value) => value + 1)}
          />
        ) : (
          <StudioStatusCard
            line={entry.kind === 'checking' ? { kind: 'checking' } : { kind: 'text', state: entry.kind, text: entry.status, tag: undefined }}
            actions={
              entry.kind === 'checking' ? (
                <StudioActionSkeleton />
              ) : (
                <button type="button" className="primary" disabled={manage.disabled} onClick={manage.onClick}>
                  {manage.label}
                </button>
              )
            }
          >
            <StudioDisclosure summary={translate('studioSetup.upgrade.manual')}>
              <InstallCommand command={STUDIO_CREATE_COMMAND} copyLabel={translate('studioSetup.command.copyAria')} />
            </StudioDisclosure>
          </StudioStatusCard>
        )}
      </StudioSettingsSection>
      {setup.status?.kind === 'installed' && (
        <StudioSettingsSection title={translate('studioSetup.auth.groupLabel')}>
          <div className="studio-auth-current">
            <span className="studio-auth-current-mark" aria-hidden="true">
              <SignInProviderIcon provider={setup.status.signIn} size={20} />
            </span>
            <div className="studio-auth-current-text" role="status">
              <span className="studio-auth-current-name">{signInName(setup.status.signIn, translate)}</span>
              {signInSaved && <span className="studio-auth-current-note">{translate('studioSetup.auth.change.saved')}</span>}
            </div>
            <button type="button" onClick={() => setSignInDialog('change')}>
              {translate('studioSetup.auth.change')}
            </button>
          </div>
        </StudioSettingsSection>
      )}
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

// What the status card says and what its main button does, per installation state. While the check runs there is
// nothing to say yet: the card draws skeletons, and the label is only for the disabled button the type still needs.
type StudioEntry =
  | { readonly kind: 'checking'; readonly label: string }
  | { readonly kind: 'installed' | 'missing' | 'blocked' | 'failed'; readonly status: string; readonly label: string };

function studioEntry(status: StudioStatus | undefined, activity: StudioActivity, translate: Translator): StudioEntry {
  if (status === undefined) {
    if (activity.kind === 'error') {
      return { kind: 'failed', status: translate('studioSetup.entry.failed'), label: translate('studioSetup.entry.open') };
    }
    return { kind: 'checking', label: translate('studioSetup.entry.manage') };
  }
  switch (status.kind) {
    case 'installed':
      return { kind: 'installed', status: translate('studioSetup.entry.installed', { version: status.version }), label: translate('studioSetup.entry.manage') };
    case 'missing':
      return { kind: 'missing', status: translate('studioSetup.entry.missing'), label: translate('studioSetup.entry.add') };
    case 'blocked':
      return { kind: 'blocked', status: translate('studioSetup.entry.blocked'), label: translate('studioSetup.entry.review') };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function initialSignIn(status: StudioStatus | undefined): StudioAuthKind {
  return status?.kind === 'installed' && status.signIn !== 'custom' ? status.signIn : 'github';
}

function signInName(signIn: StudioAuthKind | 'custom', translate: Translator): string {
  return signIn === 'custom' ? translate('studioSetup.auth.currentCustom') : translate(`studioSetup.auth.kind.${signIn}.label`);
}
