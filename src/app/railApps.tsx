// Apps a role pins to the left rail (`pinnedApps` in `.stacki/roles.json`,
// shared/properties/projectRoles.ts), for both rails: Desktop's LeftRail.tsx and
// Studio's EditorRail.tsx. A pinned app is its own rail button, drawn with its
// tile (AppTile.tsx) and its `app.badge` count, below the built-in panels.
// Clicking it opens the app as the Apps panel's Launch button does, in the mode
// the person last chose (appWindowPreferences.ts); a docked app shows in the Apps
// panel, which the click reveals.
//
// The rail shows a pin only while the app is installed and the role may use it
// (`app:<id>` or `app:*`, with `panel:apps`); other pins stay in the file, ignored.
import { useTranslate } from '../lib/i18n/useTranslate';
import { useEffect, useState } from 'react';
import { assert } from '../../shared/core/assert';
import { APP_LIMITS, type AppSummary } from '../../shared/properties/apps';
import { appAccessFeature } from '../../shared/properties/appsRpc';
import { ROLE_LIMITS, can, type RoleView } from '../../shared/properties/projectRoles';
import { listApps } from '../ipc/appsBridge';
import { badgeText, useAppBadgeCount } from '../features/apps/appBadges';
import { AppTile } from '../features/apps/AppTile';
import { useAppsRefresh } from '../features/apps/appsRefresh';
import { launchApp, useAppsRuntime } from '../features/apps/appsRuntime';
import { revealAppsPanel } from '../features/apps/appsDirectory';
import { appOpeningMode, shownDockedApp } from '../features/apps/appWindowPreferences';

/** A rail id for a pinned app, distinct from every panel id. */
export function railAppId(appId: string): string {
  assert(appId.length > 0, 'A pinned app has an id');
  return `app:${appId}`;
}

/** The pinned apps `role` sees on the rail: installed, usable, in the order they were pinned. */
export function pinnedRailApps(role: RoleView, installed: readonly AppSummary[]): readonly AppSummary[] {
  assert(role.pinnedApps.length <= ROLE_LIMITS.pinnedAppsMax, 'Pins are bounded by the roles parser');
  assert(installed.length <= APP_LIMITS.appsMax, 'Installed apps are bounded');
  const apps: AppSummary[] = [];
  for (const appId of role.pinnedApps) {
    const app = installed.find((candidate) => candidate.manifest.id === appId);
    if (app !== undefined && can(role, appAccessFeature(appId))) {
      apps.push(app);
    }
  }
  assert(apps.length <= role.pinnedApps.length, 'The rail never shows more apps than were pinned');
  return apps;
}

/**
 * The installed apps, read while `role` pins any: again when the project, the pins
 * or the installed apps change (appsRefresh.ts), and whenever `reread` changes; the
 * rail passes its open panel, so an app installed in the Apps panel appears once
 * the person moves on. Nothing is read for a role with no pins.
 */
export function usePinnedRailApps(projectPath: string | undefined, role: RoleView, reread: string | undefined): readonly AppSummary[] {
  const [installed, setInstalled] = useState<{ readonly projectPath: string; readonly apps: readonly AppSummary[] } | undefined>(undefined);
  const refreshTick = useAppsRefresh();
  const pins = role.pinnedApps.join(' ');
  useEffect(() => {
    if (projectPath === undefined || pins.length === 0) {
      return undefined;
    }
    let lifetime: 'active' | 'disposed' = 'active';
    const settle = (apps: readonly AppSummary[]) => {
      if (lifetime === 'active') {
        setInstalled({ projectPath, apps });
      }
    };
    // A failed read shows no pinned apps; the Apps panel says why.
    void listApps(projectPath).then(
      (answer) => settle(answer.ok ? answer.value : []),
      () => settle([]),
    );
    return () => {
      lifetime = 'disposed';
    };
  }, [projectPath, pins, refreshTick, reread]);
  if (installed === undefined || installed.projectPath !== projectPath) {
    return [];
  }
  return pinnedRailApps(role, installed.apps);
}

/** The app the open Apps panel shows docked, whose pinned button reads as the active one. */
export function useShownPinnedApp(role: RoleView, appsOpen: 'open' | 'closed'): string | undefined {
  const runtime = useAppsRuntime();
  if (appsOpen === 'closed') {
    return undefined;
  }
  return shownDockedApp(runtime.running, role)?.app.manifest.id;
}

/** Opens a pinned app in its remembered mode; a docked one shows in the Apps panel, which is revealed. */
export function openPinnedApp(projectPath: string, app: AppSummary): void {
  assert(projectPath.length > 0, 'A pinned app opens in a project');
  const mode = launchApp(app, appOpeningMode(projectPath, app));
  if (mode === 'panel') {
    revealAppsPanel();
  }
}

/** A pinned app's rail face: its tile, and its `app.badge` count in the corner. */
export function RailAppFace({ app }: { readonly app: AppSummary }) {
  return (
    <>
      <AppTile manifest={app.manifest} size={20} />
      <RailAppCount appId={app.manifest.id} name={app.manifest.name} />
    </>
  );
}

function RailAppCount({ appId, name }: { readonly appId: string; readonly name: string }) {
  const count = useAppBadgeCount(appId);
  const translate = useTranslate();
  if (count === 0) {
    return undefined;
  }
  return (
    <span className="apps-rail-count" role="status" aria-label={translate('rail.appWaiting', { name, count })}>
      {badgeText(count)}
    </span>
  );
}
