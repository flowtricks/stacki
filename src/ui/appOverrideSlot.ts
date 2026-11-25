// Where Stacki's own pickers ask a running app first (docs/apps.md, "Overrides").
// The pickers live in the ui and props layers, below the Apps feature, so they
// cannot import it; the Apps host installs its dispatcher here
// (src/features/apps/appOverrides.ts) while the editor is open, and every
// override point asks through this one seam. With nothing installed, or with the
// gesture bypassing apps (Alt held), every answer is `default`: Stacki's own
// picker, exactly as before.
import { useSyncExternalStore } from 'react';
import { assert } from '../../shared/core/assert';
import { defaultAnswer, type AppOverrideAnswer, type AppOverrideContexts, type AppOverridePoint } from '../../shared/properties/appsRpc';

/** What a picker asks: the point and its context, less what the dispatcher fills in (the selection). */
export type AppOverrideAsk =
  | { readonly point: 'assets.pick'; readonly context: AppOverrideContexts['assets.pick'] }
  | { readonly point: 'cms.bind'; readonly context: Omit<AppOverrideContexts['cms.bind'], 'selection'> };

/** One request in flight: its answer, and how the picker stops waiting (the field closed). */
export interface AppOverrideCall {
  readonly answer: Promise<AppOverrideAnswer>;
  readonly cancel: () => void;
}

/** What the Apps host installs. */
export interface AppOverrideSlot {
  /** The name of the running app that answers `point` for the current role, if one does. */
  readonly owner: (point: AppOverridePoint) => string | undefined;
  readonly dispatch: (ask: AppOverrideAsk) => AppOverrideCall;
  /** Hears every change of owner. Returns the stop. */
  readonly subscribe: (listener: () => void) => () => void;
}

let slot: AppOverrideSlot | undefined;
let stopSlot: (() => void) | undefined;
const slotListeners = new Set<() => void>();
let altAtLastPress = false;
let pressListening = false;

/** Installs the dispatcher, or removes it with undefined. */
export function setAppOverrideSlot(next: AppOverrideSlot | undefined): void {
  stopSlot?.();
  slot = next;
  stopSlot = next?.subscribe(notifyOwners);
  listenForPresses();
  notifyOwners();
}

/** Asks the point's owner, or answers `default` at once when no app owns it or the gesture bypasses apps. */
export function askAppOverride(ask: AppOverrideAsk, gesture: { readonly bypass: boolean }): AppOverrideCall {
  if (gesture.bypass || slot === undefined) {
    return { answer: Promise.resolve(defaultAnswer(ask.point)), cancel: () => undefined };
  }
  return slot.dispatch(ask);
}

/** The app that answers `point` now, kept current for an indicator. */
export function useAppOverrideOwner(point: AppOverridePoint): string | undefined {
  return useSyncExternalStore(subscribeOwner, () => slot?.owner(point));
}

/**
 * Whether Alt was held at the last pointer press anywhere in the window: the
 * press that opened a picker mounted by its opener (the data picker), whose own
 * click handler is not the picker's.
 */
export function altHeldAtLastPress(): boolean {
  return altAtLastPress;
}

function subscribeOwner(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => {
    slotListeners.delete(listener);
  };
}

function notifyOwners(): void {
  for (const listener of [...slotListeners]) {
    listener();
  }
}

function listenForPresses(): void {
  if (pressListening || typeof window === 'undefined') {
    return;
  }
  pressListening = true;
  const note = (event: MouseEvent): void => {
    altAtLastPress = event.altKey;
  };
  // Capture, so a handler that stops the press cannot hide its Alt.
  window.addEventListener('pointerdown', note, { capture: true });
  window.addEventListener('mousedown', note, { capture: true });
  assert(pressListening, 'Presses are heard once per window');
}
