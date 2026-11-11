// An app asking to show its own details (`app.openSettings`, docs/apps.md "App
// settings"): the runtime records the request here and reveals the Apps panel,
// which opens that app's details popup at the asked section and marks the
// request handled. Its own module, beside appsRuntime.ts and AppsPanel.tsx,
// so neither imports the other for it. One request waits at a time: a newer one
// replaces it, as a second click on a row would.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AppDetailsSectionId } from './AppDetails';

/** One app's details, at one section. */
export interface AppDetailsRequest {
  readonly appId: string;
  readonly section: AppDetailsSectionId;
  /** Tells one request from the next, so a panel never handles the same one twice. */
  readonly serial: number;
}

/** Requests are numbered within one window; this many is never reached in practice and stays a safe integer. */
const SERIAL_MAX = Number.MAX_SAFE_INTEGER;

let pending: AppDetailsRequest | undefined;
let serial = 0;
let reveal: (() => void) | undefined;
const listeners = new Set<() => void>();

/** Asks the Apps panel to open `appId`'s details at `section`, revealing the panel. */
export function requestAppDetails(appId: string, section: AppDetailsSectionId): void {
  assert(appId.length > 0, 'A details request names its app');
  assert(serial < SERIAL_MAX, 'Request serials stay safe integers');
  serial += 1;
  pending = { appId, section, serial };
  reveal?.();
  notify();
}

/** The host's way to show the Apps panel (appsDirectory.ts setAppsPanelReveal passes it on); undefined when it unmounts. */
export function setAppDetailsReveal(next: (() => void) | undefined): void {
  reveal = next;
}

/** The Apps panel's side: the request waiting, and how to mark it handled. */
export function useAppDetailsRequest(): { readonly request: AppDetailsRequest | undefined; readonly handled: (request: AppDetailsRequest) => void } {
  const current = useSyncExternalStore(subscribe, () => pending);
  return { request: current, handled: handleAppDetailsRequest };
}

/** Marks `request` handled; a newer one that arrived meanwhile stays. */
export function handleAppDetailsRequest(request: AppDetailsRequest): void {
  if (pending?.serial === request.serial) {
    pending = undefined;
    notify();
  }
  assert(pending?.serial !== request.serial, 'A handled request is no longer pending');
}

/** The request waiting, for tests and hosts that read it without React. */
export function pendingAppDetailsRequest(): AppDetailsRequest | undefined {
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}
