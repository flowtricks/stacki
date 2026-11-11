// App commands (docs/apps.md, "Shortcuts and commands"): global actions an app
// declares in its manifest (`commands`) or registers while it runs
// (`commands.register`), each optionally on a key in the reserved range
// (shared/properties/appShortcuts.ts). A command runs from its key wherever focus
// is, from the insert palette's Apps tab, or from another app frame forwarding the
// key; if its app is not running, it is launched first, and `command.run` reaches
// it once its frame listens.
//
// Conflicts: two apps on one shortcut, the first installed (the lockfile's
// `installedAt`) keeps it, and the later one shows "in use" in its details. An
// admin can rebind or clear an app's shortcuts there. Rebinds are kept per person
// and project in this browser's storage, as the app windows' modes and sizes are
// (appWindowPreferences.ts): a key is a person's habit, a rebind should not commit
// a file every teammate pulls, and Studio and Desktop both have the storage.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { record } from '../../../shared/core/boundary';
import { can, type RoleView } from '../../../shared/properties/projectRoles';
import { APP_LIMITS, type AppSummary } from '../../../shared/properties/apps';
import { appAccessFeature, type AppEventData } from '../../../shared/properties/appsRpc';
import {
  APP_RESERVED_SHORTCUTS,
  APP_SHORTCUT_LIMITS,
  isReservedShortcut,
  shortcutLabel,
  type AppCommand,
  type AppReservedShortcut,
} from '../../../shared/properties/appShortcuts';
import { revealAppsPanel } from './appsDirectory';
import { emitToApp, launchApp, onAppSubscribed, onAppsRuntimeChange, runningApps, setAppCommandRegistry } from './appsRuntime';
import { appOpeningMode } from './appWindowPreferences';

/** `command.run` events one app may have waiting for its frame to listen. */
const QUEUED_RUNS_MAX = 4;
const STORAGE_PREFIX = 'stacki.apps.commands:';

/** A person's rebind: another reserved key, or no key. */
export type CommandRebind = AppReservedShortcut | 'none';
/** Rebinds by app id, then command id. */
export type CommandRebinds = Readonly<Record<string, Readonly<Record<string, CommandRebind>>>>;

/** One command as the editor binds it. */
export interface BoundCommand {
  readonly app: AppSummary;
  readonly command: AppCommand;
  /** The key that runs it now; undefined when it has none or lost it to an earlier app. */
  readonly shortcut: AppReservedShortcut | undefined;
  /** The key it asked for (the manifest's, or the rebind), when an earlier app holds it. */
  readonly inUse: { readonly shortcut: AppReservedShortcut; readonly holder: string } | undefined;
  /** The person's rebind over the manifest's key, if any. */
  readonly rebind: CommandRebind | undefined;
}

interface Store {
  readonly projectPath: string | undefined;
  readonly apps: readonly AppSummary[];
  /** Commands running apps registered through the SDK, by app id. */
  readonly registered: ReadonlyMap<string, readonly AppCommand[]>;
  readonly rebinds: CommandRebinds;
  readonly bound: readonly BoundCommand[];
}

let store: Store = { projectPath: undefined, apps: [], registered: new Map(), rebinds: {}, bound: [] };
let role: (() => RoleView) | undefined;
const listeners = new Set<() => void>();
const queued = new Map<string, AppEventData['command.run'][]>();

onAppSubscribed((appId) => deliverQueued(appId));
setAppCommandRegistry({
  register: (session, commands) => registerAppCommands(session.app.manifest.id, commands),
  trigger: (shortcut) => runShortcutCommand(shortcut),
});
// A stopped app's registered commands and waiting runs go with it.
onAppsRuntimeChange(() => {
  const running = new Set(runningApps().map((entry) => entry.app.manifest.id));
  for (const appId of [...queued.keys()]) {
    if (!running.has(appId)) {
      queued.delete(appId);
    }
  }
  const stopped = [...store.registered.keys()].filter((appId) => !running.has(appId));
  for (const appId of stopped) {
    forgetAppCommands(appId);
  }
});

/**
 * The commands every installed app declares, bound to keys: earlier installs
 * first, rebinds over the manifest's keys, a key taken once. Pure: the store and
 * the tests call it alike.
 */
