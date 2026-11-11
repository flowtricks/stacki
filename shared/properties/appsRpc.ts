// The Stacki Apps RPC: what an app's sandboxed frame may say to Stacki, and what
// Stacki says back (docs/apps.md, "API reference"). Every message is a plain
// structured-clone object; this module parses each one at the boundary, names
// every method and event an app may use, and bounds every list, string and
// overlay description. Desktop and Studio host the same protocol, so an app sees
// one API whichever editor runs it.
//
// Versioned: `v` is APP_API_VERSION. A later version adds methods and fields; an
// app that sends a newer `v` than the host speaks gets `unsupported-version`.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { parseAppId } from './apps';
import { parseAppFileContent, parseFilePathShape } from './appFiles';
import { parseAppPermissionId } from './appPermissions';
import { parseAuthProviderId, type AppAuthStatus } from './appAuth';
import { parseAppNetRequest } from './appNet';
import { parseAppStorageKey, parseAppStorageScope, parseAppStorageValue, type AppStorageScope } from './appStorage';
import { APP_SHORTCUTS, parseAppCommands, parseCommandShortcut, parseShortcutClaims, type AppReservedShortcut } from './appShortcuts';
import type { AppThemeView } from './appUiKit';
import { CANVAS_HIGHLIGHT_STYLES, CANVAS_OUTLINE_MODES, type CanvasHighlightStyle, type CanvasOutlineMode } from './deepOutline';

export { APP_SHORTCUTS, type AppShortcut } from './appShortcuts';
export type { AppStorageScope } from './appStorage';

export const APP_API_VERSION = 1;

export const APP_RPC_LIMITS = {
  /** Requests an app may have unanswered at once; more are answered `busy`. */
  requestsInFlightMax: 32,
  /** A request id: a positive safe integer the app chooses. */
  methodCharsMax: 64,
  /** Events one subscription call may name. */
  subscriptionsMax: 16,
  /** Items in one overlay description. */
  overlayItemsMax: 64,
  /**
   * Distinct elements one app's overlay may anchor to: each is measured on every frame.
   * Raised from 16 to the item bound (64): a page of 30 pinned comments is ordinary, and
   * labels too close together now collapse into one count bubble, so the drawing stays
   * legible. The measuring is one getBoundingClientRect per anchor per frame, the same
   * work a selected loop's outline already does for each of its copies.
   */
  overlayAnchorsMax: 64,
  /** How near two anchored labels' points may be, in overlay-layer pixels, before they collapse into one count bubble. */
  clusterRadiusPx: 24,
  /**
   * How far a press on a `draggable` overlay item moves, in overlay-layer pixels, before it is a
   * drag (`overlay.drag`) rather than a click: about the slop of a hand on a trackpad, so a
   * click on a pin stays a click.
   */
  dragThresholdPx: 4,
  /** What the capture chip says for an app (`canvas.capture`'s `reason`): a short instruction, not a paragraph. */
  captureReasonCharsMax: 60,
  /** An image cursor (`canvas.capture`'s `cursor.image`): a small PNG or SVG, so it costs nothing to send the canvas. */
  cursorImageBytesMax: 4096,
  /** An image cursor's width and height: browsers draw no larger cursor, and fall back silently when it is. */
  cursorImagePxMax: 32,
  /**
   * How long `page.open`, `component.open` and `canvas.scrollTo` wait for the editor to open the file
   * or the canvas to draw the element: a cold dev server renders a page in a second or two.
   */
  navigateTimeoutMs: 5000,
  /** `canvas.snapshot`'s PNG, as bytes: a comment's thumbnail, not a screenshot archive. */
  snapshotBytesMax: 200 * 1024,
  /** `canvas.snapshot`'s widest image, and the default `widthMax`. */
  snapshotWidthPxMax: 800,
  snapshotWidthPxDefault: 320,
  /** Snapshots one app may take: one per this interval, since each photographs the window. */
  snapshotIntervalMs: 1000,
  /** Boxes `node.measure` answers with: one per place the element renders. */
  measureRectsMax: 500,
  /** How long `node.measure` waits for the canvas to measure an element it was not already measuring. */
  measureTimeoutMs: 1000,
  /** Elements `node.measure` may be waiting on at once, across apps; more answer at once with what is known. */
  measureRequestsMax: 16,
  /** Pages and components `page.getTree` and `page.findByAttribute` may read in a project. */
  indexFilesMax: 2000,
  /** Bytes one `page.getTree` or `page.findByAttribute` call may read from disk; files the cache already holds cost nothing. */
  indexBytesReadMax: 32 * 1024 * 1024,
  /** Matches `page.findByAttribute` answers with at most, and its default `limit`. */
  attributeMatchesMax: 500,
  /** A durable node key (`node.key`): `k` and 12 lowercase letters or digits as Stacki mints them. */
  nodeKeyCharsMax: 32,
  /**
   * Layers one canvas click names (`layers`), and steps one node ref holds: each is a component
   * instance inside the one before, and a site nested deeper than this has lost its way.
   */
  nodeLayersMax: 32,
  /** Which copy a node ref step names inside the step before it: a loop renders at most this many. */
  nodeCopyMax: 100_000,
  /** A project path `page.getTree` names. */
  pathCharsMax: 512,
  /** Overlay frames per app: each is a whole sandboxed document. */
  overlayFramesMax: 2,
  /** Cells in one heat map. */
  heatCellsMax: 1024,
  labelCharsMax: 120,
  /** A pin's label: a number or initials, which fit the 24px badge. Counted in characters as a person reads them (code points). */
  pinLabelCharsMax: 3,
  /** A pin's avatar address: a profile picture URL, never a data payload. */
  pinAvatarURLCharsMax: 2048,
  /** A notification's text. */
  notifyCharsMax: 280,
  /** An attribute name or class name an edit writes. */
  nameCharsMax: 128,
  /** An attribute value or inline style an edit writes. */
  valueCharsMax: 4096,
  /** Nodes a page tree reply carries. */
  treeNodesMax: 5000,
  /** Depth of a page tree reply. */
  treeDepthMax: 64,
  /** Text a node view carries. */
  nodeTextCharsMax: 500,
  /**
   * Attributes (an element) or props (a component) one `node.insert` gives the new node: a
   * starting point for the node, not a page's worth of markup.
   */
  insertAttributesMax: 32,
  /** A canvas coordinate, in CSS pixels. */
  coordinatePxMax: 1_000_000,
  /** How long Stacki waits on an override: a person is choosing in the app's picker. Past it, Stacki's own picker opens. */
  overrideTimeoutMs: 5 * 60_000,
  /** Override requests one app may have unanswered at once; past it, Stacki's own picker answers. */
  overrideCallsMax: 4,
  /** Registrations one override point may queue: one per app frame at most (appsRuntime.ts FRAMES_MAX). */
  overrideQueueMax: 64,
  /** Data paths an override context offers, breadth first. */
  overridePathsMax: 500,
  /** A data path a binding override answers with. */
  bindingPathCharsMax: 512,
  /** A URL or project path an asset override answers with. */
  assetURLCharsMax: 2048,
  /** Alt text an asset override answers with. */
  altCharsMax: 500,
  /** Custom frames (`ui.openFrame`) one app may have open at once: each is a whole sandboxed document. */
  customFramesMax: 2,
  /** A custom frame's size, in CSS pixels. */
  frameWidthPxMin: 240,
  frameWidthPxMax: 1600,
  frameHeightPxMin: 160,
  frameHeightPxMax: 1200,
  /** An edit's undo label (`label`), as History and the undo toast show it: about one short phrase. */
  undoLabelCharsMax: 60,
  /** A rail badge's count (`app.badge`); the rail draws 99+ past 99. */
  badgeCountMax: 9999,
  /** Project paths one `project.change` names; past it, `paths` is left out, meaning many. */
  changePathsMax: 64,
  /**
   * The text of one `overlay.post` message, either way between an app and its overlay frame: the
   * state a small control shows (a JSON string of a model's angles, a pin's thread), not a file.
   */
  overlayMessageCharsMax: 64 * 1024,
  /** People `people.list` answers with at most: a team's role members and the authors of recent commits. */
  peopleMax: 200,
  /** Text `clipboard.write` copies: a link, a snippet or a page of notes, not a file. */
  clipboardCharsMax: 256 * 1024,
} as const satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// Values the API speaks in
// ---------------------------------------------------------------------------

/** The left panels an app can open, by their role feature names (shared/properties/projectRoles.ts). */
export const APP_LEFT_PANELS = [
  'pages',
  'navigator',
  'properties',
  'components',
  'assets',
  'cms',
  'variables',
  'selectors',
  'code',
  'history',
  'apps',
  'instructions',
  'audits',
  'ai',
] as const;
export type AppLeftPanel = (typeof APP_LEFT_PANELS)[number];
export const APP_RIGHT_PANELS = ['style', 'settings'] as const;
export type AppRightPanel = (typeof APP_RIGHT_PANELS)[number];
export const APP_DEVICES = ['desktop', 'tablet', 'phone'] as const;
export type AppDevice = (typeof APP_DEVICES)[number];
export const APP_CHANGE_SOURCES = ['page', 'styles', 'cms', 'assets', 'files'] as const;
export type AppChangeSource = (typeof APP_CHANGE_SOURCES)[number];

/**
 * The Stacki actions an app may answer instead of Stacki's own UI while it runs
 * (docs/apps.md, "Overrides"). `assets.pick` is every "Choose image…" button;
 * `cms.bind` is the data picker a field's dot and a loop's Source open.
 */
export const APP_OVERRIDE_POINTS = ['assets.pick', 'cms.bind'] as const;
export type AppOverridePoint = (typeof APP_OVERRIDE_POINTS)[number];
export const APP_MEDIA_KINDS = ['image', 'video', 'audio', 'file'] as const;
export type AppMediaKind = (typeof APP_MEDIA_KINDS)[number];

/** What each override point tells the app about the request. */
export interface AppOverrideContexts {
  readonly 'assets.pick': {
    /** The element whose field asked; undefined for a field that is not an element's (a CMS entry, a background). */
    readonly nodeId: string | undefined;
    /** The prop or attribute the field writes (`src`, `poster`), when it knows. */
    readonly field: string | undefined;
    readonly accepts: readonly AppMediaKind[];
    /** The field's value now; empty when it is unset. */
    readonly current: string;
    /** Whether the field takes an `https://` URL; when false, answer with a project path. */
    readonly acceptsURL: boolean;
  };
  readonly 'cms.bind': {
    /** A field's value (the dot beside it), or what a loop goes over. */
    readonly purpose: 'field' | 'loop-source';
    /** The path bound now, when there is one. */
    readonly current: string | undefined;
    /** The paths Stacki's own picker offers, breadth first, up to APP_RPC_LIMITS.overridePathsMax. */
    readonly paths: readonly string[];
    /** The selected element: the one the Settings and Properties panels edit. */
    readonly selection: string | undefined;
  };
}

