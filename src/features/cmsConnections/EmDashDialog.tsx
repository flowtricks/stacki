// The EmDash dialog: a native modal (the app's Popup in its default mode, as the other dialogs are) centred over the window
// with a dimmed backdrop, a title row with the EmDash mark and a close button, and a body that scrolls inside the dialog.
// The browser traps focus inside a modal dialog; Escape, the close button and a press on the backdrop close it, and focus
// goes back to the EmDash button. While EmDash is being added it cannot be closed, so the run is never left unwatched.
//
// What it shows: the project as detected (not set up, or the content types, missing pieces and the preview guide), and for a
// project without EmDash the section that adds it to this project (EmDashInstall) beside the starter command for a new site.
import { useState } from 'react';
import { CloseIcon, EmDashIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { SkeletonRows } from '../../ui/Skeleton';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { EmDashProject } from '../../../shared/properties/emdash';
import { ChangedFiles, Check, EmDashInstall, type EmDashInstalled } from './EmDashInstall';
import { EmDashAbsent, EmDashPresent } from './EmDashDetails';

export interface EmDashDialogProps {
  readonly projectPath: string;
  /** What detection found; undefined while the first read is out. */
  readonly project: EmDashProject | undefined;
  /** The project as re-read after EmDash was added, so the button's mark follows. */
  readonly onProject: (project: EmDashProject) => void;
  readonly onClose: () => void;
}

export function EmDashDialog({ projectPath, project, onProject, onClose }: EmDashDialogProps) {
  const translate = useTranslate();
  const [running, setRunning] = useState(false);
  const [installed, setInstalled] = useState<EmDashInstalled | undefined>(undefined);
  return (
    <Popup className="modal emdash-dialog" label={translate('emdash.title')} onClose={onClose} dismissible={!running}>
      {({ close }) => (
        <>
          <div className="modal-header emdash-dialog-header">
            <EmDashIcon size={16} />
            {/* i18n-ignore: EmDash is a product name. */}
            <h4>EmDash</h4>
            <button
              type="button"
              className="ghost emdash-dialog-close"
              disabled={running}
              aria-label={translate('ui.close')}
              title={translate('ui.close')}
              onClick={close}
            >
              <CloseIcon size={13} />
            </button>
          </div>
          <div className="modal-body emdash-dialog-body">
            {installed !== undefined && <Outcome installed={installed} />}
            {project === undefined && <SkeletonRows count={3} />}
            {project?.kind === 'absent' && (
              <EmDashAbsent>
                {installed === undefined && (
                  <EmDashInstall
                    projectPath={projectPath}
                    onDismiss={close}
                    onRunningChange={setRunning}
                    onInstalled={(result) => {
                      setInstalled(result);
                      onProject(result.project);
                    }}
                  />
                )}
              </EmDashAbsent>
            )}
            {project?.kind === 'present' && <EmDashPresent project={project} />}
          </div>
        </>
      )}
    </Popup>
  );
}

// What follows a successful install, as a checklist: each line is done (a tick) or still ahead, and what is ahead has its
// exact code one disclosure away. Nothing here claims more than the run did and detection found.
function Outcome({ installed }: { readonly installed: EmDashInstalled }) {
  const translate = useTranslate();
  const configDone = installed.config === 'created' || installed.config === 'merged' || installed.config === 'unchanged';
  const configLabel =
    installed.config === 'otherAdapter'
      ? translate('emdash.install.config.otherAdapter')
      : installed.config === 'unusualShape'
        ? translate('emdash.install.config.unusualShape')
        : translate('emdash.install.check.config');
  return (
    <section className="emdash-install" aria-label={translate('emdash.install.title')} role="status">
      <p>
        <strong>{translate(installed.complete ? 'emdash.install.done.complete' : 'emdash.install.done.partial')}</strong>
      </p>
      <ul className="emdash-checklist">
        <Check done label={translate('emdash.install.check.installed')} />
        <Check done={configDone} label={configLabel} step={configDone ? undefined : 'astroConfig'} />
        {installed.manual.includes('liveConfig') && <Check done={false} label={translate('emdash.install.manual.liveConfig')} step="liveConfig" />}
        <Check
          done={installed.keyGenerated}
          label={translate(installed.keyGenerated ? 'emdash.install.check.key' : 'emdash.install.manual.secrets')}
          step={installed.keyGenerated ? undefined : 'secrets'}
        />
        <Check done={false} label={translate('emdash.install.manual.admin')} />
      </ul>
      {installed.onDemand && <p>{translate('emdash.install.onDemand')}</p>}
      {installed.saved && <p>{translate('emdash.install.savedNote')}</p>}
      <ChangedFiles files={installed.changedFiles} />
    </section>
  );
}
