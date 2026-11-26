import { useState } from 'react';
import type { Hosting } from '../../../shared/properties/publishConfig';
import type { PublishAccount } from '../../../shared/properties/publishDiscovery';
import { NETLIFY_SITE_NAME_PATTERN } from '../../../shared/properties/publishNetlify';
import Dropdown from '../../ui/Dropdown';
import InfoHint from '../../ui/InfoHint';
import Popup from '../../ui/Popup';
import { reportErrorToast } from '../../ui/errorNotices';
import { cleanError } from '../../lib/cleanError';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { createPublishNetlifySite } from '../../ipc/publishNetlifyBridge';
import { WorkerSetupButton } from './PublishWorker';

interface Props {
  readonly projectPath: string;
  readonly teams: readonly PublishAccount[];
  readonly close: () => void;
  readonly created: (hosting: Hosting) => void;
}

// Add site creates the Netlify site now, because publishing needs its id. Nothing is uploaded until the next Publish,
// and the project's own files are not touched.
export function AddNetlifySite(props: Props) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const team = chosen || (props.teams[0]?.id ?? '');
  const valid = NETLIFY_SITE_NAME_PATTERN.test(name);
  const ready = valid && team !== '';
  async function create(): Promise<void> {
    setBusy(true);
    try {
      const result = await createPublishNetlifySite(props.projectPath, { team, name });
      if (result.kind === 'ready') {
        props.created(result.hosting);
      } else {
        reportErrorToast(translateDescribed(result));
      }
    } catch (failure: unknown) {
      reportErrorToast(cleanError(failure));
    } finally {
      setBusy(false);
    }
  }
  const title = translate('publish.netlify.newSite.title');
  return (
    <Popup className="modal publish-settings publish-new-worker" label={title} onClose={props.close} dismissible={!busy}>
      {({ close }) => (
        <>
          <div className="modal-header">{title}</div>
          <fieldset className="modal-body publish-fields" disabled={busy}>
            <div className="publish-field">
              <span className="publish-label">{translate('publish.netlify.newSite.team')}</span>
              <Dropdown
                ariaLabel={translate('publish.netlify.newSite.team')}
                value={team}
                options={props.teams.map((entry) => ({ value: entry.id, label: entry.name }))}
                onChange={setChosen}
                menuClassName="publish-dropdown"
                livePreview={false}
                searchable={props.teams.length > 6}
              />
            </div>
            <div className="publish-field">
              <div className="publish-account-line">
                <span className="publish-label">{translate('publish.netlify.newSite.name')}</span>
                <InfoHint text={translate('publish.netlify.newSite.nameRule')} />
              </div>
              <input
                aria-label={translate('publish.netlify.newSite.name')}
                value={name}
                maxLength={63}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={name !== '' && !valid}
              />
            </div>
          </fieldset>
          <div className="modal-footer">
            <button type="button" onClick={close} disabled={busy}>
              {translate('ui.cancel')}
            </button>
            <WorkerSetupButton
              label={translate('publish.netlify.newSite.create')}
              busyLabel={translate('publish.netlify.newSite.creating')}
              busy={busy}
              disabled={!ready}
              run={() => void create()}
            />
          </div>
        </>
      )}
    </Popup>
  );
}
