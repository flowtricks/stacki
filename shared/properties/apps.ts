// Stacki Apps: what an installed app is, as Desktop and Studio both read it from
// `.stacki/apps/`. This module is the contract for the bundle's manifest
// (`stacki-app.json`), the project's lockfile (`.stacki/apps/apps.json`), the
// paths a bundle may hold,
// and the summaries the Apps panel shows. Every value from a bundle, the
// lockfile, GitHub or the wire passes one of these parsers first (docs/apps.md,
// docs/contracts.md "Stacki Apps").
//
// The bounds live here, beside the parsers that enforce them (AGENTS.md §10):
// no other module answers to them.
import { parseAppCommands, parseShortcutClaims, type AppCommand } from './appShortcuts';
import { parseAppSettingDeclarations, type AppSettingDeclaration } from './appSettings';
import { parseAppPermissionDeclarations, type AppPermissionDeclaration } from './appPermissions';
import { parseSecretsAllowlist, type AppSecretAllowance } from './appSecrets';
import { parseAppAuthProviders, parseAppNetwork, type AppAuthProvider, type AppNetworkHost } from './appAuth';
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { parseGitHubLogin } from './projectRoles';

/** Where a project keeps its apps; tracked, so every editor of the project sees the same ones. */
export const APPS_DIRECTORY = '.stacki/apps';
/** The lockfile: which apps are installed, from where, at which digest, with which grants. */
export const APPS_LOCK_FILE = '.stacki/apps/apps.json';
/** The manifest at the root of every bundle. */
export const APP_MANIFEST_FILE = 'stacki-app.json';
/** The SDK the host serves into every app at this path; a bundle may not ship its own. */
export const APP_SDK_FILE = 'stacki-sdk.js';
/** The folder the host serves its UI kit from in every app (`__stacki/ui.css`); a bundle may not ship one (shared/properties/appUiKit.ts). */
export const APP_HOST_FOLDER = '__stacki';

export const APP_LIMITS = {
  /** An app id, as role grants name it (`app:<id>`, shared/properties/projectRoles.ts). */
  idCharsMax: 64,
  nameCharsMax: 60,
  descriptionCharsMax: 280,
  versionCharsMax: 32,
  /** Installed apps in one project. */
  appsMax: 50,
  /** Files in one bundle, directories not counted. */
  filesMax: 200,
  /** One file, uncompressed. */
  fileBytesMax: 5 * 1024 * 1024,
  /** All files together, uncompressed: the zip-bomb bound. */
  bundleBytesMax: 20 * 1024 * 1024,
  /** The uploaded or downloaded archive itself. */
  archiveBytesMax: 10 * 1024 * 1024,
  /** A path inside a bundle. */
  pathCharsMax: 200,
  pathDepthMax: 8,
  /** The manifest file's own size. */
  manifestBytesMax: 16 * 1024,
  /** The lockfile's size: 50 apps of about 1 KiB each, with room. */
  lockBytesMax: 256 * 1024,
  /**
   * The manifest's `window.width` and `window.height`. In panel mode the side panel
   * also clamps the width to its own range (ResizablePanel.tsx: 260 to 600 pixels).
   */
  windowWidthPxMin: 240,
  windowWidthPxMax: 1600,
  windowHeightPxMin: 160,
  windowHeightPxMax: 1200,
  /** GitHub's own owner and repository name limits. */
  ownerCharsMax: 39,
  repositoryCharsMax: 100,
  assetNameCharsMax: 120,
  tagCharsMax: 128,
  messageCharsMax: 1000,
  /** An app icon: small enough to show in every list at once, square, at most 512 pixels a side. */
  iconBytesMax: 256 * 1024,
  iconPxMax: 512,
} as const satisfies Record<string, number>;

/** Where an app's UI shows: docked in the side panel, or in a popup over the canvas. */
export const APP_WINDOW_MODES = ['panel', 'popup'] as const;
export type AppWindowMode = (typeof APP_WINDOW_MODES)[number];

/** The popup size an app gets when its manifest names none. */
export const APP_WINDOW_DEFAULT = { widthPx: 360, heightPx: 480 } as const satisfies Record<string, number>;

/**
 * How an app's UI first opens. The user can switch modes and resize afterwards;
 * their choice is remembered per project and wins over these defaults.
 */
export interface AppWindow {
  /** The mode the app opens in until the user picks another. */
  readonly mode: AppWindowMode;
  /** The side panel's width while the app is docked, and the popup's width; absent keeps the user's panel width. */
  readonly widthPx: number | undefined;
  /** The popup's height; absent uses `APP_WINDOW_DEFAULT`. */
  readonly heightPx: number | undefined;
}

/** Where updates come from: GitHub releases of one repository, by asset name. */
export interface AppGitHubSource {
  readonly kind: 'github';
  readonly owner: string;
  readonly repository: string;
  /** The release asset's file name, e.g. `heatmap.zip`. */
  readonly asset: string;
  /**
   * The signed-in GitHub account that reads the repository, for a private one:
   * the publish flow's account on Desktop. Absent reads it as a public repository.
   */
  readonly account?: string | undefined;
}

