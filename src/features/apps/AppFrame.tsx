// One app document in a sandboxed frame: the app's panel UI, its floating
// window, or one of its overlay frames. No `allow-same-origin`, so the frame's
// origin is opaque whatever address it loads from: it can reach none of
// Stacki's storage, cookies or DOM, and talks to Stacki only through the RPC.
// The host also serves each document under a content security policy with the
// same sandbox (shared/properties/appSdk.ts), so even opened on its own it is
// never Stacki's origin.
import { useEffect, useRef } from 'react';
import type { AppSummary } from '../../../shared/properties/apps';
import type { AppFrameInfo } from '../../../shared/properties/appsRpc';
import { APP_FRAME_SURFACE } from '../../../shared/properties/appUiKit';
import { appFrameURL } from '../../ipc/appsBridge';
import { appFrameReloaded, attachAppFrame } from './appsRuntime';
import { useAppFileRevision } from './appFileRevisions';

/** What an app frame may do. Never `allow-same-origin`, `allow-top-navigation` or `allow-popups-to-escape-sandbox`. */
export const APP_FRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

export function AppFrame({
  app,
  path,
  title,
  className,
  interactive = true,
  frame,
  overlayItem,
}: {
  readonly app: AppSummary;
  /** A bundle file; the manifest's entry when absent. */
  readonly path?: string;
  readonly title: string;
  readonly className?: string;
  /** False lets pointer events pass through to what is below (an overlay frame that only draws). */
  readonly interactive?: boolean;
  /** A custom frame's id and data, which `app.info` tells the document inside. */
  readonly frame?: AppFrameInfo;
  /** The overlay `frame` item this frame draws, so `overlay.post` messages for it reach it. */
  readonly overlayItem?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  useEffect(() => {
    const target = frameRef.current?.contentWindow ?? undefined;
    if (target === undefined) {
      return undefined;
    }
    // The frame's WindowProxy stays the same across its own loads, so one attach covers them.
    return attachAppFrame(target, app, frame, overlayItem);
  }, [app, frame, overlayItem]);
  // The app's files changed on disk (appFolderChanges.ts): load the document again. Setting
  // `src` navigates even to the same address, and the load that follows is heard as a reload.
  const revision = useAppFileRevision(app.manifest.id);
  const shownRevision = useRef(revision);
  useEffect(() => {
    if (revision === shownRevision.current) {
      return;
    }
    shownRevision.current = revision;
    const element = frameRef.current ?? undefined;
    if (element !== undefined) {
      element.src = appFrameURL(app.manifest.id, path ?? app.manifest.entry);
    }
  }, [revision, app, path]);
  // A load after the first is a new document in the same window: what the old one registered went with it.
  // The first load is not: the SDK may have registered before it fires.
  const loaded = (): void => {
    loads.current += 1;
    const target = frameRef.current?.contentWindow ?? undefined;
    if (loads.current > 1 && target !== undefined) {
      appFrameReloaded(target);
    }
  };
  return (
    <iframe
      ref={frameRef}
      className={className}
      title={title}
      src={appFrameURL(app.manifest.id, path ?? app.manifest.entry)}
      sandbox={APP_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      allow=""
      // Transparent outside what the app paints (appUiKit.ts APP_FRAME_SURFACE): overlay `frame` items rely on it.
      style={{ ...APP_FRAME_SURFACE, pointerEvents: interactive ? undefined : 'none' }}
      onLoad={loaded}
    />
  );
}
