// An app's custom frames (`ui.openFrame`, docs/apps.md "Custom frames"): one of
// its own pages in a modal over the editor or a popup beside it, for UI a docked
// window has no room for, such as an image picker an override opens. Each is the
// shared Popup (the asset pop-up's surface), with the app's name and a close
// button Stacki draws, so a frame cannot pass itself off as Stacki's own dialog;
// inside is an AppFrame with the app's sandbox and nothing more. Closing it here
// tells the opener `frame.close` with no result.
import { useMemo } from 'react';
import type { AppSummary } from '../../../shared/properties/apps';
import Popup from '../../ui/Popup';
import { CloseIcon } from '../../ui/Icons';
import { AppFrame } from './AppFrame';
import { AppTile } from './AppTile';
import { closeCustomFrame, useAppsRuntime, type CustomFrame } from './appsRuntime';
import './appFrames.css';

/** Room kept around a frame, so its header and edges stay on screen. */
const FRAME_MARGIN_PX = 24;
/** The header Stacki draws above the app's page. */
const HEADER_HEIGHT_PX = 40;

export function AppCustomFrames() {
  const runtime = useAppsRuntime();
  const apps = new Map(runtime.running.map((running) => [running.app.manifest.id, running.app]));
  return (
    <>
      {runtime.frames.map((frame) => {
        const app = apps.get(frame.appId);
        // A frame outlives nothing: its app stopped, so it is on its way out of the snapshot.
        return app === undefined ? undefined : <CustomFrameWindow key={frame.id} frame={frame} app={app} />;
      })}
    </>
  );
}

function CustomFrameWindow({ frame, app }: { readonly frame: CustomFrame; readonly app: AppSummary }) {
  // One object per frame, so the frame attaches once (AppFrame's effect depends on it).
  const info = useMemo(() => ({ id: frame.id, data: frame.data }), [frame.id, frame.data]);
  const close = (): void => closeCustomFrame(frame.id, undefined);
  const size = fittedSize(frame);
  const labelId = `${frame.id}-title`;
  const body = (
    <>
      <header className="app-custom-frame-header">
        <AppTile manifest={app.manifest} size={18} />
        <h2 id={labelId}>{app.manifest.name}</h2>
        <button type="button" className="ghost apps-icon-button" onClick={close} title="Close" aria-label={`Close ${app.manifest.name}`}>
          <CloseIcon size={13} />
        </button>
      </header>
      <AppFrame app={app} path={frame.page} title={app.manifest.name} className="app-custom-frame-page" frame={info} />
    </>
  );
  if (frame.modal) {
    return (
      <Popup className="app-custom-frame" labelledBy={labelId} onClose={close} style={size}>
        {body}
      </Popup>
    );
  }
  // A popup is a window beside the editor: pressing elsewhere or scrolling leaves it open.
  return (
    <Popup
      mode="popover"
      dismissible={false}
      keepOnScroll
      className="app-custom-frame is-popup"
      role="dialog"
      labelledBy={labelId}
      onClose={close}
      style={{ ...size, left: centered(window.innerWidth, size.width), top: centered(window.innerHeight, size.height) }}
    >
      {body}
    </Popup>
  );
}

// The asked size, shrunk to the window with its margin; the header is Stacki's and comes on top.
function fittedSize(frame: CustomFrame): { readonly width: number; readonly height: number } {
  const viewportWidth = typeof window === 'undefined' ? frame.width : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? frame.height : window.innerHeight;
  return {
    width: Math.max(0, Math.min(frame.width, viewportWidth - FRAME_MARGIN_PX * 2)),
    height: Math.max(0, Math.min(frame.height + HEADER_HEIGHT_PX, viewportHeight - FRAME_MARGIN_PX * 2)),
  };
}

function centered(viewportPx: number, sizePx: number): number {
  return Math.max(FRAME_MARGIN_PX, Math.floor((viewportPx - sizePx) / 2));
}
