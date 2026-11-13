// The host side of the Apps RPC (shared/properties/appsRpc.ts): one message from
// an app frame in, one answer out. It parses the envelope, refuses what the
// current role may not do, parses the params, and
// calls `AppHostCommands`: the same commands the editor's own UI runs, supplied
// by each host (Desktop: src/app/shell/desktopAppHost.ts; Studio:
// studio/src/features/apps/studioAppHost.ts). So undo, saving and conflicts
// behave for an app exactly as they do for a click.
//
// Apps are first-party: every app may call every method. What is checked is
// what keeps the project safe from accidents: an app the role may not use
// (`app:<id>`) is refused everything, a role that cannot see a panel cannot have
// an app open it, every message is parsed and bounded, and at most 32 requests
// wait at once.
import { assert } from '../../../shared/core/assert';
import { appPermissionsFor, can, type RoleView } from '../../../shared/properties/projectRoles';
import type { AppManifest, AppSummary } from '../../../shared/properties/apps';
import type { AppSettingValues } from '../../../shared/properties/appSettings';
import {
  APP_CAPABILITIES,
  APP_EVENT_NAMES,
  APP_METHODS,
  APP_RPC_LIMITS,
  UnsupportedVersionError,
  appAccessFeature,
  errorMessage,
  eventMessage,
  isAppMethod,
  okMessage,
  parseAppRequest,
  requestIdOf,
  type AppDevice,
  type AppCapabilities,
  type AppEditOutcome,
  type AppEventData,
  type AppEventName,
  type AppFrameInfo,
  type AppHostKind,
  type AppHostMessage,
  type AppInsert,
  type AppInsertDragStep,
  type AppInsertOutcome,
  type AppInsertPlace,
  type AppInfo,
  type AppPerson,
  type AppMember,
  type AppOverlayPost,
  type AppOpenFrame,
  type AppOverrideAnswer,
  type AppOverridePoint,
  type AppShortcut,
  type AppLeftPanel,
  type AppMethod,
  type AppNodeRef,
  type AppNodeTarget,
  type AppNodeView,
  type AppOverlayItem,
  type AppPageSummary,
  type AppPageView,
  type AppRect,
  type AppRightPanel,
  type AppRoleView,
  type AppScrollTarget,
  type AppSelection,
  type AppSnapshotOutcome,
  type AppViewport,
} from '../../../shared/properties/appsRpc';
import type { AppCommand, AppReservedShortcut } from '../../../shared/properties/appShortcuts';
import type { AppStorageChange, AppStorageScope } from '../../../shared/properties/appStorage';
import { accessRoleRefusal, runAccessMethod, type AppHostAuth, type AppHostFiles, type AppHostNet } from './appAccessRpc';
import { canPanel } from '../../lib/roleAccess';
import { createAppPageIndex, type AppPageFiles, type AppPageIndex } from './appPageIndex';
import type { CanvasCapture } from './canvasCapture';
import { resolveCanvasCursor, type BundleBytesReader } from './appCursorImage';
import { findNodeByKey, nodeKey } from './nodeKeys';
import { resolveHighlight, resolveNodeRef, resolveNodeRefSteps, type NodeRefHost } from './nodeRefs';
import type { CanvasHighlight, CanvasHighlightStyle } from '../../../shared/properties/deepOutline';
import type { OutlineModeOwner } from './outlineModeOwner';
import type { InsertDrag } from './insertDrag';
import type { AppNodeMeasurer } from './overlayMeasure';
import { currentAppTheme } from './appTheme';

/** What the editor does for an app: each is the command its own UI runs. */
export interface AppHostCommands {
  readonly viewport: () => AppViewport;
  readonly setDevice: (device: AppDevice) => void;
  readonly setWidth: AppHostAbility<(widthPx: number) => void>;
  readonly scrollTo: AppHostAbility<(target: AppScrollTarget) => AppEditOutcome>;
  readonly openPanel: (panel: AppLeftPanel) => void;
  readonly closePanel: () => void;
  readonly openRightPanel: (panel: AppRightPanel) => void;
  readonly panels: () => AppEventData['panels.change'];
  readonly selection: () => AppSelection;
  readonly select: (nodeId: string | undefined) => AppEditOutcome;
  readonly page: () => AppPageView | undefined;
  readonly pages: () => readonly AppPageSummary[];
  /** Opens a page of the project (relative path), as the Pages panel does; `page.get` names it once it is open. */
  readonly openPage: (path: string) => AppEditOutcome;
  /** Enters a component's own canvas (relative path), as opening it from the Components panel does: no instance's props. */
  readonly openComponent: AppHostAbility<(path: string) => AppEditOutcome>;
  /** Photographs a box of the canvas (its viewport's CSS pixels) as a PNG, at most `widthMax` wide. */
  readonly snapshot: AppHostAbility<(box: AppRect, widthMax: number) => Promise<AppSnapshotOutcome>>;
  readonly node: (nodeId: string) => AppNodeView | undefined;
  // Edits take the step's undo label (`label`), which the host shows when the step is undone or redone.
  readonly attributes: AppHostAbility<{
    readonly set: (nodeId: string, name: string, value: string, label: string | undefined) => Promise<AppEditOutcome>;
    readonly remove: (nodeId: string, name: string, label: string | undefined) => Promise<AppEditOutcome>;
  }>;
  readonly classes: AppHostAbility<{
    readonly add: (nodeId: string, className: string, label: string | undefined) => Promise<AppEditOutcome>;
    readonly remove: (nodeId: string, className: string, label: string | undefined) => Promise<AppEditOutcome>;
  }>;
  readonly setStyle: AppHostAbility<(nodeId: string, css: string, label: string | undefined) => Promise<AppEditOutcome>>;
  // An insert is one undo step and one save, a replaced node's removal included.
  readonly insertElement: AppHostAbility<(insert: AppHostInsert<'element'>) => Promise<AppInsertOutcome>>;
  readonly insertComponent: (insert: AppHostInsert<'component'>) => Promise<AppInsertOutcome>;
  /** Giving the new node attributes or props (`node.insert`'s `attributes` and `props`). */
  readonly insertAttributes: AppHostAbility<true>;
  /** Putting the new node in an existing node's place, in the insert's own undo step (`node.insert`'s `replace`). */
  readonly insertReplace: AppHostAbility<true>;
  readonly remove: (nodeId: string, label: string | undefined) => Promise<AppEditOutcome>;
  readonly duplicate: (nodeId: string, label: string | undefined) => Promise<AppEditOutcome>;
  readonly history: AppHostAbility<{ readonly undo: () => Promise<AppEditOutcome>; readonly redo: () => Promise<AppEditOutcome> }>;
  /** What ⌘S does: the pending edits are written now. */
  readonly save: () => Promise<AppEditOutcome>;
  /** What ⌘E does: the insert palette opens on an editable page. */
  readonly openPalette: AppHostAbility<() => AppEditOutcome>;
  /** What Escape does in the editor: leave the preview, or the component drilled into. */
  readonly escape: () => AppEditOutcome;
  readonly notify: (message: string, kind: 'info' | 'success' | 'error') => void;
  /** One app's settings, secrets included, as its installer filled them in (src/ipc/appPublishBridge.ts). */
  readonly settings: (appId: string) => Promise<AppSettingValues>;
  /** Which editor this is, and its version, for `app.info`. */
  readonly kind: AppHostKind;
  readonly version: () => Promise<string>;
  /** Who is using the editor, with their details hidden when they chose so (docs/apps.md, "The person"). */
  readonly person: () => Promise<AppPerson>;
  /** Hears the person's details being hidden or shown; returns the stop. */
  readonly onPersonChange: (listener: () => void) => () => void;
  /** Each app's stored values (shared/properties/appStorage.ts). */
  readonly storage: AppHostStorage;
  /** The project's files (`files.*`, appAccessRpc.ts); absent in a host that does not offer them. */
  readonly files?: AppHostFiles | undefined;
  /** OAuth sign-ins (`auth.*`, appAccessRpc.ts); absent in a host that does not offer them. */
  readonly auth?: AppHostAuth | undefined;
  /** Requests made for apps (`net.fetch`, appAccessRpc.ts); absent in a host that does not offer them. */
  readonly net?: AppHostNet | undefined;
  /** The project's pages and components as `page.getTree` and `page.findByAttribute` read them from disk (appPageIndex.ts). */
  readonly pageFiles: AppPageFiles;
  /** The people an app may mention (`people.list`, shared/properties/appsRpc.ts appMembers); absent in a host that does not offer them. */
  readonly people?: (() => Promise<readonly AppMember[]>) | undefined;
}

