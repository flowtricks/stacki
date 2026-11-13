// Rail badges (`app.badge`): a count an app shows while it is not open, such as
// "4 open" comments. Each app has at most one count; the Apps rail button shows
// their sum and each app's row its own. The counts live as long as the editor
// window and the project: an uninstalled app's count is dropped, and closing the
// project drops them all, so a count never outlives the app that set it.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS } from '../../../shared/properties/apps';
import { APP_RPC_LIMITS } from '../../../shared/properties/appsRpc';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { AppBadgeRegistry } from './appRpcHost';

/** The most a badge draws; a larger count reads as this and a plus. */
const BADGE_SHOWN_MAX = 99;

let counts: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

function publish(next: ReadonlyMap<string, number>): void {
  assert(next.size <= APP_LIMITS.appsMax, 'Badges are bounded by the installed apps');
  counts = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** What `app.badge` sets: 0 clears an app's count. */
export const appBadges: AppBadgeRegistry = {
  set: (appId, count) => {
    assert(Number.isSafeInteger(count), 'A badge count is a whole number');
    assert(count >= 0, 'A badge count is not negative');
    assert(count <= APP_RPC_LIMITS.badgeCountMax, 'A badge count is within its bound');
    if ((counts.get(appId) ?? 0) === count) {
      return;
    }
    const next = new Map(counts);
    if (count === 0) {
      next.delete(appId);
    } else {
      // A new app's badge past the bound would mean more apps than a project installs: the parser refused it already.
      assert(next.has(appId) || next.size < APP_LIMITS.appsMax, 'Badges are bounded by the installed apps');
      next.set(appId, count);
    }
    publish(next);
  },
};

/** Keeps only the installed apps' counts: an uninstalled app's badge goes with it. */
export function keepAppBadges(installedIds: readonly string[]): void {
  const installed = new Set(installedIds);
  const next = new Map([...counts].filter(([appId]) => installed.has(appId)));
  if (next.size !== counts.size) {
    publish(next);
  }
  assert(counts.size <= installed.size, 'Only installed apps keep a badge');
}

/** Drops every count: the project closed. */
export function clearAppBadges(): void {
  if (counts.size > 0) {
    publish(new Map());
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One app's count, or the sum of every app's when `appId` is undefined. */
export function useAppBadgeCount(appId: string | undefined): number {
  return useSyncExternalStore(subscribe, () => badgeCount(appId));
}

function badgeCount(appId: string | undefined): number {
  if (appId !== undefined) {
    return counts.get(appId) ?? 0;
  }
  let sum = 0;
  for (const count of counts.values()) {
    sum += count;
  }
  return sum;
}

/** How a badge writes a count: 99+ past 99. */
export function badgeText(count: number): string {
  assert(count > 0, 'Only a count above zero is drawn');
  return count > BADGE_SHOWN_MAX ? `${BADGE_SHOWN_MAX}+` : String(count);
}

/** The count on the Apps rail button: every app's, summed. */
export function AppsRailCount() {
  const translate = useTranslate();
  const count = useAppBadgeCount(undefined);
  if (count === 0) {
    return undefined;
  }
  return (
    <span className="apps-rail-count" role="status" aria-label={translate('apps.badge.waiting', { count })}>
      {badgeText(count)}
    </span>
  );
}

/** The count on an app's row in the Apps panel. */
export function AppRowCount({ appId, name }: { readonly appId: string; readonly name: string }) {
  const translate = useTranslate();
  const count = useAppBadgeCount(appId);
  if (count === 0) {
    return undefined;
  }
  return (
    <span className="apps-row-count" aria-label={translate('apps.badge.rowCount', { name, count })}>
      {badgeText(count)}
    </span>
  );
}
