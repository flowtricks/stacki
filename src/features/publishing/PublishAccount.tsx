import { useEffect, useRef, useState } from 'react';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { described, type MessageKey } from '../../../shared/properties/i18n/messageRef';
import InfoHint from '../../ui/InfoHint';
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
  const { connected } = props;
  useEffect(() => {
    if (state.kind === 'complete') {
      connected();
    }
  }, [state.kind, connected]);
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
              <BrowserSignIn provider={props.provider} state={state} retry={retry} />
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

// The step the sign-in button names while it works, changing in place: setting up (installing the tool or starting
// sign-in), then waiting for the person in the browser. A finished or failed sign-in names its own next step instead.
const BROWSER_STEP_LABELS = {
  installing: 'publish.account.step.setup',
  starting: 'publish.account.step.setup',
  browser: 'publish.account.step.waiting',
  waiting: 'publish.account.step.waiting',
  complete: 'publish.account.connected',
  cancelled: 'publish.account.step.setup',
} as const satisfies Record<Exclude<AccountState['kind'], 'failed'>, MessageKey>;

// One screen for the whole browser sign-in: one line, a (?) tip for switching logins, and one primary button that
// carries the progress (spinner and step label) from setup to sign-in. The browser opens by itself once the sign-in
// page is ready; problems are toasts, each with its own retry, never lines added to the dialog.
function BrowserSignIn(props: { readonly provider: 'cloudflare' | 'vercel'; readonly state: AccountState; readonly retry: () => void }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [openError, setOpenError] = useState('');
  const opened = useRef<string | undefined>(undefined);
  const { state } = props;
  const label = PROVIDER_LABELS[props.provider];
  const openBrowser = (url: string) => {
    setOpenError('');
    void openAccountSignIn(url).catch(() => {
      setOpenError(translate('publish.account.openFailed', { provider: label }));
    });
  };
  const browserURL = state.kind === 'browser' ? state.url : undefined;
  useEffect(() => {
    // Each sign-in page opens once; polling hands back the same address every second.
    if (browserURL !== undefined && opened.current !== browserURL) {
      opened.current = browserURL;
      openBrowser(browserURL);
    }
  });
  const tryAgain = translate('publish.common.tryAgain');
  return (
    <>
      <div className="publish-account-line">
        <p>{translate('publish.account.browser.approve')}</p>
        <InfoHint text={translate('publish.account.browser.switchHint', { provider: label })} />
      </div>
      {state.kind === 'failed' ? (
        <>
          <button type="button" className="primary" onClick={props.retry}>
            {tryAgain}
          </button>
          <ErrorToast message={translateDescribed(state)} recovery={[{ label: tryAgain, run: props.retry }]} />
        </>
      ) : (
        <SignInStepButton state={state} />
      )}
      {openError && browserURL !== undefined && (
        <ErrorToast message={openError} recovery={[{ label: translate('publish.account.openBrowser'), run: () => openBrowser(browserURL) }]} />
      )}
    </>
  );
}

// The blue button keeps its fill while it works (aria-disabled, not the disabled attribute that dims it), so it reads
// as busy rather than unavailable; a click while it works does nothing.
function SignInStepButton({ state }: { readonly state: Exclude<AccountState, { readonly kind: 'failed' }> }) {
  const translate = useTranslate();
  const busy = accountSignInPending(state);
  return (
    <button type="button" className="primary publish-setup-button" aria-busy={busy} aria-disabled={true} aria-live="polite">
      {busy && <span className="mini-spinner" aria-hidden="true" />}
      {translate(BROWSER_STEP_LABELS[state.kind])}
    </button>
  );
}