export interface AppManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** A bundle path to a square PNG, SVG or WebP (appBundle.ts checks it); absent shows a lettered tile. */
  readonly icon: string | undefined;
  /** The bundle path the frame opens. */
  readonly entry: string;
  readonly window: AppWindow;
  readonly source: AppGitHubSource | undefined;
  /** The author's GitHub login (`author.github`), for their picture; absent falls back to the repository owner. */
  readonly authorGitHub: string | undefined;
  /** Global commands, each optionally on a key in the reserved range (appShortcuts.ts). */
  readonly commands: readonly AppCommand[];
  /** Shortcuts the app keeps while it has focus, as canonical text (appShortcuts.ts). */
  readonly shortcutClaims: readonly string[];
  /** What each installer fills in, such as their own API key (appSettings.ts). */
  readonly settings: readonly AppSettingDeclaration[];
  /** Lines the secret scan skips, each named by file and line hash, for reviewers to see (appSecrets.ts). */
  readonly secretsAllowlist: readonly AppSecretAllowance[];
  /** Every external host the app calls at runtime, with why; its frame may connect to these only (appAuth.ts). Empty: it works offline. */
  readonly network: readonly AppNetworkHost[];
  /** OAuth providers it signs in to with the installer's own client (appAuth.ts). */
  readonly auth: readonly AppAuthProvider[];
  /** Switches admins set per role in Settings → Roles; the app reads and enforces them itself (appPermissions.ts). */
  readonly permissions: readonly AppPermissionDeclaration[];
  /**
   * The oldest Stacki that runs the app, from the manifest's `"stacki": ">=1.1.0"`; absent runs on any.
   * Install and update refuse a bundle that needs a newer Stacki (`stackiVersionProblem`).
   */
  readonly stackiVersionMin: string | undefined;
}

/**
 * How an installed app arrived. A file install keeps the uploaded name for the record only.
 * A marketplace install names the index entry and approved version (shared/properties/appMarketplace.ts);
 * where it downloads from is the index's to say, so the lockfile never repeats it.
 */
export type AppInstallSource =
  | { readonly kind: 'file'; readonly fileName: string }
  /**
   * Added straight to `.stacki/apps/<id>/` (by hand, an AI agent, a pull or a copy): a folder
   * the lockfile does not name, listed as installed at once. Its `sha256` is the folder's
   * digest (electron/project/appScan.ts); nothing is written to the lockfile for it.
   */
  | { readonly kind: 'local' }
  | (AppGitHubSource & { readonly tag: string })
  | { readonly kind: 'marketplace'; readonly id: string; readonly version: string };

/** A newer release found by an update check, installed when an admin chooses Update. */
export interface AppAvailableUpdate {
  readonly version: string;
  readonly tag: string;
  /** SHA-256 of the archive that was checked; Update installs only these bytes. */
  readonly sha256: string;
}

export interface AppLockEntry {
  readonly id: string;
  readonly version: string;
  /** SHA-256 (hex) of the archive that was installed. */
  readonly sha256: string;
  readonly installedAt: string;
  readonly source: AppInstallSource;
  readonly update: AppAvailableUpdate | undefined;
  /**
   * Whether an update check installs a newer version by itself. Off unless an admin
   * switched it on for this app: an app is third-party code, so nothing new runs
   * without a person choosing Update or this switch (docs/apps.md, "Update policy").
   */
  readonly autoUpdate: boolean;
}

export interface AppsLock {
  readonly version: 1;
  readonly apps: readonly AppLockEntry[];
}

export const EMPTY_APPS_LOCK: AppsLock = { version: 1, apps: [] };

/** What the Apps panel shows of one installed app: its manifest and its lock entry. */
export interface AppSummary {
  readonly manifest: AppManifest;
  readonly lock: AppLockEntry;
}

/** A bundle checked and held by the host until an admin confirms the install. */
export interface AppStaged {
  /** Opaque handle for `apps:commit`. */
  readonly token: string;
  readonly manifest: AppManifest;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly source: AppInstallSource;
  /** The installed version this would replace, if any. */
  readonly replaces: string | undefined;
}

/** An app operation's expected failure: a bad bundle, a refused download, a missing app. */
export type AppsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** What an update check did, app by app. */
export type AppUpdateOutcome =
  | { readonly kind: 'current'; readonly id: string }
  | { readonly kind: 'available'; readonly id: string; readonly version: string }
  | { readonly kind: 'failed'; readonly id: string; readonly message: string }
  /** Auto-update was on, and the check installed this version. */
  | { readonly kind: 'updated'; readonly id: string; readonly version: string };

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

// The role grant pattern (projectRoles.ts parseFeature), so every app can be granted.
const APP_ID = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,20}))?$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function parseAppId(input: unknown): string {
  const id = text(input);
  if (id.length === 0 || id.length > APP_LIMITS.idCharsMax) {
    throw new Error(`An app id is 1 to ${APP_LIMITS.idCharsMax} characters`);
  }
  if (!APP_ID.test(id)) {
    throw new Error(`App id "${id}" must be lowercase letters, digits, dots, dashes and underscores`);
  }
  assert(!id.includes('/'), 'An app id never names a path');
  return id;
}

export function parseAppVersion(input: unknown): string {
  const version = text(input);
  if (version.length > APP_LIMITS.versionCharsMax) {
    throw new Error('App version exceeds limit');
  }
  if (!VERSION.test(version)) {
    throw new Error(`App version "${version}" is not MAJOR.MINOR.PATCH`);
  }
  return version;
}

/** The only Stacki range a manifest may state: a minimum release, `>=MAJOR.MINOR.PATCH`. */
const STACKI_RANGE = /^>=(\d+\.\d+\.\d+)$/;
/** `">=1.1.0"` plus room: longer text is not a range this parser reads. */
const STACKI_RANGE_CHARS_MAX = APP_LIMITS.versionCharsMax + 2;