/**
 * A command a host has, or the reason it has not. `app.info`'s `can` reads the
 * kind and the method answers the reason, from this one value: the two cannot
 * disagree (docs/apps.md, "Desktop and Studio").
 */
export type AppHostAbility<T> = { readonly kind: 'able'; readonly run: T } | { readonly kind: 'unable'; readonly reason: string };

export function able<T>(run: T): AppHostAbility<T> {
  return { kind: 'able', run };
}

export function unable<T>(reason: string): AppHostAbility<T> {
  assert(reason.length > 0, 'An unavailable command says why');
  return { kind: 'unable', reason };
}

/** An edit's refusal: the one answer every edit method shares. */
type AppRefusal = Extract<AppEditOutcome, { readonly applied: false }>;

/** One `node.insert`, as a host runs it: what goes in, where, and the undo step's label. */
export interface AppHostInsert<K extends AppInsert['kind']> {
  readonly item: Extract<AppInsert, { readonly kind: K }>;
  readonly place: AppInsertPlace;
  readonly label: string | undefined;
}

// The parts of an insert beyond the node itself, each refused with the host's own reason
// when it cannot do them: the same abilities `app.info`'s `can` reports.
function insertPartRefusal(host: AppHostCommands, item: AppInsert, place: AppInsertPlace): AppRefusal | undefined {
  const given = item.kind === 'element' ? item.attributes : item.props;
  if (Object.keys(given).length > 0) {
    if (host.insertAttributes.kind === 'unable') {
      return refusedBy(host.insertAttributes);
    }
  }
  if (place.kind === 'replace') {
    if (host.insertReplace.kind === 'unable') {
      return refusedBy(host.insertReplace);
    }
  }
  return undefined;
}

/** Each app's stored values, in the host's store: Desktop's main process, or the Studio server. */
export interface AppHostStorage {
  /** This editor window's own token: a change notice carrying it was this window's write. */
  readonly writer: string;
  readonly get: (appId: string, scope: AppStorageScope, key: string) => Promise<string | undefined>;
  /** Sets a value, or removes it for undefined; a full scope answers `applied: false` with the bound it hit. */
  readonly set: (appId: string, scope: AppStorageScope, key: string, value: string | undefined) => Promise<AppEditOutcome>;
  readonly keys: (appId: string, scope: AppStorageScope) => Promise<readonly string[]>;
  /** Hears every stored change in the project, this window's included; returns the stop. */
  readonly watch: (listener: (change: AppStorageChange) => void) => () => void;
}

/** What the host can do for apps, as `app.info` reports it: each from the ability its methods read. */
export function hostCapabilities(host: AppHostCommands): AppCapabilities {
  const can: AppCapabilities = {
    setAttribute: host.attributes.kind === 'able',
    addClass: host.classes.kind === 'able',
    setStyle: host.setStyle.kind === 'able',
    insertElement: host.insertElement.kind === 'able',
    insertAttributes: host.insertAttributes.kind === 'able',
    insertReplace: host.insertReplace.kind === 'able',
    openPalette: host.openPalette.kind === 'able',
    undo: host.history.kind === 'able',
    setWidth: host.setWidth.kind === 'able',
    scrollTo: host.scrollTo.kind === 'able',
    snapshot: host.snapshot.kind === 'able',
  };
  assert(Object.keys(can).length === APP_CAPABILITIES.length, 'Every capability is answered');
  return can;
}

