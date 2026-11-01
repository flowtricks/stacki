import { ErrorToast } from './ErrorToast';
import { useEffect, useState } from 'react';
import { readRepositories } from '../ipc/repositoryBridge';
import Dropdown from './Dropdown';

type RepositoryState =
  { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly repositories: readonly string[] } | { readonly kind: 'error'; readonly message: string };

// A manual owner/name also reaches repositories beyond the bounded recent list.
export default function RepositoryPicker(props: { readonly value: string; readonly onChange: (value: string) => void; readonly disabled: boolean }) {
  const [state, setState] = useState<RepositoryState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void readRepositories().then((result) => {
      if (active) {
        setState(result.ok ? { kind: 'ready', repositories: result.value } : { kind: 'error', message: result.error });
      }
    });
    return () => {
      active = false;
    };
  }, []);
  const options = state.kind === 'ready' ? state.repositories.map((repository) => ({ value: repository, label: repository })) : [];
  return (
    <>
      <label>Existing GitHub repository</label>
      <Dropdown
        ariaLabel="Recent GitHub repositories"
        value={props.value}
        options={options}
        disabled={props.disabled || state.kind === 'loading'}
        searchable
        livePreview={false}
        searchPlaceholder="Search repositories…"
        placeholder={state.kind === 'loading' ? 'Loading repositories…' : props.value || 'Choose a repository…'}
        onChange={props.onChange}
      />
      <input
        aria-label="Repository owner/name"
        placeholder="owner/repository"
        maxLength={140}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {state.kind === 'error' && <ErrorToast message={`${state.message} Install GitHub CLI and run gh auth login.`} />}
    </>
  );
}
