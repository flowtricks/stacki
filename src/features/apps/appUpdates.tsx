// What the Apps platform shows about updates outside the update flow itself:
// which installed apps have an update waiting (for the rail's badge), how a row
// says so ("Update available · v1.2.0"), and each app's Auto-update switch.
//
// The waiting set is the last thing the editor learned: the installed list the
// Apps panel read (which replaces it), or an update check's outcomes (which add
// and remove ids). It holds app ids only, at most one per installed app.
//
// Auto-update is off for every app until an admin turns it on (docs/apps.md,
// "Update policy"): an app is third-party code, so new code runs only after a
// person chose Update or switched this on for that app.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS, type AppAvailableUpdate, type AppSummary, type AppUpdateOutcome } from '../../../shared/properties/apps';
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

/** The installed apps as just read: an app has an update waiting exactly when its lock entry records one. */
export function noteInstalledApps(apps: readonly AppSummary[]): void {
  assert(apps.length <= APP_LIMITS.appsMax, 'Installed apps are bounded');
  publish(new Set(apps.filter((app) => app.lock.update !== undefined).map((app) => app.manifest.id)));
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

export function useWaitingUpdateCount(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => waiting.size,
  );
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
  const count = useWaitingUpdateCount();
  if (count === 0) {
    return undefined;
  }
  return <span className="apps-rail-badge" role="status" aria-label={count === 1 ? 'An app update is available' : `${count} app updates are available`} />;
}

/** How a row names a waiting update. */
export function updateAvailableLabel(update: AppAvailableUpdate): string {
  assert(update.version.length > 0, 'An update names its version');
  return `Update available · v${update.version}`;
}

/**
 * An app's Auto-update row in its details popup's Updates list (a list item): a
 * switch for an admin, the state for anyone else; what it does is in its hint.
 * An uploaded app has no source to update from, so it has none.
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
  const { lock } = app;
  if (!appUpdatable(lock.source)) {
    return undefined;
  }
  const note =
    lock.source.kind === 'marketplace'
      ? 'Installs new versions the Stacki marketplace approves, when each is checked.'
      : 'Installs each new GitHub release of this app, when it is checked.';
  return (
    <AppDetailsItem label="Auto-update" hint={lock.autoUpdate ? note : 'Off: updates wait for you to choose Update.'}>
      <Switch
        label={`Auto-update ${app.manifest.name}`}
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