export function bindCommands(
  apps: readonly AppSummary[],
  registered: ReadonlyMap<string, readonly AppCommand[]>,
  rebinds: CommandRebinds,
): readonly BoundCommand[] {
  assert(apps.length <= APP_LIMITS.appsMax, 'Installed apps are bounded');
  const ordered = [...apps].sort((left, right) => {
    if (left.lock.installedAt === right.lock.installedAt) {
      return left.manifest.id < right.manifest.id ? -1 : 1;
    }
    return left.lock.installedAt < right.lock.installedAt ? -1 : 1;
  });
  const holders = new Map<AppReservedShortcut, string>();
  const bound: BoundCommand[] = [];
  for (const app of ordered) {
    for (const command of commandsOf(app, registered)) {
      const rebind = rebinds[app.manifest.id]?.[command.id];
      const wanted = rebind === undefined ? command.shortcut : rebind === 'none' ? undefined : rebind;
      if (wanted === undefined) {
        bound.push({ app, command, shortcut: undefined, inUse: undefined, rebind });
      } else {
        const holder = holders.get(wanted);
        if (holder === undefined) {
          holders.set(wanted, app.manifest.name);
          bound.push({ app, command, shortcut: wanted, inUse: undefined, rebind });
        } else {
          bound.push({ app, command, shortcut: undefined, inUse: { shortcut: wanted, holder }, rebind });
        }
      }
    }
  }
  assert(holders.size <= APP_RESERVED_SHORTCUTS.length, 'Each reserved key runs one command');
  return bound;
}

/** The editor's project, its installed apps and its role: AppsHost sets them as they change. */
export function configureAppCommands(projectPath: string, apps: readonly AppSummary[], currentRole: () => RoleView): void {
  role = currentRole;
  const rebinds = projectPath === store.projectPath ? store.rebinds : readRebinds(projectPath);
  update({ ...store, projectPath, apps, rebinds });
}

/** A running app's own commands (`commands.register`); they last while it runs. */
export function registerAppCommands(appId: string, commands: readonly AppCommand[]): void {
  const registered = new Map(store.registered);
  registered.set(appId, commands);
  update({ ...store, registered });
}

/** Forgets a stopped app's registered commands and queued runs. */
export function forgetAppCommands(appId: string): void {
  queued.delete(appId);
  if (store.registered.has(appId)) {
    const registered = new Map(store.registered);
    registered.delete(appId);
    update({ ...store, registered });
  }
}

/** The command a reserved key runs now, if one does. */
export function commandForShortcut(shortcut: AppReservedShortcut): BoundCommand | undefined {
  return store.bound.find((entry) => entry.shortcut === shortcut);
}

/**
 * A press in the reserved range, from anywhere: the editor, the canvas, or an app
 * frame. True when a command took it (the caller then keeps the key from the page).
 */
export function runShortcutCommand(shortcut: string): boolean {
  if (!isReservedShortcut(shortcut)) {
    return false;
  }
  const entry = commandForShortcut(shortcut);
  if (entry === undefined) {
    return false;
  }
  return runCommand(entry, shortcut);
}

/** Runs a command by app and id (the palette's row). False when the role cannot use the app or it has no such command. */
export function runAppCommand(appId: string, commandId: string): boolean {
  const entry = store.bound.find((candidate) => candidate.app.manifest.id === appId && candidate.command.id === commandId);
  return entry === undefined ? false : runCommand(entry, undefined);
}

/** Sets or clears a person's rebind of one command; undefined returns it to the manifest's key. */
export function rebindCommand(appId: string, commandId: string, rebind: CommandRebind | undefined): void {
  const projectPath = store.projectPath;
  assert(projectPath !== undefined, 'Rebinding needs an open project');
  const forApp: Record<string, CommandRebind> = { ...store.rebinds[appId] };
  if (rebind === undefined) {
    delete forApp[commandId];
  } else {
    forApp[commandId] = rebind;
  }
  const rebinds: Record<string, Readonly<Record<string, CommandRebind>>> = { ...store.rebinds, [appId]: forApp };
  writeRebinds(projectPath, rebinds);
  update({ ...store, rebinds });
}

/** Every bound command, kept current. */
export function useAppCommands(): readonly BoundCommand[] {
  return useSyncExternalStore(subscribe, () => store.bound);
}

/** Which modifier `Mod` is here: ⌘ on macOS, Ctrl elsewhere. */
export function shortcutPlatform(): 'mac' | 'other' {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? 'mac' : 'other';
}

/** A shortcut as this platform writes it. */
export function platformShortcutLabel(shortcut: string): string {
  return shortcutLabel(shortcut, shortcutPlatform());
}

/**
 * The hint a shortcut field shows for a key outside the reserved range, read from
 * the range itself so the two cannot drift: "Use ⌘⌥⇧ with a number from 1 to 9".
 */
export function commandShortcutHint(platform: 'mac' | 'other'): string {
  const keys = APP_RESERVED_SHORTCUTS.map((shortcut) => shortcut.split('+').at(-1) ?? '');
  const modifiers = APP_RESERVED_SHORTCUTS[0].split('+').slice(0, -1).join('+');
  assert(
    APP_RESERVED_SHORTCUTS.every((shortcut) => shortcut.startsWith(`${modifiers}+`)),
    'The reserved range shares one set of modifiers',
  );
  assert(
    keys.every((key) => /^[0-9]$/.test(key)),
    'The reserved range is digits; the hint says numbers',
  );
  return `Use ${shortcutLabel(modifiers, platform)} with a number from ${keys[0] ?? ''} to ${keys.at(-1) ?? ''}`;
}