/** One running app, as the dispatcher sees it. The runtime owns and mutates it. */
export interface AppSession {
  readonly app: AppSummary;
  readonly subscriptions: Set<AppEventName>;
  /** A custom frame's id and data (`ui.openFrame`); undefined for the app's window and overlay frames. */
  readonly frame?: AppFrameInfo | undefined;
  /** The overlay `frame` item this frame draws (`overlay.post`); undefined for every other frame. */
  readonly overlayItem?: string | undefined;
  /** Counts a request in; false when APP_RPC_LIMITS.requestsInFlightMax are already waiting. */
  readonly begin: () => boolean;
  /** Counts a request out. */
  readonly end: () => void;
}

/** The in-flight counter a session's `begin` and `end` share. */
export function inFlightCounter(): Pick<AppSession, 'begin' | 'end'> {
  let count = 0;
  return {
    begin: () => {
      if (count >= APP_RPC_LIMITS.requestsInFlightMax) {
        return false;
      }
      count += 1;
      return true;
    },
    end: () => {
      count -= 1;
      assert(count >= 0, 'In-flight requests never go negative');
    },
  };
}

export interface AppRpcContext {
  readonly host: AppHostCommands;
  readonly role: () => RoleView;
  /** Replaces the app's overlay; undefined clears it. */
  readonly setOverlay: (appId: string, items: readonly AppOverlayItem[] | undefined) => void;
  /** The override dispatcher (appOverrides.ts); absent in a host without overrides. */
  readonly overrides?: AppOverrideRegistry | undefined;
  /** Custom frames (appsRuntime.ts); absent in a host without them. */
  readonly frames?: AppCustomFrames | undefined;
  /** Each frame's focus and kept shortcuts, which the host owns (appsRuntime.ts); absent in a host without menus. */
  readonly shortcuts?: AppShortcutState | undefined;
  /** App commands; absent in a host without them. */
  readonly commands?: AppCommandRegistry | undefined;
  /** Rail badges (appBadges.tsx); absent in a host without the rail. */
  readonly badges?: AppBadgeRegistry | undefined;
  /** Marks an app's page edit while it runs, so the change it makes reaches it as `origin: 'self'` (appsRuntime.ts). */
  readonly editOrigin?: AppEditOriginTracker | undefined;
  /** Canvas click capture (canvasCapture.ts); absent in a host without a canvas. */
  readonly capture?: CanvasCapture | undefined;
  /** Element measurement (overlayMeasure.ts); absent in a host without a canvas. */
  readonly measure?: AppNodeMeasurer | undefined;
  /** Reads an app's bundle file for an image cursor (appCursorImage.ts); absent, a capture takes named cursors only. */
  readonly readBundle?: BundleBytesReader | undefined;
  /** Tells the canvas frame something that needs no answer (src/editor/canvasQuery.ts tellCanvas); false with no canvas. */
  readonly tellCanvas?: ((message: unknown) => boolean) | undefined;
  /** The clock `canvas.snapshot`'s rate is kept by; Date.now when absent. */
  readonly nowMs?: (() => number) | undefined;
  /** Delivers `overlay.post` messages between an app and its overlay frames (appsRuntime.ts); absent in a host without overlays. */
  readonly overlayMessages?: AppOverlayMessenger | undefined;
  /** Opens an app's details popup at a section (`app.openSettings`, appsDirectory.ts); absent in a host without the Apps panel. */
  readonly openDetails?: ((appId: string) => void) | undefined;
  /** Writes text to the system clipboard for an app (`clipboard.write`); absent in a host that cannot. */
  readonly writeClipboard?: ((text: string) => Promise<void>) | undefined;
  /** Reads node refs back to the canvas (nodeRefs.ts); absent in a host without a canvas. */
  readonly nodeRefs?: NodeRefHost | undefined;
  /** The canvas's deep outline mode and its owner (outlineModeOwner.ts); absent in a host without a canvas. */
  readonly outlineMode?: OutlineModeOwner | undefined;
  /** App highlights (`canvas.highlight`, appsRuntime.ts); absent in a host without a canvas. */
  readonly highlight?: AppHighlights | undefined;
  /** Drag to insert (insertDrag.ts); absent in a host without a canvas. */
  readonly insertDrag?: InsertDrag | undefined;
  /** Where the asking frame sits in the editor window, client pixels: a drag's pointer is in the frame's own. */
  readonly frameOrigin?: (() => { readonly left: number; readonly top: number } | undefined) | undefined;
}

/** What `canvas.highlight` asks of the runtime: one highlight shown, owned by the app that drew it. */
export interface AppHighlights {
  readonly show: (appId: string, highlight: CanvasHighlight) => void;
  /** Clears the app's own highlight; another app's stays. */
  readonly clear: (appId: string) => void;
}

/** What `overlay.post` asks of the runtime: one message, to the frames it is for. Answers how many frames it reached. */
export interface AppOverlayMessenger {
  readonly post: (session: AppSession, message: AppOverlayPost) => number;
}

/** What the RPC asks of rail badges. */
export interface AppBadgeRegistry {
  /** Sets an app's count; 0 clears it. */
  readonly set: (appId: string, count: number) => void;
}

/** Attributes the page change an edit makes to the app that asked for it. */
export interface AppEditOriginTracker {
  /** An app's edit starts; the returned function marks it finished. */
  readonly begin: (appId: string) => () => void;
}

/** Where each frame's SDK says focus is, and which shortcuts it keeps: read by the host's menu (appShortcutRoute). */
export interface AppShortcutState {
  /** Focus moved into (true) or out of (false) a text field of the session's frame. */
  readonly noteFocus: (session: AppSession, editable: boolean) => void;
  /** The shortcuts the session's frame now claims (canonical text), over the manifest's own claims. */
  readonly claim: (session: AppSession, shortcuts: readonly string[]) => void;
}

/** What the RPC asks of app commands (appCommands.ts). */
export interface AppCommandRegistry {
  /** The running app's own commands, beside its manifest's. */
  readonly register: (session: AppSession, commands: readonly AppCommand[]) => void;
  /** A reserved key pressed in an app frame; false when no command is on it. */
  readonly trigger: (shortcut: AppReservedShortcut) => boolean;
}

