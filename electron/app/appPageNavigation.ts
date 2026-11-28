// The preload hands Stacki's API to whatever page the app's window shows, so the
// window never leaves Stacki's own page; web links open in the browser instead.
// A redirect is held as a navigation is: a navigation that starts on the page and
// is answered with another address would otherwise arrive there.
import type { Event, WebContents } from 'electron';
import { isAppPage, isBrowserLink } from './windowSecurity';

type PageNavigationEvent = Pick<Event<{ url: string; isMainFrame: boolean }>, 'url' | 'isMainFrame' | 'preventDefault'>;

export function keepOnAppPage(contents: WebContents, appUrl: string, openExternal: (url: string) => void): void {
  const hold = (event: PageNavigationEvent): void => {
    if (!event.isMainFrame) {
      return; // Frames keep their own rules (previewNavigation.ts, appFrameNavigation.ts).
    }
    if (isAppPage(event.url, appUrl)) {
      return;
    }
    event.preventDefault();
    if (isBrowserLink(event.url)) {
      openExternal(event.url);
    }
  };
  contents.on('will-navigate', hold);
  contents.on('will-redirect', hold);
}
