import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import { CheckIcon, CopyIcon } from '../../ui/Icons';

const COMMAND = 'npm create stacki@latest';

export default function InstallCommand() {
  const translate = useTranslate();
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
      await navigator.clipboard.writeText(COMMAND);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };
  return (
    <div className="studio-install-command">
      <p>{translate('studioSetup.command.runHere')}</p>
      <div className="studio-install-command-box">
        <CodeInline language="shell" text={COMMAND} />
        <button
          type="button"
          aria-label={translate('studioSetup.command.copyAria')}
          title={translate('studioSetup.command.copyTitle')}
          disabled={status === 'copying'}
          onClick={() => void copy()}
        >
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
