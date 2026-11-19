import { useEffect, useState } from 'react';
import { StackiLogo } from '../shared/ui/StackiLogo';
import { useTranslate } from '../../vendor/stacki/src/lib/i18n/useTranslate';
import { STARTUP_LIMITS, type StartupView } from '../features/startup/startupStages';
import { STARTUP_STAGE_KEYS, startupStep } from '../features/startup/startupText';

export function BootScreen({
  attempt,
  failure,
  authenticated,
  startup,
  retry,
}: {
  readonly attempt: number;
  readonly failure: string;
  readonly authenticated: boolean;
  /** Where the container's cold start is, once the Worker has said; undefined before that and where there is no container. */
  readonly startup: StartupView | undefined;
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
      : startup
        ? translate(STARTUP_STAGE_KEYS[startup.stage])
        : translate('studio.boot.loading');
  const step = startup && startup.stage !== 'ready' ? startupStep(startup.stage) : undefined;
  const elapsedMs = seconds * 1000;
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
      {!failure && step && <p className="boot-detail">{translate('studio.boot.stage.step', step)}</p>}
      {!failure && elapsedMs >= STARTUP_LIMITS.slowAfterMs && <p className="boot-detail">{translate('studio.boot.slow', { seconds })}</p>}
      {/* A cold start is normally well under a minute; Retry before that only restarts the wait. */}
      {(failure || elapsedMs >= STARTUP_LIMITS.retryAfterMs) && <button onClick={retry}>{translate('studio.boot.retry')}</button>}
    </div>
  );
}