/** Stacki opens its own picker, or nothing happens. */
export type AppOverrideFallback = { readonly kind: 'default' } | { readonly kind: 'cancel' };

/** What an app may answer at each point. */
export interface AppOverrideResults {
  readonly 'assets.pick': { readonly kind: 'picked'; readonly url: string; readonly alt: string | undefined } | AppOverrideFallback;
  readonly 'cms.bind': { readonly kind: 'picked'; readonly path: string } | AppOverrideFallback;
}

/** A request at one point, as Stacki asks it. */
export type AppOverrideRequest = { readonly [P in AppOverridePoint]: { readonly point: P; readonly context: AppOverrideContexts[P] } }[AppOverridePoint];
/** An answer at one point. */
export type AppOverrideAnswer = { readonly [P in AppOverridePoint]: { readonly point: P; readonly result: AppOverrideResults[P] } }[AppOverridePoint];

/** The answer that opens Stacki's own picker, at any point. */
export function defaultAnswer(point: AppOverridePoint): AppOverrideAnswer {
  return fallbackAnswer(point, { kind: 'default' });
}

/** A `default` or `cancel` answer at `point`. */
export function fallbackAnswer(point: AppOverridePoint, fallback: AppOverrideFallback): AppOverrideAnswer {
  switch (point) {
    case 'assets.pick':
      return { point, result: fallback };
    case 'cms.bind':
      return { point, result: fallback };
    default: {
      const exhaustive: never = point;
      return exhaustive;
    }
  }
}

/** A custom frame an app opened (`ui.openFrame`): one of its own pages, in a modal or a popup. */
export interface AppOpenFrame {
  readonly page: string;
  readonly width: number;
  readonly height: number;
  readonly modal: boolean;
  /** Text the frame reads back from `app.info` (a JSON string, an override's call id). */
  readonly data: string | undefined;
}

/** What `app.info` tells a custom frame about itself. */
export interface AppFrameInfo {
  readonly id: string;
  readonly data: string | undefined;
}

/** A rectangle in the canvas viewport, in the page's CSS pixels (before the canvas's zoom); it stays put as the page scrolls. */
export interface AppRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AppViewport {
  /** The canvas's CSS width, the page's own layout width. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** How far the canvas is zoomed to fit (1 is 100%). */
  readonly scale: number;
  readonly device: AppDevice | 'custom' | 'canvas';
}

/** One element of the open page, as an app reads it. */
export interface AppNodeView {
  readonly id: string;
  readonly kind: string;
  /** The tag (`section`) or component name (`Card`); empty for text and expressions. */
  readonly name: string;
  readonly classes: readonly string[];
  /** Attributes written as plain strings; expressions and spreads are left out. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly text: string | undefined;
  readonly children: readonly AppNodeView[];
}

export interface AppPageView {
  /** The open file, relative to the project. */
  readonly path: string;
  readonly editable: boolean;
  readonly nodes: readonly AppNodeView[];
  /** Whether the tree was cut at APP_RPC_LIMITS.treeNodesMax. */
  readonly truncated: boolean;
}

export interface AppPageSummary {
  readonly path: string;
  readonly route: string;
  readonly title: string | undefined;
}

export interface AppSelection {
  readonly nodeId: string | undefined;
}

export interface AppRoleView {
  readonly id: string;
  readonly name: string;
  readonly isAdmin: boolean;
  /**
   * The calling app's own permissions (its manifest's `permissions`), resolved for
   * this role: every one true for admin, every one false for a role that may not
   * use the app, else the admin's choice or the default. Signals the app enforces itself.
   */
  readonly permissions: Readonly<Record<string, boolean>>;
}

export type AppEditOutcome = { readonly applied: true } | { readonly applied: false; readonly reason: string };

/**
 * What `node.insert` answers: the new node's id, as `node.get` and the selection name it on the
 * open page once the insert resolves, or why nothing was inserted. The id is undefined only when
 * the host cannot tell which node the insert made (Studio, when its server named none).
 */
export type AppInsertOutcome = { readonly applied: true; readonly nodeId: string | undefined } | { readonly applied: false; readonly reason: string };

/** What `canvas.snapshot` answers: a PNG of the element as the canvas draws it, or why not. */
export type AppSnapshotOutcome =
  { readonly applied: true; readonly url: string; readonly width: number; readonly height: number } | { readonly applied: false; readonly reason: string };

/**
 * Who is using the editor (`person.get`, docs/apps.md "The person"). The id is
 * always there; the rest is undefined when unknown, or when the person chose to
 * hide their details from apps.
 */
export interface AppPerson {
  /** Stable for this person in this project, and the same from any app: group their work without knowing more. */
  readonly id: string;
  /** Git's `user.name` for the project. */
  readonly name: string | undefined;
  /** Git's `user.email` for the project. */
  readonly email: string | undefined;
  /** The GitHub account signed in for publishing (Studio: the session's account). */
  readonly github: string | undefined;
}

export const APP_PERSON_LIMITS = {
  /** A person id: hex of a SHA-256 prefix. */
  idChars: 32,
  /** A Git name or email as an app reads it. */
  detailCharsMax: 256,
} as const satisfies Record<string, number>;

/** A person as it crosses a process or the network; the id's form and each detail's bound are held here. */
export function parseAppPerson(input: unknown): AppPerson {
  const value = record(input);
  const id = text(value['id']);
  if (id.length !== APP_PERSON_LIMITS.idChars || !/^[0-9a-f]+$/.test(id)) {
    throw new Error('A person id is 32 hex characters');
  }
  const detail = (field: string): string | undefined => {
    const raw = value[field];
    if (raw === undefined) {
      return undefined;
    }
    return boundedLabel(raw, APP_PERSON_LIMITS.detailCharsMax, field);
  };
  const github = detail('github');
  if (github !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(github)) {
    throw new Error('github is a GitHub login');
  }
  return { id, name: detail('name'), email: detail('email'), github };
}

/** A commit author as Git records it, before `people.list` decides what of them an app hears. */
export interface AppCommitAuthor {
  readonly name: string | undefined;
  readonly email: string | undefined;
}

/**
 * The people an app may mention (`people.list`), from the role members (GitHub
 * logins) and recent commit authors, in that order, each once, at most
 * APP_RPC_LIMITS.peopleMax. An author whose email is a member's GitHub noreply
 * address is that member. While `hidden`, the person using the editor hides
 * details from apps, so only logins and their pictures are listed: authors known
 * by name and email alone are left out. `avatar` is the login's picture
 * (shared/ipc/commitAvatars.ts githubLoginAvatar), passed in so this contract
 * imports no picture rules.
 */
export function appMembers(input: {
  readonly roleMembers: readonly string[];
  readonly authors: readonly AppCommitAuthor[];
  readonly hidden: boolean;
  readonly avatar: (login: string) => string | undefined;
}): readonly AppMember[] {
  const members: AppMember[] = [];
  const logins = new Set<string>();
  const emails = new Set<string>();
  for (const login of input.roleMembers) {
    if (members.length >= APP_RPC_LIMITS.peopleMax) {
      break;
    }
    if (!GITHUB_LOGIN.test(login) || logins.has(login.toLowerCase())) {
      continue;
    }
    logins.add(login.toLowerCase());
    members.push({ login, name: undefined, email: undefined, avatarURL: input.avatar(login) });
  }
  for (const author of input.authors) {
    if (members.length >= APP_RPC_LIMITS.peopleMax) {
      break;
    }
    const email = author.email?.toLowerCase();
    const login = email === undefined ? undefined : noreplyLogin(email);
    const known = (login !== undefined && logins.has(login.toLowerCase())) || (email !== undefined && emails.has(email));
    if (known) {
      continue;
    }
    if (input.hidden) {
      // Only what a login already shows in public: no name, no email.
      if (login !== undefined) {
        logins.add(login.toLowerCase());
        members.push({ login, name: undefined, email: undefined, avatarURL: input.avatar(login) });
      }
      continue;
    }
    if (author.name === undefined && email === undefined) {
      continue;
    }
    if (email !== undefined) {
      emails.add(email);
    }
    if (login !== undefined) {
      logins.add(login.toLowerCase());
    }
    members.push({
      login,
      name: boundedDetail(author.name),
      email: boundedDetail(author.email),
      avatarURL: login === undefined ? undefined : input.avatar(login),
    });
  }
  assert(members.length <= APP_RPC_LIMITS.peopleMax, 'people.list is bounded');
  assert(!input.hidden || members.every((member) => member.name === undefined && member.email === undefined), 'Hidden details stay hidden');
  return members;
}

/** `people.list`'s answer as it crosses a process or the network. */
export function parseAppMembers(input: unknown): readonly AppMember[] {
  const list = toArray(input);
  if (list === undefined) {
    throw new Error('people is a list');
  }
  if (list.length > APP_RPC_LIMITS.peopleMax) {
    throw new Error(`people lists at most ${APP_RPC_LIMITS.peopleMax}`);
  }
  return list.map((entry): AppMember => {
    const value = record(entry);
    const optional = (field: string): string | undefined =>
      value[field] === undefined ? undefined : boundedLabel(value[field], APP_PERSON_LIMITS.detailCharsMax, field);
    const login = optional('login');
    if (login !== undefined && !GITHUB_LOGIN.test(login)) {
      throw new Error('login is a GitHub login');
    }
    const avatarURL = optional('avatarURL');
    if (avatarURL !== undefined && !/^https:\/\/(?:avatars\.githubusercontent\.com|github\.com)\//.test(avatarURL)) {
      throw new Error('avatarURL is a GitHub picture');
    }
    return { login, name: optional('name'), email: optional('email'), avatarURL };
  });
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// `12345+login@users.noreply.github.com` or `login@users.noreply.github.com`: the login GitHub wrote.
function noreplyLogin(email: string): string | undefined {
  const login = /^(?:\d{1,12}\+)?([^@\s]+)@users\.noreply\.github\.com$/.exec(email)?.[1];
  return login !== undefined && GITHUB_LOGIN.test(login) ? login : undefined;
}

function boundedDetail(detail: string | undefined): string | undefined {
  const trimmed = detail?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed.slice(0, APP_PERSON_LIMITS.detailCharsMax);
}

/** The editor an app runs in. */
export const APP_HOST_KINDS = ['desktop', 'studio'] as const;
export type AppHostKind = (typeof APP_HOST_KINDS)[number];

/**
 * What a host can do for apps, by method family (`app.info`'s `can`). Each host
 * answers from its commands' own abilities (appRpcHost.ts AppHostAbility): the
 * same value the method reads before it answers `applied: false`, so `can` and
 * the answer cannot disagree.
 */
export const APP_CAPABILITIES = [
  'setAttribute',
  'addClass',
  'setStyle',
  'insertElement',
  'insertAttributes',
  'insertReplace',
  'openPalette',
  'undo',
  'setWidth',
  'scrollTo',
  'snapshot',
] as const;
export type AppCapability = (typeof APP_CAPABILITIES)[number];
export type AppCapabilities = { readonly [C in AppCapability]: boolean };

/** What `app.info` answers. */
export interface AppInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly frame: AppFrameInfo | undefined;
  readonly shortcutClaims: readonly string[];
  readonly host: { readonly kind: AppHostKind; readonly version: string };
  readonly can: AppCapabilities;
}

