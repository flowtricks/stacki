// Which permission request has the person's attention: the oldest unanswered one, whether its card
// is on screen, and the keys that answer it. The cards register themselves while they wait, so the
// pinned strip above the composer (PermissionPin) and the keyboard handler agree on one request
// without any of the transcript's components knowing about each other.
//
// The registry is module state because every mounted card must see the same order; it holds only
// request ids and is bounded by `AI_LIMITS.permissionsPendingMax` (a card past the bound still works
// with its buttons, it is only not offered the shortcuts or the pin).
import { useSyncExternalStore } from 'react';
import type { PermissionRequestId } from '../../../../shared/properties/ai/chatModel';

export const PERMISSION_ATTENTION_LIMITS = {
  permissionsPendingMax: 16,
} as const satisfies Record<string, number>;

export interface PermissionAttention {
  /** Unanswered requests whose cards are mounted, oldest first. */
  readonly waiting: readonly PermissionRequestId[];
  /** Those among them whose card was reported off screen. A card not yet reported counts as on screen, so the pin never flashes on mount. */
  readonly hidden: ReadonlySet<PermissionRequestId>;
}

let attention: PermissionAttention = { waiting: [], hidden: new Set() };
const listeners = new Set<() => void>();
const elements = new Map<PermissionRequestId, HTMLElement>();

function publish(next: PermissionAttention): void {
  attention = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Marks a card as waiting for an answer; returns the function that clears it. */
export function registerWaiting(request: PermissionRequestId, element: HTMLElement | undefined): () => void {
  if (attention.waiting.includes(request) || attention.waiting.length >= PERMISSION_ATTENTION_LIMITS.permissionsPendingMax) {
    return () => undefined;
  }
  publish({ waiting: [...attention.waiting, request], hidden: attention.hidden });
  if (element !== undefined) {
    elements.set(request, element);
  }
  return () => {
    elements.delete(request);
    publish({
      waiting: attention.waiting.filter((candidate) => candidate !== request),
      hidden: new Set([...attention.hidden].filter((candidate) => candidate !== request)),
    });
  };
}

/** Records that a waiting card came into or left the transcript's view. */
export function setOnScreen(request: PermissionRequestId, visibility: 'visible' | 'hidden'): void {
  const has = attention.hidden.has(request);
  if ((visibility === 'hidden') === has) {
    return;
  }
  const next = new Set(attention.hidden);
  if (visibility === 'hidden') {
    next.add(request);
  } else {
    next.delete(request);
  }
  publish({ waiting: attention.waiting, hidden: next });
}

/** The request the number keys and Esc answer: the oldest one still waiting. */
export function requestInFocus(): PermissionRequestId | undefined {
  return attention.waiting[0];
}

/** Scrolls a waiting request's card into view. */
export function revealRequest(request: PermissionRequestId): void {
  elements.get(request)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function usePermissionAttention(): PermissionAttention {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => attention,
  );
}

/** Forgets every card; a test starts clean. */
export function resetPermissionAttention(): void {
  elements.clear();
  publish({ waiting: [], hidden: new Set() });
}

/**
 * Whether a key press belongs to a text field. The shortcuts answer a request only outside text
 * fields, so a digit typed into the composer is a digit, not an answer. (A card that appears while
 * the composer is empty takes focus itself, so the keys work at once; see PermissionCard.)
 */
export function typesText(target: EventTarget | undefined): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.closest('[contenteditable=""], [contenteditable="true"], .cm-editor') !== null;
}
