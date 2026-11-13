import { useState } from 'react';
import type { Hosting } from '../../../shared/properties/publishConfig';
import type { PublishProject } from '../../../shared/properties/publishDiscovery';
import Popup from '../../ui/Popup';
import { useTranslate } from '../../lib/i18n/useTranslate';

interface Props {
  readonly account: string;
  readonly accountName: string;
  readonly projects: readonly PublishProject[];
  readonly close: () => void;
  readonly change: (hosting: Hosting) => void;
}

export function AddWorker(props: Props) {
  const translate = useTranslate();
  const [name, setName] = useState('');
  const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);
  const exists = props.projects.some((project) => project.hosting.provider === 'cloudflare-workers' && project.hosting.project === name);
  const ready = valid && !exists && props.account.length > 0;
  return (
    <Popup className="modal publish-settings publish-new-worker" label={translate('publish.worker.title')} onClose={props.close} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('publish.worker.title')}</div>
          <div className="modal-body publish-fields">
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
            <p className="hint-text">{translate('publish.worker.saveHint')}</p>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!ready}
              onClick={() => {
                if (ready) {
                  props.change({
                    provider: 'cloudflare-workers',
                    accountId: props.account,
                    project: name,
                  });
                }
              }}
            >
              {translate('publish.worker.add')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
