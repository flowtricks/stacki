import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeBlock } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import { useState } from 'react';
import { STUDIO_LAUNCH_COMMAND } from '../../../shared/ipc/studioSetup';
import { CheckIcon, CopyIcon } from '../../ui/Icons';
import { useCopyText } from './useCopyText';
import { openExternalURL } from '../../ipc/appBridge';
import { localStudioURL } from './localStudioURL';

export default function LocalStep({ installed, previewURL }: { readonly installed: boolean; readonly previewURL: string | undefined }) {
  const translate = useTranslate();
  const url = installed ? localStudioURL(previewURL) : undefined;
  const [error, setError] = useState('');
  return (
    <div className="studio-step-layout">
      <div className="studio-step-intro">
        <h3>{translate('studioSetup.local.title')}</h3>
        <p>{installed ? translate('studioSetup.local.installed') : translate('studioSetup.local.notInstalled')}</p>
      </div>
      <ol className="studio-preview-steps">
        <li>
          <span className="studio-step-number" aria-hidden="true">
            1
          </span>
          <div>
            <h4>{translate('studioSetup.local.open')}</h4>
            <p>{url ?? translate('studioSetup.local.startPreview')}</p>
            <button
              className="primary"
              disabled={!url}
              onClick={() => {
                if (url) {
                  void openExternalURL(url).catch(() => setError(translate('studioSetup.local.openFailed')));
                }
              }}
            >
              {translate('studioSetup.local.open')}
            </button>
            {error && <ErrorToast message={error} />}
          </div>
        </li>
        <li>
          <span className="studio-step-number" aria-hidden="true">
            2
          </span>
          <div>
            <h4>{translate('studioSetup.local.edit')}</h4>
            <p>{translate('studioSetup.local.editHint')}</p>
          </div>
        </li>
      </ol>
      <LaunchCommand />
    </div>
  );
}

function LaunchCommand() {
  const translate = useTranslate();
  const clipboard = useCopyText(STUDIO_LAUNCH_COMMAND);
  return (
    <section className="studio-command-reference" aria-label={translate('studioSetup.local.manual')}>
      <div className="studio-section-heading">
        <h4>{translate('studioSetup.local.later')}</h4>
        <span>{translate('studioSetup.local.folder')}</span>
      </div>
      <div className="studio-launch-command">
        <CodeBlock className="studio-launch-code" label={translate('studioSetup.local.launch')} language="shell" text={STUDIO_LAUNCH_COMMAND} />
        <button
          aria-label={translate('studioSetup.local.copyLaunch')}
          title={translate('studioSetup.local.copyLaunch')}
          disabled={clipboard.status === 'copying'}
          onClick={() => void clipboard.copy()}
        >
          {clipboard.status === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {clipboard.status === 'copied' ? translate('studioSetup.copied') : translate('studioSetup.copy')}
        </button>
      </div>
      {clipboard.status === 'copied' && (
        <span className="studio-command-status" role="status">
          {translate('studioSetup.local.copiedStatus')}
        </span>
      )}
      {clipboard.status === 'failed' && <ErrorToast message={translate('studioSetup.copyCommandFailed')} />}
    </section>
  );
}