/** Whether a change came from the app that hears it (`self`) or from anything else. */
export type AppChangeOrigin = 'self' | 'other';

/** A point within an element's box: x and y each run 0 (left, top) to 1 (right, bottom). */
export interface AppPoint {
  readonly x: number;
  readonly y: number;
}

/** Where an overlay item sits: on an element (each place it renders, following scroll and resize), at a point within it, or on a viewport rectangle. */
export type AppOverlayAnchor =
  | { readonly nodeId: string; readonly occurrence: number | undefined; readonly at: AppPoint | undefined }
  | { readonly ref: AppNodeRef; readonly at: AppPoint | undefined }
  | { readonly rect: AppRect };

/** The named cursors the canvas can show while an app captures its clicks (`canvas.capture`). */
export const APP_CANVAS_CURSORS = ['crosshair', 'default'] as const;
export type AppCanvasCursorName = (typeof APP_CANVAS_CURSORS)[number];

/** Where an image cursor points, in its own pixels from the top left: 0 to cursorImagePxMax − 1 each way. */
export interface AppCursorHotspot {
  readonly x: number;
  readonly y: number;
}

/** What `canvas.capture` asks for: a named cursor, or an image from the app's own bundle. */
export type AppCanvasCursorRequest = AppCanvasCursorName | { readonly image: string; readonly hotspot: AppCursorHotspot };

/**
 * The cursor the canvas shows while an app captures its clicks: a named one, or
 * the app's image after Stacki read it from the bundle and checked it, as a data
 * URL (src/features/apps/appCursorImage.ts).
 */
export type AppCanvasCursor = AppCanvasCursorName | { readonly url: string; readonly hotspot: AppCursorHotspot };

/** A click on the canvas while an app captures it: the element and the point within it, and the point in the canvas viewport. */
export interface AppCanvasClick {
  /** The element of the open page under the click; undefined over markup the open file does not own. */
  readonly nodeId: string | undefined;
  /** Where in that element's box, 0–1 each way; undefined when there is no element. */
  readonly at: AppPoint | undefined;
  /** In the canvas viewport, in the page's CSS pixels (before the canvas's zoom), as AppRect. */
  readonly x: number;
  readonly y: number;
  /**
   * Every element under the click through the component instances it sits in (docs/apps.md,
   * "Layers"): innermost first, ending at the open page's element. Empty when the canvas could
   * not say; at most APP_RPC_LIMITS.nodeLayersMax.
   */
  readonly layers: readonly AppNodeLayer[];
}

/**
 * One step of a node ref: an element of one file, and which rendered copy of it
 * sits inside the step before (0 unless a loop there renders it more than once).
 * A step names its element by `key`, by `nodeId`, or both; the key wins.
 */
export interface AppNodeRefStep {
  /** The page or component, relative to the project. */
  readonly file: string;
  /** Its id as `page.getTree` gives it for that file. */
  readonly nodeId: string | undefined;
  /** Its durable key (`node.key`), when it carries one: it survives every edit, where an id may not. */
  readonly key: string | undefined;
  readonly copy: number;
}

/**
 * An element anywhere on the canvas, inside component instances too (docs/apps.md,
 * "Node refs"): the open page's element first, then each element down to the one
 * meant. Two links a component renders in two instances are two refs.
 */
export interface AppNodeRef {
  readonly steps: readonly AppNodeRefStep[];
}

/** One layer of a canvas click: the element under it in one file. */
export interface AppNodeLayer {
  /** The page or component, relative to the project. */
  readonly file: string;
  /** Its id as `page.getTree` gives it for that file. */
  readonly nodeId: string;
  readonly key: string | undefined;
  /** The component's name when this layer is a component instance: it renders the layer before it. */
  readonly component: string | undefined;
  /** The instances this layer sits inside, the open page's element first: `ref`'s steps without its last. */
  readonly instancePath: readonly AppNodeRefStep[];
  /** This layer's element, for node.measure, overlay anchors, canvas.scrollTo, canvas.snapshot and node.find. */
  readonly ref: AppNodeRef;
}

/** An element as node.measure and canvas.snapshot name it: an id on the open page (one copy, or each), or a ref. */
export type AppNodeTarget = { readonly nodeId: string; readonly occurrence: number | undefined } | { readonly ref: AppNodeRef };

// The chip's text an app gives (`reason`): one line, trimmed, within its bound.
function captureReason(input: unknown): string {
  const reason = boundedLabel(input, APP_RPC_LIMITS.captureReasonCharsMax, 'reason').trim();
  if (reason.length === 0 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new Error('reason is one line of words');
  }
  return reason;
}

/**
 * How an app takes canvas clicks (`canvas.capture`'s `mode`): `capture` (the default) takes them
 * from the editor, which selects nothing; `observe` leaves every click to the editor and the app
 * hears single clicks too (docs/apps.md, "Observing clicks").
 */
export const APP_CAPTURE_MODES = ['capture', 'observe'] as const;
export type AppCaptureMode = (typeof APP_CAPTURE_MODES)[number];

/**
 * Why a capture started or ended (`canvas.capture`): the app's own call (`app`),
 * Escape (`escape`), or another app taking the canvas (`replaced`).
 */
export const APP_CAPTURE_REASONS = ['app', 'escape', 'replaced'] as const;
export type AppCaptureReason = (typeof APP_CAPTURE_REASONS)[number];

/** The canvas outline modes an app may set (`canvas.setOutlineMode`, docs/apps.md "Outline modes"). */
export const APP_OUTLINE_MODES = CANVAS_OUTLINE_MODES;
export type AppOutlineMode = CanvasOutlineMode;

/**
 * Why the outline mode changed (`canvas.outline`): the app's own call (`app`), the person
 * opening another panel (`panel`), another app taking the panel or the mode (`replaced`),
 * the project closing (`project`), or the app the person came back to getting the deep
 * mode it last asked for (`restored`).
 */
export const APP_OUTLINE_REASONS = ['app', 'panel', 'replaced', 'project', 'restored'] as const;
export type AppOutlineReason = (typeof APP_OUTLINE_REASONS)[number];

/** Who sent an `overlay.message`: the app's own frames, or its overlay frame item. */
export const APP_OVERLAY_MESSAGE_SENDERS = ['app', 'overlay'] as const;
export type AppOverlayMessageSender = (typeof APP_OVERLAY_MESSAGE_SENDERS)[number];

/** What `overlay.post` asks: a message, and the frame item it is for when an app sends it. */
export interface AppOverlayPost {
  readonly itemId: string | undefined;
  readonly data: string;
}

/**
 * One person an app may mention (`people.list`): a role member (a GitHub login
 * and its picture) or the author of a recent commit (Git's name and email), each
 * with no more than `person.get` would tell of them. While the person using the
 * editor hides their details from apps, only logins and pictures are listed.
 */
export interface AppMember {
  readonly login: string | undefined;
  readonly name: string | undefined;
  readonly email: string | undefined;
  /** The login's GitHub picture; undefined without a login. */
  readonly avatarURL: string | undefined;
}

/** The phases of one `overlay.drag`: one `start`, any number of `move`, one `end`. */
export const APP_DRAG_PHASES = ['start', 'move', 'end'] as const;
export type AppDragPhase = (typeof APP_DRAG_PHASES)[number];

/**
 * A drag of a `draggable` overlay item, to the app that drew it. The geometry is
 * `AppCanvasClick`'s, for the point under the pointer now. `cancelled` is true
 * only on an `end` that Escape, the app stopping, the item leaving the overlay
 * or a lost pointer cut short: put the item back where it was.
 */
export interface AppOverlayDrag extends AppCanvasClick {
  readonly itemId: string;
  readonly phase: AppDragPhase;
  readonly cancelled: boolean;
}

// The attribute `node.key` writes lives with the rule that hides it from every attribute list.
export { NODE_KEY_ATTRIBUTE } from '../core/internalAttributes';

export type AppNodeKeyOutcome = { readonly applied: true; readonly key: string } | { readonly applied: false; readonly reason: string };

/** One element carrying an attribute, somewhere in the project (`page.findByAttribute`). */
export interface AppAttributeMatch {
  /** The page or component, relative to the project. */
  readonly path: string;
  /** Its id as `page.getTree` gives it: the open page's own ids for the open page, otherwise the ids opening the file would give. */
  readonly nodeId: string;
  readonly value: string;
}

/** A pin's fill, one of the editor's own colours: the accent, green, grey or red. */
export const APP_PIN_TONES = ['accent', 'success', 'muted', 'danger'] as const;
export type AppPinTone = (typeof APP_PIN_TONES)[number];

export type AppOverlayItem =
  | {
      readonly kind: 'box';
      readonly id: string;
      readonly anchor: AppOverlayAnchor;
      readonly color: string | undefined;
      readonly fill: string | undefined;
      readonly label: string | undefined;
      readonly dashed: boolean;
      readonly interactive: boolean;
      /** Whether pressing and moving it sends `overlay.drag`; Stacki does not move it, the app redraws it. */
      readonly draggable: boolean;
    }
  | {
      readonly kind: 'label';
      readonly id: string;
      readonly anchor: AppOverlayAnchor;
      readonly text: string;
      readonly placement: 'top' | 'bottom' | 'center';
      readonly color: string | undefined;
      readonly background: string | undefined;
      readonly interactive: boolean;
      /** Whether pressing and moving it sends `overlay.drag`; a label collapsed into a count bubble is not draggable. */
      readonly draggable: boolean;
      /** Whether the label joins nearby anchored labels of its app in one count bubble (on by default). */
      readonly cluster: boolean;
    }
  | {
      /** A comment marker: a round badge whose tail points at the anchor point (docs/apps.md, "Pins"). */
      readonly kind: 'pin';
      readonly id: string;
      readonly anchor: AppOverlayAnchor;
      /** Up to APP_RPC_LIMITS.pinLabelCharsMax characters, such as a comment's number. */
      readonly label: string | undefined;
      readonly tone: AppPinTone;
      /** An https image shown in the badge on hover, such as the comment author's picture. */
      readonly avatarURL: string | undefined;
      /** Draws a ring: the pin's comment is open or selected. */
      readonly active: boolean;
      readonly interactive: boolean;
      readonly draggable: boolean;
      /** Whether the pin joins nearby anchored pins and labels of its app in one count bubble (on by default). */
      readonly cluster: boolean;
    }
  | {
      readonly kind: 'heat';
      readonly id: string;
      readonly anchor: AppOverlayAnchor;
      readonly columns: number;
      readonly rows: number;
      /** Row-major, each 0 to 1. */
      readonly values: readonly number[];
      readonly color: string | undefined;
    }
  | {
      readonly kind: 'frame';
      readonly id: string;
      readonly anchor: AppOverlayAnchor;
      /** A bundle HTML file, opened in its own sandboxed frame with the app's grants. */
      readonly path: string;
      /** Whether the frame takes the pointer; otherwise clicks pass through to the canvas. */
      readonly interactive: boolean;
    };