/**
 * A `stacki` range, `">=1.1.0"`, as the minimum version it names. Only a
 * minimum release is accepted: no upper bound, no prerelease, nothing else, so
 * every Stacki answers the question the same way. Throws on any other text.
 */
export function parseStackiRange(input: unknown): string {
  const range = text(input).trim();
  if (range.length === 0 || range.length > STACKI_RANGE_CHARS_MAX) {
    throw new Error(`stacki must be ">=MAJOR.MINOR.PATCH", at most ${STACKI_RANGE_CHARS_MAX} characters`);
  }
  const match = STACKI_RANGE.exec(range);
  if (match === null) {
    throw new Error(`stacki "${range.slice(0, 40)}" must be ">=MAJOR.MINOR.PATCH", such as ">=1.1.0"`);
  }
  const minimum = parseStackiVersionMin(match[1]);
  assert(range.endsWith(minimum), 'The minimum is the range’s own version');
  return minimum;
}

/** A minimum Stacki version, as a parsed manifest carries it: a release, never a prerelease. */
export function parseStackiVersionMin(input: unknown): string {
  const version = parseAppVersion(input);
  if (version.includes('-')) {
    throw new Error(`The minimum Stacki version "${version}" must be a release, not a prerelease`);
  }
  return version;
}

// The file says `"stacki": ">=1.1.0"`; a parsed manifest on the wire says `stackiVersionMin: "1.1.0"`.
function parseManifestStackiVersionMin(value: Readonly<Record<string, unknown>>): string | undefined {
  const range = value['stacki'];
  const parsed = value['stackiVersionMin'];
  if (range !== undefined) {
    if (parsed !== undefined) {
      throw new Error('Name stacki or stackiVersionMin, not both');
    }
    return parseStackiRange(range);
  }
  return parsed === undefined ? undefined : parseStackiVersionMin(parsed);
}

/** What Stacki says when an app needs a newer Stacki than the one running. */
export function stackiVersionMessage(minimum: string): string {
  assert(minimum.length > 0, 'A minimum Stacki version is never empty');
  return `Needs Stacki ${minimum} or later. Update Stacki.`;
}

/**
 * Why this Stacki cannot run an app that needs `minimum`, or undefined when it
 * can. A running version that is not MAJOR.MINOR.PATCH (`unknown` from a host
 * too old to say) is not judged: the bundle's other checks still hold it.
 */
export function stackiVersionProblem(minimum: string | undefined, running: string): string | undefined {
  if (minimum === undefined) {
    return undefined;
  }
  if (!VERSION.test(running)) {
    return undefined;
  }
  if (compareAppVersions(running, minimum) >= 0) {
    return undefined;
  }
  const message = stackiVersionMessage(minimum);
  assert(message.includes(minimum), 'The message names the version needed');
  return message;
}

/** Orders two app versions: negative when `left` is older. A prerelease is older than its release. */
export function compareAppVersions(left: string, right: string): number {
  const first = versionParts(left);
  const second = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (first.numbers[index] ?? 0) - (second.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  if (first.prerelease === second.prerelease) {
    return 0;
  }
  if (first.prerelease === undefined) {
    return 1;
  }
  if (second.prerelease === undefined) {
    return -1;
  }
  return first.prerelease < second.prerelease ? -1 : 1;
}

function versionParts(version: string): { readonly numbers: readonly number[]; readonly prerelease: string | undefined } {
  const match = VERSION.exec(version);
  assert(match !== null, 'compareAppVersions takes parsed versions');
  const numbers = [match[1], match[2], match[3]].map((part) => Number(part));
  assert(
    numbers.every((part) => Number.isSafeInteger(part)),
    'Version parts are integers',
  );
  return { numbers, prerelease: match[4] ?? undefined };
}

export function parseSha256(input: unknown): string {
  const value = text(input);
  if (!SHA256.test(value)) {
    throw new Error('Expected a lowercase hex SHA-256');
  }
  return value;
}

function boundedText(input: unknown, charsMax: number, what: string): string {
  const value = text(input).trim();
  if (value.length === 0) {
    throw new Error(`${what} is empty`);
  }
  if (value.length > charsMax) {
    throw new Error(`${what} exceeds ${charsMax} characters`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Bundle paths
// ---------------------------------------------------------------------------

/**
 * File types a bundle may hold, with the type the host serves them as. Anything
 * else, executables and native modules above all, is refused: a bundle's files
 * are only ever served to its sandboxed frame, never run by Stacki.
 */
export const APP_FILE_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * A path inside a bundle: relative, `/`-separated, no `.` or `..`, no hidden or
 * empty segments, no backslashes or drive letters, a known file type, bounded.
 * The same check guards writing a bundle to disk and serving a file from it.
 */
export function parseBundlePath(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > APP_LIMITS.pathCharsMax) {
    throw new Error(`A bundle path is 1 to ${APP_LIMITS.pathCharsMax} characters`);
  }
  const segments = value.split('/');
  if (segments.length > APP_LIMITS.pathDepthMax) {
    throw new Error('A bundle path is nested too deeply');
  }
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment)) {
      throw new Error(`Bundle path "${value.slice(0, 80)}" has an unsafe segment`);
    }
  }
  if (appFileType(value) === undefined) {
    throw new Error(`Bundle file "${value.slice(0, 80)}" is not a type an app may hold`);
  }
  assert(!value.startsWith('/'), 'A bundle path is relative');
  assert(!segments.includes('..'), 'A bundle path never climbs');
  return value;
}

