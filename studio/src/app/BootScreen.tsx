import { useEffect, useState } from 'react';
import { StackiLogo } from '../shared/ui/StackiLogo';
import { useTranslate } from '../../vendor/stacki/src/lib/i18n/useTranslate';

export function BootScreen({
  attempt,
  failure,
  authenticated,
  retry,
}: {
  readonly attempt: number;
  readonly failure: string;
  readonly authenticated: boolean;
  readonly retry: () => void;
}) {
  const translate = useTranslate();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const stage = !authenticated
    ? translate('studio.boot.checkingSession')
    : attempt > 1
      ? translate('studio.boot.reconnecting', { attempt })
      : translate('studio.boot.loading');
  return (
    <div className="boot" aria-busy={!failure}>
      <div className="studio-brand">
        <StackiLogo />
      </div>
      {!failure && <p>{translate('studio.boot.opening')}</p>}
      {!failure && (
        <div className="boot-progress" role="progressbar" aria-label={translate('studio.boot.openingLabel')} aria-valuetext={stage}>
          <span />
        </div>
      )}
      {!failure && (
        <p className="boot-detail" role="status">
          {stage}
        </p>
      )}
      {!failure && seconds >= 10 && <p className="boot-detail">{translate('studio.boot.slow', { seconds })}</p>}
      {(failure || seconds >= 10) && <button onClick={retry}>{translate('studio.boot.retry')}</button>}
    </div>
  );
}