/** What the RPC asks of the override dispatcher. */
export interface AppOverrideRegistry {
  /** Queues the session for `point`; it owns the point while it is the latest running registration. */
  readonly register: (session: AppSession, point: AppOverridePoint) => { readonly owner: boolean };
  readonly unregister: (session: AppSession, point: AppOverridePoint) => void;
  /** Settles a request Stacki sent the session's app. */
  readonly resolve: (session: AppSession, call: number, answer: AppOverrideAnswer) => AppEditOutcome;
}

/** What the RPC asks of the custom frame layer. */
export interface AppCustomFrames {
  /** Opens a frame; throws (answered `failed`) when the app has APP_RPC_LIMITS.customFramesMax open. */
  readonly open: (session: AppSession, frame: AppOpenFrame) => { readonly frameId: string };
  /** Closes the frame named, or the calling frame itself when none is named. */
  readonly close: (session: AppSession, frameId: string | undefined, result: string | undefined) => AppEditOutcome;
}

/** Answers one message from an app frame; undefined when it was not an app message. */
export async function answerAppMessage(session: AppSession, input: unknown, context: AppRpcContext): Promise<AppHostMessage | undefined> {
  let request: ReturnType<typeof parseAppRequest>;
  try {
    request = parseAppRequest(input);
  } catch (error: unknown) {
    if (error instanceof UnsupportedVersionError) {
      return errorMessage(error.requestId, 'unsupported-version', error.message);
    }
    const id = requestIdOf(input);
    return id === undefined ? undefined : errorMessage(id, 'bad-request', describe(error));
  }
  if (request === undefined) {
    return undefined;
  }
  const { id, method } = request;
  if (!isAppMethod(method)) {
    return errorMessage(id, 'unknown-method', `Stacki has no method "${method.slice(0, 64)}"`);
  }
  const role = context.role();
  if (!can(role, appAccessFeature(session.app.manifest.id))) {
    return errorMessage(id, 'role-denied', `The ${role.name} role cannot use this app`);
  }
  try {
    APP_METHODS[method].params(request.params);
  } catch (error: unknown) {
    return errorMessage(id, 'bad-params', describe(error));
  }
  if (!session.begin()) {
    return errorMessage(id, 'busy', 'Too many requests are waiting');
  }
  try {
    const refusal = roleRefusal(method, request.params, role);
    if (refusal !== undefined) {
      return errorMessage(id, 'role-denied', refusal);
    }
    return okMessage(id, await runMethod(method, request.params, session, context));
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error; // A broken invariant is the editor's bug: it crashes, it is not the app's failure.
    }
    return errorMessage(id, 'failed', describe(error));
  } finally {
    session.end();
  }
}

