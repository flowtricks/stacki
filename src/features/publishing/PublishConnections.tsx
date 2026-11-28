import { AddPublishAccount } from './PublishAccount';
import { CodeInline } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslate, useTranslateDescribed, useTranslateRich } from '../../lib/i18n/useTranslate';
import { described, type Described, type MessageKey } from '../../../shared/properties/i18n/messageRef';
import { RefreshIcon } from '../../ui/Icons';
import Dropdown from '../../ui/Dropdown';
import InfoHint from '../../ui/InfoHint';
import { HostingChoice, hostingKey } from './PublishHosting';
import { ADD_OPTION, withAddOption } from './publishFields';
import { cachedPublishingDiscovery, invalidatePublishingAccounts } from './publishDiscoveryCache';
import { connectionFailureMessage, type ConnectionProblem, type PublishAccount, type PublishDiscovery } from '../../../shared/properties/publishDiscovery';
import type { Hosting } from '../../../shared/properties/publishConfig';

type Props = {
  readonly projectPath: string;
  /** Fields that need this connection: shown after it, and left out while it asks to be connected. */
  readonly children?: ReactNode;
} & (
  | {
      readonly provider: 'github';
      readonly value: string;
      readonly change: (account: string) => void;
    }
  | {
      readonly provider: 'cloudflare' | 'vercel' | 'netlify';
      readonly value: Hosting;
      readonly change: (hosting: Hosting) => void;
      /** Production sets a newly named Worker up at once; a destination's is created by its first publish. */
      readonly workerSetup: 'now' | 'on-first-deploy';
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
  // While the next step is to connect or sign in, that button is all there is to do: no list could be filled.
  const signedOut = displayed?.kind === 'failed' && connectionRecovery(provider, displayed).kind === 'sign-in';
  const connection = (
    <div className="publish-connections" aria-busy={busy} data-loading={busy && !selected && !displayed}>
      {signedOut ? undefined : props.provider === 'github' ? (
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
      {displayed?.kind === 'failed' && !installsOnConnect(provider, displayed) && <ConnectionHelp provider={provider} />}
    </div>
  );
  return (
    <>
      {connection}
      {!signedOut && props.children}
    </>
  );
}

// i18n-ignore: product names are never translated.
const PROVIDER_LABELS: Readonly<Record<Props['provider'], string>> = { github: 'GitHub', cloudflare: 'Cloudflare', vercel: 'Vercel', netlify: 'Netlify' };

// The label is English text plus its reference, so the screen translates it and tests and logs keep the English.
type Recovery = ({ readonly kind: 'sign-in' } | { readonly kind: 'refresh' }) & Described & { readonly label: string };

function recoveryOf(kind: Recovery['kind'], key: MessageKey, params?: Readonly<Record<string, string>>): Recovery {
  const label = described(key, params);
  return { kind, label: label.message, ...label };
}

// The sentence for a connection problem, from its reason: the producer's English text is a function of reason and provider.
const FAILURE_KEYS = {
  'missing-cli': 'publish.connection.failure.missingCli',
  'signed-out': 'publish.connection.failure.signedOut',
  expired: 'publish.connection.failure.expired',
  network: 'publish.connection.failure.network',
  unknown: 'publish.connection.failure.unknown',
} as const satisfies Record<ConnectionProblem['reason'], MessageKey>;

/** The one next step for a connection problem: install and sign in, sign in again, or re-check. */
export function connectionRecovery(provider: Props['provider'], problem: Pick<ConnectionProblem, 'reason'>): Recovery {
  const label = PROVIDER_LABELS[provider];
  switch (problem.reason) {
    case 'missing-cli':
      // Cloudflare, Vercel and Netlify sign-in install their CLI first; Stacki never installs gh.
      if (provider === 'github') {
        return recoveryOf('refresh', 'publish.connection.recovery.refresh');
      }
      return provider === 'vercel'
        ? recoveryOf('sign-in', 'publish.connection.recovery.installVercel')
        : recoveryOf('sign-in', 'publish.connection.recovery.connect', { provider: label });
    case 'signed-out':
      return recoveryOf('sign-in', 'publish.connection.recovery.signIn', { provider: label });
    case 'expired':
      return recoveryOf('sign-in', 'publish.connection.recovery.signInAgain');
    case 'network':
    case 'unknown':
      return recoveryOf('refresh', 'publish.connection.recovery.refresh');
    default: {
      const exhaustive: never = problem.reason;
      return exhaustive;
    }
  }
}

/**
 * Whether the recovery button fixes the problem by itself: a missing Cloudflare, Vercel or Netlify tool is installed by the
 * sign-in that button starts, so the missing tool is not news to report, only a step the button takes.
 */
export function installsOnConnect(provider: Props['provider'], problem: Pick<ConnectionProblem, 'reason'>): boolean {
  if (problem.reason !== 'missing-cli') {
    return false;
  }
  return provider !== 'github';
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
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [signingIn, setSigningIn] = useState(false);
  const recovery = connectionRecovery(props.provider, props.problem);
  const recoveryLabel = translateDescribed(recovery);
  const problemText = translate(FAILURE_KEYS[props.problem.reason], { provider: PROVIDER_LABELS[props.provider] });
  const run = recovery.kind === 'sign-in' ? () => setSigningIn(true) : props.refresh;
  // The problem is a toast (a failed check) or the button's (i) tip (a notice beside working accounts), never a line in
  // the dialog. A tool the button installs itself is neither: the button alone is the next step.
  const silent = installsOnConnect(props.provider, props.problem);
  return (
    <div className="publish-connection-recovery">
      <div className="publish-connection-action">
        <button type="button" className={recovery.kind === 'sign-in' ? 'primary' : ''} disabled={props.busy} onClick={run}>
          {props.busy ? translate('publish.connection.checking') : recoveryLabel}
        </button>
        {!props.toast && !silent && <InfoHint text={problemText} />}
      </div>
      {props.toast && !silent && !props.busy && <ErrorToast message={problemText} recovery={[{ label: recoveryLabel, run }]} />}
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
  const translate = useTranslate();
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
        <RefreshLabel
          label={translate('publish.common.githubAccount')}
          refreshLabel={translate('publish.connection.githubAccount.refresh')}
          busy={props.busy}
          refresh={props.refresh}
        />
        <button type="button" className="publish-refresh" onClick={() => setAdding(true)}>
          {translate('publish.common.addAccount')}
        </button>
      </div>
      <Dropdown
        ariaLabel={translate('publish.common.githubAccount')}
        value={props.value}
        options={withAddOption(
          translate('publish.common.addAccount'),
          accounts.map((account) => ({ value: account.id, label: account.name, icon: <GitHubAvatar key={account.id} login={account.id} /> })),
        )}
        placeholder={props.busy ? translate('publish.common.loadingAccounts') : translate('publish.connection.noAccounts')}
        onChange={(account) => (account === ADD_OPTION ? setAdding(true) : props.change(account))}
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

function RefreshLabel(props: { readonly label: string; readonly refreshLabel: string; readonly busy: boolean; readonly refresh: () => void }) {
  return (
    <div className="publish-field-heading publish-label-refresh">
      <span className="publish-label">{props.label}</span>
      <button type="button" className="publish-refresh publish-refresh-icon" disabled={props.busy} aria-label={props.refreshLabel} onClick={props.refresh}>
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
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const command = { github: 'gh auth login', cloudflare: 'wrangler login', vercel: 'vercel login', netlify: 'netlify login' };
  return (
    <details className="publish-connection-help">
      <summary>{translate('publish.connection.help.title')}</summary>
      <p>{translateRich('publish.connection.help.body', { command: <CodeInline language="shell" text={command[provider]} /> })}</p>
    </details>
  );
}