// ---------------------------------------------------------------------------
// Methods and events
// ---------------------------------------------------------------------------

type ParamsParser<T> = (input: unknown) => T;

const nothing: ParamsParser<undefined> = () => undefined;

/**
 * Every method and its params parser. Every app may call every method: apps are
 * first-party, limited only by the role (`app:<id>`) and these parsers.
 * The host's dispatcher (src/features/apps/appRpcHost.ts) maps each to the
 * command the UI itself runs.
 */
export const APP_METHODS = {
  'app.info': { params: nothing },
  'role.get': { params: nothing },
  /** Whether the current role has one of the calling app's own permissions; an id the manifest does not declare fails. */
  'role.can': { params: (input: unknown) => ({ permission: parseAppPermissionId(record(input)['permission']) }) },
  /** The app's settings as this person filled them in, secrets included (shared/properties/appSettings.ts). */
  'settings.get': { params: nothing },
  'events.subscribe': { params: parseEventList },
  'events.unsubscribe': { params: parseEventList },
  'canvas.getViewport': { params: nothing },
  'canvas.setDevice': { params: (input: unknown) => ({ device: oneOf(record(input)['device'], APP_DEVICES, 'device') }) },
  'canvas.setWidth': { params: (input: unknown) => ({ widthPx: integerIn(record(input)['widthPx'], 240, 6000, 'widthPx') }) },
  'canvas.scrollTo': { params: parseScrollTarget },
  'canvas.snapshot': {
    params: (input: unknown) => {
      const value = record(input);
      const widthMax = value['widthMax'];
      return {
        target: parseNodeTarget(value),
        widthMax: widthMax === undefined ? APP_RPC_LIMITS.snapshotWidthPxDefault : integerIn(widthMax, 16, APP_RPC_LIMITS.snapshotWidthPxMax, 'widthMax'),
      };
    },
  },
  'canvas.capture': {
    params: (input: unknown) => {
      const value = record(input);
      return {
        on: requiredFlag(value['on'], 'on'),
        cursor: parseCursorRequest(value['cursor']),
        mode: value['mode'] === undefined ? 'capture' : oneOf(value['mode'], APP_CAPTURE_MODES, 'mode'),
        reason: value['reason'] === undefined ? undefined : captureReason(value['reason']),
      };
    },
  },
  /**
   * Drag to insert (docs/apps.md, "Drag to insert"): the app starts a drag of a new element or
   * component from its own UI; the SDK's helper then reports the pointer with `canvas.insertDrag`
   * until the drop, which inserts as `node.insert` does at the place the canvas shows.
   */
  'canvas.startInsertDrag': { params: parseInsertDragStart },
  'canvas.insertDrag': { params: parseInsertDragStep },
  /**
   * Outlines one element as the editor draws it (docs/apps.md, "Highlights"), inside closed
   * components too; display only. Leave the target out to clear it.
   */
  'canvas.highlight': { params: parseHighlight },
  /** Deep outlines: hovering inside a closed component outlines the element there, until the mode resets. */
  'canvas.setOutlineMode': { params: (input: unknown) => ({ mode: oneOf(record(input)['mode'], APP_OUTLINE_MODES, 'mode') }) },
  'panels.open': { params: (input: unknown) => ({ panel: oneOf(record(input)['panel'], APP_LEFT_PANELS, 'panel') }) },
  'panels.close': { params: nothing },
  'panels.openRight': { params: (input: unknown) => ({ panel: oneOf(record(input)['panel'], APP_RIGHT_PANELS, 'panel') }) },
  'panels.get': { params: nothing },
  'selection.get': { params: nothing },
  'selection.set': { params: (input: unknown) => ({ nodeId: optionalNodeId(record(input)['nodeId']) }) },
  'page.get': { params: nothing },
  'page.open': { params: (input: unknown) => ({ path: parseProjectFilePath(record(input)['path']) }) },
  'component.open': { params: (input: unknown) => ({ path: parseComponentPath(record(input)['path']) }) },
  'page.list': { params: nothing },
  'page.getTree': { params: (input: unknown) => ({ path: parseProjectFilePath(record(input)['path']) }) },
  'page.findByAttribute': { params: parseFindByAttribute },
  'node.get': { params: (input: unknown) => ({ nodeId: parseNodeId(record(input)['nodeId']) }) },
  'node.measure': { params: (input: unknown) => parseNodeTarget(record(input)) },
  'node.key': { params: (input: unknown) => ({ nodeId: parseNodeId(record(input)['nodeId']) }) },
  'node.find': { params: parseNodeFind },
  'node.setAttribute': {
    params: (input: unknown) => {
      const value = record(input);
      return {
        nodeId: parseNodeId(value['nodeId']),
        name: parseAttributeName(value['name']),
        value: boundedValue(value['value'], 'value'),
        label: optionalUndoLabel(value['label']),
      };
    },
  },
  'node.removeAttribute': {
    params: (input: unknown) => {
      const value = record(input);
      return { nodeId: parseNodeId(value['nodeId']), name: parseAttributeName(value['name']), label: optionalUndoLabel(value['label']) };
    },
  },
  'node.addClass': { params: parseClassEdit },
  'node.removeClass': { params: parseClassEdit },
  'node.setStyle': {
    params: (input: unknown) => {
      const value = record(input);
      return { nodeId: parseNodeId(value['nodeId']), css: boundedValue(value['css'], 'css'), label: optionalUndoLabel(value['label']) };
    },
  },
  'node.insert': {
    params: (input: unknown) => ({ item: parseInsert(input), place: parseInsertPlace(input), label: optionalUndoLabel(record(input)['label']) }),
  },
  'node.remove': { params: parseNodeStep },
  'node.duplicate': { params: parseNodeStep },
  'history.undo': { params: nothing },
  'history.redo': { params: nothing },
  'shortcuts.run': { params: (input: unknown) => ({ shortcut: oneOf(record(input)['shortcut'], APP_SHORTCUTS, 'shortcut') }) },
  'shortcuts.focus': { params: (input: unknown) => ({ editable: requiredFlag(record(input)['editable'], 'editable') }) },
  'shortcuts.claim': { params: (input: unknown) => ({ shortcuts: parseShortcutClaims(record(input)['shortcuts']) }) },
  'commands.register': { params: (input: unknown) => ({ commands: parseAppCommands(record(input)['commands']) }) },
  'commands.trigger': { params: (input: unknown) => ({ shortcut: parseCommandShortcut(record(input)['shortcut']) }) },
  'overrides.register': { params: (input: unknown) => ({ point: oneOf(record(input)['point'], APP_OVERRIDE_POINTS, 'point') }) },
  'overrides.unregister': { params: (input: unknown) => ({ point: oneOf(record(input)['point'], APP_OVERRIDE_POINTS, 'point') }) },
  'overrides.resolve': { params: parseOverrideResolve },
  'overlay.set': { params: (input: unknown) => ({ items: parseOverlayItems(record(input)['items']) }) },
  'overlay.clear': { params: nothing },
  /**
   * A message between an app and one of its overlay `frame` items, so the frame updates in place
   * instead of reloading: from the app, `itemId` names the frame item; from the frame, it is left
   * out and the message goes to the app's other frames. Heard as `overlay.message`.
   */
  'overlay.post': { params: parseOverlayPost },
  /** Opens this app's details popup at its App settings section (AppDetails.tsx), where the person fills them in. */
  'app.openSettings': { params: nothing },
  /** The people an app may mention: role members and recent commit authors, no more of each than `person.get` tells. */
  'people.list': { params: nothing },
  /** Copies text to the system clipboard, which a sandboxed frame cannot reach itself. */
  'clipboard.write': {
    params: (input: unknown) => ({ text: boundedValueMax(record(input)['text'], APP_RPC_LIMITS.clipboardCharsMax, 'text') }),
  },
  'ui.notify': {
    params: (input: unknown) => {
      const value = record(input);
      return {
        message: boundedLabel(value['message'], APP_RPC_LIMITS.notifyCharsMax, 'message'),
        kind: value['kind'] === undefined ? 'info' : oneOf(value['kind'], ['info', 'success', 'error'] as const, 'kind'),
      };
    },
  },
  'ui.openFrame': { params: parseOpenFrame },
  /** The editor's theme and its design tokens, as the UI kit's stylesheet has them (shared/properties/appUiKit.ts). */
  'ui.theme': { params: nothing },
  'ui.closeFrame': {
    params: (input: unknown) => {
      const value = input === undefined ? {} : record(input);
      return {
        frameId: value['frameId'] === undefined ? undefined : parseFrameId(value['frameId']),
        result: value['result'] === undefined ? undefined : boundedValue(value['result'], 'result'),
      };
    },
  },
  /** Who is using the editor: the id always, the rest unless the person hides it. */
  'person.get': { params: nothing },
  /** A count on the Apps rail button and the app's row while it is not open; 0 clears it. */
  'app.badge': { params: (input: unknown) => ({ count: integerIn(record(input)['count'], 0, APP_RPC_LIMITS.badgeCountMax, 'count') }) },
  'storage.get': { params: (input: unknown) => parseStorageKeyParams(input) },
  'storage.set': {
    params: (input: unknown) => {
      const value = record(input);
      return { ...parseStorageKeyParams(value), value: parseAppStorageValue(value['value']) };
    },
  },
  'storage.remove': { params: (input: unknown) => parseStorageKeyParams(input) },
  'storage.keys': { params: (input: unknown) => ({ scope: parseAppStorageScope(input === undefined ? undefined : record(input)['scope']) }) },
  /**
   * Project files (shared/properties/appFiles.ts): paths are checked here for what holds for every app,
   * and again with the app's id (its own folder in .stacki/apps/) before the host's store runs.
   */
  'files.list': { params: (input: unknown) => ({ dir: parseFilePathShape(input === undefined ? '' : (record(input)['dir'] ?? ''), { allowRoot: true }) }) },
  'files.read': { params: (input: unknown) => ({ path: parseFilePathShape(record(input)['path'], { allowRoot: false }) }) },
  'files.write': {
    params: (input: unknown) => {
      const value = record(input);
      return {
        path: parseFilePathShape(value['path'], { allowRoot: false }),
        ...parseAppFileContent(value['content'], value['encoding']),
        label: optionalUndoLabel(value['label']),
      };
    },
  },
  'files.delete': { params: parseFileStep },
  'files.move': {
    params: (input: unknown) => {
      const value = record(input);
      return {
        from: parseFilePathShape(value['from'], { allowRoot: false }),
        to: parseFilePathShape(value['to'], { allowRoot: false }),
        label: optionalUndoLabel(value['label']),
      };
    },
  },
  'files.mkdir': { params: parseFileStep },
  /** OAuth sign-ins with the installer's own client (shared/properties/appAuth.ts); the host keeps the tokens. */
  'auth.connect': { params: parseProviderParams },
  'auth.token': { params: parseProviderParams },
  'auth.disconnect': { params: parseProviderParams },
  'auth.status': { params: nothing },
  /** A request the host makes to a declared host (shared/properties/appNet.ts), signed with a sign-in when `auth` names one. */
  'net.fetch': { params: parseAppNetRequest },
} as const satisfies Readonly<Record<string, { readonly params: ParamsParser<unknown> }>>;

