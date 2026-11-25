// The preview frames stay on the site they show. A link to another site, a page
// script setting `location.href`, a form posting elsewhere: each would put a page
// in the canvas that usually refuses to be framed ("refused to connect") under
// outlines measured on the page that was there. Main refuses those navigations
// before they start and opens a web link in the browser instead, the rule the
// app window itself keeps (main.ts keepOnAppPage). The frame clients refuse the
// links first (frameInteraction.ts); this holds for every frame and every cause.
//
// A redirect is held to the same rule. A link to one of the site's own routes
// that the server answers with a redirect elsewhere (`/download`, which the
// marketing site's Worker sends to the release's file) starts on the site, so
// `will-frame-navigate` lets it go; only `will-redirect` sees it leave. Without
// this the interactive preview followed it into GitHub's "refused to connect"
// page, where a browser tab would have shown the release or saved the file.
import type { Event, WebContents, WebContentsWillRedirectEventParams, WebFrameMain } from 'electron';
import { assert } from '../../shared/core/assert';
import { isBrowserLink } from './windowSecurity';

export interface PreviewNavigationInput {
  /** Where the frame is now. */
  readonly currentURL: string;
  /** Where it was asked to go. */
  readonly targetURL: string;
  /** The app's own window asked: the editor switching pages or showing something else. */
  readonly initiatedByWindow: boolean;
  /** The frame sits directly in the app's window, rather than being one the site embeds. */
  readonly childOfWindow: boolean;
}

/** Whether main refuses a frame navigation: a preview frame leaving its site on its own. */
export function refusesPreviewNavigation(input: PreviewNavigationInput): boolean {
  if (!input.childOfWindow) {
    return false; // A site's own embeds (a video, a map) go where they like.
  }
  if (input.initiatedByWindow) {
    return false; // The editor decides what its frames show.
  }
  if (!URL.canParse(input.currentURL)) {
    return false;
  }
  const current = new URL(input.currentURL);
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    return false; // A frame that has not loaded a site yet has none to leave.
  }
  if (URL.canParse(input.targetURL)) {
    return new URL(input.targetURL).origin !== current.origin;
  }
  return true;
}

/**
 * The fields `will-frame-navigate` and `will-redirect` both carry for a frame's
 * navigation, as Electron types them; its absent frames are read as `undefined` below.
 */
type FrameNavigationEvent = Pick<Event<WebContentsWillRedirectEventParams>, 'url' | 'isMainFrame' | 'frame' | 'initiator' | 'preventDefault'>;

// Both moments a navigation can leave the site: as it starts, and at each
// redirect the server answers with.
export function keepPreviewsOnSite(contents: WebContents, openExternal: (url: string) => void): void {
  const hold = (event: FrameNavigationEvent) => keepPreviewOnSite(event, contents.mainFrame, openExternal);
  contents.on('will-frame-navigate', hold);
  contents.on('will-redirect', hold);
}

function keepPreviewOnSite(event: FrameNavigationEvent, window: WebFrameMain, openExternal: (url: string) => void): void {
  const frame = event.frame ?? undefined;
  if (event.isMainFrame || frame === undefined) {
    return; // The app's own page is held by keepOnAppPage in main.ts.
  }
  const refused = refusesPreviewNavigation({
    currentURL: frame.url,
    targetURL: event.url,
    initiatedByWindow: sameFrame(event.initiator ?? undefined, window),
    childOfWindow: sameFrame(frame.parent ?? undefined, window),
  });
  if (refused) {
    assert(!event.isMainFrame, 'Only a preview frame is held on its site');
    event.preventDefault();
    if (isBrowserLink(event.url)) {
      openExternal(event.url);
    }
  }
}

function sameFrame(left: WebFrameMain | undefined, right: WebFrameMain): boolean {
  if (left === undefined) {
    return false;
  }
  return left.processId === right.processId && left.routingId === right.routingId;
}
