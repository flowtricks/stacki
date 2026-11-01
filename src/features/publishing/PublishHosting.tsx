import { useEffect, useState } from 'react';
import type { Hosting } from '../../../shared/properties/publishConfig';
import type { PublishAccount, PublishProject } from '../../../shared/properties/publishDiscovery';
import Dropdown from '../../ui/Dropdown';
import { RefreshIcon } from '../../ui/Icons';
import { AddPublishAccount } from './PublishAccount';
import { AddWorker } from './PublishWorker';
import { invalidatePublishingAccounts } from './publishDiscoveryCache';

interface Props {
  readonly projectPath: string;
  readonly provider: 'cloudflare' | 'vercel';
  readonly value: Hosting;
  readonly change: (hosting: Hosting) => void;
  readonly accounts: readonly PublishAccount[];
  readonly projects: readonly PublishProject[];
  readonly busy: boolean;
  readonly refresh: () => void;
}

export function HostingChoice(props: Props) {
  const [dialog, setDialog] = useState<'closed' | 'account' | 'worker'>('closed');
  useResolvedAccount(props);
  const account = hostingAccount(props.value);
  const projects =
    props.provider === 'cloudflare' ? props.projects.filter((project) => !account || hostingAccount(project.hosting) === account) : props.projects;
  return (
    <>
      {props.provider === 'cloudflare' && <CloudflareAccount {...props} add={() => setDialog('account')} />}
      <HostingProject {...props} projects={projects} add={() => setDialog('worker')} />
      {dialog === 'account' && (
        <AddPublishAccount
          projectPath={props.projectPath}
          provider="cloudflare"
          close={() => setDialog('closed')}
          connected={() => {
            setDialog('closed');
            invalidatePublishingAccounts(props.projectPath, 'cloudflare');
            props.refresh();
          }}
        />
      )}
      {dialog === 'worker' && (
        <AddWorker
          account={account}
          accountName={props.accounts.find((entry) => entry.id === account)?.name ?? account}
          projects={projects}
          close={() => setDialog('closed')}
          change={(hosting) => {
            props.change(hosting);
            setDialog('closed');
          }}
        />
      )}
    </>
  );
}

function CloudflareAccount(props: Props & { readonly add: () => void }) {
  const selected = hostingAccount(props.value);
  const selectedName = useCloudflareAccountName(props, selected);
  const accounts =
    props.accounts.some((account) => account.id === selected) || !selected ? props.accounts : [...props.accounts, { id: selected, name: selectedName }];
  return (
    <div className="publish-field">
      <div className="publish-field-heading">
        <HostingLabel label="Cloudflare account" busy={props.busy} refresh={props.refresh} />
        <button type="button" className="publish-refresh" onClick={props.add}>
          Add account
        </button>
      </div>
      <Dropdown
        ariaLabel="Cloudflare account"
        value={selected}
        options={accounts.map((account) => ({ value: account.id, label: account.name }))}
        placeholder={props.busy ? 'Loading accounts…' : 'Choose account…'}
        disabled={accounts.length === 0}
        searchable={accounts.length > 6}
        menuClassName="publish-dropdown"
        livePreview={false}
        onChange={(accountId) => {
          if (accountId !== selected) {
            // A project belongs to its account; never carry it into a different destination.
            props.change({ provider: 'cloudflare-workers', accountId, project: '' });
          }
        }}
      />
    </div>
  );
}

function useCloudflareAccountName(props: Props, selected: string): string {
  const [known, setKnown] = useState<{
    readonly projectPath: string;
    readonly account: PublishAccount;
  }>();
  const account = props.accounts.find((entry) => entry.id === selected);
  useEffect(() => {
    if (account !== undefined) {
      setKnown({ projectPath: props.projectPath, account });
    }
  }, [props.projectPath, account]);
  if (account !== undefined) {
    return account.name;
  }
  // A failed refresh must not replace a resolved name with an internal deployment ID.
  if (known?.projectPath === props.projectPath) {
    if (known.account.id === selected) {
      return known.account.name;
    }
  }
  return props.busy ? 'Loading account name…' : 'Account name unavailable';
}

