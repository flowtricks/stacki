// An app frame stays on its own app. The editor talks to a frame by its window,
// so a frame that navigated itself to some website would put that website
// where the app's grants are honoured. Main refuses a `stacki-app:` frame
// leaving its own origin (`stacki-app://<id>`) and opens a web link in the
// browser instead, the rule previewNavigation.ts keeps for the canvas.
import type { Event, WebContents, WebContentsWillRedirectEventParams } from 'electron';
import { assert } from '../../shared/core/assert';
import { isBrowserLink } from './windowSecurity';

/** Whether a frame now at `currentURL` may go to `targetURL`. */
export function appFrameMayNavigate(currentURL: string, targetURL: string): boolean {
  if (!URL.canParse(currentURL)) {
    return true;
  }
  const current = new URL(currentURL);
  if (current.protocol !== 'stacki-app:') {
    return true; // Not an app frame: other rules decide.
  }
  if (!URL.canParse(targetURL)) {
    return false;
  }
  const target = new URL(targetURL);
  const same = target.protocol === current.protocol && target.host === current.host;
  assert(current.host.length > 0, 'An app frame has an app id for its host');
  return same;
}

type FrameNavigationEvent = Pick<Event<WebContentsWillRedirectEventParams>, 'url' | 'isMainFrame' | 'frame' | 'preventDefault'>;

export function keepAppFramesHome(contents: WebContents, openExternal: (url: string) => void): void {
  const hold = (event: FrameNavigationEvent): void => {
    const frame = event.frame ?? undefined;
    if (event.isMainFrame || frame === undefined) {
      return;
    }
    if (appFrameMayNavigate(frame.url, event.url)) {
      return;
    }
    event.preventDefault();
    if (isBrowserLink(event.url)) {
      openExternal(event.url);
    }
  };
  contents.on('will-frame-navigate', hold);
  contents.on('will-redirect', hold);
}
