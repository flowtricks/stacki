// The insert palette's Apps tab: the installed apps a role may open, as rows the palette ranks
// beside components and elements. The palette never loads apps itself: the host supplies a
// `PaletteAppsSource` (src/app/shell/insertApps.ts for Desktop and Studio alike, over
// src/features/apps/appsDirectory.ts), so this module stays free of IPC and runs wherever the
// palette does, Studio included. What it owns is which apps a role sees and how an app reads to
// the search. A role with `marketplace:view` also finds the marketplace's approved apps that are not
// installed yet, listed after the installed ones under "Marketplace"; choosing one shows it in the
// Apps panel's Marketplace tab, where installing is a separate, deliberate click.
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS } from '../../../shared/properties/apps';
import { MARKETPLACE_LIMITS } from '../../../shared/properties/appMarketplace';
import { appAccessFeature } from '../../../shared/properties/appsRpc';
import { can, type RoleView } from '../../../shared/properties/projectRoles';

/** One installed app, as the palette lists it. */
export interface PaletteApp {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Who made it; absent when neither the manifest nor the app's GitHub source names someone. */
  readonly author: PaletteAppAuthor | undefined;
  /** The app's icon image; absent (or failing to load) draws `initial` on `color`, as the Apps panel does. */
  readonly iconURL: string | undefined;
  readonly initial: string;
  readonly color: string;
  /** Switches the rail to the Apps panel and opens the app (or runs its open action). */
  readonly open: () => void;
  /** The app's commands, each a row of its own after the app's (docs/apps.md, "Shortcuts and commands"). */
  readonly commands?: readonly PaletteAppCommand[] | undefined;
  /** A command row's key, as this platform writes it (`⌘⇧1`). */
  readonly shortcut?: string | undefined;
}

/** One command of an app, as the palette lists it. */
export interface PaletteAppCommand {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string | undefined;
  /** Runs the command, launching the app first when it is not running. */
  readonly run: () => void;
}

/** An app's author, as the row's byline draws it: a small picture, then "by <login>". */
export interface PaletteAppAuthor {
  /** A GitHub login. */
  readonly login: string;
  /** The login's GitHub picture; absent (or failing to load) leaves the byline without one. */
  readonly avatarURL: string | undefined;
}

