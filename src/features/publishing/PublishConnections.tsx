import { AddPublishAccount } from './PublishAccount';
import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import { RefreshIcon } from '../../ui/Icons';
import Dropdown from '../../ui/Dropdown';
import { HostingChoice, hostingKey } from './PublishHosting';
import { cachedPublishingDiscovery, invalidatePublishingAccounts } from './publishDiscoveryCache';
import type { PublishAccount, PublishDiscovery } from '../../../shared/properties/publishDiscovery';
import type { Hosting } from '../../../shared/properties/publishConfig';

type Props = { readonly projectPath: string } & (
  | {
      readonly provider: 'github';
      readonly value: string;
      readonly change: (account: string) => void;
    }
  | {
      readonly provider: 'cloudflare' | 'vercel';
      readonly value: Hosting;
      readonly change: (hosting: Hosting) => void;
    }
);
type ConnectionState = PublishDiscovery | { readonly kind: 'loading'; readonly previous: PublishDiscovery | undefined };

export function PublishConnections(props: Props) {
  const [state, setState] = useState<ConnectionState>({ kind: 'loading', previous: undefined });
  const [attempt, setAttempt] = useState(0);
  const { projectPath, provider } = props;
  useEffect(() => {
    let active = true;
    setState((previous) => ({
      kind: 'loading',
      previous: previous.kind === 'loading' ? previous.previous : previous,
    }));
    void cachedPublishingDiscovery(projectPath, { provider, account: '' }, attempt === 0 ? 'reuse' : 'refresh')
      .then((result) => {
        if (active) {
          setState(result);
        }
      })
      .catch(() => {
        if (active) {
          setState({ kind: 'failed', message: 'Connection unavailable.' });
        }
      });
    return () => {
      active = false;
    };
  }, [projectPath, provider, attempt]);
  const displayed = state.kind === 'loading' ? state.previous : state;
  const accounts = displayed?.kind === 'ready' ? displayed.accounts : [];
  const projects = displayed?.kind === 'ready' ? displayed.projects : [];
  const busy = state.kind === 'loading';
  const selected = props.provider === 'github' ? props.value : hostingKey(props.value);
  return (
    <div className="publish-connections" aria-busy={busy} data-loading={busy && !selected && !displayed}>
      {props.provider === 'github' ? (
        <GitHubChoice {...props} accounts={accounts} busy={busy} refresh={() => setAttempt(attempt + 1)} />
      ) : (
        <HostingChoice {...props} accounts={accounts} projects={projects} busy={busy} refresh={() => setAttempt(attempt + 1)} />
      )}
      {displayed?.kind === 'failed' && (
        <ErrorToast
          message="Connection unavailable. Refresh or check sign-in."
          recovery={[{ label: 'Refresh connection', run: () => setAttempt(attempt + 1) }]}
        />
      )}
      {displayed?.kind === 'ready' && displayed.notice && <p className="hint-text">{displayed.notice}</p>}
      {displayed?.kind === 'failed' && <ConnectionHelp provider={provider} />}
    </div>
  );
}

function GitHubChoice(
  props: Extract<Props, { provider: 'github' }> & {
    readonly accounts: readonly PublishAccount[];
    readonly busy: boolean;
    readonly refresh: () => void;
  },
) {
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (props.value === '' && props.accounts[0]) {
      // Persist a concrete username; other projects may switch the global CLI account.
      props.change(props.accounts[0].id);
    }
  }, [props]);
  const accounts =
    props.accounts.some((account) => account.id === props.value) || !props.value ? props.accounts : [...props.accounts, { id: props.value, name: props.value }];
  return (
    <div className="publish-field">
      <div className="publish-field-heading">
        <RefreshLabel label="GitHub account" busy={props.busy} refresh={props.refresh} />
        <button type="button" className="publish-refresh" onClick={() => setAdding(true)}>
          Add account
        </button>
      </div>
      <Dropdown
        ariaLabel="GitHub account"
        value={props.value}
        options={accounts.map((account) => ({
          value: account.id,
          label: account.name,
          icon: <GitHubAvatar key={account.id} login={account.id} />,
        }))}
        placeholder={props.busy ? 'Loading accounts…' : 'No connected accounts'}
        disabled={accounts.length === 0}
        onChange={props.change}
        menuClassName="publish-dropdown"
        livePreview={false}
        searchable={accounts.length > 6}
      />
      {adding && (
        <AddPublishAccount
          projectPath={props.projectPath}
          provider="github"
          close={() => setAdding(false)}
          connected={() => {
            setAdding(false);
            invalidatePublishingAccounts(props.projectPath);
            props.refresh();
          }}
        />
      )}
    </div>
  );
}

function RefreshLabel(props: { readonly label: string; readonly busy: boolean; readonly refresh: () => void }) {
  return (
    <div className="publish-field-heading publish-label-refresh">
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
function GitHubAvatar({ login }: { readonly login: string }) {
  const [image, setImage] = useState<'loading' | 'ready' | 'failed'>('loading');
  return (
    <span className="publish-avatar" aria-hidden="true">
      {login.slice(0, 1).toUpperCase()}
      {image !== 'failed' && (
        <img
          src={`https://github.com/${encodeURIComponent(login)}.png?size=48`}
          alt=""
          width={20}
          height={20}
          referrerPolicy="no-referrer"
          data-state={image}
          onLoad={() => setImage('ready')}
          onError={() => setImage('failed')}
        />
      )}
    </span>
  );
}

function ConnectionHelp({ provider }: { readonly provider: Props['provider'] }) {
  const command = { github: 'gh auth login', cloudflare: 'wrangler login', vercel: 'vercel login' };
  return (
    <details className="publish-connection-help">
      <summary>Connection help</summary>
      <p>
        Run <code>{command[provider]}</code>, then refresh.
      </p>
    </details>
  );
}
