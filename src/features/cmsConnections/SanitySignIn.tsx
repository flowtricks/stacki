// "Log in with Sanity": Sanity's own login page opens in the browser (it offers
// Google, GitHub and email), then the person picks the project and dataset this
// site uses. The main process turns the login into a project key and logs the
// login out (electron/content/sanityLogin.ts).
import { useEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import { ErrorToast } from '../../ui/ErrorToast';
import { SanityIcon } from '../../ui/Icons';
import { openSanitySignIn, sanityLogin } from '../../ipc/cmsConnectionsBridge';
import {
  SANITY_LOGIN_TIMEOUT_MS,
  type SanityLoginState,
  type SanityProjectChoice,
} from '../../../shared/properties/cmsConnections';

const POLL_INTERVAL_MS = 1000;
const POLLS_MAX = Math.ceil(SANITY_LOGIN_TIMEOUT_MS / POLL_INTERVAL_MS);

export function SanitySignIn(props: { readonly projectPath: string; readonly close: () => void }) {
  // A new id starts a new sign-in: on opening, and on Try again.
  const [session, setSession] = useState(() => crypto.randomUUID());
  const state = useSanitySession(props.projectPath, session);
  const { close } = props;
  useEffect(() => {
    if (state?.kind === 'complete') {
      close();
    }
  }, [state?.kind, close]);
  return (
    <Popup
      className="modal publish-settings cms-sanity-sign-in"
      label="Log in with Sanity"
      onClose={close}
      dismissible
    >
      {() => (
        <>
          <div className="modal-header">
            <SanityIcon size={18} /> Log in with Sanity
          </div>
          <div className="modal-body publish-fields" aria-live="polite">
            <SignInStep
              state={state ?? { kind: 'starting' }}
              choose={(projectId, dataset) =>
                void sanityLogin(props.projectPath, {
                  action: 'choose',
                  id: session,
                  projectId,
                  dataset,
                })
              }
              retry={() => setSession(crypto.randomUUID())}
            />
          </div>
        </>
      )}
    </Popup>
  );
}

function SignInStep(props: {
  readonly state: SanityLoginState;
  readonly choose: (projectId: string, dataset: string) => void;
  readonly retry: () => void;
}) {
  const { state } = props;
  switch (state.kind) {
    case 'starting':
      return <p>Starting…</p>;
    case 'browser':
      return (
        <>
          <p>
            Sign in on Sanity’s page in your browser, then come back here. Stacki creates an Editor
            key for this site’s project and keeps only that key.
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => void openSanitySignIn(state.url)}
          >
            Open the browser again
          </button>
        </>
      );
    case 'choosing':
      return <ProjectChoice state={state} choose={props.choose} />;
    case 'creating':
      return <p>Creating an Editor key for this project…</p>;
    case 'complete':
      return <p>Connected.</p>;
    case 'cancelled':
    case 'failed':
      return (
        <>
          <ErrorToast message={state.kind === 'failed' ? state.message : 'Sign-in cancelled.'} />
          <button type="button" onClick={props.retry}>
            Try again
          </button>
        </>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function ProjectChoice(props: {
  readonly state: Extract<SanityLoginState, { readonly kind: 'choosing' }>;
  readonly choose: (projectId: string, dataset: string) => void;
}) {
  const { projects, suggestion } = props.state;
  const first = projects[0];
  const [projectId, setProjectId] = useState(suggestion?.projectId ?? first?.id ?? '');
  const project: SanityProjectChoice | undefined = projects.find((entry) => entry.id === projectId);
  const [dataset, setDataset] = useState(suggestion?.dataset ?? project?.datasets[0] ?? '');
  const datasets = project?.datasets ?? [];
  return (
    <>
      {suggestion && <p>This site’s .env names the project and dataset chosen below.</p>}
      <label>
        Project
        <select
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            const next = projects.find((entry) => entry.id === event.target.value);
            setDataset(next?.datasets[0] ?? '');
          }}
        >
          {projects.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} ({entry.id})
            </option>
          ))}
        </select>
      </label>
      <label>
        Dataset
        <select value={dataset} onChange={(event) => setDataset(event.target.value)}>
          {datasets.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="primary"
        disabled={!project || !datasets.includes(dataset)}
        onClick={() => props.choose(projectId, dataset)}
      >
        Connect
      </button>
    </>
  );
}

// Polls one sign-in session; the first request starts it and opens the browser.
function useSanitySession(projectPath: string, id: string): SanityLoginState | undefined {
  const [state, setState] = useState<SanityLoginState | undefined>(undefined);
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(undefined);
    async function poll(): Promise<void> {
      for (let count = 0; count < POLLS_MAX && active; count++) {
        const result = await sanityLogin(
          projectPath,
          count === 0 ? { action: 'start', id } : { action: 'status', id },
        );
        if (!active) {
          return;
        }
        setState(result);
        if (result.kind === 'browser' && opened.current !== id) {
          opened.current = id;
          void openSanitySignIn(result.url);
        }
        if (result.kind === 'complete' || result.kind === 'failed' || result.kind === 'cancelled') {
          return;
        }
        await new Promise<void>((resolve) => (timer = setTimeout(resolve, POLL_INTERVAL_MS)));
      }
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      void sanityLogin(projectPath, { action: 'cancel', id });
    };
  }, [projectPath, id]);
  return state;
}