/** The type a bundle path is served as, or undefined when it is not allowed. */
export function appFileType(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  const extension = path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(APP_FILE_TYPES, extension) ? APP_FILE_TYPES[extension] : undefined;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Parses a manifest file's text. Throws with the reason on any bad shape. */
export function parseAppManifestSource(source: string): AppManifest {
  if (source.length > APP_LIMITS.manifestBytesMax) {
    throw new Error(`${APP_MANIFEST_FILE} exceeds ${APP_LIMITS.manifestBytesMax} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    throw new Error(`${APP_MANIFEST_FILE} is not JSON: ${String(error).slice(0, 200)}`);
  }
  return parseAppManifest(parsed);
}

export function parseAppManifest(input: unknown): AppManifest {
  const value = record(input);
  if (value['manifestVersion'] !== 1) {
    throw new Error('manifestVersion must be 1');
  }
  const entry = parseBundlePath(value['entry']);
  if (!entry.endsWith('.html')) {
    throw new Error('The entry must be an HTML file');
  }
  const icon = value['icon'] === undefined ? undefined : parseIconPath(value['icon']);
  const settings = parseAppSettingDeclarations(value['settings']);
  const manifest: AppManifest = {
    manifestVersion: 1,
    id: parseAppId(value['id']),
    name: boundedText(value['name'], APP_LIMITS.nameCharsMax, 'App name'),
    version: parseAppVersion(value['version']),
    // Absent and empty are the same: a parsed manifest carries '' for no description, and must read back over the wire.
    description:
      value['description'] === undefined || value['description'] === ''
        ? ''
        : boundedText(value['description'], APP_LIMITS.descriptionCharsMax, 'App description'),
    icon,
    entry,
    window: parseAppWindow(value['window'] ?? {}),
    source: value['source'] === undefined ? undefined : parseGitHubSource(value['source']),
    authorGitHub: value['author'] === undefined ? parseParsedAuthor(value['authorGitHub']) : parseAuthor(value['author']),
    commands: parseAppCommands(value['commands']),
    shortcutClaims: parseShortcutClaims(value['shortcutClaims']),
    settings,
    secretsAllowlist: parseSecretsAllowlist(value['secretsAllowlist'], parseBundlePath),
    network: parseAppNetwork(value['network']),
    auth: parseAppAuthProviders(value['auth'], settings),
    permissions: parseAppPermissionDeclarations(value['permissions']),
    stackiVersionMin: parseManifestStackiVersionMin(value),
  };
  assert(manifest.entry !== APP_SDK_FILE, 'The entry is never the host SDK');
  return manifest;
}

// A parsed manifest on the wire carries the login as `authorGitHub`; it is checked as the file's is.
function parseParsedAuthor(input: unknown): string | undefined {
  return input === undefined ? undefined : parseGitHubLogin(input);
}

/**
 * A field the manifest file and the parsed manifest name differently: the file's
 * name first, else the parsed one. `parseAppManifest` reads both forms, so a
 * manifest parsed once (Desktop's main process, Studio's server) parses again to
 * the same value where the renderer re-checks it from IPC or HTTP.
 */
function fileOrParsed(value: Readonly<Record<string, unknown>>, fileKey: string, parsedKey: string): unknown {
  const fromFile = value[fileKey];
  if (fromFile === undefined) {
    return value[parsedKey];
  }
  if (value[parsedKey] !== undefined) {
    throw new Error(`Name ${fileKey} or ${parsedKey}, not both`);
  }
  return fromFile;
}

// `author: { "github": "login" }`: only the login is read, validated as GitHub validates it.
function parseAuthor(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const github = record(input)['github'];
  return github === undefined ? undefined : parseGitHubLogin(github);
}

/** Whose picture an app shows: its declared author, else its GitHub repository's owner. */
export function appAuthorLogin(summary: AppSummary): string | undefined {
  const source = summary.lock.source;
  const login = summary.manifest.authorGitHub ?? (source.kind === 'github' ? source.owner : undefined);
  assert(login === undefined || login.length > 0, 'An author login is never empty');
  return login;
}

function parseIconPath(input: unknown): string {
  const icon = parseBundlePath(input);
  if (!/\.(svg|png|webp)$/i.test(icon)) {
    throw new Error('An app icon is a PNG, SVG or WebP image');
  }
  return icon;
}

/** `window: { mode?, width?, height? }`: every field optional, each bounded by `APP_LIMITS`. */
export function parseAppWindow(input: unknown): AppWindow {
  const value = record(input);
  if (value['kind'] !== undefined) {
    // The first manifests named the mode `kind` ("panel" or "floating"); say what replaced it.
    throw new Error('window.kind is now window.mode: "panel" or "popup"');
  }
  const mode = value['mode'] ?? 'panel';
  if (mode !== 'panel' && mode !== 'popup') {
    throw new Error('window.mode must be "panel" or "popup"');
  }
  // A manifest file says `width`; a parsed window on the wire says `widthPx` (see `fileOrParsed`).
  const width = fileOrParsed(value, 'width', 'widthPx');
  const height = fileOrParsed(value, 'height', 'heightPx');
  const parsed: AppWindow = {
    mode,
    widthPx: width === undefined ? undefined : pixels(width, APP_LIMITS.windowWidthPxMin, APP_LIMITS.windowWidthPxMax, 'Window width'),
    heightPx: height === undefined ? undefined : pixels(height, APP_LIMITS.windowHeightPxMin, APP_LIMITS.windowHeightPxMax, 'Window height'),
  };
  assert(APP_WINDOW_MODES.includes(parsed.mode), 'A parsed window mode is a known mode');
  return parsed;
}

/** The popup's first size: the manifest's, else the default, each within the manifest bounds. */
export function appPopupSize(placement: AppWindow): { readonly widthPx: number; readonly heightPx: number } {
  const size = { widthPx: placement.widthPx ?? APP_WINDOW_DEFAULT.widthPx, heightPx: placement.heightPx ?? APP_WINDOW_DEFAULT.heightPx };
  assert(size.widthPx >= APP_LIMITS.windowWidthPxMin, 'A popup is at least the minimum width');
  assert(size.widthPx <= APP_LIMITS.windowWidthPxMax, 'A popup is at most the maximum width');
  assert(size.heightPx >= APP_LIMITS.windowHeightPxMin, 'A popup is at least the minimum height');
  assert(size.heightPx <= APP_LIMITS.windowHeightPxMax, 'A popup is at most the maximum height');
  return size;
}

function pixels(input: unknown, minimum: number, maximum: number, what: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new Error(`${what} must be a whole number of pixels`);
  }
  if (input < minimum || input > maximum) {
    throw new Error(`${what} must be ${minimum} to ${maximum} pixels`);
  }
  return input;
}

/** A GitHub releases source, as the manifest or the install form names it. */
export function parseGitHubSource(input: unknown): AppGitHubSource {
  const value = record(input);
  if (value['kind'] !== undefined && value['kind'] !== 'github') {
    throw new Error('source.kind must be "github"');
  }
  const owner = boundedText(value['owner'], APP_LIMITS.ownerCharsMax, 'GitHub owner');
  if (!GITHUB_OWNER.test(owner)) {
    throw new Error(`"${owner}" is not a GitHub owner`);
  }
  const repository = boundedText(value['repository'] ?? value['repo'], APP_LIMITS.repositoryCharsMax, 'GitHub repository');
  if (!GITHUB_REPOSITORY.test(repository) || repository === '.' || repository === '..') {
    throw new Error(`"${repository}" is not a GitHub repository name`);
  }
  const asset = boundedText(value['asset'], APP_LIMITS.assetNameCharsMax, 'Release asset');
  if (!ASSET_NAME.test(asset)) {
    throw new Error('The release asset must be a .zip file name');
  }
  if (value['account'] === undefined || value['account'] === null) {
    return { kind: 'github', owner, repository, asset };
  }
  return { kind: 'github', owner, repository, asset, account: parseGitHubLogin(value['account']) };
}

// ---------------------------------------------------------------------------
// Choosing a GitHub release
// ---------------------------------------------------------------------------

/**
 * What listing an account's repositories came to, as the chooser shows it. The
 * IPC reply stays an AppsResult like every other apps channel; the renderer's
 * bridge turns it into this. `restart` is a renderer newer than the main process
 * (no handler, or a reply the renderer's parser no longer accepts): only a
 * restart brings the two back to one version.
 */
export type AppRepositoryListing =
  | { readonly kind: 'ready'; readonly repositories: readonly AppRepository[] }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'rate-limited'; readonly resetAtMs: number | undefined }
  | { readonly kind: 'restart' };

// The rate-limit failure travels as an AppsResult message, so the one shape every
// apps channel uses stays the same; these two functions are its only writer and
// reader, and the message still reads well where an older renderer shows it raw.
const RATE_LIMIT_MESSAGE = /^GitHub is limiting requests(?: until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z))?\.$/;

/** The failure message for GitHub's rate limit, with the time it lifts when GitHub said. */
export function rateLimitMessage(resetAtMs: number | undefined): string {
  if (resetAtMs === undefined) {
    return 'GitHub is limiting requests.';
  }
  assert(Number.isSafeInteger(resetAtMs), 'A rate-limit reset is a whole millisecond time');
  assert(resetAtMs >= 0, 'A rate-limit reset is after 1970');
  const message = `GitHub is limiting requests until ${new Date(resetAtMs).toISOString()}.`;
  assert(RATE_LIMIT_MESSAGE.test(message), 'The rate-limit message reads back');
  return message;
}

/** The rate limit a failure message reports, or undefined for any other failure. */
export function parseRateLimitMessage(message: string): { readonly resetAtMs: number | undefined } | undefined {
  const match = RATE_LIMIT_MESSAGE.exec(message) ?? undefined;
  if (match === undefined) {
    return undefined;
  }
  const iso = match[1];
  if (iso === undefined) {
    return { resetAtMs: undefined };
  }
  const resetAtMs = Date.parse(iso);
  return { resetAtMs: Number.isNaN(resetAtMs) ? undefined : resetAtMs };
}

/** A repository named by what a person typed or pasted. */
export interface GitHubRepositoryReference {
  readonly owner: string;
  readonly repository: string;
}

/** Longer than any owner, repository and URL around them; past it the text is not a reference. */
const REPOSITORY_REFERENCE_CHARS_MAX = 300;

/**
 * `owner/repo`, `github.com/owner/repo` or `https://github.com/owner/repo(.git)`
 * as the repository it names, held to GitHub's name rules; undefined for any
 * other text, which the chooser treats as a search. A github.com address may go
 * on past the repository (`/releases`, `?tab=…`, `#readme`); a bare `owner/repo`
 * may not, so a search like `a/b/c` is not mistaken for one.
 */
export function parseGitHubRepositoryReference(input: string): GitHubRepositoryReference | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > REPOSITORY_REFERENCE_CHARS_MAX) {
    return undefined;
  }
  // RegExp.exec answers null for no match; it becomes undefined where it is read.
  const hosted = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)(?:[/?#]\S*)?$/i.exec(trimmed) ?? undefined;
  const match = hosted ?? /^([^/\s]+)\/([^/\s]+?)\/?$/.exec(trimmed) ?? undefined;
  if (match === undefined) {
    return undefined;
  }
  const owner = match[1] ?? '';
  const repository = (match[2] ?? '').replace(/\.git$/i, '');
  if (owner.length === 0 || owner.length > APP_LIMITS.ownerCharsMax || !GITHUB_OWNER.test(owner)) {
    return undefined;
  }
  if (repository.length === 0 || repository.length > APP_LIMITS.repositoryCharsMax || !GITHUB_REPOSITORY.test(repository)) {
    return undefined;
  }
  if (repository === '.' || repository === '..') {
    return undefined;
  }
  assert(owner.length <= APP_LIMITS.ownerCharsMax, 'A parsed owner is within GitHub’s limit');
  return { owner, repository };
}

export const APP_GITHUB_CHOICE_LIMITS = {
  repositoriesMax: 300,
  releasesMax: 30,
  assetsMax: 100,
} as const satisfies Record<string, number>;

/** A repository the signed-in account can read, as the chooser lists it. */
export interface AppRepository {
  readonly owner: string;
  readonly name: string;
  readonly private: boolean;
  /** ISO time of the last push or update. */
  readonly updatedAt: string;
  /** Whether it carries the `stacki-app` topic, which marks a repository that publishes a Stacki app. */
  readonly stackiApp: boolean;
  /** Whether its owner is an organization: Share offers the organizations an account's repositories belong to. */
  readonly organization: boolean;
}

export interface AppReleaseAsset {
  readonly name: string;
  readonly sizeBytes: number;
}

export interface AppRelease {
  readonly tag: string;
  readonly name: string;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly assets: readonly AppReleaseAsset[];
}

/** Which asset of a release is the app: the one zip, or a choice among several, or none. */
export type AppAssetChoice =
  | { readonly kind: 'single'; readonly asset: AppReleaseAsset }
  | { readonly kind: 'choose'; readonly assets: readonly AppReleaseAsset[] }
  | { readonly kind: 'none' };

/** The app bundle candidates of a release: `.zip` assets within the archive bound. */
export function releaseAssetChoice(release: AppRelease): AppAssetChoice {
  const zips = release.assets.filter((asset) => ASSET_NAME.test(asset.name) && asset.sizeBytes <= APP_LIMITS.archiveBytesMax);
  assert(zips.length <= release.assets.length, 'Candidates come from the release');
  const only = zips[0];
  if (zips.length === 1 && only !== undefined) {
    return { kind: 'single', asset: only };
  }
  return zips.length === 0 ? { kind: 'none' } : { kind: 'choose', assets: zips };
}

/** Releases newest first, by publication time; ties keep GitHub's order. */
export function orderReleases(releases: readonly AppRelease[]): readonly AppRelease[] {
  const ordered = releases
    .map((release, index) => ({ release, index, time: Date.parse(release.publishedAt) }))
    .sort((left, right) => (right.time || 0) - (left.time || 0) || left.index - right.index)
    .map((entry) => entry.release);
  assert(ordered.length === releases.length, 'Ordering keeps every release');
  return ordered;
}

function isoTime(input: unknown, what: string): string {
  const value = text(input);
  if (value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new Error(`${what} must be an ISO date`);
  }
  return value;
}

export function parseAppRepositories(input: unknown): readonly AppRepository[] {
  const items = toArray(input);
  if (items === undefined || items.length > APP_GITHUB_CHOICE_LIMITS.repositoriesMax) {
    throw new Error('Expected a bounded list of repositories');
  }
  return items.map((item) => {
    const value = record(item);
    const source = parseGitHubSource({ owner: value['owner'], repository: value['name'], asset: 'app.zip' });
    if (typeof value['private'] !== 'boolean') {
      throw new Error('A repository says whether it is private');
    }
    if (typeof value['stackiApp'] !== 'boolean') {
      throw new Error('A repository says whether it carries the stacki-app topic');
    }
    return {
      owner: source.owner,
      name: source.repository,
      private: value['private'],
      updatedAt: isoTime(value['updatedAt'], 'updatedAt'),
      stackiApp: value['stackiApp'],
      // A main process from before Share sends no owner kind: read as a personal repository.
      organization: value['organization'] === true,
    };
  });
}

export function parseAppReleases(input: unknown): readonly AppRelease[] {
  const items = toArray(input);
  if (items === undefined || items.length > APP_GITHUB_CHOICE_LIMITS.releasesMax) {
    throw new Error('Expected a bounded list of releases');
  }
  return items.map((item) => {
    const value = record(item);
    const assets = toArray(value['assets']);
    if (assets === undefined || assets.length > APP_GITHUB_CHOICE_LIMITS.assetsMax) {
      throw new Error('Expected a bounded list of assets');
    }
    if (typeof value['prerelease'] !== 'boolean') {
      throw new Error('A release says whether it is a pre-release');
    }
    return {
      tag: boundedText(value['tag'], APP_LIMITS.tagCharsMax, 'Release tag'),
      name: typeof value['name'] === 'string' ? value['name'].slice(0, APP_LIMITS.nameCharsMax * 2) : '',
      publishedAt: isoTime(value['publishedAt'], 'publishedAt'),
      prerelease: value['prerelease'],
      assets: assets.map((asset) => {
        const fields = record(asset);
        const sizeBytes = fields['sizeBytes'];
        if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
          throw new Error('An asset has a size');
        }
        return { name: boundedText(fields['name'], APP_LIMITS.assetNameCharsMax * 2, 'Asset name'), sizeBytes };
      }),
    };
  });
}

/** A release tag as the chooser sends it. */
export function parseReleaseTag(input: unknown): string {
  return boundedText(input, APP_LIMITS.tagCharsMax, 'Release tag');
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

/** Parses the lockfile's text; a missing file is `EMPTY_APPS_LOCK` at the reader. */
export function parseAppsLockSource(source: string): AppsLock {
  if (source.length > APP_LIMITS.lockBytesMax) {
    throw new Error(`${APPS_LOCK_FILE} exceeds ${APP_LIMITS.lockBytesMax} bytes`);
  }
  return parseAppsLock(JSON.parse(source) as unknown);
}

export function parseAppsLock(input: unknown): AppsLock {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Apps lockfile version must be 1');
  }
  const items = toArray(value['apps']);
  if (items === undefined) {
    throw new Error('Apps lockfile needs an apps list');
  }
  if (items.length > APP_LIMITS.appsMax) {
    throw new Error(`A project has at most ${APP_LIMITS.appsMax} apps`);
  }
  const apps = items.map(parseLockEntry);
  const ids = new Set(apps.map((app) => app.id));
  if (ids.size !== apps.length) {
    throw new Error('An app is listed twice in the lockfile');
  }
  return { version: 1, apps };
}

/** The lockfile as the Installed list reads it: every entry that parses, and why the others do not. */
export interface AppsLockReading {
  readonly lock: AppsLock;
  /** Each entry that does not parse, or is listed twice, by its app id: only that app's row is broken. */
  readonly entryFailures: ReadonlyMap<string, string>;
  /** Why the file as a whole, or an entry with no readable id, cannot be read; undefined when it reads. */
  readonly fileFailure: string | undefined;
}

export const EMPTY_APPS_LOCK_READING: AppsLockReading = { lock: EMPTY_APPS_LOCK, entryFailures: new Map(), fileFailure: undefined };

/**
 * The lockfile's text read one entry at a time, for listing. `parseAppsLockSource`
 * refuses the whole file on one bad entry, which is right before a write; a list
 * instead keeps every good entry, so one app's bad record breaks that app's row
 * and never the others.
 */
export function readAppsLockEntries(source: string): AppsLockReading {
  let input: unknown;
  try {
    if (source.length > APP_LIMITS.lockBytesMax) {
      throw new Error(`${APPS_LOCK_FILE} exceeds ${APP_LIMITS.lockBytesMax} bytes`);
    }
    input = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    return { ...EMPTY_APPS_LOCK_READING, fileFailure: `${APPS_LOCK_FILE} cannot be read: ${appsFailureMessage(error)}` };
  }
  const items = lockItems(input);
  if (items === undefined) {
    return { ...EMPTY_APPS_LOCK_READING, fileFailure: `${APPS_LOCK_FILE} is not a version 1 lockfile of at most ${APP_LIMITS.appsMax} apps` };
  }
  const apps = new Map<string, AppLockEntry>();
  const entryFailures = new Map<string, string>();
  const unnamed: string[] = [];
  for (const item of items) {
    const id = lockEntryId(item);
    let entry: AppLockEntry;
    try {
      entry = parseLockEntry(item);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Assertion failed')) {
        throw error; // A broken invariant is a bug, not a bad record (AGENTS.md §3).
      }
      if (id === undefined) {
        unnamed.push(appsFailureMessage(error));
      } else {
        entryFailures.set(id, `Its entry in ${APPS_LOCK_FILE} is invalid: ${appsFailureMessage(error)}`);
      }
      continue;
    }
    if (apps.has(entry.id)) {
      apps.delete(entry.id);
      entryFailures.set(entry.id, `${APPS_LOCK_FILE} lists this app twice`);
    } else if (!entryFailures.has(entry.id)) {
      apps.set(entry.id, entry);
    }
  }
  assert(apps.size + entryFailures.size + unnamed.length <= items.length, 'Every lock entry is read at most once');
  const fileFailure =
    unnamed.length === 0 ? undefined : `${APPS_LOCK_FILE} has an entry with no valid id: ${unnamed[0] ?? ''}`.slice(0, APP_LIMITS.messageCharsMax);
  return { lock: { version: 1, apps: [...apps.values()] }, entryFailures, fileFailure };
}

// The entries of a version 1 lockfile within the app bound; undefined for any other shape.
function lockItems(input: unknown): readonly unknown[] | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (Reflect.get(input, 'version') !== 1) {
    return undefined;
  }
  const items = toArray(Reflect.get(input, 'apps'));
  if (items === undefined) {
    return undefined;
  }
  return items.length <= APP_LIMITS.appsMax ? items : undefined;
}

