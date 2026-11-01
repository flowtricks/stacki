import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import { RefreshIcon } from '../../ui/Icons';
import Dropdown from '../../ui/Dropdown';
import Popup from '../../ui/Popup';
import { publishingRepositories } from '../../ipc/publishRepositoryBridge';
import type { PublishingRepositories, RepositoryRequest } from '../../../shared/ipc/publishRepository';
import { cleanError } from '../../lib/cleanError';

type Connection = Extract<RepositoryRequest, { readonly action: 'connect' }>;
interface Props {
  readonly projectPath: string;
  readonly account: string;
  readonly selection: Connection | undefined;
  readonly change: (selection: Connection | undefined) => void;
  readonly busy: (busy: boolean) => void;
}
type SettledState = { readonly kind: 'ready'; readonly value: PublishingRepositories } | { readonly kind: 'failed'; readonly message: string };
type State = SettledState | { readonly kind: 'loading'; readonly previous: SettledState | undefined };

export function PublishRepositories(props: Props) {
  const { state, setState, refresh } = useRepositoryList(props.projectPath, props.account);
  const [adding, setAdding] = useState(false);
  const { account } = props;
  const displayed = state.kind === 'loading' ? state.previous : state;
  const ready = displayed?.kind === 'ready' ? displayed.value : undefined;
  return (
    <div className="publish-field" aria-busy={state.kind === 'loading' && !!account} data-loading={state.kind === 'loading' && !!account && !displayed}>
      <div className="publish-field-heading">
        <div className="publish-label-refresh">
          <span className="publish-label">GitHub repository</span>
          <button
            type="button"
            className="publish-refresh publish-refresh-icon"
            aria-label="Refresh repos"
            disabled={!account || state.kind === 'loading'}
            onClick={refresh}
          >
            <RefreshIcon size={13} />
          </button>
        </div>
        <div className="publish-field-actions">
          <button type="button" className="publish-refresh" disabled={!account || ready?.mode === 'managed'} onClick={() => setAdding(true)}>
            Add repo
          </button>
        </div>
      </div>
      <RepositoryChoice {...props} state={displayed} />
      {displayed?.kind === 'failed' && <ErrorToast message={displayed.message} />}
      {ready?.notice && <p className="hint-text">{ready.notice}</p>}
      {adding && (
        <NewRepository
          key={account}
          {...props}
          close={() => setAdding(false)}
          created={(value, repository) => {
            setState({ kind: 'ready', value });
            props.change({ action: 'connect', account, repository, revision: value.revision });
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function RepositoryChoice(props: Props & { readonly state: SettledState | undefined }) {
  const ready = props.state?.kind === 'ready' ? props.state.value : undefined;
  const selection = props.selection?.account === props.account ? props.selection : undefined;
  const selected = selection?.repository ?? ready?.connected ?? '';
  const repositories = [...new Set([...(ready?.repositories ?? []), ...(selected ? [selected] : [])])];
  return (
    <Dropdown
      ariaLabel="GitHub repository"
      value={selected}
      options={repositories.map((repository) => ({ value: repository, label: repository }))}
      placeholder={!props.account ? 'Choose a GitHub account first' : props.state === undefined ? 'Loading repositories…' : 'Choose repository…'}
      disabled={props.state?.kind !== 'ready' || ready?.mode === 'managed'}
      searchable={repositories.length > 6}
      searchPlaceholder="Find repository…"
      menuClassName="publish-dropdown"
      livePreview={false}
      onChange={(repository) => {
        if (ready) {
          props.change(repository === ready.connected ? undefined : { action: 'connect', account: props.account, repository, revision: ready.revision });
        }
      }}
    />
  );
}

interface NewRepositoryProps extends Props {
  readonly close: () => void;
  readonly created: (value: PublishingRepositories, repository: string) => void;
}
function NewRepository(props: NewRepositoryProps) {
  const { name, setName, visibility, setVisibility, state, error, create } = useNewRepository(props);
  return (
    <Popup className="modal publish-settings publish-new-repository" label="Create repository" onClose={props.close} dismissible={state === 'editing'}>
      {({ close }) => (
        <>
          <div className="modal-header">Create repository</div>
          <div className="modal-body publish-fields" aria-busy={state === 'creating'}>
            <label>
              Repository name
              <input value={name} maxLength={100} disabled={state === 'creating'} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="publish-field">
              <span className="publish-label">Visibility</span>
              <Dropdown
                ariaLabel="Repository visibility"
                value={visibility}
                options={[
                  { value: 'private', label: 'Private' },
                  { value: 'public', label: 'Public' },
                ]}
                onChange={setVisibility}
                livePreview={false}
                menuClassName="publish-dropdown"
                disabled={state === 'creating'}
              />
            </div>
            <p className="hint-text">Creates an empty repo in {props.account}. Save Publish settings to connect it.</p>
            {error && <ErrorToast message={error} />}
          </div>
          <div className="modal-footer">
            <button type="button" disabled={state === 'creating'} onClick={close}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={!name || state === 'creating'} onClick={() => void create()}>
              {state === 'creating' ? 'Creating…' : 'Create repo'}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function useNewRepository(props: NewRepositoryProps) {
  const [name, setName] = useState(props.projectPath.split(/[/\\]/).at(-1) ?? 'website');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [state, setState] = useState<'editing' | 'creating'>('editing');
  const [error, setError] = useState('');
  async function create() {
    if (state === 'creating') {
      return;
    }
    setState('creating');
    props.busy(true);
    try {
      const result = await publishingRepositories(props.projectPath, {
        action: 'create',
        account: props.account,
        name,
        private: visibility === 'private',
      });
      if (result.ok) {
        props.created(result.value, `${props.account}/${name}`);
      } else {
        setError(result.error);
      }
    } catch (failure: unknown) {
      setError(cleanError(failure));
    } finally {
      setState('editing');
      props.busy(false);
    }
  }
  return { name, setName, visibility, setVisibility, state, error, create };
}

function useRepositoryList(projectPath: string, account: string) {
  const [state, setState] = useState<State>({ kind: 'loading', previous: undefined });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setState((previous) => ({
      kind: 'loading',
      previous: previous.kind === 'loading' ? previous.previous : previous,
    }));
    if (account) {
      void publishingRepositories(projectPath, { action: 'list', account })
        .then((result) => {
          if (active) {
            setState(result.ok ? { kind: 'ready', value: result.value } : { kind: 'failed', message: result.error });
          }
        })
        .catch((failure: unknown) => {
          if (active) {
            setState({
              kind: 'failed',
              message: cleanError(failure),
            });
          }
        });
    }
    return () => {
      active = false;
    };
  }, [projectPath, account, refresh]);
  return { state, setState, refresh: () => setRefresh((value) => value + 1) };
}
