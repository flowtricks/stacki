// The Stacki UI kit for apps, as both hosts serve it (docs/apps.md, "Look and
// feel"). Every app's origin has a reserved folder, `__stacki/`, that the host
// answers itself and a bundle may not ship (appBundle.ts refuses it):
//
// - `__stacki/tokens.css`: the design tokens alone, `--stacki-*` custom properties.
// - `__stacki/ui.css`: the tokens, and the CSS of Stacki's own components, scoped
//   to the kit (`@scope (.stacki-ui)`) so it styles nothing else of the app's.
// - `__stacki/ui.js`: Stacki's own components, compiled as custom elements.
//
// The tokens are also injected into every HTML document an app serves, as one
// inline style of variables only, so even an app that never links the kit can
// write `var(--stacki-accent)`. Everything comes from the editor's own
// components and CSS, built by scripts/build/appUiKit.mts into
// generated/appUiKitBundle.ts on every build, so the kit cannot drift from them.
//
// Desktop's `stacki-app:` protocol (electron/handlers/appsHandlers.ts) and the
// Studio file route (studio/src/features/apps/appsServer.ts) both answer through
// appHostAsset and withAppTokens, so an app sees the same kit in either editor.
import { assert } from '../core/assert';
import { APP_HOST_FOLDER } from './apps';
import {
  APP_UI_COMPONENTS_CSS,
  APP_UI_SCRIPT,
  APP_UI_THEMES,
  APP_UI_TOKEN_NAMES,
  APP_UI_TOKEN_VALUES,
  APP_UI_TOKENS_CSS,
  type AppUiTheme,
  type AppUiTokenName,
} from './generated/appUiKitBundle';

export { APP_UI_THEMES, APP_UI_TOKEN_NAMES, type AppUiTheme, type AppUiTokenName } from './generated/appUiKitBundle';

/** The theme every editor draws today; the one an app starts in. */
export const APP_UI_DEFAULT_THEME: AppUiTheme = 'dark';

/**
 * The `color-scheme` both sides of every app frame use: the frame element's
 * (AppFrame.tsx) and, by default, the document's root (`withAppTokens`).
 *
 * Why both: Chromium paints an iframe opaque, with its color scheme's canvas
 * colour (#121212 dark, white light), whenever the frame element's used color
 * scheme differs from the embedded root's (css-color-adjust, "color-scheme
 * effect"). An app styled for the dark editor says `color-scheme: dark`; the
 * editor's frame element said `normal`, so an overlay `frame` item showed a grey
 * box the size of its frame around what the app painted. With the same scheme on
 * both sides the frame is transparent outside the app's own pixels. An app that
 * names another scheme for its root asks for that scheme's opaque canvas.
 */
export const APP_FRAME_COLOR_SCHEME: AppUiTheme = APP_UI_DEFAULT_THEME;

/**
 * The frame element's side: every app frame (src/features/apps/AppFrame.tsx)
 * draws no background of its own and uses APP_FRAME_COLOR_SCHEME, so it is
 * transparent outside what its document paints.
 */
export const APP_FRAME_SURFACE = { background: 'transparent', colorScheme: APP_FRAME_COLOR_SCHEME } as const;

// The document side of APP_FRAME_COLOR_SCHEME, at zero specificity so an app's own `:root` rule wins.
const APP_FRAME_ROOT_CSS = `:where(:root) {\n  color-scheme: ${APP_FRAME_COLOR_SCHEME};\n}`;

/** The files under `__stacki/`, with the type each is served as. */
export const APP_UI_KIT_FILES = {
  'tokens.css': 'text/css; charset=utf-8',
  'ui.css': 'text/css; charset=utf-8',
  'ui.js': 'text/javascript; charset=utf-8',
} as const;
export type AppUiKitFile = keyof typeof APP_UI_KIT_FILES;
const APP_UI_KIT_FILE_NAMES: readonly AppUiKitFile[] = ['tokens.css', 'ui.css', 'ui.js'];

/**
 * What the host answers for one path in an app's origin: a kit file it serves
 * itself, a reserved path it has no file for (a 404, never the app's own file),
 * or a path that belongs to the app's bundle.
 */
export type AppHostAsset =
  | { readonly kind: 'kit'; readonly file: AppUiKitFile; readonly type: string; readonly body: string }
  | { readonly kind: 'reserved' }
  | { readonly kind: 'bundle' };

