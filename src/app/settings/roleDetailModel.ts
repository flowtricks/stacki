// The pure side of a role's detail views in Settings → Roles: the sections a card lists, the counts its
// summary rows show, and the permission list grouped by area with a per-group state and an instant search.
// Why a model: the card, the detail view and the tests read the same numbers, so a count on a row can
// never disagree with the list it opens.
import { assert } from '../../../shared/core/assert';
import { editorWithholds } from '../../../shared/properties/projectRoles';
import {
  ACCESS_GROUPS,
  ADMIN_ROLE_ID,
  APPS_ACCESS_GROUP,
  APP_ACCESS_ALL,
  can,
  roleView,
  type ProjectRole,
  type StaticAccessFeature,
} from '../../../shared/properties/projectRoles';
import type { AppSummary } from '../../../shared/properties/apps';
import type { Described } from '../../../shared/properties/i18n/messageRef';

/** The detail views a role card opens, in the order the card lists them. */
export const ROLE_SECTIONS = ['members', 'pins', 'components', 'editing', 'permissions'] as const;
export type RoleSection = (typeof ROLE_SECTIONS)[number];

/** Where Settings → Roles is: the cards, or one section of one role. */
export type RolesView = { readonly kind: 'cards' } | { readonly kind: 'detail'; readonly roleId: string; readonly section: RoleSection };

/** A group's switch: every permission in it on, none, or some. */
export type GroupState = 'on' | 'off' | 'mixed';

export interface PermissionRowView {
  /** "Every app" (`app:*`) is listed in the Apps group but is not one of the group's counted switches. */
  readonly feature: StaticAccessFeature | typeof APP_ACCESS_ALL;
  readonly label: string;
  readonly checked: boolean;
  /** The role's Editing options take it away whatever the switch says, so it shows off and cannot be switched here. */
  readonly withheld: boolean;
}

export interface PermissionGroupView {
  /** The group's English label: its identity, as in ACCESS_GROUPS. */
  readonly key: string;
  readonly label: string;
  readonly rows: readonly PermissionRowView[];
  /** Permissions on and listed in the whole group (not only the rows a search keeps). */
  readonly on: number;
  readonly total: number;
  readonly state: GroupState;
  /** Every feature of the whole group, so its switch changes all of it even while a search shows some. */
  readonly features: readonly StaticAccessFeature[];
}

/** Whether the role's editing options take `feature` away. */
function withheld(role: ProjectRole, feature: StaticAccessFeature | typeof APP_ACCESS_ALL): boolean {
  return role.id !== ADMIN_ROLE_ID && editorWithholds(roleView(role).editorOff, feature);
}

/**
 * Whether a switch reads as on. `panel:elements` reads its effective state, because a role that holds a design panel has it
 * by default without naming it (`can`); every other switch is exactly what the role stores.
 */
function switchOn(role: ProjectRole, feature: StaticAccessFeature): boolean {
  if (withheld(role, feature)) {
    return false;
  }
  if (feature === 'panel:elements' && role.id !== ADMIN_ROLE_ID) {
    return can(roleView(role), feature);
  }
  return role.access.includes(feature);
}

/** Granted and total switches: every grouped feature plus "Every app". */
export function permissionCounts(role: ProjectRole): { readonly granted: number; readonly total: number } {
  const features = ACCESS_GROUPS.flatMap((group) => group.features.map((item) => item.feature));
  const total = features.length + 1;
  const granted = features.filter((feature) => switchOn(role, feature)).length + (role.access.includes(APP_ACCESS_ALL) ? 1 : 0);
  assert(granted <= total, 'Role permissions: granted switches are among the listed ones');
  assert(total > 1, 'Role permissions: the grid lists features');
  return { granted, total };
}

/** The state a group of `total` permissions with `on` of them granted reads as. */
export function groupState(on: number, total: number): GroupState {
  assert(on >= 0, 'A group has no negative count on');
  assert(on <= total, 'A group has no more on than it lists');
  if (on === 0) {
    return 'off';
  }
  if (on === total) {
    return 'on';
  }
  return 'mixed';
}

/** Whether `label` matches a search: case-insensitive, every word of the query inside the label. An empty query matches all. */
export function matchesQuery(label: string, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  assert(words.length <= query.length, 'A query has at most as many words as characters');
  const text = label.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The role's permissions grouped by area, filtered by `query`. A group whose own name matches keeps all of its
 * rows; otherwise only the rows that match, and a group with none is left out. Counts and state always describe
 * the whole group (without "Every app"), so a search never makes a group look fully on.
 */
export function permissionGroups(
  role: ProjectRole,
  query: string,
  everyAppLabel: string,
  translateDescribed: (described: Described) => string,
): readonly PermissionGroupView[] {
  assert(everyAppLabel.length > 0, 'Every app has a label');
  const granted = new Set<string>(role.access);
  const groups: PermissionGroupView[] = [];
  for (const group of ACCESS_GROUPS) {
    const label = translateDescribed({ message: group.label, messageRef: group.labelRef });
    const all: PermissionRowView[] = group.features.map((item): PermissionRowView => ({
      feature: item.feature,
      label: translateDescribed({ message: item.label, messageRef: item.labelRef }),
      checked: item.feature === 'panel:elements' ? switchOn(role, item.feature) : granted.has(item.feature) && !withheld(role, item.feature),
      withheld: withheld(role, item.feature),
    }));
    const counted = all.length;
    if (group.label === APPS_ACCESS_GROUP) {
      all.push({ feature: APP_ACCESS_ALL, label: everyAppLabel, checked: granted.has(APP_ACCESS_ALL), withheld: false });
    }
    const groupMatches = matchesQuery(label, query);
    const rows = groupMatches ? all : all.filter((row) => matchesQuery(row.label, query));
    if (rows.length === 0) {
      continue;
    }
    const counting = all.slice(0, counted);
    const on = counting.filter((row) => row.checked).length;
    const features = counting.flatMap((row) => (row.feature === APP_ACCESS_ALL ? [] : [row.feature]));
    assert(features.length === counted, 'The counted rows are the static features');
    groups.push({ key: group.label, label, rows, on, total: counted, state: groupState(on, counted), features });
  }
  assert(groups.length <= ACCESS_GROUPS.length, 'A search never adds groups');
  return groups;
}

/**
 * Which of an installed app's permissions a search keeps: `'all'` when the query is empty or names the app,
 * the ids of the permissions whose label matches, or `undefined` when nothing of the app matches.
 */
export function appPermissionMatches(app: AppSummary, query: string): 'all' | readonly string[] | undefined {
  if (matchesQuery(app.manifest.name, query)) {
    return 'all';
  }
  const ids = app.manifest.permissions.filter((permission) => matchesQuery(permission.label, query)).map((permission) => permission.id);
  assert(ids.length <= app.manifest.permissions.length, 'A search never adds permissions');
  return ids.length === 0 ? undefined : ids;
}