function HostingProject(props: Props & { readonly add: () => void }) {
  const selected = hostingKey(props.value);
  const account = hostingAccount(props.value);
  const options = props.projects
    .map((project) => ({
      value: hostingKey(project.hosting),
      label: project.name,
      group: props.accounts.find((entry) => entry.id === hostingAccount(project.hosting))?.name ?? '',
      description: project.hosting.provider === 'cloudflare' ? 'Pages' : project.hosting.provider === 'cloudflare-workers' ? 'Worker' : '',
    }))
    .sort((left, right) => left.group.localeCompare(right.group) || left.label.localeCompare(right.label));
  if (selected && !options.some((option) => option.value === selected)) {
    options.unshift({
      value: selected,
      label: hostingName(props.value),
      group: '',
      description: account ? 'Saved' : 'Account unverified',
    });
  }
  return (
    <div className="publish-field">
      <div className="publish-field-heading">
        <HostingLabel label="Hosting project" busy={props.busy} refresh={props.refresh} />
        {props.provider === 'cloudflare' && (
          <button type="button" className="publish-refresh" disabled={!account || props.busy} onClick={props.add}>
            Add Worker
          </button>
        )}
      </div>
      <Dropdown
        ariaLabel="Hosting project"
        value={selected}
        options={options}
        placeholder={props.provider === 'cloudflare' && !account ? 'Choose a Cloudflare account first' : props.busy ? 'Loading projects…' : 'Choose project…'}
        disabled={props.provider === 'cloudflare' && !account && !selected}
        menuClassName="publish-dropdown"
        livePreview={false}
        searchable={true}
        searchPlaceholder="Find project…"
        onChange={(value) => {
          const project = props.projects.find((entry) => hostingKey(entry.hosting) === value);
          if (project) {
            props.change(project.hosting);
          }
        }}
      />
    </div>
  );
}

function useResolvedAccount(props: Props): void {
  useEffect(() => {
    if (props.provider !== 'cloudflare' || hostingAccount(props.value) || props.busy) {
      return;
    }
    const name = hostingName(props.value);
    if (name) {
      const matches = props.projects.filter((project) => project.hosting.provider === props.value.provider && hostingName(project.hosting) === name);
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match && hostingAccount(match.hosting)) {
        props.change(match.hosting);
      }
    } else if (props.accounts.length === 1 && props.accounts[0]) {
      props.change({
        provider: 'cloudflare-workers',
        accountId: props.accounts[0].id,
        project: '',
      });
    }
  }, [props]);
}

function HostingLabel(props: { readonly label: string; readonly busy: boolean; readonly refresh: () => void }) {
  return (
    <div className="publish-label-refresh">
      <span className="publish-label">{props.label}</span>
      <button
        type="button"
        className="publish-refresh publish-refresh-icon"
        disabled={props.busy}
        aria-label={`Refresh ${props.label.toLowerCase()}`}
        onClick={props.refresh}
      >
        <RefreshIcon size={13} />
      </button>
    </div>
  );
}

function hostingAccount(hosting: Hosting): string {
  switch (hosting.provider) {
    case 'none':
      return '';
    case 'cloudflare':
    case 'cloudflare-workers':
      return hosting.accountId;
    case 'vercel':
      return hosting.organizationId;
  }
}
export function hostingKey(hosting: Hosting): string {
  switch (hosting.provider) {
    case 'none':
      return '';
    case 'cloudflare':
    case 'cloudflare-workers':
      return hosting.project ? `${hosting.provider}/${hosting.accountId}/${hosting.project}` : '';
    case 'vercel':
      return hosting.projectId ? `vercel/${hosting.organizationId}/${hosting.projectId}` : '';
  }
}
function hostingName(hosting: Hosting): string {
  switch (hosting.provider) {
    case 'none':
      return '';
    case 'cloudflare':
    case 'cloudflare-workers':
      return hosting.project;
    case 'vercel':
      return 'Saved Vercel project';
  }
}
