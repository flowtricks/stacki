import { useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { LogBlock } from '../../ui/LogBlock';
import { RECOVERY_DETAILS_LIMITS } from './recoveryDetails';
import { closeProject, openProject } from '../../ipc/appBridge';
import './recovery.css';

// What the whole window shows when the interface itself cannot (src/app/recovery/AppBoundary.tsx): what happened, in a
// sentence, and the three ways out. It sits on the app's own panel colour and has no loading state of its own: it is
// the first thing painted when it is needed, and nothing is drawn behind it.
//
// Reload starts the interface again. Open another project asks main to let go of this window's project and load the
// chosen one, which is the same path as closing a project. Copy details puts the failure on the clipboard.
// Files on disk were never written by the failed render, which the screen says because it is the first worry.

interface RecoveryScreenProps {
  /** The sentence that names the failure. */
  readonly reason: string;
  /** The failure's text, shown and copied. */
  readonly details: string;
}

export function RecoveryScreen({ reason, details }: RecoveryScreenProps) {
  const translate = useTranslate();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(details).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const openAnother = (): void => {
    // A picker that fails (the bridge itself may be what broke) leaves the other two buttons working.
    openProject()
      .then((picked) => (!picked.canceled && 'projectPath' in picked ? closeProject(picked.projectPath) : undefined))
      .catch((error: unknown) => console.error('[recovery] could not open another project:', error));
  };
  return (
    <div className="recovery-screen" role="alert">
      <div className="recovery-card">
        <h1 className="recovery-title">{translate('recovery.screen.title')}</h1>
        <p className="recovery-reason">{reason}</p>
        <p className="recovery-reassurance">{translate('recovery.screen.filesSafe')}</p>
        <div className="recovery-actions">
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            {translate('recovery.screen.reload')}
          </button>
          <button type="button" onClick={openAnother}>
            {translate('recovery.screen.openProject')}
          </button>
          <button type="button" onClick={copy}>
            {copied ? translate('recovery.screen.copied') : translate('recovery.screen.copyDetails')}
          </button>
        </div>
        {details !== '' && <LogBlock text={details} charsMax={RECOVERY_DETAILS_LIMITS.traceCharsMax} />}
      </div>
    </div>
  );
}
