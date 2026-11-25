// The part of the Apps platform that lives as long as the editor, whichever
// panel is open: it hands the runtime the host's commands and role, turns the
// editor's state into app events (selection, hover, canvas, panels, page,
// role) and the project's existing change streams into `project.change`,
// checks GitHub and marketplace apps for updates (each installs by itself only
// when an admin switched on that app's auto-update; appUpdates.tsx), and draws every app's window, docked or
// popped out (AppWindows.tsx), so an app keeps running across both. Desktop's
// shell and Studio's editor each mount one with their own commands.
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { RoleView } from '../../../shared/properties/projectRoles';
import { APP_RPC_LIMITS, type AppChangeSource, type AppEventData } from '../../../shared/properties/appsRpc';
import { checkAppUpdates, listApps } from '../../ipc/appsBridge';
import { shortcutOfPress } from '../../../shared/properties/appShortcuts';
import { configureAppCommands, runShortcutCommand } from './appCommands';
import { isShortcutRecorderTarget } from '../../ui/ShortcutRecorder';
import { cmsTransport, onPropertyFilesChanged, onVariablesChanged } from '../../ipc/editorEnvironment';
import { onAssetEntriesChanged } from '../../ipc/assetBridge';
import { AppWindows } from './AppWindows';
import { bumpAppsRefresh, useAppsRefresh } from './appsRefresh';
import {
  appOverrideSlot,
  configureAppsRuntime,
  emitAppEvent,
  emitProjectChange,
  emitRoleChange,
  emitToApp,
  noteLeftPanel,
  nodeRefTargets,
  outlineModeOwner,
  overridesChanged,
  stopAllApps,
  stopApp,
} from './appsRuntime';
import { clearAppBadges, keepAppBadges } from './appBadges';
import { setAppOverrideSlot } from '../../ui/appOverrideSlot';
import { noteUpdateOutcomes } from './appUpdates';
import { useAppFolderChanges } from './appFolderChanges';
import type { AppHostCommands } from './appRpcHost';
import { watchAppTheme } from './appTheme';
import './apps.css';

/** How long after a page edit node refs are read again: the canvas re-renders the edit within about this. */
const REF_REFRESH_DELAY_MS = 600;

/** Automatic update checks: on open, then this often while the project stays open. */
export const APP_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;

/** The editor state apps hear about, as of this render. */
export interface AppEventState {
  readonly selection: string | undefined;
  readonly hover: string | undefined;
  readonly viewport: AppEventData['canvas.change'];
  readonly panels: AppEventData['panels.change'];
  readonly pagePath: string | undefined;
  /** Changes whenever the open page's source changes (a checksum or the text's length and a counter). */
  readonly pageVersion: string | undefined;
}

export function AppsHost({
  projectPath,
  host,
  role,
  state,
  notify,
}: {
  readonly projectPath: string;
  readonly host: AppHostCommands;
  readonly role: RoleView;
  readonly state: AppEventState;
  readonly notify: (message: string, kind: 'info' | 'success' | 'error') => void;
}) {
  const roleRef = useRef(role);
  roleRef.current = role;
  configureAppsRuntime(host, () => roleRef.current);
  useEffect(
    () => () => {
      stopAllApps();
      clearAppBadges();
    },
    [projectPath],
  );
  // Stacki's pickers ask running apps first while the editor is open (docs/apps.md, "Overrides").
  useEffect(() => {
    setAppOverrideSlot(appOverrideSlot);
    return () => setAppOverrideSlot(undefined);
  }, []);
  // A role change can give or take a point's owner: the "via" indicators follow.
  useEffect(() => overridesChanged(), [role]);
  useStateEvents(state, role, projectPath);
  useProjectChangeEvents(projectPath);
  useStorageEvents(host);
  usePersonEvents(host);
  useAuthEvents(host);
  useThemeEvents();
  useUpdateChecks(projectPath, role, notify);
  // `.stacki/apps/` changed: the lists read again, running apps reload or stop (appFolderChanges.ts).
  useAppFolderChanges(projectPath);
  useAppCommandKeys(projectPath, roleRef);
  return <AppWindows projectPath={projectPath} role={role} />;
}

