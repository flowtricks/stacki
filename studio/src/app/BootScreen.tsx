import { useEffect, useRef, useState } from 'react';
import { StackiLogo } from '../shared/ui/StackiLogo';
import { useTranslate } from '../../vendor/stacki/src/lib/i18n/useTranslate';
import { STARTUP_LIMITS, type StartupView } from '../features/startup/startupStages';
import { STARTUP_STAGE_KEYS, startupFractionHeld, startupRow, startupStep } from '../features/startup/startupText';

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
  const stepped = startup && startup.stage !== 'ready' ? startupStep(startup.stage) : undefined;
  const row = stepped ? startupRow(stepped.step, stepped.total) : undefined;
  const held = useRef(0);
  held.current = startupFractionHeld(held.current, row ? row.fraction : 0);
  const stepLabel = row ? translate('studio.boot.stage.step', { step: row.step, total: row.total }) : undefined;
  const elapsedMs = seconds * 1000;
  return (
    <div className="boot" aria-busy={!failure}>
      <div className="studio-brand">
        <StackiLogo />
      </div>
      {!failure && <h1 className="boot-title">{translate('studio.boot.opening')}</h1>}
      {!failure && (
        <div className="boot-status">
          <div
            className="boot-progress"
            data-determinate={row ? 'true' : 'false'}
            role="progressbar"
            aria-label={translate('studio.boot.openingLabel')}
            aria-valuemin={row ? 0 : undefined}
            aria-valuemax={row ? row.total : undefined}
            aria-valuenow={row ? row.step : undefined}
            aria-valuetext={stepLabel ? `${stage}. ${stepLabel}` : stage}
          >
            <span style={{ width: `${Math.round((row ? held.current : 0.06) * 1000) / 10}%` }} />
          </div>
          <div className="boot-row">
            <p className="boot-stage" role="status">
              {stage}
            </p>
            {row && (
              <span className="boot-counter" aria-label={stepLabel}>
                {row.counter}
              </span>
            )}
          </div>
          {/* Reserved height: the slow line appears here without moving the bar or the row. */}
          <p className="boot-note">{elapsedMs >= STARTUP_LIMITS.slowAfterMs ? translate('studio.boot.slow', { seconds }) : ''}</p>
        </div>
      )}
      {/* A cold start is normally well under a minute; Retry before that only restarts the wait. */}
      {(failure || elapsedMs >= STARTUP_LIMITS.retryAfterMs) && <button onClick={retry}>{translate('studio.boot.retry')}</button>}
    </div>
  );
}