export type AppMethod = keyof typeof APP_METHODS;
export type AppMethodParams = { readonly [M in AppMethod]: ReturnType<(typeof APP_METHODS)[M]['params']> };
export const APP_METHOD_NAMES: readonly AppMethod[] = methodNames();

/** Every event an app can hear. */
export const APP_EVENT_LIST = [
  'selection.change',
  'hover.change',
  'canvas.change',
  'panels.change',
  'page.change',
  'project.change',
  'overlay.click',
  'role.change',
  'shortcut.press',
  'command.run',
  'override.request',
  'override.cancel',
  'frame.close',
  'storage.change',
  'person.change',
  'canvas.click',
  'canvas.capture',
  'auth.change',
  'theme.change',
  'overlay.drag',
  'overlay.message',
  'overlay.hover',
  'settings.change',
  'canvas.outline',
] as const;
export type AppEventName = (typeof APP_EVENT_LIST)[number];
export const APP_EVENT_NAMES: readonly AppEventName[] = APP_EVENT_LIST;

/** What each event carries. */
export interface AppEventData {
  readonly 'selection.change': AppSelection;
  readonly 'hover.change': AppSelection;
  readonly 'canvas.change': AppViewport;
  readonly 'panels.change': { readonly left: AppLeftPanel | undefined; readonly right: AppRightPanel };
  readonly 'page.change': { readonly path: string | undefined };
  /**
   * Something under `source` changed. `paths` names the project files when Stacki
   * knows them and they are at most APP_RPC_LIMITS.changePathsMax; absent means
   * unknown or many. `origin` is `self` for the change this app's own edit made.
   */
  readonly 'project.change': { readonly source: AppChangeSource; readonly paths?: readonly string[]; readonly origin: AppChangeOrigin };
  readonly 'overlay.click': { readonly itemId: string; readonly nodeId: string | undefined };
  readonly 'role.change': AppRoleView;
  /** A shortcut the app claims, pressed while it had focus (canonical text, `Mod+Z`). */
  readonly 'shortcut.press': { readonly shortcut: string };
  /** One of the app's commands ran: its shortcut, the palette, or another app's frame forwarding the key. */
  readonly 'command.run': { readonly id: string; readonly panel: string | undefined; readonly shortcut: AppReservedShortcut | undefined };
  /** Stacki asks the app that owns a point to answer it; reply with `overrides.resolve`. */
  readonly 'override.request': { readonly call: number } & AppOverrideRequest;
  /** Stacki stopped waiting (the time limit, or the person closed the field): close the app's picker. */
  readonly 'override.cancel': { readonly call: number };
  /** A custom frame closed, with what it closed with. */
  readonly 'frame.close': { readonly frameId: string; readonly result: string | undefined };
  /**
   * A stored value of this app changed: by this app (`self`), or by Git, a
   * teammate or another editor (`other`). `key` is undefined when more than
   * APP_STORAGE_LIMITS.changeKeysMax moved at once: read them again.
   */
  readonly 'storage.change': { readonly key: string | undefined; readonly scope: AppStorageScope; readonly origin: AppChangeOrigin };
  /** What `person.get` answers changed: the person hid or showed their details. */
  readonly 'person.change': AppPerson;
  /** A canvas click, to the app that captures clicks (`canvas.capture`) instead of a selection. */
  readonly 'canvas.click': AppCanvasClick;
  /** The canvas outline mode this app set changed: its own call, another panel or app, or the project closing. */
  readonly 'canvas.outline': { readonly mode: AppOutlineMode; readonly reason: AppOutlineReason };
  /** The app's capture started or ended: its own call, Escape, or another app taking the canvas. */
  readonly 'canvas.capture': { readonly on: boolean; readonly reason: AppCaptureReason };
  /** An `overlay.post` message: to an overlay frame from its app (`from: 'app'`), or to the app from that frame (`from: 'overlay'`). */
  readonly 'overlay.message': { readonly itemId: string; readonly data: string; readonly from: AppOverlayMessageSender };
  /** The pointer moved onto an `interactive` overlay item of this app, or off every one (`itemId` undefined); at most once per frame. */
  readonly 'overlay.hover': { readonly itemId: string | undefined };
  /** This person saved the app's settings (its details, or the setup prompt): the ids whose values changed. Read them with `settings.get`. */
  readonly 'settings.change': { readonly ids: readonly string[] };
  /** A `draggable` overlay item of this app is being dragged (docs/apps.md, "Dragging"). */
  readonly 'overlay.drag': AppOverlayDrag;
  /** This person connected or disconnected one of the app's sign-in providers, here or in another window. */
  readonly 'auth.change': AppAuthStatus;
  /** The editor's theme changed: what `ui.theme` now answers. The UI kit's script sets it on the document root. */
  readonly 'theme.change': AppThemeView;
}

function methodNames(): readonly AppMethod[] {
  const names: AppMethod[] = [];
  for (const name of Object.keys(APP_METHODS)) {
    const known = isAppMethod(name);
    assert(known, 'Every key of APP_METHODS is a method');
    names.push(name);
  }
  return names;
}

export function isAppMethod(name: string): name is AppMethod {
  return Object.hasOwn(APP_METHODS, name);
}

export function isAppEvent(name: string): name is AppEventName {
  return APP_EVENT_LIST.some((event) => event === name);
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** What an app frame sends. `params` stays unknown until the method's own parser runs. */
export interface AppRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export type AppErrorCode = 'bad-request' | 'unsupported-version' | 'unknown-method' | 'role-denied' | 'bad-params' | 'busy' | 'failed';

export type AppHostMessage =
  | { readonly stacki: 'host'; readonly v: 1; readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly stacki: 'host';
      readonly v: 1;
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly code: AppErrorCode; readonly message: string };
    }
  | { readonly stacki: 'host'; readonly v: 1; readonly event: AppEventName; readonly data: unknown };

/**
 * Reads a message from an app frame. Undefined when it is not an app message at
 * all (a frame's library talking to itself); a throw when it claims to be one
 * and is malformed, which the host answers `bad-request` when it has an id.
 */
export function parseAppRequest(input: unknown): AppRequest | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const value = record(input);
  if (value['stacki'] !== 'app') {
    return undefined;
  }
  const id = value['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error('A request id is a positive safe integer');
  }
  if (value['v'] !== APP_API_VERSION) {
    throw new UnsupportedVersionError(id);
  }
  const method = text(value['method']);
  if (method.length === 0 || method.length > APP_RPC_LIMITS.methodCharsMax) {
    throw new Error('A method name is 1 to 64 characters');
  }
  return { id, method, params: value['params'] };
}

/** A request in a version this host does not speak; it carries the id so the host can answer. */
export class UnsupportedVersionError extends Error {
  public readonly requestId: number;

  public constructor(requestId: number) {
    super(`This Stacki speaks app API version ${APP_API_VERSION}`);
    this.requestId = requestId;
  }
}

/** The request id a malformed message carries, when it carries a usable one. */
export function requestIdOf(input: unknown): number | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const id = record(input)['id'];
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function okMessage(id: number, value: unknown): AppHostMessage {
  assert(id > 0, 'A response answers a request id');
  return { stacki: 'host', v: 1, id, ok: true, value };
}

export function errorMessage(id: number, code: AppErrorCode, message: string): AppHostMessage {
  assert(id > 0, 'A response answers a request id');
  assert(message.length > 0, 'An error says why');
  return { stacki: 'host', v: 1, id, ok: false, error: { code, message: message.slice(0, 500) } };
}

export function eventMessage<E extends AppEventName>(event: E, data: AppEventData[E]): AppHostMessage {
  assert(isAppEvent(event), 'An event message names a known event');
  return { stacki: 'host', v: 1, event, data };
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

function oneOf<const T extends string>(input: unknown, options: readonly T[], what: string): T {
  const found = options.find((option) => option === input);
  if (found === undefined) {
    throw new Error(`${what} must be one of ${options.join(', ')}`);
  }
  return found;
}

function integerIn(input: unknown, minimum: number, maximum: number, what: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${what} must be a number`);
  }
  const rounded = Math.round(input);
  if (rounded < minimum || rounded > maximum) {
    throw new Error(`${what} must be ${minimum} to ${maximum}`);
  }
  return rounded;
}

function coordinate(input: unknown, what: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${what} must be a finite number`);
  }
  if (Math.abs(input) > APP_RPC_LIMITS.coordinatePxMax) {
    throw new Error(`${what} is out of range`);
  }
  return input;
}

/** A node id as the host hands it out: bounded text without spaces. */
export function parseNodeId(input: unknown): string {
  const id = text(input);
  if (id.length === 0 || id.length > 200 || /\s/.test(id)) {
    throw new Error('nodeId must be a node id the host gave out');
  }
  return id;
}

function optionalNodeId(input: unknown): string | undefined {
  return input === undefined || input === null ? undefined : parseNodeId(input);
}

function boundedLabel(input: unknown, charsMax: number, what: string): string {
  const value = text(input);
  if (value.length === 0 || value.length > charsMax) {
    throw new Error(`${what} is 1 to ${charsMax} characters`);
  }
  return value;
}

function boundedValue(input: unknown, what: string): string {
  const value = text(input);
  if (value.length > APP_RPC_LIMITS.valueCharsMax) {
    throw new Error(`${what} exceeds ${APP_RPC_LIMITS.valueCharsMax} characters`);
  }
  return value;
}

// Attribute names an app may write: HTML attribute syntax, never an Astro directive or event handler.
function parseAttributeNameShape(input: unknown): string {
  const name = boundedLabel(input, APP_RPC_LIMITS.nameCharsMax, 'name');
  if (!/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(name)) {
    throw new Error(`"${name.slice(0, 40)}" is not an attribute name`);
  }
  if (/^on/i.test(name)) {
    throw new Error('Event handler attributes cannot be written by apps');
  }
  if (name.includes(':')) {
    throw new Error('Directives cannot be written by apps');
  }
  return name;
}

// An existing node's class and inline style have their own edits, which keep the class list and declarations whole.
function parseAttributeName(input: unknown): string {
  const name = parseAttributeNameShape(input);
  if (name === 'class' || name === 'style') {
    throw new Error(`Use node.${name === 'class' ? 'addClass' : 'setStyle'} for ${name}`);
  }
  return name;
}

