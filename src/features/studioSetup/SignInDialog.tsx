import { useState } from 'react';
import Popup from '../../ui/Popup';
import { ErrorToast } from '../../ui/ErrorToast';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { StudioAuthConfig, StudioAuthKind } from '../../../shared/ipc/studioAuth';
import SignInFormView, { useSignInForm } from './SignInForm';
import './studioSetup.css';
import './studioAuth.css';

interface Props {
  /** `add` asks before Studio is installed; `change` edits an installed Studio's sign-in only. */
  readonly mode: 'add' | 'change';
  readonly initialKind: StudioAuthKind;
  /** Resolves to a failure sentence to show, or undefined when the choice was taken. */
  readonly onConfirm: (config: StudioAuthConfig) => Promise<string | undefined>;
  readonly onClose: () => void;
}

// A custom dialog, never a native one. The form checks every field with the shared rules before
// anything is sent, and the payload is the checked choice: it has no field a secret could occupy.
export default function SignInDialog({ mode, initialKind, onConfirm, onClose }: Props) {
  const translate = useTranslate();
  const form = useSignInForm(initialKind);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const confirm = async () => {
    const config = form.submit();
    if (config === undefined) {
      return;
    }
    setSaving(true);
    setFailure(undefined);
    const message = await onConfirm(config);
    setSaving(false);
    if (message !== undefined) {
      setFailure(message);
    }
  };
  return (
    <Popup className="studio-setup studio-auth-dialog" label={translate('studioSetup.auth.dialogLabel')} onClose={onClose} dismissible={!saving}>
      {({ close }) => (
        <>
          <header>
            <div>
              <h2>{mode === 'add' ? translate('studioSetup.auth.title') : translate('studioSetup.auth.change.title')}</h2>
            </div>
          </header>
          <section className="studio-setup-content studio-auth-content">
            <p>{translate('studioSetup.auth.intro')}</p>
            {mode === 'change' && <p className="studio-auth-warning">{translate('studioSetup.auth.change.warning')}</p>}
            <SignInFormView form={form} />
            {failure !== undefined && <ErrorToast message={failure} />}
          </section>
          <footer>
            <button disabled={saving} onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button className="primary" disabled={saving} onClick={() => void confirm()}>
              {mode === 'add' ? translate('studioSetup.auth.add') : translate('studioSetup.auth.save')}
            </button>
          </footer>
        </>
      )}
    </Popup>
  );
}