// An entry's app id when it has a valid one, for naming the row its failure breaks.
function lockEntryId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  try {
    return parseAppId(Reflect.get(item, 'id'));
  } catch {
    return undefined;
  }
}

export function parseLockEntry(input: unknown): AppLockEntry {
  const value = record(input);
  const installedAt = text(value['installedAt']);
  if (installedAt.length > 40 || Number.isNaN(Date.parse(installedAt))) {
    throw new Error('installedAt must be an ISO date');
  }
  // JSON written by an older reader may say absence with null (docs/contracts.md, IPC).
  const update = value['update'] === undefined || value['update'] === null ? undefined : parseAvailableUpdate(value['update']);
  const id = parseAppId(value['id']);
  const source = parseInstallSource(value['source']);
  if (source.kind === 'marketplace' && source.id !== id) {
    throw new Error(`The lock entry "${id}" names the marketplace app "${source.id}"`);
  }
  return {
    id,
    version: parseAppVersion(value['version']),
    sha256: parseSha256(value['sha256']),
    installedAt,
    source,
    update,
    // Lockfiles written before the switch existed read as off, the safe default.
    autoUpdate: parseAutoUpdate(value['autoUpdate']),
  };
}

function parseAutoUpdate(input: unknown): boolean {
  if (input === undefined || input === null) {
    return false;
  }
  if (typeof input !== 'boolean') {
    throw new Error('autoUpdate must be true or false');
  }
  return input;
}