function parseClassEdit(input: unknown): { readonly nodeId: string; readonly className: string; readonly label: string | undefined } {
  const value = record(input);
  const className = boundedLabel(value['className'], APP_RPC_LIMITS.nameCharsMax, 'className');
  if (!/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(className)) {
    throw new Error(`"${className.slice(0, 40)}" is not a class name`);
  }
  return { nodeId: parseNodeId(value['nodeId']), className, label: optionalUndoLabel(value['label']) };
}

/** A removal or a duplicate: the element, and the step's label. */
function parseNodeStep(input: unknown): { readonly nodeId: string; readonly label: string | undefined } {
  const value = record(input);
  return { nodeId: parseNodeId(value['nodeId']), label: optionalUndoLabel(value['label']) };
}

/**
 * The name an edit gives its undo step, shown when the step is undone or redone.
 * One line of plain text: no line breaks, at most APP_RPC_LIMITS.undoLabelCharsMax.
 */
export function optionalUndoLabel(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const label = boundedLabel(input, APP_RPC_LIMITS.undoLabelCharsMax, 'label').trim();
  if (label.length === 0) {
    throw new Error('label has words in it');
  }
  if (/[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('label is one line of text');
  }
  return label;
}

/** A file removal or folder creation: the path, and the step's label. */
function parseFileStep(input: unknown): { readonly path: string; readonly label: string | undefined } {
  const value = record(input);
  return { path: parseFilePathShape(value['path'], { allowRoot: false }), label: optionalUndoLabel(value['label']) };
}

function parseProviderParams(input: unknown): { readonly provider: string } {
  return { provider: parseAuthProviderId(record(input)['provider']) };
}

/** A storage key and its scope. */
function parseStorageKeyParams(input: unknown): { readonly key: string; readonly scope: AppStorageScope } {
  const value = record(input);
  return { key: parseAppStorageKey(value['key']), scope: parseAppStorageScope(value['scope']) };
}

/** A new node's string attributes (an element) or props (a component), by name, in the order given. */
export type AppInsertAttributes = Readonly<Record<string, string>>;

/** What `node.insert` adds: an element by tag with its attributes, or a project component by name with its props. */
export type AppInsert =
  | { readonly kind: 'element'; readonly tag: string; readonly attributes: AppInsertAttributes }
  | { readonly kind: 'component'; readonly name: string; readonly props: AppInsertAttributes };

/** Where `node.insert` puts the new node beside or within its anchor (`position`). */
export const APP_INSERT_POSITIONS = ['before', 'after', 'inside'] as const;
export type AppInsertPosition = (typeof APP_INSERT_POSITIONS)[number];

/**
 * Where the new node goes: where the insert palette would put it for the selection (no
 * position), before or after an anchor, inside one (at a child index, or last), or in
 * the place of a node it replaces. Replacing and a position cannot be asked together.
 */
export type AppInsertPlace =
  | { readonly kind: 'selection' }
  | { readonly kind: 'before' | 'after'; readonly anchor: string }
  | { readonly kind: 'inside'; readonly anchor: string; readonly index: number | undefined }
  | { readonly kind: 'replace'; readonly nodeId: string };

/**
 * Elements apps never insert. A `<script>` runs in every visitor's browser and in the
 * editor's canvas, and Astro bundles and hoists it; a `<style>` restyles the whole page.
 * Both are code: an app writes code with `files.write`, which the role's `code:edit` gates.
 */
const INSERT_CODE_TAGS: readonly string[] = ['script', 'style'];

function parseInsert(input: unknown): AppInsert {
  const value = record(input);
  if (value['kind'] === 'element') {
    const tag = boundedLabel(value['tag'], 40, 'tag');
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
      throw new Error(`"${tag}" is not an element an app may insert`);
    }
    if (INSERT_CODE_TAGS.includes(tag)) {
      throw new Error(`Apps cannot insert <${tag}> elements: they are code. Write code with files.write, which needs the code:edit role feature`);
    }
    if (value['props'] !== undefined) {
      throw new Error('An element takes attributes, not props');
    }
    const attributes = parseInsertAttributes(value['attributes'], 'attributes', { kind: 'element' });
    assert(Object.keys(attributes).length <= APP_RPC_LIMITS.insertAttributesMax, 'An element starts with a bounded set of attributes');
    return { kind: 'element', tag, attributes };
  }
  if (value['kind'] === 'component') {
    const name = boundedLabel(value['name'], 120, 'name');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(`"${name.slice(0, 40)}" is not a component name`);
    }
    if (value['attributes'] !== undefined) {
      throw new Error('A component takes props, not attributes');
    }
    const props = parseInsertAttributes(value['props'], 'props', { kind: 'component' });
    assert(Object.keys(props).length <= APP_RPC_LIMITS.insertAttributesMax, 'A component starts with a bounded set of props');
    return { kind: 'component', name, props };
  }
  throw new Error('kind must be "element" or "component"');
}

/**
 * A new node's attributes or props: `node.setAttribute`'s name rules (no event handlers,
 * no directives) and value bound, at most APP_RPC_LIMITS.insertAttributesMax of them.
 * `class` and `style` are allowed here, unlike on an existing node: a new node has no
 * class list or declarations of its own to keep. A class value is class names only.
 */
function parseInsertAttributes(input: unknown, what: string, owner: { readonly kind: 'element' | 'component' }): AppInsertAttributes {
  if (input === undefined) {
    return {};
  }
  const value = record(input);
  const names = Object.keys(value);
  if (names.length > APP_RPC_LIMITS.insertAttributesMax) {
    throw new Error(`${what} has at most ${APP_RPC_LIMITS.insertAttributesMax} entries`);
  }
  const parsed: Record<string, string> = {};
  // HTML attribute names ignore case, so `Title` and `title` would be one attribute twice.
  const seen = new Set<string>();
  for (const name of names) {
    const checked = parseAttributeNameShape(name);
    const key = owner.kind === 'element' ? checked.toLowerCase() : checked;
    if (seen.has(key)) {
      throw new Error(`${what} names "${checked.slice(0, 40)}" twice`);
    }
    seen.add(key);
    const attributeValue = boundedValue(value[name], `${what}.${checked.slice(0, 40)}`);
    if (checked === 'class' && !classNamesOnly(attributeValue)) {
      throw new Error('class is class names separated by spaces');
    }
    parsed[checked] = attributeValue;
  }
  assert(Object.keys(parsed).length === names.length, 'Every attribute is kept once');
  return parsed;
}

// Each word a class name, as node.addClass takes one: no expressions, quotes or braces in a class value.
function classNamesOnly(value: string): boolean {
  const words = value.split(/\s+/).filter((word) => word.length > 0);
  assert(words.length <= APP_RPC_LIMITS.valueCharsMax, 'A bounded value has bounded words');
  return words.every((word) => /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(word));
}

function parseInsertPlace(input: unknown): AppInsertPlace {
  const value = record(input);
  const position = value['position'];
  const anchor = value['anchor'];
  const index = value['index'];
  if (value['replace'] !== undefined) {
    if (position !== undefined || anchor !== undefined || index !== undefined) {
      throw new Error('replace puts the new node in that node’s place: leave out position, anchor and index');
    }
    return { kind: 'replace', nodeId: parseNodeId(value['replace']) };
  }
  if (position === undefined) {
    if (anchor !== undefined || index !== undefined) {
      throw new Error('anchor and index need a position: "before", "after" or "inside"');
    }
    return { kind: 'selection' };
  }
  const kind = oneOf(position, APP_INSERT_POSITIONS, 'position');
  if (anchor === undefined) {
    throw new Error('position needs an anchor: the node id to place the new node by');
  }
  const anchorId = parseNodeId(anchor);
  if (kind === 'inside') {
    return { kind, anchor: anchorId, index: parseInsertIndex(index) };
  }
  if (index !== undefined) {
    throw new Error('index goes with position "inside" only');
  }
  return { kind, anchor: anchorId };
}

// A child index: a whole number below the page tree's node bound, since no parent holds more children.
function parseInsertIndex(input: unknown): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new Error('index must be a whole number');
  }
  if (input < 0) {
    throw new Error('index must be at least 0');
  }
  if (input < APP_RPC_LIMITS.treeNodesMax) {
    return input;
  }
  throw new Error(`index must be below ${APP_RPC_LIMITS.treeNodesMax}`);
}

/** Where `canvas.scrollTo` brings into view: `start` puts it at the top of the canvas, `center` (the default) in the middle. */
export const APP_SCROLL_BLOCKS = ['center', 'start'] as const;
export type AppScrollBlock = (typeof APP_SCROLL_BLOCKS)[number];

/** An element (one copy of it, the first by default), an element a ref names, or a point of the page in its CSS pixels. */
export type AppScrollTarget =
  | { readonly nodeId: string; readonly occurrence: number | undefined; readonly block: AppScrollBlock }
  | { readonly ref: AppNodeRef; readonly block: AppScrollBlock }
  | { readonly x: number; readonly y: number; readonly block: AppScrollBlock };

function parseScrollTarget(input: unknown): AppScrollTarget {
  const value = record(input);
  const block = value['block'] === undefined ? 'center' : oneOf(value['block'], APP_SCROLL_BLOCKS, 'block');
  if (value['ref'] !== undefined) {
    if (value['nodeId'] !== undefined) {
      throw new Error('Name the element by nodeId or by ref, not both');
    }
    return { ref: parseNodeRef(value['ref']), block };
  }
  if (value['nodeId'] !== undefined) {
    return { nodeId: parseNodeId(value['nodeId']), occurrence: parseOccurrence(value['occurrence']), block };
  }
  const x = coordinate(value['x'], 'x');
  const y = coordinate(value['y'], 'y');
  if (x < 0 || y < 0) {
    throw new Error('A page point is at or below and right of its top left: x and y are at least 0');
  }
  return { x, y, block };
}

/** A component file `component.open` enters: an .astro file of the project. */
function parseComponentPath(input: unknown): string {
  const path = parseProjectFilePath(input);
  if (!path.endsWith('.astro')) {
    throw new Error('path names a component: an .astro file');
  }
  return path;
}

/** A drag to insert, as an app starts it: what `node.insert` would insert, its undo label, and the chip's text. */
export interface AppInsertDragStart {
  readonly item: AppInsert;
  readonly label: string | undefined;
  /** What the chip beside the pointer says; the tag or component name by default. */
  readonly preview: string | undefined;
}

/** The phases of a drag to insert the SDK reports, at the pointer in the app frame's own CSS pixels. */
export const APP_INSERT_DRAG_PHASES = ['move', 'drop', 'cancel'] as const;
export type AppInsertDragPhase = (typeof APP_INSERT_DRAG_PHASES)[number];
export interface AppInsertDragStep {
  readonly phase: AppInsertDragPhase;
  readonly x: number;
  readonly y: number;
}

function parseInsertDragStart(input: unknown): AppInsertDragStart {
  const value = record(input);
  if (value['position'] !== undefined || value['anchor'] !== undefined || value['replace'] !== undefined) {
    throw new Error('A drag to insert is placed by the drop: leave out position, anchor and replace');
  }
  const preview = value['preview'] === undefined ? undefined : boundedLabel(value['preview'], APP_RPC_LIMITS.labelCharsMax, 'preview');
  return { item: parseInsert(value), label: optionalUndoLabel(value['label']), preview };
}

