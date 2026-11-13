import { useEffect, useState } from 'react';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { described, type MessageKey } from '../../../shared/properties/i18n/messageRef';
import { publishingAccount, openAccountSignIn } from '../../ipc/publishAccountBridge';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import {
  ACCOUNT_INSTALL_TIMEOUT_MS,
  ACCOUNT_SIGN_IN_TIMEOUT_MS,
  accountSignInPending,
  type AccountProvider,
  type AccountState,
} from '../../../shared/ipc/publishAccount';

interface Props {
  readonly projectPath: string;
  readonly provider: AccountProvider;
  // Why the dialog opened: adding another account, or a first or renewed sign-in.
  readonly purpose?: 'add' | 'sign-in';
  readonly close: () => void;
  readonly connected: () => void;
}
const POLL_INTERVAL_MS = 1000;
const POLLS_MAX = Math.ceil((ACCOUNT_INSTALL_TIMEOUT_MS + ACCOUNT_SIGN_IN_TIMEOUT_MS) / POLL_INTERVAL_MS);

export function AddPublishAccount(props: Props) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const label = PROVIDER_LABELS[props.provider];
  const [attempt, setAttempt] = useState(0);
  const state = useAccountSignIn(props.projectPath, props.provider, attempt);
  // The attempt that installed the CLI, so its later steps can say what changed.
  const [installedAttempt, setInstalledAttempt] = useState<number | undefined>(undefined);
  const { connected } = props;
  useEffect(() => {
    if (state.kind === 'complete') {
      connected();
    }
    if (state.kind === 'installing') {
      setInstalledAttempt(attempt);
    }
  }, [state.kind, connected, attempt]);
  const retry = () => setAttempt(attempt + 1);
  // A first connection signs in; adding another GitHub or Cloudflare account keeps its old title.
  const heading =
    props.purpose === 'sign-in' ? translate('publish.account.signInTitle', { provider: label }) : translate('publish.account.addTitle', { provider: label });
  return (
    <Popup className="modal publish-settings publish-add-account" label={heading} onClose={props.close} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">{heading}</div>
          <div className="modal-body publish-fields" aria-live="polite">
            {props.provider !== 'github' ? (
              <BrowserSignIn provider={props.provider} state={state} installed={installedAttempt === attempt} retry={retry} />
            ) : state.kind === 'waiting' ? (
              <AccountDeviceCode code={state.code} />
            ) : state.kind === 'failed' ? (
              <>
                <ErrorToast message={translateDescribed(state)} />
                <button type="button" onClick={retry}>
                  {translate('publish.common.tryAgain')}
                </button>
              </>
            ) : (
              <p>{state.kind === 'complete' ? translate('publish.account.connected') : translate('publish.account.starting', { provider: label })}</p>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              {translate('ui.cancel')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

// i18n-ignore: product names are never translated.
const PROVIDER_LABELS: Readonly<Record<AccountProvider, string>> = { github: 'GitHub', cloudflare: 'Cloudflare', vercel: 'Vercel' };

function AccountDeviceCode({ code }: { readonly code: string }) {
  const translate = useTranslate();
  const [error, setError] = useState('');
  return (
    <>
      <p>{translate('publish.account.deviceCode.intro')}</p>
      <label>
        {translate('publish.account.deviceCode.label')}
        <input className="publish-account-code" value={code} readOnly onFocus={(event) => event.currentTarget.select()} />
      </label>
      <p className="hint-text">{translate('publish.account.deviceCode.hint')}</p>
      <button
        type="button"
        className="primary"
        onClick={() => {
          setError('');
          void openAccountSignIn().catch(() => {
            setError(translate('publish.account.deviceCode.openFailed'));
          });
        }}
      >
        {translate('publish.account.continueBrowser')}
      </button>
      <p className="hint-text">{translate('publish.account.waiting')}</p>
      {error && <ErrorToast message={error} />}
    </>
  );
}

function useAccountSignIn(projectPath: string, provider: AccountProvider, attempt: number): AccountState {
  const [state, setState] = useState<AccountState>({ kind: 'starting' });
  useEffect(() => {
    const id = crypto.randomUUID();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resume: () => void = () => {};
    setState({ kind: 'starting' });
    // One request at a time, bounded by both the poll count and the server's session timeout.
    async function poll(): Promise<void> {
      for (let count = 0; count < POLLS_MAX; count++) {
        if (!active) {
          return;
        }
        const result = await publishingAccount(projectPath, {
          action: count === 0 ? 'start' : 'status',
          id,
          provider,
        });
        if (!active) {
          return;
        }
        setState(result);
        if (!accountSignInPending(result)) {
          return;
        }
        await new Promise<void>((resolve) => {
          resume = resolve;
          timer = setTimeout(resolve, POLL_INTERVAL_MS);
        });
      }
      if (active) {
        setState({ kind: 'failed', ...described('publish.account.expired') });
        void publishingAccount(projectPath, { action: 'cancel', id, provider });
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      resume();
      void publishingAccount(projectPath, { action: 'cancel', id, provider });
    };
  }, [projectPath, provider, attempt]);
  return state;
}

// What each browser sign-in says: the tool it installs, and where the install goes.
const BROWSER_SIGN_IN = {
  cloudflare: {
    label: 'Cloudflare', // i18n-ignore: product name.
    installed: 'publish.account.cloudflare.installed',
    installing: 'publish.account.cloudflare.installing',
  },
  vercel: {
    label: 'Vercel', // i18n-ignore: product name.
    installed: 'publish.account.vercel.installed',
    installing: 'publish.account.vercel.installing',
  },
} as const satisfies Record<'cloudflare' | 'vercel', { readonly label: string; readonly installed: MessageKey; readonly installing: MessageKey }>;

// One screen for the whole browser sign-in: installing, starting, waiting and failing only
// change the button and the status line, so nothing flashes past between steps.
function BrowserSignIn(props: {
  readonly provider: 'cloudflare' | 'vercel';
  readonly state: AccountState;
  readonly installed: boolean;
  readonly retry: () => void;
}) {
  const translate = useTranslate();
  const [error, setError] = useState('');
  const { state } = props;
  const copy = BROWSER_SIGN_IN[props.provider];
  return (
    <>
      <p>{translate('publish.account.browser.intro', { provider: copy.label })}</p>
      <p className="hint-text">{translate('publish.account.browser.switchHint', { provider: copy.label })}</p>
      {props.installed && state.kind !== 'installing' && <p className="hint-text">{translate(copy.installed)}</p>}
      {state.kind === 'failed' ? (
        <button type="button" className="primary" onClick={props.retry}>
          {translate('publish.common.tryAgain')}
        </button>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={state.kind !== 'browser'}
          onClick={() => {
            if (state.kind === 'browser') {
              setError('');
              void openAccountSignIn(state.url).catch(() => {
                setError(translate('publish.account.openFailed', { provider: copy.label }));
              });
            }
          }}
        >
          {translate('publish.account.continueBrowser')}
        </button>
      )}
      <BrowserSignInStatus provider={props.provider} state={state} />
      {error && <ErrorToast message={error} />}
    </>
  );
}

function BrowserSignInStatus({ provider, state }: { readonly provider: 'cloudflare' | 'vercel'; readonly state: AccountState }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const copy = BROWSER_SIGN_IN[provider];
  switch (state.kind) {
    case 'installing':
      return <p className="hint-text">{translate(copy.installing)}</p>;
    case 'starting':
      return <p className="hint-text">{translate('publish.account.starting', { provider: copy.label })}</p>;
    case 'waiting':
    case 'browser':
      return <p className="hint-text">{translate('publish.account.waiting')}</p>;
    case 'complete':
      return <p className="hint-text">{translate('publish.account.connected')}</p>;
    case 'cancelled':
      return <p className="hint-text">{translate('publish.account.cancelled')}</p>;
    case 'failed':
      // The cause goes to the app's error toast; the screen only says sign-in stopped.
      return (
        <>
          <p className="hint-text">{translate('publish.account.unfinished')}</p>
          <ErrorToast message={translateDescribed(state)} />
        </>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
