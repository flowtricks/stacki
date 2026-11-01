import { useState } from 'react';
import type { Hosting } from '../../../shared/properties/publishConfig';
import type { PublishProject } from '../../../shared/properties/publishDiscovery';
import Popup from '../../ui/Popup';

interface Props {
  readonly account: string;
  readonly accountName: string;
  readonly projects: readonly PublishProject[];
  readonly close: () => void;
  readonly change: (hosting: Hosting) => void;
}

export function AddWorker(props: Props) {
  const [name, setName] = useState('');
  const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);
  const exists = props.projects.some((project) => project.hosting.provider === 'cloudflare-workers' && project.hosting.project === name);
  const ready = valid && !exists && props.account.length > 0;
  return (
    <Popup className="modal publish-settings publish-new-worker" label="Add Cloudflare Worker" onClose={props.close} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">Add Cloudflare Worker</div>
          <div className="modal-body publish-fields">
            <p>Account: {props.accountName}</p>
            <label>
              Worker name
              <input
                value={name}
                maxLength={63}
                onChange={(event) => setName(event.target.value)}
                aria-describedby="publish-worker-name-help"
                aria-invalid={!!name && !ready}
              />
            </label>
            <p className="hint-text" id="publish-worker-name-help">
              {exists
                ? 'This Worker already exists. Choose it from Hosting project.'
                : 'Use lowercase letters, numbers, and hyphens. Start with a letter or number.'}
            </p>
            <p className="hint-text">
              Save Publish settings to select this destination. Your next publish creates the Worker using this project’s Cloudflare configuration.
            </p>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              Cancel
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
              Add Worker
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
