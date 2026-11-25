// What the Apps platform shows about updates outside the update flow itself:
// which installed apps have an update waiting (for the rail's badge), how a row
// says so ("Update available · v1.2.0"), and each app's Update automatically switch.
//
// The waiting set is the last thing the editor learned: the installed list the
// Apps panel read (which replaces it), or an update check's outcomes (which add
// and remove ids). It holds app ids only, at most one per installed app.
//
// Update automatically is off for every app until an admin turns it on (docs/apps.md,
// "Update policy"): an app is third-party code, so new code runs only after a
// person chose Update or switched this on for that app.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS, type AppAvailableUpdate, type AppSummary, type AppUpdateOutcome } from '../../../shared/properties/apps';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { Switch } from '../../ui/Switch';
import { AppsRailCount } from './appBadges';
import { AppDetailsItem } from './AppDetailsLayout';
import './marketplace/marketplace.css';

let waiting: ReadonlySet<string> = new Set<string>();
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>): void {
  assert(next.size <= APP_LIMITS.appsMax, 'Waiting updates are bounded by the installed apps');
  waiting = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** The installed apps as just read: an app has an update waiting exactly when its lock entry records one and it has a source to update from. */
export function noteInstalledApps(apps: readonly AppSummary[]): void {
  assert(apps.length <= APP_LIMITS.appsMax, 'Installed apps are bounded');
  publish(new Set(apps.filter((app) => appUpdateStatus(app.lock).kind !== 'none').map((app) => app.manifest.id)));
}

/** An update check's outcomes: an available update waits; an installed one, or a current app, no longer does. */
export function noteUpdateOutcomes(outcomes: readonly AppUpdateOutcome[]): void {
  assert(outcomes.length <= APP_LIMITS.appsMax, 'Outcomes are bounded by the installed apps');
  const next = new Set(waiting);
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'available':
        next.add(outcome.id);
        break;
      case 'needs-approval':
        // Held for a person's OK: it waits like any available update.
        next.add(outcome.id);
        break;
      case 'updated':
        next.delete(outcome.id);
        break;
      case 'current':
        next.delete(outcome.id);
        break;
      case 'failed':
        // A failed check says nothing new about what waits.
        break;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
  publish(next);
}

/** How many installed apps have an update waiting right now. */
export function waitingUpdateCount(): number {
  return waiting.size;
}

export function useWaitingUpdateCount(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, waitingUpdateCount);
}

/**
 * What the rail's Apps button carries: the apps' own counts (`app.badge`,
 * appBadges.tsx), and the dot while an update waits. Only an admin sees the dot:
 * only an admin can install an update, so for anyone else it would ask for
 * something they cannot do.
 */
export function AppsRailBadge({ admin }: { readonly admin: boolean }) {
  return (
    <>
      <AppsRailCount />
      {admin && <UpdateDot />}
    </>
  );
}

function UpdateDot() {
  const translate = useTranslate();
  const count = useWaitingUpdateCount();
  if (count === 0) {
    return undefined;
  }
  return <span className="apps-rail-badge" role="status" aria-label={translate('apps.updates.available', { count })} />;
}

/** How a row names a waiting update. */
export function updateAvailableLabel(update: AppAvailableUpdate, translate: Translator): string {
  assert(update.version.length > 0, 'An update names its version');
  return translate('apps.updates.availableVersion', { version: update.version });
}

/**
 * What an installed app's update looks like to the person, decided from its lock entry alone:
 * - `none`: nothing waits, or the app has no source to update from (an uploaded app or one added to
 *   the project folder is the person's own, so it never offers Update).
 * - `available`: a newer version waits; Update installs it.
 * - `needs-approval`: auto-update is on, but the new version asks for more than the installed one did
 *   (new network hosts, sign-in providers or role switches, `additions`). The main process does not
 *   install it by itself; the row says "Update needs your OK" until a person chooses Update.
 */
export type AppUpdateStatus =
  | { readonly kind: 'none' }
  | { readonly kind: 'available'; readonly update: AppAvailableUpdate }
  | { readonly kind: 'needs-approval'; readonly update: AppAvailableUpdate };

export function appUpdateStatus(lock: AppSummary['lock']): AppUpdateStatus {
  if (!appUpdatable(lock.source)) {
    return { kind: 'none' };
  }
  const { update } = lock;
  if (update === undefined) {
    return { kind: 'none' };
  }
  if (lock.autoUpdate) {
    if (update.additions.length > 0) {
      return { kind: 'needs-approval', update };
    }
  }
  return { kind: 'available', update };
}

/** The row's and the details' words for a status: "Update available · v1.2.0" or "Update needs your OK · v1.2.0". */
export function updateStatusLabel(status: Exclude<AppUpdateStatus, { readonly kind: 'none' }>, translate: Translator): string {
  assert(status.update.version.length > 0, 'An update names its version');
  switch (status.kind) {
    case 'available':
      return updateAvailableLabel(status.update, translate);
    case 'needs-approval':
      return translate('apps.updates.needsApproval', { version: status.update.version });
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** The one line under an update that asks for more: what is new in it, or undefined when nothing is. */
export function updateAdditionsNote(update: AppAvailableUpdate, translate: Translator): string | undefined {
  if (update.additions.length === 0) {
    return undefined;
  }
  return translate('apps.updates.additions', { version: update.version, additions: update.additions.join(', ') });
}

/**
 * An app's "Update automatically" row in its details popup's Updates list: a switch for an admin, the
 * state for anyone else. Only an app with a source to update from has it. It is off until an admin
 * turns it on, and its hint says who it is for: new code runs unattended, so only a publisher you trust.
 */
export function AutoUpdateSetting({
  app,
  admin,
  busy,
  onChange,
}: {
  readonly app: AppSummary;
  readonly admin: boolean;
  readonly busy: boolean;
  readonly onChange: (policy: { readonly autoUpdate: boolean }) => void;
}) {
  const translate = useTranslate();
  const { lock } = app;
  if (!appUpdatable(lock.source)) {
    return undefined;
  }
  return (
    <AppDetailsItem label={translate('apps.updates.automatically')} hint={translate('apps.updates.automaticallyHint')}>
      <Switch
        label={translate('apps.updates.automaticallyNamed', { name: app.manifest.name })}
        checked={lock.autoUpdate}
        disabled={!admin || busy}
        onToggle={() => onChange({ autoUpdate: !lock.autoUpdate })}
      />
    </AppDetailsItem>
  );
}

/** Whether an app has somewhere to update from: an uploaded app, or one added to the project folder, has not. */
export function appUpdatable(source: AppSummary['lock']['source']): boolean {
  switch (source.kind) {
    case 'github':
    case 'marketplace':
      return true;
    case 'file':
    case 'local':
      return false;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
