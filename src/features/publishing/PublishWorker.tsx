import { useContext, useState } from 'react';
import type { Hosting } from '../../../shared/properties/publishConfig';
import type { PublishProject } from '../../../shared/properties/publishDiscovery';
import { WORKER_NAME_PATTERN } from '../../../shared/properties/publishWorkerSetup';
import Popup from '../../ui/Popup';
import { reportErrorToast } from '../../ui/errorNotices';
import { cleanError } from '../../lib/cleanError';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { PublishSettingsRebaseContext, setUpWorker } from './setUpWorker';

interface Props {
  readonly projectPath: string;
  readonly account: string;
  readonly accountName: string;
  readonly projects: readonly PublishProject[];
  readonly close: () => void;
  readonly change: (hosting: Hosting) => void;
  /** `now` sets the site up and saves it as production. `on-first-deploy` only names a Worker, for staging. */
  readonly setup: 'now' | 'on-first-deploy';
}

// For production, Add Worker sets the site up for Workers and saves the Worker as its hosting, so the next Publish deploys at once.
// The Worker itself is created by that first deploy; nothing is created at Cloudflare before then.
export function AddWorker(props: Props) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const rebase = useContext(PublishSettingsRebaseContext);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = WORKER_NAME_PATTERN.test(name);
  const exists = props.projects.some((project) => project.hosting.provider === 'cloudflare-workers' && project.hosting.project === name);
  const ready = valid && !exists && props.account.length > 0;
  async function add(): Promise<void> {
    if (props.setup === 'on-first-deploy') {
      // Setting the site up would make this Worker production's. Staging's first deploy creates it.
      props.change({ provider: 'cloudflare-workers', accountId: props.account, project: name });
      return;
    }
    setBusy(true);
    try {
      const result = await setUpWorker(props.projectPath, { accountId: props.account, project: name });
      if (result.ok) {
        rebase?.(result.value.settings);
        props.change(result.value.hosting);
      } else {
        reportErrorToast(translateDescribed(result.error));
      }
    } catch (failure: unknown) {
      reportErrorToast(cleanError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Popup className="modal publish-settings publish-new-worker" label={translate('publish.worker.title')} onClose={props.close} dismissible={!busy}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('publish.worker.title')}</div>
          <fieldset className="modal-body publish-fields" disabled={busy}>
            <p>{translate('publish.worker.account', { account: props.accountName })}</p>
            <label>
              {translate('publish.worker.name')}
              <input
                value={name}
                maxLength={63}
                onChange={(event) => setName(event.target.value)}
                aria-describedby="publish-worker-name-help"
                aria-invalid={!!name && !ready}
              />
            </label>
            <p className="hint-text" id="publish-worker-name-help">
              {exists ? translate('publish.worker.exists') : translate('publish.worker.nameRule')}
            </p>
            {props.setup === 'now' && <p className="hint-text">{translate('publish.worker.setupHint')}</p>}
          </fieldset>
          <div className="modal-footer">
            <button type="button" onClick={close} disabled={busy}>
              {translate('ui.cancel')}
            </button>
            <WorkerSetupButton
              label={translate('publish.worker.add')}
              busyLabel={translate('publish.worker.setup.running')}
              busy={busy}
              disabled={!ready}
              run={() => void add()}
            />
          </div>
        </>
      )}
    </Popup>
  );
}

/**
 * The primary button that runs Worker setup: while it runs, a spinner sits in the button (never a line of text below) and
 * the button keeps its blue fill, so it reads as working rather than unavailable. Shared with the Publish dialog's fix.
 */
export function WorkerSetupButton(props: {
  readonly label: string;
  readonly busyLabel: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly run: () => void;
}) {
  return (
    <button
      type="button"
      className="primary publish-setup-button"
      disabled={props.disabled}
      aria-busy={props.busy}
      aria-label={props.busy ? props.busyLabel : undefined}
      onClick={() => {
        if (!props.busy) {
          props.run();
        }
      }}
    >
      {props.busy && <span className="mini-spinner" aria-hidden="true" />}
      {props.label}
    </button>
  );
}
