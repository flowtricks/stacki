// "Log in with Sanity": Sanity's own login page opens in the browser (it offers
// Google, GitHub and email), then the person picks the project and dataset this
// site uses. The main process turns the login into a project key and logs the
// login out (electron/content/sanityLogin.ts).
import { useEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { SanityIcon } from '../../ui/Icons';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { openSanitySignIn, sanityLogin } from '../../ipc/cmsConnectionsBridge';
import { SANITY_LOGIN_TIMEOUT_MS, type SanityLoginState, type SanityProjectChoice } from '../../../shared/properties/cmsConnections';

const POLL_INTERVAL_MS = 1000;
const POLLS_MAX = Math.ceil(SANITY_LOGIN_TIMEOUT_MS / POLL_INTERVAL_MS);

export function SanitySignIn(props: { readonly projectPath: string; readonly close: () => void }) {
  const translate = useTranslate();
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
    <Popup className="modal publish-settings cms-sanity-sign-in" label={translate('cmsConnections.actions.logInSanity')} onClose={close} dismissible>
      {() => (
        <>
          <div className="modal-header">
            <SanityIcon size={18} /> {translate('cmsConnections.actions.logInSanity')}
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

function SignInStep(props: { readonly state: SanityLoginState; readonly choose: (projectId: string, dataset: string) => void; readonly retry: () => void }) {
  const { state } = props;
  const translate = useTranslate();
  const describe = useTranslateDescribed();
  switch (state.kind) {
    case 'starting':
      return <p>{translate('cmsConnections.signIn.starting')}</p>;
    case 'browser':
      return (
        <>
          <p>{translate('cmsConnections.signIn.browser')}</p>
          <button type="button" className="primary" onClick={() => void openSanitySignIn(state.url)}>
            {translate('cmsConnections.signIn.openAgain')}
          </button>
        </>
      );
    case 'choosing':
      return <ProjectChoice state={state} choose={props.choose} />;
    case 'creating':
      return <p>{translate('cmsConnections.signIn.creating')}</p>;
    case 'complete':
      return <p>{translate('cmsConnections.signIn.complete')}</p>;
    case 'cancelled':
    case 'failed':
      return (
        <>
          <ErrorToast message={state.kind === 'failed' ? describe(state) : translate('cmsConnections.signIn.cancelled')} />
          <button type="button" onClick={props.retry}>
            {translate('cmsConnections.signIn.tryAgain')}
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
  const translate = useTranslate();
  const { projects, suggestion } = props.state;
  const first = projects[0];
  const [projectId, setProjectId] = useState(suggestion?.projectId ?? first?.id ?? '');
  const project: SanityProjectChoice | undefined = projects.find((entry) => entry.id === projectId);
  const [dataset, setDataset] = useState(suggestion?.dataset ?? project?.datasets[0] ?? '');
  const datasets = project?.datasets ?? [];
  return (
    <>
      {suggestion && <p>{translate('cmsConnections.signIn.envNote')}</p>}
      <div className="publish-field">
        <label>{translate('cmsConnections.signIn.project')}</label>
        <Dropdown
          ariaLabel={translate('cmsConnections.signIn.project')}
          value={projectId}
          options={projects.map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.id})` }))}
          searchable={projects.length > 6}
          menuClassName="publish-dropdown"
          livePreview={false}
          onChange={(nextId) => {
            setProjectId(nextId);
            const next = projects.find((entry) => entry.id === nextId);
            setDataset(next?.datasets[0] ?? '');
          }}
        />
      </div>
      <div className="publish-field">
        <label>{translate('cmsConnections.form.dataset')}</label>
        <Dropdown
          ariaLabel={translate('cmsConnections.form.dataset')}
          value={dataset}
          options={datasets.map((name) => ({ value: name, label: name }))}
          menuClassName="publish-dropdown"
          livePreview={false}
          onChange={setDataset}
        />
      </div>
      <button type="button" className="primary" disabled={!project || !datasets.includes(dataset)} onClick={() => props.choose(projectId, dataset)}>
        {translate('cmsConnections.signIn.connect')}
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
        const result = await sanityLogin(projectPath, count === 0 ? { action: 'start', id } : { action: 'status', id });
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
