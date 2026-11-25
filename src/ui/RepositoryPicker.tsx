import { ErrorToast } from './ErrorToast';
import { useEffect, useState } from 'react';
import { readRepositories } from '../ipc/repositoryBridge';
import Dropdown from './Dropdown';
import { useTranslate } from '../lib/i18n/useTranslate';

type RepositoryState =
  { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly repositories: readonly string[] } | { readonly kind: 'error'; readonly message: string };

// A manual owner/name also reaches repositories beyond the bounded recent list.
export default function RepositoryPicker(props: { readonly value: string; readonly onChange: (value: string) => void; readonly disabled: boolean }) {
  const translate = useTranslate();
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
      <label>{translate('ui.repositoryPicker.label')}</label>
      <Dropdown
        ariaLabel={translate('ui.repositoryPicker.recent')}
        value={props.value}
        options={options}
        disabled={props.disabled || state.kind === 'loading'}
        searchable
        livePreview={false}
        searchPlaceholder={translate('ui.repositoryPicker.search')}
        placeholder={state.kind === 'loading' ? translate('ui.repositoryPicker.loading') : props.value || translate('ui.repositoryPicker.choose')}
        onChange={props.onChange}
      />
      <input
        aria-label={translate('ui.repositoryPicker.ownerName')}
        placeholder="owner/repository" // i18n-ignore: the owner/name form GitHub uses
        maxLength={140}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {state.kind === 'error' && <ErrorToast message={translate('ui.repositoryPicker.errorHint', { message: state.message })} />}
    </>
  );
}