/** The host's apps: still loading, failed to load, or listed. */
export type PaletteAppList =
  { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready'; readonly apps: readonly PaletteApp[] };

export interface PaletteAppsSource {
  readonly list: PaletteAppList;
  /** Switches the rail to the Apps panel: the empty state's "Open Apps panel" row. */
  readonly browse: () => void;
  /** Opens the Apps panel's "Load App From GitHub" popup; absent opens the Apps panel instead. */
  readonly connect?: (() => void) | undefined;
  /** Opens the AI chat with the "Build an app" prompt waiting unsent, as the Apps panel's item does; absent opens the Apps panel instead. */
  readonly buildApp?: (() => void) | undefined;
  /** Approved marketplace apps not installed here, for a role that may see the marketplace; `open` shows one in the Apps panel. */
  readonly marketplace?: readonly PaletteApp[] | undefined;
}

/** One row of the empty Apps tab: something to do instead of an app to open. */
export interface PaletteAppsAction {
  readonly key: 'connect' | 'buildApp' | 'browse';
  readonly label: string;
  readonly run: () => void;
}

/**
 * The empty Apps tab's rows, first highlighted: connecting a release, opening the AI chat on the prompt
 * that builds an app, then the panel itself. Installing is an admin's (the Apps panel offers it to no
 * one else), so another role is offered the prompt and the panel. An action the host does not expose
 * opens the panel, where the person finishes it.
 */
export function paletteAppsActions(source: PaletteAppsSource, role: RoleView): readonly PaletteAppsAction[] {
  assert(canSeePaletteApps(role), 'paletteApps: only a role with the Apps panel has an Apps tab');
  const browse: PaletteAppsAction = { key: 'browse', label: 'Open Apps panel', run: source.browse };
  const buildApp: PaletteAppsAction = { key: 'buildApp', label: 'Build an app', run: source.buildApp ?? source.browse };
  if (!role.isAdmin) {
    return [buildApp, browse];
  }
  const actions: readonly PaletteAppsAction[] = [{ key: 'connect', label: 'Load App From GitHub', run: source.connect ?? source.browse }, buildApp, browse];
  assert(actions.at(-1) === browse, 'paletteApps: the panel is the last way on');
  return actions;
}

/** An app as a search row. `type` keeps it apart from every insert choice: an app opens, it never inserts. */
export interface PaletteAppItem {
  readonly type: 'app';
  readonly app: PaletteApp;
  readonly name: string;
  readonly label: string;
  /** What else the search lands on, after the name: the id and the description. */
  readonly sub: string;
  readonly cat: 'apps';
}

/** A marketplace app as a search row: it opens the Apps panel's Marketplace tab on that app, never installs. */
export interface PaletteMarketplaceItem {
  readonly type: 'marketplace';
  readonly app: PaletteApp;
  readonly name: string;
  readonly label: string;
  readonly sub: string;
  readonly cat: 'apps';
}

/** The marketplace rows `role` may see: none without `marketplace:view`, and at most the index's bound. */
export function paletteMarketplaceItems(apps: readonly PaletteApp[], role: RoleView): readonly PaletteMarketplaceItem[] {
  assert(apps.length <= MARKETPLACE_LIMITS.appsMax, 'paletteApps: marketplace apps are bounded by the index');
  if (!canSeePaletteApps(role)) {
    return [];
  }
  if (!can(role, 'marketplace:view')) {
    return [];
  }
  const items = apps.map((app): PaletteMarketplaceItem => ({
    type: 'marketplace',
    app,
    name: app.name,
    label: app.name,
    sub: `${app.id} ${app.description}`,
    cat: 'apps',
  }));
  assert(items.length === apps.length, 'paletteApps: one row per marketplace app');
  return items;
}

/** Whether `role` sees the Apps tab at all: without the Apps panel no app is reachable. */
export function canSeePaletteApps(role: RoleView): boolean {
  assert(role.id.length > 0, 'paletteApps: a role has an id');
  const allowed = can(role, 'panel:apps');
  assert(!role.isAdmin || allowed, 'paletteApps: an admin always sees Apps');
  return allowed;
}

/** The apps `role` may open, in the host's order; an app without its `app:<id>` grant is left out. */
export function visiblePaletteApps(apps: readonly PaletteApp[], role: RoleView): readonly PaletteApp[] {
  assert(apps.length <= APP_LIMITS.appsMax, 'paletteApps: installed apps are bounded');
  if (!canSeePaletteApps(role)) {
    return [];
  }
  const visible = apps.filter((app) => can(role, appAccessFeature(app.id)));
  assert(visible.length <= apps.length, 'paletteApps: filtering never adds apps');
  return visible;
}

/** The search rows for `apps`. The name is the label, so it outranks the id and description (src/lib/insertRank.ts). */
export function paletteAppItems(apps: readonly PaletteApp[]): readonly PaletteAppItem[] {
  assert(apps.length <= APP_LIMITS.appsMax, 'paletteApps: installed apps are bounded');
  // One row per app, which opens it: the palette is for finding an app, not its commands
  // (those stay on their keys and in the command palette).
  const items = apps.map(appItem);
  assert(items.length === apps.length, 'paletteApps: one row per app');
  return items;
}

function appItem(app: PaletteApp): PaletteAppItem {
  return { type: 'app', app, name: app.name, label: app.name, sub: app.description === '' ? app.id : `${app.id} ${app.description}`, cat: 'apps' };
}

/** The byline after an app's description, "by <login>"; absent when the app names no author. */
export function paletteAppByline(app: PaletteApp): string | undefined {
  assert(app.name.length > 0, 'paletteApps: an app has a name');
  if (app.author === undefined) {
    return undefined;
  }
  assert(app.author.login.length > 0, 'paletteApps: an author has a login');
  return `by ${app.author.login}`;
}
