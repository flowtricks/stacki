import { ErrorToast } from '../../ui/ErrorToast';
import { useState } from 'react';
import { STUDIO_LAUNCH_COMMAND } from '../../../shared/ipc/studioSetup';
import { CheckIcon, CopyIcon } from '../../ui/Icons';
import { useCopyText } from './useCopyText';
import { openExternalURL } from '../../ipc/appBridge';
import { localStudioURL } from './localStudioURL';

export default function LocalStep({ installed, previewURL }: { readonly installed: boolean; readonly previewURL: string | undefined }) {
  const url = installed ? localStudioURL(previewURL) : undefined;
  const [error, setError] = useState('');
  return (
    <div className="studio-step-layout">
      <div className="studio-step-intro">
        <h3>Try your editor locally</h3>
        <p>{installed ? 'Studio runs with your website. No Cloudflare setup needed.' : 'Install Studio first, or use an agent in Go live.'}</p>
      </div>
      <ol className="studio-preview-steps">
        <li>
          <span className="studio-step-number" aria-hidden="true">
            1
          </span>
          <div>
            <h4>Open Studio</h4>
            <p>{url ?? 'Start your website preview to open Studio.'}</p>
            <button
              className="primary"
              disabled={!url}
              onClick={() => {
                if (url) {
                  void openExternalURL(url).catch(() => setError('Could not open your browser.'));
                }
              }}
            >
              Open Studio
            </button>
            {error && <ErrorToast message={error} />}
          </div>
        </li>
        <li>
          <span className="studio-step-number" aria-hidden="true">
            2
          </span>
          <div>
            <h4>Try an edit</h4>
            <p>Choose a page and make a change. Edits save directly to your project files.</p>
          </div>
        </li>
      </ol>
      <LaunchCommand />
    </div>
  );
}

function LaunchCommand() {
  const clipboard = useCopyText(STUDIO_LAUNCH_COMMAND);
  return (
    <section className="studio-command-reference" aria-label="Manual startup">
      <div className="studio-section-heading">
        <h4>Run it yourself later</h4>
        <span>From your project folder</span>
      </div>
      <div className="studio-launch-command">
        <textarea aria-label="Launch command" rows={2} readOnly value={STUDIO_LAUNCH_COMMAND} onFocus={(event) => event.currentTarget.select()} />
        <button aria-label="Copy launch command" title="Copy launch command" disabled={clipboard.status === 'copying'} onClick={() => void clipboard.copy()}>
          {clipboard.status === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {clipboard.status === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {clipboard.status === 'copied' && (
        <span className="studio-command-status" role="status">
          Launch command copied.
        </span>
      )}
      {clipboard.status === 'failed' && <ErrorToast message="Could not copy. Select the command and copy it manually." />}
    </section>
  );
}
