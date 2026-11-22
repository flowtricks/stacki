import { STUDIO_INSTALL_STAGES, studioCompletedStages } from '../../../shared/ipc/studioProgress';
import { manualUpgradeCommand, type StudioChange, type StudioUpgradeNote } from '../../../shared/ipc/studioUpgrade';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { CodeInline } from '../../ui/CodeBlock';
import { CheckIcon } from '../../ui/Icons';
import { Skeleton } from '../../ui/Skeleton';
import InstallCommand, { STUDIO_CREATE_COMMAND } from './InstallCommand';
import { STAGE_LABELS } from './InstallProgress';
import { StudioDisclosure, StudioStatusCard } from './StudioStatusCard';
import { useStudioUpgrade } from './useStudioUpgrade';
import { canStartUpgrade, restorableNote, type UpgradeState } from './upgradeState';
import './studioUpgrade.css';

/** The button that opens the setup dialog; the card decides whether it is the primary one. */
export interface ManageAction {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

interface Props {
  readonly projectPath: string;
  readonly installedVersion: string;
  readonly manage: ManageAction;
  readonly onUpgraded: () => void;
}

const CHANGE_LABELS: Readonly<Record<StudioChange['kind'], MessageKey>> = {
  modifiedFile: 'studioSetup.upgrade.change.modified',
  addedFile: 'studioSetup.upgrade.change.added',
  removedFile: 'studioSetup.upgrade.change.removed',
};

// The status card of an installed Studio. The installed version shows once, in the status line; a newer release is one tag
// after it. One primary button per state: Upgrade (or Retry) while an upgrade is on offer, Manage otherwise, none while
// an upgrade or restore runs. Below the header: one line of progress or result, the backup note, and the manual command
// behind "Run it yourself". The transitions live in upgradeState.ts.
export default function StudioUpgrade({ projectPath, installedVersion, manage, onUpgraded }: Props) {
  const translate = useTranslate();
  assert(installedVersion.length > 0, 'StudioUpgrade: an installed Studio has a version');
  const { state, start, restore } = useStudioUpgrade(projectPath, installedVersion, onUpgraded);
  const note = restorableNote(state);
  const busy = state.kind === 'running' || state.kind === 'restoring';
  return (
    <StudioStatusCard
      line={{
        kind: 'text',
        state: 'installed',
        text: translate('studioSetup.entry.installed', { version: installedVersion }),
        tag: <UpgradeTag state={state} />,
      }}
      actions={<UpgradeActions state={state} manage={manage} busy={busy} onStart={() => void start()} />}
    >
      <UpgradeLine state={state} onRestore={() => void restore()} />
      {note !== undefined && <BackupNote note={note} onRestore={() => void restore()} />}
      <StudioDisclosure summary={translate('studioSetup.upgrade.manual')}>
        {canStartUpgrade(state) ? (
          <InstallCommand command={manualUpgradeCommand(state.latest)} copyLabel={translate('studioSetup.upgrade.copyAria')} />
        ) : (
          <InstallCommand command={STUDIO_CREATE_COMMAND} copyLabel={translate('studioSetup.command.copyAria')} />
        )}
      </StudioDisclosure>
    </StudioStatusCard>
  );
}

function UpgradeActions(props: { readonly state: UpgradeState; readonly manage: ManageAction; readonly busy: boolean; readonly onStart: () => void }) {
  const translate = useTranslate();
  const { state, manage } = props;
  // Manage steps back to secondary while an upgrade is on offer, so exactly one blue button leads, and while an upgrade
  // or restore runs, when it waits disabled and the progress line is what the person watches.
  const offersStart = canStartUpgrade(state);
  const managePrimary = !offersStart && !props.busy;
  return (
    <>
      <button type="button" className={managePrimary ? 'primary' : undefined} disabled={manage.disabled || props.busy} onClick={manage.onClick}>
        {manage.label}
      </button>
      {offersStart && (
        <button type="button" className="primary" onClick={props.onStart}>
          {state.kind === 'ready' ? translate('studioSetup.upgrade.start', { version: state.latest }) : translate('studioSetup.upgrade.retry')}
        </button>
      )}
    </>
  );
}

// The tag after "Installed · 1.4.10": up to date, or the one newer version on offer. Nothing when there is nothing to say.
function UpgradeTag({ state }: { readonly state: UpgradeState }) {
  const translate = useTranslate();
  switch (state.kind) {
    case 'checking':
      return (
        <span className="studio-upgrade-tag-skeleton">
          <Skeleton width="72px" height="18px" radius="9px" />
        </span>
      );
    case 'current':
      return (
        <span className="studio-upgrade-tag" data-kind="current">
          <CheckIcon size={12} />
          {translate('studioSetup.upgrade.current')}
        </span>
      );
    case 'ready':
    case 'failure':
      return (
        <span className="studio-upgrade-tag" data-kind="available">
          {translate('studioSetup.upgrade.available', { version: state.latest })}
        </span>
      );
    case 'unavailable':
    case 'running':
    case 'success':
    case 'restoring':
    case 'restored':
    case 'restoreFailure':
      return undefined;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// The one line under the header while something happens or has just happened; the resting states need none.
function UpgradeLine({ state, onRestore }: { readonly state: UpgradeState; readonly onRestore: () => void }) {
  const translate = useTranslate();
  switch (state.kind) {
    case 'checking':
    case 'unavailable':
    case 'current':
    case 'ready':
      return undefined;
    case 'running': {
      const stage = state.progress.stage;
      const label = translate(STAGE_LABELS[stage]);
      return (
        <div className="studio-upgrade-progress" role="status">
          <span className="studio-upgrade-line">{`${translate('studioSetup.upgrade.running', { version: state.latest })} · ${label}`}</span>
          <progress max={STUDIO_INSTALL_STAGES.length - 1} value={studioCompletedStages(stage)} aria-label={label} />
        </div>
      );
    }
    case 'restoring': {
      const label = translate('studioSetup.upgrade.restoring', { version: state.note.from });
      return (
        <div className="studio-upgrade-progress" role="status">
          <span className="studio-upgrade-line">{label}</span>
          <progress aria-label={label} />
        </div>
      );
    }
    case 'success':
      return (
        <p className="studio-upgrade-line studio-upgrade-current" role="status">
          <CheckIcon size={14} />
          {`${translate('studioSetup.upgrade.success', { version: state.note.to })} ${translate('studioSetup.upgrade.success.next')}`}
        </p>
      );
    case 'restored':
      return (
        <p className="studio-upgrade-line studio-upgrade-current" role="status">
          <CheckIcon size={14} />
          {translate('studioSetup.upgrade.restored', { version: state.version })}
        </p>
      );
    case 'failure':
      // Retry is the card's primary action, in the header; this line only says what went wrong.
      return (
        <p className="studio-upgrade-line studio-upgrade-error" role="alert">
          {state.message}
        </p>
      );
    case 'restoreFailure':
      return (
        <div className="studio-upgrade-row">
          <p className="studio-upgrade-line studio-upgrade-error" role="alert">
            {state.message}
          </p>
          <button type="button" onClick={onRestore}>
            {translate('studioSetup.upgrade.retry')}
          </button>
        </div>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// One calm sentence about the backup, with the files and the restore behind a disclosure for the few who want them.
function BackupNote({ note, onRestore }: { readonly note: StudioUpgradeNote; readonly onRestore: () => void }) {
  const translate = useTranslate();
  const total = note.changed?.total ?? 0;
  return (
    <StudioDisclosure summary={total > 0 ? translate('studioSetup.upgrade.backup.files', { count: total }) : translate('studioSetup.upgrade.backup.folder')}>
      {note.changed !== undefined && note.changed.listed.length > 0 && (
        <ul className="studio-upgrade-files">
          {note.changed.listed.map((change) => (
            <li key={`${change.kind}:${change.path}`}>
              <span>{translate(CHANGE_LABELS[change.kind])}</span>
              <CodeInline text={change.path} language="shell" />
            </li>
          ))}
        </ul>
      )}
      {note.changed !== undefined && note.changed.total > note.changed.listed.length && (
        <p className="studio-upgrade-line">{translate('studioSetup.upgrade.details.more', { count: note.changed.total - note.changed.listed.length })}</p>
      )}
      <button type="button" className="studio-upgrade-restore" onClick={onRestore}>
        {translate('studioSetup.upgrade.restore', { version: note.from })}
      </button>
    </StudioDisclosure>
  );
}
