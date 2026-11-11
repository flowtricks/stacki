// Every running app's window, docked in the side panel or popped out over the
// canvas: the Variables window (src/ui/DockableWindow.tsx), with its toggle,
// drag, resize handles and stored rectangle. AppsHost mounts this layer for as
// long as the editor, so the frames live here and never change parent: docking,
// popping out and switching rail panels only restyle a frame, and an iframe that
// is not moved is not reloaded. The app keeps running with its state.
//
// A docked window is positioned over the slot the Apps panel reserves
// (`AppDockSlot`); with no slot (another rail panel is open) it hides and keeps
// running. While the shown docked app holds the panel, its width (the user's
// resize, else the manifest's `window.width`) is requested through the same width
// store the panel's resize handle uses, and released when it docks away, closes
// or the panel changes, which restores the user's own width.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { appPopupSize, type AppSummary } from '../../../shared/properties/apps';
import type { RoleView } from '../../../shared/properties/projectRoles';
import DockableWindow, { type WindowMode } from '../../ui/DockableWindow';
import { CloseIcon } from '../../ui/Icons';
import { requestPanelWidth } from '../../ui/panelWidthRequests';
import { AppCustomFrames } from './AppCustomFrames';
import { AppFrame } from './AppFrame';
import { appFolderErrorNotice } from './appFolderChanges';
import { AppSetupGate } from './AppSettings';
import { AppTile } from './AppTile';
import { revealAppsPanel } from './appsDirectory';
import { appIdOfFrame, outlineModeOwner, setAppMode, stopApp, useAppsRuntime, type RunningApp } from './appsRuntime';
import {
  APP_WINDOW_MINIMUM_SIZE,
  appModeOf,
  appPanelWidth,
  appWindowStorageKey,
  dockModeOf,
  setAppDockSlot,
  shownDockedApp,
  storeAppPanelWidth,
  storeAppWindowMode,
  useAppDockSlot,
} from './appWindowPreferences';

/** The Apps panel's place for the docked app: an empty element the docked window covers. */
export function AppDockSlot() {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = slot.current ?? undefined;
    assert(element !== undefined, 'The dock slot is mounted before its layout effect');
    setAppDockSlot(element);
    return () => setAppDockSlot(undefined);
  }, []);
  return <div ref={slot} className="apps-panel apps-dock-slot" />;
}

export function AppWindows({ projectPath, role }: { readonly projectPath: string; readonly role: RoleView }) {
  const runtime = useAppsRuntime();
  const slot = useAppDockSlot();
  const layer = useRef<HTMLDivElement>(null);
  const shown = slot === undefined ? undefined : shownDockedApp(runtime.running, role);
  useDockBox(slot, layer);
  useDockedPanelWidth(projectPath, shown?.app);
  useOutlineRestore(shown?.app.manifest.id);
  return (
    <div ref={layer} className="apps-windows">
      {runtime.running.map((running) => (
        <AppWindow key={running.app.manifest.id} projectPath={projectPath} running={running} hidden={running !== shown} />
      ))}
      <AppCustomFrames />
    </div>
  );
}

/**
 * Gives an app back the deep outlines it last asked for when the person comes back to it
 * (outlineModeOwner.ts): its docked window shown in the Apps panel again, or focus moving into
 * one of its frames (a popup clicked, a docked app clicked).
 */
