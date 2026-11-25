import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { CodeBlock } from '../../ui/CodeBlock';
import { CheckIcon, CopyIcon } from '../../ui/Icons';

/** What `npm create stacki` runs: the way to add or manage Studio without this window. */
export const STUDIO_CREATE_COMMAND = 'npm create stacki@latest';

// A shell command to run in the project folder, highlighted, on a fill (never a border), with a Copy button in the
// shared secondary style. The Studio card shows it inside its "Run it yourself" disclosure.
export default function InstallCommand(props: { readonly command: string; readonly copyLabel: string }) {
  const translate = useTranslate();
  assert(props.command.length > 0, 'InstallCommand: there is a command to show');
  assert(props.copyLabel.length > 0, 'InstallCommand: the Copy button is named');
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (status !== 'copied') {
      return;
    }
    const timer = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  const copy = async () => {
    setStatus('copying');
    try {
      await navigator.clipboard.writeText(props.command);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };
  return (
    <div className="studio-install-command">
      <p>{translate('studioSetup.command.runHere')}</p>
      <div className="studio-install-command-box">
        <CodeBlock className="studio-install-command-code" language="shell" text={props.command} />
        <button type="button" aria-label={props.copyLabel} disabled={status === 'copying'} onClick={() => void copy()}>
          {status === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {status === 'copied' ? translate('studioSetup.copied') : translate('studioSetup.copy')}
        </button>
      </div>
      <span className="studio-command-status" role="status">
        {status === 'copied' ? translate('studioSetup.command.copiedStatus') : ''}
      </span>
      {status === 'failed' && <ErrorToast message={translate('studioSetup.copyCommandFailed')} />}
    </div>
  );
}
