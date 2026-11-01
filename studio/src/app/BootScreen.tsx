import { useEffect, useState } from 'react';
import { StackiLogo } from '../shared/ui/StackiLogo';

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
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const stage = !authenticated
    ? 'Checking your session…'
    : attempt > 1
      ? `Reconnecting to your workspace… (attempt ${attempt} of 3)`
      : 'Loading your pages and components…';
  return (
    <div className="boot" aria-busy={!failure}>
      <div className="studio-brand">
        <StackiLogo />
      </div>
      {!failure && <p>Opening your studio…</p>}
      {!failure && (
        <div className="boot-progress" role="progressbar" aria-label="Opening Studio" aria-valuetext={stage}>
          <span />
        </div>
      )}
      {!failure && (
        <p className="boot-detail" role="status">
          {stage}
        </p>
      )}
      {!failure && seconds >= 10 && <p className="boot-detail">This is taking longer than usual. {seconds}s elapsed.</p>}
      {(failure || seconds >= 10) && <button onClick={retry}>Retry opening Studio</button>}
    </div>
  );
}
