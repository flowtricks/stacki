import { useEffect, useRef, useState } from 'react';
import { hasPendingOperations, mayPause, onOperationsSettled } from './activity';

export function useIdleSession(canPause: boolean) {
  const [paused, setPaused] = useState(false);
  const lastActivity = useRef(Date.now());
  const safe = useRef(canPause);
  safe.current = canPause;
  useEffect(() => {
    if (canPause && document.hidden && !hasPendingOperations()) {
      setPaused(true);
    }
  }, [canPause]);
  useEffect(() => {
    const activity = () => {
      lastActivity.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'studio:interaction'] as const;
    for (const event of events) {
      window.addEventListener(event, activity, { passive: true });
    }
    const check = () => {
      if (!safe.current || hasPendingOperations()) {
        return;
      }
      // Hidden tabs can freeze their timers while proxy sockets stay alive.
      // Release connections before freezing, but only after work is saved.
      if (document.hidden) {
        setPaused(true);
        return;
      }
      if (mayPause(lastActivity.current, Date.now(), !safe.current || hasPendingOperations())) {
        setPaused(true);
      }
    };
    document.addEventListener('visibilitychange', check);
    const stopSettled = onOperationsSettled(check);
    const timer = setInterval(check, 10_000);
    return () => {
      clearInterval(timer);
      stopSettled();
      document.removeEventListener('visibilitychange', check);
      for (const event of events) {
        window.removeEventListener(event, activity);
      }
    };
  }, []);
  return {
    paused,
    resume: () => {
      lastActivity.current = Date.now();
      setPaused(false);
    },
  };
}