/** `stacki.ui.theme()`: the editor's theme and every token's value in it. */
export interface AppThemeView {
  readonly theme: AppUiTheme;
  readonly tokens: { readonly [N in AppUiTokenName]: string };
}

/** Whether a bundle path is inside the reserved folder (`__stacki/…`). */
export function isAppHostPath(bundlePath: string): boolean {
  const first = bundlePath.replace(/^\/+/, '').split('/')[0] ?? '';
  assert(!first.includes('/'), 'A first path segment has no slash');
  return first.toLowerCase() === APP_HOST_FOLDER;
}

/** Answers one request path (already decoded, without the leading slash) in an app's origin. */
export function appHostAsset(filePath: string): AppHostAsset {
  assert(!filePath.startsWith('/'), 'The path is relative to the app origin');
  if (!isAppHostPath(filePath)) {
    return { kind: 'bundle' };
  }
  // The kit answers at the folder's exact spelling; any other case is reserved, never the bundle's.
  const exact = filePath.startsWith(`${APP_HOST_FOLDER}/`);
  const name = filePath.slice(APP_HOST_FOLDER.length + 1);
  const file = exact ? APP_UI_KIT_FILE_NAMES.find((candidate) => candidate === name) : undefined;
  if (file === undefined) {
    return { kind: 'reserved' };
  }
  const body = appUiKitBody(file);
  assert(body.length > 0, 'Every kit file has content');
  return { kind: 'kit', file, type: APP_UI_KIT_FILES[file], body };
}

/**
 * An HTML document with the tokens added as one inline style, before `</head>`
 * (or the body, or after the doctype) so a `<meta charset>` stays in the first
 * kilobyte. Any other file comes back as it is. The tokens, and the root's
 * `color-scheme` (APP_FRAME_COLOR_SCHEME), sit at zero specificity, so the
 * app's own `:root` rules win.
 */
export function withAppTokens(file: { readonly bytes: Uint8Array; readonly type: string }): Uint8Array {
  if (!file.type.startsWith('text/html')) {
    return file.bytes;
  }
  const html = new TextDecoder().decode(file.bytes);
  const style = `<style data-stacki-tokens>\n${APP_FRAME_ROOT_CSS}\n${APP_UI_TOKENS_CSS}\n</style>\n`;
  const at = tokenInsertionIndex(html);
  assert(at >= 0, 'The tokens go inside the document');
  assert(at <= html.length, 'The tokens go inside the document');
  return new TextEncoder().encode(html.slice(0, at) + style + html.slice(at));
}

/** The editor's tokens in one theme. */
export function appThemeView(theme: AppUiTheme): AppThemeView {
  const tokens = APP_UI_TOKEN_VALUES[theme];
  assert(Object.keys(tokens).length === APP_UI_TOKEN_NAMES.length, 'A theme has every token');
  assert(APP_UI_THEMES.includes(theme), 'The theme is one the kit has');
  return { theme, tokens };
}

/** A theme name from outside (the editor root's `data-theme`); the default for anything else. */
export function parseAppUiTheme(input: unknown): AppUiTheme {
  const theme = APP_UI_THEMES.find((candidate) => candidate === input) ?? APP_UI_DEFAULT_THEME;
  assert(APP_UI_THEMES.includes(theme), 'A parsed theme is one the kit has');
  return theme;
}

function appUiKitBody(file: AppUiKitFile): string {
  switch (file) {
    case 'tokens.css':
      return `${APP_UI_TOKENS_CSS}\n`;
    case 'ui.css':
      // i18n-ignore: a CSS comment in the stylesheet served to apps.
      return `/* Stacki app UI kit, built from the editor's CSS. See docs/apps.md, "Look and feel". */\n${APP_UI_TOKENS_CSS}\n${APP_UI_COMPONENTS_CSS}\n`;
    case 'ui.js':
      return APP_UI_SCRIPT;
    default: {
      const exhaustive: never = file;
      return exhaustive;
    }
  }
}

function tokenInsertionIndex(html: string): number {
  const lower = html.toLowerCase();
  const headEnd = lower.indexOf('</head');
  if (headEnd >= 0) {
    return headEnd;
  }
  const body = lower.indexOf('<body');
  if (body >= 0) {
    return body;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype === null ? 0 : doctype[0].length;
}
