import { useLayoutEffect } from 'react';
import { cleanError } from '../lib/cleanError';
import { TOAST_LIMIT, type ToastNotice } from './toastNotice';

export interface ToastRecovery {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

type Listener = (notice: ToastNotice) => void;
let listener: Listener | undefined;
let dismissListener: ((id: string) => void) | undefined;
let pending: readonly ToastNotice[] = [];

// A bounded handoff lets child mount effects report before the application's toast owner mounts.
// This is an internal renderer channel, never an IPC or browser-message boundary.
export function reportErrorToast(message: string, recovery: readonly ToastRecovery[] = []): string | undefined {
  return reportActionToast(message, 'error', recovery);
}

/** A toast that offers actions; it stays up until it is dismissed or acted on. */
export function reportActionToast(message: string, kind: ToastNotice['kind'], recovery: readonly ToastRecovery[]): string | undefined {
  if (message.trim().length === 0) {
    return;
  }
  const notice: ToastNotice = { id: crypto.randomUUID(), kind, message, recovery };
  if (listener) {
    listener(notice);
  } else {
    pending = [...pending.filter((item) => item.message !== message), notice].slice(-TOAST_LIMIT);
  }
  return notice.id;
}

export function useErrorToasts(push: Listener, dismiss: (id: string) => void): void {
  useLayoutEffect(() => subscribeErrorToasts(push, dismiss), [push, dismiss]);
}

export function subscribeErrorToasts(push: Listener, dismiss: (id: string) => void): () => void {
  listener = push;
  dismissListener = dismiss;
  const queued = pending;
  pending = [];
  for (const notice of queued) {
    push(notice);
  }
  return () => {
    if (listener === push) {
      listener = undefined;
      dismissListener = undefined;
    }
  };
}

export async function runToastRecovery(action: ToastRecovery): Promise<void> {
  try {
    await action.run();
  } catch (error: unknown) {
    reportErrorToast(cleanError(error));
  }
}

export function dismissErrorToast(id: string): void {
  pending = pending.filter((notice) => notice.id !== id);
  dismissListener?.(id);
}
