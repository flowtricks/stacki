// Stacki Apps in Desktop's shell: the Apps panel's tab, the host that lives as
// long as the editor (events, update checks, floating windows), and the canvas
// overlay layer with the paths it needs measured. The shared pieces are in
// src/features/apps; this file supplies Desktop's commands, role and avatar.
import { useTranslate } from '../../lib/i18n/useTranslate';
import React, { useEffect, useMemo, useRef } from 'react';
import type { ShellView } from '../App';
import AppsPanel from '../../features/apps/AppsPanel';
import { AppsHost } from '../../features/apps/AppsHost';
import { AppOverlayLayer } from '../../features/apps/AppOverlayLayer';
import { useAppsRuntime, useRefTargetLookup } from '../../features/apps/appsRuntime';
import { setAppsPanelReveal } from '../../features/apps/appsDirectory';
import { overlayAnchorPaths, type MeasuredRects } from '../../features/apps/overlayPlacement';
import CommitAvatar from '../../features/history/CommitAvatar';
import { AddPublishAccount } from '../../features/publishing/PublishAccount';
import { githubLoginAvatar } from '../../../shared/ipc/commitAvatars';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useLiveValue } from '../../ui/liveValue';
import { desktopAppEventState, desktopAppHost, projectRelative } from './desktopAppHost';
import { useCanvasCapture } from '../../features/apps/useCanvasCapture';
import { useMeasureRequests } from '../../features/apps/overlayMeasure';
import { nodeAtPath } from '../../editor/editorTree';
import { trailOf } from '../model/pageGestures';
import type { AppCanvasCursor } from '../../../shared/properties/appsRpc';

/** A GitHub user's picture, the history panel's avatar: the initial shows until it loads, and if it fails. */
export function appAuthorAvatar(login: string | undefined, name: string): React.ReactNode {
  return <CommitAvatar name={login ?? name} email="" url={login === undefined ? undefined : githubLoginAvatar(login)} />;
}

export function AppsTab({ app }: { readonly app: ShellView }) {
  const role = useCurrentRole();
  const projectPath = app.project.path;
  return (
    <AppsPanel
      projectPath={projectPath}
      role={role}
      notify={app.showToast}
      renderAvatar={appAuthorAvatar}
      // The publish flow's GitHub sign-in, reused: the same account lists repositories and reads private releases.
      renderSignIn={(done, cancel) => <AddPublishAccount projectPath={projectPath} provider="github" connected={done} close={cancel} />}
    />
  );
}

export function DesktopAppsHost({ app }: { readonly app: ShellView }) {
  const appRef = useRef(app);
  appRef.current = app;
  const translate = useTranslate();
  const translateRef = useRef(translate);
  translateRef.current = translate;
  const host = useMemo(() => desktopAppHost(appRef, translateRef), []);
  const role = useCurrentRole();
  const hover = useLiveValue(app.hoverNode);
  // An app opened from outside the panel (the command palette) shows in it.
  useEffect(() => {
    setAppsPanelReveal(() => appRef.current.setLeftTab('apps'));
    return () => setAppsPanelReveal(undefined);
  }, []);
  useCanvasCapture({
    nodeIdForPath: (path) => canvasNodeId(appRef.current, path),
    sendCursor: sendCanvasCursor,
    canvasPage: () => canvasPageFile(appRef.current),
  });
  return <AppsHost projectPath={app.project.path} host={host} role={role} state={desktopAppEventState(app, hover)} notify={app.showToast} />;
}

/** The canvas paths app overlays anchor to, and those `node.measure` waits on, for the canvas to measure. */
export function useAppOverlayPaths(app: ShellView): readonly string[] {
  const runtime = useAppsRuntime();
  const measuring = useMeasureRequests();
  const refTarget = useRefTargetLookup();
  return overlayAnchorPaths(runtime.overlays, measuring, refTarget, (nodeId) => app.pathFor(nodeId));
}

// The open file's node under a canvas path: the click's own resolution (AppPanes.tsx selectCanvasPath), without selecting.
function canvasNodeId(app: ShellView, path: string): string | undefined {
  const scope = app.editedRel ? `${app.editedRel}|` : '';
  if (scope !== '' && !path.startsWith(scope)) {
    return undefined; // Markup of another file than the one open.
  }
  const local = path.slice(scope.length);
  if (app.model === undefined || local === '' || local.includes('|')) {
    return undefined;
  }
  return nodeAtPath(app.model.nodes, trailOf(local))?.id;
}

// The page the canvas renders, named exactly as `page.get` names the open page (projectRelative), so an
// app can tell the page's own layer by comparing paths: the stack's page while a component is open
// (App.tsx canvasRouteOf), else the open page itself.
function canvasPageFile(app: ShellView): string | undefined {
  const page = (app.editStack[0] ?? app.currentPage)?.path;
  return page === undefined ? undefined : projectRelative(app.project.path, page);
}

// The cursor the canvas frame shows while an app captures its clicks (electron/preload/frameAppCursor.ts).
function sendCanvasCursor(cursor: AppCanvasCursor | undefined): void {
  const frame = document.querySelector<HTMLIFrameElement>('.frame-clip iframe')?.contentWindow ?? undefined;
  frame?.postMessage({ type: 'avb:app-cursor', cursor: cursor ?? 'none' }, '*');
}

/** What PreviewPane draws above its outlines. */
export function appOverlayLayer(app: ShellView): (frame: { readonly rects: MeasuredRects; readonly scale: number }) => React.ReactNode {
  return function AppOverlays(frame) {
    return <AppOverlayLayer rects={frame.rects} scale={frame.scale} pathFor={(nodeId) => app.pathFor(nodeId)} />;
  };
}