function useOutlineRestore(shownAppId: string | undefined): void {
  useEffect(() => {
    if (shownAppId !== undefined) {
      outlineModeOwner.restore(shownAppId);
    }
  }, [shownAppId]);
  useEffect(() => {
    // A click into a frame takes focus from the editor's window; the frame is then the active element.
    const onBlur = (): void => {
      const active = document.activeElement;
      const source = active instanceof HTMLIFrameElement ? (active.contentWindow ?? undefined) : undefined;
      const appId = source === undefined ? undefined : appIdOfFrame(source);
      if (appId !== undefined) {
        outlineModeOwner.restore(appId);
      }
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);
}

function AppWindow({ projectPath, running, hidden }: { readonly projectPath: string; readonly running: RunningApp; readonly hidden: boolean }) {
  const { app } = running;
  const size = appPopupSize(app.manifest.window);
  const changeMode = (next: WindowMode): void => {
    const mode = appModeOf(next);
    if (!setAppMode(app.manifest.id, mode)) {
      return;
    }
    storeAppWindowMode(projectPath, app.manifest.id, mode);
    // Docking shows the app where it now lives, as Variables opens its panel on dock.
    if (mode === 'panel') {
      revealAppsPanel();
    }
  };
  return (
    <DockableWindow
      mode={dockModeOf(running.mode)}
      onModeChange={changeMode}
      label={app.manifest.name}
      className="apps-window"
      hidden={hidden}
      minimumSize={APP_WINDOW_MINIMUM_SIZE}
      initialSize={{ width: size.widthPx, height: size.heightPx }}
      storageKey={appWindowStorageKey(projectPath, app.manifest.id)}
      header={<AppWindowHeader app={app} />}
      trailing={<AppWindowClose app={app} />}
    >
      {running.folderError !== undefined && (
        // Non-blocking: the last good version keeps running below it until the folder reads as valid again.
        <p className="apps-folder-error" role="status">
          {appFolderErrorNotice(running.folderError)}
        </p>
      )}
      <AppSetupGate projectPath={projectPath} app={app}>
        <AppFrame app={app} title={app.manifest.name} className="apps-frame" />
      </AppSetupGate>
    </DockableWindow>
  );
}

// The app's tile and name; the window adds the dock toggle after it, and the
// close button (AppWindowClose) ends the header at the far right.
function AppWindowHeader({ app }: { readonly app: AppSummary }) {
  return (
    <span className="apps-running-title">
      <AppTile manifest={app.manifest} size={18} />
      <h2>{app.manifest.name}</h2>
    </span>
  );
}

function AppWindowClose({ app }: { readonly app: AppSummary }) {
  return (
    <button
      type="button"
      className="ghost apps-icon-button"
      onClick={() => stopApp(app.manifest.id)}
      title="Close app"
      aria-label={`Close ${app.manifest.name}`}
    >
      <CloseIcon size={13} />
    </button>
  );
}

interface DockBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

// The slot's rectangle, as custom properties on the layer the docked windows read.
// The layer is `display: contents`, so it adds no box and no stacking context.
function useDockBox(slot: HTMLElement | undefined, layer: React.RefObject<HTMLDivElement>): void {
  const [box, setBox] = useState<DockBox | undefined>(undefined);
  useLayoutEffect(() => {
    if (slot === undefined) {
      setBox(undefined);
      return undefined;
    }
    const measure = (): void => {
      const rectangle = slot.getBoundingClientRect();
      setBox({ left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height });
    };
    measure();
    window.addEventListener('resize', measure);
    // JSDOM and older hosts have no ResizeObserver; the window's own resize still applies.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(slot);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [slot]);
  useLayoutEffect(() => {
    const element = layer.current;
    if (element === null) {
      return;
    }
    if (box === undefined) {
      return;
    }
    element.style.setProperty('--apps-dock-left', `${box.left}px`);
    element.style.setProperty('--apps-dock-top', `${box.top}px`);
    element.style.setProperty('--apps-dock-width', `${box.width}px`);
    element.style.setProperty('--apps-dock-height', `${box.height}px`);
  }, [box, layer]);
}

/** Holds the docked app's panel width while it shows; the release restores the user's width. */
export function useDockedPanelWidth(projectPath: string, app: AppSummary | undefined): void {
  useEffect(() => {
    if (app === undefined) {
      return undefined;
    }
    const widthPx = appPanelWidth(projectPath, app);
    if (widthPx === undefined) {
      return undefined; // No manifest width and no resize yet: the panel keeps the user's width.
    }
    const appId = app.manifest.id;
    return requestPanelWidth('left', { widthPx, onResize: (resized) => storeAppPanelWidth(projectPath, appId, resized) });
  }, [projectPath, app]);
}