/**
 * What holds a key another command wants, as a shortcut field names it ("Used by
 * Heat map"), or undefined when the key is free or this command already holds it.
 * Another app's command is named by its app; one of the same app's by its title.
 */
export function shortcutHolder(bound: readonly BoundCommand[], appId: string, commandId: string, shortcut: string): string | undefined {
  assert(appId.length > 0, 'A command belongs to an app');
  const holder = bound.find((entry) => entry.shortcut === shortcut);
  if (holder === undefined) {
    return undefined;
  }
  if (holder.app.manifest.id === appId) {
    if (holder.command.id === commandId) {
      return undefined;
    }
    return `Used by ${holder.command.title}`;
  }
  assert(holder.app.manifest.name.length > 0, 'An installed app has a name');
  return `Used by ${holder.app.manifest.name}`;
}

/**
 * The rebind that puts a command on a key, or on none (undefined): no rebind at
 * all when that is the app's own choice, so a key recorded back to the default
 * leaves nothing to reset.
 */
export function rebindFor(command: AppCommand, shortcut: AppReservedShortcut | undefined): CommandRebind | undefined {
  if (shortcut === command.shortcut) {
    return undefined;
  }
  const rebind = shortcut ?? 'none';
  assert(rebind !== command.shortcut, 'A rebind differs from the app’s own key');
  return rebind;
}

/** Rebinds as storage holds them, parsed: unknown apps, commands or keys are dropped, never trusted. */
export function parseRebinds(input: unknown): CommandRebinds {
  const out: Record<string, Record<string, CommandRebind>> = {};
  const apps = Object.entries(record(input)).slice(0, APP_LIMITS.appsMax);
  for (const [appId, commands] of apps) {
    const forApp: Record<string, CommandRebind> = {};
    for (const [commandId, value] of Object.entries(record(commands)).slice(0, APP_SHORTCUT_LIMITS.commandsMax * 2)) {
      if (value === 'none') {
        forApp[commandId] = 'none';
      } else if (typeof value === 'string' && isReservedShortcut(value)) {
        forApp[commandId] = value;
      }
    }
    out[appId] = forApp;
  }
  return out;
}

function runCommand(entry: BoundCommand, shortcut: AppReservedShortcut | undefined): boolean {
  const currentRole = role?.();
  if (currentRole === undefined) {
    return false;
  }
  if (!can(currentRole, appAccessFeature(entry.app.manifest.id))) {
    return false; // A role without the app has no commands of it.
  }
  const appId = entry.app.manifest.id;
  const running = runningApps().some((candidate) => candidate.app.manifest.id === appId);
  if (!running) {
    const projectPath = store.projectPath;
    assert(projectPath !== undefined, 'A command runs in an open project');
    if (launchApp(entry.app, appOpeningMode(projectPath, entry.app)) === 'panel') {
      revealAppsPanel();
    }
  }
  const run: AppEventData['command.run'] = { id: entry.command.id, panel: entry.command.panel, shortcut };
  const waiting = [...(queued.get(appId) ?? []), run].slice(-QUEUED_RUNS_MAX);
  queued.set(appId, waiting);
  deliverQueued(appId);
  return true;
}

// Runs wait until a frame of the app listens for `command.run`: a just-launched app has not loaded yet.
function deliverQueued(appId: string): void {
  const waiting = queued.get(appId);
  if (waiting === undefined || waiting.length === 0) {
    return;
  }
  let delivered = false;
  for (const run of waiting) {
    delivered = emitToApp(appId, 'command.run', run) > 0;
    if (!delivered) {
      return;
    }
  }
  queued.delete(appId);
}

function commandsOf(app: AppSummary, registered: ReadonlyMap<string, readonly AppCommand[]>): readonly AppCommand[] {
  const declared = app.manifest.commands;
  const extra = (registered.get(app.manifest.id) ?? []).filter((command) => !declared.some((known) => known.id === command.id));
  return [...declared, ...extra].slice(0, APP_SHORTCUT_LIMITS.commandsMax * 2);
}

function update(next: Omit<Store, 'bound'>): void {
  store = { ...next, bound: bindCommands(next.apps, next.registered, next.rebinds) };
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readRebinds(projectPath: string): CommandRebinds {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectPath);
    if (raw === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return parseRebinds(parsed);
  } catch {
    return {}; // No storage (a private window), or a value another version wrote: the manifest's keys.
  }
}

function writeRebinds(projectPath: string, rebinds: CommandRebinds): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + projectPath, JSON.stringify(rebinds));
  } catch {
    // No storage: the rebind holds until the editor closes.
  }
}

/** For tests: forget the project, apps, rebinds and queued runs. */
export function resetAppCommands(): void {
  queued.clear();
  role = undefined;
  store = { projectPath: undefined, apps: [], registered: new Map(), rebinds: {}, bound: [] };
}