export function parseInstallSource(input: unknown): AppInstallSource {
  const value = record(input);
  if (value['kind'] === 'file') {
    return { kind: 'file', fileName: boundedText(value['fileName'], APP_LIMITS.assetNameCharsMax, 'File name') };
  }
  if (value['kind'] === 'github') {
    return { ...parseGitHubSource(value), tag: boundedText(value['tag'], APP_LIMITS.tagCharsMax, 'Release tag') };
  }
  if (value['kind'] === 'marketplace') {
    return { kind: 'marketplace', id: parseAppId(value['id']), version: parseAppVersion(value['version']) };
  }
  if (value['kind'] === 'local') {
    return { kind: 'local' };
  }
  throw new Error('An install source is "file", "github", "marketplace" or "local"');
}

function parseAvailableUpdate(input: unknown): AppAvailableUpdate {
  const value = record(input);
  return {
    version: parseAppVersion(value['version']),
    tag: boundedText(value['tag'], APP_LIMITS.tagCharsMax, 'Release tag'),
    sha256: parseSha256(value['sha256']),
  };
}

/** The lockfile's text: stable order, two-space indent, checked by its own parser first. */
export function serializeAppsLock(lock: AppsLock): string {
  const checked = parseAppsLock(JSON.parse(JSON.stringify(lock)) as unknown);
  assert(checked.apps.length === lock.apps.length, 'Serializing never drops apps');
  const sorted = [...checked.apps].sort((left, right) => (left.id < right.id ? -1 : 1));
  const source = `${JSON.stringify({ version: 1, apps: sorted }, undefined, 2)}\n`;
  assert(source.length <= APP_LIMITS.lockBytesMax, 'A serialized lockfile stays inside its bound');
  return source;
}

