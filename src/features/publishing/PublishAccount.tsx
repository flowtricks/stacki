import { useEffect, useState } from 'react';
import { publishingAccount, openAccountSignIn } from '../../ipc/publishAccountBridge';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import {
  ACCOUNT_INSTALL_TIMEOUT_MS,
  ACCOUNT_SIGN_IN_TIMEOUT_MS,
  accountSignInPending,
  type AccountState,
} from '../../../shared/ipc/publishAccount';

interface Props {
  readonly projectPath: string;
  readonly provider: 'github' | 'cloudflare';
  readonly close: () => void;
  readonly connected: () => void;
}
const POLL_INTERVAL_MS = 1000;
const POLLS_MAX = Math.ceil(
  (ACCOUNT_INSTALL_TIMEOUT_MS + ACCOUNT_SIGN_IN_TIMEOUT_MS) / POLL_INTERVAL_MS,
);

export function AddPublishAccount(props: Props) {
  const label = props.provider === 'github' ? 'GitHub' : 'Cloudflare';
  const [attempt, setAttempt] = useState(0);
  const state = useAccountSignIn(props.projectPath, props.provider, attempt);
  const { connected } = props;
  useEffect(() => {
    if (state.kind === 'complete') {
      connected();
    }
  }, [state.kind, connected]);
  return (
    <Popup
      className="modal publish-settings publish-add-account"
      label={`Add ${label} account`}
      onClose={props.close}
      dismissible={true}
    >
      {({ close }) => (
        <>
          <div className="modal-header">Add {label} account</div>
          <div className="modal-body publish-fields" aria-live="polite">
            {state.kind === 'installing' ? (
              <p>
                Installing Wrangler in this project. Cloudflare sign-in will start automatically…
              </p>
            ) : state.kind === 'waiting' ? (
              <AccountDeviceCode code={state.code} />
            ) : state.kind === 'browser' ? (
              <AccountBrowserSignIn url={state.url} />
            ) : state.kind === 'failed' ? (
              <>
                <ErrorToast message={state.message} />
                <button type="button" onClick={() => setAttempt(attempt + 1)}>
                  Try again
                </button>
              </>
            ) : (
              <p>
                {state.kind === 'complete' ? 'Account connected.' : `Starting ${label} sign-in…`}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function AccountDeviceCode({ code }: { readonly code: string }) {
  const [error, setError] = useState('');
  return (
    <>
      <p>Enter this one-time code on GitHub to connect your account.</p>
      <label>
        One-time code
        <input
          className="publish-account-code"
          value={code}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <p className="hint-text">
        Choose the account you want to add on GitHub. You can sign in with another account there.
      </p>
      <button
        type="button"
        className="primary"
        onClick={() => {
          setError('');
          void openAccountSignIn().catch(() => {
            setError(
              'Could not open the browser. Visit github.com/login/device and enter the code.',
            );
          });
        }}
      >
        Continue in browser
      </button>
      <p className="hint-text">Waiting for sign-in…</p>
      {error && <ErrorToast message={error} />}
    </>
  );
}

function useAccountSignIn(
  projectPath: string,
  provider: Props['provider'],
  attempt: number,
): AccountState {
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
        setState({ kind: 'failed', message: 'Account sign-in expired. Please try again.' });
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

function AccountBrowserSignIn({ url }: { readonly url: string }) {
  const [error, setError] = useState('');
  return (
    <>
      <p>Sign in to Cloudflare and approve access to connect your accounts.</p>
      <p className="hint-text">
        To use a different login, switch accounts in Cloudflare before approving access. This
        updates the Cloudflare login used by local publishing.
      </p>
      <button
        type="button"
        className="primary"
        onClick={() => {
          setError('');
          void openAccountSignIn(url).catch(() => {
            setError('Could not open Cloudflare sign-in. Please try again.');
          });
        }}
      >
        Continue in browser
      </button>
      <p className="hint-text">Waiting for sign-in…</p>
      {error && <ErrorToast message={error} />}
    </>
  );
}
