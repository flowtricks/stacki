// What the app's windows may open, load and be granted. Kept apart from
// main.ts, which wires these rules to electron, so each one is tested alone.

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

// Permissions that reveal the user or reach their devices. Electron grants every
// request by default, and a previewed site may run scripts the user never read;
// Stacki itself uses none of these, so they are refused for every page. 'media' is
// not in this list: dictation needs the microphone, so it is decided by
// isAllowedMedia below (audio, for Stacki's own page only).
const PRIVATE_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'deprecated-sync-clipboard-read',
  'display-capture',
  'geolocation',
  'geolocation-approximate',
  'hid',
  'idle-detection',
  'serial',
  'usb',
]);

export function isPrivatePermission(permission: string): boolean {
  return PRIVATE_PERMISSIONS.has(permission);
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