// ---------------------------------------------------------------------------
// Wire values
// ---------------------------------------------------------------------------

export function parseAppSummary(input: unknown): AppSummary {
  const value = record(input);
  const manifest = parseAppManifest(value['manifest']);
  const lock = parseLockEntry(value['lock']);
  if (manifest.id !== lock.id) {
    throw new Error('An app summary pairs one app’s manifest and lock entry');
  }
  return { manifest, lock };
}

export function parseAppSummaries(input: unknown): readonly AppSummary[] {
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('Expected a list of apps');
  }
  if (items.length > APP_LIMITS.appsMax) {
    throw new Error('Too many apps');
  }
  return items.map(parseAppSummary);
}

export function parseAppStaged(input: unknown): AppStaged {
  const value = record(input);
  const sizeBytes = value['sizeBytes'];
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > APP_LIMITS.archiveBytesMax) {
    throw new Error('A staged bundle has a bounded positive size');
  }
  const token = text(value['token']);
  if (!/^[0-9a-f]{32}$/.test(token)) {
    throw new Error('A staged bundle token is 32 hex characters');
  }
  return {
    token,
    manifest: parseAppManifest(value['manifest']),
    sha256: parseSha256(value['sha256']),
    sizeBytes,
    source: parseInstallSource(value['source']),
    replaces: value['replaces'] === undefined ? undefined : parseAppVersion(value['replaces']),
  };
}