function parseInsertDragStep(input: unknown): AppInsertDragStep {
  const value = record(input);
  const phase = oneOf(value['phase'], APP_INSERT_DRAG_PHASES, 'phase');
  if (phase === 'cancel') {
    return { phase, x: 0, y: 0 };
  }
  return { phase, x: coordinate(value['x'], 'x'), y: coordinate(value['y'], 'y') };
}

/** What `node.find` looks for: the open page's element carrying a key, or the element a ref names. */
export type AppNodeFind = { readonly key: string } | { readonly ref: AppNodeRef };

function parseNodeFind(input: unknown): AppNodeFind {
  const value = record(input);
  if (value['ref'] !== undefined) {
    if (value['key'] !== undefined) {
      throw new Error('Find by key or by ref, not both');
    }
    return { ref: parseNodeRef(value['ref']) };
  }
  return { key: parseNodeKey(value['key']) };
}

/** What `canvas.highlight` draws: an element in the shapes node.measure takes, or none for nothing or `{}`; selected by default. */
function parseHighlight(input: unknown): { readonly target: AppNodeTarget | undefined; readonly style: CanvasHighlightStyle } {
  if (input === undefined || input === null) {
    return { target: undefined, style: 'selected' };
  }
  const { style, ...value } = record(input);
  const shown = style === undefined ? 'selected' : oneOf(style, CANVAS_HIGHLIGHT_STYLES, 'style');
  return { target: Object.keys(value).length === 0 ? undefined : parseNodeTarget(value), style: shown };
}

/** An element by its id on the open page (with the copy, when one is meant) or by a ref. */
function parseNodeTarget(value: Readonly<Record<string, unknown>>): AppNodeTarget {
  if (value['ref'] !== undefined) {
    if (value['nodeId'] !== undefined || value['occurrence'] !== undefined) {
      throw new Error('A ref names one copy already: leave out nodeId and occurrence');
    }
    return { ref: parseNodeRef(value['ref']) };
  }
  return { nodeId: parseNodeId(value['nodeId']), occurrence: parseOccurrence(value['occurrence']) };
}

/**
 * A node ref an app sends (docs/apps.md, "Node refs"), usually one a `canvas.click` layer
 * gave it and it stored: 1 to nodeLayersMax steps, each a project file and its element by
 * key or id, with the copy inside the step before.
 */
export function parseNodeRef(input: unknown): AppNodeRef {
  const value = record(input);
  const steps = toArray(value['steps']);
  if (steps === undefined) {
    throw new Error('ref.steps must be a list');
  }
  if (steps.length === 0) {
    throw new Error('A ref has at least one step');
  }
  if (steps.length > APP_RPC_LIMITS.nodeLayersMax) {
    throw new Error(`A ref has at most ${APP_RPC_LIMITS.nodeLayersMax} steps`);
  }
  const parsed = steps.map((step, index) => parseNodeRefStep(step, `ref.steps[${index}]`));
  assert(parsed.length > 0, 'A parsed ref has a step');
  assert(parsed.length <= APP_RPC_LIMITS.nodeLayersMax, 'A parsed ref is within the layer bound');
  return { steps: parsed };
}

function parseNodeRefStep(input: unknown, what: string): AppNodeRefStep {
  const value = record(input);
  const file = parseProjectFilePath(value['file']);
  if (file.includes('|')) {
    throw new Error(`${what}.file names a project file: no |`);
  }
  const key = absent(value['key']) ? undefined : parseNodeKey(value['key']);
  const nodeId = absent(value['nodeId']) ? undefined : parseNodeId(value['nodeId']);
  if (key === undefined && nodeId === undefined) {
    throw new Error(`${what} names its element: nodeId, key or both`);
  }
  const copy = absent(value['copy']) ? 0 : integerIn(value['copy'], 0, APP_RPC_LIMITS.nodeCopyMax, `${what}.copy`);
  return { file, nodeId, key, copy };
}

// A field a stored ref left out: JSON drops undefined, and some stores write null for it.
function absent(input: unknown): boolean {
  return input === undefined || input === null;
}

/** One string per element a ref names, so equal refs share a map entry. */
export function nodeRefKey(ref: AppNodeRef): string {
  assert(ref.steps.length > 0, 'A ref has a step to key');
  assert(ref.steps.length <= APP_RPC_LIMITS.nodeLayersMax, 'A keyed ref is within the layer bound');
  return JSON.stringify(ref.steps.map((step) => [step.file, step.key ?? '', step.nodeId ?? '', step.copy]));
}

/** A key `node.key` handed out: `k` and lowercase letters or digits. */
export function parseNodeKey(input: unknown): string {
  const key = text(input);
  if (!/^k[0-9a-z]{6,31}$/.test(key)) {
    throw new Error('key must be a key node.key gave out');
  }
  assert(key.length <= APP_RPC_LIMITS.nodeKeyCharsMax, 'A node key is within its bound');
  return key;
}

/** A page or component of the project, as `page.list` and `page.findByAttribute` name it: relative, `/`-separated, never climbing out. */
export function parseProjectFilePath(input: unknown): string {
  const path = boundedLabel(input, APP_RPC_LIMITS.pathCharsMax, 'path');
  if (!/\.(?:astro|md|mdx)$/.test(path)) {
    throw new Error('path names a page or component: an .astro, .md or .mdx file');
  }
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error('path is relative to the project and uses /');
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('path names a file without ., .. or empty segments');
  }
  return path;
}

function parseFindByAttribute(input: unknown): { readonly name: string; readonly limit: number } {
  const value = record(input);
  const name = boundedLabel(value['name'], APP_RPC_LIMITS.nameCharsMax, 'name');
  if (!/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(name)) {
    throw new Error(`"${name.slice(0, 40)}" is not an attribute name`);
  }
  const { attributeMatchesMax } = APP_RPC_LIMITS;
  return { name, limit: value['limit'] === undefined ? attributeMatchesMax : integerIn(value['limit'], 1, attributeMatchesMax, 'limit') };
}

function parseEventList(input: unknown): { readonly events: readonly AppEventName[] } {
  const items = toArray(record(input)['events']);
  if (items === undefined) {
    throw new Error('events must be a list');
  }
  if (items.length === 0 || items.length > APP_RPC_LIMITS.subscriptionsMax) {
    throw new Error(`events names 1 to ${APP_RPC_LIMITS.subscriptionsMax} events`);
  }
  const events = items.map((item) => {
    const name = text(item);
    if (!isAppEvent(name)) {
      throw new Error(`Unknown event "${name.slice(0, 40)}"`);
    }
    return name;
  });
  return { events: [...new Set(events)] };
}

// ---------------------------------------------------------------------------
// Shortcuts, overrides and custom frames
// ---------------------------------------------------------------------------

function parseCall(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) {
    throw new Error('call is the positive id Stacki sent with the request');
  }
  return input;
}

// What an asset override may write: an `https://` URL, or a file in the project's public/ or src/.
function parseAssetURL(input: unknown): string {
  const value = boundedLabel(input, APP_RPC_LIMITS.assetURLCharsMax, 'url');
  if (value.startsWith('https://')) {
    if (!URL.canParse(value)) {
      throw new Error('url is not a URL');
    }
    return value;
  }
  if (!/^(?:public|src)\/[^\\\0?#]+$/.test(value)) {
    throw new Error('url is an https:// URL or a project path in public/ or src/');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('A project path names a file without ., .. or empty segments');
  }
  return value;
}

// A data path the binding picker would hand back: `post.data.title`, `items[0]`,
// `post.data["campus-name"]`, a collection (`astro:campus`). Never an expression.
const BINDING_PATH = /^(?:(?:astro|sanity):)?[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$]*|\[\d{1,6}\]|\["[^"\\\]\n]{1,200}"\])*$/;

function parseBindingPath(input: unknown): string {
  const path = boundedLabel(input, APP_RPC_LIMITS.bindingPathCharsMax, 'path');
  if (!BINDING_PATH.test(path)) {
    throw new Error(`"${path.slice(0, 40)}" is not a data path`);
  }
  return path;
}

function parseFallback(kind: unknown): AppOverrideFallback | undefined {
  if (kind === 'default') {
    return { kind: 'default' };
  }
  if (kind === 'cancel') {
    return { kind: 'cancel' };
  }
  return undefined;
}

/** An app's answer at `point`: `picked` in the point's own shape, `default` or `cancel`. */
export function parseOverrideAnswer(point: AppOverridePoint, input: unknown): AppOverrideAnswer {
  const value = record(input);
  const fallback = parseFallback(value['kind']);
  if (fallback !== undefined) {
    return fallbackAnswer(point, fallback);
  }
  if (value['kind'] !== 'picked') {
    throw new Error('result.kind must be picked, default or cancel');
  }
  switch (point) {
    case 'assets.pick':
      return {
        point,
        result: {
          kind: 'picked',
          url: parseAssetURL(value['url']),
          alt: value['alt'] === undefined ? undefined : boundedValueMax(value['alt'], APP_RPC_LIMITS.altCharsMax, 'alt'),
        },
      };
    case 'cms.bind':
      return { point, result: { kind: 'picked', path: parseBindingPath(value['path']) } };
    default: {
      const exhaustive: never = point;
      return exhaustive;
    }
  }
}

function parseOverrideResolve(input: unknown): { readonly call: number; readonly answer: AppOverrideAnswer } {
  const value = record(input);
  const point = oneOf(value['point'], APP_OVERRIDE_POINTS, 'point');
  return { call: parseCall(value['call']), answer: parseOverrideAnswer(point, value['result']) };
}

/** A custom frame's id, as the host hands it out from `ui.openFrame`. */
export function parseFrameId(input: unknown): string {
  const id = text(input);
  if (!/^frame-[1-9]\d{0,8}$/.test(id)) {
    throw new Error('frameId is an id ui.openFrame gave out');
  }
  return id;
}

function parseOpenFrame(input: unknown): AppOpenFrame {
  const value = record(input);
  const { frameWidthPxMin, frameWidthPxMax, frameHeightPxMin, frameHeightPxMax } = APP_RPC_LIMITS;
  return {
    page: parseBundlePage(value['page'], 'A custom frame'),
    width: integerIn(value['width'], frameWidthPxMin, frameWidthPxMax, 'width'),
    height: integerIn(value['height'], frameHeightPxMin, frameHeightPxMax, 'height'),
    modal: flag(value['modal'], 'modal'),
    data: value['data'] === undefined ? undefined : boundedValue(value['data'], 'data'),
  };
}