// Each state change is an event, sent once, after the render that made it.
function useStateEvents(state: AppEventState, role: RoleView, projectPath: string): void {
  useEffect(() => emitAppEvent('selection.change', { nodeId: state.selection }), [state.selection]);
  useEffect(() => emitAppEvent('hover.change', { nodeId: state.hover }), [state.hover]);
  const { widthPx, heightPx, scale, device } = state.viewport;
  useEffect(() => emitAppEvent('canvas.change', { widthPx, heightPx, scale, device }), [widthPx, heightPx, scale, device]);
  const { left, right } = state.panels;
  useEffect(() => emitAppEvent('panels.change', { left, right }), [left, right]);
  useEffect(() => emitAppEvent('page.change', { path: state.pagePath }), [state.pagePath]);
  // The page that changed is named when its version moves, and only then: opening another page is `page.change`.
  const changedPage = state.pagePath === undefined ? undefined : projectRelativePath(projectPath, state.pagePath);
  const changedPageRef = useRef(changedPage);
  changedPageRef.current = changedPage;
  useEffect(() => {
    if (state.pageVersion !== undefined) {
      const page = changedPageRef.current;
      emitProjectChange('page', page === undefined ? [] : [page]);
    }
  }, [state.pageVersion]);
  // Deep outlines are for the Apps panel: opening another rail panel puts the canvas back to normal.
  useEffect(() => {
    noteLeftPanel(state.panels.left);
  }, [state.panels.left]);
  // And so does closing the project, or the editor (outlineModeOwner.ts).
  useEffect(() => () => void outlineModeOwner.reset('project'), [projectPath]);
  // Overlay anchors on node refs follow the page: read again now, and once more after the canvas has
  // re-rendered the edit, which lands a moment after the model (nodeRefs.ts NodeRefTargets).
  useEffect(() => {
    nodeRefTargets.refresh();
    const later = setTimeout(() => nodeRefTargets.refresh(), REF_REFRESH_DELAY_MS);
    return () => clearTimeout(later);
  }, [state.pageVersion, state.pagePath]);
  // Each app hears its own permissions, so the event is built per frame (emitRoleChange); `role` is the trigger.
  useEffect(() => emitRoleChange(), [role]);
}

