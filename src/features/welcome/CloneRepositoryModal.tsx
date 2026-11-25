import { translateFailure, translateReference } from '../../lib/i18n/translateErrorText';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import { useRef, useState } from 'react';
import RepositoryPicker from '../../ui/RepositoryPicker';
import { cloneRepository } from '../../ipc/repositoryBridge';
import { parseGitHubRepository } from '../../../shared/ipc/githubRepository';

export default function CloneRepositoryModal(props: { readonly onClose: () => void; readonly onOpen: (projectPath: string) => void }) {
  const translate = useTranslate();
  const [repository, setRepository] = useState('');
  const [state, setState] = useState<{ readonly kind: 'ready'; readonly error?: string } | { readonly kind: 'cloning' }>({ kind: 'ready' });
  const running = useRef(false);
  const clone = async () => {
    if (running.current) {
      return;
    }
    try {
      parseGitHubRepository(repository);
    } catch {
      setState({ kind: 'ready', error: translate('welcome.clone.invalid') });
      return;
    }
    running.current = true;
    setState({ kind: 'cloning' });
    try {
      const result = await cloneRepository(repository);
      if (!result.ok) {
        setState({ kind: 'ready', error: translateFailure(result, translate) });
      } else if (result.value.canceled) {
        setState({ kind: 'ready' });
      } else if ('error' in result.value) {
        setState({ kind: 'ready', error: translateReference(result.value.error, result.value.errorRef, translate) });
      } else {
        props.onOpen(result.value.projectPath);
      }
    } finally {
      running.current = false;
    }
  };
  const busy = state.kind === 'cloning';
  return (
    <Popup className="modal" onClose={props.onClose} dismissible={!busy}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('welcome.clone.title')}</div>
          <div className="modal-body">
            <RepositoryPicker value={repository} onChange={setRepository} disabled={busy} />
            <p className="hint-text">{translate('welcome.clone.hint')}</p>
            {state.kind === 'ready' && state.error && <ErrorToast message={state.error} />}
            {busy && <div role="status">{translate('welcome.clone.downloading')}</div>}
          </div>
          <div className="modal-footer">
            <button onClick={close} disabled={busy}>
              {translate('ui.cancel')}
            </button>
            <button className="primary" disabled={busy || !repository.trim()} onClick={() => void clone()}>
              {busy ? translate('welcome.clone.busy') : translate('welcome.clone.submit')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
