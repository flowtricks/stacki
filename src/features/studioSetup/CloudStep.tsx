import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import { useState } from 'react';
import type { StudioStatus } from '../../../shared/ipc/studioSetup';
import { openExternalURL } from '../../ipc/appBridge';
import { CheckIcon, CopyIcon } from '../../ui/Icons';
import { studioSetupPrompt } from './setupPrompt';
import { useCopyText } from './useCopyText';

export default function CloudStep({ status }: { readonly status: StudioStatus | undefined }) {
  const translate = useTranslate();
  return (
    <div className="studio-step-layout">
      <div className="studio-step-intro">
        <h3>{translate('studioSetup.cloud.title')}</h3>
        <p>{translate('studioSetup.cloud.intro')}</p>
      </div>
      <section aria-labelledby="studio-accounts-title">
        <h4 id="studio-accounts-title" className="studio-section-label">
          {translate('studioSetup.cloud.need')}
        </h4>
        <div className="studio-account-grid">
          <div className="studio-account-card">
            {/* i18n-ignore: brand name. */}
            <strong>GitHub</strong>
            <p>{translate('studioSetup.cloud.githubNote')}</p>
          </div>
          <div className="studio-account-card">
            {/* i18n-ignore: brand name. */}
            <strong>Cloudflare</strong>
            <p>{translate('studioSetup.cloud.cloudflareNote')}</p>
          </div>
        </div>
      </section>
      {status ? (
        <AgentHandoff
          text={studioSetupPrompt(status.kind === 'installed' ? status.version : status.desktopVersion, { installed: status.kind === 'installed' })}
        />
      ) : (
        <p role="status">{translate('studioSetup.cloud.checking')}</p>
      )}
    </div>
  );
}

function AgentHandoff({ text }: { readonly text: string }) {
  const translate = useTranslate();
  const clipboard = useCopyText(text);
  return (
    <>
      <section className="studio-agent-card" aria-labelledby="studio-agent-title">
        <h4 id="studio-agent-title">{translate('studioSetup.cloud.agentTitle')}</h4>
        <p>{translate('studioSetup.cloud.agentIntro')}</p>
        <button className="primary studio-copy-action" disabled={clipboard.status === 'copying'} onClick={() => void clipboard.copy()}>
          {clipboard.status === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {clipboard.status === 'copied' ? translate('studioSetup.cloud.copiedInstructions') : translate('studioSetup.cloud.copyInstructions')}
        </button>
        <p className="studio-setup-note">{translate('studioSetup.cloud.agentNote')}</p>
        {clipboard.status === 'copied' && (
          <span className="studio-command-status" role="status">
            {translate('studioSetup.cloud.copiedStatus')}
          </span>
        )}
        {clipboard.status === 'failed' && <ErrorToast message={translate('studioSetup.cloud.copyFailed')} />}
      </section>
      <details className="studio-setup-details" open={clipboard.status === 'failed' || undefined}>
        <summary>{translate('studioSetup.cloud.details')}</summary>
        <div className="studio-setup-details-content">
          <textarea aria-label={translate('studioSetup.cloud.promptLabel')} readOnly value={text} rows={7} onFocus={(event) => event.currentTarget.select()} />
          <div className="studio-setup-actions">
            <DocumentationLink url="https://developers.cloudflare.com/containers/get-started/" label={translate('studioSetup.cloud.cloudflareGuide')} />
            <DocumentationLink
              url={'https://docs.github.com/en/apps/creating-github-apps/' + 'registering-a-github-app/registering-a-github-app'}
              label={translate('studioSetup.cloud.githubGuide')}
            />
          </div>
        </div>
      </details>
    </>
  );
}

function DocumentationLink({ url, label }: { readonly url: string; readonly label: string }) {
  const translate = useTranslate();
  const [error, setError] = useState('');
  return (
    <>
      <button onClick={() => void openExternalURL(url).catch(() => setError(url))}>{label}</button>
      {error && <ErrorToast message={translate('studioSetup.cloud.openFailed', { url: error })} />}
    </>
  );
}
