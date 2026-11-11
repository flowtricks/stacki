import { AddPublishAccount } from './PublishAccount';
import { CodeInline } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import { RefreshIcon } from '../../ui/Icons';
import Dropdown from '../../ui/Dropdown';
import { HostingChoice, hostingKey } from './PublishHosting';
import { cachedPublishingDiscovery, invalidatePublishingAccounts } from './publishDiscoveryCache';
import { connectionFailureMessage, type ConnectionProblem, type PublishAccount, type PublishDiscovery } from '../../../shared/properties/publishDiscovery';
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
          // The request itself failed (the bridge, not the provider): say so, and offer refresh.
          setState({ kind: 'failed', reason: 'unknown', message: connectionFailureMessage(PROVIDER_LABELS[provider], 'unknown') });
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
  const refresh = () => setAttempt(attempt + 1);
  const problem = displayed?.kind === 'failed' ? displayed : displayed?.kind === 'ready' ? displayed.notice : undefined;
  return (
    <div className="publish-connections" aria-busy={busy} data-loading={busy && !selected && !displayed}>
      {props.provider === 'github' ? (
        <GitHubChoice {...props} accounts={accounts} busy={busy} refresh={refresh} />
      ) : (
        <HostingChoice {...props} accounts={accounts} projects={projects} busy={busy} refresh={refresh} />
      )}
      {problem && (
        <ConnectionRecovery
          key={attempt}
          projectPath={projectPath}
          provider={provider}
          problem={problem}
          toast={displayed?.kind === 'failed'}
          busy={busy}
          refresh={refresh}
        />
      )}
      {displayed?.kind === 'failed' && <ConnectionHelp provider={provider} />}
    </div>
  );
}

const PROVIDER_LABELS: Readonly<Record<Props['provider'], string>> = { github: 'GitHub', cloudflare: 'Cloudflare', vercel: 'Vercel' };

type Recovery = { readonly kind: 'sign-in'; readonly label: string } | { readonly kind: 'refresh'; readonly label: string };

/** The one next step for a connection problem: install and sign in, sign in again, or re-check. */
export function connectionRecovery(provider: Props['provider'], problem: Pick<ConnectionProblem, 'reason'>): Recovery {
  const label = PROVIDER_LABELS[provider];
  switch (problem.reason) {
    case 'missing-cli':
      // Cloudflare and Vercel sign-in install their CLI first; Stacki never installs gh.
      if (provider === 'github') {
        return { kind: 'refresh', label: 'Refresh connection' };
      }
      return { kind: 'sign-in', label: provider === 'vercel' ? 'Install Vercel' : `Connect ${label}` };
    case 'signed-out':
      return { kind: 'sign-in', label: `Sign in to ${label}` };
    case 'expired':
      return { kind: 'sign-in', label: 'Sign in again' };
    case 'network':
    case 'unknown':
      return { kind: 'refresh', label: 'Refresh connection' };
    default: {
      const exhaustive: never = problem.reason;
      return exhaustive;
    }
  }
}

// Remounted for each check (keyed by attempt), so a refresh that fails again reports again: the
// toast leaves while the check runs and returns with the reason it found.
function ConnectionRecovery(props: {
  readonly projectPath: string;
  readonly provider: Props['provider'];
  readonly problem: ConnectionProblem;
  readonly toast: boolean;
  readonly busy: boolean;
  readonly refresh: () => void;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const recovery = connectionRecovery(props.provider, props.problem);
  const run = recovery.kind === 'sign-in' ? () => setSigningIn(true) : props.refresh;
  return (
    <div className="publish-connection-recovery">
      <p className="hint-text">{props.problem.message}</p>
      <button type="button" className={recovery.kind === 'sign-in' ? 'primary' : ''} disabled={props.busy} onClick={run}>
        {props.busy ? 'Checking connection…' : recovery.label}
      </button>
      {props.toast && !props.busy && <ErrorToast message={props.problem.message} recovery={[{ label: recovery.label, run }]} />}
      {signingIn && (
        <AddPublishAccount
          projectPath={props.projectPath}
          provider={props.provider}
          purpose="sign-in"
          close={() => setSigningIn(false)}
          connected={() => {
            setSigningIn(false);
            invalidatePublishingAccounts(props.projectPath, props.provider);
            props.refresh();
          }}
        />
      )}
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

export function ConnectionHelp({ provider }: { readonly provider: Props['provider'] }) {
  const command = { github: 'gh auth login', cloudflare: 'wrangler login', vercel: 'vercel login' };
  return (
    <details className="publish-connection-help">
      <summary>Connection help</summary>
      <p>
        Run <CodeInline language="shell" text={command[provider]} />, then refresh.
      </p>
    </details>
  );
}