export function parseStagedToken(input: unknown): string {
  const token = text(input);
  if (!/^[0-9a-f]{32}$/.test(token)) {
    throw new Error('A staged bundle token is 32 hex characters');
  }
  return token;
}

export function parseAppUpdateOutcome(input: unknown): AppUpdateOutcome {
  const value = record(input);
  const id = parseAppId(value['id']);
  switch (value['kind']) {
    case 'current':
      return { kind: 'current', id };
    case 'available':
      return { kind: 'available', id, version: parseAppVersion(value['version']) };
    case 'failed':
      return { kind: 'failed', id, message: boundedText(value['message'], APP_LIMITS.messageCharsMax, 'Failure message') };
    case 'updated':
      return { kind: 'updated', id, version: parseAppVersion(value['version']) };
    default:
      throw new Error('Unknown update outcome');
  }
}

/** An `AppsResult` reply, its value checked by `parse`. */
export function parseAppsResult<T>(input: unknown, parse: (value: unknown) => T): AppsResult<T> {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true, value: parse(value['value']) };
  }
  if (value['ok'] === false) {
    return { ok: false, message: boundedText(value['message'], APP_LIMITS.messageCharsMax, 'Failure message') };
  }
  throw new Error('An apps result says ok');
}

export function parseUpdateOutcomes(input: unknown): readonly AppUpdateOutcome[] {
  const items = toArray(input);
  if (items === undefined || items.length > APP_LIMITS.appsMax) {
    throw new Error('Expected a bounded list of update outcomes');
  }
  return items.map(parseAppUpdateOutcome);
}

/** A failure message, cut to the bound the wire allows. */
export function appsFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = (message.trim() || 'The app operation failed.').slice(0, APP_LIMITS.messageCharsMax);
  assert(bounded.length > 0, 'A failure message is never empty');
  return bounded;
}
