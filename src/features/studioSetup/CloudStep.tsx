import { ErrorToast } from '../../ui/ErrorToast';
import { useState } from 'react';
import type { StudioStatus } from '../../../shared/ipc/studioSetup';
import { openExternalURL } from '../../ipc/appBridge';
import { CheckIcon, CopyIcon } from '../../ui/Icons';
import { studioSetupPrompt } from './setupPrompt';
import { useCopyText } from './useCopyText';

export default function CloudStep({ status }: { readonly status: StudioStatus | undefined }) {
  return (
    <div className="studio-step-layout">
      <div className="studio-step-intro">
        <h3>Bring Studio online</h3>
        <p>Give your team a shared editor they can access in a browser.</p>
      </div>
      <section aria-labelledby="studio-accounts-title">
        <h4 id="studio-accounts-title" className="studio-section-label">
          You’ll need
        </h4>
        <div className="studio-account-grid">
          <div className="studio-account-card">
            <strong>GitHub</strong>
            <p>Your website’s repository</p>
          </div>
          <div className="studio-account-card">
            <strong>Cloudflare</strong>
            <p>Hosts Studio · Workers Paid plan</p>
          </div>
        </div>
      </section>
      {status ? (
        <AgentHandoff
          text={studioSetupPrompt(status.kind === 'installed' ? status.version : status.desktopVersion, { installed: status.kind === 'installed' })}
        />
      ) : (
        <p role="status">Checking Studio before preparing your instructions…</p>
      )}
    </div>
  );
}

function AgentHandoff({ text }: { readonly text: string }) {
  const clipboard = useCopyText(text);
  return (
    <>
      <section className="studio-agent-card" aria-labelledby="studio-agent-title">
        <h4 id="studio-agent-title">Let your agent handle setup</h4>
        <p>Paste these instructions into your coding agent, in this project.</p>
        <button className="primary studio-copy-action" disabled={clipboard.status === 'copying'} onClick={() => void clipboard.copy()}>
          {clipboard.status === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {clipboard.status === 'copied' ? 'Instructions copied' : 'Copy setup instructions'}
        </button>
        <p className="studio-setup-note">Your agent guides account connection and deployment approval.</p>
        {clipboard.status === 'copied' && (
          <span className="studio-command-status" role="status">
            Setup instructions copied.
          </span>
        )}
        {clipboard.status === 'failed' && <ErrorToast message="Could not copy. Copy the instructions manually." />}
      </section>
      <details className="studio-setup-details" open={clipboard.status === 'failed' || undefined}>
        <summary>View instructions &amp; guides</summary>
        <div className="studio-setup-details-content">
          <textarea aria-label="Agent setup prompt" readOnly value={text} rows={7} onFocus={(event) => event.currentTarget.select()} />
          <div className="studio-setup-actions">
            <DocumentationLink url="https://developers.cloudflare.com/containers/get-started/" label="Cloudflare guide" />
            <DocumentationLink
              url={'https://docs.github.com/en/apps/creating-github-apps/' + 'registering-a-github-app/registering-a-github-app'}
              label="GitHub App guide"
            />
          </div>
        </div>
      </details>
    </>
  );
}

function DocumentationLink({ url, label }: { readonly url: string; readonly label: string }) {
  const [error, setError] = useState('');
  return (
    <>
      <button onClick={() => void openExternalURL(url).catch(() => setError(url))}>{label}</button>
      {error && <ErrorToast message={`Could not open the browser. Open this address: ${error}`} />}
    </>
  );
}