function boundedValueMax(input: unknown, charsMax: number, what: string): string {
  const value = text(input);
  if (value.length > charsMax) {
    throw new Error(`${what} exceeds ${charsMax} characters`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

/** `overlay.post`'s params: the message, and the frame item it is for (an app's) or none (the frame's own). */
export function parseOverlayPost(input: unknown): AppOverlayPost {
  const value = record(input);
  const target = value['itemId'];
  const post: AppOverlayPost = {
    itemId: target === undefined ? undefined : itemId(target),
    data: boundedValueMax(value['data'], APP_RPC_LIMITS.overlayMessageCharsMax, 'data'),
  };
  assert(post.data.length <= APP_RPC_LIMITS.overlayMessageCharsMax, 'An overlay message is bounded');
  return post;
}

/** A colour an overlay may use: hex only, so no CSS can ride along with it. */
export function parseOverlayColor(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const color = text(input);
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
    throw new Error('Overlay colours are hex: #rgb, #rgba, #rrggbb or #rrggbbaa');
  }
  return color;
}

function parseAnchor(input: unknown): AppOverlayAnchor {
  const value = record(input);
  if (value['ref'] !== undefined) {
    if (value['nodeId'] !== undefined || value['occurrence'] !== undefined) {
      throw new Error('An anchor names its element by nodeId or by ref, not both');
    }
    const at = value['at'] === undefined ? undefined : parsePoint(value['at'], 'anchor.at');
    return { ref: parseNodeRef(value['ref']), at };
  }
  if (value['nodeId'] !== undefined) {
    const at = value['at'] === undefined ? undefined : parsePoint(value['at'], 'anchor.at');
    return { nodeId: parseNodeId(value['nodeId']), occurrence: parseOccurrence(value['occurrence']), at };
  }
  const rect = record(value['rect']);
  const width = coordinate(rect['width'], 'rect.width');
  const height = coordinate(rect['height'], 'rect.height');
  if (width < 0 || height < 0) {
    throw new Error('An overlay rectangle has a nonnegative size');
  }
  return { rect: { x: coordinate(rect['x'], 'rect.x'), y: coordinate(rect['y'], 'rect.y'), width, height } };
}

function parseOccurrence(input: unknown): number | undefined {
  return input === undefined ? undefined : integerIn(input, 0, APP_RPC_LIMITS.measureRectsMax - 1, 'occurrence');
}

/** A point within a box, each coordinate 0 to 1. */
export function parsePoint(input: unknown, what: string): AppPoint {
  const value = record(input);
  return { x: unitInterval(value['x'], `${what}.x`), y: unitInterval(value['y'], `${what}.y`) };
}

function unitInterval(input: unknown, what: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${what} must be a number`);
  }
  if (input < 0 || input > 1) {
    throw new Error(`${what} runs 0 to 1 within the element's box`);
  }
  return input;
}

function itemId(input: unknown): string {
  const id = boundedLabel(input, 64, 'id');
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new Error('Overlay item ids are letters, digits and _.:-');
  }
  return id;
}

function flag(input: unknown, what: string): boolean {
  if (input === undefined) {
    return false;
  }
  if (typeof input !== 'boolean') {
    throw new Error(`${what} must be true or false`);
  }
  return input;
}

function requiredFlag(input: unknown, what: string): boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${what} must be true or false`);
  }
  return input;
}

// A named cursor (the crosshair by default), or `{ image, hotspot? }`: a PNG or SVG in the bundle.
function parseCursorRequest(input: unknown): AppCanvasCursorRequest {
  if (input === undefined) {
    return 'crosshair';
  }
  if (typeof input === 'string') {
    return oneOf(input, APP_CANVAS_CURSORS, 'cursor');
  }
  const value = record(input);
  const image = text(value['image']);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*\.(?:png|svg)$/.test(image) || image.includes('..') || image.length > 200) {
    throw new Error('cursor.image names a PNG or SVG file in the app’s own bundle');
  }
  const pixelMax = APP_RPC_LIMITS.cursorImagePxMax - 1;
  const hotspotInput = value['hotspot'];
  if (hotspotInput === undefined) {
    return { image, hotspot: { x: 0, y: 0 } };
  }
  const hotspot = record(hotspotInput);
  return { image, hotspot: { x: integerIn(hotspot['x'], 0, pixelMax, 'cursor.hotspot.x'), y: integerIn(hotspot['y'], 0, pixelMax, 'cursor.hotspot.y') } };
}

// One of the app's own HTML files: a bundle path that cannot climb out of it.
function parseBundlePage(input: unknown, what: string): string {
  const path = text(input);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*\.html$/.test(path) || path.includes('..') || path.length > 200) {
    throw new Error(`${what} opens one of the app’s own HTML files`);
  }
  return path;
}

export function parseOverlayItem(input: unknown): AppOverlayItem {
  const value = record(input);
  const id = itemId(value['id']);
  const anchor = parseAnchor(value['anchor']);
  // A point has no size: only a label or a pin, drawn beside it, can sit on one.
  if ('at' in anchor && anchor.at !== undefined && value['kind'] !== 'label' && value['kind'] !== 'pin') {
    throw new Error('Only a label or a pin anchors to a point (anchor.at)');
  }
  // A heat map draws data and a frame takes its own pointer: neither has a handle to drag.
  if (value['draggable'] !== undefined && value['kind'] !== 'box' && value['kind'] !== 'label' && value['kind'] !== 'pin') {
    throw new Error('Only a box, a label or a pin is draggable');
  }
  switch (value['kind']) {
    case 'box':
      return {
        kind: 'box',
        id,
        anchor,
        color: parseOverlayColor(value['color']),
        fill: parseOverlayColor(value['fill']),
        label: value['label'] === undefined ? undefined : boundedLabel(value['label'], APP_RPC_LIMITS.labelCharsMax, 'label'),
        dashed: flag(value['dashed'], 'dashed'),
        interactive: flag(value['interactive'], 'interactive'),
        draggable: flag(value['draggable'], 'draggable'),
      };
    case 'label':
      return {
        kind: 'label',
        id,
        anchor,
        text: boundedLabel(value['text'], APP_RPC_LIMITS.labelCharsMax, 'text'),
        placement: value['placement'] === undefined ? 'top' : oneOf(value['placement'], ['top', 'bottom', 'center'] as const, 'placement'),
        color: parseOverlayColor(value['color']),
        background: parseOverlayColor(value['background']),
        interactive: flag(value['interactive'], 'interactive'),
        draggable: flag(value['draggable'], 'draggable'),
        cluster: value['cluster'] === undefined ? true : requiredFlag(value['cluster'], 'cluster'),
      };
    case 'pin':
      return parsePin(value, id, anchor);
    case 'heat':
      return parseHeat(value, id, anchor);
    case 'frame':
      return { kind: 'frame', id, anchor, path: parseBundlePage(value['path'], 'An overlay frame'), interactive: flag(value['interactive'], 'interactive') };
    default:
      throw new Error('Overlay kind must be box, label, pin, heat or frame');
  }
}

function parsePin(value: Readonly<Record<string, unknown>>, id: string, anchor: AppOverlayAnchor): AppOverlayItem {
  return {
    kind: 'pin',
    id,
    anchor,
    label: value['label'] === undefined ? undefined : parsePinLabel(value['label']),
    tone: value['tone'] === undefined ? 'accent' : oneOf(value['tone'], APP_PIN_TONES, 'tone'),
    avatarURL: value['avatarURL'] === undefined ? undefined : parsePinAvatarURL(value['avatarURL']),
    active: flag(value['active'], 'active'),
    interactive: flag(value['interactive'], 'interactive'),
    draggable: flag(value['draggable'], 'draggable'),
    cluster: value['cluster'] === undefined ? true : requiredFlag(value['cluster'], 'cluster'),
  };
}

// Counted in code points, so a number, initials or one emoji fit, whatever their UTF-16 length.
function parsePinLabel(input: unknown): string {
  const label = text(input);
  const characters = [...label].length;
  if (characters === 0 || characters > APP_RPC_LIMITS.pinLabelCharsMax) {
    throw new Error(`A pin label is 1 to ${APP_RPC_LIMITS.pinLabelCharsMax} characters`);
  }
  if (label.trim() !== label) {
    throw new Error('A pin label has no leading or trailing space');
  }
  return label;
}

// An https address, as an app page's own image policy allows: any host, no credentials, bounded.
function parsePinAvatarURL(input: unknown): string {
  const address = text(input);
  if (address.length === 0 || address.length > APP_RPC_LIMITS.pinAvatarURLCharsMax) {
    throw new Error(`avatarURL is 1 to ${APP_RPC_LIMITS.pinAvatarURLCharsMax} characters`);
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('avatarURL is an https address');
  }
  if (url.protocol !== 'https:') {
    throw new Error('avatarURL is an https address');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('avatarURL carries no credentials');
  }
  return url.href;
}

function parseHeat(value: Readonly<Record<string, unknown>>, id: string, anchor: AppOverlayAnchor): AppOverlayItem {
  const columns = integerIn(value['columns'], 1, 64, 'columns');
  const rows = integerIn(value['rows'], 1, 64, 'rows');
  if (columns * rows > APP_RPC_LIMITS.heatCellsMax) {
    throw new Error(`A heat map has at most ${APP_RPC_LIMITS.heatCellsMax} cells`);
  }
  const items = toArray(value['values']);
  if (items === undefined || items.length !== columns * rows) {
    throw new Error('values holds columns × rows numbers');
  }
  const values = items.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1) {
      throw new Error('Heat values are numbers from 0 to 1');
    }
    return item;
  });
  return { kind: 'heat', id, anchor, columns, rows, values, color: parseOverlayColor(value['color']) };
}

/** A whole overlay description: bounded items, unique ids, few anchors and frames. */
export function parseOverlayItems(input: unknown): readonly AppOverlayItem[] {
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('items must be a list');
  }
  if (items.length > APP_RPC_LIMITS.overlayItemsMax) {
    throw new Error(`An overlay has at most ${APP_RPC_LIMITS.overlayItemsMax} items`);
  }
  const parsed = items.map(parseOverlayItem);
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) {
    throw new Error('Overlay item ids are unique');
  }
  const anchors = new Set(parsed.flatMap((item) => anchoredElement(item.anchor)));
  if (anchors.size > APP_RPC_LIMITS.overlayAnchorsMax) {
    throw new Error(`An overlay anchors to at most ${APP_RPC_LIMITS.overlayAnchorsMax} elements`);
  }
  if (parsed.filter((item) => item.kind === 'frame').length > APP_RPC_LIMITS.overlayFramesMax) {
    throw new Error(`An overlay has at most ${APP_RPC_LIMITS.overlayFramesMax} frames`);
  }
  return parsed;
}

// The element an anchor follows, as one string: refs and ids count alike against overlayAnchorsMax.
function anchoredElement(anchor: AppOverlayAnchor): readonly string[] {
  if ('nodeId' in anchor) {
    return [`id:${anchor.nodeId}`];
  }
  if ('ref' in anchor) {
    return [`ref:${nodeRefKey(anchor.ref)}`];
  }
  return [];
}

/** The app id in an `app:<id>` role grant, for the panel's gate. */
export function appAccessFeature(appId: string): `app:${string}` {
  return `app:${parseAppId(appId)}`;
}
