// A read-only list of the installed apps a role may use, for lists outside the
// Apps panel (the command palette). Each entry carries what a row needs and an
// `open` that launches the app as the panel's Launch button does. The host
// (Desktop's shell, Studio's editor) registers how to reveal the Apps panel, so
// a panel app opened from elsewhere is shown, not started out of sight.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { can, type RoleView } from '../../../shared/properties/projectRoles';
import { APP_LIMITS, appAuthorLogin, type AppsResult } from '../../../shared/properties/apps';
import { githubLoginAvatar } from '../../../shared/ipc/commitAvatars';
import { appAccessFeature } from '../../../shared/properties/appsRpc';
import { listApps } from '../../ipc/appsBridge';
import { appIconURL, appTileColor, appTileInitial } from './AppTile';
import { launchApp } from './appsRuntime';
import { appOpeningMode } from './appWindowPreferences';
import { setAppDetailsReveal } from './appDetailsRequests';

export interface AppDirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** The app's own icon, or undefined: draw `initial` on `color` instead. */
  readonly iconURL: string | undefined;
  readonly initial: string;
  readonly color: string;
  readonly hasUpdate: boolean;
  /** Who made it: the manifest's `author.github`, else its GitHub repository's owner. */
  readonly authorLogin: string | undefined;
  /** That person's GitHub picture, on GitHub's own avatar host. */
  readonly authorAvatarURL: string | undefined;
  /** Launches the app, revealing the Apps panel when the app shows there. */
  readonly open: () => void;
}

let revealPanel: (() => void) | undefined;

/** What another surface (the command palette) asks the Apps panel to start. */
export type AppsPanelRequest = 'connect' | 'marketplace';

let pendingRequest: { readonly kind: AppsPanelRequest; readonly serial: number } | undefined;
let requestSerial = 0;
const requestListeners = new Set<() => void>();

function request(kind: AppsPanelRequest): void {
  requestSerial += 1;
  pendingRequest = { kind, serial: requestSerial };
  revealPanel?.();
  for (const listener of [...requestListeners]) {
    listener();
  }
}

/** Opens the Apps panel's "Load App From GitHub" popup, revealing the panel. */
export function requestAppConnect(): void {
  request('connect');
}

/** Opens the Apps panel's Marketplace tab, revealing the panel (marketplace/marketplaceRequests.ts names the app). */
export function requestAppMarketplace(): void {
  request('marketplace');
}

/** The Apps panel's side: the request waiting for it, and how to mark it handled. */
export function useAppsPanelRequest(): { readonly request: AppsPanelRequest | undefined; readonly handled: () => void } {
  const current = useSyncExternalStore(
    (listener) => {
      requestListeners.add(listener);
      return () => {
        requestListeners.delete(listener);
      };
    },
    () => pendingRequest,
  );
  return {
    request: current?.kind,
    handled: () => {
      if (pendingRequest?.serial === current?.serial) {
        pendingRequest = undefined;
        for (const listener of [...requestListeners]) {
          listener();
        }
      }
    },
  };
}

/** Shows the Apps panel, where a docked app draws; nothing when no host registered how. */
export function revealAppsPanel(): void {
  revealPanel?.();
}

/** The host's way to show the Apps panel; `undefined` when it unmounts. */
export function setAppsPanelReveal(reveal: (() => void) | undefined): void {
  revealPanel = reveal;
  // An app opening its own details reveals the panel the same way.
  setAppDetailsReveal(reveal);
}

/** The installed apps `role` may use, in lockfile order. */
export async function listAppDirectory(projectPath: string, role: RoleView): Promise<AppsResult<readonly AppDirectoryEntry[]>> {
  const answer = await listApps(projectPath);
  if (!answer.ok) {
    return answer;
  }
  const entries = answer.value
    .filter((app) => can(role, appAccessFeature(app.manifest.id)))
    .map((app): AppDirectoryEntry => ({
      id: app.manifest.id,
      name: app.manifest.name,
      description: app.manifest.description,
      version: app.manifest.version,
      iconURL: appIconURL(app.manifest),
      initial: appTileInitial(app.manifest.name),
      color: appTileColor(app.manifest.id),
      hasUpdate: app.lock.update !== undefined,
      authorLogin: appAuthorLogin(app),
      authorAvatarURL: authorAvatar(appAuthorLogin(app)),
      open: () => {
        if (launchApp(app, appOpeningMode(projectPath, app)) === 'panel') {
          revealPanel?.();
        }
      },
    }));
  assert(entries.length <= APP_LIMITS.appsMax, 'The directory is bounded by the installed apps');
  return { ok: true, value: entries };
}

function authorAvatar(login: string | undefined): string | undefined {
  return login === undefined ? undefined : githubLoginAvatar(login);
}