// What the role narrows: a panel the role cannot see stays closed, whoever asks.
function roleRefusal(method: AppMethod, rawParams: unknown, role: RoleView): string | undefined {
  const access = accessRoleRefusal(method, role);
  if (access !== undefined) {
    return access;
  }
  if (method === 'panels.open' || method === 'panels.openRight') {
    const panel = APP_METHODS[method].params(rawParams).panel;
    if (!canPanel(role, panel)) {
      return `The ${role.name} role cannot open ${panel}`; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
  }
  // Reading pages that are not open is what the Pages panel shows: a role without it reads only the open page.
  if (method === 'page.getTree' || method === 'page.findByAttribute') {
    if (!canPanel(role, 'pages')) {
      return `The ${role.name} role cannot read other pages`; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
  }
  // Opening a page is the Pages panel's; entering a component is editing it, as the editor's own double-click asks.
  if (method === 'page.open') {
    if (!canPanel(role, 'pages')) {
      return `The ${role.name} role cannot open other pages`; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
  }
  if (method === 'component.open') {
    if (!can(role, 'component:edit')) {
      return `The ${role.name} role cannot edit components`; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
  }
  // An app's details are in the Apps panel: a role that cannot see it is not shown them by an app.
  if (method === 'app.openSettings') {
    if (!canPanel(role, 'apps')) {
      return `The ${role.name} role cannot open the Apps panel`; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
  }
  return undefined;
}

// One page index per host's command object, which each host builds once: its cache lives as long as the editor.
const pageIndexes = new WeakMap<AppHostCommands, AppPageIndex>();

/** The host's page index: `page.getTree` and node refs read other files through the same cache. */
export function pageIndexOf(host: AppHostCommands): AppPageIndex {
  const known = pageIndexes.get(host);
  if (known !== undefined) {
    return known;
  }
  const created = createAppPageIndex(host.pageFiles);
  pageIndexes.set(host, created);
  return created;
}

// Each method, to its command. Exhaustive: a new method in the table is a compile error here.
// The params were checked before this runs; each case parses them again with its own parser to get their type.
async function runMethod(method: AppMethod, rawParams: unknown, session: AppSession, context: AppRpcContext): Promise<unknown> {
  const { host } = context;
  switch (method) {
    case 'app.info': {
      const { id, name, version, shortcutClaims } = session.app.manifest;
      const info: AppInfo = {
        id,
        name,
        version,
        frame: session.frame,
        shortcutClaims,
        host: { kind: host.kind, version: await host.version() },
        can: hostCapabilities(host),
      };
      return info;
    }
    case 'settings.get':
      return host.settings(session.app.manifest.id);
    case 'role.get':
      return appRoleView(context.role(), session.app.manifest);
    case 'role.can': {
      const { permission } = APP_METHODS['role.can'].params(rawParams);
      const permissions = appRoleView(context.role(), session.app.manifest).permissions;
      // An id the manifest never declared is the app's mistake, said plainly rather than read as "no".
      if (!Object.hasOwn(permissions, permission)) {
        throw new Error(`This app declares no permission "${permission}" in its manifest`);
      }
      return permissions[permission] === true;
    }
    case 'events.subscribe':
      return subscribe(session, APP_METHODS['events.subscribe'].params(rawParams).events);
    case 'events.unsubscribe':
      for (const event of APP_METHODS['events.unsubscribe'].params(rawParams).events) {
        session.subscriptions.delete(event);
      }
      return { events: [...session.subscriptions] };
    case 'canvas.getViewport':
      return host.viewport();
    case 'canvas.setDevice':
      host.setDevice(APP_METHODS['canvas.setDevice'].params(rawParams).device);
      return host.viewport();
    case 'canvas.setWidth':
      // A viewport is the answer, so a host without the command fails with its reason rather than answer `applied: false`.
      ableOrThrow(host.setWidth)(APP_METHODS['canvas.setWidth'].params(rawParams).widthPx);
      return host.viewport();
    case 'canvas.scrollTo':
      return scrollCanvas(host, context, APP_METHODS['canvas.scrollTo'].params(rawParams));
    case 'canvas.startInsertDrag': {
      const start = APP_METHODS['canvas.startInsertDrag'].params(rawParams);
      // Refused up front for what node.insert would refuse, so the person never drags what cannot land.
      const refusal = insertDragRefusal(host, start.item);
      if (refusal !== undefined) {
        return refusal;
      }
      required(context.insertDrag, 'Drags to insert').start(session.app.manifest.id, start);
      return { applied: true };
    }
    case 'canvas.insertDrag':
      return insertDragStep(context, session, APP_METHODS['canvas.insertDrag'].params(rawParams));
    case 'canvas.highlight':
      return highlightCanvas(context, session, APP_METHODS['canvas.highlight'].params(rawParams));
    case 'canvas.setOutlineMode':
      return required(context.outlineMode, 'Outline modes').set(session.app.manifest.id, APP_METHODS['canvas.setOutlineMode'].params(rawParams).mode);
    case 'canvas.snapshot': {
      const { target, widthMax } = APP_METHODS['canvas.snapshot'].params(rawParams);
      if (host.snapshot.kind === 'unable') {
        return refusedBy(host.snapshot);
      }
      if (!snapshotAllowed(session.app.manifest.id, (context.nowMs ?? Date.now)())) {
        return { applied: false, reason: `One snapshot per ${APP_RPC_LIMITS.snapshotIntervalMs / 1000} s: try again in a moment` }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      const box =
        'ref' in target
          ? await refBox(context, target.ref)
          : await renderedBox(required(context.measure, 'Element measurements'), target.nodeId, target.occurrence);
      if (box === undefined) {
        return { applied: false, reason: 'That element is not drawn on the canvas' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      return host.snapshot.run(box, widthMax);
    }
    case 'panels.open':
      host.openPanel(APP_METHODS['panels.open'].params(rawParams).panel);
      return host.panels();
    case 'panels.close':
      host.closePanel();
      return host.panels();
    case 'panels.openRight':
      host.openRightPanel(APP_METHODS['panels.openRight'].params(rawParams).panel);
      return host.panels();
    case 'panels.get':
      return host.panels();
    case 'selection.get':
      return host.selection();
    case 'selection.set':
      return host.select(APP_METHODS['selection.set'].params(rawParams).nodeId);
    case 'page.get':
      return host.page();
    case 'page.open': {
      const { path } = APP_METHODS['page.open'].params(rawParams);
      if (!host.pages().some((page) => page.path === path)) {
        return { applied: false, reason: 'This project has no page at that path; page.list names them' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      return openedWithin(host, path, host.openPage(path));
    }
    case 'component.open': {
      const { path } = APP_METHODS['component.open'].params(rawParams);
      if (host.openComponent.kind === 'unable') {
        return refusedBy(host.openComponent);
      }
      return openedWithin(host, path, host.openComponent.run(path));
    }
    case 'page.list':
      return host.pages();
    case 'node.get':
      return host.node(APP_METHODS['node.get'].params(rawParams).nodeId);
    case 'node.setAttribute': {
      const edit = APP_METHODS['node.setAttribute'].params(rawParams);
      return pageEdit(context, session, host.attributes, (run) => run.set(edit.nodeId, edit.name, edit.value, edit.label));
    }
    case 'node.removeAttribute': {
      const edit = APP_METHODS['node.removeAttribute'].params(rawParams);
      return pageEdit(context, session, host.attributes, (run) => run.remove(edit.nodeId, edit.name, edit.label));
    }
    case 'node.addClass': {
      const edit = APP_METHODS['node.addClass'].params(rawParams);
      return pageEdit(context, session, host.classes, (run) => run.add(edit.nodeId, edit.className, edit.label));
    }
    case 'node.removeClass': {
      const edit = APP_METHODS['node.removeClass'].params(rawParams);
      return pageEdit(context, session, host.classes, (run) => run.remove(edit.nodeId, edit.className, edit.label));
    }
    case 'node.setStyle': {
      const edit = APP_METHODS['node.setStyle'].params(rawParams);
      return pageEdit(context, session, host.setStyle, (run) => run(edit.nodeId, edit.css, edit.label));
    }
    case 'node.insert': {
      const { item, place, label } = APP_METHODS['node.insert'].params(rawParams);
      // A part of the insert the host cannot do refuses the whole insert: never a node without what was asked of it.
      const refusal = insertPartRefusal(host, item, place);
      if (refusal !== undefined) {
        return refusal;
      }
      if (item.kind === 'element') {
        return pageEdit(context, session, host.insertElement, (run) => run({ item, place, label }));
      }
      return pageEdit(context, session, able(host.insertComponent), (run) => run({ item, place, label }));
    }
    case 'node.remove': {
      const edit = APP_METHODS['node.remove'].params(rawParams);
      return pageEdit(context, session, able(host.remove), (run) => run(edit.nodeId, edit.label));
    }
    case 'node.duplicate': {
      const edit = APP_METHODS['node.duplicate'].params(rawParams);
      return pageEdit(context, session, able(host.duplicate), (run) => run(edit.nodeId, edit.label));
    }
    case 'history.undo':
      return pageEdit(context, session, host.history, (run) => run.undo());
    case 'history.redo':
      return pageEdit(context, session, host.history, (run) => run.redo());
    case 'shortcuts.run':
      return runShortcut(host, APP_METHODS['shortcuts.run'].params(rawParams).shortcut);
    case 'shortcuts.focus':
      required(context.shortcuts, 'Menu shortcuts').noteFocus(session, APP_METHODS['shortcuts.focus'].params(rawParams).editable);
      return { applied: true };
    case 'shortcuts.claim': {
      const { shortcuts } = APP_METHODS['shortcuts.claim'].params(rawParams);
      required(context.shortcuts, 'Menu shortcuts').claim(session, shortcuts);
      return { shortcuts: [...new Set([...session.app.manifest.shortcutClaims, ...shortcuts])] };
    }
    case 'commands.register': {
      const { commands } = APP_METHODS['commands.register'].params(rawParams);
      required(context.commands, 'App commands').register(session, commands);
      return { commands: commands.map((command) => command.id) };
    }
    case 'commands.trigger':
      return { ran: required(context.commands, 'App commands').trigger(APP_METHODS['commands.trigger'].params(rawParams).shortcut) };
    case 'overrides.register':
      return required(context.overrides, 'Overrides').register(session, APP_METHODS['overrides.register'].params(rawParams).point);
    case 'overrides.unregister':
      required(context.overrides, 'Overrides').unregister(session, APP_METHODS['overrides.unregister'].params(rawParams).point);
      return { applied: true };
    case 'overrides.resolve': {
      const { call, answer } = APP_METHODS['overrides.resolve'].params(rawParams);
      return required(context.overrides, 'Overrides').resolve(session, call, answer);
    }
    case 'ui.theme':
      return currentAppTheme();
    case 'ui.openFrame':
      return required(context.frames, 'Custom frames').open(session, APP_METHODS['ui.openFrame'].params(rawParams));
    case 'ui.closeFrame': {
      const { frameId, result } = APP_METHODS['ui.closeFrame'].params(rawParams);
      return required(context.frames, 'Custom frames').close(session, frameId, result);
    }
    case 'overlay.set':
      context.setOverlay(session.app.manifest.id, APP_METHODS['overlay.set'].params(rawParams).items);
      return { applied: true };
    case 'overlay.clear':
      context.setOverlay(session.app.manifest.id, undefined);
      return { applied: true };
    case 'ui.notify': {
      const note = APP_METHODS['ui.notify'].params(rawParams);
      host.notify(`${session.app.manifest.name}: ${note.message}`, note.kind);
      return { applied: true };
    }
    case 'person.get':
      return host.person();
    case 'app.badge':
      required(context.badges, 'Rail badges').set(session.app.manifest.id, APP_METHODS['app.badge'].params(rawParams).count);
      return { applied: true };
    case 'storage.get': {
      const { key, scope } = APP_METHODS['storage.get'].params(rawParams);
      return { value: await host.storage.get(session.app.manifest.id, scope, key) };
    }
    case 'storage.set': {
      const { key, scope, value } = APP_METHODS['storage.set'].params(rawParams);
      return host.storage.set(session.app.manifest.id, scope, key, value);
    }
    case 'storage.remove': {
      const { key, scope } = APP_METHODS['storage.remove'].params(rawParams);
      return host.storage.set(session.app.manifest.id, scope, key, undefined);
    }
    case 'files.list':
    case 'files.read':
    case 'files.write':
    case 'files.delete':
    case 'files.move':
    case 'files.mkdir':
    case 'auth.connect':
    case 'auth.token':
    case 'auth.disconnect':
    case 'auth.status':
    case 'net.fetch':
      return runAccessMethod(method, rawParams, session, context);
    case 'storage.keys':
      return { keys: await host.storage.keys(session.app.manifest.id, APP_METHODS['storage.keys'].params(rawParams).scope) };
    case 'canvas.capture': {
      const { on, cursor, mode, reason } = APP_METHODS['canvas.capture'].params(rawParams);
      const { id, name } = session.app.manifest;
      const capture = required(context.capture, 'Canvas clicks');
      if (!on) {
        return capture.set({ id, name }, on, { cursor: 'crosshair', mode, reason }); // Ending a capture shows no cursor: the image is not read.
      }
      const read = typeof cursor === 'string' ? undefined : required(context.readBundle, 'Image cursors');
      const resolved = await resolveCanvasCursor(id, cursor, read ?? (() => Promise.resolve(undefined)));
      return resolved.ok ? capture.set({ id, name }, on, { cursor: resolved.cursor, mode, reason }) : { applied: false, reason: resolved.reason };
    }
    case 'node.measure': {
      const target = APP_METHODS['node.measure'].params(rawParams);
      if ('ref' in target) {
        const box = await refBox(context, target.ref);
        return { rects: box === undefined ? [] : [box] };
      }
      return { rects: await required(context.measure, 'Element measurements').measure(target.nodeId, target.occurrence) };
    }
    case 'node.key': {
      const { nodeId } = APP_METHODS['node.key'].params(rawParams);
      return nodeKey(
        {
          node: (id) => host.node(id),
          tree: () => host.page()?.nodes ?? [],
          // The key is written as any app edit is: one undo step, saved, and heard as this app's change.
          setAttribute: (id, name, value) => pageEdit(context, session, host.attributes, (run) => run.set(id, name, value, 'Key element')),
        },
        nodeId,
      );
    }
    case 'overlay.post': {
      const message = APP_METHODS['overlay.post'].params(rawParams);
      // An app names the frame item; a frame item speaks only as itself, to its own app.
      if (session.overlayItem === undefined && message.itemId === undefined) {
        throw new Error('Name the overlay frame item (itemId) to post to');
      }
      if (session.overlayItem !== undefined && message.itemId !== undefined && message.itemId !== session.overlayItem) {
        throw new Error('An overlay frame posts only to its own app; leave itemId out');
      }
      return { delivered: required(context.overlayMessages, 'Overlay messages').post(session, message) };
    }
    case 'app.openSettings':
      required(context.openDetails, 'App details')(session.app.manifest.id);
      return { applied: true };
    case 'people.list':
      return required(host.people, 'Project members')();
    case 'clipboard.write': {
      const { text } = APP_METHODS['clipboard.write'].params(rawParams);
      await required(context.writeClipboard, 'Clipboard writes')(text);
      return { applied: true };
    }
    case 'node.find': {
      const find = APP_METHODS['node.find'].params(rawParams);
      if ('key' in find) {
        return { nodeId: findNodeByKey(host.page()?.nodes ?? [], find.key) };
      }
      // A ref: each step found in its file now, with the open page's element that holds it.
      const steps = await resolveNodeRefSteps(required(context.nodeRefs, 'Node refs'), find.ref);
      return steps.found ? { nodeId: steps.openNodeId, ref: steps.ref } : { nodeId: undefined, ref: undefined };
    }
    case 'page.getTree':
      return pageIndexOf(host).getTree(APP_METHODS['page.getTree'].params(rawParams).path, host.page());
    case 'page.findByAttribute': {
      const { name, limit } = APP_METHODS['page.findByAttribute'].params(rawParams);
      return pageIndexOf(host).findByAttribute(name, limit, host.page());
    }
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

// A forwarded shortcut, to the command the editor's own key runs. Exhaustive.
async function runShortcut(host: AppHostCommands, shortcut: AppShortcut): Promise<AppEditOutcome> {
  switch (shortcut) {
    case 'undo':
      return host.history.kind === 'able' ? host.history.run.undo() : refusedBy(host.history);
    case 'redo':
      return host.history.kind === 'able' ? host.history.run.redo() : refusedBy(host.history);
    case 'save':
      return host.save();
    case 'palette':
      return host.openPalette.kind === 'able' ? host.openPalette.run() : refusedBy(host.openPalette);
    case 'escape':
      return host.escape();
    default: {
      const exhaustive: never = shortcut;
      return exhaustive;
    }
  }
}

// An edit of the open page: refused with the host's reason when it cannot, else
// run while the app is marked as the change's origin, so the project change it
// makes reaches this app as its own (`origin: 'self'`).
async function pageEdit<T, O extends AppEditOutcome | AppInsertOutcome>(
  context: AppRpcContext,
  session: AppSession,
  ability: AppHostAbility<T>,
  edit: (run: T) => Promise<O>,
): Promise<O | AppRefusal> {
  if (ability.kind === 'unable') {
    return refusedBy(ability);
  }
  const finish = context.editOrigin?.begin(session.app.manifest.id);
  try {
    return await edit(ability.run);
  } finally {
    finish?.();
  }
}

/** How often a navigation wait looks again: the editor opens a file within a few frames. */
const NAVIGATE_POLL_MS = 50;

/** `page.open` and `component.open` answer once `page.get` names the file, or say it did not open in time. */
async function openedWithin(host: AppHostCommands, path: string, started: AppEditOutcome): Promise<AppEditOutcome> {
  if (!started.applied) {
    return started;
  }
  // Bounded: navigateTimeoutMs / NAVIGATE_POLL_MS looks at most.
  for (let waitedMs = 0; waitedMs < APP_RPC_LIMITS.navigateTimeoutMs; waitedMs += NAVIGATE_POLL_MS) {
    if (host.page()?.path === path) {
      return { applied: true };
    }
    await new Promise((resolve) => setTimeout(resolve, NAVIGATE_POLL_MS));
  }
  return host.page()?.path === path
    ? { applied: true }
    : { applied: false, reason: `The editor did not open ${path} within ${APP_RPC_LIMITS.navigateTimeoutMs / 1000} s` }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
}

/**
 * The box an element draws on the canvas, once the canvas draws it: `node.measure`
 * waits up to measureTimeoutMs each time, so this asks again until navigateTimeoutMs,
 * which covers a page `page.open` just opened and is still rendering.
 */
async function renderedBox(measure: AppNodeMeasurer, nodeId: string, occurrence: number | undefined): Promise<AppRect | undefined> {
  const tries = Math.ceil(APP_RPC_LIMITS.navigateTimeoutMs / APP_RPC_LIMITS.measureTimeoutMs);
  assert(tries >= 1, 'A rendered box is asked for at least once');
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const [box] = await measure.measure(nodeId, occurrence);
    if (box !== undefined) {
      return box;
    }
  }
  return undefined;
}

/**
 * `canvas.scrollTo`. A point scrolls the page there. An element is first waited
 * for until the canvas draws it (a page just opened, a breakpoint just changed);
 * `center` then uses the editor's own reveal (it scrolls a panel the element is
 * in, and moves only when the element is out of view), and `start` aligns the
 * element's top with the canvas's top.
 */
async function scrollCanvas(host: AppHostCommands, context: AppRpcContext, target: AppScrollTarget): Promise<AppEditOutcome> {
  if (host.scrollTo.kind === 'unable') {
    return refusedBy(host.scrollTo);
  }
  const tell = context.tellCanvas ?? (() => false);
  if ('ref' in target) {
    // The ref's copy as drawn now, aligned by the frame's own app scroll (frameAppScroll.ts).
    const box = await refBox(context, target.ref);
    if (box === undefined) {
      return { applied: false, reason: 'That element is not drawn on the canvas' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
    const told = tell({ type: 'avb:app-scroll', space: 'viewport', x: box.x, y: box.y, w: box.width, h: box.height, block: target.block });
    return told ? { applied: true } : { applied: false, reason: 'The canvas is not showing a page' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  if (!('nodeId' in target)) {
    const told = tell({ type: 'avb:app-scroll', space: 'page', x: target.x, y: target.y, w: 0, h: 0, block: target.block });
    return told ? { applied: true } : { applied: false, reason: 'The canvas is not showing a page' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  const box = context.measure === undefined ? undefined : await renderedBox(context.measure, target.nodeId, target.occurrence);
  if (context.measure !== undefined && box === undefined) {
    return { applied: false, reason: `That element is not drawn on the canvas within ${APP_RPC_LIMITS.navigateTimeoutMs / 1000} s` }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  if (target.block === 'start' && box !== undefined) {
    const told = tell({ type: 'avb:app-scroll', space: 'viewport', x: box.x, y: box.y, w: box.width, h: box.height, block: 'start' });
    return told ? { applied: true } : { applied: false, reason: 'The canvas is not showing a page' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  return host.scrollTo.run(target);
}

// What node.insert would refuse for this item wherever it lands: the host's insert, and attributes or props.
function insertDragRefusal(host: AppHostCommands, item: AppInsert): AppRefusal | undefined {
  if (item.kind === 'element' && host.insertElement.kind === 'unable') {
    return refusedBy(host.insertElement);
  }
  return insertPartRefusal(host, item, { kind: 'selection' });
}

/**
 * One step of a drag to insert, at the pointer in the asking frame's pixels: a move
 * answers whether the place under it takes the drop; the drop inserts there as
 * `node.insert` does (one undo step, the same checks); a cancel ends the drag.
 */
async function insertDragStep(context: AppRpcContext, session: AppSession, step: AppInsertDragStep): Promise<unknown> {
  const drag = required(context.insertDrag, 'Drags to insert');
  const appId = session.app.manifest.id;
  const origin = context.frameOrigin?.() ?? { left: 0, top: 0 };
  const x = origin.left + step.x;
  const y = origin.top + step.y;
  switch (step.phase) {
    case 'move':
      return { over: await drag.move(appId, x, y) };
    case 'cancel':
      if (drag.view()?.appId === appId) {
        drag.cancel();
      }
      return { applied: false, reason: 'The drag was cancelled' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    case 'drop': {
      const dropped = await drag.drop(appId, x, y);
      if (dropped.kind === 'refused') {
        return { applied: false, reason: dropped.reason };
      }
      const { item, place, label } = dropped;
      const refusal = insertPartRefusal(context.host, item, place);
      if (refusal !== undefined) {
        return refusal;
      }
      if (item.kind === 'element') {
        return pageEdit(context, session, context.host.insertElement, (run) => run({ item, place, label }));
      }
      return pageEdit(context, session, able(context.host.insertComponent), (run) => run({ item, place, label }));
    }
    default: {
      const exhaustive: never = step.phase;
      return exhaustive;
    }
  }
}

/** `canvas.highlight`: the target resolved and labelled (nodeRefs.ts), or the app's highlight cleared. */
async function highlightCanvas(
  context: AppRpcContext,
  session: AppSession,
  { target, style }: { readonly target: AppNodeTarget | undefined; readonly style: CanvasHighlightStyle },
): Promise<AppEditOutcome> {
  const highlights = required(context.highlight, 'Highlights');
  const appId = session.app.manifest.id;
  if (target === undefined) {
    highlights.clear(appId);
    return { applied: true };
  }
  const page = context.host.page()?.path;
  if (!('ref' in target) && page === undefined) {
    return { applied: false, reason: 'No page is open' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  // An open-page id is a one-step ref: its copy on the page is the step's copy.
  const ref: AppNodeRef = 'ref' in target ? target.ref : { steps: [{ file: page ?? '', nodeId: target.nodeId, key: undefined, copy: target.occurrence ?? 0 }] };
  const resolved = await resolveHighlight(required(context.nodeRefs, 'Node refs'), ref, style);
  if ('reason' in resolved) {
    return { applied: false, reason: resolved.reason };
  }
  highlights.show(appId, resolved);
  return { applied: true };
}

/** The box a ref's element draws now, or undefined when it is not on the canvas. */
async function refBox(context: AppRpcContext, ref: AppNodeRef): Promise<AppRect | undefined> {
  const resolved = await resolveNodeRef(required(context.nodeRefs, 'Node refs'), ref);
  return 'reason' in resolved ? undefined : resolved.box;
}

/** Apps whose last snapshot is remembered: more than run at once (appsRuntime.ts RUNNING_APPS_MAX), so none is forgotten early. */
const SNAPSHOT_APPS_MAX = 64;
const snapshotTimes = new Map<string, number>();

// One snapshot per app per snapshotIntervalMs: each photographs the editor window.
function snapshotAllowed(appId: string, nowMs: number): boolean {
  const lastMs = snapshotTimes.get(appId);
  if (lastMs !== undefined && nowMs - lastMs < APP_RPC_LIMITS.snapshotIntervalMs) {
    return false;
  }
  snapshotTimes.delete(appId);
  snapshotTimes.set(appId, nowMs);
  if (snapshotTimes.size > SNAPSHOT_APPS_MAX) {
    const [oldest] = snapshotTimes.keys();
    if (oldest !== undefined) {
      snapshotTimes.delete(oldest);
    }
  }
  assert(snapshotTimes.size <= SNAPSHOT_APPS_MAX, 'Snapshot times are bounded');
  return true;
}

function refusedBy(ability: { readonly kind: 'unable'; readonly reason: string }): AppRefusal {
  assert(ability.reason.length > 0, 'A refusal says why');
  return { applied: false, reason: ability.reason };
}

function ableOrThrow<T>(ability: AppHostAbility<T>): T {
  if (ability.kind === 'unable') {
    throw new Error(ability.reason);
  }
  return ability.run;
}

// A part of the platform this host has not wired: the request fails with a reason, as any unavailable command does.
function required<T>(part: T | undefined, what: string): T {
  if (part === undefined) {
    throw new Error(`${what} are not available in this editor`);
  }
  return part;
}

function subscribe(session: AppSession, events: readonly AppEventName[]): { readonly events: readonly AppEventName[] } {
  for (const event of events) {
    session.subscriptions.add(event);
  }
  assert(session.subscriptions.size <= APP_EVENT_NAMES.length, 'Subscriptions are bounded by the event list');
  return { events: [...session.subscriptions] };
}

/**
 * What `role.get` and `role.change` tell one app: the role, and that app's own
 * permissions resolved for it. Stacki enforces none of them: they are signals the
 * app must respect in its own features (docs/apps.md, "Permissions").
 */
export function appRoleView(role: RoleView, manifest: Pick<AppManifest, 'id' | 'permissions'>): AppRoleView {
  const permissions = appPermissionsFor(role, manifest.id, manifest.permissions);
  assert(Object.keys(permissions).length === manifest.permissions.length, 'An app hears exactly the permissions it declares');
  return { id: role.id, name: role.name, isAdmin: role.isAdmin, permissions };
}

/** The message an event sends this session, or undefined when it is not subscribed or its role lacks the app. */
export function eventForSession<E extends AppEventName>(session: AppSession, role: RoleView, event: E, data: AppEventData[E]): AppHostMessage | undefined {
  if (!session.subscriptions.has(event)) {
    return undefined;
  }
  if (!can(role, appAccessFeature(session.app.manifest.id))) {
    return undefined;
  }
  return eventMessage(event, data);
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500) || 'The request failed'; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
}