// App commands (appCommands.ts): the installed apps' commands, read again whenever
// the installed apps change, and their reserved keys heard wherever focus is in
// the editor's own document. Capture, so a panel's own key handler cannot take a
// reserved key first; no Stacki shortcut is in the range (appShortcuts.test.ts).
function useAppCommandKeys(projectPath: string, roleRef: MutableRefObject<RoleView>): void {
  const refreshTick = useAppsRefresh();
  useEffect(() => {
    let current = true;
    void listApps(projectPath).then(
      (answer) => {
        if (current) {
          configureAppCommands(projectPath, answer.ok ? answer.value : [], () => roleRef.current);
          if (answer.ok) {
            keepAppBadges(answer.value.map((app) => app.manifest.id));
          }
        }
      },
      () => {
        if (current) {
          configureAppCommands(projectPath, [], () => roleRef.current);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [projectPath, refreshTick, roleRef]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // A key being recorded as a shortcut is the recorder's, not the command that holds it now.
      if (isShortcutRecorderTarget(event.target)) {
        return;
      }
      const shortcut = shortcutOfPress(event);
      if (shortcut !== undefined && runShortcutCommand(shortcut)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);
}

// The project's own change streams, the ones the panels already refresh from.
// Only the file stream names its files; the others say what kind moved.
function useProjectChangeEvents(projectPath: string): void {
  useEffect(() => {
    const emit = (source: AppChangeSource) => () => emitProjectChange(source, []);
    const stops = [
      cmsTransport.onCmsChanged(emit('cms')),
      onVariablesChanged(emit('styles')),
      onAssetEntriesChanged(emit('assets')),
      onPropertyFilesChanged((event) => {
        const paths: string[] = [];
        for (const file of event.files.slice(0, APP_RPC_LIMITS.changePathsMax + 1)) {
          const relative = projectRelativePath(projectPath, file);
          if (relative !== undefined) {
            paths.push(relative);
          }
        }
        emitProjectChange('files', paths);
      }),
    ];
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  }, [projectPath]);
}

/**
 * A changed file as apps name it: relative to the project, `/`-separated.
 * Undefined for a path outside the project; a path that is already relative
 * (Studio's) is kept.
 */
export function projectRelativePath(projectPath: string, file: string): string | undefined {
  const normalized = file.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  if (!absolute) {
    return normalized.replace(/^\.\//, '');
  }
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : undefined;
}

// Stored values (`storage.change`): each change reaches only the app it belongs
// to, as its own (`self`) when this window wrote it, else from elsewhere.
function useStorageEvents(host: AppHostCommands): void {
  useEffect(
    () =>
      host.storage.watch((change) => {
        const origin = change.writer === host.storage.writer ? 'self' : 'other';
        if (change.keys === undefined) {
          emitToApp(change.appId, 'storage.change', { key: undefined, scope: change.scope, origin });
          return;
        }
        for (const key of change.keys) {
          emitToApp(change.appId, 'storage.change', { key, scope: change.scope, origin });
        }
      }),
    [host],
  );
}

// The editor's theme changed: apps hear what `ui.theme` now answers, and the UI kit's script follows it (appTheme.ts).
function useThemeEvents(): void {
  useEffect(() => watchAppTheme((view) => emitAppEvent('theme.change', view)), []);
}

// The person hid or showed their details: apps hear what `person.get` now answers.
// A sign-in changed (`auth.change`): the app it belongs to hears each of its providers' status now.
function useAuthEvents(host: AppHostCommands): void {
  useEffect(() => {
    const auth = host.auth;
    if (auth === undefined) {
      return undefined;
    }
    return auth.watch((appId) => {
      void auth.status(appId).then(
        (answer) => {
          if (answer.ok) {
            for (const status of answer.value) {
              emitToApp(appId, 'auth.change', status);
            }
          }
        },
        () => undefined, // A status that cannot be read now is read again by the app's next auth.status.
      );
    });
  }, [host]);
}

function usePersonEvents(host: AppHostCommands): void {
  useEffect(
    () =>
      host.onPersonChange(() => {
        void host.person().then(
          (person) => emitAppEvent('person.change', person),
          () => undefined, // A person that cannot be read now is read again on the next change or request.
        );
      }),
    [host],
  );
}

function useUpdateChecks(projectPath: string, role: RoleView, notify: (message: string, kind: 'info' | 'success' | 'error') => void): void {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const adminRef = useRef(role.isAdmin);
  adminRef.current = role.isAdmin;
  useEffect(() => {
    let active = true;
    const check = async (): Promise<void> => {
      try {
        const answer = await checkAppUpdates(projectPath, { force: false });
        if (!active || !answer.ok) {
          return;
        }
        noteUpdateOutcomes(answer.value);
        const available = answer.value.filter((outcome) => outcome.kind === 'available');
        const held = answer.value.filter((outcome) => outcome.kind === 'needs-approval');
        const updated = answer.value.filter((outcome) => outcome.kind === 'updated');
        // An auto-updated app restarts closed, so its next open runs the new version.
        for (const outcome of updated) {
          stopApp(outcome.id);
        }
        if (available.length + held.length + updated.length > 0) {
          bumpAppsRefresh();
        }
        if (updated.length > 0) {
          notifyRef.current(
            updated.length === 1 ? 'An app updated itself (auto-update is on).' : `${updated.length} apps updated themselves (auto-update is on).`,
            'info',
          );
        }
        // Auto-update is on for these, but the new version asks for more than the installed one did: only a person's OK installs it.
        if (adminRef.current && held.length > 0) {
          notifyRef.current(
            held.length === 1 ? 'An app update needs your OK in the Apps panel.' : `${held.length} app updates need your OK in the Apps panel.`,
            'info',
          );
        }
        if (adminRef.current && available.length > 0) {
          notifyRef.current(
            available.length === 1 ? 'An app update is available in the Apps panel.' : `${available.length} app updates are available in the Apps panel.`,
            'info',
          );
        }
      } catch {
        // A host without Apps (an older main process) has nothing to check; the panel says so.
      }
    };
    void check();
    const timer = setInterval(() => void check(), APP_UPDATE_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectPath]);
}
