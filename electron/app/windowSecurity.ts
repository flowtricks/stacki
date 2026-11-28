// What the app's windows may open, load and be granted. Kept apart from
// main.ts, which wires these rules to electron, so each one is tested alone.
import type { Session } from 'electron';

const BROWSER_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

// A link the user's browser may open. Any other scheme (file:, javascript:, an
// app's own link) would let a page choose what the operating system launches.
export function isBrowserLink(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  return BROWSER_PROTOCOLS.has(new URL(url).protocol);
}

// Whether a navigation of the app's window stays on Stacki's own page: the same
// file in a packaged build, the same origin as the dev server in development.
export function isAppPage(url: string, appUrl: string): boolean {
  if (!URL.canParse(url) || !URL.canParse(appUrl)) {
    return false;
  }
  const target = new URL(url);
  const app = new URL(appUrl);
  if (app.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === app.pathname;
  }
  return target.origin === app.origin;
}

// What any page may be granted. Electron grants every request by default, and a
// previewed site, or a page it embeds, may run scripts the user never read, so a
// permission is refused unless it is named here: nothing in it reveals the person
// or reaches their devices. These are what a site and Stacki use in ordinary
// browsing: copying, full screen, games and canvases that take the pointer or
// keys, video players, and a site's own storage and background work.
const OPEN_PERMISSIONS: ReadonlySet<string> = new Set([
  'background-sync',
  'clipboard-sanitized-write',
  'fileSystem', // Only ever a file or folder the person picks in the system's own dialog.
  'fullscreen',
  'keyboardLock',
  'mediaKeySystem',
  'persistent-storage',
  'pointerLock',
  'screen-wake-lock',
  'storage-access',
  'top-level-storage-access',
]);

// Reaching servers on this computer or its network: for pages that are themselves there.
const LOCAL_NETWORK_PERMISSIONS: ReadonlySet<string> = new Set(['local-network', 'local-network-access', 'loopback-network']);

// The links an embedded page may hand to another app, as in any browser: writing an email, calling, texting.
// Every other scheme would let a page choose what the operating system launches.
const EXTERNAL_APP_PROTOCOLS: ReadonlySet<string> = new Set(['mailto:', 'tel:', 'sms:']);

// Addresses on this computer or its own network: loopback, private IPv4 ranges, link-local and `.local` names.
const LOCAL_HOST =
  /^(?:localhost|.+\.localhost|.+\.local|\[::1\]|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/;

export interface PermissionAsk {
  readonly permission: string;
  /** The asking page's address or origin; '' when Electron names none. */
  readonly requestingUrl: string;
  /** Stacki's own page. */
  readonly appUrl: string;
  /** What a 'media' ask names. */
  readonly mediaTypes?: readonly string[] | undefined;
  /** Where an 'openExternal' ask leads. */
  readonly externalURL?: string | undefined;
}

/** Whether a page is granted a permission: only what is allowed by name (above). */
export function allowsPermission({ permission, requestingUrl, appUrl, mediaTypes, externalURL }: PermissionAsk): boolean {
  if (OPEN_PERMISSIONS.has(permission)) {
    return true;
  }
  if (permission === 'media') {
    return isAllowedMedia({ mediaTypes, requestingUrl, appUrl });
  }
  if (permission === 'openExternal') {
    return isExternalAppLink(externalURL ?? '');
  }
  if (permission === 'speaker-selection') {
    return isAppPage(requestingUrl, appUrl);
  }
  if (LOCAL_NETWORK_PERMISSIONS.has(permission)) {
    return isAppPage(requestingUrl, appUrl) || isLocalPage(requestingUrl);
  }
  return false;
}

function isExternalAppLink(url: string): boolean {
  return URL.canParse(url) && EXTERNAL_APP_PROTOCOLS.has(new URL(url).protocol);
}

function isLocalPage(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const page = new URL(url);
  // The packaged app's own page and what it loads from disk.
  if (page.protocol === 'file:') {
    return true;
  }
  return (page.protocol === 'http:' || page.protocol === 'https:') && LOCAL_HOST.test(page.hostname);
}

/**
 * Answers both of a session's permission questions with `allowsPermission`: the request a page makes, and the
 * check Chromium runs before using what it holds. Every frame of every window asks here, nested ones too.
 */
export function guardSessionPermissions(target: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>, appUrl: string): void {
  target.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(
      allowsPermission({
        permission,
        requestingUrl: details.requestingUrl,
        appUrl,
        mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
        externalURL: 'externalURL' in details ? details.externalURL : undefined,
      }),
    );
  });
  target.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    // A check names one kind at a time; 'unknown' is the system asking whether any device exists.
    const mediaTypes = 'mediaType' in details && details.mediaType !== 'video' ? ['audio'] : undefined;
    return allowsPermission({ permission, requestingUrl: details.requestingUrl ?? requestingOrigin, appUrl, mediaTypes });
  });
}

/**
 * Whether a camera or microphone request is dictation's: audio only, from Stacki's own page.
 * Why not simply refuse 'media' like the rest: the composer's voice input is Chromium's speech
 * recognition, which asks for the microphone through this permission, and a blanket refusal
 * made every dictation fail with "not-allowed" before macOS was even asked. A previewed site
 * (another origin) and any video request stay refused. `mediaTypes` is what the request names;
 * a request that names none is refused, because "everything" is not audio only.
 */
export function isAllowedMedia({
  mediaTypes,
  requestingUrl,
  appUrl,
}: {
  readonly mediaTypes: readonly string[] | undefined;
  readonly requestingUrl: string;
  readonly appUrl: string;
}): boolean {
  if (mediaTypes === undefined || mediaTypes.length === 0) {
    return false;
  }
  if (mediaTypes.some((type) => type !== 'audio')) {
    return false;
  }
  return isAppPage(requestingUrl, appUrl);
}
