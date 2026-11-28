// A destination's separate Worker in production's account, chosen like production's: from the account's own Workers,
// or named with Add Worker. Production's Worker is never offered. A named Worker that does not exist yet is created by
// the destination's first publish.
import { useEffect, useState } from 'react';
import { WORKER_NAME_PATTERN } from '../../../shared/properties/publishWorkerSetup';
import type { PublishDiscovery, PublishProject } from '../../../shared/properties/publishDiscovery';
import Dropdown from '../../ui/Dropdown';
import { RefreshIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { cachedPublishingDiscovery, invalidatePublishingAccounts } from './publishDiscoveryCache';
import { ADD_OPTION, FieldLabel, withAddOption } from './publishFields';
import { connectionRecovery } from './PublishConnections';
import { AddWorker } from './PublishWorker';

interface Props {
  readonly projectPath: string;
  readonly accountId: string;
  readonly productionWorker: string;
  readonly value: string;
  readonly invalid: boolean;
  readonly change: (worker: string) => void;
}

export function DestinationWorkerField(props: Props) {
  const translate = useTranslate();
  const { discovery, busy, refresh } = useAccountDiscovery(props.projectPath);
  const [adding, setAdding] = useState(false);
  const workers = accountWorkers(discovery, props.accountId);
  const offered = workers.map((worker) => worker.name).filter((name) => name.toLowerCase() !== props.productionWorker.toLowerCase());
  const listed = props.value === '' || offered.includes(props.value);
  // Only a complete list can say that a Worker is not at Cloudflare yet.
  const isNew = !listed && !busy && discovery?.kind === 'ready' && discovery.notice === undefined && WORKER_NAME_PATTERN.test(props.value);
  const options = [
    ...(listed ? [] : [{ value: props.value, label: props.value, ...(isNew ? { description: translate('publish.destination.worker.new') } : {}) }]),
    ...offered.map((name) => ({ value: name, label: name })),
  ];
  // While the account asks to be signed in, its own field above shows that button and nothing here could be listed.
  if (discovery?.kind === 'failed' && connectionRecovery('cloudflare', discovery).kind === 'sign-in') {
    return undefined;
  }
  const label = translate('publish.destination.workerName');
  return (
    <div className="publish-field" aria-busy={busy}>
      <div className="publish-field-heading">
        <div className="publish-label-refresh">
          <FieldLabel label={label} hint={translate('publish.destination.worker.replaces')} />
          <button
            type="button"
            className="publish-refresh publish-refresh-icon"
            disabled={busy}
            aria-label={translate('publish.hosting.refreshProject')}
            onClick={refresh}
          >
            <RefreshIcon size={13} />
          </button>
        </div>
        <button type="button" className="publish-refresh" disabled={busy} onClick={() => setAdding(true)}>
          {translate('publish.hosting.addWorker')}
        </button>
      </div>
      <Dropdown<string>
        ariaLabel={label}
        value={props.value}
        options={busy ? options : withAddOption(translate('publish.hosting.addWorker'), options)}
        placeholder={busy ? translate('publish.hosting.loadingProjects') : translate('publish.destination.worker.choose')}
        invalid={props.invalid}
        onChange={(worker) => (worker === ADD_OPTION ? setAdding(true) : props.change(worker))}
        menuClassName="publish-dropdown"
        livePreview={false}
        searchable={true}
        searchPlaceholder={translate('publish.hosting.findProject')}
      />
      {adding && (
        <AddWorker
          setup="on-first-deploy"
          projectPath={props.projectPath}
          account={props.accountId}
          accountName={accountName(discovery, props.accountId)}
          projects={workers}
          close={() => setAdding(false)}
          change={(hosting) => {
            if (hosting.provider === 'cloudflare-workers') {
              props.change(hosting.project);
            }
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function useAccountDiscovery(projectPath: string) {
  const [state, setState] = useState<{ readonly discovery: PublishDiscovery | undefined; readonly busy: boolean }>({ discovery: undefined, busy: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState((previous) => ({ discovery: previous.discovery, busy: true }));
    void cachedPublishingDiscovery(projectPath, { provider: 'cloudflare', account: '' }, attempt === 0 ? 'reuse' : 'refresh')
      .then((discovery) => {
        if (active) {
          setState({ discovery, busy: false });
        }
      })
      .catch(() => {
        // Production's account field reports a connection problem; Add Worker still names one here.
        if (active) {
          setState((previous) => ({ discovery: previous.discovery, busy: false }));
        }
      });
    return () => {
      active = false;
    };
  }, [projectPath, attempt]);
  const refresh = () => {
    invalidatePublishingAccounts(projectPath, 'cloudflare');
    setAttempt(attempt + 1);
  };
  return { ...state, refresh };
}

function accountWorkers(discovery: PublishDiscovery | undefined, accountId: string): readonly PublishProject[] {
  const projects = discovery?.kind === 'ready' ? discovery.projects : [];
  return projects.filter((project) => project.hosting.provider === 'cloudflare-workers' && project.hosting.accountId === accountId);
}

function accountName(discovery: PublishDiscovery | undefined, accountId: string): string {
  const accounts = discovery?.kind === 'ready' ? discovery.accounts : [];
  return accounts.find((account) => account.id === accountId)?.name ?? accountId;
}
